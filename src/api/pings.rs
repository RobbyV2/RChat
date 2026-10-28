use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use utoipa::ToSchema;

use crate::api::access::ResolvedChannel;
use crate::api::{ApiError, Message, NAME_MAX, UserRef, placeholders};
use crate::db::{Db, User, now};
use crate::state::AppState;
use crate::ws::WsEvent;

pub const MENTION_MAX: usize = 20;
pub const PINGS_MAX: i64 = 1000;
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
}

impl PingKind {
    pub fn as_str(self) -> &'static str {
        match self {
            PingKind::Mention => "mention",
            PingKind::Reply => "reply",
            PingKind::Reaction => "reaction",
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
    /// `c<channel id>` (thread replies use their channel and set `thread_root_id`) or
    /// `d<dm id>`.
    #[schema(example = "c12")]
    pub scope: String,
    /// Server of a channel scope; `null` for DMs.
    pub server: Option<String>,
    /// The message that pinged, or that was reacted to.
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
/// `app/lib/mentions.ts`), so `@name` inside code is not a mention.
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
/// `app/lib/mentions.ts`, so a username with spaces or dots can be mentioned. Code is skipped.
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

fn excerpt(content: &str) -> String {
    content.chars().take(EXCERPT_MAX).collect()
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
        sqlx::query(
            "DELETE FROM pings WHERE username = $1 AND seen = 0 AND id <= (SELECT p.id FROM pings p WHERE p.username = $1 AND p.seen = 0 ORDER BY p.id DESC LIMIT 1 OFFSET $2)",
        )
        .bind(username)
        .bind(PINGS_MAX)
        .execute(&mut *tx)
        .await?;
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

/// Stores the pings (see `insert_pings`) and sends each recipient's connections a `ping` event.
pub async fn create_pings(
    state: &AppState,
    spec: &PingSpec<'_>,
    recipients: &[String],
) -> Result<Vec<Ping>, ApiError> {
    let stored = insert_pings(&state.db, spec, recipients).await?;
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

/// Pings the users `message` mentions with `@username` who can see `scope`. Never fails the
/// send: errors are logged.
pub async fn ping_mentions(
    state: &AppState,
    scope: PingScope<'_>,
    message: &Message,
    actor: &User,
) {
    let run = async {
        let candidates = mention_candidates(&message.content);
        if candidates.is_empty() {
            return Ok(());
        }
        let named = mentioned_users(&state.db, &candidates, &actor.username).await?;
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
        tracing::warn!("mention pings for message {} failed: {e}", message.id);
    }
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
        let message = crate::api::messages::load_message(db, mid)
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
        assert_eq!(swept.pings, PINGS_MAX as u64 + 1);
        sqlx::query("DELETE FROM messages WHERE id = $1")
            .bind(mid)
            .execute(db)
            .await
            .expect("delete");
        assert_eq!(count("SELECT COUNT(*) FROM pings").await, 0);
        done(state, path).await;
    }
}
