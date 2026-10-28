use std::collections::HashMap;

use axum::Json;
use axum::extract::{Path, Query, RawQuery, State};
use axum::http::{HeaderMap, StatusCode};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use sqlx::any::AnyRow;
use utoipa::{IntoParams, ToSchema};

use crate::api::access::{
    Proof, channel_manager_servers, granted_servers, member_channel_rights, resolve_channel,
    resolve_dm, resolve_message,
};
use crate::api::admin::like_pattern;
use crate::api::pings::{
    PingScope, ScopePings, SeenScope, ThreadPings, announce_counts, mark_seen, ping_message,
    pinged_by, unseen_counts,
};
use crate::api::reactions::attach_reactions;
use crate::api::{
    ApiError, ApiErrorBody, Authed, CallLog, Embed, ForwardRef, LIST_MAX, LIST_PAGE, MESSAGE_MAX,
    MaybeAuthed, MediaRef, Message, Paged, ProfanityTarget, ReplyRef, Settings, UserRef, check_len,
    check_profanity, cursor_int, decode_cursor, embeds, encode_cursor, media::MEDIA_TTL_SECS,
    placeholders, require_guest_ok, unique_capped, user_from, user_refs,
};
use crate::db::{
    ChannelAccess, Db, LIVE_AUTHOR, MediaKind, User, has_fts, is_sqlite, now, perm_subjects,
    touch_interaction,
};
use crate::state::AppState;
use crate::ws::{Updated, WsEvent};

const COLS: &str = "m.id, m.channel_id, m.dm_id, m.thread_root_id, m.author, m.content, m.media_id, m.media_filename, m.media_removed, m.media_spoiler, m.created_at, (SELECT COUNT(*) FROM messages r WHERE r.thread_root_id = m.id), m.media_kind, m.media_hoster, m.media_expires_at, m.media_size, m.media_mime, m.kind, m.call_answered_at, m.call_ended_at, m.call_outcome, m.reply_to, m.reply_mention, m.edited_at, CASE WHEN EXISTS(SELECT 1 FROM users fu WHERE fu.username = m.fwd_author AND fu.password_hash = '!purging') THEN NULL ELSE m.fwd_author END, m.fwd_created_at, m.fwd_source_id, m.fwd_origin, m.fwd_dropped, m.pinned_at / 1000, m.pin_message_id, (SELECT pm.created_at FROM messages pm WHERE pm.id = m.pin_message_id), m.media_sha256";
const SNIPPET_MAX: usize = 200;

/// Message-id paging for message lists. Give at most one of `before`, `after` and `around`;
/// if several are given, `around` wins over `after`, which wins over `before`.
#[derive(Clone, Copy, Deserialize, IntoParams)]
pub struct PageQuery {
    /// Return the newest messages with an id lower than this one. Omit all three anchors for the
    /// latest messages.
    before: Option<i64>,
    /// Return the oldest messages with an id higher than this one.
    after: Option<i64>,
    /// Return a window centred on this id: `limit / 2` older messages, then this id (if it
    /// exists) and newer ones up to `limit` in total. The id itself does not need to exist.
    around: Option<i64>,
    /// Page size. Default 50, clamped to 1..=100.
    #[param(example = 50)]
    limit: Option<i64>,
}

#[derive(Clone, Copy)]
enum Span {
    Before,
    From,
    After,
}

/// A new message. It needs non-blank `content` or an attachment; `media_id` and `p2p` are
/// mutually exclusive.
#[derive(Deserialize, ToSchema)]
pub struct SendReq {
    /// Message text, at most 4000 characters (Unicode code points). May be empty or blank when
    /// an attachment is given. Up to 3 `http(s)` links in it (invite links excluded) get link
    /// previews after the message is posted.
    #[schema(example = "Hello https://example.com")]
    content: String,
    /// Optional id of a file from `POST /api/media` to attach. The caller must be its uploader
    /// and it must not already be attached to another message. Omit for no server-hosted file.
    media_id: Option<String>,
    /// Optional; blur the attachment behind a spoiler. Defaults to `false`.
    media_spoiler: Option<bool>,
    /// Optional peer-to-peer attachment hosted by the sender's client instead of the server.
    /// Omit for no P2P file.
    p2p: Option<P2pAttachment>,
    /// Optional id of a message to reply to inline (quoted above the new message). It must be a
    /// `user` message you can read in the same place: the same channel outside threads, the
    /// same thread (or its root) for thread replies, or the same DM. Anything else, including
    /// ids that do not exist, gives the same `400 Cannot reply to that message`.
    #[schema(example = 42)]
    #[serde(default)]
    reply_to: Option<i64>,
    /// With `reply_to`: ping the quoted message's author (a `reply` ping, if they can see the
    /// message and are not you). Defaults to `true`; ignored without `reply_to`.
    #[serde(default = "yes")]
    #[schema(default = true)]
    mention_reply: bool,
    /// Optional id of a message to forward here. The server makes the new message as a copy: its
    /// text, its server-hosted attachment (unless removed, expired, uploads are off, or 50
    /// messages already carry that file; P2P attachments are not forwarded) and its link
    /// previews. `forward` names the original author and time. `content`, the attachment fields
    /// and `reply_to` are then ignored. It must be a `user` message you can read. All else, also unknown ids, gives the same
    /// `400 Cannot forward that message`. Forwards never ping anyone.
    #[schema(example = 42)]
    #[serde(default)]
    forward_of: Option<i64>,
}

fn yes() -> bool {
    true
}

/// A file offered peer to peer by the sender, who becomes its `hoster`. The server stores only
/// this metadata, never the file.
#[derive(Deserialize, ToSchema)]
pub struct P2pAttachment {
    /// File name shown to recipients. In server channels it is checked by the profanity filter
    /// when that is enabled for file names.
    #[schema(example = "notes.pdf")]
    filename: String,
    /// File size in bytes, from 0 to 2^53 - 1. There is no other size limit: the bytes never
    /// reach the server.
    #[schema(example = 48213)]
    size: i64,
    /// MIME type as reported by the sender, not verified; at most 255 characters.
    #[schema(example = "application/pdf")]
    mime: String,
    /// SHA-256 of the file's bytes as 64 hexadecimal characters (stored lowercase), computed
    /// when attaching it. Recipients check downloads against it. Optional for older clients;
    /// files without it are shown as unverified.
    #[schema(example = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08")]
    #[serde(default)]
    sha256: Option<String>,
    /// Transfer id chosen by the sender: exactly 32 hexadecimal characters.
    #[schema(example = "0123456789abcdef0123456789abcdef")]
    p2p_id: String,
    /// Optional lifetime in seconds from now, must be positive. The message's `expires_at`
    /// becomes now plus this; omit for no expiry.
    #[schema(example = 86400)]
    expires_in_seconds: Option<i64>,
}

/// Message search filters. All are optional and combine with AND; unknown parameters are
/// ignored.
#[derive(Clone, Default, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct SearchQuery {
    /// Text the message content must contain, case-insensitive substring match after trimming.
    /// Omit or leave blank to match every message. Must not contain NUL.
    #[param(example = "release")]
    q: Option<String>,
    /// Only search this server (name, case-insensitive). Must not contain NUL.
    server: Option<String>,
    /// Only search this channel id.
    channel_id: Option<i64>,
    /// Only messages by this username (case-insensitive). Must not contain NUL.
    from: Option<String>,
    /// `file` keeps only messages with an attachment; any other value is ignored. Must not
    /// contain NUL.
    #[param(example = "file")]
    has: Option<String>,
    /// Only messages with an id lower than this (exclusive). Replaced by `cursor` when both are
    /// given.
    before: Option<i64>,
    /// Only messages with an id higher than this (exclusive).
    after: Option<i64>,
    /// Only messages created before this Unix time in seconds (exclusive).
    before_ts: Option<i64>,
    /// Only messages created after this Unix time in seconds (exclusive).
    after_ts: Option<i64>,
    /// Legacy: skip this many results, capped at 500. Ignored when `cursor` is given. Prefer
    /// `cursor`.
    offset: Option<i64>,
    /// Opaque cursor from the previous page's `X-Next-Cursor` header. A blank value is ignored.
    cursor: Option<String>,
    /// Guests only (ignored for signed-in callers, who search every server they are a member
    /// of): the servers to search, as repeated parameters (`servers=a&servers=b`). Names are
    /// trimmed and lowercased, duplicates dropped, at most 100 used. A guest who passes none
    /// gets an empty result. Must not contain NUL.
    servers: Option<Vec<String>>,
}

impl SearchQuery {
    fn parse(raw: &str) -> Result<SearchQuery, ApiError> {
        let int = |v: &str| {
            v.parse::<i64>()
                .map_err(|_| ApiError(StatusCode::BAD_REQUEST, "Invalid number".to_string()))
        };
        let mut sq = SearchQuery::default();
        for (key, value) in url::form_urlencoded::parse(raw.as_bytes()) {
            match key.as_ref() {
                "q" => sq.q = Some(value.into_owned()),
                "server" => sq.server = Some(value.into_owned()),
                "channel_id" => sq.channel_id = Some(int(&value)?),
                "from" => sq.from = Some(value.into_owned()),
                "has" => sq.has = Some(value.into_owned()),
                "before" => sq.before = Some(int(&value)?),
                "after" => sq.after = Some(int(&value)?),
                "before_ts" => sq.before_ts = Some(int(&value)?),
                "after_ts" => sq.after_ts = Some(int(&value)?),
                "offset" => sq.offset = Some(int(&value)?),
                "cursor" if !value.trim().is_empty() => sq.cursor = Some(value.into_owned()),
                "servers" => sq
                    .servers
                    .get_or_insert_with(Vec::new)
                    .push(value.into_owned()),
                _ => {}
            }
        }
        Ok(sq)
    }
}

/// One search hit with where it was posted.
#[derive(Serialize, ToSchema)]
pub struct SearchResult {
    /// The matching message, with its link previews. It can be a thread reply (then
    /// `thread_root_id` is set).
    pub message: Message,
    /// Lowercase name of the server the message is in.
    #[schema(example = "rust")]
    pub server: String,
    /// Name of the channel the message is in.
    #[schema(example = "general")]
    pub channel_name: String,
}

/// Read position of one channel or DM.
#[derive(Serialize, ToSchema)]
pub struct Unread {
    /// `c<channel id>` for a text channel or `d<dm id>` for a DM.
    #[schema(example = "c12")]
    pub scope: String,
    /// Lowercase server name for a channel scope; `null` for a DM.
    #[schema(example = "rust")]
    pub server: Option<String>,
    /// Last message id the caller marked read with `POST /api/read`; 0 if never.
    #[schema(example = 340)]
    pub last_read: i64,
    /// Id of the newest message from someone else: in a channel the newest top-level one
    /// (thread replies are not counted).
    #[schema(example = 352)]
    pub latest: i64,
    /// Unseen pings (mentions, replies and reactions for the caller) in this scope, including
    /// thread replies of a channel. A scope with pings is listed even when it is read.
    #[schema(example = 2)]
    pub pings: i64,
    /// Highest unseen ping id outside threads (0: none). Send it as `pings_until` to
    /// `POST /api/read` for this scope.
    #[schema(example = 918)]
    pub pings_until: i64,
    /// Unseen pings on thread replies in this channel, per thread (included in `pings`). Read
    /// with scope `t<root id>`.
    pub thread_pings: Vec<ThreadPings>,
}

/// The caller's unread channels and DMs.
#[derive(Serialize, ToSchema)]
pub struct Unreads {
    /// Unread scopes, newest `latest` first and at most 500. With `all=true`: every scope with
    /// messages from others, read or not, in no particular order and without a cap.
    pub items: Vec<Unread>,
    /// `true` when more than 500 scopes were unread and the list was cut; always `false` with
    /// `all=true`.
    pub more: bool,
}

/// Mark a channel, DM or thread read up to a message.
#[derive(Deserialize, ToSchema)]
pub struct ReadReq {
    /// `c<channel id>`, `d<dm id>` or `t<thread root id>`: the letter followed by one or more
    /// ASCII digits.
    #[schema(example = "c12")]
    scope: String,
    /// Id of the last message read. A value lower than the stored one leaves it unchanged.
    /// Threads store no position (send 0 or the last reply id).
    #[schema(example = 352)]
    last_read: i64,
    /// Highest ping id the client has shown for this scope: only pings up to it are marked
    /// seen, so a ping that arrives meanwhile keeps its badge. Omitted: every unseen ping.
    #[serde(default)]
    #[schema(example = 918)]
    pings_until: Option<i64>,
}

/// The stored read position of a scope.
#[derive(Serialize, ToSchema)]
pub struct ReadState {
    /// The scope from the request, as given.
    #[schema(example = "c12")]
    pub scope: String,
    /// The stored last-read message id: the higher of the previous value and the request.
    #[schema(example = 352)]
    pub last_read: i64,
}

fn valid_scope(scope: &str) -> bool {
    let bytes = scope.as_bytes();
    bytes.len() >= 2
        && matches!(bytes[0], b'c' | b'd' | b't')
        && bytes[1..].iter().all(|b| b.is_ascii_digit())
}

fn row_message(r: &AnyRow, refs: &HashMap<String, UserRef>) -> Result<Message, ApiError> {
    let media = match r.try_get::<Option<String>, _>(6)? {
        Some(id) => {
            let removed = r.try_get::<i64, _>(8)?;
            Some(MediaRef {
                id,
                filename: r.try_get::<Option<String>, _>(7)?.unwrap_or_default(),
                kind: MediaKind::parse(&r.try_get::<String, _>(12)?)?,
                hoster: r.try_get(13)?,
                expires_at: r.try_get(14)?,
                size: r.try_get(15)?,
                mime: r.try_get(16)?,
                sha256: r.try_get(32)?,
                removed: removed != 0,
                removed_by_author: removed == 2,
                spoiler: r.try_get::<i64, _>(9)? != 0,
            })
        }
        None => None,
    };
    let kind: String = r.try_get(17)?;
    let call = match kind.as_str() {
        "call" => Some(CallLog {
            from: r.try_get(4)?,
            answered_at: r.try_get(18)?,
            ended_at: r.try_get(19)?,
            outcome: r.try_get(20)?,
        }),
        _ => None,
    };
    Ok(Message {
        id: r.try_get(0)?,
        channel_id: r.try_get(1)?,
        dm_id: r.try_get(2)?,
        thread_root_id: r.try_get(3)?,
        author: user_from(refs, &r.try_get::<String, _>(4)?),
        content: r.try_get(5)?,
        created_at: r.try_get(10)?,
        reply_count: r.try_get(11)?,
        media,
        embeds: Vec::new(),
        kind,
        call,
        reactions: Vec::new(),
        reply_to: match r.try_get::<Option<i64>, _>(21)? {
            Some(id) => Some(ReplyRef {
                id,
                author: None,
                content: String::new(),
                has_media: false,
                deleted: true,
                mention: r.try_get::<i64, _>(22)? != 0,
                partial: false,
                forwarded: false,
            }),
            None => None,
        },
        edited_at: r.try_get(23)?,
        forward: match (
            r.try_get::<Option<String>, _>(24)?,
            r.try_get::<Option<i64>, _>(25)?,
            r.try_get::<Option<i64>, _>(26)?,
        ) {
            (author, Some(created_at), Some(source_id)) => Some(ForwardRef {
                author: author.map(|a| user_from(refs, &a)),
                created_at,
                source_id,
                origin: r.try_get(27)?,
                dropped: r.try_get(28)?,
            }),
            (_, _, _) => None,
        },
        pinned_at: r.try_get(29)?,
        pin_message_id: match r.try_get::<Option<i64>, _>(31)? {
            Some(_) => r.try_get(30)?,
            None => None,
        },
    })
}

/// Which quoted messages to fill in: none (search results, internal lookups), only the
/// reference (`Partial`, for WebSocket events, which reach viewers with different read-history
/// limits), or those the viewer may read (`Since(floor)`: sent at or after `floor`).
#[derive(Clone, Copy)]
pub(crate) enum Quotes {
    Skip,
    Partial,
    Since(Option<i64>),
}

/// `message` as WebSocket events carry it: the quote keeps only its id and `mention`.
pub(crate) fn partial_quote(mut message: Message) -> Message {
    message.reply_to = message.reply_to.map(
        |ReplyRef {
             id,
             author: _,
             content: _,
             has_media: _,
             deleted: _,
             mention,
             partial: _,
             forwarded: _,
         }| ReplyRef {
            id,
            author: None,
            content: String::new(),
            has_media: false,
            deleted: false,
            mention,
            partial: true,
            forwarded: false,
        },
    );
    message
}

async fn rows_messages(db: &Db, rows: &[AnyRow], quotes: Quotes) -> Result<Vec<Message>, ApiError> {
    let mut authors = Vec::with_capacity(rows.len());
    for r in rows {
        authors.push(r.try_get::<String, _>(4)?);
        if let Some(original) = r.try_get::<Option<String>, _>(24)? {
            authors.push(original);
        }
    }
    let refs = user_refs(db, &authors).await;
    let mut msgs = rows
        .iter()
        .map(|r| row_message(r, &refs))
        .collect::<Result<Vec<_>, _>>()?;
    if let Quotes::Since(Some(floor)) = quotes {
        for (m, r) in msgs.iter_mut().zip(rows) {
            if r.try_get::<Option<i64>, _>(31)?.is_some_and(|t| t < floor) {
                m.pin_message_id = None;
            }
        }
    }
    match quotes {
        Quotes::Skip => msgs.iter_mut().for_each(|m| m.reply_to = None),
        Quotes::Partial => return Ok(msgs.into_iter().map(partial_quote).collect()),
        Quotes::Since(floor) => attach_quotes(db, &mut msgs, floor).await?,
    }
    Ok(msgs)
}

/// The first line of `content` with text left, as plain text: code fences, quote, heading and
/// subtext markers, emphasis, strikethrough, inline code and link targets are removed;
/// `||spoilers||` stay so clients can hide them. At most 200 characters.
pub fn reply_snippet(content: &str) -> String {
    let line = content
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("```") && !l.starts_with("~~~"))
        .map(|mut l| {
            loop {
                let next = l
                    .strip_prefix("-# ")
                    .or_else(|| l.strip_prefix('>'))
                    .or_else(|| {
                        let hashes = l.len() - l.trim_start_matches('#').len();
                        match (1..=6).contains(&hashes) {
                            true => l[hashes..].strip_prefix(' '),
                            false => None,
                        }
                    });
                match next {
                    Some(rest) => l = rest.trim_start(),
                    None => return l,
                }
            }
        })
        .find(|l| !l.is_empty())
        .unwrap_or("");
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        match c {
            '\\' if next.is_some_and(|n| n.is_ascii_punctuation()) => {
                out.push(next.unwrap_or(c));
                i += 2;
                continue;
            }
            '*' | '`' => {}
            '~' if next == Some('~') => i += 1,
            '_' => {
                let prev = i.checked_sub(1).map(|p| chars[p]);
                let inner = prev.is_some_and(char::is_alphanumeric)
                    && next.is_some_and(char::is_alphanumeric);
                if inner {
                    out.push(c);
                }
            }
            '[' => {
                let close = chars[i + 1..]
                    .iter()
                    .position(|&x| x == ']')
                    .map(|p| p + i + 1);
                let target = close.filter(|&e| chars.get(e + 1) == Some(&'('));
                let end = target.and_then(|e| {
                    chars[e + 2..]
                        .iter()
                        .position(|&x| x == ')')
                        .map(|p| (e, p + e + 2))
                });
                match end {
                    Some((label_end, link_end)) => {
                        let label: String = chars[i + 1..label_end].iter().collect();
                        out.push_str(&reply_snippet(&label));
                        i = link_end + 1;
                        continue;
                    }
                    None => out.push(c),
                }
            }
            '<' => {
                let close = chars[i + 1..]
                    .iter()
                    .position(|&x| x == '>')
                    .map(|p| p + i + 1);
                let inner: Option<String> = close.map(|e| chars[i + 1..e].iter().collect());
                match (close, inner) {
                    (Some(e), Some(url))
                        if url.starts_with("http://") || url.starts_with("https://") =>
                    {
                        out.push_str(&url);
                        i = e + 1;
                        continue;
                    }
                    _ => out.push(c),
                }
            }
            c if c.is_whitespace() => {
                if !out.ends_with(' ') {
                    out.push(' ');
                }
            }
            c if hidden_char(c) => {}
            c => out.push(c),
        }
        i += 1;
    }
    out.trim()
        .chars()
        .take(SNIPPET_MAX)
        .collect::<String>()
        .trim_end()
        .to_string()
}

/// Control characters and bidirectional formatting marks, which a one-line preview drops.
fn hidden_char(c: char) -> bool {
    c.is_control()
        || matches!(c, '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

struct Original {
    channel_id: Option<i64>,
    dm_id: Option<i64>,
    author: String,
    content: String,
    has_media: bool,
    created_at: i64,
    forwarded: bool,
}

/// Fills in `reply_to` of `msgs` from the quoted messages in one query. A quoted message that
/// is gone, by an account being deleted, outside the reply's channel or DM, or sent before
/// `floor` stays `deleted`.
async fn attach_quotes(db: &Db, msgs: &mut [Message], floor: Option<i64>) -> Result<(), ApiError> {
    let mut ids: Vec<i64> = msgs
        .iter()
        .filter_map(|m| m.reply_to.as_ref().map(|q| q.id))
        .collect();
    ids.sort_unstable();
    ids.dedup();
    if ids.is_empty() {
        return Ok(());
    }
    let sql = format!(
        "SELECT m.id, m.channel_id, m.dm_id, m.author, m.content, m.media_id, m.created_at, m.fwd_source_id FROM messages m WHERE m.id IN ({}) AND {LIVE_AUTHOR}",
        placeholders(1, ids.len())
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
    for id in &ids {
        query = query.bind(*id);
    }
    let rows = query.fetch_all(db).await?;
    let mut found: HashMap<i64, Original> = HashMap::with_capacity(rows.len());
    for r in &rows {
        found.insert(
            r.try_get(0)?,
            Original {
                channel_id: r.try_get(1)?,
                dm_id: r.try_get(2)?,
                author: r.try_get(3)?,
                content: r.try_get(4)?,
                has_media: r.try_get::<Option<String>, _>(5)?.is_some(),
                created_at: r.try_get(6)?,
                forwarded: r.try_get::<Option<i64>, _>(7)?.is_some(),
            },
        );
    }
    let authors: Vec<String> = found.values().map(|f| f.author.clone()).collect();
    let refs = user_refs(db, &authors).await;
    for m in msgs.iter_mut() {
        let (channel_id, dm_id) = (m.channel_id, m.dm_id);
        let Some(quote) = m.reply_to.as_mut() else {
            continue;
        };
        let Some(Original {
            channel_id: qc,
            dm_id: qd,
            author,
            content,
            has_media,
            created_at,
            forwarded,
        }) = found.get(&quote.id)
        else {
            continue;
        };
        let same = *qc == channel_id && *qd == dm_id;
        if !same || floor.is_some_and(|f| *created_at < f) {
            continue;
        }
        quote.author = Some(user_from(&refs, author));
        quote.content = reply_snippet(content);
        quote.has_media = *has_media;
        quote.forwarded = *forwarded;
        quote.deleted = false;
    }
    Ok(())
}

/// One message, with no access check. `quotes` decides how much of a quoted message is
/// included: `Partial` for anything broadcast, `Since` only with the viewer's floor.
pub(crate) async fn load_message(
    db: &Db,
    id: i64,
    quotes: Quotes,
) -> Result<Option<Message>, ApiError> {
    let sql = format!("SELECT {COLS} FROM messages m WHERE m.id = $1 AND {LIVE_AUTHOR}");
    let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_all(db)
        .await?;
    Ok(rows_messages(db, &rows, quotes).await?.pop())
}

/// A message for a WebSocket event: link previews attached, quote reduced to its reference.
pub(crate) async fn load_broadcast(db: &Db, id: i64) -> Result<Option<Message>, ApiError> {
    let Some(message) = load_message(db, id, Quotes::Partial).await? else {
        return Ok(None);
    };
    let mut msgs = [message];
    attach_embeds(db, &mut msgs).await?;
    let [message] = msgs;
    Ok(Some(message))
}

async fn attach_embeds(db: &Db, msgs: &mut [Message]) -> Result<(), ApiError> {
    if msgs.is_empty() {
        return Ok(());
    }
    let ph: Vec<String> = (1..=msgs.len()).map(|n| format!("${n}")).collect();
    let sql = format!(
        "SELECT me.message_id, me.ord, me.url, me.banner_removed, e.site_name, e.title, e.description, e.image_url FROM message_embeds me JOIN embeds e ON e.url = me.url WHERE me.removed = 0 AND me.message_id IN ({}) ORDER BY me.message_id, me.ord",
        ph.join(", ")
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
    for m in msgs.iter() {
        query = query.bind(m.id);
    }
    let rows = query.fetch_all(db).await?;
    let mut map: HashMap<i64, Vec<Embed>> = HashMap::new();
    for r in &rows {
        map.entry(r.try_get(0)?).or_default().push(Embed {
            ord: r.try_get(1)?,
            url: r.try_get(2)?,
            site_name: r.try_get(4)?,
            title: r.try_get(5)?,
            description: r.try_get(6)?,
            image_url: r.try_get(7)?,
            banner_removed: r.try_get::<i64, _>(3)? != 0,
        });
    }
    for m in msgs.iter_mut() {
        if let Some(embeds) = map.remove(&m.id) {
            m.embeds = embeds;
        }
    }
    Ok(())
}

async fn slice(
    db: &Db,
    cond: &str,
    key: i64,
    span: Span,
    edge: i64,
    min_ts: Option<i64>,
    limit: i64,
) -> Result<Vec<Message>, ApiError> {
    let (bound, order) = match span {
        Span::Before => ("m.id < $2", "DESC"),
        Span::From => ("m.id >= $2", "ASC"),
        Span::After => ("m.id > $2", "ASC"),
    };
    let sql = format!(
        "SELECT {COLS} FROM messages m WHERE {cond} AND {bound} AND m.created_at >= $3 AND {LIVE_AUTHOR} ORDER BY m.id {order} LIMIT $4"
    );
    let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(key)
        .bind(edge)
        .bind(min_ts.unwrap_or(i64::MIN))
        .bind(limit)
        .fetch_all(db)
        .await?;
    let mut msgs = rows_messages(db, &rows, Quotes::Since(min_ts)).await?;
    if let Span::Before = span {
        msgs.reverse();
    }
    Ok(msgs)
}

async fn page(
    db: &Db,
    cond: &str,
    key: i64,
    q: &PageQuery,
    min_ts: Option<i64>,
) -> Result<Vec<Message>, ApiError> {
    let PageQuery {
        before,
        after,
        around,
        limit,
    } = *q;
    let limit = limit.unwrap_or(LIST_PAGE).clamp(1, LIST_MAX);
    let mut msgs = match (around, after) {
        (Some(id), _) => {
            let older = limit / 2;
            let mut out = match older {
                0 => Vec::new(),
                n => slice(db, cond, key, Span::Before, id, min_ts, n).await?,
            };
            out.extend(slice(db, cond, key, Span::From, id, min_ts, limit - older).await?);
            out
        }
        (None, Some(id)) => slice(db, cond, key, Span::After, id, min_ts, limit).await?,
        (None, None) => {
            let edge = before.unwrap_or(i64::MAX);
            slice(db, cond, key, Span::Before, edge, min_ts, limit).await?
        }
    };
    attach_embeds(db, &mut msgs).await?;
    Ok(msgs)
}

/// Pinned messages of a channel (`m.channel_id`) or DM (`m.dm_id`), newest pin first, sent at or
/// after `floor`, with link previews and quotes the viewer may read.
pub(crate) async fn pinned_messages(
    db: &Db,
    channel_id: Option<i64>,
    dm_id: Option<i64>,
    floor: Option<i64>,
    limit: i64,
) -> Result<Vec<Message>, ApiError> {
    let (col, key) = match (channel_id, dm_id) {
        (Some(id), _) => ("m.channel_id", id),
        (None, Some(id)) => ("m.dm_id", id),
        (None, None) => return Ok(Vec::new()),
    };
    let sql = format!(
        "SELECT {COLS} FROM messages m WHERE {col} = $1 AND m.pinned_at IS NOT NULL AND m.thread_root_id IS NULL AND m.created_at >= $2 AND {LIVE_AUTHOR} ORDER BY m.pinned_at DESC, m.id DESC LIMIT $3"
    );
    let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(key)
        .bind(floor.unwrap_or(i64::MIN))
        .bind(limit)
        .fetch_all(db)
        .await?;
    let mut msgs = rows_messages(db, &rows, Quotes::Since(floor)).await?;
    attach_embeds(db, &mut msgs).await?;
    Ok(msgs)
}

/// The latest top-level messages for an invite preview, without quotes (no read-history floor
/// applies to the viewer).
pub(crate) async fn recent_channel_messages(
    db: &Db,
    channel_id: i64,
    limit: i64,
) -> Result<Vec<Message>, ApiError> {
    page(
        db,
        "m.channel_id = $1 AND m.thread_root_id IS NULL AND m.kind = 'user'",
        channel_id,
        &PageQuery {
            before: None,
            after: None,
            around: None,
            limit: Some(limit),
        },
        None,
    )
    .await
    .map(|msgs| {
        msgs.into_iter()
            .map(|m| Message {
                reply_to: None,
                ..m
            })
            .collect()
    })
}

async fn claim_media(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    id: &str,
    username: &str,
    spoiler: bool,
) -> Result<MediaRef, ApiError> {
    let claimed = sqlx::query("UPDATE media SET uploader = $1 WHERE id = $2 AND uploader = $1")
        .bind(username)
        .bind(id)
        .execute(&mut **tx)
        .await?
        .rows_affected();
    let row = sqlx::query("SELECT filename, uploaded_at FROM media WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?;
    let (filename, uploaded_at): (String, i64) = match &row {
        Some(r) => (r.try_get(0)?, r.try_get(1)?),
        None => {
            return Err(ApiError(
                StatusCode::BAD_REQUEST,
                "Unknown media".to_string(),
            ));
        }
    };
    if claimed == 0 {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "You can only attach files you uploaded".to_string(),
        ));
    }
    let attached =
        sqlx::query("SELECT 1 FROM messages WHERE media_id = $1 AND media_kind = 'server'")
            .bind(id)
            .fetch_optional(&mut **tx)
            .await?
            .is_some();
    if attached {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "This file is already attached to a message".to_string(),
        ));
    }
    Ok(MediaRef::server(
        id.to_string(),
        filename,
        spoiler,
        uploaded_at + MEDIA_TTL_SECS,
    ))
}

/// Largest P2P file size a client can describe exactly (2^53 - 1, JavaScript's safe integers).
const P2P_SIZE_MAX: i64 = (1 << 53) - 1;
const P2P_MIME_MAX: usize = 255;

fn attachments_off(what: &str) -> ApiError {
    ApiError(
        StatusCode::FORBIDDEN,
        format!("{what} are turned off on this server"),
    )
}

/// Whether the instance takes this kind of attachment: server files need uploads on, P2P files
/// need P2P attachments on; with both off nothing but text is accepted.
fn attachments_allowed(settings: &Settings, server: bool, p2p: bool) -> Result<(), ApiError> {
    match (server || p2p, settings.text_only()) {
        (true, true) => Err(attachments_off("Attachments")),
        (_, _) if server && !settings.asset_uploads => Err(attachments_off("File uploads")),
        (_, _) if p2p && !settings.p2p_attachments => Err(attachments_off("P2P attachments")),
        (_, _) => Ok(()),
    }
}

fn valid_sha256(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Checks a P2P attachment. Its id must not name a stored server file, so a P2P message can
/// never stand in as a reference to someone else's upload, nor a P2P file another user hosts,
/// so nobody can post their own bytes under someone else's attachment id.
async fn p2p_media(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    p2p: P2pAttachment,
    user: &User,
    spoiler: bool,
) -> Result<MediaRef, ApiError> {
    let P2pAttachment {
        filename,
        size,
        mime,
        sha256,
        p2p_id,
        expires_in_seconds,
    } = p2p;
    let valid_id = p2p_id.len() == 32 && p2p_id.chars().all(|c| c.is_ascii_hexdigit());
    let p2p_id = p2p_id.to_ascii_lowercase();
    if !valid_id {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Invalid p2p_id".to_string(),
        ));
    }
    let valid = (0..=P2P_SIZE_MAX).contains(&size)
        && mime.chars().count() <= P2P_MIME_MAX
        && !mime.chars().any(char::is_control)
        && sha256.as_deref().is_none_or(valid_sha256)
        && expires_in_seconds.is_none_or(|s| s > 0);
    if !valid {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Invalid P2P attachment".to_string(),
        ));
    }
    let taken = sqlx::query("SELECT 1 FROM media WHERE id = $1")
        .bind(&p2p_id)
        .fetch_optional(&mut **tx)
        .await?
        .is_some();
    let foreign = sqlx::query("SELECT 1 FROM messages WHERE media_kind = 'p2p' AND (media_id = $1 OR media_id = $2) AND media_hoster <> $3 LIMIT 1")
        .bind(&p2p_id)
        .bind(p2p_id.to_ascii_uppercase())
        .bind(&user.username)
        .fetch_optional(&mut **tx)
        .await?
        .is_some();
    if taken || foreign {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Invalid p2p_id".to_string(),
        ));
    }
    Ok(MediaRef {
        id: p2p_id,
        filename,
        kind: MediaKind::P2p,
        hoster: Some(user.username.clone()),
        expires_at: expires_in_seconds.map(|s| now().saturating_add(s)),
        size: Some(size),
        mime: Some(mime),
        sha256: sha256.map(|h| h.to_ascii_lowercase()),
        removed: false,
        removed_by_author: false,
        spoiler,
    })
}

/// Where a new message goes, for checking what it may reply to.
#[derive(Clone, Copy)]
enum Place {
    Channel(i64),
    Thread(i64),
    Dm(i64),
}

/// The message a reply quotes, checked.
struct Quoted {
    id: i64,
    author: String,
    mention: bool,
}

fn cannot_reply() -> ApiError {
    ApiError(
        StatusCode::BAD_REQUEST,
        "Cannot reply to that message".to_string(),
    )
}

/// Checks `reply_to` of a new message going to `place`: the sender must be able to read it
/// (through the access gate) and it must be a `user` message in the same channel (outside
/// threads), the same thread or its root, or the same DM. Every refusal is the same 400, so it
/// tells nothing about messages the sender cannot read.
async fn quoted(
    db: &Db,
    user: &User,
    place: Place,
    reply_to: Option<i64>,
    mention: bool,
) -> Result<Option<Quoted>, ApiError> {
    let Some(id) = reply_to else {
        return Ok(None);
    };
    let target = match resolve_message(db, id, Some(user), &Proof::none()).await {
        Ok(target) => target,
        Err(ApiError(StatusCode::INTERNAL_SERVER_ERROR, e)) => {
            return Err(ApiError(StatusCode::INTERNAL_SERVER_ERROR, e));
        }
        Err(_) => return Err(cannot_reply()),
    };
    let scope = target.scope();
    let here = match place {
        Place::Channel(cid) => scope.channel_id == Some(cid) && scope.thread_root_id.is_none(),
        Place::Thread(root) => {
            scope.channel_id.is_some() && (id == root || scope.thread_root_id == Some(root))
        }
        Place::Dm(did) => scope.dm_id == Some(did),
    };
    if !here {
        return Err(cannot_reply());
    }
    let kind: Option<String> = sqlx::query("SELECT kind FROM messages WHERE id = $1")
        .bind(id)
        .fetch_optional(db)
        .await?
        .map(|r| r.try_get(0))
        .transpose()?;
    if kind.as_deref() != Some("user") {
        return Err(cannot_reply());
    }
    Ok(Some(Quoted {
        id,
        mention: mention && scope.author != user.username,
        author: scope.author.clone(),
    }))
}

fn replied(quote: &Option<Quoted>) -> Option<&str> {
    quote
        .as_ref()
        .filter(|q| q.mention)
        .map(|q| q.author.as_str())
}

async fn insert_message(
    db: &Db,
    channel_id: Option<i64>,
    dm_id: Option<i64>,
    thread_root_id: Option<i64>,
    user: &User,
    req: SendReq,
    quote: Option<&Quoted>,
) -> Result<Message, ApiError> {
    let SendReq {
        content,
        media_id,
        media_spoiler,
        p2p,
        reply_to: _,
        mention_reply: _,
        forward_of: _,
    } = req;
    check_len(&content, MESSAGE_MAX, "Message")?;
    let spoiler = media_spoiler.unwrap_or(false);
    let settings = Settings::cached(db).await;
    attachments_allowed(&settings, media_id.is_some(), p2p.is_some())?;
    let mut tx = db.begin().await?;
    let media = match (&media_id, p2p) {
        (Some(_), Some(_)) => {
            return Err(ApiError(
                StatusCode::BAD_REQUEST,
                "Choose server or P2P attachment, not both".to_string(),
            ));
        }
        (Some(id), None) => Some(claim_media(&mut tx, id, &user.username, spoiler).await?),
        (None, Some(p2p)) => Some(p2p_media(&mut tx, p2p, user, spoiler).await?),
        (None, None) => None,
    };
    if let (Some(_), Some(media)) = (channel_id, &media) {
        settings.check_profanity(ProfanityTarget::FileNames, &media.filename)?;
    }
    if content.trim().is_empty() && media.is_none() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Message is empty".to_string(),
        ));
    }
    let t = now();
    let id: i64 = sqlx::query(
        "INSERT INTO messages(channel_id, dm_id, thread_root_id, author, content, media_id, media_filename, media_removed, media_spoiler, media_kind, media_hoster, media_expires_at, media_size, media_mime, media_sha256, reply_to, reply_mention, created_at) VALUES($1, $2, $3, $4, $5, $6, $7, 0, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING id",
    )
    .bind(channel_id)
    .bind(dm_id)
    .bind(thread_root_id)
    .bind(&user.username)
    .bind(&content)
    .bind(media.as_ref().map(|m| m.id.clone()))
    .bind(media.as_ref().map(|m| m.filename.clone()))
    .bind(spoiler as i64)
    .bind(media.as_ref().map_or(MediaKind::Server, |m| m.kind).as_str())
    .bind(media.as_ref().and_then(|m| m.hoster.clone()))
    .bind(media.as_ref().and_then(|m| m.expires_at))
    .bind(media.as_ref().and_then(|m| m.size))
    .bind(media.as_ref().and_then(|m| m.mime.clone()))
    .bind(media.as_ref().and_then(|m| m.sha256.clone()))
    .bind(quote.map(|q| q.id))
    .bind(quote.is_some_and(|q| q.mention) as i64)
    .bind(t)
    .fetch_one(&mut *tx)
    .await?
    .try_get(0)?;
    tx.commit().await?;
    let mut msgs = [Message {
        id,
        channel_id,
        dm_id,
        thread_root_id,
        author: UserRef::from_user(user),
        content,
        created_at: t,
        reply_count: 0,
        media,
        embeds: Vec::new(),
        kind: "user".to_string(),
        call: None,
        reactions: Vec::new(),
        reply_to: quote.map(|q| ReplyRef {
            id: q.id,
            author: None,
            content: String::new(),
            has_media: false,
            deleted: true,
            mention: q.mention,
            partial: false,
            forwarded: false,
        }),
        edited_at: None,
        forward: None,
        pinned_at: None,
        pin_message_id: None,
    }];
    attach_quotes(db, &mut msgs, None).await?;
    let [message] = msgs;
    Ok(message)
}

fn cannot_forward() -> ApiError {
    ApiError(
        StatusCode::BAD_REQUEST,
        "Cannot forward that message".to_string(),
    )
}

/// A message to forward, checked and read. `media` is the server-hosted attachment to share;
/// `dropped` names an attachment that is not forwarded (peer to peer).
struct Forwarded {
    id: i64,
    content: String,
    media: Option<MediaRef>,
    author: Option<String>,
    created_at: i64,
    origin: Option<String>,
    dropped: Option<String>,
}

/// Checks and reads `id` for a forward into `dest` (the destination's server, `None` for a
/// DM). The sender must be able to read it through the access gate and it must be a `user`
/// message with something left to forward. Every refusal is the same 400, so it tells nothing
/// about messages the sender cannot read. The origin label names a channel only inside its own
/// server (and only when everyone there may see it), and another server only when it has no
/// password.
async fn forwarded(
    db: &Db,
    user: &User,
    id: i64,
    dest: Option<&str>,
) -> Result<Forwarded, ApiError> {
    let source = match resolve_message(db, id, Some(user), &Proof::none()).await {
        Ok(source) => source,
        Err(ApiError(StatusCode::INTERNAL_SERVER_ERROR, e)) => {
            return Err(ApiError(StatusCode::INTERNAL_SERVER_ERROR, e));
        }
        Err(_) => return Err(cannot_forward()),
    };
    let origin = match (source.channel(), source.scope().dm_id) {
        (Some(channel), _) => {
            let server = channel.server();
            let display = server.lite().display_name.clone();
            match (dest == Some(server.name()), server.lite().has_password) {
                (true, _) => match channel.restricted(db).await? {
                    false => Some(format!("#{} · {display}", channel.name())),
                    true => Some(display),
                },
                (false, false) => Some(display),
                (false, true) => None,
            }
        }
        (None, Some(_)) => Some("Direct message".to_string()),
        (None, None) => return Err(cannot_forward()),
    };
    let row = sqlx::query("SELECT m.content, m.kind, m.media_id, m.media_filename, m.media_removed, m.media_spoiler, m.media_kind, m.media_hoster, m.media_expires_at, m.media_size, m.media_mime, m.author, m.created_at, CASE WHEN EXISTS(SELECT 1 FROM users fu WHERE fu.username = m.fwd_author AND fu.password_hash = '!purging') THEN NULL ELSE m.fwd_author END, m.fwd_created_at, m.fwd_dropped FROM messages m WHERE m.id = $1")
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(cannot_forward)?;
    if row.try_get::<String, _>(1)? != "user" {
        return Err(cannot_forward());
    }
    let content: String = row.try_get(0)?;
    let filename = row.try_get::<Option<String>, _>(3)?.unwrap_or_default();
    let uploads = Settings::cached(db).await.asset_uploads;
    let (media, dropped) = match (
        row.try_get::<Option<String>, _>(2)?,
        row.try_get::<i64, _>(4)?,
        MediaKind::parse(&row.try_get::<String, _>(6)?)?,
    ) {
        (Some(_), 0, MediaKind::Server) if !uploads => (None, Some(filename)),
        (Some(media_id), 0, MediaKind::Server) => {
            let stored = sqlx::query("SELECT 1 FROM media WHERE id = $1")
                .bind(&media_id)
                .fetch_optional(db)
                .await?
                .is_some();
            let media = MediaRef {
                id: media_id,
                filename,
                kind: MediaKind::Server,
                hoster: None,
                expires_at: row.try_get(8)?,
                size: row.try_get(9)?,
                mime: row.try_get(10)?,
                sha256: None,
                removed: false,
                removed_by_author: false,
                spoiler: row.try_get::<i64, _>(5)? != 0,
            };
            (stored.then_some(media), None)
        }
        (Some(_), 0, MediaKind::P2p) => (None, Some(filename)),
        (_, _, _) => (None, row.try_get::<Option<String>, _>(15)?),
    };
    if content.trim().is_empty() && media.is_none() && dropped.is_none() {
        return Err(cannot_forward());
    }
    let (author, created_at) = match row.try_get::<Option<i64>, _>(14)? {
        Some(created_at) => (row.try_get::<Option<String>, _>(13)?, created_at),
        None => (Some(row.try_get::<String, _>(11)?), row.try_get(12)?),
    };
    Ok(Forwarded {
        id,
        content,
        media,
        author,
        created_at,
        origin,
        dropped,
    })
}

/// Stores the forwarded copy and copies the original's link previews. Returns the message and
/// whether the original had any previews (otherwise the copy's links are resolved anew).
async fn insert_forward(
    db: &Db,
    channel_id: Option<i64>,
    dm_id: Option<i64>,
    thread_root_id: Option<i64>,
    user: &User,
    fwd: Forwarded,
) -> Result<(Message, bool), ApiError> {
    let Forwarded {
        id: source_id,
        content,
        media,
        author,
        created_at,
        origin,
        dropped,
    } = fwd;
    if channel_id.is_some() {
        let settings = Settings::cached(db).await;
        settings.check_profanity(ProfanityTarget::Messages, &content)?;
        if let Some(media) = &media {
            settings.check_profanity(ProfanityTarget::FileNames, &media.filename)?;
        }
    }
    let t = now();
    let mut tx = db.begin().await?;
    let (media, dropped) = match media {
        Some(media)
            if !crate::api::media::may_carry(
                &mut tx,
                crate::db::is_sqlite(db),
                &media.id,
                &user.username,
            )
            .await? =>
        {
            (None, Some(media.filename))
        }
        media => (media, dropped),
    };
    let id: i64 = sqlx::query(
        "INSERT INTO messages(channel_id, dm_id, thread_root_id, author, content, media_id, media_filename, media_removed, media_spoiler, media_kind, media_hoster, media_expires_at, media_size, media_mime, fwd_author, fwd_created_at, fwd_source_id, fwd_origin, fwd_dropped, created_at) VALUES($1, $2, $3, $4, $5, $6, $7, 0, $8, 'server', NULL, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING id",
    )
    .bind(channel_id)
    .bind(dm_id)
    .bind(thread_root_id)
    .bind(&user.username)
    .bind(&content)
    .bind(media.as_ref().map(|m| m.id.clone()))
    .bind(media.as_ref().map(|m| m.filename.clone()))
    .bind(media.as_ref().is_some_and(|m| m.spoiler) as i64)
    .bind(media.as_ref().and_then(|m| m.expires_at))
    .bind(media.as_ref().and_then(|m| m.size))
    .bind(media.as_ref().and_then(|m| m.mime.clone()))
    .bind(&author)
    .bind(created_at)
    .bind(source_id)
    .bind(&origin)
    .bind(&dropped)
    .bind(t)
    .fetch_one(&mut *tx)
    .await?
    .try_get(0)?;
    let previews = sqlx::query("INSERT INTO message_embeds(message_id, ord, url, banner_removed, removed) SELECT $1, ord, url, banner_removed, removed FROM message_embeds WHERE message_id = $2")
        .bind(id)
        .bind(source_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    tx.commit().await?;
    let refs = user_refs(db, author.as_slice()).await;
    let mut msgs = [Message {
        id,
        channel_id,
        dm_id,
        thread_root_id,
        author: UserRef::from_user(user),
        content,
        created_at: t,
        reply_count: 0,
        media,
        embeds: Vec::new(),
        kind: "user".to_string(),
        call: None,
        reactions: Vec::new(),
        reply_to: None,
        edited_at: None,
        forward: Some(ForwardRef {
            author: author.as_ref().map(|a| user_from(&refs, a)),
            created_at,
            source_id,
            origin,
            dropped,
        }),
        pinned_at: None,
        pin_message_id: None,
    }];
    attach_embeds(db, &mut msgs).await?;
    let [message] = msgs;
    Ok((message, previews > 0))
}

/// Where a message is, as far as the caller can read it.
#[derive(Serialize, ToSchema)]
pub struct MessageLocation {
    /// Lowercase name of the message's server; `null` for a DM message.
    #[schema(example = "rust")]
    pub server: Option<String>,
    /// The channel; `null` for a DM message.
    pub channel_id: Option<i64>,
    /// The DM conversation; `null` for a channel message.
    pub dm_id: Option<i64>,
    /// For a thread reply, the thread's root message; `null` otherwise.
    pub thread_root_id: Option<i64>,
}

/// Locate a message
///
/// Tells where a message is (server and channel, thread, or DM), for opening it from a
/// forwarded copy. Access is checked exactly like reading the message: guests are allowed when
/// guest access is on (with `X-Guest-Grant` for password-protected servers), signed-in callers
/// need to be able to read it (a server without a password can be read without joining).
/// Every refusal is the same `404 Not found` as for an id that does not exist. General
/// rate-limit bucket.
#[utoipa::path(get, path = "/api/messages/{id}/location", tag = "Messages", params(("id" = i64, Path, description = "Message id")), responses((status = 200, description = "Where the message is", body = MessageLocation), (status = 400, description = "Non-numeric id (plain-text framework error)", content_type = "text/plain", body = String), (status = 401, description = "No valid token and guest access is disabled (`Guest access is disabled`)", body = ApiErrorBody), (status = 404, description = "`Not found`: no such message, its author's account is being deleted, or you cannot read it (hidden channel, before your join without read history, a server you have no access to, or a DM you are not in); identical responses", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security((), ("bearer" = [])))]
pub(crate) async fn message_location(
    State(state): State<AppState>,
    MaybeAuthed(user): MaybeAuthed,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<MessageLocation>, ApiError> {
    let db = &state.read();
    require_guest_ok(db, user.as_ref()).await?;
    let message = resolve_message(db, id, user.as_ref(), &Proof::headers(&headers)).await?;
    let crate::api::access::MsgScope {
        channel_id,
        dm_id,
        thread_root_id,
        kind: _,
        author: _,
        media_id: _,
        media_filename: _,
        media_kind: _,
        server,
        dm_users: _,
    } = message.into_scope();
    if channel_id.is_none() && dm_id.is_none() {
        return Err(crate::api::access::not_found());
    }
    Ok(Json(MessageLocation {
        server,
        channel_id,
        dm_id,
        thread_root_id,
    }))
}

/// List channel messages
///
/// Returns the top-level messages of a text channel, oldest first, with link previews. Thread
/// replies are not included (see `reply_count`). Page by message id with `before`, `after` or
/// `around`. Works with a bearer token, or for guests when guest access is on.
/// Password-protected servers need membership, or for guests a valid `X-Guest-Grant`. Banned
/// users are refused. All refusals are the same `404 Not found` as for an unknown channel.
/// Channels with permission overrides need the view permission (guests never see them). Without
/// read-history access, you get only messages posted after you joined (none if you are not a
/// member). General rate-limit bucket.
#[utoipa::path(get, path = "/api/channels/{id}/messages", tag = "Messages", params(("id" = i64, Path, description = "Channel id"), PageQuery), responses((status = 200, description = "Up to `limit` (default 50, max 100) top-level messages, oldest first: the newest ones before `before` (or the latest), or with `after` the oldest ones after that id, or with `around` a window of `limit / 2` messages before that id followed by the message itself and newer ones (`around` wins over `after`, which wins over `before`); without read-history access only messages since joining are returned", body = Vec<Message>), (status = 400, description = "Non-numeric id or paging parameter (plain-text framework error)", content_type = "text/plain", body = String), (status = 401, description = "No valid token and guest access is disabled (`Guest access is disabled`)", body = ApiErrorBody), (status = 404, description = "`Not found`: no such channel, a channel you cannot see, or one in a server you have no access to (password-protected without access, or banned); identical responses", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security((), ("bearer" = [])))]
pub(crate) async fn channel_messages(
    State(state): State<AppState>,
    MaybeAuthed(user): MaybeAuthed,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<PageQuery>,
) -> Result<Json<Vec<Message>>, ApiError> {
    let db = &state.read();
    require_guest_ok(db, user.as_ref()).await?;
    let channel = resolve_channel(db, id, user.as_ref(), &Proof::headers(&headers)).await?;
    let min_ts = channel.read_since(db).await?;
    let mut msgs = page(
        db,
        "m.channel_id = $1 AND m.thread_root_id IS NULL",
        id,
        &q,
        min_ts,
    )
    .await?;
    attach_reactions(db, &mut msgs, user.as_ref()).await?;
    Ok(Json(msgs))
}

/// Post a channel message
///
/// Posts a top-level message with an optional attachment (an uploaded file with `media_id` or a
/// P2P file with `p2p`). Requires a bearer token. The profanity filter checks the text when it is
/// on. In server channels, needs membership and the send permission. With slow mode, members
/// without Manage channels or Manage messages wait `slowmode_seconds` between messages in the
/// channel (thread replies count). Voice channels take no messages. Emits `message` to clients in
/// the server that can see the channel. If the text has links, `embeds_resolved` follows when the
/// previews are fetched. Each `@username` outside code pings that user if they are a member who
/// can see the channel (at most 20 users, not yourself). The ping is stored for
/// `GET /api/unreads` and sent as a `ping` event. `reply_to` quotes a top-level message of the
/// channel. With `mention_reply` (default), its author gets one `reply` ping instead. With
/// `forward_of`, the message is a copy of a message you can read (see `SendReq`). Forwards never
/// ping. General rate-limit bucket.
#[utoipa::path(post, path = "/api/channels/{id}/messages", tag = "Messages", params(("id" = i64, Path, description = "Channel id")), request_body = SendReq, responses((status = 200, description = "The posted message; link previews arrive later as an `embeds_resolved` WebSocket event", body = Message), (status = 400, description = "Blocked by the profanity filter (text or attachment file name), voice channel, text over 4000 characters, empty message without attachment, both `media_id` and `p2p`, unknown or already attached `media_id`, an invalid `p2p` attachment, a `reply_to` you cannot reply to (`Cannot reply to that message`), or a `forward_of` you cannot forward (`Cannot forward that message`); both are the same for ids that do not exist. A non-numeric id, malformed JSON or a missing `Content-Type` give plain-text 400/415 framework errors", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 403, description = "Not a member of the channel's server, no permission to send in the channel, or `media_id` was uploaded by someone else, or that kind of attachment is turned off (`File uploads are turned off on this server`, `P2P attachments are turned off on this server`, or `Attachments are turned off on this server` when both are off)", body = ApiErrorBody), (status = 404, description = "`Not found`: no such channel, a channel you cannot see, or one in a server you have no access to (password-protected without access, or banned); identical responses", body = ApiErrorBody), (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String), (status = 429, description = "Slow mode: the channel has `slowmode_seconds` and you posted in it (including thread replies) less than that long ago; JSON `Slow mode: wait Ns`. Or too many requests in the general bucket (plain text `Too Many Requests! Wait for Ns`)", content((ApiErrorBody = "application/json"), (String = "text/plain")))), security(("bearer" = [])))]
pub(crate) async fn send_channel_message(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Authed(user): Authed,
    Json(req): Json<SendReq>,
) -> Result<Json<Message>, ApiError> {
    if req.forward_of.is_none() {
        check_profanity(&state.db, ProfanityTarget::Messages, &req.content).await?;
    }
    let channel = resolve_channel(&state.db, id, Some(&user), &Proof::none()).await?;
    channel.send_gate(&state.db).await?;
    let server = channel.server().name().to_string();
    let (message, quote, previews) = match req.forward_of {
        Some(source) => {
            let fwd = forwarded(&state.db, &user, source, Some(&server)).await?;
            let (message, previews) =
                insert_forward(&state.db, Some(id), None, None, &user, fwd).await?;
            (message, None, previews)
        }
        None => {
            let quote = quoted(
                &state.db,
                &user,
                Place::Channel(id),
                req.reply_to,
                req.mention_reply,
            )
            .await?;
            let message =
                insert_message(&state.db, Some(id), None, None, &user, req, quote.as_ref()).await?;
            (message, quote, false)
        }
    };
    touch_interaction(&state.db, &server, &user.username).await?;
    if !previews {
        embeds::spawn_unfurl(
            &state,
            Some(server.clone()),
            Some(id),
            None,
            None,
            message.id,
            &message.content,
        );
    }
    state.hub.broadcast(WsEvent::Message {
        server: Some(server),
        channel_id: Some(id),
        dm_id: None,
        dm_users: None,
        message: Box::new(partial_quote(message.clone())),
    });
    if message.forward.is_none() {
        ping_message(
            &state,
            PingScope::Channel(&channel),
            &message,
            &user,
            replied(&quote),
        )
        .await;
    }
    Ok(Json(message))
}

/// List thread replies
///
/// Returns the replies to a top-level channel message, oldest first, with link previews.
/// Access is checked on the root's channel exactly as for `GET /api/channels/{id}/messages`
/// (guests allowed when guest access is on, password-protected servers, bans, channel view
/// and read-history permissions). General rate-limit bucket.
#[utoipa::path(get, path = "/api/messages/{id}/thread", tag = "Threads", params(("id" = i64, Path, description = "Id of the thread's root message"), PageQuery), responses((status = 200, description = "Up to `limit` (default 50, max 100) thread replies, oldest first, paged with `before`, `after` or `around` like channel messages; without read-history access only replies since joining are returned", body = Vec<Message>), (status = 400, description = "The message is a DM message or itself a thread reply (`Threads only start on channel messages`). A non-numeric id or paging parameter gives a plain-text 400", body = ApiErrorBody), (status = 401, description = "No valid token and guest access is disabled (`Guest access is disabled`)", body = ApiErrorBody), (status = 404, description = "`Not found`: no such message, its author's account is being deleted, or you cannot read it (hidden channel, before your join without read history, a server you have no access to, or a DM you are not in); identical responses", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security((), ("bearer" = [])))]
pub(crate) async fn thread_messages(
    State(state): State<AppState>,
    MaybeAuthed(user): MaybeAuthed,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<PageQuery>,
) -> Result<Json<Vec<Message>>, ApiError> {
    let db = &state.read();
    require_guest_ok(db, user.as_ref()).await?;
    let root = resolve_message(db, id, user.as_ref(), &Proof::headers(&headers)).await?;
    let min_ts = root.thread_channel()?.read_since(db).await?;
    let mut msgs = page(db, "m.thread_root_id = $1", id, &q, min_ts).await?;
    attach_reactions(db, &mut msgs, user.as_ref()).await?;
    Ok(Json(msgs))
}

/// Reply in a thread
///
/// Posts a reply to a top-level channel message and starts the thread if needed. The reply is in
/// the channel of the root and has `thread_root_id` set. Requires a bearer token. The profanity
/// filter checks the text when it is on. In server channels, needs membership and the send
/// permission. With slow mode, members without Manage channels or Manage messages wait
/// `slowmode_seconds` between messages in the channel (thread replies count). Emits `message` to
/// clients in the server that can see the channel. If the text has links, `embeds_resolved`
/// follows when the previews are fetched. Each `@username` outside code pings that user if they
/// are a member who can see the channel (at most 20 users, not yourself). The ping is stored for
/// `GET /api/unreads` and sent as a `ping` event. `reply_to` can quote the root or another reply
/// of the thread. With `mention_reply` (default), its author gets a `reply` ping instead of a
/// mention ping. With `forward_of`, the reply is a copy of a message you can read (see `SendReq`)
/// and pings nobody. General rate-limit bucket.
#[utoipa::path(post, path = "/api/messages/{id}/thread", tag = "Threads", params(("id" = i64, Path, description = "Id of the thread's root message")), request_body = SendReq, responses((status = 200, description = "The posted thread reply; link previews arrive later as an `embeds_resolved` WebSocket event", body = Message), (status = 400, description = "The root is a DM message or itself a reply, blocked by the profanity filter (text or attachment file name), text over 4000 characters, empty message without attachment, both `media_id` and `p2p`, unknown or already attached `media_id`, an invalid `p2p` attachment, a `reply_to` you cannot reply to (`Cannot reply to that message`), or a `forward_of` you cannot forward (`Cannot forward that message`); both are the same for ids that do not exist. A non-numeric id, malformed JSON or a missing `Content-Type` give plain-text 400/415 framework errors", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 403, description = "Not a member of the server, no permission to send in the channel, or `media_id` was uploaded by someone else, or that kind of attachment is turned off (`File uploads are turned off on this server`, `P2P attachments are turned off on this server`, or `Attachments are turned off on this server` when both are off)", body = ApiErrorBody), (status = 404, description = "`Not found`: no such message, its author's account is being deleted, or you cannot read it (hidden channel, before your join without read history, a server you have no access to, or a DM you are not in); identical responses", body = ApiErrorBody), (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String), (status = 429, description = "Slow mode: the channel has `slowmode_seconds` and you posted in it (including thread replies) less than that long ago; JSON `Slow mode: wait Ns`. Or too many requests in the general bucket (plain text `Too Many Requests! Wait for Ns`)", content((ApiErrorBody = "application/json"), (String = "text/plain")))), security(("bearer" = [])))]
pub(crate) async fn send_thread_message(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Authed(user): Authed,
    Json(req): Json<SendReq>,
) -> Result<Json<Message>, ApiError> {
    let root = resolve_message(&state.db, id, Some(&user), &Proof::none()).await?;
    let channel = root.thread_channel()?;
    if req.forward_of.is_none() {
        check_profanity(&state.db, ProfanityTarget::Messages, &req.content).await?;
    }
    channel.send_gate(&state.db).await?;
    let (channel_id, server) = (channel.id(), channel.server().name().to_string());
    let (message, quote, previews) = match req.forward_of {
        Some(source) => {
            let fwd = forwarded(&state.db, &user, source, Some(&server)).await?;
            let (message, previews) =
                insert_forward(&state.db, Some(channel_id), None, Some(id), &user, fwd).await?;
            (message, None, previews)
        }
        None => {
            let quote = quoted(
                &state.db,
                &user,
                Place::Thread(id),
                req.reply_to,
                req.mention_reply,
            )
            .await?;
            let message = insert_message(
                &state.db,
                Some(channel_id),
                None,
                Some(id),
                &user,
                req,
                quote.as_ref(),
            )
            .await?;
            (message, quote, false)
        }
    };
    touch_interaction(&state.db, &server, &user.username).await?;
    if !previews {
        embeds::spawn_unfurl(
            &state,
            Some(server.clone()),
            Some(channel_id),
            None,
            None,
            message.id,
            &message.content,
        );
    }
    state.hub.broadcast(WsEvent::Message {
        server: Some(server),
        channel_id: Some(channel_id),
        dm_id: None,
        dm_users: None,
        message: Box::new(partial_quote(message.clone())),
    });
    if message.forward.is_none() {
        ping_message(
            &state,
            PingScope::Channel(channel),
            &message,
            &user,
            replied(&quote),
        )
        .await;
    }
    Ok(Json(message))
}

/// List DM messages
///
/// Returns messages of a direct-message conversation, oldest first, with link previews.
/// Requires a bearer token and being one of the two participants. General rate-limit bucket.
#[utoipa::path(get, path = "/api/dms/{id}/messages", tag = "Direct messages", params(("id" = i64, Path, description = "DM conversation id"), PageQuery), responses((status = 200, description = "Up to `limit` (default 50, max 100) DM messages, oldest first, paged with `before`, `after` or `around` like channel messages", body = Vec<Message>), (status = 400, description = "Non-numeric id or paging parameter (plain-text framework error)", content_type = "text/plain", body = String), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 404, description = "`Not found`: no such DM, you are not a participant, or a participant's account is being deleted; identical responses", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn dm_messages(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Authed(user): Authed,
    Query(q): Query<PageQuery>,
) -> Result<Json<Vec<Message>>, ApiError> {
    let db = &state.read();
    resolve_dm(db, id, &user).await?;
    let mut msgs = page(db, "m.dm_id = $1", id, &q, None).await?;
    attach_reactions(db, &mut msgs, Some(&user)).await?;
    Ok(Json(msgs))
}

/// Send a DM message
///
/// Posts a message, optionally with one attachment, in a direct-message conversation.
/// Requires a bearer token and being one of the two participants. Unlike server channels,
/// DM text and attachment names are not checked by the profanity filter and there is no slow
/// mode. Emits `message` to both participants; when the text has links, `embeds_resolved`
/// follows once previews are fetched. `@username` of the other participant pings them (`ping`
/// event). `reply_to` may quote a message of the same conversation; with `mention_reply`
/// (default) its author gets a `reply` ping instead. With `forward_of` the message is a copy
/// of a message you can read (see `SendReq`) and pings nobody. General rate-limit bucket.
#[utoipa::path(post, path = "/api/dms/{id}/messages", tag = "Direct messages", params(("id" = i64, Path, description = "DM conversation id")), request_body = SendReq, responses((status = 200, description = "The posted DM message; link previews arrive later as an `embeds_resolved` WebSocket event", body = Message), (status = 400, description = "Text over 4000 characters, empty message without attachment, both `media_id` and `p2p`, unknown or already attached `media_id`, an invalid `p2p` attachment, a `reply_to` you cannot reply to (`Cannot reply to that message`), or a `forward_of` you cannot forward (`Cannot forward that message`); both are the same for ids that do not exist. A non-numeric id, malformed JSON or a missing `Content-Type` give plain-text 400/415 framework errors", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 403, description = "`media_id` was uploaded by someone else, or that kind of attachment is turned off (`File uploads are turned off on this server`, `P2P attachments are turned off on this server`, or `Attachments are turned off on this server` when both are off)", body = ApiErrorBody), (status = 404, description = "`Not found`: no such DM, you are not a participant, or a participant's account is being deleted; identical responses", body = ApiErrorBody), (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn send_dm_message(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Authed(user): Authed,
    Json(req): Json<SendReq>,
) -> Result<Json<Message>, ApiError> {
    let users = resolve_dm(&state.db, id, &user).await?;
    let (message, quote, previews) = match req.forward_of {
        Some(source) => {
            let fwd = forwarded(&state.db, &user, source, None).await?;
            let (message, previews) =
                insert_forward(&state.db, None, Some(id), None, &user, fwd).await?;
            (message, None, previews)
        }
        None => {
            let quote = quoted(
                &state.db,
                &user,
                Place::Dm(id),
                req.reply_to,
                req.mention_reply,
            )
            .await?;
            let message =
                insert_message(&state.db, None, Some(id), None, &user, req, quote.as_ref()).await?;
            (message, quote, false)
        }
    };
    if !previews {
        embeds::spawn_unfurl(
            &state,
            None,
            None,
            Some(id),
            Some(users.clone()),
            message.id,
            &message.content,
        );
    }
    state.hub.broadcast(WsEvent::Message {
        server: None,
        channel_id: None,
        dm_id: Some(id),
        dm_users: Some(users.clone()),
        message: Box::new(partial_quote(message.clone())),
    });
    if message.forward.is_none() {
        ping_message(
            &state,
            PingScope::Dm { id, users: &users },
            &message,
            &user,
            replied(&quote),
        )
        .await;
    }
    Ok(Json(message))
}

/// Delete a message
///
/// Permanently deletes a channel, thread or DM message; deleting a thread root also deletes
/// its replies. Pings on the deleted messages are removed; each affected user gets
/// `ping_count` with the scope's new unseen count. Requires a bearer token. The author may
/// always delete their own message; in servers, members with the Manage messages permission
/// may delete anyone's. Emits `message_deleted` (with `thread_root_id` for replies) to clients
/// in the server that can see the channel, or to both DM participants. General rate-limit
/// bucket.
#[utoipa::path(delete, path = "/api/messages/{id}", tag = "Messages", params(("id" = i64, Path, description = "Message id")), responses((status = 200, description = "Deleted; body `{\"ok\": true}`", body = crate::api::servers::OkResp), (status = 400, description = "Non-numeric id (plain-text framework error)", content_type = "text/plain", body = String), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 403, description = "Not the author and no Manage messages permission in the server (in DMs only the author may delete)", body = ApiErrorBody), (status = 404, description = "`Not found`: no such message, its author's account is being deleted, or you cannot read it (hidden channel, before your join without read history, a server you have no access to, or a DM you are not in); identical responses", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn delete_message(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Authed(user): Authed,
) -> Result<Json<serde_json::Value>, ApiError> {
    let message = resolve_message(&state.db, id, Some(&user), &Proof::none()).await?;
    message.require_can_delete(&state.db).await?;
    let scope = message.into_scope();
    let pinged = pinged_by(&state.db, id).await?;
    sqlx::query("DELETE FROM messages WHERE id = $1")
        .bind(id)
        .execute(&state.db)
        .await?;
    announce_counts(&state, pinged).await;
    let crate::api::access::MsgScope {
        channel_id,
        dm_id,
        thread_root_id,
        kind: _,
        author: _,
        media_id: _,
        media_filename: _,
        media_kind: _,
        server,
        dm_users,
    } = scope;
    state.hub.broadcast(WsEvent::MessageDeleted {
        server,
        channel_id,
        dm_id,
        dm_users,
        id,
        thread_root_id,
    });
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// New text for a message.
#[derive(Deserialize, ToSchema)]
pub struct EditReq {
    /// The new text, at most 4000 characters (Unicode code points). It may only be blank when
    /// the message has an attachment.
    #[schema(example = "Hello again")]
    content: String,
}

/// Edit a message
///
/// Replaces the text of your own message and sets `edited_at`. Requires a bearer token. Only the
/// author can edit, only `user` messages (not call logs), and only while the author can still
/// send there: in server channels, membership and the send permission (slow mode does not
/// apply); in DMs, being a participant. The text is checked like a new message (length, blank
/// text without attachment, profanity filter in server channels). The same text again changes
/// nothing. Edits never ping and keep the reply quote, reactions and attachment. If the links
/// change, old link previews are removed and new ones are fetched. In server channels, clients
/// that can see the channel get a `message_updated` stub without content (`id`,
/// `thread_root_id`, `edited_at`, `stub: true`; sent again when new previews are stored). They
/// read the message again through the message list (`around=id`), which applies the
/// read-history rules. In DMs, both participants get `message_updated` with the full message, and
/// new previews as `embeds_resolved`. General rate-limit bucket.
#[utoipa::path(patch, path = "/api/messages/{id}", tag = "Messages", params(("id" = i64, Path, description = "Message id")), request_body = EditReq, responses((status = 200, description = "The edited message", body = Message), (status = 400, description = "Blocked by the profanity filter, text over 4000 characters, blank text on a message without attachment (`Message is empty`), or not a user message (`Cannot edit this message`). A non-numeric id, malformed JSON or a missing `Content-Type` give plain-text 400/415 framework errors", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 403, description = "Not your message (`You can only edit your own messages`), no longer a member of the server, or no permission to send in the channel", body = ApiErrorBody), (status = 404, description = "`Not found`: no such message, its author's account is being deleted, or you cannot read it (hidden channel, before your join without read history, a server you have no access to, or a DM you are not in); identical responses", body = ApiErrorBody), (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String), (status = 429, description = "Too many requests in the general bucket (plain text), or `Too many attempts. Try again later` (JSON) after more than 30 reactions, pins and edits in 10 seconds", content((ApiErrorBody = "application/json"), (String = "text/plain")))), security(("bearer" = [])))]
pub(crate) async fn edit_message(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Authed(user): Authed,
    Json(req): Json<EditReq>,
) -> Result<Json<Message>, ApiError> {
    let EditReq { content } = req;
    let message = resolve_message(&state.db, id, Some(&user), &Proof::none()).await?;
    message.edit_gate(&state.db).await?;
    let row = sqlx::query(
        "SELECT content, kind, media_removed, fwd_source_id FROM messages WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(crate::api::access::not_found)?;
    let (old, kind, media_removed): (String, String, i64) =
        (row.try_get(0)?, row.try_get(1)?, row.try_get(2)?);
    if kind != "user" || row.try_get::<Option<i64>, _>(3)?.is_some() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Cannot edit this message".to_string(),
        ));
    }
    check_len(&content, MESSAGE_MAX, "Message")?;
    let attached = message.scope().media_id.is_some() && media_removed == 0;
    if content.trim().is_empty() && !attached {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Message is empty".to_string(),
        ));
    }
    if message.channel().is_some() {
        check_profanity(&state.db, ProfanityTarget::Messages, &content).await?;
    }
    let floor = match message.channel() {
        Some(channel) => channel.read_since(&state.db).await?,
        None => None,
    };
    if content != old {
        let relink = embeds::extract_urls(&content) != embeds::extract_urls(&old);
        let mut tx = state.db.begin().await?;
        sqlx::query("UPDATE messages SET content = $1, edited_at = $2 WHERE id = $3")
            .bind(&content)
            .bind(now())
            .bind(id)
            .execute(&mut *tx)
            .await?;
        if relink {
            sqlx::query("DELETE FROM message_embeds WHERE message_id = $1")
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        let crate::api::access::MsgScope {
            channel_id,
            dm_id,
            thread_root_id: _,
            kind: _,
            author: _,
            media_id: _,
            media_filename: _,
            media_kind: _,
            server,
            dm_users,
        } = message.into_scope();
        if relink {
            embeds::spawn_unfurl(
                &state,
                server.clone(),
                channel_id,
                dm_id,
                dm_users.clone(),
                id,
                &content,
            );
        }
        if let Some(updated) = load_broadcast(&state.db, id).await? {
            let update = match server {
                Some(_) => Updated::stub(id, updated.thread_root_id, updated.edited_at),
                None => Updated::full(updated),
            };
            state.hub.broadcast(WsEvent::MessageUpdated {
                server,
                channel_id,
                update,
                dm_users: dm_users.unwrap_or_default(),
            });
        }
    }
    let Some(edited) = load_message(&state.db, id, Quotes::Since(floor)).await? else {
        return Err(crate::api::access::not_found());
    };
    let mut msgs = [edited];
    attach_embeds(&state.db, &mut msgs).await?;
    attach_reactions(&state.db, &mut msgs, Some(&user)).await?;
    let [edited] = msgs;
    Ok(Json(edited))
}

enum Bind {
    S(String),
    I(i64),
}

const SEARCH_PAGE: i64 = 25;
const FTS_MIN_CHARS: usize = 3;

fn fts_phrase(text: &str) -> String {
    format!("\"{}\"", text.replace('"', "\"\""))
}

const SEARCH_OFFSET_MAX: i64 = 500;
const SEARCH_WINDOW: i64 = 4096;
const LIKE_BUDGET: i64 = 250_000;
const FTS_BATCH: i64 = 500;
const FTS_ROUNDS: usize = 8;

/// Search messages
///
/// Searches channel messages (including thread replies; DMs are never searched), newest
/// first, with link previews. Signed-in callers search the servers they are members of,
/// skipping channels they cannot view and, without read-history access, messages from before
/// they joined. Guests (allowed when guest access is on) search only the servers listed in
/// `servers`, only channels without permission overrides, and only servers without a password
/// or with a valid grant in `X-Guest-Grant` (invalid grants are ignored). Messages by accounts
/// being deleted are left out. General rate-limit bucket.
#[utoipa::path(get, path = "/api/search", tag = "Search", params(SearchQuery), responses((status = 200, description = "Up to 25 messages from channels the caller can view whose content contains `q` (case-insensitive), newest first; `before`/`after` bound the message id and `before_ts`/`after_ts` bound `created_at` (exclusive, unix seconds). When more results may follow, the `X-Next-Cursor` response header holds a `cursor` for the next page (it is absent once the search reached the oldest message); a page can hold fewer than 25 results and still have a next cursor. Passing the oldest returned id as `before` also works when the page is full. The legacy `offset` is capped at 500. Guests pass the servers to search as repeated `servers` params (`servers=a&servers=b`, max 100)", body = Vec<SearchResult>, headers(("x-next-cursor" = String, description = "Cursor for the next page; absent on the last page"))), (status = 400, description = "Invalid number or cursor, or text containing a NUL character", body = ApiErrorBody), (status = 401, description = "No valid token and guest access is disabled", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security((), ("bearer" = [])))]
pub(crate) async fn search(
    State(state): State<AppState>,
    MaybeAuthed(user): MaybeAuthed,
    headers: HeaderMap,
    RawQuery(raw): RawQuery,
) -> Result<Paged<SearchResult>, ApiError> {
    let sq = SearchQuery::parse(raw.as_deref().unwrap_or(""))?;
    let (results, next) = search_paged(&state, user.as_ref(), &headers, sq).await?;
    Ok(Paged(
        results,
        next.map(|id| encode_cursor(&[&id.to_string()])),
    ))
}

#[cfg(test)]
async fn search_with(
    state: &AppState,
    user: Option<&User>,
    headers: &HeaderMap,
    sq: SearchQuery,
) -> Result<Vec<SearchResult>, ApiError> {
    Ok(search_paged(state, user, headers, sq).await?.0)
}

async fn search_paged(
    state: &AppState,
    user: Option<&User>,
    headers: &HeaderMap,
    mut sq: SearchQuery,
) -> Result<(Vec<SearchResult>, Option<i64>), ApiError> {
    let db = &state.read();
    require_guest_ok(db, user).await?;
    check_nul([&sq.q, &sq.server, &sq.from, &sq.has], &sq.servers)?;
    if let Some(raw) = sq.cursor.take() {
        sq.before = Some(cursor_int(&decode_cursor(&raw, 1)?[0])?);
        sq.offset = None;
    }
    sq.offset = sq.offset.map(|n| n.min(SEARCH_OFFSET_MAX));
    let text = sq.q.as_deref().map(str::trim).unwrap_or("");
    let short = text.chars().count() < FTS_MIN_CHARS || !has_fts(db);
    let unscoped = sq.server.is_none() && sq.channel_id.is_none();
    let first_page = sq.offset.is_none_or(|n| n <= 0);
    if !text.is_empty() && !short && is_sqlite(db) && first_page {
        let phrase = fts_phrase(text);
        return fts_paged(db, user, headers, sq, &phrase).await;
    }
    let windowed = !text.is_empty() && (short || unscoped) && is_sqlite(db) && first_page;
    let budget = match short {
        true => LIKE_BUDGET,
        false => i64::MAX,
    };
    if !windowed {
        let results = search_once(db, user, headers, sq, None, SEARCH_PAGE).await?;
        let next = match results.len() as i64 == SEARCH_PAGE {
            true => results.last().map(|r| r.message.id),
            false => None,
        };
        return Ok((results, next));
    }
    let floor = sq.after.unwrap_or(0).max(0);
    let mut hi = match sq.before {
        Some(b) => b,
        None => {
            sqlx::query("SELECT MAX(id) FROM messages")
                .fetch_one(db)
                .await?
                .try_get::<Option<i64>, _>(0)?
                .unwrap_or(0)
                + 1
        }
    };
    let mut size = SEARCH_WINDOW;
    let mut scanned = 0i64;
    let mut results: Vec<SearchResult> = Vec::new();
    while (results.len() as i64) < SEARCH_PAGE && hi > floor + 1 && scanned < budget {
        let lo = hi.saturating_sub(size).max(floor + 1);
        let want = SEARCH_PAGE - results.len() as i64;
        let page = search_once(db, user, headers, sq.clone(), Some((lo, hi)), want).await?;
        results.extend(page);
        scanned = scanned.saturating_add(hi - lo);
        hi = lo;
        size = size.saturating_mul(8);
    }
    let next = match (results.len() as i64 == SEARCH_PAGE, hi > floor + 1) {
        (true, _) => results.last().map(|r| r.message.id),
        (false, true) => Some(hi),
        (false, false) => None,
    };
    Ok((results, next))
}

async fn fts_paged(
    db: &Db,
    user: Option<&User>,
    headers: &HeaderMap,
    sq: SearchQuery,
    phrase: &str,
) -> Result<(Vec<SearchResult>, Option<i64>), ApiError> {
    let floor = sq.after.unwrap_or(0).max(0);
    let mut hi = sq.before.unwrap_or(i64::MAX);
    let mut results: Vec<SearchResult> = Vec::new();
    let mut more = true;
    for _ in 0..FTS_ROUNDS {
        if results.len() as i64 >= SEARCH_PAGE {
            break;
        }
        let rows = sqlx::query(
            "SELECT rowid FROM messages_fts WHERE messages_fts MATCH $1 AND rowid < $2 AND rowid > $3 ORDER BY rowid DESC LIMIT $4",
        )
        .bind(phrase)
        .bind(hi)
        .bind(floor)
        .bind(FTS_BATCH)
        .fetch_all(db)
        .await?;
        let Some(last) = rows.last() else {
            more = false;
            break;
        };
        let lo: i64 = last.try_get(0)?;
        let want = SEARCH_PAGE - results.len() as i64;
        results.extend(search_once(db, user, headers, sq.clone(), Some((lo, hi)), want).await?);
        hi = lo;
        if (rows.len() as i64) < FTS_BATCH {
            more = false;
            break;
        }
    }
    let next = match (results.len() as i64 == SEARCH_PAGE, more) {
        (true, _) => results.last().map(|r| r.message.id),
        (false, true) => Some(hi),
        (false, false) => None,
    };
    Ok((results, next))
}

async fn search_once(
    db: &Db,
    user: Option<&User>,
    headers: &HeaderMap,
    sq: SearchQuery,
    window: Option<(i64, i64)>,
    limit: i64,
) -> Result<Vec<SearchResult>, ApiError> {
    let (sql, binds) = match search_sql(db, user, headers, sq, window, limit).await? {
        Some(built) => built,
        None => return Ok(Vec::new()),
    };
    let rows = bind_all(sqlx::query(sqlx::AssertSqlSafe(sql)), &binds)
        .fetch_all(db)
        .await?;
    let mut msgs = rows_messages(db, &rows, Quotes::Skip).await?;
    let mut ctx: Vec<(String, String)> = Vec::with_capacity(rows.len());
    for r in &rows {
        ctx.push((r.try_get(33)?, r.try_get(34)?));
    }
    attach_embeds(db, &mut msgs).await?;
    Ok(msgs
        .into_iter()
        .zip(ctx)
        .map(|(message, (server, channel_name))| SearchResult {
            message,
            server,
            channel_name,
        })
        .collect())
}

fn bind_all<'q>(
    mut query: sqlx::query::Query<'q, sqlx::Any, sqlx::any::AnyArguments>,
    binds: &'q [Bind],
) -> sqlx::query::Query<'q, sqlx::Any, sqlx::any::AnyArguments> {
    for b in binds {
        query = match b {
            Bind::S(s) => query.bind(s),
            Bind::I(i) => query.bind(*i),
        };
    }
    query
}

fn check_nul(texts: [&Option<String>; 4], servers: &Option<Vec<String>>) -> Result<(), ApiError> {
    let nul = texts
        .iter()
        .any(|t| t.as_deref().is_some_and(|v| v.contains('\0')))
        || servers.iter().flatten().any(|v| v.contains('\0'));
    match nul {
        true => Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Search text cannot contain NUL characters".to_string(),
        )),
        false => Ok(()),
    }
}

async fn search_sql(
    db: &Db,
    user: Option<&User>,
    headers: &HeaderMap,
    sq: SearchQuery,
    window: Option<(i64, i64)>,
    limit: i64,
) -> Result<Option<(String, Vec<Bind>)>, ApiError> {
    let SearchQuery {
        q,
        server,
        channel_id,
        from,
        has,
        before,
        after,
        before_ts,
        after_ts,
        offset,
        cursor: _,
        servers,
    } = sq;
    let (lo, hi) = match window {
        Some((lo, hi)) => (lo, hi),
        None => (i64::MIN, before.unwrap_or(i64::MAX)),
    };
    check_nul([&q, &server, &from, &has], &servers)?;
    let mut conds: Vec<String> = vec![LIVE_AUTHOR.to_string(), "m.kind = 'user'".to_string()];
    let mut binds: Vec<Bind> = Vec::new();
    match user {
        Some(u) => {
            binds.push(Bind::S(u.username.clone()));
            conds.push(format!(
                "c.server IN (SELECT server FROM members WHERE username = ${})",
                binds.len()
            ));
            if !u.is_site_admin {
                let mut ph = Vec::new();
                for subject in perm_subjects(db, None, &u.username).await? {
                    binds.push(Bind::S(subject));
                    ph.push(format!("${}", binds.len()));
                }
                let mut managed = Vec::new();
                for server in channel_manager_servers(db, u).await? {
                    binds.push(Bind::S(server));
                    managed.push(format!("${}", binds.len()));
                }
                let bypass = match managed.is_empty() {
                    true => String::new(),
                    false => format!("c.server IN ({}) OR ", managed.join(", ")),
                };
                let mine = ph.join(", ");
                conds.push(format!(
                    "({bypass}(c.restrict_view = 0 AND NOT EXISTS(SELECT 1 FROM channel_perms cp WHERE cp.channel_id = m.channel_id AND cp.subject IN ({mine}))) OR EXISTS(SELECT 1 FROM channel_perms cp WHERE cp.channel_id = m.channel_id AND cp.can_view != 0 AND cp.subject IN ({mine})))"
                ));
                conds.push(format!(
                    "({bypass}NOT EXISTS(SELECT 1 FROM channel_perms cp WHERE cp.channel_id = m.channel_id AND cp.subject IN ({mine})) OR EXISTS(SELECT 1 FROM channel_perms cp WHERE cp.channel_id = m.channel_id AND cp.can_read_history != 0 AND cp.subject IN ({mine})) OR m.created_at >= (SELECT joined_at FROM members mm WHERE mm.server = c.server AND mm.username = $1))"
                ));
            }
        }
        None => {
            conds.push("c.restrict_view = 0".to_string());
            let granted = granted_servers(db, &Proof::headers(headers)).await?;
            match granted.is_empty() {
                true => conds.push(
                    "c.server IN (SELECT name FROM servers WHERE password_hash IS NULL)"
                        .to_string(),
                ),
                false => {
                    let mut ph = Vec::with_capacity(granted.len());
                    for server in granted {
                        binds.push(Bind::S(server));
                        ph.push(format!("${}", binds.len()));
                    }
                    conds.push(format!(
                        "(c.server IN (SELECT name FROM servers WHERE password_hash IS NULL) OR c.server IN ({}))",
                        ph.join(", "),
                    ));
                }
            }
            let names = unique_capped(
                servers
                    .unwrap_or_default()
                    .iter()
                    .map(|s| s.trim().to_lowercase()),
            );
            if names.is_empty() {
                return Ok(None);
            }
            let mut ph = Vec::with_capacity(names.len());
            for name in names {
                binds.push(Bind::S(name));
                ph.push(format!("${}", binds.len()));
            }
            conds.push(format!("c.server IN ({})", ph.join(", ")));
        }
    }
    if let Some(text) = q.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        match text.chars().count() >= FTS_MIN_CHARS && has_fts(db) {
            true => {
                binds.push(Bind::S(fts_phrase(text)));
                binds.push(Bind::I(lo));
                binds.push(Bind::I(hi));
                conds.push(format!(
                    "m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ${} AND rowid >= ${} AND rowid < ${})",
                    binds.len() - 2,
                    binds.len() - 1,
                    binds.len()
                ));
            }
            false => {
                binds.push(Bind::S(like_pattern(text, false)));
                conds.push(format!(
                    "lower(m.content) LIKE lower(${}) ESCAPE '\\'",
                    binds.len()
                ));
            }
        }
    }
    if let Some(s) = server {
        binds.push(Bind::S(s.to_lowercase()));
        conds.push(format!("c.server = ${}", binds.len()));
    }
    if let Some(cid) = channel_id {
        binds.push(Bind::I(cid));
        conds.push(format!("m.channel_id = ${}", binds.len()));
    }
    if let Some(author) = from {
        binds.push(Bind::S(author.to_lowercase()));
        conds.push(format!("m.author = ${}", binds.len()));
    }
    if has.as_deref() == Some("file") {
        conds.push("m.media_id IS NOT NULL".to_string());
    }
    if let Some(b) = before {
        binds.push(Bind::I(b));
        conds.push(format!("m.id < ${}", binds.len()));
    }
    if window.is_some() {
        binds.push(Bind::I(lo));
        conds.push(format!("m.id >= ${}", binds.len()));
        binds.push(Bind::I(hi));
        conds.push(format!("m.id < ${}", binds.len()));
    }
    if let Some(a) = after {
        binds.push(Bind::I(a));
        conds.push(format!("m.id > ${}", binds.len()));
    }
    if let Some(t) = before_ts {
        binds.push(Bind::I(t));
        conds.push(format!("m.created_at < ${}", binds.len()));
    }
    if let Some(t) = after_ts {
        binds.push(Bind::I(t));
        conds.push(format!("m.created_at > ${}", binds.len()));
    }
    let skip = match offset {
        Some(n) if n > 0 => {
            binds.push(Bind::I(n));
            format!(" OFFSET ${}", binds.len())
        }
        _ => String::new(),
    };
    let sql = format!(
        "SELECT {COLS}, c.server, c.name FROM messages m CROSS JOIN channels c WHERE c.id = m.channel_id AND {} ORDER BY m.id DESC LIMIT {limit}{skip}",
        conds.join(" AND ")
    );
    Ok(Some((sql, binds)))
}

const UNREADS_MAX: usize = 500;

/// Options for the unread list.
#[derive(Deserialize, IntoParams)]
pub struct UnreadsQuery {
    /// `true` lists every viewable channel and DM with messages from others, read or not, with
    /// no cap. Default `false`: only unread scopes, capped at 500.
    all: Option<bool>,
}

/// List unread channels and DMs
///
/// Returns the caller's read positions for text channels in servers they are a member of
/// (skipping channels they cannot view, or whose latest message they could not read without
/// read-history access) and for their DMs (skipping DMs with an account being deleted). Only
/// messages by other users count as unread. Each item carries the caller's unseen ping count
/// for the scope; scopes with unseen pings are listed even when read. Requires a bearer token.
/// General rate-limit bucket.
#[utoipa::path(get, path = "/api/unreads", tag = "Messages", params(UnreadsQuery), responses((status = 200, description = "Unread scopes: the latest top-level message id from someone else and the last-read id for each text channel the caller can view (with its server) and each DM whose latest message is newer than its read position, plus every such scope with unseen pings (`pings`), scopes with pings first, then newest first, capped at 500 (`more` is true when the cap cut the list). Scopes that are not listed are read. With `all=true` every viewable channel and DM with messages from others is listed, read or not (no cap)", body = Unreads), (status = 400, description = "`all` is not `true` or `false` (plain-text framework error)", content_type = "text/plain", body = String), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn unreads(
    State(state): State<AppState>,
    Authed(user): Authed,
    Query(q): Query<UnreadsQuery>,
) -> Result<Json<Unreads>, ApiError> {
    let all = q.all.unwrap_or(false);
    let db = &state.read();
    let restricted = member_channel_rights(db, &user).await?;
    let channel_sql = format!(
        "SELECT x.id, x.server, x.latest, (SELECT lm.created_at FROM messages lm WHERE lm.id = x.latest), x.last_read, x.joined_at FROM (SELECT c.id, c.server, (SELECT m.id FROM messages m WHERE m.channel_id = c.id AND m.thread_root_id IS NULL AND m.author <> $1 AND {LIVE_AUTHOR} ORDER BY m.id DESC LIMIT 1) AS latest, COALESCE((SELECT rs.last_read FROM read_state rs WHERE rs.username = $1 AND rs.scope = 'c' || c.id), 0) AS last_read, mem.joined_at FROM channels c JOIN members mem ON mem.server = c.server AND mem.username = $1 WHERE c.kind = 'text') x"
    );
    let channel_rows = sqlx::query(sqlx::AssertSqlSafe(channel_sql))
        .bind(&user.username)
        .fetch_all(db)
        .await?;
    let dm_sql = match all {
        true => {
            "SELECT d.id, (SELECT MAX(m.id) FROM messages m WHERE m.dm_id = d.id AND m.author <> $1), COALESCE((SELECT rs.last_read FROM read_state rs WHERE rs.username = $1 AND rs.scope = 'd' || d.id), 0) FROM dms d WHERE (d.user_a = $1 OR d.user_b = $1) AND NOT EXISTS(SELECT 1 FROM users pu WHERE pu.username IN (d.user_a, d.user_b) AND pu.password_hash = '!purging')"
        }
        false => {
            "SELECT x.id, (SELECT MAX(m.id) FROM messages m WHERE m.dm_id = x.id AND m.author <> $1), x.last_read FROM (SELECT d.id, d.last_message_id, COALESCE((SELECT rs.last_read FROM read_state rs WHERE rs.username = $1 AND rs.scope = 'd' || d.id), 0) AS last_read FROM dms d WHERE (d.user_a = $1 OR d.user_b = $1) AND NOT EXISTS(SELECT 1 FROM users pu WHERE pu.username IN (d.user_a, d.user_b) AND pu.password_hash = '!purging')) x WHERE x.last_message_id > x.last_read OR EXISTS(SELECT 1 FROM pings p WHERE p.username = $1 AND p.seen = 0 AND p.scope = 'd' || x.id)"
        }
    };
    let dm_rows = sqlx::query(dm_sql)
        .bind(&user.username)
        .fetch_all(db)
        .await?;
    let mut pings = unseen_counts(db, &user.username).await?;
    let mut pings_of = |scope: &str| pings.remove(scope).unwrap_or_default();
    let mut items = Vec::with_capacity(channel_rows.len() + dm_rows.len());
    for r in &channel_rows {
        let id: i64 = r.try_get(0)?;
        let (latest, latest_at): (Option<i64>, Option<i64>) = (r.try_get(2)?, r.try_get(3)?);
        let joined_at: i64 = r.try_get(5)?;
        let readable = match restricted.get(&id) {
            None => true,
            Some(ChannelAccess {
                view,
                send: _,
                history,
            }) => *view && (*history || latest_at.is_some_and(|t| t >= joined_at)),
        };
        let last_read: i64 = r.try_get(4)?;
        let scope = format!("c{id}");
        let pinged = pings_of(&scope);
        let latest = latest.filter(|_| readable);
        let ScopePings {
            pings: pinged,
            pings_until,
            threads,
        } = match restricted.get(&id) {
            Some(ChannelAccess {
                view: false,
                send: _,
                history: _,
            }) => ScopePings::default(),
            _ => pinged,
        };
        if latest.is_some_and(|latest| all || latest > last_read) || pinged > 0 {
            items.push(Unread {
                scope,
                server: Some(r.try_get(1)?),
                last_read,
                latest: latest.unwrap_or(last_read),
                pings: pinged,
                pings_until,
                thread_pings: threads,
            });
        }
    }
    for r in &dm_rows {
        let id: i64 = r.try_get(0)?;
        let last_read: i64 = r.try_get(2)?;
        let scope = format!("d{id}");
        let ScopePings {
            pings: pinged,
            pings_until,
            threads,
        } = pings_of(&scope);
        let latest: Option<i64> = r.try_get(1)?;
        if latest.is_some_and(|latest| all || latest > last_read) || pinged > 0 {
            items.push(Unread {
                scope,
                server: None,
                last_read,
                latest: latest.unwrap_or(last_read),
                pings: pinged,
                pings_until,
                thread_pings: threads,
            });
        }
    }
    let more = !all && items.len() > UNREADS_MAX;
    if !all {
        items.sort_by_key(|u| std::cmp::Reverse((u.pings > 0, u.latest)));
        items.truncate(UNREADS_MAX);
    }
    Ok(Json(Unreads { items, more }))
}

/// Mark a channel, DM or thread read
///
/// Stores the last-read message id of the caller for a scope (`c<channel id>` or `d<dm id>`). The
/// position only moves forward: a lower `last_read` changes nothing. The caller must be able to
/// read the scope. For a channel, the checks are the same as for listing its messages (not
/// banned, member of a password-protected server, view permission). For a DM, the caller must be
/// a participant. Otherwise nothing is stored. Also marks the unseen pings of the caller in the
/// scope as seen (all kinds, outside threads, ids up to `pings_until` if given). A thread scope
/// (`t<root id>`) stores no position. It marks pings on the replies of the thread as seen and has
/// the same checks as listing the thread. Requires a bearer token. If the position is stored or
/// pings were marked seen, emits `read_updated` to the connections of the caller with
/// `pings_until` (the highest ping id marked seen, 0 for none). Other devices then clear those
/// badges and keep newer ones. General rate-limit bucket.
#[utoipa::path(post, path = "/api/read", tag = "Messages", request_body = ReadReq, responses((status = 200, description = "The stored read position, which never moves backwards (for a thread, `last_read` as sent)", body = ReadState), (status = 400, description = "`scope` is not `c`, `d` or `t` followed by digits (`Invalid scope`), or a `t` scope names a DM message or a thread reply (`Threads only start on channel messages`). Malformed JSON or a missing `Content-Type` give plain-text 400/415 framework errors", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 404, description = "`Not found`: the channel, DM or thread root does not exist or you cannot read it (hidden channel, before your join without read history, a server you have no access to or are banned from, a DM you are not in, or a participant's account is being deleted); identical responses", body = ApiErrorBody), (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn mark_read(
    State(state): State<AppState>,
    Authed(user): Authed,
    Json(req): Json<ReadReq>,
) -> Result<Json<ReadState>, ApiError> {
    let ReadReq {
        scope,
        last_read,
        pings_until,
    } = req;
    let id = match valid_scope(&scope) {
        true => scope[1..].parse::<i64>().ok(),
        false => None,
    };
    let Some(id) = id else {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Invalid scope".to_string(),
        ));
    };
    if scope.as_bytes()[0] == b't' {
        let root = resolve_message(&state.db, id, Some(&user), &Proof::none()).await?;
        let channel = format!("c{}", root.thread_channel()?.id());
        let seen = mark_seen(
            &state.db,
            &user.username,
            SeenScope::Thread {
                scope: &channel,
                root: id,
            },
            pings_until,
        )
        .await?;
        if let Some(pings_until) = seen {
            state.hub.broadcast(WsEvent::ReadUpdated {
                username: user.username,
                scope: scope.clone(),
                last_read,
                pings_until,
            });
        }
        return Ok(Json(ReadState { scope, last_read }));
    }
    match scope.as_bytes()[0] {
        b'c' => {
            resolve_channel(&state.db, id, Some(&user), &Proof::none()).await?;
        }
        _ => {
            resolve_dm(&state.db, id, &user).await?;
        }
    }
    let stored: i64 = sqlx::query(
        "INSERT INTO read_state(username, scope, last_read) VALUES($1, $2, $3) ON CONFLICT(username, scope) DO UPDATE SET last_read = CASE WHEN excluded.last_read > read_state.last_read THEN excluded.last_read ELSE read_state.last_read END RETURNING last_read",
    )
    .bind(&user.username)
    .bind(&scope)
    .bind(last_read)
    .fetch_one(&state.db)
    .await?
    .try_get(0)?;
    let seen = mark_seen(
        &state.db,
        &user.username,
        SeenScope::Scope(&scope),
        pings_until,
    )
    .await?;
    if stored == last_read || seen.is_some() {
        state.hub.broadcast(WsEvent::ReadUpdated {
            username: user.username,
            scope: scope.clone(),
            last_read: stored,
            pings_until: seen.unwrap_or(0),
        });
    }
    Ok(Json(ReadState {
        scope,
        last_read: stored,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::access::reference_channel_access as channel_access;
    use crate::api::access::resolve_server;
    use crate::api::test_util::{add_member, done, mem_user, temp_state};
    use crate::db::Perm;

    async fn general_id(db: &Db) -> i64 {
        sqlx::query("SELECT id FROM channels WHERE server = 'rchat'")
            .fetch_one(db)
            .await
            .expect("general channel")
            .try_get(0)
            .expect("channel id")
    }

    #[tokio::test]
    async fn read_markers_need_access_to_the_scope() {
        let (state, path) = temp_state("read_access").await;
        let db = &state.db;
        let cid = general_id(db).await;
        let hidden: i64 = sqlx::query("INSERT INTO channels(server, name, kind, created_at) VALUES('rchat', 'hidden', 'text', 1) RETURNING id")
            .fetch_one(db)
            .await
            .expect("channel")
            .try_get(0)
            .expect("id");
        sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'u:hist', 1, 1, 1)")
            .bind(hidden)
            .execute(db)
            .await
            .expect("restrict");
        crate::api::test_util::restrict_ruled(db).await;
        let dm: i64 =
            sqlx::query("INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id")
                .fetch_one(db)
                .await
                .expect("dm")
                .try_get(0)
                .expect("dm id");
        sqlx::query(
            "INSERT INTO server_bans(server, username, created_at) VALUES('rchat', 'eve', 1)",
        )
        .execute(db)
        .await
        .expect("ban");
        let mark = |who: &'static str, scope: String| {
            let state = state.clone();
            async move {
                mark_read(
                    State(state),
                    Authed(mem_user(who, false)),
                    Json(ReadReq {
                        scope,
                        last_read: 7,
                        pings_until: None,
                    }),
                )
                .await
                .map(|Json(r)| r.last_read)
                .map_err(|ApiError(code, _)| code)
            }
        };
        assert_eq!(
            mark("carol", format!("c{hidden}")).await,
            Err(StatusCode::NOT_FOUND)
        );
        assert_eq!(
            mark("eve", format!("c{cid}")).await,
            Err(StatusCode::NOT_FOUND)
        );
        assert_eq!(
            mark("carol", format!("d{dm}")).await,
            Err(StatusCode::NOT_FOUND)
        );
        assert_eq!(
            mark("carol", "c999999".to_string()).await,
            Err(StatusCode::NOT_FOUND)
        );
        assert_eq!(
            mark("carol", "d999999".to_string()).await,
            Err(StatusCode::NOT_FOUND)
        );
        assert_eq!(
            mark("carol", "c99999999999999999999".to_string()).await,
            Err(StatusCode::BAD_REQUEST)
        );
        let rows: i64 = sqlx::query("SELECT COUNT(*) FROM read_state")
            .fetch_one(db)
            .await
            .expect("count")
            .try_get(0)
            .expect("n");
        assert_eq!(rows, 0);
        assert_eq!(mark("carol", format!("c{cid}")).await, Ok(7));
        assert_eq!(mark("hist", format!("c{hidden}")).await, Ok(7));
        assert_eq!(mark("bob", format!("d{dm}")).await, Ok(7));
        done(state, path).await;
    }

    async fn send(state: &AppState, cid: i64, name: &str) -> Result<Json<Message>, ApiError> {
        send_channel_message(
            State(state.clone()),
            Path(cid),
            Authed(mem_user(name, false)),
            Json(SendReq {
                content: "hello".to_string(),
                media_id: None,
                media_spoiler: None,
                p2p: None,
                reply_to: None,
                mention_reply: true,
                forward_of: None,
            }),
        )
        .await
    }

    async fn list(
        state: &AppState,
        cid: i64,
        user: Option<&str>,
    ) -> Result<Vec<Message>, ApiError> {
        channel_messages(
            State(state.clone()),
            MaybeAuthed(user.map(|name| mem_user(name, false))),
            HeaderMap::new(),
            Path(cid),
            Query(PageQuery {
                before: None,
                after: None,
                around: None,
                limit: None,
            }),
        )
        .await
        .map(|r| r.0)
    }

    async fn send_with(
        state: &AppState,
        cid: i64,
        name: &str,
        content: String,
        media_id: Option<&str>,
    ) -> Result<Json<Message>, ApiError> {
        send_channel_message(
            State(state.clone()),
            Path(cid),
            Authed(mem_user(name, false)),
            Json(SendReq {
                content,
                media_id: media_id.map(str::to_string),
                media_spoiler: None,
                p2p: None,
                reply_to: None,
                mention_reply: true,
                forward_of: None,
            }),
        )
        .await
    }

    async fn add_media(db: &Db, id: &str, uploader: Option<&str>) {
        sqlx::query("INSERT INTO media(id, filename, mime, size, data, uploader, uploaded_at) VALUES($1, 'a.txt', 'text/plain', 1, $2, $3, $4)")
            .bind(id)
            .bind(vec![0u8])
            .bind(uploader)
            .bind(now())
            .execute(db)
            .await
            .expect("insert media");
    }

    #[tokio::test]
    async fn message_length_limit() {
        let (state, path) = temp_state("msg_len").await;
        let cid = general_id(&state.db).await;
        add_member(&state.db, "rchat", "alice", 0, 0, now()).await;
        let ok = send_with(&state, cid, "alice", "😀".repeat(MESSAGE_MAX), None).await;
        assert_eq!(
            ok.expect("4000 emoji ok").0.content.chars().count(),
            MESSAGE_MAX
        );
        let long = send_with(&state, cid, "alice", "a".repeat(MESSAGE_MAX + 1), None).await;
        assert!(matches!(long, Err(ApiError(StatusCode::BAD_REQUEST, _))));
        let dm: i64 =
            sqlx::query("INSERT INTO dms(user_a, user_b) VALUES('alice', 'alice') RETURNING id")
                .fetch_one(&state.db)
                .await
                .expect("insert dm")
                .try_get(0)
                .expect("dm id");
        let dm_long = send_dm_message(
            State(state.clone()),
            Path(dm),
            Authed(mem_user("alice", false)),
            Json(SendReq {
                content: "a".repeat(MESSAGE_MAX + 1),
                media_id: None,
                media_spoiler: None,
                p2p: None,
                reply_to: None,
                mention_reply: true,
                forward_of: None,
            }),
        )
        .await;
        assert!(matches!(dm_long, Err(ApiError(StatusCode::BAD_REQUEST, _))));
        done(state, path).await;
    }

    #[tokio::test]
    async fn media_single_use() {
        let (state, path) = temp_state("media_once").await;
        let cid = general_id(&state.db).await;
        add_member(&state.db, "rchat", "alice", 0, 0, now()).await;
        add_member(&state.db, "rchat", "bob", 0, 0, now()).await;
        let owned = "aa".repeat(16);
        add_media(&state.db, &owned, Some("alice")).await;
        let stolen = send_with(&state, cid, "bob", String::new(), Some(&owned)).await;
        assert!(matches!(stolen, Err(ApiError(StatusCode::FORBIDDEN, _))));
        let first = send_with(&state, cid, "alice", String::new(), Some(&owned))
            .await
            .expect("owner attaches")
            .0;
        assert_eq!(first.media.map(|m| m.id), Some(owned.clone()));
        let reuse = send_with(&state, cid, "alice", String::new(), Some(&owned)).await;
        assert!(matches!(reuse, Err(ApiError(StatusCode::BAD_REQUEST, _))));
        let legacy = "bb".repeat(16);
        add_media(&state.db, &legacy, None).await;
        for who in ["bob", "alice"] {
            let claimed = send_with(&state, cid, who, String::new(), Some(&legacy)).await;
            assert!(
                matches!(claimed, Err(ApiError(StatusCode::FORBIDDEN, _))),
                "uploads without an uploader belong to nobody"
            );
        }
        let unknown = send_with(&state, cid, "bob", String::new(), Some(&"cc".repeat(16))).await;
        assert!(matches!(unknown, Err(ApiError(StatusCode::BAD_REQUEST, _))));
        let count: i64 = sqlx::query("SELECT COUNT(*) FROM messages WHERE media_id IS NOT NULL")
            .fetch_one(&state.db)
            .await
            .expect("count")
            .try_get(0)
            .expect("count value");
        assert_eq!(count, 1);
        done(state, path).await;
    }

    async fn set_switch(db: &Db, key: &str, on: bool) {
        sqlx::query("INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
            .bind(key)
            .bind(if on { "1" } else { "0" })
            .execute(db)
            .await
            .expect("setting");
        Settings::forget(db);
    }

    fn p2p_req(id: &str, size: i64, sha256: Option<&str>) -> SendReq {
        SendReq {
            content: String::new(),
            media_id: None,
            media_spoiler: None,
            p2p: Some(P2pAttachment {
                filename: "big.bin".to_string(),
                size,
                mime: "application/octet-stream".to_string(),
                sha256: sha256.map(str::to_string),
                p2p_id: id.to_string(),
                expires_in_seconds: None,
            }),
            reply_to: None,
            mention_reply: true,
            forward_of: None,
        }
    }

    async fn send_req(state: &AppState, cid: i64, req: SendReq) -> Result<Message, ApiError> {
        send_channel_message(
            State(state.clone()),
            Path(cid),
            Authed(mem_user("alice", false)),
            Json(req),
        )
        .await
        .map(|j| j.0)
    }

    fn refused(res: Result<Message, ApiError>, text: &str) -> bool {
        matches!(res, Err(ApiError(StatusCode::FORBIDDEN, ref m)) if m == text)
    }

    #[tokio::test]
    async fn p2p_ids_of_another_hoster_cannot_be_reused() {
        let (state, path) = temp_state("p2p_reuse").await;
        let db = &state.db;
        let cid = general_id(db).await;
        add_member(db, "rchat", "alice", 0, 0, now()).await;
        add_member(db, "rchat", "mallory", 0, 0, now()).await;
        let id = "c3".repeat(16);
        let first = send_req(&state, cid, p2p_req(&id, 10, Some(&"aa".repeat(32))))
            .await
            .expect("alice hosts the file")
            .media
            .expect("media");
        assert_eq!(first.hoster.as_deref(), Some("alice"));
        let as_mallory = |id: String| {
            send_channel_message(
                State(state.clone()),
                Path(cid),
                Authed(mem_user("mallory", false)),
                Json(p2p_req(&id, 10, Some(&"bb".repeat(32)))),
            )
        };
        let mixed = "aBcD".repeat(8);
        let stored = send_req(&state, cid, p2p_req(&mixed, 10, None))
            .await
            .expect("ids in any letter case are accepted")
            .media
            .expect("media");
        assert_eq!(stored.id, mixed.to_ascii_lowercase(), "and kept lowercase");
        let kept: String =
            sqlx::query("SELECT media_id FROM messages WHERE id = (SELECT MAX(id) FROM messages)")
                .fetch_one(db)
                .await
                .expect("row")
                .try_get(0)
                .expect("id");
        assert_eq!(kept, mixed.to_ascii_lowercase());
        for reuse in [
            id.clone(),
            id.to_ascii_uppercase(),
            mixed.clone(),
            mixed.to_ascii_lowercase(),
        ] {
            assert!(
                matches!(
                    as_mallory(reuse).await,
                    Err(ApiError(StatusCode::BAD_REQUEST, ref m)) if m == "Invalid p2p_id"
                ),
                "another hoster's id is refused"
            );
        }
        assert!(
            as_mallory("d4".repeat(16)).await.is_ok(),
            "fresh ids still work"
        );
        send_req(&state, cid, p2p_req(&id, 10, Some(&"aa".repeat(32))))
            .await
            .expect("the hoster may post its own id again");
        let rows: i64 = sqlx::query("SELECT COUNT(*) FROM messages WHERE media_id = $1")
            .bind(&id)
            .fetch_one(db)
            .await
            .expect("count")
            .try_get(0)
            .expect("count value");
        assert_eq!(rows, 2);
        done(state, path).await;
    }

    #[tokio::test]
    async fn p2p_attachments_follow_their_own_switch_and_carry_a_hash() {
        let (state, path) = temp_state("p2p_switch").await;
        let db = &state.db;
        let cid = general_id(db).await;
        add_member(db, "rchat", "alice", 0, 0, now()).await;
        let hash = "AB".repeat(32);
        set_switch(db, "asset_uploads", false).await;
        let big = send_req(&state, cid, p2p_req(&"1a".repeat(16), 5 << 30, Some(&hash)))
            .await
            .expect("P2P works with uploads off and has no size cap")
            .media
            .expect("media");
        assert_eq!(big.size, Some(5 << 30));
        assert_eq!(big.sha256, Some("ab".repeat(32)), "stored lowercase");
        let listed = list(&state, cid, Some("alice")).await.expect("list");
        let row = listed.iter().find_map(|m| m.media.clone()).expect("row");
        assert_eq!(row.sha256, Some("ab".repeat(32)));
        let old = send_req(&state, cid, p2p_req(&"2b".repeat(16), 10, None))
            .await
            .expect("older clients send no hash")
            .media
            .expect("media");
        assert_eq!(old.sha256, None);
        for (id, size, sha) in [
            ("3c".repeat(16), 1i64 << 53, Some(hash.clone())),
            ("3d".repeat(16), -1, Some(hash.clone())),
            ("3e".repeat(16), 10, Some("ab".repeat(31))),
            ("3f".repeat(16), 10, Some("zz".repeat(32))),
        ] {
            assert!(
                matches!(
                    send_req(&state, cid, p2p_req(&id, size, sha.as_deref())).await,
                    Err(ApiError(StatusCode::BAD_REQUEST, _))
                ),
                "{size} {sha:?}"
            );
        }
        let mut bad_mime = p2p_req(&"40".repeat(16), 1, None);
        if let Some(p2p) = &mut bad_mime.p2p {
            p2p.mime = "text/html\r\nx".to_string();
        }
        assert!(send_req(&state, cid, bad_mime).await.is_err());
        add_media(db, &"5a".repeat(16), Some("bob")).await;
        assert!(
            matches!(
                send_req(&state, cid, p2p_req(&"5A".repeat(16), 1, None)).await,
                Err(ApiError(StatusCode::BAD_REQUEST, _))
            ),
            "a P2P id can't name a stored server file"
        );
        add_media(db, &"6b".repeat(16), Some("alice")).await;
        assert!(refused(
            send_with(&state, cid, "alice", String::new(), Some(&"6b".repeat(16)))
                .await
                .map(|j| j.0),
            "File uploads are turned off on this server"
        ));
        set_switch(db, "asset_uploads", true).await;
        set_switch(db, "p2p_attachments", false).await;
        assert!(refused(
            send_req(&state, cid, p2p_req(&"7c".repeat(16), 1, None)).await,
            "P2P attachments are turned off on this server"
        ));
        assert!(
            send_with(&state, cid, "alice", String::new(), Some(&"6b".repeat(16)))
                .await
                .is_ok()
        );
        set_switch(db, "asset_uploads", false).await;
        assert!(Settings::cached(db).await.text_only());
        add_media(db, &"8d".repeat(16), Some("alice")).await;
        assert!(refused(
            send_with(&state, cid, "alice", String::new(), Some(&"8d".repeat(16)))
                .await
                .map(|j| j.0),
            "Attachments are turned off on this server"
        ));
        assert!(refused(
            send_req(&state, cid, p2p_req(&"9e".repeat(16), 1, None)).await,
            "Attachments are turned off on this server"
        ));
        let dm: i64 =
            sqlx::query("INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id")
                .fetch_one(db)
                .await
                .expect("dm")
                .try_get(0)
                .expect("dm id");
        let in_dm = send_dm_message(
            State(state.clone()),
            Path(dm),
            Authed(mem_user("alice", false)),
            Json(p2p_req(&"af".repeat(16), 1, None)),
        )
        .await;
        assert!(
            matches!(in_dm, Err(ApiError(StatusCode::FORBIDDEN, _))),
            "DMs too"
        );
        let text = send_with(&state, cid, "alice", "just text 😀".to_string(), None).await;
        assert!(text.is_ok(), "text and emoji still work");
        done(state, path).await;
    }

    #[tokio::test]
    async fn forwards_drop_server_files_while_uploads_are_off() {
        let (state, path) = temp_state("fwd_uploads_off").await;
        let db = &state.db;
        let cid = general_id(db).await;
        add_member(db, "rchat", "alice", 0, 0, now()).await;
        let id = "c0".repeat(16);
        add_media(db, &id, Some("alice")).await;
        let src = send_with(&state, cid, "alice", "look".to_string(), Some(&id))
            .await
            .expect("source")
            .0;
        set_switch(db, "asset_uploads", false).await;
        let mut req = p2p_req(&"c1".repeat(16), 1, None);
        req.p2p = None;
        req.forward_of = Some(src.id);
        let copy = send_req(&state, cid, req).await.expect("forward");
        assert!(copy.media.is_none());
        assert_eq!(
            copy.forward.and_then(|f| f.dropped),
            Some("a.txt".to_string())
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn slowmode_gap() {
        let (state, path) = temp_state("slowmode").await;
        let cid = general_id(&state.db).await;
        sqlx::query("UPDATE channels SET slowmode_seconds = 60 WHERE id = $1")
            .bind(cid)
            .execute(&state.db)
            .await
            .expect("set slowmode");
        add_member(&state.db, "rchat", "alice", 0, 0, now()).await;
        add_member(&state.db, "rchat", "boss", 1, 0, now()).await;
        let _ = send(&state, cid, "alice").await.expect("first send");
        let second = send(&state, cid, "alice").await;
        match second {
            Err(ApiError(StatusCode::TOO_MANY_REQUESTS, msg)) => {
                assert!(
                    msg == "Slow mode: wait 60s" || msg == "Slow mode: wait 59s",
                    "{msg}"
                )
            }
            _ => panic!("expected slow mode rejection"),
        }
        let _ = send(&state, cid, "boss").await.expect("admin send 1");
        let _ = send(&state, cid, "boss").await.expect("admin send 2");
        let db = &state.db;
        for (holder, perms) in [
            ("chanmod", Perm::ManageChannels as i64),
            ("msgmod", Perm::DeleteMessages as i64),
            ("kicker", Perm::Kick as i64),
            ("writer", 0),
        ] {
            add_member(db, "rchat", holder, 0, 0, now()).await;
            let role: i64 = sqlx::query("INSERT INTO roles(server, name, color, perms) VALUES('rchat', $1, '#ffffff', $2) RETURNING id")
                .bind(holder)
                .bind(perms)
                .fetch_one(db)
                .await
                .expect("role")
                .try_get(0)
                .expect("role id");
            sqlx::query(
                "INSERT INTO user_roles(server, username, role_id) VALUES('rchat', $1, $2)",
            )
            .bind(holder)
            .bind(role)
            .execute(db)
            .await
            .expect("assign");
            if holder == "writer" {
                sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, $2, 1, 1, 1)")
                    .bind(cid)
                    .bind(format!("r:{role}"))
                    .execute(db)
                    .await
                    .expect("send rule");
            }
        }
        for who in ["chanmod", "msgmod"] {
            let _ = send(&state, cid, who).await.expect("exempt 1");
            let _ = send(&state, cid, who).await.expect("exempt 2");
        }
        let _ = send(&state, cid, "kicker").await.expect("kicker 1");
        assert!(matches!(
            send(&state, cid, "kicker").await,
            Err(ApiError(StatusCode::TOO_MANY_REQUESTS, _))
        ));
        sqlx::query("UPDATE channels SET restrict_send = 1 WHERE id = $1")
            .bind(cid)
            .execute(db)
            .await
            .expect("restrict send");
        let _ = send(&state, cid, "chanmod").await.expect("managers bypass");
        for who in ["msgmod", "kicker", "alice"] {
            assert!(matches!(
                send(&state, cid, who).await,
                Err(ApiError(StatusCode::FORBIDDEN, _))
            ));
        }
        let _ = send(&state, cid, "writer").await.expect("allowed sender");
        assert!(matches!(
            send(&state, cid, "writer").await,
            Err(ApiError(StatusCode::TOO_MANY_REQUESTS, _))
        ));
        done(state, path).await;
    }

    #[tokio::test]
    async fn private_channel_history() {
        let (state, path) = temp_state("history").await;
        let cid = general_id(&state.db).await;
        let joined = now() - 1000;
        add_member(&state.db, "rchat", "alice", 0, 0, joined).await;
        for (content, at) in [("before", joined - 500), ("after", joined + 500)] {
            sqlx::query(
                "INSERT INTO messages(channel_id, author, content, created_at) VALUES($1, 'alice', $2, $3)",
            )
            .bind(cid)
            .bind(content)
            .bind(at)
            .execute(&state.db)
            .await
            .expect("insert message");
        }
        sqlx::query(
            "INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'u:alice', 1, 1, 0)",
        )
        .bind(cid)
        .execute(&state.db)
        .await
        .expect("insert perm");
        crate::api::test_util::restrict_ruled(&state.db).await;
        let visible = list(&state, cid, Some("alice")).await.expect("alice list");
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].content, "after");
        let bob = list(&state, cid, Some("bob")).await;
        assert!(matches!(bob, Err(ApiError(StatusCode::NOT_FOUND, _))));
        let guest = list(&state, cid, None).await;
        assert!(matches!(guest, Err(ApiError(StatusCode::NOT_FOUND, _))));
        let found = search_with(
            &state,
            Some(&mem_user("alice", false)),
            &HeaderMap::new(),
            query(None),
        )
        .await
        .expect("search");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].message.content, "after");
        done(state, path).await;
    }

    fn query(q: Option<&str>) -> SearchQuery {
        SearchQuery {
            q: q.map(str::to_string),
            server: None,
            channel_id: None,
            from: None,
            has: None,
            before: None,
            after: None,
            before_ts: None,
            after_ts: None,
            offset: None,
            cursor: None,
            servers: None,
        }
    }

    async fn add_user(db: &Db, name: &str, display: &str) {
        sqlx::query("INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, avatar_color, created_at) VALUES($1, $2, '', 'text', 'identicon', NULL, $3)")
            .bind(name)
            .bind(display)
            .bind(now())
            .execute(db)
            .await
            .expect("insert user");
    }

    async fn insert(
        db: &Db,
        cid: Option<i64>,
        dm: Option<i64>,
        root: Option<i64>,
        author: &str,
    ) -> i64 {
        sqlx::query("INSERT INTO messages(channel_id, dm_id, thread_root_id, author, content, created_at) VALUES($1, $2, $3, $4, 'x', $5) RETURNING id")
            .bind(cid)
            .bind(dm)
            .bind(root)
            .bind(author)
            .bind(now())
            .fetch_one(db)
            .await
            .expect("insert message")
            .try_get(0)
            .expect("message id")
    }

    async fn add_channel(db: &Db, name: &str, kind: &str) -> i64 {
        sqlx::query("INSERT INTO channels(server, name, kind, created_at) VALUES('rchat', $1, $2, 0) RETURNING id")
            .bind(name)
            .bind(kind)
            .fetch_one(db)
            .await
            .expect("insert channel")
            .try_get(0)
            .expect("channel id")
    }

    async fn perm(db: &Db, cid: i64, subject: &str, view: i64) {
        sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, $2, $3, 1, 1)")
            .bind(cid)
            .bind(subject)
            .bind(view)
            .execute(db)
            .await
            .expect("insert perm");
        crate::api::test_util::restrict_ruled(db).await;
    }

    #[tokio::test]
    async fn channel_permission_paths_agree() {
        let (state, path) = temp_state("perm_paths").await;
        let db = &state.db;
        let private = add_channel(db, "private", "text").await;
        let t = now();
        for (name, admin, perms) in [
            ("alice", 0, 0),
            ("bob", 0, 0),
            ("mod", 1, Perm::ManageChannels as i64),
            ("kicker", 1, Perm::Kick as i64),
            ("roler", 0, 0),
            ("plainrole", 0, 0),
        ] {
            add_member(db, "rchat", name, admin, perms, t - 100).await;
        }
        for (holder, perms) in [
            ("roler", Perm::ManageChannels as i64),
            ("plainrole", Perm::Kick as i64),
        ] {
            let role: i64 = sqlx::query("INSERT INTO roles(server, name, color, perms) VALUES('rchat', $1, '#ffffff', $2) RETURNING id")
                .bind(holder)
                .bind(perms)
                .fetch_one(db)
                .await
                .expect("role")
                .try_get(0)
                .expect("role id");
            sqlx::query(
                "INSERT INTO user_roles(server, username, role_id) VALUES('rchat', $1, $2)",
            )
            .bind(holder)
            .bind(role)
            .execute(db)
            .await
            .expect("assign role");
        }
        perm(db, private, "u:alice", 0).await;
        perm(db, private, "u:bob", 1).await;
        let needle = post(db, private, "eve", "secret needle", t - 200).await;
        let bare = add_channel(db, "bare", "text").await;
        let hay = post(db, bare, "eve", "secret hay", t - 200).await;
        let cases = [
            (
                private,
                needle,
                "needle",
                1,
                [false, true, true, false, true, false],
            ),
            (
                private,
                needle,
                "needle",
                0,
                [false, true, true, true, true, true],
            ),
            (
                bare,
                hay,
                "hay",
                1,
                [false, false, true, false, true, false],
            ),
            (bare, hay, "hay", 0, [true; 6]),
        ];
        for (cid, msg, word, restrict, wants) in cases {
            sqlx::query("UPDATE channels SET restrict_view = $1 WHERE id = $2")
                .bind(restrict)
                .bind(cid)
                .execute(db)
                .await
                .expect("restrict");
            let names = ["alice", "bob", "mod", "kicker", "roler", "plainrole"];
            for (name, want) in names.into_iter().zip(wants) {
                let user = mem_user(name, false);
                let direct = channel_access(db, "rchat", cid, Some(&user))
                    .await
                    .expect("access")
                    .view;
                let unread = member_channel_rights(db, &user)
                    .await
                    .expect("restricted")
                    .get(&cid)
                    .is_none_or(|a| a.view);
                let rchat = resolve_server(db, "rchat", Some(&user), &Proof::none())
                    .await
                    .expect("rchat");
                let listed = rchat
                    .channel_rights(db)
                    .await
                    .expect("visible")
                    .get(&cid)
                    .is_none_or(|a| a.view);
                let searched = found(&state, Some(user), HeaderMap::new(), query(Some(word)))
                    .await
                    .contains(&msg);
                assert_eq!(
                    [direct, unread, listed, searched],
                    [want; 4],
                    "{name} in {cid} restrict {restrict}"
                );
            }
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn common_terms_page_through_bounded_fts_batches() {
        let (state, path) = temp_state("fts_batches").await;
        let db = &state.db;
        let general = general_id(db).await;
        let private = add_channel(db, "hidden", "text").await;
        add_member(db, "rchat", "alice", 0, 0, 0).await;
        perm(db, private, "u:alice", 0).await;
        let mut visible = Vec::new();
        for n in 0..3 {
            visible.push(post(db, general, "eve", &format!("common word {n}"), 1).await);
        }
        sqlx::query("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 6000) INSERT INTO messages(channel_id, author, content, created_at) SELECT $1, 'eve', 'common word hidden ' || i, 2 FROM n")
            .bind(private)
            .execute(db)
            .await
            .expect("seed hidden");
        let alice = mem_user("alice", false);
        let mut sq = query(Some("common"));
        let mut got = Vec::new();
        let mut calls = 0;
        loop {
            calls += 1;
            let (page, next) = search_paged(&state, Some(&alice), &HeaderMap::new(), sq.clone())
                .await
                .expect("search");
            got.extend(page.iter().map(|r| r.message.id));
            match next {
                Some(before) => sq.before = Some(before),
                None => break,
            }
            assert!(calls < 10, "search never finished");
        }
        assert!(
            calls > 1,
            "a common term must not scan every match in one call"
        );
        visible.reverse();
        assert_eq!(got, visible);
        done(state, path).await;
    }

    #[tokio::test]
    async fn pages_batch_authors_and_clamp() {
        let (state, path) = temp_state("page_batch").await;
        let db = &state.db;
        let cid = general_id(db).await;
        add_user(db, "alice", "Alice A").await;
        add_user(db, "bob", "Bob B").await;
        let mut ids = Vec::new();
        for n in 0..150 {
            let author = ["alice", "bob", "ghost"][n % 3];
            ids.push(insert(db, Some(cid), None, None, author).await);
        }
        let root = ids[0];
        for author in ["bob", "ghost"] {
            insert(db, Some(cid), None, Some(root), author).await;
        }
        let get = |before: Option<i64>, limit: Option<i64>| {
            let state = state.clone();
            async move {
                channel_messages(
                    State(state),
                    MaybeAuthed(None),
                    HeaderMap::new(),
                    Path(cid),
                    Query(PageQuery {
                        before,
                        after: None,
                        around: None,
                        limit,
                    }),
                )
                .await
                .expect("page")
                .0
            }
        };
        let latest = get(None, None).await;
        assert_eq!(latest.len(), 50);
        assert_eq!(latest.last().map(|m| m.id), ids.last().copied());
        assert!(latest.windows(2).all(|w| w[0].id < w[1].id));
        assert_eq!(get(None, Some(500)).await.len(), 100);
        assert_eq!(get(None, Some(0)).await.len(), 1);
        let tail = get(Some(ids[40]), None).await;
        assert_eq!(tail.len(), 40);
        assert_eq!(tail[0].id, root);
        assert_eq!(tail[0].reply_count, 2);
        let names: HashMap<String, String> = latest
            .iter()
            .map(|m| (m.author.username.clone(), m.author.display_name.clone()))
            .collect();
        assert_eq!(names["alice"], "Alice A");
        assert_eq!(names["bob"], "Bob B");
        assert_eq!(names["ghost"], "ghost");
        let thread = thread_messages(
            State(state.clone()),
            MaybeAuthed(None),
            HeaderMap::new(),
            Path(root),
            Query(PageQuery {
                before: None,
                after: None,
                around: None,
                limit: None,
            }),
        )
        .await
        .expect("thread")
        .0;
        let authors: Vec<&str> = thread
            .iter()
            .map(|m| m.author.display_name.as_str())
            .collect();
        assert_eq!(authors, ["Bob B", "ghost"]);
        let loaded = load_message(db, ids[1], Quotes::Since(None))
            .await
            .expect("load")
            .expect("exists");
        assert_eq!(loaded.author.display_name, "Bob B");
        assert!(
            load_message(db, i64::MAX, Quotes::Skip)
                .await
                .expect("load")
                .is_none()
        );
        done(state, path).await;
    }

    async fn unread_map(
        state: &AppState,
        name: &str,
    ) -> HashMap<String, (Option<String>, i64, i64)> {
        unreads(
            State(state.clone()),
            Authed(mem_user(name, false)),
            Query(UnreadsQuery { all: Some(true) }),
        )
        .await
        .expect("unreads")
        .0
        .items
        .into_iter()
        .map(|u| (u.scope, (u.server, u.latest, u.last_read)))
        .collect()
    }

    #[tokio::test]
    async fn unreads_respect_visibility() {
        let (state, path) = temp_state("unread_vis").await;
        let db = &state.db;
        let general = general_id(db).await;
        let private = add_channel(db, "private", "text").await;
        let roled = add_channel(db, "roled", "text").await;
        let empty = add_channel(db, "empty", "text").await;
        let voice = add_channel(db, "voice", "voice").await;
        let t = now();
        for (name, admin, perms) in [
            ("alice", 0, 0),
            ("bob", 0, 0),
            ("mod", 1, Perm::ManageChannels as i64),
            ("kicker", 1, Perm::Kick as i64),
        ] {
            add_member(db, "rchat", name, admin, perms, t).await;
        }
        let role: i64 = sqlx::query("INSERT INTO roles(server, name, color, perms) VALUES('rchat', 'r', '#ffffff', 0) RETURNING id")
            .fetch_one(db)
            .await
            .expect("role")
            .try_get(0)
            .expect("role id");
        sqlx::query("INSERT INTO user_roles(server, username, role_id) VALUES('rchat', 'bob', $1)")
            .bind(role)
            .execute(db)
            .await
            .expect("assign role");
        perm(db, private, "u:alice", 0).await;
        perm(db, private, "u:bob", 1).await;
        perm(db, roled, &format!("r:{role}"), 1).await;
        perm(db, empty, "u:alice", 0).await;
        let nohist = add_channel(db, "nohist", "text").await;
        sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'u:alice', 1, 1, 0)")
            .bind(nohist)
            .execute(db)
            .await
            .expect("no history perm");
        crate::api::test_util::restrict_ruled(db).await;
        let at = |when: i64| {
            sqlx::query("INSERT INTO messages(channel_id, author, content, created_at) VALUES($1, 'eve', 'x', $2) RETURNING id")
                .bind(nohist)
                .bind(when)
        };
        let before_join: i64 = at(t - 10)
            .fetch_one(db)
            .await
            .expect("old message")
            .try_get(0)
            .expect("old id");
        let g = insert(db, Some(general), None, None, "eve").await;
        let reply = insert(db, Some(general), None, Some(g), "eve").await;
        let p = insert(db, Some(private), None, None, "eve").await;
        let r = insert(db, Some(roled), None, None, "eve").await;
        insert(db, Some(voice), None, None, "eve").await;
        let dm: i64 =
            sqlx::query("INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id")
                .fetch_one(db)
                .await
                .expect("dm")
                .try_get(0)
                .expect("dm id");
        let call: i64 = sqlx::query("INSERT INTO messages(dm_id, author, content, kind, created_at) VALUES($1, 'bob', '', 'call', $2) RETURNING id")
            .bind(dm)
            .bind(t)
            .fetch_one(db)
            .await
            .expect("call log")
            .try_get(0)
            .expect("call id");
        sqlx::query("INSERT INTO read_state(username, scope, last_read) VALUES('alice', $1, $2)")
            .bind(format!("c{general}"))
            .bind(g)
            .execute(db)
            .await
            .expect("read state");
        assert!(reply > g);
        let alice = unread_map(&state, "alice").await;
        let rchat = Some("rchat".to_string());
        assert_eq!(alice.len(), 2);
        assert_eq!(alice[&format!("c{general}")], (rchat.clone(), g, g));
        assert_eq!(alice[&format!("d{dm}")], (None, call, 0));
        let bob = unread_map(&state, "bob").await;
        assert_eq!(bob[&format!("c{private}")], (rchat.clone(), p, 0));
        assert_eq!(bob[&format!("c{roled}")], (rchat.clone(), r, 0));
        assert!(!bob.contains_key(&format!("d{dm}")));
        assert_eq!(bob.len(), 3);
        let moderator = unread_map(&state, "mod").await;
        assert!(moderator.contains_key(&format!("c{private}")));
        assert!(moderator.contains_key(&format!("c{roled}")));
        assert!(!moderator.contains_key(&format!("c{empty}")));
        assert!(!moderator.contains_key(&format!("c{voice}")));
        assert_eq!(
            moderator[&format!("c{nohist}")],
            (rchat.clone(), before_join, 0)
        );
        let outsider = unread_map(&state, "zed").await;
        assert!(outsider.is_empty());
        let after_join: i64 = at(t + 10)
            .fetch_one(db)
            .await
            .expect("new message")
            .try_get(0)
            .expect("new id");
        let alice = unread_map(&state, "alice").await;
        assert_eq!(alice[&format!("c{nohist}")], (rchat.clone(), after_join, 0));
        assert!(
            !unread_map(&state, "bob")
                .await
                .contains_key(&format!("c{nohist}"))
        );
        for name in ["alice", "bob", "mod", "kicker"] {
            let user = mem_user(name, false);
            let restricted = member_channel_rights(db, &user).await.expect("restricted");
            let open = ChannelAccess::all(true);
            for cid in [general, private, roled, empty, nohist] {
                let want = channel_access(db, "rchat", cid, Some(&user))
                    .await
                    .expect("access");
                let got = restricted.get(&cid).unwrap_or(&open);
                assert_eq!(
                    (got.view, got.send, got.history),
                    (want.view, want.send, want.history),
                    "{name} channel {cid}"
                );
            }
        }
        done(state, path).await;
    }

    async fn post(db: &Db, cid: i64, author: &str, content: &str, at: i64) -> i64 {
        sqlx::query("INSERT INTO messages(channel_id, author, content, created_at) VALUES($1, $2, $3, $4) RETURNING id")
            .bind(cid)
            .bind(author)
            .bind(content)
            .bind(at)
            .fetch_one(db)
            .await
            .expect("insert message")
            .try_get(0)
            .expect("message id")
    }

    async fn found(
        state: &AppState,
        user: Option<User>,
        headers: HeaderMap,
        sq: SearchQuery,
    ) -> Vec<i64> {
        search_with(state, user.as_ref(), &headers, sq)
            .await
            .expect("search")
            .iter()
            .map(|r| r.message.id)
            .collect()
    }

    async fn drop_fts(db: &Db) {
        for stmt in [
            "DROP TRIGGER messages_fts_insert",
            "DROP TRIGGER messages_fts_delete",
            "DROP TRIGGER messages_fts_update",
            "DROP TABLE messages_fts",
        ] {
            sqlx::query(stmt).execute(db).await.expect("drop fts");
        }
        crate::db::set_fts(db, false);
    }

    async fn fts_ok(db: &Db) {
        sqlx::query("INSERT INTO messages_fts(messages_fts, rank) VALUES('integrity-check', 1)")
            .execute(db)
            .await
            .expect("fts index matches messages");
    }

    async fn fts_hits(db: &Db, phrase: &str) -> i64 {
        sqlx::query("SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH $1")
            .bind(fts_phrase(phrase))
            .fetch_one(db)
            .await
            .expect("fts count")
            .try_get(0)
            .expect("count value")
    }

    async fn seed(db: &Db, cid: i64, count: i64) {
        sqlx::query("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < $2) INSERT INTO messages(channel_id, author, content, created_at) SELECT $1, 'alice', CASE WHEN i % 50 = 0 THEN 'find the needle ' || i ELSE 'plain hay ' || i END, i FROM n")
            .bind(cid)
            .bind(count)
            .execute(db)
            .await
            .expect("seed messages");
    }

    #[tokio::test]
    async fn search_skips_pin_notices_and_call_logs() {
        let (state, path) = temp_state("search_kinds").await;
        let db = &state.db;
        let cid = general_id(db).await;
        add_member(db, "rchat", "alice", 0, 0, 0).await;
        let t = now();
        let real = post(db, cid, "alice", "needle", t).await;
        for kind in ["pin", "call"] {
            sqlx::query("INSERT INTO messages(channel_id, author, content, kind, created_at) VALUES($1, 'alice', '', $2, $3)")
                .bind(cid)
                .bind(kind)
                .bind(t)
                .execute(db)
                .await
                .expect("system row");
        }
        for q in [Some("needle"), None] {
            let got = found(
                &state,
                Some(mem_user("alice", false)),
                HeaderMap::new(),
                query(q),
            )
            .await;
            assert_eq!(got, vec![real], "q={q:?}");
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn search_substring_and_wildcards() {
        let (state, path) = temp_state("search_substr").await;
        let db = &state.db;
        let cid = general_id(db).await;
        add_member(db, "rchat", "alice", 0, 0, 0).await;
        let t = now();
        let hello = post(db, cid, "alice", "Hello World", t).await;
        let shout = post(db, cid, "alice", "say HELLO again", t).await;
        let pct = post(db, cid, "alice", "100% sure", t).await;
        let snake = post(db, cid, "alice", "snake_case name", t).await;
        let slash = post(db, cid, "alice", r"back\slash", t).await;
        let quoted = post(db, cid, "alice", r#"she said "hi there" twice"#, t).await;
        post(db, cid, "alice", "unrelated", t).await;
        let cases: Vec<(&str, Vec<i64>)> = vec![
            ("hello", vec![shout, hello]),
            ("HeLLo", vec![shout, hello]),
            ("  lo wo ", vec![hello]),
            ("lo", vec![shout, hello]),
            ("O", vec![shout, hello]),
            ("%", vec![pct]),
            ("_", vec![snake]),
            ("0%", vec![pct]),
            ("e_c", vec![snake]),
            ("%%%", vec![]),
            (r"\", vec![slash]),
            (r"k\s", vec![slash]),
            (r#""hi"#, vec![quoted]),
            (r#""hi there""#, vec![quoted]),
            ("hi there", vec![quoted]),
            ("zzz", vec![]),
        ];
        for fts in [true, false] {
            assert_eq!(has_fts(db), fts);
            for (q, want) in &cases {
                let got = found(
                    &state,
                    Some(mem_user("alice", false)),
                    HeaderMap::new(),
                    query(Some(q)),
                )
                .await;
                assert_eq!(&got, want, "q={q:?} fts={fts}");
            }
            let nul = search_with(
                &state,
                Some(&mem_user("alice", false)),
                &HeaderMap::new(),
                query(Some("hel\0lo")),
            )
            .await;
            assert!(matches!(nul, Err(ApiError(StatusCode::BAD_REQUEST, _))));
            if fts {
                drop_fts(db).await;
            }
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn search_respects_visibility() {
        let (state, path) = temp_state("search_vis").await;
        let db = &state.db;
        let t = now();
        for (name, password) in [("locked", Some("x")), ("other", None), ("comma, inc", None)] {
            sqlx::query("INSERT INTO servers(name, display_name, password_hash, created_at) VALUES($1, $1, $2, 0)")
                .bind(name)
                .bind(password)
                .execute(db)
                .await
                .expect("insert server");
        }
        let general = general_id(db).await;
        let private = add_channel(db, "private", "text").await;
        let roled = add_channel(db, "roled", "text").await;
        let history = add_channel(db, "history", "text").await;
        let mut ids = HashMap::new();
        for (server, name) in [
            ("locked", "vault"),
            ("other", "lobby"),
            ("comma, inc", "hall"),
        ] {
            let cid: i64 = sqlx::query(
                "INSERT INTO channels(server, name, created_at) VALUES($1, $2, 0) RETURNING id",
            )
            .bind(server)
            .bind(name)
            .fetch_one(db)
            .await
            .expect("insert channel")
            .try_get(0)
            .expect("channel id");
            ids.insert(name, post(db, cid, "bob", "a needle here", t).await);
        }
        for (server, name) in [
            ("rchat", "alice"),
            ("rchat", "bob"),
            ("rchat", "root"),
            ("locked", "alice"),
        ] {
            add_member(db, server, name, 0, 0, t).await;
        }
        let role: i64 = sqlx::query("INSERT INTO roles(server, name, color, perms) VALUES('rchat', 'r', '#ffffff', 0) RETURNING id")
            .fetch_one(db)
            .await
            .expect("role")
            .try_get(0)
            .expect("role id");
        sqlx::query(
            "INSERT INTO user_roles(server, username, role_id) VALUES('rchat', 'alice', $1)",
        )
        .bind(role)
        .execute(db)
        .await
        .expect("assign role");
        perm(db, private, "u:bob", 1).await;
        perm(db, roled, &format!("r:{role}"), 1).await;
        sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'u:alice', 1, 1, 0)")
            .bind(history)
            .execute(db)
            .await
            .expect("history perm");
        crate::api::test_util::restrict_ruled(db).await;
        sqlx::query(
            "INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at) VALUES($1, 'locked', 0, 4000000000)",
        )
        .bind(crate::db::secret_key(&crate::api::test_util::test_grant("g1")))
        .execute(db)
        .await
        .expect("grant");
        ids.insert("general", post(db, general, "bob", "the needle", t).await);
        ids.insert("private", post(db, private, "bob", "needle!", t).await);
        ids.insert("roled", post(db, roled, "bob", "NEEDLE", t).await);
        ids.insert("old", post(db, history, "bob", "old needle", t - 100).await);
        ids.insert("new", post(db, history, "bob", "new needle", t + 100).await);
        let dm: i64 =
            sqlx::query("INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id")
                .fetch_one(db)
                .await
                .expect("dm")
                .try_get(0)
                .expect("dm id");
        sqlx::query("INSERT INTO messages(dm_id, author, content, created_at) VALUES($1, 'bob', 'dm needle', $2)")
            .bind(dm)
            .bind(t)
            .execute(db)
            .await
            .expect("dm message");
        let grant = |value: &str| {
            let mut h = HeaderMap::new();
            h.insert(
                "x-guest-grant",
                crate::api::test_util::test_grant(value)
                    .parse()
                    .expect("header"),
            );
            h
        };
        let expect = |names: &[&str]| {
            let mut want: Vec<i64> = names.iter().map(|n| ids[n]).collect();
            want.sort_by(|a, b| b.cmp(a));
            want
        };
        for q in [Some("needle"), Some("ee"), None] {
            let guest = |servers: Option<&[&str]>| {
                let mut sq = query(q);
                sq.servers = servers.map(|list| list.iter().map(|n| n.to_string()).collect());
                sq
            };
            let cases: Vec<(Option<User>, HeaderMap, SearchQuery, Vec<i64>)> = vec![
                (
                    Some(mem_user("alice", false)),
                    HeaderMap::new(),
                    query(q),
                    expect(&["general", "roled", "new", "vault"]),
                ),
                (
                    Some(mem_user("bob", false)),
                    HeaderMap::new(),
                    query(q),
                    expect(&["general", "private"]),
                ),
                (
                    Some(mem_user("root", true)),
                    HeaderMap::new(),
                    query(q),
                    expect(&["general", "private", "roled", "old", "new"]),
                ),
                (
                    Some(mem_user("zed", false)),
                    HeaderMap::new(),
                    query(q),
                    Vec::new(),
                ),
                (
                    None,
                    HeaderMap::new(),
                    guest(Some(&["rchat", "locked", "other"])),
                    expect(&["general", "lobby"]),
                ),
                (
                    None,
                    grant("g1"),
                    guest(Some(&["rchat", " LOCKED"])),
                    expect(&["general", "vault"]),
                ),
                (None, grant("nope"), guest(Some(&["locked"])), Vec::new()),
                (None, grant("g1"), guest(None), Vec::new()),
                (
                    None,
                    HeaderMap::new(),
                    guest(Some(&["comma, inc"])),
                    expect(&["hall"]),
                ),
                (
                    None,
                    HeaderMap::new(),
                    guest(Some(&["comma", " inc"])),
                    Vec::new(),
                ),
            ];
            for (n, (user, headers, sq, want)) in cases.into_iter().enumerate() {
                let got = found(&state, user, headers, sq).await;
                assert_eq!(got, want, "case {n} q={q:?}");
            }
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn search_keyset_pages_and_dates() {
        let (state, path) = temp_state("search_pages").await;
        let db = &state.db;
        let cid = general_id(db).await;
        add_member(db, "rchat", "alice", 0, 0, 0).await;
        seed(db, cid, 6000).await;
        let alice = || Some(mem_user("alice", false));
        for q in ["needle", "ne", "NeEdLe"] {
            let all: Vec<i64> = sqlx::query(
                "SELECT id FROM messages WHERE lower(content) LIKE $1 ORDER BY id DESC",
            )
            .bind(format!("%{}%", q.to_lowercase()))
            .fetch_all(db)
            .await
            .expect("expected ids")
            .iter()
            .map(|r| r.try_get(0).expect("id"))
            .collect();
            assert!(all.len() > 50, "q={q}");
            let mut seen: Vec<i64> = Vec::new();
            let mut before = None;
            loop {
                let mut sq = query(Some(q));
                sq.before = before;
                let page = found(&state, alice(), HeaderMap::new(), sq).await;
                assert!(page.len() <= 25);
                assert!(page.windows(2).all(|w| w[0] > w[1]), "q={q}");
                if let (Some(last), Some(first)) = (seen.last(), page.first()) {
                    assert!(last > first, "pages overlap for q={q}");
                }
                seen.extend(&page);
                match page.len() {
                    25 => before = page.last().copied(),
                    _ => break,
                }
            }
            assert_eq!(seen, all, "q={q}");
            let mut legacy = query(Some(q));
            legacy.offset = Some(25);
            assert_eq!(
                found(&state, alice(), HeaderMap::new(), legacy).await,
                all[25..50]
            );
        }
        let window = |before_ts: Option<i64>, after_ts: Option<i64>, q: Option<&str>| {
            let mut sq = query(q);
            sq.before_ts = before_ts;
            sq.after_ts = after_ts;
            sq
        };
        let cases: Vec<(SearchQuery, Vec<i64>)> = vec![
            (window(Some(150), Some(50), Some("needle")), vec![100]),
            (window(Some(150), Some(100), Some("needle")), vec![]),
            (window(Some(100), Some(0), Some("needle")), vec![50]),
            (window(Some(51), None, Some("ne")), vec![50]),
            (window(None, Some(5949), Some("needle")), vec![6000, 5950]),
            (window(Some(4), None, None), vec![3, 2, 1]),
            (window(Some(3), Some(1), None), vec![2]),
        ];
        for (n, (sq, want)) in cases.into_iter().enumerate() {
            assert_eq!(
                found(&state, alice(), HeaderMap::new(), sq).await,
                want,
                "case {n}"
            );
        }
        let mut sq = window(Some(5000), Some(1000), Some("needle"));
        sq.before = Some(2001);
        let page = found(&state, alice(), HeaderMap::new(), sq).await;
        assert_eq!(page.len(), 20);
        assert_eq!(page.first(), Some(&2000));
        assert_eq!(page.last(), Some(&1050));
        done(state, path).await;
    }

    async fn plan(db: &Db, user: &User, sq: SearchQuery) -> String {
        let (sql, binds) = search_sql(db, Some(user), &HeaderMap::new(), sq, None, SEARCH_PAGE)
            .await
            .expect("search sql")
            .expect("built");
        let explain = format!("EXPLAIN QUERY PLAN {sql}");
        bind_all(sqlx::query(sqlx::AssertSqlSafe(explain)), &binds)
            .fetch_all(db)
            .await
            .expect("explain")
            .iter()
            .map(|r| r.try_get::<String, _>(3).expect("detail"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[tokio::test]
    async fn search_plans_use_indexes() {
        let (state, path) = temp_state("search_plan").await;
        let db = &state.db;
        let cid = general_id(db).await;
        add_member(db, "rchat", "alice", 0, 0, 0).await;
        seed(db, cid, 5000).await;
        let alice = mem_user("alice", false);
        let fts = plan(db, &alice, query(Some("needle"))).await;
        assert!(fts.contains("SCAN messages_fts VIRTUAL TABLE"), "{fts}");
        assert!(
            fts.contains("SEARCH m USING INTEGER PRIMARY KEY (rowid=?)"),
            "{fts}"
        );
        let mut paged = query(Some("needle"));
        paged.before = Some(3000);
        paged.from = Some("alice".to_string());
        paged.channel_id = Some(cid);
        paged.before_ts = Some(4000);
        let filtered = plan(db, &alice, paged).await;
        assert!(
            filtered.contains("SCAN messages_fts VIRTUAL TABLE"),
            "{filtered}"
        );
        let mut short = query(Some("ne"));
        short.before = Some(3000);
        let like = plan(db, &alice, short).await;
        assert!(
            like.contains("SEARCH m USING INTEGER PRIMARY KEY (rowid<?)"),
            "{like}"
        );
        let mut dated = query(None);
        dated.after_ts = Some(10);
        let browse = plan(db, &alice, dated).await;
        assert!(browse.contains("SCAN m"), "{browse}");
        for detail in [fts, filtered, like, browse] {
            assert!(!detail.contains("TEMP B-TREE"), "{detail}");
            assert!(!detail.contains("SCAN c"), "{detail}");
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn search_index_tracks_edits_and_deletes() {
        let (state, path) = temp_state("search_sync").await;
        let db = &state.db;
        let cid = general_id(db).await;
        add_member(db, "rchat", "alice", 0, 0, 0).await;
        let sent = send_with(&state, cid, "alice", "alpha beta".to_string(), None)
            .await
            .expect("send")
            .0
            .id;
        let alice = || Some(mem_user("alice", false));
        let hits = |q: &str| found(&state, alice(), HeaderMap::new(), query(Some(q)));
        assert_eq!(hits("beta").await, vec![sent]);
        sqlx::query("UPDATE messages SET content = 'gamma delta' WHERE id = $1")
            .bind(sent)
            .execute(db)
            .await
            .expect("edit");
        assert_eq!(hits("beta").await, Vec::<i64>::new());
        assert_eq!(hits("delta").await, vec![sent]);
        assert_eq!(fts_hits(db, "beta").await, 0);
        sqlx::query("UPDATE messages SET media_removed = 1 WHERE id = $1")
            .bind(sent)
            .execute(db)
            .await
            .expect("unrelated update");
        assert_eq!(hits("delta").await, vec![sent]);
        fts_ok(db).await;
        let root = post(db, cid, "alice", "root delta", 1).await;
        sqlx::query("INSERT INTO messages(channel_id, thread_root_id, author, content, created_at) VALUES($1, $2, 'alice', 'reply delta', 2)")
            .bind(cid)
            .bind(root)
            .execute(db)
            .await
            .expect("reply");
        assert_eq!(fts_hits(db, "delta").await, 3);
        let _ = delete_message(
            State(state.clone()),
            Path(sent),
            Authed(mem_user("alice", false)),
        )
        .await
        .expect("delete");
        sqlx::query("DELETE FROM messages WHERE id = $1")
            .bind(root)
            .execute(db)
            .await
            .expect("delete root");
        assert_eq!(fts_hits(db, "delta").await, 0);
        assert_eq!(hits("delta").await, Vec::<i64>::new());
        let doomed = add_channel(db, "doomed", "text").await;
        post(db, doomed, "alice", "epsilon", 3).await;
        assert_eq!(fts_hits(db, "epsilon").await, 1);
        sqlx::query("DELETE FROM channels WHERE id = $1")
            .bind(doomed)
            .execute(db)
            .await
            .expect("delete channel");
        assert_eq!(fts_hits(db, "epsilon").await, 0);
        fts_ok(db).await;
        done(state, path).await;
    }

    fn reopened(db: Db) -> AppState {
        AppState::new(
            db,
            crate::ws::Hub::new(),
            None,
            None,
            crate::instance::Instance::ephemeral(),
        )
    }

    #[tokio::test]
    async fn search_index_backfills_existing_db() {
        let (state, path) = temp_state("search_backfill").await;
        let cid = general_id(&state.db).await;
        add_member(&state.db, "rchat", "alice", 0, 0, 0).await;
        drop_fts(&state.db).await;
        seed(&state.db, cid, 500).await;
        let alice = || Some(mem_user("alice", false));
        let like = found(&state, alice(), HeaderMap::new(), query(Some("needle"))).await;
        assert_eq!(like.len(), 10);
        state.db.close().await;
        for _ in 0..2 {
            let state = reopened(crate::db::open(path.to_str()).await.expect("reopen"));
            assert!(has_fts(&state.db));
            assert_eq!(fts_hits(&state.db, "needle").await, 10);
            fts_ok(&state.db).await;
            let got = found(&state, alice(), HeaderMap::new(), query(Some("needle"))).await;
            assert_eq!(got, like);
            state.db.close().await;
        }
        let state = reopened(crate::db::open(path.to_str()).await.expect("reopen"));
        done(state, path).await;
    }

    fn around(before: Option<i64>, after: Option<i64>, at: Option<i64>, limit: i64) -> PageQuery {
        PageQuery {
            before,
            after,
            around: at,
            limit: Some(limit),
        }
    }

    #[tokio::test]
    async fn pages_around_and_after() {
        let (state, path) = temp_state("page_around").await;
        let db = &state.db;
        let cid = general_id(db).await;
        let mut ids = Vec::new();
        for _ in 0..120 {
            ids.push(insert(db, Some(cid), None, None, "alice").await);
        }
        let root = ids[10];
        let mut replies = Vec::new();
        for _ in 0..30 {
            replies.push(insert(db, Some(cid), None, Some(root), "bob").await);
        }
        let channel = |q: PageQuery| {
            let state = state.clone();
            async move {
                channel_messages(
                    State(state),
                    MaybeAuthed(None),
                    HeaderMap::new(),
                    Path(cid),
                    Query(q),
                )
                .await
                .expect("page")
                .0
                .iter()
                .map(|m| m.id)
                .collect::<Vec<i64>>()
            }
        };
        assert_eq!(
            channel(around(None, None, Some(ids[60]), 50)).await,
            ids[35..85]
        );
        assert_eq!(
            channel(around(None, None, Some(ids[3]), 50)).await,
            ids[0..28]
        );
        assert_eq!(
            channel(around(None, None, Some(ids[110]), 50)).await,
            ids[85..120]
        );
        assert_eq!(
            channel(around(None, None, Some(ids[60]), 1)).await,
            ids[60..61]
        );
        assert_eq!(
            channel(around(None, Some(ids[20]), None, 10)).await,
            ids[21..31]
        );
        assert_eq!(
            channel(around(None, Some(ids[115]), None, 50)).await,
            ids[116..120]
        );
        assert_eq!(
            channel(around(Some(ids[5]), Some(ids[20]), Some(ids[60]), 4)).await,
            ids[58..62]
        );
        assert_eq!(
            channel(around(Some(ids[50]), Some(ids[20]), None, 5)).await,
            ids[21..26]
        );
        let thread = thread_messages(
            State(state.clone()),
            MaybeAuthed(None),
            HeaderMap::new(),
            Path(root),
            Query(around(None, None, Some(replies[15]), 10)),
        )
        .await
        .expect("thread")
        .0
        .iter()
        .map(|m| m.id)
        .collect::<Vec<i64>>();
        assert_eq!(thread, replies[10..20]);
        let dm: i64 =
            sqlx::query("INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id")
                .fetch_one(db)
                .await
                .expect("dm")
                .try_get(0)
                .expect("dm id");
        let mut dm_ids = Vec::new();
        for _ in 0..20 {
            dm_ids.push(insert(db, None, Some(dm), None, "bob").await);
        }
        let dm_page = dm_messages(
            State(state.clone()),
            Path(dm),
            Authed(mem_user("alice", false)),
            Query(around(None, None, Some(dm_ids[2]), 10)),
        )
        .await
        .expect("dm page")
        .0
        .iter()
        .map(|m| m.id)
        .collect::<Vec<i64>>();
        assert_eq!(dm_page, dm_ids[0..7]);
        let joined = now() - 100;
        add_member(db, "rchat", "late", 0, 0, joined).await;
        sqlx::query("UPDATE messages SET created_at = $1 WHERE channel_id = $2 AND id < $3")
            .bind(joined - 10)
            .bind(cid)
            .bind(ids[60])
            .execute(db)
            .await
            .expect("age messages");
        sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'u:late', 1, 1, 0)")
            .bind(cid)
            .execute(db)
            .await
            .expect("no history perm");
        crate::api::test_util::restrict_ruled(db).await;
        let gated = channel_messages(
            State(state.clone()),
            MaybeAuthed(Some(mem_user("late", false))),
            HeaderMap::new(),
            Path(cid),
            Query(around(None, None, Some(ids[62]), 50)),
        )
        .await
        .expect("gated page")
        .0
        .iter()
        .map(|m| m.id)
        .collect::<Vec<i64>>();
        assert_eq!(gated, ids[60..87]);
        done(state, path).await;
    }

    #[tokio::test]
    async fn unreads_skip_own_messages() {
        let (state, path) = temp_state("unread_own").await;
        let db = &state.db;
        let general = general_id(db).await;
        let t = now();
        add_member(db, "rchat", "alice", 0, 0, t).await;
        add_member(db, "rchat", "bob", 0, 0, t).await;
        let theirs = insert(db, Some(general), None, None, "bob").await;
        let mine = insert(db, Some(general), None, None, "alice").await;
        assert!(mine > theirs);
        let only_mine = add_channel(db, "mine", "text").await;
        insert(db, Some(only_mine), None, None, "alice").await;
        let dm: i64 =
            sqlx::query("INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id")
                .fetch_one(db)
                .await
                .expect("dm")
                .try_get(0)
                .expect("dm id");
        let sent = insert(db, None, Some(dm), None, "alice").await;
        let rchat = Some("rchat".to_string());
        let alice = unread_map(&state, "alice").await;
        assert_eq!(alice[&format!("c{general}")], (rchat.clone(), theirs, 0));
        assert!(!alice.contains_key(&format!("c{only_mine}")));
        assert!(!alice.contains_key(&format!("d{dm}")));
        let bob = unread_map(&state, "bob").await;
        assert_eq!(bob[&format!("c{general}")], (rchat.clone(), mine, 0));
        assert_eq!(bob[&format!("d{dm}")], (None, sent, 0));
        let reply = insert(db, None, Some(dm), None, "bob").await;
        let alice = unread_map(&state, "alice").await;
        assert_eq!(alice[&format!("d{dm}")], (None, reply, 0));
        done(state, path).await;
    }

    #[tokio::test]
    async fn search_query_parsing() {
        let sq = SearchQuery::parse("q=hi&servers=a%2Cb&servers=c&channel_id=4&unknown=1")
            .expect("parse");
        assert_eq!(sq.q.as_deref(), Some("hi"));
        assert_eq!(sq.channel_id, Some(4));
        assert_eq!(sq.servers, Some(vec!["a,b".to_string(), "c".to_string()]));
        assert!(SearchQuery::parse("").expect("empty").servers.is_none());
        assert!(matches!(
            SearchQuery::parse("before=x"),
            Err(ApiError(StatusCode::BAD_REQUEST, _))
        ));
        let (state, path) = temp_state("search_parse").await;
        add_member(&state.db, "rchat", "alice", 0, 0, 0).await;
        for raw in ["q=a%00b", "from=a%00", "servers=rch%00at", "server=x%00"] {
            let got = search(
                State(state.clone()),
                MaybeAuthed(Some(mem_user("alice", false))),
                HeaderMap::new(),
                RawQuery(Some(raw.to_string())),
            )
            .await;
            assert!(
                matches!(got, Err(ApiError(StatusCode::BAD_REQUEST, _))),
                "{raw}"
            );
        }
        let ok = search(
            State(state.clone()),
            MaybeAuthed(Some(mem_user("alice", false))),
            HeaderMap::new(),
            RawQuery(Some("q=hello".to_string())),
        )
        .await;
        assert!(ok.is_ok());
        done(state, path).await;
    }

    #[tokio::test]
    async fn unreads_default_lists_only_unread_scopes() {
        let (state, path) = temp_state("unreads_only").await;
        let db = &state.db;
        let general = general_id(db).await;
        let quiet = add_channel(db, "quiet", "text").await;
        add_member(db, "rchat", "alice", 0, 0, 0).await;
        add_member(db, "rchat", "bob", 0, 0, 0).await;
        let loud = insert(db, Some(general), None, None, "bob").await;
        let old = insert(db, Some(quiet), None, None, "bob").await;
        let dm: i64 =
            sqlx::query("INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id")
                .fetch_one(db)
                .await
                .expect("dm")
                .try_get(0)
                .expect("id");
        let read_dm: i64 =
            sqlx::query("INSERT INTO dms(user_a, user_b) VALUES('alice', 'carol') RETURNING id")
                .fetch_one(db)
                .await
                .expect("dm")
                .try_get(0)
                .expect("id");
        let dm_msg = insert(db, None, Some(dm), None, "bob").await;
        let carol = insert(db, None, Some(read_dm), None, "carol").await;
        insert(db, None, Some(read_dm), None, "alice").await;
        for (scope, last) in [(format!("c{quiet}"), old), (format!("d{read_dm}"), carol)] {
            sqlx::query(
                "INSERT INTO read_state(username, scope, last_read) VALUES('alice', $1, $2)",
            )
            .bind(scope)
            .bind(last)
            .execute(db)
            .await
            .expect("read");
        }
        let got = unreads(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            Query(UnreadsQuery { all: None }),
        )
        .await
        .expect("unreads")
        .0;
        assert!(!got.more);
        let scopes: Vec<(String, i64)> =
            got.items.into_iter().map(|u| (u.scope, u.latest)).collect();
        assert_eq!(
            scopes,
            vec![(format!("d{dm}"), dm_msg), (format!("c{general}"), loud)]
        );
        let all = unread_map(&state, "alice").await;
        assert_eq!(all.len(), 4);
        done(state, path).await;
    }

    #[tokio::test]
    async fn search_cursor_header_walks_windows() {
        let (state, path) = temp_state("search_windows").await;
        let db = &state.db;
        let cid = general_id(db).await;
        add_member(db, "rchat", "alice", 0, 0, 0).await;
        seed(db, cid, 20000).await;
        let alice = Some(mem_user("alice", false));
        for q in ["needle", "ne"] {
            let expected: Vec<i64> = sqlx::query(
                "SELECT id FROM messages WHERE lower(content) LIKE $1 ORDER BY id DESC",
            )
            .bind(format!("%{q}%"))
            .fetch_all(db)
            .await
            .expect("expected")
            .iter()
            .map(|r| r.try_get(0).expect("id"))
            .collect();
            let mut seen = Vec::new();
            let mut cursor: Option<String> = None;
            let mut pages = 0;
            loop {
                let mut sq = query(Some(q));
                sq.cursor = cursor.clone();
                let (page, next) = search_paged(&state, alice.as_ref(), &HeaderMap::new(), sq)
                    .await
                    .expect("search");
                assert!(page.len() as i64 <= SEARCH_PAGE);
                seen.extend(page.iter().map(|r| r.message.id));
                pages += 1;
                match next {
                    Some(id) => cursor = Some(encode_cursor(&[&id.to_string()])),
                    None => break,
                }
            }
            assert_eq!(seen, expected, "q={q}");
            assert!(pages >= expected.len() / SEARCH_PAGE as usize, "q={q}");
        }
        let mut deep = query(Some("needle"));
        deep.offset = Some(10_000);
        let capped = found(&state, alice.clone(), HeaderMap::new(), deep).await;
        assert!(capped.is_empty());
        let mut bad = query(Some("needle"));
        bad.cursor = Some("nothex".to_string());
        assert!(matches!(
            search_paged(&state, alice.as_ref(), &HeaderMap::new(), bad).await,
            Err(ApiError(StatusCode::BAD_REQUEST, _))
        ));
        done(state, path).await;
    }

    #[tokio::test]
    async fn send_path_checks_membership_and_slowmode() {
        let (state, path) = temp_state("send_gate").await;
        let db = &state.db;
        let cid = general_id(db).await;
        add_member(db, "rchat", "alice", 0, 0, 0).await;
        let send = |who: &str, cid: i64| {
            let state = state.clone();
            let who = who.to_string();
            async move {
                send_channel_message(
                    State(state),
                    Path(cid),
                    Authed(mem_user(&who, false)),
                    Json(SendReq {
                        content: "hello".to_string(),
                        media_id: None,
                        media_spoiler: None,
                        p2p: None,
                        reply_to: None,
                        mention_reply: true,
                        forward_of: None,
                    }),
                )
                .await
                .map(|_| ())
            }
        };
        assert!(send("alice", cid).await.is_ok());
        assert!(matches!(
            send("mallory", cid).await,
            Err(ApiError(StatusCode::FORBIDDEN, _))
        ));
        assert!(matches!(
            send("alice", 9999).await,
            Err(ApiError(StatusCode::NOT_FOUND, _))
        ));
        sqlx::query("UPDATE channels SET slowmode_seconds = 60 WHERE id = $1")
            .bind(cid)
            .execute(db)
            .await
            .expect("slowmode");
        assert!(matches!(
            send("alice", cid).await,
            Err(ApiError(StatusCode::TOO_MANY_REQUESTS, _))
        ));
        let voice = add_channel(db, "talk", "voice").await;
        assert!(matches!(
            send("alice", voice).await,
            Err(ApiError(StatusCode::BAD_REQUEST, _))
        ));
        done(state, path).await;
    }

    async fn say(
        state: &AppState,
        to: (Option<i64>, Option<i64>, Option<i64>),
        author: &str,
        content: &str,
    ) -> Message {
        say_to(state, to, author, content, None, true)
            .await
            .expect("send")
    }

    async fn say_to(
        state: &AppState,
        to: (Option<i64>, Option<i64>, Option<i64>),
        author: &str,
        content: &str,
        reply_to: Option<i64>,
        mention_reply: bool,
    ) -> Result<Message, ApiError> {
        let req = SendReq {
            content: content.to_string(),
            media_id: None,
            media_spoiler: None,
            p2p: None,
            reply_to,
            mention_reply,
            forward_of: None,
        };
        let user = Authed(mem_user(author, false));
        let sent = match to {
            (Some(cid), _, _) => {
                send_channel_message(State(state.clone()), Path(cid), user, Json(req)).await
            }
            (_, Some(dm), _) => {
                send_dm_message(State(state.clone()), Path(dm), user, Json(req)).await
            }
            (_, _, Some(root)) => {
                send_thread_message(State(state.clone()), Path(root), user, Json(req)).await
            }
            (None, None, None) => panic!("no target"),
        };
        sent.map(|r| r.0)
    }

    fn reply_pings(
        rx: &mut tokio::sync::broadcast::Receiver<WsEvent>,
    ) -> Vec<(String, String, i64)> {
        std::iter::from_fn(|| rx.try_recv().ok())
            .filter_map(|ev| match ev {
                WsEvent::Ping { username, ping } => {
                    Some((username, ping.kind.as_str().to_string(), ping.message_id))
                }
                _ => None,
            })
            .collect()
    }

    #[test]
    fn reply_snippets_are_one_plain_line() {
        assert_eq!(reply_snippet("hello\nworld"), "hello");
        assert_eq!(reply_snippet("\n\n```rust\nlet x = 1;\n```"), "let x = 1;");
        assert_eq!(
            reply_snippet("> **bold** _it_ ~~gone~~ `code` snake_case"),
            "bold it gone code snake_case"
        );
        assert_eq!(reply_snippet("## Title"), "Title");
        assert_eq!(reply_snippet("-# small print"), "small print");
        assert_eq!(
            reply_snippet("see [the docs](https://x.y/z) or <https://a.b>"),
            "see the docs or https://a.b"
        );
        assert_eq!(reply_snippet("a ||secret|| b"), "a ||secret|| b");
        assert_eq!(reply_snippet("2 \\* 3   =  6"), "2 * 3 = 6");
        assert_eq!(reply_snippet(""), "");
        assert_eq!(reply_snippet(&"é".repeat(300)).chars().count(), 200);
        assert_eq!(
            reply_snippet("a\u{202E}b\u{200F}c\u{2066}d\u{2069}\u{200E}e\u{0007}f\u{202A}g"),
            "abcdefg"
        );
        assert_eq!(reply_snippet("x\ty\u{000B}z\u{001B}[0m"), "x y z[0m");
    }

    #[tokio::test]
    async fn replies_quote_messages_from_the_same_place() {
        let (state, path) = temp_state("replies").await;
        let db = &state.db;
        let cid = general_id(db).await;
        for name in ["alice", "bob", "carol"] {
            add_user(db, name, &name.to_uppercase()).await;
            add_member(db, "rchat", name, 0, 0, 1).await;
        }
        let other = add_channel(db, "other", "text").await;
        let secret = add_channel(db, "secret", "text").await;
        perm(db, secret, "u:carol", 1).await;
        let dm: i64 =
            sqlx::query("INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id")
                .fetch_one(db)
                .await
                .expect("dm")
                .try_get(0)
                .expect("id");
        let general = (Some(cid), None, None);
        let top = say(
            &state,
            general,
            "alice",
            "**Lunch** at _noon_?\nsecond line",
        )
        .await;
        let elsewhere = say(&state, (Some(other), None, None), "alice", "elsewhere").await;
        let hidden = say(&state, (Some(secret), None, None), "carol", "hidden").await;
        let in_thread = say(&state, (None, None, Some(top.id)), "carol", "thread talk").await;
        let side = say(&state, general, "carol", "side").await;
        let side_reply = say(&state, (None, None, Some(side.id)), "carol", "side talk").await;
        let direct = say(&state, (None, Some(dm), None), "alice", "dm hello").await;
        let mut rx = state.hub.subscribe();

        let reply = say_to(&state, general, "bob", "yes", Some(top.id), true)
            .await
            .expect("reply");
        let quote = reply.reply_to.clone().expect("quote");
        assert_eq!(quote.id, top.id);
        assert_eq!(
            quote.author.as_ref().map(|a| a.username.as_str()),
            Some("alice")
        );
        assert_eq!(quote.content, "Lunch at noon?");
        assert!(!quote.has_media && !quote.deleted && quote.mention);
        assert_eq!(
            reply_pings(&mut rx),
            vec![("alice".to_string(), "reply".to_string(), reply.id)]
        );
        let listed = list(&state, cid, Some("carol")).await.expect("list");
        let shown = listed.iter().find(|m| m.id == reply.id).expect("listed");
        assert_eq!(
            serde_json::to_value(&shown.reply_to).expect("json"),
            serde_json::to_value(&reply.reply_to).expect("json")
        );

        let quiet = say_to(&state, general, "bob", "quiet", Some(top.id), false)
            .await
            .expect("quiet reply");
        assert!(!quiet.reply_to.as_ref().expect("quote").mention);
        assert!(reply_pings(&mut rx).is_empty());

        let both = say_to(
            &state,
            general,
            "bob",
            "@alice and @carol",
            Some(top.id),
            true,
        )
        .await
        .expect("reply with mentions");
        assert_eq!(
            reply_pings(&mut rx),
            vec![
                ("alice".to_string(), "reply".to_string(), both.id),
                ("carol".to_string(), "mention".to_string(), both.id)
            ]
        );
        let named = say_to(&state, general, "bob", "@alice anyway", Some(top.id), false)
            .await
            .expect("quiet reply with a mention");
        assert_eq!(
            reply_pings(&mut rx),
            vec![("alice".to_string(), "mention".to_string(), named.id)]
        );
        let own = say_to(&state, general, "alice", "me again", Some(top.id), true)
            .await
            .expect("reply to yourself");
        assert!(!own.reply_to.as_ref().expect("quote").mention);
        assert!(reply_pings(&mut rx).is_empty());

        let in_reply = say_to(
            &state,
            (None, None, Some(top.id)),
            "bob",
            "a",
            Some(in_thread.id),
            true,
        )
        .await
        .expect("reply inside the thread");
        assert_eq!(in_reply.thread_root_id, Some(top.id));
        assert_eq!(
            reply_pings(&mut rx),
            vec![("carol".to_string(), "reply".to_string(), in_reply.id)]
        );
        say_to(
            &state,
            (None, None, Some(top.id)),
            "bob",
            "b",
            Some(top.id),
            false,
        )
        .await
        .expect("reply to the root inside its thread");
        say_to(
            &state,
            (None, Some(dm), None),
            "bob",
            "c",
            Some(direct.id),
            true,
        )
        .await
        .expect("reply in the DM");
        let _ = reply_pings(&mut rx);

        let refused = [
            (general, elsewhere.id),
            (general, hidden.id),
            (general, in_thread.id),
            (general, direct.id),
            (general, i64::MAX),
            ((None, None, Some(top.id)), side.id),
            ((None, None, Some(top.id)), side_reply.id),
            ((None, None, Some(top.id)), elsewhere.id),
            ((None, Some(dm), None), top.id),
            ((None, Some(dm), None), i64::MAX),
        ];
        for (to, target) in refused {
            match say_to(&state, to, "bob", "nope", Some(target), true).await {
                Err(ApiError(StatusCode::BAD_REQUEST, msg)) => {
                    assert_eq!(msg, "Cannot reply to that message", "{target}")
                }
                _ => panic!("reply to {target} was not refused"),
            }
        }
        assert!(reply_pings(&mut rx).is_empty());
        sqlx::query("UPDATE messages SET kind = 'call' WHERE id = $1")
            .bind(direct.id)
            .execute(db)
            .await
            .expect("call log");
        assert!(matches!(
            say_to(
                &state,
                (None, Some(dm), None),
                "bob",
                "d",
                Some(direct.id),
                true
            )
            .await,
            Err(ApiError(StatusCode::BAD_REQUEST, _))
        ));

        let gone = say(&state, general, "carol", "to be deleted").await;
        let late = say_to(&state, general, "bob", "too late", Some(gone.id), true)
            .await
            .expect("reply");
        let _ = reply_pings(&mut rx);
        let _ = delete_message(
            State(state.clone()),
            Path(gone.id),
            Authed(mem_user("carol", false)),
        )
        .await
        .expect("delete")
        .0;
        let listed = list(&state, cid, Some("bob")).await.expect("list");
        let quote = listed
            .iter()
            .find(|m| m.id == late.id)
            .and_then(|m| m.reply_to.clone())
            .expect("quote of a deleted message");
        assert_eq!(quote.id, gone.id);
        assert!(quote.deleted && quote.author.is_none() && quote.content.is_empty());
        assert!(quote.mention);
        assert!(matches!(
            say_to(&state, general, "bob", "x", Some(gone.id), true).await,
            Err(ApiError(StatusCode::BAD_REQUEST, _))
        ));
        done(state, path).await;
    }

    #[tokio::test]
    async fn reply_pings_need_the_author_to_see_the_reply() {
        let (state, path) = temp_state("reply_pings").await;
        let db = &state.db;
        let cid = general_id(db).await;
        for name in ["alice", "bob", "carol"] {
            add_user(db, name, name).await;
            add_member(db, "rchat", name, 0, 0, 1).await;
        }
        let secret = add_channel(db, "secret", "text").await;
        perm(db, secret, "u:bob", 1).await;
        perm(db, secret, "u:carol", 1).await;
        let top = say(&state, (Some(secret), None, None), "carol", "mine").await;
        sqlx::query("UPDATE channel_perms SET can_view = 0 WHERE subject = 'u:carol'")
            .execute(db)
            .await
            .expect("hide");
        let mut rx = state.hub.subscribe();
        say_to(
            &state,
            (Some(secret), None, None),
            "bob",
            "@carol hi",
            Some(top.id),
            true,
        )
        .await
        .expect("reply");
        assert!(reply_pings(&mut rx).is_empty());
        assert!(ping_rows(db, "carol").await.is_empty());

        let joined = now() - 1000;
        let early = say(&state, (Some(cid), None, None), "alice", "early").await;
        sqlx::query("UPDATE messages SET created_at = $1 WHERE id = $2")
            .bind(joined - 500)
            .bind(early.id)
            .execute(db)
            .await
            .expect("backdate");
        let reply = say_to(
            &state,
            (Some(cid), None, None),
            "bob",
            "late",
            Some(early.id),
            true,
        )
        .await
        .expect("reply");
        add_user(db, "dave", "dave").await;
        add_member(db, "rchat", "dave", 0, 0, joined).await;
        sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'u:dave', 1, 1, 0)")
            .bind(cid)
            .execute(db)
            .await
            .expect("no history");
        crate::api::test_util::restrict_ruled(db).await;
        perm(db, cid, "u:bob", 1).await;
        let listed = list(&state, cid, Some("dave")).await.expect("list");
        let quote = listed
            .iter()
            .find(|m| m.id == reply.id)
            .and_then(|m| m.reply_to.clone())
            .expect("quote");
        assert!(quote.deleted && quote.content.is_empty() && quote.author.is_none());
        assert!(matches!(
            say_to(
                &state,
                (Some(cid), None, None),
                "dave",
                "x",
                Some(early.id),
                true
            )
            .await,
            Err(ApiError(StatusCode::BAD_REQUEST, _))
        ));
        let full = list(&state, cid, Some("bob")).await.expect("list");
        let quote = full
            .iter()
            .find(|m| m.id == reply.id)
            .and_then(|m| m.reply_to.clone())
            .expect("quote");
        assert_eq!(quote.content, "early");
        done(state, path).await;
    }

    #[tokio::test]
    async fn broadcast_replies_carry_only_the_quote_reference() {
        let (state, path) = temp_state("reply_broadcast").await;
        let db = &state.db;
        let cid = general_id(db).await;
        for name in ["alice", "bob"] {
            add_user(db, name, name).await;
            add_member(db, "rchat", name, 0, 0, 1).await;
        }
        let joined = now() - 1000;
        let early = say(&state, (Some(cid), None, None), "alice", "early secret").await;
        sqlx::query("UPDATE messages SET created_at = $1 WHERE id = $2")
            .bind(joined - 500)
            .bind(early.id)
            .execute(db)
            .await
            .expect("backdate");
        add_user(db, "dave", "dave").await;
        add_member(db, "rchat", "dave", 0, 0, joined).await;
        sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'u:dave', 1, 1, 0)")
            .bind(cid)
            .execute(db)
            .await
            .expect("no history");
        crate::api::test_util::restrict_ruled(db).await;
        perm(db, cid, "u:bob", 1).await;
        let mut rx = state.hub.subscribe();
        let reply = say_to(
            &state,
            (Some(cid), None, None),
            "bob",
            "late",
            Some(early.id),
            true,
        )
        .await
        .expect("reply");
        let sent = reply.reply_to.clone().expect("sender quote");
        assert_eq!(sent.content, "early secret");
        assert!(!sent.partial);
        let event = std::iter::from_fn(|| rx.try_recv().ok())
            .find(|ev| matches!(ev, WsEvent::Message { message, .. } if message.id == reply.id))
            .expect("message event");
        let reposted = crate::ws::current(&state, event.clone())
            .await
            .expect("repost");
        for ev in [event, reposted] {
            let WsEvent::Message { message, .. } = &ev else {
                panic!("not a message event");
            };
            let quote = message.reply_to.clone().expect("quote ref");
            assert_eq!(quote.id, early.id);
            assert!(quote.partial && quote.mention && !quote.deleted && !quote.has_media);
            assert!(quote.author.is_none() && quote.content.is_empty());
            let json = serde_json::to_string(&ev).expect("json");
            assert!(!json.contains("early secret"), "{json}");
            assert!(!json.contains("\"alice\""), "{json}");
        }
        let around = |user: &'static str| {
            channel_messages(
                State(state.clone()),
                MaybeAuthed(Some(mem_user(user, false))),
                HeaderMap::new(),
                Path(cid),
                Query(PageQuery {
                    before: None,
                    after: None,
                    around: Some(reply.id),
                    limit: Some(1),
                }),
            )
        };
        let hidden = around("dave").await.expect("dave").0;
        assert_eq!(hidden.len(), 1);
        let quote = hidden[0].reply_to.clone().expect("quote");
        assert_eq!(hidden[0].id, reply.id);
        assert!(quote.deleted && !quote.partial && quote.author.is_none());
        assert!(quote.content.is_empty());
        let shown = around("bob").await.expect("bob").0;
        let quote = shown[0].reply_to.clone().expect("quote");
        assert_eq!(shown[0].id, reply.id);
        assert!(!quote.deleted && !quote.partial);
        assert_eq!(quote.content, "early secret");
        assert_eq!(quote.author.map(|a| a.username), Some("alice".to_string()));
        done(state, path).await;
    }

    async fn ping_rows(db: &Db, who: &str) -> Vec<(String, String, i64, String, i64)> {
        sqlx::query("SELECT kind, scope, message_id, actor, seen FROM pings WHERE username = $1 ORDER BY id")
            .bind(who)
            .fetch_all(db)
            .await
            .expect("pings")
            .iter()
            .map(|r| {
                (
                    r.try_get(0).expect("kind"),
                    r.try_get(1).expect("scope"),
                    r.try_get(2).expect("message"),
                    r.try_get(3).expect("actor"),
                    r.try_get(4).expect("seen"),
                )
            })
            .collect()
    }

    fn pings_sent(
        rx: &mut tokio::sync::broadcast::Receiver<WsEvent>,
    ) -> Vec<(String, String, i64)> {
        std::iter::from_fn(|| rx.try_recv().ok())
            .filter_map(|ev| match ev {
                WsEvent::Ping { username, ping } => {
                    assert_eq!(ping.kind, crate::api::pings::PingKind::Mention);
                    Some((username, ping.scope, ping.message_id))
                }
                _ => None,
            })
            .collect()
    }

    async fn unread_pings(state: &AppState, name: &str, all: bool) -> HashMap<String, (i64, i64)> {
        unreads(
            State(state.clone()),
            Authed(mem_user(name, false)),
            Query(UnreadsQuery { all: Some(all) }),
        )
        .await
        .expect("unreads")
        .0
        .items
        .into_iter()
        .map(|u| (u.scope, (u.pings, u.latest)))
        .collect()
    }

    #[tokio::test]
    async fn mentions_ping_members_who_can_see_the_message() {
        let (state, path) = temp_state("mention_pings").await;
        let db = &state.db;
        let cid = general_id(db).await;
        for name in ["alice", "bob", "carol", "dave", "gone"] {
            add_user(db, name, &name.to_uppercase()).await;
        }
        for name in ["alice", "bob", "carol", "gone"] {
            add_member(db, "rchat", name, 0, 0, 1).await;
        }
        sqlx::query("UPDATE users SET password_hash = '!purging' WHERE username = 'gone'")
            .execute(db)
            .await
            .expect("purging");
        let secret = add_channel(db, "secret", "text").await;
        perm(db, secret, "u:alice", 1).await;
        perm(db, secret, "u:bob", 1).await;
        let dm: i64 =
            sqlx::query("INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id")
                .fetch_one(db)
                .await
                .expect("dm")
                .try_get(0)
                .expect("id");
        let mut rx = state.hub.subscribe();

        let top = say(
            &state,
            (Some(cid), None, None),
            "alice",
            "hi @Bob, @carol and @dave and @alice @gone @nobody `@carol` mail@bob @bob",
        )
        .await;
        let c = format!("c{cid}");
        assert_eq!(
            pings_sent(&mut rx),
            vec![
                ("bob".to_string(), c.clone(), top.id),
                ("carol".to_string(), c.clone(), top.id)
            ]
        );
        let hidden = say(&state, (Some(secret), None, None), "alice", "@bob @carol").await;
        assert_eq!(
            pings_sent(&mut rx),
            vec![("bob".to_string(), format!("c{secret}"), hidden.id)]
        );
        let reply = say(
            &state,
            (None, None, Some(top.id)),
            "bob",
            "@carol @bob look",
        )
        .await;
        assert_eq!(reply.thread_root_id, Some(top.id));
        assert_eq!(
            pings_sent(&mut rx),
            vec![("carol".to_string(), c.clone(), reply.id)]
        );
        let direct = say(&state, (None, Some(dm), None), "alice", "@bob @carol dm").await;
        assert_eq!(
            pings_sent(&mut rx),
            vec![("bob".to_string(), format!("d{dm}"), direct.id)]
        );
        let plain = say(&state, (Some(cid), None, None), "alice", "no mentions").await;
        assert!(pings_sent(&mut rx).is_empty());

        assert_eq!(
            ping_rows(db, "bob").await,
            vec![
                (
                    "mention".to_string(),
                    c.clone(),
                    top.id,
                    "alice".to_string(),
                    0
                ),
                (
                    "mention".to_string(),
                    format!("c{secret}"),
                    hidden.id,
                    "alice".to_string(),
                    0
                ),
                (
                    "mention".to_string(),
                    format!("d{dm}"),
                    direct.id,
                    "alice".to_string(),
                    0
                ),
            ]
        );
        for nobody in ["alice", "dave", "gone"] {
            assert!(ping_rows(db, nobody).await.is_empty(), "{nobody}");
        }
        let bob = unread_pings(&state, "bob", false).await;
        assert_eq!(bob.get(&c), Some(&(1, plain.id)));
        assert_eq!(bob.get(&format!("c{secret}")), Some(&(1, hidden.id)));
        assert_eq!(bob.get(&format!("d{dm}")), Some(&(1, direct.id)));
        let carol = unread_pings(&state, "carol", false).await;
        assert_eq!(carol.get(&c), Some(&(2, plain.id)));
        assert_eq!(carol.get(&format!("c{secret}")), None);
        done(state, path).await;
    }

    #[tokio::test]
    async fn reading_a_scope_clears_its_pings_everywhere() {
        let (state, path) = temp_state("ping_read").await;
        let db = &state.db;
        let cid = general_id(db).await;
        for name in ["alice", "bob"] {
            add_user(db, name, name).await;
            add_member(db, "rchat", name, 0, 0, 1).await;
        }
        let c = format!("c{cid}");
        let first = say(&state, (Some(cid), None, None), "alice", "@bob one").await;
        let read = |last_read: i64| {
            let state = state.clone();
            let scope = c.clone();
            async move {
                mark_read(
                    State(state),
                    Authed(mem_user("bob", false)),
                    Json(ReadReq {
                        scope,
                        last_read,
                        pings_until: None,
                    }),
                )
                .await
                .expect("read")
                .0
                .last_read
            }
        };
        assert_eq!(read(first.id).await, first.id);
        assert_eq!(ping_rows(db, "bob").await[0].4, 1);
        assert_eq!(
            unread_pings(&state, "bob", true).await.get(&c),
            Some(&(0, first.id))
        );
        assert!(!unread_pings(&state, "bob", false).await.contains_key(&c));

        let second = say(&state, (Some(cid), None, None), "alice", "@bob two").await;
        assert_eq!(
            unread_pings(&state, "bob", false).await.get(&c),
            Some(&(1, second.id))
        );
        let mut rx = state.hub.subscribe();
        assert_eq!(read(0).await, first.id);
        let echoed = std::iter::from_fn(|| rx.try_recv().ok()).any(|ev| {
            matches!(ev, WsEvent::ReadUpdated { username, scope, last_read, pings_until }
                if username == "bob" && scope == c && last_read == first.id && pings_until > 0)
        });
        assert!(echoed, "clearing pings echoes read_updated to other tabs");
        assert!(
            unread_pings(&state, "bob", false)
                .await
                .get(&c)
                .is_some_and(|(p, _)| *p == 0)
        );
        assert!(read(0).await == first.id && rx.try_recv().is_err());

        let third = say(&state, (Some(cid), None, None), "alice", "@bob three").await;
        let mut rx = state.hub.subscribe();
        let _ = delete_message(
            State(state.clone()),
            Path(third.id),
            Authed(mem_user("alice", false)),
        )
        .await
        .expect("delete");
        let counted = std::iter::from_fn(|| rx.try_recv().ok()).any(|ev| {
            matches!(ev, WsEvent::PingCount { username, scope, pings: 0, pings_until: 0, thread_pings } if username == "bob" && scope == c && thread_pings.is_empty())
        });
        assert!(counted, "deleting a mention recounts the badge");
        assert_eq!(
            ping_rows(db, "bob")
                .await
                .iter()
                .filter(|p| p.4 == 0)
                .count(),
            0
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn reaction_pings_list_a_dm_without_messages_from_others() {
        let (state, path) = temp_state("reaction_dm_unreads").await;
        let db = &state.db;
        for name in ["alice", "bob"] {
            add_user(db, name, name).await;
        }
        let dm: i64 =
            sqlx::query("INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id")
                .fetch_one(db)
                .await
                .expect("dm")
                .try_get(0)
                .expect("id");
        let own = say(&state, (None, Some(dm), None), "alice", "only me here").await;
        let scope = format!("d{dm}");
        assert!(
            !unread_pings(&state, "alice", false)
                .await
                .contains_key(&scope)
        );
        crate::api::reactions::add_reaction(
            State(state.clone()),
            Path((own.id, "👍".to_string())),
            Authed(mem_user("bob", false)),
        )
        .await
        .map(|_| ())
        .expect("react");
        assert_eq!(
            unread_pings(&state, "alice", false).await.get(&scope),
            Some(&(1, 0)),
            "listed with latest = last_read"
        );
        assert_eq!(
            unread_pings(&state, "alice", true).await.get(&scope),
            Some(&(1, 0))
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn pinged_scopes_are_listed_even_when_read() {
        let (state, path) = temp_state("ping_unreads").await;
        let db = &state.db;
        let cid = general_id(db).await;
        for name in ["alice", "bob"] {
            add_user(db, name, name).await;
            add_member(db, "rchat", name, 0, 0, 1).await;
        }
        let root = say(&state, (Some(cid), None, None), "bob", "root").await;
        say(
            &state,
            (None, None, Some(root.id)),
            "alice",
            "@bob in a thread",
        )
        .await;
        let c = format!("c{cid}");
        assert_eq!(
            unread_pings(&state, "bob", false).await.get(&c),
            Some(&(1, 0))
        );
        let hidden = add_channel(db, "hidden", "text").await;
        perm(db, hidden, "u:alice", 1).await;
        let mid = insert(db, Some(hidden), None, None, "alice").await;
        sqlx::query("INSERT INTO pings(username, kind, scope, server, message_id, actor, created_at) VALUES('bob', 'mention', $1, 'rchat', $2, 'alice', 1)")
            .bind(format!("c{hidden}"))
            .bind(mid)
            .execute(db)
            .await
            .expect("stale ping");
        assert!(
            !unread_pings(&state, "bob", true)
                .await
                .contains_key(&format!("c{hidden}")),
            "pings in a channel you can no longer see stay hidden"
        );
        done(state, path).await;
    }

    async fn read_as(
        state: &AppState,
        who: &str,
        scope: String,
        last_read: i64,
        pings_until: Option<i64>,
    ) -> Result<i64, ApiError> {
        mark_read(
            State(state.clone()),
            Authed(mem_user(who, false)),
            Json(ReadReq {
                scope,
                last_read,
                pings_until,
            }),
        )
        .await
        .map(|Json(r)| r.last_read)
    }

    async fn unread_item(state: &AppState, name: &str, scope: &str) -> Option<Unread> {
        unreads(
            State(state.clone()),
            Authed(mem_user(name, false)),
            Query(UnreadsQuery { all: Some(true) }),
        )
        .await
        .expect("unreads")
        .0
        .items
        .into_iter()
        .find(|u| u.scope == scope)
    }

    fn read_echoes(rx: &mut tokio::sync::broadcast::Receiver<WsEvent>) -> Vec<(String, i64)> {
        std::iter::from_fn(|| rx.try_recv().ok())
            .filter_map(|ev| match ev {
                WsEvent::ReadUpdated {
                    username: _,
                    scope,
                    last_read: _,
                    pings_until,
                } => Some((scope, pings_until)),
                _ => None,
            })
            .collect()
    }

    fn ping_ids(rx: &mut tokio::sync::broadcast::Receiver<WsEvent>) -> Vec<i64> {
        std::iter::from_fn(|| rx.try_recv().ok())
            .filter_map(|ev| match ev {
                WsEvent::Ping { username: _, ping } => Some(ping.id),
                _ => None,
            })
            .collect()
    }

    #[tokio::test]
    async fn reads_only_clear_pings_up_to_the_bound() {
        let (state, path) = temp_state("ping_bound").await;
        let db = &state.db;
        let cid = general_id(db).await;
        for name in ["alice", "bob"] {
            add_user(db, name, name).await;
            add_member(db, "rchat", name, 0, 0, 1).await;
        }
        let c = format!("c{cid}");
        let mut rx = state.hub.subscribe();
        let first = say(&state, (Some(cid), None, None), "alice", "@bob one").await;
        let shown = ping_ids(&mut rx)[0];
        let second = say(&state, (Some(cid), None, None), "alice", "@bob two").await;
        let late = ping_ids(&mut rx)[0];
        assert!(late > shown);
        let item = unread_item(&state, "bob", &c).await.expect("listed");
        assert_eq!((item.pings, item.pings_until), (2, late));

        assert_eq!(
            read_as(&state, "bob", c.clone(), first.id, Some(shown))
                .await
                .expect("read"),
            first.id
        );
        assert_eq!(read_echoes(&mut rx), vec![(c.clone(), shown)]);
        let item = unread_item(&state, "bob", &c).await.expect("listed");
        assert_eq!(
            (item.pings, item.pings_until),
            (1, late),
            "a ping newer than the bound keeps its badge"
        );

        read_as(&state, "bob", c.clone(), first.id, Some(shown))
            .await
            .expect("read again");
        assert_eq!(
            read_echoes(&mut rx),
            vec![(c.clone(), 0)],
            "nothing new to clear"
        );
        read_as(&state, "bob", c.clone(), second.id, None)
            .await
            .expect("read all");
        assert_eq!(read_echoes(&mut rx), vec![(c.clone(), late)]);
        assert_eq!(
            unread_item(&state, "bob", &c).await.expect("listed").pings,
            0
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn thread_pings_clear_only_with_their_thread() {
        let (state, path) = temp_state("ping_thread").await;
        let db = &state.db;
        let cid = general_id(db).await;
        for name in ["alice", "bob"] {
            add_user(db, name, name).await;
            add_member(db, "rchat", name, 0, 0, 1).await;
        }
        let c = format!("c{cid}");
        let mut rx = state.hub.subscribe();
        let root = say(&state, (Some(cid), None, None), "alice", "root").await;
        let reply = say(
            &state,
            (None, None, Some(root.id)),
            "alice",
            "@bob in the thread",
        )
        .await;
        let thread_ping = ping_ids(&mut rx)[0];
        let top = say(&state, (Some(cid), None, None), "alice", "@bob up top").await;
        let top_ping = ping_ids(&mut rx)[0];
        let stored: Option<i64> = sqlx::query("SELECT thread_root_id FROM pings WHERE id = $1")
            .bind(thread_ping)
            .fetch_one(db)
            .await
            .expect("ping")
            .try_get(0)
            .expect("root");
        assert_eq!(stored, Some(root.id));
        let item = unread_item(&state, "bob", &c).await.expect("listed");
        assert_eq!((item.pings, item.pings_until), (2, top_ping));
        assert_eq!(
            item.thread_pings,
            vec![ThreadPings {
                root_id: root.id,
                pings: 1,
                pings_until: thread_ping,
            }]
        );

        read_as(&state, "bob", c.clone(), top.id, None)
            .await
            .expect("read channel");
        assert_eq!(read_echoes(&mut rx), vec![(c.clone(), top_ping)]);
        let item = unread_item(&state, "bob", &c).await.expect("listed");
        assert_eq!(
            (item.pings, item.pings_until, item.thread_pings.len()),
            (1, 0, 1),
            "reading the channel keeps the thread ping"
        );

        let t = format!("t{}", root.id);
        assert_eq!(
            read_as(&state, "bob", t.clone(), reply.id, Some(thread_ping))
                .await
                .expect("read thread"),
            reply.id
        );
        assert_eq!(read_echoes(&mut rx), vec![(t.clone(), thread_ping)]);
        let item = unread_item(&state, "bob", &c).await.expect("listed");
        assert_eq!((item.pings, item.thread_pings.len()), (0, 0));
        let position: Option<i64> =
            sqlx::query("SELECT last_read FROM read_state WHERE username = 'bob' AND scope = $1")
                .bind(&t)
                .fetch_optional(db)
                .await
                .expect("read state")
                .map(|r| r.try_get(0).expect("last_read"));
        assert_eq!(position, None, "threads store no read position");

        let hidden = add_channel(db, "hidden", "text").await;
        perm(db, hidden, "u:alice", 1).await;
        let secret = insert(db, Some(hidden), None, None, "alice").await;
        let missing = read_as(&state, "bob", "t999999".to_string(), 0, None)
            .await
            .expect_err("missing");
        let denied = read_as(&state, "bob", format!("t{secret}"), 0, None)
            .await
            .expect_err("hidden");
        assert_eq!(missing.0, StatusCode::NOT_FOUND);
        assert_eq!(
            (denied.0, denied.1.as_str()),
            (missing.0, missing.1.as_str())
        );
        let not_root = read_as(&state, "bob", format!("t{}", reply.id), 0, None)
            .await
            .expect_err("reply");
        assert_eq!(not_root.0, StatusCode::BAD_REQUEST);
        assert_eq!(
            read_as(&state, "bob", "x5".to_string(), 0, None)
                .await
                .expect_err("scope")
                .0,
            StatusCode::BAD_REQUEST
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn ping_recipients_match_channel_access() {
        let (state, path) = temp_state("ping_viewers").await;
        let db = &state.db;
        let names = [
            "admin", "manager", "granted", "rolled", "denied", "plain", "site", "gone", "outside",
        ];
        for name in names {
            add_user(db, name, name).await;
        }
        for (name, admin, perms) in [
            ("admin", 1, 0),
            ("manager", 0, 0),
            ("granted", 0, 0),
            ("rolled", 0, 0),
            ("denied", 0, 0),
            ("plain", 0, 0),
            ("site", 0, 0),
            ("gone", 0, 0),
        ] {
            add_member(db, "rchat", name, admin, perms, 1).await;
        }
        sqlx::query("UPDATE users SET is_site_admin = 1 WHERE username = 'site'")
            .execute(db)
            .await
            .expect("site admin");
        sqlx::query("UPDATE users SET password_hash = '!purging' WHERE username = 'gone'")
            .execute(db)
            .await
            .expect("purging");
        let private = add_channel(db, "private", "text").await;
        let mut roles = Vec::new();
        for (holder, perms) in [("manager", Perm::ManageChannels as i64), ("rolled", 0)] {
            let role: i64 = sqlx::query("INSERT INTO roles(server, name, color, perms) VALUES('rchat', $1, '#ffffff', $2) RETURNING id")
                .bind(holder)
                .bind(perms)
                .fetch_one(db)
                .await
                .expect("role")
                .try_get(0)
                .expect("role id");
            sqlx::query(
                "INSERT INTO user_roles(server, username, role_id) VALUES('rchat', $1, $2)",
            )
            .bind(holder)
            .bind(role)
            .execute(db)
            .await
            .expect("assign role");
            roles.push(role);
        }
        perm(db, private, "u:granted", 1).await;
        perm(db, private, "u:denied", 0).await;
        perm(db, private, &format!("r:{}", roles[1]), 1).await;
        let wanted: Vec<String> = names.iter().rev().map(|n| n.to_string()).collect();
        for cid in [general_id(db).await, private] {
            let channel = resolve_channel(db, cid, Some(&mem_user("admin", false)), &Proof::none())
                .await
                .expect("channel");
            let got = channel
                .viewers_among(db, &wanted, None)
                .await
                .expect("viewers");
            let mut expected = Vec::new();
            for name in &wanted {
                let member = name != "outside" && name != "gone";
                let Some(user) = crate::db::get_user(db, name).await.expect("user") else {
                    continue;
                };
                if member
                    && channel_access(db, "rchat", cid, Some(&user))
                        .await
                        .expect("access")
                        .view
                {
                    expected.push(name.clone());
                }
            }
            assert_eq!(got, expected, "channel {cid}");
        }
        let channel = resolve_channel(db, private, Some(&mem_user("admin", false)), &Proof::none())
            .await
            .expect("channel");
        assert_eq!(
            channel
                .viewers_among(db, &wanted, None)
                .await
                .expect("viewers"),
            vec!["site", "rolled", "granted", "manager", "admin"]
        );
        assert!(
            channel
                .viewers_among(db, &["outside".to_string()], None)
                .await
                .expect("none")
                .is_empty()
        );
        let bare = add_channel(db, "bare", "text").await;
        for (view, send) in [(0, 0), (0, 1), (1, 0), (1, 1)] {
            sqlx::query(
                "UPDATE channels SET restrict_view = $1, restrict_send = $2 WHERE id IN ($3, $4)",
            )
            .bind(view)
            .bind(send)
            .bind(private)
            .bind(bare)
            .execute(db)
            .await
            .expect("restrict");
            for cid in [private, bare] {
                let channel =
                    resolve_channel(db, cid, Some(&mem_user("admin", false)), &Proof::none())
                        .await
                        .expect("channel");
                let got = channel
                    .viewers_among(db, &wanted, None)
                    .await
                    .expect("viewers");
                let mut expected = Vec::new();
                for name in &wanted {
                    let Some(user) = crate::db::get_user(db, name).await.expect("user") else {
                        continue;
                    };
                    if name != "outside"
                        && name != "gone"
                        && channel_access(db, "rchat", cid, Some(&user))
                            .await
                            .expect("access")
                            .view
                    {
                        expected.push(name.clone());
                    }
                }
                assert_eq!(got, expected, "channel {cid} view {view} send {send}");
                if cid == bare && view == 1 {
                    assert_eq!(got, vec!["site", "manager", "admin"]);
                }
            }
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn thread_pings_need_a_readable_root() {
        let (state, path) = temp_state("ping_root").await;
        let db = &state.db;
        let general = general_id(db).await;
        let quiet = add_channel(db, "quiet", "text").await;
        let names = ["alice", "early", "late", "history", "manager"];
        for (name, admin, joined) in [
            ("alice", 1, 1),
            ("early", 0, 1),
            ("late", 0, 200),
            ("history", 0, 200),
            ("manager", 0, 200),
        ] {
            add_user(db, name, name).await;
            add_member(db, "rchat", name, admin, 0, joined).await;
        }
        let role: i64 = sqlx::query("INSERT INTO roles(server, name, color, perms) VALUES('rchat', 'mod', '#ffffff', $1) RETURNING id")
            .bind(Perm::ManageChannels as i64)
            .fetch_one(db)
            .await
            .expect("role")
            .try_get(0)
            .expect("role id");
        sqlx::query(
            "INSERT INTO user_roles(server, username, role_id) VALUES('rchat', 'manager', $1)",
        )
        .bind(role)
        .execute(db)
        .await
        .expect("assign role");
        for (subject, history) in [("u:early", 0), ("u:late", 0), ("u:history", 1)] {
            sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, $2, 1, 1, $3)")
                .bind(quiet)
                .bind(subject)
                .bind(history)
                .execute(db)
                .await
                .expect("perm");
            crate::api::test_util::restrict_ruled(db).await;
        }
        let mut roots = Vec::new();
        for cid in [general, quiet] {
            let root: i64 = sqlx::query("INSERT INTO messages(channel_id, author, content, created_at) VALUES($1, 'alice', 'root', 100) RETURNING id")
                .bind(cid)
                .fetch_one(db)
                .await
                .expect("root")
                .try_get(0)
                .expect("root id");
            roots.push((cid, root));
        }
        let wanted: Vec<String> = names.iter().map(|n| n.to_string()).collect();
        for (cid, root) in &roots {
            let channel =
                resolve_channel(db, *cid, Some(&mem_user("alice", false)), &Proof::none())
                    .await
                    .expect("channel");
            let got = channel
                .viewers_among(db, &wanted, Some(*root))
                .await
                .expect("viewers");
            let mut expected = Vec::new();
            for name in &wanted {
                let user = crate::db::get_user(db, name)
                    .await
                    .expect("user")
                    .expect("exists");
                if resolve_message(db, *root, Some(&user), &Proof::none())
                    .await
                    .is_ok()
                {
                    expected.push(name.clone());
                }
            }
            assert_eq!(got, expected, "root {root} matches resolve_message");
            let unthreaded = channel
                .viewers_among(db, &wanted, None)
                .await
                .expect("viewers");
            assert!(got.iter().all(|n| unthreaded.contains(n)));
        }
        let quiet_root = roots[1].1;
        let channel = resolve_channel(db, quiet, Some(&mem_user("alice", false)), &Proof::none())
            .await
            .expect("channel");
        assert_eq!(
            channel
                .viewers_among(db, &wanted, Some(quiet_root))
                .await
                .expect("viewers"),
            vec!["alice", "early", "history", "manager"]
        );
        assert!(
            channel
                .viewers_among(db, &wanted, Some(roots[0].1))
                .await
                .expect("other channel")
                .is_empty(),
            "a root from another channel never qualifies"
        );

        let mut rx = state.hub.subscribe();
        let reply = say(
            &state,
            (None, None, Some(quiet_root)),
            "alice",
            "@early @late @history thread",
        )
        .await;
        let pinged: Vec<(String, i64)> = std::iter::from_fn(|| rx.try_recv().ok())
            .filter_map(|ev| match ev {
                WsEvent::Ping { username, ping } => Some((username, ping.id)),
                _ => None,
            })
            .collect();
        assert_eq!(
            pinged.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>(),
            vec!["early", "history"],
            "a member who joined after the root without read history is not pinged"
        );
        let c = format!("c{quiet}");
        assert!(
            unread_item(&state, "late", &c)
                .await
                .is_none_or(|i| i.pings == 0)
        );
        let item = unread_item(&state, "history", &c).await.expect("listed");
        assert_eq!((item.pings, item.thread_pings.len()), (1, 1));
        read_as(
            &state,
            "history",
            format!("t{quiet_root}"),
            reply.id,
            Some(pinged[1].1),
        )
        .await
        .expect("read thread");
        assert_eq!(
            unread_item(&state, "history", &c)
                .await
                .expect("listed")
                .pings,
            0,
            "the thread ping clears by reading the thread"
        );
        done(state, path).await;
    }

    async fn edit(
        state: &AppState,
        id: i64,
        who: &str,
        content: &str,
    ) -> Result<Message, ApiError> {
        edit_message(
            State(state.clone()),
            Path(id),
            Authed(mem_user(who, false)),
            Json(EditReq {
                content: content.to_string(),
            }),
        )
        .await
        .map(|r| r.0)
    }

    fn edits(rx: &mut tokio::sync::broadcast::Receiver<WsEvent>) -> Vec<WsEvent> {
        std::iter::from_fn(|| rx.try_recv().ok())
            .filter(|ev| matches!(ev, WsEvent::MessageUpdated { .. } | WsEvent::Ping { .. }))
            .collect()
    }

    #[tokio::test]
    async fn only_authors_edit_their_messages() {
        let (state, path) = temp_state("edit_author").await;
        let db = &state.db;
        let cid = general_id(db).await;
        for name in ["alice", "bob", "carol"] {
            add_user(db, name, name).await;
            add_member(db, "rchat", name, 0, 0, 1).await;
        }
        add_user(db, "nora", "nora").await;
        let hidden = add_channel(db, "hidden", "text").await;
        perm(db, hidden, "u:alice", 1).await;
        let note = say(&state, (Some(cid), None, None), "alice", "hello").await;
        let secret = say(&state, (Some(hidden), None, None), "alice", "psst").await;
        let status = |r: Result<Message, ApiError>| r.err().map(|ApiError(code, _)| code);
        assert_eq!(
            status(edit(&state, note.id, "bob", "hijack").await),
            Some(StatusCode::FORBIDDEN)
        );
        assert_eq!(
            status(edit(&state, note.id, "nora", "hijack").await),
            Some(StatusCode::FORBIDDEN),
            "a readable message of a server you are not in"
        );
        let missing = status(edit(&state, secret.id + 1000, "bob", "x").await);
        let unreadable = status(edit(&state, secret.id, "bob", "x").await);
        assert_eq!(missing, Some(StatusCode::NOT_FOUND));
        assert_eq!(
            unreadable, missing,
            "unreadable and unknown ids look the same"
        );
        let dm: i64 =
            sqlx::query("INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id")
                .fetch_one(db)
                .await
                .expect("dm")
                .try_get(0)
                .expect("id");
        let mine = say(&state, (None, Some(dm), None), "alice", "dm text").await;
        assert_eq!(
            status(edit(&state, mine.id, "carol", "x").await),
            Some(StatusCode::NOT_FOUND)
        );
        assert_eq!(
            status(edit(&state, mine.id, "bob", "x").await),
            Some(StatusCode::FORBIDDEN)
        );
        let call: i64 = sqlx::query("INSERT INTO messages(dm_id, author, content, kind, created_at) VALUES($1, 'alice', '', 'call', 5) RETURNING id")
            .bind(dm)
            .fetch_one(db)
            .await
            .expect("call log")
            .try_get(0)
            .expect("id");
        assert_eq!(
            edit(&state, call, "alice", "not a call")
                .await
                .err()
                .map(|e| e.1),
            Some("Cannot edit this message".to_string())
        );
        sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'u:alice', 1, 0, 1)")
            .bind(cid)
            .execute(db)
            .await
            .expect("no send");
        crate::api::test_util::restrict_ruled(db).await;
        assert_eq!(
            status(edit(&state, note.id, "alice", "muted").await),
            Some(StatusCode::FORBIDDEN),
            "editing needs the send permission"
        );
        let kept = load_message(db, note.id, Quotes::Skip)
            .await
            .expect("load")
            .expect("note");
        assert_eq!(kept.content, "hello");
        assert_eq!(kept.edited_at, None);
        done(state, path).await;
    }

    #[tokio::test]
    async fn edits_are_validated_like_new_messages() {
        let (state, path) = temp_state("edit_validate").await;
        let db = &state.db;
        let cid = general_id(db).await;
        add_user(db, "alice", "alice").await;
        add_member(db, "rchat", "alice", 0, 0, 1).await;
        let note = say(&state, (Some(cid), None, None), "alice", "hello").await;
        let error = |r: Result<Message, ApiError>| r.err().map(|ApiError(code, e)| (code, e));
        assert_eq!(
            error(edit(&state, note.id, "alice", "  \n ").await),
            Some((StatusCode::BAD_REQUEST, "Message is empty".to_string()))
        );
        assert_eq!(
            error(edit(&state, note.id, "alice", &"a".repeat(MESSAGE_MAX + 1)).await).map(|e| e.0),
            Some(StatusCode::BAD_REQUEST)
        );
        assert!(
            edit(&state, note.id, "alice", &"😀".repeat(MESSAGE_MAX))
                .await
                .is_ok()
        );
        assert_eq!(
            error(edit(&state, note.id, "alice", "well fuck").await),
            Some((
                StatusCode::BAD_REQUEST,
                "Content blocked by profanity filter".to_string()
            ))
        );
        add_media(db, "pic", Some("alice")).await;
        let pic = send_with(&state, cid, "alice", "caption".to_string(), Some("pic"))
            .await
            .expect("send with media")
            .0;
        let blank = edit(&state, pic.id, "alice", "")
            .await
            .expect("attachment stays");
        assert_eq!(blank.content, "");
        assert!(blank.media.is_some() && blank.edited_at.is_some());
        add_media(db, "pic2", Some("alice")).await;
        let gone = send_with(&state, cid, "alice", "caption".to_string(), Some("pic2"))
            .await
            .expect("send with media")
            .0;
        for removed in [1, 2] {
            sqlx::query("UPDATE messages SET media_removed = $1 WHERE id = $2")
                .bind(removed)
                .bind(gone.id)
                .execute(db)
                .await
                .expect("attachment removed");
            assert_eq!(
                error(edit(&state, gone.id, "alice", " ").await),
                Some((StatusCode::BAD_REQUEST, "Message is empty".to_string())),
                "a removed attachment counts as none"
            );
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn edits_reach_viewers_without_pinging() {
        let (state, path) = temp_state("edit_events").await;
        let db = &state.db;
        let cid = general_id(db).await;
        for name in ["alice", "bob"] {
            add_user(db, name, name).await;
            add_member(db, "rchat", name, 0, 0, 1).await;
        }
        let asked = say(&state, (Some(cid), None, None), "bob", "lunch?").await;
        let answer = say_to(
            &state,
            (Some(cid), None, None),
            "alice",
            "sure",
            Some(asked.id),
            true,
        )
        .await
        .expect("reply");
        let mut rx = state.hub.subscribe();
        let before = now();
        let edited = edit(&state, answer.id, "alice", "sure @bob, noon")
            .await
            .expect("edit");
        assert_eq!(edited.content, "sure @bob, noon");
        assert!(edited.edited_at.is_some_and(|t| t >= before));
        let quote = edited.reply_to.clone().expect("quote kept");
        assert_eq!(quote.id, asked.id);
        assert_eq!(quote.content, "lunch?");
        let events = edits(&mut rx);
        assert_eq!(events.len(), 1, "one update, no ping");
        let WsEvent::MessageUpdated {
            server,
            channel_id,
            update: Updated::Stub(stub),
            dm_users,
        } = &events[0]
        else {
            panic!("not an edit stub");
        };
        assert_eq!(server.as_deref(), Some("rchat"));
        assert_eq!(*channel_id, Some(cid));
        assert!(dm_users.is_empty());
        assert_eq!(stub.id, answer.id);
        assert_eq!(stub.thread_root_id, None);
        assert_eq!(stub.edited_at, edited.edited_at);
        assert!(stub.stub);
        let json = serde_json::to_string(&events[0]).expect("json");
        for leak in ["lunch?", "noon", "alice", "\"message\"", "content"] {
            assert!(!json.contains(leak), "{leak} in {json}");
        }
        assert!(json.contains("\"stub\":true"), "{json}");
        let reposted = crate::ws::current(&state, events[0].clone())
            .await
            .expect("repost");
        assert!(matches!(
            reposted,
            WsEvent::MessageUpdated { update: Updated::Stub(s), .. }
                if s.id == answer.id && s.edited_at == edited.edited_at
        ));
        assert_eq!(
            ping_rows(db, "bob").await.len(),
            1,
            "only the reply ping, nothing from the edit"
        );
        let same = edit(&state, answer.id, "alice", "sure @bob, noon")
            .await
            .expect("same text");
        assert_eq!(same.edited_at, edited.edited_at);
        assert!(edits(&mut rx).is_empty(), "no change, no event");
        let listed = list(&state, cid, Some("bob")).await.expect("list");
        let row = listed.iter().find(|m| m.id == answer.id).expect("listed");
        assert_eq!(row.edited_at, edited.edited_at);
        assert_eq!(row.content, "sure @bob, noon");
        assert_eq!(row.reply_to.as_ref().map(|q| q.id), Some(asked.id));
        let thread = say(&state, (None, None, Some(asked.id)), "alice", "in thread").await;
        edit(&state, thread.id, "alice", "in the thread")
            .await
            .expect("thread edit");
        let events = edits(&mut rx);
        assert!(matches!(
            events.as_slice(),
            [WsEvent::MessageUpdated { server: Some(s), channel_id: Some(c), update: Updated::Stub(stub), .. }]
                if s == "rchat" && *c == cid && stub.id == thread.id && stub.thread_root_id == Some(asked.id)
        ));
        let dm: i64 =
            sqlx::query("INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id")
                .fetch_one(db)
                .await
                .expect("dm")
                .try_get(0)
                .expect("id");
        let mine = say(&state, (None, Some(dm), None), "alice", "dm text").await;
        edit(&state, mine.id, "alice", "dm text!")
            .await
            .expect("dm edit");
        let events = edits(&mut rx);
        assert!(matches!(
            events.as_slice(),
            [WsEvent::MessageUpdated { server: None, channel_id: None, update: Updated::Full { message }, dm_users }]
                if dm_users.len() == 2 && dm_users.iter().any(|u| u == "bob") && message.content == "dm text!"
        ));
        let reposted = crate::ws::current(&state, events[0].clone())
            .await
            .expect("repost");
        assert!(matches!(
            reposted,
            WsEvent::MessageUpdated { update: Updated::Full { message }, dm_users, .. }
                if message.content == "dm text!" && dm_users.len() == 2
        ));
        done(state, path).await;
    }

    #[tokio::test]
    async fn edits_of_old_messages_tell_no_history_viewers_nothing() {
        let (state, path) = temp_state("edit_no_history").await;
        let db = &state.db;
        let cid = general_id(db).await;
        for name in ["alice", "bob"] {
            add_user(db, name, name).await;
            add_member(db, "rchat", name, 0, 0, 1).await;
        }
        let joined = now() - 1000;
        let early = say(&state, (Some(cid), None, None), "alice", "early plan").await;
        let early_reply = say(
            &state,
            (None, None, Some(early.id)),
            "alice",
            "early detail",
        )
        .await;
        for id in [early.id, early_reply.id] {
            sqlx::query("UPDATE messages SET created_at = $1 WHERE id = $2")
                .bind(joined - 500)
                .bind(id)
                .execute(db)
                .await
                .expect("backdate");
        }
        add_user(db, "dave", "dave").await;
        add_member(db, "rchat", "dave", 0, 0, joined).await;
        sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'u:dave', 1, 1, 0)")
            .bind(cid)
            .execute(db)
            .await
            .expect("no history");
        crate::api::test_util::restrict_ruled(db).await;
        perm(db, cid, "u:alice", 1).await;
        perm(db, cid, "u:bob", 1).await;
        let late = say(&state, (Some(cid), None, None), "bob", "after dave").await;
        let mut rx = state.hub.subscribe();
        edit(
            &state,
            early.id,
            "alice",
            "secret new plan https://edit.example/x",
        )
        .await
        .expect("edit");
        edit(&state, early_reply.id, "alice", "secret new detail")
            .await
            .expect("thread edit");
        let events = edits(&mut rx);
        assert_eq!(events.len(), 2);
        for (ev, id, root) in [
            (&events[0], early.id, None),
            (&events[1], early_reply.id, Some(early.id)),
        ] {
            assert!(matches!(
                ev,
                WsEvent::MessageUpdated { server: Some(s), channel_id: Some(c), update: Updated::Stub(stub), .. }
                    if s == "rchat" && *c == cid && stub.id == id && stub.thread_root_id == root
            ));
            let json = serde_json::to_string(ev).expect("json");
            for leak in [
                "secret",
                "early",
                "edit.example",
                "alice",
                "content",
                "author",
            ] {
                assert!(!json.contains(leak), "{leak} in {json}");
            }
        }
        let page = |id: i64| PageQuery {
            before: None,
            after: None,
            around: Some(id),
            limit: Some(1),
        };
        let reread = |user: &'static str, id: i64| {
            channel_messages(
                State(state.clone()),
                MaybeAuthed(Some(mem_user(user, false))),
                HeaderMap::new(),
                Path(cid),
                Query(page(id)),
            )
        };
        let hidden = reread("dave", early.id).await.expect("dave").0;
        assert!(hidden.iter().all(|m| m.id != early.id));
        assert_eq!(
            hidden.iter().map(|m| m.id).collect::<Vec<_>>(),
            vec![late.id]
        );
        let thread = thread_messages(
            State(state.clone()),
            MaybeAuthed(Some(mem_user("dave", false))),
            HeaderMap::new(),
            Path(early.id),
            Query(page(early_reply.id)),
        )
        .await;
        assert!(matches!(thread, Err(ApiError(StatusCode::NOT_FOUND, _))));
        let shown = reread("bob", early.id).await.expect("bob").0;
        assert_eq!(shown.len(), 1);
        assert_eq!(shown[0].id, early.id);
        assert_eq!(shown[0].content, "secret new plan https://edit.example/x");
        assert!(shown[0].edited_at.is_some());
        let shown = thread_messages(
            State(state.clone()),
            MaybeAuthed(Some(mem_user("bob", false))),
            HeaderMap::new(),
            Path(early.id),
            Query(page(early_reply.id)),
        )
        .await
        .expect("bob thread")
        .0;
        assert_eq!(shown[0].id, early_reply.id);
        assert_eq!(shown[0].content, "secret new detail");
        done(state, path).await;
    }

    #[tokio::test]
    async fn edits_replace_link_previews_when_links_change() {
        let (state, path) = temp_state("edit_embeds").await;
        let db = &state.db;
        let cid = general_id(db).await;
        add_user(db, "alice", "alice").await;
        add_member(db, "rchat", "alice", 0, 0, 1).await;
        let note = say(
            &state,
            (Some(cid), None, None),
            "alice",
            "see https://old.example/a",
        )
        .await;
        for (url, title) in [
            ("https://old.example/a", "Old"),
            ("https://new.example/b", "New"),
        ] {
            sqlx::query("INSERT INTO embeds(url, title, fetched_at) VALUES($1, $2, $3)")
                .bind(url)
                .bind(title)
                .bind(now())
                .execute(db)
                .await
                .expect("cached preview");
        }
        sqlx::query("INSERT INTO message_embeds(message_id, ord, url, banner_removed, removed) VALUES($1, 0, 'https://old.example/a', 1, 0)")
            .bind(note.id)
            .execute(db)
            .await
            .expect("preview");
        let titles = |m: &Message| m.embeds.iter().map(|e| e.title.clone()).collect::<Vec<_>>();
        let same = edit(&state, note.id, "alice", "look https://old.example/a")
            .await
            .expect("same link");
        assert_eq!(titles(&same), vec![Some("Old".to_string())]);
        assert!(
            same.embeds[0].banner_removed,
            "a kept preview keeps its state"
        );
        let mut rx = state.hub.subscribe();
        let moved = edit(&state, note.id, "alice", "now https://new.example/b")
            .await
            .expect("new link");
        assert!(
            titles(&moved).iter().all(|t| t.as_deref() == Some("New")),
            "old previews are removed"
        );
        let mut stubs = 0;
        let resolved = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                match rx.recv().await {
                    Ok(WsEvent::EmbedsResolved { message_id, .. }) if message_id == note.id => {
                        panic!("previews of an edited channel message travel as a stub")
                    }
                    Ok(WsEvent::MessageUpdated {
                        server,
                        channel_id,
                        update: Updated::Stub(stub),
                        ..
                    }) if stub.id == note.id => {
                        stubs += 1;
                        if stubs == 2 {
                            break (server, channel_id, stub);
                        }
                    }
                    Ok(_) => continue,
                    Err(e) => panic!("{e}"),
                }
            }
        })
        .await
        .expect("a second stub once the new previews are stored");
        assert_eq!(resolved.0.as_deref(), Some("rchat"));
        assert_eq!(resolved.1, Some(cid));
        assert_eq!(resolved.2.edited_at, moved.edited_at);
        let listed = list(&state, cid, Some("alice")).await.expect("list");
        let row = listed.iter().find(|m| m.id == note.id).expect("listed");
        assert_eq!(titles(row), vec![Some("New".to_string())]);
        assert!(!row.embeds[0].banner_removed);
        sqlx::query("UPDATE messages SET content = 'gone' WHERE id = $1")
            .bind(note.id)
            .execute(db)
            .await
            .expect("edited behind the job");
        sqlx::query("DELETE FROM message_embeds WHERE message_id = $1")
            .bind(note.id)
            .execute(db)
            .await
            .expect("clear");
        embeds::spawn_unfurl(
            &state,
            Some("rchat".to_string()),
            Some(cid),
            None,
            None,
            note.id,
            "now https://new.example/b",
        );
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert_eq!(
            list(&state, cid, Some("alice"))
                .await
                .expect("list")
                .iter()
                .find(|m| m.id == note.id)
                .map(|m| m.embeds.len()),
            Some(0),
            "a job for links the message no longer has stores nothing"
        );
        done(state, path).await;
    }

    async fn forward(
        state: &AppState,
        to: (Option<i64>, Option<i64>, Option<i64>),
        author: &str,
        source: i64,
    ) -> Result<Message, ApiError> {
        let req = SendReq {
            content: "ignored".to_string(),
            media_id: None,
            media_spoiler: None,
            p2p: None,
            reply_to: Some(source),
            mention_reply: true,
            forward_of: Some(source),
        };
        let user = Authed(mem_user(author, false));
        let sent = match to {
            (Some(cid), _, _) => {
                send_channel_message(State(state.clone()), Path(cid), user, Json(req)).await
            }
            (_, Some(dm), _) => {
                send_dm_message(State(state.clone()), Path(dm), user, Json(req)).await
            }
            (_, _, Some(root)) => {
                send_thread_message(State(state.clone()), Path(root), user, Json(req)).await
            }
            (None, None, None) => panic!("no target"),
        };
        sent.map(|r| r.0)
    }

    async fn locate(
        state: &AppState,
        user: Option<&str>,
        id: i64,
    ) -> Result<MessageLocation, ApiError> {
        message_location(
            State(state.clone()),
            MaybeAuthed(user.map(|name| mem_user(name, false))),
            HeaderMap::new(),
            Path(id),
        )
        .await
        .map(|r| r.0)
    }

    #[tokio::test]
    async fn forwards_are_server_side_copies_of_readable_messages() {
        let (state, path) = temp_state("forwards").await;
        let db = &state.db;
        let cid = general_id(db).await;
        for name in ["alice", "bob", "carol", "dave"] {
            add_user(db, name, &name.to_uppercase()).await;
        }
        for name in ["alice", "bob", "carol"] {
            add_member(db, "rchat", name, 0, 0, 1).await;
        }
        let secret = add_channel(db, "secret", "text").await;
        perm(db, secret, "u:alice", 1).await;
        let mut servers = HashMap::new();
        for (name, display, hash) in [("pub", "Pub Hall", None), ("vault", "Vault", Some("x"))] {
            sqlx::query("INSERT INTO servers(name, display_name, creator, password_hash, created_at) VALUES($1, $2, 'alice', $3, 0)")
                .bind(name)
                .bind(display)
                .bind(hash)
                .execute(db)
                .await
                .expect("server");
            let id: i64 = sqlx::query("INSERT INTO channels(server, name, created_at) VALUES($1, 'lobby', 0) RETURNING id")
                .bind(name)
                .fetch_one(db)
                .await
                .expect("channel")
                .try_get(0)
                .expect("id");
            add_member(db, name, "alice", 0, 0, 1).await;
            servers.insert(name, id);
        }
        let dm: i64 =
            sqlx::query("INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id")
                .fetch_one(db)
                .await
                .expect("dm")
                .try_get(0)
                .expect("id");
        let general = (Some(cid), None, None);
        let to_dm = (None, Some(dm), None);

        let media_id = "ab".repeat(16);
        crate::api::media::store_media(
            db,
            &media_id,
            "cat.png",
            "image/png",
            1,
            Some(&[1]),
            "alice",
            now(),
        )
        .await
        .expect("store media");
        let hidden: i64 = sqlx::query("INSERT INTO messages(channel_id, author, content, media_id, media_filename, media_spoiler, media_kind, media_expires_at, created_at) VALUES($1, 'alice', '@bob @carol look https://example.com', $2, 'cat.png', 1, 'server', $3, 5) RETURNING id")
            .bind(secret)
            .bind(&media_id)
            .bind(now() + 3600)
            .fetch_one(db)
            .await
            .expect("hidden")
            .try_get(0)
            .expect("id");
        sqlx::query("INSERT INTO embeds(url, site_name, title, fetched_at) VALUES('https://example.com', 'Example', 'Example Domain', $1)")
            .bind(now())
            .execute(db)
            .await
            .expect("embed");
        sqlx::query(
            "INSERT INTO message_embeds(message_id, ord, url) VALUES($1, 0, 'https://example.com')",
        )
        .bind(hidden)
        .execute(db)
        .await
        .expect("message embed");
        let see = |who: &'static str| {
            let state = state.clone();
            let media_id = media_id.clone();
            async move {
                crate::api::media::media_view_ok(
                    &state.db,
                    &HeaderMap::new(),
                    &media_id,
                    Some(&mem_user(who, false)),
                    None,
                )
                .await
                .is_ok()
            }
        };
        assert!(
            !see("bob").await,
            "bob cannot see the hidden channel's file"
        );

        let refused = |r: Result<Message, ApiError>| match r {
            Ok(_) => panic!("forwarded"),
            Err(ApiError(code, msg)) => (code, msg),
        };
        let cannot = (
            StatusCode::BAD_REQUEST,
            "Cannot forward that message".to_string(),
        );
        assert_eq!(
            refused(forward(&state, general, "bob", hidden).await),
            cannot
        );
        assert_eq!(
            refused(forward(&state, general, "bob", 999_999).await),
            cannot
        );
        let vault_msg = say(
            &state,
            (Some(servers["vault"]), None, None),
            "alice",
            "vault talk",
        )
        .await;
        assert_eq!(
            refused(forward(&state, to_dm, "bob", vault_msg.id).await),
            cannot
        );

        let mut rx = state.hub.subscribe();
        let copy = forward(&state, general, "alice", hidden)
            .await
            .expect("forward");
        assert_eq!(copy.content, "@bob @carol look https://example.com");
        assert!(copy.reply_to.is_none(), "reply_to is ignored");
        let fwd = copy.forward.clone().expect("forward ref");
        assert_eq!(
            fwd.author.as_ref().map(|a| a.username.as_str()),
            Some("alice")
        );
        assert_eq!(fwd.created_at, 5);
        assert_eq!(fwd.source_id, hidden);
        assert_eq!(
            fwd.origin.as_deref(),
            Some("RChat"),
            "a restricted channel is not named"
        );
        assert_eq!(fwd.dropped, None);
        let media = copy.media.clone().expect("media");
        assert_eq!(
            (media.id.as_str(), media.filename.as_str(), media.spoiler),
            (media_id.as_str(), "cat.png", true)
        );
        assert_eq!(copy.embeds.len(), 1, "previews are copied");
        assert!(reply_pings(&mut rx).is_empty(), "forwards never ping");
        assert!(see("bob").await, "the copy's audience can open its file");
        assert!(
            resolve_message(db, hidden, Some(&mem_user("bob", false)), &Proof::none())
                .await
                .is_err()
        );
        let listed = list(&state, cid, Some("bob")).await.expect("list");
        let shown = listed.iter().find(|m| m.id == copy.id).expect("listed");
        assert_eq!(
            serde_json::to_value(shown).expect("json")["forward"],
            serde_json::to_value(&copy.forward).expect("json")
        );

        sqlx::query("UPDATE messages SET content = 'changed', edited_at = 9 WHERE id = $1")
            .bind(hidden)
            .execute(db)
            .await
            .expect("edit original");
        let listed = list(&state, cid, Some("bob")).await.expect("list");
        assert_eq!(
            listed
                .iter()
                .find(|m| m.id == copy.id)
                .expect("copy")
                .content,
            "@bob @carol look https://example.com"
        );
        let edit = edit_message(
            State(state.clone()),
            Path(copy.id),
            Authed(mem_user("alice", false)),
            Json(EditReq {
                content: "forged".to_string(),
            }),
        )
        .await;
        assert_eq!(
            edit.err().map(|ApiError(c, m)| (c, m)),
            Some((
                StatusCode::BAD_REQUEST,
                "Cannot edit this message".to_string()
            ))
        );

        let quoting = say_to(&state, general, "bob", "nice", Some(copy.id), false)
            .await
            .expect("reply to the forward");
        let quote = quoting.reply_to.expect("quote");
        assert!(
            quote.forwarded && !quote.deleted,
            "a quoted forward is marked"
        );
        let listed = list(&state, cid, Some("bob")).await.expect("list");
        let quoted = listed
            .iter()
            .find(|m| m.id == quoting.id)
            .and_then(|m| m.reply_to.as_ref())
            .expect("listed quote");
        assert!(quoted.forwarded);
        let plain = say_to(&state, general, "bob", "plain", Some(quoting.id), false)
            .await
            .expect("reply");
        assert!(!plain.reply_to.expect("quote").forwarded);

        let open_msg = say(&state, general, "bob", "hello").await;
        let same = forward(&state, general, "carol", open_msg.id)
            .await
            .expect("same server");
        assert_eq!(
            same.forward.as_ref().and_then(|f| f.origin.as_deref()),
            Some("#general · RChat")
        );
        let pub_msg = say(
            &state,
            (Some(servers["pub"]), None, None),
            "alice",
            "pub talk",
        )
        .await;
        let from_pub = forward(&state, to_dm, "bob", pub_msg.id)
            .await
            .expect("public, not a member");
        assert_eq!(
            from_pub.forward.as_ref().and_then(|f| f.origin.as_deref()),
            Some("Pub Hall")
        );
        let from_vault = forward(&state, to_dm, "alice", vault_msg.id)
            .await
            .expect("member of vault");
        let vault_fwd = from_vault.forward.clone().expect("ref");
        assert_eq!(vault_fwd.origin, None, "a protected server is never named");
        assert!(
            !serde_json::to_string(&from_vault)
                .expect("json")
                .contains("Vault")
        );
        let dm_msg = say(&state, to_dm, "bob", "dm secret").await;
        let from_dm = forward(&state, general, "alice", dm_msg.id)
            .await
            .expect("dm source");
        assert_eq!(
            from_dm.forward.as_ref().and_then(|f| f.origin.as_deref()),
            Some("Direct message")
        );
        assert_eq!(
            refused(forward(&state, general, "carol", dm_msg.id).await),
            cannot
        );
        assert!(reply_pings(&mut rx).is_empty(), "no pings for any forward");

        let again = forward(&state, (None, None, Some(open_msg.id)), "alice", copy.id)
            .await
            .expect("forward a forward");
        let again_fwd = again.forward.clone().expect("ref");
        assert_eq!(
            (
                again_fwd.author.as_ref().map(|a| a.username.as_str()),
                again_fwd.created_at,
                again_fwd.source_id
            ),
            (Some("alice"), 5, copy.id)
        );
        assert_eq!(again.thread_root_id, Some(open_msg.id));
        assert_eq!(
            again.media.as_ref().map(|m| m.id.as_str()),
            Some(media_id.as_str())
        );

        let p2p: i64 = sqlx::query("INSERT INTO messages(channel_id, author, content, media_id, media_filename, media_kind, media_hoster, created_at) VALUES($1, 'bob', '', $2, 'notes.pdf', 'p2p', 'bob', 6) RETURNING id")
            .bind(cid)
            .bind("cd".repeat(16))
            .fetch_one(db)
            .await
            .expect("p2p")
            .try_get(0)
            .expect("id");
        let dropped = forward(&state, to_dm, "alice", p2p)
            .await
            .expect("p2p forward");
        assert!(dropped.media.is_none());
        assert_eq!(
            dropped.forward.and_then(|f| f.dropped).as_deref(),
            Some("notes.pdf")
        );
        let call: i64 = sqlx::query("INSERT INTO messages(dm_id, author, content, kind, created_at) VALUES($1, 'alice', '', 'call', 7) RETURNING id")
            .bind(dm)
            .fetch_one(db)
            .await
            .expect("call")
            .try_get(0)
            .expect("id");
        assert_eq!(
            refused(forward(&state, general, "alice", call).await),
            cannot
        );
        let outsider = forward(
            &state,
            (Some(servers["pub"]), None, None),
            "bob",
            open_msg.id,
        )
        .await;
        assert_eq!(
            outsider.err().map(|ApiError(c, _)| c),
            Some(StatusCode::FORBIDDEN),
            "sending still needs membership"
        );

        let hidden_where = locate(&state, Some("bob"), hidden)
            .await
            .err()
            .map(|ApiError(c, m)| (c, m));
        let missing_where = locate(&state, Some("bob"), 999_999)
            .await
            .err()
            .map(|ApiError(c, m)| (c, m));
        let vault_where = locate(&state, Some("bob"), vault_msg.id)
            .await
            .err()
            .map(|ApiError(c, m)| (c, m));
        assert_eq!(
            hidden_where,
            Some((StatusCode::NOT_FOUND, "Not found".to_string()))
        );
        assert_eq!(hidden_where, missing_where);
        assert_eq!(hidden_where, vault_where);
        let pub_where = locate(&state, Some("dave"), pub_msg.id)
            .await
            .expect("public preview");
        assert_eq!(
            (pub_where.server.as_deref(), pub_where.channel_id),
            (Some("pub"), Some(servers["pub"]))
        );
        let thread_where = locate(&state, Some("bob"), again.id).await.expect("thread");
        assert_eq!(thread_where.thread_root_id, Some(open_msg.id));
        let dm_where = locate(&state, Some("alice"), dm_msg.id).await.expect("dm");
        assert_eq!((dm_where.server, dm_where.dm_id), (None, Some(dm)));
        assert!(locate(&state, Some("carol"), dm_msg.id).await.is_err());
        done(state, path).await;
    }

    #[tokio::test]
    async fn one_file_is_carried_by_a_bounded_number_of_messages() {
        let (state, path) = temp_state("media_refs").await;
        let db = &state.db;
        let cid = general_id(db).await;
        add_member(db, "rchat", "alice", 0, 0, 0).await;
        let file = "ef".repeat(16);
        add_media(db, &file, Some("alice")).await;
        let source = send_with(&state, cid, "alice", String::new(), Some(&file))
            .await
            .expect("attach")
            .0
            .id;
        for _ in 1..crate::api::media::MEDIA_REFS_MAX {
            sqlx::query("INSERT INTO messages(channel_id, author, content, media_id, media_filename, created_at) VALUES($1, 'alice', '', $2, 'a.txt', 1)")
                .bind(cid)
                .bind(&file)
                .execute(db)
                .await
                .expect("copy");
        }
        assert_eq!(
            crate::api::media::references(db, &file)
                .await
                .expect("count"),
            crate::api::media::MEDIA_REFS_MAX
        );
        let copy = forward(&state, (Some(cid), None, None), "alice", source)
            .await
            .expect("forward");
        assert!(copy.media.is_none(), "past the cap only the name travels");
        assert_eq!(
            copy.forward.and_then(|f| f.dropped).as_deref(),
            Some("a.txt")
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn one_sender_and_concurrent_forwards_stay_within_the_file_caps() {
        use crate::api::media::{MEDIA_REFS_MAX, MEDIA_REFS_PER_SENDER, references};
        let (state, path) = temp_state("media_refs_sender").await;
        let db = &state.db;
        let cid = general_id(db).await;
        let senders: Vec<String> = (0..12).map(|n| format!("user{n}")).collect();
        for name in ["alice", "bob"]
            .into_iter()
            .chain(senders.iter().map(String::as_str))
        {
            add_member(db, "rchat", name, 0, 0, 0).await;
        }
        let file = "ab".repeat(16);
        add_media(db, &file, Some("alice")).await;
        let source = send_with(&state, cid, "alice", String::new(), Some(&file))
            .await
            .expect("attach")
            .0
            .id;
        let carried = |m: &Message| m.media.is_some();
        for n in 1..MEDIA_REFS_PER_SENDER {
            let copy = forward(&state, (Some(cid), None, None), "alice", source)
                .await
                .expect("forward");
            assert!(carried(&copy), "forward {n} carries the file");
        }
        let past = forward(&state, (Some(cid), None, None), "alice", source)
            .await
            .expect("forward");
        assert!(
            !carried(&past),
            "one sender carries the file at most 5 times"
        );
        let other = forward(&state, (Some(cid), None, None), "bob", source)
            .await
            .expect("forward");
        assert!(carried(&other), "others still can");
        let used = references(db, &file).await.expect("count");
        for _ in used..MEDIA_REFS_MAX - 3 {
            sqlx::query("INSERT INTO messages(channel_id, author, content, media_id, media_filename, created_at) VALUES($1, 'carol', '', $2, 'a.txt', 1)")
                .bind(cid)
                .bind(&file)
                .execute(db)
                .await
                .expect("copy");
        }
        let results = futures_util::future::join_all(
            senders
                .iter()
                .map(|name| forward(&state, (Some(cid), None, None), name, source)),
        )
        .await;
        let with_file = results
            .iter()
            .filter(|r| r.as_ref().is_ok_and(carried))
            .count();
        assert_eq!(with_file, 3, "the cap is counted inside the insert");
        assert_eq!(references(db, &file).await.expect("count"), MEDIA_REFS_MAX);
        done(state, path).await;
    }
}
