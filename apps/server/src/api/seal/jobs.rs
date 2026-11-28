//! Jobs over the stored messages of one place: encrypting what a place that stores messages
//! encrypted kept plain from before ("Also encrypt earlier messages"), and the site's own way
//! back, storing encrypted messages plain again before keys are removed.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;

use axum::Json;
use axum::extract::{Path, Query, State};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use utoipa::{IntoParams, ToSchema};

use super::make_ready;
use super::sweep::seal_row;
use crate::api::access::perms::Perm;
use crate::api::access::{Proof, not_found, resolve_dm, resolve_server};
use crate::api::reauth::{AuthedSession, Purpose, ReAuth, ReAuthBody, check};
use crate::api::{ApiError, ApiErrorBody, Authed, bad};
use crate::crypt::body::{OPTIONS, Opener, POLLS, Parts, SNAPSHOTS, Scope};
use crate::crypt::copies::{self, BACKUPS, BIOS, DELIVERIES, SERVER_BIOS};
use crate::db::{Db, User, is_sqlite, now, pool_key};
use crate::state::AppState;
use crate::ws::WsEvent;

/// Messages one step of a job reads.
pub const BATCH: i64 = 2048;
/// Rows of the copies (bios, reports, deliveries, backups) one step of a job reads.
const COPIES_BATCH: i64 = 500;
const PAUSE: Duration = Duration::from_millis(100);
const RETRIES: u32 = 3;

pub(crate) const BAD_PLACE: &str = "place must be s:<server>, d:<dm id> or *";

/// What a job does to the stored messages of its place.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    /// Stores encrypted what the place stored plain before it encrypted new messages.
    Seal,
    /// Stores encrypted messages plain again.
    Unseal,
}

impl Direction {
    fn as_str(self) -> &'static str {
        match self {
            Direction::Seal => "seal",
            Direction::Unseal => "unseal",
        }
    }

    fn parse(text: &str) -> Option<Direction> {
        match text {
            "seal" => Some(Direction::Seal),
            "unseal" => Some(Direction::Unseal),
            _ => None,
        }
    }
}

/// Where a job is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Running,
    Done,
    Failed,
}

impl JobState {
    fn parse(text: &str) -> Option<JobState> {
        match text {
            "running" => Some(JobState::Running),
            "done" => Some(JobState::Done),
            "failed" => Some(JobState::Failed),
            _ => None,
        }
    }
}

/// A job over the stored messages of one place.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct SealJob {
    /// The job's id.
    pub id: i64,
    /// `s:<server>`, `d:<dm id>` or `*` (every place).
    #[schema(example = "s:club")]
    pub place: String,
    /// What it does.
    pub direction: Direction,
    /// The newest message id when the job started: it covers messages up to it.
    pub upto: i64,
    /// The message id it has finished up to.
    pub done: i64,
    /// The message id before the first one of the place it covers, while it runs (0 once it
    /// ended): how far it got is `(done - from) / (upto - from)`.
    #[serde(default)]
    pub from: i64,
    /// Whether it runs, ended, or stopped on an error.
    pub state: JobState,
    /// Unix seconds.
    pub created_at: i64,
    /// Unix seconds, once it ended.
    pub finished_at: Option<i64>,
}

/// The place of a job.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Target {
    Server(String),
    Dm(i64),
    All,
}

impl Target {
    pub(crate) fn parse(text: &str) -> Option<Target> {
        match text.split_once(':') {
            None if text == "*" => Some(Target::All),
            Some(("s", name)) if !name.is_empty() => Some(Target::Server(name.to_lowercase())),
            Some(("d", id)) => id.parse().ok().filter(|id| *id > 0).map(Target::Dm),
            _ => None,
        }
    }

    pub(crate) fn key(&self) -> String {
        match self {
            Target::Server(name) => format!("s:{name}"),
            Target::Dm(id) => format!("d:{id}"),
            Target::All => "*".to_string(),
        }
    }

    /// The SQL condition on `messages` of this place, and its bind.
    fn messages(&self) -> (&'static str, Option<Bind>) {
        match self {
            Target::Server(name) => (
                "channel_id IN (SELECT id FROM channels WHERE server = $4)",
                Some(Bind::Text(name.clone())),
            ),
            Target::Dm(id) => ("dm_id = $4", Some(Bind::Int(*id))),
            Target::All => ("(channel_id IS NOT NULL OR dm_id IS NOT NULL)", None),
        }
    }
}

enum Bind {
    Text(String),
    Int(i64),
}

/// Starting a job.
#[derive(Deserialize, ToSchema)]
pub struct NewSealJob {
    /// `s:<server>`, `d:<dm id>` or `*` (every place).
    pub place: String,
    /// What it does.
    pub direction: Direction,
    /// Confirms it is you.
    pub reauth: ReAuthBody,
}

/// Jobs of one place.
#[derive(Debug, Default, Deserialize, IntoParams)]
pub struct JobsQuery {
    /// `s:<server>`, `d:<dm id>` or `*`.
    pub place: String,
}

/// Whether `user` may run and see jobs of `target` in `direction`: Manage server for a server,
/// a participant for a DM, the site admin for every place and for every decryption. Others get
/// the uniform 404.
async fn allowed(
    db: &Db,
    user: &User,
    target: &Target,
    direction: Direction,
) -> Result<(), ApiError> {
    if direction == Direction::Unseal || *target == Target::All {
        return match user.is_site_admin {
            true => Ok(()),
            false => Err(not_found()),
        };
    }
    match target {
        Target::Server(name) => {
            let access = resolve_server(db, name, Some(user), &Proof::none()).await?;
            access.require_perm(db, Perm::ManageServer).await
        }
        Target::Dm(id) => resolve_dm(db, *id, user).await.map(|_| ()),
        Target::All => Err(not_found()),
    }
}

const COLS: &str = "id, place, direction, upto_id, done_id, state, created_at, finished_at, started_by, (SELECT value FROM settings WHERE key = 'seal_job_from:' || CAST(seal_jobs.id AS TEXT))";

/// The `settings` key holding where job `id` starts, while it runs.
fn from_key(id: i64) -> String {
    format!("seal_job_from:{id}")
}

fn job_of(r: &sqlx::any::AnyRow) -> Result<(SealJob, Option<String>), ApiError> {
    let wrong = |what: &str, v: &str| ApiError::internal(format!("a seal job has the {what} {v}"));
    let direction: String = r.try_get(2)?;
    let state: String = r.try_get(5)?;
    Ok((
        SealJob {
            id: r.try_get(0)?,
            place: r.try_get(1)?,
            direction: Direction::parse(&direction)
                .ok_or_else(|| wrong("direction", &direction))?,
            upto: r.try_get(3)?,
            done: r.try_get(4)?,
            from: r
                .try_get::<Option<String>, _>(9)?
                .and_then(|v| v.parse().ok())
                .unwrap_or(0),
            state: JobState::parse(&state).ok_or_else(|| wrong("state", &state))?,
            created_at: r.try_get(6)?,
            finished_at: r.try_get(7)?,
        },
        r.try_get(8)?,
    ))
}

async fn load(db: &Db, id: i64) -> Result<Option<(SealJob, Option<String>)>, ApiError> {
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {COLS} FROM seal_jobs WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(db)
    .await?;
    row.as_ref().map(job_of).transpose()
}

/// The newest jobs of every place, for the admin page.
pub(crate) async fn recent(db: &Db) -> Result<Vec<SealJob>, ApiError> {
    let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {COLS} FROM seal_jobs ORDER BY id DESC LIMIT 10"
    )))
    .fetch_all(db)
    .await?;
    rows.iter().map(|r| job_of(r).map(|(job, _)| job)).collect()
}

/// The newest message id of `target`.
async fn newest(db: &Db, target: &Target) -> Result<i64, ApiError> {
    let (cond, bind) = target.messages();
    let sql = format!(
        "SELECT COALESCE(MAX(id), 0) FROM messages WHERE {} ",
        cond.replace("$4", "$1")
    );
    let query = sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(sql));
    let query = match bind {
        Some(Bind::Text(v)) => query.bind(v),
        Some(Bind::Int(v)) => query.bind(v),
        None => query,
    };
    Ok(query.fetch_one(db).await?)
}

/// Start a job over stored messages
///
/// Starts encrypting the messages a place stored plain before it began storing new messages
/// encrypted (`seal`: the earlier messages of a server for a member with Manage server, of a DM
/// for a participant; only a place that stores new messages encrypted is touched). Their files
/// go with them. Other places and directions are for this site's staff; anyone else gets the
/// uniform 404. It confirms it is you with `reauth`. One job per place and
/// direction runs at a time: asking again answers the running one. Progress arrives as
/// `seal_job_progress` WebSocket events to your own connections. General rate-limit bucket.
#[utoipa::path(post, path = "/api/v1/seal_jobs", tag = "Encryption", request_body = NewSealJob, responses((status = 200, description = "The job, started or already running", body = SealJob), (status = 400, description = "`place must be s:<server>, d:<dm id> or *`, or not exactly one way to confirm in `reauth`", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token, `Wrong password`, `Wrong backup phrase`, or `Confirm with your password`", body = ApiErrorBody), (status = 403, description = "`Missing permission`: no Manage server in the server", body = ApiErrorBody), (status = 404, description = "`Not found`: a server or DM you have no access to, or a job you may not start; identical responses", body = ApiErrorBody), (status = 409, description = "`This site needs an encryption key first` or `Not available while this site updates` (reason `keys`): encrypting needs a key every copy holds", body = ApiErrorBody), (status = 423, description = "Changes from this session locked for the day (UTC) after 50 wrong passwords or phrases", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket, or less than 3 seconds since this session's last try", body = ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn start_job(
    State(state): State<AppState>,
    AuthedSession(session): AuthedSession,
    Json(NewSealJob {
        place,
        direction,
        reauth,
    }): Json<NewSealJob>,
) -> Result<Json<SealJob>, ApiError> {
    let target = Target::parse(&place).ok_or_else(|| bad(BAD_PLACE))?;
    allowed(&state.db, &session.user, &target, direction).await?;
    let purpose = Purpose::SealData {
        place: target.key(),
    };
    check(&state, &session, ReAuth::try_from(reauth)?, purpose).await?;
    if direction == Direction::Seal {
        make_ready(&state).await?;
    }
    let job = begin(&state, &target, direction, Some(&session.user.username)).await?;
    spawn_job(&state, job.id);
    Ok(Json(job))
}

/// The running job of `target` in `direction`, or a new one.
pub(crate) async fn begin(
    state: &AppState,
    target: &Target,
    direction: Direction,
    by: Option<&str>,
) -> Result<SealJob, ApiError> {
    let db = &state.db;
    let upto = newest(db, target).await?;
    let key = target.key();
    sqlx::query("INSERT INTO seal_jobs(place, direction, upto_id, started_by, created_at) SELECT $1, $2, $3, $4, $5 WHERE NOT EXISTS (SELECT 1 FROM seal_jobs WHERE place = $1 AND direction = $2 AND state = 'running') ON CONFLICT DO NOTHING")
        .bind(&key)
        .bind(direction.as_str())
        .bind(upto)
        .bind(by)
        .bind(state.clock.unix())
        .execute(db)
        .await?;
    let pick = format!(
        "SELECT {COLS} FROM seal_jobs WHERE place = $1 AND direction = $2 ORDER BY (CASE WHEN state = 'running' THEN 0 ELSE 1 END), id DESC LIMIT 1"
    );
    let row = sqlx::query(sqlx::AssertSqlSafe(pick.clone()))
        .bind(&key)
        .bind(direction.as_str())
        .fetch_one(db)
        .await?;
    let (job, _) = job_of(&row)?;
    if job.state != JobState::Running || job.from != 0 {
        return Ok(job);
    }
    sqlx::query("INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO NOTHING")
        .bind(from_key(job.id))
        .bind(before_first(db, target, job.upto).await?.to_string())
        .execute(db)
        .await?;
    let row = sqlx::query(sqlx::AssertSqlSafe(pick))
        .bind(&key)
        .bind(direction.as_str())
        .fetch_one(db)
        .await?;
    Ok(job_of(&row)?.0)
}

/// The message id before the first one of `target` up to `upto`; `upto` when there is none.
async fn before_first(db: &Db, target: &Target, upto: i64) -> Result<i64, ApiError> {
    let (cond, bind) = target.messages();
    let sql = format!(
        "SELECT COALESCE(MIN(id) - 1, $1) FROM messages WHERE id <= $1 AND {}",
        cond.replace("$4", "$2")
    );
    let query = sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(sql)).bind(upto);
    let query = match bind {
        Some(Bind::Text(v)) => query.bind(v),
        Some(Bind::Int(v)) => query.bind(v),
        None => query,
    };
    Ok(query.fetch_one(db).await?)
}

/// Get a job over stored messages
///
/// A job started with `POST /api/v1/seal_jobs`, for whoever may start one like it. General
/// rate-limit bucket.
#[utoipa::path(get, path = "/api/v1/seal_jobs/{id}", tag = "Encryption", params(("id" = i64, Path, description = "Job id")), responses((status = 200, description = "The job", body = SealJob), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 404, description = "`Not found`: no such job, or one you may not run; identical responses", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn get_job(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(id): Path<i64>,
) -> Result<Json<SealJob>, ApiError> {
    let (job, _) = load(&state.db, id).await?.ok_or_else(not_found)?;
    let target = Target::parse(&job.place).ok_or_else(not_found)?;
    allowed(&state.db, &user, &target, job.direction)
        .await
        .map_err(|_| not_found())?;
    Ok(Json(job))
}

/// List the jobs of a place
///
/// The newest 10 jobs over the stored messages of `place` that you may run, newest first.
/// General rate-limit bucket.
#[utoipa::path(get, path = "/api/v1/seal_jobs", operation_id = "list_seal_jobs", tag = "Encryption", params(JobsQuery), responses((status = 200, description = "The jobs, newest first", body = Vec<SealJob>), (status = 400, description = "`place must be s:<server>, d:<dm id> or *`", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 404, description = "`Not found`: a server or DM you have no access to; identical responses", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn list_jobs(
    State(state): State<AppState>,
    Authed(user): Authed,
    Query(JobsQuery { place }): Query<JobsQuery>,
) -> Result<Json<Vec<SealJob>>, ApiError> {
    let target = Target::parse(&place).ok_or_else(|| bad(BAD_PLACE))?;
    let unseal = allowed(&state.db, &user, &target, Direction::Unseal)
        .await
        .is_ok();
    allowed(&state.db, &user, &target, Direction::Seal)
        .await
        .map_err(|_| not_found())?;
    let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {COLS} FROM seal_jobs WHERE place = $1 ORDER BY id DESC LIMIT 10"
    )))
    .bind(target.key())
    .fetch_all(&state.db)
    .await?;
    let mut out = Vec::new();
    for r in &rows {
        let (job, _) = job_of(r)?;
        if job.direction == Direction::Seal || unseal {
            out.push(job);
        }
    }
    Ok(Json(out))
}

static RUNNING: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// This process, as the runner of the jobs it holds.
static RUNNER: std::sync::LazyLock<String> =
    std::sync::LazyLock::new(|| hex::encode(rand::random::<[u8; 8]>()));

/// Seconds a runner holds a job after it last said it still runs it.
const LEASE: i64 = 900;

/// Takes or keeps job `id` for this process: false while another process holds it.
async fn hold(db: &Db, id: i64) -> Result<bool, ApiError> {
    let t = now();
    let held = sqlx::query("UPDATE seal_jobs SET runner = $1, lease_until = $2 WHERE id = $3 AND state = 'running' AND (runner IS NULL OR runner = $1 OR lease_until < $4)")
        .bind(RUNNER.as_str())
        .bind(t + LEASE)
        .bind(id)
        .bind(t)
        .execute(db)
        .await?
        .rows_affected();
    Ok(held == 1)
}

fn running_key(db: &Db, id: i64) -> String {
    format!("{}\n{id}", pool_key(db))
}

/// Runs job `id` in the background unless this process already runs it.
pub(crate) fn spawn_job(state: &AppState, id: i64) {
    let state = state.clone();
    tokio::spawn(async move {
        run_job(&state, id).await;
    });
}

/// Runs every running job, at start.
pub(crate) async fn resume_jobs(state: &AppState) -> sqlx::Result<()> {
    let ids: Vec<i64> =
        sqlx::query_scalar("SELECT id FROM seal_jobs WHERE state = 'running' ORDER BY id")
            .fetch_all(&state.db)
            .await?;
    for id in ids {
        spawn_job(state, id);
    }
    Ok(())
}

/// Runs job `id` to its end, unless another process runs it. Returns whether this one did.
pub(crate) async fn run_job(state: &AppState, id: i64) -> bool {
    let key = running_key(&state.db, id);
    {
        let mut running = RUNNING.lock().unwrap_or_else(|p| p.into_inner());
        if !running.get_or_insert_with(HashSet::new).insert(key.clone()) {
            return false;
        }
    }
    let mut errors = 0;
    let mut ran = false;
    loop {
        match hold(&state.db, id).await {
            Ok(true) => ran = true,
            Ok(false) => break,
            Err(e) => {
                tracing::warn!("seal job {id} could not be held: {}", e.1);
                break;
            }
        }
        match step(state, id).await {
            Ok(true) => {
                errors = 0;
                tokio::time::sleep(PAUSE).await;
            }
            Ok(false) => break,
            Err(e) if errors < RETRIES => {
                errors += 1;
                tracing::warn!("seal job {id} step failed, trying again: {}", e.1);
                tokio::time::sleep(PAUSE * 10 * 2u32.pow(errors)).await;
            }
            Err(e) => {
                tracing::warn!("seal job {id} failed: {}", e.1);
                if let Err(e) = end(state, id, JobState::Failed).await {
                    tracing::warn!("marking seal job {id} failed did not work: {}", e.1);
                }
                break;
            }
        }
    }
    if let Some(running) = RUNNING.lock().unwrap_or_else(|p| p.into_inner()).as_mut() {
        running.remove(&key);
    }
    ran
}

async fn end(state: &AppState, id: i64, to: JobState) -> Result<(), ApiError> {
    let word = match to {
        JobState::Running => "running",
        JobState::Done => "done",
        JobState::Failed => "failed",
    };
    let ended = sqlx::query(
        "UPDATE seal_jobs SET state = $1, finished_at = $2 WHERE id = $3 AND state = 'running' AND runner = $4",
    )
    .bind(word)
    .bind(state.clock.unix())
    .bind(id)
    .bind(RUNNER.as_str())
    .execute(&state.db)
    .await?
    .rows_affected();
    if ended == 1 {
        sqlx::query("DELETE FROM settings WHERE key = $1")
            .bind(from_key(id))
            .execute(&state.db)
            .await?;
    }
    announce(state, id).await
}

async fn announce(state: &AppState, id: i64) -> Result<(), ApiError> {
    if let Some((job, Some(username))) = load(&state.db, id).await? {
        state
            .hub
            .broadcast(WsEvent::SealJobProgress { username, job });
    }
    Ok(())
}

/// One step of job `id`: a batch of its messages and their files, then its extras once the
/// messages are done. False once the job has ended.
async fn step(state: &AppState, id: i64) -> Result<bool, ApiError> {
    let db = &state.db;
    let Some((job, _)) = load(db, id).await? else {
        return Ok(false);
    };
    if job.state != JobState::Running {
        return Ok(false);
    }
    let target = Target::parse(&job.place).ok_or_else(|| bad(BAD_PLACE))?;
    let (cond, bind) = target.messages();
    let form = match job.direction {
        Direction::Seal => "body IS NULL AND kind IN ('user', 'poll')",
        Direction::Unseal => "body IS NOT NULL",
    };
    let sql = format!(
        "SELECT id FROM messages WHERE id > $1 AND id <= $2 AND {form} AND {cond} ORDER BY id LIMIT $3"
    );
    let query = sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(sql))
        .bind(job.done)
        .bind(job.upto)
        .bind(BATCH);
    let query = match bind {
        Some(Bind::Text(v)) => query.bind(v),
        Some(Bind::Int(v)) => query.bind(v),
        None => query,
    };
    let ids = query.fetch_all(db).await?;
    let mut left = Vec::new();
    for message in &ids {
        if let Err(e) = retried(|| row(db, *message, job.direction)).await {
            left.push(e);
        }
    }
    if !ids.is_empty() && left.len() == ids.len() {
        return Err(left.swap_remove(0));
    }
    for e in &left {
        tracing::warn!("seal job {id} left a message as it is: {}", e.1);
    }
    files(state, id, &ids, job.direction).await?;
    let last = match ids.last() {
        Some(last) if (ids.len() as i64) == BATCH => *last,
        _ => job.upto,
    };
    sqlx::query(
        "UPDATE seal_jobs SET done_id = $1 WHERE id = $2 AND state = 'running' AND runner = $3",
    )
    .bind(last)
    .bind(id)
    .bind(RUNNER.as_str())
    .execute(db)
    .await?;
    scrubbed(db).await;
    if last < job.upto {
        announce(state, id).await?;
        return Ok(true);
    }
    match job.direction {
        Direction::Seal => {
            crate::api::scheduled::seal_pending(db).await?;
        }
        Direction::Unseal => {
            sealed_files(state, id, &target).await?;
            crate::api::scheduled::unseal_pending(db, &target).await?;
        }
    }
    server_bios(db, &target, job.direction).await?;
    if target == Target::All {
        extras(state, job.direction).await?;
    }
    end(state, id, JobState::Done).await?;
    Ok(false)
}

async fn row(db: &Db, id: i64, direction: Direction) -> Result<bool, ApiError> {
    match direction {
        Direction::Seal => seal_row(db, id, true).await,
        Direction::Unseal => unseal_row(db, id).await,
    }
}

/// `work`, tried again once after a pause when it fails.
async fn retried<T, F, W>(work: W) -> Result<T, ApiError>
where
    W: Fn() -> F,
    F: std::future::Future<Output = Result<T, ApiError>>,
{
    match work().await {
        Ok(v) => Ok(v),
        Err(_) => {
            tokio::time::sleep(PAUSE).await;
            work().await
        }
    }
}

/// On SQLite, the pages a batch freed are wiped from the write-ahead log too.
async fn scrubbed(db: &Db) {
    if !is_sqlite(db) {
        return;
    }
    for pause in [true, false] {
        match sqlx::query_scalar::<_, i64>("PRAGMA wal_checkpoint(TRUNCATE)")
            .fetch_one(db)
            .await
        {
            Ok(0) => return,
            Ok(_) if pause => tokio::time::sleep(PAUSE).await,
            Ok(_) => {
                tracing::warn!("the write-ahead log was in use and could not be truncated yet")
            }
            Err(e) => return tracing::warn!("the write-ahead log could not be truncated: {e}"),
        }
    }
}

/// The files the messages `ids` carry follow them: sealed when their message is, plain again
/// when it is not. A file that fails twice is left as it is.
async fn files(
    state: &AppState,
    job: i64,
    ids: &[i64],
    direction: Direction,
) -> Result<(), ApiError> {
    if ids.is_empty() {
        return Ok(());
    }
    let list = crate::api::placeholders(1, ids.len());
    let form = match direction {
        Direction::Seal => "body IS NOT NULL",
        Direction::Unseal => "body IS NULL",
    };
    let sql = format!(
        "SELECT DISTINCT media_id FROM messages WHERE id IN ({list}) AND media_kind = 'server' AND media_id IS NOT NULL AND {form}"
    );
    let mut query = sqlx::query_scalar::<_, String>(sqlx::AssertSqlSafe(sql));
    for id in ids {
        query = query.bind(*id);
    }
    for media in query.fetch_all(&state.db).await? {
        file(state, job, &media, direction).await;
    }
    Ok(())
}

async fn file(state: &AppState, job: i64, media: &str, direction: Direction) {
    let done = retried(|| async {
        match direction {
            Direction::Seal => crate::api::media::sealed::seal_now(state, media).await,
            Direction::Unseal => crate::api::media::sealed::unseal_now(state, media).await,
        }
    })
    .await;
    if let Err(e) = done {
        tracing::warn!("seal job {job} left the file {media} as it is: {}", e.1);
    }
}

/// Files of `target` stored encrypted: every one a message of the place carries, whatever that
/// message's own form, and on every place the ones no message carries too. Each is stored plain
/// again.
async fn sealed_files(state: &AppState, job: i64, target: &Target) -> Result<(), ApiError> {
    let (cond, bind) = target.messages();
    let sql = match target {
        Target::All => {
            "SELECT id FROM media WHERE seal_key IS NOT NULL AND id > $1 ORDER BY id LIMIT $2"
                .to_string()
        }
        Target::Server(_) | Target::Dm(_) => format!(
            "SELECT id FROM media WHERE seal_key IS NOT NULL AND id > $1 AND id IN (SELECT media_id FROM messages WHERE media_kind = 'server' AND media_id IS NOT NULL AND {}) ORDER BY id LIMIT $2",
            cond.replace("$4", "$3")
        ),
    };
    let mut after = String::new();
    loop {
        let query = sqlx::query_scalar::<_, String>(sqlx::AssertSqlSafe(sql.clone()))
            .bind(&after)
            .bind(COPIES_BATCH);
        let query = match &bind {
            Some(Bind::Text(v)) => query.bind(v.clone()),
            Some(Bind::Int(v)) => query.bind(*v),
            None => query,
        };
        let ids = query.fetch_all(&state.db).await?;
        for media in &ids {
            file(state, job, media, Direction::Unseal).await;
        }
        if !hold(&state.db, job).await? {
            return Ok(());
        }
        match ids.last() {
            Some(last) if (ids.len() as i64) == COPIES_BATCH => after = last.clone(),
            _ => return Ok(()),
        }
    }
}

/// Stores the message `id` and its poll plain again, while its record holds what was read. A
/// record that does not open stays. Returns whether it was written.
pub(crate) async fn unseal_row(db: &Db, id: i64) -> Result<bool, ApiError> {
    let sqlite = is_sqlite(db);
    let row = sqlx::query(
        "SELECT channel_id, dm_id, author, body FROM messages WHERE id = $1 AND body IS NOT NULL",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    let Some(row) = row else {
        return Ok(false);
    };
    let scope = Scope::of(row.try_get(0)?, row.try_get(1)?);
    let author: String = row.try_get(2)?;
    let record: Vec<u8> = row.try_get(3)?;
    let polls = sqlx::query("SELECT body FROM polls WHERE message_id = $1 AND body IS NOT NULL")
        .bind(id)
        .fetch_optional(db)
        .await?;
    let options: Vec<(i64, Vec<u8>)> = sqlx::query_as(
        "SELECT id, body FROM poll_options WHERE message_id = $1 AND body IS NOT NULL",
    )
    .bind(id)
    .fetch_all(db)
    .await?;
    let snapshot: Option<Vec<u8>> = sqlx::query_scalar(
        "SELECT body FROM poll_snapshots WHERE message_id = $1 AND body IS NOT NULL",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    let poll: Option<Vec<u8>> = polls.map(|r| r.try_get(0)).transpose()?;
    let records = std::iter::once(record.as_slice())
        .chain(poll.as_deref())
        .chain(options.iter().map(|(_, b)| b.as_slice()))
        .chain(snapshot.as_deref());
    let opener = Opener::of(db, records).await?;
    let opened = opener.message(id, scope, &author, Some(&record), Parts::default());
    if opened.unreadable {
        return Ok(false);
    }
    let question = match &poll {
        Some(body) => match opener.opened_text(POLLS, id, scope, body) {
            Some(text) => Some((body, text)),
            None => return Ok(false),
        },
        None => None,
    };
    let mut choices = Vec::with_capacity(options.len());
    for (option, body) in &options {
        match opener.opened_text(OPTIONS, *option, scope, body) {
            Some(text) => choices.push((*option, body, text)),
            None => return Ok(false),
        }
    }
    let data = match &snapshot {
        Some(body) => match opener.opened_text(SNAPSHOTS, id, scope, body) {
            Some(text) => Some((body, text)),
            None => return Ok(false),
        },
        None => None,
    };
    let Parts {
        content,
        embeds,
        filename,
        dropped,
        alt,
    } = opened.parts;
    let mut tx = match sqlite {
        true => db.begin_with("BEGIN IMMEDIATE").await?,
        false => db.begin().await?,
    };
    let grams = match sqlite {
        true => "",
        false => ", grams = NULL",
    };
    let written = sqlx::query(sqlx::AssertSqlSafe(format!("UPDATE messages SET content = $1, webhook_embeds = $2, media_filename = $3, fwd_dropped = $4, media_alt = $7, body = NULL{grams} WHERE id = $5 AND body = $6")))
        .bind(&content)
        .bind(&embeds)
        .bind(&filename)
        .bind(&dropped)
        .bind(id)
        .bind(&record)
        .bind(&alt)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if written == 0 {
        return Ok(false);
    }
    if let Some((body, question)) = question {
        sqlx::query(
            "UPDATE polls SET question = $1, body = NULL WHERE message_id = $2 AND body = $3",
        )
        .bind(question)
        .bind(id)
        .bind(body)
        .execute(&mut *tx)
        .await?;
    }
    for (option, body, text) in choices {
        sqlx::query("UPDATE poll_options SET text = $1, body = NULL WHERE id = $2 AND body = $3")
            .bind(text)
            .bind(option)
            .bind(body)
            .execute(&mut *tx)
            .await?;
    }
    if let Some((body, data)) = data {
        sqlx::query(
            "UPDATE poll_snapshots SET data = $1, body = NULL WHERE message_id = $2 AND body = $3",
        )
        .bind(data)
        .bind(id)
        .bind(body)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(true)
}

/// What `target` still stores encrypted: messages, their files, and on every place the files
/// no message carries and the encrypted copies.
pub(crate) async fn still_sealed(db: &Db, target: &Target) -> Result<i64, ApiError> {
    let (cond, bind) = target.messages();
    let cond = cond.replace("$4", "$1");
    let mut sqls = vec![format!(
        "SELECT COUNT(*) FROM messages WHERE body IS NOT NULL AND {cond}"
    )];
    match target {
        Target::All => sqls.extend(
            [
                "SELECT COUNT(*) FROM media WHERE seal_key IS NOT NULL",
                "SELECT COUNT(*) FROM users WHERE bio_sealed IS NOT NULL",
                "SELECT COUNT(*) FROM member_profiles WHERE bio_sealed IS NOT NULL",
                "SELECT COUNT(*) FROM reports WHERE sealed IS NOT NULL",
                "SELECT COUNT(*) FROM report_events WHERE detail_sealed IS NOT NULL",
                "SELECT COUNT(*) FROM webhook_deliveries WHERE payload_sealed IS NOT NULL",
                "SELECT COUNT(*) FROM p2p_backups WHERE data_sealed IS NOT NULL",
            ]
            .map(str::to_string),
        ),
        Target::Server(_) | Target::Dm(_) => sqls.push(format!(
            "SELECT COUNT(*) FROM media WHERE seal_key IS NOT NULL AND id IN (SELECT media_id FROM messages WHERE media_kind = 'server' AND media_id IS NOT NULL AND {cond})"
        )),
    }
    if let Target::Server(_) = target {
        sqls.push(
            "SELECT COUNT(*) FROM member_profiles WHERE bio_sealed IS NOT NULL AND server = $1"
                .to_string(),
        );
    }
    let mut left = crate::api::scheduled::still_sealed(db, target).await?;
    for sql in sqls {
        let query = sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(sql));
        let query = match (&bind, target) {
            (_, Target::All) => query,
            (Some(Bind::Text(v)), _) => query.bind(v.clone()),
            (Some(Bind::Int(v)), _) => query.bind(*v),
            (None, _) => query,
        };
        left += query.fetch_one(db).await?;
    }
    Ok(left)
}

/// The servers whose profile descriptions a job over `target` covers, as a condition on
/// `member_profiles` with its bind at `$3`. A DM has none.
fn profile_servers(target: &Target) -> Option<(&'static str, Option<&str>)> {
    match target {
        Target::Server(name) => Some(("server = $3", Some(name))),
        Target::All => Some(("$3 = ''", None)),
        Target::Dm(_) => None,
    }
}

/// A server profile's server, username, plain description and its record.
type BioRow = (String, String, Option<String>, Option<Vec<u8>>);

const BIO_KEYSET: &str = "(server > $1 OR (server = $1 AND username > $2))";

/// What a job does to the descriptions of the server profiles of its place once its messages
/// are done: encrypts the plain ones of the servers that are stored encrypted, or stores the
/// encrypted ones plain again. One that does not open stays.
async fn server_bios(db: &Db, target: &Target, direction: Direction) -> Result<(), ApiError> {
    let Some((cond, name)) = profile_servers(target) else {
        return Ok(());
    };
    let form = match direction {
        Direction::Seal => "bio IS NOT NULL AND bio_sealed IS NULL",
        Direction::Unseal => "bio_sealed IS NOT NULL",
    };
    let sql = format!(
        "SELECT server, username, bio, bio_sealed FROM member_profiles WHERE {form} AND {cond} AND {BIO_KEYSET} ORDER BY server, username LIMIT $4"
    );
    let mut after = (String::new(), String::new());
    let mut sealers: HashMap<String, Option<copies::Sealer>> = HashMap::new();
    loop {
        let rows: Vec<BioRow> = sqlx::query_as(sqlx::AssertSqlSafe(sql.clone()))
            .bind(&after.0)
            .bind(&after.1)
            .bind(name.unwrap_or(""))
            .bind(COPIES_BATCH)
            .fetch_all(db)
            .await?;
        let opener = copies::Opener::of(db, rows.iter().filter_map(|(.., r)| r.as_deref())).await?;
        for (server, username, bio, record) in &rows {
            let binding = copies::server_bio_binding(server, username);
            match (direction, bio, record) {
                (Direction::Seal, Some(bio), None) => {
                    if !sealers.contains_key(server) {
                        let mut conn = db.acquire().await?;
                        let source = super::Source::Server(server);
                        let sealer = super::copy_sealer_of(db, &mut conn, source).await?;
                        sealers.insert(server.clone(), sealer);
                    }
                    let Some(Some(sealer)) = sealers.get(server) else {
                        continue;
                    };
                    sqlx::query("UPDATE member_profiles SET bio = NULL, bio_sealed = $1 WHERE server = $2 AND username = $3 AND bio = $4 AND bio_sealed IS NULL")
                        .bind(sealer.seal(SERVER_BIOS, &binding, bio.as_bytes()))
                        .bind(server)
                        .bind(username)
                        .bind(bio)
                        .execute(db)
                        .await?;
                }
                (Direction::Unseal, _, Some(record)) => {
                    let Some(bio) = opener.text(SERVER_BIOS, &binding, record) else {
                        continue;
                    };
                    sqlx::query("UPDATE member_profiles SET bio = $1, bio_sealed = NULL WHERE server = $2 AND username = $3 AND bio_sealed = $4")
                        .bind(bio)
                        .bind(server)
                        .bind(username)
                        .bind(record)
                        .execute(db)
                        .await?;
                }
                (Direction::Seal | Direction::Unseal, _, _) => {}
            }
        }
        match rows.last() {
            Some((server, username, ..)) if rows.len() as i64 == COPIES_BATCH => {
                after = (server.clone(), username.clone());
            }
            _ => return Ok(()),
        }
    }
}

/// What a job over every place does once its messages are done: account descriptions, and on
/// the way back the encrypted copies.
async fn extras(state: &AppState, direction: Direction) -> Result<(), ApiError> {
    let db = &state.db;
    match direction {
        Direction::Seal => seal_bios(db).await,
        Direction::Unseal => {
            unseal_bios(db).await?;
            crate::api::reports::unseal_copies(db, COPIES_BATCH).await?;
            unseal_deliveries(db).await?;
            unseal_backups(db).await
        }
    }
}

/// Encrypts the descriptions stored plain while the site requires encrypted storage.
async fn seal_bios(db: &Db) -> Result<(), ApiError> {
    let mut conn = db.acquire().await?;
    let floors = super::copy_place(&mut conn, is_sqlite(db), super::Source::Site).await?;
    let Some(sealer) = super::copy_sealer(db, &mut conn, floors).await? else {
        return Ok(());
    };
    drop(conn);
    let mut after = String::new();
    loop {
        let rows: Vec<(String, String)> = sqlx::query_as("SELECT username, bio FROM users WHERE bio IS NOT NULL AND bio_sealed IS NULL AND username > $1 ORDER BY username LIMIT $2")
            .bind(&after)
            .bind(COPIES_BATCH)
            .fetch_all(db)
            .await?;
        for (username, bio) in &rows {
            sqlx::query("UPDATE users SET bio = NULL, bio_sealed = $1 WHERE username = $2 AND bio = $3 AND bio_sealed IS NULL")
                .bind(sealer.seal(BIOS, username, bio.as_bytes()))
                .bind(username)
                .bind(bio)
                .execute(db)
                .await?;
        }
        match rows.last() {
            Some((last, _)) if rows.len() as i64 == COPIES_BATCH => after = last.clone(),
            _ => return Ok(()),
        }
    }
}

/// Stores the encrypted descriptions plain again; one that does not open stays.
async fn unseal_bios(db: &Db) -> Result<(), ApiError> {
    let mut after = String::new();
    loop {
        let rows: Vec<(String, Vec<u8>)> = sqlx::query_as("SELECT username, bio_sealed FROM users WHERE bio_sealed IS NOT NULL AND username > $1 ORDER BY username LIMIT $2")
            .bind(&after)
            .bind(COPIES_BATCH)
            .fetch_all(db)
            .await?;
        let opener = copies::Opener::of(db, rows.iter().map(|(_, r)| r.as_slice())).await?;
        for (username, record) in &rows {
            let Some(bio) = opener.text(BIOS, username, record) else {
                continue;
            };
            sqlx::query(
                "UPDATE users SET bio = $1, bio_sealed = NULL WHERE username = $2 AND bio_sealed = $3",
            )
            .bind(bio)
            .bind(username)
            .bind(record)
            .execute(db)
            .await?;
        }
        match rows.last() {
            Some((last, _)) if rows.len() as i64 == COPIES_BATCH => after = last.clone(),
            _ => return Ok(()),
        }
    }
}

/// Stores the encrypted delivery facts plain again; one that does not open stays.
async fn unseal_deliveries(db: &Db) -> Result<(), ApiError> {
    let mut after = 0;
    loop {
        let rows: Vec<(i64, Vec<u8>)> = sqlx::query_as("SELECT id, payload_sealed FROM webhook_deliveries WHERE payload_sealed IS NOT NULL AND id > $1 ORDER BY id LIMIT $2")
            .bind(after)
            .bind(COPIES_BATCH)
            .fetch_all(db)
            .await?;
        let opener = copies::Opener::of(db, rows.iter().map(|(_, r)| r.as_slice())).await?;
        for (id, record) in &rows {
            let Some(payload) = opener.text(DELIVERIES, &id.to_string(), record) else {
                continue;
            };
            sqlx::query("UPDATE webhook_deliveries SET payload = $1, payload_sealed = NULL WHERE id = $2 AND payload_sealed = $3")
                .bind(payload)
                .bind(id)
                .bind(record)
                .execute(db)
                .await?;
        }
        match rows.last() {
            Some((last, _)) if rows.len() as i64 == COPIES_BATCH => after = *last,
            _ => return Ok(()),
        }
    }
}

/// P2P backup versions read in one go: they are large.
const BACKUPS_BATCH: i64 = 10;

/// Stores the P2P backup versions stored encrypted plain again (they stay encrypted by their
/// client); one that does not open stays.
async fn unseal_backups(db: &Db) -> Result<(), ApiError> {
    let mut after = (String::new(), String::new(), -1i64);
    loop {
        let rows: Vec<(String, String, i64, Vec<u8>)> = sqlx::query_as("SELECT username, ik, version, data_sealed FROM p2p_backups WHERE data_sealed IS NOT NULL AND (username > $1 OR (username = $1 AND (ik > $2 OR (ik = $2 AND version > $3)))) ORDER BY username, ik, version LIMIT $4")
            .bind(&after.0)
            .bind(&after.1)
            .bind(after.2)
            .bind(BACKUPS_BATCH)
            .fetch_all(db)
            .await?;
        let opener = copies::Opener::of(db, rows.iter().map(|(.., r)| r.as_slice())).await?;
        for (username, ik, version, record) in &rows {
            let binding = copies::backup_binding(username, ik, *version);
            let Some(data) = opener.open(BACKUPS, &binding, record) else {
                continue;
            };
            sqlx::query("UPDATE p2p_backups SET data = $1, data_sealed = NULL WHERE username = $2 AND ik = $3 AND version = $4 AND data_sealed = $5")
                .bind(data.as_slice())
                .bind(username)
                .bind(ik)
                .bind(version)
                .bind(record)
                .execute(db)
                .await?;
        }
        match rows.last() {
            Some((username, ik, version, _)) if rows.len() as i64 == BACKUPS_BATCH => {
                after = (username.clone(), ik.clone(), *version)
            }
            _ => return Ok(()),
        }
    }
}

#[cfg(test)]
mod tests;
