use std::collections::{BTreeMap, HashMap, HashSet};

use axum::Json;
use axum::extract::{Query, State};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use utoipa::{IntoParams, ToSchema};

use crate::api::access::{member_channel_rights, not_found};
use crate::api::pings::{GROUP_PINGS_MAX, GroupKind, announce_counts, excerpt};
use crate::api::{
    ApiError, ApiErrorBody, Authed, OkResp, UserRef, bad, cursor_int, decode_cursor, encode_cursor,
    ok, user_from, user_refs,
};
use crate::db::{ChannelAccess, Db, LIVE_AUTHOR, User};
use crate::state::AppState;
use crate::ws::WsEvent;

/// Default and largest inbox page.
pub const INBOX_PAGE: i64 = 50;
/// Servers per group mention query: one bounded subquery each, joined with `UNION ALL`.
const SERVERS_PER_QUERY: usize = 50;

/// Where an inbox item comes from. Items of different sources are ordered by time; ids are
/// only unique within a source.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, ToSchema,
)]
#[serde(rename_all = "lowercase")]
pub enum InboxSource {
    /// A mention, reply or reaction ping; `id` is the ping id.
    Ping,
    /// An `@everyone`, `@here` or role mention; `id` is the message id.
    Group,
    /// A friend request or an accepted request; `id` is the friend ping id.
    Friend,
}

impl InboxSource {
    fn rank(self) -> i64 {
        match self {
            InboxSource::Ping => 0,
            InboxSource::Group => 1,
            InboxSource::Friend => 2,
        }
    }

    fn of_rank(rank: i64) -> Option<InboxSource> {
        match rank {
            0 => Some(InboxSource::Ping),
            1 => Some(InboxSource::Group),
            2 => Some(InboxSource::Friend),
            _ => None,
        }
    }
}

/// What an inbox item is about.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum InboxKind {
    /// `@username` in a message.
    Mention,
    /// A reply to your message.
    Reply,
    /// A reaction to your message (`emoji`).
    Reaction,
    /// `@everyone`.
    Everyone,
    /// `@here`.
    Here,
    /// A mention of one of your roles (`role`).
    Role,
    /// A friend request from `actor`.
    FriendRequest,
    /// `actor` accepted your friend request.
    FriendAccept,
}

impl InboxKind {
    fn of_ping(kind: &str) -> Option<InboxKind> {
        match kind {
            "mention" => Some(InboxKind::Mention),
            "reply" => Some(InboxKind::Reply),
            "reaction" => Some(InboxKind::Reaction),
            "friend_request" => Some(InboxKind::FriendRequest),
            "friend_accept" => Some(InboxKind::FriendAccept),
            _ => None,
        }
    }
}

/// One notification in the inbox.
#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct InboxItem {
    /// Where it comes from.
    pub source: InboxSource,
    /// Ping id, message id (`group`) or friend ping id; unique within `source`.
    pub id: i64,
    /// What it is about.
    pub kind: InboxKind,
    /// Not seen yet: an unseen ping, or a group mention newer than your read position in the
    /// channel that you did not mark seen.
    pub unread: bool,
    /// When it happened, Unix seconds.
    pub created_at: i64,
    /// Who caused it: the author of the message, the user who reacted, or the friend.
    pub actor: UserRef,
    /// The emoji of a `reaction`.
    pub emoji: Option<String>,
    /// The role name of a `role` mention (the first of your roles it names).
    pub role: Option<String>,
    /// For a group mention, every way it addresses you (`everyone`, `here`, `role`).
    #[serde(default)]
    pub group_kinds: Vec<GroupKind>,
    /// `c<channel id>` or `d<dm id>`; `null` for friend items.
    pub scope: Option<String>,
    /// Server of a channel item.
    pub server: Option<String>,
    /// Display name of that server.
    pub server_name: Option<String>,
    /// Channel name of a channel item.
    pub channel_name: Option<String>,
    /// The message (for reactions, your message that was reacted to).
    pub message_id: Option<i64>,
    /// Thread root when the message is a thread reply.
    pub thread_root_id: Option<i64>,
    /// The start of the message text as written (at most 200 characters, a spoiler cut open
    /// is closed again); clients mask markdown and spoilers. `null` for friend items.
    pub content: Option<String>,
    /// File name of the message's attachment, if it has one.
    pub media_filename: Option<String>,
    /// The attachment is marked as a spoiler.
    #[serde(default)]
    pub media_spoiler: bool,
}

/// The newest id of each source when the page was read; send it back to mark all read, so
/// newer notifications stay unread.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct InboxUntil {
    /// Highest ping id.
    pub pings: i64,
    /// Highest message id (group mentions).
    pub groups: i64,
    /// Highest friend ping id.
    pub friends: i64,
}

/// A page of the inbox.
#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct InboxPage {
    /// Newest first.
    pub items: Vec<InboxItem>,
    /// Cursor for the next page; `null` on the last page.
    pub next: Option<String>,
    /// Bounds for `POST /api/inbox/read_all`, read with the first page (no `cursor`); `null`
    /// on later pages.
    pub until: Option<InboxUntil>,
}

/// Which kinds to list.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum InboxFilter {
    /// Mentions, `@everyone`, `@here` and role mentions.
    Mentions,
    /// Replies to your messages.
    Replies,
    /// Reactions to your messages.
    Reactions,
    /// Friend requests and accepted requests.
    Friends,
}

/// Inbox filters and paging.
#[derive(Deserialize, IntoParams)]
pub struct InboxQuery {
    /// `true`: only unread items. Default `false`.
    unread: Option<bool>,
    /// Only this kind.
    kind: Option<InboxFilter>,
    /// Only items in channels of this server (case-insensitive name).
    server: Option<String>,
    /// `true`: only direct-message items. Cannot be combined with `server`.
    dms: Option<bool>,
    /// Opaque cursor from `next` of the previous page.
    cursor: Option<String>,
    /// Page size, 1 to 50 (clamped), default 50.
    limit: Option<i64>,
}

/// One inbox item.
#[derive(Clone, Copy, Debug, Deserialize, ToSchema)]
pub struct InboxRef {
    /// Its source.
    pub source: InboxSource,
    /// Its id within the source.
    pub id: i64,
}

/// Mark every unread item up to `until` read, optionally only those a filter lists.
#[derive(Clone, Debug, Deserialize, ToSchema)]
pub struct InboxReadAll {
    /// From `InboxPage.until`.
    pub until: InboxUntil,
    /// Only this kind.
    #[serde(default)]
    pub kind: Option<InboxFilter>,
    /// Only items in channels of this server.
    #[serde(default)]
    pub server: Option<String>,
    /// Only direct-message items.
    #[serde(default)]
    pub dms: Option<bool>,
}

#[derive(Clone, Debug, Default)]
struct Filter {
    unread: bool,
    kind: Option<InboxFilter>,
    server: Option<String>,
    dms: bool,
}

impl Filter {
    fn new(
        unread: bool,
        kind: Option<InboxFilter>,
        server: Option<String>,
        dms: bool,
    ) -> Result<Filter, ApiError> {
        let server = server
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty());
        if server.is_some() && dms {
            return Err(bad("Choose a server or DMs, not both"));
        }
        if server.as_deref().is_some_and(|s| s.contains('\0')) {
            return Err(bad("Invalid server"));
        }
        Ok(Filter {
            unread,
            kind,
            server,
            dms,
        })
    }

    fn wants(&self, source: InboxSource) -> bool {
        match source {
            InboxSource::Ping => self.kind != Some(InboxFilter::Friends),
            InboxSource::Group => {
                matches!(self.kind, None | Some(InboxFilter::Mentions)) && !self.dms
            }
            InboxSource::Friend => {
                matches!(self.kind, None | Some(InboxFilter::Friends))
                    && self.server.is_none()
                    && !self.dms
            }
        }
    }

    fn ping_kind(&self) -> Option<&'static str> {
        match self.kind {
            Some(InboxFilter::Mentions) => Some("mention"),
            Some(InboxFilter::Replies) => Some("reply"),
            Some(InboxFilter::Reactions) => Some("reaction"),
            Some(InboxFilter::Friends) | None => None,
        }
    }
}

/// Channels of the reader's servers that the read-time gate needs: the ones they can not view,
/// and the ones they view without read history (messages before their join stay hidden).
struct Gate {
    hidden: Vec<i64>,
    no_history: Vec<i64>,
}

impl Gate {
    async fn load(db: &Db, user: &User) -> Result<Gate, ApiError> {
        let rights = member_channel_rights(db, user).await?;
        let mut hidden = Vec::new();
        let mut no_history = Vec::new();
        for (id, access) in rights {
            let ChannelAccess {
                view,
                send: _,
                history,
            } = access;
            match (view, history) {
                (false, _) => hidden.push(id),
                (true, false) => no_history.push(id),
                (true, true) => {}
            }
        }
        hidden.sort_unstable();
        no_history.sort_unstable();
        Ok(Gate { hidden, no_history })
    }

    fn not_in(column: &str, ids: &[i64]) -> String {
        match ids {
            [] => String::new(),
            ids => format!(" AND {column} NOT IN ({})", join_ids(ids)),
        }
    }
}

fn join_ids(ids: &[i64]) -> String {
    ids.iter()
        .map(i64::to_string)
        .collect::<Vec<_>>()
        .join(", ")
}

#[derive(Clone)]
enum Bind {
    S(String),
    I(i64),
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

/// Position in the merged order: newest first, then by source, then by id.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Key {
    created_at: i64,
    rank: i64,
    id: i64,
}

impl Key {
    fn of(item: &InboxItem) -> Key {
        Key {
            created_at: item.created_at,
            rank: item.source.rank(),
            id: item.id,
        }
    }

    fn encode(self) -> String {
        encode_cursor(&[
            &self.created_at.to_string(),
            &self.rank.to_string(),
            &self.id.to_string(),
        ])
    }

    fn decode(raw: &str) -> Result<Key, ApiError> {
        let parts = decode_cursor(raw, 3)?;
        let key = Key {
            created_at: cursor_int(&parts[0])?,
            rank: cursor_int(&parts[1])?,
            id: cursor_int(&parts[2])?,
        };
        match InboxSource::of_rank(key.rank) {
            Some(_) => Ok(key),
            None => Err(bad("Invalid cursor")),
        }
    }

    /// The keyset condition for items of `source` that come after this key.
    fn after(self, source: InboxSource, at: &str, id: &str, binds: &mut Vec<Bind>) -> String {
        binds.push(Bind::I(self.created_at));
        let t = binds.len();
        match source.rank().cmp(&self.rank) {
            std::cmp::Ordering::Less => format!(" AND {at} <= ${t}"),
            std::cmp::Ordering::Greater => format!(" AND {at} < ${t}"),
            std::cmp::Ordering::Equal => {
                binds.push(Bind::I(self.id));
                format!(
                    " AND {at} <= ${t} AND ({at} < ${t} OR {id} < ${})",
                    binds.len()
                )
            }
        }
    }
}

/// Blocks hide everything `col` (a username column) caused for the reader (`$1`).
fn not_blocked(col: &str) -> String {
    format!(" AND NOT EXISTS(SELECT 1 FROM blocks b WHERE b.blocker = $1 AND b.blocked = {col})")
}

fn live(col: &str) -> String {
    format!(
        " AND NOT EXISTS(SELECT 1 FROM users pa WHERE pa.username = {col} AND pa.password_hash = '!purging')"
    )
}

/// Personal pings (`pings`) of the reader that pass the read-time gate: the message still
/// exists and its author's account is live, neither the actor nor the author is blocked, and
/// for a channel the reader is still a member, can view it and (without read history) the
/// message and its thread root were sent after they joined; for a DM they are a participant
/// and both accounts are live.
fn ping_sql(gate: &Gate, filter: &Filter, extra: &str, binds: &mut Vec<Bind>) -> String {
    let history = match gate.no_history.as_slice() {
        [] => String::new(),
        ids => format!(
            " AND (m.channel_id NOT IN ({}) OR (m.created_at >= mem.joined_at AND COALESCE(rt.created_at, m.created_at) >= mem.joined_at))",
            join_ids(ids)
        ),
    };
    let hidden = Gate::not_in("m.channel_id", &gate.hidden);
    let mut conds = String::new();
    if filter.unread {
        conds.push_str(" AND p.seen = 0");
    }
    if let Some(kind) = filter.ping_kind() {
        binds.push(Bind::S(kind.to_string()));
        conds.push_str(&format!(" AND p.kind = ${}", binds.len()));
    }
    if let Some(server) = &filter.server {
        binds.push(Bind::S(server.clone()));
        conds.push_str(&format!(" AND c.server = ${}", binds.len()));
    }
    if filter.dms {
        conds.push_str(" AND m.dm_id IS NOT NULL");
    }
    format!(
        "SELECT p.id, p.kind, p.created_at, p.seen, p.actor, p.emoji, m.id, m.thread_root_id, m.content, m.media_filename, m.media_spoiler, m.channel_id, m.dm_id, c.server, c.name, s.display_name FROM pings p JOIN messages m ON m.id = p.message_id LEFT JOIN messages rt ON rt.id = m.thread_root_id LEFT JOIN channels c ON c.id = m.channel_id LEFT JOIN servers s ON s.name = c.server LEFT JOIN members mem ON mem.server = c.server AND mem.username = $1 WHERE p.username = $1 AND p.seen IN (0, 1) AND {LIVE_AUTHOR}{actor_live}{actor_blocked}{author_blocked} AND ((m.channel_id IS NOT NULL AND c.kind = 'text' AND mem.username IS NOT NULL{hidden}{history}) OR (m.dm_id IS NOT NULL AND EXISTS(SELECT 1 FROM dms d WHERE d.id = m.dm_id AND (d.user_a = $1 OR d.user_b = $1) AND NOT EXISTS(SELECT 1 FROM users pu WHERE pu.username IN (d.user_a, d.user_b) AND pu.password_hash = '!purging')))){conds}{extra}",
        actor_live = live("p.actor"),
        actor_blocked = not_blocked("p.actor"),
        author_blocked = not_blocked("m.author"),
    )
}

/// Whether the group mention row `g` addresses the reader (`$1`) now: `@everyone`, `@here` when
/// they were among the stored online viewers, or a role they hold.
fn addressed(g: &str) -> String {
    format!(
        "({g}.kind = 'everyone' OR ({g}.kind = 'here' AND EXISTS(SELECT 1 FROM here_pings h WHERE h.username = $1 AND h.ping_id = {g}.id)) OR ({g}.kind = 'role' AND EXISTS(SELECT 1 FROM user_roles ur WHERE ur.server = {g}.server AND ur.username = $1 AND ur.role_id = {g}.role_id)))"
    )
}

/// A group mention is unread while it is newer than the reader's read position in the channel
/// and they did not mark it read in the inbox.
const GROUP_UNREAD: &str = "g.message_id > COALESCE((SELECT rs.last_read FROM read_state rs WHERE rs.username = $1 AND rs.scope = 'c' || g.channel_id), 0) AND NOT EXISTS(SELECT 1 FROM group_pings_read gr WHERE gr.username = $1 AND gr.message_id = g.message_id)";

/// Group mentions of the reader (`$1`) where `place` holds, one row per message (its first
/// row that addresses them), under the same rules as the unread counts
/// (`pings::group_unseen`): `place` makes them a member who joined before it was sent; a
/// channel they can view, not their own, author not blocked, addressing them now. Messages
/// that also pinged them personally are listed through that ping instead.
fn group_sql(gate: &Gate, filter: &Filter, place: &str) -> String {
    let hidden = Gate::not_in("g.channel_id", &gate.hidden);
    let unread = match filter.unread {
        true => format!(" AND {GROUP_UNREAD}"),
        false => String::new(),
    };
    format!(
        "SELECT g.message_id AS message_id, g.created_at AS created_at, CAST(CASE WHEN {GROUP_UNREAD} THEN 1 ELSE 0 END AS BIGINT) AS unread, g.channel_id AS channel_id, g.server AS server, g.actor AS actor FROM group_pings g JOIN channels c ON c.id = g.channel_id JOIN messages m ON m.id = g.message_id WHERE {place} AND c.kind = 'text' AND g.actor <> $1 AND {LIVE_AUTHOR}{blocked} AND {mine} AND NOT EXISTS(SELECT 1 FROM group_pings g2 WHERE g2.message_id = g.message_id AND g2.id < g.id AND {earlier}) AND NOT EXISTS(SELECT 1 FROM pings p WHERE p.message_id = g.message_id AND p.username = $1 AND p.kind <> 'reaction' AND p.seen IN (0, 1)){hidden}{unread}",
        blocked = not_blocked("g.actor"),
        mine = addressed("g"),
        earlier = addressed("g2"),
    )
}

/// Friend pings whose actor is live and not blocked.
fn friend_sql(filter: &Filter, extra: &str) -> String {
    let unread = match filter.unread {
        true => " AND f.seen = 0",
        false => "",
    };
    format!(
        "SELECT f.id, f.kind, f.created_at, f.seen, f.actor FROM friend_pings f WHERE f.username = $1{live}{blocked}{unread}{extra}",
        live = live("f.actor"),
        blocked = not_blocked("f.actor"),
    )
}

struct GroupRow {
    message_id: i64,
    created_at: i64,
    unread: bool,
    channel_id: i64,
    server: String,
    actor: String,
}

fn group_rows(rows: &[sqlx::any::AnyRow]) -> sqlx::Result<Vec<GroupRow>> {
    rows.iter()
        .map(|r| {
            Ok(GroupRow {
                message_id: r.try_get(0)?,
                created_at: r.try_get(1)?,
                unread: r.try_get::<i64, _>(2)? != 0,
                channel_id: r.try_get(3)?,
                server: r.try_get(4)?,
                actor: r.try_get(5)?,
            })
        })
        .collect()
}

async fn ping_items(
    db: &Db,
    user: &User,
    gate: &Gate,
    filter: &Filter,
    after: Option<Key>,
    only: Option<i64>,
    limit: i64,
) -> Result<Vec<InboxItem>, ApiError> {
    let mut binds = vec![Bind::S(user.username.clone())];
    let mut extra = String::new();
    let sql = {
        let base = ping_sql(gate, filter, "", &mut binds);
        if let Some(key) = after {
            extra.push_str(&key.after(InboxSource::Ping, "p.created_at", "p.id", &mut binds));
        }
        if let Some(id) = only {
            binds.push(Bind::I(id));
            extra.push_str(&format!(" AND p.id = ${}", binds.len()));
        }
        binds.push(Bind::I(limit));
        format!(
            "{base}{extra} ORDER BY p.created_at DESC, p.id DESC LIMIT ${}",
            binds.len()
        )
    };
    let rows = bind_all(sqlx::query(sqlx::AssertSqlSafe(sql)), &binds)
        .fetch_all(db)
        .await?;
    let actors: Vec<String> = rows
        .iter()
        .map(|r| r.try_get::<String, _>(4))
        .collect::<sqlx::Result<_>>()?;
    let refs = user_refs(db, &actors).await;
    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        let kind: String = r.try_get(1)?;
        let Some(kind) = InboxKind::of_ping(&kind) else {
            continue;
        };
        let actor: String = r.try_get(4)?;
        let content: String = r.try_get(8)?;
        let (channel_id, dm_id): (Option<i64>, Option<i64>) = (r.try_get(11)?, r.try_get(12)?);
        let scope = match (channel_id, dm_id) {
            (Some(c), _) => format!("c{c}"),
            (None, Some(d)) => format!("d{d}"),
            (None, None) => continue,
        };
        out.push(InboxItem {
            source: InboxSource::Ping,
            id: r.try_get(0)?,
            kind,
            unread: r.try_get::<i64, _>(3)? == 0,
            created_at: r.try_get(2)?,
            actor: user_from(&refs, &actor),
            emoji: r.try_get(5)?,
            role: None,
            group_kinds: Vec::new(),
            scope: Some(scope),
            server: r.try_get(13)?,
            server_name: r.try_get(15)?,
            channel_name: r.try_get(14)?,
            message_id: Some(r.try_get(6)?),
            thread_root_id: r.try_get(7)?,
            content: Some(excerpt(&content)),
            media_filename: r.try_get(9)?,
            media_spoiler: r.try_get::<i64, _>(10)? != 0,
        });
    }
    Ok(out)
}

/// The newest `limit` group mention rows after `after` (and with a message id up to `up_to`),
/// newest first. Each joined server (or only `filter.server`) is read separately through
/// `idx_group_pings_server_time`, newest first and stopping after `limit` rows, and the
/// results are merged here, so a page never reads more than `limit` rows per server plus the
/// rows it skips.
async fn group_page(
    db: &Db,
    user: &User,
    gate: &Gate,
    filter: &Filter,
    after: Option<Key>,
    up_to: Option<i64>,
    limit: i64,
) -> Result<Vec<GroupRow>, ApiError> {
    let mut joined = sqlx::query("SELECT server, joined_at FROM members WHERE username = $1")
        .bind(&user.username)
        .fetch_all(db)
        .await?
        .iter()
        .map(|r| Ok((r.try_get::<String, _>(0)?, r.try_get::<i64, _>(1)?)))
        .collect::<sqlx::Result<Vec<(String, i64)>>>()?;
    if let Some(server) = &filter.server {
        joined.retain(|(name, _)| name == server);
    }
    let mut out = Vec::new();
    for chunk in joined.chunks(SERVERS_PER_QUERY) {
        let mut binds = vec![Bind::S(user.username.clone())];
        let mut parts = Vec::with_capacity(chunk.len());
        for (i, (server, joined_at)) in chunk.iter().enumerate() {
            binds.push(Bind::S(server.clone()));
            binds.push(Bind::I(*joined_at));
            let mut place = format!(
                "g.server = ${} AND g.created_at >= ${}",
                binds.len() - 1,
                binds.len()
            );
            if let Some(key) = after {
                place.push_str(&key.after(
                    InboxSource::Group,
                    "g.created_at",
                    "g.message_id",
                    &mut binds,
                ));
            }
            if let Some(max) = up_to {
                binds.push(Bind::I(max));
                place.push_str(&format!(" AND g.message_id <= ${}", binds.len()));
            }
            binds.push(Bind::I(limit));
            parts.push(format!(
                "SELECT * FROM ({} ORDER BY g.created_at DESC, g.message_id DESC LIMIT ${}) AS q{i}",
                group_sql(gate, filter, &place),
                binds.len()
            ));
        }
        let sql = parts.join(" UNION ALL ");
        let rows = bind_all(sqlx::query(sqlx::AssertSqlSafe(sql)), &binds)
            .fetch_all(db)
            .await?;
        out.extend(group_rows(&rows)?);
    }
    out.sort_by_key(|r| std::cmp::Reverse((r.created_at, r.message_id)));
    out.truncate(limit.max(0) as usize);
    Ok(out)
}

/// The group mention row of message `id` if the inbox lists it.
async fn group_one(
    db: &Db,
    user: &User,
    gate: &Gate,
    id: i64,
) -> Result<Option<GroupRow>, ApiError> {
    let place = "g.message_id = $2 AND g.created_at >= (SELECT mem.joined_at FROM members mem WHERE mem.server = g.server AND mem.username = $1)";
    let sql = format!("{} LIMIT 1", group_sql(gate, &Filter::default(), place));
    let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(&user.username)
        .bind(id)
        .fetch_all(db)
        .await?;
    Ok(group_rows(&rows)?.pop())
}

async fn group_items(
    db: &Db,
    user: &User,
    rows: Vec<GroupRow>,
) -> Result<Vec<InboxItem>, ApiError> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<i64> = rows.iter().map(|r| r.message_id).collect();
    let list = join_ids(&ids);
    let kinds_sql = format!(
        "SELECT g.message_id, g.kind, r.name, r.id FROM group_pings g LEFT JOIN roles r ON r.id = g.role_id WHERE g.message_id IN ({list}) AND {mine} ORDER BY g.message_id, r.id",
        mine = addressed("g"),
    );
    let mut kinds: HashMap<i64, (Vec<GroupKind>, Option<String>)> = HashMap::new();
    for r in sqlx::query(sqlx::AssertSqlSafe(kinds_sql))
        .bind(&user.username)
        .fetch_all(db)
        .await?
    {
        let (mid, kind, role): (i64, String, Option<String>) =
            (r.try_get(0)?, r.try_get(1)?, r.try_get(2)?);
        let entry = kinds.entry(mid).or_default();
        let kind = match kind.as_str() {
            "everyone" => GroupKind::Everyone,
            "here" => GroupKind::Here,
            "role" => GroupKind::Role,
            _ => continue,
        };
        if !entry.0.contains(&kind) {
            entry.0.push(kind);
        }
        if entry.1.is_none() && kind == GroupKind::Role {
            entry.1 = role;
        }
    }
    let msg_sql = format!(
        "SELECT m.id, m.content, m.media_filename, m.media_spoiler, c.name, s.display_name FROM messages m JOIN channels c ON c.id = m.channel_id JOIN servers s ON s.name = c.server WHERE m.id IN ({list})"
    );
    let mut messages: HashMap<i64, (String, Option<String>, bool, String, String)> = HashMap::new();
    for r in sqlx::query(sqlx::AssertSqlSafe(msg_sql))
        .fetch_all(db)
        .await?
    {
        messages.insert(
            r.try_get(0)?,
            (
                r.try_get(1)?,
                r.try_get(2)?,
                r.try_get::<i64, _>(3)? != 0,
                r.try_get(4)?,
                r.try_get(5)?,
            ),
        );
    }
    let actors: Vec<String> = rows.iter().map(|r| r.actor.clone()).collect();
    let refs = user_refs(db, &actors).await;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let (Some((mut found, role)), Some((content, media, spoiler, channel, server_name))) = (
            kinds.remove(&row.message_id),
            messages.remove(&row.message_id),
        ) else {
            continue;
        };
        found.sort();
        let kind = match found.first() {
            Some(GroupKind::Everyone) => InboxKind::Everyone,
            Some(GroupKind::Here) => InboxKind::Here,
            Some(GroupKind::Role) => InboxKind::Role,
            None => continue,
        };
        out.push(InboxItem {
            source: InboxSource::Group,
            id: row.message_id,
            kind,
            unread: row.unread,
            created_at: row.created_at,
            actor: user_from(&refs, &row.actor),
            emoji: None,
            role,
            group_kinds: found,
            scope: Some(format!("c{}", row.channel_id)),
            server: Some(row.server),
            server_name: Some(server_name),
            channel_name: Some(channel),
            message_id: Some(row.message_id),
            thread_root_id: None,
            content: Some(excerpt(&content)),
            media_filename: media,
            media_spoiler: spoiler,
        });
    }
    Ok(out)
}

async fn friend_items(
    db: &Db,
    user: &User,
    filter: &Filter,
    after: Option<Key>,
    only: Option<i64>,
    limit: i64,
) -> Result<Vec<InboxItem>, ApiError> {
    let mut binds = vec![Bind::S(user.username.clone())];
    let mut extra = String::new();
    if let Some(key) = after {
        extra.push_str(&key.after(InboxSource::Friend, "f.created_at", "f.id", &mut binds));
    }
    if let Some(id) = only {
        binds.push(Bind::I(id));
        extra.push_str(&format!(" AND f.id = ${}", binds.len()));
    }
    binds.push(Bind::I(limit));
    let sql = format!(
        "{} ORDER BY f.created_at DESC, f.id DESC LIMIT ${}",
        friend_sql(filter, &extra),
        binds.len()
    );
    let rows = bind_all(sqlx::query(sqlx::AssertSqlSafe(sql)), &binds)
        .fetch_all(db)
        .await?;
    let actors: Vec<String> = rows
        .iter()
        .map(|r| r.try_get::<String, _>(4))
        .collect::<sqlx::Result<_>>()?;
    let refs = user_refs(db, &actors).await;
    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        let kind: String = r.try_get(1)?;
        let Some(kind) = InboxKind::of_ping(&kind) else {
            continue;
        };
        let actor: String = r.try_get(4)?;
        out.push(InboxItem {
            source: InboxSource::Friend,
            id: r.try_get(0)?,
            kind,
            unread: r.try_get::<i64, _>(3)? == 0,
            created_at: r.try_get(2)?,
            actor: user_from(&refs, &actor),
            emoji: None,
            role: None,
            group_kinds: Vec::new(),
            scope: None,
            server: None,
            server_name: None,
            channel_name: None,
            message_id: None,
            thread_root_id: None,
            content: None,
            media_filename: None,
            media_spoiler: false,
        });
    }
    Ok(out)
}

/// The newest ids the reader could have now: their pings, group mentions in the servers they
/// are in, and their friend pings.
async fn until_now(db: &Db, user: &User) -> Result<InboxUntil, ApiError> {
    let max = |sql: &'static str| async move {
        Ok::<i64, ApiError>(
            sqlx::query(sql)
                .bind(&user.username)
                .fetch_one(db)
                .await?
                .try_get::<Option<i64>, _>(0)?
                .unwrap_or(0),
        )
    };
    Ok(InboxUntil {
        pings: max("SELECT MAX(id) FROM pings WHERE username = $1").await?,
        groups: max("SELECT MAX((SELECT MAX(g.message_id) FROM group_pings g WHERE g.channel_id = c.id)) FROM members mem JOIN channels c ON c.server = mem.server WHERE mem.username = $1").await?,
        friends: max("SELECT MAX(id) FROM friend_pings WHERE username = $1").await?,
    })
}

/// One merged page. Each source reads at most `limit + 1` rows after the cursor in the same
/// order, every check in SQL, so a dropped item never leaves a hole.
async fn inbox_page(
    db: &Db,
    user: &User,
    filter: &Filter,
    after: Option<Key>,
    limit: i64,
) -> Result<(Vec<InboxItem>, Option<String>), ApiError> {
    let gate = Gate::load(db, user).await?;
    let mut all = Vec::new();
    if filter.wants(InboxSource::Ping) {
        all.extend(ping_items(db, user, &gate, filter, after, None, limit + 1).await?);
    }
    if filter.wants(InboxSource::Group) {
        let rows = group_page(db, user, &gate, filter, after, None, limit + 1).await?;
        all.extend(group_items(db, user, rows).await?);
    }
    if filter.wants(InboxSource::Friend) {
        all.extend(friend_items(db, user, filter, after, None, limit + 1).await?);
    }
    all.sort_by_key(|i| std::cmp::Reverse(Key::of(i)));
    let more = all.len() as i64 > limit;
    all.truncate(limit as usize);
    let next = match (more, all.last()) {
        (true, Some(last)) => Some(Key::of(last).encode()),
        _ => None,
    };
    Ok((all, next))
}

/// List the inbox
///
/// The signed-in user's notifications of the last 30 days, newest first, in pages of up to 50:
/// mention, reply and reaction pings, `@everyone`, `@here` and role mentions (worked out when
/// read, like the unread counts), and friend requests and accepted requests. Every item is
/// checked when it is read: the server membership is current, the channel can still be viewed,
/// messages from before the user joined are left out where they have no read history, the
/// message still exists, and nothing from a user they blocked is listed. Items that fail are
/// left out without a gap. `unread=true` lists only unread items; `kind`, `server` and `dms`
/// narrow the list. The text is the raw start of the message. Requires a bearer token. General
/// rate-limit bucket.
#[utoipa::path(get, path = "/api/inbox", tag = "Inbox", params(InboxQuery), responses((status = 200, description = "A page of the inbox, with the cursor for the next page and the bounds for marking all read", body = InboxPage), (status = 400, description = "Invalid cursor, `server` combined with `dms` (`Choose a server or DMs, not both`), or an unknown `kind` or a non-integer `limit` (plain-text framework error)", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn list_inbox(
    State(state): State<AppState>,
    Authed(user): Authed,
    Query(q): Query<InboxQuery>,
) -> Result<Json<InboxPage>, ApiError> {
    let InboxQuery {
        unread,
        kind,
        server,
        dms,
        cursor,
        limit,
    } = q;
    let filter = Filter::new(unread.unwrap_or(false), kind, server, dms.unwrap_or(false))?;
    let after = match cursor.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        Some(raw) => Some(Key::decode(raw)?),
        None => None,
    };
    let limit = limit.unwrap_or(INBOX_PAGE).clamp(1, INBOX_PAGE);
    let db = state.read();
    let until = match after {
        Some(_) => None,
        None => Some(until_now(&db, &user).await?),
    };
    let (items, next) = inbox_page(&db, &user, &filter, after, limit).await?;
    Ok(Json(InboxPage { items, next, until }))
}

/// Marks these group mentions read for the reader (`group_pings_read`) and tells their
/// connections about the ones that were not marked yet.
async fn mark_groups(state: &AppState, user: &User, rows: &[GroupRow]) -> Result<(), ApiError> {
    let fresh: Vec<&GroupRow> = rows.iter().filter(|r| r.unread).collect();
    if fresh.is_empty() {
        return Ok(());
    }
    let mut marked: HashSet<i64> = HashSet::new();
    let mut tx = state.db.begin().await?;
    for chunk in fresh.chunks(100) {
        let mut values = Vec::with_capacity(chunk.len());
        let mut binds: Vec<Bind> = vec![Bind::S(user.username.clone())];
        for row in chunk {
            binds.push(Bind::I(row.message_id));
            binds.push(Bind::I(row.created_at));
            values.push(format!("($1, ${}, ${})", binds.len() - 1, binds.len()));
        }
        let sql = format!(
            "INSERT INTO group_pings_read(username, message_id, created_at) VALUES {} ON CONFLICT DO NOTHING RETURNING message_id",
            values.join(", ")
        );
        for r in bind_all(sqlx::query(sqlx::AssertSqlSafe(sql)), &binds)
            .fetch_all(&mut *tx)
            .await?
        {
            marked.insert(r.try_get(0)?);
        }
    }
    tx.commit().await?;
    let mut by_scope: BTreeMap<String, Vec<i64>> = BTreeMap::new();
    for row in fresh.into_iter().filter(|r| marked.contains(&r.message_id)) {
        by_scope
            .entry(format!("c{}", row.channel_id))
            .or_default()
            .push(row.message_id);
    }
    for (scope, message_ids) in by_scope {
        state.hub.broadcast(WsEvent::GroupPingsSeen {
            username: user.username.clone(),
            scope,
            message_ids,
        });
    }
    Ok(())
}

/// Mark one inbox item read
///
/// Marks one item of the signed-in user's inbox seen: a ping (its scope's read position does
/// not move), a group mention (the channel's read position does not move; it no longer counts
/// as unread) or a friend ping. The item must be one that `GET /api/inbox` would list now.
/// Items that are already read stay read. Emits `ping_count` for the ping's scope (or the
/// `friends` scope) or `group_pings_seen`, to the user's connections only, when something
/// changed. Requires a bearer token. General rate-limit bucket.
#[utoipa::path(post, path = "/api/inbox/read", tag = "Inbox", request_body = InboxRef, responses((status = 200, description = "Read; body `{\"ok\": true}`", body = OkResp), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 404, description = "`Not found`: no such item in your inbox (it does not exist, is not yours, or is no longer shown); identical responses", body = ApiErrorBody), (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn read_item(
    State(state): State<AppState>,
    Authed(user): Authed,
    Json(req): Json<InboxRef>,
) -> Result<Json<OkResp>, ApiError> {
    let InboxRef { source, id } = req;
    let db = &state.db;
    let filter = Filter::default();
    match source {
        InboxSource::Ping => {
            let gate = Gate::load(db, &user).await?;
            let item = ping_items(db, &user, &gate, &filter, None, Some(id), 1)
                .await?
                .pop()
                .ok_or_else(not_found)?;
            if !item.unread {
                return Ok(ok());
            }
            let changed = sqlx::query(
                "UPDATE pings SET seen = 1 WHERE id = $1 AND username = $2 AND seen = 0",
            )
            .bind(id)
            .bind(&user.username)
            .execute(db)
            .await?
            .rows_affected();
            if let (true, Some(scope)) = (changed > 0, item.scope) {
                announce_counts(&state, vec![(user.username.clone(), scope)]).await;
            }
        }
        InboxSource::Group => {
            let gate = Gate::load(db, &user).await?;
            let row = group_one(db, &user, &gate, id)
                .await?
                .ok_or_else(not_found)?;
            mark_groups(&state, &user, &[row]).await?;
        }
        InboxSource::Friend => {
            let item = friend_items(db, &user, &filter, None, Some(id), 1)
                .await?
                .pop()
                .ok_or_else(not_found)?;
            if !item.unread {
                return Ok(ok());
            }
            let changed = sqlx::query(
                "UPDATE friend_pings SET seen = 1 WHERE id = $1 AND username = $2 AND seen = 0",
            )
            .bind(id)
            .bind(&user.username)
            .execute(db)
            .await?
            .rows_affected();
            if changed > 0 {
                crate::api::friends::announce_count(&state, &user.username).await?;
            }
        }
    }
    Ok(ok())
}

/// Mark the inbox read
///
/// Marks the signed-in user's unread inbox items up to `until` (from the page they were shown)
/// seen: pings with an id up to `until.pings`, group mentions of messages up to `until.groups`
/// and friend pings up to `until.friends`, so notifications that arrived later stay unread.
/// `kind`, `server` and `dms` limit it to what that filter lists. Pings in that filter that are
/// no longer listed (the channel can no longer be viewed, the actor is blocked) are marked too;
/// at most 1000 group mentions are marked per call, the newest first. Read positions do not move.
/// Emits `ping_count` for each scope that changed (and the `friends` scope) and
/// `group_pings_seen`, to the user's connections only. Requires a bearer token. General
/// rate-limit bucket.
#[utoipa::path(post, path = "/api/inbox/read_all", tag = "Inbox", request_body = InboxReadAll, responses((status = 200, description = "Read; body `{\"ok\": true}`", body = OkResp), (status = 400, description = "`server` combined with `dms` (`Choose a server or DMs, not both`)", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn read_all(
    State(state): State<AppState>,
    Authed(user): Authed,
    Json(req): Json<InboxReadAll>,
) -> Result<Json<OkResp>, ApiError> {
    let InboxReadAll {
        until,
        kind,
        server,
        dms,
    } = req;
    let InboxUntil {
        pings,
        groups,
        friends,
    } = until;
    let filter = Filter::new(true, kind, server, dms.unwrap_or(false))?;
    let db = &state.db;
    if filter.wants(InboxSource::Ping) && pings > 0 {
        let mut binds = vec![Bind::S(user.username.clone()), Bind::I(pings)];
        let mut conds = String::new();
        if let Some(kind) = filter.ping_kind() {
            binds.push(Bind::S(kind.to_string()));
            conds.push_str(&format!(" AND kind = ${}", binds.len()));
        }
        if let Some(server) = &filter.server {
            binds.push(Bind::S(server.clone()));
            conds.push_str(&format!(" AND server = ${}", binds.len()));
        }
        if filter.dms {
            conds.push_str(" AND server IS NULL");
        }
        let scopes_sql = format!(
            "SELECT DISTINCT scope FROM pings WHERE username = $1 AND seen = 0 AND id <= $2{conds}"
        );
        let scopes: Vec<String> = bind_all(sqlx::query(sqlx::AssertSqlSafe(scopes_sql)), &binds)
            .fetch_all(db)
            .await?
            .iter()
            .map(|r| r.try_get(0))
            .collect::<sqlx::Result<_>>()?;
        if !scopes.is_empty() {
            let sql = format!(
                "UPDATE pings SET seen = 1 WHERE username = $1 AND seen = 0 AND id <= $2{conds}"
            );
            bind_all(sqlx::query(sqlx::AssertSqlSafe(sql)), &binds)
                .execute(db)
                .await?;
            announce_counts(
                &state,
                scopes
                    .into_iter()
                    .map(|s| (user.username.clone(), s))
                    .collect(),
            )
            .await;
        }
    }
    if filter.wants(InboxSource::Group) && groups > 0 {
        let gate = Gate::load(db, &user).await?;
        let rows = group_page(
            db,
            &user,
            &gate,
            &filter,
            None,
            Some(groups),
            GROUP_PINGS_MAX,
        )
        .await?;
        mark_groups(&state, &user, &rows).await?;
    }
    if filter.wants(InboxSource::Friend) && friends > 0 {
        let changed = sqlx::query(
            "UPDATE friend_pings SET seen = 1 WHERE username = $1 AND seen = 0 AND id <= $2",
        )
        .bind(&user.username)
        .bind(friends)
        .execute(db)
        .await?
        .rows_affected();
        if changed > 0 {
            crate::api::friends::announce_count(&state, &user.username).await?;
        }
    }
    Ok(ok())
}

#[cfg(test)]
mod tests {
    use axum::extract::{Path, Query, State};
    use serde_json::json;

    use super::*;
    use crate::api::Message;
    use crate::api::test_util::{add_member, done, mem_user, temp_state};
    use crate::db::now;

    async fn exec(db: &Db, sql: &str) {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .execute(db)
            .await
            .expect(sql);
    }

    async fn one(db: &Db, sql: &str) -> i64 {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .fetch_one(db)
            .await
            .expect(sql)
            .try_get(0)
            .expect("value")
    }

    async fn add_user(db: &Db, name: &str) {
        sqlx::query("INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, created_at) VALUES($1, $2, '', 'text', 'identicon', 1)")
            .bind(name)
            .bind(name.to_uppercase())
            .execute(db)
            .await
            .expect("user");
    }

    fn me(name: &str) -> Authed {
        Authed(mem_user(name, false))
    }

    async fn say(state: &AppState, author: &str, to: &str, content: &str) -> Message {
        say_reply(state, author, to, content, None).await
    }

    async fn say_reply(
        state: &AppState,
        author: &str,
        to: &str,
        content: &str,
        reply_to: Option<i64>,
    ) -> Message {
        let req = serde_json::from_value(json!({ "content": content, "reply_to": reply_to }))
            .expect("send body");
        let id: i64 = to[1..].parse().expect("id");
        let sent = match &to[..1] {
            "c" => {
                crate::api::messages::send_channel_message(
                    State(state.clone()),
                    Path(id),
                    me(author),
                    Json(req),
                )
                .await
            }
            "d" => {
                crate::api::messages::send_dm_message(
                    State(state.clone()),
                    Path(id),
                    me(author),
                    Json(req),
                )
                .await
            }
            _ => {
                crate::api::messages::send_thread_message(
                    State(state.clone()),
                    Path(id),
                    me(author),
                    Json(req),
                )
                .await
            }
        };
        sent.expect("send").0
    }

    async fn page(
        state: &AppState,
        who: &str,
        query: serde_json::Value,
    ) -> Result<InboxPage, ApiError> {
        let q: InboxQuery = serde_json::from_value(query).expect("query");
        list_inbox(State(state.clone()), me(who), Query(q))
            .await
            .map(|Json(p)| p)
    }

    async fn all(state: &AppState, who: &str, query: serde_json::Value) -> Vec<InboxItem> {
        page(state, who, query).await.expect("inbox").items
    }

    fn keys(items: &[InboxItem]) -> Vec<(InboxSource, i64)> {
        items.iter().map(|i| (i.source, i.id)).collect()
    }

    async fn read(
        state: &AppState,
        who: &str,
        source: InboxSource,
        id: i64,
    ) -> Result<(), ApiError> {
        read_item(State(state.clone()), me(who), Json(InboxRef { source, id }))
            .await
            .map(|_| ())
    }

    async fn general(db: &Db) -> i64 {
        one(db, "SELECT id FROM channels WHERE server = 'rchat'").await
    }

    /// alice (the reader), bob and carol in `rchat`; boss is an admin there.
    async fn world(tag: &str) -> (AppState, std::path::PathBuf, i64) {
        let (state, path) = temp_state(tag).await;
        let db = &state.db;
        for name in ["alice", "bob", "carol", "boss"] {
            add_user(db, name).await;
        }
        add_member(db, "rchat", "boss", 1, 0, 1).await;
        for name in ["alice", "bob", "carol"] {
            add_member(db, "rchat", name, 0, 0, 1).await;
        }
        let cid = general(db).await;
        (state, path, cid)
    }

    #[tokio::test]
    async fn every_kind_is_listed_newest_first_and_pages_have_no_holes() {
        let (state, path, cid) = world("inbox_kinds").await;
        let db = &state.db;
        let c = format!("c{cid}");
        let crew = one(db, "INSERT INTO roles(server, name, color, perms, mentionable) VALUES('rchat', 'crew', '#336699', 0, 1) RETURNING id").await;
        exec(
            db,
            &format!(
                "INSERT INTO user_roles(server, username, role_id) VALUES('rchat', 'alice', {crew})"
            ),
        )
        .await;
        let mine = say(&state, "alice", &c, "my message").await;
        let mention = say(&state, "bob", &c, "hi @alice").await;
        let reply = say_reply(&state, "carol", &c, "answer", Some(mine.id)).await;
        let _ = crate::api::reactions::add_reaction(
            State(state.clone()),
            Path((mine.id, "👍".to_string())),
            me("bob"),
        )
        .await
        .expect("react");
        let everyone = say(&state, "boss", &c, "@everyone ||big|| news").await;
        let role = say(&state, "bob", &c, "@crew assemble").await;
        let both = say(&state, "boss", &c, "@everyone and @alice").await;
        let thread = say(&state, "bob", &format!("t{}", mine.id), "in thread @alice").await;
        let dm = crate::api::dms::open_dm(
            State(state.clone()),
            me("bob"),
            Json(serde_json::from_value(json!({"username": "alice"})).expect("dm")),
        )
        .await
        .expect("dm")
        .0
        .id;
        let in_dm = say(&state, "bob", &format!("d{dm}"), "psst @alice").await;
        let _ = crate::api::friends::send_request(
            State(state.clone()),
            me("carol"),
            Json(serde_json::from_value(json!({"username": "alice"})).expect("req")),
        )
        .await
        .expect("friend request");
        exec(db, "UPDATE friend_pings SET created_at = 1").await;

        let items = all(&state, "alice", json!({})).await;
        let kinds: Vec<(InboxKind, Option<i64>)> =
            items.iter().map(|i| (i.kind, i.message_id)).collect();
        assert!(kinds.contains(&(InboxKind::Mention, Some(mention.id))));
        assert!(kinds.contains(&(InboxKind::Reply, Some(reply.id))));
        assert!(kinds.contains(&(InboxKind::Reaction, Some(mine.id))));
        assert!(kinds.contains(&(InboxKind::Everyone, Some(everyone.id))));
        assert!(kinds.contains(&(InboxKind::Role, Some(role.id))));
        assert!(kinds.contains(&(InboxKind::Mention, Some(both.id))));
        assert!(kinds.contains(&(InboxKind::Mention, Some(thread.id))));
        assert!(kinds.contains(&(InboxKind::Mention, Some(in_dm.id))));
        assert_eq!(items.len(), 9, "one item per ping, the double mention once");
        assert_eq!(items.last().map(|i| i.kind), Some(InboxKind::FriendRequest));
        assert!(items.iter().all(|i| i.unread));
        let grouped = items
            .iter()
            .find(|i| i.id == role.id && i.source == InboxSource::Group)
            .expect("role");
        assert_eq!(grouped.role.as_deref(), Some("crew"));
        assert_eq!(grouped.source, InboxSource::Group);
        let news = items
            .iter()
            .find(|i| i.id == everyone.id && i.source == InboxSource::Group)
            .expect("everyone");
        assert_eq!(news.content.as_deref(), Some("@everyone ||big|| news"));
        assert_eq!(news.server_name.as_deref(), Some("RChat"));
        assert_eq!(news.channel_name.as_deref(), Some("general"));
        let threaded = items
            .iter()
            .find(|i| i.message_id == Some(thread.id))
            .expect("thread");
        assert_eq!(threaded.thread_root_id, Some(mine.id));
        let direct = items
            .iter()
            .find(|i| i.message_id == Some(in_dm.id))
            .expect("dm");
        assert_eq!(direct.scope, Some(format!("d{dm}")));
        assert_eq!(direct.server, None);
        let mut order: Vec<Key> = items.iter().map(Key::of).collect();
        order.sort_by_key(|k| std::cmp::Reverse(*k));
        assert_eq!(order, items.iter().map(Key::of).collect::<Vec<_>>());

        for size in 1..=4 {
            let mut paged = Vec::new();
            let mut cursor: Option<String> = None;
            loop {
                let p = page(&state, "alice", json!({"limit": size, "cursor": cursor}))
                    .await
                    .expect("page");
                assert!(p.items.len() as i64 <= size);
                if p.next.is_some() {
                    assert_eq!(p.items.len() as i64, size, "full pages");
                }
                paged.extend(p.items);
                match p.next {
                    Some(next) => cursor = Some(next),
                    None => break,
                }
            }
            assert_eq!(keys(&paged), keys(&items), "page size {size}");
        }

        let only = |q: serde_json::Value| {
            let state = state.clone();
            async move { keys(&all(&state, "alice", q).await) }
        };
        assert_eq!(
            only(json!({"kind": "replies"})).await,
            vec![(
                InboxSource::Ping,
                items
                    .iter()
                    .find(|i| i.kind == InboxKind::Reply)
                    .expect("r")
                    .id
            )]
        );
        assert_eq!(only(json!({"kind": "friends"})).await.len(), 1);
        assert_eq!(only(json!({"kind": "reactions"})).await.len(), 1);
        assert_eq!(only(json!({"kind": "mentions"})).await.len(), 6);
        assert_eq!(only(json!({"dms": true})).await.len(), 1);
        assert_eq!(only(json!({"server": "RCHAT"})).await.len(), 7);
        assert_eq!(only(json!({"server": "elsewhere"})).await.len(), 0);
        assert!(matches!(
            page(&state, "alice", json!({"server": "rchat", "dms": true})).await,
            Err(ApiError(axum::http::StatusCode::BAD_REQUEST, _))
        ));
        assert!(matches!(
            page(&state, "alice", json!({"cursor": "zz"})).await,
            Err(ApiError(axum::http::StatusCode::BAD_REQUEST, _))
        ));
        assert!(
            all(&state, "bob", json!({}))
                .await
                .iter()
                .all(|i| i.message_id != Some(mention.id)),
            "only your own"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn items_are_checked_again_when_read() {
        let (state, path, cid) = world("inbox_gate").await;
        let db = &state.db;
        let c = format!("c{cid}");
        let secret = one(db, "INSERT INTO channels(server, name, kind, created_at) VALUES('rchat', 'secret', 'text', 0) RETURNING id").await;
        let s = format!("c{secret}");
        let early = say(&state, "bob", &c, "@alice first").await;
        let hidden = say(&state, "bob", &s, "@alice secret").await;
        let shout = say(&state, "boss", &s, "@everyone secret").await;
        let blocked = say(&state, "carol", &c, "@alice from carol").await;
        let gone = say(&state, "bob", &c, "@alice soon gone").await;
        let late = say(&state, "bob", &c, "@alice last").await;
        let _ = crate::api::friends::send_request(
            State(state.clone()),
            me("carol"),
            Json(serde_json::from_value(json!({"username": "alice"})).expect("req")),
        )
        .await
        .expect("friend request");
        let ids = |items: Vec<InboxItem>| {
            items
                .iter()
                .filter_map(|i| i.message_id)
                .collect::<Vec<_>>()
        };
        let before: HashSet<i64> = ids(all(&state, "alice", json!({})).await)
            .into_iter()
            .collect();
        assert_eq!(
            before,
            HashSet::from([late.id, gone.id, blocked.id, shout.id, hidden.id, early.id])
        );
        let hidden_ping = one(
            db,
            &format!("SELECT id FROM pings WHERE message_id = {}", hidden.id),
        )
        .await;

        exec(db, &format!("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES({secret}, 'u:bob', 1, 1, 1)")).await;
        crate::api::test_util::restrict_ruled(db).await;
        exec(db, &format!("DELETE FROM messages WHERE id = {}", gone.id)).await;
        exec(db, "UPDATE pings SET seen = 1 WHERE actor = 'carol'").await;
        exec(db, "UPDATE friend_pings SET seen = 1 WHERE actor = 'carol'").await;
        let _ = crate::api::blocks::block_user(
            State(state.clone()),
            me("alice"),
            Json(serde_json::from_value(json!({"username": "carol"})).expect("block")),
        )
        .await
        .expect("block");
        let now_ids = ids(all(&state, "alice", json!({})).await);
        assert_eq!(
            now_ids,
            vec![late.id, early.id],
            "access removed, deleted, blocked"
        );
        let p = page(&state, "alice", json!({"limit": 1}))
            .await
            .expect("page");
        assert_eq!(p.items.len(), 1);
        let p2 = page(&state, "alice", json!({"limit": 1, "cursor": p.next}))
            .await
            .expect("page 2");
        assert_eq!(
            ids(p2.items),
            vec![early.id],
            "no hole where hidden items were"
        );
        assert!(p2.next.is_none());
        assert_eq!(
            all(&state, "alice", json!({"kind": "friends"})).await.len(),
            0,
            "blocked friend ping"
        );
        let missing = read(&state, "alice", InboxSource::Ping, hidden_ping)
            .await
            .expect_err("hidden");
        let unknown = read(&state, "alice", InboxSource::Ping, 999_999)
            .await
            .expect_err("unknown");
        say(&state, "alice", &c, "@bob yours").await;
        let theirs = one(db, "SELECT MIN(id) FROM pings WHERE username <> 'alice'").await;
        let foreign = read(&state, "alice", InboxSource::Ping, theirs).await;
        assert!(foreign.is_err());
        assert_eq!(missing.0, unknown.0);
        assert_eq!(missing.1, unknown.1);
        assert!(
            read(&state, "alice", InboxSource::Group, shout.id)
                .await
                .is_err()
        );

        exec(db, "UPDATE channels SET restrict_view = 0").await;
        exec(
            db,
            &format!("DELETE FROM channel_perms WHERE channel_id = {secret}"),
        )
        .await;
        exec(db, &format!("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES({cid}, 'u:alice', 1, 1, 0)")).await;
        exec(
            db,
            &format!(
                "UPDATE members SET joined_at = {} WHERE username = 'alice'",
                early.created_at + 1
            ),
        )
        .await;
        exec(
            db,
            &format!(
                "UPDATE messages SET created_at = {} WHERE id = {}",
                early.created_at + 5,
                late.id
            ),
        )
        .await;
        let floor = ids(all(&state, "alice", json!({})).await);
        assert!(
            floor.contains(&late.id) && !floor.contains(&early.id),
            "read-history floor: {floor:?}"
        );

        exec(db, "DELETE FROM members WHERE username = 'alice'").await;
        assert!(
            all(&state, "alice", json!({})).await.is_empty(),
            "membership ended"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn marking_read_clears_the_badges_but_not_the_read_position() {
        let (state, path, cid) = world("inbox_read").await;
        let db = &state.db;
        let c = format!("c{cid}");
        let mention = say(&state, "bob", &c, "@alice one").await;
        let other = say(&state, "bob", &c, "@alice two").await;
        let everyone = say(&state, "boss", &c, "@everyone").await;
        let _ = crate::api::friends::send_request(
            State(state.clone()),
            me("carol"),
            Json(serde_json::from_value(json!({"username": "alice"})).expect("req")),
        )
        .await
        .expect("friend request");
        let items = all(&state, "alice", json!({})).await;
        let ping_id = items
            .iter()
            .find(|i| i.message_id == Some(mention.id))
            .expect("m")
            .id;
        let friend_id = items
            .iter()
            .find(|i| i.source == InboxSource::Friend)
            .expect("f")
            .id;
        let mut rx = state.hub.subscribe();

        read(&state, "alice", InboxSource::Ping, ping_id)
            .await
            .expect("read one");
        read(&state, "alice", InboxSource::Ping, ping_id)
            .await
            .expect("again");
        read(&state, "alice", InboxSource::Group, everyone.id)
            .await
            .expect("read group");
        read(&state, "alice", InboxSource::Friend, friend_id)
            .await
            .expect("read friend");
        let events: Vec<WsEvent> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
        assert!(events.iter().any(|e| matches!(e, WsEvent::PingCount { username, scope, pings: 1, .. } if username == "alice" && *scope == c)));
        assert!(events.iter().any(|e| matches!(e, WsEvent::GroupPingsSeen { username, scope, message_ids } if username == "alice" && *scope == c && message_ids == &vec![everyone.id])));
        assert!(events.iter().any(|e| matches!(e, WsEvent::PingCount { username, scope, pings: 0, .. } if username == "alice" && scope == "friends")));
        let unread = all(&state, "alice", json!({"unread": true})).await;
        assert_eq!(
            unread
                .iter()
                .filter_map(|i| i.message_id)
                .collect::<Vec<_>>(),
            vec![other.id]
        );
        let listed = all(&state, "alice", json!({})).await;
        assert_eq!(listed.len(), 4, "read items stay in All");
        assert!(
            !listed
                .iter()
                .find(|i| i.id == everyone.id && i.source == InboxSource::Group)
                .expect("g")
                .unread
        );
        assert_eq!(
            one(
                db,
                "SELECT COUNT(*) FROM read_state WHERE username = 'alice'"
            )
            .await,
            0,
            "no read position"
        );
        let groups = crate::api::pings::group_unseen(db, "alice", &[])
            .await
            .expect("groups");
        assert!(groups.is_empty(), "the group mention no longer counts");
        assert_eq!(
            crate::api::pings::scope_counts(db, "alice", &c)
                .await
                .expect("count")
                .pings,
            1
        );

        let snapshot = page(&state, "alice", json!({}))
            .await
            .expect("page")
            .until
            .expect("until");
        let newer = say(&state, "bob", &c, "@alice after").await;
        let shout = say(&state, "boss", &c, "@everyone after").await;
        let _ = read_all(
            State(state.clone()),
            me("alice"),
            Json(InboxReadAll {
                until: snapshot,
                kind: None,
                server: None,
                dms: None,
            }),
        )
        .await
        .expect("read all");
        let unread: HashSet<i64> = all(&state, "alice", json!({"unread": true}))
            .await
            .iter()
            .filter_map(|i| i.message_id)
            .collect();
        assert_eq!(
            unread,
            HashSet::from([newer.id, shout.id]),
            "newer than the page stay unread"
        );

        let snapshot = page(&state, "alice", json!({}))
            .await
            .expect("page")
            .until
            .expect("until");
        let _ = read_all(
            State(state.clone()),
            me("alice"),
            Json(InboxReadAll {
                until: snapshot,
                kind: Some(InboxFilter::Replies),
                server: None,
                dms: None,
            }),
        )
        .await
        .expect("filtered");
        assert_eq!(
            all(&state, "alice", json!({"unread": true})).await.len(),
            2,
            "the filter limits it"
        );
        let _ = read_all(
            State(state.clone()),
            me("alice"),
            Json(InboxReadAll {
                until: snapshot,
                kind: Some(InboxFilter::Mentions),
                server: Some("rchat".into()),
                dms: None,
            }),
        )
        .await
        .expect("mentions");
        assert!(
            all(&state, "alice", json!({"unread": true}))
                .await
                .is_empty()
        );
        assert!(
            crate::api::pings::group_unseen(db, "alice", &[])
                .await
                .expect("groups")
                .is_empty()
        );

        crate::db::sweep_stale(db).await.expect("sweep");
        assert_eq!(
            all(&state, "alice", json!({})).await.len(),
            6,
            "seen pings stay for 30 days"
        );
        exec(db, "UPDATE pings SET created_at = 1").await;
        exec(db, "UPDATE friend_pings SET created_at = 1").await;
        exec(db, "UPDATE group_pings SET created_at = 1").await;
        crate::db::sweep_stale(db).await.expect("sweep old");
        assert!(
            all(&state, "alice", json!({})).await.is_empty(),
            "then they age out"
        );
        done(state, path).await;
    }

    fn group_plan_sql(gate: &Gate) -> String {
        format!(
            "EXPLAIN QUERY PLAN {} ORDER BY g.created_at DESC, g.message_id DESC LIMIT 51",
            group_sql(
                gate,
                &Filter::default(),
                "g.server = $2 AND g.created_at >= $3 AND g.created_at <= $4 AND (g.created_at < $4 OR g.message_id < $5)"
            )
        )
    }

    async fn plan(db: &Db, sql: &str, binds: &[Bind]) -> Vec<String> {
        bind_all(sqlx::query(sqlx::AssertSqlSafe(sql.to_string())), binds)
            .fetch_all(db)
            .await
            .expect("plan")
            .iter()
            .map(|r| r.try_get::<String, _>(3).expect("detail"))
            .collect()
    }

    #[tokio::test]
    async fn a_big_inbox_reads_a_bounded_number_of_rows_per_page() {
        let (state, path, cid) = world("inbox_scale").await;
        let db = &state.db;
        let t = now();
        let base = say(&state, "bob", &format!("c{cid}"), "@alice base")
            .await
            .id;
        exec(db, "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50) INSERT INTO servers(name, display_name, created_at) SELECT 'big' || i, 'Big ' || i, 1 FROM n").await;
        exec(db, "INSERT INTO channels(server, name, kind, created_at) SELECT name, 'general', 'text', 1 FROM servers WHERE name LIKE 'big%'").await;
        exec(db, "INSERT INTO members(server, username, is_admin, perms, joined_at) SELECT name, 'alice', 0, 0, 1 FROM servers WHERE name LIKE 'big%'").await;
        exec(db, "INSERT INTO members(server, username, is_admin, perms, joined_at) SELECT name, 'boss', 1, 1, 1 FROM servers WHERE name LIKE 'big%'").await;
        exec(db, "INSERT INTO roles(server, name, color, perms, mentionable) SELECT name, 'others', '#336699', 0, 1 FROM servers WHERE name LIKE 'big%'").await;
        exec(db, &format!("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000) INSERT INTO messages(channel_id, author, content, created_at) SELECT c.id, 'boss', 'news ' || n.i, {t} - 100 - n.i FROM channels c, n WHERE c.server LIKE 'big%'")).await;
        exec(db, "INSERT INTO group_pings(message_id, channel_id, server, kind, role_id, actor, created_at) SELECT m.id, m.channel_id, c.server, CASE m.id % 4 WHEN 0 THEN 'everyone' WHEN 1 THEN 'role' ELSE 'here' END, CASE WHEN m.id % 4 = 1 THEN (SELECT r.id FROM roles r WHERE r.server = c.server) END, 'boss', m.created_at FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.server LIKE 'big%'").await;
        exec(db, &format!("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000) INSERT INTO messages(channel_id, author, content, created_at) SELECT {cid}, 'bob', '@alice ' || n.i, {t} - 100 - n.i FROM n")).await;
        exec(db, &format!("INSERT INTO pings(username, kind, scope, server, message_id, actor, created_at, seen) SELECT 'alice', 'mention', 'c{cid}', 'rchat', id, 'bob', created_at, id % 2 FROM messages WHERE author = 'bob' AND id <> {base}")).await;
        exec(db, "ANALYZE").await;
        assert_eq!(one(db, "SELECT COUNT(*) FROM group_pings").await, 100_000);

        let mut cursor: Option<String> = None;
        let mut items = Vec::new();
        let mut slowest = std::time::Duration::ZERO;
        for _ in 0..10 {
            let started = std::time::Instant::now();
            let p = page(&state, "alice", json!({"cursor": cursor}))
                .await
                .expect("page");
            slowest = slowest.max(started.elapsed());
            assert_eq!(p.items.len(), 50);
            items.extend(p.items);
            cursor = p.next;
        }
        eprintln!("slowest of 10 inbox pages over 100k group pings and 20k pings: {slowest:?}");
        assert!(slowest < std::time::Duration::from_secs(2), "{slowest:?}");
        let mut order: Vec<Key> = items.iter().map(Key::of).collect();
        order.sort_by_key(|k| std::cmp::Reverse(*k));
        assert_eq!(order, items.iter().map(Key::of).collect::<Vec<_>>());
        assert!(
            items
                .iter()
                .filter(|i| i.source == InboxSource::Group)
                .all(|i| i.kind == InboxKind::Everyone && i.id % 4 == 0),
            "only what addresses the reader"
        );
        assert!(items.iter().any(|i| i.source == InboxSource::Group));
        assert!(items.iter().any(|i| i.source == InboxSource::Ping));

        let gate = Gate::load(db, &mem_user("alice", false))
            .await
            .expect("gate");
        let lines = plan(
            db,
            &group_plan_sql(&gate),
            &[
                Bind::S("alice".into()),
                Bind::S("big7".into()),
                Bind::I(1),
                Bind::I(t),
                Bind::I(i64::MAX),
            ],
        )
        .await;
        assert!(
            lines
                .iter()
                .any(|l| l.contains("idx_group_pings_server_time")),
            "{lines:#?}"
        );
        assert!(
            !lines.iter().any(|l| l.contains("TEMP B-TREE")),
            "walks the index in order and stops at the limit: {lines:#?}"
        );
        let mut binds = vec![Bind::S("alice".into())];
        let ping_plan = format!(
            "EXPLAIN QUERY PLAN {} ORDER BY p.created_at DESC, p.id DESC LIMIT 51",
            ping_sql(&gate, &Filter::default(), "", &mut binds)
        );
        let lines = plan(db, &ping_plan, &binds).await;
        assert!(
            lines
                .iter()
                .any(|l| l.contains("SEARCH p USING INDEX idx_pings_user")),
            "pings are read per user: {lines:#?}"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn group_marks_survive_the_seen_ping_cap_and_never_duplicate() {
        let (state, path, cid) = world("inbox_marks").await;
        let db = &state.db;
        let c = format!("c{cid}");
        let first = say(&state, "boss", &c, "@everyone one").await;
        let second = say(&state, "boss", &c, "@everyone two").await;
        read(&state, "alice", InboxSource::Group, first.id)
            .await
            .expect("mark");
        exec(db, &format!("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2500) INSERT INTO pings(username, kind, scope, server, message_id, actor, created_at, seen, emoji) SELECT 'alice', 'reaction', '{c}', 'rchat', {}, 'bob', {}, 1, '👍' FROM n", second.id, now())).await;
        let swept = crate::db::sweep_stale(db).await.expect("sweep");
        assert!(swept.pings >= 500, "the cap trimmed the reactions");
        let unseen = crate::api::pings::group_unseen(db, "alice", &[])
            .await
            .expect("groups");
        assert_eq!(
            unseen
                .get(&cid)
                .map(|l| l.iter().map(|g| g.message_id).collect::<Vec<_>>()),
            Some(vec![second.id]),
            "the marked mention stays read"
        );
        assert!(
            all(&state, "alice", json!({"unread": true}))
                .await
                .iter()
                .all(|i| i.id != first.id)
        );

        let mut rx = state.hub.subscribe();
        let (a, b, c2) = tokio::join!(
            read(&state, "alice", InboxSource::Group, second.id),
            read(&state, "alice", InboxSource::Group, second.id),
            read(&state, "alice", InboxSource::Group, second.id),
        );
        a.expect("a");
        b.expect("b");
        c2.expect("c");
        assert_eq!(
            one(
                db,
                &format!(
                    "SELECT COUNT(*) FROM group_pings_read WHERE username = 'alice' AND message_id = {}",
                    second.id
                )
            )
            .await,
            1
        );
        let seen_events = std::iter::from_fn(|| rx.try_recv().ok())
            .filter(|e| matches!(e, WsEvent::GroupPingsSeen { .. }))
            .count();
        assert_eq!(seen_events, 1, "told once");
        assert_eq!(
            one(db, "SELECT COUNT(*) FROM pings WHERE seen NOT IN (0, 1, 2)").await,
            0,
            "no marker pings"
        );
        exec(db, &format!("DELETE FROM messages WHERE id = {}", first.id)).await;
        assert_eq!(
            one(db, "SELECT COUNT(*) FROM group_pings_read").await,
            1,
            "deleted with the message"
        );
        exec(db, "DELETE FROM members WHERE username = 'alice'").await;
        let mut conn = db.acquire().await.expect("conn");
        crate::api::pings::forget_server_pings(&mut conn, "rchat", "alice")
            .await
            .expect("forget");
        drop(conn);
        assert_eq!(
            one(db, "SELECT COUNT(*) FROM group_pings_read").await,
            0,
            "dropped when the membership ends"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn group_mentions_follow_here_rows_and_held_roles() {
        let (state, path, cid) = world("inbox_group_gate").await;
        let db = &state.db;
        let c = format!("c{cid}");
        let crew = one(db, "INSERT INTO roles(server, name, color, perms, mentionable) VALUES('rchat', 'crew', '#336699', 0, 1) RETURNING id").await;
        exec(
            db,
            &format!(
                "INSERT INTO user_roles(server, username, role_id) VALUES('rchat', 'alice', {crew})"
            ),
        )
        .await;
        let here = say(&state, "boss", &c, "@here anyone").await;
        let role = say(&state, "boss", &c, "@crew go").await;
        let listed = |state: AppState| async move {
            all(&state, "alice", json!({}))
                .await
                .iter()
                .map(|i| i.id)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            listed(state.clone()).await,
            vec![role.id],
            "@here while offline is not listed"
        );
        exec(db, &format!("INSERT INTO here_pings(ping_id, username) SELECT id, 'alice' FROM group_pings WHERE message_id = {}", here.id)).await;
        assert_eq!(listed(state.clone()).await, vec![role.id, here.id]);
        exec(db, "DELETE FROM user_roles WHERE username = 'alice'").await;
        assert_eq!(
            listed(state.clone()).await,
            vec![here.id],
            "the role was taken away"
        );
        assert!(
            read(&state, "alice", InboxSource::Group, role.id)
                .await
                .is_err()
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn read_all_marks_at_most_the_newest_group_cap() {
        let (state, path, cid) = world("inbox_read_all_cap").await;
        let db = &state.db;
        let t = now();
        let extra = 5;
        exec(db, &format!("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < {}) INSERT INTO messages(channel_id, author, content, created_at) SELECT {cid}, 'boss', '@everyone ' || i, {t} - i FROM n", GROUP_PINGS_MAX + extra)).await;
        exec(db, &format!("INSERT INTO group_pings(message_id, channel_id, server, kind, actor, created_at) SELECT id, {cid}, 'rchat', 'everyone', 'boss', created_at FROM messages WHERE author = 'boss'")).await;
        let until = page(&state, "alice", json!({}))
            .await
            .expect("page")
            .until
            .expect("until");
        let _ = read_all(
            State(state.clone()),
            me("alice"),
            Json(InboxReadAll {
                until,
                kind: None,
                server: None,
                dms: None,
            }),
        )
        .await
        .expect("read all");
        let left = all(&state, "alice", json!({"unread": true})).await;
        let oldest: Vec<i64> = sqlx::query(sqlx::AssertSqlSafe(format!(
            "SELECT id FROM messages WHERE author = 'boss' ORDER BY created_at DESC, id DESC LIMIT {extra} OFFSET {GROUP_PINGS_MAX}"
        )))
        .fetch_all(db)
        .await
        .expect("oldest")
        .iter()
        .map(|r| r.try_get(0).expect("id"))
        .collect();
        assert_eq!(
            left.iter().map(|i| i.id).collect::<Vec<_>>(),
            oldest,
            "the oldest stay unread and listed"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn until_covers_only_your_servers_and_the_first_page() {
        let (state, path, cid) = world("inbox_until").await;
        let db = &state.db;
        say(&state, "bob", &format!("c{cid}"), "@alice older").await;
        let mine = say(&state, "boss", &format!("c{cid}"), "@everyone mine").await;
        exec(
            db,
            "INSERT INTO servers(name, display_name, created_at) VALUES('hidden', 'Hidden', 1)",
        )
        .await;
        let other = one(db, "INSERT INTO channels(server, name, kind, created_at) VALUES('hidden', 'general', 'text', 1) RETURNING id").await;
        add_member(db, "hidden", "boss", 1, 0, 1).await;
        let theirs = say(&state, "boss", &format!("c{other}"), "@everyone theirs").await;
        assert!(theirs.id > mine.id);
        let first = page(&state, "alice", json!({"limit": 1}))
            .await
            .expect("page");
        assert_eq!(first.until.map(|u| u.groups), Some(mine.id));
        let next = page(&state, "alice", json!({"limit": 1, "cursor": first.next}))
            .await
            .expect("page 2");
        assert!(next.until.is_none(), "only with the first page");
        done(state, path).await;
    }

    #[tokio::test]
    async fn friend_items_go_with_the_request_or_friendship() {
        let (state, path, _) = world("inbox_friends").await;
        let request = |from: &'static str, to: &'static str| {
            let state = state.clone();
            async move {
                let _ = crate::api::friends::send_request(
                    State(state),
                    me(from),
                    Json(serde_json::from_value(json!({ "username": to })).expect("req")),
                )
                .await
                .expect("request");
            }
        };
        let friends = |who: &'static str| {
            let state = state.clone();
            async move { all(&state, who, json!({"kind": "friends"})).await }
        };
        request("carol", "alice").await;
        let item = friends("alice").await.pop().expect("request item");
        read(&state, "alice", InboxSource::Friend, item.id)
            .await
            .expect("read");
        let _ = crate::api::friends::cancel_request(
            State(state.clone()),
            me("carol"),
            Path("alice".into()),
        )
        .await
        .expect("cancel");
        assert!(friends("alice").await.is_empty(), "cancelled");

        request("bob", "alice").await;
        let item = friends("alice").await.pop().expect("request item");
        read(&state, "alice", InboxSource::Friend, item.id)
            .await
            .expect("read");
        let _ = crate::api::friends::deny_request(
            State(state.clone()),
            me("alice"),
            Path("bob".into()),
        )
        .await
        .expect("deny");
        assert!(friends("alice").await.is_empty(), "declined");

        request("alice", "carol").await;
        let _ = crate::api::friends::accept_request(
            State(state.clone()),
            me("carol"),
            Path("alice".into()),
        )
        .await
        .expect("accept");
        let item = friends("alice").await.pop().expect("accept item");
        assert_eq!(item.kind, InboxKind::FriendAccept);
        read(&state, "alice", InboxSource::Friend, item.id)
            .await
            .expect("read");
        let _ = crate::api::friends::remove_friend(
            State(state.clone()),
            me("carol"),
            Path("alice".into()),
        )
        .await
        .expect("unfriend");
        assert!(friends("alice").await.is_empty(), "unfriended");
        done(state, path).await;
    }

    #[tokio::test]
    async fn the_cap_check_walks_a_covering_index() {
        let (state, path, cid) = world("inbox_trim_plan").await;
        let db = &state.db;
        let mid = say(&state, "bob", &format!("c{cid}"), "@alice hi").await.id;
        exec(db, &format!("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000) INSERT INTO pings(username, kind, scope, server, message_id, actor, created_at, seen) SELECT 'u' || (i % 50), 'mention', 'c{cid}', 'rchat', {mid}, 'bob', i, CASE WHEN i % 10 = 0 THEN 0 ELSE 1 END FROM n")).await;
        exec(db, "ANALYZE").await;
        let lines = plan(
            db,
            &format!("EXPLAIN QUERY PLAN {}", crate::db::KEPT_USERS_SQL),
            &[Bind::I(2000), Bind::I(1000)],
        )
        .await;
        assert!(
            lines.iter().any(|l| l.contains("COVERING INDEX")),
            "{lines:#?}"
        );
        done(state, path).await;
    }
}
