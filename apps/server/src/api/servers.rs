use std::collections::{HashMap, HashSet};

use axum::Json;
use axum::extract::{Path, Query, RawQuery, State};
use axum::http::{HeaderMap, StatusCode};
use serde::{Deserialize, Serialize};
use sqlx::{AnyConnection, Row};
use utoipa::{IntoParams, ToSchema};

use crate::api::PermMode;
use crate::api::access::members::{ListPlace, MemberList, Roster, refusal, seen_authors};
use crate::api::access::overwrite_sql::private_sql;
use crate::api::access::perms::{
    ALL_PERMS, ChannelAccess, EVERYONE, EVERYONE_BITS, PRE_DELEGATION_PERMS, PRE_REPORT_PERMS,
    Perm, PermRow, ROLE_BITS, Restrict, can_grant, channel_mask, everyone_mask, perm_bits,
    perm_columns, perm_row, reflag, row_flags, rule_narrows, update_bits, update_role_bits,
};
use crate::api::access::{
    BANNED, Caller, InviteView, Proof, ResolvedChannel, ServerAccess, Via, acting_on, grants,
    ranks, resolve_channel, resolve_invite, resolve_join, resolve_reading, resolve_server,
    seen_among,
};
use crate::api::admin::{is_fuzzy, like_pattern, name_hit};
use crate::api::audit::{self, ChannelRef, Details, Entry, Target, TargetKind};
use crate::api::auth::{Work, clean_multiline, hash_in, new_token, present};
use crate::api::bans::{self, BanOptions, BanReq, BanResp};
use crate::api::categories::{
    NEXT_POSITION, announce, bump, channel_order, current_layout, layout_version, listed,
    load_layout, rank, seen_part, server_categories, write_layout,
};
use crate::api::features::Feature;
use crate::api::join_modes::{
    JoinMode, KEY_LEN, StartChannels, join_mode_of, keeps_key, random_text,
};
use crate::api::lookup::{self, LookupClass};
use crate::api::messages::recent_channel_messages;
use crate::api::pings::forget_server_pings;
use crate::api::policy::{ServerCreation, ServerJoining};
use crate::api::rare::{self, Rare};
use crate::api::sealed;
use crate::api::server_about::{self, IconKind};
use crate::api::system_messages::{SystemKind, announce_system, post_system};
use crate::api::timeouts::{running_timeouts, timeout_event};
use crate::api::users::Names;
use crate::api::{
    ApiError, ApiErrorBody, Authed, Channel, ChannelPerm, LIST_MAX, MaybeAuthed, Member, Message,
    NAME_MAX, OFFSET_MAX, OkResp, Paged, ProfanityTarget, Role, RoleLimits, SLOWMODE_MAX,
    ServerDetail, ServerSummary, ServerSummaryLite, Settings, TOPIC_MAX, UserRef, allowed,
    check_len, check_profanity, cursor_int, decode_cursor, encode_cursor, header_grants, ok,
    page_bounds, placeholders, require_guest_ok, unique_capped, user_from, user_ref, user_refs,
    valid_color,
};
use crate::db::{ChannelKind, Db, NO_PERMANENT_HASH, User, lock_server, now, shift_member_count};
use crate::limits::Limits;
use crate::state::AppState;
use crate::ws::{Hub, WsEvent, voice_rules_changed};
use rchat_perms::delta::{self, Refusal};
use rchat_perms::eval::{self, Mode, Ow, Who};
use rchat_perms::hier::{self, Actor, Rank, Tier};
use rchat_perms::rules::HOSTED;
use rchat_perms::{Mask, masks};
use rchat_perms::{looks, order};

/// Request body for creating a channel.
#[derive(Deserialize, ToSchema)]
pub struct CreateChannelReq {
    /// Channel name. Surrounding whitespace is trimmed; must not be blank, at most 100
    /// characters, must pass the channel-name profanity filter and must not equal the name of
    /// another channel in the server (exact, case-sensitive comparison).
    #[schema(example = "general")]
    name: String,
    /// Channel kind, `text` or `voice`. Optional; omitted or `null` creates a text channel.
    kind: Option<ChannelKind>,
    /// Create the channel with `restrict_view` on, so only people who manage channels see it
    /// until rules are added. Optional; omitted means off.
    #[serde(default)]
    restrict_view: bool,
    /// Start a text channel with text-only messages.
    #[serde(default)]
    text_only: bool,
    /// Category to list the channel under, at its end. Optional; omitted or `null` lists it
    /// at the end of the channels without a category.
    #[serde(default)]
    category_id: Option<i64>,
}

/// Request body for creating a server.
#[derive(Deserialize, ToSchema)]
pub struct CreateServerReq {
    /// Server name. Surrounding whitespace is trimmed and the result becomes the
    /// `display_name`; its lowercase form becomes the `name` used in URLs. Must not be blank,
    /// at most 100 characters, not `.` or `..`, must pass the server-name profanity filter and
    /// must not be taken by another server (case-insensitive).
    #[schema(example = "Club")]
    name: String,
    /// Optional join password. Surrounding whitespace is trimmed; omitted, `null` or blank
    /// creates a server without a password. Only for `join: password`.
    password: Option<String>,
    /// How the server starts.
    #[serde(flatten)]
    options: ServerOptions,
}

/// How a new server starts. Every field is optional; without them anyone joins the server by
/// its name, or with its password when `password` is set.
#[derive(Default, Deserialize, ToSchema)]
pub struct ServerOptions {
    /// How people join: `name` (anyone who knows the name), `invite` (only with an invite link
    /// or a password the managers make), `password` (the name and `password`) or `closed`
    /// (nobody new). Default: `password` when `password` is set, otherwise `name`. An `invite`
    /// or `closed` server gets a random key of 10 characters for its URLs, and its name is only
    /// a label that other servers may share. `name` is refused while the instance's
    /// `server_joining` is `invites`.
    #[serde(default)]
    pub(crate) join: Option<JoinMode>,
    /// Whether server search lists the server for people who aren't members while they can
    /// read it by its name. Default `true`; `true` only for `name` and `password` servers.
    #[serde(default)]
    pub(crate) listed: Option<bool>,
    /// "Anyone can read this server", as in `PATCH /api/v1/servers/{name}`: `true` or `false`;
    /// omit to follow the instance. `true` is refused while the instance's `public_reading` is
    /// off.
    #[serde(default)]
    pub(crate) public_read: Option<bool>,
    /// The channels it starts with: `text` (a text channel `general`, the default) or
    /// `text_voice` (also a voice channel `Voice`).
    #[serde(default)]
    pub(crate) channels: Option<StartChannels>,
    /// Join and leave notices in its first channel. Default `true`.
    #[serde(default)]
    pub(crate) notices: Option<bool>,
    /// How long uploaded files stay, as in `PUT /api/v1/servers/{name}/upload_expiry`. Default:
    /// the instance's time.
    #[serde(default)]
    pub(crate) upload_expiry: Option<crate::api::upload_expiry::UploadExpiry>,
    /// For `join: invite`: give it an invite link now, which any member may share (default
    /// `true`); `false` leaves it to links its managers make later. Only for invite servers.
    #[serde(default)]
    pub(crate) standing_link: Option<bool>,
}

/// A new server, with its invite link.
#[derive(Serialize, ToSchema)]
pub struct CreatedServer {
    /// The server (its fields appear at the top level).
    #[serde(flatten)]
    pub server: ServerDetail,
    /// The invite link of a new `invite` server, unless `standing_link` was `false`; `null`
    /// otherwise.
    pub invite: Option<crate::api::passwords::InviteLinkInfo>,
}

/// Optional request body for joining a server.
#[derive(Deserialize, ToSchema)]
pub struct JoinReq {
    /// The server password. Ignored for servers without a password and for servers you are
    /// already a member of. Omitted or blank asks the API whether a password is needed: the
    /// answer is `401 Password required` for every name that is not a public server.
    password: Option<String>,
}

/// What happens to the other members when a server password is set, changed or cleared:
/// `keep` (default) keeps everyone; `remove` removes every other member the caller could kick
/// (see `ServerDetail.roles_order_confirmed`).
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PasswordMembers {
    #[default]
    Keep,
    Remove,
}

/// Request body for updating a server. Every field is optional; omitted fields are left
/// unchanged.
#[derive(Deserialize, ToSchema)]
pub struct ServerPatch {
    /// New server name, with the same rules as when creating a server (trimmed, 1-100
    /// characters, not `.` or `..`, profanity-filtered, not taken). Changes the lowercase `name`
    /// used in URLs as well as the `display_name`. On the built-in rchat server only the
    /// `display_name` changes: its key and URLs stay `rchat`.
    name: Option<String>,
    /// New permanent join password. Surrounding whitespace is trimmed; a blank value removes
    /// the permanent password, which makes the server public unless `protected` is `true`. Omit
    /// to leave the password as it is. Not allowed on the rchat server.
    password: Option<String>,
    /// `false` makes the server public: the permanent password is removed and every extra
    /// password is revoked. `true` makes it password protected; without a permanent password
    /// and without live extra passwords it is closed (nobody new can join). Omit to keep the
    /// current state. Not allowed on the rchat server.
    protected: Option<bool>,
    /// What to do with the other members when `password` is present: `keep` (default) or
    /// `remove`. Ignored when `password` is omitted.
    #[serde(default)]
    members: PasswordMembers,
    /// When `password` is present, existing guest grants are revoked unless this is `true` and
    /// `members` is `keep`. Defaults to `false`.
    #[serde(default)]
    keep_guests: bool,
    /// Background color of the channel sidebar header as `#rrggbb` (stored lowercase). `null`
    /// resets it to the theme color; omit to leave it unchanged.
    #[serde(default, deserialize_with = "crate::api::auth::present")]
    #[schema(value_type = Option<String>, example = "#1e293b")]
    banner_color: Option<Option<String>>,
    /// Color of the server name in the channel sidebar header as `#rrggbb` (stored lowercase).
    /// `null` resets it to the theme color; omit to leave it unchanged.
    #[serde(default, deserialize_with = "crate::api::auth::present")]
    #[schema(value_type = Option<String>, example = "#f8fafc")]
    name_color: Option<Option<String>>,
    /// "Anyone can read this server": `true` lets people who aren't members read the server by
    /// its name without joining (guests too, while guest access is on), `false` never does,
    /// `null` follows the instance again (readable while the server has no password and
    /// `server_joining` is `everyone`). It lets nobody join or post; readers may use its voice
    /// channels. Omit to leave it unchanged. `true` is refused while the instance's
    /// `public_reading` is off.
    #[serde(default, deserialize_with = "crate::api::auth::present")]
    #[schema(value_type = Option<bool>)]
    public_read: Option<Option<bool>>,
    /// Accepts false to disable guest voice. Enabling it requires guest_voice_opt_in.
    guest_voice: Option<bool>,
    /// Allow guests to talk in voice channels when the site permits it.
    guest_voice_opt_in: Option<bool>,
    /// Allow guests to send text when the site permits it.
    guest_chat_opt_in: Option<bool>,
    /// "Members can be seen by people outside this server": `false` shows the member list,
    /// members' profiles and their membership only to other members (and the member list to
    /// instance staff), and finds members by name through the server only for other members
    /// (a member whose own choice is `everyone` still shows their profile and is found by
    /// name, but not as a member), and leaves the server's `join` and `leave` messages out of
    /// what people outside it read; `true` (the default) also for people who open the server
    /// without being a member. Omit to leave it unchanged.
    members_visible: Option<bool>,
    /// "Allow members to view the member list" off (`true`): only members with Manage server,
    /// Manage roles or Kick and ban, and instance staff, get the member list, presence and
    /// mention suggestions; `false` (the default) leaves it to View members. Omit to leave it
    /// unchanged.
    #[serde(default)]
    hide_members: Option<bool>,
    /// How people join: `name`, `invite`, `password` or `closed` (see `POST /api/v1/servers`).
    /// Use it instead of `protected`. `password` needs `password`, unless the server has a
    /// permanent password already. `invite` and `closed` remove the permanent password, and
    /// `closed` revokes every extra password. A server that turns to `name` or `password`
    /// takes its lowercase name as its key, which must be free. `name` is refused while the
    /// instance's `server_joining` is `invites`. Not allowed on the rchat server. Omit to
    /// leave it unchanged.
    #[serde(default)]
    join: Option<JoinMode>,
    /// Whether server search lists the server for people who aren't members (see
    /// `POST /api/v1/servers`). `true` only for `name` and `password` servers. Omit to leave it
    /// unchanged.
    #[serde(default)]
    listed: Option<bool>,
    /// What members may set in their server profile: `all` (the default), `no_names` or `off`.
    /// Stored profiles are kept and not shown while a mode leaves them out. Omit to leave it
    /// unchanged.
    #[serde(default)]
    profiles_mode: Option<crate::api::profiles::ProfilesMode>,
    /// What the server is about, shown on invite cards and in server search: plain text, at
    /// most 300 characters (code points) after cleanup (trimmed, control characters other than
    /// newlines dropped, runs of 3 or more newlines cut to 2). Checked by the profanity filter
    /// (`server_names` target). Empty or `null` clears it. Omit to keep it.
    #[serde(default, deserialize_with = "crate::api::auth::present")]
    #[schema(value_type = Option<String>, example = "Rust help and chat")]
    description: Option<Option<String>>,
    /// How the server's icon is drawn: `letter` or `identicon` (see `ServerSummaryLite`). Omit
    /// to keep it.
    #[serde(default)]
    icon_kind: Option<IconKind>,
    /// Whether new messages, edits and polls of the server are stored encrypted with a key this
    /// site keeps. Messages stored before stay as they were, and turning it off decrypts
    /// nothing. This is not end-to-end encryption. A change posts a `storage` system message.
    /// Omit to leave it unchanged.
    #[serde(default)]
    seal: Option<bool>,
}

/// The server after an update, plus how many members a password change removed.
#[derive(Serialize, ToSchema)]
pub struct ServerUpdated {
    /// The server as it is after the update (its fields appear at the top level).
    #[serde(flatten)]
    pub server: ServerSummaryLite,
    /// Number of members removed because `members` was `remove`; 0 otherwise.
    pub removed: i64,
    /// Number of members other than the caller who are still in the server.
    pub kept: i64,
}

/// Request body for updating a channel. Every field is optional; omitted fields are left
/// unchanged.
#[derive(Default, Deserialize, ToSchema)]
pub struct ChannelPatch {
    /// New channel name: trimmed, not blank, at most 100 characters, profanity-filtered and
    /// not equal to the name of another channel in the server.
    name: Option<String>,
    /// Slow mode delay in seconds between messages from the same user, 0 (off) to 21600.
    /// Voice channels only accept 0.
    #[schema(example = 10)]
    slowmode_seconds: Option<i64>,
    /// Require roles to view: only roles and members with a `can_view` rule (and people who
    /// manage channels) can see the channel. With no rules, only they can.
    restrict_view: Option<bool>,
    /// Require roles to send: only roles and members with a `can_send` rule (and people who
    /// manage channels) can send. With no rules, only they can. Voice channels only accept
    /// `false`.
    restrict_send: Option<bool>,
    /// Set the shared sensitive-content label. Omit to keep it.
    sensitive: Option<bool>,
    /// Disable new attachments, previews, rich embeds and polls in a text channel.
    text_only: Option<bool>,
    /// Channel topic, plain text where links show as links. At most 1024 characters (code
    /// points) after cleanup: trimmed, control characters other than newlines dropped, runs of
    /// 3 or more newlines cut to 2. Checked by the profanity filter (`channel_topics` target).
    /// Empty or `null` clears it. Omit to keep it.
    #[serde(default, deserialize_with = "present")]
    #[schema(value_type = Option<String>)]
    topic: Option<Option<String>>,
}

/// Request body naming a user.
#[derive(Deserialize, ToSchema)]
pub struct UsernameReq {
    /// Target username, case-insensitive.
    #[schema(example = "alice")]
    username: String,
}

/// Request body for setting a server admin's permissions.
#[derive(Deserialize, ToSchema)]
pub struct PermsReq {
    /// Permission bitmask: 1 Manage channels, 2 Manage messages (delete messages of others and
    /// close their polls), 4 Kick, 8 Delete server, 16 Manage admins, 32 Mention everyone and
    /// roles, 64 View audit log, 128 Timeout members, 256 Manage webhooks, 512 Manage reports,
    /// 4096 Manage server settings, 8192 Manage invites, 16384 Manage roles, 32768 Assign roles,
    /// 65536 Reset server profiles, 536870912 Pin messages and 1073741824 Bypass slow mode. Bits
    /// outside 1610740735 are dropped. For an admin, 0 means all permissions.
    #[schema(example = 7)]
    perms: i64,
    /// The permission bits `perms` sets; send 1610740735. The admin keeps the bits they hold
    /// outside it. Set bits within 1023 are also added for compatibility. Defaults to 511.
    #[schema(example = 1610740735)]
    mask: Option<i64>,
}

/// Request body for creating a role.
#[derive(Deserialize, ToSchema)]
pub struct RoleReq {
    /// Role name: trimmed, not blank, at most 100 characters and profanity-filtered. Names do
    /// not have to be unique.
    #[schema(example = "Moderators")]
    name: String,
    /// Role color as `#rrggbb`, stored as sent.
    #[schema(example = "#22c55e")]
    color: String,
    /// Permission bitmask for members with the role: 1 Manage channels, 2 Manage messages (delete
    /// messages of others and close their polls), 4 Kick, 8 Delete server, 16 Manage admins, 32
    /// Mention everyone and roles, 64 View audit log, 128 Timeout members, 256 Manage webhooks, 512
    /// Manage reports, 4096 Manage server settings, 8192 Manage invites, 16384 Manage roles, 32768
    /// Assign roles, 65536 Reset server profiles, 536870912 Pin messages and 1073741824 Bypass slow
    /// mode,
    /// and the bits everyone can hold (see `PATCH /api/v1/servers/{name}/everyone`). Other bits
    /// are dropped. Roles only add permissions to members who are not admins. Admins use their
    /// own admin permissions and get only the bits everyone can hold from their roles.
    #[schema(example = 6)]
    perms: i64,
    /// Anyone who can send may mention the role (default `false`: only members with the Mention
    /// everyone permission can). Turning it on needs the Mention everyone permission.
    #[serde(default)]
    mentionable: bool,
}

/// Request body for updating a role. Every field is optional; omitted fields are left
/// unchanged.
#[derive(Deserialize, ToSchema)]
pub struct RolePatch {
    /// Bits covered by a permissions update. Defaults to 1023. Bits outside the mask are kept,
    /// and set bits within 1023 are also added. Include delegated permissions in the mask to change them.
    mask: Option<i64>,
    /// New role name: trimmed, not blank, at most 100 characters and profanity-filtered.
    name: Option<String>,
    /// New role color as `#rrggbb`, stored as sent.
    color: Option<String>,
    /// New permission bitmask (see `RoleReq.perms`). Bits no role can hold are dropped.
    perms: Option<i64>,
    /// Whether anyone who can send may mention the role (see `RoleReq.mentionable`). Turning it
    /// on needs the Mention everyone permission.
    mentionable: Option<bool>,
    /// One emoji shown after the names of the role's members, stored as its fully-qualified
    /// sequence (see `Role.icon`). `null` or a blank text removes it. Omit to keep it.
    #[serde(default, deserialize_with = "crate::api::auth::present")]
    #[schema(value_type = Option<String>)]
    icon: Option<Option<String>>,
    /// Whether the role's members show in a group of their own in the member list (see
    /// `Role.hoist`).
    hoist: Option<bool>,
    /// Whether the role colors the names of its members (see `Role.color_names`).
    color_names: Option<bool>,
}

/// Request body for getting guest access to a password-protected server.
#[derive(Deserialize, ToSchema)]
pub struct GuestAccessReq {
    /// The server password. Omitted or blank answers `401 Password required` for every name
    /// that is not a public server.
    #[serde(default)]
    password: Option<String>,
}

/// A guest grant for a password-protected server.
#[derive(Serialize, ToSchema)]
pub struct GuestGrant {
    /// Opaque grant token. Guests send it in the `X-Guest-Grant` header (comma-separated with
    /// other grants) to view this server. It expires after `GUEST_GRANT_DAYS` days without use
    /// (an instance setting, 30 by default) and is revoked when the server password changes, unless
    /// the change kept guests. `null` for a server without a password: guests view it without a
    /// grant.
    grant: Option<String>,
}

/// Whether a server name is free to create.
#[derive(Serialize, ToSchema)]
pub struct ServerAvailable {
    /// `true` when no server (public or password-protected) uses this name.
    available: bool,
}

/// Query parameters for server search.
#[derive(Deserialize, IntoParams)]
pub struct ServerSearchQuery {
    /// Search text, trimmed and case-insensitive. Up to 8 characters it matches names that
    /// contain the characters in order (fuzzy); longer queries match as a substring of the
    /// name or display name. Omitted or blank returns an empty list.
    #[param(example = "club")]
    q: Option<String>,
}

/// A server returned by server search.
#[derive(Serialize, ToSchema)]
pub struct ServerMatch {
    /// Lowercase server name, used in URLs.
    #[schema(example = "club")]
    pub name: String,
    /// Server name in its original case.
    #[schema(example = "Club")]
    pub display_name: String,
    /// `true` when joining the server needs a password.
    pub has_password: bool,
    /// What the server is about (see `ServerSummaryLite`).
    pub description: Option<String>,
    /// How its icon is drawn (see `ServerSummaryLite`).
    pub icon_kind: IconKind,
    /// The id of its uploaded picture (see `ServerSummaryLite`); `null` without one.
    pub icon_image: Option<String>,
    /// The color its icon is drawn on, as `#rrggbb`; `null` uses the theme color.
    pub banner_color: Option<String>,
}

/// A user banned from a server.
#[derive(Serialize, ToSchema)]
pub struct ServerBan {
    /// The banned user (their fields appear at the top level).
    #[serde(flatten)]
    pub user: UserRef,
    /// When the ban was created, Unix seconds.
    pub banned_at: i64,
    /// When the ban ends, Unix seconds; `null` for a ban without an end.
    pub expires_at: Option<i64>,
    /// The reason given with the ban.
    pub reason: Option<String>,
}

/// The viewer's relation to an invited server: `member` (already a member), `banned` (banned
/// from the server), `joinable` (may join now: no password, or the invite password or a guest
/// grant was accepted) or `readable` (may read it, as anyone may, but what was shown doesn't
/// join it: joining needs a password or invite, or nobody new may join). Guests never get
/// `member` or `banned`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum InviteStatus {
    Member,
    Banned,
    Joinable,
    Readable,
}

/// An invite card for a server.
#[derive(Serialize, ToSchema)]
pub struct Invite {
    /// The invited server.
    pub server: ServerSummaryLite,
    /// Number of members.
    pub member_count: i64,
    /// Number of members online now.
    pub online_count: i64,
    /// The viewer's relation to the server.
    pub status: InviteStatus,
    /// Name of the channel the preview comes from: the first text channel without any
    /// permission rules. `null` when the viewer is banned or no such channel exists.
    pub preview_channel: Option<String>,
    /// Stable identifier of the authorized preview channel.
    pub preview_channel_id: Option<i64>,
    /// The shared viewing label of the authorized preview channel.
    pub preview_sensitive: bool,
    /// The last 3 top-level messages of `preview_channel`. Empty when the viewer is banned or
    /// there is no preview channel.
    pub preview: Vec<Message>,
    /// When the extra password that unlocked this card expires, Unix seconds. `null` unless an
    /// extra password with an expiry unlocked it.
    pub password_expires_at: Option<i64>,
    /// Uses left on the extra password that unlocked this card. `null` unless an extra
    /// password with a use limit unlocked it.
    pub password_uses_left: Option<i64>,
}

/// Where a member list shows.
#[derive(Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ListScope {
    /// The channel the list shows in: View members is read there. A channel of another server,
    /// or one the caller can't view, gives the uniform 404.
    channel_id: Option<i64>,
}

/// Paging query parameters.
#[derive(Deserialize, IntoParams)]
pub struct MembersQuery {
    /// Legacy offset paging: number of items to skip (negative counts as 0). Ignored when
    /// `cursor` is given.
    pub(crate) offset: Option<i64>,
    /// Page size, default 50, clamped to 1-50.
    pub(crate) limit: Option<i64>,
    /// Opaque cursor from the previous page's `X-Next-Cursor` header. Blank means the first
    /// page.
    pub(crate) cursor: Option<String>,
}

/// Query parameters for listing your servers.
#[derive(IntoParams)]
#[into_params(parameter_in = Query)]
pub struct MyServersQuery {
    /// Legacy offset paging: number of servers to skip, clamped to 0-1000000. Ignored when
    /// `cursor` or `names` is given. Must be an integer.
    offset: Option<i64>,
    /// Page size, default 50, clamped to 1-100. Ignored with `names`. Must be an integer.
    limit: Option<i64>,
    /// Opaque cursor from the previous page's `X-Next-Cursor` header. Blank means the first
    /// page. Ignored with `names`.
    cursor: Option<String>,
    /// Only return these servers (case-insensitive names), repeated once per server, e.g.
    /// `names=a&names=b`. Duplicates and blanks are dropped and only the first 100 count.
    /// Servers you are not a member of are skipped. Disables paging.
    names: Option<Vec<String>>,
}

struct PagedList {
    offset: Option<i64>,
    limit: Option<i64>,
    cursor: Option<String>,
    list: Option<Vec<String>>,
}

fn paged_list(raw: &str, list_key: &str) -> Result<PagedList, ApiError> {
    let int = |v: &str| {
        v.parse::<i64>()
            .map_err(|_| ApiError::invalid("Invalid number", "query"))
    };
    let mut out = PagedList {
        offset: None,
        limit: None,
        cursor: None,
        list: None,
    };
    for (key, value) in url::form_urlencoded::parse(raw.as_bytes()) {
        match key.as_ref() {
            "offset" => out.offset = Some(int(&value)?),
            "limit" => out.limit = Some(int(&value)?),
            "cursor" if !value.trim().is_empty() => out.cursor = Some(value.into_owned()),
            k if k == list_key => out
                .list
                .get_or_insert_with(Vec::new)
                .push(value.into_owned()),
            _ => {}
        }
    }
    Ok(out)
}

impl MyServersQuery {
    fn parse(raw: &str) -> Result<MyServersQuery, ApiError> {
        let PagedList {
            offset,
            limit,
            cursor,
            list,
        } = paged_list(raw, "names")?;
        Ok(MyServersQuery {
            offset,
            limit,
            cursor,
            names: list,
        })
    }
}

/// Query parameters for listing server members.
#[derive(IntoParams)]
#[into_params(parameter_in = Query)]
pub struct MemberListQuery {
    /// Legacy offset paging for the default (online-first) listing: number of members to skip,
    /// clamped to 0-1000000. Ignored when `cursor`, `usernames`, `q`, `admins`, `top_hoisted`
    /// or `unhoisted` is given. Must be an integer.
    offset: Option<i64>,
    /// Page size, default 50, clamped to 1-50. Ignored with `usernames`. Must be an integer.
    limit: Option<i64>,
    /// Opaque cursor from the previous page's `X-Next-Cursor` header. Blank means the first
    /// page. A cursor only works with the same kind of listing (default, `q`/`admins`, or one
    /// group) that produced it. Ignored with `usernames`.
    cursor: Option<String>,
    /// Only return these users (case-insensitive usernames), repeated once per user, e.g.
    /// `usernames=a&usernames=b`. Duplicates and blanks are dropped and only the first 100
    /// count. Non-members are skipped. Disables paging and takes precedence over `q` and
    /// `admins`.
    usernames: Option<Vec<String>>,
    /// Username prefix, trimmed and case-insensitive. Returns matching members alphabetically
    /// instead of online first.
    q: Option<String>,
    /// `1` or `true` returns only server admins, alphabetically; any other value is ignored.
    admins: Option<bool>,
    /// `1` or `true` with a non-blank `q` (mention autocomplete): the members
    /// `GET /api/v1/servers/{name}/mentions` suggests, as member rows, unpaged. Ignored without
    /// `q` and when `usernames` is given.
    suggest: Option<bool>,
    /// A role id, with `top_hoisted`. Must be an integer.
    role: Option<i64>,
    /// `1` or `true` with `role`: the members the member list shows in that role's group, those
    /// whose first role in display order that forms a group is this one (see `Role.hoist`),
    /// alphabetically, paged by `cursor`. Empty when the role forms no group. Ignored when
    /// `usernames`, `q` or `admins` is given.
    top_hoisted: Option<bool>,
    /// `1` or `true`: the members in no group of the member list, alphabetically, paged by
    /// `cursor`. Ignored when `usernames`, `q` or `admins` is given.
    unhoisted: Option<bool>,
    /// The channel the list shows in: View members is read there (see
    /// `ServerSummaryLite.hide_members`). A channel of another server, or one the caller can't
    /// view, gives the uniform 404. Must be an integer.
    channel_id: Option<i64>,
}

impl MemberListQuery {
    /// The lookup class of the listing: mention suggestions, or a member list.
    pub(crate) fn class(&self) -> LookupClass {
        match (&self.usernames, self.suggest, &self.q) {
            (None, Some(true), Some(_)) => LookupClass::Typeahead,
            (_, _, _) => LookupClass::List,
        }
    }

    pub(crate) fn parse(raw: &str) -> Result<MemberListQuery, ApiError> {
        let PagedList {
            offset,
            limit,
            cursor,
            list,
        } = paged_list(raw, "usernames")?;
        let mut q = None;
        let mut admins = None;
        let mut suggest = None;
        let mut role = None;
        let mut top_hoisted = None;
        let mut unhoisted = None;
        let mut channel_id = None;
        for (key, value) in url::form_urlencoded::parse(raw.as_bytes()) {
            match key.as_ref() {
                "q" if !value.trim().is_empty() => {
                    check_len(value.trim(), NAME_MAX, "Search text")?;
                    q = Some(value.trim().to_lowercase())
                }
                "admins" => admins = Some(matches!(value.as_ref(), "1" | "true")),
                "suggest" => suggest = Some(matches!(value.as_ref(), "1" | "true")),
                "role" => {
                    role = Some(
                        value
                            .parse()
                            .map_err(|_| ApiError::invalid("Invalid role", "role"))?,
                    )
                }
                "top_hoisted" => top_hoisted = Some(matches!(value.as_ref(), "1" | "true")),
                "unhoisted" => unhoisted = Some(matches!(value.as_ref(), "1" | "true")),
                "channel_id" => {
                    channel_id = Some(
                        value
                            .parse()
                            .map_err(|_| ApiError::invalid("Invalid channel", "channel_id"))?,
                    )
                }
                _ => {}
            }
        }
        Ok(MemberListQuery {
            offset,
            limit,
            cursor,
            usernames: list,
            q,
            admins,
            suggest,
            role,
            top_hoisted,
            unhoisted,
            channel_id,
        })
    }
}

pub const SUGGEST_MAX: usize = 10;
/// Rows each kind of match reads before the lookup rule leaves out who the caller may not find.
const SUGGEST_ROWS: i64 = 50;

/// Members of `server` whose username, then whose display name, then whose name in the server,
/// starts with `q`, each alphabetical, at most `SUGGEST_ROWS` of each.
async fn suggested_members(db: &Db, server: &str, q: &str) -> Result<Vec<MemberRow>, ApiError> {
    let (mut rows, _) =
        filtered_members(db, server, Some(q), false, Some(SUGGEST_ROWS), None).await?;
    let col = match crate::db::is_sqlite(db) {
        true => "lower(u.display_name)",
        false => "(lower(u.display_name) COLLATE \"C\")",
    };
    let end = match prefix_end(q) {
        Some(_) => format!(" AND {col} < $4"),
        None => String::new(),
    };
    let sql = format!(
        "SELECT m.username, m.is_admin, m.perms FROM users u JOIN members m ON m.username = u.username AND m.server = $1 WHERE {col} >= $2{end} ORDER BY {col}, m.username LIMIT $3"
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(server)
        .bind(q)
        .bind(SUGGEST_ROWS);
    if let Some(end) = prefix_end(q) {
        query = query.bind(end);
    }
    let by_name = query.fetch_all(db).await?;
    for row in member_rows(&by_name)? {
        if !rows.iter().any(|(name, _, _)| *name == row.0) {
            rows.push(row);
        }
    }
    let named =
        crate::api::profiles::named_like(db, server, q, prefix_end(q).as_deref(), SUGGEST_ROWS)
            .await?;
    let by_profile: Vec<String> = named
        .into_iter()
        .filter(|name| !rows.iter().any(|(listed, _, _)| listed == name))
        .collect();
    let mut found = members_by_names(db, server, &by_profile).await?;
    found.sort_by_key(|(name, _, _)| by_profile.iter().position(|n| n == name));
    rows.extend(found);
    Ok(rows)
}

/// Mention suggestions from the member list `list`: at most `SUGGEST_MAX` of the server's
/// members whose username, display name or name in the server starts with `q`, username matches
/// first, only ones the caller may find by name (the lookup rule with the server named). Only
/// signed-in members and signed-in readers of a server anyone can read get any.
async fn mentionable(
    state: &AppState,
    list: &MemberList<'_>,
    viewer: Option<&User>,
    proof: &Proof<'_>,
    q: &str,
) -> Result<Vec<MemberRow>, ApiError> {
    match (viewer, list.access().via()) {
        (Some(_), Via::Member | Via::Public) => {}
        (_, _) => return Ok(Vec::new()),
    }
    let rows = suggested_members(&state.read(), list.server(), q).await?;
    let names: Vec<String> = rows.iter().map(|(name, _, _)| name.clone()).collect();
    let caller = Caller {
        user: viewer,
        proof,
        server: Some(list.server()),
        badge: None,
    };
    let seen = seen_among(state, &caller, &names).await?;
    Ok(rows
        .into_iter()
        .filter(|(name, _, _)| seen.contains_key(name))
        .take(SUGGEST_MAX)
        .collect())
}

pub(crate) fn prefix_end(prefix: &str) -> Option<String> {
    let mut chars: Vec<char> = prefix.chars().collect();
    while let Some(last) = chars.pop() {
        let next = (u32::from(last) + 1..=u32::from(char::MAX)).find_map(char::from_u32);
        if let Some(c) = next {
            chars.push(c);
            return Some(chars.into_iter().collect());
        }
    }
    None
}

async fn filtered_members(
    db: &Db,
    server: &str,
    q: Option<&str>,
    admins: bool,
    limit: Option<i64>,
    cursor: Option<&str>,
) -> Result<(Vec<MemberRow>, Option<String>), ApiError> {
    let limit = limit.unwrap_or(50).clamp(1, 50);
    let after = match cursor {
        Some(raw) => {
            let parts = decode_cursor(raw, 2)?;
            match parts[0].as_str() {
                "s" => Some(parts[1].clone()),
                _ => return Err(ApiError::invalid("Invalid cursor", "cursor")),
            }
        }
        None => None,
    };
    let q = q.filter(|q| !q.is_empty());
    let col = match crate::db::is_sqlite(db) {
        true => "username",
        false => "(username COLLATE \"C\")",
    };
    let mut sql = String::from("SELECT username, is_admin, perms FROM members WHERE server = $1");
    let mut binds: Vec<String> = Vec::new();
    if admins {
        sql.push_str(" AND is_admin <> 0");
    }
    match (&after, q) {
        (Some(a), _) => {
            binds.push(a.clone());
            sql.push_str(&format!(" AND {col} > ${}", binds.len() + 1));
        }
        (None, Some(q)) => {
            binds.push(q.to_string());
            sql.push_str(&format!(" AND {col} >= ${}", binds.len() + 1));
        }
        (None, None) => {}
    }
    if let Some(end) = q.and_then(prefix_end) {
        binds.push(end);
        sql.push_str(&format!(" AND {col} < ${}", binds.len() + 1));
    }
    sql.push_str(&format!(" ORDER BY {col} LIMIT ${}", binds.len() + 2));
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(server);
    for b in &binds {
        query = query.bind(b);
    }
    let mut rows = member_rows(&query.bind(limit + 1).fetch_all(db).await?)?;
    rows.retain(|(name, _, _)| q.is_none_or(|q| name.starts_with(q)));
    let more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);
    let next = match (more, rows.last()) {
        (true, Some((name, _, _))) => Some(encode_cursor(&["s", name])),
        _ => None,
    };
    Ok((rows, next))
}

/// The roles of `server` whose members show as groups in the member list, in display order.
pub(crate) async fn hoist_groups(db: &Db, server: &str) -> Result<Vec<i64>, ApiError> {
    let rows = sqlx::query(
        "SELECT id, position, display_position, hoist FROM roles WHERE server = $1 ORDER BY position DESC, id",
    )
    .bind(server)
    .fetch_all(db)
    .await?;
    let mut ids = Vec::with_capacity(rows.len());
    let mut shown = Vec::with_capacity(rows.len());
    for r in &rows {
        ids.push(r.try_get::<i64, _>(0)?);
        shown.push(looks::Look {
            place: r
                .try_get::<Option<i64>, _>(2)?
                .unwrap_or(r.try_get::<i64, _>(1)?),
            hoist: r.try_get::<i64, _>(3)? != 0,
        });
    }
    Ok(looks::groups(&shown).into_iter().map(|i| ids[i]).collect())
}

/// A page of the members the member list shows in the group of role `group` (`None`: in no
/// group), alphabetical by username: those who hold it and no group role above it in display
/// order.
async fn grouped_members(
    db: &Db,
    server: &str,
    group: Option<i64>,
    limit: Option<i64>,
    cursor: Option<&str>,
) -> Result<(Vec<MemberRow>, Option<String>), ApiError> {
    let limit = limit.unwrap_or(50).clamp(1, 50);
    let tag = group.map_or_else(|| "rest".to_string(), |id| id.to_string());
    let after = match cursor {
        Some(raw) => {
            let parts = decode_cursor(raw, 3)?;
            match parts[0] == "g" && parts[1] == tag {
                true => Some(parts[2].clone()),
                false => return Err(ApiError::invalid("Invalid cursor", "cursor")),
            }
        }
        None => None,
    };
    let groups = hoist_groups(db, server).await?;
    let above = match group {
        Some(id) => match groups.iter().position(|g| *g == id) {
            Some(at) => &groups[..at],
            None => return Ok((Vec::new(), None)),
        },
        None => &groups[..],
    };
    let (mut sql, mut next, by) = match group {
        Some(_) => (
            String::from(
                "SELECT m.username, m.is_admin, m.perms FROM user_roles ur JOIN members m ON m.server = ur.server AND m.username = ur.username WHERE ur.role_id = $1 AND ur.server = $2",
            ),
            3,
            "ur.username",
        ),
        None => (
            String::from(
                "SELECT m.username, m.is_admin, m.perms FROM members m WHERE m.server = $1",
            ),
            2,
            "m.username",
        ),
    };
    if after.is_some() {
        sql.push_str(&format!(" AND {by} > ${next}"));
        next += 1;
    }
    if !above.is_empty() {
        sql.push_str(&format!(
            " AND NOT EXISTS(SELECT 1 FROM user_roles h WHERE h.server = m.server AND h.username = m.username AND h.role_id IN ({}))",
            placeholders(next, above.len())
        ));
        next += above.len();
    }
    sql.push_str(&format!(" ORDER BY {by} LIMIT ${next}"));
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
    if let Some(id) = group {
        query = query.bind(id);
    }
    query = query.bind(server);
    if let Some(after) = &after {
        query = query.bind(after);
    }
    for id in above {
        query = query.bind(*id);
    }
    let mut rows = member_rows(&query.bind(limit + 1).fetch_all(db).await?)?;
    let more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);
    let next = match (more, rows.last()) {
        (true, Some((name, _, _))) => Some(encode_cursor(&["g", &tag, name])),
        _ => None,
    };
    Ok((rows, next))
}

pub const CHANNEL_PERM_MAX: i64 = 500;

fn not_found(msg: &str) -> ApiError {
    ApiError(StatusCode::NOT_FOUND, msg.to_string(), None)
}

pub(crate) async fn check_name(
    db: &Db,
    target: ProfanityTarget,
    what: &str,
    name: &str,
) -> Result<(), ApiError> {
    if name.trim().is_empty() {
        return Err(ApiError::invalid("Name required", "name"));
    }
    check_len(name, NAME_MAX, what)?;
    check_profanity(db, target, name).await
}

async fn check_server_name(db: &Db, name: &str) -> Result<(), ApiError> {
    check_name(db, ProfanityTarget::ServerNames, "Server name", name).await?;
    match name {
        "." | ".." => Err(ApiError::invalid(
            "Server name cannot be \".\" or \"..\"",
            "name",
        )),
        _ => Ok(()),
    }
}

/// Whether `key` is the instance's built-in server: the server `rchat`, until the site admin
/// deletes it.
pub(crate) async fn is_builtin(db: &Db, key: &str) -> bool {
    key == crate::db::BUILTIN_SERVER
        && Settings::cached(db).await.builtin_server == crate::api::policy::Builtin::Kept
}

pub(crate) async fn guard_rchat(db: &Db, key: &str) -> Result<(), ApiError> {
    match is_builtin(db, key).await {
        true => Err(ApiError::forced("The rchat server is protected")),
        false => Ok(()),
    }
}

fn announce_kick(hub: &Hub, server: &str, username: &str, banned: bool) {
    hub.broadcast(WsEvent::MemberKicked {
        server: server.to_string(),
        username: username.to_string(),
        banned,
    });
}

async fn role_ids(db: &Db, server: &str, username: &str) -> Result<Vec<i64>, ApiError> {
    Ok(member_role_ids(db, server, username)
        .await?
        .unwrap_or_default())
}

pub(crate) async fn role_ids_of(
    db: &Db,
    server: &str,
    names: &[String],
) -> Result<HashMap<String, Vec<i64>>, ApiError> {
    let mut map: HashMap<String, Vec<i64>> = HashMap::new();
    if names.is_empty() {
        return Ok(map);
    }
    let sql = format!(
        "SELECT username, role_id FROM user_roles WHERE server = $1 AND username IN ({}) ORDER BY role_id",
        placeholders(2, names.len())
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(server);
    for name in names {
        query = query.bind(name);
    }
    for r in &query.fetch_all(db).await? {
        map.entry(r.try_get(0)?).or_default().push(r.try_get(1)?);
    }
    Ok(map)
}

const MY_SERVERS: &str = "SELECT s.name, s.display_name, s.creator, m.is_admin, m.joined_at, s.banner_color, s.name_color, t.until, s.profiles_mode, s.icon_kind, s.icon_image FROM members m JOIN servers s ON s.name = m.server LEFT JOIN member_timeouts t ON t.server = m.server AND t.username = m.username WHERE m.username = $1";

fn summary_rows(rows: &[sqlx::any::AnyRow]) -> Result<Vec<ServerSummary>, ApiError> {
    let t = now();
    let mut servers = Vec::with_capacity(rows.len());
    for r in rows {
        let timed_out_until = r.try_get::<Option<i64>, _>(7)?.filter(|u| *u > t);
        servers.push(ServerSummary {
            name: r.try_get(0)?,
            display_name: r.try_get(1)?,
            creator: r.try_get(2)?,
            is_admin: r.try_get::<i64, _>(3)? != 0,
            banner_color: r.try_get(5)?,
            name_color: r.try_get(6)?,
            icon_kind: IconKind::stored(r.try_get::<Option<String>, _>(9)?.as_deref()),
            icon_image: r.try_get(10)?,
            timed_out_until,
            timed_out_remaining: timed_out_until.map(|u| u - t),
            profiles_mode: crate::api::profiles::ProfilesMode::parse(&r.try_get::<String, _>(8)?),
        });
    }
    Ok(servers)
}

pub(crate) struct Page<T> {
    pub items: Vec<T>,
    pub more: bool,
    pub next: Option<String>,
}

pub(crate) async fn my_servers_page(
    db: &Db,
    username: &str,
    offset: i64,
    cursor: Option<&str>,
    limit: i64,
) -> Result<Page<ServerSummary>, ApiError> {
    let mut rows = match cursor {
        Some(raw) => {
            let parts = decode_cursor(raw, 2)?;
            let sql = format!(
                "{MY_SERVERS} AND (m.joined_at, m.server) > ($2, $3) ORDER BY m.joined_at, m.server LIMIT $4"
            );
            sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(username)
                .bind(cursor_int(&parts[0])?)
                .bind(parts[1].clone())
                .bind(limit + 1)
                .fetch_all(db)
                .await?
        }
        None => {
            let sql = format!("{MY_SERVERS} ORDER BY m.joined_at, m.server LIMIT $2 OFFSET $3");
            sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(username)
                .bind(limit + 1)
                .bind(offset)
                .fetch_all(db)
                .await?
        }
    };
    let more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);
    let next = match (more, rows.last()) {
        (true, Some(r)) => Some(encode_cursor(&[
            &r.try_get::<i64, _>(4)?.to_string(),
            &r.try_get::<String, _>(0)?,
        ])),
        _ => None,
    };
    Ok(Page {
        items: summary_rows(&rows)?,
        more,
        next,
    })
}

pub(crate) async fn my_servers_by_names(
    db: &Db,
    username: &str,
    names: &[String],
) -> Result<Vec<ServerSummary>, ApiError> {
    if names.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "{MY_SERVERS} AND m.server IN ({}) ORDER BY m.joined_at, m.server",
        placeholders(2, names.len())
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(username);
    for name in names {
        query = query.bind(name);
    }
    summary_rows(&query.fetch_all(db).await?)
}

/// List your servers
///
/// Returns the servers the signed-in user is a member of, oldest membership first, as pages of
/// `limit` (default 50, max 100). Page with `cursor` from the `X-Next-Cursor` response header (or
/// the legacy `offset`). With `names` it returns just those servers instead, unpaged, skipping ones
/// you are not a member of. Requires a bearer token. General rate-limit bucket.
#[utoipa::path(
    get,
    path = "/api/v1/me/servers",
    tag = "Account",
    params(MyServersQuery),
    responses(
        (status = 200, description = "A page of the servers you joined, oldest membership first, or just the requested `names`", body = Vec<ServerSummary>, headers(("x-next-cursor" = String, description = "Cursor for the next page; absent on the last page"))),
        (status = 400, description = "Invalid cursor, or a non-integer `offset` or `limit`", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn list_my_servers(
    State(state): State<AppState>,
    Authed(user): Authed,
    RawQuery(raw): RawQuery,
) -> Result<Paged<ServerSummary>, ApiError> {
    let MyServersQuery {
        offset,
        limit,
        cursor,
        names,
    } = MyServersQuery::parse(raw.as_deref().unwrap_or(""))?;
    let db = &state.read();
    match names {
        Some(names) => Ok(Paged(
            my_servers_by_names(
                db,
                &user.username,
                &unique_capped(names.iter().map(|n| n.to_lowercase())),
            )
            .await?,
            None,
        )),
        None => {
            let (offset, limit) = page_bounds(offset, limit);
            let Page {
                items,
                more: _,
                next,
            } = my_servers_page(db, &user.username, offset, cursor.as_deref(), limit).await?;
            Ok(Paged(items, next))
        }
    }
}

pub(crate) async fn build_member(
    db: &Db,
    hub: &Hub,
    server: &str,
    creator: Option<&str>,
    username: &str,
    is_admin: bool,
    perms: i64,
) -> Result<Member, ApiError> {
    Ok(Member {
        user: user_ref(db, username).await,
        is_admin,
        is_creator: creator == Some(username),
        online: hub.is_online(server, username),
        perms,
        role_ids: role_ids(db, server, username).await?,
        joined_via: None,
        timeout: None,
        profile: crate::api::profiles::look_of(db, server, username).await?,
    })
}

/// The `roles` columns `role_of` reads, in its order, of a row aliased `r`.
pub(crate) const ROLE_COLUMNS: &str = "r.id, r.name, r.color, r.perms, r.mentionable, r.position, r.display_position, r.hoist, r.icon, r.color_names";

/// A role from a row that starts with `ROLE_COLUMNS`.
pub(crate) fn role_of(r: &sqlx::any::AnyRow) -> Result<Role, ApiError> {
    Ok(Role {
        id: r.try_get(0)?,
        name: r.try_get(1)?,
        color: r.try_get(2)?,
        perms: r.try_get(3)?,
        mentionable: r.try_get::<i64, _>(4)? != 0,
        position: r.try_get(5)?,
        display_position: r.try_get(6)?,
        hoist: r.try_get::<i64, _>(7)? != 0,
        icon: r.try_get(8)?,
        color_names: r.try_get::<i64, _>(9)? != 0,
    })
}

pub(crate) async fn server_roles(db: &Db, server: &str) -> Result<Vec<Role>, ApiError> {
    let sql = format!(
        "SELECT {ROLE_COLUMNS} FROM roles r WHERE r.server = $1 ORDER BY r.position DESC, r.id"
    );
    let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(server)
        .fetch_all(db)
        .await?;
    rows.iter().map(role_of).collect()
}

/// The version of the role order of `server` and whether the order is confirmed.
async fn role_order_state<'e, E>(ex: E, server: &str) -> Result<(i64, bool), ApiError>
where
    E: sqlx::Executor<'e, Database = sqlx::Any>,
{
    let row =
        sqlx::query("SELECT roles_version, roles_order_confirmed FROM servers WHERE name = $1")
            .bind(server)
            .fetch_one(ex)
            .await?;
    Ok((row.try_get(0)?, row.try_get::<i64, _>(1)? != 0))
}

/// Text channels among `channels` where the caller, a member, may look but not send (no
/// reacting either). Non-members cannot send anywhere and get none.
fn read_only_channels(
    access: &ServerAccess,
    rights: &HashMap<i64, ChannelAccess>,
    channels: &[Channel],
) -> Vec<i64> {
    if access.viewer().is_some() && !access.is_member() {
        return Vec::new();
    }
    channels
        .iter()
        .filter(|c| c.kind == ChannelKind::Text)
        .filter(|c| rights.get(&c.id).is_some_and(|a| a.view() && !a.send()))
        .map(|c| c.id)
        .collect()
}

fn channel_row(r: &sqlx::any::AnyRow) -> Result<Channel, ApiError> {
    let Restrict {
        view: restrict_view,
        send: restrict_send,
    } = Restrict::read(r, 4)?;
    Ok(Channel {
        id: r.try_get(0)?,
        name: r.try_get(1)?,
        kind: ChannelKind::parse(&r.try_get::<String, _>(2)?)?,
        slowmode_seconds: r.try_get(3)?,
        restrict_view,
        restrict_send,
        topic: r.try_get(6)?,
        category_id: r.try_get(7)?,
        position: r.try_get(8)?,
        sensitive: r.try_get::<i64, _>(9)? != 0,
        text_only: r.try_get::<i64, _>(10)? != 0,
        perm_sync: r.try_get::<i64, _>(11)? != 0,
        my_perms: None,
    })
}

pub(crate) async fn member_count(db: &Db, server: &str) -> Result<i64, ApiError> {
    Ok(
        sqlx::query("SELECT member_count FROM servers WHERE name = $1")
            .bind(server)
            .fetch_optional(db)
            .await?
            .map(|r| r.try_get::<i64, _>(0))
            .transpose()?
            .unwrap_or(0),
    )
}

async fn server_detail(
    db: &Db,
    hub: &Hub,
    access: &ServerAccess,
) -> Result<ServerDetail, ApiError> {
    let ServerSummaryLite {
        name,
        display_name,
        creator,
        has_password,
        banner_color,
        name_color,
        public_read,
        guest_voice,
        guest_chat,
        members_visible,
        hide_members,
        join_mode,
        listed,
        profiles_mode,
        description,
        icon_kind,
        icon_image,
        seal,
    } = access.lite().clone();
    let rows = sqlx::query(
        "SELECT id, name, kind, slowmode_seconds, restrict_view, restrict_send, topic, category_id, position, sensitive, text_only, perm_sync FROM channels WHERE server = $1 ORDER BY position, id",
    )
    .bind(&name)
    .fetch_all(db)
    .await?;
    let rights = access.channel_rights(db).await?;
    let shown = match access.is_member() || access.site_admin() {
        true => masks::CHANNEL as i64,
        false => access.visitor_caps(db).await? as i64,
    };
    let mut channels = Vec::new();
    for r in &rows {
        let id: i64 = r.try_get(0)?;
        if rights.get(&id).is_some_and(|a| !a.view()) {
            continue;
        }
        channels.push(Channel {
            my_perms: rights.get(&id).map(|a| a.mask() & shown),
            ..channel_row(r)?
        });
    }
    let read_only = read_only_channels(access, &rights, &channels);
    let manage = access.manages_channels(db).await?;
    let all = server_categories(db, &name).await?;
    let at: HashMap<i64, usize> = all.iter().enumerate().map(|(i, c)| (c.id, i)).collect();
    channels.sort_by_key(|c| c.category_id.and_then(|id| at.get(&id).map(|i| i + 1)));
    for (i, c) in channels.iter_mut().enumerate() {
        c.position = i as i64;
    }
    let mut categories: Vec<crate::api::Category> = all
        .into_iter()
        .filter(|c| manage || channels.iter().any(|ch| ch.category_id == Some(c.id)))
        .collect();
    for (i, c) in categories.iter_mut().enumerate() {
        c.position = i as i64;
    }
    let visible: HashSet<i64> = channels.iter().map(|c| c.id).collect();
    let seen = current_layout(db, &name)
        .await?
        .map(|full| seen_part(&full, |id| visible.contains(&id), manage));
    let layout_version = match manage {
        true => layout_version(db, &name).await?,
        false => seen.as_ref().map(|l| l.version).unwrap_or_default(),
    };
    let separators = seen.map(|l| l.separators).unwrap_or_default();
    let member_count = member_count(db, &name).await?;
    let online_count = hub.online_count(&name);
    let choice = crate::api::upload_expiry::stored(db, &name).await?;
    let settings = crate::api::Settings::cached(db).await;
    let everyone = access.everyone(db).await?;
    let my_perms = eval::server_bits(&access.standing(db).await?.who, everyone, &HOSTED);
    let (roles_version, roles_order_confirmed) = role_order_state(db, &name).await?;
    Ok(ServerDetail {
        seal,
        name: name.clone(),
        display_name,
        creator,
        has_password,
        banner_color,
        name_color,
        public_read,
        guest_voice,
        guest_chat,
        members_visible,
        hide_members,
        join_mode,
        listed,
        description,
        icon_kind,
        icon_image,
        channels,
        categories,
        separators,
        layout_version,
        read_only,
        roles: server_roles(db, &name).await?,
        roles_version,
        roles_order_confirmed,
        everyone_perms: everyone as i64,
        my_perms: my_perms as i64,
        role_limits: role_limits(db, access).await?,
        member_count,
        online_count,
        profiles_mode,
        my_profile: crate::api::profiles::mine(db, access).await?,
        upload_expiry: choice,
        upload_ttl: choice.lifetime(settings.upload_expiry_max_days),
    })
}

type MemberRow = (String, i64, i64);

fn member_rows(rows: &[sqlx::any::AnyRow]) -> Result<Vec<MemberRow>, ApiError> {
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        out.push((r.try_get(0)?, r.try_get(1)?, r.try_get(2)?));
    }
    Ok(out)
}

async fn members_by_names(
    db: &Db,
    server: &str,
    names: &[String],
) -> Result<Vec<MemberRow>, ApiError> {
    if names.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT username, is_admin, perms FROM members WHERE server = $1 AND username IN ({}) ORDER BY username",
        placeholders(2, names.len())
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(server);
    for name in names {
        query = query.bind(name);
    }
    member_rows(&query.fetch_all(db).await?)
}

async fn online_members(
    db: &Db,
    server: &str,
    hub: &Hub,
    after: Option<&str>,
    mut skip: usize,
    want: usize,
) -> Result<(Vec<MemberRow>, usize), ApiError> {
    let mut out = Vec::new();
    let mut skipped = 0;
    let mut from = after.map(str::to_string);
    loop {
        let chunk = hub.online_after(server, from.as_deref(), LIST_MAX as usize);
        let Some(last) = chunk.last() else {
            return Ok((out, skipped));
        };
        from = Some(last.clone());
        for row in members_by_names(db, server, &chunk).await? {
            if skip > 0 {
                skip -= 1;
                skipped += 1;
                continue;
            }
            out.push(row);
            if out.len() == want {
                return Ok((out, skipped));
            }
        }
    }
}

const OFFLINE_CHUNK_MAX: usize = 5000;

async fn offline_members(
    db: &Db,
    server: &str,
    hub: &Hub,
    mut after: Option<String>,
    mut skip: usize,
    want: usize,
) -> Result<Vec<MemberRow>, ApiError> {
    let mut out = Vec::new();
    let mut chunk = (want + skip).clamp(64, OFFLINE_CHUNK_MAX) as i64;
    loop {
        let rows = match &after {
            Some(a) => sqlx::query(
                "SELECT username, is_admin, perms FROM members WHERE server = $1 AND username > $2 ORDER BY username LIMIT $3",
            )
            .bind(server)
            .bind(a)
            .bind(chunk),
            None => sqlx::query(
                "SELECT username, is_admin, perms FROM members WHERE server = $1 ORDER BY username LIMIT $2",
            )
            .bind(server)
            .bind(chunk),
        }
        .fetch_all(db)
        .await?;
        let rows = member_rows(&rows)?;
        let exhausted = (rows.len() as i64) < chunk;
        chunk = (chunk * 2).min(OFFLINE_CHUNK_MAX as i64);
        if let Some((last, _, _)) = rows.last() {
            after = Some(last.clone());
        }
        let names: Vec<String> = rows.iter().map(|(name, _, _)| name.clone()).collect();
        let online: HashSet<String> = hub
            .online_among(server, &names)
            .into_iter()
            .map(str::to_string)
            .collect();
        for row in rows {
            if online.contains(&row.0) {
                continue;
            }
            if skip > 0 {
                skip -= 1;
                continue;
            }
            out.push(row);
            if out.len() == want {
                return Ok(out);
            }
        }
        if exhausted {
            return Ok(out);
        }
    }
}

async fn members_page(
    db: &Db,
    server: &str,
    hub: &Hub,
    offset: Option<i64>,
    limit: Option<i64>,
    cursor: Option<&str>,
) -> Result<(Vec<MemberRow>, Option<String>), ApiError> {
    let limit = limit.unwrap_or(50).clamp(1, 50) as usize;
    let want = limit + 1;
    let (from_online, after, skip) = match cursor {
        Some(raw) => {
            let parts = decode_cursor(raw, 2)?;
            match parts[0].as_str() {
                "o" => (true, Some(parts[1].clone()), 0),
                "f" => (false, Some(parts[1].clone()), 0),
                _ => return Err(ApiError::invalid("Invalid cursor", "cursor")),
            }
        }
        None => (
            true,
            None,
            offset.unwrap_or(0).clamp(0, OFFSET_MAX) as usize,
        ),
    };
    let mut rows: Vec<(bool, MemberRow)> = Vec::with_capacity(want);
    let mut skip = skip;
    let mut offline_after = after.clone();
    if from_online {
        let (got, skipped) = online_members(db, server, hub, after.as_deref(), skip, want).await?;
        skip -= skipped.min(skip);
        rows.extend(got.into_iter().map(|r| (true, r)));
        offline_after = None;
    }
    if rows.len() < want {
        let got = offline_members(db, server, hub, offline_after, skip, want - rows.len()).await?;
        rows.extend(got.into_iter().map(|r| (false, r)));
    }
    let more = rows.len() > limit;
    rows.truncate(limit);
    let next = match (more, rows.last()) {
        (true, Some((phase, (username, _, _)))) => Some(encode_cursor(&[
            match phase {
                true => "o",
                false => "f",
            },
            username,
        ])),
        _ => None,
    };
    Ok((rows.into_iter().map(|(_, r)| r).collect(), next))
}

/// List server members
///
/// Returns members as pages of `limit` (default and max 50): online members first, then offline
/// ones, each alphabetical by username. Page with `cursor` from the `X-Next-Cursor` response header
/// (or the legacy `offset`). With `q` (username prefix) and/or `admins=1` it returns matching
/// members alphabetically, paged by `cursor` only. With `role` and `top_hoisted=1`, or with
/// `unhoisted=1`, it returns the members of one group of the member list (see `Role.hoist`)
/// alphabetically, paged by `cursor` only. With `q` and `suggest=1` it returns the
/// members `GET /api/v1/servers/{name}/mentions` suggests (mention autocomplete). With
/// `usernames` it returns just those users that are members, alphabetical and unpaged.
///
/// Signed-in users may call it, and guests when guest access is on. Banned users get 403. On a
/// password-protected server signed-in callers must be members and guests need a valid
/// `X-Guest-Grant`; everyone else gets the same 404 as for a server that does not exist. A
/// server whose `members_visible` is off lists its members only to its members and instance
/// staff: everyone else gets an empty list in every mode.
///
/// The member list itself needs the site's `member_lists` switch on, the server's
/// `hide_members` off and View members (34359738368) held, in `channel_id` when given; members
/// with Manage server, Manage roles or Kick and ban, and instance staff, get it regardless of the
/// server and its permissions. Without it the caller gets 403, `suggest` an empty list, and
/// `usernames` only the members who wrote a message the caller can read, all shown offline.
/// Each call takes one of the caller's `list` lookups (`LOOKUP_LIST_PER_MINUTE`, 120 a minute
/// by default), or with `suggest` one of its `typeahead` lookups
/// (`LOOKUP_TYPEAHEAD_PER_MINUTE`, 300 a minute), counted per account, or per client address
/// without one. General rate-limit bucket.
#[utoipa::path(
    get,
    path = "/api/v1/servers/{name}/members",
    tag = "Members",
    params(("name" = String, Path, description = "Server name, case-insensitive"), MemberListQuery, ("X-Guest-Grant" = Option<String>, Header, description = "Guest grants from `POST /api/v1/servers/{name}/guest_access`, comma-separated, up to 100. Only read for guests viewing a password-protected server")),
    responses(
        (status = 200, description = "A page of members, or just the requested `usernames`", body = Vec<Member>, headers(("x-next-cursor" = String, description = "Cursor for the next page; absent on the last page"))),
        (status = 400, description = "Invalid cursor (including a cursor from a different kind of listing), a non-integer `offset` or `limit`, a non-integer `role` (`Invalid role`) or `channel_id` (`Invalid channel`), or `top_hoisted` without `role` (`top_hoisted needs a role`)", body = ApiErrorBody),
        (status = 401, description = "Guest access is disabled (no or unknown token)", body = ApiErrorBody),
        (status = 403, description = "`You are banned from this server`; for password-protected servers only when you took part in the server before. `Member lists are turned off on this site` (reason `off_site`, control `member_lists`), `You can't view the members of this server` (with reason `off_server` and control `hide_members` while the server hides its list, else without a reason) or `You can't view the members of this channel`", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses). Also a `channel_id` of another server or that you can't view", body = ApiErrorBody),
        (status = 429, description = "`Too many lookups. Try again later.` with a `Retry-After` header (JSON): the caller used up its `list` lookups, or with `suggest` its `typeahead` lookups. Or too many requests in the general bucket", body = ApiErrorBody)
    ),
    security((), ("bearer" = []))
)]
pub(crate) async fn list_members(
    State(state): State<AppState>,
    MaybeAuthed(viewer): MaybeAuthed,
    headers: HeaderMap,
    Path(name): Path<String>,
    RawQuery(raw): RawQuery,
) -> Result<Paged<Member>, ApiError> {
    let query = MemberListQuery::parse(raw.as_deref().unwrap_or(""))?;
    let class = query.class();
    let MemberListQuery {
        offset,
        limit,
        cursor,
        usernames,
        q,
        admins,
        suggest,
        role,
        top_hoisted,
        unhoisted,
        channel_id,
    } = query;
    let db = &state.read();
    require_guest_ok(db, viewer.as_ref()).await?;
    lookup::take(&state, class, viewer.as_ref())?;
    let proof = Proof::headers(&headers, &state.limits);
    let access = resolve_server(db, &name, viewer.as_ref(), &proof).await?;
    let place = ListPlace::open(access, db, channel_id).await?;
    let settings = crate::api::Settings::cached(db).await;
    let suggesting = suggest == Some(true) && q.is_some();
    let list = match place.member_list(db, &settings).await? {
        Roster::Shown(list) => list,
        Roster::Hidden(why) => {
            let access = place.access();
            return match (refusal(why, access.lite()), usernames, suggesting) {
                (None, _, _) | (Some(_), None, true) => Ok(Paged(Vec::new(), None)),
                (Some(_), Some(names), _) => {
                    let names = unique_capped(names.iter().map(|n| n.to_lowercase()));
                    let seen = seen_authors(db, access, &names).await?;
                    let names: Vec<String> =
                        names.into_iter().filter(|n| seen.contains(n)).collect();
                    let rows = members_by_names(db, access.name(), &names).await?;
                    Ok(Paged(
                        member_objects(&state, access, rows, false).await?,
                        None,
                    ))
                }
                (Some(e), None, false) => Err(e),
            };
        }
    };
    let key = list.server();
    let (rows, next) = match usernames {
        Some(names) => (
            members_by_names(
                db,
                key,
                &unique_capped(names.iter().map(|n| n.to_lowercase())),
            )
            .await?,
            None,
        ),
        None if suggesting => (
            mentionable(
                &state,
                &list,
                viewer.as_ref(),
                &proof,
                q.as_deref().unwrap_or_default(),
            )
            .await?,
            None,
        ),
        None if q.is_some() || admins == Some(true) => {
            filtered_members(
                db,
                key,
                q.as_deref(),
                admins == Some(true),
                limit,
                cursor.as_deref(),
            )
            .await?
        }
        None if unhoisted == Some(true) => {
            grouped_members(db, key, None, limit, cursor.as_deref()).await?
        }
        None if top_hoisted == Some(true) => match role {
            Some(role) => grouped_members(db, key, Some(role), limit, cursor.as_deref()).await?,
            None => return Err(ApiError::invalid("top_hoisted needs a role", "top_hoisted")),
        },
        None => members_page(db, key, &state.hub, offset, limit, cursor.as_deref()).await?,
    };
    Ok(Paged(
        member_objects(&state, list.access(), rows, true).await?,
        next,
    ))
}

/// The members of `rows` as the list shows them to the viewer of `access`, with whether they
/// are online when `presence` (else every one reads as offline).
async fn member_objects(
    state: &AppState,
    access: &ServerAccess,
    rows: Vec<MemberRow>,
    presence: bool,
) -> Result<Vec<Member>, ApiError> {
    let db = &state.read();
    let key = access.name();
    let creator = access.lite().creator.clone();
    let names: Vec<String> = rows.iter().map(|(name, _, _)| name.clone()).collect();
    let online = match presence {
        true => state.hub.online_among(key, &names),
        false => HashSet::new(),
    };
    let refs = user_refs(db, &names).await;
    let mut roles = role_ids_of(db, key, &names).await?;
    let mut via = match access.can_view(db, Perm::ManageInvites).await {
        true => crate::api::passwords::joined_via(db, key, &names).await?,
        false => HashMap::new(),
    };
    let mut timeouts = match access.can_view(db, Perm::TimeoutMembers).await {
        true => running_timeouts(db, key, &names).await?,
        false => HashMap::new(),
    };
    let mut looks = crate::api::profiles::looks_of(db, key, &names).await?;
    Ok(rows
        .into_iter()
        .map(|(username, is_admin, perms)| Member {
            profile: looks.remove(&username),
            timeout: timeouts.remove(&username),
            online: online.contains(username.as_str()),
            is_admin: is_admin != 0,
            is_creator: creator.as_deref() == Some(username.as_str()),
            perms,
            role_ids: roles.remove(&username).unwrap_or_default(),
            joined_via: via.remove(&username),
            user: user_from(&refs, &username),
        })
        .collect())
}

/// The most characters of the text a mention suggestion or a user search looks for.
pub const LOOKUP_TEXT_MAX: usize = 32;

/// The text a mention suggestion or a user search looks for: trimmed and lowercase, `min` to
/// `LOOKUP_TEXT_MAX` characters, without NUL.
pub(crate) fn lookup_text(raw: Option<&str>, min: usize) -> Result<String, ApiError> {
    let text = raw.unwrap_or_default().trim().to_lowercase();
    let len = text.chars().count();
    let wrong = |error: String| Err(ApiError::invalid(error, "q"));
    if len < min {
        return wrong(match min {
            1 => "Search text needs at least 1 character".to_string(),
            _ => format!("Search text needs at least {min} characters"),
        });
    }
    if len > LOOKUP_TEXT_MAX {
        return wrong(format!(
            "Search text must be at most {LOOKUP_TEXT_MAX} characters"
        ));
    }
    if text.contains('\0') {
        return wrong("Search text cannot contain NUL characters".to_string());
    }
    Ok(text)
}

/// Query for mention suggestions.
#[derive(Deserialize, IntoParams)]
pub struct MentionQuery {
    /// The start of a username or display name, 1 to 32 characters after trimming,
    /// case-insensitive.
    #[param(example = "al")]
    q: Option<String>,
    /// The channel the suggestions are for: View members is read there. A channel of another
    /// server, or one the caller can't view, gives the uniform 404.
    channel_id: Option<i64>,
}

/// Suggest mentions
///
/// At most 10 members of the server whose username, display name or server profile name starts
/// with `q` (case-insensitive), username matches first, each alphabetical, with only what a
/// suggestion shows: the name and avatar of their server profile over the account's. Members the caller may not find by name are left out: members see each other, and
/// people who read the server without being a member see its members while its
/// `members_visible` is on; each member's own choice (`profile` in `PATCH
/// /api/v1/me/privacy`) applies, so one who keeps their profile to friends is suggested only to
/// friends, and one who chose `everyone` to everyone who gets suggestions here. For signed-in
/// members, and anyone signed in on a server anyone can read while its `members_visible` is
/// on; guests and everyone else get an empty list, and so does a caller without the member list
/// (see `GET /api/v1/servers/{name}/members`, with `channel_id`). Each call takes one of the
/// caller's `typeahead` lookups
/// (`LOOKUP_TYPEAHEAD_PER_MINUTE`, 300 a minute by default), counted per account, or per client
/// address without one. General rate-limit bucket.
#[utoipa::path(
    get,
    path = "/api/v1/servers/{name}/mentions",
    tag = "Members",
    params(("name" = String, Path, description = "Server name, case-insensitive"), MentionQuery, ("X-Guest-Grant" = Option<String>, Header, description = "Guest grants from `POST /api/v1/servers/{name}/guest_access`, comma-separated, up to 100. Only read for guests viewing a password-protected server")),
    responses(
        (status = 200, description = "The suggestions, best first", body = Vec<UserRef>, headers(("cache-control" = String, description = "`private, max-age=15`"))),
        (status = 400, description = "`Search text needs at least 1 character`, `Search text must be at most 32 characters` or `Search text cannot contain NUL characters` (reason `invalid`, field `q`)", body = ApiErrorBody),
        (status = 401, description = "Guest access is disabled (no or unknown token)", body = ApiErrorBody),
        (status = 403, description = "`You are banned from this server`; for password-protected servers only when you took part in the server before", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses). Also a `channel_id` of another server or that you can't view", body = ApiErrorBody),
        (status = 429, description = "`Too many lookups. Try again later.` with a `Retry-After` header (JSON): the caller used up its `typeahead` lookups. Or too many requests in the general bucket", body = ApiErrorBody)
    ),
    security((), ("bearer" = []))
)]
pub(crate) async fn mentions(
    State(state): State<AppState>,
    MaybeAuthed(viewer): MaybeAuthed,
    headers: HeaderMap,
    Path(name): Path<String>,
    Query(query): Query<MentionQuery>,
) -> Result<Names, ApiError> {
    let db = &state.read();
    require_guest_ok(db, viewer.as_ref()).await?;
    let MentionQuery { q, channel_id } = query;
    let q = lookup_text(q.as_deref(), 1)?;
    lookup::take(&state, LookupClass::Typeahead, viewer.as_ref())?;
    let proof = Proof::headers(&headers, &state.limits);
    let access = resolve_server(db, &name, viewer.as_ref(), &proof).await?;
    let place = ListPlace::open(access, db, channel_id).await?;
    let settings = crate::api::Settings::cached(db).await;
    let list = match place.member_list(db, &settings).await? {
        Roster::Shown(list) => list,
        Roster::Hidden(_) => return Ok(Names(Vec::new())),
    };
    let names: Vec<String> = mentionable(&state, &list, viewer.as_ref(), &proof, &q)
        .await?
        .into_iter()
        .map(|(name, _, _)| name)
        .collect();
    let refs = user_refs(db, &names).await;
    let looks = crate::api::profiles::looks_of(db, list.server(), &names).await?;
    Ok(Names(
        names
            .iter()
            .map(|n| {
                let user = user_from(&refs, n);
                match looks.get(n) {
                    Some(look) => look.over(&user),
                    None => user,
                }
            })
            .collect(),
    ))
}

fn pair_cursor(raw: Option<&str>) -> Result<Option<(i64, String)>, ApiError> {
    match raw.filter(|c| !c.trim().is_empty()) {
        Some(raw) => {
            let parts = decode_cursor(raw, 2)?;
            Ok(Some((cursor_int(&parts[0])?, parts[1].clone())))
        }
        None => Ok(None),
    }
}

fn pair_next(more: bool, last: Option<&(String, i64)>) -> Option<String> {
    match (more, last) {
        (true, Some((name, at))) => Some(encode_cursor(&[&at.to_string(), name])),
        _ => None,
    }
}

async fn recent_pairs(
    db: &Db,
    sql_first: &str,
    sql_after: &str,
    server: &str,
    after: Option<(i64, String)>,
    offset: i64,
    limit: i64,
) -> Result<(Vec<(String, i64)>, bool), ApiError> {
    let rows = match after {
        Some((at, name)) => {
            sqlx::query(sqlx::AssertSqlSafe(sql_after.to_string()))
                .bind(server)
                .bind(at)
                .bind(name)
                .bind(limit + 1)
                .fetch_all(db)
                .await?
        }
        None => {
            sqlx::query(sqlx::AssertSqlSafe(sql_first.to_string()))
                .bind(server)
                .bind(limit + 1)
                .bind(offset)
                .fetch_all(db)
                .await?
        }
    };
    let mut pairs = Vec::with_capacity(rows.len());
    for r in &rows {
        pairs.push((r.try_get::<String, _>(0)?, r.try_get::<i64, _>(1)?));
    }
    let more = pairs.len() as i64 > limit;
    pairs.truncate(limit as usize);
    Ok((pairs, more))
}

/// The list name `interacted` cursors are sealed for.
const INTERACTED: &str = "interacted";

/// The statement that gives each former member of the server `$1` the id of their newest message
/// in `reading`'s channels the viewer may read. Each author and channel costs one index seek from
/// the newest message where the viewer reads the whole history.
fn seen_sql(reading: &str) -> String {
    format!(
        "WITH seen AS MATERIALIZED ({reading}) SELECT a.username, MAX(a.seen_id) FROM (SELECT i.username, (SELECT m.id FROM messages m WHERE m.channel_id = s.id AND m.author = i.username AND m.kind IN ('user', 'poll') AND m.webhook_id IS NULL AND (s.whole <> 0 OR (m.created_at >= s.since AND (m.thread_root_id IS NULL OR EXISTS(SELECT 1 FROM messages rt WHERE rt.id = m.thread_root_id AND rt.created_at >= s.since)))) ORDER BY m.id DESC LIMIT 1) AS seen_id FROM interactions i CROSS JOIN seen s WHERE i.server = $1 AND NOT EXISTS(SELECT 1 FROM members mem WHERE mem.server = i.server AND mem.username = i.username)) a WHERE a.seen_id IS NOT NULL GROUP BY a.username"
    )
}

/// Former members of the server by the newest message of theirs the viewer, who doesn't manage
/// channels, may read, in message order, newest first: a page of `(username, message id)` after
/// `after` (else from `offset`), and whether more follow. One statement reads what the viewer may
/// see and the messages.
async fn seen_pairs(
    db: &Db,
    access: &ServerAccess,
    after: Option<(i64, String)>,
    offset: i64,
    limit: i64,
) -> Result<(Vec<(String, i64)>, bool), ApiError> {
    let reading = access.text_reading(2);
    let sql = seen_sql(&reading.sql);
    let query = reading.bind(sqlx::query(sqlx::AssertSqlSafe(sql)).bind(access.name()));
    let mut pairs = Vec::new();
    for r in query.fetch_all(db).await? {
        pairs.push((r.try_get::<String, _>(0)?, r.try_get::<i64, _>(1)?));
    }
    pairs.sort_by(|(a, id_a), (b, id_b)| id_b.cmp(id_a).then_with(|| b.cmp(a)));
    let rest: Vec<(String, i64)> = match after {
        Some((id, name)) => pairs
            .into_iter()
            .filter(|(n, i)| (*i, n.as_str()) < (id, name.as_str()))
            .collect(),
        None => pairs.into_iter().skip(offset as usize).collect(),
    };
    let more = rest.len() as i64 > limit;
    Ok((rest.into_iter().take(limit as usize).collect(), more))
}

/// List non-members who interacted
///
/// Returns users who sent a message or joined a voice channel in the server but are not members
/// now (for example former members), most recent interaction first, as pages of `limit` (default
/// and max 50). Only channel managers get this activity order. Other callers get only users with
/// a message the caller may read, newest such message first. Page with `cursor` from the
/// `X-Next-Cursor` response header (or the legacy `offset`); a cursor works only for the caller
/// it was given to.
///
/// Signed-in users may call it, and guests when guest access is on. Banned users get 403. On a
/// password-protected server signed-in callers must be members and guests need a valid
/// `X-Guest-Grant`; everyone else gets the same 404 as for a server that does not exist. A
/// server whose `members_visible` is off lists them only to its members and instance staff:
/// everyone else gets an empty list. A caller without the member list (see
/// `GET /api/v1/servers/{name}/members`, with `channel_id`) gets its 403.
/// Each admitted call spends one `list` lookup per account or guest address group.
/// One list runs per caller. The latest waiter may wait up to 5 s for that caller or 2 s
/// for a process search place. Pools with two or more readers reserve one for other requests.
/// With one reader, other requests share that connection with a single admitted list.
/// General rate-limit bucket.
#[utoipa::path(
    get,
    path = "/api/v1/servers/{name}/interacted",
    tag = "Members",
    params(("name" = String, Path, description = "Server name, case-insensitive"), MembersQuery, ListScope, ("X-Guest-Grant" = Option<String>, Header, description = "Guest grants from `POST /api/v1/servers/{name}/guest_access`, comma-separated, up to 100. Only read for guests viewing a password-protected server")),
    responses(
        (status = 200, description = "A page of users who interacted with the server and are not members, most recent first", body = Vec<UserRef>, headers(("x-next-cursor" = String, description = "Cursor for the next page; absent on the last page"))),
        (status = 400, description = "`Invalid cursor` (JSON): malformed, changed, or given to another caller or for another permission level. Or a non-integer `offset` or `limit` (plain-text framework error)", body = ApiErrorBody),
        (status = 401, description = "Guest access is disabled (no or unknown token)", body = ApiErrorBody),
        (status = 403, description = "`You are banned from this server`; for password-protected servers only when you took part in the server before. The member list refusals of `GET /api/v1/servers/{name}/members`", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses). Also a `channel_id` of another server or that you can't view", body = ApiErrorBody),
        (status = 429, description = "The caller used up its list lookups, a newer request replaced this one, or no place is available. JSON with the reason `rate` and a `Retry-After` header. Or too many requests in the general bucket", body = ApiErrorBody)
    ),
    security((), ("bearer" = []))
)]
pub(crate) async fn list_interacted(
    State(state): State<AppState>,
    MaybeAuthed(viewer): MaybeAuthed,
    headers: HeaderMap,
    Path(name): Path<String>,
    Query(q): Query<MembersQuery>,
    Query(scope): Query<ListScope>,
) -> Result<Paged<UserRef>, ApiError> {
    let db = state.read();
    require_guest_ok(&db, viewer.as_ref()).await?;
    let token = lookup::reserve(&state, LookupClass::List, viewer.as_ref())?;
    let proof = Proof::headers(&headers, &state.limits);
    let resolve = async || {
        let access = resolve_server(&db, &name, viewer.as_ref(), &proof).await?;
        let place = ListPlace::open(access, &db, scope.channel_id).await?;
        let settings = crate::api::Settings::cached(&db).await;
        let shown = match place.member_list(&db, &settings).await? {
            Roster::Shown(_) => Ok(()),
            Roster::Hidden(why) => Err(refusal(why, place.access().lite())),
        };
        Ok::<_, ApiError>((place, shown))
    };
    let mut place = match resolve().await {
        Ok((place, Ok(()))) => place,
        Ok((_, Err(refused))) => {
            token.spend();
            return refused.map_or(Ok(Paged(Vec::new(), None)), Err);
        }
        Err(e) => {
            token.spend();
            return Err(e);
        }
    };
    let mut admission = std::pin::pin!(crate::api::search_limits::admit_interacted(
        &state,
        viewer.as_ref()
    ));
    let admitted = match futures_util::poll!(admission.as_mut()) {
        std::task::Poll::Ready(answer) => answer?,
        std::task::Poll::Pending => {
            let admitted = admission.await?;
            // Membership, grants and member visibility can change while the request waits.
            require_guest_ok(&db, viewer.as_ref()).await?;
            place = match resolve().await? {
                (place, Ok(())) => place,
                (_, Err(refused)) => return refused.map_or(Ok(Paged(Vec::new(), None)), Err),
            };
            admitted
        }
    };
    token.spend();
    admitted
        .run(async move {
            let settings = crate::api::Settings::cached(&db).await;
            match place.member_list(&db, &settings).await? {
                Roster::Shown(list) => interacted_page(&db, &list, q).await,
                Roster::Hidden(why) => {
                    refusal(why, place.access().lite()).map_or(Ok(Paged(Vec::new(), None)), Err)
                }
            }
        })
        .await?
}

async fn interacted_page(
    db: &Db,
    list: &MemberList<'_>,
    q: MembersQuery,
) -> Result<Paged<UserRef>, ApiError> {
    let access = list.access();
    let key = access.name();
    let MembersQuery {
        offset,
        limit,
        cursor,
    } = q;
    let (offset, limit) = (offset.unwrap_or(0).max(0), limit.unwrap_or(50).clamp(1, 50));
    let seen = !access.manages_channels(db).await?;
    let reader = match access.viewer() {
        Some(user) => format!("u:{}", user.username),
        None => "g".to_string(),
    };
    let basis = match seen {
        true => "seen",
        false => "all",
    };
    let pepper = crate::db::pepper(db).await?;
    let binding = [key, reader.as_str(), basis];
    let after = match cursor.as_deref().filter(|c| !c.trim().is_empty()) {
        Some(raw) => {
            let parts = sealed::open(&pepper, INTERACTED, &binding, raw, 2)?;
            Some((cursor_int(&parts[0])?, parts[1].clone()))
        }
        None => None,
    };
    let (pairs, more) = match seen {
        true => seen_pairs(db, access, after, offset, limit).await?,
        false => {
            recent_pairs(
                db,
                "SELECT i.username, i.last_at FROM interactions i WHERE i.server = $1 AND NOT EXISTS(SELECT 1 FROM members m WHERE m.server = i.server AND m.username = i.username) ORDER BY i.last_at DESC, i.username DESC LIMIT $2 OFFSET $3",
                "SELECT i.username, i.last_at FROM interactions i WHERE i.server = $1 AND (i.last_at, i.username) < ($2, $3) AND NOT EXISTS(SELECT 1 FROM members m WHERE m.server = i.server AND m.username = i.username) ORDER BY i.last_at DESC, i.username DESC LIMIT $4",
                key,
                after,
                offset,
                limit,
            )
            .await?
        }
    };
    let next = match (more, pairs.last()) {
        (true, Some((name, at))) => Some(sealed::seal(
            &pepper,
            INTERACTED,
            &binding,
            &[&at.to_string(), name],
        )),
        _ => None,
    };
    let names: Vec<String> = pairs.into_iter().map(|(name, _)| name).collect();
    let refs = user_refs(db, &names).await;
    Ok(Paged(
        names.iter().map(|n| user_from(&refs, n)).collect(),
        next,
    ))
}

/// Create a server
///
/// Creates a server owned by the caller: they become its creator and an admin with all
/// permissions, and it starts with one text channel named `general`. Requires a bearer token.
/// The other fields choose how people join (`join`: by its name, with an invite, with a
/// password, or nobody new), whether search lists it, whether people who aren't members can read
/// it, a voice channel, the join and leave notices and how long uploads stay; without them anyone
/// joins the server by its name, or with its password when `password` is set. An `invite` or
/// `closed` server gets a random key of 10 characters (`name` in the answer) and
/// keeps it when it is renamed; its display name may be the name of other servers.
/// The instance may limit who creates servers (`server_creation` in `GET /api/v1/settings`):
/// accounts it leaves out get 404, and `can_create_servers` in `GET /api/v1/me` says which
/// applies to the caller. Emits `server_created` to the creator. Strict and general rate-limit
/// buckets.
/// New servers are rare requests: at most `RARE_REQUESTS_PER_HOUR` (20) an hour and
/// `RARE_REQUESTS_PER_DAY` (100) a day per account by default. A request refused while the server
/// is busy does not count.
#[utoipa::path(
    post,
    path = "/api/v1/servers",
    tag = "Servers",
    request_body = CreateServerReq,
    responses(
        (status = 200, description = "The created server, with the caller as admin, its channels and, for an `invite` server, its invite link", body = CreatedServer),
        (status = 400, description = "Invalid name (blank, longer than 100 characters, `.` or `..`, or blocked by the profanity filter), the name is taken (for `name` and `password` servers), or a password shorter than 8 characters. With reason `invalid` and its `field`: `Pick one way to join` (a `password` for another mode than `password`), `A password needs 8 characters` (`join: password` without one), `Listed is only for servers people join by name` (`listed: true` for an `invite` or `closed` server), or an invalid `upload_expiry`. `This instance needs invites to join. Pick invite or password.` with reason `off_site` and control `server_joining`: `join: name` while the instance's `server_joining` is `invites`. `An account can be in at most 1000 servers` with the configured number (`SERVERS_PER_ACCOUNT`, reason `limit`): creating a server counts as joining it. Malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "`Public reading is turned off on this site` with reason `off_site` and control `public_reading`: `public_read: true` while the instance has public reading off", body = ApiErrorBody),
        (status = 404, description = "`Not found`: the instance does not let this account create servers", body = ApiErrorBody),
        (status = 409, description = "That name belonged to a deleted server that is still being purged; try again later", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "`You've done this too often. Try again later.` (JSON, with `Retry-After`): past the rare requests of this kind. `Too many new servers from your network. Try again later.` (JSON, reason `rate`, with `Retry-After`): past `SERVERS_PER_NETWORK_PER_DAY` for your network (an IPv4 address or an IPv6 /48). Too many requests in the strict or the general bucket", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn create_server(
    State(state): State<AppState>,
    Authed(user): Authed,
    Json(req): Json<CreateServerReq>,
) -> Result<Json<CreatedServer>, ApiError> {
    let allowed = crate::api::policy::effective(&state.db, Some(&user)).await;
    if !allowed.can_create_servers().await? {
        let answer = crate::api::access::not_found();
        return Err(match allowed.server_creation() {
            ServerCreation::Some => {
                crate::api::policy::left_out(&rchat_settings::items::SERVER_CREATION, answer)
            }
            ServerCreation::Everyone | ServerCreation::Nobody => {
                crate::api::policy::refused(&rchat_settings::items::SERVER_CREATION, answer)
            }
        });
    }
    let CreateServerReq {
        name,
        password,
        options,
    } = req;
    let held = rare::hold(&state, Rare::NewServer, Some(&user))?;
    crate::api::network_caps::take(&state, crate::api::network_caps::Kind::Server).await?;
    let founder = Founder::Creator(&user.username);
    let founded = async {
        let new = check_new_server(&state, &user, &name, password.as_deref(), options).await?;
        found_server(&state, new, founder).await
    };
    let (key, invite) = rare::counted(held, founded.await)?;
    let access = resolve_server(&state.db, &key, Some(&user), &Proof::none()).await?;
    Ok(Json(CreatedServer {
        server: server_detail(&state.db, &state.hub, &access).await?,
        invite,
    }))
}

/// Who a new server belongs to.
enum Founder<'a> {
    /// The account that creates it.
    Creator(&'a str),
    /// An account the site admin `by` picked. The server has no creator, and the owner is its
    /// admin with every permission, like in a server whose creator left.
    Owner { owner: &'a str, by: &'a str },
}

/// A new server as its request asks for it, checked.
struct NewServer {
    display: String,
    mode: JoinMode,
    /// The permanent password of a `password` server.
    password: Option<String>,
    listed: bool,
    public_read: Option<bool>,
    channels: StartChannels,
    notices: bool,
    upload_expiry: Option<crate::api::upload_expiry::UploadExpiry>,
    /// Make its invite link.
    standing: bool,
}

const PICK_ONE: &str = "Pick one way to join";
const PASSWORD_NEEDED: &str = "A password needs 8 characters";
const LISTED_BY_NAME: &str = "Listed is only for servers people join by name";
const NEEDS_INVITES: &str = "This instance needs invites to join. Pick invite or password.";
const NAME_FOR_JOINING: &str = "That name is taken. Pick another to let people join by name.";

/// The refusal of a request that picks `join: name` while the instance needs invites.
fn needs_invites(joining: ServerJoining, join: Option<JoinMode>) -> Result<(), ApiError> {
    match (joining, join) {
        (ServerJoining::Invites, Some(JoinMode::Name)) => Err(ApiError::off_site(
            StatusCode::BAD_REQUEST,
            NEEDS_INVITES,
            &rchat_settings::items::SERVER_JOINING,
        )),
        (ServerJoining::Everyone | ServerJoining::Invites | ServerJoining::Nobody, _) => Ok(()),
    }
}

/// Checks the request for a new server named `name` by `user` against the rules of each
/// option and the instance's switches.
async fn check_new_server(
    state: &AppState,
    user: &User,
    name: &str,
    password: Option<&str>,
    options: ServerOptions,
) -> Result<NewServer, ApiError> {
    let ServerOptions {
        join,
        listed,
        public_read,
        channels,
        notices,
        upload_expiry,
        standing_link,
    } = options;
    let db = &state.db;
    let display = name.trim().to_string();
    check_server_name(db, &display).await?;
    let password = password.map(str::trim).filter(|p| !p.is_empty());
    let mode = join.unwrap_or(match password {
        Some(_) => JoinMode::Password,
        None => JoinMode::Name,
    });
    let password = match (mode, password) {
        (JoinMode::Password, Some(p)) => {
            crate::api::passwords::check_strength(p)?;
            Some(p.to_string())
        }
        (JoinMode::Password, None) => return Err(ApiError::invalid(PASSWORD_NEEDED, "password")),
        (JoinMode::Name | JoinMode::Invite | JoinMode::Closed, Some(_)) => {
            return Err(ApiError::invalid(PICK_ONE, "join"));
        }
        (JoinMode::Name | JoinMode::Invite | JoinMode::Closed, None) => None,
    };
    if listed == Some(true) && !mode.by_name() {
        return Err(ApiError::invalid(LISTED_BY_NAME, "listed"));
    }
    let standing = match (mode, standing_link) {
        (JoinMode::Invite, Some(made)) => made,
        (JoinMode::Invite, None) => true,
        (JoinMode::Name | JoinMode::Password | JoinMode::Closed, Some(true)) => {
            return Err(ApiError::invalid(
                "Only invite servers have an invite link",
                "standing_link",
            ));
        }
        (JoinMode::Name | JoinMode::Password | JoinMode::Closed, _) => false,
    };
    if let Some(choice) = upload_expiry {
        let cap = Settings::cached(db).await.upload_expiry_max_days;
        if let Err(problem) = crate::api::upload_expiry::refusal(choice, cap) {
            return Err(ApiError::invalid(problem, "upload_expiry"));
        }
    }
    let allowed = crate::api::policy::effective(db, Some(user)).await;
    needs_invites(allowed.server_joining(), join)?;
    if public_read == Some(true) && !allowed.public_reading() {
        return Err(crate::api::policy::refused(
            &rchat_settings::items::PUBLIC_READING,
            ApiError::perm(PUBLIC_READING_OFF, "member"),
        ));
    }
    Ok(NewServer {
        display,
        mode,
        password,
        listed: listed.unwrap_or(true),
        public_read,
        channels: channels.unwrap_or_default(),
        notices: notices.unwrap_or(true),
        upload_expiry,
        standing,
    })
}

/// A key no server has, for a server whose key isn't its name.
async fn free_key(db: &Db) -> Result<String, ApiError> {
    for _ in 0..5 {
        let key = random_text(KEY_LEN);
        let taken = sqlx::query("SELECT 1 FROM servers WHERE name = $1")
            .bind(&key)
            .fetch_optional(db)
            .await?
            .is_some();
        if !taken {
            return Ok(key);
        }
    }
    Err(ApiError::internal("no free server key"))
}

/// Creates the server `new` with its channels, its founder as the only member and its
/// invite link, and announces it. Returns its key and its invite link.
async fn found_server(
    state: &AppState,
    new: NewServer,
    founder: Founder<'_>,
) -> Result<(String, Option<crate::api::passwords::InviteLinkInfo>), ApiError> {
    let NewServer {
        display,
        mode,
        password,
        listed,
        public_read,
        channels,
        notices,
        upload_expiry,
        standing,
    } = new;
    let key = match mode.by_name() {
        true => {
            let key = display.to_lowercase();
            name_free(&state.db, &key).await?;
            key
        }
        false => free_key(&state.db).await?,
    };
    let permanent = match &password {
        Some(password) => Some(hash_in(Work::Server, password).await?),
        None => None,
    };
    let password_hash = mode.hash(permanent);
    let (creator, member, perms) = match founder {
        Founder::Creator(user) => (Some(user), user, 0),
        Founder::Owner { owner, by: _ } => (None, owner, ALL_PERMS),
    };
    let expiry_by = upload_expiry
        .filter(|choice| crate::api::upload_expiry::extends(choice.ttl(0)))
        .map(|_| member);
    let link = match standing {
        true => Some(crate::api::passwords::NewLink::make(&state.db, &key).await?),
        false => None,
    };
    let t = state.clock.unix();
    let mut tx = state.db.begin().await?;
    lock_account(&mut tx, member).await?;
    room_for_account(&mut tx, &state.limits, member).await?;
    sqlx::query(
        "INSERT INTO servers(name, display_name, creator, password_hash, member_count, created_at, join_mode, listed, public_read, join_messages, leave_messages, upload_expiry, upload_expiry_by, roles_order_confirmed) VALUES($1, $2, $3, $4, 1, $5, $6, $7, $8, $9, $9, $10, $11, 1)",
    )
    .bind(&key)
    .bind(&display)
    .bind(creator)
    .bind(&password_hash)
    .bind(t)
    .bind(mode.as_str())
    .bind(i64::from(listed))
    .bind(public_read.map(i64::from))
    .bind(i64::from(notices))
    .bind(upload_expiry.and_then(|choice| choice.stored()))
    .bind(expiry_by)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES($1, $2, 1, $3, $4)",
    )
    .bind(&key)
    .bind(member)
    .bind(perms)
    .bind(t)
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO channels(server, name, created_at) VALUES($1, 'general', $2)")
        .bind(&key)
        .bind(t)
        .execute(&mut *tx)
        .await?;
    if channels == StartChannels::TextVoice {
        sqlx::query("INSERT INTO channels(server, name, kind, position, created_at) VALUES($1, 'Voice', 'voice', 1, $2)")
            .bind(&key)
            .bind(t)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(link) = &link {
        link.insert(&mut tx, &key, Some(member), t).await?;
    }
    if let Founder::Owner { owner, by } = founder {
        crate::api::instance_audit::record_in(
            &mut tx,
            by,
            "server.create",
            Some(&key),
            serde_json::json!({ "owner": owner }),
            t,
        )
        .await?;
    }
    tx.commit().await?;
    state.hub.broadcast(WsEvent::ServerCreated {
        server: ServerSummaryLite {
            name: key.clone(),
            display_name: display,
            creator: creator.map(str::to_string),
            has_password: password_hash.is_some(),
            banner_color: None,
            name_color: None,
            public_read,
            guest_voice: false,
            guest_chat: false,
            members_visible: true,
            hide_members: false,
            join_mode: mode,
            listed,
            profiles_mode: Default::default(),
            description: None,
            icon_kind: IconKind::Letter,
            icon_image: None,
            seal: crate::api::seal::server_view(&state.db, 0, 0).await,
        },
    });
    Ok((key, link.map(|link| link.info())))
}

/// Creates a server for `owner` on behalf of the site admin `admin`, whatever the instance
/// allows people to create themselves. Answers the server as the admin sees it.
pub(crate) async fn found_for(
    state: &AppState,
    admin: &User,
    name: &str,
    password: Option<&str>,
    options: ServerOptions,
    owner: &User,
) -> Result<Json<CreatedServer>, ApiError> {
    let founder = Founder::Owner {
        owner: &owner.username,
        by: &admin.username,
    };
    let new = check_new_server(state, admin, name, password, options).await?;
    let (key, invite) = found_server(state, new, founder).await?;
    let member = build_member(
        &state.db,
        &state.hub,
        &key,
        None,
        &owner.username,
        true,
        ALL_PERMS,
    )
    .await?;
    state.hub.broadcast(WsEvent::MemberJoined {
        server: key.clone(),
        member,
    });
    let access = resolve_server(&state.db, &key, Some(admin), &Proof::none()).await?;
    Ok(Json(CreatedServer {
        server: server_detail(&state.db, &state.hub, &access).await?,
        invite,
    }))
}

/// Get a server
///
/// Returns the server with its channels, roles and member and online counts. Channels that have
/// permission rules are only listed when a rule lets the viewer see them or the viewer has the
/// Manage channels permission; guests only see channels without rules. For callers with Manage
/// admins, `role_limits` lists the roles they can't edit, delete or assign.
///
/// Signed-in users may call it, and guests when guest access is on. Banned users get 403. On a
/// password-protected server signed-in callers must be members and guests need a valid
/// `X-Guest-Grant`; everyone else gets the same 404 as for a server that does not exist. A
/// server without a password answers the same way while the instance's `server_joining` is
/// `invites` or `nobody`. General rate-limit bucket.
#[utoipa::path(
    get,
    path = "/api/v1/servers/{name}",
    tag = "Servers",
    params(("name" = String, Path, description = "Server name, case-insensitive"), ("X-Guest-Grant" = Option<String>, Header, description = "Guest grants from `POST /api/v1/servers/{name}/guest_access`, comma-separated, up to 100. Only read for guests viewing a password-protected server")),
    responses(
        (status = 200, description = "Server details: channels visible to the viewer, roles, and member and online counts", body = ServerDetail),
        (status = 401, description = "Guest access is disabled (no or unknown token)", body = ApiErrorBody),
        (status = 403, description = "`You are banned from this server`; for password-protected servers only when you took part in the server before", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses)", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)
    ),
    security((), ("bearer" = []))
)]
pub(crate) async fn get_server(
    State(state): State<AppState>,
    MaybeAuthed(viewer): MaybeAuthed,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Result<Json<ServerDetail>, ApiError> {
    let db = &state.read();
    require_guest_ok(db, viewer.as_ref()).await?;
    let access = resolve_server(
        db,
        &name,
        viewer.as_ref(),
        &Proof::headers(&headers, &state.limits),
    )
    .await?;
    Ok(Json(server_detail(db, &state.hub, &access).await?))
}

/// Check that a server name is free
///
/// Reports whether a server could be created with this name right now. This is the one
/// deliberate existence oracle in the API: it answers `false` for password-protected servers
/// too, because creating a server with a taken name would reveal the same. It never says whether
/// a taken name is password-protected. The name goes through the same checks as when creating a
/// server, so invalid names get 400. Requires a bearer token. Strict and general rate-limit
/// buckets.
/// Name checks and renames (`PATCH /api/v1/servers/{name}` with a new `name`) are rare requests of
/// one kind: at most `RARE_REQUESTS_PER_HOUR` (20) an hour and `RARE_REQUESTS_PER_DAY` (100) a day
/// per account by default.
#[utoipa::path(
    get,
    path = "/api/v1/servers/{name}/available",
    tag = "Servers",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    responses(
        (status = 200, description = "Whether the name is free; `false` for every taken name, protected or not, and for names of deleted servers still being purged", body = ServerAvailable),
        (status = 400, description = "Invalid name (blank, longer than 100 characters, `.` or `..`, or blocked by the profanity filter)", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 429, description = "`You've done this too often. Try again later.` (JSON, with `Retry-After`): past the rare requests of this kind. Too many requests in the strict or the general bucket. Also `Too many attempts. Try again later` (JSON) after too many password attempts from your address (an IPv6 /64 counts as one) or your network (an IPv4 /24 or IPv6 /48), after 5 wrong passwords for this name from your address (then a wait that doubles up to an hour; 3 an hour while many addresses get the name wrong; names that do not exist count the same way), or while the server is busy checking passwords", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn server_available(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
) -> Result<Json<ServerAvailable>, ApiError> {
    let display = name.trim().to_string();
    check_server_name(&state.db, &display).await?;
    rare::take(&state, Rare::ServerName, Some(&user))?;
    let available = match name_free(&state.read(), &display.to_lowercase()).await {
        Ok(()) => true,
        Err(ApiError(StatusCode::BAD_REQUEST | StatusCode::CONFLICT, _, _)) => false,
        Err(e) => return Err(e),
    };
    Ok(Json(ServerAvailable { available }))
}

/// Search servers
///
/// Finds up to 10 servers, ordered by name, whose name or display name matches `q`. Queries of up
/// to 8 characters match fuzzily (the characters in order, not necessarily adjacent); longer ones
/// match as a substring. Only servers the caller is a member of, and servers that people who
/// aren't members may read by name, that people join by name (`join_mode` `name` or `password`)
/// and that are `listed`, are searched; other servers never appear. While the instance's
/// `server_joining` is `invites` or `nobody`, a server without a password is only searched by its
/// members, unless its `public_read` is on. A blank `q` returns an empty
/// list. Signed-in users may call it, and guests when guest access is on (guests only find
/// servers without a password). Answers 404 while the instance has server search off
/// (`server_search` in `GET /api/v1/settings`). Each call takes one of the caller's `search`
/// lookups (`LOOKUP_SEARCH_PER_MINUTE`, 30 a minute by default), counted per account, or per
/// client address without one. General rate-limit bucket.
#[utoipa::path(
    get,
    path = "/api/v1/server_search",
    tag = "Search",
    params(ServerSearchQuery),
    responses(
        (status = 200, description = "Up to 10 servers without a password or that you are a member of, whose name or display name matches the query", body = Vec<ServerMatch>),
        (status = 401, description = "Guest access is disabled and no valid token was sent", body = ApiErrorBody),
        (status = 404, description = "`Not found`: server search is off on this instance", body = ApiErrorBody),
        (status = 429, description = "`Too many lookups. Try again later.` with a `Retry-After` header (JSON): the caller used up its `search` lookups. Or too many requests in the general bucket", body = ApiErrorBody)
    ),
    security((), ("bearer" = []))
)]
pub(crate) async fn search_servers(
    State(state): State<AppState>,
    MaybeAuthed(viewer): MaybeAuthed,
    Query(sq): Query<ServerSearchQuery>,
) -> Result<Json<Vec<ServerMatch>>, ApiError> {
    let db = &state.read();
    if !crate::api::policy::effective(db, viewer.as_ref())
        .await
        .server_search()
    {
        return Err(crate::api::policy::refused(
            &rchat_settings::items::SERVER_SEARCH,
            crate::api::access::not_found(),
        ));
    }
    require_guest_ok(db, viewer.as_ref()).await?;
    lookup::take(&state, LookupClass::Search, viewer.as_ref())?;
    let q = sq.q.as_deref().unwrap_or("").trim().to_lowercase();
    if q.is_empty() {
        return Ok(Json(Vec::new()));
    }
    let fuzzy = is_fuzzy(&q);
    let sql = format!(
        "SELECT name, display_name, password_hash, description, icon_kind, banner_color, icon_image FROM servers WHERE (lower(name) LIKE $1 ESCAPE '\\' OR lower(display_name) LIKE $1 ESCAPE '\\') AND COALESCE(password_hash, '') <> '!purging' AND ((name IN ({}) AND listed <> 0 AND COALESCE(password_hash, '') <> '!none') OR name IN (SELECT server FROM members WHERE username = $2)) ORDER BY name LIMIT 50",
        crate::api::access::Reading::now(db).await.servers_sql()
    );
    let rows = state
        .replica(async |db| {
            Ok(sqlx::query(sqlx::AssertSqlSafe(sql.as_str()))
                .bind(like_pattern(&q, fuzzy))
                .bind(viewer.as_ref().map(|u| u.username.clone()))
                .fetch_all(db)
                .await?)
        })
        .await?;
    let mut out = Vec::new();
    for r in &rows {
        let name: String = r.try_get(0)?;
        let display_name: String = r.try_get(1)?;
        if !name_hit(&q, fuzzy, &name, &display_name) {
            continue;
        }
        out.push(ServerMatch {
            name,
            display_name,
            has_password: r.try_get::<Option<String>, _>(2)?.is_some(),
            description: r.try_get(3)?,
            icon_kind: IconKind::stored(r.try_get::<Option<String>, _>(4)?.as_deref()),
            icon_image: r.try_get(6)?,
            banner_color: r.try_get(5)?,
        });
        if out.len() >= 10 {
            break;
        }
    }
    Ok(Json(out))
}

/// Get guest access to a server
///
/// Checks the password of a password-protected server and returns a guest grant. Guests send the
/// grant in the `X-Guest-Grant` header to view the server without an account; it expires after
/// `GUEST_GRANT_DAYS` days without use (30 by default) and is revoked when the password changes
/// (unless the change kept guests). Each password has at most 2000 live grants by default
/// (`GUEST_GRANTS_PER_PASSWORD`; the permanent password counts as one), and at most 50 of them
/// per network by default (`GUEST_GRANTS_PER_NETWORK`; an IPv4 /24 or IPv6 /48); past that no
/// new grant is given until older ones expire. The API drives the
/// password step: without `password` every
/// name that is not a server without a password gets the same `401 Password required`, and a
/// wrong password or a name that does not exist gets the same `404 Server not found or wrong
/// password` (the password is always hashed, also for names that do not exist). Anyone may call
/// it, guests only when guest access is on. A server that people who aren't members may read
/// by its name answers `grant: null` under every joining rule, and any `password` is ignored.
/// For every other name the instance's `server_joining` applies as for
/// `POST /api/v1/servers/{name}/join`: under `invites` a server without a password answers
/// like a password-protected one, and under `nobody` every call gets the 404. Strict and
/// general rate-limit buckets.
#[utoipa::path(
    post,
    path = "/api/v1/servers/{name}/guest_access",
    operation_id = "server_guest_access",
    tag = "Servers",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    request_body = GuestAccessReq,
    responses(
        (status = 200, description = "Password accepted; returns a guest grant for viewing the server without an account. For a server that people who aren't members may read by its name `grant` is `null` and any `password` is ignored", body = GuestGrant),
        (status = 400, description = "Malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", content_type = "text/plain", body = String),
        (status = 401, description = "`Password required`: no `password` was given and the name is not a server without a password (password-protected and nonexistent names answer identically). Also `Guest access is disabled` for guests without a valid token when guest access is off", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: the same body for a wrong password and for a name that does not exist", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the strict or the general bucket. Also `Too many attempts. Try again later` (JSON) after too many password attempts from your address (an IPv6 /64 counts as one) or your network (an IPv4 /24 or IPv6 /48), after 5 wrong passwords for this name from your address (then a wait that doubles up to an hour; 3 an hour while many addresses get the name wrong; names that do not exist count the same way), or while the server is busy checking passwords. `Too many guests use this password. Try again later` (JSON) when the password already has its live guest grants (by default 2000, `GUEST_GRANTS_PER_PASSWORD`), or your network has its share (by default 50, `GUEST_GRANTS_PER_NETWORK`). Grants made per address (20 an hour) and per network (by default 60 an hour across servers, `GUEST_GRANT_MINTS_PER_NETWORK`) are limited too, with `Too many attempts. Try again later`", body = ApiErrorBody)
    ),
    security((), ("bearer" = []))
)]
pub(crate) async fn guest_access(
    State(state): State<AppState>,
    MaybeAuthed(viewer): MaybeAuthed,
    Path(name): Path<String>,
    Json(req): Json<GuestAccessReq>,
) -> Result<Json<GuestGrant>, ApiError> {
    require_guest_ok(&state.db, viewer.as_ref()).await?;
    if resolve_reading(&state.db, &name, None).await?.is_some() {
        return Ok(Json(GuestGrant { grant: None }));
    }
    let joining = crate::api::policy::effective(&state.db, viewer.as_ref())
        .await
        .server_joining();
    let access = resolve_join(&state.db, &name, None, req.password.as_deref(), joining).await?;
    if access.via() == Via::Public {
        return Ok(Json(GuestGrant { grant: None }));
    }
    let network = grant_network(&state.db, &state.limits).await?;
    let grant = new_token();
    let t = state.clock.unix();
    let cutoff = t - state.limits.guest_grant_ttl();
    let password_id = access.password_id().unwrap_or(0);
    let mut tx = state.db.begin().await?;
    lock_server(&mut tx, access.name()).await?;
    sqlx::query("DELETE FROM guest_grants WHERE server = $1 AND COALESCE(password_id, 0) = $2 AND last_used_at < $3 AND (last_used_at > 0 OR created_at < $3)")
        .bind(access.name())
        .bind(password_id)
        .bind(cutoff)
        .execute(&mut *tx)
        .await?;
    let made = sqlx::query("INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at, password_id, network) SELECT $1, $2, $3, $3, $4, $7 WHERE (SELECT COUNT(*) FROM guest_grants WHERE server = $2 AND COALESCE(password_id, 0) = $5) < $6 AND (SELECT COUNT(*) FROM guest_grants WHERE server = $2 AND network = $7 AND COALESCE(password_id, 0) = $5) < $8")
        .bind(crate::db::secret_key(&grant))
        .bind(access.name())
        .bind(t)
        .bind(access.password_id())
        .bind(password_id)
        .bind(i64::from(state.limits.guest_grants_per_password))
        .bind(&network)
        .bind(i64::from(state.limits.guest_grants_per_network))
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if made == 0 {
        return Err(ApiError::capacity(
            StatusCode::TOO_MANY_REQUESTS,
            TOO_MANY_GUESTS,
            crate::api::error::Cap::GuestGrants,
            None,
        ));
    }
    access.spend_ticket(&mut tx).await?;
    tx.commit().await?;
    Ok(Json(GuestGrant { grant: Some(grant) }))
}

/// Guest grants minted per client address (an IPv6 /64 counts as one address).
static GRANT_MINTS: std::sync::LazyLock<crate::limits::bucket::Keyed> =
    std::sync::LazyLock::new(|| {
        crate::limits::bucket::Keyed::new(
            crate::limits::bucket::Policy::Window {
                limit: 20,
                window: std::time::Duration::from_secs(3600),
            },
            100_000,
        )
    });

/// Guest grants minted per wider network (IPv4 /24, IPv6 /48) in an hour, across all servers,
/// under `GUEST_GRANT_MINTS_PER_NETWORK`.
static GRANT_NETWORK_MINTS: std::sync::LazyLock<crate::limits::bucket::Keyed> =
    std::sync::LazyLock::new(|| {
        crate::limits::bucket::Keyed::new(network_mints(GRANT_NETWORK_MINTS_MAX), 100_000)
    });

fn network_mints(limit: u32) -> crate::limits::bucket::Policy {
    crate::limits::bucket::Policy::Window {
        limit,
        window: std::time::Duration::from_secs(3600),
    }
}

pub(crate) const GRANT_NETWORK_MINTS_MAX: u32 =
    rchat_settings::items::GUEST_GRANT_MINTS_PER_NETWORK.default() as u32;

/// Most live guest grants per wider network and server password, so one network can not use up
/// a password's share for everyone else.
pub const GRANTS_PER_NETWORK: i64 = rchat_settings::items::GUEST_GRANTS_PER_NETWORK.default();

/// Takes the mint budgets of the client's network, then of its address, and returns the stored
/// network marker: an HMAC of the IPv4 /24 or IPv6 /48 under the instance pepper.
async fn grant_network(db: &Db, limits: &crate::limits::Limits) -> Result<String, ApiError> {
    use hmac::{Hmac, KeyInit, Mac};
    let ip = crate::api::budget::client();
    let wide = match ip {
        Some(ip) => crate::api::budget::wide(ip).to_string(),
        None => "-".to_string(),
    };
    if let Some(ip) = ip {
        let pool = crate::db::pool_key(db);
        let group = crate::api::budget::group(ip);
        let now = tokio::time::Instant::now();
        if !GRANT_NETWORK_MINTS
            .under(network_mints(limits.guest_grant_mints_per_network))
            .take(&format!("{pool}\n{wide}"), 1.0, now)
            || !GRANT_MINTS.take(&format!("{pool}\n{group}"), 1.0, now)
        {
            return Err(crate::api::budget::slow_down());
        }
    }
    let pepper = crate::db::pepper(db).await?;
    let mut mac = <Hmac<sha2::Sha256> as KeyInit>::new_from_slice(&pepper).map_err(|_| {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "pepper".to_string(),
            None,
        )
    })?;
    mac.update(b"guest network\n");
    mac.update(wide.as_bytes());
    Ok(format!("n:{}", hex::encode(mac.finalize().into_bytes())))
}

/// Most live guest grants per server password (the permanent password counts as one). Past it,
/// no new grants are given until older ones expire; live grants of others never end for it.
pub const GRANTS_PER_PASSWORD: i64 = rchat_settings::items::GUEST_GRANTS_PER_PASSWORD.default();

pub const TOO_MANY_GUESTS: &str = "Too many guests use this password. Try again later";

const INVITE_PREVIEW: i64 = 3;

fn invite_password(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get("x-invite-password")?.to_str().ok()?;
    let decoded = percent_encoding::percent_decode_str(raw)
        .decode_utf8()
        .ok()?;
    match decoded.trim() {
        "" => None,
        password => Some(password.to_string()),
    }
}

#[derive(Default, Deserialize)]
pub(crate) struct InvitePreviewQuery {
    preview_revision: Option<String>,
}

#[derive(Default)]
struct InvitePreview {
    name: Option<String>,
    id: Option<i64>,
    sensitive: bool,
    messages: Vec<Message>,
}

/// The preview channel and its latest messages, as the viewer may read them: messages from
/// before the viewer's read-history floor are left out.
async fn invite_preview(
    db: &Db,
    access: ServerAccess,
    contents: bool,
    revision: Option<&str>,
) -> Result<InvitePreview, ApiError> {
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT c.id, c.name FROM channels c WHERE c.server = $1 AND c.kind = 'text' AND NOT {} ORDER BY c.id LIMIT 1",
        private_sql()
    )))
    .bind(access.name())
    .fetch_optional(db)
    .await?;
    let Some(r) = row else {
        return Ok(InvitePreview::default());
    };
    let (id, name): (i64, String) = (r.try_get(0)?, r.try_get(1)?);
    let Some(channel) = allowed(access.channel(db, id).await)? else {
        return Ok(InvitePreview::default());
    };
    let sensitive = channel.sensitive();
    let mut preview = InvitePreview {
        name: Some(name),
        id: Some(id),
        sensitive,
        messages: Vec::new(),
    };
    if contents && revision.is_none_or(|r| r == channel.viewing_revision()) {
        let floor = channel.read_since(db).await?;
        preview.messages = recent_channel_messages(db, id, INVITE_PREVIEW).await?;
        if let Some(floor) = floor {
            preview.messages.retain(|m| m.created_at >= floor);
        }
    }
    Ok(preview)
}

/// Preview an invite
///
/// Returns an invite card: the server, the viewer `status`, member and online counts, and a short
/// preview of recent messages. The password step is the same as for
/// `POST /api/v1/servers/{name}/join`. You get the card for a server without a password, a server you
/// are a member of, or (for guests) a server that a valid `X-Guest-Grant` unlocks. All other names
/// get the same `401 Password required` without `X-Invite-Password`, also when the server does not
/// exist. A wrong password or an unknown name gets `404 Server not found or wrong password`.
/// While the instance's `server_joining` is `invites` or `nobody`, a server without a password
/// answers like a password-protected one unless you are a member, and under `nobody` a request
/// without `X-Invite-Password` gets that 404 for every name instead of the 401. A server that
/// people who aren't members may read by its name always gets its card: with status `readable`
/// when what you sent doesn't join it.
/// Banned viewers get the card (with counts) only after they prove access, and never a preview.
/// The preview has the last 3 top-level messages of the first text channel without permission
/// rules.
///
/// Signed-in users may call it, and guests when guest access is on. Invite and general rate-limit
/// buckets.
#[utoipa::path(
    get,
    path = "/api/v1/invites/{name}",
    tag = "Invites",
    params(
        ("preview_revision" = Option<String>, Query, description = "Only include messages if the preview channel matches this previously observed channel ID and shared label, formatted as id.0 or id.1"),
        ("name" = String, Path, description = "Server name, case-insensitive"),
        ("X-Invite-Password" = Option<String>, Header, description = "Percent-encoded server password from the invite link or typed by the viewer; blank counts as absent"),
        ("X-Guest-Grant" = Option<String>, Header, description = "Guest grants from `POST /api/v1/servers/{name}/guest_access`, comma-separated, up to 100. Only read for guests; a valid grant unlocks the card")
    ),
    responses(
        (status = 200, description = "Invite card for the server", body = Invite),
        (status = 401, description = "`Password required`: identical for password-protected servers you have not unlocked and for names that do not exist. Also `Guest access is disabled` when guest access is off and no valid token was sent", body = ApiErrorBody),
        (status = 403, description = "`You are banned from this server`, only after access was proven (correct password, or you took part in the server before)", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: identical for a wrong `X-Invite-Password` and for a name that does not exist", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the invite or the general bucket. Also `Too many attempts. Try again later` (JSON) after too many password attempts from your address (an IPv6 /64 counts as one) or your network (an IPv4 /24 or IPv6 /48), after 5 wrong passwords for this name from your address (then a wait that doubles up to an hour; 3 an hour while many addresses get the name wrong; names that do not exist count the same way), or while the server is busy checking passwords", body = ApiErrorBody)
    ),
    security((), ("bearer" = []))
)]
pub(crate) async fn get_invite(
    State(state): State<AppState>,
    MaybeAuthed(viewer): MaybeAuthed,
    headers: HeaderMap,
    Path(name): Path<String>,
    Query(query): Query<InvitePreviewQuery>,
) -> Result<Json<Invite>, ApiError> {
    invite_card(
        state,
        viewer,
        headers,
        name,
        true,
        query.preview_revision.as_deref(),
    )
    .await
}

/// Read invite card metadata
///
/// Returns the card with an empty message list. When the viewer can read the preview channel,
/// the card includes its ID and shared sensitive label. Pass these values in `preview_revision`
/// when requesting preview messages from `GET /api/v1/invites/{name}`.
#[utoipa::path(
    get, path = "/api/v1/invites/{name}/metadata", tag = "Invites",
    params(
        ("name" = String, Path, description = "Server name"),
        ("X-Invite-Password" = Option<String>, Header, description = "Percent-encoded invite password"),
        ("X-Guest-Grant" = Option<String>, Header, description = "Guest grants")
    ),
    responses((status = 200, description = "Authorized card with an empty preview", body = Invite),
        (status = 401, description = "Password required or guests disabled", body = ApiErrorBody),
        (status = 403, description = "Access denied", body = ApiErrorBody),
        (status = 404, description = "Unknown server or wrong password", body = ApiErrorBody),
        (status = 429, description = "Too many requests")),
    security((), ("bearer" = []))
)]
pub(crate) async fn invite_metadata(
    State(state): State<AppState>,
    MaybeAuthed(viewer): MaybeAuthed,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Result<Json<Invite>, ApiError> {
    invite_card(state, viewer, headers, name, false, None).await
}

async fn invite_card(
    state: AppState,
    viewer: Option<User>,
    headers: HeaderMap,
    name: String,
    contents: bool,
    revision: Option<&str>,
) -> Result<Json<Invite>, ApiError> {
    let db = &state.read();
    require_guest_ok(db, viewer.as_ref()).await?;
    let given = invite_password(&headers);
    let grants = match viewer {
        Some(_) => Vec::new(),
        None => header_grants(&headers),
    };
    let proof = Proof::password(given.as_deref()).and_grants(grants, &state.limits);
    let (view, joins) = match resolve_invite(db, &name, viewer.as_ref(), &proof).await {
        Ok(view) => (view, true),
        Err(e) if e.failed() => return Err(e),
        Err(e) => match resolve_reading(db, &name, viewer.as_ref()).await? {
            Some(view) => (view, false),
            None => return Err(e),
        },
    };
    Ok(Json(
        card_of(&state, db, view, joins, contents, revision).await?,
    ))
}

/// Preview an invite code
///
/// Returns the invite card of an invite link (`/i/{code}/`) with an empty message list: the
/// server with the key to join it by (`server.name`), the viewer `status`, member and online
/// counts, and, when the viewer can read the preview channel, its ID and shared sensitive label.
/// Load the preview messages with `GET /api/v1/invites/{name}` and the code as
/// `X-Invite-Password`. Join with `POST /api/v1/servers/{name}/join` and the code as `password`;
/// guests get access with `POST /api/v1/servers/{name}/guest_access` and the code. Codes are
/// found case-blind. An unknown code, and one that is revoked, expired or used up, all get the
/// same `404 Not found`, after the same work; each counts as a wrong password of your address
/// and network.
///
/// Signed-in users may call it, and guests when guest access is on. Invite and general
/// rate-limit buckets.
#[utoipa::path(
    get,
    path = "/api/v1/invite_codes/{code}",
    tag = "Invites",
    params(
        ("code" = String, Path, description = "The invite code"),
        ("X-Guest-Grant" = Option<String>, Header, description = "Guest grants from `POST /api/v1/servers/{name}/guest_access`, comma-separated, up to 100. Only read for guests")
    ),
    responses(
        (status = 200, description = "Invite card for the server the code opens, with an empty preview", body = Invite),
        (status = 401, description = "`Guest access is disabled` when guest access is off and no valid token was sent", body = ApiErrorBody),
        (status = 403, description = "`You are banned from this server`", body = ApiErrorBody),
        (status = 404, description = "`Not found`: identical for unknown, revoked, expired and used-up codes", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the invite or the general bucket. Also `Too many attempts. Try again later` (JSON) after too many password attempts from your address (an IPv6 /64 counts as one) or your network (an IPv4 /24 or IPv6 /48), after 5 codes that work nowhere from your address (then a wait that doubles up to an hour), or while the server is busy checking passwords", body = ApiErrorBody)
    ),
    security((), ("bearer" = []))
)]
pub(crate) async fn get_invite_code(
    State(state): State<AppState>,
    MaybeAuthed(viewer): MaybeAuthed,
    headers: HeaderMap,
    Path(code): Path<String>,
) -> Result<Json<Invite>, ApiError> {
    let db = &state.read();
    require_guest_ok(db, viewer.as_ref()).await?;
    let grants = match viewer {
        Some(_) => Vec::new(),
        None => header_grants(&headers),
    };
    let view =
        crate::api::access::resolve_code(db, &code, viewer.as_ref(), grants, &state.limits).await?;
    Ok(Json(card_of(&state, db, view, true, false, None).await?))
}

/// The invite card of `view`; `joins` when what the viewer showed lets them join, `contents`
/// with the preview messages when `revision` is none or the preview channel's.
async fn card_of(
    state: &AppState,
    db: &Db,
    view: InviteView,
    joins: bool,
    contents: bool,
    revision: Option<&str>,
) -> Result<Invite, ApiError> {
    let (server, status, preview, ticket) = match view {
        InviteView::Banned(lite) => (lite, InviteStatus::Banned, InvitePreview::default(), None),
        InviteView::Open(access) => {
            let status = match (access.is_member(), joins) {
                (true, _) => InviteStatus::Member,
                (false, true) => InviteStatus::Joinable,
                (false, false) => InviteStatus::Readable,
            };
            let (lite, ticket) = (access.lite().clone(), access.ticket());
            let preview = match access.via() {
                Via::Joinable | Via::Managed => InvitePreview::default(),
                Via::Public | Via::Member | Via::Password | Via::Grant | Via::Staff => {
                    invite_preview(db, *access, contents, revision).await?
                }
            };
            (lite, status, preview, ticket)
        }
    };
    Ok(Invite {
        online_count: state.hub.online_count(&server.name),
        member_count: member_count(db, &server.name).await?,
        server,
        status,
        preview_channel: preview.name,
        preview_channel_id: preview.id,
        preview_sensitive: preview.sensitive,
        preview: preview.messages,
        password_expires_at: ticket.and_then(|t| t.expires_at),
        password_uses_left: ticket.and_then(|t| t.uses_left),
    })
}

/// Locks the row of the account `username` until the transaction ends (on Postgres; SQLite has
/// one writer). A transaction that adds a membership takes it before `lock_server`, so the
/// account's servers are counted once at a time.
pub(crate) async fn lock_account(conn: &mut AnyConnection, username: &str) -> sqlx::Result<()> {
    if conn.backend_name() == "PostgreSQL" {
        sqlx::query("SELECT 1 FROM users WHERE username = $1 FOR NO KEY UPDATE")
            .bind(username)
            .fetch_optional(&mut *conn)
            .await?;
    }
    Ok(())
}

/// The refusal past `SERVERS_PER_ACCOUNT`.
fn account_full(most: i64) -> ApiError {
    ApiError::limit(
        StatusCode::BAD_REQUEST,
        format!("An account can be in at most {most} servers"),
        &rchat_settings::items::SERVERS_PER_ACCOUNT,
    )
}

/// Whether `username` may be in one server more (`SERVERS_PER_ACCOUNT`, 0 for no cap), counted
/// after `lock_account`.
pub(crate) async fn account_has_room(
    conn: &mut AnyConnection,
    limits: &Limits,
    username: &str,
) -> sqlx::Result<bool> {
    let most = limits.servers_per_account;
    if most == 0 {
        return Ok(true);
    }
    let count: i64 = sqlx::query("SELECT COUNT(*) FROM members WHERE username = $1")
        .bind(username)
        .fetch_one(&mut *conn)
        .await?
        .try_get(0)?;
    Ok(count < most)
}

async fn room_for_account(
    conn: &mut AnyConnection,
    limits: &Limits,
    username: &str,
) -> Result<(), ApiError> {
    match account_has_room(conn, limits, username).await? {
        true => Ok(()),
        false => Err(account_full(limits.servers_per_account)),
    }
}

/// Whether `server` takes one member more (`SERVER_MEMBERS_MAX`, 0 for no cap), counted after
/// `lock_server`.
pub(crate) async fn server_has_room(
    conn: &mut AnyConnection,
    limits: &Limits,
    server: &str,
) -> sqlx::Result<bool> {
    let most = limits.server_members_max;
    if most == 0 {
        return Ok(true);
    }
    let count: i64 = sqlx::query("SELECT member_count FROM servers WHERE name = $1")
        .bind(server)
        .fetch_optional(&mut *conn)
        .await?
        .map(|r| r.try_get(0))
        .transpose()?
        .unwrap_or(0);
    Ok(count < most)
}

async fn room_in_server(
    conn: &mut AnyConnection,
    limits: &Limits,
    server: &str,
) -> Result<(), ApiError> {
    match server_has_room(conn, limits, server).await? {
        true => Ok(()),
        false => Err(ApiError::capacity(
            StatusCode::BAD_REQUEST,
            "This server is full",
            &rchat_settings::items::SERVER_MEMBERS_MAX,
            None,
        )),
    }
}

/// A membership `insert_member` created, with its join message when one was posted.
pub(crate) struct NewMember {
    pub(crate) notice: Option<i64>,
}

async fn insert_member(
    db: &Db,
    limits: &Limits,
    access: &ServerAccess,
    username: &str,
) -> Result<Option<NewMember>, ApiError> {
    let server = access.name();
    let mut tx = db.begin().await?;
    lock_account(&mut tx, username).await?;
    lock_server(&mut tx, server).await?;
    let result = insert_member_locked(&mut tx, limits, access, username).await?;
    tx.commit().await?;
    Ok(result)
}

pub(crate) async fn insert_member_locked(
    tx: &mut AnyConnection,
    limits: &Limits,
    access: &ServerAccess,
    username: &str,
) -> Result<Option<NewMember>, ApiError> {
    let server = access.name();
    if access.member_in(&mut *tx, username).await? {
        return Ok(None);
    }
    let banned = crate::api::bans::banned(&mut *tx, server, username).await?;
    if banned {
        return Err(ApiError::locked_by(BANNED, "ban", None));
    }
    room_in_server(tx, limits, server).await?;
    room_for_account(tx, limits, username).await?;
    let inserted = sqlx::query(
        "INSERT INTO members(server, username, is_admin, joined_at, joined_via) SELECT $1, $2, 0, $3, $4 WHERE NOT EXISTS(SELECT 1 FROM server_bans WHERE server = $1 AND username = $2 AND (expires_at IS NULL OR expires_at > $3)) ON CONFLICT(server, username) DO NOTHING",
    )
    .bind(server)
    .bind(username)
    .bind(now())
    .bind(access.password_id())
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if inserted > 0 {
        shift_member_count(tx, server, 1).await?;
        access.spend_ticket(tx).await?;
        if let Some(id) = access.password_id()
            && let Some((kind, label)) = crate::api::passwords::joined_with(tx, id).await?
        {
            audit::record(
                tx,
                Entry::new(
                    server,
                    &audit::Actor::User(username.to_string()),
                    audit::Action::MemberJoin,
                )
                .target(Target::with_id(TargetKind::Password, id, label.as_deref()))
                .details(Details::new().set("kind", crate::api::passwords::kind_word(kind))),
            )
            .await?;
        }
        let notice = post_system(tx, server, username, SystemKind::Join).await?;
        return Ok(Some(NewMember { notice }));
    }
    let member = access.member_in(&mut *tx, username).await?;
    match member {
        true => Ok(None),
        false => Err(ApiError::locked_by(BANNED, "ban", None)),
    }
}

/// Adds the account `username` to `server` on behalf of the site admin `admin`, whatever the
/// instance lets people join by themselves, and gives it the roles `roles` of that server.
/// The server is the one the admin's own access resolves, so a missing one answers the uniform
/// 404; a role of another server is refused before anything changes. The membership has no
/// `joined_via` and gets the server's join message. Answers the server's key.
pub(crate) async fn add_for(
    state: &AppState,
    admin: &User,
    server: &str,
    username: &str,
    roles: &[i64],
) -> Result<String, ApiError> {
    let access = resolve_server(&state.db, server, Some(admin), &Proof::none()).await?;
    let key = access.name().to_string();
    for id in roles {
        require_role(&state.db, &key, *id).await?;
    }
    let inserted = insert_member(&state.db, &state.limits, &access, username).await?;
    if let Some(NewMember { notice }) = inserted {
        let member = build_member(
            &state.db,
            &state.hub,
            &key,
            access.lite().creator.as_deref(),
            username,
            false,
            0,
        )
        .await?;
        state.hub.broadcast(WsEvent::MemberJoined {
            server: key.clone(),
            member,
        });
        announce_system(state, &key, notice).await;
    }
    for id in roles {
        let Json(OkResp { ok: _ }) = assign_role(
            State(state.clone()),
            Authed(admin.clone()),
            Path((key.clone(), *id)),
            Json(UsernameReq {
                username: username.to_string(),
            }),
        )
        .await?;
    }
    Ok(key)
}

/// Join a server
///
/// Adds the caller as a member (not an admin) and returns the server details. Requires a
/// bearer token. The body is optional (send no `Content-Type` without a body). Password step: a
/// server without a password, or one you are a member of, is joined at once and `password` is
/// ignored. For all other names, a call without `password` gets `401 Password required`, also
/// when the server does not exist. A wrong password or an unknown name gets
/// `404 Server not found or wrong password`. The password is always hashed, also for unknown
/// names. A ban (403) shows only after you prove access: no password, the correct password, or
/// earlier membership. A new membership emits `member_joined` to the server and the user. Then a
/// `join` system message (`message` event) goes to the system channel, unless join messages are
/// off or the user got one in this server in the last 10 minutes. The instance may limit
/// joining (`server_joining` in `GET /api/v1/settings`): under `invites` a server without a
/// password answers like a password-protected one unless you are a member, so a name alone
/// gets `401 Password required` and only a password or ticket joins; under `nobody` every call
/// gets `404 Server not found or wrong password`. After access is proven, an account in
/// `SERVERS_PER_ACCOUNT` servers (by default 1000) or a server with `SERVER_MEMBERS_MAX` members
/// (by default no cap) refuses a new membership; lowering either removes nobody. Join and general
/// rate-limit buckets.
#[utoipa::path(
    post,
    path = "/api/v1/servers/{name}/join",
    tag = "Servers",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    request_body(content = Option<JoinReq>, description = "Optional; `password` is only read for password-protected servers you are not a member of"),
    responses(
        (status = 200, description = "Joined, or already a member; returns the server details", body = ServerDetail),
        (status = 400, description = "`An account can be in at most 1000 servers` with the configured number (`SERVERS_PER_ACCOUNT`, reason `limit`), or `This server is full` (`SERVER_MEMBERS_MAX`, reason `capacity`), only after access was proven. Malformed JSON body (plain-text framework error)", body = ApiErrorBody),
        (status = 401, description = "`Password required`: no `password` and the name is not a server without a password (identical for password-protected and nonexistent names). Also `Unauthorized` for a missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "`You are banned from this server`, only after access was proven", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: identical for a wrong password and for a name that does not exist", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the join or the general bucket. Also `Too many attempts. Try again later` (JSON) after too many password attempts from your address (an IPv6 /64 counts as one) or your network (an IPv4 /24 or IPv6 /48), after 5 wrong passwords for this name from your address (then a wait that doubles up to an hour; 3 an hour while many addresses get the name wrong; names that do not exist count the same way), or while the server is busy checking passwords", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn join_server(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    body: Option<Json<JoinReq>>,
) -> Result<Json<ServerDetail>, ApiError> {
    let given = body.as_ref().and_then(|Json(j)| j.password.as_deref());
    let joining = crate::api::policy::effective(&state.db, Some(&user))
        .await
        .server_joining();
    let access = resolve_join(&state.db, &name, Some(&user), given, joining).await?;
    let key = access.name().to_string();
    let inserted = insert_member(&state.db, &state.limits, &access, &user.username).await?;
    let access = resolve_server(&state.db, &key, Some(&user), &Proof::none()).await?;
    let detail = server_detail(&state.db, &state.hub, &access).await?;
    if let Some(NewMember { notice }) = inserted {
        announce_join(
            &state,
            &key,
            access.lite().creator.as_deref(),
            &user.username,
            notice,
        )
        .await?;
    }
    Ok(Json(detail))
}

pub(crate) async fn announce_join(
    state: &AppState,
    key: &str,
    creator: Option<&str>,
    username: &str,
    notice: Option<i64>,
) -> Result<(), ApiError> {
    let member = build_member(&state.db, &state.hub, key, creator, username, false, 0).await;
    let joined = member.map(|member| {
        state.hub.broadcast(WsEvent::MemberJoined {
            server: key.to_owned(),
            member,
        });
    });
    let timeout = running_timeouts(&state.db, key, &[username.to_owned()])
        .await
        .map(|running| {
            if let Some(timeout) = running.into_values().next() {
                state
                    .hub
                    .broadcast(timeout_event(key, username, Some(timeout)));
            }
        });
    announce_system(state, key, notice).await;
    joined.and(timeout)
}

/// A membership `end_membership` removed, with its leave message when one was posted.
pub(crate) struct Ended {
    pub(crate) notice: Option<i64>,
}

/// Ends `username`'s membership of `server` (leave, kick, ban): drops the member row, their
/// roles there and their pings in the server, lowers the member count and posts a leave message.
/// The caller took `lock_server` first. Returns `None` when they were not a member.
pub(crate) async fn end_membership(
    conn: &mut sqlx::AnyConnection,
    server: &str,
    username: &str,
) -> sqlx::Result<Option<Ended>> {
    let removed = sqlx::query("DELETE FROM members WHERE server = $1 AND username = $2")
        .bind(server)
        .bind(username)
        .execute(&mut *conn)
        .await?
        .rows_affected();
    sqlx::query("DELETE FROM user_roles WHERE server = $1 AND username = $2")
        .bind(server)
        .bind(username)
        .execute(&mut *conn)
        .await?;
    sqlx::query("DELETE FROM sso_grants WHERE server = $1 AND username = $2")
        .bind(server)
        .bind(username)
        .execute(&mut *conn)
        .await?;
    crate::api::profiles::forget(conn, server, username).await?;
    forget_server_pings(conn, server, username).await?;
    if removed == 0 {
        return Ok(None);
    }
    shift_member_count(conn, server, -(removed as i64)).await?;
    let notice = post_system(conn, server, username, SystemKind::Leave).await?;
    Ok(Some(Ended { notice }))
}

/// Leave a server
///
/// Removes the caller from the server and drops their role assignments. Anyone may leave,
/// including the creator and admins. Requires a bearer token. Posts a `leave` system message
/// (`message` event) in the server's system channel unless leave messages are off or the same
/// user got one in this server in the last 10 minutes. Emits `member_left` to the server and the
/// caller, and the caller goes offline in the server. General rate-limit bucket.
#[utoipa::path(
    post,
    path = "/api/v1/servers/{name}/leave",
    tag = "Servers",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    responses(
        (status = 200, description = "Left the server and dropped its roles", body = OkResp),
        (status = 400, description = "Not a member", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses)", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn leave_server(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
) -> Result<Json<OkResp>, ApiError> {
    let access = resolve_server(&state.db, &name, Some(&user), &Proof::none()).await?;
    let key = access.name().to_string();
    let mut tx = state.db.begin().await?;
    lock_server(&mut tx, &key).await?;
    let ended = end_membership(&mut tx, &key, &user.username).await?;
    tx.commit().await?;
    match ended {
        None => Err(ApiError::invalid("Not a member", "username")),
        Some(Ended { notice }) => {
            announce_system(&state, &key, notice).await;
            state.hub.broadcast(WsEvent::MemberLeft {
                server: key.clone(),
                username: user.username.clone(),
            });
            Ok(ok())
        }
    }
}

/// Update a server
///
/// Renames the server, switches it between public and password protected or changes how people
/// join it (`join`), sets, changes or clears its permanent password, changes its header colors,
/// and sets whether people who aren't members can read it (`public_read`) and see its members
/// (`members_visible`), whether members without moderation rights see the member list
/// (`hide_members`), whether search lists it (`listed`), and whether guests can participate
/// in text and voice (`guest_chat_opt_in`, `guest_voice_opt_in`); every field is optional.
/// Turning a guest choice on requires its site switch. A suspended choice can be kept or turned
/// off. A server people join with an invite or that is closed keeps its key when it is renamed,
/// so its passwords and links keep working; one that turns to `name` or `password` takes its
/// lowercase name as its key. Joining by password or by name with `protected` and `password`
/// sets the matching `join_mode`.
/// Requires the Manage server settings permission; `members: remove` together with `password` also
/// requires Kick. The built-in rchat server can't be given a password and keeps its key
/// `rchat` (a new name changes only its display name); its colors, `public_read`,
/// `members_visible`, `hide_members` and the guest participation opt-ins may change.
///
/// When `password` is present, `members: remove` removes every other member you could kick
/// (their roles are dropped, as if kicked; see `ServerDetail.roles_order_confirmed`) and existing
/// guest grants are revoked unless `keep_guests` is true with `members: keep`. The response
/// carries `removed` and `kept` counts. Making the server public, or changing its lowercase
/// name, revokes every extra password (extra password lookups are bound to the name, and invite
/// links carry it); revoked passwords stay listed until they are purged.
///
/// Emits `server_renamed` (with `old_name`) to the server when the name or display name changed,
/// otherwise `server_updated` with the new state (password flag, colors, description and icon), and
/// `members_purged` to the server and the removed members. Voice users who can no longer open
/// the server leave their call, and with `guest_voice: false` every guest in its voice gets
/// `voice_ended` (`Guests can't use voice in this server`). Strict and general rate-limit buckets.
/// A new `name` counts with the name checks of `GET /api/v1/servers/{name}/available`, and a new
/// `password` with new server passwords, as rare requests: at most `RARE_REQUESTS_PER_HOUR` (20) an
/// hour and `RARE_REQUESTS_PER_DAY` (100) a day per account and kind by default. A password refused
/// by its checks, or while the server is busy, does not count.
#[utoipa::path(
    patch,
    path = "/api/v1/servers/{name}",
    tag = "Servers",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    request_body = ServerPatch,
    responses(
        (status = 200, description = "The updated server, with `removed`, the number of members removed, and `kept`, the number of other members who stayed", body = ServerUpdated),
        (status = 400, description = "Invalid server name (blank, longer than 100 characters, `.` or `..`, or blocked by the profanity filter), the name is taken, or an invalid banner or name color, a description over 300 characters (`Description must be at most 300 characters`) or blocked by the profanity filter, a new password shorter than 8 characters, or a new password that is already a live extra password of the server. With reason `invalid` and its `field`: `Use join or protected, not both`, `Pick one way to join` (a `password` with `join` other than `password`), `A password needs 8 characters` (`join: password` on a server without a permanent password), `Listed is only for servers people join by name`, or `That name is taken. Pick another to let people join by name.` (the server would take its lowercase name as its key, and another server has it). `This instance needs invites to join. Pick invite or password.` with reason `off_site` and control `server_joining`: `join: name` while the instance's `server_joining` is `invites`. `An account can be in at most 1000 servers` with the configured number (`SERVERS_PER_ACCOUNT`, reason `limit`): creating a server counts as joining it. Malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Manage server settings permission, missing Kick for `members: remove`, a password or `join` change on the protected rchat server, enabling guest text or voice while its site switch is off, or `public_read: true` while the instance has public reading off (`Public reading is turned off on this site`, with reason `off_site` and control `public_reading`), or `seal: false` while the site requires encrypted storage (`Required by this site`, with reason `forced`)", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses)", body = ApiErrorBody),
        (status = 409, description = "The new name belonged to a deleted server that is still being purged; try again later. With reason `keys`, for `seal: true`: `This site needs an encryption key first` or `Not available while this site updates`", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "`You've done this too often. Try again later.` (JSON, with `Retry-After`): past the rare requests of this kind. Too many requests in the strict or the general bucket, or `Too many attempts. Try again later` (JSON) while the server is busy checking passwords. With `seal`, `Sending too fast, try again in a moment` (JSON, reason `rate`, with `Retry-After`): a switch posts a system message, so it counts against `MESSAGE_RATE_BURST` and `MESSAGE_RATE_PER_MINUTE` like one", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn update_server(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Json(req): Json<ServerPatch>,
) -> Result<Json<ServerUpdated>, ApiError> {
    let key = name.to_lowercase();
    let ServerPatch {
        name,
        password,
        protected,
        members,
        keep_guests,
        banner_color,
        name_color,
        public_read,
        guest_voice,
        guest_chat_opt_in,
        guest_voice_opt_in,
        members_visible,
        hide_members,
        join,
        listed: list,
        profiles_mode,
        description,
        icon_kind,
        seal,
    } = req;
    let guest_voice = guest_voice_opt_in.or(guest_voice.filter(|v| !v));
    let builtin = is_builtin(&state.db, &key).await;
    if password.is_some() || protected.is_some() || join.is_some() {
        guard_rchat(&state.db, &key).await?;
    }
    let access = resolve_server(&state.db, &key, Some(&user), &Proof::none()).await?;
    access.require_perm(&state.db, Perm::ManageServer).await?;
    if seal.is_some() {
        crate::api::messages::message_rate(&state, &user).await?;
    }
    if seal == Some(true) {
        crate::api::seal::make_ready(&state).await?;
    }
    if join.is_some() && protected.is_some() {
        return Err(ApiError::invalid(
            "Use join or protected, not both",
            "protected",
        ));
    }
    let allowed = crate::api::policy::effective(&state.db, Some(&user)).await;
    if public_read == Some(Some(true)) && !allowed.public_reading() {
        return Err(crate::api::policy::refused(
            &rchat_settings::items::PUBLIC_READING,
            ApiError::perm(PUBLIC_READING_OFF, "member"),
        ));
    }
    needs_invites(allowed.server_joining(), join)?;
    let key = access.name().to_string();
    let lite = access.lite().clone();
    let stored = match sqlx::query("SELECT join_mode FROM servers WHERE name = $1")
        .bind(&key)
        .fetch_optional(&state.db)
        .await?
    {
        Some(row) => row
            .try_get::<Option<String>, _>(0)?
            .as_deref()
            .and_then(JoinMode::parse),
        None => None,
    };
    let typed = password.as_deref().map(str::trim).filter(|p| !p.is_empty());
    if let Some(mode) = join {
        match (mode, typed) {
            (JoinMode::Password, None) if lite.join_mode != JoinMode::Password => {
                return Err(ApiError::invalid(PASSWORD_NEEDED, "password"));
            }
            (JoinMode::Name | JoinMode::Invite | JoinMode::Closed, Some(_)) => {
                return Err(ApiError::invalid(PICK_ONE, "join"));
            }
            _ => {}
        }
    }
    let listed = crate::api::policy::Policy::cached(&state.db).await;
    let banner_color = server_color(banner_color, "banner")?;
    let name_color = server_color(name_color, "name")?;
    let description = match description {
        Some(text) => Some(server_about::clean_description(&state.db, text.as_deref()).await?),
        None => None,
    };
    let purge = password.is_some() && members == PasswordMembers::Remove;
    if purge {
        access.require_perm(&state.db, Perm::Kick).await?;
    }
    let mine = access.perms(&state.db).await?;
    let own = access.member_own_perms(&state.db).await?;
    let display = match &name {
        Some(n) => {
            let display = n.trim().to_string();
            check_server_name(&state.db, &display).await?;
            display
        }
        None => lite.display_name.clone(),
    };
    let change = match (join, password.as_deref().map(str::trim), protected) {
        (Some(JoinMode::Name), _, _) => match lite.has_password {
            true => HashChange::Clear,
            false => HashChange::Keep,
        },
        (Some(JoinMode::Invite | JoinMode::Closed), _, _) => match lite.join_mode.by_name() {
            true => HashChange::NoPermanent,
            false => HashChange::Keep,
        },
        (Some(JoinMode::Password), None | Some(""), _) => HashChange::Keep,
        (None, Some(""), Some(true)) => HashChange::NoPermanent,
        (None, Some(""), _) | (None, None, Some(false)) => HashChange::Clear,
        (_, Some(p), _) => HashChange::Set(p),
        (None, None, Some(true)) if !lite.has_password => HashChange::NoPermanent,
        (None, None, _) => HashChange::Keep,
    };
    let stored_after = match (join, change) {
        (Some(mode), _) => Some(mode),
        (None, HashChange::Keep) => stored,
        (None, HashChange::Clear) => Some(JoinMode::Name),
        (None, HashChange::NoPermanent) => stored.filter(|m| !m.by_name()),
        (None, HashChange::Set(_)) => Some(JoinMode::Password),
    };
    let mode_after = match (join, change) {
        (Some(mode), _) => Some(mode),
        (None, HashChange::Keep) => Some(lite.join_mode),
        (None, HashChange::Clear) => Some(JoinMode::Name),
        (None, HashChange::NoPermanent) => {
            join_mode_of(stored_after.map(JoinMode::as_str), Some(NO_PERMANENT_HASH))
        }
        (None, HashChange::Set(_)) => Some(JoinMode::Password),
    };
    if list == Some(true) && !mode_after.is_some_and(JoinMode::by_name) {
        return Err(ApiError::invalid(LISTED_BY_NAME, "listed"));
    }
    let keyed_by_name = name.is_some() || stored.is_some_and(|m| !m.by_name());
    let new_key = match keeps_key(
        builtin,
        stored_after,
        mode_after.unwrap_or(JoinMode::Closed),
    ) {
        false if keyed_by_name => display.to_lowercase(),
        _ => key.clone(),
    };
    if new_key != key {
        rare::take(&state, Rare::ServerName, Some(&user))?;
        match (name_free(&state.db, &new_key).await, &name) {
            (Err(ApiError(StatusCode::BAD_REQUEST, _, _)), None) => {
                return Err(ApiError::invalid(NAME_FOR_JOINING, "name"));
            }
            (res, _) => res?,
        }
    }
    let password_hash = match change {
        HashChange::Keep => None,
        HashChange::Clear => Some(None),
        HashChange::NoPermanent => Some(Some(NO_PERMANENT_HASH.to_string())),
        HashChange::Set(p) => {
            rare::check(&state, Rare::ServerPassword, Some(&user))?;
            crate::api::passwords::check_strength(p)?;
            if new_key == key && access.is_live_extra_password(&state.db, p).await? {
                return Err(ApiError::conflict(
                    StatusCode::BAD_REQUEST,
                    "That password is already in use for this server",
                ));
            }
            let hash = hash_in(Work::Server, p).await?;
            rare::take(&state, Rare::ServerPassword, Some(&user))?;
            Some(Some(hash))
        }
    };
    let closing = join == Some(JoinMode::Closed);
    let public_now = matches!(password_hash, Some(None));
    let actor = access.audit_actor(&state.db, Perm::ManageServer).await?;
    let had_permanent = match password_hash {
        Some(_) => access.has_permanent_password(&state.db).await?,
        None => false,
    };
    let mut tx = state.db.begin().await?;
    rename_live(&mut tx, &key, &new_key, &display, password_hash.as_ref()).await?;
    if new_key != key {
        crate::api::policy::move_creator_roles(&mut tx, &key, Some(&new_key)).await?;
        crate::api::policy::move_default_server(&mut tx, &key, Some(&new_key)).await?;
    }
    set_colors(
        &mut tx,
        &new_key,
        banner_color.as_ref(),
        name_color.as_ref(),
    )
    .await?;
    if let Some(option) = public_read {
        sqlx::query("UPDATE servers SET public_read = $1 WHERE name = $2")
            .bind(option.map(i64::from))
            .bind(&new_key)
            .execute(&mut *tx)
            .await?;
    }
    for (choice, column, feature, refusal) in [
        (
            guest_chat_opt_in,
            "guest_chat_opt_in",
            Feature::GuestChat,
            "Guest text chat is turned off on this site",
        ),
        (
            guest_voice,
            "guest_voice_opt_in",
            Feature::GuestVoice,
            "Guest voice is turned off on this site",
        ),
    ] {
        if let Some(on) = choice {
            let sql = format!(
                "UPDATE servers SET {column} = $1 WHERE name = $2 AND ($1 = 0 OR {column} = 1 OR EXISTS (SELECT 1 FROM settings WHERE key = $3 AND value = '1'))"
            );
            if sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(i64::from(on))
                .bind(&new_key)
                .bind(feature.key())
                .execute(&mut *tx)
                .await?
                .rows_affected()
                == 0
            {
                return Err(ApiError::off_site(
                    StatusCode::FORBIDDEN,
                    refusal,
                    feature.item(),
                ));
            }
        }
    }
    if let Some(visible) = members_visible {
        sqlx::query("UPDATE servers SET members_visible = $1 WHERE name = $2")
            .bind(i64::from(visible))
            .bind(&new_key)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(hide) = hide_members {
        sqlx::query("UPDATE servers SET hide_members = $1 WHERE name = $2")
            .bind(i64::from(hide))
            .bind(&new_key)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(mode) = profiles_mode {
        sqlx::query("UPDATE servers SET profiles_mode = $1 WHERE name = $2")
            .bind(mode.as_str())
            .bind(&new_key)
            .execute(&mut *tx)
            .await?;
    }
    if stored_after != stored {
        sqlx::query("UPDATE servers SET join_mode = $1 WHERE name = $2")
            .bind(stored_after.map(JoinMode::as_str))
            .bind(&new_key)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(list) = list {
        sqlx::query("UPDATE servers SET listed = $1 WHERE name = $2")
            .bind(i64::from(list))
            .bind(&new_key)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(text) = &description {
        sqlx::query("UPDATE servers SET description = $1 WHERE name = $2")
            .bind(text)
            .bind(&new_key)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(kind) = icon_kind {
        sqlx::query("UPDATE servers SET icon_kind = $1 WHERE name = $2")
            .bind(kind.as_str())
            .bind(&new_key)
            .execute(&mut *tx)
            .await?;
    }
    let (removed, kept, bypassed) = match purge {
        true => purge_members(&mut tx, &new_key, &user, mine, own).await?,
        false => (
            Vec::new(),
            other_members(&mut tx, &new_key, &user.username).await?,
            false,
        ),
    };
    let actor = actor.staff_if(bypassed);
    let guests_revoked =
        password_hash.is_some() && !(keep_guests && members == PasswordMembers::Keep);
    if guests_revoked {
        sqlx::query("DELETE FROM guest_grants WHERE server = $1")
            .bind(&new_key)
            .execute(&mut *tx)
            .await?;
    }
    let passwords_revoked = public_now || closing || new_key != key;
    if passwords_revoked {
        crate::api::passwords::revoke_all(&mut tx, &new_key).await?;
    }
    let join_mode = match mode_after {
        Some(mode) => mode,
        None => crate::api::join_modes::legacy_mode(
            crate::api::access::has_live_extra(&mut *tx, &new_key).await?,
        ),
    };
    let changed = audit::Details::new()
        .change("name", lite.display_name.as_str(), display.as_str())
        .change(
            "banner_color",
            lite.banner_color.clone(),
            banner_color.clone().unwrap_or(lite.banner_color.clone()),
        )
        .change(
            "name_color",
            lite.name_color.clone(),
            name_color.clone().unwrap_or(lite.name_color.clone()),
        )
        .change(
            "public_read",
            reading_word(lite.public_read),
            reading_word(public_read.unwrap_or(lite.public_read)),
        )
        .change(
            "guest_chat",
            lite.guest_chat,
            guest_chat_opt_in.unwrap_or(lite.guest_chat),
        )
        .change(
            "guest_voice",
            on_word(lite.guest_voice),
            on_word(guest_voice.unwrap_or(lite.guest_voice)),
        )
        .change(
            "members_visible",
            lite.members_visible,
            members_visible.unwrap_or(lite.members_visible),
        )
        .change(
            "hide_members",
            lite.hide_members,
            hide_members.unwrap_or(lite.hide_members),
        )
        .change("listed", lite.listed, list.unwrap_or(lite.listed))
        .change(
            "profiles_mode",
            lite.profiles_mode.as_str(),
            profiles_mode.unwrap_or(lite.profiles_mode).as_str(),
        )
        .change(
            "description",
            lite.description.clone(),
            description.clone().unwrap_or(lite.description.clone()),
        )
        .change(
            "icon_kind",
            lite.icon_kind.as_str(),
            icon_kind.unwrap_or(lite.icon_kind).as_str(),
        );
    if changed.has_changes() {
        let changed = match passwords_revoked && password_hash.is_none() {
            true => changed.set("passwords_revoked", true),
            false => changed,
        };
        audit::record(
            &mut tx,
            audit::Entry::new(&new_key, &actor, audit::Action::ServerUpdate)
                .target(audit::Target::server(&display))
                .details(changed),
        )
        .await?;
    }
    if password_hash.is_some() || join_mode != lite.join_mode {
        let hash = match &password_hash {
            Some(hash) => hash.clone(),
            None => lite.has_password.then(|| NO_PERMANENT_HASH.to_string()),
        };
        let permanent = match &password_hash {
            Some(hash) => hash.as_deref().is_some_and(|h| h != NO_PERMANENT_HASH),
            None => lite.join_mode == JoinMode::Password,
        };
        let had_permanent = match password_hash {
            Some(_) => had_permanent,
            None => permanent,
        };
        let details = audit::Details::new()
            .change("join_mode", lite.join_mode.as_str(), join_mode.as_str())
            .change("protected", lite.has_password, hash.is_some())
            .set(
                "permanent_password",
                match (had_permanent, permanent) {
                    (false, true) => "set",
                    (true, true) => "changed",
                    (true, false) => "removed",
                    (false, false) => "none",
                },
            )
            .set("members_removed", removed.len())
            .set("guests_revoked", guests_revoked)
            .set("passwords_revoked", passwords_revoked);
        audit::record(
            &mut tx,
            audit::Entry::new(&new_key, &actor, audit::Action::AccessMode)
                .target(audit::Target::server(&display))
                .details(details),
        )
        .await?;
    }
    let storage = match seal {
        Some(on) => {
            let sqlite = crate::db::is_sqlite(&state.db);
            let author = match &actor {
                audit::Actor::User(name) => name.as_str(),
                audit::Actor::Staff => "",
            };
            crate::api::seal::set_server(&mut tx, sqlite, &new_key, author, on).await?
        }
        None => crate::api::seal::Switched::Same,
    };
    tx.commit().await?;
    if let crate::api::seal::Switched::Changed(notice) = storage {
        crate::api::seal::forget_site(&state.db);
        announce_system(&state, &new_key, notice).await;
    }
    let reading = password_hash.is_some() || public_read.is_some();
    if new_key != key || (reading && listed.default_servers.contains(&key)) {
        let settings = crate::api::PublicSettings::load(&state.db).await;
        if settings.guest_servers != listed.guest_servers {
            state.hub.broadcast(WsEvent::SettingsChanged { settings });
        }
    }
    let renamed = new_key != key || display != lite.display_name;
    let server = resolve_server(&state.db, &new_key, Some(&user), &Proof::none())
        .await?
        .lite()
        .clone();
    state.hub.broadcast(match renamed {
        true => WsEvent::ServerRenamed {
            old_name: key,
            server: server.clone(),
        },
        false => WsEvent::ServerUpdated {
            server: server.clone(),
        },
    });
    crate::ws::announce_purge(&state.hub, &server.name, &removed);
    if password_hash.is_some() || public_read.is_some() || closing {
        voice_rules_changed(&state, &server.name, None).await;
    }
    if guest_voice == Some(false) {
        crate::ws::guests_out_of_voice(&state.hub, &server.name);
    }
    Ok(Json(ServerUpdated {
        server,
        removed: removed.len() as i64,
        kept,
    }))
}

/// What an update does to a server's `password_hash`.
#[derive(Clone, Copy)]
enum HashChange<'a> {
    Keep,
    /// No password: anyone joins by name.
    Clear,
    /// Protected without a permanent password.
    NoPermanent,
    /// This new permanent password.
    Set(&'a str),
}

/// The refusal of `public_read: true` while the instance has public reading off.
pub const PUBLIC_READING_OFF: &str = "Public reading is turned off on this site";

/// A server's on or off option as the audit log words it.
fn on_word(on: bool) -> &'static str {
    match on {
        true => "on",
        false => "off",
    }
}

/// A server's `public_read` option as the audit log words it.
fn reading_word(option: Option<bool>) -> &'static str {
    match option {
        None => "default",
        Some(true) => "on",
        Some(false) => "off",
    }
}

fn server_color(
    color: Option<Option<String>>,
    what: &str,
) -> Result<Option<Option<String>>, ApiError> {
    match color {
        None => Ok(None),
        Some(None) => Ok(Some(None)),
        Some(Some(c)) if valid_color(&c) => Ok(Some(Some(c.to_lowercase()))),
        Some(Some(_)) => Err(ApiError::invalid(format!("Invalid {what} color"), "color")),
    }
}

async fn set_colors(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    key: &str,
    banner: Option<&Option<String>>,
    name: Option<&Option<String>>,
) -> Result<(), ApiError> {
    for (sql, color) in [
        (
            "UPDATE servers SET banner_color = $1 WHERE name = $2",
            banner,
        ),
        ("UPDATE servers SET name_color = $1 WHERE name = $2", name),
    ] {
        if let Some(color) = color {
            sqlx::query(sql)
                .bind(color)
                .bind(key)
                .execute(&mut **tx)
                .await?;
        }
    }
    Ok(())
}

async fn rename_live(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    key: &str,
    new_key: &str,
    display: &str,
    password_hash: Option<&Option<String>>,
) -> Result<(), ApiError> {
    if new_key != key {
        crate::api::upload_expiry::lock_kept(tx, key).await?;
    }
    let renamed = sqlx::query(
        "UPDATE servers SET name = $1, display_name = $2 WHERE name = $3 AND COALESCE(password_hash, '') <> '!purging'",
    )
    .bind(new_key)
    .bind(display)
    .bind(key)
    .execute(&mut **tx)
    .await?
    .rows_affected();
    if renamed == 0 {
        return Err(not_found("Server not found"));
    }
    if new_key != key {
        sqlx::query("UPDATE media SET kept_by = $1 WHERE kept_by = $2")
            .bind(new_key)
            .bind(key)
            .execute(&mut **tx)
            .await?;
        sqlx::query("UPDATE seal_jobs SET place = $1 WHERE place = $2")
            .bind(format!("s:{new_key}"))
            .bind(format!("s:{key}"))
            .execute(&mut **tx)
            .await?;
    }
    if let Some(hash) = password_hash {
        sqlx::query(
            "UPDATE servers SET password_hash = $1 WHERE name = $2 AND COALESCE(password_hash, '') <> '!purging'",
        )
        .bind(hash)
        .bind(new_key)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

async fn name_free(db: &Db, key: &str) -> Result<(), ApiError> {
    let row = sqlx::query("SELECT password_hash FROM servers WHERE name = $1")
        .bind(key)
        .fetch_optional(db)
        .await?;
    match row {
        None => Ok(()),
        Some(r) => match r.try_get::<Option<String>, _>(0)?.as_deref() {
            Some(crate::db::PURGING_HASH) => Err(ApiError(
                StatusCode::CONFLICT,
                "That name is not available yet".to_string(),
                None,
            )),
            _ => Err(ApiError::conflict(
                StatusCode::BAD_REQUEST,
                "Server name is taken",
            )),
        },
    }
}

async fn other_members(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    server: &str,
    username: &str,
) -> Result<i64, ApiError> {
    Ok(
        sqlx::query("SELECT COUNT(*) FROM members WHERE server = $1 AND username <> $2")
            .bind(server)
            .bind(username)
            .fetch_one(&mut **tx)
            .await?
            .try_get(0)?,
    )
}

/// Removes the members `actor` may moderate. Also says whether that needed instance powers:
/// `own` is the site admin's permissions as a plain member.
async fn purge_members(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    server: &str,
    actor: &User,
    mine: i64,
    own: Option<i64>,
) -> Result<(Vec<String>, i64, bool), ApiError> {
    let rows = sqlx::query(
        "SELECT username, is_admin, perms FROM members WHERE server = $1 AND username <> $2",
    )
    .bind(server)
    .bind(&actor.username)
    .fetch_all(&mut **tx)
    .await?;
    let role_rows = sqlx::query(
        "SELECT ur.username, r.perms FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.server = $1",
    )
    .bind(server)
    .fetch_all(&mut **tx)
    .await?;
    let mut roles: HashMap<String, i64> = HashMap::new();
    for r in &role_rows {
        *roles.entry(r.try_get(0)?).or_default() |= r.try_get::<i64, _>(1)?;
    }
    let mut removed = Vec::new();
    let mut kept = 0;
    let mut bypassed = own.is_some_and(|o| o & Perm::Kick as i64 == 0);
    let guard = ranks::guard_in(&mut **tx, server).await?;
    let mut names = Vec::with_capacity(rows.len());
    for r in &rows {
        names.push(r.try_get::<String, _>(0)?);
    }
    let placed = ranks::ranks_in(tx, server, &names).await?;
    let member = ranks::rank_in(tx, server, &actor.username).await?;
    let me = Actor {
        rank: match actor.is_site_admin {
            true => Rank::of(Tier::Staff),
            false => member,
        },
        bits: mine as Mask,
    };
    let plain = own.map(|bits| Actor {
        rank: member,
        bits: bits as Mask,
    });
    for (r, username) in rows.iter().zip(names) {
        let them = Actor {
            rank: placed
                .get(&username)
                .copied()
                .unwrap_or(Rank::of(Tier::Outside)),
            bits: perm_bits(
                r.try_get::<i64, _>(1)? != 0,
                r.try_get(2)?,
                roles.get(&username).copied().unwrap_or(0),
            ) as Mask,
        };
        match hier::may_moderate(&me, &them, 0, guard) {
            true => {
                bypassed |= plain
                    .as_ref()
                    .is_some_and(|p| !hier::may_moderate(p, &them, 0, guard));
                removed.push(username);
            }
            false => kept += 1,
        }
    }
    let mut gone = 0;
    for chunk in removed.chunks(500) {
        for table in ["members", "user_roles", "sso_grants"] {
            let sql = format!(
                "DELETE FROM {table} WHERE server = $1 AND username IN ({})",
                placeholders(2, chunk.len())
            );
            let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(server);
            for name in chunk {
                query = query.bind(name);
            }
            let n = query.execute(&mut **tx).await?.rows_affected();
            if table == "members" {
                gone += n as i64;
            }
        }
    }
    shift_member_count(tx, server, -gone).await?;
    Ok((removed, kept, bypassed))
}

/// Delete a server
///
/// Deletes the server. Members, bans, role assignments and guest grants go at once and the server
/// disappears from the API; its channels, messages and roles are purged in the background, and
/// until that finishes its name can't be reused (409 on create). Requires the Delete server
/// permission; the rchat server can't be deleted. Emits `server_deleted` to the server. General
/// rate-limit bucket.
/// Deleting a server is a rare request: at most `RARE_REQUESTS_PER_HOUR` (20) an hour and
/// `RARE_REQUESTS_PER_DAY` (100) a day per account by default.
#[utoipa::path(
    delete,
    path = "/api/v1/servers/{name}",
    tag = "Servers",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    responses(
        (status = 200, description = "Server deleted along with its channels, members, and roles", body = OkResp),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Delete server permission, or the server is the protected rchat server", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses)", body = ApiErrorBody),
        (status = 429, description = "`You've done this too often. Try again later.` (JSON, with `Retry-After`): past the rare requests of this kind. Too many requests in the general bucket", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn delete_server(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
) -> Result<Json<OkResp>, ApiError> {
    let key = name.to_lowercase();
    guard_rchat(&state.db, &key).await?;
    let access = resolve_server(&state.db, &key, Some(&user), &Proof::none()).await?;
    access.require_perm(&state.db, Perm::DeleteServer).await?;
    rare::take(&state, Rare::DeletedServer, Some(&user))?;
    match crate::api::admin::remove_server(&state, access.name()).await? {
        true => Ok(ok()),
        false => Err(crate::api::access::denied()),
    }
}

/// Create a channel
///
/// Adds a text or voice channel to the server, with slow mode off, at the end of its category
/// (or of the channels without one). A server can have at most 500 channels by default
/// (`SERVER_CHANNELS_MAX`). Requires the Manage channels permission. Raises the layout version, then emits `channel_created` and
/// `layout_changed` to the server; only connections that can view the new channel get either.
/// General rate-limit bucket.
#[utoipa::path(
    post,
    path = "/api/v1/servers/{name}/channels",
    tag = "Channels",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    request_body = CreateChannelReq,
    responses(
        (status = 200, description = "The created channel", body = Channel),
        (status = 400, description = "Invalid channel name (blank, longer than 100 characters or blocked by the profanity filter), the name is taken in this server, or `A server can have at most 500 channels` with the configured number (`SERVER_CHANNELS_MAX`, reason `limit`). Malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Manage channels permission", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses). `Category not found`: `category_id` is not a category of this server", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn create_channel(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Json(req): Json<CreateChannelReq>,
) -> Result<Json<Channel>, ApiError> {
    let key = name.to_lowercase();
    let channel_name = req.name.trim().to_string();
    let kind = req.kind.unwrap_or(ChannelKind::Text);
    check_name(
        &state.db,
        ProfanityTarget::ChannelNames,
        "Channel name",
        &channel_name,
    )
    .await?;
    let access = resolve_server(&state.db, &key, Some(&user), &Proof::none()).await?;
    access.require_perm(&state.db, Perm::ManageChannels).await?;
    if kind == ChannelKind::Voice && req.text_only {
        return Err(ApiError::invalid(
            "Text only applies to text channels",
            "text_only",
        ));
    }
    let key = access.name().to_string();
    if let Some(category) = req.category_id
        && !req.restrict_view
    {
        category_perms::check_copy(&state.db, &access, category).await?;
    }
    let actor = access.audit_actor(&state.db, Perm::ManageChannels).await?;
    let mut tx = state.db.begin().await?;
    bump(&mut tx, &key, None).await?;
    let taken = sqlx::query("SELECT 1 FROM channels WHERE server = $1 AND name = $2")
        .bind(&key)
        .bind(&channel_name)
        .fetch_optional(&mut *tx)
        .await?
        .is_some();
    if taken {
        return Err(ApiError::conflict(
            StatusCode::BAD_REQUEST,
            "Channel name is taken",
        ));
    }
    let count: i64 = sqlx::query("SELECT COUNT(*) FROM channels WHERE server = $1")
        .bind(&key)
        .fetch_one(&mut *tx)
        .await?
        .try_get(0)?;
    let most = state.limits.server_channels_max;
    if count >= most {
        return Err(ApiError::limit(
            StatusCode::BAD_REQUEST,
            format!("A server can have at most {most} channels"),
            &rchat_settings::items::SERVER_CHANNELS_MAX,
        ));
    }
    let sql = match req.category_id {
        Some(_) => format!(
            "INSERT INTO channels(server, name, kind, created_at, restrict_view, category_id, text_only, position) SELECT $1, $2, $3, $4, $5, $6, $7, {NEXT_POSITION} WHERE EXISTS(SELECT 1 FROM channel_categories WHERE id = $6 AND server = $1) RETURNING id"
        ),
        None => format!(
            "INSERT INTO channels(server, name, kind, created_at, restrict_view, category_id, text_only, position) SELECT $1, $2, $3, $4, $5, $6, $7, {NEXT_POSITION} RETURNING id"
        ),
    };
    let Some(row) = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(&key)
        .bind(&channel_name)
        .bind(kind.as_str())
        .bind(state.clock.unix())
        .bind(i64::from(req.restrict_view))
        .bind(req.category_id)
        .bind(i64::from(req.text_only))
        .fetch_optional(&mut *tx)
        .await?
    else {
        return Err(not_found("Category not found"));
    };
    let id: i64 = row.try_get(0)?;
    let (synced, ruled) = match req.category_id {
        Some(category) if !req.restrict_view => (
            true,
            category_perms::copy_category_rules(&mut tx, id, category).await?,
        ),
        _ => (false, false),
    };
    let created = ChannelRef {
        id,
        name: channel_name.clone(),
        private: req.restrict_view
            || (ruled
                && audit::channel_ref(&mut *tx, id)
                    .await?
                    .is_some_and(|c| c.private)),
    };
    audit::record(
        &mut tx,
        audit::channel_entry(&key, &actor, audit::Action::ChannelCreate, &created).details(
            Details::new()
                .channel(&created)
                .set("kind", kind.as_str())
                .set("text_only", req.text_only)
                .set("restrict_view", req.restrict_view),
        ),
    )
    .await?;
    let layout = load_layout(&mut tx, &key).await?;
    tx.commit().await?;
    let position = layout
        .as_ref()
        .map(|l| rank(&listed(l), id, |_| true))
        .unwrap_or_default();
    let channel = Channel {
        id,
        name: channel_name,
        kind,
        slowmode_seconds: 0,
        sensitive: false,
        text_only: req.text_only,
        restrict_view: req.restrict_view,
        restrict_send: false,
        topic: None,
        category_id: req.category_id,
        position,
        perm_sync: synced,
        my_perms: None,
    };
    state.hub.broadcast(WsEvent::ChannelCreated {
        server: key.clone(),
        channel: channel.clone(),
    });
    if ruled {
        state.hub.broadcast(WsEvent::ChannelPermsChanged {
            server: key.clone(),
            channel_id: id,
        });
    }
    if let Some(layout) = layout {
        announce(&state, &key, layout, Some(id), None);
    }
    Ok(Json(channel))
}

/// Update a channel
///
/// Renames a channel, sets its slow mode, its topic and/or its restrictions; omitted fields
/// are left unchanged. Text and voice channels can both have a topic. Slow mode is 0 to 21600 seconds and only text channels may have it. With
/// `restrict_view` or `restrict_send` on, only roles and members with a matching channel rule
/// (`can_view` / `can_send`) can see or send; people who manage channels always can, so with no
/// rules only they can. Requires the Manage channels permission in the channel's server. When a
/// restriction changed, emits `channel_perms_changed` to the server first and removes users from
/// the channel's voice room if they can no longer view it. Then emits `channel_renamed` with the
/// updated channel when the name changed, otherwise `channel_updated`. General rate-limit bucket.
#[utoipa::path(
    patch,
    path = "/api/v1/channels/{id}",
    tag = "Channels",
    params(("id" = i64, Path, description = "Channel id")),
    request_body = ChannelPatch,
    responses(
        (status = 200, description = "The updated channel", body = Channel),
        (status = 400, description = "Slow mode out of range or set on a voice channel, `restrict_send` turned on for a voice channel, an invalid channel name (blank, longer than 100 characters or blocked by the profanity filter), a topic over 1024 characters or blocked by the profanity filter, or the name is taken in this server. A non-integer `id`, malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Manage channels permission", body = ApiErrorBody),
        (status = 404, description = "`Not found`: no such channel, a channel you cannot see, or one in a password-protected server you have no access to (identical responses)", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn update_channel(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(id): Path<i64>,
    Json(req): Json<ChannelPatch>,
) -> Result<Json<Channel>, ApiError> {
    let ChannelPatch {
        name,
        slowmode_seconds,
        restrict_view,
        restrict_send,
        sensitive,
        text_only,
        topic,
    } = req;
    let channel = resolve_channel(&state.db, id, Some(&user), &Proof::none()).await?;
    channel
        .server()
        .require_perm(&state.db, Perm::ManageChannels)
        .await?;
    let (server, kind, old_name) = (
        channel.server().name().to_string(),
        channel.kind(),
        channel.name().to_string(),
    );
    if let Some(secs) = slowmode_seconds {
        if !(0..=SLOWMODE_MAX).contains(&secs) {
            return Err(ApiError::invalid(
                format!("Slow mode must be between 0 and {SLOWMODE_MAX} seconds"),
                "slowmode_seconds",
            ));
        }
        if kind == ChannelKind::Voice && secs != 0 {
            return Err(ApiError::invalid(
                "Slow mode only applies to text channels",
                "slowmode_seconds",
            ));
        }
    }
    if kind == ChannelKind::Voice && text_only == Some(true) {
        return Err(ApiError::invalid(
            "Text only applies to text channels",
            "text_only",
        ));
    }
    if kind == ChannelKind::Voice && restrict_send == Some(true) {
        return Err(ApiError::invalid(
            "Require roles to send only applies to text channels",
            "restrict_send",
        ));
    }
    let channel_name = match &name {
        Some(name) => {
            let channel_name = name.trim().to_string();
            check_name(
                &state.db,
                ProfanityTarget::ChannelNames,
                "Channel name",
                &channel_name,
            )
            .await?;
            Some(channel_name)
        }
        None => None,
    };
    let topic = match topic {
        Some(text) => {
            let text = clean_multiline(text.as_deref().unwrap_or(""), TOPIC_MAX, "Topic")?;
            if let Some(text) = &text {
                check_profanity(&state.db, ProfanityTarget::ChannelTopics, text).await?;
            }
            Some(text)
        }
        None => None,
    };
    let actor = channel
        .server()
        .audit_actor(&state.db, Perm::ManageChannels)
        .await?;
    let mut tx = state.db.begin().await?;
    let old = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT c.name, c.topic, c.slowmode_seconds, c.restrict_view, c.restrict_send, CASE WHEN {} THEN 1 ELSE 0 END, c.sensitive, c.text_only FROM channels c WHERE c.id = $1",
        private_sql()
    )))
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(crate::api::access::not_found)?;
    let before = Restrict::read(&old, 3)?;
    let (was_name, was_topic, was_slow): (String, Option<String>, i64) =
        (old.try_get(0)?, old.try_get(1)?, old.try_get(2)?);
    let was_private = old.try_get::<i64, _>(5)? != 0;
    let was_text_only = old.try_get::<i64, _>(7)? != 0;
    let was_sensitive = old.try_get::<i64, _>(6)? != 0;
    if let Some(channel_name) = &channel_name {
        let taken =
            sqlx::query("SELECT 1 FROM channels WHERE server = $1 AND name = $2 AND id != $3")
                .bind(&server)
                .bind(channel_name)
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?
                .is_some();
        if taken {
            return Err(ApiError::conflict(
                StatusCode::BAD_REQUEST,
                "Channel name is taken",
            ));
        }
        sqlx::query("UPDATE channels SET name = $1 WHERE id = $2")
            .bind(channel_name)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(text) = &topic {
        sqlx::query("UPDATE channels SET topic = $1 WHERE id = $2")
            .bind(text)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(secs) = slowmode_seconds {
        sqlx::query("UPDATE channels SET slowmode_seconds = $1 WHERE id = $2")
            .bind(secs)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    for (column, value) in [
        ("sensitive", sensitive),
        ("text_only", text_only),
        ("restrict_view", restrict_view),
        ("restrict_send", restrict_send),
    ] {
        if let Some(on) = value {
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "UPDATE channels SET {column} = $1 WHERE id = $2"
            )))
            .bind(i64::from(on))
            .bind(id)
            .execute(&mut *tx)
            .await?;
        }
    }
    let changes = Details::new()
        .change(
            "text_only",
            was_text_only,
            text_only.unwrap_or(was_text_only),
        )
        .change(
            "name",
            was_name.as_str(),
            channel_name.as_deref().unwrap_or(&was_name),
        )
        .change(
            "sensitive",
            was_sensitive,
            sensitive.unwrap_or(was_sensitive),
        )
        .change(
            "topic",
            was_topic.clone(),
            topic.clone().unwrap_or(was_topic.clone()),
        )
        .change(
            "slowmode_seconds",
            was_slow,
            slowmode_seconds.unwrap_or(was_slow),
        )
        .change(
            "restrict_view",
            before.view,
            restrict_view.unwrap_or(before.view),
        )
        .change(
            "restrict_send",
            before.send,
            restrict_send.unwrap_or(before.send),
        );
    if changes.has_changes() {
        let at = ChannelRef {
            id,
            name: channel_name.clone().unwrap_or(was_name.clone()),
            private: was_private || restrict_view == Some(true),
        };
        audit::record(
            &mut tx,
            audit::channel_entry(&server, &actor, audit::Action::ChannelUpdate, &at)
                .details(changes.channel(&at)),
        )
        .await?;
    }
    tx.commit().await?;
    let row = sqlx::query(
        "SELECT id, name, kind, slowmode_seconds, restrict_view, restrict_send, topic, category_id, position, sensitive, text_only, perm_sync FROM channels WHERE id = $1",
    )
    .bind(id)
    .fetch_one(&state.db)
    .await?;
    let mut channel = channel_row(&row)?;
    channel.position = rank(&channel_order(&state.db, &server).await?, id, |_| true);
    let restrict = Restrict {
        view: channel.restrict_view,
        send: channel.restrict_send,
    };
    if restrict != before {
        state.hub.broadcast(WsEvent::ChannelPermsChanged {
            server: server.clone(),
            channel_id: id,
        });
        voice_rules_changed(&state, &server, Some(id)).await;
    }
    state.hub.broadcast(match channel.name == old_name {
        true => WsEvent::ChannelUpdated {
            server,
            channel: channel.clone(),
        },
        false => WsEvent::ChannelRenamed {
            server,
            channel: channel.clone(),
        },
    });
    Ok(Json(channel))
}

/// Delete a channel
///
/// Deletes a channel. A server always keeps at least one channel and at least one text channel.
/// When it was the channel for join and leave messages, they go to the default channel again.
/// Requires the Manage channels permission in the channel's server. Raises the layout version,
/// then emits `channel_deleted` and `layout_changed` to the server; only connections that could
/// view the channel get either. General rate-limit bucket.
#[utoipa::path(
    delete,
    path = "/api/v1/channels/{id}",
    tag = "Channels",
    params(("id" = i64, Path, description = "Channel id")),
    responses(
        (status = 200, description = "Channel deleted", body = OkResp),
        (status = 400, description = "It is the server's only channel or only text channel. A non-integer `id` gives a plain-text 400", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Manage channels permission", body = ApiErrorBody),
        (status = 404, description = "`Not found`: no such channel, a channel you cannot see, or one in a password-protected server you have no access to (identical responses)", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn delete_channel(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(id): Path<i64>,
) -> Result<Json<OkResp>, ApiError> {
    let channel = resolve_channel(&state.db, id, Some(&user), &Proof::none()).await?;
    channel
        .server()
        .require_perm(&state.db, Perm::ManageChannels)
        .await?;
    let (server, kind) = (channel.server().name().to_string(), channel.kind());
    let count: i64 = sqlx::query("SELECT COUNT(*) FROM channels WHERE server = $1")
        .bind(&server)
        .fetch_one(&state.db)
        .await?
        .try_get(0)?;
    if count <= 1 {
        return Err(ApiError::conflict(
            StatusCode::BAD_REQUEST,
            "Cannot delete the only channel",
        ));
    }
    if kind == ChannelKind::Text {
        let text_count: i64 =
            sqlx::query("SELECT COUNT(*) FROM channels WHERE server = $1 AND kind = 'text'")
                .bind(&server)
                .fetch_one(&state.db)
                .await?
                .try_get(0)?;
        if text_count <= 1 {
            return Err(ApiError::conflict(
                StatusCode::BAD_REQUEST,
                "Cannot delete the only text channel",
            ));
        }
    }
    let rules = channel.view_rules(&state.db).await?;
    let actor = channel
        .server()
        .audit_actor(&state.db, Perm::ManageChannels)
        .await?;
    let gone = audit::channel_ref(&state.db, id)
        .await?
        .ok_or_else(crate::api::access::not_found)?;
    let mut tx = state.db.begin().await?;
    bump(&mut tx, &server, None).await?;
    audit::record(
        &mut tx,
        audit::channel_entry(&server, &actor, audit::Action::ChannelDelete, &gone)
            .details(Details::new().channel(&gone).set("kind", kind.as_str())),
    )
    .await?;
    sqlx::query("UPDATE servers SET system_channel_id = NULL WHERE system_channel_id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM channels WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let layout = load_layout(&mut tx, &server).await?;
    if let Some(layout) = &layout {
        write_layout(&mut tx, &server, layout).await?;
    }
    tx.commit().await?;
    state.hub.broadcast(WsEvent::ChannelDeleted {
        server: server.clone(),
        channel_id: id,
        rules: Some(rules.clone()),
    });
    if let Some(layout) = layout {
        state.hub.broadcast(WsEvent::LayoutChanged {
            server,
            layout: layout.into(),
            created: None,
            deleted: Some(rules),
            before: None,
            after: None,
        });
    }
    Ok(ok())
}

/// Kick a member
///
/// Removes `username` from the server and drops their role assignments. Requires the Kick server
/// permission, and you must rank above the target, or while the role order is unconfirmed their
/// server permissions must be a strict subset of yours (see
/// `ServerDetail.roles_order_confirmed`). So you can't kick yourself or someone at your own
/// rank. Kicked users may rejoin. Posts a `leave`
/// system message like leaving does (no reason shown). Emits `member_kicked` (with
/// `banned: false`) to the server and the kicked user, who goes offline in the server. General
/// rate-limit bucket.
#[utoipa::path(
    post,
    path = "/api/v1/servers/{name}/kick",
    tag = "Moderation",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    request_body = UsernameReq,
    responses(
        (status = 200, description = "Member removed from the server and their roles dropped", body = OkResp),
        (status = 400, description = "Malformed JSON or a missing `Content-Type` give a plain-text 400 or 415 (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Kick permission, or you do not rank above the member (`You can't moderate this member`)", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses); or the user is not a member", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn kick_member(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Json(req): Json<UsernameReq>,
) -> Result<Json<OkResp>, ApiError> {
    let target = req.username.to_lowercase();
    let user = acting_on(&user, &target);
    let access = resolve_server(&state.db, &name, Some(&user), &Proof::none()).await?;
    let granted = access.grant::<grants::Kick>(&state.db).await?;
    let kick = granted.moderate(&state.db, &target).await?;
    let (key, target) = (kick.server().to_string(), kick.target().to_string());
    let mut tx = state.db.begin().await?;
    lock_server(&mut tx, &key).await?;
    let ended = end_membership(&mut tx, &key, &target).await?;
    if ended.is_some() {
        audit::record(
            &mut tx,
            Entry::new(&key, kick.actor(), audit::Action::MemberKick).target(Target::user(&target)),
        )
        .await?;
    }
    tx.commit().await?;
    match ended {
        None => Err(not_found("Not a member")),
        Some(Ended { notice }) => {
            announce_system(&state, &key, notice).await;
            announce_kick(&state.hub, &key, &target, false);
            Ok(ok())
        }
    }
}

/// Ban a user
///
/// Bans `username` from the server: they are removed with their roles dropped, taken out of the
/// server's voice channels, and blocked from rejoining until unbanned. Works on non-members too.
/// `duration_secs` (60 seconds to two years) ends the ban by itself; without it the ban holds
/// until someone lifts it. `reason` (at most 300 characters) is kept with the ban and in the
/// audit log. `purge_hours` (0 to 168) also deletes the messages the user sent in that many
/// hours before now, in the background: one bulk delete job of yours per channel and thread,
/// only where you may delete that user's messages. `purge_skipped` and `purge_busy` count the
/// places left alone.
/// Banning someone already banned replaces the ban's end and reason. Requires the Kick server
/// permission, and you must rank above the target as for a kick. Banning a
/// member posts a `leave` system message like leaving does (no reason shown). Emits
/// `member_kicked` (with `banned: true`) to the server and the user when they were a member,
/// otherwise `server_banned` to the user. A name with no account is banned like an account that
/// is not a member (the same answer), so it applies if the name is ever taken. A ban of someone
/// who is not a member, with or without an account, counts as a miss (`LOOKUP_MISSES_PER_HOUR`,
/// as for `GET /api/v1/users/{username}/card`); past the misses such bans are refused until the
/// hour ends. General rate-limit bucket.
#[utoipa::path(
    post,
    path = "/api/v1/servers/{name}/bans",
    tag = "Moderation",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    request_body = BanReq,
    responses(
        (status = 200, description = "User banned", body = BanResp),
        (status = 400, description = "You can't ban yourself, `duration_secs` outside 60 to 63072000, `purge_hours` outside 0 to 168, a reason over 300 characters, or `Invalid username` (reason `invalid`, field `username`) for a name no account could have (blank, longer than 100 characters, or with `@`). Malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Kick permission, or you do not rank above the user (`You can't moderate this member`)", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses)", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "`Too many bans of people outside this server. Try again later.` with a `Retry-After` header (JSON, reason `rate`): a ban of someone who is not a member after the caller's misses for the hour (`LOOKUP_MISSES_PER_HOUR`). Or too many requests in the general bucket", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn ban_member(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Json(req): Json<BanReq>,
) -> Result<Json<BanResp>, ApiError> {
    let BanReq {
        username,
        duration_secs,
        reason,
        purge_hours,
    } = req;
    let target = username.to_lowercase();
    let access = resolve_server(&state.db, &name, Some(&user), &Proof::none()).await?;
    let granted = access.grant::<grants::Kick>(&state.db).await?;
    if target == user.username {
        return Err(ApiError::invalid("You can't ban yourself", "username"));
    }
    if !crate::api::names::could_be_username(&target) {
        return Err(ApiError::invalid("Invalid username", "username"));
    }
    let t = state.clock.unix();
    let BanOptions {
        expires_at,
        reason,
        purge_hours,
    } = bans::options(duration_secs, reason, purge_hours, t)?;
    let held = match access.member_in(&state.db, &target).await? {
        true => None,
        false => Some(lookup::outside_ban(&state, &user)?),
    };
    let ban = granted.moderate(&state.db, &target).await?;
    let (key, target, actor) = (ban.server().to_string(), ban.target(), ban.actor());
    let mut tx = state.db.begin().await?;
    lock_server(&mut tx, &key).await?;
    let before = sqlx::query(
        "SELECT expires_at, reason FROM server_bans WHERE server = $1 AND username = $2 AND (expires_at IS NULL OR expires_at > $3)",
    )
    .bind(&key)
    .bind(target)
    .bind(t)
    .fetch_optional(&mut *tx)
    .await?
    .map(|r| Ok::<_, sqlx::Error>((r.try_get::<Option<i64>, _>(0)?, r.try_get::<Option<String>, _>(1)?)))
    .transpose()?;
    let changed = before.as_ref() != Some(&(expires_at, reason.clone()));
    if changed {
        sqlx::query(
            "INSERT INTO server_bans(server, username, banned_by, created_at, expires_at, reason) VALUES($1, $2, $3, $4, $5, $6) ON CONFLICT(server, username) DO UPDATE SET banned_by = excluded.banned_by, created_at = excluded.created_at, expires_at = excluded.expires_at, reason = excluded.reason",
        )
        .bind(&key)
        .bind(target)
        .bind(&user.username)
        .bind(t)
        .bind(expires_at)
        .bind(reason.as_deref())
        .execute(&mut *tx)
        .await?;
    }
    let ended = end_membership(&mut tx, &key, target).await?;
    if changed || ended.is_some() {
        audit::record(
            &mut tx,
            Entry::new(&key, actor, audit::Action::MemberBan)
                .target(Target::user(target))
                .details(
                    Details::new()
                        .set("was_member", ended.is_some())
                        .set("expires_at", expires_at)
                        .set("reason", reason.clone())
                        .set("purge_hours", purge_hours),
                ),
        )
        .await?;
    }
    tx.commit().await?;
    match ended {
        None => state.hub.broadcast(WsEvent::ServerBanned {
            server: key.clone(),
            username: target.to_string(),
        }),
        Some(Ended { notice }) => {
            announce_system(&state, &key, notice).await;
            announce_kick(&state.hub, &key, target, true);
        }
    }
    for (cid, users) in state.hub.rooms_in(&key, None) {
        if users.iter().any(|u| u == target) {
            state.hub.evict_voice(target, cid);
        }
    }
    if let Some(held) = held {
        held.spend();
    }
    let purge = match purge_hours {
        0 => bans::Purge::default(),
        hours => bans::enqueue_purge(&state.db, &user, &key, target, t - hours * 3600).await?,
    };
    let bans::Purge {
        jobs,
        skipped: purge_skipped,
        busy: purge_busy,
    } = purge;
    let purge_places = jobs.len() as i64;
    bans::spawn_purge(&state, jobs);
    let still = match changed {
        true => expires_at,
        false => before.and_then(|(until, _)| until),
    };
    Ok(Json(BanResp {
        ok: true,
        expires_at: still,
        purge_places,
        purge_skipped,
        purge_busy,
    }))
}

/// Unban a user
///
/// Lifts a ban so the user may join again. Requires the Kick server permission. Emits no
/// WebSocket event. General rate-limit bucket.
#[utoipa::path(
    delete,
    path = "/api/v1/servers/{name}/bans/{username}",
    tag = "Moderation",
    params(("name" = String, Path, description = "Server name, case-insensitive"), ("username" = String, Path, description = "Target username, case-insensitive")),
    responses(
        (status = 200, description = "Ban lifted; the user may join again", body = OkResp),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Kick permission", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses); or the user is not banned", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn unban_member(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path((name, target)): Path<(String, String)>,
) -> Result<Json<OkResp>, ApiError> {
    let target = target.to_lowercase();
    let user = acting_on(&user, &target);
    let access = resolve_server(&state.db, &name, Some(&user), &Proof::none()).await?;
    access.require_perm(&state.db, Perm::Kick).await?;
    let actor = access.audit_actor(&state.db, Perm::Kick).await?;
    let mut tx = state.db.begin().await?;
    lock_server(&mut tx, access.name()).await?;
    let removed = sqlx::query("DELETE FROM server_bans WHERE server = $1 AND username = $2")
        .bind(access.name())
        .bind(&target)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if removed == 0 {
        return Err(not_found("Not banned"));
    }
    audit::record(
        &mut tx,
        Entry::new(access.name(), &actor, audit::Action::MemberUnban).target(Target::user(&target)),
    )
    .await?;
    tx.commit().await?;
    Ok(ok())
}

/// List bans
///
/// Returns the users banned from the server, most recently banned first, as pages of `limit`
/// (default and max 50). Page with `cursor` from the `X-Next-Cursor` response header (or the
/// legacy `offset`). Requires the Kick server permission. General rate-limit bucket.
#[utoipa::path(
    get,
    path = "/api/v1/servers/{name}/bans",
    tag = "Moderation",
    params(("name" = String, Path, description = "Server name, case-insensitive"), MembersQuery),
    responses(
        (status = 200, description = "A page of banned users, most recently banned first", body = Vec<ServerBan>, headers(("x-next-cursor" = String, description = "Cursor for the next page; absent on the last page"))),
        (status = 400, description = "Invalid cursor (JSON), or a non-integer `offset` or `limit` (plain-text framework error)", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Kick permission", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses)", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn list_bans(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Query(q): Query<MembersQuery>,
) -> Result<Paged<ServerBan>, ApiError> {
    let db = &state.read();
    let access = resolve_server(db, &name, Some(&user), &Proof::none()).await?;
    access.require_perm(db, Perm::Kick).await?;
    let key = access.name();
    let MembersQuery {
        offset,
        limit,
        cursor,
    } = q;
    let t = state.clock.unix();
    let limit = limit.unwrap_or(50).clamp(1, 50);
    let rows = match pair_cursor(cursor.as_deref())? {
        Some((at, name)) => {
            sqlx::query("SELECT username, created_at, expires_at, reason FROM server_bans WHERE server = $1 AND (expires_at IS NULL OR expires_at > $2) AND (created_at, username) < ($3, $4) ORDER BY created_at DESC, username DESC LIMIT $5")
                .bind(key)
                .bind(t)
                .bind(at)
                .bind(name)
                .bind(limit + 1)
                .fetch_all(db)
                .await?
        }
        None => {
            sqlx::query("SELECT username, created_at, expires_at, reason FROM server_bans WHERE server = $1 AND (expires_at IS NULL OR expires_at > $2) ORDER BY created_at DESC, username DESC LIMIT $3 OFFSET $4")
                .bind(key)
                .bind(t)
                .bind(limit + 1)
                .bind(offset.unwrap_or(0).max(0))
                .fetch_all(db)
                .await?
        }
    };
    let mut bans = Vec::with_capacity(rows.len());
    for r in &rows {
        bans.push((
            r.try_get::<String, _>(0)?,
            r.try_get::<i64, _>(1)?,
            r.try_get::<Option<i64>, _>(2)?,
            r.try_get::<Option<String>, _>(3)?,
        ));
    }
    let more = bans.len() as i64 > limit;
    bans.truncate(limit as usize);
    let last = bans.last().map(|(name, at, _, _)| (name.clone(), *at));
    let next = pair_next(more, last.as_ref());
    let names: Vec<String> = bans.iter().map(|(name, ..)| name.clone()).collect();
    let refs = user_refs(db, &names).await;
    Ok(Paged(
        bans.into_iter()
            .map(|(username, banned_at, expires_at, reason)| ServerBan {
                user: user_from(&refs, &username),
                banned_at,
                expires_at,
                reason,
            })
            .collect(),
        next,
    ))
}

async fn role_perms<'e, E>(ex: E, server: &str, username: &str) -> Result<i64, ApiError>
where
    E: sqlx::Executor<'e, Database = sqlx::Any>,
{
    let rows = sqlx::query("SELECT r.perms FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.server = $1 AND ur.username = $2")
        .bind(server)
        .bind(username)
        .fetch_all(ex)
        .await?;
    let mut acc = 0;
    for r in &rows {
        acc |= r.try_get::<i64, _>(0)?;
    }
    Ok(acc & ALL_PERMS)
}

const ROLE_DELETE_WIDENS: &str = "This role limits access to a channel, so deleting it would widen that access. That needs Manage channels";
const ROLE_UNASSIGN_WIDENS: &str = "This role limits access to a channel, so removing it would widen that access. That needs Manage channels";
const REVOKE_RAISES: &str = "They hold roles with permissions you don't have, so revoking their admin would give them those";

async fn require_revoke(db: &Db, access: &ServerAccess, target: &str) -> Result<(), ApiError> {
    if access.site_admin() {
        return Ok(());
    }
    let row = sqlx::query(
        "SELECT perms FROM members WHERE server = $1 AND username = $2 AND is_admin <> 0",
    )
    .bind(access.name())
    .bind(target)
    .fetch_optional(db)
    .await?;
    if let Some(r) = row {
        let old = perm_bits(true, r.try_get(0)?, 0);
        let roles = role_perms(db, access.name(), target).await?;
        let mine = access.perms(db).await?;
        if roles & !old != 0 && !can_grant(mine, false, roles) {
            return Err(ApiError::perm(REVOKE_RAISES, "rank"));
        }
    }
    Ok(())
}

async fn set_admin(
    state: &AppState,
    actor: &User,
    server: &str,
    target: &str,
    is_admin: bool,
) -> Result<Json<OkResp>, ApiError> {
    let actor = &acting_on(actor, target);
    let access = resolve_server(&state.db, server, Some(actor), &Proof::none()).await?;
    access.require_perm(&state.db, Perm::ManageAdmins).await?;
    let server = access.name();
    let db = &state.db;
    let check = |access: ServerAccess| async move {
        match is_admin {
            true => access.require_grant(db, ALL_PERMS).await,
            false => require_revoke(db, &access, target).await,
        }
    };
    let bypassed = access.bypassed(check).await;
    match is_admin {
        true => access.require_grant(db, ALL_PERMS).await?,
        false => require_revoke(db, &access, target).await?,
    }
    let actor = access
        .audit_actor(&state.db, Perm::ManageAdmins)
        .await?
        .staff_if(bypassed);
    let mut tx = state.db.begin().await?;
    let was = access.role_in(&mut *tx, target).await?;
    let changed = sqlx::query(
        "UPDATE members SET is_admin = $1, perms = 0 WHERE server = $2 AND username = $3",
    )
    .bind(i64::from(is_admin))
    .bind(server)
    .bind(target)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if let Some((was_admin, was_perms)) = was
        && (was_admin != is_admin || (is_admin && was_perms != 0))
    {
        let action = match is_admin {
            true => audit::Action::AdminGrant,
            false => audit::Action::AdminRevoke,
        };
        audit::record(
            &mut tx,
            Entry::new(server, &actor, action).target(Target::user(target)),
        )
        .await?;
    }
    tx.commit().await?;
    match changed {
        0 => Err(not_found("Not a member")),
        _ => {
            state.hub.broadcast(WsEvent::AdminChanged {
                server: server.to_string(),
                username: target.to_string(),
                is_admin,
                perms: 0,
            });
            voice_rules_changed(state, server, None).await;
            Ok(ok())
        }
    }
}

/// Make a member an admin
///
/// Marks `username` as a server admin and resets their admin permissions to 0, which means all
/// permissions. Works on any member, including current admins (whose permissions are reset) and
/// yourself. Requires the Manage admins server permission, and because the new admin gets every
/// permission, the caller must hold every permission too. Emits `admin_changed` to the server and
/// the user. General rate-limit bucket.
#[utoipa::path(
    post,
    path = "/api/v1/servers/{name}/admins",
    tag = "Moderation",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    request_body = UsernameReq,
    responses(
        (status = 200, description = "Member promoted to admin with permissions reset to all", body = OkResp),
        (status = 400, description = "Malformed JSON or a missing `Content-Type` give a plain-text 400 or 415 (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Manage admins permission, or you don't hold every permission (`You can't grant permissions you don't have`)", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses); or the user is not a member", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn grant_admin(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Json(req): Json<UsernameReq>,
) -> Result<Json<OkResp>, ApiError> {
    set_admin(
        &state,
        &user,
        &name.to_lowercase(),
        &req.username.to_lowercase(),
        true,
    )
    .await
}

/// Revoke admin
///
/// Clears the admin flag and admin permissions of `username`; they keep the permissions of their
/// roles. Works on any member, including the creator, admins with more permissions than you and
/// members who are not admins. The one limit: an admin's roles count again once admin is
/// revoked, so if their roles have permissions their admin permissions lack, those role
/// permissions must be a subset of yours (otherwise revoking would raise them, or yourself, above
/// what you can grant). Requires the Manage admins server permission. Emits `admin_changed` to
/// the server and the user. General rate-limit bucket.
#[utoipa::path(
    delete,
    path = "/api/v1/servers/{name}/admins/{username}",
    tag = "Moderation",
    params(("name" = String, Path, description = "Server name, case-insensitive"), ("username" = String, Path, description = "Target username, case-insensitive")),
    responses(
        (status = 200, description = "Admin status and permissions revoked", body = OkResp),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Manage admins permission, or the admin's roles have permissions that neither their admin permissions nor yours include (`They hold roles with permissions you don't have, so revoking their admin would give them those`)", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses); or the user is not a member", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn revoke_admin(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path((name, target)): Path<(String, String)>,
) -> Result<Json<OkResp>, ApiError> {
    set_admin(
        &state,
        &user,
        &name.to_lowercase(),
        &target.to_lowercase(),
        false,
    )
    .await
}

/// Transfer admin
///
/// Makes `username` an admin and clears the admin flag and admin permissions of the caller, in
/// one transaction. Unlike granting admin, it keeps the stored admin permission mask of the
/// target (0, meaning all permissions, for members who are not admins). So an admin with limited
/// permissions keeps them. The final permissions of the target must be a subset of yours (equal
/// is fine). The permissions of your own roles must be too, because they count again when you
/// are no longer an admin. Requires the Manage admins permission. Emits `admin_changed` for the
/// target with their stored mask and for the caller with 0, each to the server and that user.
/// General rate-limit bucket.
#[utoipa::path(
    post,
    path = "/api/v1/servers/{name}/transfer_admin",
    tag = "Moderation",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    request_body = UsernameReq,
    responses(
        (status = 200, description = "Admin granted to the target member and revoked from the caller", body = OkResp),
        (status = 400, description = "Cannot transfer to yourself. Malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Manage admins permission; the target would get permissions you don't have (`You can't grant permissions you don't have`); or your own roles have permissions your admin permissions don't include, which you would gain by giving up admin", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses); or the user is not a member", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn transfer_admin(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Json(req): Json<UsernameReq>,
) -> Result<Json<OkResp>, ApiError> {
    let key = name.to_lowercase();
    let target = req.username.to_lowercase();
    if target == user.username {
        return Err(ApiError::invalid("Cannot transfer to yourself", "username"));
    }
    let access = resolve_server(&state.db, &key, Some(&user), &Proof::none()).await?;
    access.require_perm(&state.db, Perm::ManageAdmins).await?;
    let key = access.name().to_string();
    let mine = access.perms(&state.db).await?;
    let own = access.member_own_perms(&state.db).await?;
    let actor = access.audit_actor(&state.db, Perm::ManageAdmins).await?;
    let mut tx = state.db.begin().await?;
    let stored: i64 = match sqlx::query(
        "UPDATE members SET is_admin = 1 WHERE server = $1 AND username = $2 RETURNING perms",
    )
    .bind(&key)
    .bind(&target)
    .fetch_optional(&mut *tx)
    .await?
    {
        Some(r) => r.try_get(0)?,
        None => return Err(not_found("Not a member")),
    };
    let granted = perm_bits(true, stored, 0);
    if !can_grant(mine, user.is_site_admin, granted) {
        return Err(ApiError::perm(
            "You can't grant permissions you don't have",
            "rank",
        ));
    }
    let own_roles = role_perms(&mut *tx, &key, &user.username).await?;
    if !can_grant(mine, user.is_site_admin, own_roles) {
        return Err(ApiError::perm(
            "You hold roles with permissions your admin permissions don't include, so giving up admin would give you those",
            "rank",
        ));
    }
    let actor = actor.staff_if(
        own.is_some_and(|o| !can_grant(o, false, granted) || !can_grant(o, false, own_roles)),
    );
    let revoked = sqlx::query(
        "UPDATE members SET is_admin = 0, perms = 0 WHERE server = $1 AND username = $2 AND is_admin = 1",
    )
    .bind(&key)
    .bind(&user.username)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    let actor = match revoked {
        0 => actor,
        _ => audit::Actor::of(&user, false),
    };
    audit::record(
        &mut tx,
        Entry::new(&key, &actor, audit::Action::AdminTransfer).target(Target::user(&target)),
    )
    .await?;
    tx.commit().await?;
    state.hub.broadcast(WsEvent::AdminChanged {
        server: key.clone(),
        username: target,
        is_admin: true,
        perms: stored,
    });
    if revoked > 0 {
        state.hub.broadcast(WsEvent::AdminChanged {
            server: key.clone(),
            username: user.username,
            is_admin: false,
            perms: 0,
        });
    }
    voice_rules_changed(&state, &key, None).await;
    Ok(ok())
}

/// Set an admin's permissions
///
/// Replaces the permission bits of the admin `username` that `mask` covers and also adds set bits
/// within 1023 (bits outside 1610740735 are dropped; 0 means all permissions). Taking permissions away
/// works on any admin, like revoking admin. When the new permissions add any the admin did not
/// have, all of the new permissions must be ones you have (equal is fine), so only callers holding
/// every permission can set 0. A nonzero update must leave a supported permission. Requires the Manage admins server permission. Emits
/// `admin_changed` to the server and the user. General rate-limit bucket.
#[utoipa::path(
    patch,
    path = "/api/v1/servers/{name}/admins/{username}/perms",
    tag = "Moderation",
    params(("name" = String, Path, description = "Server name, case-insensitive"), ("username" = String, Path, description = "Target username, case-insensitive")),
    request_body = PermsReq,
    responses(
        (status = 200, description = "Admin permissions updated", body = OkResp),
        (status = 400, description = "Malformed JSON or a missing `Content-Type` give a plain-text 400 or 415 (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Manage admins permission, or the change adds permissions and the new permissions include some you don't have (`You can't grant permissions you don't have`)", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses); or the user is not an admin of it", body = ApiErrorBody),
        (status = 409, description = "Admin permissions changed during this request", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn set_admin_perms(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path((name, target)): Path<(String, String)>,
    Json(PermsReq { perms: sent, mask }): Json<PermsReq>,
) -> Result<Json<OkResp>, ApiError> {
    let target = target.to_lowercase();
    let user = acting_on(&user, &target);
    let access = resolve_server(&state.db, &name, Some(&user), &Proof::none()).await?;
    access.require_perm(&state.db, Perm::ManageAdmins).await?;
    let key = access.name().to_string();
    let mine = access.perms(&state.db).await?;
    let own = access.member_own_perms(&state.db).await?;
    let actor = access.audit_actor(&state.db, Perm::ManageAdmins).await?;
    let mut tx = state.db.begin().await?;
    let stored: i64 = match sqlx::query(
        "SELECT perms FROM members WHERE server = $1 AND username = $2 AND is_admin != 0",
    )
    .bind(&key)
    .bind(&target)
    .fetch_optional(&mut *tx)
    .await?
    {
        Some(r) => r.try_get(0)?,
        None => return Err(not_found("Not an admin")),
    };
    let old = perm_bits(true, stored, 0);
    let perms = match sent {
        0 => 0,
        _ => {
            let bits = update_bits(old, sent, mask.unwrap_or(PRE_REPORT_PERMS));
            if bits == 0 {
                return Err(ApiError::invalid(
                    "Choose a supported permission or revoke admin.",
                    "perms",
                ));
            }
            bits
        }
    };
    let new = perm_bits(true, perms, 0);
    if new & !old != 0 && !can_grant(mine, user.is_site_admin, new) {
        return Err(ApiError::perm(
            "You can't grant permissions you don't have",
            "rank",
        ));
    }
    let actor = actor.staff_if(own.is_some_and(|o| new & !old != 0 && !can_grant(o, false, new)));
    if sqlx::query("UPDATE members SET perms = $1 WHERE server = $2 AND username = $3 AND is_admin <> 0 AND perms = $4")
        .bind(perms)
        .bind(&key)
        .bind(&target)
        .bind(stored)
        .execute(&mut *tx)
        .await?.rows_affected() == 0 {
        return Err(ApiError::conflict(StatusCode::CONFLICT, "Admin permissions changed. Refresh and try again."));
    }
    if old != new {
        audit::record(
            &mut tx,
            Entry::new(&key, &actor, audit::Action::AdminPerms)
                .target(Target::user(&target))
                .details(
                    Details::new()
                        .change("perms", old, new)
                        .perms_diff(old, new),
                ),
        )
        .await?;
    }
    tx.commit().await?;
    state.hub.broadcast(WsEvent::AdminChanged {
        server: key.clone(),
        username: target,
        is_admin: true,
        perms,
    });
    voice_rules_changed(&state, &key, None).await;
    Ok(ok())
}

async fn bump_roles_version(conn: &mut AnyConnection, server: &str) -> sqlx::Result<()> {
    sqlx::query("UPDATE servers SET roles_version = roles_version + 1 WHERE name = $1")
        .bind(server)
        .execute(conn)
        .await?;
    Ok(())
}

/// Lock the authorized role version and return its other fields for the audit entry.
async fn lock_role_version(
    conn: &mut AnyConnection,
    server: &str,
    id: i64,
    authorized: i64,
    mentionable: Option<bool>,
) -> Result<(String, String, bool), ApiError> {
    let row = sqlx::query("UPDATE roles SET perms = perms WHERE server = $1 AND id = $2 AND perms = $3 AND ($4 = -1 OR mentionable = $4) RETURNING name, color, mentionable")
        .bind(server).bind(id).bind(authorized).bind(mentionable.map_or(-1,i64::from))
        .fetch_optional(conn).await?
        .ok_or_else(|| ApiError::conflict(StatusCode::CONFLICT, "Role permissions or mention settings changed. Refresh and try again."))?;
    Ok((
        row.try_get(0)?,
        row.try_get(1)?,
        row.try_get::<i64, _>(2)? != 0,
    ))
}

async fn require_role(db: &Db, server: &str, id: i64) -> Result<i64, ApiError> {
    match sqlx::query("SELECT perms FROM roles WHERE id = $1 AND server = $2")
        .bind(id)
        .bind(server)
        .fetch_optional(db)
        .await?
    {
        Some(r) => Ok(r.try_get(0)?),
        None => Err(not_found("Role not found")),
    }
}

/// Who sets or clears a channel rule for `subject`: a rule for yourself (`u:<you>`) is set with
/// your plain membership only (see `acting_on`).
fn rule_actor(user: &User, subject: &str) -> User {
    match subject.to_lowercase().strip_prefix("u:") {
        Some(target) => acting_on(user, target),
        None => user.clone(),
    }
}

async fn role_guard(
    state: &AppState,
    name: &str,
    user: &User,
    perm: Perm,
) -> Result<ServerAccess, ApiError> {
    let access = resolve_server(&state.db, name, Some(user), &Proof::none()).await?;
    access.require_perm(&state.db, perm).await?;
    Ok(access)
}

fn held_above_sql(one: bool) -> String {
    let bits = (0..i64::BITS)
        .map(|i| 1i64 << i)
        .filter(|b| ALL_PERMS & b != 0)
        .map(|b| format!("MAX(r.perms & {b})"))
        .collect::<Vec<_>>()
        .join(" | ");
    let role = match one {
        true => " AND h.role_id = $4",
        false => "",
    };
    format!(
        "SELECT DISTINCT t.role_id FROM (SELECT h.role_id AS role_id, CASE WHEN m.is_admin <> 0 THEN CASE WHEN m.perms = 0 THEN {ALL_PERMS} ELSE m.perms & {ALL_PERMS} END ELSE {bits} END AS eff FROM user_roles h JOIN members m ON m.server = h.server AND m.username = h.username JOIN user_roles ur ON ur.server = h.server AND ur.username = h.username JOIN roles r ON r.id = ur.role_id WHERE h.server = $1 AND h.username <> $2{role} GROUP BY h.role_id, h.username, m.is_admin, m.perms) t WHERE (t.eff | $3) <> $3 OR t.eff = $3"
    )
}

async fn held_above<'e, E: sqlx::Executor<'e, Database = sqlx::Any>>(
    db: E,
    access: &ServerAccess,
    mine: i64,
    role: Option<i64>,
) -> Result<HashSet<i64>, ApiError> {
    let mut out = HashSet::new();
    let Some(actor) = access.viewer().filter(|u| !u.is_site_admin) else {
        return Ok(out);
    };
    let mut query = sqlx::query(sqlx::AssertSqlSafe(held_above_sql(role.is_some())))
        .bind(access.name())
        .bind(&actor.username)
        .bind(mine);
    if let Some(id) = role {
        query = query.bind(id);
    }
    for r in &query.fetch_all(db).await? {
        out.insert(r.try_get::<i64, _>(0)?);
    }
    Ok(out)
}

#[derive(Default)]
struct ChannelLimits {
    grants: HashSet<i64>,
    denies: HashSet<i64>,
}

async fn channel_limits(
    db: &Db,
    access: &ServerAccess,
    mine: i64,
    role: Option<i64>,
) -> Result<ChannelLimits, ApiError> {
    let mut out = ChannelLimits::default();
    let Some(actor) = access.viewer() else {
        return Ok(out);
    };
    if actor.is_site_admin {
        return Ok(out);
    }
    let manager = mine & Perm::ManageChannels as i64 != 0;
    let server = access.name();
    let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT cp.channel_id, {}, c.restrict_view, c.restrict_send, c.kind FROM channel_perms cp JOIN channels c ON c.id = cp.channel_id WHERE c.server = $1",
        perm_columns("cp")
    )))
    .bind(server)
    .fetch_all(db)
    .await?;
    let only = role.map(|id| format!("r:{id}"));
    let mut channels: HashMap<i64, (Vec<PermRow>, Restrict, bool)> = HashMap::new();
    for r in &rows {
        let voice = r.try_get::<String, _>(10)? == "voice";
        channels
            .entry(r.try_get(0)?)
            .or_insert((Vec::new(), Restrict::read(r, 8)?, voice))
            .0
            .push(perm_row(r, 1)?);
    }
    let named = |rule: &PermRow| only.as_ref().is_none_or(|s| *s == rule.subject);
    if !channels
        .values()
        .any(|(rules, _, _)| rules.iter().any(named))
    {
        return Ok(out);
    }
    let standing = access.standing(db).await?;
    let everyone = access.everyone(db).await?;
    for (rules, restrict, voice) in channels.values() {
        let have = channel_mask(rules, &standing, everyone, *restrict, *voice, false);
        for rule in rules.iter().filter(|rule| named(rule)) {
            let Some(id) = rule
                .subject
                .strip_prefix("r:")
                .and_then(|id| id.parse::<i64>().ok())
            else {
                continue;
            };
            if rule.evaluated().0.allow & !have != 0 {
                out.grants.insert(id);
            }
            if !manager && rule_narrows(rule, rules, everyone, *restrict) {
                out.denies.insert(id);
            }
        }
    }
    Ok(out)
}

async fn role_limits(db: &Db, access: &ServerAccess) -> Result<RoleLimits, ApiError> {
    if access.viewer().is_none_or(|u| u.is_site_admin) {
        return Ok(RoleLimits::default());
    }
    let mine = access.perms(db).await?;
    if mine & (Perm::ManageRoles as i64 | Perm::AssignRoles as i64) == 0 {
        return Ok(RoleLimits::default());
    }
    let sorted = |set: HashSet<i64>| {
        let mut ids: Vec<i64> = set.into_iter().collect();
        ids.sort_unstable();
        ids
    };
    let ChannelLimits { grants, denies } = channel_limits(db, access, mine, None).await?;
    let mut locked = match access.order_guard(db).await? {
        true => held_above(db, access, mine, None).await?,
        false => HashSet::new(),
    };
    let rank = access.rank(db).await?;
    let rows = sqlx::query("SELECT id, position FROM roles WHERE server = $1")
        .bind(access.name())
        .fetch_all(db)
        .await?;
    for r in &rows {
        let id: i64 = r.try_get(0)?;
        if !hier::outranks(&rank, &ranks::role_rank(r.try_get(1)?, id)) {
            locked.insert(id);
        }
    }
    Ok(RoleLimits {
        held_above: sorted(locked),
        channel_grants: sorted(grants),
        channel_denies: sorted(denies),
    })
}

const ROLE_NOT_BELOW: &str = "You can't change a role that is not below your highest role";
const ROLE_HELD_ABOVE: &str = "You can't change a role held by a member you can't moderate";

/// Refuses a caller who does not manage role `id`: it must rank below them. While the role
/// order is unconfirmed, its permissions must also be within theirs and every other holder
/// must be someone they could moderate.
async fn require_role_change(
    db: &Db,
    access: &ServerAccess,
    id: i64,
    role_perms: i64,
) -> Result<i64, ApiError> {
    let mine = access.perms(db).await?;
    if access.order_guard(db).await? {
        if !can_grant(mine, access.site_admin(), role_perms) {
            return Err(ApiError::perm(
                "You can't change a role that has permissions you don't have",
                "rank",
            ));
        }
        if !held_above(db, access, mine, Some(id)).await?.is_empty() {
            return Err(ApiError::perm(ROLE_HELD_ABOVE, "rank"));
        }
    }
    let role = ranks::role_rank_in(db, access.name(), id)
        .await?
        .ok_or_else(|| not_found("Role not found"))?;
    match hier::manages_role(&access.actor(db).await?, &role, None) {
        true => Ok(mine),
        false => Err(ApiError::perm(ROLE_NOT_BELOW, "rank")),
    }
}

/// The role edit as it stands once the role is locked: `adds` are the permissions the role is
/// to hold and `also` what the edit needs besides. Answers whether only instance powers let it
/// pass.
async fn check_locked_role_edit(
    conn: &mut AnyConnection,
    access: &ServerAccess,
    id: i64,
    current: i64,
    adds: i64,
    also: i64,
) -> Result<bool, ApiError> {
    let (mine, own) = access.role_authority_in(conn, Perm::ManageRoles).await?;
    let guard = ranks::guard_in(&mut *conn, access.name()).await?;
    let needed = also
        | match guard {
            true => current | adds,
            false => adds & !current,
        };
    if !can_grant(mine, access.site_admin(), needed) {
        return Err(ApiError::perm(
            "You can't grant permissions you don't have",
            "rank",
        ));
    }
    let member = access.as_member();
    let held = guard
        && !held_above(&mut *conn, member.as_ref().unwrap_or(access), own, Some(id))
            .await?
            .is_empty();
    let rank = match access.viewer() {
        Some(user) => ranks::rank_in(conn, access.name(), &user.username).await?,
        None => Rank::of(Tier::Outside),
    };
    let role = ranks::role_rank_in(&mut *conn, access.name(), id)
        .await?
        .ok_or_else(|| not_found("Role not found"))?;
    let below = hier::manages_role(
        &Actor {
            rank,
            bits: own as Mask,
        },
        &role,
        None,
    );
    match (access.site_admin(), held, below) {
        (false, true, _) => return Err(ApiError::perm(ROLE_HELD_ABOVE, "rank")),
        (false, false, false) => return Err(ApiError::perm(ROLE_NOT_BELOW, "rank")),
        (true, _, _) | (false, false, true) => {}
    }
    Ok(access.site_admin()
        && (held
            || !below
            || own & (needed | Perm::ManageRoles as i64) != (needed | Perm::ManageRoles as i64)))
}

const ROLE_ABOVE: &str = "You can't give or take a role that is not below your highest role";

/// Refuses a caller whose rank is not above role `id`.
async fn require_below(db: &Db, access: &ServerAccess, id: i64) -> Result<(), ApiError> {
    let role = ranks::role_rank_in(db, access.name(), id)
        .await?
        .ok_or_else(|| not_found("Role not found"))?;
    match hier::outranks(&access.rank(db).await?, &role) {
        true => Ok(()),
        false => Err(ApiError::perm(ROLE_ABOVE, "rank")),
    }
}

const MENTIONABLE_NEEDS: &str =
    "Letting anyone mention a role needs the Mention everyone permission";

async fn require_mentionable(db: &Db, access: &ServerAccess, on: bool) -> Result<(), ApiError> {
    match on && !access.has_perm(db, Perm::MentionEveryone).await {
        true => Err(ApiError::perm(MENTIONABLE_NEEDS, "MentionEveryone")),
        false => Ok(()),
    }
}

fn check_color(color: &str) -> Result<(), ApiError> {
    match valid_color(color) {
        true => Ok(()),
        false => Err(ApiError::invalid("Invalid color", "color")),
    }
}

/// The icon to store for `icon`: one emoji, stored as its fully-qualified sequence, or none for
/// `None` and a blank text.
fn check_icon(icon: Option<&str>) -> Result<Option<&'static str>, ApiError> {
    match icon.map(str::trim).filter(|text| !text.is_empty()) {
        None => Ok(None),
        Some(text) => crate::api::reactions::canonical_emoji(text)
            .map(Some)
            .ok_or_else(|| ApiError::invalid("Not an emoji", "emoji")),
    }
}

/// Create a role
///
/// Adds a role to the server. A server can have at most 250 roles by default (`SERVER_ROLES_MAX`).
/// The role's permissions must be a subset of yours (equal is fine). The new role goes to the
/// bottom of the role order (`position` 1; the others move up), and to the bottom of the display
/// order when roles have display positions. Requires the Manage roles server permission. Emits
/// `roles_changed` to the server. General rate-limit bucket.
#[utoipa::path(
    post,
    path = "/api/v1/servers/{name}/roles",
    tag = "Roles",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    request_body = RoleReq,
    responses(
        (status = 200, description = "The created role", body = Role),
        (status = 400, description = "Invalid role name (blank, longer than 100 characters or blocked by the profanity filter), an invalid color, or `A server can have at most 250 roles` with the configured number (`SERVER_ROLES_MAX`, reason `limit`). Malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Manage roles permission, or the role's permissions include some you don't have (`You can't grant permissions you don't have`)", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses)", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn create_role(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Json(req): Json<RoleReq>,
) -> Result<Json<Role>, ApiError> {
    let access = role_guard(&state, &name, &user, Perm::ManageRoles).await?;
    let key = access.name().to_string();
    let role_name = req.name.trim().to_string();
    check_name(
        &state.db,
        ProfanityTarget::RoleNames,
        "Role name",
        &role_name,
    )
    .await?;
    check_color(&req.color)?;
    let perms = req.perms & ROLE_BITS;
    access.require_grant(&state.db, perms).await?;
    require_mentionable(&state.db, &access, req.mentionable).await?;
    let (db, on) = (&state.db, req.mentionable);
    let bypassed = access
        .bypassed(|m| async move {
            m.require_grant(db, perms).await?;
            require_mentionable(db, &m, on).await
        })
        .await;
    let actor = access
        .audit_actor(&state.db, Perm::ManageRoles)
        .await?
        .staff_if(bypassed);
    let mut tx = state.db.begin().await?;
    crate::db::lock_server(&mut tx, &key).await?;
    let most = state.limits.server_roles_max;
    sqlx::query("UPDATE roles SET position = position + 1 WHERE server = $1")
        .bind(&key)
        .execute(&mut *tx)
        .await?;
    let shown = sqlx::query("UPDATE roles SET display_position = display_position + 1 WHERE server = $1 AND display_position IS NOT NULL")
        .bind(&key)
        .execute(&mut *tx)
        .await?
        .rows_affected()
        > 0;
    let display_position = shown.then_some(1i64);
    bump_roles_version(&mut tx, &key).await?;
    let id: i64 = sqlx::query(
        "INSERT INTO roles(server, name, color, perms, mentionable, position, display_position) SELECT $1, $2, $3, $4, $5, 1, $7 WHERE (SELECT COUNT(*) FROM roles WHERE server = $1) < $6 RETURNING id",
    )
    .bind(&key)
    .bind(&role_name)
    .bind(&req.color)
    .bind(perms)
    .bind(i64::from(req.mentionable))
    .bind(most)
    .bind(display_position)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| {
        ApiError::limit(
            StatusCode::BAD_REQUEST,
            format!("A server can have at most {most} roles"),
            &rchat_settings::items::SERVER_ROLES_MAX,
        )
    })?
    .try_get(0)?;
    audit::record(
        &mut tx,
        Entry::new(&key, &actor, audit::Action::RoleCreate)
            .target(Target::with_id(TargetKind::Role, id, Some(&role_name)))
            .details(
                Details::new()
                    .change("name", None::<String>, role_name.as_str())
                    .change("color", None::<String>, req.color.as_str())
                    .change("perms", None::<i64>, perms)
                    .change("mentionable", None::<bool>, req.mentionable),
            ),
    )
    .await?;
    tx.commit().await?;
    state.hub.broadcast(WsEvent::RolesChanged { server: key });
    Ok(Json(Role {
        id,
        name: role_name,
        color: req.color,
        perms,
        mentionable: req.mentionable,
        position: 1,
        display_position,
        hoist: false,
        icon: None,
        color_names: true,
    }))
}

/// Update a role
///
/// Changes the name, color, permissions or looks of a role. Omitted fields stay the same. All
/// fields are checked before anything is saved, so a rejected request changes nothing. Every
/// edit, also a rename or recolor, needs the role to rank below your highest role (see
/// `role_limits.held_above` in the server detail). Permissions you add must be ones you hold.
/// While the role order is unconfirmed (`ServerDetail.roles_order_confirmed`), the role's
/// current and new permissions must also be a subset of yours, and every other member with the
/// role must be someone you could kick. Requires the Manage roles permission. A change of
/// permissions emits `roles_changed` to the server and removes users from voice channels they can
/// no longer view; any other change emits `role_updated` with the role. General rate-limit
/// bucket.
#[utoipa::path(
    patch,
    path = "/api/v1/servers/{name}/roles/{id}",
    tag = "Roles",
    params(("name" = String, Path, description = "Server name, case-insensitive"), ("id" = i64, Path, description = "Role id; the role must belong to this server")),
    request_body = RolePatch,
    responses(
        (status = 200, description = "The updated role", body = Role),
        (status = 400, description = "Invalid role name (blank, longer than 100 characters or blocked by the profanity filter), color or icon (`Not an emoji`); nothing is saved. A non-integer `id`, malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Nothing is saved. Missing the Manage roles permission; the role does not rank below your highest role (`You can't change a role that is not below your highest role`); the new permissions include some you don't have (`You can't grant permissions you don't have`); or, while the role order is unconfirmed, the role has permissions you don't have (`You can't change a role that has permissions you don't have`) or another holder of the role is someone you could not kick (`You can't change a role held by a member you can't moderate`)", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses); or the role does not exist in it", body = ApiErrorBody),
        (status = 409, description = "Role permissions or mention settings changed during this request", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn update_role(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path((name, id)): Path<(String, i64)>,
    Json(req): Json<RolePatch>,
) -> Result<Json<Role>, ApiError> {
    let access = role_guard(&state, &name, &user, Perm::ManageRoles).await?;
    let key = access.name().to_string();
    let current = require_role(&state.db, &key, id).await?;
    require_role_change(&state.db, &access, id, current).await?;
    let RolePatch {
        mask,
        name,
        color,
        perms,
        mentionable,
        icon,
        hoist,
        color_names,
    } = req;
    let role_name = match &name {
        Some(role_name) => {
            let role_name = role_name.trim().to_string();
            check_name(
                &state.db,
                ProfanityTarget::RoleNames,
                "Role name",
                &role_name,
            )
            .await?;
            Some(role_name)
        }
        None => None,
    };
    if let Some(color) = &color {
        check_color(color)?;
    }
    let icon = icon.map(|icon| check_icon(icon.as_deref())).transpose()?;
    let perms = perms.map(|p| update_role_bits(current, p, mask.unwrap_or(PRE_DELEGATION_PERMS)));
    let asked = match access.order_guard(&state.db).await? {
        true => perms,
        false => perms.map(|p| p & !current),
    };
    if let Some(asked) = asked {
        access.require_grant(&state.db, asked).await?;
    }
    let was_on = sqlx::query("SELECT mentionable FROM roles WHERE id = $1")
        .bind(id)
        .fetch_one(&state.db)
        .await?
        .try_get::<i64, _>(0)?
        != 0;
    let on = mentionable == Some(true) && !was_on;
    require_mentionable(&state.db, &access, on).await?;
    let db = &state.db;
    let bypassed = access
        .bypassed(|m| async move {
            require_role_change(db, &m, id, current).await?;
            if let Some(asked) = asked {
                m.require_grant(db, asked).await?;
            }
            require_mentionable(db, &m, on).await
        })
        .await;
    let actor = access
        .audit_actor(&state.db, Perm::ManageRoles)
        .await?
        .staff_if(bypassed);
    let mut tx = state.db.begin().await?;
    lock_server(&mut tx, &key).await?;
    let (was_name, was_color, was_mentionable) =
        lock_role_version(&mut tx, &key, id, current, Some(was_on)).await?;
    let looks = sqlx::query("SELECT icon, hoist, color_names FROM roles WHERE id = $1")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    let (was_icon, was_hoist, was_tinted): (Option<String>, bool, bool) = (
        looks.try_get(0)?,
        looks.try_get::<i64, _>(1)? != 0,
        looks.try_get::<i64, _>(2)? != 0,
    );
    let also = match on {
        true => Perm::MentionEveryone as i64,
        false => 0,
    };
    let adds = perms.unwrap_or(current);
    let actor =
        actor.staff_if(check_locked_role_edit(&mut tx, &access, id, current, adds, also).await?);
    if let Some(bits) = perms {
        sqlx::query("UPDATE roles SET perms = $1 WHERE id = $2")
            .bind(bits)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    let was_perms = current;
    if let Some(role_name) = &role_name {
        sqlx::query("UPDATE roles SET name = $1 WHERE id = $2")
            .bind(role_name)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(color) = &color {
        sqlx::query("UPDATE roles SET color = $1 WHERE id = $2")
            .bind(color)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(mentionable) = mentionable {
        sqlx::query("UPDATE roles SET mentionable = $1 WHERE id = $2")
            .bind(i64::from(mentionable))
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(icon) = icon {
        sqlx::query("UPDATE roles SET icon = $1 WHERE id = $2")
            .bind(icon)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    for (column, on) in [("hoist", hoist), ("color_names", color_names)] {
        if let Some(on) = on {
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "UPDATE roles SET {column} = $1 WHERE id = $2"
            )))
            .bind(i64::from(on))
            .bind(id)
            .execute(&mut *tx)
            .await?;
        }
    }
    let changes = Details::new()
        .change(
            "name",
            was_name.as_str(),
            role_name.as_deref().unwrap_or(&was_name),
        )
        .change(
            "color",
            was_color.as_str(),
            color.as_deref().unwrap_or(&was_color),
        )
        .change("perms", was_perms, perms.unwrap_or(was_perms))
        .perms_diff(was_perms, perms.unwrap_or(was_perms))
        .change(
            "mentionable",
            was_mentionable,
            mentionable.unwrap_or(was_mentionable),
        )
        .change(
            "icon",
            was_icon.as_deref(),
            icon.unwrap_or(was_icon.as_deref()),
        )
        .change("hoist", was_hoist, hoist.unwrap_or(was_hoist))
        .change("color_names", was_tinted, color_names.unwrap_or(was_tinted));
    if changes.has_changes() {
        audit::record(
            &mut tx,
            Entry::new(&key, &actor, audit::Action::RoleUpdate)
                .target(Target::with_id(
                    TargetKind::Role,
                    id,
                    Some(role_name.as_deref().unwrap_or(&was_name)),
                ))
                .details(changes),
        )
        .await?;
    }
    tx.commit().await?;
    let role = role_by_id(&state.db, id).await?;
    match perms.is_some_and(|bits| bits != was_perms) {
        true => {
            state.hub.broadcast(WsEvent::RolesChanged {
                server: key.clone(),
            });
            voice_rules_changed(&state, &key, None).await;
        }
        false => state.hub.broadcast(WsEvent::RoleUpdated {
            server: key,
            role: role.clone(),
        }),
    }
    Ok(Json(role))
}

/// The role `id` of `server`, while it is one.
pub(crate) async fn role_in(db: &Db, server: &str, id: i64) -> Result<Option<Role>, ApiError> {
    let sql = format!("SELECT {ROLE_COLUMNS} FROM roles r WHERE r.id = $1 AND r.server = $2");
    match sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .bind(server)
        .fetch_optional(db)
        .await?
    {
        Some(row) => Ok(Some(role_of(&row)?)),
        None => Ok(None),
    }
}

/// Where the roles of `server` are: every role id, the highest first, the display position of
/// each, and the version of the role order. `None` when there is no such server.
pub(crate) async fn role_places(
    db: &Db,
    server: &str,
) -> Result<Option<(Vec<i64>, Vec<Option<i64>>, i64)>, ApiError> {
    let Some(version) = sqlx::query("SELECT roles_version FROM servers WHERE name = $1")
        .bind(server)
        .fetch_optional(db)
        .await?
    else {
        return Ok(None);
    };
    let rows = sqlx::query(
        "SELECT id, display_position FROM roles WHERE server = $1 ORDER BY position DESC, id",
    )
    .bind(server)
    .fetch_all(db)
    .await?;
    let mut order = Vec::with_capacity(rows.len());
    let mut display = Vec::with_capacity(rows.len());
    for r in &rows {
        order.push(r.try_get(0)?);
        display.push(r.try_get(1)?);
    }
    Ok(Some((order, display, version.try_get(0)?)))
}

/// The role `id`.
pub(crate) async fn role_by_id<'e, E>(ex: E, id: i64) -> Result<Role, ApiError>
where
    E: sqlx::Executor<'e, Database = sqlx::Any>,
{
    let sql = format!("SELECT {ROLE_COLUMNS} FROM roles r WHERE r.id = $1");
    let row = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_optional(ex)
        .await?
        .ok_or_else(|| not_found("Role not found"))?;
    role_of(&row)
}

/// Delete a role
///
/// Deletes the role, unassigns it from everyone and removes the channel permission rules that
/// name it. The role must rank below your highest role. While the role order is unconfirmed
/// (`ServerDetail.roles_order_confirmed`), its permissions must also be a subset of yours and
/// every other member who holds it must be someone you could kick. If one
/// of the role's channel rules denies something its channel gives everyone who views it (see
/// `role_limits.channel_denies`), deleting it would widen access, so you also need Manage
/// channels. Requires the Manage roles server permission.
/// Emits `roles_changed` to the server and removes users from voice channels they can no longer
/// view. General rate-limit bucket.
#[utoipa::path(
    delete,
    path = "/api/v1/servers/{name}/roles/{id}",
    tag = "Roles",
    params(("name" = String, Path, description = "Server name, case-insensitive"), ("id" = i64, Path, description = "Role id; the role must belong to this server")),
    responses(
        (status = 200, description = "Role deleted and removed from channel permission rules", body = OkResp),
        (status = 400, description = "Non-integer `id` (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Manage roles permission; the role does not rank below your highest role (`You can't change a role that is not below your highest role`); while the role order is unconfirmed, the role has permissions you don't have (`You can't change a role that has permissions you don't have`) or another holder of the role is someone you could not kick (`You can't change a role held by a member you can't moderate`); or the role limits access to a channel and you lack Manage channels (`This role limits access to a channel, so deleting it would widen that access. That needs Manage channels`)", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses); or the role does not exist in it", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn delete_role(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path((name, id)): Path<(String, i64)>,
) -> Result<Json<OkResp>, ApiError> {
    let access = role_guard(&state, &name, &user, Perm::ManageRoles).await?;
    let key = access.name().to_string();
    let current = require_role(&state.db, &key, id).await?;
    let mine = require_role_change(&state.db, &access, id, current).await?;
    if !channel_limits(&state.db, &access, mine, Some(id))
        .await?
        .denies
        .is_empty()
    {
        return Err(ApiError::perm(ROLE_DELETE_WIDENS, "rank"));
    }
    let db = &state.db;
    let bypassed = access
        .bypassed(|m| async move {
            let mine = require_role_change(db, &m, id, current).await?;
            match channel_limits(db, &m, mine, Some(id))
                .await?
                .denies
                .is_empty()
            {
                true => Ok(()),
                false => Err(ApiError::perm(ROLE_DELETE_WIDENS, "rank")),
            }
        })
        .await;
    let actor = access
        .audit_actor(&state.db, Perm::ManageRoles)
        .await?
        .staff_if(bypassed);
    let mut tx = state.db.begin().await?;
    lock_server(&mut tx, &key).await?;
    let gone = sqlx::query("DELETE FROM roles WHERE id = $1 RETURNING name, color, perms")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    for sql in [
        "DELETE FROM channel_perms WHERE subject = $1",
        "DELETE FROM category_perms WHERE subject = $1",
    ] {
        sqlx::query(sql)
            .bind(format!("r:{id}"))
            .execute(&mut *tx)
            .await?;
    }
    if let Some(gone) = &gone {
        bump_roles_version(&mut tx, &key).await?;
        let (name, color, perms): (String, String, i64) =
            (gone.try_get(0)?, gone.try_get(1)?, gone.try_get(2)?);
        audit::record(
            &mut tx,
            Entry::new(&key, &actor, audit::Action::RoleDelete)
                .target(Target::with_id(TargetKind::Role, id, Some(&name)))
                .details(
                    Details::new()
                        .change("name", name.as_str(), None::<String>)
                        .change("color", color.as_str(), None::<String>)
                        .change("perms", perms, None::<i64>),
                ),
        )
        .await?;
    }
    tx.commit().await?;
    state.hub.broadcast(WsEvent::RolesChanged {
        server: key.clone(),
    });
    voice_rules_changed(&state, &key, None).await;
    Ok(ok())
}

/// Assign a role
///
/// Gives the role to the member `username`, yourself or a member you could kick (see
/// `ServerDetail.roles_order_confirmed`); assigning a role they already hold succeeds without
/// changes. The role must rank below your highest role, and its permissions must be a subset
/// of yours (equal is fine). The channel permission rules that name the role must not allow
/// anything you don't have in that channel (see `role_limits.channel_grants` in the server
/// detail). Requires the Assign roles server permission. Emits `member_roles_changed` (the
/// member's roles now) to the server and the member when the member gains the role, and takes
/// them out of voice channels they can no longer be in. General rate-limit bucket.
#[utoipa::path(
    post,
    path = "/api/v1/servers/{name}/roles/{id}/assign",
    tag = "Roles",
    params(("name" = String, Path, description = "Server name, case-insensitive"), ("id" = i64, Path, description = "Role id; the role must belong to this server")),
    request_body = UsernameReq,
    responses(
        (status = 200, description = "Role assigned to the member", body = OkResp),
        (status = 400, description = "A non-integer `id`, malformed JSON or a missing `Content-Type` (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Assign roles permission, the role does not rank below your highest role (`You can't give or take a role that is not below your highest role`), you could not kick the member (`You can't moderate this member`), the role has permissions you don't have (`You can't grant permissions you don't have`), or its channel rules give access you don't have (`This role gives channel access you don't have`)", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses); or the role does not exist in it, or the user is not a member", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 409, description = "Role permissions changed during assignment", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn assign_role(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path((name, id)): Path<(String, i64)>,
    Json(req): Json<UsernameReq>,
) -> Result<Json<OkResp>, ApiError> {
    let target = req.username.to_lowercase();
    let user = acting_on(&user, &target);
    let access = role_guard(&state, &name, &user, Perm::AssignRoles).await?;
    let key = access.name().to_string();
    let role_perms = require_role(&state.db, &key, id).await?;
    if !access.member_in(&state.db, &target).await? {
        return Err(not_found("Not a member"));
    }
    require_below(&state.db, &access, id).await?;
    if target != user.username {
        access.require_moderate(&state.db, &target).await?;
    }
    access.require_grant(&state.db, role_perms).await?;
    let mine = access.perms(&state.db).await?;
    if !channel_limits(&state.db, &access, mine, Some(id))
        .await?
        .grants
        .is_empty()
    {
        return Err(ApiError::perm(
            "This role gives channel access you don't have",
            "rank",
        ));
    }
    let (db, who, me) = (&state.db, target.as_str(), user.username.as_str());
    let bypassed = access
        .bypassed(|m| async move {
            require_below(db, &m, id).await?;
            if who != me {
                m.require_moderate(db, who).await?;
            }
            m.require_grant(db, role_perms).await?;
            let mine = m.perms(db).await?;
            match channel_limits(db, &m, mine, Some(id))
                .await?
                .grants
                .is_empty()
            {
                true => Ok(()),
                false => Err(ApiError::perm(
                    "This role gives channel access you don't have",
                    "rank",
                )),
            }
        })
        .await;
    let actor = access
        .audit_actor(&state.db, Perm::AssignRoles)
        .await?
        .staff_if(bypassed);
    let mut tx = state.db.begin().await?;
    lock_server(&mut tx, &key).await?;
    lock_role_version(&mut tx, &key, id, role_perms, None).await?;
    let (mine, own) = access.role_authority_in(&mut tx, Perm::AssignRoles).await?;
    let theirs = access
        .member_perms_in(&mut tx, &target)
        .await?
        .ok_or_else(|| not_found("Not a member"))?;
    let guard = ranks::guard_in(&mut *tx, &key).await?;
    let role = ranks::role_rank_in(&mut *tx, &key, id)
        .await?
        .ok_or_else(|| not_found("Role not found"))?;
    let member = ranks::rank_in(&mut tx, &key, &user.username).await?;
    let them = Actor {
        rank: ranks::rank_in(&mut tx, &key, &target).await?,
        bits: theirs as Mask,
    };
    let other = (target != user.username).then_some(&them);
    let gives = |rank: Rank<'static>, bits: i64| {
        hier::may_assign(
            &Actor {
                rank,
                bits: bits as Mask,
            },
            &role,
            guard,
            (role_perms & ALL_PERMS) as Mask,
            true,
            other,
            &HOSTED,
        )
    };
    let rank = match access.site_admin() {
        true => Rank::of(Tier::Staff),
        false => member,
    };
    if !gives(rank, mine) {
        return Err(ApiError::perm(
            "You can't assign this role to this member",
            "rank",
        ));
    }
    let actor = actor.staff_if(access.site_admin() && !gives(member, own));
    let added = grant_role(&mut tx, &key, &target, id).await?;
    if added > 0 {
        record_role_member(
            &mut tx,
            &key,
            &actor,
            audit::Action::RoleAssign,
            id,
            &target,
        )
        .await?;
    }
    tx.commit().await?;
    if added > 0 {
        announce_member_roles(&state, &key, &target).await;
    }
    Ok(ok())
}

/// Unassign a role
///
/// Takes the role away from `username`. When `username` is someone else, the role must rank
/// below your highest role and they must be someone you could kick (see
/// `ServerDetail.roles_order_confirmed`); the role's own permissions don't matter. If one of the role's channel rules denies something its channel gives
/// everyone who views it (see `role_limits.channel_denies`), removing it would widen
/// access, so you also need Manage channels, even for yourself. Requires the Assign roles server
/// permission. Emits `member_roles_changed` (the member's roles now) to the server and the
/// member, and takes them out of voice channels they can no longer be in. General rate-limit
/// bucket.
#[utoipa::path(
    delete,
    path = "/api/v1/servers/{name}/roles/{id}/assign/{username}",
    tag = "Roles",
    params(("name" = String, Path, description = "Server name, case-insensitive"), ("id" = i64, Path, description = "Role id; the role must belong to this server"), ("username" = String, Path, description = "Target username, case-insensitive")),
    responses(
        (status = 200, description = "Role removed from the member", body = OkResp),
        (status = 400, description = "Non-integer `id` (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Assign roles permission, the role does not rank below your highest role (`You can't give or take a role that is not below your highest role`), you could not kick the member (`You can't moderate this member`), or the role limits access to a channel and you lack Manage channels (`This role limits access to a channel, so removing it would widen that access. That needs Manage channels`)", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses); or the role does not exist in it, or the user does not hold the role", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn unassign_role(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path((name, id, target)): Path<(String, i64, String)>,
) -> Result<Json<OkResp>, ApiError> {
    let target = target.to_lowercase();
    let user = acting_on(&user, &target);
    let access = role_guard(&state, &name, &user, Perm::AssignRoles).await?;
    let key = access.name().to_string();
    require_role(&state.db, &key, id).await?;
    if target != user.username {
        require_below(&state.db, &access, id).await?;
        access.require_moderate(&state.db, &target).await?;
    }
    let mine = access.perms(&state.db).await?;
    if !channel_limits(&state.db, &access, mine, Some(id))
        .await?
        .denies
        .is_empty()
    {
        return Err(ApiError::perm(ROLE_UNASSIGN_WIDENS, "rank"));
    }
    let (db, who, me) = (&state.db, target.as_str(), user.username.as_str());
    let bypassed = access
        .bypassed(|m| async move {
            if who != me {
                require_below(db, &m, id).await?;
                m.require_moderate(db, who).await?;
            }
            let mine = m.perms(db).await?;
            match channel_limits(db, &m, mine, Some(id))
                .await?
                .denies
                .is_empty()
            {
                true => Ok(()),
                false => Err(ApiError::perm(ROLE_UNASSIGN_WIDENS, "rank")),
            }
        })
        .await;
    let actor = access
        .audit_actor(&state.db, Perm::AssignRoles)
        .await?
        .staff_if(bypassed);
    let mut tx = state.db.begin().await?;
    lock_server(&mut tx, &key).await?;
    let removed = revoke_role(&mut tx, &key, &target, id).await?;
    if removed > 0 {
        record_role_member(
            &mut tx,
            &key,
            &actor,
            audit::Action::RoleUnassign,
            id,
            &target,
        )
        .await?;
    }
    tx.commit().await?;
    match removed {
        0 => Err(not_found("Not assigned")),
        _ => {
            announce_member_roles(&state, &key, &target).await;
            Ok(ok())
        }
    }
}

pub(crate) async fn grant_role(
    tx: &mut AnyConnection,
    server: &str,
    username: &str,
    id: i64,
) -> sqlx::Result<u64> {
    Ok(sqlx::query(
        "INSERT INTO user_roles(server, username, role_id) VALUES($1, $2, $3) ON CONFLICT(server, username, role_id) DO NOTHING",
    )
    .bind(server)
    .bind(username)
    .bind(id)
    .execute(&mut *tx)
    .await?
    .rows_affected())
}

pub(crate) async fn revoke_role(
    tx: &mut AnyConnection,
    server: &str,
    username: &str,
    id: i64,
) -> sqlx::Result<u64> {
    sqlx::query("DELETE FROM sso_grants WHERE server = $1 AND username = $2 AND role_id = $3")
        .bind(server)
        .bind(username)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    Ok(
        sqlx::query("DELETE FROM user_roles WHERE server = $1 AND username = $2 AND role_id = $3")
            .bind(server)
            .bind(username)
            .bind(id)
            .execute(&mut *tx)
            .await?
            .rows_affected(),
    )
}

/// Tells the server and `username` which roles they hold now (the whole server reloads its
/// roles when they can't be read), and checks their voice.
pub(crate) async fn announce_member_roles(state: &AppState, server: &str, username: &str) {
    match member_role_ids(&state.db, server, username).await {
        Ok(Some(role_ids)) => state.hub.broadcast(WsEvent::MemberRolesChanged {
            server: server.to_owned(),
            username: username.to_owned(),
            role_ids,
        }),
        Ok(None) => {}
        Err(_) => state.hub.broadcast(WsEvent::RolesChanged {
            server: server.to_owned(),
        }),
    }
    crate::ws::member_voice_changed(state, server, username).await;
}

/// The roles `username` holds in `server`, lowest id first; `None` for a non-member.
pub(crate) async fn member_role_ids(
    db: &Db,
    server: &str,
    username: &str,
) -> Result<Option<Vec<i64>>, ApiError> {
    let rows = sqlx::query(
        "SELECT r.role_id FROM members m LEFT JOIN user_roles r ON r.server = m.server AND r.username = m.username WHERE m.server = $1 AND m.username = $2 ORDER BY r.role_id",
    )
    .bind(server)
    .bind(username)
    .fetch_all(db)
    .await?;
    if rows.is_empty() {
        return Ok(None);
    }
    let ids = rows
        .iter()
        .map(|r| r.try_get::<Option<i64>, _>(0))
        .collect::<sqlx::Result<Vec<_>>>()?;
    Ok(Some(ids.into_iter().flatten().collect()))
}

/// A channel rule subject for the audit log: `{kind: "user", name}` or `{kind: "role", id,
/// name}`.
async fn rule_subject(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    subject: &str,
) -> Result<serde_json::Value, ApiError> {
    Ok(match subject.split_once(':') {
        Some(("r", id)) => {
            let id: i64 = id.parse().unwrap_or_default();
            let name: Option<String> = sqlx::query("SELECT name FROM roles WHERE id = $1")
                .bind(id)
                .fetch_optional(&mut **tx)
                .await?
                .map(|r| r.try_get(0))
                .transpose()?;
            serde_json::json!({ "kind": "role", "id": id, "name": name })
        }
        Some((_, name)) => serde_json::json!({ "kind": "user", "name": name }),
        None => serde_json::json!({ "kind": "user", "name": subject }),
    })
}

async fn record_role_member(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    server: &str,
    actor: &audit::Actor,
    action: audit::Action,
    role: i64,
    username: &str,
) -> Result<(), ApiError> {
    let name: Option<String> = sqlx::query("SELECT name FROM roles WHERE id = $1")
        .bind(role)
        .fetch_optional(&mut **tx)
        .await?
        .map(|r| r.try_get(0))
        .transpose()?;
    audit::record(
        tx,
        Entry::new(server, actor, action)
            .target(Target::user(username))
            .details(Details::new().set("role", serde_json::json!({ "id": role, "name": name }))),
    )
    .await?;
    Ok(())
}

async fn channel_perm_guard(
    state: &AppState,
    id: i64,
    user: &User,
) -> Result<ResolvedChannel, ApiError> {
    let channel = resolve_channel(&state.db, id, Some(user), &Proof::none()).await?;
    channel
        .server()
        .require_perm(&state.db, Perm::ManageChannels)
        .await?;
    Ok(channel)
}

/// A rule subject: `everyone`, a role of the server, or an account. A name that is not a
/// member of the server holds one of the caller's misses while it is looked up, and keeps it
/// when no account has the name, which is refused like a malformed subject.
async fn check_subject(
    state: &AppState,
    caller: &User,
    access: &ServerAccess,
    subject: &str,
) -> Result<(), ApiError> {
    let wrong = || ApiError::invalid("Invalid subject", "subject");
    if subject == EVERYONE {
        return Ok(());
    }
    match subject.split_once(':') {
        Some(("u", name)) if crate::api::names::could_be_username(name) => {
            if access.has_member(&state.db, name).await? {
                return Ok(());
            }
            let held = lookup::unmissed(state, Some(caller))?;
            match crate::db::get_user(&state.db, name).await? {
                Some(_) => Ok(()),
                None => {
                    held.spend();
                    Err(wrong())
                }
            }
        }
        Some(("r", id)) => {
            let id: i64 = id.parse().map_err(|_| wrong())?;
            require_role(&state.db, access.name(), id).await.map(|_| ())
        }
        Some((_, _)) | None => Err(wrong()),
    }
}

/// Whether the caller may take moderation permissions from `subject` in a channel: everyone, a
/// role they could edit, or a member they could moderate.
async fn outranks_subject(db: &Db, access: &ServerAccess, subject: &str) -> Result<bool, ApiError> {
    match subject.split_once(':') {
        Some(("r", id)) => {
            let id: i64 = id.parse().unwrap_or_default();
            let mine = access.perms(db).await?;
            Ok(mine & Perm::ManageRoles as i64 != 0
                && require_role_change(db, access, id, require_role(db, access.name(), id).await?)
                    .await
                    .is_ok())
        }
        Some((_, name)) => Ok(access.require_moderate(db, name).await.is_ok()),
        None => Ok(true),
    }
}

/// Refuses a rule edit that allows what the caller does not hold in the channel (`mine`), that
/// denies a moderation permission they do not hold, or that denies or stops allowing one for a
/// subject they do not outrank. Admins with every permission pass.
async fn check_rule_edit(
    db: &Db,
    access: &ServerAccess,
    mine: i64,
    subject: &str,
    before: Option<Ow>,
    after: Option<Ow>,
) -> Result<(), ApiError> {
    let exempt = matches!(
        access.standing(db).await?.who,
        Who::Staff | Who::Owner | Who::Admin { mask: 0, roles: _ }
    );
    if exempt {
        return Ok(());
    }
    let subject_ok =
        delta::taken(before, after) == 0 || outranks_subject(db, access, subject).await?;
    match delta::check_overwrite_edit(mine as Mask, false, before, after, subject_ok) {
        Ok(()) => Ok(()),
        Err(Refusal::Grants(_)) => Err(ApiError::perm(
            "You can't allow permissions you don't have in this channel",
            "rank",
        )),
        Err(Refusal::DeniesModeration(_)) => Err(ApiError::perm(
            "You can't deny moderation permissions you don't have in this channel",
            "rank",
        )),
        Err(Refusal::Outranked) => Err(ApiError::perm(
            "You can't take moderation permissions from this role or member",
            "rank",
        )),
    }
}

/// `check_rule_edit` for a change from `before` to `after`. A rule that changes how it combines
/// with roles is checked as removed and added again. Returns whether the edit only passed
/// through instance powers.
async fn guard_rule_edit(
    db: &Db,
    channel: &ResolvedChannel,
    subject: &str,
    before: Option<&PermRow>,
    after: Option<&PermRow>,
) -> Result<bool, ApiError> {
    let access = channel.server();
    let member = match access.as_member() {
        Some(member) => Some((member, channel.member_rights(db).await?.mask())),
        None => None,
    };
    guard_edit(
        db,
        access,
        channel.rights().mask(),
        member,
        subject,
        before,
        after,
    )
    .await
}

/// `guard_rule_edit` for a category's rule: checked against what the caller holds in a channel
/// of the server without rules.
async fn guard_category_rule(
    db: &Db,
    access: &ServerAccess,
    subject: &str,
    before: Option<&PermRow>,
    after: Option<&PermRow>,
) -> Result<bool, ApiError> {
    let unruled = async |a: &ServerAccess| -> Result<i64, ApiError> {
        let none = Restrict {
            view: false,
            send: false,
        };
        let standing = a.standing(db).await?;
        Ok(channel_mask([], &standing, a.everyone(db).await?, none, false, false) as i64)
    };
    let member = match access.as_member() {
        Some(member) => {
            let own = unruled(&member).await?;
            Some((member, own))
        }
        None => None,
    };
    let mine = unruled(access).await?;
    guard_edit(db, access, mine, member, subject, before, after).await
}

/// Checks a rule edit with the caller's mask `mine`, then with the plain membership's mask:
/// returns whether only instance powers let it pass.
async fn guard_edit(
    db: &Db,
    access: &ServerAccess,
    mine: i64,
    member: Option<(ServerAccess, i64)>,
    subject: &str,
    before: Option<&PermRow>,
    after: Option<&PermRow>,
) -> Result<bool, ApiError> {
    let ow = |row: Option<&PermRow>| row.map(|r| r.evaluated());
    let steps = match (ow(before), ow(after)) {
        (Some((b, was)), Some((a, now))) if was != now => vec![(Some(b), None), (None, Some(a))],
        (b, a) => vec![(b.map(|x| x.0), a.map(|x| x.0))],
    };
    for (b, a) in &steps {
        check_rule_edit(db, access, mine, subject, *b, *a).await?;
    }
    let Some((member, own)) = member else {
        return Ok(false);
    };
    for (b, a) in &steps {
        if check_rule_edit(db, &member, own, subject, *b, *a)
            .await
            .is_err()
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// A channel whose rules are edited one by one stops copying its category's.
async fn stop_sync(conn: &mut AnyConnection, id: i64) -> sqlx::Result<()> {
    sqlx::query("UPDATE channels SET perm_sync = 0 WHERE id = $1 AND perm_sync <> 0")
        .bind(id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

fn perm_view(row: &PermRow) -> ChannelPerm {
    let (Ow { allow, deny }, mode) = row.evaluated();
    ChannelPerm {
        subject: row.subject.clone(),
        can_view: row.view,
        can_send: row.send,
        can_read_history: row.history,
        allow: allow as i64,
        deny: deny as i64,
        mode: match mode {
            Mode::Override => PermMode::Override,
            Mode::Merge => PermMode::Merge,
        },
    }
}

fn rule_changes(was: Option<&PermRow>, now: Option<&PermRow>) -> Details {
    let (was, now) = (was.map(perm_view), now.map(perm_view));
    let mode = |p: &ChannelPerm| match p.mode {
        PermMode::Override => "override",
        PermMode::Merge => "merge",
    };
    Details::new()
        .change(
            "can_view",
            was.as_ref().map(|p| p.can_view),
            now.as_ref().map(|p| p.can_view),
        )
        .change(
            "can_send",
            was.as_ref().map(|p| p.can_send),
            now.as_ref().map(|p| p.can_send),
        )
        .change(
            "can_read_history",
            was.as_ref().map(|p| p.can_read_history),
            now.as_ref().map(|p| p.can_read_history),
        )
        .change(
            "allow",
            was.as_ref().map(|p| p.allow),
            now.as_ref().map(|p| p.allow),
        )
        .change(
            "deny",
            was.as_ref().map(|p| p.deny),
            now.as_ref().map(|p| p.deny),
        )
        .change("mode", was.as_ref().map(mode), now.as_ref().map(mode))
}

/// Paging query parameters for channel permission rules.
#[derive(Deserialize, IntoParams)]
pub struct ChannelPermsQuery {
    /// Page size, default 100, clamped to 1-100.
    limit: Option<i64>,
    /// Opaque cursor from the previous page's `X-Next-Cursor` header. Blank means the first
    /// page.
    cursor: Option<String>,
}

/// List channel permission rules
///
/// Returns the permission rules on a channel, ordered by subject, as pages of `limit` (default and
/// max 100). Page with `cursor` from the `X-Next-Cursor` response header. Requires the Manage
/// channels permission in the channel's server. General rate-limit bucket.
#[utoipa::path(
    get,
    path = "/api/v1/channels/{id}/perms",
    tag = "Channels",
    params(("id" = i64, Path, description = "Channel id"), ChannelPermsQuery),
    responses(
        (status = 200, description = "A page of permission rules on the channel, ordered by subject", body = Vec<ChannelPerm>, headers(("x-next-cursor" = String, description = "Cursor for the next page; absent on the last page"))),
        (status = 400, description = "Invalid cursor (JSON), or a non-integer `id` or `limit` (plain-text framework error)", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Manage channels permission", body = ApiErrorBody),
        (status = 404, description = "`Not found`: no such channel, a channel you cannot see, or one in a password-protected server you have no access to (identical responses)", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn list_channel_perms(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(id): Path<i64>,
    Query(q): Query<ChannelPermsQuery>,
) -> Result<Paged<ChannelPerm>, ApiError> {
    channel_perm_guard(&state, id, &user).await?;
    let ChannelPermsQuery { limit, cursor } = q;
    let limit = limit.unwrap_or(LIST_MAX).clamp(1, LIST_MAX);
    let after = match cursor.as_deref().filter(|c| !c.trim().is_empty()) {
        Some(raw) => decode_cursor(raw, 1)?.remove(0),
        None => String::new(),
    };
    let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {} FROM channel_perms cp WHERE cp.channel_id = $1 AND cp.subject > $2 ORDER BY cp.subject LIMIT $3",
        perm_columns("cp")
    )))
    .bind(id)
    .bind(&after)
    .bind(limit + 1)
    .fetch_all(&state.read())
    .await?;
    let mut perms = Vec::with_capacity(rows.len());
    for r in &rows {
        perms.push(perm_view(&perm_row(r, 0)?));
    }
    let more = perms.len() as i64 > limit;
    perms.truncate(limit as usize);
    let next = match (more, perms.last()) {
        (true, Some(p)) => Some(encode_cursor(&[&p.subject])),
        _ => None,
    };
    Ok(Paged(perms, next))
}

/// Request body for setting a channel permission rule: `subject` with either `allow` and `deny`
/// (and `mode`), or the three `can_` flags, or a rule as listed with its flags changed.
#[derive(Deserialize, ToSchema)]
pub struct ChannelPermSet {
    /// Who the rule applies to: `everyone`, `u:<username>` or `r:<role id>`.
    #[schema(example = "r:12")]
    subject: String,
    /// Permission bits the rule allows in the channel (see `ChannelPerm.allow`).
    allow: Option<i64>,
    /// Permission bits the rule denies in the channel. No bit may be in both masks.
    deny: Option<i64>,
    /// How a `u:` rule combines with the member's roles. Defaults to the rule's current mode,
    /// or `override` for a new rule. Only `u:` rules may be `merge`.
    mode: Option<PermMode>,
    /// With `can_send` and `can_read_history`: the subject can see the channel.
    can_view: Option<bool>,
    /// The subject can send messages in the channel.
    can_send: Option<bool>,
    /// The subject can read messages sent before now.
    can_read_history: Option<bool>,
}

/// Set a channel permission rule
///
/// Creates or replaces the rule for `subject` on the channel. The subject is `everyone`,
/// `u:<username>` (an existing account; a name outside the server counts against your hourly
/// lookup misses, `LOOKUP_MISSES_PER_HOUR`, when no account has it) or `r:<role id>` (a role of
/// the channel's server), case-insensitive. Send `allow` and `deny` (bits of `ChannelPerm.allow`); with both 0 the rule
/// is removed. A body with `can_view`, `can_send` and `can_read_history` instead stores a rule
/// that allows what is on and denies what is off. A body with the flags and the `allow`, `deny`
/// and `mode` that `GET` lists for the stored rule changes only the flags that differ: a flag
/// turned on allows its permissions, one turned off denies them, and the rule keeps its other
/// bits and its mode. A channel can have at most 500 rules. Requires the Manage channels
/// permission in the channel's server. You can only allow, or stop denying, permissions you hold
/// in the channel, and deny Manage messages, Mention everyone, Pin messages or Bypass slow mode
/// only when you hold it. Denying one of them, or no longer allowing it, also needs a role you
/// could edit or a member you could moderate. Emits `channel_perms_changed` to the server and
/// removes users from the channel's voice room if they can no longer view it. General
/// rate-limit bucket.
#[utoipa::path(
    put,
    path = "/api/v1/channels/{id}/perms",
    tag = "Channels",
    params(("id" = i64, Path, description = "Channel id")),
    request_body = ChannelPermSet,
    responses(
        (status = 200, description = "Permission rule created, replaced or removed for the subject", body = OkResp),
        (status = 400, description = "`Invalid subject` (reason `invalid`, field `subject`; also a `u:` name without an account), `Invalid permissions` (bits outside the channel permissions, or a bit in both masks), `Invalid mode` (`merge` on a rule that is not for a user), a body with neither form, `This rule changed. Try again.` (the flags with masks that are not those listed for the stored rule), or the channel already has 500 rules. A non-integer `id`, malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Manage channels permission, or the rule allows or denies more than you may", body = ApiErrorBody),
        (status = 404, description = "`Not found`: no such channel, a channel you cannot see, or one in a password-protected server you have no access to (identical responses); or the subject's role does not exist", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket, or `Too many lookups. Try again later.` for a `u:` subject outside the server once your lookup misses are spent", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn set_channel_perm(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(id): Path<i64>,
    Json(req): Json<ChannelPermSet>,
) -> Result<Json<OkResp>, ApiError> {
    let user = rule_actor(&user, &req.subject);
    let channel = channel_perm_guard(&state, id, &user).await?;
    let server = channel.server().name().to_string();
    let actor = channel
        .server()
        .audit_actor(&state.db, Perm::ManageChannels)
        .await?;
    let ChannelPermSet {
        subject,
        allow,
        deny,
        mode,
        can_view,
        can_send,
        can_read_history,
    } = req;
    let subject = subject.to_lowercase();
    check_subject(&state, &user, channel.server(), &subject).await?;
    let was = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {} FROM channel_perms cp WHERE cp.channel_id = $1 AND cp.subject = $2",
        perm_columns("cp")
    )))
    .bind(id)
    .bind(&subject)
    .fetch_optional(&state.db)
    .await?
    .map(|r| perm_row(&r, 0))
    .transpose()?;
    let own = subject.starts_with("u:");
    let flagged = |[view, send, history]: [bool; 3]| PermRow {
        subject: subject.clone(),
        view,
        send,
        history,
        allow: 0,
        deny: 0,
        merge: false,
    };
    let masked = |allow: i64, deny: i64, merge: bool| {
        let [view, send, history] = row_flags(allow, deny);
        (allow | deny != 0).then(|| PermRow {
            subject: subject.clone(),
            view,
            send,
            history,
            allow,
            deny,
            merge,
        })
    };
    let listed = |row: &&PermRow| {
        let shown = perm_view(row);
        allow == Some(shown.allow)
            && deny == Some(shown.deny)
            && mode.is_none_or(|m| m == shown.mode)
    };
    let now = match (allow, deny, [can_view, can_send, can_read_history]) {
        (None, None, [Some(view), Some(send), Some(history)]) if mode.is_none() => {
            Some(flagged([view, send, history]))
        }
        (Some(_), Some(_), [Some(view), Some(send), Some(history)]) => {
            let row = was.as_ref().filter(listed).ok_or_else(|| {
                ApiError::conflict(StatusCode::BAD_REQUEST, "This rule changed. Try again.")
            })?;
            let flags = [view, send, history];
            match row.allow | row.deny {
                0 => Some(flagged(flags)),
                _ => {
                    let shown = [row.view, row.send, row.history];
                    let (allow, deny) = reflag(row.allow, row.deny, shown, flags);
                    masked(allow, deny, row.merge)
                }
            }
        }
        (allow, deny, [None, None, None]) if allow.is_some() || deny.is_some() => {
            let (allow, deny) = (allow.unwrap_or(0), deny.unwrap_or(0));
            if (allow | deny) & !(masks::CHANNEL as i64) != 0 || allow & deny != 0 {
                return Err(ApiError::invalid("Invalid permissions", "allow"));
            }
            let merge = match (mode, &was) {
                (Some(PermMode::Merge), _) if !own => {
                    return Err(ApiError::invalid("Invalid mode", "mode"));
                }
                (Some(mode), _) => mode == PermMode::Merge,
                (None, Some(row)) => row.evaluated().1 == Mode::Merge,
                (None, None) => false,
            };
            masked(allow, deny, merge)
        }
        _ => {
            return Err(ApiError::invalid(
                "Send allow and deny, or can_view, can_send and can_read_history",
                "allow",
            ));
        }
    };
    let rules: i64 = sqlx::query("SELECT COUNT(*) FROM channel_perms WHERE channel_id = $1")
        .bind(id)
        .fetch_one(&state.db)
        .await?
        .try_get(0)?;
    if was.is_none() && now.is_some() && rules >= CHANNEL_PERM_MAX {
        return Err(ApiError::limit(
            StatusCode::BAD_REQUEST,
            format!("A channel can have at most {CHANNEL_PERM_MAX} permission rules"),
            crate::api::error::Cap::ChannelPermRules,
        ));
    }
    let bypassed =
        guard_rule_edit(&state.db, &channel, &subject, was.as_ref(), now.as_ref()).await?;
    let actor = actor.staff_if(bypassed);
    let mut tx = state.db.begin().await?;
    stop_sync(&mut tx, id).await?;
    match &now {
        Some(row) => {
            sqlx::query(
                "INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history, restrict_set, allow, deny, mode) VALUES($1, $2, $3, $4, $5, 1, $6, $7, $8) ON CONFLICT(channel_id, subject) DO UPDATE SET can_view = excluded.can_view, can_send = excluded.can_send, can_read_history = excluded.can_read_history, restrict_set = 1, allow = excluded.allow, deny = excluded.deny, mode = excluded.mode",
            )
            .bind(id)
            .bind(&subject)
            .bind(i64::from(row.view))
            .bind(i64::from(row.send))
            .bind(i64::from(row.history))
            .bind(row.allow)
            .bind(row.deny)
            .bind(match row.merge {
                true => "merge",
                false => "override",
            })
            .execute(&mut *tx)
            .await?;
        }
        None => {
            sqlx::query("DELETE FROM channel_perms WHERE channel_id = $1 AND subject = $2")
                .bind(id)
                .bind(&subject)
                .execute(&mut *tx)
                .await?;
        }
    }
    let changes = rule_changes(was.as_ref(), now.as_ref());
    if changes.has_changes()
        && let Some(at) = audit::channel_ref(&mut *tx, id).await?
    {
        let details = changes
            .channel(&at)
            .set("subject", rule_subject(&mut tx, &subject).await?);
        let action = match now {
            Some(_) => audit::Action::ChannelPermSet,
            None => audit::Action::ChannelPermClear,
        };
        audit::record(
            &mut tx,
            audit::channel_entry(&server, &actor, action, &at).details(details),
        )
        .await?;
    }
    tx.commit().await?;
    state.hub.broadcast(WsEvent::ChannelPermsChanged {
        server: server.clone(),
        channel_id: id,
    });
    voice_rules_changed(&state, &server, Some(id)).await;
    Ok(ok())
}

/// Remove a channel permission rule
///
/// Deletes the rule for `subject` on the channel. Requires the Manage channels permission in the
/// channel's server. Removing a rule that denies something is checked like allowing it, and
/// removing one that allows a moderation permission like denying it to that role or member (see
/// `PUT /api/v1/channels/{id}/perms`). Emits `channel_perms_changed` to the server and removes
/// users from the channel's voice room if they can no longer view it. General rate-limit bucket.
#[utoipa::path(
    delete,
    path = "/api/v1/channels/{id}/perms/{subject}",
    tag = "Channels",
    params(
        ("id" = i64, Path, description = "Channel id"),
        ("subject" = String, Path, description = "Rule subject, `everyone`, `u:<username>` or `r:<role id>`, case-insensitive")
    ),
    responses(
        (status = 200, description = "Permission rule removed for the subject", body = OkResp),
        (status = 400, description = "Non-integer `id` (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Manage channels permission, the rule denies a permission you don't hold in the channel, or it allows a moderation permission to a role you couldn't edit or a member you couldn't moderate", body = ApiErrorBody),
        (status = 404, description = "`Not found`: no such channel, a channel you cannot see, or one in a password-protected server you have no access to (identical responses); or no rule for that subject", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn clear_channel_perm(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path((id, subject)): Path<(i64, String)>,
) -> Result<Json<OkResp>, ApiError> {
    let user = rule_actor(&user, &subject);
    let channel = channel_perm_guard(&state, id, &user).await?;
    let server = channel.server().name().to_string();
    let actor = channel
        .server()
        .audit_actor(&state.db, Perm::ManageChannels)
        .await?;
    let subject = subject.to_lowercase();
    let was = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {} FROM channel_perms cp WHERE cp.channel_id = $1 AND cp.subject = $2",
        perm_columns("cp")
    )))
    .bind(id)
    .bind(&subject)
    .fetch_optional(&state.db)
    .await?
    .map(|r| perm_row(&r, 0))
    .transpose()?
    .ok_or_else(|| not_found("No such rule"))?;
    let bypassed = guard_rule_edit(&state.db, &channel, &subject, Some(&was), None).await?;
    let actor = actor.staff_if(bypassed);
    let mut tx = state.db.begin().await?;
    stop_sync(&mut tx, id).await?;
    let at = audit::channel_ref(&mut *tx, id).await?;
    let removed = sqlx::query("DELETE FROM channel_perms WHERE channel_id = $1 AND subject = $2")
        .bind(id)
        .bind(&subject)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if let (1.., Some(at)) = (removed, &at) {
        let details = rule_changes(Some(&was), None)
            .channel(at)
            .set("subject", rule_subject(&mut tx, &subject).await?);
        audit::record(
            &mut tx,
            audit::channel_entry(&server, &actor, audit::Action::ChannelPermClear, at)
                .details(details),
        )
        .await?;
    }
    tx.commit().await?;
    match removed {
        0 => Err(not_found("No such rule")),
        _ => {
            state.hub.broadcast(WsEvent::ChannelPermsChanged {
                server: server.clone(),
                channel_id: id,
            });
            voice_rules_changed(&state, &server, Some(id)).await;
            Ok(ok())
        }
    }
}

/// Request body for a new role order.
#[derive(Deserialize, ToSchema)]
pub struct RoleOrderReq {
    /// Every role id of the server once, the highest first.
    order: Vec<i64>,
    /// The `roles_version` the order was made from (see `ServerDetail.roles_version`).
    version: i64,
}

/// The role order of a server.
#[derive(Serialize, ToSchema)]
pub struct RoleOrder {
    /// Every role id of the server, the highest first.
    pub order: Vec<i64>,
    /// The version of this order, for the next change.
    pub version: i64,
}

/// Request body for confirming the role order.
#[derive(Deserialize, ToSchema)]
pub struct RoleOrderConfirmReq {
    /// The `roles_version` of the order being confirmed (see `ServerDetail.roles_version`).
    version: i64,
}

/// The answer to confirming the role order.
#[derive(Serialize, ToSchema)]
pub struct RoleOrderConfirmed {
    /// Always `true`: the role order now decides who may moderate whom.
    pub confirmed: bool,
}

/// Most roles the audit entry of one reorder names.
const REORDER_NAMED: usize = 20;
const ORDER_STALE: &str = "The role order changed. Refresh and try again.";
const MOVE_NOT_BELOW: &str = "You can't move a role that is not below your highest role";
const MOVE_NOT_WITHIN: &str = "You can't move a role that has permissions you don't have";
const MOVE_HELD_ABOVE: &str = "You can't move a role held by a member you can't moderate";

fn order_stale() -> ApiError {
    ApiError(StatusCode::CONFLICT, ORDER_STALE.to_string(), None)
}

/// The roles of `server` a caller with the permissions `bits` at `rank` may move: those below
/// their rank, and while the order is unconfirmed (`guard`) only those whose permissions are
/// within theirs and that nobody they could not moderate holds (`held`).
fn movable(
    roles: &[(i64, i64, i64)],
    rank: Rank<'static>,
    bits: i64,
    guard: bool,
    held: &HashSet<i64>,
) -> HashSet<i64> {
    let actor = Actor {
        rank,
        bits: bits as Mask,
    };
    roles
        .iter()
        .filter(|(id, position, perms)| {
            hier::manages_role(&actor, &ranks::role_rank(*position, *id), None)
                && (!guard
                    || rank.tier == Tier::Staff
                    || (can_grant(bits, false, *perms) && !held.contains(id)))
        })
        .map(|(id, _, _)| *id)
        .collect()
}

/// Refuses changing the order `current` of `roles` (id, position, permissions) into `asked`
/// unless only roles the caller may move change places: those below their rank, and while the
/// order is unconfirmed only those they could edit. `authority` is the caller's Manage roles
/// permissions and those of their plain membership. Answers whether only instance powers allow
/// it.
async fn require_moves(
    conn: &mut AnyConnection,
    access: &ServerAccess,
    roles: &[(i64, i64, i64)],
    current: &[i64],
    asked: &[i64],
    confirmed: bool,
    authority: (i64, i64),
) -> Result<bool, ApiError> {
    let (mine, own) = authority;
    let guard = !confirmed;
    let member = access.as_member();
    let held = match guard {
        true => held_above(&mut *conn, member.as_ref().unwrap_or(access), own, None).await?,
        false => HashSet::new(),
    };
    let plain = match access.viewer() {
        Some(viewer) => ranks::rank_in(&mut *conn, access.name(), &viewer.username).await?,
        None => Rank::of(Tier::Outside),
    };
    let rank = match access.site_admin() {
        true => Rank::of(Tier::Staff),
        false => plain,
    };
    let place = |can: HashSet<i64>| order::reorder(current, asked, &|id| can.contains(&id));
    if place(movable(roles, rank, mine, guard, &held)) != asked {
        let none = HashSet::new();
        let reason = match (
            place(movable(roles, rank, mine, false, &none)) == asked,
            place(movable(roles, rank, mine, guard, &none)) == asked,
        ) {
            (false, _) => MOVE_NOT_BELOW,
            (true, false) => MOVE_NOT_WITHIN,
            (true, true) => MOVE_HELD_ABOVE,
        };
        return Err(ApiError::perm(reason, "rank"));
    }
    Ok(access.site_admin() && place(movable(roles, plain, own, guard, &held)) != asked)
}

/// Reorder roles
///
/// Sets the rank order of the server's roles. `order` lists every role once, the highest first.
/// You can move only the roles you manage: those below your highest role (while the role order
/// is unconfirmed, also only those you could edit; see `role_limits.held_above` in the server
/// detail). The roles you can't move must stay where they are. `version` is the
/// `roles_version` the order was made from; a role created, deleted or moved since then makes
/// it stale. Requires the Manage roles server permission. Emits `roles_reordered` to the
/// server. General rate-limit bucket.
#[utoipa::path(
    put,
    path = "/api/v1/servers/{name}/roles/order",
    tag = "Roles",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    request_body = RoleOrderReq,
    responses(
        (status = 200, description = "The order as saved and its new version", body = RoleOrder),
        (status = 400, description = "`order` does not list every role of the server exactly once (`List every role once`). Malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Manage roles permission, or the order moves a role you can't manage: one that does not rank below your highest role (`You can't move a role that is not below your highest role`), or while the role order is unconfirmed one with permissions you don't have (`You can't move a role that has permissions you don't have`) or one held by a member you can't moderate (`You can't move a role held by a member you can't moderate`)", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses)", body = ApiErrorBody),
        (status = 409, description = "`version` is not the current one (`The role order changed. Refresh and try again.`)", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn reorder_roles(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Json(req): Json<RoleOrderReq>,
) -> Result<Json<RoleOrder>, ApiError> {
    let access = role_guard(&state, &name, &user, Perm::ManageRoles).await?;
    let key = access.name().to_string();
    let RoleOrderReq {
        order: asked,
        version,
    } = req;
    let actor = access.audit_actor(&state.db, Perm::ManageRoles).await?;
    let mut tx = state.db.begin().await?;
    lock_server(&mut tx, &key).await?;
    let (stored, confirmed) = role_order_state(&mut *tx, &key).await?;
    if stored != version {
        return Err(order_stale());
    }
    let (mine, own) = access.role_authority_in(&mut tx, Perm::ManageRoles).await?;
    let rows = sqlx::query(
        "SELECT id, position, perms, name, display_position FROM roles WHERE server = $1 ORDER BY position DESC, id",
    )
    .bind(&key)
    .fetch_all(&mut *tx)
    .await?;
    let mut roles = Vec::with_capacity(rows.len());
    let mut names = HashMap::new();
    let mut shown = HashMap::new();
    for r in &rows {
        let id: i64 = r.try_get(0)?;
        roles.push((id, r.try_get(1)?, r.try_get(2)?));
        names.insert(id, r.try_get::<String, _>(3)?);
        shown.insert(id, r.try_get::<Option<i64>, _>(4)?);
    }
    let current: Vec<i64> = roles.iter().map(|(id, _, _)| *id).collect();
    let listed: HashSet<i64> = asked.iter().copied().collect();
    if asked.len() != current.len()
        || listed.len() != current.len()
        || current.iter().any(|id| !listed.contains(id))
    {
        return Err(ApiError::invalid("List every role once", "order"));
    }
    let bypassed = require_moves(
        &mut tx,
        &access,
        &roles,
        &current,
        &asked,
        confirmed,
        (mine, own),
    )
    .await?;
    let next = asked;
    if next == current {
        return Ok(Json(RoleOrder {
            order: next,
            version,
        }));
    }
    let actor = actor.staff_if(bypassed);
    let top = next.len() as i64;
    for (i, id) in next.iter().enumerate() {
        sqlx::query("UPDATE roles SET position = $1 WHERE id = $2 AND position <> $1")
            .bind(top - i as i64)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    bump_roles_version(&mut tx, &key).await?;
    let moved = order::moved(&current, &next);
    let named: Vec<serde_json::Value> = moved
        .iter()
        .take(REORDER_NAMED)
        .map(|id| serde_json::json!({ "id": id, "name": names.get(id) }))
        .collect();
    audit::record(
        &mut tx,
        Entry::new(&key, &actor, audit::Action::RoleReorder).details(
            Details::new().set("roles", named).set(
                "more_roles",
                moved.len().saturating_sub(REORDER_NAMED) as i64,
            ),
        ),
    )
    .await?;
    tx.commit().await?;
    state.hub.broadcast(WsEvent::RolesReordered {
        server: key,
        display: next
            .iter()
            .map(|id| shown.get(id).copied().flatten())
            .collect(),
        order: next.clone(),
        version: version + 1,
    });
    Ok(Json(RoleOrder {
        order: next,
        version: version + 1,
    }))
}

/// Confirm the role order
///
/// Makes the role order decide who may moderate whom and manage which role (see
/// `ServerDetail.roles_order_confirmed`). It stays on. `version` is the `roles_version` of the
/// order you looked at; a role created, deleted or moved since then makes it stale. Confirming an
/// order that is already confirmed changes nothing. Requires the Manage roles server permission.
/// Emits `roles_changed` to the server. General rate-limit bucket.
#[utoipa::path(
    post,
    path = "/api/v1/servers/{name}/roles/order/confirm",
    tag = "Roles",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    request_body = RoleOrderConfirmReq,
    responses(
        (status = 200, description = "The role order is confirmed", body = RoleOrderConfirmed),
        (status = 400, description = "Malformed JSON or a missing `Content-Type` (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Manage roles permission", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses)", body = ApiErrorBody),
        (status = 409, description = "`version` is not the current one (`The role order changed. Refresh and try again.`)", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn confirm_role_order(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Json(req): Json<RoleOrderConfirmReq>,
) -> Result<Json<RoleOrderConfirmed>, ApiError> {
    let access = role_guard(&state, &name, &user, Perm::ManageRoles).await?;
    let key = access.name().to_string();
    let actor = access.audit_actor(&state.db, Perm::ManageRoles).await?;
    let mut tx = state.db.begin().await?;
    lock_server(&mut tx, &key).await?;
    let (stored, confirmed) = role_order_state(&mut *tx, &key).await?;
    if stored != req.version {
        return Err(order_stale());
    }
    access.role_authority_in(&mut tx, Perm::ManageRoles).await?;
    if !confirmed {
        sqlx::query("UPDATE servers SET roles_order_confirmed = 1 WHERE name = $1")
            .bind(&key)
            .execute(&mut *tx)
            .await?;
        audit::record(
            &mut tx,
            Entry::new(&key, &actor, audit::Action::RoleOrderConfirm),
        )
        .await?;
    }
    tx.commit().await?;
    if !confirmed {
        state.hub.broadcast(WsEvent::RolesChanged { server: key });
    }
    Ok(Json(RoleOrderConfirmed { confirmed: true }))
}

/// Request body for setting the display order of roles.
#[derive(Deserialize, ToSchema)]
pub struct RoleDisplayReq {
    /// Every role id of the server once, the one shown highest first.
    order: Vec<i64>,
    /// The `roles_version` the order was made from (see `ServerDetail.roles_version`).
    version: i64,
}

/// Request body for showing roles in their role order again.
#[derive(Deserialize, ToSchema)]
pub struct RoleDisplayFollowReq {
    /// The `roles_version` of the order you looked at (see `ServerDetail.roles_version`).
    version: i64,
}

/// The roles of a server as a display reorder reads them, inside the server lock.
struct RolePlaces {
    /// Id, position and permissions of every role, the highest first.
    roles: Vec<(i64, i64, i64)>,
    /// Every role id in display order.
    display: Vec<i64>,
    /// The display position of every role.
    shown: HashMap<i64, Option<i64>>,
    names: HashMap<i64, String>,
}

async fn role_places_in(conn: &mut AnyConnection, server: &str) -> Result<RolePlaces, ApiError> {
    let rows = sqlx::query(
        "SELECT id, position, perms, name, display_position FROM roles WHERE server = $1 ORDER BY position DESC, id",
    )
    .bind(server)
    .fetch_all(&mut *conn)
    .await?;
    let mut places = RolePlaces {
        roles: Vec::with_capacity(rows.len()),
        display: Vec::new(),
        shown: HashMap::new(),
        names: HashMap::new(),
    };
    let mut looks = Vec::with_capacity(rows.len());
    for r in &rows {
        let id: i64 = r.try_get(0)?;
        let position: i64 = r.try_get(1)?;
        let shown: Option<i64> = r.try_get(4)?;
        places.roles.push((id, position, r.try_get(2)?));
        places.names.insert(id, r.try_get(3)?);
        places.shown.insert(id, shown);
        looks.push(looks::Look {
            place: shown.unwrap_or(position),
            hoist: false,
        });
    }
    places.display = looks::display_order(&looks)
        .into_iter()
        .map(|i| places.roles[i].0)
        .collect();
    Ok(places)
}

/// Saves the display positions `shown` (one per role, the highest first: `None` follows the
/// role order), audits the change from `before` to `after` and returns the event that announces
/// it.
#[allow(clippy::too_many_arguments)]
async fn save_display(
    tx: &mut AnyConnection,
    key: &str,
    actor: &audit::Actor,
    places: &RolePlaces,
    shown: Vec<Option<i64>>,
    after: &[i64],
    follow: bool,
    version: i64,
) -> Result<WsEvent, ApiError> {
    for ((id, _, _), at) in places.roles.iter().zip(&shown) {
        if places.shown.get(id).copied().flatten() != *at {
            sqlx::query("UPDATE roles SET display_position = $1 WHERE id = $2")
                .bind(*at)
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
    }
    bump_roles_version(&mut *tx, key).await?;
    let moved = order::moved(&places.display, after);
    let named: Vec<serde_json::Value> = moved
        .iter()
        .take(REORDER_NAMED)
        .map(|id| serde_json::json!({ "id": id, "name": places.names.get(id) }))
        .collect();
    audit::record(
        &mut *tx,
        Entry::new(key, actor, audit::Action::RoleDisplayOrder).details(
            Details::new()
                .set("roles", named)
                .set(
                    "more_roles",
                    moved.len().saturating_sub(REORDER_NAMED) as i64,
                )
                .set("follow", follow),
        ),
    )
    .await?;
    Ok(WsEvent::RolesReordered {
        server: key.to_string(),
        order: places.roles.iter().map(|(id, _, _)| *id).collect(),
        display: shown,
        version: version + 1,
    })
}

/// Set the display order of roles
///
/// Sets the order the server's roles show in (see `Role.display_position`): it orders the groups
/// of the member list and decides which role colors a member's name and gives it its icon.
/// `order` lists every role once, the one shown highest first. You can move only the roles you
/// could move in the role order (see `PUT /api/v1/servers/{name}/roles/order`); the others must
/// stay where they are. A new order gives every role a display position, so the display order
/// stops following the role order; the order the roles already show in changes nothing.
/// `version` is the `roles_version` the order was made from; a role created, deleted or moved
/// since then makes it stale. Requires the Manage roles server permission. Emits
/// `roles_reordered` to the server. General rate-limit bucket.
#[utoipa::path(
    put,
    path = "/api/v1/servers/{name}/roles/display_order",
    tag = "Roles",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    request_body = RoleDisplayReq,
    responses(
        (status = 200, description = "The display order as saved and the new `roles_version`", body = RoleOrder),
        (status = 400, description = "`order` does not list every role of the server exactly once (`List every role once`). Malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Manage roles permission, or the order moves a role you can't move: one that does not rank below your highest role (`You can't move a role that is not below your highest role`), or while the role order is unconfirmed one with permissions you don't have (`You can't move a role that has permissions you don't have`) or one held by a member you can't moderate (`You can't move a role held by a member you can't moderate`)", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses)", body = ApiErrorBody),
        (status = 409, description = "`version` is not the current one (`The role order changed. Refresh and try again.`)", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn set_role_display(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Json(req): Json<RoleDisplayReq>,
) -> Result<Json<RoleOrder>, ApiError> {
    let access = role_guard(&state, &name, &user, Perm::ManageRoles).await?;
    let key = access.name().to_string();
    let RoleDisplayReq {
        order: asked,
        version,
    } = req;
    let actor = access.audit_actor(&state.db, Perm::ManageRoles).await?;
    let mut tx = state.db.begin().await?;
    lock_server(&mut tx, &key).await?;
    let (stored, confirmed) = role_order_state(&mut *tx, &key).await?;
    if stored != version {
        return Err(order_stale());
    }
    let authority = access.role_authority_in(&mut tx, Perm::ManageRoles).await?;
    let places = role_places_in(&mut tx, &key).await?;
    let listed: HashSet<i64> = asked.iter().copied().collect();
    if asked.len() != places.roles.len()
        || listed.len() != places.roles.len()
        || places.roles.iter().any(|(id, _, _)| !listed.contains(id))
    {
        return Err(ApiError::invalid("List every role once", "order"));
    }
    if asked == places.display {
        return Ok(Json(RoleOrder {
            order: asked,
            version,
        }));
    }
    let bypassed = require_moves(
        &mut tx,
        &access,
        &places.roles,
        &places.display,
        &asked,
        confirmed,
        authority,
    )
    .await?;
    let top = asked.len() as i64;
    let at: HashMap<i64, i64> = asked
        .iter()
        .enumerate()
        .map(|(i, id)| (*id, top - i as i64))
        .collect();
    let shown: Vec<Option<i64>> = places
        .roles
        .iter()
        .map(|(id, _, _)| at.get(id).copied())
        .collect();
    let actor = actor.staff_if(bypassed);
    let event = save_display(
        &mut tx, &key, &actor, &places, shown, &asked, false, version,
    )
    .await?;
    tx.commit().await?;
    state.hub.broadcast(event);
    Ok(Json(RoleOrder {
        order: asked,
        version: version + 1,
    }))
}

/// Show roles in their role order
///
/// Clears the display positions of every role, so the server's roles show in their role order
/// again (see `Role.display_position`). Only allowed when every role whose place changes is one
/// you could move in the role order (see `PUT /api/v1/servers/{name}/roles/order`). `version` is
/// the `roles_version` of the order you looked at. Requires the Manage roles server permission.
/// Emits `roles_reordered` to the server. General rate-limit bucket.
#[utoipa::path(
    delete,
    path = "/api/v1/servers/{name}/roles/display_order",
    tag = "Roles",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    request_body = RoleDisplayFollowReq,
    responses(
        (status = 200, description = "The display order, now the role order, and the `roles_version`", body = RoleOrder),
        (status = 400, description = "Malformed JSON or a missing `Content-Type` (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Manage roles permission, or a role you can't move would change places: one that does not rank below your highest role (`You can't move a role that is not below your highest role`), or while the role order is unconfirmed one with permissions you don't have (`You can't move a role that has permissions you don't have`) or one held by a member you can't moderate (`You can't move a role held by a member you can't moderate`)", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses)", body = ApiErrorBody),
        (status = 409, description = "`version` is not the current one (`The role order changed. Refresh and try again.`)", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn follow_role_order(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Json(req): Json<RoleDisplayFollowReq>,
) -> Result<Json<RoleOrder>, ApiError> {
    let access = role_guard(&state, &name, &user, Perm::ManageRoles).await?;
    let key = access.name().to_string();
    let RoleDisplayFollowReq { version } = req;
    let actor = access.audit_actor(&state.db, Perm::ManageRoles).await?;
    let mut tx = state.db.begin().await?;
    lock_server(&mut tx, &key).await?;
    let (stored, confirmed) = role_order_state(&mut *tx, &key).await?;
    if stored != version {
        return Err(order_stale());
    }
    let authority = access.role_authority_in(&mut tx, Perm::ManageRoles).await?;
    let places = role_places_in(&mut tx, &key).await?;
    let rank: Vec<i64> = places.roles.iter().map(|(id, _, _)| *id).collect();
    if places.shown.values().all(Option::is_none) {
        return Ok(Json(RoleOrder {
            order: rank,
            version,
        }));
    }
    let bypassed = require_moves(
        &mut tx,
        &access,
        &places.roles,
        &places.display,
        &rank,
        confirmed,
        authority,
    )
    .await?;
    let actor = actor.staff_if(bypassed);
    let shown = vec![None; rank.len()];
    let event = save_display(&mut tx, &key, &actor, &places, shown, &rank, true, version).await?;
    tx.commit().await?;
    state.hub.broadcast(event);
    Ok(Json(RoleOrder {
        order: rank,
        version: version + 1,
    }))
}

/// Request body for changing what everyone in a server may do.
#[derive(Deserialize, ToSchema)]
pub struct EveryoneReq {
    /// The permission bits everyone holds (see `ServerDetail.everyone_perms`).
    #[schema(example = 34896478208i64)]
    perms: i64,
    /// The bits this request changes. Bits outside it keep their current value. Defaults to
    /// every bit everyone may hold.
    mask: Option<i64>,
}

/// What everyone in a server may do.
#[derive(Serialize, ToSchema)]
pub struct EveryonePerms {
    /// The permission bits everyone holds (see `ServerDetail.everyone_perms`).
    pub everyone_perms: i64,
}

/// Set what everyone may do
///
/// Changes the permission bits every member of the server holds: 131072 View channels, 262144
/// Send messages, 524288 Read history, 1048576 Add reactions, 2097152 Attach files, 4194304
/// Embed links, 8388608 Create polls, 16777216 Start threads, 33554432 Connect, 67108864 Speak,
/// 134217728 Video, 268435456 Change server profile and 34359738368 View members. Other bits
/// are left as they are. Requires the Manage roles permission, and you can only add bits you
/// hold yourself. Emits `roles_changed` to the server and removes
/// users from voice rooms they can no longer view. General rate-limit bucket.
#[utoipa::path(
    patch,
    path = "/api/v1/servers/{name}/everyone",
    tag = "Roles",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    request_body = EveryoneReq,
    responses(
        (status = 200, description = "The bits everyone holds now", body = EveryonePerms),
        (status = 400, description = "Malformed JSON or a missing `Content-Type` (plain-text 400 or 415)", content_type = "text/plain", body = String),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Manage roles permission, or the change adds a permission you don't have (`You can't grant permissions you don't have`)", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses)", body = ApiErrorBody),
        (status = 409, description = "The bits changed during this request", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn set_everyone_perms(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Json(req): Json<EveryoneReq>,
) -> Result<Json<EveryonePerms>, ApiError> {
    let access = role_guard(&state, &name, &user, Perm::ManageRoles).await?;
    let key = access.name().to_string();
    let EveryoneReq { perms, mask } = req;
    let may = mask.unwrap_or(EVERYONE_BITS) & EVERYONE_BITS;
    let db = &state.db;
    let check = async |access: &ServerAccess, before: i64, after: i64| {
        let standing = access.standing(db).await?;
        let everyone = before as Mask;
        let exempt = matches!(
            standing.who,
            Who::Staff | Who::Owner | Who::Admin { mask: 0, roles: _ }
        );
        let mine = eval::server_bits(&standing.who, everyone, &HOSTED);
        match delta::check_bits_edit(mine, exempt, everyone, after as Mask) {
            Ok(()) => Ok(()),
            Err(_) => Err(ApiError::perm(
                "You can't grant permissions you don't have",
                "rank",
            )),
        }
    };
    let stored: Option<i64> = sqlx::query("SELECT everyone_perms FROM servers WHERE name = $1")
        .bind(&key)
        .fetch_one(db)
        .await?
        .try_get(0)?;
    let before = everyone_mask(stored) as i64;
    let after = (before & !may) | (perms & may);
    check(&access, before, after).await?;
    let bypassed = match access.as_member() {
        Some(member) => check(&member, before, after).await.is_err(),
        None => false,
    };
    let actor = access
        .audit_actor(&state.db, Perm::ManageRoles)
        .await?
        .staff_if(bypassed);
    if after != before {
        let mut tx = state.db.begin().await?;
        let swapped = sqlx::query("UPDATE servers SET everyone_perms = $1 WHERE name = $2 AND COALESCE(everyone_perms, -1) = $3")
            .bind(after)
            .bind(&key)
            .bind(stored.unwrap_or(-1))
            .execute(&mut *tx)
            .await?
            .rows_affected();
        if swapped == 0 {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "Permissions changed during this request".to_string(),
                None,
            ));
        }
        audit::record(
            &mut tx,
            Entry::new(&key, &actor, audit::Action::ServerUpdate).details(
                Details::new()
                    .change("everyone_perms", before, after)
                    .perms_diff(before, after),
            ),
        )
        .await?;
        tx.commit().await?;
    }
    if after != before {
        state.hub.broadcast(WsEvent::RolesChanged {
            server: key.clone(),
        });
        voice_rules_changed(&state, &key, None).await;
    }
    Ok(Json(EveryonePerms {
        everyone_perms: after,
    }))
}

pub(crate) mod category_perms;
#[cfg(test)]
mod category_perms_tests;
#[cfg(test)]
mod looks_tests;
#[cfg(test)]
mod member_roles_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::access::{DENIED, PASSWORD_REQUIRED};
    use crate::api::test_util::{add_member, done, mem_user, temp_state};
    use crate::api::{Reason, ReasonKind};

    async fn lite_opt(db: &Db, name: &str) -> Option<ServerSummaryLite> {
        resolve_server(db, name, Some(&mem_user("root", true)), &Proof::none())
            .await
            .ok()
            .map(|a| a.lite().clone())
    }

    async fn lite_of(db: &Db, name: &str) -> ServerSummaryLite {
        lite_opt(db, name).await.expect("lite")
    }

    async fn detail_as(
        state: &AppState,
        name: &str,
        viewer: Option<&User>,
    ) -> Result<ServerDetail, ApiError> {
        let access = resolve_server(&state.db, name, viewer, &Proof::none()).await?;
        server_detail(&state.db, &state.hub, &access).await
    }

    #[tokio::test]
    async fn member_privacy_is_set_by_whoever_edits_the_server() {
        let (state, path) = temp_state("member_privacy_patch").await;
        let db = &state.db;
        let _ = make_server(&state, "club").await.expect("club");
        add_member(db, "club", "bob", 0, 0, 1).await;
        assert!(lite_of(db, "club").await.members_visible, "on by default");
        let detail = |state: AppState| async move {
            detail_as(&state, "club", Some(&mem_user("alice", false)))
                .await
                .expect("detail")
                .members_visible
        };
        assert!(detail(state.clone()).await);
        let patch = |who: &'static str, body: serde_json::Value| {
            let state = state.clone();
            async move {
                update_server(
                    State(state),
                    Authed(mem_user(who, false)),
                    Path("club".to_string()),
                    Json(serde_json::from_value(body).expect("patch")),
                )
                .await
                .map(|Json(updated)| updated.server.members_visible)
            }
        };
        let mut rx = state.hub.subscribe();
        assert!(matches!(
            patch("bob", serde_json::json!({"members_visible": false})).await,
            Err(ApiError(StatusCode::FORBIDDEN, _, _))
        ));
        assert!(lite_of(db, "club").await.members_visible, "a member can't");
        assert_eq!(
            patch("alice", serde_json::json!({"members_visible": false}))
                .await
                .ok(),
            Some(false)
        );
        assert!(!lite_of(db, "club").await.members_visible);
        assert!(!detail(state.clone()).await);
        let mut told = None;
        while let Ok(event) = rx.try_recv() {
            if let WsEvent::ServerUpdated { server } = event {
                told = Some(server.members_visible);
            }
        }
        assert_eq!(told, Some(false), "server_updated carries it");
        let logged: String = sqlx::query(
            "SELECT details FROM audit_log WHERE server = 'club' AND action = 'server.update' ORDER BY id DESC LIMIT 1",
        )
        .fetch_one(db)
        .await
        .expect("audit")
        .try_get(0)
        .expect("details");
        let logged: serde_json::Value = serde_json::from_str(&logged).expect("json");
        assert_eq!(
            logged["changes"],
            serde_json::json!([{"field": "members_visible", "before": true, "after": false}])
        );
        assert_eq!(
            patch("alice", serde_json::json!({"banner_color": "#112233"}))
                .await
                .ok(),
            Some(false),
            "left out, it stays"
        );
        assert_eq!(
            patch("alice", serde_json::json!({"members_visible": true}))
                .await
                .ok(),
            Some(true)
        );
        assert!(lite_of(db, "club").await.members_visible);
        done(state, path).await;
    }

    /// Every member list of `server` for `who` (or a guest holding `grant`), as sorted names.
    async fn member_lists(
        state: &AppState,
        who: Option<User>,
        grant: Option<&str>,
        server: &str,
    ) -> Vec<(&'static str, Vec<String>)> {
        let mut headers = HeaderMap::new();
        if let Some(grant) = grant {
            let grant = crate::api::test_util::test_grant(grant);
            headers.insert("x-guest-grant", grant.parse().expect("grant"));
        }
        let mut out = Vec::new();
        for mode in ["", "q=bo", "admins=1", "usernames=bob"] {
            let Paged(rows, _) = list_members(
                State(state.clone()),
                MaybeAuthed(who.clone()),
                headers.clone(),
                Path(server.to_string()),
                RawQuery(Some(mode.to_string())),
            )
            .await
            .expect(mode);
            let mut names: Vec<String> = rows.into_iter().map(|m| m.user.username).collect();
            names.sort();
            out.push((mode, names));
        }
        let Paged(rows, _) = list_interacted(
            State(state.clone()),
            MaybeAuthed(who),
            headers,
            Path(server.to_string()),
            Query(MembersQuery {
                offset: None,
                limit: None,
                cursor: None,
            }),
            Query(ListScope { channel_id: None }),
        )
        .await
        .expect("interacted");
        out.push(("interacted", rows.into_iter().map(|u| u.username).collect()));
        out
    }

    #[tokio::test]
    async fn a_server_that_keeps_its_members_lists_them_to_members_only() {
        let (state, path) = temp_state("member_privacy_lists").await;
        let db = &state.db;
        for name in ["alice", "bob", "carol", "erin"] {
            crate::db::NewUser::plain(name).at(1).add(db).await;
        }
        for (server, password, public) in [("club", None, 1), ("vault", Some("hash"), 0)] {
            sqlx::query("INSERT INTO servers(name, display_name, creator, password_hash, public_read, created_at) VALUES($1, $1, 'alice', $2, $3, 0)")
                .bind(server)
                .bind(password)
                .bind(public)
                .execute(db)
                .await
                .expect("server");
            add_member(db, server, "alice", 1, 0, 1).await;
            add_member(db, server, "bob", 0, 0, 2).await;
            sqlx::query(
                "INSERT INTO interactions(server, username, last_at) VALUES($1, 'erin', 3)",
            )
            .bind(server)
            .execute(db)
            .await
            .expect("interaction");
            let cid = sqlx::query_scalar(
                "INSERT INTO channels(server, name, created_at) VALUES($1, 'chat', 1) RETURNING id",
            )
            .bind(server)
            .fetch_one(db)
            .await
            .expect("channel");
            wrote(db, cid, "erin", 3, None).await;
        }
        sqlx::query("INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at) VALUES($1, 'vault', 0, 4000000000)")
            .bind(crate::db::secret_key(&crate::api::test_util::test_grant("g1")))
            .execute(db)
            .await
            .expect("grant");
        let names = |list: &[&str]| list.iter().map(|n| n.to_string()).collect::<Vec<_>>();
        let full = vec![
            ("", names(&["alice", "bob"])),
            ("q=bo", names(&["bob"])),
            ("admins=1", names(&["alice"])),
            ("usernames=bob", names(&["bob"])),
            ("interacted", names(&["erin"])),
        ];
        let none: Vec<_> = full.iter().map(|(m, _)| (*m, Vec::new())).collect();
        let user = |name: &str, admin: bool| Some(mem_user(name, admin));
        for visible in [true, false] {
            sqlx::query("UPDATE servers SET members_visible = $1")
                .bind(i64::from(visible))
                .execute(db)
                .await
                .expect("option");
            let outside = match visible {
                true => &full,
                false => &none,
            };
            let cases = [
                ("alice, a member", user("alice", false), None, "club", &full),
                ("bob, a member", user("bob", false), None, "vault", &full),
                ("root reading", user("root", true), None, "club", &full),
                (
                    "root, the staff view",
                    user("root", true),
                    None,
                    "vault",
                    &full,
                ),
                (
                    "carol, reading",
                    user("carol", false),
                    None,
                    "club",
                    outside,
                ),
                ("no token, reading", None, None, "club", outside),
                ("a guest's grant", None, Some("g1"), "vault", outside),
            ];
            for (what, who, grant, server, want) in cases {
                assert_eq!(
                    &member_lists(&state, who, grant, server).await,
                    want,
                    "{what}, members_visible {visible}"
                );
            }
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn sole_channel_guard() {
        let (state, path) = temp_state("sole_channel").await;
        let cid: i64 = sqlx::query("SELECT id FROM channels WHERE server = 'rchat'")
            .fetch_one(&state.db)
            .await
            .expect("general channel")
            .try_get(0)
            .expect("channel id");
        let blocked = delete_channel(
            State(state.clone()),
            Authed(mem_user("root", true)),
            Path(cid),
        )
        .await;
        assert!(matches!(
            blocked,
            Err(ApiError(StatusCode::BAD_REQUEST, _, _))
        ));
        let extra: i64 = sqlx::query(
            "INSERT INTO channels(server, name, created_at) VALUES('rchat', 'second', $1) RETURNING id",
        )
        .bind(now())
        .fetch_one(&state.db)
        .await
        .expect("insert channel")
        .try_get(0)
        .expect("extra id");
        let _ = delete_channel(
            State(state.clone()),
            Authed(mem_user("root", true)),
            Path(extra),
        )
        .await
        .expect("delete second channel");
        let count: i64 = sqlx::query("SELECT COUNT(*) FROM channels WHERE server = 'rchat'")
            .fetch_one(&state.db)
            .await
            .expect("count channels")
            .try_get(0)
            .expect("count");
        assert_eq!(count, 1);
        sqlx::query(
            "INSERT INTO channels(server, name, kind, created_at) VALUES('rchat', 'lounge', 'voice', $1)",
        )
        .bind(now())
        .execute(&state.db)
        .await
        .expect("insert voice channel");
        let sole_text = delete_channel(
            State(state.clone()),
            Authed(mem_user("root", true)),
            Path(cid),
        )
        .await;
        assert!(matches!(
            sole_text,
            Err(ApiError(StatusCode::BAD_REQUEST, _, _))
        ));
        done(state, path).await;
    }

    fn rejected<T>(res: Result<T, ApiError>) -> bool {
        matches!(res, Err(ApiError(StatusCode::BAD_REQUEST, _, _)))
    }

    fn capped(state: AppState, set: impl FnOnce(&mut crate::limits::Limits)) -> AppState {
        let mut limits = crate::limits::Limits::default();
        set(&mut limits);
        state.with_limits(std::sync::Arc::new(limits))
    }

    fn limit_of<T>(res: Result<T, ApiError>) -> (StatusCode, String, Option<String>) {
        match res {
            Err(ApiError(code, msg, reason)) => {
                assert_eq!(reason.as_ref().map(|r| r.kind), Some(ReasonKind::Limit));
                (code, msg, reason.and_then(|r| r.control))
            }
            Ok(_) => panic!("expected a refusal"),
        }
    }

    async fn new_channel(state: &AppState, server: &str, name: &str) -> Result<(), ApiError> {
        create_channel(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            Path(server.to_string()),
            Json(CreateChannelReq {
                name: name.to_string(),
                kind: None,
                text_only: false,
                restrict_view: false,
                category_id: None,
            }),
        )
        .await
        .map(|_| ())
    }

    #[tokio::test]
    async fn channel_cap_is_configurable() {
        let (state, path) = temp_state("server_channel_cap").await;
        let _ = make_server(&state, "cap").await.expect("server");
        let have: i64 = sqlx::query("SELECT COUNT(*) FROM channels WHERE server = 'cap'")
            .fetch_one(&state.db)
            .await
            .expect("count")
            .try_get(0)
            .expect("n");
        let two = capped(state.clone(), |l| l.server_channels_max = have + 1);
        new_channel(&two, "cap", "second")
            .await
            .expect("under the cap");
        let most = have + 1;
        assert_eq!(
            limit_of(new_channel(&two, "cap", "third").await),
            (
                StatusCode::BAD_REQUEST,
                format!("A server can have at most {most} channels"),
                Some("server_channels_max".to_string())
            )
        );
        let lower = capped(state.clone(), |l| l.server_channels_max = 1);
        assert!(new_channel(&lower, "cap", "third").await.is_err());
        let kept: i64 = sqlx::query("SELECT COUNT(*) FROM channels WHERE server = 'cap'")
            .fetch_one(&state.db)
            .await
            .expect("count")
            .try_get(0)
            .expect("n");
        assert_eq!(kept, most, "lowering the cap removes no channel");
        let raised = capped(state.clone(), |l| l.server_channels_max = most + 1);
        new_channel(&raised, "cap", "third").await.expect("raised");
        done(state, path).await;
    }

    #[tokio::test]
    async fn the_role_cap_is_configurable() {
        let (state, path) = temp_state("server_role_cap").await;
        let _ = make_server(&state, "cap").await.expect("server");
        let state = capped(state, |l| l.server_roles_max = 2);
        let role = |name: &str| {
            create_role(
                State(state.clone()),
                Authed(mem_user("alice", false)),
                Path("cap".to_string()),
                Json(RoleReq {
                    name: name.to_string(),
                    color: "#ffffff".to_string(),
                    perms: 0,
                    mentionable: false,
                }),
            )
        };
        let have: i64 = sqlx::query("SELECT COUNT(*) FROM roles WHERE server = 'cap'")
            .fetch_one(&state.db)
            .await
            .expect("count")
            .try_get(0)
            .expect("n");
        for n in have..2 {
            let _ = role(&format!("r{n}")).await.expect("under the cap");
        }
        assert_eq!(
            limit_of(role("over").await),
            (
                StatusCode::BAD_REQUEST,
                "A server can have at most 2 roles".to_string(),
                Some("server_roles_max".to_string())
            )
        );
        done(state, path).await;
    }

    /// Servers `names`, each with alice as its only member, made directly.
    async fn open_servers(db: &Db, names: &[&str]) {
        for name in names {
            sqlx::query("INSERT INTO servers(name, display_name, creator, member_count, created_at) VALUES($1, $1, 'alice', 1, 1)")
                .bind(name)
                .execute(db)
                .await
                .expect("server");
            sqlx::query("INSERT INTO members(server, username, is_admin, joined_at) VALUES($1, 'alice', 1, 1)")
                .bind(name)
                .execute(db)
                .await
                .expect("owner");
        }
    }

    async fn servers_of(db: &Db, who: &str) -> i64 {
        sqlx::query("SELECT COUNT(*) FROM members WHERE username = $1")
            .bind(who)
            .fetch_one(db)
            .await
            .expect("count")
            .try_get(0)
            .expect("n")
    }

    #[tokio::test]
    async fn joining_past_the_account_cap_is_refused() {
        let (state, path) = temp_state("account_cap_join").await;
        let db = &state.db;
        for name in ["alice", "bob"] {
            add_user(db, name, name).await;
        }
        open_servers(db, &["one", "two", "three"]).await;
        let state = capped(state, |l| l.servers_per_account = 2);
        add_member(&state.db, "rchat", "bob", 0, 0, 1).await;
        join(&state, "bob", "one").await.expect("second server");
        assert_eq!(
            limit_of(join(&state, "bob", "two").await),
            (
                StatusCode::BAD_REQUEST,
                "An account can be in at most 2 servers".to_string(),
                Some("servers_per_account".to_string())
            )
        );
        join(&state, "bob", "one")
            .await
            .expect("joining a server again is no new membership");
        assert_eq!(servers_of(&state.db, "bob").await, 2);
        done(state, path).await;
    }

    #[tokio::test]
    async fn creating_past_the_account_cap_is_refused() {
        let (state, path) = temp_state("account_cap_create").await;
        let db = &state.db;
        add_user(db, "alice", "alice").await;
        add_user(db, "root", "root").await;
        add_member(db, "rchat", "alice", 0, 0, 1).await;
        let state = capped(state, |l| l.servers_per_account = 2);
        let _ = make_server(&state, "first")
            .await
            .expect("counts as joining it");
        assert_eq!(
            limit_of(make_server(&state, "second").await),
            (
                StatusCode::BAD_REQUEST,
                "An account can be in at most 2 servers".to_string(),
                Some("servers_per_account".to_string())
            )
        );
        let req: crate::api::admin::AdminServerReq =
            serde_json::from_value(serde_json::json!({ "name": "Gift", "owner": "alice" }))
                .expect("req");
        let by_admin = crate::api::admin::create_server_for(
            State(state.clone()),
            Authed(mem_user("root", true)),
            Json(req),
        )
        .await;
        assert_eq!(
            limit_of(by_admin).2.as_deref(),
            Some("servers_per_account"),
            "a server the site admin makes for an account counts too"
        );
        assert_eq!(servers_of(&state.db, "alice").await, 2);
        let none = sqlx::query("SELECT 1 FROM servers WHERE name IN ('second', 'gift')")
            .fetch_optional(&state.db)
            .await
            .expect("servers");
        assert!(none.is_none(), "a refused server is not made");
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_full_server_refuses_joins_and_lowering_a_cap_removes_nobody() {
        let (state, path) = temp_state("server_members_cap").await;
        let db = &state.db;
        for name in ["alice", "bob", "carol", "dave"] {
            add_user(db, name, name).await;
        }
        open_servers(db, &["club"]).await;
        let three = capped(state.clone(), |l| l.server_members_max = 3);
        join(&three, "bob", "club").await.expect("second member");
        join(&three, "carol", "club").await.expect("third member");
        let full = join(&three, "dave", "club").await.expect_err("full");
        assert_eq!(
            (full.0, full.1.as_str()),
            (StatusCode::BAD_REQUEST, "This server is full")
        );
        let reason = full.2.expect("reason");
        assert_eq!(
            (reason.kind, reason.control.as_deref()),
            (ReasonKind::Capacity, Some("server_members_max"))
        );
        let one = capped(state.clone(), |l| {
            l.server_members_max = 1;
            l.servers_per_account = 1;
        });
        join(&one, "bob", "club")
            .await
            .expect("a member stays a member under a lower cap");
        let members: i64 = sqlx::query("SELECT COUNT(*) FROM members WHERE server = 'club'")
            .fetch_one(&one.db)
            .await
            .expect("count")
            .try_get(0)
            .expect("n");
        assert_eq!(members, 3, "lowering a cap removes nobody");
        assert_eq!(servers_of(&one.db, "alice").await, 1);
        done(state, path).await;
    }

    #[tokio::test]
    async fn caps_hold_under_concurrent_joins() {
        for (state, temp) in crate::api::test_util::each_db("caps_race").await {
            let db = &state.db;
            add_user(db, "alice", "alice").await;
            for n in 0..50 {
                add_user(db, &format!("u{n}"), "u").await;
            }
            let mut names: Vec<String> = (0..20).map(|n| format!("s{n}")).collect();
            names.push("club".to_string());
            let refs: Vec<&str> = names.iter().map(String::as_str).collect();
            open_servers(db, &refs).await;
            let state = capped(state, |l| {
                l.server_members_max = 10;
                l.servers_per_account = 5;
            });
            let into_club = (0..50).map(|n| {
                let state = state.clone();
                tokio::spawn(async move { join(&state, &format!("u{n}"), "club").await })
            });
            let codes: Vec<Option<StatusCode>> = futures_util::future::join_all(into_club)
                .await
                .into_iter()
                .map(|r| r.expect("task").err().map(|e| e.0))
                .collect();
            assert_eq!(
                codes.iter().filter(|c| c.is_none()).count(),
                9,
                "alice and 9 more"
            );
            assert!(
                codes
                    .iter()
                    .all(|c| matches!(c, None | Some(StatusCode::BAD_REQUEST))),
                "{codes:?}"
            );
            let in_club: i64 = sqlx::query("SELECT COUNT(*) FROM members WHERE server = 'club'")
                .fetch_one(&state.db)
                .await
                .expect("count")
                .try_get(0)
                .expect("n");
            assert_eq!(in_club, 10);
            let by_one = (0..20).map(|n| {
                let state = state.clone();
                tokio::spawn(async move { join(&state, "u49", &format!("s{n}")).await })
            });
            let codes: Vec<Option<StatusCode>> = futures_util::future::join_all(by_one)
                .await
                .into_iter()
                .map(|r| r.expect("task").err().map(|e| e.0))
                .collect();
            assert!(
                codes
                    .iter()
                    .all(|c| matches!(c, None | Some(StatusCode::BAD_REQUEST))),
                "{codes:?}"
            );
            assert_eq!(servers_of(&state.db, "u49").await, 5);
            temp.done(state).await;
        }
    }

    #[tokio::test]
    async fn the_role_cap_holds_under_concurrent_creates() {
        for (state, temp) in crate::api::test_util::each_db("role_cap_race").await {
            let _ = make_server(&state, "cap").await.expect("server");
            let have: i64 = sqlx::query("SELECT COUNT(*) FROM roles WHERE server = 'cap'")
                .fetch_one(&state.db)
                .await
                .expect("count")
                .try_get(0)
                .expect("n");
            let state = capped(state, |l| l.server_roles_max = have + 5);
            let tries = (0..20).map(|n| {
                let state = state.clone();
                tokio::spawn(async move {
                    create_role(
                        State(state),
                        Authed(mem_user("alice", false)),
                        Path("cap".to_string()),
                        Json(RoleReq {
                            name: format!("r{n}"),
                            color: "#ffffff".to_string(),
                            perms: 0,
                            mentionable: false,
                        }),
                    )
                    .await
                    .map(|_| ())
                    .map_err(|ApiError(code, _, _)| code)
                })
            });
            let answers: Vec<Result<(), StatusCode>> = futures_util::future::join_all(tries)
                .await
                .into_iter()
                .map(|r| r.expect("task"))
                .collect();
            assert_eq!(answers.iter().filter(|a| a.is_ok()).count(), 5);
            assert!(
                answers
                    .iter()
                    .all(|a| matches!(a, Ok(()) | Err(StatusCode::BAD_REQUEST)))
            );
            let after: i64 = sqlx::query("SELECT COUNT(*) FROM roles WHERE server = 'cap'")
                .fetch_one(&state.db)
                .await
                .expect("count")
                .try_get(0)
                .expect("n");
            assert_eq!(after, have + 5);
            temp.done(state).await;
        }
    }

    async fn make_server(state: &AppState, name: &str) -> Result<Json<ServerDetail>, ApiError> {
        create_server(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            Json(CreateServerReq {
                name: name.to_string(),
                password: None,
                options: ServerOptions::default(),
            }),
        )
        .await
        .map(|Json(created)| Json(created.server))
    }

    async fn rename(state: &AppState, server: &str, name: &str) -> Result<(), ApiError> {
        update_server(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            Path(server.to_string()),
            Json(ServerPatch {
                seal: Default::default(),
                name: Some(name.to_string()),
                password: None,
                protected: None,
                members: PasswordMembers::Keep,
                keep_guests: false,
                banner_color: None,
                name_color: None,
                public_read: None,
                guest_voice: None,
                guest_chat_opt_in: None,
                guest_voice_opt_in: None,
                members_visible: None,
                hide_members: None,
                join: None,
                listed: None,
                profiles_mode: None,
                description: None,
                icon_kind: None,
            }),
        )
        .await
        .map(|_| ())
    }

    #[tokio::test]
    async fn server_name_rules() {
        let (state, path) = temp_state("server_names").await;
        assert!(rejected(make_server(&state, &"é".repeat(101)).await));
        assert!(rejected(make_server(&state, ".").await));
        assert!(rejected(make_server(&state, " .. ").await));
        let long = "é".repeat(100);
        let detail = make_server(&state, &long).await.expect("100 chars ok").0;
        assert_eq!(detail.display_name, long);
        let _ = make_server(&state, "dots...")
            .await
            .expect("dots inside ok");
        assert!(rejected(rename(&state, "dots...", "..").await));
        assert!(rejected(rename(&state, "dots...", &"x".repeat(101)).await));
        rename(&state, "dots...", "a.b").await.expect("rename ok");
        done(state, path).await;
    }

    #[tokio::test]
    async fn purging_names_are_not_available_yet() {
        let (state, path) = temp_state("purging_names").await;
        let _ = make_server(&state, "gone").await.expect("gone");
        let _ = make_server(&state, "live").await.expect("live");
        sqlx::query("UPDATE servers SET password_hash = '!purging' WHERE name = 'gone'")
            .execute(&state.db)
            .await
            .expect("hide");
        let conflict = |res: Result<(), ApiError>| match res {
            Err(ApiError(StatusCode::CONFLICT, msg, _)) => msg == "That name is not available yet",
            _ => false,
        };
        assert!(conflict(make_server(&state, "Gone").await.map(|_| ())));
        assert!(conflict(rename(&state, "live", "GONE").await));
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_rename_racing_a_delete_leaves_the_hidden_server_alone() {
        let (state, path) = temp_state("rename_race").await;
        let _ = make_server(&state, "gone").await.expect("gone");
        let _ = make_server(&state, "live").await.expect("live");
        sqlx::query("UPDATE servers SET password_hash = '!purging' WHERE name = 'gone'")
            .execute(&state.db)
            .await
            .expect("hide");
        assert!(matches!(
            rename(&state, "gone", "fresh").await,
            Err(ApiError(StatusCode::NOT_FOUND, _, _))
        ));
        let mut tx = state.db.begin().await.expect("tx");
        let raced = rename_live(&mut tx, "gone", "fresh", "Fresh", Some(&None)).await;
        assert!(matches!(raced, Err(ApiError(StatusCode::NOT_FOUND, _, _))));
        drop(tx);
        let row =
            sqlx::query("SELECT name, password_hash FROM servers WHERE name IN ('gone', 'fresh')")
                .fetch_all(&state.db)
                .await
                .expect("rows");
        assert_eq!(row.len(), 1);
        assert_eq!(row[0].try_get::<String, _>(0).expect("name"), "gone");
        assert_eq!(
            row[0]
                .try_get::<Option<String>, _>(1)
                .expect("hash")
                .as_deref(),
            Some("!purging")
        );
        let mut tx = state.db.begin().await.expect("tx");
        rename_live(&mut tx, "live", "lively", "Lively", None)
            .await
            .expect("live rename");
        tx.commit().await.expect("commit");
        assert!(lite_opt(&state.db, "lively").await.is_some());
        done(state, path).await;
    }

    #[tokio::test]
    async fn channel_and_role_limits() {
        let (state, path) = temp_state("channel_limits").await;
        let _ = make_server(&state, "lim").await.expect("create server");
        let alice = || Authed(mem_user("alice", false));
        let channel = |name: String, kind: ChannelKind| {
            let state = state.clone();
            async move {
                create_channel(
                    State(state),
                    Authed(mem_user("alice", false)),
                    Path("lim".to_string()),
                    Json(CreateChannelReq {
                        name,
                        kind: Some(kind),
                        text_only: false,
                        restrict_view: false,
                        category_id: None,
                    }),
                )
                .await
            }
        };
        assert!(rejected(channel("c".repeat(101), ChannelKind::Text).await));
        let text = channel("😀".repeat(100), ChannelKind::Text)
            .await
            .expect("100 emoji ok")
            .0;
        let voice = channel("lounge".to_string(), ChannelKind::Voice)
            .await
            .expect("voice")
            .0;
        let slow = |id: i64, secs: i64| {
            let state = state.clone();
            async move {
                update_channel(
                    State(state),
                    Authed(mem_user("alice", false)),
                    Path(id),
                    Json(ChannelPatch {
                        slowmode_seconds: Some(secs),
                        ..Default::default()
                    }),
                )
                .await
            }
        };
        assert!(rejected(slow(text.id, -1).await));
        assert!(rejected(slow(text.id, SLOWMODE_MAX + 1).await));
        assert_eq!(
            slow(text.id, SLOWMODE_MAX)
                .await
                .expect("max slowmode")
                .0
                .slowmode_seconds,
            SLOWMODE_MAX
        );
        assert!(rejected(slow(voice.id, 5).await));
        let _ = slow(voice.id, 0).await.expect("zero on voice ok");
        let renamed = update_channel(
            State(state.clone()),
            alice(),
            Path(text.id),
            Json(ChannelPatch {
                name: Some("x".repeat(101)),
                ..Default::default()
            }),
        )
        .await;
        assert!(rejected(renamed));
        let role = |name: String| {
            let state = state.clone();
            async move {
                create_role(
                    State(state),
                    Authed(mem_user("alice", false)),
                    Path("lim".to_string()),
                    Json(RoleReq {
                        name,
                        color: "#ffffff".to_string(),
                        perms: 0,
                        mentionable: false,
                    }),
                )
                .await
            }
        };
        assert!(rejected(role("r".repeat(101)).await));
        let made = role("r".repeat(100)).await.expect("100 char role").0;
        let patched = update_role(
            State(state.clone()),
            alice(),
            Path(("lim".to_string(), made.id)),
            Json(RolePatch {
                mask: Some(ALL_PERMS),
                name: Some("r".repeat(101)),
                color: None,
                perms: None,
                mentionable: None,
                icon: None,
                hoist: None,
                color_names: None,
            }),
        )
        .await;
        assert!(rejected(patched));
        done(state, path).await;
    }

    async fn my_servers(state: &AppState, raw: &str) -> Vec<String> {
        list_my_servers(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            RawQuery(Some(raw.to_string()).filter(|r| !r.is_empty())),
        )
        .await
        .expect("my servers")
        .0
        .into_iter()
        .map(|s| s.name)
        .collect()
    }

    #[tokio::test]
    async fn my_servers_order_paging_and_batch() {
        let (state, path) = temp_state("my_servers").await;
        let db = &state.db;
        for (name, joined) in [
            ("s1", 3),
            ("s2", 1),
            ("s4", 2),
            ("s3", 2),
            ("s5", 5),
            ("foo, bar", 6),
            ("a&b=c+d", 7),
        ] {
            sqlx::query("INSERT INTO servers(name, display_name, creator, created_at) VALUES($1, $1, NULL, 0)")
                .bind(name)
                .execute(db)
                .await
                .expect("insert server");
            add_member(db, name, "alice", i64::from(name == "s3"), 0, joined).await;
        }
        add_member(db, "rchat", "bob", 0, 0, 0).await;
        let all = vec!["s2", "s3", "s4", "s1", "s5", "foo, bar", "a&b=c+d"];
        assert_eq!(my_servers(&state, "").await, all);
        assert_eq!(my_servers(&state, "offset=1&limit=2").await, all[1..3]);
        assert_eq!(my_servers(&state, "offset=6&limit=2").await, all[6..]);
        assert!(my_servers(&state, "offset=7").await.is_empty());
        let named = my_servers(
            &state,
            "names=S5&names=s1&names=rchat&names=nope&names=s1&names=&names=%20s2",
        )
        .await;
        assert_eq!(named, vec!["s1", "s5"]);
        let named = my_servers(&state, "names=Foo%2C%20Bar&names=a%26b%3Dc%2Bd&names=foo").await;
        assert_eq!(named, vec!["foo, bar", "a&b=c+d"]);
        let many: Vec<String> = (0..150).map(|n| format!("names=x{n}")).collect();
        let capped = format!("{}&names=s1", many[..99].join("&"));
        assert_eq!(my_servers(&state, &capped).await, vec!["s1"]);
        let capped = format!("{}&names=s1", many.join("&"));
        assert!(my_servers(&state, &capped).await.is_empty());
        assert!(
            list_my_servers(
                State(state.clone()),
                Authed(mem_user("alice", false)),
                RawQuery(Some("offset=x".to_string())),
            )
            .await
            .is_err()
        );
        let first = my_servers_page(db, "alice", 0, None, 4)
            .await
            .expect("page");
        assert_eq!(first.items.len(), 4);
        assert!(first.more);
        assert!(first.items[1].is_admin && !first.items[0].is_admin);
        let rest = my_servers_page(db, "alice", 0, first.next.as_deref(), 4)
            .await
            .expect("page");
        let all = my_servers_page(db, "alice", 0, None, 7)
            .await
            .expect("page");
        assert!(!all.more && all.next.is_none());
        let names = |p: &[ServerSummary]| p.iter().map(|s| s.name.clone()).collect::<Vec<_>>();
        assert_eq!(
            [names(&first.items), names(&rest.items)].concat(),
            names(&all.items)
        );
        assert!(!rest.more);
        done(state, path).await;
    }

    async fn add_user(db: &Db, username: &str, display_name: &str) {
        crate::db::NewUser::plain(username)
            .shown(display_name)
            .add(db)
            .await;
    }

    async fn count(db: &Db, sql: &str) -> i64 {
        sqlx::query(sqlx::AssertSqlSafe(sql))
            .fetch_one(db)
            .await
            .expect("count query")
            .try_get(0)
            .expect("count value")
    }

    async fn join(state: &AppState, who: &str, server: &str) -> Result<(), ApiError> {
        join_server(
            State(state.clone()),
            Authed(mem_user(who, false)),
            Path(server.to_string()),
            None,
        )
        .await
        .map(|_| ())
    }

    async fn crowd_server(state: &AppState, users: usize) -> Vec<String> {
        let db = &state.db;
        add_user(db, "alice", "Alice").await;
        sqlx::query("INSERT INTO servers(name, display_name, creator, created_at) VALUES('club', 'Club', 'alice', 1)")
            .execute(db)
            .await
            .expect("server");
        sqlx::query("INSERT INTO channels(server, name, created_at) VALUES('club', 'general', 1)")
            .execute(db)
            .await
            .expect("channel");
        add_member(db, "club", "alice", 1, 0, 1).await;
        let names: Vec<String> = (0..users).map(|n| format!("u{n:02}")).collect();
        for name in &names {
            add_user(db, name, name).await;
        }
        names
    }

    async fn all_ok<T>(jobs: Vec<tokio::task::JoinHandle<Result<T, ApiError>>>) {
        for job in jobs {
            if let Err(ApiError(code, msg, _)) = job.await.expect("task") {
                panic!("{code}: {msg}");
            }
        }
    }

    async fn leave(state: &AppState, who: &str) -> Result<(), ApiError> {
        leave_server(
            State(state.clone()),
            Authed(mem_user(who, false)),
            Path("club".to_string()),
        )
        .await
        .map(|_| ())
    }

    async fn kick(state: &AppState, target: &str) -> Result<(), ApiError> {
        kick_member(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            Path("club".to_string()),
            Json(UsernameReq {
                username: target.to_string(),
            }),
        )
        .await
        .map(|_| ())
    }

    async fn join_crowd(state: &AppState) {
        let db = &state.db;
        let names = crowd_server(state, 60).await;
        let jobs = names
            .iter()
            .map(|name| {
                let (state, name) = (state.clone(), name.clone());
                tokio::spawn(async move { join(&state, &name, "club").await })
            })
            .collect();
        all_ok(jobs).await;
        let members = "SELECT COUNT(*) FROM members WHERE server = 'club'";
        assert_eq!(count(db, members).await, 61);
        assert_eq!(
            count(db, "SELECT member_count FROM servers WHERE name = 'club'").await,
            61
        );
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM messages WHERE kind = 'join' AND channel_id IN (SELECT id FROM channels WHERE server = 'club')").await,
            crate::api::system_messages::SERVER_NOTICES_MAX,
            "the server lock still lets only the limit of join messages through"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 8)]
    async fn sixty_concurrent_joins_into_one_server_all_succeed() {
        let (state, path) = temp_state("join_crowd").await;
        join_crowd(&state).await;
        done(state, path).await;
        if let Some((state, pg)) = crate::api::test_util::pg_state("join_crowd").await {
            join_crowd(&state).await;
            crate::api::test_util::pg_done(state, pg).await;
        }
    }

    async fn churn_crowd(state: &AppState) {
        let db = &state.db;
        let names = crowd_server(state, 70).await;
        for name in &names[..40] {
            join(state, name, "club").await.expect("first join");
        }
        let racing: Vec<String> = names[60..].to_vec();
        for name in &racing[..5] {
            join(state, name, "club").await.expect("first join");
        }
        let mut jobs = Vec::new();
        for (k, name) in names.iter().enumerate() {
            let (state, name) = (state.clone(), name.clone());
            jobs.push(tokio::spawn(async move {
                match k {
                    0..20 => leave(&state, &name).await,
                    20..30 => kick(&state, &name).await,
                    30..35 => ban(&state, mem_user("alice", false), "club", &name).await,
                    35..40 => Ok(()),
                    _ => join(&state, &name, "club").await,
                }
            }));
        }
        let mut racers = Vec::new();
        for name in &racing {
            let (state, name) = (state.clone(), name.clone());
            racers.push(tokio::spawn(async move {
                match leave(&state, &name).await {
                    Err(ApiError(StatusCode::BAD_REQUEST, _, _)) => Ok(()),
                    other => other,
                }
            }));
        }
        all_ok(jobs).await;
        all_ok(racers).await;
        let settled = "SELECT COUNT(*) FROM members WHERE server = 'club' AND username NOT IN ('u60', 'u61', 'u62', 'u63', 'u64', 'u65', 'u66', 'u67', 'u68', 'u69')";
        assert_eq!(count(db, settled).await, 1 + 5 + 20);
        assert_eq!(
            count(db, "SELECT member_count FROM servers WHERE name = 'club'").await,
            count(db, "SELECT COUNT(*) FROM members WHERE server = 'club'").await
        );
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM server_bans WHERE server = 'club'").await,
            5
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 8)]
    async fn member_count_stays_right_through_concurrent_joins_and_leaves() {
        let (state, path) = temp_state("join_churn").await;
        churn_crowd(&state).await;
        done(state, path).await;
        if let Some((state, pg)) = crate::api::test_util::pg_state("join_churn").await {
            churn_crowd(&state).await;
            crate::api::test_util::pg_done(state, pg).await;
        }
    }

    async fn revoke_during_guest_access(state: &AppState) {
        let db = &state.db;
        let _ = make_server(state, "club").await.expect("club");
        set_password(state, "club-password").await;
        let body = serde_json::json!({ "password": "tickets-please", "max_uses": 5 });
        let Json(created) = crate::api::passwords::create_password(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            Path("club".to_string()),
            Json(serde_json::from_value(body).expect("body")),
        )
        .await
        .expect("extra password");
        let id = created.info.id;
        for n in 0..3 {
            sqlx::query("INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at, password_id) VALUES($1, 'club', 1, 1, $2)")
                .bind(crate::db::secret_key(&format!("stale-{n}")))
                .bind(id)
                .execute(db)
                .await
                .expect("stale grant");
        }
        let access = resolve_server(db, "club", None, &Proof::password(Some("tickets-please")))
            .await
            .expect("guest access");
        let mut tx = db.begin().await.expect("tx");
        lock_server(&mut tx, "club").await.expect("lock");
        sqlx::query("DELETE FROM guest_grants WHERE server = $1 AND COALESCE(password_id, 0) = $2 AND last_used_at < $3 AND (last_used_at > 0 OR created_at < $3)")
            .bind("club")
            .bind(id)
            .bind(now())
            .execute(&mut *tx)
            .await
            .expect("stale grants of the password");
        let revoke = {
            let state = state.clone();
            tokio::spawn(async move {
                crate::api::passwords::revoke_password(
                    State(state),
                    Authed(mem_user("alice", false)),
                    Path(("club".to_string(), id)),
                )
                .await
                .map(|_| ())
            })
        };
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        access
            .spend_ticket(&mut tx)
            .await
            .expect("the guest spends a use while the revoke waits");
        tx.commit().await.expect("commit");
        all_ok(vec![revoke]).await;
        assert_eq!(
            count(db, &format!("SELECT COUNT(*) FROM server_passwords WHERE id = {id} AND revoked_at IS NOT NULL AND uses = 1")).await,
            1
        );
        assert_eq!(
            count(
                db,
                &format!("SELECT COUNT(*) FROM guest_grants WHERE password_id = {id}")
            )
            .await,
            0
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn revoking_a_password_while_a_guest_uses_it_does_not_deadlock() {
        let (state, path) = temp_state("revoke_race").await;
        revoke_during_guest_access(&state).await;
        done(state, path).await;
        if let Some((state, pg)) = crate::api::test_util::pg_state("revoke_race").await {
            revoke_during_guest_access(&state).await;
            crate::api::test_util::pg_done(state, pg).await;
        }
    }

    async fn ban(
        state: &AppState,
        actor: User,
        server: &str,
        target: &str,
    ) -> Result<(), ApiError> {
        ban_member(
            State(state.clone()),
            Authed(actor),
            Path(server.to_string()),
            Json(BanReq::forever(target)),
        )
        .await
        .map(|_| ())
    }

    async fn unban(
        state: &AppState,
        actor: User,
        server: &str,
        target: &str,
    ) -> Result<(), ApiError> {
        unban_member(
            State(state.clone()),
            Authed(actor),
            Path((server.to_string(), target.to_string())),
        )
        .await
        .map(|_| ())
    }

    async fn bans(
        state: &AppState,
        actor: User,
        server: &str,
        offset: Option<i64>,
    ) -> Result<Vec<(String, String, i64)>, ApiError> {
        list_bans(
            State(state.clone()),
            Authed(actor),
            Path(server.to_string()),
            Query(MembersQuery {
                offset,
                limit: None,
                cursor: None,
            }),
        )
        .await
        .map(|Paged(list, _)| {
            list.into_iter()
                .map(|b| (b.user.username, b.user.display_name, b.banned_at))
                .collect()
        })
    }

    fn status<T>(res: Result<T, ApiError>) -> Option<StatusCode> {
        res.err().map(|ApiError(code, _, _)| code)
    }

    fn kicks(rx: &mut tokio::sync::broadcast::Receiver<WsEvent>) -> Vec<(String, String, bool)> {
        let mut out = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            match ev {
                WsEvent::MemberKicked {
                    server,
                    username,
                    banned,
                } => out.push((server, username, banned)),
                WsEvent::MembersPurged { server, usernames } => {
                    out.extend(usernames.into_iter().map(|u| (server.clone(), u, false)))
                }
                _ => {}
            }
        }
        out
    }

    #[tokio::test]
    async fn ban_removes_membership_and_blocks_rejoin() {
        let (state, path) = temp_state("ban_rejoin").await;
        let db = &state.db;
        let cid = make_server(&state, "club").await.expect("club").0.channels[0].id;
        add_user(db, "bob", "Bob").await;
        join(&state, "bob", "club").await.expect("bob joins");
        let role: i64 = sqlx::query("INSERT INTO roles(server, name, color, perms) VALUES('club', 'r', '#ffffff', 0) RETURNING id")
            .fetch_one(db)
            .await
            .expect("role")
            .try_get(0)
            .expect("role id");
        sqlx::query("INSERT INTO user_roles(server, username, role_id) VALUES('club', 'bob', $1)")
            .bind(role)
            .execute(db)
            .await
            .expect("assign");
        let _ = state.hub.voice_join("bob", 7, "club", cid).await;
        let mut rx = state.hub.subscribe();
        ban(&state, mem_user("alice", false), "Club", "Bob")
            .await
            .expect("ban bob");
        let bob_rows = |table: &str| {
            format!("SELECT COUNT(*) FROM {table} WHERE server = 'club' AND username = 'bob'")
        };
        assert_eq!(count(db, &bob_rows("members")).await, 0);
        assert_eq!(count(db, &bob_rows("user_roles")).await, 0);
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM server_bans WHERE server = 'club' AND username = 'bob' AND banned_by = 'alice'").await,
            1
        );
        assert_eq!(
            kicks(&mut rx),
            vec![("club".to_string(), "bob".to_string(), true)]
        );
        assert!(state.hub.rooms_in("club", None).is_empty());
        match join(&state, "bob", "club").await {
            Err(ApiError(StatusCode::FORBIDDEN, msg, _)) => {
                assert_eq!(msg, "You are banned from this server")
            }
            _ => panic!("expected banned join rejection"),
        }
        assert_eq!(count(db, &bob_rows("members")).await, 0);
        ban(&state, mem_user("alice", false), "club", "bob")
            .await
            .expect("re-ban is a no-op");
        assert_eq!(count(db, &bob_rows("server_bans")).await, 1);
        assert!(kicks(&mut rx).is_empty());
        unban(&state, mem_user("alice", false), "club", "BOB")
            .await
            .expect("unban");
        assert_eq!(
            status(unban(&state, mem_user("alice", false), "club", "bob").await),
            Some(StatusCode::NOT_FOUND)
        );
        join(&state, "bob", "club").await.expect("bob rejoins");
        assert_eq!(count(db, &bob_rows("members")).await, 1);
        done(state, path).await;
    }

    #[tokio::test]
    async fn ban_permissions_and_targets() {
        let (state, path) = temp_state("ban_perms").await;
        let db = &state.db;
        let cid = make_server(&state, "club").await.expect("club").0.channels[0].id;
        for name in ["bob", "carol", "dave", "erin"] {
            add_user(db, name, name).await;
        }
        for name in ["bob", "carol", "dave"] {
            join(&state, name, "club").await.expect("join");
        }
        let plain = || mem_user("carol", false);
        assert_eq!(
            status(ban(&state, plain(), "club", "bob").await),
            Some(StatusCode::FORBIDDEN)
        );
        assert_eq!(
            status(bans(&state, plain(), "club", None).await),
            Some(StatusCode::FORBIDDEN)
        );
        let role: i64 = sqlx::query("INSERT INTO roles(server, name, color, perms) VALUES('club', 'mod', '#ffffff', $1) RETURNING id")
            .bind(Perm::Kick as i64)
            .fetch_one(db)
            .await
            .expect("role")
            .try_get(0)
            .expect("role id");
        sqlx::query("INSERT INTO user_roles(server, username, role_id) VALUES('club', 'dave', $1)")
            .bind(role)
            .execute(db)
            .await
            .expect("assign");
        let moderator = || mem_user("dave", false);
        ban(&state, moderator(), "club", "bob")
            .await
            .expect("kick-perm role can ban");
        assert_eq!(
            status(unban(&state, plain(), "club", "bob").await),
            Some(StatusCode::FORBIDDEN)
        );
        assert_eq!(
            status(ban(&state, moderator(), "club", "ghost").await),
            None,
            "a name with no account is banned like an account that is not a member"
        );
        assert_eq!(
            status(ban(&state, moderator(), "nowhere", "bob").await),
            Some(StatusCode::NOT_FOUND)
        );
        let _ = state.hub.voice_join("erin", 9, "club", cid).await;
        let mut rx = state.hub.subscribe();
        ban(&state, moderator(), "club", "erin")
            .await
            .expect("non-member ban");
        assert!(kicks(&mut rx).is_empty());
        assert!(state.hub.rooms_in("club", None).is_empty());
        assert_eq!(
            status(join(&state, "erin", "club").await),
            Some(StatusCode::FORBIDDEN)
        );
        let _ = kick_member(
            State(state.clone()),
            Authed(moderator()),
            Path("club".to_string()),
            Json(UsernameReq {
                username: "carol".to_string(),
            }),
        )
        .await
        .expect("kick");
        assert_eq!(
            kicks(&mut rx),
            vec![("club".to_string(), "carol".to_string(), false)]
        );
        join(&state, "carol", "club")
            .await
            .expect("kicked may rejoin");
        let root = || mem_user("root", true);
        let listed: Vec<String> = bans(&state, root(), "club", None)
            .await
            .expect("site admin lists")
            .into_iter()
            .map(|(name, _, _)| name)
            .collect();
        assert_eq!(listed.len(), 3);
        for name in ["bob", "erin", "ghost"] {
            assert!(listed.contains(&name.to_string()), "{name}");
        }
        unban(&state, root(), "club", "erin")
            .await
            .expect("site admin unbans");
        join(&state, "erin", "club").await.expect("erin joins");
        done(state, path).await;
    }

    async fn moderate(
        state: &AppState,
        actor: User,
        target: &str,
        banning: bool,
    ) -> Result<String, (StatusCode, String)> {
        let path = Path("club".to_string());
        let body = Json(UsernameReq {
            username: target.to_string(),
        });
        let json = |v: serde_json::Value| v.to_string();
        let res = match banning {
            true => ban_member(
                State(state.clone()),
                Authed(actor),
                path,
                Json(BanReq::forever(target)),
            )
            .await
            .map(|Json(done)| json(serde_json::json!({ "ok": done.ok }))),
            false => kick_member(State(state.clone()), Authed(actor), path, body)
                .await
                .map(|Json(ok)| serde_json::to_string(&ok).expect("json")),
        };
        res.map_err(|ApiError(code, msg, _)| (code, msg))
    }

    async fn set_admin_row(db: &Db, username: &str, perms: i64) {
        sqlx::query(
            "UPDATE members SET is_admin = 1, perms = $1 WHERE server = 'club' AND username = $2",
        )
        .bind(perms)
        .bind(username)
        .execute(db)
        .await
        .expect("make admin");
    }

    #[tokio::test]
    async fn moderation_needs_strictly_more_perms() {
        let (state, path) = temp_state("mod_rule").await;
        let db = &state.db;
        let _ = make_server(&state, "club").await.expect("club");
        let names = [
            "alice", "bob", "carol", "dave", "erin", "frank", "gina", "root", "su",
        ];
        for name in names {
            add_user(db, name, name).await;
        }
        for name in &names[1..8] {
            join(&state, name, "club").await.expect("join");
        }
        sqlx::query("UPDATE users SET is_site_admin = 1 WHERE username IN ('root', 'su')")
            .execute(db)
            .await
            .expect("site admins");
        let role: i64 = sqlx::query("INSERT INTO roles(server, name, color, perms) VALUES('club', 'mod', '#ffffff', $1) RETURNING id")
            .bind(Perm::Kick as i64)
            .fetch_one(db)
            .await
            .expect("role")
            .try_get(0)
            .expect("role id");
        for name in ["carol", "dave", "root"] {
            sqlx::query("INSERT INTO user_roles(server, username, role_id) VALUES('club', $1, $2)")
                .bind(name)
                .bind(role)
                .execute(db)
                .await
                .expect("assign");
        }
        let narrow = Perm::Kick as i64 | Perm::DeleteMessages as i64;
        set_admin_row(db, "erin", narrow).await;
        set_admin_row(db, "gina", Perm::DeleteMessages as i64).await;
        set_admin_row(db, "frank", 0).await;
        let carol = || mem_user("carol", false);
        let alice = || mem_user("alice", false);
        let denied = Err((
            StatusCode::FORBIDDEN,
            "You can't moderate this member".to_string(),
        ));
        for banning in [false, true] {
            for target in ["alice", "frank", "erin", "dave", "root"] {
                assert_eq!(
                    moderate(&state, carol(), target, banning).await,
                    denied,
                    "carol vs {target} banning {banning}"
                );
            }
        }
        sqlx::query("DELETE FROM user_roles WHERE server = 'club' AND username = 'root'")
            .execute(db)
            .await
            .expect("drop root role");
        let plain = moderate(&state, carol(), "bob", false)
            .await
            .expect("kick plain");
        assert_eq!(
            moderate(&state, carol(), "root", false).await,
            Ok(plain.clone())
        );
        join(&state, "bob", "club").await.expect("bob rejoins");
        join(&state, "root", "club").await.expect("root rejoins");
        let banned = moderate(&state, carol(), "bob", true)
            .await
            .expect("ban plain");
        assert_eq!(moderate(&state, carol(), "root", true).await, Ok(banned));
        assert_eq!(
            status(join(&state, "root", "club").await),
            Some(StatusCode::FORBIDDEN)
        );
        moderate(&state, alice(), "erin", false)
            .await
            .expect("full admin kicks narrower admin");
        moderate(&state, alice(), "gina", true)
            .await
            .expect("full admin bans narrower admin");
        assert_eq!(moderate(&state, alice(), "frank", false).await, denied);
        set_admin_row(db, "alice", Perm::Kick as i64).await;
        moderate(&state, mem_user("frank", false), "alice", false)
            .await
            .expect("creator has no protection");
        let su = || mem_user("su", true);
        moderate(&state, su(), "frank", false)
            .await
            .expect("site admin kicks full admin");
        moderate(&state, su(), "dave", true)
            .await
            .expect("site admin bans peer");
        let own = Err((
            StatusCode::BAD_REQUEST,
            "You can't ban yourself".to_string(),
        ));
        assert_eq!(moderate(&state, carol(), "Carol", true).await, own);
        assert_eq!(moderate(&state, su(), "su", true).await, own);
        assert_eq!(
            count(
                db,
                "SELECT COUNT(*) FROM server_bans WHERE username IN ('carol', 'su')"
            )
            .await,
            0
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn join_rejects_a_ban_that_lands_before_insert() {
        let (state, path) = temp_state("join_race").await;
        let db = &state.db;
        let _ = make_server(&state, "club").await.expect("club");
        sqlx::query("INSERT INTO server_bans(server, username, banned_by, created_at) VALUES('club', 'bob', 'alice', 0)")
            .execute(db)
            .await
            .expect("ban after check");
        let club = resolve_server(db, "club", Some(&mem_user("alice", false)), &Proof::none())
            .await
            .expect("club");
        match insert_member(db, &state.limits, &club, "bob").await {
            Err(ApiError(StatusCode::FORBIDDEN, msg, _)) => {
                assert_eq!(msg, "You are banned from this server")
            }
            _ => panic!("expected banned insert rejection"),
        }
        assert_eq!(
            count(
                db,
                "SELECT COUNT(*) FROM members WHERE server = 'club' AND username = 'bob'"
            )
            .await,
            0
        );
        assert!(
            insert_member(db, &state.limits, &club, "alice")
                .await
                .expect("already a member")
                .is_none()
        );
        assert!(
            insert_member(db, &state.limits, &club, "carol")
                .await
                .expect("new member")
                .is_some()
        );
        assert!(
            insert_member(db, &state.limits, &club, "carol")
                .await
                .expect("repeat join")
                .is_none()
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn ban_list_pages_newest_first() {
        let (state, path) = temp_state("ban_pages").await;
        let db = &state.db;
        let _ = make_server(&state, "club").await.expect("club");
        add_user(db, "u54", "Fifty Four").await;
        for i in 0..55 {
            sqlx::query("INSERT INTO server_bans(server, username, banned_by, created_at) VALUES('club', $1, 'alice', $2)")
                .bind(format!("u{i:02}"))
                .bind(1000 + i)
                .execute(db)
                .await
                .expect("insert ban");
        }
        let alice = || mem_user("alice", false);
        let first = bans(&state, alice(), "club", None).await.expect("page 1");
        assert_eq!(first.len(), 50);
        assert_eq!(
            first[0],
            ("u54".to_string(), "Fifty Four".to_string(), 1054)
        );
        assert_eq!(first[1], ("u53".to_string(), "u53".to_string(), 1053));
        assert_eq!(first[49].0, "u05");
        let rest: Vec<String> = bans(&state, alice(), "club", Some(50))
            .await
            .expect("page 2")
            .into_iter()
            .map(|(name, _, _)| name)
            .collect();
        assert_eq!(rest, vec!["u04", "u03", "u02", "u01", "u00"]);
        assert!(
            bans(&state, alice(), "club", Some(55))
                .await
                .expect("past end")
                .is_empty()
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn members_batch_refs_and_roles() {
        let (state, path) = temp_state("members_batch").await;
        let db = &state.db;
        crate::db::NewUser::plain("alice")
            .shown("Alice A")
            .color("#abcdef")
            .add(db)
            .await;
        for name in ["alice", "bob", "carol"] {
            add_member(db, "rchat", name, 0, 0, 0).await;
        }
        let mut roles = Vec::new();
        for name in ["r1", "r2"] {
            let id: i64 = sqlx::query("INSERT INTO roles(server, name, color, perms) VALUES('rchat', $1, '#ffffff', 0) RETURNING id")
                .bind(name)
                .fetch_one(db)
                .await
                .expect("role")
                .try_get(0)
                .expect("role id");
            roles.push(id);
        }
        for (user, role) in [("bob", roles[1]), ("bob", roles[0]), ("carol", roles[1])] {
            sqlx::query(
                "INSERT INTO user_roles(server, username, role_id) VALUES('rchat', $1, $2)",
            )
            .bind(user)
            .bind(role)
            .execute(db)
            .await
            .expect("assign");
        }
        let fetch = |raw: &str| {
            let state = state.clone();
            let raw = raw.to_string();
            async move {
                list_members(
                    State(state),
                    MaybeAuthed(None),
                    HeaderMap::new(),
                    Path("rchat".to_string()),
                    RawQuery(Some(raw)),
                )
                .await
                .map(|members| {
                    members
                        .0
                        .into_iter()
                        .map(|m| (m.user.username, m.user.display_name, m.role_ids))
                        .collect::<Vec<(String, String, Vec<i64>)>>()
                })
            }
        };
        let all = vec![
            ("alice".to_string(), "Alice A".to_string(), vec![]),
            ("bob".to_string(), "bob".to_string(), roles.clone()),
            ("carol".to_string(), "carol".to_string(), vec![roles[1]]),
        ];
        assert_eq!(fetch("").await.expect("members"), all);
        assert_eq!(fetch("offset=1&limit=1").await.expect("page"), all[1..2]);
        let picked = fetch("usernames=CAROL&usernames=nobody&usernames=alice&usernames=carol")
            .await
            .expect("by name");
        assert_eq!(picked, vec![all[0].clone(), all[2].clone()]);
        assert!(fetch("usernames=").await.expect("empty name").is_empty());
        let many: Vec<String> = (0..150).map(|n| format!("usernames=x{n}")).collect();
        let capped = fetch(&format!("{}&usernames=bob", many[..99].join("&")))
            .await
            .expect("under cap");
        assert_eq!(capped, vec![all[1].clone()]);
        let over = fetch(&format!("{}&usernames=bob", many.join("&")))
            .await
            .expect("over cap");
        assert!(over.is_empty());
        assert!(rejected(fetch("offset=x").await));
        sqlx::query("UPDATE servers SET password_hash = 'x' WHERE name = 'rchat'")
            .execute(db)
            .await
            .expect("lock server");
        assert!(matches!(
            fetch("usernames=bob").await,
            Err(ApiError(StatusCode::NOT_FOUND, m, _)) if m == DENIED
        ));
        done(state, path).await;
    }

    async fn invite_as(
        state: &AppState,
        viewer: Option<User>,
        server: &str,
        password: Option<&str>,
        grant: Option<&str>,
    ) -> Result<Invite, ApiError> {
        let mut headers = HeaderMap::new();
        if let Some(password) = password {
            let encoded =
                percent_encoding::utf8_percent_encode(password, percent_encoding::NON_ALPHANUMERIC)
                    .to_string();
            headers.insert(
                "x-invite-password",
                encoded.parse().expect("password header"),
            );
        }
        if let Some(grant) = grant {
            headers.insert("x-guest-grant", grant.parse().expect("grant header"));
        }
        get_invite(
            State(state.clone()),
            MaybeAuthed(viewer),
            headers,
            Path(server.to_string()),
            Query(InvitePreviewQuery::default()),
        )
        .await
        .map(|Json(invite)| invite)
    }

    async fn status_of(
        state: &AppState,
        viewer: Option<User>,
        password: Option<&str>,
    ) -> InviteStatus {
        invite_as(state, viewer, "club", password, None)
            .await
            .expect("invite")
            .status
    }

    async fn set_password(state: &AppState, password: &str) {
        let _ = update_server(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            Path("club".to_string()),
            Json(ServerPatch {
                seal: Default::default(),
                name: None,
                password: Some(password.to_string()),
                protected: None,
                members: PasswordMembers::Keep,
                keep_guests: false,
                banner_color: None,
                name_color: None,
                public_read: None,
                guest_voice: None,
                guest_chat_opt_in: None,
                guest_voice_opt_in: None,
                members_visible: None,
                hide_members: None,
                join: None,
                listed: None,
                profiles_mode: None,
                description: None,
                icon_kind: None,
            }),
        )
        .await
        .expect("set password");
    }

    async fn insert_grant(db: &Db, server: &str) -> String {
        let grant = new_token();
        sqlx::query("INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at) VALUES($1, $2, 0, 4000000000)")
            .bind(crate::db::secret_key(&grant))
            .bind(server)
            .execute(db)
            .await
            .expect("insert grant");
        grant
    }

    #[tokio::test]
    async fn banned_users_cannot_read_an_open_server() {
        let (state, path) = temp_state("ban_hides").await;
        let db = &state.db;
        let _ = make_server(&state, "Club").await.expect("club");
        add_user(db, "carol", "Carol").await;
        add_user(db, "dave", "Dave").await;
        let mut rx = state.hub.subscribe();
        ban(&state, mem_user("alice", false), "club", "carol")
            .await
            .expect("ban carol");
        let mut notices = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            match ev {
                WsEvent::ServerBanned { server, username } => notices.push((server, username)),
                WsEvent::MemberKicked { .. } => panic!("carol was never a member"),
                _ => {}
            }
        }
        assert_eq!(notices, vec![("club".to_string(), "carol".to_string())]);
        let view = |who: &str| {
            get_server(
                State(state.clone()),
                MaybeAuthed(Some(mem_user(who, false))),
                HeaderMap::new(),
                Path("club".to_string()),
            )
        };
        assert!(matches!(
            view("carol").await,
            Err(ApiError(StatusCode::FORBIDDEN, m, _)) if m == "You are banned from this server"
        ));
        assert!(view("dave").await.is_ok());
        let cid: i64 = sqlx::query("SELECT id FROM channels WHERE server = 'club'")
            .fetch_one(db)
            .await
            .expect("channel")
            .try_get(0)
            .expect("id");
        let carol = mem_user("carol", false);
        assert!(matches!(
            resolve_channel(db, cid, Some(&carol), &Proof::none()).await,
            Err(ApiError(StatusCode::NOT_FOUND, m, _)) if m == "Not found"
        ));
        assert!(
            crate::api::access::ws_channel_viewable(
                crate::ws::Layer::for_tests(),
                db,
                "club",
                cid,
                Some("dave")
            )
            .await
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn invite_statuses() {
        let (state, path) = temp_state("invite_status").await;
        let db = &state.db;
        let _ = make_server(&state, "Club").await.expect("club");
        add_user(db, "bob", "Bob").await;
        add_user(db, "carol", "Carol").await;
        join(&state, "bob", "club").await.expect("bob joins");
        ban(&state, mem_user("alice", false), "club", "carol")
            .await
            .expect("ban carol");
        let user = |name: &str| Some(mem_user(name, false));
        let open = invite_as(&state, user("dave"), "CLUB", None, None)
            .await
            .expect("open invite");
        assert_eq!(open.server.display_name, "Club");
        assert_eq!(open.server.name, "club");
        assert!(!open.server.has_password);
        assert_eq!(open.member_count, 2);
        assert_eq!(open.status, InviteStatus::Joinable);
        assert_eq!(open.preview_channel.as_deref(), Some("general"));
        assert_eq!(
            status_of(&state, user("alice"), None).await,
            InviteStatus::Member
        );
        assert_eq!(
            status_of(&state, user("bob"), None).await,
            InviteStatus::Member
        );
        assert_eq!(
            status_of(&state, user("carol"), None).await,
            InviteStatus::Banned
        );
        assert_eq!(status_of(&state, None, None).await, InviteStatus::Joinable);
        assert_eq!(
            status_of(&state, Some(mem_user("root", true)), None).await,
            InviteStatus::Joinable
        );
        set_password(&state, "pässwörd #1").await;
        let outcome =
            |viewer: Option<User>, server: &'static str, password: Option<&'static str>| {
                let state = state.clone();
                async move {
                    invite_as(&state, viewer, server, password, None)
                        .await
                        .map(|i| i.status)
                        .map_err(|ApiError(code, m, _)| (code, m))
                }
            };
        let required = Err((StatusCode::UNAUTHORIZED, PASSWORD_REQUIRED.to_string()));
        let denied = Err((StatusCode::NOT_FOUND, DENIED.to_string()));
        assert_eq!(outcome(user("dave"), "club", None).await, required);
        assert_eq!(outcome(user("dave"), "club", Some("wrong")).await, denied);
        assert_eq!(
            outcome(user("dave"), "club", Some("pässwörd #1")).await,
            Ok(InviteStatus::Joinable)
        );
        assert_eq!(
            outcome(Some(mem_user("root", true)), "club", None).await,
            required
        );
        assert_eq!(
            outcome(user("bob"), "club", None).await,
            Ok(InviteStatus::Member)
        );
        assert_eq!(outcome(user("carol"), "club", None).await, required);
        assert_eq!(
            outcome(user("carol"), "club", Some("pässwörd #1")).await,
            Ok(InviteStatus::Banned)
        );
        assert_eq!(outcome(None, "club", None).await, required);
        assert_eq!(
            outcome(None, "club", Some("pässwörd #1")).await,
            Ok(InviteStatus::Joinable)
        );
        let grant = insert_grant(db, "club").await;
        let guest = invite_as(&state, None, "club", None, Some(&format!("bogus, {grant}")))
            .await
            .expect("guest invite");
        assert_eq!(guest.status, InviteStatus::Joinable);
        let ignored = invite_as(&state, user("dave"), "club", None, Some(&grant))
            .await
            .map_err(|ApiError(code, m, _)| (code, m))
            .map(|i| i.status);
        assert_eq!(ignored, required);
        assert_eq!(outcome(user("dave"), "nowhere", None).await, required);
        assert_eq!(outcome(user("dave"), "nowhere", Some("x")).await, denied);
        assert_eq!(outcome(None, "nowhere", None).await, required);
        done(state, path).await;
    }

    #[tokio::test]
    async fn invite_counts_only_when_unlocked() {
        let (state, path) = temp_state("invite_counts").await;
        let db = &state.db;
        let _ = make_server(&state, "Club").await.expect("club");
        add_user(db, "bob", "Bob").await;
        join(&state, "bob", "club").await.expect("bob joins");
        let user = |name: &str| Some(mem_user(name, false));
        let counts = |invite: &Invite| (invite.member_count, invite.online_count);
        let open = invite_as(&state, user("dave"), "club", None, None)
            .await
            .expect("open");
        assert_eq!(counts(&open), (2, 0));
        set_password(&state, "secret-pw").await;
        let grant = insert_grant(db, "club").await;
        type Case<'a> = (
            Option<User>,
            Option<&'a str>,
            Option<&'a str>,
            Option<StatusCode>,
        );
        let cases: Vec<Case> = vec![
            (user("dave"), None, None, Some(StatusCode::UNAUTHORIZED)),
            (
                user("dave"),
                Some("nope"),
                None,
                Some(StatusCode::NOT_FOUND),
            ),
            (user("dave"), Some("secret-pw"), None, None),
            (user("bob"), None, None, None),
            (
                Some(mem_user("root", true)),
                None,
                None,
                Some(StatusCode::UNAUTHORIZED),
            ),
            (None, None, None, Some(StatusCode::UNAUTHORIZED)),
            (None, None, Some("bogus"), Some(StatusCode::UNAUTHORIZED)),
            (None, None, Some(&grant), None),
            (None, Some("secret-pw"), None, None),
        ];
        for (n, (viewer, password, grant, refused)) in cases.into_iter().enumerate() {
            match (
                invite_as(&state, viewer, "club", password, grant).await,
                refused,
            ) {
                (Ok(invite), None) => {
                    assert_eq!(invite.server.display_name, "Club", "case {n}");
                    assert_eq!(counts(&invite), (2, 0), "case {n}");
                }
                (Err(ApiError(code, _, _)), Some(want)) => assert_eq!(code, want, "case {n}"),
                (_, _) => panic!("case {n}"),
            }
        }
        done(state, path).await;
    }

    async fn post(db: &Db, channel: i64, content: &str, root: Option<i64>) -> i64 {
        sqlx::query("INSERT INTO messages(channel_id, thread_root_id, author, content, created_at) VALUES($1, $2, 'alice', $3, 0) RETURNING id")
            .bind(channel)
            .bind(root)
            .bind(content)
            .fetch_one(db)
            .await
            .expect("insert message")
            .try_get(0)
            .expect("message id")
    }

    fn contents(invite: &Invite) -> Vec<&str> {
        invite.preview.iter().map(|m| m.content.as_str()).collect()
    }

    #[tokio::test]
    async fn invite_preview_gating() {
        let (state, path) = temp_state("invite_preview").await;
        let db = &state.db;
        let general = make_server(&state, "club").await.expect("club").0.channels[0].id;
        set_password(&state, "secret-pw").await;
        for n in 1..=5 {
            post(db, general, &format!("m{n}"), None).await;
        }
        let last = post(db, general, "m6", None).await;
        post(db, general, "reply", Some(last)).await;
        let dave = || Some(mem_user("dave", false));
        assert!(matches!(
            invite_as(&state, dave(), "club", None, None).await,
            Err(ApiError(StatusCode::UNAUTHORIZED, m, _)) if m == PASSWORD_REQUIRED
        ));
        assert!(matches!(
            invite_as(&state, dave(), "club", Some("nope"), None).await,
            Err(ApiError(StatusCode::NOT_FOUND, m, _)) if m == DENIED
        ));
        let unlocked = invite_as(&state, dave(), "club", Some("secret-pw"), None)
            .await
            .expect("unlocked");
        assert_eq!(unlocked.preview_channel.as_deref(), Some("general"));
        assert_eq!(contents(&unlocked), vec!["m4", "m5", "m6"]);
        assert_eq!(unlocked.preview[2].author.username, "alice");
        let viewer = || Some(mem_user("alice", false));
        let metadata = invite_card(
            state.clone(),
            viewer(),
            HeaderMap::new(),
            "club".into(),
            false,
            None,
        )
        .await
        .unwrap()
        .0;
        assert_eq!(metadata.preview_channel_id, Some(general));
        assert!(!metadata.preview_sensitive);
        assert!(metadata.preview.is_empty());
        let version = format!("{general}.0");
        let matching = invite_card(
            state.clone(),
            viewer(),
            HeaderMap::new(),
            "club".into(),
            true,
            Some(&version),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(contents(&matching), vec!["m4", "m5", "m6"]);
        sqlx::query("UPDATE channels SET sensitive = 1 WHERE id = $1")
            .bind(general)
            .execute(db)
            .await
            .unwrap();
        let changed = invite_card(
            state.clone(),
            viewer(),
            HeaderMap::new(),
            "club".into(),
            true,
            Some(&version),
        )
        .await
        .unwrap()
        .0;
        assert!(changed.preview_sensitive && changed.preview.is_empty());
        sqlx::query("UPDATE channels SET sensitive = 0 WHERE id = $1")
            .bind(general)
            .execute(db)
            .await
            .unwrap();

        let grant = insert_grant(db, "club").await;
        let guest = invite_as(&state, None, "club", None, Some(&grant))
            .await
            .expect("guest");
        assert_eq!(contents(&guest), vec!["m4", "m5", "m6"]);
        let member = invite_as(&state, Some(mem_user("alice", false)), "club", None, None)
            .await
            .expect("member");
        assert_eq!(contents(&member), vec!["m4", "m5", "m6"]);
        sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'u:alice', 1, 1, 1)")
            .bind(general)
            .execute(db)
            .await
            .expect("make general private");
        crate::api::test_util::restrict_ruled(db).await;
        sqlx::query("INSERT INTO channels(server, name, kind, created_at) VALUES('club', 'lounge', 'voice', 0)")
            .execute(db)
            .await
            .expect("voice channel");
        let lobby: i64 = sqlx::query(
            "INSERT INTO channels(server, name, created_at) VALUES('club', 'lobby', 0) RETURNING id",
        )
        .fetch_one(db)
        .await
        .expect("lobby")
        .try_get(0)
        .expect("lobby id");
        post(db, lobby, "hello lobby", None).await;
        let public = invite_as(&state, dave(), "club", Some("secret-pw"), None)
            .await
            .expect("public channel");
        assert_eq!(public.preview_channel.as_deref(), Some("lobby"));
        assert_eq!(contents(&public), vec!["hello lobby"]);
        let alice_view = invite_as(&state, Some(mem_user("alice", false)), "club", None, None)
            .await
            .expect("alice sees the outsider preview");
        assert_eq!(alice_view.preview_channel.as_deref(), Some("lobby"));
        add_user(db, "carol", "Carol").await;
        ban(&state, mem_user("alice", false), "club", "carol")
            .await
            .expect("ban carol");
        let banned = invite_as(
            &state,
            Some(mem_user("carol", false)),
            "club",
            Some("secret-pw"),
            None,
        )
        .await
        .expect("banned");
        assert_eq!(banned.status, InviteStatus::Banned);
        assert_eq!(banned.preview_channel, None);
        assert!(banned.preview.is_empty());
        assert!(matches!(
            invite_as(&state, Some(mem_user("carol", false)), "club", None, None).await,
            Err(ApiError(StatusCode::UNAUTHORIZED, m, _)) if m == PASSWORD_REQUIRED
        ));
        set_password(&state, "").await;
        let banned = invite_as(&state, Some(mem_user("carol", false)), "club", None, None)
            .await
            .expect("banned from an open server");
        assert_eq!(banned.status, InviteStatus::Banned);
        assert!(banned.preview.is_empty());
        let open = invite_as(&state, dave(), "club", None, None)
            .await
            .expect("open server");
        assert_eq!(contents(&open), vec!["hello lobby"]);
        set_password(&state, "secret-pw").await;
        sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'u:alice', 1, 1, 1)")
            .bind(lobby)
            .execute(db)
            .await
            .expect("make lobby private");
        crate::api::test_util::restrict_ruled(db).await;
        let hidden = invite_as(&state, dave(), "club", Some("secret-pw"), None)
            .await
            .expect("no public channel");
        assert_eq!(hidden.status, InviteStatus::Joinable);
        assert_eq!(hidden.preview_channel, None);
        assert!(hidden.preview.is_empty());
        sqlx::query("UPDATE channels SET restrict_view = 0 WHERE id = $1")
            .bind(lobby)
            .execute(db)
            .await
            .expect("open lobby with an allow rule");
        let allowed = invite_as(&state, dave(), "club", Some("secret-pw"), None)
            .await
            .expect("allow rules keep a channel public");
        assert_eq!(allowed.preview_channel.as_deref(), Some("lobby"));
        assert_eq!(contents(&allowed), vec!["hello lobby"]);
        sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'u:bob', 0, 0, 0)")
            .bind(lobby)
            .execute(db)
            .await
            .expect("deny rule");
        let denied = invite_as(&state, dave(), "club", Some("secret-pw"), None)
            .await
            .expect("a view deny makes it non-public");
        assert_eq!(denied.preview_channel, None);
        assert!(denied.preview.is_empty());
        done(state, path).await;
    }

    async fn change_password(
        state: &AppState,
        actor: User,
        server: &str,
        name: Option<&str>,
        password: Option<&str>,
        members: PasswordMembers,
    ) -> Result<ServerUpdated, ApiError> {
        change_keeping(state, actor, server, name, password, members, false).await
    }

    async fn change_keeping(
        state: &AppState,
        actor: User,
        server: &str,
        name: Option<&str>,
        password: Option<&str>,
        members: PasswordMembers,
        keep_guests: bool,
    ) -> Result<ServerUpdated, ApiError> {
        update_server(
            State(state.clone()),
            Authed(actor),
            Path(server.to_string()),
            Json(ServerPatch {
                seal: Default::default(),
                name: name.map(str::to_string),
                password: password.map(str::to_string),
                protected: None,
                members,
                keep_guests,
                banner_color: None,
                name_color: None,
                public_read: None,
                guest_voice: None,
                guest_chat_opt_in: None,
                guest_voice_opt_in: None,
                members_visible: None,
                hide_members: None,
                join: None,
                listed: None,
                profiles_mode: None,
                description: None,
                icon_kind: None,
            }),
        )
        .await
        .map(|Json(updated)| updated)
    }

    async fn member_names(db: &Db, server: &str) -> Vec<String> {
        let rows = sqlx::query("SELECT username FROM members WHERE server = $1 ORDER BY username")
            .bind(server)
            .fetch_all(db)
            .await
            .expect("members");
        rows.iter()
            .map(|r| r.try_get(0).expect("username"))
            .collect()
    }

    async fn grant_valid(state: &AppState, server: &str, grant: &str) -> bool {
        invite_as(state, None, server, None, Some(grant))
            .await
            .is_ok_and(|i| i.status == InviteStatus::Joinable)
    }

    async fn join_with(state: &AppState, who: &str, server: &str, password: &str) {
        let _ = join_server(
            State(state.clone()),
            Authed(mem_user(who, false)),
            Path(server.to_string()),
            Some(Json(JoinReq {
                password: Some(password.to_string()),
            })),
        )
        .await
        .expect("join with password");
    }

    async fn give_role(db: &Db, server: &str, username: &str, perms: i64) {
        let role: i64 = sqlx::query("INSERT INTO roles(server, name, color, perms) VALUES($1, $2, '#ffffff', $3) RETURNING id")
            .bind(server)
            .bind(format!("r-{username}"))
            .bind(perms)
            .fetch_one(db)
            .await
            .expect("role")
            .try_get(0)
            .expect("role id");
        sqlx::query("INSERT INTO user_roles(server, username, role_id) VALUES($1, $2, $3)")
            .bind(server)
            .bind(username)
            .bind(role)
            .execute(db)
            .await
            .expect("assign");
    }

    async fn patch_server(
        state: &AppState,
        actor: User,
        server: &str,
        body: &str,
    ) -> Result<ServerUpdated, ApiError> {
        let patch: ServerPatch = serde_json::from_str(body).expect("patch json");
        update_server(
            State(state.clone()),
            Authed(actor),
            Path(server.to_string()),
            Json(patch),
        )
        .await
        .map(|Json(updated)| updated)
    }

    #[tokio::test]
    async fn guest_opt_ins_require_the_site_switch_only_when_turning_on() {
        let (state, path) = temp_state("guest_opt_in_transitions").await;
        let _ = make_server(&state, "club").await.expect("club");
        let patch =
            |body: &'static str| patch_server(&state, mem_user("alice", false), "club", body);
        let both = r#"{"guest_chat_opt_in":true,"guest_voice_opt_in":true}"#;
        let chat = r#"{"guest_chat_opt_in":true}"#;
        let voice = r#"{"guest_voice_opt_in":true}"#;
        for body in [chat, voice] {
            assert!(matches!(
                patch(body).await,
                Err(ApiError(StatusCode::FORBIDDEN, _, _))
            ));
        }
        for (enabled, disabled, choice) in [
            ("guest_chat_enabled", "guest_voice_enabled", chat),
            ("guest_voice_enabled", "guest_chat_enabled", voice),
        ] {
            sqlx::query("UPDATE settings SET value = CASE WHEN key = $1 THEN '1' ELSE '0' END WHERE key IN ($1, $2)")
                .bind(enabled)
                .bind(disabled)
                .execute(&state.db)
                .await
                .expect("site settings");
            assert!(matches!(
                patch(both).await,
                Err(ApiError(StatusCode::FORBIDDEN, _, _))
            ));
            let server = lite_of(&state.db, "club").await;
            assert!(!server.guest_chat && !server.guest_voice);
            let server = patch(choice).await.expect("allowed choice").server;
            assert_eq!(
                (server.guest_chat, server.guest_voice),
                (choice == chat, choice == voice)
            );
            sqlx::query("UPDATE settings SET value = '0' WHERE key = $1")
                .bind(enabled)
                .execute(&state.db)
                .await
                .expect("suspend");
            patch(choice).await.expect("retain suspended choice");
            patch(r#"{"guest_voice_opt_in":false,"guest_chat_opt_in":false}"#)
                .await
                .expect("opt out");
            assert!(matches!(
                patch(choice).await,
                Err(ApiError(StatusCode::FORBIDDEN, _, _))
            ));
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn the_profiles_mode_reaches_clients_with_the_server() {
        use crate::api::profiles::ProfilesMode;
        let (state, path) = temp_state("server_profiles_mode").await;
        let db = &state.db;
        let _ = make_server(&state, "club").await.expect("club");
        add_user(db, "bob", "bob").await;
        join(&state, "bob", "club").await.expect("join");
        let mut rx = state.hub.subscribe();
        assert_eq!(
            patch_server(
                &state,
                mem_user("bob", false),
                "club",
                r#"{"profiles_mode":"off"}"#
            )
            .await
            .err()
            .map(|e| e.0),
            Some(StatusCode::FORBIDDEN)
        );
        let set = patch_server(
            &state,
            mem_user("alice", false),
            "club",
            r#"{"profiles_mode":"no_names"}"#,
        )
        .await
        .unwrap_or_else(|e| panic!("mode: {}", e.1));
        assert_eq!(set.server.profiles_mode, ProfilesMode::NoNames);
        let mut sent = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            if let WsEvent::ServerUpdated { server } = ev {
                sent.push(server.profiles_mode);
            }
        }
        assert_eq!(sent, [ProfilesMode::NoNames]);
        let detail = detail_as(&state, "club", None).await.expect("detail");
        assert_eq!(detail.profiles_mode, ProfilesMode::NoNames);
        let mine = my_servers_page(db, "bob", 0, None, 50).await.expect("mine");
        let club = mine.items.iter().find(|s| s.name == "club").expect("club");
        assert_eq!(club.profiles_mode, ProfilesMode::NoNames);
        let named = my_servers_by_names(db, "bob", &["club".to_string()])
            .await
            .expect("named");
        assert_eq!(named[0].profiles_mode, ProfilesMode::NoNames);
        let logged: String = sqlx::query(
            "SELECT details FROM audit_log WHERE action = 'server.update' ORDER BY id DESC LIMIT 1",
        )
        .fetch_one(db)
        .await
        .expect("audit")
        .get(0);
        let logged: serde_json::Value = serde_json::from_str(&logged).expect("details");
        assert_eq!(
            logged["changes"],
            serde_json::json!([{"field": "profiles_mode", "before": "all", "after": "no_names"}])
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn server_colors_are_validated_gated_and_broadcast() {
        let (state, path) = temp_state("server_colors").await;
        let db = &state.db;
        let _ = make_server(&state, "club").await.expect("club");
        add_user(db, "bob", "bob").await;
        join(&state, "bob", "club").await.expect("join");
        let alice = || mem_user("alice", false);
        let mut rx = state.hub.subscribe();
        let set = patch_server(
            &state,
            alice(),
            "club",
            r##"{"banner_color":"#FF0066","name_color":"#ffffff"}"##,
        )
        .await
        .expect("set colors");
        assert_eq!(set.server.banner_color.as_deref(), Some("#ff0066"));
        assert_eq!(set.server.name_color.as_deref(), Some("#ffffff"));
        assert!(!set.server.has_password);
        let mut updated = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            match ev {
                WsEvent::ServerRenamed { old_name, server } => {
                    updated.push((Some(old_name), server.banner_color, server.name_color))
                }
                WsEvent::ServerUpdated { server } => {
                    updated.push((None, server.banner_color, server.name_color))
                }
                _ => {}
            }
        }
        assert_eq!(
            updated,
            [(
                None,
                Some("#ff0066".to_string()),
                Some("#ffffff".to_string())
            )]
        );
        let detail = detail_as(&state, "club", None).await.expect("detail");
        assert_eq!(detail.banner_color.as_deref(), Some("#ff0066"));
        assert_eq!(detail.name_color.as_deref(), Some("#ffffff"));
        let mine = my_servers_by_names(db, "bob", &["club".to_string()])
            .await
            .expect("mine");
        assert_eq!(mine[0].banner_color.as_deref(), Some("#ff0066"));
        let renamed = patch_server(&state, alice(), "club", r#"{"name":"Club"}"#)
            .await
            .expect("rename keeps colors");
        assert_eq!(renamed.server.banner_color.as_deref(), Some("#ff0066"));
        assert_eq!(renamed.server.name_color.as_deref(), Some("#ffffff"));
        let cleared = patch_server(&state, alice(), "club", r#"{"name_color":null}"#)
            .await
            .expect("clear name color");
        assert_eq!(cleared.server.banner_color.as_deref(), Some("#ff0066"));
        assert_eq!(cleared.server.name_color, None);
        let lite = lite_of(db, "club").await;
        assert_eq!(
            (lite.banner_color.as_deref(), lite.name_color),
            (Some("#ff0066"), None)
        );
        for bad in [
            r#"{"banner_color":"red"}"#,
            r##"{"banner_color":"#12345"}"##,
            r##"{"name_color":"#12345g"}"##,
            r#"{"name_color":""}"#,
        ] {
            let err = patch_server(&state, alice(), "club", bad)
                .await
                .err()
                .expect(bad);
            assert_eq!(err.0, StatusCode::BAD_REQUEST, "{bad}");
        }
        let err = patch_server(
            &state,
            mem_user("bob", false),
            "club",
            r##"{"banner_color":"#000000"}"##,
        )
        .await
        .err()
        .expect("bob is not allowed");
        assert_eq!(err.0, StatusCode::FORBIDDEN);
        let lite = lite_of(db, "club").await;
        assert_eq!(lite.banner_color.as_deref(), Some("#ff0066"));
        let rchat = patch_server(
            &state,
            mem_user("root", true),
            "rchat",
            r##"{"banner_color":"#000000"}"##,
        )
        .await
        .expect("site admin colors rchat");
        assert_eq!(rchat.server.banner_color.as_deref(), Some("#000000"));
        let err = patch_server(
            &state,
            mem_user("root", true),
            "rchat",
            r##"{"password":"a-long-password","banner_color":"#111111"}"##,
        )
        .await
        .err()
        .expect("rchat takes no password");
        assert_eq!(err.0, StatusCode::FORBIDDEN);
        let err = patch_server(&state, alice(), "rchat", r##"{"banner_color":"#111111"}"##)
            .await
            .err()
            .expect("members can't color rchat");
        assert_eq!(err.0, StatusCode::FORBIDDEN);
        let lite = lite_of(db, "rchat").await;
        assert_eq!(lite.banner_color.as_deref(), Some("#000000"));
        done(state, path).await;
    }

    #[tokio::test]
    async fn password_change_keeps_or_removes_members() {
        let (state, path) = temp_state("pw_members").await;
        let db = &state.db;
        let cid = make_server(&state, "club").await.expect("club").0.channels[0].id;
        for name in ["bob", "carol", "dave", "erin"] {
            add_user(db, name, name).await;
            join(&state, name, "club").await.expect("join");
        }
        give_role(db, "club", "carol", Perm::Kick as i64).await;
        set_admin_row(db, "dave", 0).await;
        set_admin_row(db, "erin", Perm::Kick as i64 | Perm::DeleteMessages as i64).await;
        set_password(&state, "old-password").await;
        let grant = insert_grant(db, "club").await;
        let alice = || mem_user("alice", false);
        let mut rx = state.hub.subscribe();
        let kept = change_password(
            &state,
            alice(),
            "club",
            None,
            Some("new-password"),
            PasswordMembers::Keep,
        )
        .await
        .expect("keep everyone");
        assert!(kept.server.has_password);
        assert_eq!((kept.removed, kept.kept), (0, 4));
        assert_eq!(
            member_names(db, "club").await,
            ["alice", "bob", "carol", "dave", "erin"]
        );
        assert!(!grant_valid(&state, "club", &grant).await);
        let grant = insert_grant(db, "club").await;
        let _ = change_keeping(
            &state,
            alice(),
            "club",
            None,
            Some("new2-password"),
            PasswordMembers::Keep,
            true,
        )
        .await
        .expect("keep everyone and guests");
        assert!(grant_valid(&state, "club", &grant).await);
        let renamed = change_keeping(
            &state,
            alice(),
            "club",
            Some("Club"),
            None,
            PasswordMembers::Keep,
            false,
        )
        .await
        .expect("rename only");
        assert!(renamed.server.has_password);
        assert!(grant_valid(&state, "club", &grant).await);
        assert!(kicks(&mut rx).is_empty());
        let _ = state.hub.voice_join("bob", 7, "club", cid).await;
        state.hub.set_online("carol", 8, &["club"]);
        assert!(state.hub.is_online("club", "carol"));
        let removed = change_keeping(
            &state,
            alice(),
            "club",
            None,
            Some("newer-password"),
            PasswordMembers::Remove,
            true,
        )
        .await
        .expect("remove everyone");
        assert_eq!((removed.removed, removed.kept), (3, 1));
        assert_eq!(member_names(db, "club").await, ["alice", "dave"]);
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM user_roles WHERE server = 'club'").await,
            0
        );
        assert!(!grant_valid(&state, "club", &grant).await);
        let mut got = kicks(&mut rx);
        got.sort();
        assert_eq!(
            got,
            ["bob", "carol", "erin"].map(|u| ("club".to_string(), u.to_string(), false))
        );
        assert!(state.hub.rooms_in("club", None).is_empty());
        assert!(!state.hub.is_online("club", "carol"));
        assert_eq!(count(db, "SELECT COUNT(*) FROM server_bans").await, 0);
        assert_eq!(
            status(join(&state, "bob", "club").await),
            Some(StatusCode::UNAUTHORIZED)
        );
        join_with(&state, "bob", "club", "newer-password").await;
        let cleared = change_password(
            &state,
            alice(),
            "club",
            None,
            Some(""),
            PasswordMembers::Remove,
        )
        .await
        .expect("clear and remove");
        assert!(!cleared.server.has_password);
        assert_eq!((cleared.removed, cleared.kept), (1, 1));
        join(&state, "bob", "club").await.expect("open again");
        let renamed = change_password(
            &state,
            alice(),
            "club",
            Some("Den"),
            None,
            PasswordMembers::Remove,
        )
        .await
        .expect("rename ignores members");
        assert_eq!((renamed.removed, renamed.kept), (0, 2));
        assert_eq!(member_names(db, "den").await, ["alice", "bob", "dave"]);
        let both = change_password(
            &state,
            alice(),
            "den",
            Some("Lair"),
            Some("x-password"),
            PasswordMembers::Remove,
        )
        .await
        .expect("rename and remove");
        assert_eq!(
            (both.server.name.as_str(), both.removed, both.kept),
            ("lair", 1, 1)
        );
        assert_eq!(member_names(db, "lair").await, ["alice", "dave"]);
        assert_eq!(
            kicks(&mut rx),
            [
                ("club".to_string(), "bob".to_string(), false),
                ("lair".to_string(), "bob".to_string(), false)
            ]
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn password_remove_needs_kick_and_follows_hierarchy() {
        let (state, path) = temp_state("pw_rules").await;
        let db = &state.db;
        let _ = make_server(&state, "club").await.expect("club");
        let names = ["bob", "carol", "dave", "erin", "frank", "su", "root"];
        for name in names {
            add_user(db, name, name).await;
        }
        for name in &names[..6] {
            join(&state, name, "club").await.expect("join");
        }
        sqlx::query("UPDATE users SET is_site_admin = 1 WHERE username IN ('su', 'root')")
            .execute(db)
            .await
            .expect("site admins");
        let manage = Perm::ManageServer as i64;
        let manage_kick = manage | Perm::Kick as i64;
        set_admin_row(db, "bob", manage).await;
        set_admin_row(db, "carol", manage_kick).await;
        set_admin_row(db, "dave", manage_kick).await;
        give_role(db, "club", "erin", Perm::Kick as i64).await;
        set_admin_row(db, "frank", manage_kick | Perm::ManageAdmins as i64).await;
        let grant = insert_grant(db, "club").await;
        let everyone = ["alice", "bob", "carol", "dave", "erin", "frank", "su"];
        assert_eq!(
            status(
                change_password(
                    &state,
                    mem_user("bob", false),
                    "club",
                    None,
                    Some("password"),
                    PasswordMembers::Remove
                )
                .await
            ),
            Some(StatusCode::FORBIDDEN)
        );
        assert_eq!(member_names(db, "club").await, everyone);
        assert!(!lite_of(db, "club").await.has_password);
        assert_eq!(
            status(
                change_password(
                    &state,
                    mem_user("erin", false),
                    "club",
                    None,
                    Some("password"),
                    PasswordMembers::Keep
                )
                .await
            ),
            Some(StatusCode::FORBIDDEN)
        );
        let kept = change_password(
            &state,
            mem_user("bob", false),
            "club",
            None,
            Some("password"),
            PasswordMembers::Keep,
        )
        .await
        .expect("delete-server admin keeps everyone");
        assert_eq!((kept.removed, kept.kept), (0, 6));
        assert!(!grant_valid(&state, "club", &grant).await);
        let grant = insert_grant(db, "club").await;
        let narrow = change_password(
            &state,
            mem_user("carol", false),
            "club",
            None,
            Some("pw2-password"),
            PasswordMembers::Remove,
        )
        .await
        .expect("narrow admin removes");
        assert_eq!((narrow.removed, narrow.kept), (3, 3));
        assert_eq!(
            member_names(db, "club").await,
            ["alice", "carol", "dave", "frank"]
        );
        assert!(!grant_valid(&state, "club", &grant).await);
        let full = change_password(
            &state,
            mem_user("alice", false),
            "club",
            None,
            Some("pw3-password"),
            PasswordMembers::Remove,
        )
        .await
        .expect("full admin removes");
        assert_eq!((full.removed, full.kept), (3, 0));
        assert_eq!(member_names(db, "club").await, ["alice"]);
        join_with(&state, "frank", "club", "pw3-password").await;
        set_admin_row(db, "frank", 0).await;
        let site = change_password(
            &state,
            mem_user("root", true),
            "club",
            None,
            Some("pw4-password"),
            PasswordMembers::Remove,
        )
        .await
        .expect("site admin removes everyone");
        assert_eq!((site.removed, site.kept), (2, 0));
        assert!(member_names(db, "club").await.is_empty());
        let grant = insert_grant(db, "club").await;
        assert!(grant_valid(&state, "club", &grant).await);
        let open = change_password(
            &state,
            mem_user("root", true),
            "club",
            None,
            Some(" "),
            PasswordMembers::Keep,
        )
        .await
        .expect("clear keeps members");
        assert!(!open.server.has_password);
        assert_eq!(
            count(
                db,
                "SELECT COUNT(*) FROM guest_grants WHERE server = 'club'"
            )
            .await,
            0
        );
        assert_eq!(
            status(
                change_password(
                    &state,
                    mem_user("root", true),
                    "rchat",
                    None,
                    Some("password"),
                    PasswordMembers::Remove
                )
                .await
            ),
            Some(StatusCode::FORBIDDEN)
        );
        assert_eq!(
            status(
                change_password(
                    &state,
                    mem_user("root", true),
                    "rchat",
                    None,
                    Some("password"),
                    PasswordMembers::Keep
                )
                .await
            ),
            Some(StatusCode::FORBIDDEN)
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn member_cursor_walk_matches_offsets() {
        let (state, path) = temp_state("member_cursor").await;
        let db = &state.db;
        let mut names: Vec<String> = (0..130).map(|n| format!("m{n:03}")).collect();
        for name in &names {
            add_member(db, "rchat", name, 0, 0, 0).await;
        }
        let online: Vec<String> = names.iter().step_by(7).cloned().collect();
        for (conn, name) in online.iter().enumerate() {
            state.hub.set_online(name, conn as u64 + 1, &["rchat"]);
        }
        state.hub.set_online("stranger", 999, &["rchat"]);
        names.retain(|n| !online.contains(n));
        let expected: Vec<String> = [online.clone(), names].concat();
        let mut walked = Vec::new();
        let mut cursor: Option<String> = None;
        let mut pages = 0;
        loop {
            let (rows, next) =
                members_page(db, "rchat", &state.hub, None, Some(50), cursor.as_deref())
                    .await
                    .expect("page");
            let offset_rows = members_page(
                db,
                "rchat",
                &state.hub,
                Some(walked.len() as i64),
                Some(50),
                None,
            )
            .await
            .expect("offset page")
            .0;
            assert_eq!(rows, offset_rows, "page {pages}");
            walked.extend(rows.into_iter().map(|(name, _, _)| name));
            pages += 1;
            match next {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        assert_eq!(pages, 3);
        assert_eq!(walked, expected);
        let (small, next) = members_page(db, "rchat", &state.hub, None, Some(19), None)
            .await
            .expect("online only page");
        assert_eq!(small.len(), 19);
        let (rest, _) = members_page(db, "rchat", &state.hub, None, Some(5), next.as_deref())
            .await
            .expect("across phases");
        let rest: Vec<String> = rest.into_iter().map(|(n, _, _)| n).collect();
        assert_eq!(rest, expected[19..24]);
        assert!(rejected(
            members_page(db, "rchat", &state.hub, None, None, Some("zz"))
                .await
                .map(|_| ())
        ));
        let res = list_members(
            State(state.clone()),
            MaybeAuthed(None),
            HeaderMap::new(),
            Path("rchat".to_string()),
            RawQuery(Some("limit=50".to_string())),
        )
        .await
        .expect("handler");
        let res = axum::response::IntoResponse::into_response(res);
        assert!(res.headers().contains_key(crate::api::NEXT_CURSOR));
        done(state, path).await;
    }

    #[tokio::test]
    async fn member_search_pages_by_prefix_and_admins() {
        let (state, path) = temp_state("member_search").await;
        let db = &state.db;
        for n in 0..70 {
            add_member(
                db,
                "rchat",
                &format!("al{n:02}"),
                i64::from(n % 10 == 0),
                0,
                0,
            )
            .await;
        }
        for name in ["alpha", "bob", "alz", "am", "a\u{10ffff}x"] {
            add_member(db, "rchat", name, 0, 0, 0).await;
        }
        let fetch = |raw: String| {
            let state = state.clone();
            async move {
                let res = list_members(
                    State(state),
                    MaybeAuthed(None),
                    HeaderMap::new(),
                    Path("rchat".to_string()),
                    RawQuery(Some(raw)),
                )
                .await
                .expect("handler");
                let res = axum::response::IntoResponse::into_response(res);
                let next = res
                    .headers()
                    .get(crate::api::NEXT_CURSOR)
                    .map(|v| v.to_str().expect("ascii").to_string());
                let body = axum::body::to_bytes(res.into_body(), usize::MAX)
                    .await
                    .expect("body");
                let members: Vec<serde_json::Value> = serde_json::from_slice(&body).expect("json");
                let names: Vec<String> = members
                    .iter()
                    .map(|m| m["username"].as_str().expect("name").to_string())
                    .collect();
                (names, next)
            }
        };
        let mut walked = Vec::new();
        let mut cursor = String::new();
        loop {
            let (names, next) = fetch(format!("q=AL&cursor={cursor}")).await;
            walked.extend(names);
            match next {
                Some(next) => cursor = next,
                None => break,
            }
        }
        let mut expected: Vec<String> = (0..70).map(|n| format!("al{n:02}")).collect();
        expected.extend(["alpha".to_string(), "alz".to_string()]);
        assert_eq!(walked, expected);
        assert_eq!(
            fetch("q=b".to_string()).await,
            (vec!["bob".to_string()], None)
        );
        assert_eq!(fetch("q=zzz".to_string()).await, (Vec::new(), None));
        let (admins, next) = fetch("admins=1".to_string()).await;
        assert_eq!(
            admins,
            (0..7).map(|n| format!("al{}0", n)).collect::<Vec<_>>()
        );
        assert!(next.is_none());
        let (some, next) = fetch("admins=1&q=al3&limit=1".to_string()).await;
        assert_eq!(some, vec!["al30".to_string()]);
        assert!(next.is_none());
        assert_eq!(prefix_end("ab"), Some("ac".to_string()));
        assert_eq!(prefix_end("a\u{10ffff}"), Some("b".to_string()));
        assert_eq!(prefix_end("\u{10ffff}"), None);
        assert_eq!(prefix_end("\u{d7ff}"), Some("\u{e000}".to_string()));
        done(state, path).await;
    }

    #[tokio::test]
    async fn member_suggestions_match_username_or_display_name() {
        let (state, path) = temp_state("member_suggest").await;
        let db = &state.db;
        for (name, display) in [
            ("alice", "Alice"),
            ("albert", "Bertie"),
            ("bob", "Alfie"),
            ("carol", "ALma"),
            ("dan", "Dan"),
            ("al_x", "x"),
            ("alzz", "z"),
        ] {
            add_user(db, name, display).await;
            add_member(db, "rchat", name, 0, 0, 0).await;
        }
        for n in 0..12 {
            add_user(db, &format!("zz{n:02}"), "Zed").await;
            add_member(db, "rchat", &format!("zz{n:02}"), 0, 0, 0).await;
        }
        add_user(db, "alfred", "Alfred").await;
        let fetch = |who: Option<&'static str>, server: &'static str, raw: &'static str| {
            let state = state.clone();
            async move {
                let res = list_members(
                    State(state),
                    MaybeAuthed(who.map(|w| mem_user(w, false))),
                    HeaderMap::new(),
                    Path(server.to_string()),
                    RawQuery(Some(raw.to_string())),
                )
                .await?;
                let res = axum::response::IntoResponse::into_response(res);
                assert!(res.headers().get(crate::api::NEXT_CURSOR).is_none());
                let body = axum::body::to_bytes(res.into_body(), usize::MAX)
                    .await
                    .expect("body");
                let members: Vec<serde_json::Value> = serde_json::from_slice(&body).expect("json");
                Ok::<Vec<String>, ApiError>(
                    members
                        .iter()
                        .map(|m| m["username"].as_str().expect("name").to_string())
                        .collect(),
                )
            }
        };
        assert_eq!(
            fetch(Some("dan"), "rchat", "q=AL&suggest=1")
                .await
                .expect("al"),
            vec!["al_x", "albert", "alice", "alzz", "bob", "carol"]
        );
        assert_eq!(
            fetch(Some("dan"), "rchat", "q=al_&suggest=1")
                .await
                .expect("escaped"),
            vec!["al_x"]
        );
        assert_eq!(
            fetch(Some("dan"), "rchat", "q=zed&suggest=true")
                .await
                .expect("zed")
                .len(),
            10
        );
        assert_eq!(
            fetch(Some("dan"), "rchat", "q=zz&suggest=1")
                .await
                .expect("zz")
                .len(),
            10
        );
        assert_eq!(
            fetch(Some("dan"), "rchat", "q=ber&suggest=1")
                .await
                .expect("ber"),
            vec!["albert"]
        );
        assert_eq!(
            fetch(None, "rchat", "q=zz&limit=50")
                .await
                .expect("paged")
                .len(),
            12,
            "plain q keeps its paged username listing"
        );
        assert_eq!(
            fetch(None, "rchat", "q=al&suggest=1").await.expect("guest"),
            Vec::<String>::new(),
            "guests get no suggestions"
        );
        assert_eq!(
            fetch(Some("alfred"), "rchat", "q=ber&suggest=1")
                .await
                .expect("public server"),
            vec!["albert"],
            "anyone signed in may search a public server"
        );
        let long = format!("q={}&suggest=1", "a".repeat(NAME_MAX + 1));
        let long = list_members(
            State(state.clone()),
            MaybeAuthed(Some(mem_user("dan", false))),
            HeaderMap::new(),
            Path("rchat".to_string()),
            RawQuery(Some(long)),
        )
        .await;
        assert!(matches!(long, Err(ApiError(StatusCode::BAD_REQUEST, _, _))));
        let _ = make_server(&state, "club").await.expect("club");
        sqlx::query("UPDATE servers SET password_hash = '!none' WHERE name = 'club'")
            .execute(db)
            .await
            .expect("protect");
        assert!(matches!(
            fetch(Some("bob"), "club", "q=al&suggest=1").await,
            Err(ApiError(StatusCode::NOT_FOUND, _, _))
        ));
        assert!(matches!(
            fetch(None, "club", "q=al&suggest=1").await,
            Err(ApiError(StatusCode::NOT_FOUND, _, _))
        ));
        assert_eq!(
            fetch(Some("alice"), "club", "q=al&suggest=1")
                .await
                .expect("member"),
            vec!["alice"]
        );
        done(state, path).await;
    }

    /// The usernames `GET /servers/{server}/mentions?q=` answers `who`, with each row's keys.
    async fn mentioned(
        state: &AppState,
        who: Option<&str>,
        server: &str,
        q: Option<&str>,
    ) -> Result<Vec<String>, ApiError> {
        Ok(mention_rows(state, who, server, q)
            .await?
            .iter()
            .map(|r| r["username"].as_str().expect("name").to_string())
            .collect())
    }

    /// The rows `GET /servers/{server}/mentions?q=` answers `who`, with each row's keys checked.
    async fn mention_rows(
        state: &AppState,
        who: Option<&str>,
        server: &str,
        q: Option<&str>,
    ) -> Result<Vec<serde_json::Value>, ApiError> {
        let res = mentions(
            State(state.clone()),
            MaybeAuthed(who.map(|w| mem_user(w, false))),
            HeaderMap::new(),
            Path(server.to_string()),
            Query(MentionQuery {
                q: q.map(str::to_string),
                channel_id: None,
            }),
        )
        .await?;
        let res = axum::response::IntoResponse::into_response(res);
        assert_eq!(
            res.headers()[axum::http::header::CACHE_CONTROL],
            "private, max-age=15"
        );
        let body = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .expect("body");
        let rows: Vec<serde_json::Value> = serde_json::from_slice(&body).expect("json");
        for row in &rows {
            let mut keys: Vec<&str> = row
                .as_object()
                .expect("object")
                .keys()
                .map(String::as_str)
                .collect();
            keys.sort();
            assert_eq!(
                keys,
                [
                    "avatar_color",
                    "avatar_image",
                    "avatar_kind",
                    "display_name",
                    "username"
                ],
                "only what a suggestion shows"
            );
        }
        Ok(rows)
    }

    /// A 400 whose reason says the request value `field` is wrong.
    fn invalid(text: &str, field: &str) -> (StatusCode, String, Option<Reason>) {
        let reason = Reason {
            kind: ReasonKind::Invalid,
            control: None,
            retry_after: None,
            field: Some(field.to_string()),
            until: None,
            channel: None,
        };
        (StatusCode::BAD_REQUEST, text.to_string(), Some(reason))
    }

    /// The usernames `members?suggest=1` answers.
    async fn suggested(state: &AppState, who: Option<&str>, server: &str, q: &str) -> Vec<String> {
        let res = list_members(
            State(state.clone()),
            MaybeAuthed(who.map(|w| mem_user(w, false))),
            HeaderMap::new(),
            Path(server.to_string()),
            RawQuery(Some(format!("suggest=1&q={q}"))),
        )
        .await
        .expect("suggest");
        let res = axum::response::IntoResponse::into_response(res);
        let body = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .expect("body");
        let rows: Vec<serde_json::Value> = serde_json::from_slice(&body).expect("json");
        rows.iter()
            .map(|r| r["username"].as_str().expect("name").to_string())
            .collect()
    }

    #[tokio::test]
    async fn mentions_match_server_names() {
        let (state, path) = temp_state("mentions_server_names").await;
        let db = &state.db;
        for (name, display) in [("alice", "Alice"), ("bob", "Bob"), ("dan", "Dan")] {
            add_user(db, name, display).await;
            add_member(db, "rchat", name, 0, 0, 0).await;
        }
        add_user(db, "erin", "Erin").await;
        for (server, who, nick) in [("rchat", "alice", "Zorro"), ("rchat", "bob", "ZEbra")] {
            sqlx::query("INSERT INTO member_profiles(server, username, name, updated_at) VALUES($1, $2, $3, 1)")
                .bind(server)
                .bind(who)
                .bind(nick)
                .execute(db)
                .await
                .expect("server name");
        }
        let dan = Some("dan");
        assert_eq!(
            suggested(&state, dan, "rchat", "z").await,
            ["bob", "alice"],
            "in the order of the server names"
        );
        assert_eq!(suggested(&state, dan, "rchat", "ZO").await, ["alice"]);
        assert_eq!(suggested(&state, dan, "rchat", "bo").await, ["bob"]);
        let shown = |rows: Vec<serde_json::Value>| -> Vec<(String, String)> {
            rows.iter()
                .map(|r| {
                    (
                        r["username"].as_str().expect("name").to_string(),
                        r["display_name"].as_str().expect("shown").to_string(),
                    )
                })
                .collect()
        };
        let rows = mention_rows(&state, dan, "rchat", Some("z"))
            .await
            .unwrap_or_else(|e| panic!("mentions: {}", e.1));
        assert_eq!(
            shown(rows),
            [
                ("bob".to_string(), "ZEbra".to_string()),
                ("alice".to_string(), "Zorro".to_string())
            ]
        );
        sqlx::query("UPDATE servers SET profiles_mode = 'no_names' WHERE name = 'rchat'")
            .execute(db)
            .await
            .expect("mode");
        assert!(suggested(&state, dan, "rchat", "z").await.is_empty());
        let rows = mention_rows(&state, dan, "rchat", Some("bo"))
            .await
            .unwrap_or_else(|e| panic!("mentions: {}", e.1));
        assert_eq!(
            shown(rows),
            [("bob".to_string(), "Bob".to_string())],
            "no server names under no_names"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn mentions_suggest_what_the_member_list_suggests() {
        let (state, path) = temp_state("mentions").await;
        let db = &state.db;
        for (name, display) in [
            ("alice", "Alice"),
            ("albert", "Bertie"),
            ("bob", "Alfie"),
            ("carol", "ALma"),
            ("dan", "Dan"),
            ("al_x", "x"),
            ("alzz", "z"),
        ] {
            add_user(db, name, display).await;
            add_member(db, "rchat", name, 0, 0, 0).await;
        }
        for n in 0..12 {
            add_user(db, &format!("zz{n:02}"), "Zed").await;
            add_member(db, "rchat", &format!("zz{n:02}"), 0, 0, 0).await;
        }
        add_user(db, "alfred", "Alfred").await;
        let dan = Some("dan");
        let all = vec!["al_x", "albert", "alice", "alzz", "bob", "carol"];
        assert_eq!(
            mentioned(&state, dan, "rchat", Some("AL"))
                .await
                .expect("al"),
            all
        );
        assert_eq!(
            suggested(&state, dan, "rchat", "AL").await,
            all,
            "members?suggest=1 agrees"
        );
        assert_eq!(
            mentioned(&state, dan, "rchat", Some(" al_ "))
                .await
                .expect("escaped"),
            vec!["al_x"]
        );
        for q in ["zed", "zz"] {
            assert_eq!(
                mentioned(&state, dan, "rchat", Some(q))
                    .await
                    .expect(q)
                    .len(),
                SUGGEST_MAX
            );
        }
        assert_eq!(
            mentioned(&state, dan, "rchat", Some("ber"))
                .await
                .expect("ber"),
            vec!["albert"]
        );
        assert_eq!(
            mentioned(&state, None, "rchat", Some("al"))
                .await
                .expect("guest"),
            Vec::<String>::new(),
            "guests get no suggestions"
        );
        assert_eq!(
            mentioned(&state, Some("alfred"), "rchat", Some("ber"))
                .await
                .expect("public server"),
            vec!["albert"],
            "anyone signed in may look in a server anyone can read"
        );
        let refused = |res: Result<Vec<String>, ApiError>| match res {
            Ok(names) => panic!("answered {names:?}"),
            Err(ApiError(code, text, reason)) => (code, text, reason.map(|r| *r)),
        };
        for q in [None, Some(""), Some("   ")] {
            assert_eq!(
                refused(mentioned(&state, dan, "rchat", q).await),
                invalid("Search text needs at least 1 character", "q"),
                "{q:?}"
            );
        }
        assert_eq!(
            refused(mentioned(&state, dan, "rchat", Some(&"a".repeat(33))).await),
            invalid("Search text must be at most 32 characters", "q")
        );
        assert!(
            mentioned(&state, dan, "rchat", Some(&"a".repeat(32)))
                .await
                .expect("32 characters")
                .is_empty()
        );
        for q in ["\0", "a\0", "\0al"] {
            assert_eq!(
                refused(mentioned(&state, dan, "rchat", Some(q)).await),
                invalid("Search text cannot contain NUL characters", "q"),
                "{q:?}"
            );
        }
        let _ = make_server(&state, "club").await.expect("club");
        sqlx::query("UPDATE servers SET password_hash = '!none' WHERE name = 'club'")
            .execute(db)
            .await
            .expect("protect");
        let missing = refused(mentioned(&state, Some("bob"), "nowhere", Some("al")).await);
        assert_eq!(missing.0, StatusCode::NOT_FOUND);
        for who in [Some("bob"), None] {
            assert_eq!(
                refused(mentioned(&state, who, "club", Some("al")).await),
                missing,
                "a password server you're not in is the uniform 404"
            );
        }
        assert_eq!(
            mentioned(&state, Some("alice"), "club", Some("al"))
                .await
                .expect("member"),
            vec!["alice"]
        );
        done(state, path).await;
    }

    /// zed is in town with alice; carol reads town without being a member and dan is zed's
    /// friend outside it.
    #[tokio::test]
    async fn mentions_follow_the_choices_and_the_server_option() {
        use crate::api::access::subjects::{
            ALL_CHOICES, Level, OWN_CHOICES, SITE_LEVELS, wanted_level,
        };
        let (state, path) = temp_state("mention_choices").await;
        let state = state.with_limits(std::sync::Arc::new(crate::limits::Limits {
            lookup_typeahead_per_minute: 10_000,
            ..crate::limits::Limits::default()
        }));
        let db = &state.db;
        for name in ["alice", "carol", "dan", "zed"] {
            add_user(db, name, name).await;
        }
        sqlx::query(
            "INSERT INTO servers(name, display_name, created_at) VALUES('town', 'Town', 0)",
        )
        .execute(db)
        .await
        .expect("town");
        add_member(db, "town", "alice", 0, 0, 0).await;
        add_member(db, "town", "zed", 0, 0, 0).await;
        for (a, b) in [("dan", "zed"), ("zed", "dan")] {
            sqlx::query("INSERT INTO friends(username, friend, created_at) VALUES($1, $2, 1)")
                .bind(a)
                .bind(b)
                .execute(db)
                .await
                .expect("friends");
        }
        for (site, instance) in SITE_LEVELS {
            for (allowed, choices) in ALL_CHOICES {
                for (key, value) in [("profile_visibility", site), ("profile_choices", allowed)] {
                    sqlx::query("UPDATE settings SET value = $1 WHERE key = $2")
                        .bind(value)
                        .bind(key)
                        .execute(db)
                        .await
                        .expect("setting");
                }
                Settings::forget(db);
                for choice in OWN_CHOICES {
                    sqlx::query("INSERT INTO privacy(username, profile) VALUES('zed', $1) ON CONFLICT(username) DO UPDATE SET profile = excluded.profile")
                        .bind(choice)
                        .execute(db)
                        .await
                        .expect("choice");
                    let level = wanted_level(instance, choices, choice);
                    for visible in [true, false] {
                        sqlx::query("UPDATE servers SET members_visible = $1 WHERE name = 'town'")
                            .bind(i64::from(visible))
                            .execute(db)
                            .await
                            .expect("option");
                        let what = format!("{site}, {allowed}, {choice:?}, visible {visible}");
                        for (who, want) in [
                            ("alice", level >= Level::Shared),
                            ("carol", visible && level >= Level::Shared),
                            ("dan", visible),
                        ] {
                            let found = mentioned(&state, Some(who), "town", Some("ze"))
                                .await
                                .expect("mentions");
                            assert_eq!(found.contains(&"zed".to_string()), want, "{who}: {what}");
                            assert_eq!(
                                suggested(&state, Some(who), "town", "ze").await,
                                found,
                                "{who}, members?suggest=1: {what}"
                            );
                        }
                    }
                }
            }
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn ban_and_interacted_cursors_walk_everything() {
        let (state, path) = temp_state("pair_cursor").await;
        let db = &state.db;
        let cid = make_server(&state, "club").await.expect("club").0.channels[0].id;
        for i in 0..23 {
            sqlx::query("INSERT INTO server_bans(server, username, banned_by, created_at) VALUES('club', $1, 'alice', $2)")
                .bind(format!("b{i:02}"))
                .bind(1000 + i / 3)
                .execute(db)
                .await
                .expect("ban");
            sqlx::query(
                "INSERT INTO interactions(server, username, last_at) VALUES('club', $1, $2)",
            )
            .bind(format!("i{i:02}"))
            .bind(500 + i / 4)
            .execute(db)
            .await
            .expect("interaction");
            wrote(db, cid, &format!("i{i:02}"), 500 + i / 4, None).await;
        }
        add_member(db, "club", "i05", 0, 0, 0).await;
        let walk = |interacted: bool| {
            let state = state.clone();
            async move {
                let mut seen = Vec::new();
                let mut cursor: Option<String> = None;
                loop {
                    let q = MembersQuery {
                        offset: None,
                        limit: Some(5),
                        cursor: cursor.clone(),
                    };
                    let Paged(names, next) = match interacted {
                        true => {
                            let Paged(list, next) = list_interacted(
                                State(state.clone()),
                                MaybeAuthed(None),
                                HeaderMap::new(),
                                Path("club".to_string()),
                                Query(q),
                                Query(ListScope { channel_id: None }),
                            )
                            .await
                            .expect("interacted");
                            Paged(list.into_iter().map(|u| u.username).collect(), next)
                        }
                        false => {
                            let Paged(list, next) = list_bans(
                                State(state.clone()),
                                Authed(mem_user("alice", false)),
                                Path("club".to_string()),
                                Query(q),
                            )
                            .await
                            .expect("bans");
                            Paged(
                                list.into_iter()
                                    .map(|b| b.user.username)
                                    .collect::<Vec<_>>(),
                                next,
                            )
                        }
                    };
                    seen.extend(names);
                    match next {
                        Some(next) => cursor = Some(next),
                        None => return seen,
                    }
                }
            }
        };
        let bans_seen = walk(false).await;
        let mut want: Vec<String> = (0..23).map(|i| format!("b{i:02}")).collect();
        want.sort_by(|a, b| b.cmp(a));
        assert_eq!(bans_seen, want);
        let seen = walk(true).await;
        let mut want: Vec<String> = (0..23)
            .filter(|i| *i != 5)
            .map(|i| format!("i{i:02}"))
            .collect();
        want.sort_by(|a, b| b.cmp(a));
        assert_eq!(seen, want);
        done(state, path).await;
    }

    type Walk = Vec<(Vec<String>, Option<String>)>;

    /// Every page of `club`'s `interacted` list for `who` (a guest for `None`), one name a page,
    /// with the cursor each page gave.
    async fn interacted_walk(state: &AppState, who: Option<User>) -> Walk {
        let mut pages = Vec::new();
        let mut cursor = None;
        while pages.len() < 20 {
            let Paged(list, next) = list_interacted(
                State(state.clone()),
                MaybeAuthed(who.clone()),
                HeaderMap::new(),
                Path("club".to_string()),
                Query(MembersQuery {
                    offset: None,
                    limit: Some(1),
                    cursor,
                }),
                Query(ListScope { channel_id: None }),
            )
            .await
            .expect("interacted");
            pages.push((list.into_iter().map(|u| u.username).collect(), next.clone()));
            match next {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        pages
    }

    fn walked(walk: &Walk) -> Vec<String> {
        walk.iter().flat_map(|(names, _)| names.clone()).collect()
    }

    async fn wrote(db: &Db, cid: i64, author: &str, at: i64, root: Option<i64>) -> i64 {
        sqlx::query("INSERT INTO messages(channel_id, thread_root_id, author, content, created_at) VALUES($1, $2, $3, 'hi', $4) RETURNING id")
            .bind(cid)
            .bind(root)
            .bind(author)
            .bind(at)
            .fetch_one(db)
            .await
            .expect("message")
            .try_get(0)
            .expect("id")
    }

    /// Sets `club`'s interactions to the newest message of each author there, as sending them
    /// would have.
    async fn interactions_from_messages(db: &Db) {
        sqlx::query("DELETE FROM interactions WHERE server = 'club'")
            .execute(db)
            .await
            .expect("clear");
        sqlx::query("INSERT INTO interactions(server, username, last_at) SELECT 'club', m.author, MAX(m.created_at) FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.server = 'club' GROUP BY m.author")
            .execute(db)
            .await
            .expect("interactions");
    }

    /// `club` (public): `general`, `staff` that needs a role to view, and `archive` that bob
    /// reads without history; alice owns it, bob and carol joined at 1000; ann, ben, cat, dan
    /// and eve left it. Returns the channel ids and the archive root sent before bob joined.
    async fn interacted_world(state: &AppState) -> (i64, i64, i64, i64) {
        let db = &state.db;
        let _ = make_server(state, "club").await.expect("club");
        sqlx::query("UPDATE servers SET public_read = 1 WHERE name = 'club'")
            .execute(db)
            .await
            .expect("public");
        let general: i64 =
            sqlx::query("SELECT id FROM channels WHERE server = 'club' AND name = 'general'")
                .fetch_one(db)
                .await
                .expect("general")
                .try_get(0)
                .expect("id");
        let channel = |name: &'static str, restrict: i64| async move {
            sqlx::query("INSERT INTO channels(server, name, created_at, restrict_view) VALUES('club', $1, 1, $2) RETURNING id")
                .bind(name)
                .bind(restrict)
                .fetch_one(db)
                .await
                .expect("channel")
                .try_get::<i64, _>(0)
                .expect("id")
        };
        let staff = channel("staff", 1).await;
        let archive = channel("archive", 0).await;
        sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'u:bob', 1, 1, 0)")
            .bind(archive)
            .execute(db)
            .await
            .expect("no history for bob");
        for name in ["alice", "bob", "carol", "ann", "ben", "cat", "dan", "eve"] {
            crate::db::NewUser::plain(name).at(1).add(db).await;
        }
        add_member(db, "club", "bob", 0, 0, 1000).await;
        add_member(db, "club", "carol", 0, 0, 1000).await;
        wrote(db, general, "ann", 100, None).await;
        wrote(db, general, "cat", 150, None).await;
        wrote(db, general, "ben", 200, None).await;
        let root = wrote(db, archive, "alice", 600, None).await;
        (general, staff, archive, root)
    }

    #[tokio::test]
    async fn an_empty_hidden_channel_preserves_interacted_pages_and_cursors() {
        let (state, path) = temp_state("interacted_pages").await;
        empty_hidden_channel(&state).await;
        done(state, path).await;
        if let Some((state, temp)) = crate::api::test_util::pg_state("interacted_pages").await {
            empty_hidden_channel(&state).await;
            crate::api::test_util::pg_done(state, temp).await;
        }
    }

    async fn empty_hidden_channel(state: &AppState) {
        let db = &state.db;
        let general = make_server(state, "club").await.unwrap().0.channels[0].id;
        for name in ["bob", "zed", "pat", "ann", "ben", "vic"] {
            crate::db::NewUser::plain(name).at(1).add(db).await;
        }
        add_member(db, "club", "bob", 0, 0, 1).await;
        add_member(db, "club", "pat", 0, 0, 1).await;
        give_role(db, "club", "pat", Perm::ManageChannels as i64).await;
        sqlx::query("INSERT INTO channels(server, name, kind, created_at) VALUES('club', 'talk', 'voice', 1)")
            .execute(db).await.unwrap();
        wrote(db, general, "ann", 100, None).await;
        wrote(db, general, "ben", 120, None).await;
        wrote(db, general, "ann", 130, None).await;
        sqlx::query("INSERT INTO interactions(server, username, last_at) VALUES('club', 'ann', 100), ('club', 'ben', 120), ('club', 'vic', 150)")
            .execute(db).await.unwrap();

        let readers = [
            Some(mem_user("bob", false)),
            None,
            Some(mem_user("zed", false)),
            Some(mem_user("pat", false)),
            Some(mem_user("root", true)),
        ];
        let mut before = Vec::new();
        for reader in &readers {
            before.push(interacted_walk(state, reader.clone()).await);
        }
        let _ = create_channel(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            Path("club".into()),
            Json(CreateChannelReq {
                name: "staff".into(),
                kind: None,
                text_only: false,
                restrict_view: true,
                category_id: None,
            }),
        )
        .await
        .expect("empty restricted channel");

        for (reader, pages) in readers.into_iter().zip(before) {
            let current = interacted_walk(state, reader.clone()).await;
            assert_eq!(current, pages, "every page and cursor stays the same");
            let names: &[&str] = match reader.as_ref().map(|u| u.username.as_str()) {
                Some("pat" | "root") => &["vic", "ben", "ann"],
                _ => &["ann", "ben"],
            };
            assert_eq!(walked(&current), names);
            let Paged(list, next) = list_interacted(
                State(state.clone()),
                MaybeAuthed(reader),
                HeaderMap::new(),
                Path("club".into()),
                Query(MembersQuery {
                    offset: None,
                    limit: Some(1),
                    cursor: pages[0].1.clone(),
                }),
                Query(ListScope { channel_id: None }),
            )
            .await
            .expect("continue from the first page");
            assert_eq!(
                (list[0].username.as_str(), next),
                (names[1], pages[1].1.clone())
            );
        }
    }

    async fn former_members(state: &AppState, name: &str) -> Result<usize, ApiError> {
        list_interacted(
            State(state.clone()),
            MaybeAuthed(Some(mem_user(name, false))),
            HeaderMap::new(),
            Path("club".into()),
            Query(MembersQuery {
                offset: None,
                limit: None,
                cursor: None,
            }),
            Query(ListScope { channel_id: None }),
        )
        .await
        .map(|Paged(rows, _)| rows.len())
    }

    async fn list_waiter(state: &AppState, name: &str) {
        let caller = mem_user(name, false);
        while !crate::api::search_limits::list_waiting(state, &caller) {
            tokio::task::yield_now().await;
        }
    }

    fn rate_response(error: ApiError, wait: u64) {
        use axum::response::IntoResponse;
        let reason = error.2.as_ref().expect("a reason");
        assert_eq!(
            (reason.kind, reason.retry_after),
            (ReasonKind::Rate, Some(wait))
        );
        let response = error.into_response();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(response.headers()["retry-after"], wait.to_string());
    }

    #[tokio::test]
    async fn interacted_pages_share_a_single_reader() {
        use crate::api::{search_limits, test_util};
        use crate::config::AppConfig;
        use crate::instance::{Instance, InstanceConfig};

        async fn check(state: &AppState) {
            let state = &state
                .clone()
                .with_limits(std::sync::Arc::new(crate::limits::Limits {
                    lookup_list_per_minute: 10,
                    message_search_concurrent_limit: Some(10),
                    ..crate::limits::Limits::default()
                }));
            assert_eq!(state.read().options().get_max_connections(), 1);
            let (_, staff, _, _) = interacted_world(state).await;
            wrote(&state.db, staff, "eve", 300, None).await;
            interactions_from_messages(&state.db).await;
            let held = search_limits::admit_interacted(state, Some(&mem_user("carol", false)))
                .await
                .expect("one running list");
            let mut waiting = Box::pin(former_members(state, "bob"));
            tokio::select! {
                answer = &mut waiting => panic!("expected a waiter: {answer:?}"),
                _ = list_waiter(state, "bob") => {}
            }
            drop(waiting);
            assert!(!search_limits::list_waiting(state, &mem_user("bob", false)));
            rate_response(former_members(state, "bob").await.unwrap_err(), 2);
            drop(held);
            for _ in 0..5 {
                assert_eq!(
                    former_members(state, "bob")
                        .await
                        .expect("readable former members"),
                    3
                );
            }
            assert_eq!(
                former_members(state, "bob").await.unwrap_err().0,
                StatusCode::TOO_MANY_REQUESTS
            );
            assert_eq!(
                former_members(state, "alice").await.expect("activity list"),
                4
            );
        }

        for readers in ["1", "0"] {
            let (state, path) = test_util::temp_state_env(
                "list_one_reader",
                &[("DATABASE_READ_CONNECTIONS", readers)],
            )
            .await;
            check(&state).await;
            done(state, path).await;
        }

        let opts = AppConfig::from_map(&[("DATABASE_MAX_CONNECTIONS", "1")])
            .unwrap()
            .db_options();
        let open = async |url: &str| {
            let db = crate::db::open_with(Some(url), &opts).await.unwrap();
            let instance = Instance::load(&db, &InstanceConfig::default())
                .await
                .unwrap();
            AppState::new(db, Hub::new(), None, None, instance)
        };
        let memory = open("sqlite://interacted?mode=memory").await;
        check(&memory).await;
        crate::db::close(&memory.db).await;
        if let Some(pg) = test_util::pg_temp("list_one_reader").await {
            let state = open(&pg.url).await;
            check(&state).await;
            test_util::pg_done(state, pg).await;
        }
    }

    #[tokio::test]
    async fn interacted_waiters_leave_the_read_pool_and_lookup_budget_available() {
        use crate::api::{search_limits, test_util};
        use crate::limits::Limits;
        use std::time::Duration;
        use tokio::time::timeout;

        let (state, path) =
            test_util::temp_state_env("interacted_limit", &[("DATABASE_READ_CONNECTIONS", "2")])
                .await;
        let state = state.with_limits(std::sync::Arc::new(Limits {
            lookup_list_per_minute: 1,
            message_search_concurrent_limit: Some(10),
            ..Limits::default()
        }));
        interacted_world(&state).await;
        let held = search_limits::admit(&state, Some(&mem_user("carol", false)))
            .await
            .unwrap();
        rate_response(
            former_members(&state, "bob")
                .await
                .expect_err("one reader stays free"),
            2,
        );
        let mut older = Box::pin(former_members(&state, "bob"));
        tokio::select! {
            answer = &mut older => panic!("expected a waiter: {answer:?}"),
            _ = list_waiter(&state, "bob") => {}
        }
        let mut newer = Box::pin(former_members(&state, "bob"));
        tokio::select! {
            answer = &mut newer => panic!("expected a newer waiter: {answer:?}"),
            answer = older => rate_response(answer.unwrap_err(), 1)
        }
        let read = state.read();
        let mut connections = Vec::new();
        for _ in 0..2 {
            connections.push(
                timeout(Duration::from_secs(1), read.acquire())
                    .await
                    .expect("waiting for admission holds no read connection")
                    .unwrap(),
            );
        }
        drop(newer);
        assert!(!search_limits::list_waiting(
            &state,
            &mem_user("bob", false)
        ));
        drop(connections);
        drop(held);
        for _ in 0..5 {
            former_members(&state, "bob")
                .await
                .expect("the full list budget is available");
        }
        let error = former_members(&state, "bob").await.unwrap_err();
        assert_eq!(error.0, StatusCode::TOO_MANY_REQUESTS);
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_waiting_interacted_request_checks_membership_when_it_runs() {
        let (state, path) = temp_state("interacted_membership").await;
        interacted_world(&state).await;
        interactions_from_messages(&state.db).await;
        sqlx::query("UPDATE servers SET members_visible = 0 WHERE name = 'club'")
            .execute(&state.db)
            .await
            .unwrap();
        assert!(former_members(&state, "bob").await.unwrap() > 0);
        let held =
            crate::api::search_limits::admit_interacted(&state, Some(&mem_user("bob", false)))
                .await
                .unwrap();
        let mut next = Box::pin(former_members(&state, "bob"));
        tokio::select! {
            answer = &mut next => panic!("expected a waiter: {answer:?}"),
            _ = list_waiter(&state, "bob") => {}
        }
        sqlx::query("DELETE FROM members WHERE server = 'club' AND username = 'bob'")
            .execute(&state.db)
            .await
            .unwrap();
        drop(held);
        assert_eq!(next.await.unwrap(), 0, "outsiders cannot list the members");
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_burst_of_interacted_requests_leaves_room_for_a_server_read() {
        use std::time::Duration;
        use tokio::task::JoinSet;
        use tokio::time::Instant;
        use tokio::time::timeout;

        async fn blocked_lists(lock: &mut sqlx::Transaction<'_, sqlx::Any>) -> i64 {
            sqlx::query_scalar("SELECT COUNT(*) FROM pg_locks WHERE relation = 'messages'::regclass AND database = (SELECT oid FROM pg_database WHERE datname = current_database()) AND NOT granted")
                .fetch_one(&mut **lock).await.unwrap()
        }

        let Some((state, temp)) = crate::api::test_util::pg_state("interacted_burst").await else {
            return;
        };
        interacted_world(&state).await;
        let mut lock = state.db.begin().await.unwrap();
        sqlx::query("LOCK TABLE messages IN ACCESS EXCLUSIVE MODE")
            .execute(&mut *lock)
            .await
            .unwrap();
        let mut requests = JoinSet::new();
        let request = || {
            let state = state.clone();
            async move { former_members(&state, "bob").await }
        };
        requests.spawn(request());
        timeout(Duration::from_secs(4), async {
            loop {
                if blocked_lists(&mut lock).await == 1 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the first list query is running");
        for _ in 1..28 {
            requests.spawn(request());
        }
        timeout(Duration::from_secs(4), async {
            for _ in 0..26 {
                let refused = requests
                    .join_next()
                    .await
                    .unwrap()
                    .unwrap()
                    .expect_err("superseded request");
                rate_response(refused, 1);
            }
        })
        .await
        .expect("one request runs and one waits");
        assert_eq!(
            blocked_lists(&mut lock).await,
            1,
            "only one list query uses a connection"
        );
        let start = Instant::now();
        let detail = timeout(
            Duration::from_secs(2),
            get_server(
                State(state.clone()),
                MaybeAuthed(Some(mem_user("carol", false))),
                HeaderMap::new(),
                Path("club".into()),
            ),
        )
        .await
        .expect("a plain read completes while the list is blocked")
        .unwrap();
        assert_eq!(detail.0.name, "club");
        eprintln!("Server read with 28 list requests: {:?}", start.elapsed());
        lock.rollback().await.unwrap();
        while let Some(result) = requests.join_next().await {
            result
                .unwrap()
                .expect("the running request and its latest waiter finish");
        }
        crate::api::test_util::pg_done(state, temp).await;
    }

    #[tokio::test]
    async fn interacted_order_follows_only_what_the_caller_sees() {
        let (state, path) = temp_state("interacted_sight").await;
        interacted_sight(&state).await;
        done(state, path).await;
        if let Some((state, temp)) = crate::api::test_util::pg_state("interacted_sight").await {
            interacted_sight(&state).await;
            crate::api::test_util::pg_done(state, temp).await;
        }
    }

    async fn interacted_sight(state: &AppState) {
        let db = &state.db;
        let state = state.clone();
        let (_, staff, archive, root) = interacted_world(&state).await;
        let staff_ids = [
            wrote(db, staff, "dan", 800, None).await,
            wrote(db, staff, "ann", 900, None).await,
        ];
        let archive_ids = [
            wrote(db, archive, "eve", 500, None).await,
            wrote(db, archive, "ben", 1100, Some(root)).await,
        ];
        interactions_from_messages(db).await;
        let bob = || Some(mem_user("bob", false));
        let (bob_all, guest_all) = (
            interacted_walk(&state, bob()).await,
            interacted_walk(&state, None).await,
        );
        assert_eq!(walked(&bob_all), ["ben", "cat", "ann"]);
        assert_eq!(walked(&guest_all), ["ben", "eve", "cat", "ann"]);
        for who in [mem_user("alice", false), mem_user("root", true)] {
            assert_eq!(
                walked(&interacted_walk(&state, Some(who.clone())).await),
                ["ben", "ann", "dan", "eve", "cat"],
                "{} sees every channel",
                who.username
            );
        }
        for id in staff_ids {
            sqlx::query("DELETE FROM messages WHERE id = $1")
                .bind(id)
                .execute(db)
                .await
                .expect("delete");
        }
        interactions_from_messages(db).await;
        assert_eq!(interacted_walk(&state, bob()).await, bob_all);
        assert_eq!(
            interacted_walk(&state, None).await,
            guest_all,
            "the staff channel's activity changes neither order nor cursors"
        );
        for id in archive_ids {
            sqlx::query("DELETE FROM messages WHERE id = $1")
                .bind(id)
                .execute(db)
                .await
                .expect("delete");
        }
        interactions_from_messages(db).await;
        assert_eq!(
            interacted_walk(&state, bob()).await,
            bob_all,
            "messages bob may not read change neither order nor cursors"
        );
    }

    #[tokio::test]
    async fn interacted_cursors_open_only_for_their_caller() {
        let (state, path) = temp_state("interacted_sealed").await;
        interacted_sealed(&state).await;
        done(state, path).await;
        if let Some((state, temp)) = crate::api::test_util::pg_state("interacted_sealed").await {
            interacted_sealed(&state).await;
            crate::api::test_util::pg_done(state, temp).await;
        }
    }

    async fn interacted_sealed(state: &AppState) {
        let db = &state.db;
        let state = state.clone();
        let (general, _, _, _) = interacted_world(&state).await;
        let dan = wrote(db, general, "dan", 300, None).await.to_string();
        interactions_from_messages(db).await;
        let page = |who: Option<User>, cursor: Option<String>, offset: Option<i64>| {
            let state = state.clone();
            async move {
                list_interacted(
                    State(state),
                    MaybeAuthed(who),
                    HeaderMap::new(),
                    Path("club".to_string()),
                    Query(MembersQuery {
                        offset,
                        limit: Some(1),
                        cursor,
                    }),
                    Query(ListScope { channel_id: None }),
                )
                .await
                .map(|Paged(list, next)| {
                    (
                        list.into_iter().map(|u| u.username).collect::<Vec<_>>(),
                        next,
                    )
                })
            }
        };
        let bob = || Some(mem_user("bob", false));
        let (first, next) = page(bob(), None, None).await.expect("first page");
        assert_eq!(first, ["dan"]);
        let next = next.expect("a cursor");
        assert_eq!(decode_cursor(&next, 2).ok(), None);
        let (second, _) = page(bob(), Some(next.clone()), None).await.expect("second");
        assert_eq!(second, ["ben"]);
        let (by_offset, _) = page(bob(), None, Some(2)).await.expect("offset");
        assert_eq!(by_offset, ["cat"]);
        let refused = |res: Result<(Vec<String>, Option<String>), ApiError>| match res {
            Err(ApiError(StatusCode::BAD_REQUEST, msg, Some(_))) => msg,
            other => panic!(
                "expected the invalid cursor answer: {:?}",
                other.map(|p| p.0)
            ),
        };
        let uniform = refused(page(bob(), Some("zz".to_string()), None).await);
        assert_eq!(uniform, "Invalid cursor");
        let mut flipped = next.clone().into_bytes();
        let at = flipped.len() / 2;
        flipped[at] = if flipped[at] == b'A' { b'B' } else { b'A' };
        let flipped = String::from_utf8(flipped).expect("ascii");
        for (who, cursor) in [
            (bob(), encode_cursor(&[&dan, "dan"])),
            (bob(), encode_cursor(&["150", "zzz"])),
            (bob(), flipped),
            (Some(mem_user("carol", false)), next.clone()),
            (Some(mem_user("alice", false)), next.clone()),
            (None, next.clone()),
        ] {
            let name = who.as_ref().map(|u| u.username.clone());
            assert_eq!(
                refused(page(who, Some(cursor.clone()), None).await),
                uniform,
                "{name:?} with {cursor}"
            );
        }
    }

    async fn former_names(state: &AppState, who: Option<User>) -> Vec<String> {
        let Paged(list, _) = list_interacted(
            State(state.clone()),
            MaybeAuthed(who),
            HeaderMap::new(),
            Path("club".into()),
            Query(MembersQuery {
                offset: None,
                limit: None,
                cursor: None,
            }),
            Query(ListScope { channel_id: None }),
        )
        .await
        .expect("interacted");
        list.into_iter().map(|u| u.username).collect()
    }

    #[tokio::test]
    async fn former_members_follow_their_newest_readable_message() {
        let (state, path) = temp_state("interacted_order").await;
        newest_message_order(&state).await;
        done(state, path).await;
        if let Some((state, temp)) = crate::api::test_util::pg_state("interacted_order").await {
            newest_message_order(&state).await;
            crate::api::test_util::pg_done(state, temp).await;
        }
    }

    /// Message order, not send time: kit's only message comes first with the latest send time,
    /// and wren's newest message carries an earlier send time than her first one and lark's.
    async fn newest_message_order(state: &AppState) {
        let db = &state.db;
        let general = make_server(state, "club").await.unwrap().0.channels[0].id;
        sqlx::query("UPDATE servers SET public_read = 1 WHERE name = 'club'")
            .execute(db)
            .await
            .unwrap();
        for name in ["bob", "kit", "wren", "lark"] {
            crate::db::NewUser::plain(name).at(1).add(db).await;
        }
        add_member(db, "club", "bob", 0, 0, 1).await;
        wrote(db, general, "kit", 400, None).await;
        wrote(db, general, "wren", 300, None).await;
        wrote(db, general, "lark", 200, None).await;
        wrote(db, general, "wren", 100, None).await;
        interactions_from_messages(db).await;
        for who in [Some(mem_user("bob", false)), None] {
            let order = ["wren", "lark", "kit"];
            assert_eq!(former_names(state, who.clone()).await, order);
            assert_eq!(walked(&interacted_walk(state, who).await), order);
        }
    }

    /// Virtual machine steps SQLite takes for the former-member statement a guest's page of
    /// `club` runs, on a connection of its own to the database at `path`.
    async fn guest_seen_steps(state: &AppState, path: &std::path::Path) -> u64 {
        use sqlx::Connection;
        use std::sync::Arc;
        use std::sync::atomic::{AtomicU64, Ordering};

        let access = resolve_server(&state.db, "club", None, &Proof::none())
            .await
            .expect("club");
        let sql = seen_sql(&access.text_reading(2).sql);
        let mut conn =
            sqlx::sqlite::SqliteConnection::connect(&format!("sqlite://{}", path.display()))
                .await
                .expect("connect");
        let steps = Arc::new(AtomicU64::new(0));
        let counted = steps.clone();
        conn.lock_handle()
            .await
            .expect("handle")
            .set_progress_handler(1, move || {
                counted.fetch_add(1, Ordering::Relaxed);
                true
            });
        let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind("club")
            .bind(now())
            .fetch_all(&mut conn)
            .await
            .expect("seen");
        assert_eq!(rows.len(), 3);
        let taken = steps.load(Ordering::Relaxed);
        conn.close().await.expect("close");
        taken
    }

    #[tokio::test]
    async fn a_former_member_page_reads_one_message_per_author_and_channel() {
        let (state, path) = temp_state("interacted_cost").await;
        let db = &state.db;
        let (general, _, archive, _) = interacted_world(&state).await;
        interactions_from_messages(db).await;
        let shallow = guest_seen_steps(&state, &path).await;
        for channel in [general, archive] {
            sqlx::query("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 400) INSERT INTO messages(channel_id, author, content, created_at) SELECT $1, a.name, 'hi', 1 + n.i FROM n CROSS JOIN (SELECT 'ann' AS name UNION ALL SELECT 'ben' UNION ALL SELECT 'cat') a")
                .bind(channel)
                .execute(db)
                .await
                .expect("archive");
        }
        let deep = guest_seen_steps(&state, &path).await;
        assert!(
            deep < shallow * 2,
            "2,400 more messages by former members: {shallow} steps, then {deep}"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn channel_rules_that_change_while_a_list_waits_apply_to_its_page() {
        use std::time::Duration;
        use tokio::time::timeout;

        let Some((state, temp)) = crate::api::test_util::pg_state("interacted_moment").await else {
            return;
        };
        let db = &state.db;
        let (general, _, _, _) = interacted_world(&state).await;
        wrote(db, general, "ann", 1200, None).await;
        interactions_from_messages(db).await;
        sqlx::query("INSERT INTO interactions(server, username, last_at) VALUES('club', 'dan', 50), ('club', 'eve', 60)")
            .execute(db)
            .await
            .unwrap();
        let bob = || Some(mem_user("bob", false));
        assert_eq!(former_names(&state, bob()).await, ["ann", "ben", "cat"]);

        let mut lock = db.begin().await.unwrap();
        sqlx::query("LOCK TABLE messages IN ACCESS EXCLUSIVE MODE")
            .execute(&mut *lock)
            .await
            .unwrap();
        let waiting = tokio::spawn({
            let state = state.clone();
            async move { former_names(&state, bob()).await }
        });
        timeout(Duration::from_secs(4), async {
            loop {
                let blocked: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pg_locks WHERE relation = 'messages'::regclass AND database = (SELECT oid FROM pg_database WHERE datname = current_database()) AND NOT granted")
                    .fetch_one(&mut *lock)
                    .await
                    .unwrap();
                if blocked == 1 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the list waits for its activity read");
        let mut channel = async |name: &str| -> i64 {
            sqlx::query_scalar("INSERT INTO channels(server, name, created_at, restrict_view) VALUES('club', $1, 1, 1) RETURNING id")
                .bind(name)
                .fetch_one(&mut *lock)
                .await
                .unwrap()
        };
        let (vault, den) = (channel("vault").await, channel("den").await);
        let role: i64 = sqlx::query_scalar("INSERT INTO roles(server, name, color, perms) VALUES('club', 'den', '#ffffff', 0) RETURNING id")
            .fetch_one(&mut *lock)
            .await
            .unwrap();
        let rows = [
            (
                "INSERT INTO user_roles(server, username, role_id) VALUES('club', 'bob', $1)",
                role,
            ),
            (
                "INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'u:bob', 1, 1, 0)",
                general,
            ),
            (
                "INSERT INTO messages(channel_id, author, content, created_at) VALUES($1, 'dan', 'hi', 2000)",
                vault,
            ),
            (
                "INSERT INTO messages(channel_id, author, content, created_at) VALUES($1, 'eve', 'hi', 1500)",
                den,
            ),
        ];
        for (sql, id) in rows {
            sqlx::query(sql).bind(id).execute(&mut *lock).await.unwrap();
        }
        sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, $2, 1, 1, 1)")
            .bind(den)
            .bind(format!("r:{role}"))
            .execute(&mut *lock)
            .await
            .unwrap();
        lock.commit().await.unwrap();
        let page = waiting.await.unwrap();
        assert_eq!(
            page,
            ["eve", "ann"],
            "the page reads the channels, roles and rules of the moment it reads the activity"
        );
        assert_eq!(former_names(&state, bob()).await, page);
        crate::api::test_util::pg_done(state, temp).await;
    }

    #[tokio::test]
    async fn server_caps_and_counts() {
        let (state, path) = temp_state("server_caps").await;
        let db = &state.db;
        let _ = make_server(&state, "cap").await.expect("server");
        sqlx::query("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < $1) INSERT INTO channels(server, name, created_at) SELECT 'cap', 'c' || i, 0 FROM n")
            .bind(crate::limits::Limits::default().server_channels_max - 1)
            .execute(db)
            .await
            .expect("fill channels");
        let made = create_channel(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            Path("cap".to_string()),
            Json(CreateChannelReq {
                name: "extra".to_string(),
                kind: None,
                text_only: false,
                restrict_view: false,
                category_id: None,
            }),
        )
        .await;
        assert!(rejected(made));
        sqlx::query("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < $1) INSERT INTO roles(server, name, color, perms) SELECT 'cap', 'r' || i, '#ffffff', 0 FROM n")
            .bind(crate::limits::Limits::default().server_roles_max)
            .execute(db)
            .await
            .expect("fill roles");
        let role = create_role(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            Path("cap".to_string()),
            Json(RoleReq {
                name: "extra".to_string(),
                color: "#ffffff".to_string(),
                perms: 0,
                mentionable: false,
            }),
        )
        .await;
        assert!(rejected(role));
        let detail = |state: AppState| async move {
            get_server(
                State(state),
                MaybeAuthed(None),
                HeaderMap::new(),
                Path("cap".to_string()),
            )
            .await
            .expect("detail")
            .0
            .member_count
        };
        assert_eq!(detail(state.clone()).await, 1);
        add_user(db, "bob", "Bob").await;
        join(&state, "bob", "cap").await.expect("join");
        assert_eq!(detail(state.clone()).await, 2);
        let _ = leave_server(
            State(state.clone()),
            Authed(mem_user("bob", false)),
            Path("cap".to_string()),
        )
        .await
        .expect("leave");
        assert_eq!(detail(state.clone()).await, 1);
        let cid: i64 =
            sqlx::query("SELECT id FROM channels WHERE server = 'cap' AND name = 'general'")
                .fetch_one(db)
                .await
                .expect("general")
                .try_get(0)
                .expect("id");
        sqlx::query("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 230) INSERT INTO channel_perms(channel_id, subject) SELECT $1, 'u:p' || substr('000' || i, -3, 3) FROM n")
            .bind(cid)
            .execute(db)
            .await
            .expect("fill perms");
        crate::api::test_util::restrict_ruled(db).await;
        let mut seen = Vec::new();
        let mut cursor = None;
        loop {
            let Paged(perms, next) = list_channel_perms(
                State(state.clone()),
                Authed(mem_user("alice", false)),
                Path(cid),
                Query(ChannelPermsQuery {
                    limit: None,
                    cursor,
                }),
            )
            .await
            .expect("perms");
            assert!(perms.len() <= LIST_MAX as usize);
            seen.extend(perms.into_iter().map(|p| p.subject));
            match next {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        let want: Vec<String> = (1..=230).map(|i| format!("u:p{i:03}")).collect();
        assert_eq!(seen, want);
        done(state, path).await;
    }

    fn code<T>(res: Result<T, ApiError>) -> Result<(), (StatusCode, String)> {
        res.map(|_| ())
            .map_err(|ApiError(code, msg, _)| (code, msg))
    }

    async fn member_row(db: &Db, username: &str) -> (i64, i64) {
        let r = sqlx::query(
            "SELECT is_admin, perms FROM members WHERE server = 'club' AND username = $1",
        )
        .bind(username)
        .fetch_one(db)
        .await
        .expect("member row");
        (
            r.try_get(0).expect("is_admin"),
            r.try_get(1).expect("perms"),
        )
    }

    async fn role_row(db: &Db, id: i64) -> (String, String, i64) {
        let r = sqlx::query("SELECT name, color, perms FROM roles WHERE id = $1")
            .bind(id)
            .fetch_one(db)
            .await
            .expect("role row");
        (
            r.try_get(0).expect("name"),
            r.try_get(1).expect("color"),
            r.try_get(2).expect("perms"),
        )
    }

    async fn holds(db: &Db, username: &str, role: i64) -> bool {
        sqlx::query(
            "SELECT 1 FROM user_roles WHERE server = 'club' AND username = $1 AND role_id = $2",
        )
        .bind(username)
        .bind(role)
        .fetch_optional(db)
        .await
        .expect("holds")
        .is_some()
    }

    async fn new_role(db: &Db, name: &str, perms: i64) -> i64 {
        sqlx::query("INSERT INTO roles(server, name, color, perms) VALUES('club', $1, '#ffffff', $2) RETURNING id")
            .bind(name)
            .bind(perms)
            .fetch_one(db)
            .await
            .expect("role")
            .try_get(0)
            .expect("role id")
    }

    /// A server `club` of alice with `names` as members. Its role order is confirmed, as on
    /// every new server.
    async fn club_with(state: &AppState, names: &[&str]) {
        let db = &state.db;
        let _ = make_server(state, "club").await.expect("club");
        for name in names {
            add_user(db, name, name).await;
            join(state, name, "club").await.expect("join");
        }
        add_user(db, "root", "root").await;
        sqlx::query("UPDATE users SET is_site_admin = 1 WHERE username = 'root'")
            .execute(db)
            .await
            .expect("site admin");
    }

    const MA: i64 = Perm::ManageAdmins as i64 | Perm::ManageRoles as i64 | Perm::AssignRoles as i64;
    const KICK: i64 = Perm::Kick as i64;

    async fn grant(
        state: &AppState,
        actor: User,
        target: &str,
    ) -> Result<(), (StatusCode, String)> {
        code(
            grant_admin(
                State(state.clone()),
                Authed(actor),
                Path("club".to_string()),
                Json(UsernameReq {
                    username: target.to_string(),
                }),
            )
            .await,
        )
    }

    async fn set_perms(
        state: &AppState,
        actor: User,
        target: &str,
        perms: i64,
    ) -> Result<(), (StatusCode, String)> {
        code(
            set_admin_perms(
                State(state.clone()),
                Authed(actor),
                Path(("club".to_string(), target.to_string())),
                Json(PermsReq {
                    perms,
                    mask: Some(ALL_PERMS),
                }),
            )
            .await,
        )
    }

    async fn set_perms_json(
        state: &AppState,
        target: &str,
        body: serde_json::Value,
    ) -> Result<(), (StatusCode, String)> {
        code(
            set_admin_perms(
                State(state.clone()),
                Authed(mem_user("alice", false)),
                Path(("club".to_string(), target.to_string())),
                Json(serde_json::from_value(body).expect("perms body")),
            )
            .await,
        )
    }

    fn no_grant() -> Result<(), (StatusCode, String)> {
        Err((
            StatusCode::FORBIDDEN,
            "You can't grant permissions you don't have".to_string(),
        ))
    }

    #[tokio::test]
    async fn admin_grants_stay_within_the_actors_perms() {
        let (state, path) = temp_state("admin_escalation").await;
        let db = &state.db;
        club_with(&state, &["bob", "carol", "dave", "frank", "gina"]).await;
        set_admin_row(db, "bob", MA | KICK).await;
        set_admin_row(db, "dave", KICK).await;
        set_admin_row(db, "frank", 0).await;
        set_admin_row(db, "gina", 0).await;
        let bob = || mem_user("bob", false);
        assert_eq!(grant(&state, bob(), "carol").await, no_grant());
        assert_eq!(grant(&state, bob(), "bob").await, no_grant());
        assert_eq!(grant(&state, bob(), "dave").await, no_grant());
        assert_eq!(member_row(db, "carol").await, (0, 0));
        assert_eq!(member_row(db, "dave").await, (1, KICK));
        for perms in [0, ALL_PERMS, KICK | Perm::DeleteMessages as i64, MA | 8] {
            assert_eq!(
                set_perms(&state, bob(), "dave", perms)
                    .await
                    .map_err(|e| e.0),
                Err(StatusCode::FORBIDDEN),
                "{perms}"
            );
        }
        assert_eq!(set_perms(&state, bob(), "bob", 0).await, no_grant());
        assert_eq!(member_row(db, "dave").await, (1, KICK));
        assert_eq!(member_row(db, "bob").await, (1, MA | KICK));
        set_perms(&state, bob(), "dave", MA | KICK)
            .await
            .expect("equal is fine");
        set_perms(&state, bob(), "bob", MA)
            .await
            .expect("narrow yourself");
        assert_eq!(member_row(db, "bob").await, (1, MA));
        set_admin_row(db, "bob", MA | KICK).await;
        let delete = Perm::DeleteServer as i64;
        set_perms(&state, bob(), "gina", ALL_PERMS & !KICK)
            .await
            .expect("lowering a stronger admin is revoke-like");
        set_perms(&state, bob(), "gina", delete)
            .await
            .expect("lowering again");
        assert_eq!(member_row(db, "gina").await, (1, delete));
        for perms in [0, delete | KICK, delete | 1] {
            assert_eq!(set_perms(&state, bob(), "gina", perms).await, no_grant());
        }
        assert_eq!(member_row(db, "gina").await, (1, delete));
        set_perms(&state, bob(), "gina", KICK)
            .await
            .expect("a new mask within yours");
        assert_eq!(member_row(db, "gina").await, (1, KICK));
        code(
            revoke_admin(
                State(state.clone()),
                Authed(bob()),
                Path(("club".to_string(), "alice".to_string())),
            )
            .await,
        )
        .expect("revoking the creator stays allowed");
        assert_eq!(member_row(db, "alice").await, (0, 0));
        grant(&state, mem_user("frank", false), "carol")
            .await
            .expect("full admin grants");
        assert_eq!(member_row(db, "carol").await, (1, 0));
        grant(&state, mem_user("root", true), "alice")
            .await
            .expect("site admin grants");
        set_perms(&state, mem_user("root", true), "carol", 0)
            .await
            .expect("site admin sets");
        done(state, path).await;
    }

    async fn assign(
        state: &AppState,
        actor: User,
        role: i64,
        target: &str,
    ) -> Result<(), (StatusCode, String)> {
        code(
            assign_role(
                State(state.clone()),
                Authed(actor),
                Path(("club".to_string(), role)),
                Json(UsernameReq {
                    username: target.to_string(),
                }),
            )
            .await,
        )
    }

    async fn unassign(
        state: &AppState,
        actor: User,
        role: i64,
        target: &str,
    ) -> Result<(), (StatusCode, String)> {
        code(
            unassign_role(
                State(state.clone()),
                Authed(actor),
                Path(("club".to_string(), role, target.to_string())),
            )
            .await,
        )
    }

    #[tokio::test]
    async fn settings_and_invites_are_delegated_without_server_deletion() {
        use crate::api::passwords::{list_passwords, make_standing_invite};
        let (state, path) = temp_state("delegated_settings").await;
        let db = &state.db;
        club_with(&state, &["bob", "carol"]).await;
        give_role(db, "club", "bob", Perm::ManageServer as i64).await;
        give_role(db, "club", "carol", Perm::ManageInvites as i64).await;
        let club = || Path("club".to_string());
        let who = |name| Authed(mem_user(name, false));
        let change = |user| {
            update_server(
                State(state.clone()),
                who(user),
                club(),
                Json(serde_json::from_value(serde_json::json!({"protected":true})).expect("patch")),
            )
        };
        assert!(change("carol").await.is_err());
        let _ = change("bob").await.expect("settings");
        assert!(
            make_standing_invite(State(state.clone()), who("bob"), club())
                .await
                .is_err()
        );
        let _ = make_standing_invite(State(state.clone()), who("carol"), club())
            .await
            .expect("invite");
        for (name, rows) in [("carol", 1), ("bob", 0)] {
            let Json(settings) = list_passwords(State(state.clone()), who(name), club())
                .await
                .expect("settings");
            assert_eq!(settings.passwords.len(), rows);
            assert!(!settings.closed);
            assert!(
                delete_server(State(state.clone()), who(name), club())
                    .await
                    .is_err()
            );
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_masked_role_edit_cannot_restore_a_concurrently_revoked_grant() {
        let (state, path) = temp_state("role_edit_compare").await;
        let db = &state.db;
        club_with(&state, &[]).await;
        let id = new_role(db, "helper", Perm::ManageInvites as i64 | KICK).await;
        let baseline = require_role(db, "club", id).await.unwrap();
        edit(&state, mem_user("alice", false), id, None, Some(KICK))
            .await
            .unwrap();
        let mut tx = db.begin().await.unwrap();
        assert!(matches!(
            lock_role_version(&mut tx, "club", id, baseline, Some(false)).await,
            Err(ApiError(StatusCode::CONFLICT, _, _))
        ));
        tx.rollback().await.unwrap();
        assert_eq!(role_row(db, id).await.2, KICK);
        done(state, path).await;
    }

    #[tokio::test]
    async fn assignment_and_elevation_revalidate_the_role_in_both_orders() {
        let (state, path) = temp_state("assignment_elevation_lock").await;
        let db = &state.db;
        club_with(&state, &["bob", "carol"]).await;
        order_guard(&state.db, true).await;
        let editor = Perm::ManageRoles as i64 | KICK;
        give_role(db, "club", "bob", editor).await;
        give_role(db, "club", "carol", editor).await;
        let id = new_role(db, "helper", 0).await;
        let access = role_guard(&state, "club", &mem_user("bob", false), Perm::ManageRoles)
            .await
            .unwrap();
        require_role_change(db, &access, id, 0).await.unwrap();
        assign(&state, mem_user("alice", false), id, "carol")
            .await
            .unwrap();
        let mut tx = db.begin().await.unwrap();
        lock_role_version(&mut tx, "club", id, 0, Some(false))
            .await
            .unwrap();
        assert!(matches!(
            check_locked_role_edit(&mut tx, &access, id, 0, KICK, 0).await,
            Err(ApiError(StatusCode::FORBIDDEN, _, _))
        ));
        tx.rollback().await.unwrap();
        let unassigned = new_role(db, "other", 0).await;
        let seen = require_role(db, "club", unassigned).await.unwrap();
        edit(
            &state,
            mem_user("alice", false),
            unassigned,
            None,
            Some(KICK),
        )
        .await
        .unwrap();
        let mut tx = db.begin().await.unwrap();
        assert!(matches!(
            lock_role_version(&mut tx, "club", unassigned, seen, None).await,
            Err(ApiError(StatusCode::CONFLICT, _, _))
        ));
        tx.rollback().await.unwrap();
        assert_eq!(role_row(db, id).await.2, 0);
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_role_edit_cannot_reenable_mentions_after_they_are_revoked() {
        let (state, path) = temp_state("role_mention_compare").await;
        let db = &state.db;
        club_with(&state, &[]).await;
        let id = new_role(db, "helper", KICK).await;
        sqlx::query("UPDATE roles SET mentionable = 1 WHERE id = $1")
            .bind(id)
            .execute(db)
            .await
            .unwrap();
        let seen: i64 = sqlx::query_scalar("SELECT mentionable FROM roles WHERE id = $1")
            .bind(id)
            .fetch_one(db)
            .await
            .unwrap();
        sqlx::query("UPDATE roles SET mentionable = 0 WHERE id = $1")
            .bind(id)
            .execute(db)
            .await
            .unwrap();
        let mut tx = db.begin().await.unwrap();
        assert!(matches!(
            lock_role_version(&mut tx, "club", id, KICK, Some(seen != 0)).await,
            Err(ApiError(StatusCode::CONFLICT, _, _))
        ));
        tx.rollback().await.unwrap();
        let stored: i64 = sqlx::query_scalar("SELECT mentionable FROM roles WHERE id = $1")
            .bind(id)
            .fetch_one(db)
            .await
            .unwrap();
        assert_eq!(stored, 0);
        done(state, path).await;
    }

    #[tokio::test]
    async fn role_editors_and_assigners_delegate_independently() {
        let (state, path) = temp_state("delegated_roles").await;
        let db = &state.db;
        club_with(&state, &["bob", "carol", "dora"]).await;
        let editor = Perm::ManageRoles as i64;
        let assigner = Perm::AssignRoles as i64;
        give_role(db, "club", "bob", editor).await;
        give_role(db, "club", "carol", assigner).await;
        let role = new_role(db, "helper", 0).await;
        let bob = || mem_user("bob", false);
        let carol = || mem_user("carol", false);
        edit(&state, bob(), role, Some("helper team"), None)
            .await
            .expect("role editor");
        assert!(assign(&state, bob(), role, "dora").await.is_err());
        assign(&state, carol(), role, "dora")
            .await
            .expect("role assigner");
        assert!(
            edit(&state, carol(), role, Some("new name"), None)
                .await
                .is_err()
        );
        assert!(grant(&state, carol(), "dora").await.is_err());
        assert!(grant(&state, bob(), "dora").await.is_err());
        let admin = new_role(db, "admin", Perm::ManageAdmins as i64).await;
        assert!(assign(&state, carol(), admin, "carol").await.is_err());
        let other = role_guard(&state, "rchat", &bob(), Perm::ManageRoles).await;
        assert!(other.is_err());
        done(state, path).await;
    }

    #[tokio::test]
    async fn roles_stay_within_the_actors_perms() {
        let (state, path) = temp_state("role_escalation").await;
        let db = &state.db;
        club_with(&state, &["bob", "carol", "erin"]).await;
        order_guard(&state.db, true).await;
        set_admin_row(db, "bob", MA | KICK).await;
        set_admin_row(db, "erin", MA | KICK).await;
        let bob = || mem_user("bob", false);
        let create = |perms: i64| {
            let state = state.clone();
            async move {
                create_role(
                    State(state),
                    Authed(mem_user("bob", false)),
                    Path("club".to_string()),
                    Json(RoleReq {
                        name: "made".to_string(),
                        color: "#123456".to_string(),
                        perms,
                        mentionable: false,
                    }),
                )
                .await
                .map(|Json(role)| role.id)
            }
        };
        assert_eq!(code(create(Perm::DeleteServer as i64).await), no_grant());
        assert_eq!(code(create(ALL_PERMS).await), no_grant());
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM roles WHERE server = 'club'").await,
            0
        );
        let made = create(MA | KICK).await.expect("equal perms create");
        let patch = |name: Option<&str>, perms: Option<i64>| {
            let state = state.clone();
            let name = name.map(str::to_string);
            async move {
                update_role(
                    State(state),
                    Authed(mem_user("bob", false)),
                    Path(("club".to_string(), made)),
                    Json(RolePatch {
                        mask: Some(ALL_PERMS),
                        name,
                        color: None,
                        perms,
                        mentionable: None,
                        icon: None,
                        hoist: None,
                        color_names: None,
                    }),
                )
                .await
            }
        };
        assert_eq!(
            code(patch(Some("renamed"), Some(ALL_PERMS)).await),
            no_grant()
        );
        assert_eq!(
            role_row(db, made).await,
            ("made".to_string(), "#123456".to_string(), MA | KICK)
        );
        let _ = patch(Some("renamed"), Some(KICK))
            .await
            .expect("narrower edit");
        assert_eq!(role_row(db, made).await.2, KICK);
        let high = new_role(db, "high", ALL_PERMS).await;
        let foreign = new_role(db, "foreign", Perm::DeleteServer as i64).await;
        let equal = new_role(db, "equal", MA | KICK).await;
        let low = new_role(db, "low", KICK).await;
        let plain = new_role(db, "plain", 0).await;
        let peer = Err((
            StatusCode::FORBIDDEN,
            "You can't moderate this member".to_string(),
        ));
        for role in [high, foreign] {
            for target in ["carol", "bob"] {
                assert_eq!(assign(&state, bob(), role, target).await, no_grant());
                assert!(!holds(db, target, role).await);
            }
            assert_eq!(assign(&state, bob(), role, "erin").await, peer);
            assert!(!holds(db, "erin", role).await);
        }
        assign(&state, bob(), low, "carol")
            .await
            .expect("lower role");
        assign(&state, bob(), equal, "carol")
            .await
            .expect("equal role");
        assign(&state, bob(), plain, "bob")
            .await
            .expect("plain role on yourself");
        assert_eq!(
            assign(&state, bob(), plain, "carol").await,
            peer,
            "carol now has as much as bob"
        );
        assert_eq!(assign(&state, bob(), low, "erin").await, peer, "a peer");
        assert_eq!(
            assign(&state, bob(), low, "alice").await,
            peer,
            "a stronger admin"
        );
        assert!(!holds(db, "erin", low).await && !holds(db, "alice", low).await);
        hold(db, "erin", low).await;
        hold(db, "alice", low).await;
        let alice = || mem_user("alice", false);
        assign(&state, alice(), high, "carol")
            .await
            .expect("a full admin assigns an all-perms role");
        assign(&state, alice(), high, "alice")
            .await
            .expect("a full admin assigns it to themselves");
        for (role, target) in [(low, "erin"), (high, "carol"), (low, "alice")] {
            assert_eq!(unassign(&state, bob(), role, target).await, peer);
            assert!(holds(db, target, role).await);
        }
        unassign(&state, bob(), plain, "bob")
            .await
            .expect("dropping your own role");
        let root = || mem_user("root", true);
        unassign(&state, root(), high, "carol")
            .await
            .expect("site admin bypasses");
        assign(&state, root(), foreign, "erin")
            .await
            .expect("site admin bypasses");
        unassign(&state, alice(), equal, "carol")
            .await
            .expect("alice unassigns");
        unassign(&state, bob(), low, "carol")
            .await
            .expect("a member you can moderate");
        assert!(!holds(db, "carol", low).await && !holds(db, "carol", equal).await);
        done(state, path).await;
    }

    #[tokio::test]
    async fn role_edits_keep_manage_reports() {
        let (state, path) = temp_state("role_reports").await;
        let db = &state.db;
        club_with(&state, &["bob"]).await;
        let id = new_role(db, "mod", KICK).await;
        edit(
            &state,
            mem_user("alice", false),
            id,
            None,
            Some(ALL_PERMS | (1 << 17)),
        )
        .await
        .expect("every bit");
        assert_eq!(role_row(db, id).await.2, ALL_PERMS);
        let _ = update_role(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            Path(("club".to_string(), id)),
            Json(serde_json::from_value(serde_json::json!({"perms":516})).expect("patch")),
        )
        .await
        .expect("masked update");
        assert_eq!(role_row(db, id).await.2, (ALL_PERMS & !1023) | 516);
        edit(&state, mem_user("alice", false), id, None, Some(516))
            .await
            .expect("kick and reports");
        assert_eq!(role_row(db, id).await.2, 516);
        let _ = update_role(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            Path(("club".to_string(), id)),
            Json(
                serde_json::from_value(serde_json::json!({"perms":516 | Perm::AssignRoles as i64}))
                    .expect("patch"),
            ),
        )
        .await
        .expect("stale echo");
        assert_eq!(role_row(db, id).await.2, 516);
        let reports = |name: &str, site_admin: bool| {
            let user = mem_user(name, site_admin);
            async move {
                resolve_server(db, "club", Some(&user), &Proof::none())
                    .await
                    .expect("access")
                    .require_perm(db, Perm::ManageReports)
                    .await
                    .is_ok()
            }
        };
        assert!(!reports("bob", false).await);
        hold(db, "bob", id).await;
        assert!(reports("bob", false).await);
        assert!(reports("alice", false).await);
        assert!(reports("root", true).await);
        done(state, path).await;
    }

    #[tokio::test]
    async fn admin_edits_from_old_apps_keep_manage_reports() {
        let (state, path) = temp_state("admin_reports_mask").await;
        let db = &state.db;
        club_with(&state, &["bob", "carol", "dave"]).await;
        let (reports, timeout) = (Perm::ManageReports as i64, Perm::TimeoutMembers as i64);
        set_admin_row(db, "bob", MA | KICK | reports).await;
        set_admin_row(db, "carol", 0).await;
        set_admin_row(db, "dave", KICK).await;
        let set = |target: &'static str, body: serde_json::Value| {
            let state = state.clone();
            async move { set_perms_json(&state, target, body).await.expect(target) }
        };
        set("bob", serde_json::json!({ "perms": MA | KICK | timeout })).await;
        assert_eq!(
            member_row(db, "bob").await,
            (1, MA | KICK | timeout | reports)
        );
        set("carol", serde_json::json!({ "perms": 511 & !KICK })).await;
        assert_eq!(member_row(db, "carol").await, (1, ALL_PERMS & !KICK));
        set("dave", serde_json::json!({ "perms": reports })).await;
        assert_eq!(member_row(db, "dave").await, (1, reports));
        set("dave", serde_json::json!({ "perms": 0 })).await;
        assert_eq!(member_row(db, "dave").await, (1, 0));
        let unsupported = set_perms(&state, mem_user("alice", false), "dave", 1024 | 2048).await;
        assert!(matches!(unsupported, Err((StatusCode::BAD_REQUEST, _))));
        assert_eq!(member_row(db, "dave").await, (1, 0));
        let every = |perms: i64| serde_json::json!({ "perms": perms, "mask": ALL_PERMS });
        set("bob", every(MA | KICK)).await;
        assert_eq!(member_row(db, "bob").await, (1, MA | KICK));
        set("carol", every(511 & !KICK)).await;
        assert_eq!(member_row(db, "carol").await, (1, 511 & !KICK));
        let invites = Perm::ManageInvites as i64;
        set("bob", every(KICK | invites)).await;
        set("bob", serde_json::json!({"perms":KICK, "mask":1023})).await;
        assert_eq!(member_row(db, "bob").await.1, KICK | invites);
        set("bob", every(KICK)).await;
        for body in [
            serde_json::json!({"perms":KICK | invites}),
            serde_json::json!({"perms":KICK | invites,"mask":1023}),
        ] {
            set("bob", body).await;
            assert_eq!(member_row(db, "bob").await.1, KICK);
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn manage_reports_counts_for_role_holders_above_you() {
        let (state, path) = temp_state("role_reports_above").await;
        let db = &state.db;
        club_with(&state, &["bob", "carol"]).await;
        order_guard(&state.db, true).await;
        set_admin_row(db, "bob", MA | KICK).await;
        let low = new_role(db, "low", KICK).await;
        let reports = new_role(db, "reports", Perm::ManageReports as i64).await;
        hold(db, "carol", low).await;
        hold(db, "carol", reports).await;
        let mut above = vec![low, reports];
        above.sort_unstable();
        assert_eq!(limits_of(&state, mem_user("bob", false)).await.0, above);
        assert_eq!(
            edit(&state, mem_user("bob", false), low, Some("x"), None).await,
            forbid("You can't change a role held by a member you can't moderate")
        );
        assert_eq!(role_row(db, low).await.0, "low");
        done(state, path).await;
    }

    #[tokio::test]
    async fn every_permission_counts_for_role_holders_above_you() {
        let (state, path) = temp_state("role_bits_above").await;
        let db = &state.db;
        club_with(&state, &["bob", "carol"]).await;
        order_guard(&state.db, true).await;
        set_admin_row(db, "bob", MA | KICK).await;
        for bit in (0..i64::BITS).map(|i| 1i64 << i) {
            if ALL_PERMS & bit == 0 {
                continue;
            }
            let id = new_role(db, &format!("bit{bit}"), bit).await;
            hold(db, "carol", id).await;
            let above = match bit & !(MA | KICK) {
                0 => vec![],
                _ => vec![id],
            };
            assert_eq!(
                limits_of(&state, mem_user("bob", false)).await.0,
                above,
                "{bit}"
            );
            sqlx::query("DELETE FROM user_roles WHERE username = 'carol'")
                .execute(db)
                .await
                .expect("unhold");
        }
        done(state, path).await;
    }

    async fn hold(db: &Db, username: &str, role: i64) {
        sqlx::query("INSERT INTO user_roles(server, username, role_id) VALUES('club', $1, $2)")
            .bind(username)
            .bind(role)
            .execute(db)
            .await
            .expect("hold");
    }

    async fn edit(
        state: &AppState,
        actor: User,
        role: i64,
        name: Option<&str>,
        perms: Option<i64>,
    ) -> Result<(), (StatusCode, String)> {
        code(
            update_role(
                State(state.clone()),
                Authed(actor),
                Path(("club".to_string(), role)),
                Json(RolePatch {
                    mask: Some(ALL_PERMS),
                    name: name.map(str::to_string),
                    color: None,
                    perms,
                    mentionable: None,
                    icon: None,
                    hoist: None,
                    color_names: None,
                }),
            )
            .await,
        )
    }

    async fn drop_role(
        state: &AppState,
        actor: User,
        role: i64,
    ) -> Result<(), (StatusCode, String)> {
        code(
            delete_role(
                State(state.clone()),
                Authed(actor),
                Path(("club".to_string(), role)),
            )
            .await,
        )
    }

    async fn limits_of(state: &AppState, who: User) -> (Vec<i64>, Vec<i64>, Vec<i64>) {
        let RoleLimits {
            held_above,
            channel_grants,
            channel_denies,
        } = detail_as(state, "club", Some(&who))
            .await
            .expect("detail")
            .role_limits;
        (held_above, channel_grants, channel_denies)
    }

    fn forbid(msg: &str) -> Result<(), (StatusCode, String)> {
        Err((StatusCode::FORBIDDEN, msg.to_string()))
    }

    #[tokio::test]
    async fn role_edits_and_deletes_need_every_holder_below_you() {
        let (state, path) = temp_state("role_holders").await;
        let db = &state.db;
        club_with(&state, &["bob", "carol", "dave", "erin", "fay", "gina"]).await;
        order_guard(&state.db, true).await;
        set_admin_row(db, "bob", MA | KICK).await;
        set_admin_row(db, "erin", MA | KICK).await;
        set_admin_row(db, "gina", 0).await;
        let (bob, alice, root) = (
            || mem_user("bob", false),
            || mem_user("alice", false),
            || mem_user("root", true),
        );
        let held = forbid("You can't change a role held by a member you can't moderate");
        let foreign_msg = forbid("You can't change a role that has permissions you don't have");
        let peer = new_role(db, "peer", KICK).await;
        hold(db, "carol", peer).await;
        hold(db, "erin", peer).await;
        let ma = new_role(db, "ma", MA).await;
        let kick = new_role(db, "kick", KICK).await;
        hold(db, "dave", ma).await;
        hold(db, "dave", kick).await;
        let full = new_role(db, "full", KICK).await;
        hold(db, "gina", full).await;
        let lower = new_role(db, "lower", KICK).await;
        hold(db, "fay", lower).await;
        hold(db, "bob", lower).await;
        let foreign = new_role(db, "foreign", Perm::DeleteServer as i64).await;
        assert_eq!(limits_of(&state, bob()).await.0, {
            let mut ids = vec![peer, ma, kick, full];
            ids.sort_unstable();
            ids
        });
        for role in [peer, ma, kick, full] {
            assert_eq!(edit(&state, bob(), role, None, Some(0)).await, held);
            assert_eq!(edit(&state, bob(), role, Some("x"), None).await, held);
            assert_eq!(drop_role(&state, bob(), role).await, held);
            assert_ne!(role_row(db, role).await.0, "x");
        }
        assert_eq!(role_row(db, peer).await.2, KICK);
        assert_eq!(
            edit(&state, bob(), foreign, Some("x"), None).await,
            foreign_msg
        );
        assert_eq!(drop_role(&state, bob(), foreign).await, foreign_msg);
        assert_eq!(role_row(db, foreign).await.0, "foreign");
        assert_eq!(
            edit(&state, bob(), lower, None, Some(MA | KICK | 1)).await,
            no_grant()
        );
        assert_eq!(role_row(db, lower).await.2, KICK);
        edit(&state, bob(), lower, Some("raised"), Some(MA))
            .await
            .expect("raise within your own perms");
        edit(&state, bob(), lower, Some("lowered"), Some(0))
            .await
            .expect("lower a role held by yourself and someone below you");
        assert_eq!(
            role_row(db, lower).await,
            ("lowered".to_string(), "#ffffff".to_string(), 0)
        );
        edit(&state, bob(), lower, None, Some(MA | KICK))
            .await
            .expect("raise to equal");
        assert_eq!(edit(&state, bob(), lower, None, Some(0)).await, held);
        assert_eq!(drop_role(&state, bob(), lower).await, held);
        edit(&state, alice(), lower, None, Some(KICK))
            .await
            .expect("alice lowers it");
        drop_role(&state, bob(), lower).await.expect("delete");
        assert_eq!(limits_of(&state, alice()).await.0, vec![full]);
        edit(&state, alice(), peer, Some("helpers"), Some(0))
            .await
            .expect("a full admin edits a role held by lesser members");
        edit(&state, alice(), ma, None, Some(ALL_PERMS))
            .await
            .expect("a full admin raises one");
        assert_eq!(drop_role(&state, alice(), full).await, held);
        assert_eq!(drop_role(&state, alice(), kick).await, held);
        drop_role(&state, alice(), peer)
            .await
            .expect("full admin deletes");
        assert_eq!(limits_of(&state, root()).await, (vec![], vec![], vec![]));
        edit(&state, root(), full, Some("root"), Some(ALL_PERMS))
            .await
            .expect("site admin bypasses");
        drop_role(&state, root(), full)
            .await
            .expect("site admin bypasses");
        drop_role(&state, root(), foreign)
            .await
            .expect("site admin bypasses");
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM roles WHERE server = 'club'").await,
            2
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn role_channel_rules_limit_assign_and_delete() {
        let (state, path) = temp_state("role_channels").await;
        let db = &state.db;
        club_with(&state, &["bob", "carol"]).await;
        set_admin_row(db, "bob", MA | KICK).await;
        let (bob, alice) = (|| mem_user("bob", false), || mem_user("alice", false));
        let cid: i64 = sqlx::query("SELECT id FROM channels WHERE server = 'club'")
            .fetch_one(db)
            .await
            .expect("channel")
            .try_get(0)
            .expect("id");
        let rule = |subject: String, view: i64, send: i64| async move {
            sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, $2, $3, $4, 0)")
                .bind(cid)
                .bind(subject)
                .bind(view)
                .bind(send)
                .execute(db)
                .await
                .expect("rule");
            crate::api::test_util::restrict_ruled(db).await;
        };
        let vip = new_role(db, "vip", 0).await;
        rule(format!("r:{vip}"), 1, 1).await;
        assert_eq!(limits_of(&state, bob()).await, (vec![], vec![vip], vec![]));
        assert_eq!(
            assign(&state, bob(), vip, "carol").await,
            forbid("This role gives channel access you don't have")
        );
        assert_eq!(
            assign(&state, bob(), vip, "bob").await,
            forbid("This role gives channel access you don't have")
        );
        assert!(!holds(db, "bob", vip).await);
        assert_eq!(limits_of(&state, alice()).await, (vec![], vec![], vec![]));
        assign(&state, alice(), vip, "carol")
            .await
            .expect("Manage channels assigns");
        rule("u:bob".to_string(), 1, 0).await;
        assert_eq!(limits_of(&state, bob()).await, (vec![], vec![vip], vec![]));
        assert_eq!(
            assign(&state, bob(), vip, "bob").await.map_err(|e| e.0),
            Err(StatusCode::FORBIDDEN)
        );
        sqlx::query("UPDATE channel_perms SET can_send = 1 WHERE subject = 'u:bob'")
            .execute(db)
            .await
            .expect("send");
        assert_eq!(limits_of(&state, bob()).await, (vec![], vec![], vec![]));
        assign(&state, bob(), vip, "bob")
            .await
            .expect("access you already have");
        drop_role(&state, bob(), vip)
            .await
            .expect("not the only rule any more");
        assert_eq!(
            count(
                db,
                "SELECT COUNT(*) FROM channel_perms WHERE subject LIKE 'r:%'"
            )
            .await,
            0
        );
        sqlx::query("DELETE FROM channel_perms")
            .execute(db)
            .await
            .expect("clear rules");
        sqlx::query("UPDATE channels SET restrict_view = 0")
            .execute(db)
            .await
            .expect("open channel");
        let quiet = new_role(db, "quiet", 0).await;
        sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, $2, 1, 0, 1)")
            .bind(cid)
            .bind(format!("r:{quiet}"))
            .execute(db)
            .await
            .expect("override");
        assert_eq!(
            limits_of(&state, bob()).await,
            (vec![], vec![], vec![quiet])
        );
        assert_eq!(
            drop_role(&state, bob(), quiet).await.map_err(|e| e.0),
            Err(StatusCode::FORBIDDEN)
        );
        sqlx::query("UPDATE channels SET restrict_send = 1")
            .execute(db)
            .await
            .expect("restrict send");
        assert_eq!(limits_of(&state, bob()).await, (vec![], vec![], vec![]));
        drop_role(&state, bob(), quiet)
            .await
            .expect("deleting it only narrows access");
        done(state, path).await;
    }

    #[tokio::test]
    async fn revoking_admin_cannot_raise_anyone_above_you() {
        let (state, path) = temp_state("revoke_raise").await;
        let db = &state.db;
        club_with(&state, &["bob", "dave", "erin", "frank", "gina"]).await;
        for (who, perms) in [
            ("bob", MA | KICK),
            ("dave", KICK),
            ("erin", KICK),
            ("frank", KICK),
            ("gina", KICK),
        ] {
            set_admin_row(db, who, perms).await;
        }
        let owner = new_role(db, "owner", ALL_PERMS).await;
        let mods = new_role(db, "mods", MA | KICK).await;
        hold(db, "dave", owner).await;
        hold(db, "erin", mods).await;
        hold(db, "gina", owner).await;
        let revoke = |actor: User, target: &str| {
            let state = state.clone();
            let target = target.to_string();
            async move {
                code(
                    revoke_admin(
                        State(state),
                        Authed(actor),
                        Path(("club".to_string(), target)),
                    )
                    .await,
                )
            }
        };
        let raises = forbid(REVOKE_RAISES);
        let bob = || mem_user("bob", false);
        assert_eq!(revoke(bob(), "dave").await, raises);
        assert_eq!(member_row(db, "dave").await, (1, KICK));
        revoke(bob(), "erin").await.expect("roles within yours");
        revoke(bob(), "alice")
            .await
            .expect("revoking still works on anyone");
        revoke(mem_user("root", true), "gina")
            .await
            .expect("site admin bypasses");
        sqlx::query("UPDATE members SET is_admin = 1, perms = 0 WHERE server = 'club' AND username = 'alice'")
            .execute(db)
            .await
            .expect("restore alice");
        revoke(mem_user("alice", false), "dave")
            .await
            .expect("a full admin can");
        hold(db, "bob", owner).await;
        assert_eq!(revoke(bob(), "bob").await, raises);
        let transfer = code(
            transfer_admin(
                State(state.clone()),
                Authed(bob()),
                Path("club".to_string()),
                Json(UsernameReq {
                    username: "frank".to_string(),
                }),
            )
            .await,
        );
        assert_eq!(transfer.map_err(|e| e.0), Err(StatusCode::FORBIDDEN));
        assert_eq!(member_row(db, "bob").await, (1, MA | KICK));
        assert_eq!(member_row(db, "frank").await, (1, KICK));
        done(state, path).await;
    }

    #[tokio::test]
    async fn role_updates_validate_everything_first() {
        let (state, path) = temp_state("role_atomic").await;
        let db = &state.db;
        club_with(&state, &[]).await;
        let id = new_role(db, "mods", KICK).await;
        let patch = |name: &str, color: &str, perms: Option<i64>| {
            let state = state.clone();
            let (name, color) = (name.to_string(), color.to_string());
            async move {
                update_role(
                    State(state),
                    Authed(mem_user("alice", false)),
                    Path(("club".to_string(), id)),
                    Json(RolePatch {
                        mask: Some(ALL_PERMS),
                        name: Some(name),
                        color: Some(color),
                        perms,
                        mentionable: None,
                        icon: None,
                        hoist: None,
                        color_names: None,
                    }),
                )
                .await
            }
        };
        let before = ("mods".to_string(), "#ffffff".to_string(), KICK);
        let err = patch("helpers", "red", Some(MA)).await.err().map(|e| e.0);
        assert_eq!(err, Some(StatusCode::BAD_REQUEST));
        assert_eq!(role_row(db, id).await, before);
        let err = patch(" ", "#000000", Some(MA)).await.err().map(|e| e.0);
        assert_eq!(err, Some(StatusCode::BAD_REQUEST));
        assert_eq!(role_row(db, id).await, before);
        let Json(role) = patch("helpers", "#00ff00", Some(MA | (1 << 17)))
            .await
            .expect("valid");
        assert_eq!(
            (role.name.as_str(), role.color.as_str(), role.perms),
            ("helpers", "#00ff00", MA)
        );
        assert_eq!(
            role_row(db, id).await,
            ("helpers".to_string(), "#00ff00".to_string(), MA)
        );
        done(state, path).await;
    }

    fn admin_events(
        rx: &mut tokio::sync::broadcast::Receiver<WsEvent>,
    ) -> Vec<(String, bool, i64)> {
        let mut out = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            if let WsEvent::AdminChanged {
                server: _,
                username,
                is_admin,
                perms,
            } = ev
            {
                out.push((username, is_admin, perms));
            }
        }
        out
    }

    #[tokio::test]
    async fn transfer_reports_stored_perms_and_cannot_escalate() {
        let (state, path) = temp_state("transfer_admin").await;
        let db = &state.db;
        club_with(&state, &["bob", "carol", "dave"]).await;
        set_admin_row(db, "bob", MA | KICK).await;
        set_admin_row(db, "dave", KICK).await;
        let transfer = |actor: &str, target: &str| {
            let state = state.clone();
            let (actor, target) = (actor.to_string(), target.to_string());
            async move {
                code(
                    transfer_admin(
                        State(state),
                        Authed(mem_user(&actor, false)),
                        Path("club".to_string()),
                        Json(UsernameReq { username: target }),
                    )
                    .await,
                )
            }
        };
        let mut rx = state.hub.subscribe();
        assert_eq!(transfer("bob", "carol").await, no_grant());
        assert_eq!(member_row(db, "carol").await, (0, 0));
        assert_eq!(member_row(db, "bob").await, (1, MA | KICK));
        transfer("bob", "dave")
            .await
            .expect("restricted admin target");
        assert_eq!(member_row(db, "dave").await, (1, KICK));
        assert_eq!(member_row(db, "bob").await, (0, 0));
        assert_eq!(
            admin_events(&mut rx),
            [
                ("dave".to_string(), true, KICK),
                ("bob".to_string(), false, 0)
            ]
        );
        transfer("alice", "carol").await.expect("full admin");
        assert_eq!(member_row(db, "carol").await, (1, 0));
        assert_eq!(
            admin_events(&mut rx),
            [
                ("carol".to_string(), true, 0),
                ("alice".to_string(), false, 0)
            ]
        );
        join(&state, "root", "club").await.expect("root joins");
        set_admin_row(db, "root", MA).await;
        let as_root = |target: &str| {
            let state = state.clone();
            let target = target.to_string();
            async move {
                code(
                    transfer_admin(
                        State(state),
                        Authed(mem_user("root", true)),
                        Path("club".to_string()),
                        Json(UsernameReq { username: target }),
                    )
                    .await,
                )
            }
        };
        as_root("dave")
            .await
            .expect("site admin grants beyond own perms");
        assert_eq!(
            admin_events(&mut rx),
            [
                ("dave".to_string(), true, KICK),
                ("root".to_string(), false, 0)
            ]
        );
        as_root("bob").await.expect("staff without an admin row");
        assert_eq!(admin_events(&mut rx), [("bob".to_string(), true, 0)]);
        let actors: Vec<(Option<String>, i64)> = sqlx::query(
            "SELECT actor, staff FROM audit_log WHERE action = 'member.admin_transfer' ORDER BY id",
        )
        .fetch_all(db)
        .await
        .expect("entries")
        .iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect();
        assert_eq!(
            actors,
            [
                (Some("bob".to_string()), 0),
                (Some("alice".to_string()), 0),
                (Some("root".to_string()), 0),
                (None, 1)
            ]
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn channel_managers_can_toggle_text_only_for_their_server() {
        let (state, path) = temp_state("text_only_managers").await;
        club_with(&state, &["pat", "bob"]).await;
        give_role(&state.db, "club", "pat", Perm::ManageChannels as i64).await;
        let cid: i64 =
            sqlx::query("SELECT id FROM channels WHERE server = 'club' AND kind = 'text'")
                .fetch_one(&state.db)
                .await
                .expect("text channel")
                .get(0);
        let patch = |who: &str, text_only| {
            update_channel(
                State(state.clone()),
                Authed(mem_user(who, false)),
                Path(cid),
                Json(ChannelPatch {
                    text_only: Some(text_only),
                    ..Default::default()
                }),
            )
        };
        assert!(patch("alice", true).await.expect("owner").text_only);
        assert!(patch("bob", false).await.is_err());
        assert!(
            !patch("pat", false)
                .await
                .expect("channel manager")
                .text_only
        );
        let create = |kind| {
            create_channel(
                State(state.clone()),
                Authed(mem_user("pat", false)),
                Path("club".to_string()),
                Json(CreateChannelReq {
                    name: "quiet".to_string(),
                    kind: Some(kind),
                    text_only: true,
                    restrict_view: false,
                    category_id: None,
                }),
            )
        };
        assert!(matches!(
            create(ChannelKind::Voice).await,
            Err(ApiError(StatusCode::BAD_REQUEST, _, _))
        ));
        let created = create(ChannelKind::Text).await.expect("create text only").0;
        assert!(created.text_only);
        let flag: i64 = sqlx::query("SELECT text_only FROM channels WHERE id = $1")
            .bind(created.id)
            .fetch_one(&state.db)
            .await
            .expect("stored channel")
            .get(0);
        assert_eq!(flag, 1);
        done(state, path).await;
    }

    #[tokio::test]
    async fn rename_events_only_for_real_renames() {
        let (state, path) = temp_state("rename_events").await;
        let db = &state.db;
        club_with(&state, &[]).await;
        let mut rx = state.hub.subscribe();
        let kinds = |rx: &mut tokio::sync::broadcast::Receiver<WsEvent>| {
            let mut out = Vec::new();
            while let Ok(ev) = rx.try_recv() {
                match ev {
                    WsEvent::ServerRenamed { old_name, server } => {
                        out.push(format!("server_renamed {old_name} {}", server.display_name))
                    }
                    WsEvent::ServerUpdated { server } => out.push(format!(
                        "server_updated {} {}",
                        server.display_name, server.has_password
                    )),
                    WsEvent::ChannelRenamed { server: _, channel } => {
                        out.push(format!("channel_renamed {}", channel.name))
                    }
                    WsEvent::ChannelUpdated { server: _, channel } => out.push(format!(
                        "channel_updated {} {}",
                        channel.name, channel.slowmode_seconds
                    )),
                    _ => {}
                }
            }
            out
        };
        let patch =
            |body: &'static str| patch_server(&state, mem_user("alice", false), "club", body);
        patch(r#"{"password":"hunter22"}"#).await.expect("password");
        patch(r#"{"name":"club"}"#).await.expect("same name");
        patch(r##"{"banner_color":"#101010"}"##)
            .await
            .expect("color");
        patch(r#"{"name":"Club"}"#).await.expect("display rename");
        patch(r#"{"name":"Den"}"#).await.expect("rename");
        assert_eq!(
            kinds(&mut rx),
            [
                "server_updated club true",
                "server_updated club true",
                "server_updated club true",
                "server_renamed club Club",
                "server_renamed club Den",
            ]
        );
        let cid: i64 = sqlx::query("SELECT id FROM channels WHERE server = 'den'")
            .fetch_one(db)
            .await
            .expect("channel")
            .try_get(0)
            .expect("id");
        let channel = |name: Option<&str>, slowmode_seconds: Option<i64>| {
            let state = state.clone();
            let name = name.map(str::to_string);
            async move {
                update_channel(
                    State(state),
                    Authed(mem_user("alice", false)),
                    Path(cid),
                    Json(ChannelPatch {
                        name,
                        slowmode_seconds,
                        ..Default::default()
                    }),
                )
                .await
                .expect("channel patch")
            }
        };
        let current = channel(None, None).await.0.name;
        let _ = channel(None, Some(30)).await;
        let _ = channel(Some(&current), None).await;
        let _ = channel(Some("talk"), Some(0)).await;
        assert_eq!(
            kinds(&mut rx),
            [
                format!("channel_updated {current} 0"),
                format!("channel_updated {current} 30"),
                format!("channel_updated {current} 30"),
                "channel_renamed talk".to_string(),
            ]
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn channel_topics_are_cleaned_filtered_and_live() {
        let (state, path) = temp_state("channel_topics").await;
        let db = &state.db;
        crate::api::test_util::profanity_on(db).await;
        club_with(&state, &["bob"]).await;
        let cid: i64 = sqlx::query("SELECT id FROM channels WHERE server = 'club'")
            .fetch_one(db)
            .await
            .expect("channel")
            .try_get(0)
            .expect("id");
        let voice: i64 = sqlx::query("INSERT INTO channels(server, name, kind, created_at) VALUES('club', 'talk', 'voice', 0) RETURNING id")
            .fetch_one(db)
            .await
            .expect("voice")
            .try_get(0)
            .expect("voice id");
        let patch = |who: &str, id: i64, body: String| {
            let state = state.clone();
            let who = mem_user(who, false);
            async move {
                update_channel(
                    State(state),
                    Authed(who),
                    Path(id),
                    Json(serde_json::from_str(&body).expect("body")),
                )
                .await
                .map(|Json(c)| c.topic)
                .map_err(|ApiError(code, msg, _)| (code, msg))
            }
        };
        let body = |topic: serde_json::Value| serde_json::json!({ "topic": topic }).to_string();
        let mut rx = state.hub.subscribe();
        assert_eq!(
            patch("bob", cid, body("hi".into())).await.map_err(|e| e.0),
            Err(StatusCode::FORBIDDEN)
        );
        assert_eq!(
            patch(
                "alice",
                cid,
                body("  Rules: https://example.com\r\n\n\n\nbe\u{0007} nice \t".into())
            )
            .await
            .expect("set"),
            Some("Rules: https://example.com\n\nbe nice".to_string())
        );
        match rx.try_recv() {
            Ok(WsEvent::ChannelUpdated { server, channel }) => {
                assert_eq!(server, "club");
                assert_eq!(
                    channel.topic.as_deref(),
                    Some("Rules: https://example.com\n\nbe nice")
                );
            }
            _ => panic!("expected channel_updated"),
        }
        let max = "\u{1F600}".repeat(TOPIC_MAX);
        assert_eq!(
            patch("alice", cid, body(max.clone().into()))
                .await
                .expect("max"),
            Some(max.clone())
        );
        let over = patch("alice", cid, body(format!("{max}a").into())).await;
        assert!(
            matches!(&over, Err((StatusCode::BAD_REQUEST, m)) if m == "Topic must be at most 1024 characters")
        );
        assert_eq!(
            patch("alice", cid, r#"{"slowmode_seconds":5}"#.to_string())
                .await
                .expect("topic kept"),
            Some(max)
        );
        let rude = patch("alice", cid, body("what the fuck".into())).await;
        assert!(matches!(&rude, Err((StatusCode::BAD_REQUEST, m)) if m.contains("profanity")));
        sqlx::query("UPDATE settings SET value = '0' WHERE key = 'profanity_channel_topics'")
            .execute(db)
            .await
            .expect("topics off");
        crate::api::Settings::forget(db);
        assert_eq!(
            patch("alice", voice, body("what the fuck".into()))
                .await
                .expect("target off, voice ok"),
            Some("what the fuck".to_string())
        );
        assert!(
            check_profanity(db, ProfanityTarget::ChannelNames, "fuck")
                .await
                .is_err()
        );
        sqlx::query("UPDATE settings SET value = '1' WHERE key = 'profanity_channel_topics'")
            .execute(db)
            .await
            .expect("topics on");
        crate::api::Settings::forget(db);
        assert_eq!(
            patch("alice", voice, body(" \n ".into()))
                .await
                .expect("blank"),
            None
        );
        assert_eq!(
            patch("alice", cid, body(serde_json::Value::Null))
                .await
                .expect("null"),
            None
        );
        let stored: Option<String> = sqlx::query("SELECT topic FROM channels WHERE id = $1")
            .bind(cid)
            .fetch_one(db)
            .await
            .expect("row")
            .try_get(0)
            .expect("topic");
        assert_eq!(stored, None);
        patch("alice", cid, body("secret plans".into()))
            .await
            .expect("again");
        let bob = mem_user("bob", false);
        let detail = detail_as(&state, "club", Some(&bob)).await.expect("bob");
        assert!(
            detail
                .channels
                .iter()
                .any(|c| c.id == cid && c.topic.as_deref() == Some("secret plans"))
        );
        patch("alice", cid, r#"{"restrict_view":true}"#.to_string())
            .await
            .expect("hide");
        let detail = detail_as(&state, "club", Some(&bob)).await.expect("bob");
        assert!(detail.channels.iter().all(|c| c.id != cid));
        let stale = WsEvent::ChannelUpdated {
            server: "club".to_string(),
            channel: Channel {
                id: cid,
                name: "general".to_string(),
                kind: ChannelKind::Text,
                slowmode_seconds: 0,
                sensitive: false,
                text_only: false,
                restrict_view: false,
                restrict_send: false,
                topic: None,
                category_id: None,
                position: 0,
                perm_sync: false,
                my_perms: None,
            },
        };
        match crate::ws::current(&state, stale).await {
            Some(WsEvent::ChannelUpdated { server: _, channel }) => {
                assert_eq!(channel.topic.as_deref(), Some("secret plans"))
            }
            _ => panic!("expected the stored topic"),
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn channel_restrictions_are_live_and_gated() {
        let (state, path) = temp_state("restrict_live").await;
        let db = &state.db;
        club_with(&state, &["bob"]).await;
        let cid: i64 = sqlx::query("SELECT id FROM channels WHERE server = 'club'")
            .fetch_one(db)
            .await
            .expect("channel")
            .try_get(0)
            .expect("id");
        let mut rx = state.hub.subscribe();
        let patch = |who: &str, body: &'static str| {
            let state = state.clone();
            let who = mem_user(who, false);
            async move {
                update_channel(
                    State(state),
                    Authed(who),
                    Path(cid),
                    Json(serde_json::from_str(body).expect("body")),
                )
                .await
                .map(|Json(c)| (c.restrict_view, c.restrict_send))
                .map_err(|e| e.0)
            }
        };
        let bob = mem_user("bob", false);
        assert_eq!(
            patch("bob", r#"{"restrict_send":true}"#).await,
            Err(StatusCode::FORBIDDEN)
        );
        assert_eq!(
            patch("alice", r#"{"restrict_send":true}"#).await,
            Ok((false, true))
        );
        let detail = detail_as(&state, "club", Some(&bob)).await.expect("bob");
        assert_eq!(detail.read_only, vec![cid]);
        assert!(
            detail
                .channels
                .iter()
                .any(|c| c.id == cid && c.restrict_send)
        );
        assert_eq!(
            patch("alice", r#"{"restrict_send":true,"slowmode_seconds":30}"#).await,
            Ok((false, true))
        );
        assert_eq!(
            patch("alice", r#"{"restrict_view":true}"#).await,
            Ok((true, true))
        );
        let mut events = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            match ev {
                WsEvent::ChannelPermsChanged { server, channel_id } => {
                    events.push(format!("perms {server} {}", channel_id == cid))
                }
                WsEvent::ChannelUpdated { server, channel } => events.push(format!(
                    "updated {server} {} {} {}",
                    channel.restrict_view, channel.restrict_send, channel.slowmode_seconds
                )),
                _ => {}
            }
        }
        assert_eq!(
            events,
            [
                "perms club true",
                "updated club false true 0",
                "updated club false true 30",
                "perms club true",
                "updated club true true 30",
            ]
        );
        let detail = detail_as(&state, "club", Some(&bob)).await.expect("bob");
        assert!(detail.channels.iter().all(|c| c.id != cid));
        assert!(detail.read_only.is_empty());
        assert_eq!(
            resolve_channel(db, cid, Some(&bob), &Proof::none())
                .await
                .map(|_| ())
                .map_err(|e| e.0),
            Err(StatusCode::NOT_FOUND)
        );
        let alice = detail_as(&state, "club", Some(&mem_user("alice", false)))
            .await
            .expect("alice");
        assert!(
            alice
                .channels
                .iter()
                .any(|c| c.id == cid && c.restrict_view && c.restrict_send)
        );
        assert!(alice.read_only.is_empty());
        sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'u:bob', 1, 0, 1)")
            .bind(cid)
            .execute(db)
            .await
            .expect("bob may look");
        let detail = detail_as(&state, "club", Some(&bob)).await.expect("bob");
        assert_eq!(detail.read_only, vec![cid]);
        assert!(
            detail_as(&state, "club", None)
                .await
                .expect("guest")
                .channels
                .iter()
                .all(|c| c.id != cid)
        );
        let voice: i64 = sqlx::query("INSERT INTO channels(server, name, kind, created_at) VALUES('club', 'talk', 'voice', 0) RETURNING id")
            .fetch_one(db)
            .await
            .expect("voice")
            .try_get(0)
            .expect("voice id");
        let patch_voice = |body: &'static str| {
            let state = state.clone();
            async move {
                update_channel(
                    State(state),
                    Authed(mem_user("alice", false)),
                    Path(voice),
                    Json(serde_json::from_str(body).expect("body")),
                )
                .await
                .map(|Json(c)| (c.restrict_view, c.restrict_send))
                .map_err(|ApiError(code, msg, _)| (code, msg))
            }
        };
        assert_eq!(
            patch_voice(r#"{"restrict_send":true}"#).await,
            Err((
                StatusCode::BAD_REQUEST,
                "Require roles to send only applies to text channels".to_string()
            ))
        );
        assert_eq!(
            patch_voice(r#"{"restrict_view":true,"restrict_send":false}"#).await,
            Ok((true, false))
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn removing_a_deny_role_needs_manage_channels() {
        let (state, path) = temp_state("role_denies").await;
        let db = &state.db;
        club_with(&state, &["bob", "carol"]).await;
        set_admin_row(db, "bob", MA | KICK).await;
        let bob = || mem_user("bob", false);
        let cid: i64 = sqlx::query("SELECT id FROM channels WHERE server = 'club'")
            .fetch_one(db)
            .await
            .expect("channel")
            .try_get(0)
            .expect("id");
        let rule = |role: i64, view: i64, send: i64| async move {
            sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, $2, $3, $4, 1)")
                .bind(cid)
                .bind(format!("r:{role}"))
                .bind(view)
                .bind(send)
                .execute(db)
                .await
                .expect("rule");
        };
        let delete_widens = forbid(ROLE_DELETE_WIDENS);
        let unassign_widens = forbid(ROLE_UNASSIGN_WIDENS);
        let quiet = new_role(db, "quiet", 0).await;
        let other = new_role(db, "other", 0).await;
        rule(quiet, 1, 0).await;
        rule(other, 1, 1).await;
        assert_eq!(
            limits_of(&state, bob()).await,
            (vec![], vec![], vec![quiet]),
            "a send deny next to another rule still narrows an unrestricted channel"
        );
        assert_eq!(drop_role(&state, bob(), quiet).await, delete_widens);
        assert!(role_exists(db, quiet).await);
        drop_role(&state, bob(), other)
            .await
            .expect("an allow rule only narrows when deleted");
        sqlx::query("UPDATE channels SET restrict_send = 1 WHERE id = $1")
            .bind(cid)
            .execute(db)
            .await
            .expect("restrict send");
        let hidden = new_role(db, "hidden", 0).await;
        rule(hidden, 0, 0).await;
        assert_eq!(
            limits_of(&state, bob()).await,
            (vec![], vec![], vec![hidden]),
            "under restrict_send a view deny still narrows, a send deny no longer does"
        );
        assert_eq!(drop_role(&state, bob(), hidden).await, delete_widens);
        hold(db, "bob", hidden).await;
        hold(db, "carol", hidden).await;
        hold(db, "bob", quiet).await;
        assert_eq!(
            unassign(&state, bob(), hidden, "bob").await,
            unassign_widens
        );
        assert_eq!(
            unassign(&state, bob(), hidden, "carol").await,
            unassign_widens
        );
        assert!(holds(db, "bob", hidden).await && holds(db, "carol", hidden).await);
        unassign(&state, bob(), quiet, "bob")
            .await
            .expect("removing a role that doesn't widen access");
        assert!(!holds(db, "bob", quiet).await);
        set_admin_row(db, "bob", MA | KICK | Perm::ManageChannels as i64).await;
        assert_eq!(limits_of(&state, bob()).await, (vec![], vec![], vec![]));
        unassign(&state, bob(), hidden, "bob")
            .await
            .expect("Manage channels may widen");
        unassign(&state, bob(), hidden, "carol")
            .await
            .expect("Manage channels may widen");
        drop_role(&state, bob(), hidden)
            .await
            .expect("Manage channels deletes it");
        set_admin_row(db, "bob", MA | KICK).await;
        hold(db, "carol", quiet).await;
        sqlx::query("UPDATE channels SET restrict_send = 0, restrict_view = 1 WHERE id = $1")
            .bind(cid)
            .execute(db)
            .await
            .expect("restrict view only");
        assert_eq!(
            limits_of(&state, bob()).await,
            (vec![], vec![quiet], vec![]),
            "quiet now grants view bob lacks, but taking it away widens nothing"
        );
        unassign(&state, bob(), quiet, "carol")
            .await
            .expect("without the role carol sees nothing, so nothing widens");
        done(state, path).await;
    }

    async fn role_exists(db: &Db, id: i64) -> bool {
        sqlx::query("SELECT 1 FROM roles WHERE id = $1")
            .bind(id)
            .fetch_optional(db)
            .await
            .expect("role")
            .is_some()
    }

    #[tokio::test]
    async fn ending_membership_drops_the_servers_pings() {
        let (state, path) = temp_state("membership_pings").await;
        let db = &state.db;
        for name in ["alice", "bob", "carol", "dave"] {
            add_user(db, name, name).await;
        }
        add_member(db, "rchat", "alice", 1, 0, 1).await;
        for name in ["bob", "carol", "dave"] {
            add_member(db, "rchat", name, 0, 0, 1).await;
        }
        let mid: i64 = sqlx::query("INSERT INTO messages(channel_id, author, content, created_at) SELECT id, 'alice', 'hi', 1 FROM channels WHERE server = 'rchat' RETURNING id")
            .fetch_one(db)
            .await
            .expect("message")
            .try_get(0)
            .expect("id");
        for name in ["bob", "carol", "dave"] {
            for server in [Some("rchat"), None] {
                sqlx::query("INSERT INTO pings(username, kind, scope, server, message_id, actor, created_at) VALUES($1, 'mention', 'c1', $2, $3, 'alice', 1)")
                    .bind(name)
                    .bind(server)
                    .bind(mid)
                    .execute(db)
                    .await
                    .expect("ping");
            }
        }
        let left = |name: &'static str| async move {
            sqlx::query("SELECT server FROM pings WHERE username = $1")
                .bind(name)
                .fetch_all(db)
                .await
                .expect("pings")
                .iter()
                .map(|r| r.try_get::<Option<String>, _>(0).expect("server"))
                .collect::<Vec<_>>()
        };
        assert_eq!(left("bob").await.len(), 2);
        let _ = leave_server(
            State(state.clone()),
            Authed(mem_user("bob", false)),
            Path("rchat".to_string()),
        )
        .await
        .expect("leave");
        let _ = kick_member(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            Path("rchat".to_string()),
            Json(UsernameReq {
                username: "carol".to_string(),
            }),
        )
        .await
        .expect("kick");
        ban(&state, mem_user("alice", false), "rchat", "dave")
            .await
            .expect("ban");
        for name in ["bob", "carol", "dave"] {
            assert_eq!(
                left(name).await,
                vec![None],
                "{name} keeps only other pings"
            );
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn voice_is_rechecked_when_a_server_closes_or_roles_narrow() {
        let (state, path) = temp_state("voice_recheck").await;
        let db = &state.db;
        club_with(&state, &["carol"]).await;
        add_user(db, "zed", "zed").await;
        let cid: i64 = sqlx::query("INSERT INTO channels(server, name, kind, created_at) VALUES('club', 'talk', 'voice', 0) RETURNING id")
            .fetch_one(db)
            .await
            .expect("voice")
            .try_get(0)
            .expect("id");
        let _ = state.hub.voice_join("zed", 1, "club", cid).await;
        let _ = state.hub.voice_join("carol", 2, "club", cid).await;
        let inside = |state: &AppState| {
            let mut users: Vec<String> = state
                .hub
                .rooms_in("club", None)
                .into_iter()
                .flat_map(|(_, users)| users)
                .collect();
            users.sort();
            users
        };
        assert_eq!(inside(&state), ["carol", "zed"]);
        change_password(
            &state,
            mem_user("alice", false),
            "club",
            None,
            Some("club-password"),
            PasswordMembers::Keep,
        )
        .await
        .expect("protect");
        assert_eq!(
            inside(&state),
            ["carol"],
            "the outsider left with the password"
        );
        let muted = new_role(db, "muted", 0).await;
        sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, $2, 0, 0, 0)")
            .bind(cid)
            .bind(format!("r:{muted}"))
            .execute(db)
            .await
            .expect("deny rule");
        assign(&state, mem_user("alice", false), muted, "carol")
            .await
            .expect("assign");
        assert!(inside(&state).is_empty(), "a narrowing role ends the call");
        done(state, path).await;
    }

    #[tokio::test]
    async fn rules_written_here_are_marked_for_the_restrict_check() {
        let (state, path) = temp_state("rule_marks").await;
        club_with(&state, &["bob"]).await;
        let cid: i64 =
            sqlx::query("SELECT id FROM channels WHERE server = 'club' ORDER BY id LIMIT 1")
                .fetch_one(&state.db)
                .await
                .expect("channel")
                .try_get(0)
                .expect("id");
        for can_view in [false, true] {
            let _ = set_channel_perm(
                State(state.clone()),
                Authed(mem_user("alice", false)),
                Path(cid),
                Json(
                    serde_json::from_value(serde_json::json!({
                        "subject": "u:bob",
                        "can_view": can_view,
                        "can_send": true,
                        "can_read_history": true,
                    }))
                    .expect("rule"),
                ),
            )
            .await
            .expect("set rule");
        }
        assert_eq!(
            count(
                &state.db,
                "SELECT COUNT(*) FROM channel_perms WHERE restrict_set = 1"
            )
            .await,
            1,
            "inserted and updated rules are marked, so the next start leaves the channel open"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn invite_previews_follow_the_read_history_floor() {
        let (state, path) = temp_state("invite_floor").await;
        let db = &state.db;
        let _ = make_server(&state, "club").await.expect("club");
        add_user(db, "dave", "dave").await;
        let cid: i64 =
            sqlx::query("SELECT id FROM channels WHERE server = 'club' ORDER BY id LIMIT 1")
                .fetch_one(db)
                .await
                .expect("channel")
                .try_get(0)
                .expect("id");
        sqlx::query("INSERT INTO messages(channel_id, author, content, created_at) VALUES($1, 'alice', 'old news', 1)")
            .bind(cid)
            .execute(db)
            .await
            .expect("message");
        let before = invite_as(&state, Some(mem_user("dave", false)), "club", None, None)
            .await
            .expect("invite");
        assert_eq!(before.preview.len(), 1);
        sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'u:dave', 1, 1, 0)")
            .bind(cid)
            .execute(db)
            .await
            .expect("history rule");
        let after = invite_as(&state, Some(mem_user("dave", false)), "club", None, None)
            .await
            .expect("invite");
        assert!(after.preview.is_empty(), "no history means no old messages");
        let other = invite_as(&state, Some(mem_user("alice", false)), "club", None, None)
            .await
            .expect("invite");
        assert_eq!(other.preview.len(), 1);
        done(state, path).await;
    }

    #[tokio::test]
    async fn channels_can_start_restricted() {
        let (state, path) = temp_state("channel_restricted").await;
        let _ = make_server(&state, "club").await.expect("club");
        let Json(channel) = create_channel(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            Path("club".to_string()),
            Json(CreateChannelReq {
                name: "staff".to_string(),
                kind: None,
                text_only: false,
                restrict_view: true,
                category_id: None,
            }),
        )
        .await
        .expect("create");
        assert!(channel.restrict_view);
        assert_eq!(
            count(
                &state.db,
                &format!(
                    "SELECT COUNT(*) FROM channels WHERE id = {} AND restrict_view = 1",
                    channel.id
                )
            )
            .await,
            1
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn one_network_can_not_use_up_the_guest_grants_of_a_password() {
        let (state, path) = temp_state("grant_network").await;
        let db = &state.db;
        let _ = make_server(&state, "club").await.expect("club");
        set_password(&state, "club-password").await;
        let _ = make_server(&state, "den").await.expect("den");
        let _ = update_server(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            Path("den".to_string()),
            Json(ServerPatch {
                seal: Default::default(),
                name: None,
                password: Some("den-password".to_string()),
                protected: None,
                members: PasswordMembers::Keep,
                keep_guests: false,
                banner_color: None,
                name_color: None,
                public_read: None,
                guest_voice: None,
                guest_chat_opt_in: None,
                guest_voice_opt_in: None,
                members_visible: None,
                hide_members: None,
                join: None,
                listed: None,
                profiles_mode: None,
                description: None,
                icon_kind: None,
            }),
        )
        .await
        .expect("den password");
        let mint = |server: &'static str, from: std::net::IpAddr| {
            let state = state.clone();
            crate::api::budget::as_client(from, async move {
                guest_access(
                    State(state),
                    MaybeAuthed(None),
                    Path(server.to_string()),
                    Json(GuestAccessReq {
                        password: Some(format!("{server}-password")),
                    }),
                )
                .await
                .map(|Json(made)| made.grant.is_some())
                .map_err(|ApiError(status, body, _)| (status.as_u16(), body))
            })
        };
        let in_network = |n: u16| {
            std::net::IpAddr::V6(std::net::Ipv6Addr::new(0x2001, 0xdb8, 0x15d, n, 0, 0, 0, 1))
        };
        let mut made = 0;
        for n in 0..55 {
            match mint("club", in_network(n)).await {
                Ok(true) => made += 1,
                Ok(false) => panic!("no grant"),
                Err(e) => assert_eq!(e, (429, TOO_MANY_GUESTS.to_string())),
            }
        }
        assert_eq!(made, GRANTS_PER_NETWORK, "one /48 gets only its share");
        assert_eq!(
            count(
                db,
                "SELECT COUNT(*) FROM guest_grants WHERE server = 'club'"
            )
            .await,
            GRANTS_PER_NETWORK
        );
        assert_eq!(
            count(
                db,
                "SELECT COUNT(DISTINCT network) FROM guest_grants WHERE server = 'club' AND network LIKE 'n:%'"
            )
            .await,
            1,
            "the network is stored as a marker, not the address"
        );
        let other =
            std::net::IpAddr::V6(std::net::Ipv6Addr::new(0x2001, 0xdb8, 0x15e, 0, 0, 0, 0, 1));
        assert_eq!(
            mint("club", other).await,
            Ok(true),
            "a guest from another network still gets a grant"
        );
        let v4 = std::net::IpAddr::from([198, 51, 15, 9]);
        assert_eq!(mint("club", v4).await, Ok(true));
        let mut den = Vec::new();
        for n in 100..120 {
            den.push(mint("den", in_network(n)).await);
        }
        let spare = (GRANT_NETWORK_MINTS_MAX as usize) - 55;
        assert!(den[..spare].iter().all(|r| *r == Ok(true)));
        assert!(
            den[spare..]
                .iter()
                .all(|r| *r == Err((429, crate::api::budget::SLOW_DOWN.to_string()))),
            "the network mint budget spans all servers"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn guest_grant_caps_are_configurable() {
        let (state, path) = temp_state("grant_caps_set").await;
        let state = state.with_limits(std::sync::Arc::new(crate::limits::Limits {
            guest_grants_per_password: 4,
            guest_grants_per_network: 2,
            guest_grant_mints_per_network: 3,
            ..crate::limits::Limits::default()
        }));
        let _ = make_server(&state, "club").await.expect("club");
        set_password(&state, "club-password").await;
        let mint = |from: std::net::IpAddr| {
            let state = state.clone();
            crate::api::budget::as_client(from, async move {
                guest_access(
                    State(state),
                    MaybeAuthed(None),
                    Path("club".to_string()),
                    Json(GuestAccessReq {
                        password: Some("club-password".to_string()),
                    }),
                )
                .await
                .map(|Json(made)| made.grant.is_some())
                .map_err(|ApiError(status, body, _)| (status.as_u16(), body))
            })
        };
        let full = Err((429, TOO_MANY_GUESTS.to_string()));
        let net = |a: u8, b: u8| std::net::IpAddr::from([198, 51, a, b]);
        assert_eq!(mint(net(1, 1)).await, Ok(true));
        assert_eq!(mint(net(1, 2)).await, Ok(true));
        assert_eq!(mint(net(1, 3)).await, full, "two grants per network");
        assert_eq!(
            mint(net(1, 4)).await,
            Err((429, crate::api::budget::SLOW_DOWN.to_string())),
            "three mints an hour per network"
        );
        assert_eq!(mint(net(2, 1)).await, Ok(true));
        assert_eq!(mint(net(2, 2)).await, Ok(true));
        assert_eq!(mint(net(3, 1)).await, full, "four grants per password");
        done(state, path).await;
    }

    #[tokio::test]
    async fn guest_grants_per_password_are_capped() {
        let (state, path) = temp_state("grant_cap").await;
        let db = &state.db;
        let _ = make_server(&state, "club").await.expect("club");
        set_password(&state, "club-password").await;
        let t = now();
        for n in 0..GRANTS_PER_PASSWORD {
            sqlx::query("INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at) VALUES($1, 'club', $2, $2)")
                .bind(format!("h:live{n}"))
                .bind(t - n)
                .execute(db)
                .await
                .expect("grant");
        }
        let mint = |n: u32| {
            let state = state.clone();
            let from = std::net::IpAddr::from([198, 18, (n / 250) as u8, (n % 250) as u8]);
            crate::api::budget::as_client(from, async move {
                guest_access(
                    State(state),
                    MaybeAuthed(None),
                    Path("club".to_string()),
                    Json(GuestAccessReq {
                        password: Some("club-password".to_string()),
                    }),
                )
                .await
                .map(|Json(made)| made.grant.expect("grant"))
                .map_err(|ApiError(status, body, _)| (status.as_u16(), body))
            })
        };
        let live = "SELECT COUNT(*) FROM guest_grants WHERE server = 'club'";
        assert_eq!(
            mint(1).await,
            Err((429, TOO_MANY_GUESTS.to_string())),
            "a full password gives no new grant"
        );
        assert_eq!(
            count(db, live).await,
            GRANTS_PER_PASSWORD,
            "live grants of others never end for a new one"
        );
        sqlx::query("UPDATE guest_grants SET last_used_at = 1, created_at = 1 WHERE \"grant\" IN ('h:live0', 'h:live1', 'h:live2')")
            .execute(db)
            .await
            .expect("expire three");
        let results = futures_util::future::join_all((10..20).map(mint)).await;
        let made: Vec<String> = results.into_iter().filter_map(Result::ok).collect();
        assert_eq!(
            made.len(),
            3,
            "only expired grants make room, also under concurrency"
        );
        assert_eq!(count(db, live).await, GRANTS_PER_PASSWORD);
        assert_eq!(
            count(
                db,
                "SELECT COUNT(*) FROM guest_grants WHERE \"grant\" LIKE 'h:live%'"
            )
            .await,
            GRANTS_PER_PASSWORD - 3
        );
        assert_ne!(
            count(
                db,
                &format!(
                    "SELECT COUNT(*) FROM guest_grants WHERE \"grant\" = '{}'",
                    made[0]
                )
            )
            .await,
            1,
            "only the hash is stored"
        );
        assert!(grant_valid(&state, "club", &made[0]).await);
        done(state, path).await;
    }

    #[tokio::test]
    async fn categories_group_and_reorder_channels() {
        use crate::api::categories::{
            create_category, delete_category, rename_category, reorder_layout,
        };
        let (state, path) = temp_state("categories").await;
        let db = &state.db;
        crate::api::test_util::profanity_on(db).await;
        club_with(&state, &["bob"]).await;
        let alice = || Authed(mem_user("alice", false));
        let bob = || Authed(mem_user("bob", false));
        let club = || Path("club".to_string());
        fn body<T: serde::de::DeserializeOwned>(v: serde_json::Value) -> Json<T> {
            Json(serde_json::from_value(v).expect("body"))
        }
        let make = |name: &str, kind: &str, category: Option<i64>| {
            let state = state.clone();
            let v = serde_json::json!({ "name": name, "kind": kind, "category_id": category });
            async move {
                create_channel(
                    State(state),
                    Authed(mem_user("alice", false)),
                    Path("club".to_string()),
                    Json(serde_json::from_value(v).expect("body")),
                )
                .await
                .map(|Json(c)| c)
            }
        };
        let general: i64 = sqlx::query("SELECT id FROM channels WHERE server = 'club'")
            .fetch_one(db)
            .await
            .expect("general")
            .try_get(0)
            .expect("id");
        let talk = make("talk", "voice", None).await.expect("talk");
        assert_eq!((talk.category_id, talk.position), (None, 1));
        let mut rx = state.hub.subscribe();
        assert_eq!(
            code(
                create_category(
                    State(state.clone()),
                    bob(),
                    club(),
                    body(serde_json::json!({"name": "Games"}))
                )
                .await
            )
            .map_err(|e| e.0),
            Err(StatusCode::FORBIDDEN)
        );
        let games = create_category(
            State(state.clone()),
            alice(),
            club(),
            body(serde_json::json!({"name": "  Games  "})),
        )
        .await
        .expect("games")
        .0;
        assert_eq!((games.name.as_str(), games.position), ("Games", 0));
        match rx.try_recv() {
            Ok(WsEvent::LayoutChanged {
                server,
                layout,
                created,
                deleted: None,
                before: _,
                after: _,
            }) => {
                assert_eq!(server, "club");
                assert_eq!(created, None);
                assert_eq!(layout.version, 2);
                assert_eq!(layout.uncategorized, [general, talk.id]);
                assert_eq!(layout.categories[0].name, "Games");
            }
            _ => panic!("expected layout_changed"),
        }
        let rude = code(
            create_category(
                State(state.clone()),
                alice(),
                club(),
                body(serde_json::json!({"name": "fuck"})),
            )
            .await,
        );
        assert!(matches!(&rude, Err((StatusCode::BAD_REQUEST, m)) if m.contains("profanity")));
        sqlx::query("UPDATE settings SET value = '0' WHERE key = 'profanity_category_names'")
            .execute(db)
            .await
            .expect("off");
        crate::api::Settings::forget(db);
        let staff = create_category(
            State(state.clone()),
            alice(),
            club(),
            body(serde_json::json!({"name": "fuck"})),
        )
        .await
        .expect("target off")
        .0;
        assert!(
            check_profanity(db, ProfanityTarget::ChannelNames, "fuck")
                .await
                .is_err()
        );
        sqlx::query("UPDATE settings SET value = '1' WHERE key = 'profanity_category_names'")
            .execute(db)
            .await
            .expect("on");
        crate::api::Settings::forget(db);
        let renamed = rename_category(
            State(state.clone()),
            alice(),
            Path(staff.id),
            body(serde_json::json!({"name": "Staff"})),
        )
        .await
        .expect("rename")
        .0;
        assert_eq!(renamed.name, "Staff");
        assert_eq!(
            code(
                rename_category(
                    State(state.clone()),
                    bob(),
                    Path(staff.id),
                    body(serde_json::json!({"name": "Mine"}))
                )
                .await
            ),
            Err((StatusCode::NOT_FOUND, "Not found".to_string()))
        );
        assert_eq!(
            code(
                rename_category(
                    State(state.clone()),
                    alice(),
                    Path(9999),
                    body(serde_json::json!({"name": "Mine"}))
                )
                .await
            ),
            Err((StatusCode::NOT_FOUND, "Not found".to_string()))
        );
        let empty = create_category(
            State(state.clone()),
            alice(),
            club(),
            body(serde_json::json!({"name": "Empty"})),
        )
        .await
        .expect("empty")
        .0;
        let random = make("random", "text", Some(games.id))
            .await
            .expect("random");
        assert_eq!(random.category_id, Some(games.id));
        let lounge = make("lounge", "voice", Some(games.id))
            .await
            .expect("lounge");
        let secret = make("secret", "text", Some(staff.id))
            .await
            .expect("secret");
        sqlx::query("UPDATE channels SET restrict_view = 1 WHERE id = $1")
            .bind(secret.id)
            .execute(db)
            .await
            .expect("hide");
        let _ = make("other", "text", Some(i64::MAX))
            .await
            .map(|_| ())
            .map_err(|ApiError(c, _, _)| assert_eq!(c, StatusCode::NOT_FOUND));
        let seen = |d: &ServerDetail| {
            d.categories
                .iter()
                .map(|c| c.name.clone())
                .collect::<Vec<_>>()
        };
        let as_bob = detail_as(&state, "club", Some(&mem_user("bob", false)))
            .await
            .expect("bob");
        assert_eq!(seen(&as_bob), ["Games"]);
        assert!(as_bob.channels.iter().all(|c| c.id != secret.id));
        let as_alice = detail_as(&state, "club", Some(&mem_user("alice", false)))
            .await
            .expect("alice");
        assert_eq!(seen(&as_alice), ["Games", "Staff", "Empty"]);
        let version = as_alice.layout_version;
        let order = |version: i64, unc: Vec<i64>, cats: Vec<(i64, Vec<i64>)>| {
            serde_json::json!({
                "version": version,
                "uncategorized": unc,
                "categories": cats.into_iter().map(|(id, channels)| serde_json::json!({"id": id, "channels": channels})).collect::<Vec<_>>(),
            })
        };
        let wanted = order(
            version,
            vec![lounge.id, general],
            vec![
                (empty.id, vec![]),
                (games.id, vec![talk.id, random.id]),
                (staff.id, vec![secret.id]),
            ],
        );
        assert_eq!(
            code(reorder_layout(State(state.clone()), bob(), club(), body(wanted.clone())).await)
                .map_err(|e| e.0),
            Err(StatusCode::FORBIDDEN)
        );
        for broken in [
            order(
                version,
                vec![lounge.id],
                vec![
                    (empty.id, vec![]),
                    (games.id, vec![talk.id, random.id]),
                    (staff.id, vec![secret.id]),
                ],
            ),
            order(
                version,
                vec![lounge.id, general, general],
                vec![
                    (empty.id, vec![]),
                    (games.id, vec![talk.id, random.id]),
                    (staff.id, vec![secret.id]),
                ],
            ),
            order(
                version,
                vec![lounge.id, general],
                vec![
                    (games.id, vec![talk.id, random.id]),
                    (staff.id, vec![secret.id]),
                ],
            ),
            order(
                version,
                vec![lounge.id, general],
                vec![
                    (empty.id, vec![]),
                    (empty.id, vec![]),
                    (games.id, vec![talk.id, random.id]),
                    (staff.id, vec![secret.id]),
                ],
            ),
            order(
                version,
                vec![lounge.id, general, 9999],
                vec![
                    (empty.id, vec![]),
                    (games.id, vec![talk.id, random.id]),
                    (staff.id, vec![secret.id]),
                ],
            ),
        ] {
            assert_eq!(
                code(reorder_layout(State(state.clone()), alice(), club(), body(broken)).await)
                    .map_err(|e| e.0),
                Err(StatusCode::BAD_REQUEST)
            );
        }
        assert_eq!(layout_version(db, "club").await.expect("version"), version);
        while rx.try_recv().is_ok() {}
        let (a, b) = tokio::join!(
            reorder_layout(State(state.clone()), alice(), club(), body(wanted.clone())),
            reorder_layout(
                State(state.clone()),
                alice(),
                club(),
                body(order(
                    version,
                    vec![general, lounge.id],
                    vec![
                        (games.id, vec![random.id, talk.id]),
                        (staff.id, vec![secret.id]),
                        (empty.id, vec![])
                    ],
                ))
            ),
        );
        let codes = [code(a).map_err(|e| e.0), code(b).map_err(|e| e.0)];
        assert!(
            codes.contains(&Ok(())) && codes.contains(&Err(StatusCode::CONFLICT)),
            "{codes:?}"
        );
        assert_eq!(
            layout_version(db, "club").await.expect("version"),
            version + 1
        );
        assert!(matches!(rx.try_recv(), Ok(WsEvent::LayoutChanged { .. })));
        assert!(rx.try_recv().is_err());
        assert_eq!(
            code(reorder_layout(State(state.clone()), alice(), club(), body(wanted.clone())).await),
            Err((
                StatusCode::CONFLICT,
                "The channel list changed. Reload it and try again".to_string()
            ))
        );
        let mut fresh = wanted.clone();
        fresh["version"] = (version + 1).into();
        let stored = reorder_layout(State(state.clone()), alice(), club(), body(fresh))
            .await
            .expect("reorder")
            .0;
        assert_eq!(stored.version, version + 2);
        assert_eq!(stored.uncategorized, [lounge.id, general]);
        let as_alice = detail_as(&state, "club", Some(&mem_user("alice", false)))
            .await
            .expect("alice");
        assert_eq!(seen(&as_alice), ["Empty", "Games", "Staff"]);
        assert_eq!(
            as_alice
                .channels
                .iter()
                .map(|c| (c.id, c.category_id))
                .collect::<Vec<_>>(),
            [
                (lounge.id, None),
                (general, None),
                (talk.id, Some(games.id)),
                (random.id, Some(games.id)),
                (secret.id, Some(staff.id)),
            ]
        );
        assert_eq!(
            code(delete_category(State(state.clone()), bob(), Path(games.id)).await),
            Err((StatusCode::NOT_FOUND, "Not found".to_string()))
        );
        let _ = delete_category(State(state.clone()), alice(), Path(games.id))
            .await
            .expect("delete");
        let layout = crate::api::categories::current_layout(db, "club")
            .await
            .expect("layout")
            .expect("club");
        assert_eq!(
            layout.uncategorized,
            [lounge.id, general, talk.id, random.id]
        );
        assert_eq!(
            layout.categories.iter().map(|c| c.id).collect::<Vec<_>>(),
            [empty.id, staff.id]
        );
        assert_eq!(layout.version, version + 3);
        let as_bob = detail_as(&state, "club", Some(&mem_user("bob", false)))
            .await
            .expect("bob");
        assert!(as_bob.categories.is_empty());
        assert_eq!(
            as_bob.channels.iter().map(|c| c.id).collect::<Vec<_>>(),
            [lounge.id, general, talk.id, random.id]
        );
        done(state, path).await;
    }
    #[tokio::test]
    async fn positions_count_only_visible_channels() {
        use crate::api::categories::{create_category, delete_category, reorder_layout};
        let (state, path) = temp_state("category_positions").await;
        let db = &state.db;
        club_with(&state, &["bob"]).await;
        let alice = || Authed(mem_user("alice", false));
        let club = || Path("club".to_string());
        let make = |name: &str, hidden: bool, category: Option<i64>| {
            let state = state.clone();
            let v = serde_json::json!({ "name": name, "restrict_view": hidden, "category_id": category });
            async move {
                create_channel(
                    State(state),
                    Authed(mem_user("alice", false)),
                    Path("club".to_string()),
                    Json(serde_json::from_value(v).expect("body")),
                )
                .await
                .map(|Json(c)| c)
            }
        };
        let general: i64 = sqlx::query("SELECT id FROM channels WHERE server = 'club'")
            .fetch_one(db)
            .await
            .expect("general")
            .try_get(0)
            .expect("id");
        let before = layout_version(db, "club").await.expect("version");
        let mut rx = state.hub.subscribe();
        let a = make("a", false, None).await.expect("a");
        assert_eq!(a.position, 1);
        assert_eq!(
            layout_version(db, "club").await.expect("version"),
            before + 1,
            "creating a channel raises the layout version"
        );
        assert!(
            matches!(rx.try_recv(), Ok(WsEvent::ChannelCreated { server: _, channel }) if channel.id == a.id)
        );
        match rx.try_recv() {
            Ok(WsEvent::LayoutChanged {
                server,
                layout,
                created,
                deleted: None,
                before: _,
                after: _,
            }) => {
                assert_eq!(server, "club");
                assert_eq!(created, Some(a.id));
                assert_eq!(layout.version, before + 1);
                assert_eq!(layout.uncategorized, [general, a.id]);
            }
            _ => panic!("expected layout_changed"),
        }
        let secret = make("secret", true, None).await.expect("secret");
        let b = make("b", false, None).await.expect("b");
        assert_eq!((secret.position, b.position), (2, 3));
        let hidden = create_category(
            State(state.clone()),
            alice(),
            club(),
            Json(serde_json::from_value(serde_json::json!({"name": "Staff"})).expect("body")),
        )
        .await
        .expect("staff")
        .0;
        let games = create_category(
            State(state.clone()),
            alice(),
            club(),
            Json(serde_json::from_value(serde_json::json!({"name": "Games"})).expect("body")),
        )
        .await
        .expect("games")
        .0;
        let vault = make("vault", true, Some(hidden.id)).await.expect("vault");
        let c = make("c", false, Some(games.id)).await.expect("c");
        assert_eq!(c.position, 5, "the creator sees every channel");
        let as_bob = detail_as(&state, "club", Some(&mem_user("bob", false)))
            .await
            .expect("bob");
        assert_eq!(
            as_bob
                .channels
                .iter()
                .map(|ch| (ch.id, ch.position))
                .collect::<Vec<_>>(),
            [(general, 0), (a.id, 1), (b.id, 2), (c.id, 3)],
            "no gap where the hidden channel sits"
        );
        assert_eq!(
            as_bob
                .categories
                .iter()
                .map(|cat| (cat.id, cat.position))
                .collect::<Vec<_>>(),
            [(games.id, 0)],
            "no gap where the hidden category sits"
        );
        let as_alice = detail_as(&state, "club", Some(&mem_user("alice", false)))
            .await
            .expect("alice");
        assert_eq!(
            as_alice
                .channels
                .iter()
                .map(|ch| (ch.id, ch.position))
                .collect::<Vec<_>>(),
            [
                (general, 0),
                (a.id, 1),
                (secret.id, 2),
                (b.id, 3),
                (vault.id, 4),
                (c.id, 5)
            ]
        );
        let stale = as_alice.layout_version;
        let _ = make("late", false, None).await.expect("late");
        let late_order = serde_json::json!({
            "version": stale,
            "uncategorized": [general, a.id, secret.id, b.id],
            "categories": [{"id": hidden.id, "channels": [vault.id]}, {"id": games.id, "channels": [c.id]}],
        });
        assert_eq!(
            code(
                reorder_layout(
                    State(state.clone()),
                    alice(),
                    club(),
                    Json(serde_json::from_value(late_order).expect("body"))
                )
                .await
            )
            .map_err(|e| e.0),
            Err(StatusCode::CONFLICT),
            "a reorder from before a channel was created is stale"
        );
        while rx.try_recv().is_ok() {}
        let version = layout_version(db, "club").await.expect("version");
        let _ = delete_channel(State(state.clone()), alice(), Path(a.id))
            .await
            .expect("delete");
        assert_eq!(
            layout_version(db, "club").await.expect("version"),
            version + 1,
            "deleting a channel raises the layout version"
        );
        assert!(matches!(
            rx.try_recv(),
            Ok(WsEvent::ChannelDeleted { server: _, channel_id, rules: Some(_) }) if channel_id == a.id
        ));
        assert!(matches!(
            rx.try_recv(),
            Ok(WsEvent::LayoutChanged { server: _, layout, created: None, deleted: Some(_), before: None, after: None }) if layout.version == version + 1
        ));
        let stored: Vec<i64> =
            sqlx::query("SELECT position FROM channels WHERE server = 'club' ORDER BY position")
                .fetch_all(db)
                .await
                .expect("positions")
                .iter()
                .map(|r| r.try_get(0).expect("position"))
                .collect();
        assert_eq!(stored, (0..stored.len() as i64).collect::<Vec<_>>());
        for round in 0..4 {
            let doomed = create_category(
                State(state.clone()),
                alice(),
                club(),
                Json(serde_json::from_value(serde_json::json!({"name": "Doomed"})).expect("body")),
            )
            .await
            .expect("doomed")
            .0;
            let name = format!("race{round}");
            let (made, _) = tokio::join!(
                make(&name, false, Some(doomed.id)),
                delete_category(State(state.clone()), alice(), Path(doomed.id)),
            );
            if let Err(ApiError(status, _, _)) = &made {
                assert_eq!(*status, StatusCode::NOT_FOUND);
            }
            let dangling: i64 = sqlx::query("SELECT COUNT(*) FROM channels WHERE category_id IS NOT NULL AND category_id NOT IN (SELECT id FROM channel_categories)")
                .fetch_one(db)
                .await
                .expect("dangling")
                .try_get(0)
                .expect("count");
            assert_eq!(dangling, 0, "a channel never lands in a deleted category");
        }
        done(state, path).await;
    }

    async fn ranked(db: &Db, name: &str, perms: i64, position: i64) -> i64 {
        let id = new_role(db, name, perms).await;
        sqlx::query("UPDATE roles SET position = $1 WHERE id = $2")
            .bind(position)
            .bind(id)
            .execute(db)
            .await
            .expect("position");
        id
    }

    async fn order_guard(db: &Db, on: bool) {
        sqlx::query("UPDATE servers SET roles_order_confirmed = $1 WHERE name = 'club'")
            .bind(i64::from(!on))
            .execute(db)
            .await
            .expect("guard");
    }

    async fn role_order(db: &Db) -> Vec<i64> {
        sqlx::query("SELECT id FROM roles WHERE server = 'club' ORDER BY position DESC, id")
            .fetch_all(db)
            .await
            .expect("order")
            .iter()
            .map(|r| r.try_get(0).expect("id"))
            .collect()
    }

    async fn one(db: &Db, sql: &str) -> i64 {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .fetch_one(db)
            .await
            .expect(sql)
            .try_get(0)
            .expect("number")
    }

    async fn order_version(db: &Db) -> i64 {
        one(db, "SELECT roles_version FROM servers WHERE name = 'club'").await
    }

    async fn reorder(
        state: &AppState,
        actor: User,
        order: &[i64],
        version: i64,
    ) -> Result<(Vec<i64>, i64), (StatusCode, String)> {
        reorder_roles(
            State(state.clone()),
            Authed(actor),
            Path("club".to_string()),
            Json(RoleOrderReq {
                order: order.to_vec(),
                version,
            }),
        )
        .await
        .map(|Json(RoleOrder { order, version })| (order, version))
        .map_err(|ApiError(code, msg, _)| (code, msg))
    }

    async fn confirm(
        state: &AppState,
        actor: User,
        version: i64,
    ) -> Result<(), (StatusCode, String)> {
        code(
            confirm_role_order(
                State(state.clone()),
                Authed(actor),
                Path("club".to_string()),
                Json(RoleOrderConfirmReq { version }),
            )
            .await,
        )
    }

    async fn make_role(state: &AppState, name: &str) -> Role {
        create_role(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            Path("club".to_string()),
            Json(RoleReq {
                name: name.to_string(),
                color: "#123456".to_string(),
                perms: 0,
                mentionable: false,
            }),
        )
        .await
        .expect("role")
        .0
    }

    const MANAGER: i64 = Perm::ManageRoles as i64 | Perm::AssignRoles as i64 | KICK;

    #[tokio::test]
    async fn a_new_server_ranks_its_roles_and_puts_new_ones_at_the_bottom() {
        let (state, path) = temp_state("role_order_new").await;
        let db = &state.db;
        club_with(&state, &[]).await;
        let detail = detail_as(&state, "club", Some(&mem_user("alice", false)))
            .await
            .expect("detail");
        assert!(
            detail.roles_order_confirmed,
            "a new server starts confirmed"
        );
        assert_eq!(detail.roles_version, 0);
        let first = make_role(&state, "first").await;
        let second = make_role(&state, "second").await;
        let third = make_role(&state, "third").await;
        assert_eq!((first.position, second.position, third.position), (1, 1, 1));
        let detail = detail_as(&state, "club", Some(&mem_user("alice", false)))
            .await
            .expect("detail");
        let listed: Vec<(i64, i64)> = detail.roles.iter().map(|r| (r.id, r.position)).collect();
        assert_eq!(
            listed,
            [(first.id, 3), (second.id, 2), (third.id, 1)],
            "the highest role comes first and a new role starts lowest"
        );
        assert_eq!(detail.roles_version, 3);
        drop_role(&state, mem_user("alice", false), second.id)
            .await
            .expect("delete");
        assert_eq!(order_version(db).await, 4);
        assert_eq!(role_order(db).await, [first.id, third.id]);
        done(state, path).await;
    }

    #[tokio::test]
    async fn reordering_moves_only_the_roles_below_you() {
        let (state, path) = temp_state("role_reorder").await;
        let db = &state.db;
        club_with(&state, &["bob", "carol"]).await;
        let top = ranked(db, "top", 0, 4).await;
        let mgr = ranked(db, "mgr", MANAGER, 3).await;
        let mid = ranked(db, "mid", 0, 2).await;
        let low = ranked(db, "low", 0, 1).await;
        hold(db, "bob", mgr).await;
        let (bob, alice, root) = (
            || mem_user("bob", false),
            || mem_user("alice", false),
            || mem_user("root", true),
        );
        let above = Err((
            StatusCode::FORBIDDEN,
            "You can't move a role that is not below your highest role".to_string(),
        ));
        let stale = Err((
            StatusCode::CONFLICT,
            "The role order changed. Refresh and try again.".to_string(),
        ));
        let partial = Err((StatusCode::BAD_REQUEST, "List every role once".to_string()));
        assert_eq!(
            reorder(&state, bob(), &[mgr, top, mid, low], 0).await,
            above
        );
        assert_eq!(
            reorder(&state, bob(), &[top, mid, mgr, low], 0).await,
            above
        );
        assert_eq!(
            reorder(&state, bob(), &[top, mgr, low, mid], 7).await,
            stale
        );
        for wrong in [
            vec![top, mgr, low],
            vec![top, mgr, low, low],
            vec![top, mgr, low, mid, 999_999],
            vec![top, mgr, low, 999_999],
        ] {
            assert_eq!(
                reorder(&state, bob(), &wrong, 0).await,
                partial,
                "{wrong:?}"
            );
        }
        assert_eq!(
            reorder(&state, mem_user("carol", false), &[top, mgr, low, mid], 0)
                .await
                .map_err(|(code, _)| code),
            Err(StatusCode::FORBIDDEN),
            "reordering needs Manage roles"
        );
        assert_eq!(role_order(db).await, [top, mgr, mid, low]);
        assert_eq!(
            reorder(&state, bob(), &[top, mgr, mid, low], 0).await,
            Ok((vec![top, mgr, mid, low], 0)),
            "the same order changes nothing"
        );
        assert_eq!(
            one(
                db,
                "SELECT COUNT(*) FROM audit_log WHERE action = 'role.reorder'"
            )
            .await,
            0
        );
        assert_eq!(
            reorder(&state, bob(), &[top, mgr, low, mid], 0).await,
            Ok((vec![top, mgr, low, mid], 1))
        );
        assert_eq!(role_order(db).await, [top, mgr, low, mid]);
        assert_eq!(
            one(
                db,
                "SELECT COUNT(*) FROM roles WHERE server = 'club' AND position BETWEEN 1 AND 4"
            )
            .await,
            4,
            "positions stay dense"
        );
        let entry = sqlx::query(
            "SELECT actor, staff, details FROM audit_log WHERE action = 'role.reorder' ORDER BY id",
        )
        .fetch_all(db)
        .await
        .expect("audit");
        assert_eq!(entry.len(), 1);
        assert_eq!(
            entry[0].try_get::<Option<String>, _>(0).expect("actor"),
            Some("bob".to_string())
        );
        let details: serde_json::Value =
            serde_json::from_str(&entry[0].try_get::<String, _>(2).expect("details"))
                .expect("json");
        assert_eq!(
            details["roles"],
            serde_json::json!([{ "id": mid, "name": "mid" }]),
            "only the role that changed place is named"
        );
        assert_eq!(details["more_roles"], 0);
        assert_eq!(
            reorder(&state, bob(), &[top, mgr, mid, low], 0).await,
            stale
        );
        assert_eq!(
            reorder(&state, alice(), &[low, mid, mgr, top], 1).await,
            Ok((vec![low, mid, mgr, top], 2)),
            "an owner moves every role"
        );
        assert_eq!(
            reorder(&state, bob(), &[mid, low, mgr, top], 2).await,
            above,
            "roles moved above yours are out of reach"
        );
        assert_eq!(
            reorder(&state, bob(), &[low, mid, top, mgr], 2).await,
            above,
            "your own highest role does not move"
        );
        assert_eq!(
            reorder(&state, root(), &[top, low, mid, mgr], 2).await,
            Ok((vec![top, low, mid, mgr], 3))
        );
        assert_eq!(
            one(db, "SELECT COUNT(*) FROM audit_log WHERE action = 'role.reorder' AND staff = 1 AND actor IS NULL").await,
            1,
            "a site admin who is not a member reorders as the unnamed staff"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn an_unconfirmed_order_also_keeps_roles_you_could_not_edit_in_place() {
        let (state, path) = temp_state("role_reorder_guard").await;
        let db = &state.db;
        club_with(&state, &["bob", "carol"]).await;
        order_guard(db, true).await;
        let mgr = ranked(db, "mgr", MANAGER, 4).await;
        let peer = ranked(db, "peer", KICK, 3).await;
        let wide = ranked(db, "wide", Perm::DeleteServer as i64, 2).await;
        let low = ranked(db, "low", 0, 1).await;
        hold(db, "bob", mgr).await;
        set_admin_row(db, "carol", Perm::DeleteMessages as i64).await;
        hold(db, "carol", peer).await;
        let bob = || mem_user("bob", false);
        let forbid = |msg: &str| Err((StatusCode::FORBIDDEN, msg.to_string()));
        assert_eq!(
            reorder(&state, bob(), &[mgr, low, wide, peer], 0).await,
            forbid("You can't move a role held by a member you can't moderate"),
            "a role held by an admin stays"
        );
        assert_eq!(
            reorder(&state, bob(), &[mgr, peer, low, wide], 0).await,
            forbid("You can't move a role that has permissions you don't have"),
            "a role with permissions you lack stays"
        );
        assert_eq!(
            reorder(&state, bob(), &[peer, mgr, wide, low], 0).await,
            forbid("You can't move a role that is not below your highest role"),
            "your own highest role does not move"
        );
        order_guard(db, false).await;
        assert_eq!(
            reorder(&state, bob(), &[mgr, low, wide, peer], 0).await,
            Ok((vec![mgr, low, wide, peer], 1)),
            "once the order is confirmed rank alone decides"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn confirming_the_order_makes_rank_decide_moderation() {
        let (state, path) = temp_state("role_order_confirm").await;
        let db = &state.db;
        club_with(&state, &["bob", "carol", "dave", "erin"]).await;
        order_guard(db, true).await;
        let high = ranked(db, "high", KICK, 2).await;
        let low = ranked(db, "low", Perm::DeleteMessages as i64 | KICK, 1).await;
        hold(db, "carol", high).await;
        hold(db, "erin", high).await;
        hold(db, "dave", low).await;
        let (carol, dave, alice) = (
            || mem_user("carol", false),
            || mem_user("dave", false),
            || mem_user("alice", false),
        );
        let denied = Err((
            StatusCode::FORBIDDEN,
            "You can't moderate this member".to_string(),
        ));
        let detail = detail_as(&state, "club", Some(&alice()))
            .await
            .expect("detail");
        assert!(!detail.roles_order_confirmed);
        assert_eq!(moderate(&state, carol(), "dave", false).await, denied);
        moderate(&state, dave(), "erin", false)
            .await
            .expect("with the order unconfirmed, more permissions moderate fewer");
        join(&state, "erin", "club").await.expect("erin rejoins");
        hold(db, "erin", high).await;
        assert_eq!(
            confirm(&state, alice(), 5).await,
            Err((
                StatusCode::CONFLICT,
                "The role order changed. Refresh and try again.".to_string()
            ))
        );
        assert_eq!(
            confirm(&state, carol(), 0).await.map_err(|(code, _)| code),
            Err(StatusCode::FORBIDDEN),
            "confirming needs Manage roles"
        );
        assert_eq!(
            one(
                db,
                "SELECT roles_order_confirmed FROM servers WHERE name = 'club'"
            )
            .await,
            0
        );
        confirm(&state, alice(), 0).await.expect("confirm");
        confirm(&state, alice(), 0)
            .await
            .expect("confirming twice is fine");
        assert_eq!(
            one(db, "SELECT COUNT(*) FROM audit_log WHERE action = 'role.order_confirm' AND actor = 'alice'").await,
            1
        );
        assert_eq!(
            order_version(db).await,
            0,
            "confirming keeps the order's version"
        );
        let detail = detail_as(&state, "club", Some(&alice()))
            .await
            .expect("detail");
        assert!(detail.roles_order_confirmed);
        assert_eq!(moderate(&state, dave(), "erin", false).await, denied);
        assert_eq!(
            moderate(&state, carol(), "erin", false).await,
            denied,
            "members at one rank never moderate each other"
        );
        assert_eq!(moderate(&state, carol(), "alice", false).await, denied);
        moderate(&state, carol(), "dave", true)
            .await
            .expect("the higher role bans the lower one");
        moderate(&state, carol(), "bob", false)
            .await
            .expect("a member without roles ranks below every role");
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_confirmed_order_manages_roles_by_rank_alone() {
        let (state, path) = temp_state("role_rank_manage").await;
        let db = &state.db;
        club_with(&state, &["bob", "carol", "dave"]).await;
        let top = ranked(db, "top", 0, 5).await;
        let mgr = ranked(db, "mgr", MANAGER, 4).await;
        let big = ranked(db, "big", Perm::DeleteServer as i64, 3).await;
        let held = ranked(db, "held", 0, 2).await;
        let low = ranked(db, "low", 0, 1).await;
        hold(db, "bob", mgr).await;
        hold(db, "dave", top).await;
        hold(db, "dave", held).await;
        let bob = || mem_user("bob", false);
        let not_below = forbid("You can't change a role that is not below your highest role");
        let not_given = forbid("You can't give or take a role that is not below your highest role");
        assert_eq!(limits_of(&state, bob()).await.0, {
            let mut ids = vec![top, mgr];
            ids.sort_unstable();
            ids
        });
        for role in [top, mgr] {
            assert_eq!(edit(&state, bob(), role, Some("x"), None).await, not_below);
            assert_eq!(drop_role(&state, bob(), role).await, not_below);
            assert_eq!(assign(&state, bob(), role, "carol").await, not_given);
        }
        assert_eq!(unassign(&state, bob(), top, "dave").await, not_given);
        edit(&state, bob(), big, Some("renamed"), None)
            .await
            .expect("a role below you with permissions you lack can be renamed");
        assert_eq!(
            edit(
                &state,
                bob(),
                big,
                None,
                Some(Perm::DeleteServer as i64 | 1)
            )
            .await,
            no_grant(),
            "added permissions must be yours"
        );
        edit(
            &state,
            bob(),
            big,
            None,
            Some(Perm::DeleteServer as i64 | KICK),
        )
        .await
        .expect("adding a permission you hold keeps the ones you lack");
        edit(&state, bob(), held, Some("still held"), None)
            .await
            .expect("who holds a role below you does not matter");
        assert_eq!(assign(&state, bob(), big, "carol").await, no_grant());
        assign(&state, bob(), low, "carol").await.expect("assign");
        assert_eq!(
            assign(&state, bob(), low, "dave").await,
            forbid("You can't moderate this member"),
            "dave ranks above bob"
        );
        unassign(&state, bob(), low, "carol").await.expect("take");
        unassign(&state, bob(), mgr, "bob")
            .await
            .expect("your own role can always be dropped");
        drop_role(&state, mem_user("alice", false), top)
            .await
            .expect("an owner manages every role");
        order_guard(db, true).await;
        hold(db, "bob", mgr).await;
        assert_eq!(
            edit(&state, bob(), big, Some("y"), None).await,
            forbid("You can't change a role that has permissions you don't have"),
            "an unconfirmed order keeps the permission test"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_channel_manager_gives_no_role_that_allows_moderation_they_lack() {
        let (state, path) = temp_state("role_allow_manager").await;
        let db = &state.db;
        club_with(&state, &["bob", "carol"]).await;
        let giver = ranked(
            db,
            "giver",
            Perm::AssignRoles as i64 | Perm::ManageChannels as i64,
            3,
        )
        .await;
        let mods = ranked(db, "mods", 0, 2).await;
        let chatty = ranked(db, "chatty", 0, 1).await;
        hold(db, "bob", giver).await;
        let cid = one(db, "SELECT id FROM channels WHERE server = 'club'").await;
        for (role, allow) in [
            (mods, Perm::DeleteMessages as i64),
            (chatty, masks::SEND as i64),
        ] {
            sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history, allow, deny) VALUES($1, $2, 1, 1, 1, $3, 0)")
                .bind(cid)
                .bind(format!("r:{role}"))
                .bind(allow)
                .execute(db)
                .await
                .expect("rule");
        }
        let bob = || mem_user("bob", false);
        assert_eq!(
            assign(&state, bob(), mods, "carol").await,
            forbid("This role gives channel access you don't have")
        );
        assert_eq!(limits_of(&state, bob()).await.1, [mods]);
        assign(&state, bob(), chatty, "carol")
            .await
            .expect("Manage channels covers what everyone can hold in a channel");
        sqlx::query("UPDATE roles SET perms = perms | $1 WHERE id = $2")
            .bind(Perm::DeleteMessages as i64)
            .bind(giver)
            .execute(db)
            .await
            .expect("holds it");
        assign(&state, bob(), mods, "carol")
            .await
            .expect("allowed once the giver holds Manage messages");
        done(state, path).await;
    }

    fn bits_of(held: usize, roles: &[(i64, i64, i64)]) -> i64 {
        roles
            .iter()
            .enumerate()
            .filter(|(i, _)| held & (1 << i) != 0)
            .fold(0, |acc, (_, (_, _, perms))| acc | perms)
    }

    fn top_of(held: usize, roles: &[(i64, i64, i64)]) -> Option<(i64, i64)> {
        roles
            .iter()
            .enumerate()
            .filter(|(i, _)| held & (1 << i) != 0)
            .map(|(_, (id, position, _))| (*position, *id))
            .max()
    }

    /// Every set of up to three roles over the bits `pool` and of four roles over its first
    /// three bits, each role with a position of its own (role `i` at position `i + 1`), and two
    /// members holding any subsets of them.
    fn role_worlds(pool: &[i64], mut each: impl FnMut(&[(i64, i64, i64)], usize, usize)) {
        let masks: Vec<i64> = (0..1usize << pool.len())
            .map(|m| {
                pool.iter()
                    .enumerate()
                    .filter(|(i, _)| m & (1 << i) != 0)
                    .fold(0, |acc, (_, bit)| acc | bit)
            })
            .collect();
        for count in 1..=4usize {
            let masks = match count {
                4 => &masks[..masks.len() / 2],
                _ => &masks[..],
            };
            let mut picks = vec![0usize; count];
            loop {
                let roles: Vec<(i64, i64, i64)> = picks
                    .iter()
                    .enumerate()
                    .map(|(i, m)| (i as i64 + 1, i as i64 + 1, masks[*m]))
                    .collect();
                for a in 0..1usize << count {
                    for t in 0..1usize << count {
                        each(&roles, a, t);
                    }
                }
                let Some(i) = picks.iter().rposition(|m| *m + 1 < masks.len()) else {
                    break;
                };
                picks[i] += 1;
                for later in picks.iter_mut().skip(i + 1) {
                    *later = 0;
                }
            }
        }
    }

    #[test]
    fn the_order_guard_keeps_moderation_and_only_narrows_role_management() {
        let pool = [
            KICK,
            Perm::ManageRoles as i64,
            Perm::DeleteMessages as i64,
            Perm::ManageChannels as i64,
        ];
        let mut checked = 0u64;
        role_worlds(&pool, |roles, a, t| {
            let (mine, theirs) = (bits_of(a, roles), bits_of(t, roles));
            let me = Actor {
                rank: ranks::member_rank(false, 0, top_of(a, roles)),
                bits: mine as Mask,
            };
            let them = Actor {
                rank: ranks::member_rank(false, 0, top_of(t, roles)),
                bits: theirs as Mask,
            };
            let strictly_more = theirs & !mine == 0 && theirs != mine;
            assert_eq!(
                hier::may_moderate(&me, &them, 0, true),
                strictly_more,
                "{roles:?} {a} {t}"
            );
            let held: HashSet<i64> = roles
                .iter()
                .enumerate()
                .filter(|(i, _)| t & (1 << i) != 0 && !strictly_more)
                .map(|(_, (id, _, _))| *id)
                .collect();
            let can = movable(roles, me.rank, mine, true, &held);
            for (id, _, perms) in roles {
                let before = mine & Perm::ManageRoles as i64 != 0
                    && perms & !mine == 0
                    && !held.contains(id);
                assert!(
                    !can.contains(id) || before,
                    "{roles:?} {a} {t}: role {id} is managed only where it was before"
                );
            }
            checked += 1;
        });
        assert!(checked > 100_000, "{checked}");
    }

    #[test]
    fn a_confirmed_order_decides_as_rooms_do() {
        let pool = [
            KICK,
            Perm::ManageRoles as i64,
            Perm::DeleteMessages as i64,
            Perm::ManageChannels as i64,
        ];
        let room_rank = |held: usize, roles: &[(i64, i64, i64)]| -> (i64, String) {
            roles
                .iter()
                .enumerate()
                .filter(|(i, _)| held & (1 << i) != 0)
                .map(|(_, (id, position, _))| (*position, format!("r{id}")))
                .max()
                .unwrap_or((-1, String::new()))
        };
        role_worlds(&pool, |roles, a, t| {
            let (mine, theirs) = (bits_of(a, roles), bits_of(t, roles));
            let me = Actor {
                rank: ranks::member_rank(false, 0, top_of(a, roles)),
                bits: mine as Mask,
            };
            let them = Actor {
                rank: ranks::member_rank(false, 0, top_of(t, roles)),
                bits: theirs as Mask,
            };
            let (room_me, room_them) = (room_rank(a, roles), room_rank(t, roles));
            assert_eq!(
                hier::may_moderate(&me, &them, KICK as Mask, false),
                mine & KICK != 0 && room_me > room_them,
                "{roles:?} {a} {t}"
            );
            let can = movable(roles, me.rank, mine, false, &HashSet::new());
            for (id, position, _) in roles {
                assert_eq!(
                    can.contains(id),
                    mine & Perm::ManageRoles as i64 != 0 && room_me > (*position, format!("r{id}")),
                    "{roles:?} {a}: role {id}"
                );
            }
        });
        let owner = Actor {
            rank: ranks::member_rank(true, 0, None),
            bits: ALL_PERMS as Mask,
        };
        let admin = Actor {
            rank: ranks::member_rank(true, KICK, Some((9, 1))),
            bits: KICK as Mask,
        };
        let role = Actor {
            rank: ranks::member_rank(false, 0, Some((9, 1))),
            bits: KICK as Mask,
        };
        assert!(hier::may_moderate(&owner, &admin, 0, false));
        assert!(hier::may_moderate(&admin, &role, 0, false));
        assert!(!hier::may_moderate(&owner, &owner, 0, false));
        assert!(!hier::may_moderate(&role, &admin, 0, false));
    }
}
