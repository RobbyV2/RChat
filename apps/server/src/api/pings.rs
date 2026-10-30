use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use utoipa::ToSchema;

use crate::api::access::ResolvedChannel;
use crate::api::budget::Budget;
use crate::api::{ApiError, Message, NAME_MAX, UserRef, placeholders};
use crate::db::{Db, User, now};
use crate::state::AppState;
use crate::ws::WsEvent;

pub const MENTION_MAX: usize = 20;
pub const PINGS_MAX: i64 = 1000;
/// `pings.seen` of a reaction ping whose reaction was taken back: never counted or shown, kept
/// until it ages out so adding the reaction again does not ping again.
pub const RETRACTED: i64 = 2;
const CANDIDATES_MAX: usize = 400;
const EXCERPT_MAX: usize = 200;

/// Why someone was pinged.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum PingKind {
    /// `@username` in a message.
    Mention,
    /// A reply to the recipient's message.
    Reply,
    /// A reaction to the recipient's message.
    Reaction,
    /// A friend request from `actor` (scope `friends`, no message).
    #[serde(rename = "friend_request")]
    FriendRequest,
    /// `actor` accepted the recipient's friend request (scope `friends`, no message).
    #[serde(rename = "friend_accept")]
    FriendAccept,
}

impl PingKind {
    pub fn as_str(self) -> &'static str {
        match self {
            PingKind::Mention => "mention",
            PingKind::Reply => "reply",
            PingKind::Reaction => "reaction",
            PingKind::FriendRequest => "friend_request",
            PingKind::FriendAccept => "friend_accept",
        }
    }
}

/// A notification for one user, delivered live as the `ping` WebSocket event. Unseen pings are
/// counted per scope in `GET /api/unreads` and marked seen by `POST /api/read`.
#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct Ping {
    /// Ping id, increasing over time.
    pub id: i64,
    /// What caused the ping.
    pub kind: PingKind,
    /// `c<channel id>` (thread replies use their channel and set `thread_root_id`), `d<dm id>`,
    /// or `friends` for friend requests and accepted requests.
    #[schema(example = "c12")]
    pub scope: String,
    /// Server of a channel scope; `null` for DMs.
    pub server: Option<String>,
    /// The message that pinged, or that was reacted to; 0 in the `friends` scope.
    pub message_id: i64,
    /// Root message when the ping is about a thread reply. Thread pings count toward their
    /// channel scope but are only marked seen by reading the thread (`t<root id>`).
    pub thread_root_id: Option<i64>,
    /// Who caused the ping.
    pub actor: UserRef,
    /// The reaction emoji for `reaction` pings.
    pub emoji: Option<String>,
    /// Start of the message text, at most 200 characters.
    pub excerpt: String,
    /// When the ping was created.
    pub created_at: i64,
}

/// Where a pinging message lives.
#[derive(Clone, Copy)]
pub enum PingScope<'a> {
    Channel(&'a ResolvedChannel),
    Dm { id: i64, users: &'a [String] },
}

impl PingScope<'_> {
    pub fn key(&self) -> String {
        match self {
            PingScope::Channel(channel) => format!("c{}", channel.id()),
            PingScope::Dm { id, users: _ } => format!("d{id}"),
        }
    }

    pub fn server(&self) -> Option<String> {
        match self {
            PingScope::Channel(channel) => Some(channel.server().name().to_string()),
            PingScope::Dm { id: _, users: _ } => None,
        }
    }

    /// The candidates (lowercase usernames) who may be pinged about `message` here: existing
    /// members who can view the channel (and read the thread root of a thread reply), or the DM
    /// participants. Order is kept.
    pub async fn recipients(
        &self,
        db: &Db,
        names: &[String],
        message: &Message,
    ) -> Result<Vec<String>, ApiError> {
        match self {
            PingScope::Channel(channel) => {
                channel
                    .viewers_among(db, names, message.thread_root_id)
                    .await
            }
            PingScope::Dm { id: _, users } => Ok(names
                .iter()
                .filter(|n| users.contains(n))
                .cloned()
                .collect()),
        }
    }
}

static WORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[\p{L}\p{N}\p{M}_]$").expect("word regex"));

fn is_word(c: char) -> bool {
    let mut buf = [0u8; 4];
    WORD.is_match(c.encode_utf8(&mut buf))
}

fn fence(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with("```") || t.starts_with("~~~")
}

/// Blanks out fenced code blocks and closed inline code spans (same rules as `maskCode` in
/// `apps/web/app/lib/mentions.ts`), so `@name` inside code is not a mention.
pub fn mask_code(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut fenced = false;
    for (i, line) in text.split('\n').enumerate() {
        if i > 0 {
            out.push('\n');
        }
        if fence(line) {
            fenced = !fenced;
            out.extend(line.chars().map(|_| ' '));
            continue;
        }
        if fenced {
            out.extend(line.chars().map(|_| ' '));
            continue;
        }
        let chars: Vec<char> = line.chars().collect();
        let mut masked = chars.clone();
        let mut open: Option<(usize, usize)> = None;
        let mut i = 0;
        while i < chars.len() {
            if chars[i] != '`' {
                i += 1;
                continue;
            }
            let start = i;
            while i < chars.len() && chars[i] == '`' {
                i += 1;
            }
            let len = i - start;
            match open {
                None => open = Some((start, len)),
                Some((from, n)) if n == len => {
                    masked[from..i].fill(' ');
                    open = None;
                }
                Some(_) => {}
            }
        }
        out.extend(masked);
    }
    out
}

/// Lowercase usernames that `content` may mention, in order of appearance: for every `@` not
/// preceded by a word character, each run of following characters (no `@`, no line break) that
/// is not followed by a word character. This is the word-boundary rule of `mentionsUser` in
/// `apps/web/app/lib/mentions.ts`, so a username with spaces or dots can be mentioned. Code is
/// skipped.
pub fn mention_candidates(content: &str) -> Vec<String> {
    let text: Vec<char> = mask_code(&content.to_lowercase()).chars().collect();
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for (at, c) in text.iter().enumerate() {
        if *c != '@' || (at > 0 && is_word(text[at - 1])) {
            continue;
        }
        let mut end = at + 1;
        while end < text.len() && end - at <= NAME_MAX && text[end] != '@' && text[end] != '\n' {
            let next = text.get(end + 1);
            if !next.is_some_and(|n| is_word(*n)) && !text[end].is_whitespace() {
                let name: String = text[at + 1..=end].iter().collect();
                if seen.insert(name.clone()) {
                    out.push(name);
                    if out.len() == CANDIDATES_MAX {
                        return out;
                    }
                }
            }
            end += 1;
        }
    }
    out
}

/// Existing, live accounts among `candidates`, in the same order, at most `MENTION_MAX`,
/// without `author`.
pub async fn mentioned_users(
    db: &Db,
    candidates: &[String],
    author: &str,
) -> Result<Vec<String>, ApiError> {
    let wanted: Vec<&String> = candidates.iter().filter(|c| c.as_str() != author).collect();
    let mut found = HashSet::new();
    for chunk in wanted.chunks(100) {
        let sql = format!(
            "SELECT username FROM users WHERE password_hash <> '!purging' AND username IN ({})",
            placeholders(1, chunk.len())
        );
        let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
        for name in chunk {
            query = query.bind(name.as_str());
        }
        for r in query.fetch_all(db).await? {
            found.insert(r.try_get::<String, _>(0)?);
        }
    }
    Ok(wanted
        .into_iter()
        .filter(|n| found.contains(n.as_str()))
        .take(MENTION_MAX)
        .cloned()
        .collect())
}

/// The first `EXCERPT_MAX` characters; a spoiler cut open is closed again, so clients keep it
/// hidden.
pub(crate) fn excerpt(content: &str) -> String {
    let Some((cut, _)) = content.char_indices().nth(EXCERPT_MAX) else {
        return content.to_string();
    };
    let mut out = content[..cut].to_string();
    let open = crate::spoilers::spans(content, false)
        .iter()
        .any(|s| s.start + 2 <= cut && cut < s.end);
    if open {
        out.push_str("||");
    }
    out
}

/// What a batch of pings is about. `message` must be the stored message; its content gives the
/// excerpt.
pub struct PingSpec<'a> {
    pub kind: PingKind,
    pub scope: String,
    pub server: Option<String>,
    pub message: &'a Message,
    pub actor: &'a User,
    pub emoji: Option<String>,
}

/// Stores one unseen ping per recipient (callers check that each recipient may see the scope)
/// and trims each recipient's unseen pings to the newest `PINGS_MAX`. Returns the stored pings
/// in recipient order. Does not notify anyone; see `create_pings`.
pub async fn insert_pings(
    db: &Db,
    spec: &PingSpec<'_>,
    recipients: &[String],
) -> Result<Vec<(String, Ping)>, ApiError> {
    let PingSpec {
        kind,
        scope,
        server,
        message,
        actor,
        emoji,
    } = spec;
    let t = now();
    let pool = crate::db::pool_key(db);
    let mut out = Vec::with_capacity(recipients.len());
    let mut tx = db.begin().await?;
    for username in recipients {
        let id: i64 = sqlx::query(
            "INSERT INTO pings(username, kind, scope, server, message_id, thread_root_id, actor, emoji, created_at) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id",
        )
        .bind(username)
        .bind(kind.as_str())
        .bind(scope)
        .bind(server.as_deref())
        .bind(message.id)
        .bind(message.thread_root_id)
        .bind(&actor.username)
        .bind(emoji.as_deref())
        .bind(t)
        .fetch_one(&mut *tx)
        .await?
        .try_get(0)?;
        trim_unseen(&mut tx, &pool, username).await?;
        out.push((
            username.clone(),
            Ping {
                id,
                kind: *kind,
                scope: scope.clone(),
                server: server.clone(),
                message_id: message.id,
                thread_root_id: message.thread_root_id,
                actor: UserRef::from_user(actor),
                emoji: emoji.clone(),
                excerpt: excerpt(&message.content),
                created_at: t,
            },
        ));
    }
    tx.commit().await?;
    Ok(out)
}

/// How many more unseen pings each recipient can get before `trim_unseen` has to count, per
/// process. Each insert here lowers it; seeing or removing pings only adds real room, so the
/// value stays on the safe side. It is counted again after `HEADROOM_SECS`, which covers
/// pings that other processes insert.
static HEADROOM: LazyLock<std::sync::Mutex<HashMap<String, (std::time::Instant, i64)>>> =
    LazyLock::new(Default::default);
const HEADROOM_SECS: u64 = 60;
const HEADROOM_KEYS: usize = 100_000;
/// Most extra pings one trim removes (after other processes went past the cap).
const TRIM_MAX: i64 = 200;

#[cfg(test)]
thread_local! {
    static COUNTS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

fn headroom_left(key: &str) -> bool {
    let mut map = match HEADROOM.lock() {
        Ok(map) => map,
        Err(poisoned) => poisoned.into_inner(),
    };
    match map.get_mut(key) {
        Some((at, n)) if at.elapsed() < Duration::from_secs(HEADROOM_SECS) && *n > 0 => {
            *n -= 1;
            true
        }
        Some(_) | None => false,
    }
}

fn set_headroom(key: String, n: i64) {
    let mut map = match HEADROOM.lock() {
        Ok(map) => map,
        Err(poisoned) => poisoned.into_inner(),
    };
    if map.len() >= HEADROOM_KEYS && !map.contains_key(&key) {
        map.clear();
    }
    map.insert(key, (std::time::Instant::now(), n));
}

/// Keeps `username` at `PINGS_MAX` unseen pings. Past it, the oldest unseen pings of the actor
/// who sent the most of them go first, so one sender can not push out the pings of others.
/// While the cached headroom lasts, nothing is counted.
async fn trim_unseen(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    pool: &str,
    username: &str,
) -> Result<(), ApiError> {
    let key = format!("{pool}\n{username}");
    if headroom_left(&key) {
        return Ok(());
    }
    #[cfg(test)]
    COUNTS.with(|c| c.set(c.get() + 1));
    let unseen: i64 = sqlx::query(
        "SELECT COUNT(*) FROM (SELECT 1 FROM pings WHERE username = $1 AND seen = 0 LIMIT $2) t",
    )
    .bind(username)
    .bind(PINGS_MAX + TRIM_MAX)
    .fetch_one(&mut **tx)
    .await?
    .try_get(0)?;
    let mut over = unseen - PINGS_MAX;
    while over > 0 {
        let top: String = sqlx::query(
            "SELECT actor FROM pings WHERE username = $1 AND seen = 0 GROUP BY actor ORDER BY COUNT(*) DESC, MIN(id) LIMIT 1",
        )
        .bind(username)
        .fetch_one(&mut **tx)
        .await?
        .try_get(0)?;
        let gone = sqlx::query(
            "DELETE FROM pings WHERE id IN (SELECT id FROM pings WHERE username = $1 AND seen = 0 AND actor = $2 ORDER BY id LIMIT $3)",
        )
        .bind(username)
        .bind(&top)
        .bind(over)
        .execute(&mut **tx)
        .await?
        .rows_affected() as i64;
        if gone == 0 {
            break;
        }
        over -= gone;
    }
    set_headroom(key, (PINGS_MAX - unseen).max(0));
    Ok(())
}

/// Pings from one actor to one recipient.
static PAIR_PACE: LazyLock<Budget> =
    LazyLock::new(|| Budget::new(PAIR_MAX, Duration::from_secs(60), 100_000));
/// Pings from one actor to everyone.
static ACTOR_PACE: LazyLock<Budget> =
    LazyLock::new(|| Budget::new(ACTOR_MAX, Duration::from_secs(60), 100_000));

pub const PAIR_MAX: u32 = 20;
pub const ACTOR_MAX: u32 = 100;

/// The recipients an actor may still ping in this minute. The message is stored either way.
fn paced(db: &Db, actor: &str, recipients: &[String]) -> Vec<String> {
    let pool = crate::db::pool_key(db);
    recipients
        .iter()
        .filter(|r| {
            !ACTOR_PACE.spent(&format!("{pool}\n{actor}"))
                && PAIR_PACE.take(&format!("{pool}\n{actor}\n{r}"))
                && ACTOR_PACE.take(&format!("{pool}\n{actor}"))
        })
        .cloned()
        .collect()
}

/// Stores the pings (see `insert_pings`) and sends each recipient's connections a `ping` event.
/// Recipients who blocked the actor get nothing. Each actor is paced per recipient and in total;
/// pings past the pace are dropped.
pub async fn create_pings(
    state: &AppState,
    spec: &PingSpec<'_>,
    recipients: &[String],
) -> Result<Vec<Ping>, ApiError> {
    let recipients =
        crate::api::blocks::not_blocking(&state.db, &spec.actor.username, recipients).await?;
    let recipients = paced(&state.db, &spec.actor.username, &recipients);
    if recipients.is_empty() {
        return Ok(Vec::new());
    }
    let stored = insert_pings(&state.db, spec, &recipients).await?;
    let mut out = Vec::with_capacity(stored.len());
    for (username, ping) in stored {
        state.hub.broadcast(WsEvent::Ping {
            username,
            ping: ping.clone(),
        });
        out.push(ping);
    }
    Ok(out)
}

/// Pings for a new message: a `reply` ping to `replied` (the quoted message's author, when the
/// reply asked to mention them) and a `mention` ping to each user the text mentions with
/// `@username`, all only if they can see `scope`. Someone who gets the reply ping is not pinged
/// again for mentioning them. Never fails the send: errors are logged.
pub async fn ping_message(
    state: &AppState,
    scope: PingScope<'_>,
    message: &Message,
    actor: &User,
    replied: Option<&str>,
) {
    let run = async {
        let replied: Vec<String> = replied
            .filter(|name| *name != actor.username)
            .map(str::to_string)
            .into_iter()
            .collect();
        let replied = match replied.is_empty() {
            true => replied,
            false => scope.recipients(&state.db, &replied, message).await?,
        };
        if !replied.is_empty() {
            let spec = PingSpec {
                kind: PingKind::Reply,
                scope: scope.key(),
                server: scope.server(),
                message,
                actor,
                emoji: None,
            };
            create_pings(state, &spec, &replied).await?;
        }
        let candidates = mention_candidates(&message.content);
        if candidates.is_empty() {
            return Ok(());
        }
        let named: Vec<String> = mentioned_users(&state.db, &candidates, &actor.username)
            .await?
            .into_iter()
            .filter(|name| !replied.contains(name))
            .collect();
        let recipients = scope.recipients(&state.db, &named, message).await?;
        if recipients.is_empty() {
            return Ok(());
        }
        let spec = PingSpec {
            kind: PingKind::Mention,
            scope: scope.key(),
            server: scope.server(),
            message,
            actor,
            emoji: None,
        };
        create_pings(state, &spec, &recipients).await.map(|_| ())
    };
    let res: Result<(), ApiError> = run.await;
    if let Err(ApiError(_, e)) = res {
        tracing::warn!("pings for message {} failed: {e}", message.id);
    }
}

/// Most `@here` recipients stored per message (online viewers at send time).
pub const HERE_MAX: usize = 500;
/// Most role mentions per message.
pub const ROLE_MENTION_MAX: usize = 20;
/// Most online users looked at for one `@here`.
const HERE_SCAN: usize = 4 * HERE_MAX;
/// Most group-mentioned messages counted per user (like `PINGS_MAX`).
pub const GROUP_PINGS_MAX: i64 = PINGS_MAX;

/// Who a group mention addresses.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, ToSchema,
)]
#[serde(rename_all = "lowercase")]
pub enum GroupKind {
    /// `@everyone`: every member who can view the channel.
    Everyone,
    /// `@here`: the members who were online and could view the channel when it was sent.
    Here,
    /// `@role name`: the members with the role who can view the channel.
    Role,
}

impl GroupKind {
    pub fn as_str(self) -> &'static str {
        match self {
            GroupKind::Everyone => "everyone",
            GroupKind::Here => "here",
            GroupKind::Role => "role",
        }
    }

    fn parse(s: &str) -> Option<GroupKind> {
        match s {
            "everyone" => Some(GroupKind::Everyone),
            "here" => Some(GroupKind::Here),
            "role" => Some(GroupKind::Role),
            _ => None,
        }
    }
}

/// An `@everyone`, `@here` or role mention that pinged.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct GroupMention {
    /// Who it addresses.
    pub kind: GroupKind,
    /// The role for `role` mentions; `null` otherwise.
    pub role_id: Option<i64>,
}

/// `messages.group_mentions`: `everyone`, `here` and `r<role id>`, space separated.
pub fn stored_group_mentions(list: &[GroupMention]) -> Option<String> {
    let parts: Vec<String> = list
        .iter()
        .map(|g| match (g.kind, g.role_id) {
            (GroupKind::Role, Some(id)) => format!("r{id}"),
            (kind, _) => kind.as_str().to_string(),
        })
        .collect();
    match parts.is_empty() {
        true => None,
        false => Some(parts.join(" ")),
    }
}

pub fn parse_group_mentions(stored: Option<&str>) -> Vec<GroupMention> {
    stored
        .unwrap_or_default()
        .split_whitespace()
        .filter_map(|part| match part.strip_prefix('r') {
            Some(id) => id.parse().ok().map(|id| GroupMention {
                kind: GroupKind::Role,
                role_id: Some(id),
            }),
            None => GroupKind::parse(part).map(|kind| GroupMention {
                kind,
                role_id: None,
            }),
        })
        .collect()
}

/// The group mentions in `content` that `actor` may use in `channel`: `@everyone`, `@here` and
/// every role with the Mention everyone permission, and roles that allow anyone to mention them
/// without it. Uses the same candidates as `@username` mentions (code is skipped). The
/// permission is the one membership gives, so a site admin gets nothing extra.
pub async fn group_mentions(
    db: &Db,
    channel: &ResolvedChannel,
    content: &str,
) -> Result<Vec<GroupMention>, ApiError> {
    let candidates = mention_candidates(content);
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    let allowed = channel.member_bits(db).await? & crate::db::Perm::MentionEveryone as i64 != 0;
    let wanted: HashSet<&str> = candidates.iter().map(String::as_str).collect();
    let mut out = Vec::new();
    if allowed {
        for kind in [GroupKind::Everyone, GroupKind::Here] {
            if wanted.contains(kind.as_str()) {
                out.push(GroupMention {
                    kind,
                    role_id: None,
                });
            }
        }
    }
    let rows = sqlx::query("SELECT id, name, mentionable FROM roles WHERE server = $1 ORDER BY id")
        .bind(channel.server().name())
        .fetch_all(db)
        .await?;
    let mut roles = 0;
    for r in &rows {
        let (id, name, mentionable): (i64, String, i64) =
            (r.try_get(0)?, r.try_get(1)?, r.try_get(2)?);
        if (allowed || mentionable != 0) && wanted.contains(name.trim().to_lowercase().as_str()) {
            out.push(GroupMention {
                kind: GroupKind::Role,
                role_id: Some(id),
            });
            roles += 1;
            if roles == ROLE_MENTION_MAX {
                break;
            }
        }
    }
    Ok(out)
}

/// The members of the channel's server who are online anywhere on the site and can view the
/// channel, without the author: at most `HERE_MAX`, looking at no more than `HERE_SCAN` of the
/// server's online members.
async fn here_recipients(
    state: &AppState,
    channel: &ResolvedChannel,
    author: &str,
) -> Result<Vec<String>, ApiError> {
    let server = channel.server().name();
    let mut out = Vec::new();
    let mut after: Option<String> = None;
    let mut scanned = 0;
    while out.len() < HERE_MAX && scanned < HERE_SCAN {
        let page = state.hub.online_after(server, after.as_deref(), HERE_MAX);
        let Some(last) = page.last().cloned() else {
            break;
        };
        scanned += page.len();
        let names: Vec<String> = page.into_iter().filter(|n| n != author).collect();
        out.extend(channel.viewers_among(&state.db, &names, None).await?);
        after = Some(last);
    }
    out.truncate(HERE_MAX);
    Ok(out)
}

/// Stores the group mentions of a new top-level channel message: one `group_pings` row per
/// mention, and for `@here` the online viewers (at most `HERE_MAX`). Nothing is stored per
/// member otherwise: unseen counts are worked out when they are read (`group_unseen`). Never
/// fails the send: errors are logged.
pub async fn store_group_pings(state: &AppState, channel: &ResolvedChannel, message: &Message) {
    if message.group_mentions.is_empty() || message.thread_root_id.is_some() {
        return;
    }
    let run = async {
        let here = match message
            .group_mentions
            .iter()
            .any(|g| g.kind == GroupKind::Here)
        {
            true => here_recipients(state, channel, &message.author.username).await?,
            false => Vec::new(),
        };
        let mut tx = state.db.begin().await?;
        for g in &message.group_mentions {
            let id: i64 = sqlx::query(
                "INSERT INTO group_pings(message_id, channel_id, server, kind, role_id, actor, created_at) VALUES($1, $2, $3, $4, $5, $6, $7) RETURNING id",
            )
            .bind(message.id)
            .bind(channel.id())
            .bind(channel.server().name())
            .bind(g.kind.as_str())
            .bind(g.role_id)
            .bind(&message.author.username)
            .bind(message.created_at)
            .fetch_one(&mut *tx)
            .await?
            .try_get(0)?;
            if g.kind != GroupKind::Here {
                continue;
            }
            for chunk in here.chunks(100) {
                let values: Vec<String> = (0..chunk.len())
                    .map(|i| format!("($1, ${})", i + 2))
                    .collect();
                let sql = format!(
                    "INSERT INTO here_pings(ping_id, username) VALUES {} ON CONFLICT DO NOTHING",
                    values.join(", ")
                );
                let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(id);
                for name in chunk {
                    query = query.bind(name);
                }
                query.execute(&mut *tx).await?;
            }
        }
        tx.commit().await?;
        Ok::<(), ApiError>(())
    };
    if let Err(ApiError(_, e)) = run.await {
        tracing::warn!("group pings for message {} failed: {e}", message.id);
    }
}

/// An unread message that pings the reader through group mentions.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct GroupPing {
    /// The message.
    pub message_id: i64,
    /// Its group mentions that address the reader (`role` once, however many of their roles it
    /// names).
    pub kinds: Vec<GroupKind>,
}

/// See `group_unseen`. `hidden` channels (ids the reader cannot view) are left out in the query,
/// so they never use up the `GROUP_PINGS_MAX` rows.
pub(crate) fn group_unseen_sql(hidden: &[i64]) -> String {
    let skip = match hidden {
        [] => String::new(),
        ids => format!(
            " AND g.channel_id NOT IN ({})",
            ids.iter()
                .map(i64::to_string)
                .collect::<Vec<_>>()
                .join(", ")
        ),
    };
    format!(
        "SELECT g.channel_id, g.message_id, g.kind FROM members mem JOIN channels c ON c.server = mem.server JOIN group_pings g ON g.channel_id = c.id WHERE mem.username = $1 AND c.kind = 'text' AND g.message_id > COALESCE((SELECT rs.last_read FROM read_state rs WHERE rs.username = $1 AND rs.scope = 'c' || c.id), 0) AND g.created_at >= mem.joined_at AND g.actor <> $1 AND NOT EXISTS(SELECT 1 FROM blocks b WHERE b.blocker = $1 AND b.blocked = g.actor) AND (g.kind = 'everyone' OR (g.kind = 'here' AND EXISTS(SELECT 1 FROM here_pings h WHERE h.username = $1 AND h.ping_id = g.id)) OR (g.kind = 'role' AND EXISTS(SELECT 1 FROM user_roles ur WHERE ur.server = g.server AND ur.username = $1 AND ur.role_id = g.role_id))) AND NOT EXISTS(SELECT 1 FROM pings p WHERE p.message_id = g.message_id AND p.username = $1 AND p.kind <> 'reaction') AND NOT EXISTS(SELECT 1 FROM group_pings_read gr WHERE gr.username = $1 AND gr.message_id = g.message_id){skip} ORDER BY g.message_id DESC LIMIT $2"
    )
}

/// Unread messages that ping `username` through group mentions, by channel id, newest first.
/// A message counts while it is newer than the reader's read position in the channel, was sent
/// after they joined the server (so read-history limits never matter), is not their own, and
/// addresses them: `@everyone`, `@here` when they were among the stored online viewers, or a
/// role they hold now. Messages by someone they blocked never count. Messages that also ping them personally (a mention or reply ping) count
/// only there, and messages they marked read in the inbox (`group_pings_read`) do not count.
/// Channels in `hidden` (the ones they cannot view) are skipped. At most
/// `GROUP_PINGS_MAX` rows are read; every lookup is indexed (`members` by user, `channels` by server,
/// `group_pings` by channel and message id, `read_state`, `here_pings`, `user_roles` and `blocks` by
/// primary key, `pings` by message).
pub async fn group_unseen(
    db: &Db,
    username: &str,
    hidden: &[i64],
) -> sqlx::Result<HashMap<i64, Vec<GroupPing>>> {
    let rows = sqlx::query(sqlx::AssertSqlSafe(group_unseen_sql(hidden)))
        .bind(username)
        .bind(GROUP_PINGS_MAX)
        .fetch_all(db)
        .await?;
    let mut out: HashMap<i64, Vec<GroupPing>> = HashMap::new();
    for r in &rows {
        let (channel, message_id, kind): (i64, i64, String) =
            (r.try_get(0)?, r.try_get(1)?, r.try_get(2)?);
        let Some(kind) = GroupKind::parse(&kind) else {
            continue;
        };
        let list = out.entry(channel).or_default();
        match list.last_mut() {
            Some(last) if last.message_id == message_id => {
                if !last.kinds.contains(&kind) {
                    last.kinds.push(kind);
                    last.kinds.sort();
                }
            }
            _ => list.push(GroupPing {
                message_id,
                kinds: vec![kind],
            }),
        }
    }
    Ok(out)
}

/// Which unseen pings a read covers.
#[derive(Clone, Copy, Debug)]
pub enum SeenScope<'a> {
    /// A channel or DM scope (`c<id>`/`d<id>`), outside threads.
    Scope(&'a str),
    /// The replies of one thread; `scope` is the thread's channel scope.
    Thread { scope: &'a str, root: i64 },
}

/// Marks the unseen pings of `username` in `target` with an id up to `bound` (all of them when
/// `None`) seen. Returns the highest id it marked, `None` when nothing changed. Pings created
/// after the reader's decision have higher ids and stay unseen.
pub async fn mark_seen(
    db: &Db,
    username: &str,
    target: SeenScope<'_>,
    bound: Option<i64>,
) -> sqlx::Result<Option<i64>> {
    let (scope, root) = match target {
        SeenScope::Scope(scope) => (scope, None),
        SeenScope::Thread { scope, root } => (scope, Some(root)),
    };
    let filter = match root {
        None => "thread_root_id IS NULL",
        Some(_) => "thread_root_id = $4",
    };
    let bound = bound.unwrap_or(i64::MAX);
    let top_sql = format!(
        "SELECT MAX(id) FROM pings WHERE username = $1 AND seen = 0 AND scope = $2 AND id <= $3 AND {filter}"
    );
    let mut top = sqlx::query(sqlx::AssertSqlSafe(top_sql))
        .bind(username)
        .bind(scope)
        .bind(bound);
    if let Some(root) = root {
        top = top.bind(root);
    }
    let Some(until) = top.fetch_one(db).await?.try_get::<Option<i64>, _>(0)? else {
        return Ok(None);
    };
    let sql = format!(
        "UPDATE pings SET seen = 1 WHERE username = $1 AND seen = 0 AND scope = $2 AND id <= $3 AND {filter}"
    );
    let mut update = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(username)
        .bind(scope)
        .bind(until);
    if let Some(root) = root {
        update = update.bind(root);
    }
    Ok(match update.execute(db).await?.rows_affected() {
        0 => None,
        _ => Some(until),
    })
}

/// Unseen pings of one thread in a scope.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ThreadPings {
    /// The thread's root message.
    pub root_id: i64,
    /// Unseen pings on its replies.
    pub pings: i64,
    /// Highest unseen ping id among them.
    pub pings_until: i64,
}

/// Unseen pings of a user in one scope.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ScopePings {
    /// All unseen pings, thread pings included.
    pub pings: i64,
    /// Highest unseen ping id outside threads; 0 when there is none.
    pub pings_until: i64,
    /// Unseen pings per thread, by root id.
    pub threads: Vec<ThreadPings>,
}

impl ScopePings {
    fn add(&mut self, root: Option<i64>, pings: i64, until: i64) {
        self.pings += pings;
        match root {
            None => self.pings_until = self.pings_until.max(until),
            Some(root_id) => self.threads.push(ThreadPings {
                root_id,
                pings,
                pings_until: until,
            }),
        }
    }
}

fn scope_pings_from(rows: &[sqlx::any::AnyRow]) -> sqlx::Result<Vec<(String, ScopePings)>> {
    let mut out: Vec<(String, ScopePings)> = Vec::new();
    for r in rows {
        let scope: String = r.try_get(0)?;
        let (root, pings, until): (Option<i64>, i64, i64) =
            (r.try_get(1)?, r.try_get(2)?, r.try_get(3)?);
        match out.last_mut() {
            Some((last, acc)) if *last == scope => acc.add(root, pings, until),
            _ => {
                let mut acc = ScopePings::default();
                acc.add(root, pings, until);
                out.push((scope, acc));
            }
        }
    }
    Ok(out)
}

/// Unseen pings of `username` by scope.
pub async fn unseen_counts(db: &Db, username: &str) -> sqlx::Result<HashMap<String, ScopePings>> {
    let rows = sqlx::query(
        "SELECT scope, thread_root_id, COUNT(*), MAX(id) FROM pings WHERE username = $1 AND seen = 0 GROUP BY scope, thread_root_id ORDER BY scope, thread_root_id",
    )
    .bind(username)
    .fetch_all(db)
    .await?;
    Ok(scope_pings_from(&rows)?.into_iter().collect())
}

/// Unseen pings of `username` in one scope.
pub async fn scope_counts(db: &Db, username: &str, scope: &str) -> sqlx::Result<ScopePings> {
    let rows = sqlx::query(
        "SELECT scope, thread_root_id, COUNT(*), MAX(id) FROM pings WHERE username = $1 AND scope = $2 AND seen = 0 GROUP BY scope, thread_root_id ORDER BY thread_root_id",
    )
    .bind(username)
    .bind(scope)
    .fetch_all(db)
    .await?;
    Ok(scope_pings_from(&rows)?
        .pop()
        .map(|(_, p)| p)
        .unwrap_or_default())
}

/// Drops `username`'s pings in `server` when their membership ends (leave, kick, ban), so old
/// pings do not come back on rejoin.
pub async fn forget_server_pings(
    conn: &mut sqlx::AnyConnection,
    server: &str,
    username: &str,
) -> sqlx::Result<u64> {
    sqlx::query("DELETE FROM group_pings_read WHERE username = $2 AND message_id IN (SELECT g.message_id FROM group_pings g WHERE g.server = $1)")
        .bind(server)
        .bind(username)
        .execute(&mut *conn)
        .await?;
    Ok(
        sqlx::query("DELETE FROM pings WHERE server = $1 AND username = $2")
            .bind(server)
            .bind(username)
            .execute(conn)
            .await?
            .rows_affected(),
    )
}

/// The (recipient, scope) pairs with unseen pings on `message_id` or, for a thread root, its
/// replies. Call before deleting, then `announce_counts` after.
pub async fn pinged_by(db: &Db, message_id: i64) -> sqlx::Result<Vec<(String, String)>> {
    let rows = sqlx::query(
        "SELECT DISTINCT p.username, p.scope FROM pings p WHERE p.seen = 0 AND (p.message_id = $1 OR p.message_id IN (SELECT r.id FROM messages r WHERE r.thread_root_id = $1))",
    )
    .bind(message_id)
    .fetch_all(db)
    .await?;
    rows.iter()
        .map(|r| Ok((r.try_get(0)?, r.try_get(1)?)))
        .collect()
}

/// Sends each user a `ping_count` event with their current unseen pings in the scope (after
/// pings were removed).
pub async fn announce_counts(state: &AppState, pairs: Vec<(String, String)>) {
    for (username, scope) in pairs {
        match scope_counts(&state.db, &username, &scope).await {
            Ok(ScopePings {
                pings,
                pings_until,
                threads,
            }) => state.hub.broadcast(WsEvent::PingCount {
                username,
                scope,
                pings,
                pings_until,
                thread_pings: threads,
            }),
            Err(e) => tracing::warn!("ping count for {username} failed: {e}"),
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn excerpts_keep_spoilers_closed() {
        assert_eq!(super::excerpt("short ||one||"), "short ||one||");
        let long = format!("a ||{}||", "s".repeat(300));
        let cut = super::excerpt(&long);
        assert!(cut.ends_with("s||"));
        assert_eq!(cut.chars().count(), super::EXCERPT_MAX + 2);
        let plain = format!("||x|| {}", "p".repeat(300));
        assert_eq!(super::excerpt(&plain).chars().count(), super::EXCERPT_MAX);
    }

    use super::*;
    use crate::api::test_util::{done, mem_user, temp_state};

    fn names(content: &str) -> Vec<String> {
        mention_candidates(content)
    }

    #[test]
    fn candidates_follow_the_client_word_boundary_rule() {
        assert_eq!(names("hey @bob"), vec!["bob"]);
        assert_eq!(names("@BOB, look"), vec!["bob", "bob,", "bob, look"]);
        assert_eq!(names("(@bob)"), vec!["bob", "bob)"]);
        assert_eq!(names("@bob's turn")[0], "bob");
        assert!(names("mail@bob").is_empty());
        assert!(names("@").is_empty());
        assert_eq!(names("@bob_x"), vec!["bob_x"]);
        assert_eq!(names("@zoë!"), vec!["zoë", "zoë!"]);
        assert_eq!(names("@@bob"), vec!["bob"]);
        assert_eq!(names("x@bob @bob"), vec!["bob"]);
        assert_eq!(names("@a.b c"), vec!["a", "a.b", "a.b c"]);
        assert_eq!(names("hi\n@bob\nnext"), vec!["bob"]);
        assert_eq!(names("@john smith now")[..2], ["john", "john smith"]);
        assert!(names("`@bob` and\n```\n@carol\n```").is_empty());
        assert_eq!(names("`@bob` and ```\n@carol"), vec!["carol"]);
        assert_eq!(names("`` `@x` `` @y"), vec!["y"]);
        assert_eq!(names("`@open"), vec!["open"]);
        let long = format!("@{}", "a".repeat(150));
        assert!(names(&long).is_empty());
        let many: String = (0..1000).map(|i| format!("@u{i} ")).collect();
        assert_eq!(names(&many).len(), CANDIDATES_MAX);
    }

    #[test]
    fn code_is_masked_like_the_client() {
        assert_eq!(mask_code("a `b` c"), "a     c");
        assert_eq!(mask_code("a ``b`` `c"), "a       `c");
        assert_eq!(mask_code("x\n```\n@y\n```\nz"), "x\n   \n  \n   \nz");
        assert_eq!(mask_code("~~~\n@y"), "   \n  ");
    }

    #[tokio::test]
    async fn unseen_pings_are_capped_per_user_keeping_the_newest() {
        let (state, path) = temp_state("ping_cap").await;
        let db = &state.db;
        let cid: i64 = sqlx::query("SELECT id FROM channels WHERE server = 'rchat'")
            .fetch_one(db)
            .await
            .expect("general")
            .try_get(0)
            .expect("id");
        let mid: i64 = sqlx::query("INSERT INTO messages(channel_id, author, content, created_at) VALUES($1, 'alice', 'hi @bob', 1) RETURNING id")
            .bind(cid)
            .fetch_one(db)
            .await
            .expect("message")
            .try_get(0)
            .expect("id");
        let message =
            crate::api::messages::load_message(db, mid, crate::api::messages::Quotes::Skip)
                .await
                .expect("load")
                .expect("message");
        sqlx::query("INSERT INTO pings(username, kind, scope, message_id, actor, created_at, seen) VALUES('bob', 'mention', 'c1', $1, 'alice', 1, 1)")
            .bind(mid)
            .execute(db)
            .await
            .expect("seen ping");
        let alice = mem_user("alice", false);
        let spec = PingSpec {
            kind: PingKind::Mention,
            scope: format!("c{cid}"),
            server: Some("rchat".to_string()),
            message: &message,
            actor: &alice,
            emoji: None,
        };
        let mut last = 0;
        for _ in 0..(PINGS_MAX + 5) {
            let made = insert_pings(db, &spec, &["bob".to_string(), "carol".to_string()])
                .await
                .expect("insert");
            assert_eq!(made.len(), 2);
            assert_eq!(made[0].1.excerpt, "hi @bob");
            last = made[0].1.id;
        }
        let count = |sql: &'static str| async move {
            sqlx::query(sql)
                .fetch_one(db)
                .await
                .expect(sql)
                .try_get::<i64, _>(0)
                .expect("n")
        };
        assert_eq!(
            count("SELECT COUNT(*) FROM pings WHERE username = 'bob' AND seen = 0").await,
            PINGS_MAX
        );
        assert_eq!(
            count("SELECT COUNT(*) FROM pings WHERE username = 'carol' AND seen = 0").await,
            PINGS_MAX
        );
        assert_eq!(
            count("SELECT MAX(id) FROM pings WHERE username = 'bob'").await,
            last
        );
        assert_eq!(
            count("SELECT COUNT(*) FROM pings WHERE username = 'bob' AND seen = 1").await,
            1
        );
        let scope = format!("c{cid}");
        assert_eq!(
            unseen_counts(db, "bob").await.expect("counts").get(&scope),
            Some(&ScopePings {
                pings: PINGS_MAX,
                pings_until: last,
                threads: Vec::new(),
            })
        );
        assert_eq!(
            mark_seen(db, "bob", SeenScope::Scope(&scope), Some(last - 2))
                .await
                .expect("seen"),
            Some(last - 2)
        );
        assert_eq!(
            scope_counts(db, "bob", &scope).await.expect("count").pings,
            1
        );
        assert_eq!(
            mark_seen(db, "bob", SeenScope::Scope(&scope), None)
                .await
                .expect("seen"),
            Some(last)
        );
        assert_eq!(
            mark_seen(db, "bob", SeenScope::Scope(&scope), None)
                .await
                .expect("nothing left"),
            None
        );
        let swept = crate::db::sweep_stale(db).await.expect("sweep");
        assert_eq!(swept.pings, 1, "seen pings stay until they age out");
        sqlx::query("DELETE FROM messages WHERE id = $1")
            .bind(mid)
            .execute(db)
            .await
            .expect("delete");
        assert_eq!(count("SELECT COUNT(*) FROM pings").await, 0);
        done(state, path).await;
    }

    #[tokio::test]
    async fn the_unseen_cap_counts_only_when_the_headroom_is_used_up() {
        let (state, path) = temp_state("ping_headroom").await;
        let db = &state.db;
        let cid: i64 = sqlx::query("SELECT id FROM channels WHERE server = 'rchat'")
            .fetch_one(db)
            .await
            .expect("general")
            .try_get(0)
            .expect("id");
        let mid: i64 = sqlx::query("INSERT INTO messages(channel_id, author, content, created_at) VALUES($1, 'alice', 'hi', 1) RETURNING id")
            .bind(cid)
            .fetch_one(db)
            .await
            .expect("message")
            .try_get(0)
            .expect("id");
        let message =
            crate::api::messages::load_message(db, mid, crate::api::messages::Quotes::Skip)
                .await
                .expect("load")
                .expect("message");
        let alice = mem_user("alice", false);
        let spec = PingSpec {
            kind: PingKind::Mention,
            scope: format!("c{cid}"),
            server: Some("rchat".to_string()),
            message: &message,
            actor: &alice,
            emoji: None,
        };
        let counts = || COUNTS.with(|c| c.get());
        let before = counts();
        for _ in 0..50 {
            insert_pings(db, &spec, &["bob".to_string()])
                .await
                .expect("insert");
        }
        assert_eq!(counts() - before, 1, "one count, then the cached headroom");
        sqlx::query("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1100) INSERT INTO pings(username, kind, scope, message_id, actor, created_at) SELECT 'dave', 'mention', 'c1', $1, 'other', 1 FROM n")
            .bind(mid)
            .execute(db)
            .await
            .expect("pings from another process");
        insert_pings(db, &spec, &["dave".to_string()])
            .await
            .expect("insert");
        let unseen: i64 =
            sqlx::query("SELECT COUNT(*) FROM pings WHERE username = 'dave' AND seen = 0")
                .fetch_one(db)
                .await
                .expect("count")
                .try_get(0)
                .expect("n");
        assert_eq!(
            unseen, PINGS_MAX,
            "one trim removes everything past the cap"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_flooding_actor_is_paced_and_trims_only_its_own_pings() {
        let (state, path) = temp_state("ping_pace").await;
        let db = &state.db;
        let cid: i64 = sqlx::query("SELECT id FROM channels WHERE server = 'rchat'")
            .fetch_one(db)
            .await
            .expect("general")
            .try_get(0)
            .expect("id");
        let mid: i64 = sqlx::query("INSERT INTO messages(channel_id, author, content, created_at) VALUES($1, 'spam', 'hi @bob', 1) RETURNING id")
            .bind(cid)
            .fetch_one(db)
            .await
            .expect("message")
            .try_get(0)
            .expect("id");
        let message =
            crate::api::messages::load_message(db, mid, crate::api::messages::Quotes::Skip)
                .await
                .expect("load")
                .expect("message");
        let spec_of = |actor: &'static User| PingSpec {
            kind: PingKind::Mention,
            scope: format!("c{cid}"),
            server: Some("rchat".to_string()),
            message: &message,
            actor,
            emoji: None,
        };
        let friend: &'static User = Box::leak(Box::new(mem_user("friend", false)));
        let spam: &'static User = Box::leak(Box::new(mem_user("spam", false)));
        insert_pings(db, &spec_of(friend), &["bob".to_string()])
            .await
            .expect("friend");
        for _ in 0..PINGS_MAX + 3 {
            insert_pings(db, &spec_of(spam), &["bob".to_string()])
                .await
                .expect("spam");
        }
        let count = |sql: &'static str| async move {
            sqlx::query(sql)
                .fetch_one(db)
                .await
                .expect(sql)
                .try_get::<i64, _>(0)
                .expect("n")
        };
        assert_eq!(
            count("SELECT COUNT(*) FROM pings WHERE username = 'bob' AND seen = 0").await,
            PINGS_MAX
        );
        assert_eq!(
            count("SELECT COUNT(*) FROM pings WHERE username = 'bob' AND actor = 'friend'").await,
            1,
            "the flood pushed out only its own pings"
        );
        let mut paced = 0;
        for _ in 0..PAIR_MAX + 5 {
            paced += create_pings(&state, &spec_of(spam), &["carol".to_string()])
                .await
                .expect("create")
                .len();
        }
        assert_eq!(paced, PAIR_MAX as usize, "one recipient per minute");
        let others: Vec<String> = (0..ACTOR_MAX).map(|n| format!("u{n}")).collect();
        let reached = create_pings(&state, &spec_of(spam), &others)
            .await
            .expect("create")
            .len();
        assert_eq!(
            reached,
            (ACTOR_MAX - PAIR_MAX) as usize,
            "everyone per minute"
        );
        done(state, path).await;
    }
}
