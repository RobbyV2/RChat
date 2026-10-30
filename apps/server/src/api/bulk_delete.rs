use std::collections::{BTreeMap, HashSet};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{AnyConnection, Row};
use utoipa::ToSchema;

use crate::api::access::{
    MsgScope, Proof, ResolvedChannel, ResolvedMessage, not_found, resolve_channel, resolve_dm,
    resolve_message, typing_scope,
};
use crate::api::audit;
use crate::api::budget::{Budget, slow_down};
use crate::api::messages::moderated;
use crate::api::pings::{announce_counts, pinged_by};
use crate::api::{ApiError, ApiErrorBody, Authed, allowed, bad, placeholders};
use crate::db::{Db, LIVE_AUTHOR, Perm, User, get_user, now, pool_key};
use crate::state::AppState;
use crate::ws::WsEvent;

/// Most ids in one request.
pub const IDS_MAX: usize = 200;
/// Most ids in `except`.
pub const EXCEPT_MAX: usize = 1000;
/// Messages a job looks at per batch.
pub const BATCH: i64 = 200;
/// Jobs one user may run at once (one per scope).
pub const RUNNING_MAX: i64 = 3;
/// A job whose runner has not reported for this long is taken over by the jobs sweep.
pub const JOB_LEASE: i64 = 30;
/// Finished jobs are listed for this long, then swept.
pub const JOB_KEEP: i64 = 86400;
/// Most authors named in the audit entry of one bulk delete.
pub const AUDIT_AUTHORS: usize = 10;
/// Most distinct authors a job counts by name; later ones are counted together.
const AUTHORS_KEPT: usize = 500;
const PAUSE: Duration = Duration::from_millis(100);

const REQUESTS_MAX: u32 = 20;
static REQUESTS: LazyLock<Budget> =
    LazyLock::new(|| Budget::new(REQUESTS_MAX, Duration::from_secs(60), 100_000));
const COUNTS_MAX: u32 = 60;
static COUNTS: LazyLock<Budget> =
    LazyLock::new(|| Budget::new(COUNTS_MAX, Duration::from_secs(60), 100_000));
static RUNNING: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

pub const TOO_MANY_JOBS: &str = "Too many deletions are running. Wait for one to finish";
pub const GONE: &str = "These messages are no longer available";
pub const STOPPED: &str = "Deleting stopped because of an error";

/// Which messages to delete: `ids` (at most 200), or `all: true` for every message in the scope
/// you may delete, optionally without the `except` ids (at most 1000) and only between `after`
/// and `before` (message ids, both exclusive). `dry_run` only counts.
#[derive(Deserialize, ToSchema)]
pub struct BulkDeleteReq {
    /// `c<channel id>` (the channel's messages, not thread replies), `t<root id>` (a thread's
    /// replies) or `d<dm id>`.
    #[schema(example = "c12")]
    scope: String,
    /// The messages to delete, at most 200.
    #[serde(default)]
    ids: Option<Vec<i64>>,
    /// Every message in the scope you can read and may delete, in a background job.
    #[serde(default)]
    all: bool,
    /// With `all`: message ids to keep, at most 1000.
    #[serde(default)]
    except: Vec<i64>,
    /// With `all`: only messages with a smaller id.
    #[serde(default)]
    before: Option<i64>,
    /// With `all`: only messages with a larger id.
    #[serde(default)]
    after: Option<i64>,
    /// With `all`: only this author's messages (a username; "Select mine" sends your own).
    #[serde(default)]
    author: Option<String>,
    /// Only count what would be deleted.
    #[serde(default)]
    dry_run: bool,
}

/// Where a bulk delete job is: `running`, `done`, `cancelled` (by you) or `failed` (the scope
/// went away or an error stopped it).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Running,
    Done,
    Cancelled,
    Failed,
}

impl JobStatus {
    fn as_str(self) -> &'static str {
        match self {
            JobStatus::Running => "running",
            JobStatus::Done => "done",
            JobStatus::Cancelled => "cancelled",
            JobStatus::Failed => "failed",
        }
    }

    fn parse(s: &str) -> JobStatus {
        match s {
            "running" => JobStatus::Running,
            "done" => JobStatus::Done,
            "cancelled" => JobStatus::Cancelled,
            _ => JobStatus::Failed,
        }
    }
}

/// A background deletion of every message in a scope (`all: true`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct BulkJob {
    /// Job id, for cancelling.
    pub id: i64,
    /// The scope, as in the request.
    pub scope: String,
    /// Where the job is.
    pub status: JobStatus,
    /// Messages deleted so far.
    pub deleted: i64,
    /// Messages looked at but not deleted (gone meanwhile, or no longer allowed).
    pub skipped: i64,
    /// How many messages it expected to delete when it started.
    pub estimate: i64,
    /// When it started.
    pub created_at: i64,
    /// When it ended; `null` while running.
    pub finished_at: Option<i64>,
    /// Why a `failed` job stopped.
    pub error: Option<String>,
}

/// The outcome of a bulk delete. With `ids`: `deleted` messages (their ids in `ids`), `others`
/// that belong to other people and need Manage messages, and `missing` ones (unknown, unreadable
/// or outside the scope; the same for every reason). With `all`: the counts the job starts
/// from and the `job`. A dry run deletes nothing: `deletable` is what you could delete now.
#[derive(Serialize, Deserialize, ToSchema)]
pub struct BulkDeleteResp {
    /// Messages selected: the ids given, or every message in the scope (an estimate).
    pub total: i64,
    /// How many of them you may delete.
    pub deletable: i64,
    /// How many belong to others and need the Manage messages permission.
    pub others: i64,
    /// Ids that are unknown, unreadable or outside the scope.
    pub missing: i64,
    /// How many were deleted by this request (0 for dry runs and jobs).
    pub deleted: i64,
    /// The deleted ids.
    pub ids: Vec<i64>,
    /// The background job, for `all`.
    pub job: Option<BulkJob>,
    /// For `all`: the newest message id counted. Send `before: upto + 1` with the real request
    /// to delete exactly what the dry run counted (newer messages are kept).
    pub upto: Option<i64>,
}

/// Where the messages are, resolved through the access gate for the caller.
enum Place {
    Channel(Box<ResolvedChannel>),
    Thread(i64, Box<ResolvedMessage>),
    Dm(i64, Vec<String>),
}

impl Place {
    fn channel(&self) -> Option<&ResolvedChannel> {
        match self {
            Place::Channel(c) => Some(&**c),
            Place::Thread(_, root) => root.channel(),
            Place::Dm(_, _) => None,
        }
    }

    fn holds(&self, scope: &MsgScope) -> bool {
        match self {
            Place::Channel(c) => scope.channel_id == Some(c.id()) && scope.thread_root_id.is_none(),
            Place::Thread(root, _) => scope.thread_root_id == Some(*root),
            Place::Dm(id, _) => scope.dm_id == Some(*id) && scope.channel_id.is_none(),
        }
    }

    fn condition(&self) -> (&'static str, i64) {
        match self {
            Place::Channel(c) => ("m.channel_id = $1 AND m.thread_root_id IS NULL", c.id()),
            Place::Thread(root, _) => ("m.thread_root_id = $1", *root),
            Place::Dm(id, _) => ("m.dm_id = $1 AND m.channel_id IS NULL", *id),
        }
    }

    async fn moderator(&self, db: &Db) -> bool {
        match self.channel() {
            Some(c) => c.server().has_perm(db, Perm::DeleteMessages).await,
            None => false,
        }
    }

    async fn floor(&self, db: &Db) -> Result<Option<i64>, ApiError> {
        match self.channel() {
            Some(c) => c.read_since(db).await,
            None => Ok(None),
        }
    }

    fn event(&self, ids: Vec<i64>, created: Vec<i64>) -> WsEvent {
        let (server, channel_id) = match self.channel() {
            Some(c) => (Some(c.server().name().to_string()), Some(c.id())),
            None => (None, None),
        };
        let (dm_id, dm_users) = match self {
            Place::Dm(id, users) => (Some(*id), Some(users.clone())),
            Place::Channel(_) | Place::Thread(_, _) => (None, None),
        };
        let thread_root_id = match self {
            Place::Thread(root, _) => Some(*root),
            Place::Channel(_) | Place::Dm(_, _) => None,
        };
        WsEvent::MessagesDeleted {
            server,
            channel_id,
            dm_id,
            dm_users,
            thread_root_id,
            ids,
            created,
        }
    }
}

fn parse_scope(scope: &str) -> Result<(&str, i64), ApiError> {
    match typing_scope(scope) {
        Some((kind @ ("c" | "t" | "d"), id)) => Ok((kind, id)),
        Some(_) | None => Err(bad("Unknown scope")),
    }
}

async fn resolve_place(db: &Db, scope: &str, user: &User) -> Result<Place, ApiError> {
    let (kind, id) = parse_scope(scope)?;
    let hide = |e: ApiError| match e {
        e @ ApiError(StatusCode::INTERNAL_SERVER_ERROR, _) => e,
        _ => not_found(),
    };
    match kind {
        "c" => Ok(Place::Channel(Box::new(
            resolve_channel(db, id, Some(user), &Proof::none())
                .await
                .map_err(hide)?,
        ))),
        "t" => {
            let root = resolve_message(db, id, Some(user), &Proof::none())
                .await
                .map_err(hide)?;
            root.thread_channel().map_err(hide)?;
            Ok(Place::Thread(id, Box::new(root)))
        }
        _ => Ok(Place::Dm(id, resolve_dm(db, id, user).await.map_err(hide)?)),
    }
}

/// The verdict on one message, through the same gate and rule as `DELETE /api/messages/{id}`.
enum Verdict {
    Missing,
    Others,
    Allowed(Box<ResolvedMessage>),
}

async fn judge(db: &Db, user: &User, place: &Place, id: i64) -> Result<Verdict, ApiError> {
    let Some(message) = allowed(resolve_message(db, id, Some(user), &Proof::none()).await)? else {
        return Ok(Verdict::Missing);
    };
    if !place.holds(message.scope()) {
        return Ok(Verdict::Missing);
    }
    match allowed(message.require_can_delete(db).await)? {
        Some(()) => Ok(Verdict::Allowed(Box::new(message))),
        None => Ok(Verdict::Others),
    }
}

/// Per-author counts of other people's deleted messages, and whether instance powers were
/// needed, for the one audit entry of a bulk delete.
#[derive(Default, Clone, Debug, PartialEq)]
struct Tally {
    authors: BTreeMap<String, i64>,
    unnamed: i64,
    staff: bool,
}

impl Tally {
    fn add(&mut self, author: &str, n: i64) {
        let room = self.authors.len() < AUTHORS_KEPT;
        match self.authors.get_mut(author) {
            Some(c) => *c += n,
            None if room => {
                self.authors.insert(author.to_string(), n);
            }
            None => self.unnamed += n,
        }
    }

    fn merge(&mut self, other: &Tally) {
        for (name, n) in &other.authors {
            self.add(name, *n);
        }
        self.unnamed += other.unnamed;
        self.staff |= other.staff;
    }

    fn count(&self) -> i64 {
        self.authors.values().sum::<i64>() + self.unnamed
    }

    fn encode(&self) -> String {
        json!({ "authors": self.authors, "unnamed": self.unnamed }).to_string()
    }

    fn decode(text: &str, staff: bool) -> Tally {
        let value: Value = serde_json::from_str(text).unwrap_or(Value::Null);
        let authors = value
            .get("authors")
            .and_then(Value::as_object)
            .map(|m| {
                m.iter()
                    .filter_map(|(k, v)| v.as_i64().map(|n| (k.clone(), n)))
                    .collect()
            })
            .unwrap_or_default();
        Tally {
            authors,
            unnamed: value.get("unnamed").and_then(Value::as_i64).unwrap_or(0),
            staff,
        }
    }

    /// `authors` (the most deleted first, at most `AUDIT_AUTHORS`) and `more_authors`.
    fn details(&self) -> (Value, i64) {
        let mut list: Vec<(&String, &i64)> = self.authors.iter().collect();
        list.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
        let named: Vec<Value> = list
            .iter()
            .take(AUDIT_AUTHORS)
            .map(|(name, n)| json!({ "name": name, "count": n }))
            .collect();
        let more = list.len().saturating_sub(AUDIT_AUTHORS) as i64 + i64::from(self.unnamed > 0);
        (Value::Array(named), more)
    }
}

struct AuditPlace {
    server: String,
    channel: audit::ChannelRef,
}

fn audit_entry(
    place: &AuditPlace,
    username: &str,
    tally: &Tally,
    total: i64,
    scope: &str,
) -> audit::Entry {
    let actor = match tally.staff {
        true => audit::Actor::Staff,
        false => audit::Actor::User(username.to_string()),
    };
    let (authors, more) = tally.details();
    let mut details = audit::Details::new()
        .channel(&place.channel)
        .set("count", tally.count())
        .set("total", total)
        .set("authors", authors)
        .set("more_authors", more);
    if scope.starts_with('t') {
        details = details.set("thread", true);
    }
    audit::Entry::new(&place.server, &actor, audit::Action::MessageBulkDelete)
        .target(audit::Target::with_id(
            audit::TargetKind::Channel,
            place.channel.id,
            Some(&place.channel.name),
        ))
        .details(details)
}

async fn audit_place(db: &Db, channel_id: Option<i64>) -> Result<Option<AuditPlace>, ApiError> {
    let Some(cid) = channel_id else {
        return Ok(None);
    };
    let Some(channel) = audit::channel_ref(db, cid).await? else {
        return Ok(None);
    };
    let server: Option<String> = sqlx::query("SELECT server FROM channels WHERE id = $1")
        .bind(cid)
        .fetch_optional(db)
        .await?
        .map(|r| r.try_get(0))
        .transpose()?;
    Ok(server.map(|server| AuditPlace { server, channel }))
}

/// Messages chosen for deletion with what the delete needs.
struct Picked {
    id: i64,
    author: String,
    pinged: Vec<(String, String)>,
    moderated: bool,
}

/// Gets ready to delete `message`: the audit context and the pings it carries. Read-only, so it
/// runs before the transaction (the SQLite writer has one connection).
async fn pick(
    db: &Db,
    user: &User,
    id: i64,
    message: &ResolvedMessage,
    tally: &mut Tally,
) -> Result<Picked, ApiError> {
    let audit = moderated(db, id, message, user, true).await?;
    if let Some((_, audit::Actor::Staff, _)) = &audit {
        tally.staff = true;
    }
    Ok(Picked {
        id,
        author: message.scope().author.clone(),
        pinged: pinged_by(db, id).await?,
        moderated: audit.is_some(),
    })
}

fn audit_counts(picked: &[Picked], gone: &HashSet<i64>, tally: &mut Tally) {
    for p in picked
        .iter()
        .filter(|p| p.moderated && gone.contains(&p.id))
    {
        tally.add(&p.author, 1);
    }
}

async fn delete_rows(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    picked: &[Picked],
) -> Result<Vec<(i64, i64)>, ApiError> {
    if picked.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "DELETE FROM messages WHERE id IN ({}) RETURNING id, created_at",
        placeholders(1, picked.len())
    );
    let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
    for p in picked {
        q = q.bind(p.id);
    }
    let rows = q.fetch_all(&mut **tx).await?;
    let mut out: Vec<(i64, i64)> = rows
        .iter()
        .map(|r| Ok((r.try_get(0)?, r.try_get(1)?)))
        .collect::<sqlx::Result<_>>()?;
    out.sort_by_key(|a| std::cmp::Reverse(a.0));
    Ok(out)
}

async fn announce(state: &AppState, place: &Place, picked: Vec<Picked>, gone: &[(i64, i64)]) {
    let pinged: Vec<(String, String)> = {
        let mut seen = HashSet::new();
        picked
            .into_iter()
            .flat_map(|p| p.pinged)
            .filter(|pair| seen.insert(pair.clone()))
            .collect()
    };
    announce_counts(state, pinged).await;
    if gone.is_empty() {
        return;
    }
    let (ids, created) = gone.iter().copied().unzip();
    state.hub.broadcast(place.event(ids, created));
}

fn job_from(r: &sqlx::any::AnyRow) -> sqlx::Result<BulkJob> {
    Ok(BulkJob {
        id: r.try_get(0)?,
        scope: r.try_get(1)?,
        status: JobStatus::parse(&r.try_get::<String, _>(2)?),
        deleted: r.try_get(3)?,
        skipped: r.try_get(4)?,
        estimate: r.try_get(5)?,
        created_at: r.try_get(6)?,
        finished_at: r.try_get(7)?,
        error: r.try_get(8)?,
    })
}

const JOB_COLS: &str =
    "id, scope, status, deleted, skipped, estimate, created_at, finished_at, error";

async fn load_job(db: &Db, id: i64) -> sqlx::Result<Option<BulkJob>> {
    let sql = format!("SELECT {JOB_COLS} FROM bulk_delete_jobs WHERE id = $1");
    sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_optional(db)
        .await?
        .as_ref()
        .map(job_from)
        .transpose()
}

fn progress(state: &AppState, username: &str, job: BulkJob) {
    state.hub.broadcast(WsEvent::BulkDeleteProgress {
        username: username.to_string(),
        job,
    });
}

struct Bounds {
    after: i64,
    upto: i64,
    floor: Option<i64>,
    author: Option<String>,
}

/// `(sql, binds)` for messages of `place` within `bounds`: `$1` is the place, then `upto`,
/// `after`, the floor and the author when set.
fn scoped_sql(place: &Place, bounds: &Bounds, select: &str, tail: &str) -> (String, i64) {
    let (cond, key) = place.condition();
    let mut sql = format!(
        "SELECT {select} FROM messages m WHERE {cond} AND m.id <= $2 AND m.id > $3 AND {LIVE_AUTHOR}"
    );
    let mut n = 4;
    if bounds.floor.is_some() {
        sql.push_str(&format!(" AND m.created_at >= ${n}"));
        n += 1;
    }
    if bounds.author.is_some() {
        sql.push_str(&format!(" AND m.author = ${n}"));
    }
    sql.push(' ');
    sql.push_str(tail);
    (sql, key)
}

fn bind_bounds<'q>(
    q: sqlx::query::Query<'q, sqlx::Any, sqlx::any::AnyArguments>,
    key: i64,
    bounds: &'q Bounds,
) -> sqlx::query::Query<'q, sqlx::Any, sqlx::any::AnyArguments> {
    let mut q = q.bind(key).bind(bounds.upto).bind(bounds.after);
    if let Some(floor) = bounds.floor {
        q = q.bind(floor);
    }
    if let Some(author) = &bounds.author {
        q = q.bind(author.as_str());
    }
    q
}

/// How many messages `bounds` covers in `place` and how many of them are `username`'s,
/// without the `except` ids.
async fn count_all(
    db: &Db,
    place: &Place,
    bounds: &Bounds,
    except: &[i64],
    username: &str,
) -> Result<(i64, i64), ApiError> {
    let count = |bounds: &Bounds| scoped_sql(place, bounds, "COUNT(*)", "");
    let (sql, key) = count(bounds);
    let total: i64 = bind_bounds(sqlx::query(sqlx::AssertSqlSafe(sql)), key, bounds)
        .fetch_one(db)
        .await?
        .try_get(0)?;
    let own: i64 = match &bounds.author {
        Some(a) if a == username => total,
        Some(_) => 0,
        None => {
            let mine = Bounds {
                after: bounds.after,
                upto: bounds.upto,
                floor: bounds.floor,
                author: Some(username.to_string()),
            };
            let (sql, key) = count(&mine);
            bind_bounds(sqlx::query(sqlx::AssertSqlSafe(sql)), key, &mine)
                .fetch_one(db)
                .await?
                .try_get(0)?
        }
    };
    let (mut total, mut own) = (total, own);
    for chunk in except.chunks(IDS_MAX) {
        let tail = format!(
            "AND m.id IN ({})",
            placeholders(next_bind(bounds), chunk.len())
        );
        let (sql, key) = scoped_sql(place, bounds, "m.author", &tail);
        let mut q = bind_bounds(sqlx::query(sqlx::AssertSqlSafe(sql)), key, bounds);
        for id in chunk {
            q = q.bind(*id);
        }
        for r in q.fetch_all(db).await? {
            total -= 1;
            if r.try_get::<String, _>(0)? == username {
                own -= 1;
            }
        }
    }
    Ok((total.max(0), own.max(0)))
}

fn next_bind(bounds: &Bounds) -> usize {
    4 + usize::from(bounds.floor.is_some()) + usize::from(bounds.author.is_some())
}

async fn newest(db: &Db, place: &Place) -> Result<i64, ApiError> {
    let (cond, key) = place.condition();
    let sql = format!("SELECT COALESCE(MAX(m.id), 0) FROM messages m WHERE {cond}");
    Ok(sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(key)
        .fetch_one(db)
        .await?
        .try_get(0)?)
}

fn dedup(ids: &[i64]) -> Vec<i64> {
    let mut seen = HashSet::new();
    ids.iter().copied().filter(|id| seen.insert(*id)).collect()
}

/// Delete many messages
///
/// Deletes messages of one channel, thread or DM with the same rule as deleting one: your own
/// messages always; in server channels others' with the Manage messages permission; in DMs only
/// your own. Requires a bearer token. With `ids` (at most 200) it deletes now and answers what
/// happened; unknown, unreadable and out-of-scope ids are counted as `missing`, others' messages
/// you may not delete as `others`. With `all: true` it starts a background job for every message
/// in the scope you can read and may delete (messages posted after the start are kept; on
/// Postgres a send still committing at the start can be included), minus `except` (at most 1000
/// ids), only between `after` and `before`, and only `author`'s when given. Send the dry run's
/// `upto` as `before: upto + 1` to delete only what it counted. A user runs at most one job
/// per scope (asking again answers the running job) and three at once. The job deletes in
/// batches of 200; `bulk_delete_progress` reaches your own connections after each batch, and
/// viewers get `messages_deleted` (ids only; viewers without read history of some of them get
/// only the ids they could read). Deleting a thread root also deletes all its replies, including
/// replies posted after the start. Deleting others' messages in a channel is audit logged with one
/// entry per request or job (`message.bulk_delete` with the count and the authors), which a job
/// writes with its first such batch and updates with every later one. `dry_run` counts without deleting. Deletes: 20 per minute;
/// dry runs: 60 per minute.
#[utoipa::path(post, path = "/api/messages/bulk_delete", tag = "Messages", request_body = BulkDeleteReq, responses((status = 200, description = "What was deleted, or the job that deletes everything", body = BulkDeleteResp), (status = 400, description = "`Unknown scope`, neither `ids` nor `all` (`Choose messages to delete`), both, more than 200 ids (`At most 200 messages at a time`), more than 1000 `except` ids (`At most 1000 exceptions`), or `except`/`before`/`after`/`author` without `all` (`except, before, after and author only go with all`), or an empty or over-long `author` (`Unknown author`). Malformed JSON or a missing `Content-Type` give plain-text 400/415 framework errors", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 404, description = "`Not found`: the channel, thread or DM does not exist or you cannot read it; identical responses", body = ApiErrorBody), (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String), (status = 429, description = "`Too many attempts. Try again later` past the request limits, `Too many deletions are running. Wait for one to finish` with three jobs running, or plain text from the general bucket", content((ApiErrorBody = "application/json"), (String = "text/plain")))), security(("bearer" = [])))]
pub(crate) async fn bulk_delete(
    State(state): State<AppState>,
    Authed(user): Authed,
    Json(req): Json<BulkDeleteReq>,
) -> Result<Json<BulkDeleteResp>, ApiError> {
    let BulkDeleteReq {
        scope,
        ids,
        all,
        except,
        before,
        after,
        author,
        dry_run,
    } = req;
    parse_scope(&scope)?;
    let author = match author.map(|a| a.trim().to_lowercase()) {
        Some(a) if a.is_empty() || a.chars().count() > 100 => return Err(bad("Unknown author")),
        other => other,
    };
    match (&ids, all) {
        (Some(ids), false) if ids.is_empty() => return Err(bad("Choose messages to delete")),
        (Some(ids), false) if ids.len() > IDS_MAX => {
            return Err(bad("At most 200 messages at a time"));
        }
        (Some(_), false)
            if !except.is_empty() || before.is_some() || after.is_some() || author.is_some() =>
        {
            return Err(bad("except, before, after and author only go with all"));
        }
        (Some(_), false) => {}
        (None, true) if except.len() > EXCEPT_MAX => return Err(bad("At most 1000 exceptions")),
        (None, true) => {}
        (Some(_), true) | (None, false) => return Err(bad("Choose messages to delete")),
    }
    let budget = match dry_run {
        true => &*COUNTS,
        false => &*REQUESTS,
    };
    if !budget.take(&format!("{}\n{}", pool_key(&state.db), user.username)) {
        return Err(slow_down());
    }
    let place = resolve_place(&state.db, &scope, &user).await?;
    match ids {
        Some(ids) => delete_ids(&state, &user, &place, &dedup(&ids), dry_run).await,
        None => {
            let except = dedup(&except);
            let range = Range {
                except,
                before,
                after,
                author,
            };
            start_all(&state, &user, &place, &scope, range, dry_run).await
        }
    }
}

async fn delete_ids(
    state: &AppState,
    user: &User,
    place: &Place,
    ids: &[i64],
    dry_run: bool,
) -> Result<Json<BulkDeleteResp>, ApiError> {
    let db = &state.db;
    let (mut others, mut missing) = (0, 0);
    let mut chosen = Vec::new();
    for id in ids {
        match judge(db, user, place, *id).await? {
            Verdict::Missing => missing += 1,
            Verdict::Others => others += 1,
            Verdict::Allowed(m) => chosen.push((*id, m)),
        }
    }
    let deletable = chosen.len() as i64;
    let total = ids.len() as i64;
    if dry_run || chosen.is_empty() {
        return Ok(Json(BulkDeleteResp {
            total,
            deletable,
            others,
            missing,
            deleted: 0,
            ids: Vec::new(),
            job: None,
            upto: None,
        }));
    }
    let mut tally = Tally::default();
    let mut picked = Vec::with_capacity(chosen.len());
    for (id, m) in &chosen {
        picked.push(pick(db, user, *id, m, &mut tally).await?);
    }
    let audit_at = audit_place(db, place.channel().map(|c| c.id())).await?;
    let mut tx = db.begin().await?;
    let gone = delete_rows(&mut tx, &picked).await?;
    let gone_ids: HashSet<i64> = gone.iter().map(|(id, _)| *id).collect();
    audit_counts(&picked, &gone_ids, &mut tally);
    resolve_authors(&mut tx, &mut tally).await?;
    let scope_tag = match place {
        Place::Thread(_, _) => "t",
        Place::Channel(_) | Place::Dm(_, _) => "c",
    };
    if let Some(at) = &audit_at
        && tally.count() > 0
    {
        audit::record(
            &mut tx,
            audit_entry(at, &user.username, &tally, gone.len() as i64, scope_tag),
        )
        .await?;
    }
    tx.commit().await?;
    announce(state, place, picked, &gone).await;
    let missing = missing + deletable - gone.len() as i64;
    Ok(Json(BulkDeleteResp {
        total,
        deletable,
        others,
        missing,
        deleted: gone.len() as i64,
        ids: gone.iter().map(|(id, _)| *id).collect(),
        job: None,
        upto: None,
    }))
}

/// What `all` covers besides the scope.
struct Range {
    except: Vec<i64>,
    before: Option<i64>,
    after: Option<i64>,
    author: Option<String>,
}

async fn start_all(
    state: &AppState,
    user: &User,
    place: &Place,
    scope: &str,
    range: Range,
    dry_run: bool,
) -> Result<Json<BulkDeleteResp>, ApiError> {
    let Range {
        except,
        before,
        after,
        author,
    } = range;
    let db = &state.db;
    let moderator = place.moderator(db).await;
    let upto = match before {
        Some(b) => b.saturating_sub(1).min(newest(db, place).await?),
        None => newest(db, place).await?,
    };
    let bounds = Bounds {
        after: after.unwrap_or(0),
        upto,
        floor: place.floor(db).await?,
        author: author.clone(),
    };
    let (total, own) = count_all(db, place, &bounds, &except, &user.username).await?;
    let deletable = match moderator {
        true => total,
        false => own,
    };
    let counts = |job: Option<BulkJob>| BulkDeleteResp {
        total,
        deletable,
        others: total - deletable,
        missing: 0,
        deleted: 0,
        ids: Vec::new(),
        job,
        upto: Some(upto),
    };
    if dry_run {
        return Ok(Json(counts(None)));
    }
    if let Some(job) = running_job(db, &user.username, scope).await? {
        return Ok(Json(counts(Some(job))));
    }
    let running: i64 = sqlx::query(
        "SELECT COUNT(*) FROM bulk_delete_jobs WHERE username = $1 AND status = 'running'",
    )
    .bind(&user.username)
    .fetch_one(db)
    .await?
    .try_get(0)?;
    if running >= RUNNING_MAX {
        return Err(ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            TOO_MANY_JOBS.to_string(),
        ));
    }
    let t = now();
    let inserted = sqlx::query("INSERT INTO bulk_delete_jobs(username, scope, channel_id, except_ids, after_id, upto_id, cursor_id, estimate, claimed_at, created_at, author_filter) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10) ON CONFLICT DO NOTHING RETURNING id")
        .bind(&user.username)
        .bind(scope)
        .bind(place.channel().map(|c| c.id()))
        .bind(json!(except).to_string())
        .bind(bounds.after)
        .bind(upto)
        .bind(upto + 1)
        .bind(deletable)
        .bind(t)
        .bind(author.as_deref())
        .fetch_optional(db)
        .await?;
    let job = match inserted {
        Some(r) => {
            let id: i64 = r.try_get(0)?;
            spawn_job(state, id);
            load_job(db, id).await?
        }
        None => running_job(db, &user.username, scope).await?,
    };
    if let Some(job) = &job {
        progress(state, &user.username, job.clone());
    }
    Ok(Json(counts(job)))
}

async fn running_job(db: &Db, username: &str, scope: &str) -> sqlx::Result<Option<BulkJob>> {
    let sql = format!(
        "SELECT {JOB_COLS} FROM bulk_delete_jobs WHERE username = $1 AND scope = $2 AND status = 'running'"
    );
    sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(username)
        .bind(scope)
        .fetch_optional(db)
        .await?
        .as_ref()
        .map(job_from)
        .transpose()
}

/// List your bulk delete jobs
///
/// Your running jobs and the ones that ended in the last day, newest first (at most 20).
/// Requires a bearer token.
#[utoipa::path(get, path = "/api/messages/bulk_delete/jobs", tag = "Messages", responses((status = 200, description = "Your jobs", body = [BulkJob]), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn list_jobs(
    State(state): State<AppState>,
    Authed(user): Authed,
) -> Result<Json<Vec<BulkJob>>, ApiError> {
    let sql = format!(
        "SELECT {JOB_COLS} FROM bulk_delete_jobs WHERE username = $1 AND (status = 'running' OR finished_at >= $2) ORDER BY id DESC LIMIT 20"
    );
    let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(&user.username)
        .bind(now() - JOB_KEEP)
        .fetch_all(&state.db)
        .await?;
    Ok(Json(
        rows.iter().map(job_from).collect::<sqlx::Result<_>>()?,
    ))
}

/// Cancel a bulk delete job
///
/// Stops your running job after the batch in progress; what it deleted stays deleted (and is
/// audit logged). Requires a bearer token. A job that already ended is answered as it is.
/// Emits `bulk_delete_progress` to your connections.
#[utoipa::path(delete, path = "/api/messages/bulk_delete/jobs/{id}", tag = "Messages", params(("id" = i64, Path, description = "Job id")), responses((status = 200, description = "The job", body = BulkJob), (status = 400, description = "Non-numeric id (plain-text framework error)", content_type = "text/plain", body = String), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 404, description = "`Not found`: no such job of yours", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn cancel_job(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(id): Path<i64>,
) -> Result<Json<BulkJob>, ApiError> {
    sqlx::query("SELECT id FROM bulk_delete_jobs WHERE id = $1 AND username = $2")
        .bind(id)
        .bind(&user.username)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(not_found)?;
    finish(&state, id, &user.username, JobStatus::Cancelled, None).await?;
    let job = load_job(&state.db, id).await?.ok_or_else(not_found)?;
    Ok(Json(job))
}

/// Ends running job `id` as `status`. Does nothing for a job that already ended. The audit entry
/// is already complete: every batch writes it in its own transaction.
async fn finish(
    state: &AppState,
    id: i64,
    username: &str,
    status: JobStatus,
    error: Option<&str>,
) -> Result<(), ApiError> {
    let ended = sqlx::query("UPDATE bulk_delete_jobs SET status = $1, finished_at = $2, error = $3 WHERE id = $4 AND status = 'running'")
        .bind(status.as_str())
        .bind(now())
        .bind(error)
        .bind(id)
        .execute(&state.db)
        .await?
        .rows_affected();
    if ended == 0 {
        return Ok(());
    }
    if let Some(job) = load_job(&state.db, id).await? {
        progress(state, username, job);
    }
    Ok(())
}

fn running_key(db: &Db, id: i64) -> String {
    format!("{}\n{id}", pool_key(db))
}

/// Batches running at once in this process, over every job.
static BATCHES: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);
/// Times a batch that hit an error is tried again before the job fails.
const RETRIES: u32 = 3;

/// Runs job `id` in the background unless this process already runs it.
pub fn spawn_job(state: &AppState, id: i64) {
    let state = state.clone();
    tokio::spawn(async move { run_job(&state, id).await });
}

/// Runs job `id` to its end (or until another runner took it over).
pub(crate) async fn run_job(state: &AppState, id: i64) {
    let key = running_key(&state.db, id);
    {
        let mut running = RUNNING.lock().unwrap_or_else(|p| p.into_inner());
        if !running.insert(key.clone()) {
            return;
        }
    }
    let mut errors = 0;
    loop {
        let started = std::time::Instant::now();
        let out = match BATCHES.acquire().await {
            Ok(_permit) => step(state, id).await,
            Err(_) => Ok(false),
        };
        match out {
            Ok(true) => {
                errors = 0;
                tokio::time::sleep(PAUSE.max(started.elapsed())).await;
            }
            Ok(false) => break,
            Err(e) if errors < RETRIES => {
                errors += 1;
                tracing::warn!("bulk delete job {id} batch failed, trying again: {}", e.1);
                tokio::time::sleep(PAUSE * 10 * 2u32.pow(errors)).await;
            }
            Err(e) => {
                tracing::warn!("bulk delete job {id} failed: {}", e.1);
                if let Err(e) = fail(state, id).await {
                    tracing::warn!("marking bulk delete job {id} failed did not work: {}", e.1);
                }
                break;
            }
        }
    }
    RUNNING
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(&key);
}

async fn fail(state: &AppState, id: i64) -> Result<(), ApiError> {
    let Some(row) = sqlx::query("SELECT username FROM bulk_delete_jobs WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.db)
        .await?
    else {
        return Ok(());
    };
    let username: String = row.try_get(0)?;
    finish(state, id, &username, JobStatus::Failed, Some(STOPPED)).await
}

/// Moves the authors in `tally` whose account is gone (or being purged and already forgotten)
/// into `unnamed`, inside the transaction that writes the tally, so a purged name is never
/// written again (Task 35's deleted-user rule).
async fn resolve_authors(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    tally: &mut Tally,
) -> Result<(), ApiError> {
    let names: Vec<String> = tally.authors.keys().cloned().collect();
    let mut live = HashSet::new();
    for chunk in names.chunks(IDS_MAX) {
        let sql = format!(
            "SELECT username FROM users WHERE username IN ({})",
            placeholders(1, chunk.len())
        );
        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
        for name in chunk {
            q = q.bind(name.as_str());
        }
        for r in q.fetch_all(&mut **tx).await? {
            live.insert(r.try_get::<String, _>(0)?);
        }
    }
    for name in names.iter().filter(|n| !live.contains(*n)) {
        if let Some(n) = tally.authors.remove(name) {
            tally.unnamed += n;
        }
    }
    Ok(())
}

/// For a purged account: in every job (running ones included) its count of deleted messages
/// moves into `unnamed`, so no later batch writes its name into the audit log, and a job that
/// picked only its messages matches nothing any more. Runs in the purge transaction, before
/// `audit::forget_user`.
pub(crate) async fn forget_author(conn: &mut AnyConnection, username: &str) -> sqlx::Result<()> {
    sqlx::query("UPDATE bulk_delete_jobs SET author_filter = '' WHERE author_filter = $1")
        .bind(username)
        .execute(&mut *conn)
        .await?;
    let rows = sqlx::query("SELECT id, authors FROM bulk_delete_jobs WHERE authors <> '{}'")
        .fetch_all(&mut *conn)
        .await?;
    for r in &rows {
        let (id, text): (i64, String) = (r.try_get(0)?, r.try_get(1)?);
        let mut tally = Tally::decode(&text, false);
        let Some(n) = tally.authors.remove(username) else {
            continue;
        };
        tally.unnamed += n;
        sqlx::query("UPDATE bulk_delete_jobs SET authors = $1 WHERE id = $2")
            .bind(tally.encode())
            .bind(id)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

/// The author pre-filter of a job's batches: the job's own author, else the requester's when
/// they may not delete others' messages. `Err(())` when the job can match nothing.
fn batch_author(
    filter: Option<String>,
    moderator: bool,
    username: &str,
) -> Result<Option<String>, ()> {
    match (filter, moderator) {
        (Some(f), _) if f.is_empty() => Err(()),
        (Some(f), true) => Ok(Some(f)),
        (Some(f), false) if f == username => Ok(Some(f)),
        (Some(_), false) => Err(()),
        (None, true) => Ok(None),
        (None, false) => Ok(Some(username.to_string())),
    }
}

/// One batch of job `id`. `Ok(true)` while there is more to do.
async fn step(state: &AppState, id: i64) -> Result<bool, ApiError> {
    let db = &state.db;
    let Some(row) = sqlx::query("SELECT username, scope, channel_id, except_ids, after_id, upto_id, cursor_id, staff, author_filter FROM bulk_delete_jobs WHERE id = $1 AND status = 'running'")
        .bind(id)
        .fetch_optional(db)
        .await?
    else {
        return Ok(false);
    };
    let (username, scope, channel_id): (String, String, Option<i64>) =
        (row.try_get(0)?, row.try_get(1)?, row.try_get(2)?);
    let except: HashSet<i64> = serde_json::from_str::<Vec<i64>>(&row.try_get::<String, _>(3)?)
        .unwrap_or_default()
        .into_iter()
        .collect();
    let (after, upto, cursor): (i64, i64, i64) =
        (row.try_get(4)?, row.try_get(5)?, row.try_get(6)?);
    let staff = row.try_get::<i64, _>(7)? != 0;
    let filter: Option<String> = row.try_get(8)?;
    sqlx::query("UPDATE bulk_delete_jobs SET claimed_at = $1 WHERE id = $2 AND status = 'running'")
        .bind(now())
        .bind(id)
        .execute(db)
        .await?;
    let gone = |reason| finish(state, id, &username, JobStatus::Failed, Some(reason));
    let Some(user) = get_user(db, &username).await? else {
        gone(GONE).await?;
        return Ok(false);
    };
    let place = match resolve_place(db, &scope, &user).await {
        Ok(place) => place,
        Err(ApiError(StatusCode::INTERNAL_SERVER_ERROR, e)) => {
            return Err(ApiError(StatusCode::INTERNAL_SERVER_ERROR, e));
        }
        Err(_) => {
            gone(GONE).await?;
            return Ok(false);
        }
    };
    let Ok(author) = batch_author(filter, place.moderator(db).await, &username) else {
        finish(state, id, &username, JobStatus::Done, None).await?;
        return Ok(false);
    };
    let bounds = Bounds {
        after,
        upto: upto.min(cursor - 1),
        floor: place.floor(db).await?,
        author,
    };
    let tail = format!("ORDER BY m.id DESC LIMIT {BATCH}");
    let (sql, key) = scoped_sql(&place, &bounds, "m.id", &tail);
    let candidates: Vec<i64> = bind_bounds(sqlx::query(sqlx::AssertSqlSafe(sql)), key, &bounds)
        .fetch_all(db)
        .await?
        .iter()
        .map(|r| r.try_get(0))
        .collect::<sqlx::Result<_>>()?;
    let Some(lowest) = candidates.iter().copied().min() else {
        finish(state, id, &username, JobStatus::Done, None).await?;
        return Ok(false);
    };
    let mut skipped = 0;
    let mut batch = Tally {
        staff,
        ..Tally::default()
    };
    let mut picked = Vec::new();
    for mid in candidates.iter().copied().filter(|m| !except.contains(m)) {
        match judge(db, &user, &place, mid).await? {
            Verdict::Missing | Verdict::Others => skipped += 1,
            Verdict::Allowed(m) => picked.push(pick(db, &user, mid, &m, &mut batch).await?),
        }
    }
    let audit_at = audit_place(db, channel_id).await?;
    let mut tx = db.begin().await?;
    // Takes the job row first: a cancel or purge that got there first ends the batch here, and
    // the tally is read under the lock, so a concurrent runner or purge never loses an update.
    let Some(locked) = sqlx::query("UPDATE bulk_delete_jobs SET claimed_at = $1 WHERE id = $2 AND status = 'running' RETURNING authors, audit_id")
        .bind(now())
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
    else {
        tx.rollback().await?;
        return Ok(false);
    };
    let mut tally = Tally::decode(&locked.try_get::<String, _>(0)?, staff);
    let audit_id: Option<i64> = locked.try_get(1)?;
    let gone_rows = delete_rows(&mut tx, &picked).await?;
    let gone_ids: HashSet<i64> = gone_rows.iter().map(|(i, _)| *i).collect();
    audit_counts(&picked, &gone_ids, &mut batch);
    resolve_authors(&mut tx, &mut batch).await?;
    tally.merge(&batch);
    skipped += picked.len() as i64 - gone_rows.len() as i64;
    let deleted: i64 = sqlx::query("UPDATE bulk_delete_jobs SET cursor_id = CASE WHEN cursor_id < $1 THEN cursor_id ELSE $1 END, deleted = deleted + $2, skipped = skipped + $3, authors = $4, staff = $5 WHERE id = $6 RETURNING deleted")
        .bind(lowest)
        .bind(gone_rows.len() as i64)
        .bind(skipped)
        .bind(tally.encode())
        .bind(i64::from(tally.staff))
        .bind(id)
        .fetch_one(&mut *tx)
        .await?
        .try_get(0)?;
    if let Some(at) = &audit_at
        && tally.count() > 0
    {
        let entry = audit_entry(at, &username, &tally, deleted, &scope);
        match audit_id {
            Some(entry_id) => audit::rewrite(&mut tx, entry_id, entry).await?,
            None => {
                let entry_id = audit::record_id(&mut tx, entry).await?;
                sqlx::query("UPDATE bulk_delete_jobs SET audit_id = $1 WHERE id = $2")
                    .bind(entry_id)
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
            }
        }
    }
    tx.commit().await?;
    announce(state, &place, picked, &gone_rows).await;
    if let Some(job) = load_job(db, id).await? {
        progress(state, &username, job);
    }
    Ok(true)
}

/// Takes over running jobs whose runner stopped reporting (a restart, a crashed process) and
/// runs them here. Returns how many it took.
pub async fn resume_jobs(state: &AppState) -> sqlx::Result<u64> {
    let t = now();
    let rows = sqlx::query("SELECT id, claimed_at FROM bulk_delete_jobs WHERE status = 'running' AND claimed_at < $1 ORDER BY id LIMIT 50")
        .bind(t - JOB_LEASE)
        .fetch_all(&state.db)
        .await?;
    let mut taken = 0;
    for r in &rows {
        let (id, claimed): (i64, i64) = (r.try_get(0)?, r.try_get(1)?);
        let won = sqlx::query("UPDATE bulk_delete_jobs SET claimed_at = $1 WHERE id = $2 AND status = 'running' AND claimed_at = $3")
            .bind(t)
            .bind(id)
            .bind(claimed)
            .execute(&state.db)
            .await?
            .rows_affected();
        if won == 1 {
            spawn_job(state, id);
            taken += 1;
        }
    }
    Ok(taken)
}

#[cfg(test)]
pub(crate) fn tally_for_tests(authors: &[(&str, i64)], unnamed: i64) -> (Value, i64) {
    let mut t = Tally::default();
    for (name, n) in authors {
        t.add(name, *n);
    }
    t.unnamed += unnamed;
    t.details()
}

#[cfg(test)]
mod tests;
