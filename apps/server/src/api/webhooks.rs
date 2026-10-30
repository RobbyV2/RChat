use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::Json;
use axum::body::Bytes;
use axum::extract::{FromRequest, Multipart, Path, Query, Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use sqlx::Row;
use tokio::sync::{Notify, Semaphore, mpsc};
use url::Url;
use utoipa::{IntoParams, ToSchema};

use crate::api::access::{
    Proof, ResolvedChannel, ServerAccess, Via, denied, plain_member_perms, resolve_channel,
    resolve_message, resolve_server, timed_out_error, webhook_channel,
};
use crate::api::audit::{self, Action, Actor, Details, Entry, Target, TargetKind};
use crate::api::budget::{Budget, slow_down};
use crate::api::messages::{
    Place, Quoted, Quotes, SendReq, attach_embeds, cannot_reply, insert_message, load_broadcast,
    load_message, partial_quote, replied,
};
use crate::api::pings::{
    GroupRights, PingScope, RoleRights, UserMentions, announce_counts, group_mentions_as,
    ping_message_for, pinged_by, store_group_pings,
};
use crate::api::polls::PollReq;
use crate::api::{
    ApiError, ApiErrorBody, Authed, MESSAGE_MAX, Message, OkResp, ProfanityTarget, Settings,
    UserRef, allowed, bad, check_len, embeds, ok, placeholders, valid_color,
};
use crate::db::{AvatarKind, ChannelKind, Db, Perm, User, get_user, now, pepper};
use crate::net_guard::{self, AllowedHost, Http, Policy};
use crate::state::AppState;
use crate::ws::{Updated, WsEvent};

/// Most incoming webhooks per channel.
pub const CHANNEL_MAX: i64 = 15;
/// Most incoming webhooks per server.
pub const SERVER_MAX: i64 = 100;
/// Most outgoing webhooks per server.
pub const OUTGOING_MAX: i64 = 10;
/// Longest webhook name.
pub const NAME_MAX: usize = 80;
/// Longest outgoing webhook URL.
pub const URL_MAX: usize = 2048;
/// How long delivery log rows are kept.
pub const DELIVERY_KEEP: i64 = 7 * 86400;
/// Delivery log rows kept per outgoing webhook.
pub const LOG_KEEP: i64 = 100;
/// Deliveries waiting per outgoing webhook; newer events are dropped past this.
pub const QUEUE_MAX: i64 = 1000;
/// Tries per delivery before it counts as failed.
pub const ATTEMPTS: i64 = 6;
/// Seconds to wait before each retry.
pub const BACKOFF: [i64; 5] = [10, 30, 120, 600, 1800];
/// Failed deliveries in a row that turn an outgoing webhook off.
pub const DISABLE_AFTER: i64 = 10;
/// Largest payload sent.
pub const PAYLOAD_MAX: usize = 64 * 1024;
/// Most response bytes read (then discarded).
pub const RESPONSE_CAP: usize = 16 * 1024;
/// Executions per webhook in `HOOK_WINDOW`.
pub const HOOK_BURST: u32 = 5;
const HOOK_WINDOW: Duration = Duration::from_secs(2);
/// Webhook messages per channel per minute, all of its webhooks together.
pub const CHANNEL_BUDGET: u32 = 30;
/// The fixed User-Agent of outgoing requests: never anything about the instance or its owner.
pub const USER_AGENT: &str = "rchat-webhooks/1.0";
const TIMEOUT: Duration = Duration::from_secs(10);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const CLAIM_SECS: i64 = 60;
const EMBEDS_MAX: usize = 10;
const EMBED_TEXT_MAX: usize = 6000;
const FIELDS_MAX: usize = 25;
const AUTHOR_PREFIX: &str = "@webhook:";
const UNKNOWN: &str = "Unknown webhook";
const UNKNOWN_MESSAGE: &str = "Unknown message";
const STAFF_NAME: &str = "instance staff";
const MANAGE_BITS: i64 = Perm::ManageWebhooks as i64 | Perm::ManageChannels as i64;

/// The events an outgoing webhook can subscribe to.
pub const EVENTS: [&str; 8] = [
    "message.created",
    "message.updated",
    "message.deleted",
    "member.joined",
    "member.left",
    "reaction.added",
    "reaction.removed",
    "poll.ended",
];

/// The message author key of an incoming webhook. It starts with `@`, which usernames cannot
/// contain, so it never names an account.
pub fn author_key(id: i64) -> String {
    format!("{AUTHOR_PREFIX}{id}")
}

/// The webhook id of an author key.
pub fn hook_of(author: &str) -> Option<i64> {
    author.strip_prefix(AUTHOR_PREFIX)?.parse().ok()
}

fn avatar_parts(avatar: Option<&str>) -> (AvatarKind, Option<String>) {
    match avatar {
        Some(c) if valid_color(c) => (AvatarKind::Color, Some(c.to_lowercase())),
        Some(_) | None => (AvatarKind::Identicon, None),
    }
}

fn stored_avatar(kind: AvatarKind, color: Option<&str>) -> String {
    match (kind, color) {
        (AvatarKind::Color, Some(c)) => c.to_lowercase(),
        (_, _) => "identicon".to_string(),
    }
}

/// How a webhook message's author is shown: the name and avatar it posted with.
pub fn author_ref(id: i64, name: Option<&str>, avatar: Option<&str>) -> UserRef {
    let (avatar_kind, avatar_color) = avatar_parts(avatar);
    UserRef {
        username: author_key(id),
        display_name: name.unwrap_or("Webhook").to_string(),
        avatar_kind,
        avatar_color,
    }
}

/// Current names and avatars of webhooks, for author keys outside their own messages (forward
/// origins, ping actors). Deleted webhooks are shown as `Webhook`.
pub async fn current_refs(db: &Db, ids: &[i64]) -> HashMap<String, UserRef> {
    let mut out: HashMap<String, UserRef> = ids
        .iter()
        .map(|id| (author_key(*id), author_ref(*id, None, None)))
        .collect();
    for chunk in ids.chunks(500) {
        let sql = format!(
            "SELECT id, name, avatar_kind, avatar_color FROM webhooks WHERE id IN ({})",
            placeholders(1, chunk.len())
        );
        let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
        for id in chunk {
            query = query.bind(*id);
        }
        if let Ok(rows) = query.fetch_all(db).await {
            for r in &rows {
                let Ok(id) = r.try_get::<i64, _>(0) else {
                    continue;
                };
                let name: Option<String> = r.try_get(1).ok();
                let kind = r
                    .try_get::<String, _>(2)
                    .ok()
                    .and_then(|k| AvatarKind::parse(&k).ok())
                    .unwrap_or(AvatarKind::Identicon);
                let color: Option<String> = r.try_get(3).ok().flatten();
                let avatar = stored_avatar(kind, color.as_deref());
                out.insert(
                    author_key(id),
                    author_ref(id, name.as_deref(), Some(&avatar)),
                );
            }
        }
    }
    out
}

/// A field of a rich embed.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct EmbedField {
    /// At most 256 characters, not blank.
    pub name: String,
    /// At most 1024 characters, not blank.
    pub value: String,
    /// Shown next to other inline fields. Defaults to `false`.
    #[serde(default)]
    pub inline: bool,
}

/// The footer of a rich embed.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct EmbedFooter {
    /// At most 2048 characters, not blank.
    pub text: String,
}

/// A simple rich embed posted by a webhook: a card with a title (optionally linked), text,
/// fields and a footer. All text counts toward 6000 characters per message, and passes the
/// profanity filter like message text. Nothing in it is fetched.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct RichEmbed {
    /// At most 256 characters.
    #[serde(default)]
    pub title: Option<String>,
    /// At most 4096 characters. Rendered like message text (markdown).
    #[serde(default)]
    pub description: Option<String>,
    /// An `http(s)` link for the title, at most 2048 characters.
    #[serde(default)]
    pub url: Option<String>,
    /// Accent color as an integer `0xRRGGBB` (0 to 16777215).
    #[serde(default)]
    pub color: Option<i64>,
    /// At most 25.
    #[serde(default)]
    pub fields: Vec<EmbedField>,
    /// Small text at the bottom.
    #[serde(default)]
    pub footer: Option<EmbedFooter>,
}

/// The webhook part of a message.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct MessageWebhook {
    /// Id of the webhook that posted it (it may have been deleted since).
    pub id: i64,
    /// Rich embeds it posted, in order.
    #[serde(default)]
    pub embeds: Vec<RichEmbed>,
}

pub fn parse_embeds(stored: Option<&str>) -> Vec<RichEmbed> {
    stored
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default()
}

pub fn stored_embeds(list: &[RichEmbed]) -> Option<String> {
    match list.is_empty() {
        true => None,
        false => serde_json::to_string(list).ok(),
    }
}

/// What `insert_message` stores for a webhook message.
pub struct HookPost {
    pub id: i64,
    pub name: String,
    pub avatar: String,
    pub embeds: Vec<RichEmbed>,
}

fn blank(s: &str) -> bool {
    s.trim().is_empty()
}

fn web_url(raw: &str) -> bool {
    raw.chars().count() <= URL_MAX
        && Url::parse(raw).is_ok_and(|u| matches!(u.scheme(), "http" | "https") && u.has_host())
}

/// Checks `list` (counts, lengths, URLs, colors, the profanity filter) and trims nothing.
pub fn validate_embeds(list: &[RichEmbed], settings: &Settings) -> Result<(), ApiError> {
    if list.len() > EMBEDS_MAX {
        return Err(bad("At most 10 embeds"));
    }
    let mut total = 0;
    for e in list {
        let RichEmbed {
            title,
            description,
            url,
            color,
            fields,
            footer,
        } = e;
        let mut texts: Vec<(&str, usize, &str)> = Vec::new();
        if let Some(t) = title {
            texts.push((t, 256, "Embed title"));
        }
        if let Some(d) = description {
            texts.push((d, 4096, "Embed description"));
        }
        if fields.len() > FIELDS_MAX {
            return Err(bad("At most 25 embed fields"));
        }
        for f in fields {
            if blank(&f.name) || blank(&f.value) {
                return Err(bad("Embed fields need a name and a value"));
            }
            texts.push((&f.name, 256, "Embed field name"));
            texts.push((&f.value, 1024, "Embed field value"));
        }
        if let Some(f) = footer {
            if blank(&f.text) {
                return Err(bad("Embed footer is empty"));
            }
            texts.push((&f.text, 2048, "Embed footer"));
        }
        if let Some(u) = url
            && !web_url(u)
        {
            return Err(bad("Embed url must be an http or https link"));
        }
        if let Some(c) = color
            && !(0..=0xff_ffff).contains(c)
        {
            return Err(bad("Embed color must be between 0 and 16777215"));
        }
        let shown = title.as_deref().is_some_and(|t| !blank(t))
            || description.as_deref().is_some_and(|d| !blank(d))
            || !fields.is_empty()
            || footer.is_some();
        if !shown {
            return Err(bad("Embed is empty"));
        }
        for (text, max, what) in texts {
            check_len(text, max, what)?;
            total += text.chars().count();
            settings.check_profanity(ProfanityTarget::Messages, text)?;
        }
    }
    match total > EMBED_TEXT_MAX {
        true => Err(bad("Embeds must have at most 6000 characters in total")),
        false => Ok(()),
    }
}

fn new_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn mac(key: &[u8], parts: &[&[u8]]) -> Vec<u8> {
    let mut m = <Hmac<Sha256> as KeyInit>::new_from_slice(key).expect("hmac key");
    for p in parts {
        m.update(p);
    }
    m.finalize().into_bytes().to_vec()
}

/// The stored form of a webhook token: an HMAC under the instance pepper, so a leaked
/// database does not hand out working tokens.
pub fn token_hash(pepper: &[u8], token: &str) -> String {
    format!(
        "k:{}",
        hex::encode(mac(pepper, &[b"webhook-token\n", token.as_bytes()]))
    )
}

/// Compares in time that depends only on the lengths.
pub fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// `sha256=<hex>` of HMAC-SHA256 under `secret` over `<timestamp>.<body>`.
pub fn signature(secret: &str, timestamp: i64, body: &[u8]) -> String {
    format!(
        "sha256={}",
        hex::encode(mac(
            secret.as_bytes(),
            &[timestamp.to_string().as_bytes(), b".", body]
        ))
    )
}

fn unknown() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, UNKNOWN.to_string())
}

fn unknown_message() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, UNKNOWN_MESSAGE.to_string())
}

fn forbidden(msg: &str) -> ApiError {
    ApiError(StatusCode::FORBIDDEN, msg.to_string())
}

/// An incoming webhook as stored.
#[derive(Clone, Debug)]
struct Hook {
    id: i64,
    server: String,
    channel_id: i64,
    name: String,
    avatar_kind: AvatarKind,
    avatar_color: Option<String>,
    creator: Option<String>,
    creator_mentions: bool,
}

const HOOK_COLS: &str = "id, server, channel_id, name, avatar_kind, avatar_color, creator, creator_mentions, created_at, last_used_at, token_hash";

fn hook_row(r: &sqlx::any::AnyRow) -> sqlx::Result<Hook> {
    Ok(Hook {
        id: r.try_get(0)?,
        server: r.try_get(1)?,
        channel_id: r.try_get(2)?,
        name: r.try_get(3)?,
        avatar_kind: AvatarKind::parse(&r.try_get::<String, _>(4)?)?,
        avatar_color: r.try_get(5)?,
        creator: r.try_get(6)?,
        creator_mentions: r.try_get::<i64, _>(7)? != 0,
    })
}

/// The webhook `id` answers to `token`. Unknown ids, deleted webhooks and wrong tokens get the
/// same 404 after the same work.
async fn hook_for(db: &Db, id: &str, token: &str) -> Result<Hook, ApiError> {
    let pepper = pepper(db).await?;
    let given = token_hash(&pepper, token);
    let row = match id.parse::<i64>() {
        Ok(id) if id > 0 => {
            let sql = format!("SELECT {HOOK_COLS} FROM webhooks WHERE id = $1");
            sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(id)
                .fetch_optional(db)
                .await?
        }
        Ok(_) | Err(_) => None,
    };
    let stored: String = match &row {
        Some(r) => r.try_get(10)?,
        None => token_hash(&pepper, "\n"),
    };
    match (row, same(stored.as_bytes(), given.as_bytes())) {
        (Some(r), true) => Ok(hook_row(&r)?),
        (_, _) => Err(unknown()),
    }
}

/// An incoming webhook as its managers see it. The token is never included.
#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct Webhook {
    /// Webhook id, the first part of its URL.
    pub id: i64,
    /// The channel it posts into.
    pub channel_id: i64,
    /// Default name of its messages.
    pub name: String,
    /// How its default avatar is drawn.
    pub avatar_kind: AvatarKind,
    /// `#rrggbb` when `avatar_kind` is `color`.
    pub avatar_color: Option<String>,
    /// Who created it; `null` once that account is gone.
    pub creator: Option<UserRef>,
    /// Whether it may use `@everyone`, `@here` and role mentions (`allowed_mentions` still has
    /// to ask): its creator could when they created it. Checked again on every message.
    pub mentions: bool,
    /// When it was created, Unix seconds.
    pub created_at: i64,
    /// When it last posted, Unix seconds; `null` if never.
    pub last_used_at: Option<i64>,
}

/// A webhook with its token, returned once when it is created or its token is reset.
#[derive(Serialize, Deserialize, ToSchema)]
pub struct WebhookSecret {
    #[serde(flatten)]
    pub webhook: Webhook,
    /// The secret part of its URL. Shown only now; only a keyed hash is stored.
    pub token: String,
    /// The path to post to, `/api/webhooks/{id}/{token}`.
    pub path: String,
}

async fn webhook_rows(db: &Db, rows: &[sqlx::any::AnyRow]) -> Result<Vec<Webhook>, ApiError> {
    let creators: Vec<String> = rows
        .iter()
        .filter_map(|r| r.try_get::<Option<String>, _>(6).ok().flatten())
        .collect();
    let refs = crate::api::user_refs(db, &creators).await;
    let live: Vec<String> = live_users(db, &creators).await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let hook = hook_row(r)?;
        out.push(Webhook {
            id: hook.id,
            channel_id: hook.channel_id,
            name: hook.name,
            avatar_kind: hook.avatar_kind,
            avatar_color: hook.avatar_color,
            creator: hook
                .creator
                .filter(|c| live.contains(c))
                .and_then(|c| refs.get(&c).cloned()),
            mentions: hook.creator_mentions,
            created_at: r.try_get(8)?,
            last_used_at: r.try_get(9)?,
        });
    }
    Ok(out)
}

async fn live_users(db: &Db, names: &[String]) -> Result<Vec<String>, ApiError> {
    let mut out = Vec::new();
    for chunk in names.chunks(500) {
        if chunk.is_empty() {
            continue;
        }
        let sql = format!(
            "SELECT username FROM users WHERE password_hash <> '!purging' AND username IN ({})",
            placeholders(1, chunk.len())
        );
        let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
        for n in chunk {
            query = query.bind(n);
        }
        for r in query.fetch_all(db).await? {
            out.push(r.try_get(0)?);
        }
    }
    Ok(out)
}

/// The server, for a manager of its webhooks: a member (or a site admin) whose permissions
/// include Manage webhooks or Manage channels. Others who can't open it, and non-members, get
/// the uniform 404.
async fn manager(state: &AppState, user: &User, name: &str) -> Result<ServerAccess, ApiError> {
    let db = &state.db;
    let access = resolve_server(db, name, Some(user), &Proof::none()).await?;
    if !access.is_member() && !access.site_admin() {
        return Err(denied());
    }
    match (access.perms(db).await?, access.view_perms(db).await?) {
        (p, _) if p & MANAGE_BITS != 0 => Ok(access),
        (_, v) if v & MANAGE_BITS != 0 => Err(timed_out_error()),
        (_, _) => Err(forbidden("Missing permission")),
    }
}

/// Who a manager's change is logged as: a site admin who manages only through instance powers
/// is the unnamed staff.
async fn manager_actor(db: &Db, access: &ServerAccess, user: &User) -> Result<Actor, ApiError> {
    let plain = plain_member_perms(db, access.name(), &user.username).await?;
    let staff = access.via() == Via::Staff || (user.is_site_admin && plain & MANAGE_BITS == 0);
    Ok(Actor::of(user, staff))
}

/// A change by someone other than a hook's owner that sets what it can receive or do makes
/// them the owner, so its rights are always theirs. They must hold Manage webhooks or Manage
/// channels as a plain member (as for creating one). Returns their plain permissions when
/// ownership moves, `None` when they already own it.
async fn takeover(
    db: &Db,
    access: &ServerAccess,
    user: &User,
    owner: Option<&str>,
) -> Result<Option<i64>, ApiError> {
    if owner == Some(user.username.as_str()) {
        return Ok(None);
    }
    let plain = plain_member_perms(db, access.name(), &user.username).await?;
    match access.is_member() && plain & MANAGE_BITS != 0 {
        true => Ok(Some(plain)),
        false => Err(forbidden("Missing permission")),
    }
}

/// A text channel of the manager's server that they can see.
async fn manager_channel(
    db: &Db,
    access: &ServerAccess,
    user: &User,
    id: i64,
) -> Result<ResolvedChannel, ApiError> {
    let channel = allowed(resolve_channel(db, id, Some(user), &Proof::none()).await)?
        .filter(|c| c.server().name() == access.name())
        .ok_or_else(|| bad("Unknown channel"))?;
    match channel.kind() {
        ChannelKind::Text => Ok(channel),
        ChannelKind::Voice => Err(bad("Webhooks post only in text channels")),
    }
}

/// Characters a name may not hold: control, format (zero-width, bidi, soft hyphen), line and
/// paragraph separators, and the invisible fillers that render as nothing.
fn hidden_char(c: char) -> bool {
    use unicode_properties::{GeneralCategory, UnicodeGeneralCategory};
    matches!(
        c.general_category(),
        GeneralCategory::Control
            | GeneralCategory::Format
            | GeneralCategory::LineSeparator
            | GeneralCategory::ParagraphSeparator
            | GeneralCategory::PrivateUse
            | GeneralCategory::Surrogate
            | GeneralCategory::Unassigned
    ) || matches!(
        c as u32,
        0x34f | 0x115f | 0x1160 | 0x17b4 | 0x17b5 | 0x180b..=0x180f | 0x2800 | 0x3164 | 0xffa0
    )
}

/// What a name looks like, for comparing names: NFKC, variation selectors dropped, full case
/// folding, whitespace collapsed, then the UTS #39 confusable skeleton (folded again), so
/// `ALICE` in fullwidth letters, a Cyrillic a (U+0430) or a no-break space all match the plain
/// name.
pub fn name_key(name: &str) -> String {
    name_keys(name)[1].clone()
}

/// The keys two names are compared by: lookalike skeletons taken both before and after case
/// folding (capital I passes for l only before folding), with combining marks dropped so a
/// mark stacked on a letter cannot hide the match. Two names clash when any keys are equal.
pub fn name_keys(name: &str) -> [String; 2] {
    use unicode_normalization::UnicodeNormalization;
    use unicode_normalization::char::is_combining_mark;
    let fold = |s: &str| {
        caseless::default_case_fold_str(s)
            .nfkc()
            .filter(|c| !matches!(*c as u32, 0xfe00..=0xfe0f | 0xe0100..=0xe01ef))
            .collect::<String>()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    };
    let bare: String = name.nfkd().filter(|c| !is_combining_mark(*c)).collect();
    let skeleton = |s: &str| unicode_security::skeleton(s).collect::<String>();
    [
        fold(&skeleton(&bare.nfkc().collect::<String>())),
        fold(&skeleton(&fold(&bare))),
    ]
}

fn names_clash(a: &[String; 2], b: &[String; 2]) -> bool {
    a.iter().any(|x| b.contains(x))
}

/// Checks a webhook name: 1 to 80 characters after trimming, no control, format or invisible
/// characters, the profanity filter, and never a name that passes for someone in the server:
/// a member's username or display name, or the instance staff, compared by `name_key`.
async fn check_name(db: &Db, server: &str, raw: &str) -> Result<String, ApiError> {
    let name = raw.trim().to_string();
    if name.is_empty() {
        return Err(bad("Name is required"));
    }
    check_len(&name, NAME_MAX, "Name")?;
    if name.chars().any(hidden_char) {
        return Err(bad("Name has invalid characters"));
    }
    Settings::cached(db)
        .await
        .check_profanity(ProfanityTarget::Usernames, &name)?;
    let keys = name_keys(&name);
    if keys.iter().any(String::is_empty) {
        return Err(bad("Name is required"));
    }
    let mut taken = names_clash(&keys, &name_keys(STAFF_NAME));
    if !taken {
        let rows = sqlx::query("SELECT u.username, u.display_name FROM members m JOIN users u ON u.username = m.username WHERE m.server = $1")
            .bind(server)
            .fetch_all(db)
            .await?;
        for r in &rows {
            let (username, display): (String, String) = (r.try_get(0)?, r.try_get(1)?);
            if names_clash(&keys, &name_keys(&username)) || names_clash(&keys, &name_keys(&display))
            {
                taken = true;
                break;
            }
        }
    }
    match taken {
        true => Err(bad(
            "That name belongs to someone in this server. Pick another name",
        )),
        false => Ok(name),
    }
}

fn check_avatar(kind: AvatarKind, color: Option<&str>) -> Result<Option<String>, ApiError> {
    match (kind, color) {
        (AvatarKind::Identicon, _) => Ok(None),
        (AvatarKind::Color, Some(c)) if valid_color(c) => Ok(Some(c.to_lowercase())),
        (AvatarKind::Color, _) => Err(bad("Avatar color must be #rrggbb")),
    }
}

fn webhook_entry(server: &str, actor: &Actor, action: Action, id: i64, name: &str) -> Entry {
    Entry::new(server, actor, action).target(Target::with_id(TargetKind::Webhook, id, Some(name)))
}

/// A new incoming webhook.
#[derive(Deserialize, ToSchema)]
pub struct NewWebhook {
    /// A text channel of the server that you can see.
    pub channel_id: i64,
    /// 1 to 80 characters. It cannot be the username or display name of anyone in the server.
    pub name: String,
    /// Defaults to `identicon`.
    #[serde(default)]
    pub avatar_kind: Option<AvatarKind>,
    /// `#rrggbb`, required with `avatar_kind` `color`.
    #[serde(default)]
    pub avatar_color: Option<String>,
}

/// Changes to an incoming webhook; omitted fields stay.
#[derive(Deserialize, ToSchema)]
pub struct WebhookPatch {
    /// Move it to this text channel (at most 15 webhooks per channel).
    #[serde(default)]
    pub channel_id: Option<i64>,
    /// 1 to 80 characters, checked like a new name.
    #[serde(default)]
    pub name: Option<String>,
    /// How its default avatar is drawn.
    #[serde(default)]
    pub avatar_kind: Option<AvatarKind>,
    /// `#rrggbb`, required for `color` unless it already has one.
    #[serde(default)]
    pub avatar_color: Option<String>,
}

/// List incoming webhooks
///
/// The server's incoming webhooks in channels you can see, oldest first. Requires the Manage
/// webhooks or Manage channels permission. Tokens are never listed. General rate-limit bucket.
#[utoipa::path(get, path = "/api/servers/{name}/webhooks", tag = "Webhooks", params(("name" = String, Path, description = "Server name")), responses((status = 200, description = "The webhooks", body = Vec<Webhook>), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 403, description = "`Missing permission`, or `You are timed out in this server`", body = ApiErrorBody), (status = 404, description = "`Server not found or wrong password`: no such server, one you have no access to, or one you are not a member of (identical responses)", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn list_webhooks(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
) -> Result<Json<Vec<Webhook>>, ApiError> {
    let access = manager(&state, &user, &name).await?;
    let db = &state.db;
    let rights = access.channel_rights(db).await?;
    let sql = format!("SELECT {HOOK_COLS} FROM webhooks WHERE server = $1 ORDER BY id");
    let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(access.name())
        .fetch_all(db)
        .await?;
    let rows: Vec<_> = rows
        .into_iter()
        .filter(|r| {
            r.try_get::<i64, _>(2)
                .is_ok_and(|cid| rights.get(&cid).is_none_or(|a| a.view))
        })
        .collect();
    Ok(Json(webhook_rows(db, &rows).await?))
}

/// Create an incoming webhook
///
/// Creates a webhook that posts into one text channel of the server, and returns its token
/// once. Anyone with the URL `/api/webhooks/{id}/{token}` can post there as the webhook, so
/// treat it like a password. At most 15 per channel and 100 per server. Requires membership
/// with the Manage webhooks or Manage channels permission. Whether the webhook may use group
/// mentions is fixed now from your Mention everyone permission (and checked again on every
/// message). Logged in the audit log. Strict rate-limit bucket.
#[utoipa::path(post, path = "/api/servers/{name}/webhooks", tag = "Webhooks", params(("name" = String, Path, description = "Server name")), request_body = NewWebhook, responses((status = 200, description = "The webhook with its token", body = WebhookSecret), (status = 400, description = "Unknown or voice channel, an invalid or taken name (`That name belongs to someone in this server. Pick another name`), an invalid avatar color, the profanity filter, or the channel or server limit", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 403, description = "`Missing permission`, or `You are timed out in this server`", body = ApiErrorBody), (status = 404, description = "`Server not found or wrong password` (identical for servers you cannot open or are not a member of)", body = ApiErrorBody), (status = 429, description = "Too many requests", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn create_webhook(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Json(req): Json<NewWebhook>,
) -> Result<Json<WebhookSecret>, ApiError> {
    let NewWebhook {
        channel_id,
        name: hook_name,
        avatar_kind,
        avatar_color,
    } = req;
    let access = manager(&state, &user, &name).await?;
    let db = &state.db;
    let plain = plain_member_perms(db, access.name(), &user.username).await?;
    if !access.is_member() || plain & MANAGE_BITS == 0 {
        return Err(forbidden("Missing permission"));
    }
    let channel = manager_channel(db, &access, &user, channel_id).await?;
    let hook_name = check_name(db, access.name(), &hook_name).await?;
    let kind = avatar_kind.unwrap_or(AvatarKind::Identicon);
    let color = check_avatar(kind, avatar_color.as_deref())?;
    let mentions = plain & Perm::MentionEveryone as i64 != 0;
    let token = new_token();
    let hash = token_hash(&pepper(db).await?, &token);
    let actor = manager_actor(db, &access, &user).await?;
    let place = audit::channel_ref(db, channel.id())
        .await?
        .ok_or_else(|| bad("Unknown channel"))?;
    let t = now();
    let mut tx = db.begin().await?;
    if !crate::db::is_sqlite(db) {
        sqlx::query("SELECT 1 FROM servers WHERE name = $1 FOR UPDATE")
            .bind(access.name())
            .execute(&mut *tx)
            .await?;
    }
    let sql = format!(
        "INSERT INTO webhooks(server, channel_id, name, avatar_kind, avatar_color, token_hash, creator, creator_mentions, created_at) SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9 WHERE (SELECT COUNT(*) FROM webhooks WHERE channel_id = $2) < $10 AND (SELECT COUNT(*) FROM webhooks WHERE server = $1) < $11 RETURNING {HOOK_COLS}"
    );
    let row = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(access.name())
        .bind(channel.id())
        .bind(&hook_name)
        .bind(kind.as_str())
        .bind(&color)
        .bind(&hash)
        .bind(&user.username)
        .bind(mentions as i64)
        .bind(t)
        .bind(CHANNEL_MAX)
        .bind(SERVER_MAX)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| bad("A channel can have at most 15 webhooks and a server 100"))?;
    let id: i64 = row.try_get(0)?;
    audit::record(
        &mut tx,
        webhook_entry(access.name(), &actor, Action::WebhookCreate, id, &hook_name)
            .details(Details::new().channel(&place)),
    )
    .await?;
    tx.commit().await?;
    let webhook = webhook_rows(db, &[row]).await?.remove(0);
    Ok(Json(WebhookSecret {
        path: format!("/api/webhooks/{id}/{token}"),
        token,
        webhook,
    }))
}

async fn managed_hook(
    db: &Db,
    access: &ServerAccess,
    user: &User,
    id: i64,
) -> Result<(Hook, sqlx::any::AnyRow), ApiError> {
    let sql = format!("SELECT {HOOK_COLS} FROM webhooks WHERE id = $1 AND server = $2");
    let row = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .bind(access.name())
        .fetch_optional(db)
        .await?
        .ok_or_else(unknown)?;
    let hook = hook_row(&row)?;
    if allowed(resolve_channel(db, hook.channel_id, Some(user), &Proof::none()).await)?.is_none() {
        return Err(unknown());
    }
    Ok((hook, row))
}

/// Edit an incoming webhook
///
/// Renames it, changes its avatar or moves it to another text channel you can see. The token
/// stays. Moving someone else's webhook makes you its owner: whether it may use group mentions
/// is then taken from your Mention everyone permission (this needs Manage webhooks or Manage
/// channels as a member). Requires the Manage webhooks or Manage channels permission. Logged in
/// the audit log. General rate-limit bucket.
#[utoipa::path(patch, path = "/api/servers/{name}/webhooks/{id}", tag = "Webhooks", params(("name" = String, Path, description = "Server name"), ("id" = i64, Path, description = "Webhook id")), request_body = WebhookPatch, responses((status = 200, description = "The webhook", body = Webhook), (status = 400, description = "Invalid name, avatar or channel, or the channel's limit", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 403, description = "`Missing permission`, or `You are timed out in this server`", body = ApiErrorBody), (status = 404, description = "`Server not found or wrong password`, or `Unknown webhook` (also for webhooks in channels you cannot see)", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn update_webhook(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path((name, id)): Path<(String, i64)>,
    Json(req): Json<WebhookPatch>,
) -> Result<Json<Webhook>, ApiError> {
    let WebhookPatch {
        channel_id,
        name: new_name,
        avatar_kind,
        avatar_color,
    } = req;
    let access = manager(&state, &user, &name).await?;
    let db = &state.db;
    let (hook, _) = managed_hook(db, &access, &user, id).await?;
    let channel = match channel_id {
        Some(cid) if cid != hook.channel_id => {
            Some(manager_channel(db, &access, &user, cid).await?.id())
        }
        Some(_) | None => None,
    };
    let new_name = match new_name {
        Some(n) if n.trim() != hook.name => check_name(db, access.name(), &n).await?,
        Some(_) | None => hook.name.clone(),
    };
    let kind = avatar_kind.unwrap_or(hook.avatar_kind);
    let color = match (avatar_kind, avatar_color) {
        (None, None) => hook.avatar_color.clone(),
        (_, given) => check_avatar(kind, given.as_deref().or(hook.avatar_color.as_deref()))?,
    };
    let before = audit::channel_ref(db, hook.channel_id).await?;
    let after = match channel {
        Some(cid) => audit::channel_ref(db, cid).await?,
        None => before.clone(),
    };
    let mut details = Details::new()
        .change("name", hook.name.clone(), new_name.clone())
        .change(
            "avatar",
            stored_avatar(hook.avatar_kind, hook.avatar_color.as_deref()),
            stored_avatar(kind, color.as_deref()),
        );
    if let (Some(b), Some(a)) = (&before, &after) {
        details = details
            .change("channel", b.name.clone(), a.name.clone())
            .mention(b)
            .channel(a);
    }
    let owner = match channel {
        Some(_) => takeover(db, &access, &user, hook.creator.as_deref()).await?,
        None => None,
    };
    if owner.is_some() {
        details = details.change("owner", hook.creator.clone(), user.username.clone());
    }
    let actor = manager_actor(db, &access, &user).await?;
    let mut tx = db.begin().await?;
    let moved = sqlx::query("UPDATE webhooks SET name = $1, avatar_kind = $2, avatar_color = $3, channel_id = $4, creator = CASE WHEN $7 <> 0 THEN $8 ELSE creator END, creator_mentions = CASE WHEN $7 <> 0 THEN $9 ELSE creator_mentions END WHERE id = $5 AND (channel_id = $4 OR (SELECT COUNT(*) FROM webhooks WHERE channel_id = $4) < $6)")
        .bind(&new_name)
        .bind(kind.as_str())
        .bind(&color)
        .bind(channel.unwrap_or(hook.channel_id))
        .bind(id)
        .bind(CHANNEL_MAX)
        .bind(owner.is_some() as i64)
        .bind(&user.username)
        .bind(owner.is_some_and(|p| p & Perm::MentionEveryone as i64 != 0) as i64)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if moved == 0 {
        return Err(bad("A channel can have at most 15 webhooks"));
    }
    if details.has_changes() {
        audit::record(
            &mut tx,
            webhook_entry(access.name(), &actor, Action::WebhookUpdate, id, &new_name)
                .details(details),
        )
        .await?;
    }
    tx.commit().await?;
    let (_, row) = managed_hook(db, &access, &user, id).await?;
    Ok(Json(webhook_rows(db, &[row]).await?.remove(0)))
}

/// Reset an incoming webhook's token
///
/// Makes a new token and returns it once; the old URL stops working at once. Resetting someone
/// else's webhook makes you its owner: whether it may use group mentions is then taken from
/// your Mention everyone permission (this needs Manage webhooks or Manage channels as a
/// member). Requires the Manage webhooks or Manage channels permission. Logged in the audit
/// log. Strict rate-limit bucket.
#[utoipa::path(post, path = "/api/servers/{name}/webhooks/{id}/token", tag = "Webhooks", params(("name" = String, Path, description = "Server name"), ("id" = i64, Path, description = "Webhook id")), responses((status = 200, description = "The webhook with its new token", body = WebhookSecret), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 403, description = "`Missing permission` (also when taking over someone else's webhook without Manage webhooks or Manage channels as a member), or `You are timed out in this server`", body = ApiErrorBody), (status = 404, description = "`Server not found or wrong password`, or `Unknown webhook`", body = ApiErrorBody), (status = 429, description = "Too many requests", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn reset_token(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path((name, id)): Path<(String, i64)>,
) -> Result<Json<WebhookSecret>, ApiError> {
    let access = manager(&state, &user, &name).await?;
    let db = &state.db;
    let (hook, _) = managed_hook(db, &access, &user, id).await?;
    let owner = takeover(db, &access, &user, hook.creator.as_deref()).await?;
    let token = new_token();
    let hash = token_hash(&pepper(db).await?, &token);
    let actor = manager_actor(db, &access, &user).await?;
    let mut tx = db.begin().await?;
    sqlx::query("UPDATE webhooks SET token_hash = $1, creator = CASE WHEN $3 <> 0 THEN $4 ELSE creator END, creator_mentions = CASE WHEN $3 <> 0 THEN $5 ELSE creator_mentions END WHERE id = $2")
        .bind(&hash)
        .bind(id)
        .bind(owner.is_some() as i64)
        .bind(&user.username)
        .bind(owner.is_some_and(|p| p & Perm::MentionEveryone as i64 != 0) as i64)
        .execute(&mut *tx)
        .await?;
    let details = match owner {
        Some(_) => Details::new().change("owner", hook.creator.clone(), user.username.clone()),
        None => Details::new(),
    };
    audit::record(
        &mut tx,
        webhook_entry(
            access.name(),
            &actor,
            Action::WebhookTokenReset,
            id,
            &hook.name,
        )
        .details(details),
    )
    .await?;
    tx.commit().await?;
    let (_, row) = managed_hook(db, &access, &user, id).await?;
    Ok(Json(WebhookSecret {
        webhook: webhook_rows(db, &[row]).await?.remove(0),
        path: format!("/api/webhooks/{id}/{token}"),
        token,
    }))
}

/// Delete an incoming webhook
///
/// Its URL stops working; messages it posted stay (moderators delete them like any message).
/// Requires the Manage webhooks or Manage channels permission. Logged in the audit log.
/// General rate-limit bucket.
#[utoipa::path(delete, path = "/api/servers/{name}/webhooks/{id}", tag = "Webhooks", params(("name" = String, Path, description = "Server name"), ("id" = i64, Path, description = "Webhook id")), responses((status = 200, description = "Deleted", body = OkResp), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 403, description = "`Missing permission`, or `You are timed out in this server`", body = ApiErrorBody), (status = 404, description = "`Server not found or wrong password`, or `Unknown webhook`", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn delete_webhook(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path((name, id)): Path<(String, i64)>,
) -> Result<Json<OkResp>, ApiError> {
    let access = manager(&state, &user, &name).await?;
    let db = &state.db;
    let (hook, _) = managed_hook(db, &access, &user, id).await?;
    let actor = manager_actor(db, &access, &user).await?;
    let place = audit::channel_ref(db, hook.channel_id).await?;
    let mut tx = db.begin().await?;
    sqlx::query("DELETE FROM webhooks WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let details = match &place {
        Some(p) => Details::new().channel(p),
        None => Details::new(),
    };
    audit::record(
        &mut tx,
        webhook_entry(access.name(), &actor, Action::WebhookDelete, id, &hook.name)
            .details(details),
    )
    .await?;
    tx.commit().await?;
    Ok(ok())
}

/// Which mentions in a webhook message may ping. Omitted: `@username` mentions and the replied
/// author ping; `@everyone`, `@here` and roles never do.
#[derive(Clone, Debug, Default, Deserialize, ToSchema)]
pub struct AllowedMentions {
    /// Kinds to ping wherever they appear: `users`, `roles` and `everyone` (covers `@here`).
    #[serde(default)]
    pub parse: Vec<MentionKind>,
    /// Usernames that may be pinged (when `users` is not in `parse`). At most 100.
    #[serde(default)]
    pub users: Vec<String>,
    /// Role ids that may be pinged (when `roles` is not in `parse`). At most 100.
    #[serde(default)]
    pub roles: Vec<i64>,
    /// Ping the author of the `reply_to` message. Defaults to `false` here.
    #[serde(default)]
    pub replied_user: bool,
}

/// A kind of mention for `AllowedMentions.parse`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum MentionKind {
    Users,
    Roles,
    Everyone,
}

/// A message posted through a webhook. It needs `content`, an embed, a file or a poll.
#[derive(Default, Deserialize, ToSchema)]
pub struct ExecuteReq {
    /// Text, at most 4000 characters, like a user message.
    #[serde(default)]
    pub content: String,
    /// Name for this message only, 1 to 80 characters, checked like the webhook's name.
    #[serde(default)]
    pub username: Option<String>,
    /// Avatar for this message only: `identicon` or `#rrggbb`.
    #[serde(default)]
    pub avatar: Option<String>,
    /// Post as a reply in the thread of this top-level message of the webhook's channel.
    #[serde(default)]
    pub thread_id: Option<i64>,
    /// Quote this message (a user or poll message in the same channel, or thread).
    #[serde(default)]
    pub reply_to: Option<i64>,
    /// Which mentions may ping; see `AllowedMentions`.
    #[serde(default)]
    pub allowed_mentions: Option<AllowedMentions>,
    /// A poll, as for `POST /api/channels/{id}/messages`.
    #[serde(default)]
    pub poll: Option<PollReq>,
    /// At most 10 rich embeds.
    #[serde(default)]
    pub embeds: Vec<RichEmbed>,
    /// Blur the attached file (multipart only).
    #[serde(default)]
    pub media_spoiler: Option<bool>,
}

#[derive(Deserialize, IntoParams)]
pub struct ExecuteQuery {
    /// Answer with the posted message (200) instead of an empty 204.
    #[serde(default)]
    pub wait: bool,
}

/// What an incoming webhook may say through its token.
#[derive(Serialize, Deserialize, ToSchema)]
pub struct WebhookInfo {
    /// Webhook id.
    pub id: i64,
    /// The channel it posts into.
    pub channel_id: i64,
    /// Default name of its messages.
    pub name: String,
    /// How its default avatar is drawn.
    pub avatar_kind: AvatarKind,
    /// `#rrggbb` when `avatar_kind` is `color`.
    pub avatar_color: Option<String>,
}

static HOOK_PACE: LazyLock<Budget> =
    LazyLock::new(|| Budget::new(HOOK_BURST, HOOK_WINDOW, 100_000));
static CHANNEL_PACE: LazyLock<Budget> =
    LazyLock::new(|| Budget::new(CHANNEL_BUDGET, Duration::from_secs(60), 100_000));

fn paced(db: &Db, hook: &Hook) -> Result<(), ApiError> {
    let pool = crate::db::pool_key(db);
    match HOOK_PACE.take(&format!("{pool}\nh{}", hook.id))
        && CHANNEL_PACE.take(&format!("{pool}\nc{}", hook.channel_id))
    {
        true => Ok(()),
        false => Err(slow_down()),
    }
}

/// The account-like stand-in a webhook posts as: its author key, never a real account.
fn poster(hook: &Hook, name: &str, kind: AvatarKind, color: Option<String>) -> User {
    User {
        username: author_key(hook.id),
        display_name: name.to_string(),
        password_hash: "!webhook".to_string(),
        password_kind: String::new(),
        avatar_kind: kind,
        avatar_color: color,
        banner_color: None,
        bio: None,
        is_site_admin: false,
        appear_offline: true,
        created_at: 0,
    }
}

/// The reply a webhook message quotes: a user or poll message in the same place.
async fn hook_quote(
    db: &Db,
    channel: i64,
    place: Place,
    reply_to: Option<i64>,
    mention: bool,
) -> Result<Option<Quoted>, ApiError> {
    let Some(id) = reply_to else {
        return Ok(None);
    };
    let sql = format!(
        "SELECT m.channel_id, m.thread_root_id, m.author, m.kind FROM messages m WHERE m.id = $1 AND {}",
        crate::db::LIVE_AUTHOR
    );
    let row = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(cannot_reply)?;
    let (cid, root, author, kind): (Option<i64>, Option<i64>, String, String) = (
        row.try_get(0)?,
        row.try_get(1)?,
        row.try_get(2)?,
        row.try_get(3)?,
    );
    let here = cid == Some(channel)
        && match place {
            Place::Channel(_) => root.is_none(),
            Place::Thread(r) => id == r || root == Some(r),
            Place::Dm(_) => false,
        };
    if !here || !matches!(kind.as_str(), "user" | "poll") {
        return Err(cannot_reply());
    }
    Ok(Some(Quoted {
        id,
        mention,
        author,
    }))
}

/// Whether the webhook's creator may use group mentions right now: they could when they made
/// it, and they still can (as a plain member, ignoring timeouts like the webhook does).
async fn creator_may_group(db: &Db, hook: &Hook) -> Result<bool, ApiError> {
    if !hook.creator_mentions {
        return Ok(false);
    }
    let Some(creator) = &hook.creator else {
        return Ok(false);
    };
    if get_user(db, creator).await?.is_none() {
        return Ok(false);
    }
    Ok(plain_member_perms(db, &hook.server, creator).await? & Perm::MentionEveryone as i64 != 0)
}

async fn read_execute(
    state: &AppState,
    req: Request,
) -> Result<(ExecuteReq, Option<(String, String, Bytes)>), ApiError> {
    let multipart = req
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.to_ascii_lowercase().starts_with("multipart/form-data"));
    if !multipart {
        let Json(body) = Json::<ExecuteReq>::from_request(req, state)
            .await
            .map_err(|e| bad(&e.body_text()))?;
        return Ok((body, None));
    }
    let mut form = Multipart::from_request(req, state)
        .await
        .map_err(|e| bad(&e.body_text()))?;
    let mut body: Option<ExecuteReq> = None;
    let mut file = None;
    while let Some(field) = form
        .next_field()
        .await
        .map_err(|e| ApiError(StatusCode::BAD_REQUEST, e.to_string()))?
    {
        match field.name() {
            Some("payload_json") => {
                let text = field
                    .text()
                    .await
                    .map_err(|e| ApiError(StatusCode::BAD_REQUEST, e.to_string()))?;
                body = Some(serde_json::from_str(&text).map_err(|_| bad("Invalid payload_json"))?);
            }
            Some(_) | None if file.is_none() && field.file_name().is_some() => {
                let filename = field.file_name().unwrap_or("file").to_string();
                let mime = field
                    .content_type()
                    .unwrap_or("application/octet-stream")
                    .to_string();
                let data = field
                    .bytes()
                    .await
                    .map_err(|e| ApiError(StatusCode::PAYLOAD_TOO_LARGE, e.to_string()))?;
                file = Some((filename, mime, data));
            }
            Some(_) | None => return Err(bad("Send one file and payload_json")),
        }
    }
    Ok((body.unwrap_or_default(), file))
}

fn override_avatar(
    raw: Option<&str>,
    hook: &Hook,
) -> Result<(AvatarKind, Option<String>), ApiError> {
    match raw.map(str::trim) {
        None => Ok((hook.avatar_kind, hook.avatar_color.clone())),
        Some("identicon") => Ok((AvatarKind::Identicon, None)),
        Some(c) if valid_color(c) => Ok((AvatarKind::Color, Some(c.to_lowercase()))),
        Some(_) => Err(bad("Avatar must be identicon or #rrggbb")),
    }
}

/// Posts `req` as `hook`, like a member who may only send in the webhook's channel.
async fn post(
    state: &AppState,
    hook: &Hook,
    req: ExecuteReq,
    file: Option<(String, String, Bytes)>,
) -> Result<Message, ApiError> {
    let ExecuteReq {
        content,
        username,
        avatar,
        thread_id,
        reply_to,
        allowed_mentions,
        poll,
        embeds: cards,
        media_spoiler,
    } = req;
    let db = &state.db;
    let settings = Settings::cached(db).await;
    check_len(&content, MESSAGE_MAX, "Message")?;
    settings.check_profanity(ProfanityTarget::Messages, &content)?;
    validate_embeds(&cards, &settings)?;
    let name = match username.as_deref() {
        Some(n) if n.trim() != hook.name => check_name(db, &hook.server, n).await?,
        Some(_) | None => hook.name.clone(),
    };
    let (kind, color) = override_avatar(avatar.as_deref(), hook)?;
    let channel = webhook_channel(db, hook.channel_id).await?;
    if channel.kind() != ChannelKind::Text {
        return Err(bad("Voice channels cannot receive messages"));
    }
    let place = match thread_id {
        Some(root) => {
            let sql = format!(
                "SELECT m.channel_id, m.thread_root_id, m.kind FROM messages m WHERE m.id = $1 AND {}",
                crate::db::LIVE_AUTHOR
            );
            let row = sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(root)
                .fetch_optional(db)
                .await?;
            let ok = row.as_ref().is_some_and(|r| {
                r.try_get::<Option<i64>, _>(0).ok().flatten() == Some(hook.channel_id)
                    && r.try_get::<Option<i64>, _>(1).ok().flatten().is_none()
                    && r.try_get::<String, _>(2)
                        .is_ok_and(|k| matches!(k.as_str(), "user" | "poll"))
            });
            if !ok {
                return Err(bad("Unknown thread"));
            }
            Place::Thread(root)
        }
        None => Place::Channel(hook.channel_id),
    };
    channel.slowmode_for(db, &author_key(hook.id)).await?;
    let mentions = allowed_mentions.clone();
    let replied_ping = mentions.as_ref().is_none_or(|m| m.replied_user);
    let quote = hook_quote(db, hook.channel_id, place, reply_to, replied_ping).await?;
    let user = poster(hook, &name, kind, color.clone());
    let groups = match (place, &mentions) {
        (Place::Channel(_), Some(m)) => {
            let may = creator_may_group(db, hook).await?;
            let everyone = may && m.parse.contains(&MentionKind::Everyone);
            let any_role = may && m.parse.contains(&MentionKind::Roles);
            let roles = match (m.parse.contains(&MentionKind::Roles), m.roles.is_empty()) {
                (true, _) => RoleRights::Mentionable,
                (false, false) => {
                    RoleRights::MentionableAmong(m.roles.iter().take(100).copied().collect())
                }
                (false, true) => RoleRights::Nothing,
            };
            let mut found = group_mentions_as(
                db,
                &hook.server,
                &content,
                GroupRights {
                    everyone,
                    any_role,
                    roles,
                },
            )
            .await?;
            if may && !m.roles.is_empty() && !any_role {
                let extra = group_mentions_as(
                    db,
                    &hook.server,
                    &content,
                    GroupRights {
                        everyone: false,
                        any_role: true,
                        roles: RoleRights::Nothing,
                    },
                )
                .await?;
                for g in extra {
                    if g.role_id.is_some_and(|r| m.roles.contains(&r)) && !found.contains(&g) {
                        found.push(g);
                    }
                }
            }
            found
        }
        (_, _) => Vec::new(),
    };
    let users = match &mentions {
        None => UserMentions::All,
        Some(m) if m.parse.contains(&MentionKind::Users) => UserMentions::All,
        Some(m) => UserMentions::Only(
            m.users
                .iter()
                .take(100)
                .map(|u| u.trim().to_lowercase())
                .collect(),
        ),
    };
    let media_id = match file {
        Some((filename, mime, data)) => {
            if !settings.asset_uploads {
                return Err(forbidden("File uploads are turned off on this server"));
            }
            settings.check_profanity(ProfanityTarget::FileNames, &filename)?;
            let (id, _) =
                crate::api::media::save_upload(state, &filename, &mime, &data, &user.username)
                    .await?;
            Some(id)
        }
        None => None,
    };
    let thread_root_id = match place {
        Place::Thread(root) => Some(root),
        Place::Channel(_) | Place::Dm(_) => None,
    };
    let send = SendReq {
        content,
        media_id,
        media_spoiler,
        p2p: None,
        reply_to: None,
        mention_reply: false,
        forward_of: None,
        poll,
    };
    let extra = HookPost {
        id: hook.id,
        name: name.clone(),
        avatar: stored_avatar(kind, color.as_deref()),
        embeds: cards,
    };
    let message = insert_message(
        db,
        Some(hook.channel_id),
        None,
        thread_root_id,
        &user,
        send,
        quote.as_ref(),
        groups,
        Some(&extra),
    )
    .await?;
    sqlx::query("UPDATE webhooks SET last_used_at = $1 WHERE id = $2")
        .bind(now())
        .bind(hook.id)
        .execute(db)
        .await?;
    let server = Some(hook.server.clone());
    embeds::spawn_unfurl(
        state,
        server.clone(),
        Some(hook.channel_id),
        None,
        None,
        message.id,
        &message.content,
    );
    store_group_pings(state, &channel, &message).await;
    state.hub.broadcast(WsEvent::Message {
        server,
        channel_id: Some(hook.channel_id),
        dm_id: None,
        dm_users: None,
        message: Box::new(partial_quote(message.clone())),
    });
    ping_message_for(
        state,
        PingScope::Channel(&channel),
        &message,
        &user,
        replied(&quote),
        &users,
    )
    .await;
    Ok(message)
}

/// Execute a webhook
///
/// Posts a message into the webhook's channel as the webhook. No bearer token: the URL is the
/// secret. Send JSON, or `multipart/form-data` with the JSON in a `payload_json` part and one
/// file part (only while file uploads are on; at most 25 MiB). The same rules as a user's
/// message apply: length limit, profanity filter, slow mode (per webhook, no exemption),
/// attachment switches, and reply and thread placement inside its channel. The webhook can
/// always send in its own channel and nowhere else; timeouts and blocks do not apply to it.
/// `@username` mentions ping as usual unless `allowed_mentions` narrows them; `@everyone`,
/// `@here` and roles ping only when `allowed_mentions` asks and the webhook's creator had
/// and still has the Mention everyone permission (mentionable roles also when asked). Rate
/// limits: 5 per 2 seconds per webhook, 30 per minute per channel, and the strict bucket per
/// IP. Wrong ids, wrong tokens and deleted webhooks all get the same 404.
#[utoipa::path(post, path = "/api/webhooks/{id}/{token}", tag = "Webhooks", params(("id" = String, Path, description = "Webhook id"), ("token" = String, Path, description = "Webhook token"), ExecuteQuery), request_body(content = ExecuteReq, description = "JSON, or multipart with `payload_json` and one file", content_type = "application/json"), responses((status = 200, description = "With `wait=true`: the posted message", body = Message), (status = 204, description = "Posted"), (status = 400, description = "Empty message, text over 4000 characters, invalid embeds, name, avatar, poll, `reply_to` (`Cannot reply to that message`) or `thread_id` (`Unknown thread`), or the profanity filter", body = ApiErrorBody), (status = 403, description = "`File uploads are turned off on this server`", body = ApiErrorBody), (status = 404, description = "`Unknown webhook`: no such webhook or a wrong token (identical responses)", body = ApiErrorBody), (status = 413, description = "File over 25 MiB", body = ApiErrorBody), (status = 429, description = "Slow mode (`Slow mode: wait Ns`), the webhook or channel budget (`Too many attempts. Try again later`), or the strict bucket (plain text)", content((ApiErrorBody = "application/json"), (String = "text/plain")))), security(()))]
pub(crate) async fn execute(
    State(state): State<AppState>,
    Path((id, token)): Path<(String, String)>,
    Query(query): Query<ExecuteQuery>,
    req: Request,
) -> Result<Response, ApiError> {
    let hook = hook_for(&state.db, &id, &token).await?;
    paced(&state.db, &hook)?;
    let (body, file) = read_execute(&state, req).await?;
    let message = post(&state, &hook, body, file).await?;
    Ok(match query.wait {
        true => Json(message).into_response(),
        false => StatusCode::NO_CONTENT.into_response(),
    })
}

/// Get a webhook through its token
///
/// The webhook's id, channel, name and avatar, to check a URL. No bearer token. Wrong ids and
/// tokens get the same 404. Strict rate-limit bucket.
#[utoipa::path(get, path = "/api/webhooks/{id}/{token}", tag = "Webhooks", params(("id" = String, Path, description = "Webhook id"), ("token" = String, Path, description = "Webhook token")), responses((status = 200, description = "The webhook", body = WebhookInfo), (status = 404, description = "`Unknown webhook`", body = ApiErrorBody), (status = 429, description = "Too many requests", content_type = "text/plain", body = String)), security(()))]
pub(crate) async fn webhook_info(
    State(state): State<AppState>,
    Path((id, token)): Path<(String, String)>,
) -> Result<Json<WebhookInfo>, ApiError> {
    let Hook {
        id,
        server: _,
        channel_id,
        name,
        avatar_kind,
        avatar_color,
        creator: _,
        creator_mentions: _,
    } = hook_for(&state.db, &id, &token).await?;
    Ok(Json(WebhookInfo {
        id,
        channel_id,
        name,
        avatar_kind,
        avatar_color,
    }))
}

/// A message of this webhook, still in its channel.
async fn own_message(db: &Db, hook: &Hook, message_id: &str) -> Result<i64, ApiError> {
    let id: i64 = message_id.parse().map_err(|_| unknown_message())?;
    let found = sqlx::query(
        "SELECT kind FROM messages WHERE id = $1 AND webhook_id = $2 AND channel_id = $3",
    )
    .bind(id)
    .bind(hook.id)
    .bind(hook.channel_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(unknown_message)?;
    match found.try_get::<String, _>(0)?.as_str() {
        "user" | "poll" => Ok(id),
        _ => Err(unknown_message()),
    }
}

/// New text or embeds for a webhook message; omitted fields stay.
#[derive(Deserialize, ToSchema)]
pub struct WebhookEdit {
    /// New text, at most 4000 characters.
    #[serde(default)]
    pub content: Option<String>,
    /// New embeds (replacing the old ones), at most 10; `[]` removes them.
    #[serde(default)]
    pub embeds: Option<Vec<RichEmbed>>,
}

/// Edit a webhook message
///
/// Changes the text or embeds of a message this webhook posted (no other message). Checked
/// like a new message; edits never ping. Poll messages cannot be edited. No bearer token.
/// Strict rate-limit bucket.
#[utoipa::path(patch, path = "/api/webhooks/{id}/{token}/messages/{message_id}", tag = "Webhooks", params(("id" = String, Path, description = "Webhook id"), ("token" = String, Path, description = "Webhook token"), ("message_id" = String, Path, description = "Message id")), request_body = WebhookEdit, responses((status = 200, description = "The edited message", body = Message), (status = 400, description = "Empty result, too long, invalid embeds, the profanity filter, or a poll (`Cannot edit this message`)", body = ApiErrorBody), (status = 404, description = "`Unknown webhook`, or `Unknown message` (not one of this webhook's messages)", body = ApiErrorBody), (status = 429, description = "The webhook budget or the strict bucket", content((ApiErrorBody = "application/json"), (String = "text/plain")))), security(()))]
pub(crate) async fn edit_hook_message(
    State(state): State<AppState>,
    Path((id, token, message_id)): Path<(String, String, String)>,
    Json(req): Json<WebhookEdit>,
) -> Result<Json<Message>, ApiError> {
    let WebhookEdit {
        content,
        embeds: cards,
    } = req;
    let db = &state.db;
    let hook = hook_for(db, &id, &token).await?;
    paced(db, &hook)?;
    let mid = own_message(db, &hook, &message_id).await?;
    let row = sqlx::query(
        "SELECT content, kind, media_id, media_removed, webhook_embeds FROM messages WHERE id = $1",
    )
    .bind(mid)
    .fetch_one(db)
    .await?;
    let (old, kind): (String, String) = (row.try_get(0)?, row.try_get(1)?);
    if kind != "user" {
        return Err(bad("Cannot edit this message"));
    }
    let attached = row.try_get::<Option<String>, _>(2)?.is_some() && row.try_get::<i64, _>(3)? == 0;
    let old_cards = parse_embeds(row.try_get::<Option<String>, _>(4)?.as_deref());
    let settings = Settings::cached(db).await;
    let content = content.unwrap_or_else(|| old.clone());
    let cards = cards.unwrap_or(old_cards.clone());
    check_len(&content, MESSAGE_MAX, "Message")?;
    settings.check_profanity(ProfanityTarget::Messages, &content)?;
    validate_embeds(&cards, &settings)?;
    if blank(&content) && !attached && cards.is_empty() {
        return Err(bad("Message is empty"));
    }
    if content != old || cards != old_cards {
        let relink = embeds::extract_urls(&content) != embeds::extract_urls(&old);
        let mut tx = db.begin().await?;
        sqlx::query(
            "UPDATE messages SET content = $1, webhook_embeds = $2, edited_at = $3 WHERE id = $4",
        )
        .bind(&content)
        .bind(stored_embeds(&cards))
        .bind(now())
        .bind(mid)
        .execute(&mut *tx)
        .await?;
        if relink {
            sqlx::query("DELETE FROM message_embeds WHERE message_id = $1")
                .bind(mid)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        let server = Some(hook.server.clone());
        if relink {
            embeds::spawn_unfurl(
                &state,
                server.clone(),
                Some(hook.channel_id),
                None,
                None,
                mid,
                &content,
            );
        }
        if let Some(updated) = load_broadcast(db, mid).await? {
            state.hub.broadcast(WsEvent::MessageUpdated {
                server,
                channel_id: Some(hook.channel_id),
                update: Updated::stub(mid, updated.thread_root_id, updated.edited_at),
                dm_users: Vec::new(),
            });
        }
    }
    let message = load_message(db, mid, Quotes::Since(None))
        .await?
        .ok_or_else(unknown_message)?;
    let mut msgs = [message];
    attach_embeds(db, &mut msgs).await?;
    let [message] = msgs;
    Ok(Json(message))
}

/// Delete a webhook message
///
/// Deletes a message this webhook posted (no other message). No bearer token. Strict
/// rate-limit bucket.
#[utoipa::path(delete, path = "/api/webhooks/{id}/{token}/messages/{message_id}", tag = "Webhooks", params(("id" = String, Path, description = "Webhook id"), ("token" = String, Path, description = "Webhook token"), ("message_id" = String, Path, description = "Message id")), responses((status = 204, description = "Deleted"), (status = 404, description = "`Unknown webhook`, or `Unknown message`", body = ApiErrorBody), (status = 429, description = "The webhook budget or the strict bucket", content((ApiErrorBody = "application/json"), (String = "text/plain")))), security(()))]
pub(crate) async fn delete_hook_message(
    State(state): State<AppState>,
    Path((id, token, message_id)): Path<(String, String, String)>,
) -> Result<StatusCode, ApiError> {
    let db = &state.db;
    let hook = hook_for(db, &id, &token).await?;
    paced(db, &hook)?;
    let mid = own_message(db, &hook, &message_id).await?;
    let root: Option<i64> = sqlx::query("SELECT thread_root_id FROM messages WHERE id = $1")
        .bind(mid)
        .fetch_one(db)
        .await?
        .try_get(0)?;
    let pinged = pinged_by(db, mid).await?;
    sqlx::query("DELETE FROM messages WHERE id = $1")
        .bind(mid)
        .execute(db)
        .await?;
    announce_counts(&state, pinged).await;
    state.hub.broadcast(WsEvent::MessageDeleted {
        server: Some(hook.server.clone()),
        channel_id: Some(hook.channel_id),
        dm_id: None,
        dm_users: None,
        id: mid,
        thread_root_id: root,
    });
    Ok(StatusCode::NO_CONTENT)
}

/// The operator's rules for outgoing webhook requests.
#[derive(Clone, Debug, Default)]
pub struct Outbound {
    /// Hosts (`host` or `host:port`) that may be private or loopback addresses.
    pub allowed: Vec<AllowedHost>,
    /// Plain `http` for the allowlisted hosts (never for others).
    pub allow_http: bool,
    /// The instance's own addresses, refused like private ones.
    pub own: Vec<IpAddr>,
    /// The instance's own host names, refused like its addresses (no loops back into it).
    pub own_hosts: Vec<String>,
}

impl Outbound {
    pub fn parse(
        hosts: &str,
        allow_http: bool,
        own: Vec<IpAddr>,
        own_hosts: Vec<String>,
    ) -> anyhow::Result<Outbound> {
        let allowed = hosts
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|spec| {
                AllowedHost::parse(spec).ok_or_else(|| {
                    anyhow::anyhow!(
                        "WEBHOOK_ALLOWED_HOSTS entry {spec:?} is not a host or host:port"
                    )
                })
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        Ok(Outbound {
            allowed,
            allow_http,
            own,
            own_hosts: own_hosts
                .into_iter()
                .map(|h| h.trim_end_matches('.').to_lowercase())
                .collect(),
        })
    }

    pub fn policy(&self) -> Policy {
        Policy {
            http: match self.allow_http {
                true => Http::AllowedHostsOnly,
                false => Http::Never,
            },
            web_ports_only: false,
            allowed: self.allowed.clone(),
            own: self.own.clone(),
            own_hosts: self.own_hosts.clone(),
        }
    }
}

static OUTBOUND: OnceLock<Outbound> = OnceLock::new();

/// Sets the operator's outbound rules once at startup. Allowlist entries without a port open
/// every port of that host, so they are logged as a warning.
pub fn configure(outbound: Outbound) {
    for host in outbound.allowed.iter().filter(|h| h.any_port()) {
        tracing::warn!(
            "WEBHOOK_ALLOWED_HOSTS entry {host} has no port: outgoing webhooks may reach every port of it; prefer host:port"
        );
    }
    let _ = OUTBOUND.set(outbound);
}

fn outbound_policy() -> Policy {
    OUTBOUND.get().cloned().unwrap_or_default().policy()
}

/// An outgoing webhook. The signing secret is never listed.
#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct OutgoingWebhook {
    /// Outgoing webhook id.
    pub id: i64,
    /// Name shown to managers.
    pub name: String,
    /// Where events are POSTed.
    pub url: String,
    /// The subscribed events.
    pub events: Vec<String>,
    /// Its owner: who created it, or the last manager who changed its URL or events, turned it
    /// on or reset its secret. `null` once that account is gone. Payloads include only what
    /// this person can view when each try is sent, under their read-history rules.
    pub creator: Option<UserRef>,
    /// Off when a manager turned it off, after 10 failed deliveries in a row, or when its owner
    /// left the server.
    pub enabled: bool,
    /// When the instance turned it off, Unix seconds; `null` otherwise.
    pub disabled_at: Option<i64>,
    /// Why the instance turned it off: `failures` (10 failed deliveries in a row) or `owner`
    /// (its owner is no longer a member). Turning it on again makes you the owner.
    pub disabled_reason: Option<String>,
    /// Failed deliveries in a row.
    pub failures: i64,
    /// When it was created, Unix seconds.
    pub created_at: i64,
}

/// An outgoing webhook with its signing secret, returned once when it is created or the
/// secret is reset.
#[derive(Serialize, Deserialize, ToSchema)]
pub struct OutgoingSecret {
    #[serde(flatten)]
    pub webhook: OutgoingWebhook,
    /// HMAC-SHA256 key: `X-Webhook-Signature` is `sha256=` plus the hex HMAC of
    /// `<X-Webhook-Timestamp>.<raw body>`.
    pub secret: String,
}

/// The outgoing webhooks of a server, and whether the instance sends them at all.
#[derive(Serialize, Deserialize, ToSchema)]
pub struct OutgoingList {
    /// The instance switch; while off nothing is sent and new ones cannot be made.
    pub available: bool,
    /// The outgoing webhooks, oldest first.
    pub webhooks: Vec<OutgoingWebhook>,
}

/// A new outgoing webhook.
#[derive(Deserialize, ToSchema)]
pub struct NewOutgoing {
    /// 1 to 80 characters.
    pub name: String,
    /// `https` URL (plain `http` only for hosts the operator allows), at most 2048 characters,
    /// without credentials. Private, loopback and link-local addresses and the instance's own
    /// are refused unless the operator allowlists the host.
    pub url: String,
    /// At least one of `message.created`, `message.updated`, `message.deleted`,
    /// `member.joined`, `member.left`, `reaction.added`, `reaction.removed`, `poll.ended`.
    pub events: Vec<String>,
}

/// Changes to an outgoing webhook; omitted fields stay. Turning it on clears the failure
/// count.
#[derive(Deserialize, ToSchema)]
pub struct OutgoingPatch {
    /// 1 to 80 characters.
    #[serde(default)]
    pub name: Option<String>,
    /// A new URL, checked like `NewOutgoing.url`.
    #[serde(default)]
    pub url: Option<String>,
    /// The new event list, at least one.
    #[serde(default)]
    pub events: Option<Vec<String>>,
    /// Turn it on or off.
    #[serde(default)]
    pub enabled: Option<bool>,
}

/// One delivery: status codes and timings only, never response bodies.
#[derive(Serialize, Deserialize, ToSchema)]
pub struct Delivery {
    /// Delivery id, also sent as `X-Webhook-Delivery`.
    pub id: i64,
    /// The event type, e.g. `message.created` or `ping`.
    pub event: String,
    /// `pending` (waiting or retrying), `delivered` or `failed`.
    pub status: String,
    /// Tries so far.
    pub attempts: i64,
    /// HTTP status of the last try; `null` when it did not get a response.
    pub last_code: Option<i64>,
    /// Milliseconds the last try took.
    pub last_ms: Option<i64>,
    /// Why the last try failed (plain ASCII), e.g. `Address not allowed` or `timed out`.
    pub last_error: Option<String>,
    /// When the event was queued, Unix seconds.
    pub created_at: i64,
    /// When the next try is due, while `pending`.
    pub next_at: Option<i64>,
    /// When it was delivered or gave up, Unix seconds; `null` while `pending`.
    pub finished_at: Option<i64>,
}

const OUT_COLS: &str =
    "id, name, url, events, creator, enabled, disabled_at, failures, created_at, disabled_reason";

async fn outgoing_rows(
    db: &Db,
    rows: &[sqlx::any::AnyRow],
) -> Result<Vec<OutgoingWebhook>, ApiError> {
    let creators: Vec<String> = rows
        .iter()
        .filter_map(|r| r.try_get::<Option<String>, _>(4).ok().flatten())
        .collect();
    let refs = crate::api::user_refs(db, &creators).await;
    let live = live_users(db, &creators).await?;
    rows.iter()
        .map(|r| {
            Ok(OutgoingWebhook {
                id: r.try_get(0)?,
                name: r.try_get(1)?,
                url: r.try_get(2)?,
                events: r
                    .try_get::<String, _>(3)?
                    .split_whitespace()
                    .map(str::to_string)
                    .collect(),
                creator: r
                    .try_get::<Option<String>, _>(4)?
                    .filter(|c| live.contains(c))
                    .and_then(|c| refs.get(&c).cloned()),
                enabled: r.try_get::<i64, _>(5)? != 0,
                disabled_at: r.try_get(6)?,
                failures: r.try_get(7)?,
                created_at: r.try_get(8)?,
                disabled_reason: r.try_get(9)?,
            })
        })
        .collect()
}

fn check_events(list: &[String]) -> Result<String, ApiError> {
    let mut out: Vec<&str> = Vec::new();
    for e in list {
        let Some(known) = EVENTS.iter().find(|k| **k == e.trim()) else {
            return Err(bad("Unknown event"));
        };
        if !out.contains(known) {
            out.push(known);
        }
    }
    match out.is_empty() {
        true => Err(bad("Choose at least one event")),
        false => Ok(out.join(" ")),
    }
}

/// Checks an outgoing URL against the operator's rules, resolving it once.
async fn check_url(raw: &str) -> Result<String, ApiError> {
    let raw = raw.trim();
    check_len(raw, URL_MAX, "URL")?;
    let url = Url::parse(raw).map_err(|_| bad("Invalid URL"))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(bad("URL must not contain credentials"));
    }
    if url.fragment().is_some() {
        return Err(bad("URL must not contain a fragment"));
    }
    net_guard::check(&url, &outbound_policy())
        .await
        .map_err(|r| {
            tracing::debug!("outgoing webhook URL refused: {r}");
            bad(refusal_text(r))
        })?;
    Ok(url.to_string())
}

fn host_of(url: &str) -> String {
    Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_default()
}

fn outgoing_entry(server: &str, actor: &Actor, action: Action, id: i64, name: &str) -> Entry {
    webhook_entry(server, actor, action, id, name)
}

fn new_secret() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    format!("whsec_{}", URL_SAFE_NO_PAD.encode(bytes))
}

/// List outgoing webhooks
///
/// The server's outgoing webhooks and whether the instance sends them. Requires the Manage
/// webhooks or Manage channels permission. Secrets are never listed. General rate-limit
/// bucket.
#[utoipa::path(get, path = "/api/servers/{name}/outgoing_webhooks", tag = "Webhooks", params(("name" = String, Path, description = "Server name")), responses((status = 200, description = "The outgoing webhooks", body = OutgoingList), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 403, description = "`Missing permission`, or `You are timed out in this server`", body = ApiErrorBody), (status = 404, description = "`Server not found or wrong password`", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn list_outgoing(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
) -> Result<Json<OutgoingList>, ApiError> {
    let access = manager(&state, &user, &name).await?;
    let db = &state.db;
    let sql = format!("SELECT {OUT_COLS} FROM outgoing_webhooks WHERE server = $1 ORDER BY id");
    let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(access.name())
        .fetch_all(db)
        .await?;
    Ok(Json(OutgoingList {
        available: Settings::cached(db).await.outgoing_webhooks,
        webhooks: outgoing_rows(db, &rows).await?,
    }))
}

/// Create an outgoing webhook
///
/// The instance will POST the chosen events of this server to the URL as signed JSON
/// (`X-Webhook-Signature`, `X-Webhook-Timestamp`, `X-Webhook-Event`, `X-Webhook-Delivery`,
/// User-Agent `rchat-webhooks/1.0`). You are its owner: payloads include only channels you can
/// view, under your read-history rules, checked when each event happens and again at every
/// try; it turns off if you leave the server. Failed deliveries are retried 5 times
/// with backoff (10 s to 30 min); redirects are not followed; after 10 failed deliveries in a
/// row the webhook turns off. Only while the instance allows outgoing webhooks. At most 10
/// per server. Returns the signing secret once. Logged in the audit log (host only). Strict
/// rate-limit bucket.
#[utoipa::path(post, path = "/api/servers/{name}/outgoing_webhooks", tag = "Webhooks", params(("name" = String, Path, description = "Server name")), request_body = NewOutgoing, responses((status = 200, description = "The webhook with its secret", body = OutgoingSecret), (status = 400, description = "Invalid name, events or URL (`URL must use https`, `Address not allowed` (also for hosts that do not resolve), `Port not allowed`), or 10 already", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 403, description = "`Missing permission`, `You are timed out in this server`, or `Outgoing webhooks are turned off on this instance`", body = ApiErrorBody), (status = 404, description = "`Server not found or wrong password`", body = ApiErrorBody), (status = 429, description = "Too many requests", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn create_outgoing(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Json(req): Json<NewOutgoing>,
) -> Result<Json<OutgoingSecret>, ApiError> {
    let NewOutgoing {
        name: hook_name,
        url,
        events,
    } = req;
    let access = manager(&state, &user, &name).await?;
    let db = &state.db;
    if !Settings::cached(db).await.outgoing_webhooks {
        return Err(forbidden(
            "Outgoing webhooks are turned off on this instance",
        ));
    }
    let plain = plain_member_perms(db, access.name(), &user.username).await?;
    if !access.is_member() || plain & MANAGE_BITS == 0 {
        return Err(forbidden("Missing permission"));
    }
    let hook_name = hook_name.trim().to_string();
    if hook_name.is_empty() {
        return Err(bad("Name is required"));
    }
    check_len(&hook_name, NAME_MAX, "Name")?;
    let events = check_events(&events)?;
    let url = check_url(&url).await?;
    let secret = new_secret();
    let actor = manager_actor(db, &access, &user).await?;
    let mut tx = db.begin().await?;
    if !crate::db::is_sqlite(db) {
        sqlx::query("SELECT 1 FROM servers WHERE name = $1 FOR UPDATE")
            .bind(access.name())
            .execute(&mut *tx)
            .await?;
    }
    let sql = format!(
        "INSERT INTO outgoing_webhooks(server, name, url, events, secret, creator, created_at) SELECT $1, $2, $3, $4, $5, $6, $7 WHERE (SELECT COUNT(*) FROM outgoing_webhooks WHERE server = $1) < $8 RETURNING {OUT_COLS}"
    );
    let row = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(access.name())
        .bind(&hook_name)
        .bind(&url)
        .bind(&events)
        .bind(&secret)
        .bind(&user.username)
        .bind(now())
        .bind(OUTGOING_MAX)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| bad("A server can have at most 10 outgoing webhooks"))?;
    let id: i64 = row.try_get(0)?;
    audit::record(
        &mut tx,
        outgoing_entry(
            access.name(),
            &actor,
            Action::OutgoingCreate,
            id,
            &hook_name,
        )
        .details(
            Details::new()
                .set("host", host_of(&url))
                .set("events", events.clone()),
        ),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(OutgoingSecret {
        webhook: outgoing_rows(db, &[row]).await?.remove(0),
        secret,
    }))
}

async fn managed_outgoing(
    db: &Db,
    access: &ServerAccess,
    id: i64,
) -> Result<sqlx::any::AnyRow, ApiError> {
    let sql = format!("SELECT {OUT_COLS} FROM outgoing_webhooks WHERE id = $1 AND server = $2");
    sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .bind(access.name())
        .fetch_optional(db)
        .await?
        .ok_or_else(unknown)
}

/// Edit an outgoing webhook
///
/// Renames it, changes its URL or events, or turns it on or off (on clears the failure count).
/// The secret stays. Changing the URL or events of someone else's webhook, or turning it on,
/// makes you its owner: payloads then include only what you can view (this needs Manage
/// webhooks or Manage channels as a member). Requires the Manage webhooks or Manage channels
/// permission. Logged in the audit log. General rate-limit bucket.
#[utoipa::path(patch, path = "/api/servers/{name}/outgoing_webhooks/{id}", tag = "Webhooks", params(("name" = String, Path, description = "Server name"), ("id" = i64, Path, description = "Outgoing webhook id")), request_body = OutgoingPatch, responses((status = 200, description = "The webhook", body = OutgoingWebhook), (status = 400, description = "Invalid name, URL or events", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 403, description = "`Missing permission`, `You are timed out in this server`, or turning it on while the instance switch is off", body = ApiErrorBody), (status = 404, description = "`Server not found or wrong password`, or `Unknown webhook`", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn update_outgoing(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path((name, id)): Path<(String, i64)>,
    Json(req): Json<OutgoingPatch>,
) -> Result<Json<OutgoingWebhook>, ApiError> {
    let OutgoingPatch {
        name: new_name,
        url,
        events,
        enabled,
    } = req;
    let access = manager(&state, &user, &name).await?;
    let db = &state.db;
    let row = managed_outgoing(db, &access, id).await?;
    let owner: Option<String> = row.try_get(4)?;
    let before = outgoing_rows(db, &[row]).await?.remove(0);
    let new_name = match new_name {
        Some(n) => {
            let n = n.trim().to_string();
            if n.is_empty() {
                return Err(bad("Name is required"));
            }
            check_len(&n, NAME_MAX, "Name")?;
            n
        }
        None => before.name.clone(),
    };
    let url = match url {
        Some(u) if u.trim() != before.url => check_url(&u).await?,
        Some(_) | None => before.url.clone(),
    };
    let events = match events {
        Some(list) => check_events(&list)?,
        None => before.events.join(" "),
    };
    let enabled = enabled.unwrap_or(before.enabled);
    if enabled && !before.enabled && !Settings::cached(db).await.outgoing_webhooks {
        return Err(forbidden(
            "Outgoing webhooks are turned off on this instance",
        ));
    }
    let moves =
        url != before.url || events != before.events.join(" ") || enabled && !before.enabled;
    let takes = match moves {
        true => takeover(db, &access, &user, owner.as_deref())
            .await?
            .is_some(),
        false => false,
    };
    let details = Details::new()
        .change("name", before.name.clone(), new_name.clone())
        .change("host", host_of(&before.url), host_of(&url))
        .change(
            "url_path_changed",
            false,
            url != before.url && host_of(&url) == host_of(&before.url),
        )
        .change("events", before.events.join(" "), events.clone())
        .change("enabled", before.enabled, enabled)
        .change(
            "owner",
            owner.clone(),
            match takes {
                true => Some(user.username.clone()),
                false => owner.clone(),
            },
        );
    let actor = manager_actor(db, &access, &user).await?;
    let reset = enabled && !before.enabled;
    let mut tx = db.begin().await?;
    sqlx::query("UPDATE outgoing_webhooks SET name = $1, url = $2, events = $3, enabled = $4, failures = CASE WHEN $5 <> 0 THEN 0 ELSE failures END, disabled_at = CASE WHEN $5 <> 0 THEN NULL ELSE disabled_at END, disabled_reason = CASE WHEN $5 <> 0 THEN NULL ELSE disabled_reason END, creator = CASE WHEN $7 <> 0 THEN $8 ELSE creator END WHERE id = $6")
        .bind(&new_name)
        .bind(&url)
        .bind(&events)
        .bind(enabled as i64)
        .bind(reset as i64)
        .bind(id)
        .bind(takes as i64)
        .bind(&user.username)
        .execute(&mut *tx)
        .await?;
    if details.has_changes() {
        audit::record(
            &mut tx,
            outgoing_entry(access.name(), &actor, Action::OutgoingUpdate, id, &new_name)
                .details(details),
        )
        .await?;
    }
    tx.commit().await?;
    Ok(Json(
        outgoing_rows(db, &[managed_outgoing(db, &access, id).await?])
            .await?
            .remove(0),
    ))
}

/// Reset an outgoing webhook's secret
///
/// Makes a new signing secret and returns it once; deliveries are signed with it from now on.
/// Resetting someone else's webhook makes you its owner: payloads then include only what you
/// can view (this needs Manage webhooks or Manage channels as a member). Requires the Manage
/// webhooks or Manage channels permission. Logged in the audit log. Strict rate-limit bucket.
#[utoipa::path(post, path = "/api/servers/{name}/outgoing_webhooks/{id}/secret", tag = "Webhooks", params(("name" = String, Path, description = "Server name"), ("id" = i64, Path, description = "Outgoing webhook id")), responses((status = 200, description = "The webhook with its new secret", body = OutgoingSecret), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 403, description = "`Missing permission` (also when taking over someone else's webhook without Manage webhooks or Manage channels as a member), or `You are timed out in this server`", body = ApiErrorBody), (status = 404, description = "`Server not found or wrong password`, or `Unknown webhook`", body = ApiErrorBody), (status = 429, description = "Too many requests", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn reset_secret(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path((name, id)): Path<(String, i64)>,
) -> Result<Json<OutgoingSecret>, ApiError> {
    let access = manager(&state, &user, &name).await?;
    let db = &state.db;
    let row = managed_outgoing(db, &access, id).await?;
    let hook_name: String = row.try_get(1)?;
    let owner: Option<String> = row.try_get(4)?;
    let takes = takeover(db, &access, &user, owner.as_deref())
        .await?
        .is_some();
    let secret = new_secret();
    let actor = manager_actor(db, &access, &user).await?;
    let mut tx = db.begin().await?;
    sqlx::query("UPDATE outgoing_webhooks SET secret = $1, creator = CASE WHEN $3 <> 0 THEN $4 ELSE creator END WHERE id = $2")
        .bind(&secret)
        .bind(id)
        .bind(takes as i64)
        .bind(&user.username)
        .execute(&mut *tx)
        .await?;
    let details = match takes {
        true => Details::new().change("owner", owner.clone(), user.username.clone()),
        false => Details::new(),
    };
    audit::record(
        &mut tx,
        outgoing_entry(
            access.name(),
            &actor,
            Action::OutgoingSecretReset,
            id,
            &hook_name,
        )
        .details(details),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(OutgoingSecret {
        webhook: outgoing_rows(db, &[managed_outgoing(db, &access, id).await?])
            .await?
            .remove(0),
        secret,
    }))
}

/// Delete an outgoing webhook
///
/// Stops all deliveries, pending ones included, and drops its log. Requires the Manage webhooks
/// or Manage channels permission. Logged in the audit log. General rate-limit bucket.
#[utoipa::path(delete, path = "/api/servers/{name}/outgoing_webhooks/{id}", tag = "Webhooks", params(("name" = String, Path, description = "Server name"), ("id" = i64, Path, description = "Outgoing webhook id")), responses((status = 200, description = "Deleted", body = OkResp), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 403, description = "`Missing permission`, or `You are timed out in this server`", body = ApiErrorBody), (status = 404, description = "`Server not found or wrong password`, or `Unknown webhook`", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn delete_outgoing(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path((name, id)): Path<(String, i64)>,
) -> Result<Json<OkResp>, ApiError> {
    let access = manager(&state, &user, &name).await?;
    let db = &state.db;
    let row = managed_outgoing(db, &access, id).await?;
    let hook_name: String = row.try_get(1)?;
    let url: String = row.try_get(2)?;
    let actor = manager_actor(db, &access, &user).await?;
    let mut tx = db.begin().await?;
    sqlx::query("DELETE FROM webhook_deliveries WHERE hook_id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM outgoing_webhooks WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    audit::record(
        &mut tx,
        outgoing_entry(
            access.name(),
            &actor,
            Action::OutgoingDelete,
            id,
            &hook_name,
        )
        .details(Details::new().set("host", host_of(&url))),
    )
    .await?;
    tx.commit().await?;
    Ok(ok())
}

/// Recent deliveries of an outgoing webhook
///
/// The newest 50 deliveries with their status codes, timings and errors (never response
/// bodies). Kept for 7 days, at most 100 per webhook. Requires the Manage webhooks or Manage
/// channels permission. General rate-limit bucket.
#[utoipa::path(get, path = "/api/servers/{name}/outgoing_webhooks/{id}/deliveries", tag = "Webhooks", params(("name" = String, Path, description = "Server name"), ("id" = i64, Path, description = "Outgoing webhook id")), responses((status = 200, description = "Newest first", body = Vec<Delivery>), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 403, description = "`Missing permission`, or `You are timed out in this server`", body = ApiErrorBody), (status = 404, description = "`Server not found or wrong password`, or `Unknown webhook`", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn list_deliveries(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path((name, id)): Path<(String, i64)>,
) -> Result<Json<Vec<Delivery>>, ApiError> {
    let access = manager(&state, &user, &name).await?;
    let db = &state.db;
    managed_outgoing(db, &access, id).await?;
    let rows = sqlx::query("SELECT id, event, status, attempts, last_code, last_ms, last_error, created_at, next_at, finished_at FROM webhook_deliveries WHERE hook_id = $1 ORDER BY id DESC LIMIT 50")
        .bind(id)
        .fetch_all(db)
        .await?;
    let out = rows
        .iter()
        .map(|r| {
            let status: String = r.try_get(2)?;
            Ok(Delivery {
                id: r.try_get(0)?,
                event: r.try_get(1)?,
                attempts: r.try_get(3)?,
                last_code: r.try_get(4)?,
                last_ms: r.try_get(5)?,
                last_error: r.try_get(6)?,
                created_at: r.try_get(7)?,
                next_at: match status.as_str() {
                    "pending" => Some(r.try_get(8)?),
                    _ => None,
                },
                finished_at: r.try_get(9)?,
                status,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()?;
    Ok(Json(out))
}

/// Send a test event
///
/// Queues a `ping` event to the outgoing webhook right away, to check the URL and the
/// signature. Only while the instance allows outgoing webhooks and the webhook is on. Requires
/// the Manage webhooks or Manage channels permission. Strict rate-limit bucket.
#[utoipa::path(post, path = "/api/servers/{name}/outgoing_webhooks/{id}/test", tag = "Webhooks", params(("name" = String, Path, description = "Server name"), ("id" = i64, Path, description = "Outgoing webhook id")), responses((status = 200, description = "Queued", body = OkResp), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 403, description = "`Missing permission`, `You are timed out in this server`, `Outgoing webhooks are turned off on this instance`, or `This webhook is off`", body = ApiErrorBody), (status = 404, description = "`Server not found or wrong password`, or `Unknown webhook`", body = ApiErrorBody), (status = 429, description = "Too many requests", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn test_outgoing(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path((name, id)): Path<(String, i64)>,
) -> Result<Json<OkResp>, ApiError> {
    let access = manager(&state, &user, &name).await?;
    let db = &state.db;
    if !Settings::cached(db).await.outgoing_webhooks {
        return Err(forbidden(
            "Outgoing webhooks are turned off on this instance",
        ));
    }
    let row = managed_outgoing(db, &access, id).await?;
    if row.try_get::<i64, _>(5)? == 0 {
        return Err(forbidden("This webhook is off"));
    }
    queue(
        db,
        id,
        &Fact::Ping {
            server: access.name().to_string(),
            webhook_id: id,
        },
    )
    .await?;
    WAKE.notify_one();
    Ok(ok())
}

static ARMED: AtomicBool = AtomicBool::new(false);
static WAKE: LazyLock<Notify> = LazyLock::new(Notify::new);

/// Whether the hub should hand `ev` to the outgoing webhook queue.
pub fn wanted(ev: &WsEvent) -> bool {
    ARMED.load(Ordering::Relaxed)
        && matches!(
            ev,
            WsEvent::Message {
                server: Some(_),
                ..
            } | WsEvent::MessageUpdated {
                server: Some(_),
                ..
            } | WsEvent::MessageDeleted {
                server: Some(_),
                ..
            } | WsEvent::MessagesDeleted {
                server: Some(_),
                ..
            } | WsEvent::MemberJoined { .. }
                | WsEvent::MemberLeft { .. }
                | WsEvent::MemberKicked { .. }
                | WsEvent::ReactionAdded {
                    server: Some(_),
                    ..
                }
                | WsEvent::ReactionRemoved {
                    server: Some(_),
                    ..
                }
                | WsEvent::PollUpdated {
                    server: Some(_),
                    ..
                }
        )
}

/// Starts the outgoing webhook queue: events this process broadcasts are turned into
/// deliveries. With `deliver`, also the worker that sends due deliveries.
pub fn spawn(state: &AppState, deliver: bool) {
    let (tx, mut rx) = mpsc::channel::<WsEvent>(4096);
    state.hub.set_tap(tx);
    ARMED.store(true, Ordering::Relaxed);
    let events = state.clone();
    tokio::spawn(async move {
        while let Some(ev) = rx.recv().await {
            if let Err(ApiError(_, e)) = enqueue(&events, ev).await {
                tracing::warn!("outgoing webhook event not queued: {e}");
            }
        }
    });
    if deliver {
        let worker = state.clone();
        let pool = Pool::new(CONCURRENCY);
        tokio::spawn(async move {
            loop {
                let _ = tokio::time::timeout(Duration::from_secs(2), WAKE.notified()).await;
                let policy = outbound_policy();
                if let Err(ApiError(_, e)) = dispatch(&worker, &policy, now(), &pool).await {
                    tracing::warn!("outgoing webhook deliveries failed: {e}");
                }
            }
        });
    }
}

/// What happened, by id only: the queue never holds message content. The payload is built
/// from it at each try, as the hook's owner may see it then.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Fact {
    Created {
        server: String,
        id: i64,
        channel_id: Option<i64>,
        thread_root_id: Option<i64>,
    },
    Updated {
        server: String,
        id: i64,
        channel_id: Option<i64>,
        thread_root_id: Option<i64>,
        edited_at: Option<i64>,
    },
    Deleted {
        server: String,
        channel_id: i64,
        thread_root_id: Option<i64>,
        ids: Vec<i64>,
    },
    Joined {
        server: String,
        username: String,
    },
    Left {
        server: String,
        username: String,
        kicked: bool,
        banned: bool,
    },
    Reaction {
        server: String,
        added: bool,
        message_id: i64,
        channel_id: Option<i64>,
        thread_root_id: Option<i64>,
        emoji: String,
        username: String,
        count: i64,
    },
    PollEnded {
        server: String,
        message_id: i64,
        channel_id: Option<i64>,
        thread_root_id: Option<i64>,
    },
    Ping {
        server: String,
        webhook_id: i64,
    },
}

impl Fact {
    fn server(&self) -> &str {
        match self {
            Fact::Created { server, .. }
            | Fact::Updated { server, .. }
            | Fact::Deleted { server, .. }
            | Fact::Joined { server, .. }
            | Fact::Left { server, .. }
            | Fact::Reaction { server, .. }
            | Fact::PollEnded { server, .. }
            | Fact::Ping { server, .. } => server,
        }
    }

    fn event(&self) -> &'static str {
        match self {
            Fact::Created { .. } => "message.created",
            Fact::Updated { .. } => "message.updated",
            Fact::Deleted { .. } => "message.deleted",
            Fact::Joined { .. } => "member.joined",
            Fact::Left { .. } => "member.left",
            Fact::Reaction { added: true, .. } => "reaction.added",
            Fact::Reaction { added: false, .. } => "reaction.removed",
            Fact::PollEnded { .. } => "poll.ended",
            Fact::Ping { .. } => "ping",
        }
    }

    /// The message it is about, with where it was: `(id, channel, thread root)`.
    fn message(&self) -> Option<(i64, Option<i64>, Option<i64>)> {
        match self {
            Fact::Created {
                id,
                channel_id,
                thread_root_id,
                ..
            }
            | Fact::Updated {
                id,
                channel_id,
                thread_root_id,
                ..
            }
            | Fact::Reaction {
                message_id: id,
                channel_id,
                thread_root_id,
                ..
            }
            | Fact::PollEnded {
                message_id: id,
                channel_id,
                thread_root_id,
                ..
            } => Some((*id, *channel_id, *thread_root_id)),
            Fact::Deleted { .. } | Fact::Joined { .. } | Fact::Left { .. } | Fact::Ping { .. } => {
                None
            }
        }
    }
}

/// Edits and poll ends already queued, so repeated events (previews stored after an edit, a
/// closed poll updated again) are sent once. Bounded: the oldest entries go first.
#[derive(Default)]
struct Seen {
    map: HashMap<(i64, bool), Option<i64>>,
    order: std::collections::VecDeque<(i64, bool)>,
}

const SEEN_MAX: usize = 10_000;

impl Seen {
    fn first_time(&mut self, key: (i64, bool), version: Option<i64>) -> bool {
        match self.map.insert(key, version) {
            Some(old) => old != version,
            None => {
                self.order.push_back(key);
                while self.order.len() > SEEN_MAX {
                    if let Some(gone) = self.order.pop_front() {
                        self.map.remove(&gone);
                    }
                }
                true
            }
        }
    }

    fn forget(&mut self, key: (i64, bool)) {
        if self.map.remove(&key).is_some() {
            self.order.retain(|k| *k != key);
        }
    }
}

static SEEN: LazyLock<Mutex<Seen>> = LazyLock::new(Default::default);

fn first_time(id: i64, poll: bool, version: Option<i64>) -> bool {
    match SEEN.lock() {
        Ok(mut seen) => seen.first_time((id, poll), version),
        Err(_) => true,
    }
}

fn fact(ev: WsEvent) -> Option<Fact> {
    match ev {
        WsEvent::Message {
            server: Some(server),
            channel_id,
            message,
            ..
        } if matches!(message.kind.as_str(), "user" | "poll") => Some(Fact::Created {
            server,
            id: message.id,
            channel_id: channel_id.or(message.channel_id),
            thread_root_id: message.thread_root_id,
        }),
        WsEvent::MessageUpdated {
            server: Some(server),
            channel_id,
            update,
            ..
        } => {
            let (id, channel_id, thread_root_id, edited_at) = match update {
                Updated::Stub(stub) => (stub.id, channel_id, stub.thread_root_id, stub.edited_at),
                Updated::Full { message } => (
                    message.id,
                    channel_id.or(message.channel_id),
                    message.thread_root_id,
                    message.edited_at,
                ),
            };
            edited_at.map(|_| Fact::Updated {
                server,
                id,
                channel_id,
                thread_root_id,
                edited_at,
            })
        }
        WsEvent::MessageDeleted {
            server: Some(server),
            channel_id: Some(channel_id),
            id,
            thread_root_id,
            ..
        } => Some(Fact::Deleted {
            server,
            channel_id,
            thread_root_id,
            ids: vec![id],
        }),
        WsEvent::MessagesDeleted {
            server: Some(server),
            channel_id: Some(channel_id),
            thread_root_id,
            ids,
            ..
        } => Some(Fact::Deleted {
            server,
            channel_id,
            thread_root_id,
            ids,
        }),
        WsEvent::MemberJoined { server, member } => Some(Fact::Joined {
            server,
            username: member.user.username,
        }),
        WsEvent::MemberLeft { server, username } => Some(Fact::Left {
            server,
            username,
            kicked: false,
            banned: false,
        }),
        WsEvent::MemberKicked {
            server,
            username,
            banned,
        } => Some(Fact::Left {
            server,
            username,
            kicked: true,
            banned,
        }),
        WsEvent::ReactionAdded {
            server: Some(server),
            channel_id,
            message_id,
            thread_root_id,
            emoji,
            username,
            count,
            ..
        } => Some(Fact::Reaction {
            server,
            added: true,
            message_id,
            channel_id,
            thread_root_id,
            emoji,
            username,
            count,
        }),
        WsEvent::ReactionRemoved {
            server: Some(server),
            channel_id,
            message_id,
            thread_root_id,
            emoji,
            username,
            count,
            ..
        } => Some(Fact::Reaction {
            server,
            added: false,
            message_id,
            channel_id,
            thread_root_id,
            emoji,
            username,
            count,
        }),
        WsEvent::PollUpdated {
            server: Some(server),
            channel_id,
            message_id,
            thread_root_id,
            poll,
            ..
        } => match poll.closed {
            true => Some(Fact::PollEnded {
                server,
                message_id,
                channel_id,
                thread_root_id,
            }),
            false => {
                if let Ok(mut seen) = SEEN.lock() {
                    seen.forget((message_id, true));
                }
                None
            }
        },
        _ => None,
    }
}

/// The message `id` as the hook's owner may read it now (view rights, read-history floor),
/// with link previews and without a filled-in quote.
async fn readable_message(db: &Db, owner: &User, id: i64) -> Result<Option<Message>, ApiError> {
    if allowed(resolve_message(db, id, Some(owner), &Proof::none()).await)?.is_none() {
        return Ok(None);
    }
    load_broadcast(db, id).await
}

/// Whether message `id` still exists (and its author is not being purged).
async fn message_exists(db: &Db, id: i64) -> Result<bool, ApiError> {
    let sql = format!(
        "SELECT 1 FROM messages m WHERE m.id = $1 AND {}",
        crate::db::LIVE_AUTHOR
    );
    Ok(sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_optional(db)
        .await?
        .is_some())
}

/// The owner of an outgoing hook as they count for its payloads: a live account that is a
/// member of the server, with site-admin powers stripped. `None` when they lost access.
async fn hook_owner(db: &Db, server: &str, owner: Option<&str>) -> Result<Option<User>, ApiError> {
    let Some(name) = owner else {
        return Ok(None);
    };
    let Some(user) = get_user(db, name).await? else {
        return Ok(None);
    };
    let user = User {
        is_site_admin: false,
        ..user
    };
    let member = allowed(resolve_server(db, server, Some(&user), &Proof::none()).await)?
        .is_some_and(|a| a.is_member());
    Ok(member.then_some(user))
}

/// The event type and `data` of `fact` for an outgoing hook owned by `owner`, built from what
/// exists now, or `None` when the owner may not see it. A message that is gone is sent as a
/// `message.deleted` event with ids only; an edited one with its current content.
async fn payload(
    db: &Db,
    owner: &User,
    fact: &Fact,
) -> Result<Option<(&'static str, serde_json::Value)>, ApiError> {
    let can_view = async |cid: i64| {
        Ok::<_, ApiError>(
            allowed(resolve_channel(db, cid, Some(owner), &Proof::none()).await)?.is_some(),
        )
    };
    if let Some((id, channel_id, thread_root_id)) = fact.message()
        && !message_exists(db, id).await?
    {
        return Ok(match channel_id {
            Some(cid) if can_view(cid).await? => Some((
                "message.deleted",
                serde_json::json!({
                    "channel_id": cid,
                    "thread_root_id": thread_root_id,
                    "ids": [id],
                }),
            )),
            Some(_) | None => None,
        });
    }
    let event = fact.event();
    let data = match fact {
        Fact::Created { id, .. } | Fact::Updated { id, .. } => readable_message(db, owner, *id)
            .await?
            .map(|m| serde_json::json!({ "message": m })),
        Fact::Deleted {
            channel_id,
            thread_root_id,
            ids,
            ..
        } => match can_view(*channel_id).await? {
            true => Some(serde_json::json!({
                "channel_id": channel_id,
                "thread_root_id": thread_root_id,
                "ids": ids,
            })),
            false => None,
        },
        Fact::Joined { username, .. } => {
            Some(serde_json::json!({ "user": crate::api::user_ref(db, username).await }))
        }
        Fact::Left {
            username,
            kicked,
            banned,
            ..
        } => Some(serde_json::json!({
            "username": username,
            "kicked": kicked,
            "banned": banned,
        })),
        Fact::Reaction {
            message_id,
            emoji,
            username,
            count,
            ..
        } => match allowed(resolve_message(db, *message_id, Some(owner), &Proof::none()).await)? {
            Some(m) => Some(serde_json::json!({
                "message_id": message_id,
                "channel_id": m.scope().channel_id,
                "thread_root_id": m.scope().thread_root_id,
                "emoji": emoji,
                "user": crate::api::user_ref(db, username).await,
                "count": count,
            })),
            None => None,
        },
        Fact::PollEnded { message_id, .. } => readable_message(db, owner, *message_id)
            .await?
            .map(|m| serde_json::json!({ "message": m })),
        Fact::Ping { webhook_id, .. } => Some(serde_json::json!({ "webhook_id": webhook_id })),
    };
    Ok(data.map(|d| (event, d)))
}

/// Queues `fact` for `hook`. Only the fact is stored (ids, never content).
async fn queue(db: &Db, hook: i64, fact: &Fact) -> Result<(), ApiError> {
    let text = serde_json::to_string(fact).map_err(|e| bad(&e.to_string()))?;
    let t = now();
    let (status, payload, error, finished) = match text.len() > PAYLOAD_MAX {
        true => ("failed", None, Some("Payload too large"), Some(t)),
        false => ("pending", Some(text), None, None),
    };
    sqlx::query("INSERT INTO webhook_deliveries(hook_id, event, payload, status, next_at, last_error, created_at, finished_at) SELECT $1, $2, $3, $4, $5, $6, $5, $7 WHERE (SELECT COUNT(*) FROM webhook_deliveries WHERE hook_id = $1 AND status = 'pending') < $8")
        .bind(hook)
        .bind(fact.event())
        .bind(payload)
        .bind(status)
        .bind(t)
        .bind(error)
        .bind(finished)
        .bind(QUEUE_MAX)
        .execute(db)
        .await?;
    Ok(())
}

/// Why a hook was turned off by the instance.
const OFF_FAILURES: &str = "failures";
const OFF_OWNER: &str = "owner";
const OWNER_GONE: &str = "Owner has no access to this server";

/// Turns `hook` off because its owner is no longer a member (or their account is gone).
async fn owner_gone(db: &Db, hook: i64, at: i64) -> Result<(), ApiError> {
    let off = sqlx::query("UPDATE outgoing_webhooks SET enabled = 0, disabled_at = $2, disabled_reason = $3 WHERE id = $1 AND enabled <> 0")
        .bind(hook)
        .bind(at)
        .bind(OFF_OWNER)
        .execute(db)
        .await?
        .rows_affected();
    if off > 0 {
        tracing::info!("outgoing webhook {hook} turned off: its owner has no access");
    }
    Ok(())
}

async fn enqueue(state: &AppState, ev: WsEvent) -> Result<(), ApiError> {
    let Some(fact) = fact(ev) else {
        return Ok(());
    };
    let db = &state.db;
    if !Settings::cached(db).await.outgoing_webhooks {
        return Ok(());
    }
    let rows = sqlx::query(
        "SELECT id, events, creator FROM outgoing_webhooks WHERE server = $1 AND enabled <> 0",
    )
    .bind(fact.server())
    .fetch_all(db)
    .await?;
    let event = fact.event();
    let hooks: Vec<(i64, Option<String>)> = rows
        .iter()
        .filter(|r| {
            r.try_get::<String, _>(1)
                .is_ok_and(|e| e.split_whitespace().any(|x| x == event))
        })
        .map(|r| Ok((r.try_get(0)?, r.try_get(2)?)))
        .collect::<Result<_, sqlx::Error>>()?;
    if hooks.is_empty() {
        return Ok(());
    }
    let fresh = match &fact {
        Fact::Updated { id, edited_at, .. } => first_time(*id, false, *edited_at),
        Fact::PollEnded { message_id, .. } => first_time(*message_id, true, None),
        _ => true,
    };
    if !fresh {
        return Ok(());
    }
    let mut queued = false;
    for (hook, owner) in hooks {
        let Some(user) = hook_owner(db, fact.server(), owner.as_deref()).await? else {
            owner_gone(db, hook, now()).await?;
            continue;
        };
        if payload(db, &user, &fact).await?.is_some() {
            queue(db, hook, &fact).await?;
            queued = true;
        }
    }
    if queued {
        WAKE.notify_one();
    }
    Ok(())
}

/// The result of one try.
#[derive(Clone, Debug, PartialEq)]
pub struct Attempt {
    pub code: Option<u16>,
    pub ms: i64,
    pub error: Option<String>,
}

impl Attempt {
    fn delivered(&self) -> bool {
        self.code.is_some_and(|c| (200..300).contains(&c))
    }
}

/// A refusal as managers see it: an unknown host reads like a refused address, so the
/// refusal texts never tell whether an internal name exists.
fn refusal_text(r: net_guard::Refusal) -> &'static str {
    match r {
        net_guard::Refusal::Lookup => net_guard::Refusal::Address.as_str(),
        other => other.as_str(),
    }
}

/// POSTs `body` to `url` once: the address is checked and pinned for this request, redirects
/// are not followed, and at most `RESPONSE_CAP` bytes of the response are read and dropped,
/// all within the request timeout.
pub async fn send(
    policy: &Policy,
    url: &str,
    secret: &str,
    event: &str,
    delivery: i64,
    body: &[u8],
    at: i64,
) -> Attempt {
    let started = Instant::now();
    let ms = |s: Instant| s.elapsed().as_millis().min(i64::MAX as u128) as i64;
    let fail = |error: &str, s: Instant| Attempt {
        code: None,
        ms: ms(s),
        error: Some(error.to_string()),
    };
    let Ok(parsed) = Url::parse(url) else {
        return fail("Invalid URL", started);
    };
    let checked = match net_guard::check(&parsed, policy).await {
        Ok(c) => c,
        Err(r) => {
            tracing::debug!("outgoing webhook delivery {delivery} refused: {r}");
            return fail(refusal_text(r), started);
        }
    };
    let Ok(client) = checked.client(TIMEOUT, CONNECT_TIMEOUT) else {
        return fail("client error", started);
    };
    let sent = client
        .post(parsed)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::USER_AGENT, USER_AGENT)
        .header("x-webhook-event", event)
        .header("x-webhook-delivery", delivery.to_string())
        .header("x-webhook-timestamp", at.to_string())
        .header("x-webhook-signature", signature(secret, at, body))
        .body(body.to_vec())
        .send()
        .await;
    let mut resp = match sent {
        Ok(r) => r,
        Err(e) if e.is_timeout() => return fail("timed out", started),
        Err(e) if e.is_connect() => return fail("connection failed", started),
        Err(_) => return fail("request failed", started),
    };
    let code = resp.status().as_u16();
    let mut read = 0;
    while read < RESPONSE_CAP {
        match resp.chunk().await {
            Ok(Some(chunk)) => read += chunk.len(),
            Ok(None) | Err(_) => break,
        }
    }
    drop(resp);
    Attempt {
        code: Some(code),
        ms: ms(started),
        error: match code {
            200..=299 => None,
            300..=399 => Some("Redirects are not followed".to_string()),
            _ => Some(format!("HTTP {code}")),
        },
    }
}

/// The JSON body of a delivery.
pub fn envelope(
    delivery: i64,
    hook: i64,
    server: &str,
    event: &str,
    created_at: i64,
    data: &serde_json::Value,
) -> String {
    serde_json::json!({
        "id": delivery,
        "webhook_id": hook,
        "type": event,
        "server": server,
        "created_at": created_at,
        "data": data,
    })
    .to_string()
}

/// Most deliveries in flight at once across all servers.
pub const CONCURRENCY: usize = 16;

/// The worker's slots: a global limit, and the hooks with a request in flight (one each).
pub struct Pool {
    permits: Arc<Semaphore>,
    busy: Arc<Mutex<HashSet<i64>>>,
    turn: AtomicUsize,
}

impl Pool {
    pub fn new(size: usize) -> Pool {
        Pool {
            permits: Arc::new(Semaphore::new(size)),
            busy: Arc::new(Mutex::new(HashSet::new())),
            turn: AtomicUsize::new(0),
        }
    }
}

/// Orders candidates `(hook, delivery, server)` fairly: one hook of each server in turn,
/// starting at server `start` (rotating between rounds), so no server waits behind another.
fn fair(mut rows: Vec<(i64, i64, String)>, start: usize) -> Vec<(i64, i64)> {
    rows.sort_by(|a, b| a.2.cmp(&b.2).then(a.1.cmp(&b.1)));
    let mut servers: Vec<Vec<(i64, i64)>> = Vec::new();
    let mut last: Option<String> = None;
    for (hook, delivery, server) in rows {
        if last.as_deref() != Some(server.as_str()) {
            servers.push(Vec::new());
            last = Some(server);
        }
        if let Some(group) = servers.last_mut() {
            group.push((hook, delivery));
        }
    }
    if servers.is_empty() {
        return Vec::new();
    }
    let shift = start % servers.len();
    servers.rotate_left(shift);
    let deepest = servers.iter().map(Vec::len).max().unwrap_or(0);
    (0..deepest)
        .flat_map(|i| servers.iter().filter_map(move |g| g.get(i).copied()))
        .collect()
}

/// Starts due deliveries: the oldest due one of each hook that has none in flight, servers
/// taken in turn, while slots are free. Each is claimed first, so processes sharing the
/// database never send one twice, nor two of one hook at once. Returns the started tasks,
/// each yielding whether it sent a request.
async fn dispatch(
    state: &AppState,
    policy: &Policy,
    at: i64,
    pool: &Pool,
) -> Result<Vec<tokio::task::JoinHandle<bool>>, ApiError> {
    let db = &state.db;
    if pool.permits.available_permits() == 0 {
        return Ok(Vec::new());
    }
    let rows = sqlx::query("SELECT d.hook_id, MIN(d.id), h.server FROM webhook_deliveries d JOIN outgoing_webhooks h ON h.id = d.hook_id WHERE d.status = 'pending' AND d.next_at <= $1 AND NOT EXISTS (SELECT 1 FROM webhook_deliveries c WHERE c.hook_id = d.hook_id AND c.status = 'pending' AND c.claimed_at >= $2) GROUP BY d.hook_id, h.server")
        .bind(at)
        .bind(at - CLAIM_SECS)
        .fetch_all(db)
        .await?;
    let rows = rows
        .iter()
        .map(|r| Ok((r.try_get(0)?, r.try_get(1)?, r.try_get(2)?)))
        .collect::<Result<Vec<(i64, i64, String)>, sqlx::Error>>()?;
    let start = pool.turn.fetch_add(1, Ordering::Relaxed);
    let mut started = Vec::new();
    for (hook, id) in fair(rows, start) {
        if pool.busy.lock().is_ok_and(|b| b.contains(&hook)) {
            continue;
        }
        let Ok(permit) = pool.permits.clone().try_acquire_owned() else {
            break;
        };
        let claimed = sqlx::query("UPDATE webhook_deliveries SET claimed_at = $1 WHERE id = $2 AND status = 'pending' AND claimed_at < $3 AND NOT EXISTS (SELECT 1 FROM webhook_deliveries c WHERE c.hook_id = $4 AND c.status = 'pending' AND c.claimed_at >= $3)")
            .bind(at)
            .bind(id)
            .bind(at - CLAIM_SECS)
            .bind(hook)
            .execute(db)
            .await?
            .rows_affected();
        if claimed == 0 {
            continue;
        }
        if let Ok(mut busy) = pool.busy.lock() {
            busy.insert(hook);
        }
        let (state, policy, busy) = (state.clone(), policy.clone(), pool.busy.clone());
        started.push(tokio::spawn(async move {
            let sent = match deliver(&state, &policy, id, at).await {
                Ok(sent) => sent,
                Err(ApiError(_, e)) => {
                    tracing::warn!("outgoing webhook delivery {id} failed: {e}");
                    false
                }
            };
            if let Ok(mut busy) = busy.lock() {
                busy.remove(&hook);
            }
            drop(permit);
            WAKE.notify_one();
            sent
        }));
    }
    Ok(started)
}

/// Sends every delivery due at `at` and waits for them, at most `CONCURRENCY` at once and
/// one per hook at a time. Returns how many requests were sent.
pub async fn run_due(state: &AppState, policy: &Policy, at: i64) -> Result<usize, ApiError> {
    let pool = Pool::new(CONCURRENCY);
    let mut done = 0;
    loop {
        let started = dispatch(state, policy, at, &pool).await?;
        if started.is_empty() {
            return Ok(done);
        }
        for task in started {
            if task.await.unwrap_or(false) {
                done += 1;
            }
        }
    }
}

/// One try of the claimed delivery `id`. The owner is checked again and the payload rebuilt
/// from current data first. Returns whether a request was sent.
async fn deliver(state: &AppState, policy: &Policy, id: i64, at: i64) -> Result<bool, ApiError> {
    let db = &state.db;
    let row = sqlx::query("SELECT d.hook_id, d.payload, d.attempts, d.created_at, h.url, h.secret, h.enabled, h.server, h.creator FROM webhook_deliveries d JOIN outgoing_webhooks h ON h.id = d.hook_id WHERE d.id = $1 AND d.status = 'pending'")
        .bind(id)
        .fetch_optional(db)
        .await?;
    let Some(row) = row else {
        return Ok(false);
    };
    let (hook, stored, attempts, created): (i64, Option<String>, i64, i64) = (
        row.try_get(0)?,
        row.try_get(1)?,
        row.try_get(2)?,
        row.try_get(3)?,
    );
    let (url, secret, enabled, server, owner): (String, String, i64, String, Option<String>) = (
        row.try_get(4)?,
        row.try_get(5)?,
        row.try_get(6)?,
        row.try_get(7)?,
        row.try_get(8)?,
    );
    let off = !Settings::cached(db).await.outgoing_webhooks;
    let give_up = async |why: &str| {
        finish(
            db,
            id,
            hook,
            "failed",
            attempts,
            None,
            None,
            Some(why),
            at,
            false,
        )
        .await
    };
    if off || enabled == 0 {
        give_up(match off {
            true => "Outgoing webhooks are turned off on this instance",
            false => "This webhook is off",
        })
        .await?;
        return Ok(false);
    }
    let Some(owner) = hook_owner(db, &server, owner.as_deref()).await? else {
        give_up(OWNER_GONE).await?;
        owner_gone(db, hook, at).await?;
        return Ok(false);
    };
    let Some(fact) = stored.and_then(|s| serde_json::from_str::<Fact>(&s).ok()) else {
        give_up("Unknown event").await?;
        return Ok(false);
    };
    let Some((event, data)) = payload(db, &owner, &fact).await? else {
        give_up("Owner cannot see this").await?;
        return Ok(false);
    };
    let body = envelope(id, hook, &server, event, created, &data);
    if body.len() > PAYLOAD_MAX {
        give_up("Payload too large").await?;
        return Ok(false);
    }
    if event != fact.event() {
        sqlx::query("UPDATE webhook_deliveries SET event = $1 WHERE id = $2")
            .bind(event)
            .bind(id)
            .execute(db)
            .await?;
    }
    let attempt = send(policy, &url, &secret, event, id, body.as_bytes(), now()).await;
    let tries = attempts + 1;
    let code = attempt.code.map(i64::from);
    let err = attempt.error.as_deref();
    match (attempt.delivered(), tries >= ATTEMPTS) {
        (true, _) => {
            finish(
                db,
                id,
                hook,
                "delivered",
                tries,
                code,
                Some(attempt.ms),
                None,
                at,
                false,
            )
            .await?;
        }
        (false, true) => {
            finish(
                db,
                id,
                hook,
                "failed",
                tries,
                code,
                Some(attempt.ms),
                err,
                at,
                true,
            )
            .await?;
        }
        (false, false) => {
            let wait = BACKOFF[(tries as usize - 1).min(BACKOFF.len() - 1)];
            sqlx::query("UPDATE webhook_deliveries SET attempts = $1, last_code = $2, last_ms = $3, last_error = $4, next_at = $5, claimed_at = 0 WHERE id = $6")
                .bind(tries)
                .bind(code)
                .bind(attempt.ms)
                .bind(err)
                .bind(at + wait)
                .bind(id)
                .execute(db)
                .await?;
        }
    }
    Ok(true)
}

#[allow(clippy::too_many_arguments)]
async fn finish(
    db: &Db,
    id: i64,
    hook: i64,
    status: &str,
    attempts: i64,
    code: Option<i64>,
    ms: Option<i64>,
    error: Option<&str>,
    at: i64,
    counts: bool,
) -> Result<(), ApiError> {
    sqlx::query("UPDATE webhook_deliveries SET status = $1, attempts = $2, last_code = COALESCE($3, last_code), last_ms = COALESCE($4, last_ms), last_error = $5, payload = NULL, finished_at = $6 WHERE id = $7")
        .bind(status)
        .bind(attempts)
        .bind(code)
        .bind(ms)
        .bind(error)
        .bind(at)
        .bind(id)
        .execute(db)
        .await?;
    match (status, counts) {
        ("delivered", _) => {
            sqlx::query("UPDATE outgoing_webhooks SET failures = 0 WHERE id = $1")
                .bind(hook)
                .execute(db)
                .await?;
        }
        (_, true) => {
            let off = sqlx::query("UPDATE outgoing_webhooks SET failures = failures + 1, enabled = CASE WHEN failures + 1 >= $2 THEN 0 ELSE enabled END, disabled_at = CASE WHEN failures + 1 >= $2 AND enabled <> 0 THEN $3 ELSE disabled_at END, disabled_reason = CASE WHEN failures + 1 >= $2 AND enabled <> 0 THEN $4 ELSE disabled_reason END WHERE id = $1 RETURNING enabled")
                .bind(hook)
                .bind(DISABLE_AFTER)
                .bind(at)
                .bind(OFF_FAILURES)
                .fetch_optional(db)
                .await?;
            if off.is_some_and(|r| r.try_get::<i64, _>(0).is_ok_and(|e| e == 0)) {
                tracing::info!(
                    "outgoing webhook {hook} turned off after {DISABLE_AFTER} failed deliveries"
                );
            }
        }
        (_, false) => {}
    }
    sqlx::query("DELETE FROM webhook_deliveries WHERE hook_id = $1 AND status <> 'pending' AND id NOT IN (SELECT id FROM webhook_deliveries WHERE hook_id = $1 ORDER BY id DESC LIMIT $2)")
        .bind(hook)
        .bind(LOG_KEEP)
        .execute(db)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use serde_json::{Value, json};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;
    use crate::api::test_util::{add_member, done, mem_user, temp_state};

    async fn exec(db: &Db, sql: &str) {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .execute(db)
            .await
            .expect(sql);
    }

    async fn int(db: &Db, sql: &str) -> i64 {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .fetch_one(db)
            .await
            .expect(sql)
            .try_get(0)
            .expect("int")
    }

    async fn add_user(db: &Db, name: &str, display: &str) {
        sqlx::query("INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, created_at) VALUES($1, $2, '', 'text', 'identicon', 1)")
            .bind(name)
            .bind(display)
            .execute(db)
            .await
            .expect("user");
    }

    async fn general(db: &Db) -> i64 {
        int(
            db,
            "SELECT id FROM channels WHERE server = 'rchat' AND name = 'general'",
        )
        .await
    }

    /// `owner` (admin, every permission), `plain` (member, no permission), `outsider`.
    async fn setup(tag: &str) -> (AppState, std::path::PathBuf, i64) {
        let (state, path) = temp_state(tag).await;
        let db = &state.db;
        for (name, display) in [
            ("owner", "Owner"),
            ("plain", "Alice B"),
            ("outsider", "Out"),
        ] {
            add_user(db, name, display).await;
        }
        add_member(db, "rchat", "owner", 1, 0, 1).await;
        add_member(db, "rchat", "plain", 0, 0, 1).await;
        exec(
            db,
            "UPDATE settings SET value = '0' WHERE key = 'profanity_filter'",
        )
        .await;
        Settings::forget(db);
        let cid = general(db).await;
        (state, path, cid)
    }

    async fn create(
        state: &AppState,
        who: &str,
        cid: i64,
        name: &str,
    ) -> Result<WebhookSecret, ApiError> {
        create_webhook(
            State(state.clone()),
            Authed(mem_user(who, false)),
            Path("rchat".to_string()),
            Json(NewWebhook {
                channel_id: cid,
                name: name.to_string(),
                avatar_kind: None,
                avatar_color: None,
            }),
        )
        .await
        .map(|Json(h)| h)
    }

    async fn run(
        state: &AppState,
        id: &str,
        token: &str,
        body: Value,
    ) -> Result<Message, ApiError> {
        let req = Request::builder()
            .method("POST")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .expect("request");
        let resp = execute(
            State(state.clone()),
            Path((id.to_string(), token.to_string())),
            Query(ExecuteQuery { wait: true }),
            req,
        )
        .await?;
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("body");
        Ok(serde_json::from_slice(&bytes).expect("message"))
    }

    fn code(r: Result<impl Sized, ApiError>) -> (StatusCode, String) {
        match r {
            Ok(_) => (StatusCode::OK, String::new()),
            Err(ApiError(s, m)) => (s, m),
        }
    }

    #[test]
    fn tokens_are_long_random_and_stored_keyed() {
        let a = new_token();
        let b = new_token();
        assert_ne!(a, b);
        assert_eq!(URL_SAFE_NO_PAD.decode(&a).expect("base64").len(), 32);
        let h1 = token_hash(b"pepper-one", &a);
        assert!(h1.starts_with("k:"));
        assert!(!h1.contains(&a));
        assert_ne!(h1, token_hash(b"pepper-two", &a), "keyed by the pepper");
        assert_eq!(h1, token_hash(b"pepper-one", &a));
        assert!(same(b"abc", b"abc"));
        assert!(!same(b"abc", b"abd"));
        assert!(!same(b"abc", b"abcd"));
    }

    #[test]
    fn signatures_match_a_reference_hmac() {
        assert_eq!(
            signature("whsec_test", 1_700_000_000, br#"{"a":1}"#),
            "sha256=38877139021993b830af32feea6e18a8da83eb2f6e49ee50bd9e4cf4ca4d3789"
        );
    }

    #[test]
    fn author_keys_never_name_accounts() {
        assert_eq!(author_key(7), "@webhook:7");
        assert_eq!(hook_of("@webhook:7"), Some(7));
        assert_eq!(hook_of("webhook:7"), None);
        assert_eq!(hook_of("alice"), None);
        let r = author_ref(7, Some("CI"), Some("#AABBCC"));
        assert_eq!(r.display_name, "CI");
        assert_eq!(r.avatar_kind, AvatarKind::Color);
        assert_eq!(r.avatar_color.as_deref(), Some("#aabbcc"));
        assert_eq!(
            author_ref(7, None, Some("identicon")).avatar_kind,
            AvatarKind::Identicon
        );
    }

    #[tokio::test]
    async fn managers_create_hooks_with_limits_and_honest_names() {
        let (state, path, cid) = setup("wh_create").await;
        let db = &state.db;
        let made = create(&state, "owner", cid, "Deploys")
            .await
            .expect("create");
        assert_eq!(
            made.path,
            format!("/api/webhooks/{}/{}", made.webhook.id, made.token)
        );
        assert!(made.webhook.mentions, "the owner may mention everyone");
        let stored: String = sqlx::query("SELECT token_hash FROM webhooks WHERE id = $1")
            .bind(made.webhook.id)
            .fetch_one(db)
            .await
            .expect("row")
            .try_get(0)
            .expect("hash");
        assert!(!stored.contains(&made.token), "only a keyed hash is stored");
        assert_eq!(
            int(
                db,
                "SELECT COUNT(*) FROM audit_log WHERE action = 'webhook.create'"
            )
            .await,
            1
        );
        let Json(list) = list_webhooks(
            State(state.clone()),
            Authed(mem_user("owner", false)),
            Path("rchat".to_string()),
        )
        .await
        .expect("list");
        assert_eq!(list.len(), 1);
        assert!(
            !serde_json::to_string(&list)
                .expect("json")
                .contains(&made.token)
        );
        assert_eq!(
            code(create(&state, "plain", cid, "Mine").await).0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            code(create(&state, "outsider", cid, "Mine").await),
            (
                StatusCode::NOT_FOUND,
                crate::api::access::DENIED.to_string()
            )
        );
        for name in ["owner", "OWNER", "alice b", "Instance Staff", " ", ""] {
            assert_eq!(
                code(create(&state, "owner", cid, name).await).0,
                StatusCode::BAD_REQUEST,
                "{name}"
            );
        }
        assert!(
            code(create(&state, "owner", cid, "Alice B").await)
                .1
                .contains("belongs to someone")
        );
        for i in 1..CHANNEL_MAX {
            create(&state, "owner", cid, &format!("Hook {i}"))
                .await
                .expect("fill");
        }
        assert_eq!(
            code(create(&state, "owner", cid, "One more").await).0,
            StatusCode::BAD_REQUEST
        );
        let voice: i64 = sqlx::query("INSERT INTO channels(server, name, kind, created_at) VALUES('rchat', 'talk', 'voice', 1) RETURNING id")
            .fetch_one(db)
            .await
            .expect("voice")
            .try_get(0)
            .expect("id");
        assert_eq!(
            code(create(&state, "owner", voice, "Voice").await).0,
            StatusCode::BAD_REQUEST
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn execute_checks_tokens_and_validates_like_users() {
        let (state, path, cid) = setup("wh_execute").await;
        let db = &state.db;
        let made = create(&state, "owner", cid, "Deploys")
            .await
            .expect("create");
        let id = made.webhook.id.to_string();
        let posted = run(&state, &id, &made.token, json!({"content": "build ok"}))
            .await
            .expect("post");
        assert_eq!(posted.author.username, author_key(made.webhook.id));
        assert_eq!(posted.author.display_name, "Deploys");
        assert_eq!(posted.webhook.as_ref().map(|w| w.id), Some(made.webhook.id));
        let loaded = load_message(db, posted.id, Quotes::Skip)
            .await
            .expect("load")
            .expect("message");
        assert_eq!(loaded.author.display_name, "Deploys");
        let wrong = [
            (id.clone(), "x".repeat(43)),
            ("999999".to_string(), made.token.clone()),
            ("abc".to_string(), made.token.clone()),
            ("-1".to_string(), made.token.clone()),
        ];
        for (i, t) in wrong {
            assert_eq!(
                code(run(&state, &i, &t, json!({"content": "x"})).await),
                (StatusCode::NOT_FOUND, UNKNOWN.to_string()),
                "{i}"
            );
        }
        let cases = [
            json!({"content": ""}),
            json!({"content": "x".repeat(MESSAGE_MAX + 1)}),
            json!({"content": "x", "username": "owner"}),
            json!({"content": "x", "avatar": "red"}),
            json!({"embeds": [{}]}),
            json!({"embeds": [{"title": "t", "url": "javascript:alert(1)"}]}),
            json!({"embeds": [{"title": "t", "color": 16777216}]}),
            json!({"embeds": [{"description": "x".repeat(4097)}]}),
            json!({"embeds": (0..11).map(|_| json!({"title": "t"})).collect::<Vec<_>>()}),
            json!({"embeds": [{"fields": [{"name": "", "value": "v"}]}]}),
            json!({"content": "x", "thread_id": 999_999}),
            json!({"content": "x", "reply_to": 999_999}),
        ];
        for body in cases {
            HOOK_PACE.forget_prefix(&format!("{}\n", crate::db::pool_key(db)));
            assert_eq!(
                code(run(&state, &id, &made.token, body.clone()).await).0,
                StatusCode::BAD_REQUEST,
                "{body}"
            );
        }
        HOOK_PACE.forget_prefix(&format!("{}\n", crate::db::pool_key(db)));
        let card = run(
            &state,
            &id,
            &made.token,
            json!({"username": "Nightly", "avatar": "#112233", "embeds": [{"title": "Report", "url": "https://example.com/r", "color": 255, "fields": [{"name": "Passed", "value": "120", "inline": true}], "footer": {"text": "ci"}}]}),
        )
        .await
        .expect("embed only");
        assert_eq!(card.author.display_name, "Nightly");
        assert_eq!(card.author.avatar_color.as_deref(), Some("#112233"));
        assert_eq!(card.webhook.as_ref().map(|w| w.embeds.len()), Some(1));
        let thread = run(
            &state,
            &id,
            &made.token,
            json!({"content": "in thread", "thread_id": posted.id, "reply_to": posted.id}),
        )
        .await
        .expect("thread");
        assert_eq!(thread.thread_root_id, Some(posted.id));
        assert!(thread.reply_to.is_some());
        exec(
            db,
            "UPDATE settings SET value = '1' WHERE key = 'profanity_filter'",
        )
        .await;
        Settings::forget(db);
        HOOK_PACE.forget_prefix(&format!("{}\n", crate::db::pool_key(db)));
        assert_eq!(
            code(run(&state, &id, &made.token, json!({"content": "fuck"})).await).0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            code(
                run(
                    &state,
                    &id,
                    &made.token,
                    json!({"embeds": [{"title": "shit"}]})
                )
                .await
            )
            .0,
            StatusCode::BAD_REQUEST
        );
        exec(db, "UPDATE channels SET slowmode_seconds = 60").await;
        HOOK_PACE.forget_prefix(&format!("{}\n", crate::db::pool_key(db)));
        assert_eq!(
            code(run(&state, &id, &made.token, json!({"content": "again"})).await).0,
            StatusCode::TOO_MANY_REQUESTS,
            "slow mode applies to webhooks"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn multipart_files_follow_the_upload_switch() {
        let (state, path, cid) = setup("wh_multipart").await;
        let db = &state.db;
        let made = create(&state, "owner", cid, "Files").await.expect("create");
        let send = |state: AppState, id: String, token: String| async move {
            let boundary = "XyZ";
            let body = format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"payload_json\"\r\n\r\n{{\"content\": \"report attached\"}}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"report.txt\"\r\nContent-Type: text/plain\r\n\r\nall good\r\n--{boundary}--\r\n"
            );
            let req = Request::builder()
                .method("POST")
                .header(
                    header::CONTENT_TYPE,
                    format!("multipart/form-data; boundary={boundary}"),
                )
                .body(Body::from(body))
                .expect("request");
            let resp = execute(
                State(state),
                Path((id, token)),
                Query(ExecuteQuery { wait: true }),
                req,
            )
            .await?;
            let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
                .await
                .expect("body");
            Ok::<Message, ApiError>(serde_json::from_slice(&bytes).expect("message"))
        };
        let id = made.webhook.id.to_string();
        let posted = send(state.clone(), id.clone(), made.token.clone())
            .await
            .expect("upload");
        assert_eq!(posted.content, "report attached");
        assert_eq!(
            posted.media.as_ref().map(|m| m.filename.as_str()),
            Some("report.txt")
        );
        exec(
            db,
            "INSERT INTO settings(key, value) VALUES('asset_uploads', '0') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .await;
        Settings::forget(db);
        HOOK_PACE.forget_prefix(&format!("{}\n", crate::db::pool_key(db)));
        assert_eq!(
            code(send(state.clone(), id, made.token.clone()).await).0,
            StatusCode::FORBIDDEN
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn webhooks_are_paced_per_hook() {
        let (state, path, cid) = setup("wh_pace").await;
        let made = create(&state, "owner", cid, "Spam").await.expect("create");
        let id = made.webhook.id.to_string();
        let mut limited = false;
        for i in 0..(HOOK_BURST + 1) {
            if let Err(ApiError(StatusCode::TOO_MANY_REQUESTS, _)) = run(
                &state,
                &id,
                &made.token,
                json!({"content": format!("n{i}")}),
            )
            .await
            {
                limited = true;
            }
        }
        assert!(limited);
        done(state, path).await;
    }

    #[tokio::test]
    async fn group_mentions_need_allowed_mentions_and_the_creators_permission() {
        let (state, path, cid) = setup("wh_mentions").await;
        let db = &state.db;
        let made = create(&state, "owner", cid, "Alerts")
            .await
            .expect("create");
        let id = made.webhook.id.to_string();
        let send = |body: Value| {
            let state = state.clone();
            let id = id.clone();
            let token = made.token.clone();
            async move {
                HOOK_PACE.forget_prefix(&format!("{}\n", crate::db::pool_key(db)));
                run(&state, &id, &token, body).await.expect("post")
            }
        };
        assert!(
            send(json!({"content": "@everyone hi"}))
                .await
                .group_mentions
                .is_empty()
        );
        assert_eq!(
            send(json!({"content": "@everyone hi", "allowed_mentions": {"parse": ["everyone"]}}))
                .await
                .group_mentions
                .len(),
            1
        );
        exec(db, "UPDATE members SET perms = 1 WHERE username = 'owner'").await;
        assert!(
            send(json!({"content": "@everyone hi", "allowed_mentions": {"parse": ["everyone"]}}))
                .await
                .group_mentions
                .is_empty(),
            "re-checked at send time"
        );
        exec(db, "UPDATE members SET perms = 0 WHERE username = 'owner'").await;
        exec(db, "UPDATE webhooks SET creator_mentions = 0").await;
        assert!(
            send(json!({"content": "@here", "allowed_mentions": {"parse": ["everyone"]}}))
                .await
                .group_mentions
                .is_empty(),
            "needs the permission at creation too"
        );
        exec(db, "INSERT INTO roles(server, name, color, perms, mentionable) VALUES('rchat', 'oncall', '#ffffff', 0, 1)").await;
        let role = int(db, "SELECT id FROM roles WHERE name = 'oncall'").await;
        assert!(
            send(json!({"content": "@oncall", "allowed_mentions": {}}))
                .await
                .group_mentions
                .is_empty()
        );
        assert_eq!(
            send(json!({"content": "@oncall", "allowed_mentions": {"roles": [role]}}))
                .await
                .group_mentions
                .len(),
            1,
            "mentionable roles when asked"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn hooks_edit_and_delete_only_their_own_messages() {
        let (state, path, cid) = setup("wh_own").await;
        let db = &state.db;
        let a = create(&state, "owner", cid, "A").await.expect("a");
        let b = create(&state, "owner", cid, "B").await.expect("b");
        let mine = run(
            &state,
            &a.webhook.id.to_string(),
            &a.token,
            json!({"content": "one"}),
        )
        .await
        .expect("post");
        let user_msg: i64 = sqlx::query("INSERT INTO messages(channel_id, author, content, created_at) VALUES($1, 'owner', 'hi', 1) RETURNING id")
            .bind(cid)
            .fetch_one(db)
            .await
            .expect("user msg")
            .try_get(0)
            .expect("id");
        let edit = |id: String, token: String, mid: i64, content: &str| {
            let state = state.clone();
            let content = content.to_string();
            async move {
                HOOK_PACE.forget_prefix(&format!("{}\n", crate::db::pool_key(db)));
                edit_hook_message(
                    State(state),
                    Path((id, token, mid.to_string())),
                    Json(WebhookEdit {
                        content: Some(content),
                        embeds: None,
                    }),
                )
                .await
            }
        };
        assert_eq!(
            code(edit(b.webhook.id.to_string(), b.token.clone(), mine.id, "x").await),
            (StatusCode::NOT_FOUND, UNKNOWN_MESSAGE.to_string())
        );
        assert_eq!(
            code(edit(a.webhook.id.to_string(), a.token.clone(), user_msg, "x").await),
            (StatusCode::NOT_FOUND, UNKNOWN_MESSAGE.to_string())
        );
        assert_eq!(
            code(edit(a.webhook.id.to_string(), b.token.clone(), mine.id, "x").await).1,
            UNKNOWN
        );
        let Json(edited) = edit(a.webhook.id.to_string(), a.token.clone(), mine.id, "two")
            .await
            .expect("edit");
        assert_eq!(edited.content, "two");
        assert!(edited.edited_at.is_some());
        HOOK_PACE.forget_prefix(&format!("{}\n", crate::db::pool_key(db)));
        assert_eq!(
            code(
                delete_hook_message(
                    State(state.clone()),
                    Path((
                        b.webhook.id.to_string(),
                        b.token.clone(),
                        mine.id.to_string()
                    )),
                )
                .await
            )
            .0,
            StatusCode::NOT_FOUND
        );
        HOOK_PACE.forget_prefix(&format!("{}\n", crate::db::pool_key(db)));
        delete_hook_message(
            State(state.clone()),
            Path((
                a.webhook.id.to_string(),
                a.token.clone(),
                mine.id.to_string(),
            )),
        )
        .await
        .expect("delete");
        assert_eq!(
            int(
                db,
                &format!("SELECT COUNT(*) FROM messages WHERE id = {}", mine.id)
            )
            .await,
            0
        );
        let Json(reset) = reset_token(
            State(state.clone()),
            Authed(mem_user("owner", false)),
            Path(("rchat".to_string(), a.webhook.id)),
        )
        .await
        .expect("reset");
        HOOK_PACE.forget_prefix(&format!("{}\n", crate::db::pool_key(db)));
        assert_eq!(
            code(
                run(
                    &state,
                    &a.webhook.id.to_string(),
                    &a.token,
                    json!({"content": "old"})
                )
                .await
            )
            .0,
            StatusCode::NOT_FOUND,
            "the old token stops working"
        );
        HOOK_PACE.forget_prefix(&format!("{}\n", crate::db::pool_key(db)));
        run(
            &state,
            &a.webhook.id.to_string(),
            &reset.token,
            json!({"content": "new"}),
        )
        .await
        .expect("new token");
        let Json(_) = delete_webhook(
            State(state.clone()),
            Authed(mem_user("owner", false)),
            Path(("rchat".to_string(), a.webhook.id)),
        )
        .await
        .expect("delete hook");
        HOOK_PACE.forget_prefix(&format!("{}\n", crate::db::pool_key(db)));
        assert_eq!(
            code(
                run(
                    &state,
                    &a.webhook.id.to_string(),
                    &reset.token,
                    json!({"content": "gone"})
                )
                .await
            ),
            (StatusCode::NOT_FOUND, UNKNOWN.to_string())
        );
        assert_eq!(
            int(db, "SELECT COUNT(*) FROM messages WHERE content = 'new'").await,
            1,
            "messages stay after the hook is deleted"
        );
        done(state, path).await;
    }

    /// A tiny HTTP receiver: answers each request with the next status in `codes` and returns
    /// what it saw (headers lowercase, body).
    async fn receiver(
        codes: Vec<u16>,
    ) -> (
        u16,
        tokio::task::JoinHandle<Vec<(HashMap<String, String>, String)>>,
    ) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let task = tokio::spawn(async move {
            let mut seen = Vec::new();
            for status in codes {
                let (mut sock, _) = listener.accept().await.expect("accept");
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                let (head, body) = loop {
                    let n = sock.read(&mut chunk).await.expect("read");
                    buf.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&buf).to_string();
                    if let Some(at) = text.find("\r\n\r\n") {
                        let head = text[..at].to_string();
                        let len: usize = head
                            .lines()
                            .find_map(|l| {
                                l.to_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse().unwrap_or(0))
                            })
                            .unwrap_or(0);
                        while buf.len() < at + 4 + len {
                            let n = sock.read(&mut chunk).await.expect("read body");
                            buf.extend_from_slice(&chunk[..n]);
                        }
                        break (
                            head,
                            String::from_utf8_lossy(&buf[at + 4..at + 4 + len]).to_string(),
                        );
                    }
                };
                let headers = head
                    .lines()
                    .skip(1)
                    .filter_map(|l| l.split_once(':'))
                    .map(|(k, v)| (k.trim().to_lowercase(), v.trim().to_string()))
                    .collect();
                seen.push((headers, body));
                let reply = format!(
                    "HTTP/1.1 {status} X\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok"
                );
                sock.write_all(reply.as_bytes()).await.expect("write");
            }
            seen
        });
        (port, task)
    }

    fn local_policy() -> Policy {
        Outbound::parse("127.0.0.1", true, Vec::new(), Vec::new())
            .expect("outbound")
            .policy()
    }

    fn ping(hook: i64) -> Fact {
        Fact::Ping {
            server: "rchat".to_string(),
            webhook_id: hook,
        }
    }

    async fn outgoing_hook(db: &Db, url: &str, events: &str, creator: &str) -> i64 {
        sqlx::query("INSERT INTO outgoing_webhooks(server, name, url, events, secret, creator, created_at) VALUES('rchat', 'Out', $1, $2, 'whsec_test', $3, 1) RETURNING id")
            .bind(url)
            .bind(events)
            .bind(creator)
            .fetch_one(db)
            .await
            .expect("hook")
            .try_get(0)
            .expect("id")
    }

    #[tokio::test]
    async fn deliveries_are_signed_retried_and_turn_off_after_failures() {
        let (state, path, _) = setup("wh_deliver").await;
        let db = &state.db;
        exec(
            db,
            "UPDATE settings SET value = '1' WHERE key = 'outgoing_webhooks'",
        )
        .await;
        Settings::forget(db);
        let (port, seen) = receiver(vec![500, 302, 200]).await;
        let hook = outgoing_hook(
            db,
            &format!("http://127.0.0.1:{port}/in"),
            "message.created",
            "owner",
        )
        .await;
        queue(db, hook, &ping(hook)).await.expect("queue");
        let policy = local_policy();
        let t = now();
        assert_eq!(run_due(&state, &policy, t).await.expect("first"), 1);
        assert_eq!(run_due(&state, &policy, t).await.expect("not due yet"), 0);
        let (status, attempts, next_at, last_code): (String, i64, i64, Option<i64>) = {
            let r =
                sqlx::query("SELECT status, attempts, next_at, last_code FROM webhook_deliveries")
                    .fetch_one(db)
                    .await
                    .expect("row");
            (
                r.try_get(0).expect("s"),
                r.try_get(1).expect("a"),
                r.try_get(2).expect("n"),
                r.try_get(3).expect("c"),
            )
        };
        assert_eq!(
            (status.as_str(), attempts, last_code),
            ("pending", 1, Some(500))
        );
        assert_eq!(next_at, t + BACKOFF[0]);
        assert_eq!(run_due(&state, &policy, next_at).await.expect("second"), 1);
        assert_eq!(
            int(db, "SELECT last_code FROM webhook_deliveries").await,
            302,
            "redirects count as failures"
        );
        let next: i64 = int(db, "SELECT next_at FROM webhook_deliveries").await;
        assert_eq!(next, next_at + BACKOFF[1]);
        assert_eq!(run_due(&state, &policy, next).await.expect("third"), 1);
        let r = sqlx::query("SELECT status, attempts, payload, last_ms FROM webhook_deliveries")
            .fetch_one(db)
            .await
            .expect("row");
        assert_eq!(r.try_get::<String, _>(0).expect("s"), "delivered");
        assert_eq!(r.try_get::<i64, _>(1).expect("a"), 3);
        assert!(
            r.try_get::<Option<String>, _>(2).expect("p").is_none(),
            "payload dropped once done"
        );
        assert!(r.try_get::<Option<i64>, _>(3).expect("ms").is_some());
        let seen = seen.await.expect("receiver");
        assert_eq!(seen.len(), 3);
        for (headers, body) in &seen {
            let ts: i64 = headers["x-webhook-timestamp"].parse().expect("ts");
            assert_eq!(
                headers["x-webhook-signature"],
                signature("whsec_test", ts, body.as_bytes())
            );
            assert_eq!(headers["user-agent"], USER_AGENT);
            assert_eq!(headers["x-webhook-event"], "ping");
            let v: Value = serde_json::from_str(body).expect("json");
            assert_eq!(v["type"], "ping");
            assert_eq!(v["webhook_id"], hook);
        }
        exec(
            db,
            &format!(
                "UPDATE outgoing_webhooks SET failures = {} WHERE id = {hook}",
                DISABLE_AFTER - 1
            ),
        )
        .await;
        exec(
            db,
            &format!(
                "UPDATE outgoing_webhooks SET url = 'https://127.0.0.2:1/x' WHERE id = {hook}"
            ),
        )
        .await;
        queue(db, hook, &ping(hook)).await.expect("queue");
        let strict = Outbound::default().policy();
        let mut at = now();
        for _ in 0..ATTEMPTS {
            run_due(&state, &strict, at).await.expect("try");
            at += 3600;
        }
        let r = sqlx::query("SELECT status, last_error FROM webhook_deliveries ORDER BY id DESC")
            .fetch_one(db)
            .await
            .expect("row");
        assert_eq!(r.try_get::<String, _>(0).expect("s"), "failed");
        assert_eq!(
            r.try_get::<Option<String>, _>(1).expect("e").as_deref(),
            Some("Address not allowed")
        );
        assert_eq!(
            int(
                db,
                &format!("SELECT enabled FROM outgoing_webhooks WHERE id = {hook}")
            )
            .await,
            0
        );
        assert!(
            int(
                db,
                &format!(
                    "SELECT COALESCE(disabled_at, 0) FROM outgoing_webhooks WHERE id = {hook}"
                )
            )
            .await
                > 0
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn payloads_follow_the_creators_view_and_the_switch() {
        let (state, path, cid) = setup("wh_payload").await;
        let db = &state.db;
        let hook = outgoing_hook(
            db,
            "https://example.com/in",
            "message.created member.joined",
            "plain",
        )
        .await;
        let secret: i64 = sqlx::query("INSERT INTO channels(server, name, restrict_view, created_at) VALUES('rchat', 'staff', 1, 1) RETURNING id")
            .fetch_one(db)
            .await
            .expect("private")
            .try_get(0)
            .expect("id");
        let post = |channel: i64, text: &str| {
            let text = text.to_string();
            async move {
                sqlx::query("INSERT INTO messages(channel_id, author, content, created_at) VALUES($1, 'owner', $2, $3) RETURNING id")
                    .bind(channel)
                    .bind(text)
                    .bind(now())
                    .fetch_one(db)
                    .await
                    .expect("msg")
                    .try_get::<i64, _>(0)
                    .expect("id")
            }
        };
        let event = |id: i64| async move {
            WsEvent::Message {
                server: Some("rchat".to_string()),
                channel_id: Some(cid),
                dm_id: None,
                dm_users: None,
                message: Box::new(
                    load_message(db, id, Quotes::Skip)
                        .await
                        .expect("load")
                        .expect("message"),
                ),
            }
        };
        let open = post(cid, "visible").await;
        enqueue(&state, event(open).await).await.expect("off");
        assert_eq!(
            int(db, "SELECT COUNT(*) FROM webhook_deliveries").await,
            0,
            "switch off"
        );
        exec(
            db,
            "UPDATE settings SET value = '1' WHERE key = 'outgoing_webhooks'",
        )
        .await;
        Settings::forget(db);
        enqueue(&state, event(open).await).await.expect("on");
        let hidden = post(secret, "secret plans").await;
        enqueue(&state, event(hidden).await).await.expect("hidden");
        let rows = sqlx::query("SELECT payload FROM webhook_deliveries WHERE hook_id = $1")
            .bind(hook)
            .fetch_all(db)
            .await
            .expect("rows");
        assert_eq!(rows.len(), 1, "only what the creator can view");
        let payload: String = rows[0].try_get(0).expect("payload");
        let fact: Fact = serde_json::from_str(&payload).expect("fact");
        assert!(matches!(fact, Fact::Created { id, .. } if id == open));
        assert!(!payload.contains("visible"), "ids only, never content");
        exec(db, "DELETE FROM members WHERE username = 'plain'").await;
        enqueue(&state, event(open).await).await.expect("left");
        assert_eq!(
            int(db, "SELECT COUNT(*) FROM webhook_deliveries").await,
            1,
            "creator left: nothing"
        );
        assert_eq!(
            int(
                db,
                &format!("SELECT enabled FROM outgoing_webhooks WHERE id = {hook}")
            )
            .await,
            0,
            "and the hook turns off"
        );
        done(state, path).await;
    }

    async fn post_msg(db: &Db, channel: i64, text: &str) -> i64 {
        sqlx::query("INSERT INTO messages(channel_id, author, content, created_at) VALUES($1, 'owner', $2, $3) RETURNING id")
            .bind(channel)
            .bind(text)
            .bind(now())
            .fetch_one(db)
            .await
            .expect("msg")
            .try_get(0)
            .expect("id")
    }

    async fn created(db: &Db, cid: i64, id: i64) -> WsEvent {
        WsEvent::Message {
            server: Some("rchat".to_string()),
            channel_id: Some(cid),
            dm_id: None,
            dm_users: None,
            message: Box::new(
                load_message(db, id, Quotes::Skip)
                    .await
                    .expect("load")
                    .expect("message"),
            ),
        }
    }

    async fn switch_on(db: &Db) {
        exec(
            db,
            "UPDATE settings SET value = '1' WHERE key = 'outgoing_webhooks'",
        )
        .await;
        Settings::forget(db);
    }

    async fn text(db: &Db, sql: &str) -> Option<String> {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .fetch_one(db)
            .await
            .expect(sql)
            .try_get(0)
            .expect("text")
    }

    /// `moder` holds only Manage webhooks; `root` is a site admin who is not a member.
    async fn add_moder(db: &Db) {
        add_user(db, "moder", "Moder").await;
        add_user(db, "root", "Root").await;
        add_member(db, "rchat", "moder", 0, 0, 1).await;
        exec(
            db,
            &format!(
                "INSERT INTO roles(server, name, color, perms, mentionable) VALUES('rchat', 'hooks', '#ffffff', {}, 0)",
                Perm::ManageWebhooks as i64
            ),
        )
        .await;
        exec(db, "INSERT INTO user_roles(server, username, role_id) SELECT 'rchat', 'moder', id FROM roles WHERE name = 'hooks'").await;
    }

    #[test]
    fn name_keys_see_through_lookalikes() {
        for (a, b) in [
            ("ＡＬＩＣＥ", "alice"),
            ("\u{430}lice", "alice"),
            ("Instance\u{a0}staff", "instance staff"),
            ("Instance   Staff", "instance staff"),
            ("ÉLODIE", "élodie"),
            ("E\u{301}lodie", "élodie"),
            ("0wner", "owner"),
            ("STRASSE", "straße"),
        ] {
            assert_eq!(name_key(a), name_key(b), "{a} vs {b}");
        }
        assert_ne!(name_key("alice"), name_key("alicia"));
        for (a, b) in [
            ("AIice", "alice"),
            ("lan", "Ian"),
            ("BiII", "Bill"),
            ("OIivia", "Olivia"),
            ("ali\u{307}ce", "alice"),
            ("A\u{301}lice", "alice"),
        ] {
            assert!(names_clash(&name_keys(a), &name_keys(b)), "{a} vs {b}");
        }
        assert!(!names_clash(&name_keys("alice"), &name_keys("alicia")));
        for c in [
            '\u{200b}', '\u{200d}', '\u{2060}', '\u{feff}', '\u{ad}', '\u{202e}', '\u{2028}',
            '\u{3164}', '\t',
        ] {
            assert!(hidden_char(c), "{:?}", c);
        }
        for c in ['a', ' ', 'é', '☕', '\u{fe0f}'] {
            assert!(!hidden_char(c), "{:?}", c);
        }
    }

    #[tokio::test]
    async fn names_that_pass_for_members_are_refused_however_written() {
        let (state, path, cid) = setup("wh_names").await;
        let db = &state.db;
        add_user(db, "elodie", "Élodie").await;
        add_member(db, "rchat", "elodie", 0, 0, 1).await;
        for name in [
            "Alice\u{200b} B",
            "Al\u{ad}ice B",
            "\u{202e}Alice B",
            "Alice\u{2028}B",
            "\u{3164}",
            "Instance\u{a0}staff",
            "Instance  staff",
            "INSTANCE STAFF",
            "\u{430}lice B",
            "ＡＬＩＣＥ Ｂ",
            "élodie",
            "ÉLODIE",
            "0wner",
            "p\u{200d}lain",
        ] {
            assert_eq!(
                code(create(&state, "owner", cid, name).await).0,
                StatusCode::BAD_REQUEST,
                "{name:?}"
            );
        }
        for name in ["Deploy Bot", "Café ☕", "\u{2764}\u{fe0f} Hearts"] {
            create(&state, "owner", cid, name).await.expect(name);
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn incoming_changes_by_another_manager_make_them_the_owner() {
        let (state, path, cid) = setup("wh_takeover_in").await;
        let db = &state.db;
        add_moder(db).await;
        let made = create(&state, "owner", cid, "Deploys")
            .await
            .expect("create");
        let id = made.webhook.id;
        assert!(made.webhook.mentions);
        let owner_of = |id: i64| async move {
            let r = sqlx::query("SELECT creator, creator_mentions FROM webhooks WHERE id = $1")
                .bind(id)
                .fetch_one(db)
                .await
                .expect("row");
            (
                r.try_get::<Option<String>, _>(0).expect("creator"),
                r.try_get::<i64, _>(1).expect("mentions"),
            )
        };
        let patch = |name: Option<&str>, channel: Option<i64>| WebhookPatch {
            channel_id: channel,
            name: name.map(str::to_string),
            avatar_kind: None,
            avatar_color: None,
        };
        let _ = update_webhook(
            State(state.clone()),
            Authed(mem_user("moder", false)),
            Path(("rchat".to_string(), id)),
            Json(patch(Some("Renamed"), None)),
        )
        .await
        .expect("rename");
        assert_eq!(
            owner_of(id).await,
            (Some("owner".to_string()), 1),
            "a rename keeps the owner"
        );
        assert_eq!(
            code(
                reset_token(
                    State(state.clone()),
                    Authed(mem_user("root", true)),
                    Path(("rchat".to_string(), id)),
                )
                .await
            )
            .0,
            StatusCode::FORBIDDEN,
            "staff powers cannot take a hook over"
        );
        let Json(fresh) = reset_token(
            State(state.clone()),
            Authed(mem_user("moder", false)),
            Path(("rchat".to_string(), id)),
        )
        .await
        .expect("reset");
        assert!(!fresh.webhook.mentions);
        assert_eq!(
            owner_of(id).await,
            (Some("moder".to_string()), 0),
            "the new owner's rights, not the old one's"
        );
        let user = run(
            &state,
            &id.to_string(),
            &fresh.token,
            json!({"content": "@everyone hi", "allowed_mentions": {"parse": ["everyone"]}}),
        )
        .await
        .expect("post");
        assert!(
            user.group_mentions.is_empty(),
            "no group pings through the new owner"
        );
        assert!(
            text(
                db,
                "SELECT details FROM audit_log WHERE action = 'webhook.token_reset' ORDER BY id DESC LIMIT 1"
            )
            .await
            .is_some_and(|d| d.contains("\"owner\"") && d.contains("moder"))
        );
        let other: i64 = sqlx::query(
            "INSERT INTO channels(server, name, created_at) VALUES('rchat', 'ops', 1) RETURNING id",
        )
        .fetch_one(db)
        .await
        .expect("ops")
        .try_get(0)
        .expect("id");
        let _ = reset_token(
            State(state.clone()),
            Authed(mem_user("owner", false)),
            Path(("rchat".to_string(), id)),
        )
        .await
        .expect("owner takes it back");
        assert_eq!(owner_of(id).await, (Some("owner".to_string()), 1));
        let _ = update_webhook(
            State(state.clone()),
            Authed(mem_user("moder", false)),
            Path(("rchat".to_string(), id)),
            Json(patch(None, Some(other))),
        )
        .await
        .expect("move");
        assert_eq!(
            owner_of(id).await,
            (Some("moder".to_string()), 0),
            "moving it to another channel makes the mover the owner"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn outgoing_changes_by_another_manager_make_them_the_owner() {
        let (state, path, cid) = setup("wh_takeover_out").await;
        let db = &state.db;
        add_moder(db).await;
        switch_on(db).await;
        let staff: i64 = sqlx::query("INSERT INTO channels(server, name, restrict_view, created_at) VALUES('rchat', 'staff', 1, 1) RETURNING id")
            .fetch_one(db)
            .await
            .expect("private")
            .try_get(0)
            .expect("id");
        let hook = outgoing_hook(db, "https://93.184.216.34/a", "message.created", "owner").await;
        let creator = |hook: i64| async move {
            text(
                db,
                &format!("SELECT creator FROM outgoing_webhooks WHERE id = {hook}"),
            )
            .await
        };
        let patch = |url: Option<&str>, enabled: Option<bool>| OutgoingPatch {
            name: Some("Renamed".to_string()),
            url: url.map(str::to_string),
            events: None,
            enabled,
        };
        let edit = |who: &'static str, p: OutgoingPatch| {
            update_outgoing(
                State(state.clone()),
                Authed(mem_user(who, false)),
                Path(("rchat".to_string(), hook)),
                Json(p),
            )
        };
        let _ = edit("moder", patch(None, None)).await.expect("rename");
        let _ = edit("moder", patch(None, Some(false)))
            .await
            .expect("turn off");
        assert_eq!(creator(hook).await.as_deref(), Some("owner"));
        let _ = edit("owner", patch(None, Some(true)))
            .await
            .expect("owner turns on");
        let secret = post_msg(db, staff, "staff only").await;
        enqueue(&state, created(db, staff, secret).await)
            .await
            .expect("owner sees staff");
        assert_eq!(int(db, "SELECT COUNT(*) FROM webhook_deliveries").await, 1);
        exec(db, "DELETE FROM webhook_deliveries").await;
        let Json(after) = edit("moder", patch(Some("https://93.184.216.35/b"), None))
            .await
            .expect("move url");
        assert_eq!(creator(hook).await.as_deref(), Some("moder"));
        assert_eq!(after.creator.map(|c| c.username).as_deref(), Some("moder"));
        assert!(
            text(
                db,
                "SELECT details FROM audit_log WHERE action = 'webhook.outgoing_update' ORDER BY id DESC LIMIT 1"
            )
            .await
            .is_some_and(|d| d.contains("\"owner\"") && d.contains("moder"))
        );
        enqueue(&state, created(db, staff, secret).await)
            .await
            .expect("moder does not");
        assert_eq!(
            int(db, "SELECT COUNT(*) FROM webhook_deliveries").await,
            0,
            "a channel only the old owner can see is never sent to the new URL"
        );
        let open = post_msg(db, cid, "for all").await;
        enqueue(&state, created(db, cid, open).await)
            .await
            .expect("open");
        assert_eq!(int(db, "SELECT COUNT(*) FROM webhook_deliveries").await, 1);
        let second = outgoing_hook(db, "https://93.184.216.34/c", "message.created", "owner").await;
        assert_eq!(
            code(
                reset_secret(
                    State(state.clone()),
                    Authed(mem_user("root", true)),
                    Path(("rchat".to_string(), second)),
                )
                .await
            )
            .0,
            StatusCode::FORBIDDEN
        );
        let _ = reset_secret(
            State(state.clone()),
            Authed(mem_user("moder", false)),
            Path(("rchat".to_string(), second)),
        )
        .await
        .expect("secret");
        assert_eq!(creator(second).await.as_deref(), Some("moder"));
        let third = outgoing_hook(db, "https://93.184.216.34/d", "message.created", "owner").await;
        exec(
            db,
            &format!("UPDATE outgoing_webhooks SET enabled = 0, disabled_at = 5, disabled_reason = 'failures' WHERE id = {third}"),
        )
        .await;
        let _ = update_outgoing(
            State(state.clone()),
            Authed(mem_user("moder", false)),
            Path(("rchat".to_string(), third)),
            Json(OutgoingPatch {
                name: None,
                url: None,
                events: None,
                enabled: Some(true),
            }),
        )
        .await
        .expect("turn on");
        assert_eq!(creator(third).await.as_deref(), Some("moder"));
        assert_eq!(
            text(
                db,
                &format!("SELECT disabled_reason FROM outgoing_webhooks WHERE id = {third}")
            )
            .await,
            None
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn queued_deliveries_are_rebuilt_and_rechecked_when_sent() {
        let (state, path, cid) = setup("wh_rebuild").await;
        let db = &state.db;
        switch_on(db).await;
        let (port, seen) = receiver(vec![200, 200]).await;
        let hook = outgoing_hook(
            db,
            &format!("http://127.0.0.1:{port}/in"),
            "message.created",
            "plain",
        )
        .await;
        let edited = post_msg(db, cid, "first draft").await;
        enqueue(&state, created(db, cid, edited).await)
            .await
            .expect("edited");
        let gone = post_msg(db, cid, "doomed words").await;
        enqueue(&state, created(db, cid, gone).await)
            .await
            .expect("gone");
        let stored = sqlx::query("SELECT payload FROM webhook_deliveries ORDER BY id")
            .fetch_all(db)
            .await
            .expect("rows");
        assert_eq!(stored.len(), 2);
        for r in &stored {
            let p: String = r.try_get(0).expect("payload");
            assert!(!p.contains("first draft") && !p.contains("doomed"), "{p}");
        }
        exec(
            db,
            &format!(
                "UPDATE messages SET content = 'final text', edited_at = 9 WHERE id = {edited}"
            ),
        )
        .await;
        exec(db, &format!("DELETE FROM messages WHERE id = {gone}")).await;
        let policy = local_policy();
        assert_eq!(run_due(&state, &policy, now()).await.expect("run"), 2);
        let seen = seen.await.expect("receiver");
        let bodies: Vec<Value> = seen
            .iter()
            .map(|(_, b)| serde_json::from_str(b).expect("json"))
            .collect();
        assert_eq!(bodies[0]["type"], "message.created");
        assert_eq!(bodies[0]["data"]["message"]["content"], "final text");
        assert!(!seen[0].1.contains("first draft"));
        assert_eq!(bodies[1]["type"], "message.deleted");
        assert_eq!(seen[1].0["x-webhook-event"], "message.deleted");
        assert_eq!(bodies[1]["data"]["ids"], json!([gone]));
        assert_eq!(bodies[1]["data"]["channel_id"], cid);
        assert!(!seen[1].1.contains("doomed"));
        assert_eq!(
            text(
                db,
                "SELECT event FROM webhook_deliveries ORDER BY id DESC LIMIT 1"
            )
            .await
            .as_deref(),
            Some("message.deleted")
        );
        let late = post_msg(db, cid, "late").await;
        enqueue(&state, created(db, cid, late).await)
            .await
            .expect("late");
        exec(db, "DELETE FROM members WHERE username = 'plain'").await;
        assert_eq!(
            run_due(&state, &policy, now()).await.expect("owner gone"),
            0,
            "nothing is sent once the owner left"
        );
        let r = sqlx::query(
            "SELECT status, last_error, payload FROM webhook_deliveries ORDER BY id DESC LIMIT 1",
        )
        .fetch_one(db)
        .await
        .expect("row");
        assert_eq!(r.try_get::<String, _>(0).expect("s"), "failed");
        assert_eq!(
            r.try_get::<Option<String>, _>(1).expect("e").as_deref(),
            Some(OWNER_GONE)
        );
        assert!(r.try_get::<Option<String>, _>(2).expect("p").is_none());
        let h = sqlx::query("SELECT enabled, disabled_reason FROM outgoing_webhooks WHERE id = $1")
            .bind(hook)
            .fetch_one(db)
            .await
            .expect("hook");
        assert_eq!(h.try_get::<i64, _>(0).expect("enabled"), 0);
        assert_eq!(
            h.try_get::<Option<String>, _>(1).expect("why").as_deref(),
            Some(OFF_OWNER)
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn deliveries_lost_from_view_are_dropped() {
        let (state, path, cid) = setup("wh_hidden").await;
        let db = &state.db;
        switch_on(db).await;
        let hook = outgoing_hook(db, "http://127.0.0.1:9/in", "message.created", "plain").await;
        let m = post_msg(db, cid, "soon private").await;
        enqueue(&state, created(db, cid, m).await)
            .await
            .expect("queued");
        exec(
            db,
            &format!("UPDATE channels SET restrict_view = 1 WHERE id = {cid}"),
        )
        .await;
        assert_eq!(
            run_due(&state, &local_policy(), now()).await.expect("run"),
            0
        );
        assert_eq!(
            text(db, "SELECT last_error FROM webhook_deliveries")
                .await
                .as_deref(),
            Some("Owner cannot see this")
        );
        assert_eq!(
            int(
                db,
                &format!("SELECT enabled FROM outgoing_webhooks WHERE id = {hook}")
            )
            .await,
            1,
            "one hidden channel does not turn the hook off"
        );
        done(state, path).await;
    }

    #[test]
    fn servers_take_turns() {
        let rows = vec![
            (1, 10, "a".to_string()),
            (2, 11, "a".to_string()),
            (3, 12, "a".to_string()),
            (4, 13, "b".to_string()),
            (5, 14, "c".to_string()),
        ];
        assert_eq!(
            fair(rows.clone(), 0),
            vec![(1, 10), (4, 13), (5, 14), (2, 11), (3, 12)]
        );
        assert_eq!(
            fair(rows, 1),
            vec![(4, 13), (5, 14), (1, 10), (2, 11), (3, 12)]
        );
        assert!(fair(Vec::new(), 3).is_empty());
    }

    #[tokio::test]
    async fn a_slow_hook_does_not_hold_up_the_others() {
        let (state, path, _) = setup("wh_slow").await;
        let db = &state.db;
        switch_on(db).await;
        let tarpit = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let slow_port = tarpit.local_addr().expect("addr").port();
        let pit = tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((sock, _)) = tarpit.accept().await {
                held.push(sock);
            }
        });
        let (port, seen) = receiver(vec![200]).await;
        let slow = outgoing_hook(
            db,
            &format!("http://127.0.0.1:{slow_port}/in"),
            "message.created",
            "owner",
        )
        .await;
        let fast = outgoing_hook(
            db,
            &format!("http://127.0.0.1:{port}/in"),
            "message.created",
            "owner",
        )
        .await;
        queue(db, slow, &ping(slow)).await.expect("slow");
        queue(db, slow, &ping(slow)).await.expect("slow again");
        queue(db, fast, &ping(fast)).await.expect("fast");
        let runner = {
            let state = state.clone();
            tokio::spawn(async move { run_due(&state, &local_policy(), now()).await })
        };
        let started = Instant::now();
        loop {
            let delivered = int(
                db,
                &format!("SELECT COUNT(*) FROM webhook_deliveries WHERE hook_id = {fast} AND status = 'delivered'"),
            )
            .await;
            if delivered == 1 {
                break;
            }
            assert!(
                started.elapsed() < Duration::from_secs(4),
                "the fast hook waited behind the slow one"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(
            int(
                db,
                &format!("SELECT COUNT(*) FROM webhook_deliveries WHERE hook_id = {slow} AND status = 'pending' AND attempts = 0 AND claimed_at > 0")
            )
            .await,
            1,
            "one request per hook at a time"
        );
        assert_eq!(seen.await.expect("receiver").len(), 1);
        runner.abort();
        pit.abort();
        done(state, path).await;
    }

    #[tokio::test]
    async fn refusals_read_the_same_for_unknown_hosts() {
        assert_eq!(
            code(check_url("https://no-such-host.invalid/hook").await),
            (StatusCode::BAD_REQUEST, "Address not allowed".to_string())
        );
        assert_eq!(
            code(check_url("https://10.0.0.5/hook").await),
            (StatusCode::BAD_REQUEST, "Address not allowed".to_string())
        );
    }

    #[tokio::test]
    async fn webhook_messages_follow_spoiler_and_inbox_rules() {
        let (state, path, cid) = setup("wh_spoilers").await;
        let db = &state.db;
        let made = create(&state, "owner", cid, "Deploys")
            .await
            .expect("create");
        let id = made.webhook.id.to_string();
        let content = "||https://example.com/a|| for @plain";
        let posted = run(
            &state,
            &id,
            &made.token,
            json!({
                "content": content,
                "embeds": [{
                    "title": "||Spoiled||",
                    "description": "||https://example.com/b||",
                    "fields": [{"name": "Link", "value": "||https://example.com/c||"}],
                }],
            }),
        )
        .await
        .expect("post");
        assert_eq!(posted.content, content, "markers are kept");
        assert!(embeds::extract_urls(&posted.content).is_empty());
        assert_eq!(
            int(
                db,
                &format!(
                    "SELECT COUNT(*) FROM message_embeds WHERE message_id = {}",
                    posted.id
                )
            )
            .await,
            0,
            "nothing is fetched"
        );
        let q: crate::api::inbox::InboxQuery = serde_json::from_value(json!({})).expect("query");
        let items = crate::api::inbox::list_inbox(
            State(state.clone()),
            crate::api::Authed(mem_user("plain", false)),
            Query(q),
        )
        .await
        .expect("inbox")
        .0
        .items;
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].message_id, Some(posted.id));
        assert_eq!(items[0].actor.username, author_key(made.webhook.id));
        assert_eq!(items[0].actor.display_name, "Deploys");
        assert_eq!(items[0].content.as_deref(), Some(content));
        exec(
            db,
            "UPDATE settings SET value = '1' WHERE key = 'outgoing_webhooks'",
        )
        .await;
        Settings::forget(db);
        let owner = get_user(db, "owner").await.expect("db").expect("owner");
        let fact = Fact::Created {
            server: "rchat".to_string(),
            id: posted.id,
            channel_id: Some(cid),
            thread_root_id: None,
        };
        let (event, data) = payload(db, &owner, &fact)
            .await
            .expect("payload")
            .expect("visible");
        assert_eq!(event, "message.created");
        assert_eq!(data["message"]["content"], content, "raw content goes out");
        done(state, path).await;
    }
}
