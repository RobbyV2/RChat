use std::fmt::Write;

use axum::Json;
use axum::body::Body;
use axum::extract::multipart::MultipartRejection;
use axum::extract::{FromRequest, Multipart, Path, Request, State};
use axum::http::{StatusCode, header};
use axum::response::Response;
use rand::Rng;
use s3::Bucket;
use sqlx::Row;

use crate::api::access::{MsgScope, Proof, resolve_message};
use crate::api::audit;
use crate::api::{
    ApiError, ApiErrorBody, Authed, MediaRef, OkResp, Settings, allowed, bad, ok, placeholders,
    request_token, require_guest_ok, user_for_token,
};
use crate::db::{Db, MediaKind, User, now};
use crate::state::AppState;
use crate::ws::WsEvent;

pub(crate) const MEDIA_TTL_SECS: i64 = 86400;
/// Longest stored file name, in bytes.
pub(crate) const FILENAME_MAX: usize = 255;
/// Longest stored content type, in bytes.
pub(crate) const MIME_MAX: usize = 127;
const NEUTRAL_MIME: &str = "application/octet-stream";

/// The file name to store for an uploaded `raw` name: path parts, control and bidi-override
/// characters dropped, trimmed, cut on a character boundary to `FILENAME_MAX` bytes keeping a
/// short extension, `file` when nothing is left.
pub(crate) fn clean_filename(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or_default();
    let kept: String = base
        .chars()
        .filter(|c| !c.is_control() && !matches!(u32::from(*c), 0x202a..=0x202e | 0x2066..=0x2069))
        .collect();
    let name = kept.trim();
    if name.is_empty() || name == "." || name == ".." {
        return "file".to_string();
    }
    if name.len() <= FILENAME_MAX {
        return name.to_string();
    }
    let ext = match name.rfind('.') {
        Some(at) if at > 0 && name.len() - at <= 16 => &name[at..],
        Some(_) | None => "",
    };
    let mut stem = &name[..name.len() - ext.len()];
    let mut end = FILENAME_MAX - ext.len();
    while !stem.is_char_boundary(end) {
        end -= 1;
    }
    stem = stem[..end].trim_end();
    format!("{stem}{ext}")
}

fn mime_token(s: &str) -> bool {
    !s.is_empty()
        && s.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || matches!(
                    b,
                    b'!' | b'#' | b'$' | b'&' | b'^' | b'_' | b'.' | b'+' | b'-'
                )
        })
}

/// The content type to store for an uploaded `raw` one: `type/subtype` in lowercase without
/// parameters, at most `MIME_MAX` bytes; anything else becomes `application/octet-stream`.
pub(crate) fn clean_mime(raw: &str) -> String {
    let essence = raw
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    match essence.split_once('/') {
        Some((kind, sub)) if essence.len() <= MIME_MAX && mime_token(kind) && mime_token(sub) => {
            essence
        }
        Some(_) | None => NEUTRAL_MIME.to_string(),
    }
}

/// The operator's upload limits.
#[derive(Clone, Copy, Debug)]
pub struct UploadLimits {
    /// Most bytes of one account's files counted at once, each from its upload until it is
    /// removed, for at most `MEDIA_TTL_SECS`; 0 for no limit.
    pub budget: u64,
    /// Most bytes of upload bodies held in memory at once across all requests.
    pub buffer: u64,
}

impl Default for UploadLimits {
    fn default() -> UploadLimits {
        UploadLimits {
            budget: DEFAULT_BUDGET_MIB * 1024 * 1024,
            buffer: DEFAULT_BUFFER_MIB * 1024 * 1024,
        }
    }
}

pub const DEFAULT_BUDGET_MIB: u64 = 2048;
pub const DEFAULT_BUFFER_MIB: u64 = 256;

/// The upload limits in effect and the upload buffer sized from them.
struct Upload {
    limits: UploadLimits,
    /// Upload bodies in memory, counted in KiB.
    buffer: std::sync::Arc<tokio::sync::Semaphore>,
}

impl Upload {
    fn new(limits: UploadLimits) -> std::sync::Arc<Upload> {
        let kib = (limits.buffer / 1024).min(u32::MAX as u64);
        std::sync::Arc::new(Upload {
            limits,
            buffer: std::sync::Arc::new(tokio::sync::Semaphore::new(kib as usize)),
        })
    }
}

static UPLOAD: std::sync::LazyLock<std::sync::RwLock<std::sync::Arc<Upload>>> =
    std::sync::LazyLock::new(|| std::sync::RwLock::new(Upload::new(UploadLimits::default())));

/// Sets the upload limits at startup. A later start in the same process replaces them.
pub fn configure(limits: UploadLimits) {
    let upload = Upload::new(limits);
    match UPLOAD.write() {
        Ok(mut held) => *held = upload,
        Err(poisoned) => *poisoned.into_inner() = upload,
    }
}

fn upload() -> std::sync::Arc<Upload> {
    match UPLOAD.read() {
        Ok(held) => std::sync::Arc::clone(&held),
        Err(poisoned) => std::sync::Arc::clone(&poisoned.into_inner()),
    }
}

fn limits() -> UploadLimits {
    upload().limits
}

#[cfg(test)]
tokio::task_local! {
    static TEST_BUFFER: std::sync::Arc<tokio::sync::Semaphore>;
}

/// Runs `f` with `buffer` as the upload buffer.
#[cfg(test)]
pub(crate) async fn with_buffer<T>(
    buffer: std::sync::Arc<tokio::sync::Semaphore>,
    f: impl std::future::Future<Output = T>,
) -> T {
    TEST_BUFFER.scope(buffer, f).await
}

/// Upload bodies in memory, counted in KiB.
fn buffer() -> std::sync::Arc<tokio::sync::Semaphore> {
    #[cfg(test)]
    if let Ok(buffer) = TEST_BUFFER.try_with(std::sync::Arc::clone) {
        return buffer;
    }
    std::sync::Arc::clone(&upload().buffer)
}

/// The upload buffer, and the most KiB of it one account holds at once.
struct Room {
    buffer: std::sync::Arc<tokio::sync::Semaphore>,
    share: u32,
}

/// The KiB of a `buffer` of bytes one account holds at once, for upload bodies of at most `body`
/// bytes: a quarter of it, `UPLOADS_PER_ACCOUNT` bodies up to half of it, or one body up to all
/// of it, whichever is most.
fn share_kib(buffer: u64, body: usize) -> u32 {
    let kib = buffer / 1024;
    let one = (body as u64).div_ceil(1024);
    let all = one.saturating_mul(UPLOADS_PER_ACCOUNT as u64).min(kib / 2);
    (kib / 4).max(all).max(one.min(kib)).min(u32::MAX as u64) as u32
}

#[cfg(test)]
pub(crate) fn share_held(db: &Db, account: &str) -> u64 {
    SHARES.held(&format!("{}\n{account}", crate::db::pool_key(db)))
}

/// The KiB of the upload buffer each account holds.
static SHARES: std::sync::LazyLock<crate::api::budget::Shares> =
    std::sync::LazyLock::new(crate::api::budget::Shares::default);

const BUFFER_WAIT: std::time::Duration = std::time::Duration::from_secs(15);
/// How long an upload body may send nothing before it is dropped with 408.
const IDLE_WAIT: std::time::Duration = std::time::Duration::from_secs(30);
/// Longest an upload body may take to arrive.
const BODY_WAIT: std::time::Duration = std::time::Duration::from_secs(600);
/// Most upload bodies one account reads at once (its own uploads and those of its webhooks).
pub const UPLOADS_PER_ACCOUNT: usize = 3;

static READING: std::sync::LazyLock<crate::api::budget::Slots> =
    std::sync::LazyLock::new(|| crate::api::budget::Slots::new(UPLOADS_PER_ACCOUNT));

/// How long reading an upload body may wait, for tests to shorten.
#[derive(Clone, Copy)]
struct Waits {
    /// For room in the upload buffer.
    room: std::time::Duration,
    /// For the next piece of the body.
    idle: std::time::Duration,
    /// For the whole body.
    body: std::time::Duration,
}

const WAITS: Waits = Waits {
    room: BUFFER_WAIT,
    idle: IDLE_WAIT,
    body: BODY_WAIT,
};

/// One of the `UPLOADS_PER_ACCOUNT` places of the account an upload is charged to, held while
/// its body is read and stored. 429 when the account already reads that many.
pub(crate) fn reading_slot(db: &Db, account: &str) -> Result<crate::api::budget::Slot, ApiError> {
    READING
        .enter(format!("{}\n{account}", crate::db::pool_key(db)))
        .ok_or_else(|| {
            ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                format!("Too many uploads at once: up to {UPLOADS_PER_ACCOUNT} per account"),
            )
        })
}

/// The `Content-Length` of a request, the most its file can be.
pub(crate) fn declared_length(headers: &axum::http::HeaderMap) -> Option<u64> {
    headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse().ok())
}

fn too_large(max: usize) -> ApiError {
    ApiError(
        StatusCode::PAYLOAD_TOO_LARGE,
        format!("File exceeds {}MB limit", max / (1024 * 1024)),
    )
}

/// 413 for JSON over `max` bytes.
pub(crate) fn json_over(max: usize) -> ApiError {
    ApiError(
        StatusCode::PAYLOAD_TOO_LARGE,
        format!("JSON exceeds {}MB limit", max / (1024 * 1024)),
    )
}

/// Room held for one upload body from before it is read until it is dropped: one of its
/// account's places among its uploads at once, part of the account's share of the upload
/// buffer, and room in the buffer for the whole body.
pub(crate) struct Held {
    /// The most bytes the body can have.
    most: usize,
    _room: tokio::sync::OwnedSemaphorePermit,
    _share: crate::api::budget::Share,
    _slot: crate::api::budget::Slot,
}

/// Takes room for an upload body of `declared` bytes (`None`: not declared), at most `body`
/// bytes, for the account of `slot`, before any of it is read, so a body never waits for more
/// room while it holds some. One account holds at most its share of the buffer (`share_kib`)
/// and is refused with 429 past it; when the buffer stays full the upload is refused with 503,
/// at once unless it may `wait`.
pub(crate) async fn reserve(
    slot: crate::api::budget::Slot,
    declared: Option<u64>,
    body: usize,
    wait: bool,
) -> Result<Held, ApiError> {
    let room = Room {
        buffer: buffer(),
        share: share_kib(limits().buffer, body),
    };
    let wait = match wait {
        true => WAITS.room,
        false => std::time::Duration::ZERO,
    };
    take_room(slot, declared, body, room, wait).await
}

async fn take_room(
    slot: crate::api::budget::Slot,
    declared: Option<u64>,
    body: usize,
    room: Room,
    wait: std::time::Duration,
) -> Result<Held, ApiError> {
    let most = declared.map_or(body, |n| n.min(body as u64) as usize);
    let kib = u32::try_from(most.div_ceil(1024))
        .unwrap_or(u32::MAX)
        .min(room.share);
    let share = SHARES
        .take(slot.key(), kib.into(), room.share.into())
        .ok_or_else(|| {
            ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                format!(
                    "Too many uploads at once: up to {} per account",
                    fmt_bytes(u64::from(room.share) * 1024)
                ),
            )
        })?;
    let held = match wait.is_zero() {
        true => room.buffer.try_acquire_many_owned(kib).ok(),
        false => tokio::time::timeout(wait, room.buffer.acquire_many_owned(kib))
            .await
            .ok()
            .and_then(Result::ok),
    }
    .ok_or_else(|| {
        ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "Too many uploads right now, try again in a moment".to_string(),
        )
    })?;
    Ok(Held {
        most,
        _room: held,
        _share: share,
        _slot: slot,
    })
}

/// An upload body held in memory, counted against the instance-wide upload buffer, its
/// account's share of it and its account's uploads at once until it is dropped.
pub(crate) struct Buffered {
    pub data: Vec<u8>,
    _held: Held,
}

/// Reads one multipart file part of at most `max` bytes of a body read through `form`, in the
/// room `held` took for that body.
pub(crate) async fn read_file(
    field: axum::extract::multipart::Field<'_>,
    max: usize,
    held: Held,
    watch: &Watch,
) -> Result<Buffered, ApiError> {
    read_chunks(field, max, held, watch).await
}

async fn read_chunks<S, E>(
    stream: S,
    max: usize,
    held: Held,
    watch: &Watch,
) -> Result<Buffered, ApiError>
where
    S: futures_util::Stream<Item = Result<axum::body::Bytes, E>>,
    E: std::fmt::Display,
{
    let data = collect(stream, held.most.min(max))
        .await
        .map_err(|stop| match stop {
            Stop::Over => too_large(max),
            Stop::Failed(e) => watch.error(
                || too_large(max),
                ApiError(StatusCode::PAYLOAD_TOO_LARGE, e),
            ),
        })?;
    Ok(Buffered { data, _held: held })
}

/// Reads a JSON body of at most `max` bytes, of which `declared` were announced, with the waits
/// of an upload body but outside the upload buffer: 413 past `max` (before reading when the
/// declared length is already past it), 408 when it stalls.
pub(crate) async fn read_json<S, E>(
    stream: S,
    declared: Option<u64>,
    max: usize,
) -> Result<Vec<u8>, ApiError>
where
    S: futures_util::Stream<Item = Result<axum::body::Bytes, E>> + Send + 'static,
    E: Into<BoxError>,
{
    read_small(stream, declared, max, WAITS).await
}

async fn read_small<S, E>(
    stream: S,
    declared: Option<u64>,
    max: usize,
    waits: Waits,
) -> Result<Vec<u8>, ApiError>
where
    S: futures_util::Stream<Item = Result<axum::body::Bytes, E>> + Send + 'static,
    E: Into<BoxError>,
{
    if declared.is_some_and(|n| n > max as u64) {
        return Err(json_over(max));
    }
    let watch = Watch::default();
    read_json_part(paced(stream, usize::MAX, waits, watch.clone()), max, &watch).await
}

/// Reads a JSON part of at most `max` bytes of a body read through `form` (or `paced`): 413
/// past `max`.
pub(crate) async fn read_json_part<S, E>(
    stream: S,
    max: usize,
    watch: &Watch,
) -> Result<Vec<u8>, ApiError>
where
    S: futures_util::Stream<Item = Result<axum::body::Bytes, E>>,
    E: std::fmt::Display,
{
    collect(stream, max).await.map_err(|stop| match stop {
        Stop::Over => json_over(max),
        Stop::Failed(e) => watch.error(|| json_over(max), bad(&e)),
    })
}

fn stalled() -> ApiError {
    ApiError(
        StatusCode::REQUEST_TIMEOUT,
        "The upload stopped sending data".to_string(),
    )
}

type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// Why a paced body was cut off before its end.
#[derive(Clone, Copy, Debug)]
enum Cut {
    /// More than its most bytes came.
    Over,
    /// Nothing came for `Waits::idle`, or the whole took longer than `Waits::body`.
    Stalled,
}

impl std::fmt::Display for Cut {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Cut::Over => "The body is too large",
            Cut::Stalled => "The upload stopped sending data",
        })
    }
}

impl std::error::Error for Cut {}

/// Why a paced body was cut off, once it was.
#[derive(Clone, Default)]
pub(crate) struct Watch(std::sync::Arc<std::sync::OnceLock<Cut>>);

impl Watch {
    /// The error for a failed read of the body: 408 when it stalled, `over()` when it passed its
    /// most bytes, else `other`.
    pub(crate) fn error(&self, over: impl FnOnce() -> ApiError, other: ApiError) -> ApiError {
        match self.0.get() {
            Some(Cut::Stalled) => stalled(),
            Some(Cut::Over) => over(),
            None => other,
        }
    }
}

/// `stream` cut off with an error once it passes `most` bytes, sends nothing for `waits.idle`,
/// or runs longer than `waits.body` from its first poll; `watch` then says which.
fn paced<S, E>(
    stream: S,
    most: usize,
    waits: Waits,
    watch: Watch,
) -> impl futures_util::Stream<Item = Result<axum::body::Bytes, BoxError>> + Send + 'static
where
    S: futures_util::Stream<Item = Result<axum::body::Bytes, E>> + Send + 'static,
    E: Into<BoxError>,
{
    use futures_util::StreamExt;
    let start = (Box::pin(stream), 0usize, None, watch);
    futures_util::stream::unfold(Some(start), move |state| async move {
        let (mut stream, seen, end, watch) = state?;
        let end = end.unwrap_or_else(|| tokio::time::Instant::now() + waits.body);
        let next = (tokio::time::Instant::now() + waits.idle).min(end);
        let cut = match tokio::time::timeout_at(next, stream.next()).await {
            Ok(None) => return None,
            Ok(Some(Err(e))) => return Some((Err(e.into()), None)),
            Ok(Some(Ok(chunk))) if seen.saturating_add(chunk.len()) <= most => {
                let seen = seen + chunk.len();
                return Some((Ok(chunk), Some((stream, seen, Some(end), watch))));
            }
            Ok(Some(Ok(_))) => Cut::Over,
            Err(_) => Cut::Stalled,
        };
        let _ = watch.0.set(cut);
        Some((Err(Box::new(cut) as BoxError), None))
    })
}

/// A `multipart/form-data` request read as one body: at most `most` bytes, and within the upload
/// waits from its first byte to its last, so a stalled preamble, part header or part ends it
/// with 408 and many parts can not make it last longer. The `Watch` says why it was cut off.
pub(crate) async fn form(
    req: Request,
    most: usize,
) -> Result<(Multipart, Watch), MultipartRejection> {
    form_within(req, most, WAITS).await
}

async fn form_within(
    req: Request,
    most: usize,
    waits: Waits,
) -> Result<(Multipart, Watch), MultipartRejection> {
    let watch = Watch::default();
    let (parts, body) = req.into_parts();
    let body = Body::from_stream(paced(body.into_data_stream(), most, waits, watch.clone()));
    let form = Multipart::from_request(Request::from_parts(parts, body), &()).await?;
    Ok((form, watch))
}

/// The multipart body of an upload, read through `form`.
pub(crate) struct UploadForm(Multipart, Watch);

impl<S: Send + Sync> FromRequest<S> for UploadForm {
    type Rejection = MultipartRejection;

    async fn from_request(req: Request, _: &S) -> Result<UploadForm, MultipartRejection> {
        let (form, watch) = form(req, usize::MAX).await?;
        Ok(UploadForm(form, watch))
    }
}

/// Why `collect` stopped before the end of its stream.
enum Stop {
    /// More than its most bytes came.
    Over,
    /// The stream failed, with its error.
    Failed(String),
}

/// Reads `stream` to its end, at most `most` bytes.
async fn collect<S, E>(stream: S, most: usize) -> Result<Vec<u8>, Stop>
where
    S: futures_util::Stream<Item = Result<axum::body::Bytes, E>>,
    E: std::fmt::Display,
{
    use futures_util::StreamExt;
    let mut stream = std::pin::pin!(stream);
    let mut data: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| Stop::Failed(e.to_string()))?;
        if data.len() + chunk.len() > most {
            return Err(Stop::Over);
        }
        data.extend_from_slice(&chunk);
    }
    Ok(data)
}

fn fmt_bytes(n: u64) -> String {
    const MIB: u64 = 1024 * 1024;
    match n {
        n if n >= 1024 * MIB && n % (1024 * MIB) == 0 => format!("{} GiB", n / (1024 * MIB)),
        n if n >= MIB => format!("{} MiB", n / MIB),
        n => format!("{n} bytes"),
    }
}

/// Who an upload is charged to: an account for its own uploads, or, for an incoming webhook's
/// upload, the webhook's owner and also the webhooks of its server together.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Charge<'a> {
    /// The account whose budget the file counts against.
    pub account: &'a str,
    /// For webhook uploads, the server whose webhooks share one more budget.
    pub hooks_of: Option<&'a str>,
}

impl<'a> Charge<'a> {
    pub(crate) fn own(account: &'a str) -> Charge<'a> {
        Charge {
            account,
            hooks_of: None,
        }
    }
}

fn over_budget(budget: u64, charge: Charge<'_>) -> ApiError {
    let who = match charge.hooks_of {
        Some(_) => "this webhook's owner, and all webhooks of its server together,",
        None => "you",
    };
    ApiError(
        StatusCode::TOO_MANY_REQUESTS,
        format!(
            "Upload limit reached: {who} can upload up to {} a day. Space frees up 1 day after each upload, or sooner when a file is removed. The site admin sets this limit",
            fmt_bytes(budget)
        ),
    )
}

/// The files counted against an account: its own uploads and those charged to it, each from its
/// upload (`$2` is now) until it is removed, for at most the instance default (`$3`). Time a
/// server adds counts against that server (`media.kept_by`). One sum per column, so each walks
/// its own index (`idx_media_uploader`, `idx_media_charged_to`).
const ACCOUNT_USED: &str = "SELECT CAST((SELECT COALESCE(SUM(size), 0) FROM media WHERE uploader = $1 AND uploaded_at > $2 - $3 AND (ttl IS NULL OR ttl = 0 OR ttl >= $3 OR uploaded_at + ttl > $2)) + (SELECT COALESCE(SUM(size), 0) FROM media WHERE charged_to = $1 AND (uploader IS NULL OR uploader <> $1) AND uploaded_at > $2 - $3 AND (ttl IS NULL OR ttl = 0 OR ttl >= $3 OR uploaded_at + ttl > $2)) AS BIGINT)";
/// The files of a server's webhooks, counted for the same time (`idx_media_charged_server`).
const HOOKS_USED: &str = "SELECT CAST(COALESCE(SUM(size), 0) AS BIGINT) FROM media WHERE charged_server = $1 AND uploaded_at > $2 - $3 AND (ttl IS NULL OR ttl = 0 OR ttl >= $3 OR uploaded_at + ttl > $2)";
/// Stores a file (`$1` to `$6`, charged to `$9` and `$10`) unless it takes the account `$11`,
/// or the webhooks of the server `$10`, past the budget `$7` (0 for none) at the time `$8`,
/// counted like `ACCOUNT_USED` and `HOOKS_USED` with the instance default `$12`.
const STORE: &str = "INSERT INTO media(id, filename, mime, size, data, uploader, uploaded_at, charged_to, charged_server) SELECT $1, $2, $3, $4, NULL, $5, $6, $9, $10 WHERE $7 = 0 OR ((SELECT COALESCE(SUM(size), 0) FROM media WHERE uploader = $11 AND uploaded_at > $8 - $12 AND (ttl IS NULL OR ttl = 0 OR ttl >= $12 OR uploaded_at + ttl > $8)) + (SELECT COALESCE(SUM(size), 0) FROM media WHERE charged_to = $11 AND (uploader IS NULL OR uploader <> $11) AND uploaded_at > $8 - $12 AND (ttl IS NULL OR ttl = 0 OR ttl >= $12 OR uploaded_at + ttl > $8)) + $4 <= $7 AND ($10 IS NULL OR (SELECT COALESCE(SUM(size), 0) FROM media WHERE charged_server = $10 AND uploaded_at > $8 - $12 AND (ttl IS NULL OR ttl = 0 OR ttl >= $12 OR uploaded_at + ttl > $8)) + $4 <= $7))";

/// Refuses an upload of `adding` bytes that would take `charge` past the storage budget.
pub(crate) async fn check_budget(
    db: &Db,
    charge: Charge<'_>,
    adding: u64,
    budget: u64,
) -> Result<(), ApiError> {
    if budget == 0 {
        return Ok(());
    }
    let mut checks = vec![(ACCOUNT_USED, charge.account)];
    if let Some(server) = charge.hooks_of {
        checks.push((HOOKS_USED, server));
    }
    for (sql, key) in checks {
        let used: i64 = sqlx::query(sql)
            .bind(key)
            .bind(now())
            .bind(MEDIA_TTL_SECS)
            .fetch_one(db)
            .await?
            .try_get(0)?;
        if (used.max(0) as u64).saturating_add(adding) > budget {
            return Err(over_budget(budget, charge));
        }
    }
    Ok(())
}

/// The upload budget of this instance in bytes (0: no limit).
pub(crate) fn budget() -> u64 {
    limits().budget
}

fn s3_key(id: &str) -> String {
    format!("media/{id}")
}

async fn s3_delete(s3: Option<&Bucket>, id: &str) {
    if let Some(bucket) = s3
        && let Err(e) = bucket.delete_object(s3_key(id)).await
    {
        tracing::warn!("s3 delete failed for {id}: {e}");
    }
}

async fn fresh_id(db: &Db) -> Result<String, ApiError> {
    loop {
        let mut bytes = [0u8; 16];
        rand::rng().fill_bytes(&mut bytes);
        let id = hex::encode(bytes);
        let taken = sqlx::query("SELECT 1 FROM media WHERE id = $1")
            .bind(&id)
            .fetch_optional(db)
            .await?
            .is_some();
        if !taken {
            return Ok(id);
        }
    }
}

pub(crate) const MEDIA_CHUNK: usize = 256 * 1024;

/// Stores a file with no budget check, for tests.
#[cfg(test)]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn store_media(
    db: &Db,
    id: &str,
    filename: &str,
    mime: &str,
    size: i64,
    in_db: Option<&[u8]>,
    uploader: &str,
    uploaded_at: i64,
) -> Result<(), ApiError> {
    let file = NewMedia {
        id,
        filename,
        mime,
        size,
        in_db,
        uploader,
        uploaded_at,
    };
    store_within(db, &file, Charge::own(uploader), 0).await
}

struct NewMedia<'a> {
    id: &'a str,
    filename: &'a str,
    mime: &'a str,
    size: i64,
    in_db: Option<&'a [u8]>,
    uploader: &'a str,
    uploaded_at: i64,
}

/// Stores `file` unless it takes `charge` past `budget` bytes of counted files (0 for no limit):
/// the charged account, and for a webhook upload also the webhooks of its server together. The
/// check and the insert are one statement in one transaction: SQLite takes its write lock
/// before the statement reads, and on Postgres advisory locks on the account (then the server)
/// are held until commit, so concurrent uploads cannot pass the budget together.
async fn store_within(
    db: &Db,
    file: &NewMedia<'_>,
    charge: Charge<'_>,
    budget: u64,
) -> Result<(), ApiError> {
    let mut tx = db.begin().await?;
    if budget > 0 && !crate::db::is_sqlite(db) {
        let mut keys = vec![format!("media budget:{}", charge.account)];
        if let Some(server) = charge.hooks_of {
            keys.push(format!("media budget:hooks:{server}"));
        }
        for key in keys {
            sqlx::query("SELECT COUNT(*) FROM pg_advisory_xact_lock(hashtextextended($1, 0))")
                .bind(key)
                .execute(&mut *tx)
                .await?;
        }
    }
    let charged_to = charge
        .hooks_of
        .map(|_| charge.account.to_string())
        .filter(|account| account != file.uploader);
    let inserted = sqlx::query(STORE)
        .bind(file.id)
        .bind(file.filename)
        .bind(file.mime)
        .bind(file.size)
        .bind(file.uploader)
        .bind(file.uploaded_at)
        .bind(budget.min(i64::MAX as u64) as i64)
        .bind(file.uploaded_at)
        .bind(charged_to)
        .bind(charge.hooks_of.map(str::to_string))
        .bind(charge.account)
        .bind(MEDIA_TTL_SECS)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if inserted == 0 {
        tx.rollback().await?;
        return Err(over_budget(budget, charge));
    }
    for (seq, chunk) in file
        .in_db
        .unwrap_or_default()
        .chunks(MEDIA_CHUNK)
        .enumerate()
    {
        sqlx::query("INSERT INTO media_chunks(media_id, seq, data) VALUES($1, $2, $3)")
            .bind(file.id)
            .bind(seq as i64)
            .bind(chunk.to_vec())
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Upload a file
///
/// Stores one file for attaching to a message: send it as the first part of a
/// `multipart/form-data` body (any field name). The part's file name (default `file`) is kept
/// without path parts and control characters, cut to 255 bytes (keeping a short extension);
/// its content type (default `application/octet-stream`) is kept as `type/subtype` without
/// parameters when it is at most 127 bytes, else stored as `application/octet-stream`. Then
/// pass the returned `id` as
/// `media_id` when sending a message; only the uploader can attach it, and only to one
/// message. The file is deleted 24 hours after upload (attached or not), or at the time its
/// server chose when it is posted in a server (`upload_expiry` of the server); messages carrying
/// it then show it as removed (`media_removed` event). At most `limits.upload_bytes`
/// of `GET /api/v1/instance` per file, by default 25 MiB (`UPLOAD_MAX_MIB`), and
/// at most the instance's per-account budget (`UPLOAD_BUDGET_MIB`, 2 GiB unless set) of your
/// files at once. Each counts from its upload until it is removed, for at most 24 hours (files
/// your webhooks sent count too). Time a server adds with its `upload_expiry` counts against
/// that server and its owner instead (`kept` and `owner_kept` of
/// `GET /api/v1/servers/{name}/upload_expiry`).
/// At most 3 of your uploads are read at once. Each takes room for its whole declared body in
/// the instance's upload buffer (`UPLOAD_BUFFER_MIB`) before any of it is read, and together
/// they hold at most a quarter of it, three uploads (up to half of it) or one upload, whichever
/// is most. A body that sends nothing for 30 seconds, or takes over 10 minutes in all, is
/// dropped with 408.
///
/// Requires a bearer token and the instance's uploads setting. Strict rate-limit bucket.
#[utoipa::path(post, path = "/api/v1/media", tag = "Media", request_body(content = Vec<u8>, content_type = "multipart/form-data", description = "A multipart form whose first part is the file"), responses((status = 200, description = "File stored; returns a media reference with its expiry time to attach to a message", body = MediaRef), (status = 400, description = "No file part (JSON `No file provided`) or a malformed multipart body (JSON). A body that is not `multipart/form-data` or has no valid boundary gets a plain-text 400 from the framework", content((ApiErrorBody = "application/json"), (String = "text/plain"))), (status = 401, description = "Not signed in", body = ApiErrorBody), (status = 403, description = "File uploads are disabled on this instance", body = ApiErrorBody), (status = 413, description = "File over `limits.upload_bytes`, by default 25 MiB (`UPLOAD_MAX_MIB`): `File exceeds 25MB limit` with the configured number. A request body over that size plus 1 MiB is cut off while the file is read and answers with this status and the JSON error \"Error parsing `multipart/form-data` request\"", body = ApiErrorBody), (status = 408, description = "`The upload stopped sending data`: the body sent nothing for 30 seconds or took over 10 minutes", body = ApiErrorBody), (status = 429, description = "Too many requests in the strict bucket (shared with register, login, word hints, password change and guest access) or the general bucket (plain text), the per-account budget is used up (JSON `Upload limit reached: you can upload up to 2 GiB a day. ...` with the configured size; space frees up 24 hours after each upload, or sooner when a file is removed, and the site operator sets the limit with `UPLOAD_BUDGET_MIB`), or 3 of your uploads, or uploads holding your share of the upload buffer, are already being read (JSON `Too many uploads at once: ...`)", content((ApiErrorBody = "application/json"), (String = "text/plain"))), (status = 503, description = "`Too many uploads right now, try again in a moment`: the instance holds as many upload bodies in memory as it allows (each upload takes room for its whole declared size first)", body = ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn upload_media(
    State(state): State<AppState>,
    Authed(user): Authed,
    headers: axum::http::HeaderMap,
    UploadForm(mut multipart, watch): UploadForm,
) -> Result<Json<MediaRef>, ApiError> {
    if !Settings::cached(&state.db).await.asset_uploads {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "File uploads are disabled".to_string(),
        ));
    }
    check_budget(&state.db, Charge::own(&user.username), 1, budget()).await?;
    let slot = reading_slot(&state.db, &user.username)?;
    let body = state.limits.upload_body_bytes();
    let held = reserve(slot, declared_length(&headers), body, true).await?;
    let max = state.limits.upload_bytes();
    let field = multipart
        .next_field()
        .await
        .map_err(|e| {
            watch.error(
                || too_large(max),
                ApiError(StatusCode::BAD_REQUEST, e.to_string()),
            )
        })?
        .ok_or_else(|| bad("No file provided"))?;
    let filename = clean_filename(field.file_name().unwrap_or("file"));
    let mime = clean_mime(field.content_type().unwrap_or(NEUTRAL_MIME));
    let body = read_file(field, max, held, &watch).await?;
    let (id, uploaded_at) = save_upload(
        &state,
        &filename,
        &mime,
        &body.data,
        &user.username,
        Charge::own(&user.username),
    )
    .await?;
    Ok(Json(MediaRef::server(
        id,
        filename,
        false,
        Some(uploaded_at + MEDIA_TTL_SECS),
    )))
}

/// Stores an uploaded file for `uploader`, counted against `charge` (S3 when configured, else
/// the database). Returns its id and upload time.
pub(crate) async fn save_upload(
    state: &AppState,
    filename: &str,
    mime: &str,
    data: &[u8],
    uploader: &str,
    charge: Charge<'_>,
) -> Result<(String, i64), ApiError> {
    save_within(state, filename, mime, data, uploader, charge, budget()).await
}

pub(crate) async fn save_within(
    state: &AppState,
    filename: &str,
    mime: &str,
    data: &[u8],
    uploader: &str,
    charge: Charge<'_>,
    budget: u64,
) -> Result<(String, i64), ApiError> {
    let max = state.limits.upload_bytes();
    if data.len() > max {
        return Err(too_large(max));
    }
    let filename = &clean_filename(filename);
    let mime = &clean_mime(mime);
    // A cheap early refusal before the S3 write; `store_within` makes the binding check.
    check_budget(&state.db, charge, data.len() as u64, budget).await?;
    let id = fresh_id(&state.db).await?;
    let uploaded_at = now();
    let in_db = match &state.s3 {
        Some(bucket) => {
            bucket
                .put_object_with_content_type(s3_key(&id), data, mime)
                .await
                .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            None
        }
        None => Some(data),
    };
    let file = NewMedia {
        id: &id,
        filename,
        mime,
        size: data.len() as i64,
        in_db,
        uploader,
        uploaded_at,
    };
    if let Err(e) = store_within(&state.db, &file, charge, budget).await {
        s3_delete(state.s3.as_deref(), &id).await;
        return Err(e);
    }
    Ok((id, uploaded_at))
}

/// Remove a message's attachment
///
/// Marks the attachment of a message as removed (the text stays). A stored file that no other
/// live message uses is deleted. For a P2P attachment, the metadata (hash included) is cleared:
/// `p2p_who` stops offering it, the app of the hoster stops serving it (also on its next
/// `p2p_hosting`, answered by `p2p_hosted`), and recipients drop their copies. A modified client
/// that has the file can still share it with people who know its id. The server cannot prevent
/// this. The author can always do this. In a server channel, members with Manage messages can
/// too. Emits `media_removed` to all who can see the message. Forwarded copies keep their own
/// reference to the file (and so the file). Moderators of the destination use this endpoint on
/// the copy. Requires a bearer token. General rate-limit bucket.
#[utoipa::path(delete, path = "/api/v1/messages/{id}/media", tag = "Media", params(("id" = i64, Path, description = "Message id")), responses((status = 200, description = "Removed; the body is `{\"ok\": true}`", body = OkResp), (status = 401, description = "Not signed in", body = ApiErrorBody), (status = 403, description = "Not the author and no Manage messages permission in the server", body = ApiErrorBody), (status = 404, description = "`Not found`: no such message, its author's account is being deleted, or you cannot read it (hidden channel, before your join without read history, a server you have no access to, or a DM you are not in); identical responses; or it has no attachment (`No attachment`)", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn delete_media(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Authed(user): Authed,
) -> Result<Json<OkResp>, ApiError> {
    let message = resolve_message(&state.db, id, Some(&user), &Proof::none()).await?;
    message.require_can_delete(&state.db).await?;
    let audit = crate::api::messages::moderated(&state.db, id, &message, &user, true).await?;
    let MsgScope {
        channel_id,
        dm_id,
        thread_root_id: _,
        kind: _,
        author,
        media_id,
        media_filename: _,
        media_kind,
        server,
        dm_users,
    } = message.into_scope();
    let media_id = match media_id {
        Some(media_id) => media_id,
        None => {
            return Err(ApiError(StatusCode::NOT_FOUND, "No attachment".to_string()));
        }
    };
    let entry = audit.map(|(server, actor, channel)| {
        audit::message_entry(
            &server,
            &actor,
            audit::Action::AttachmentRemove,
            id,
            &author,
            &channel,
        )
    });
    match media_kind {
        MediaKind::P2p => {
            let mut tx = state.db.begin().await?;
            sqlx::query("UPDATE messages SET media_removed = 2, media_hoster = NULL, media_expires_at = NULL, media_size = NULL, media_mime = NULL, media_sha256 = NULL WHERE id = $1")
                .bind(id)
                .execute(&mut *tx)
                .await?;
            if let Some(entry) = entry {
                audit::record(&mut tx, entry).await?;
            }
            tx.commit().await?;
        }
        MediaKind::Server => {
            let mut tx = state.db.begin().await?;
            if let Some(entry) = entry {
                audit::record(&mut tx, entry).await?;
            }
            let original =
                sqlx::query("SELECT 1 FROM messages WHERE id = $1 AND fwd_created_at IS NULL")
                    .bind(id)
                    .fetch_optional(&mut *tx)
                    .await?
                    .is_some();
            sqlx::query("UPDATE messages SET media_removed = 2 WHERE id = $1")
                .bind(id)
                .execute(&mut *tx)
                .await?;
            let shared = sqlx::query(
                "SELECT 1 FROM messages WHERE media_id = $1 AND media_kind = 'server' AND media_removed = 0",
            )
            .bind(&media_id)
            .fetch_optional(&mut *tx)
            .await?
            .is_some();
            match shared {
                true if original => crate::api::upload_expiry::release(&mut tx, &media_id).await?,
                true => {}
                false => {
                    sqlx::query("DELETE FROM media WHERE id = $1")
                        .bind(&media_id)
                        .execute(&mut *tx)
                        .await?;
                }
            }
            tx.commit().await?;
            if !shared {
                s3_delete(state.s3.as_deref(), &media_id).await;
            }
        }
    }
    state.hub.broadcast(WsEvent::MediaRemoved {
        server,
        channel_id,
        dm_id,
        dm_users,
        message_id: id,
        removed_by_author: true,
    });
    Ok(ok())
}

fn media_hidden() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, "Media not found".to_string())
}

/// Most messages that may carry one uploaded file. Forwards past this carry the file name
/// only, so checking access to a file and sweeping it stay bounded.
pub const MEDIA_REFS_MAX: i64 = 50;

/// How many live messages carry the uploaded file `media_id`, counting at most
/// `MEDIA_REFS_MAX`.
#[cfg(test)]
pub(crate) async fn references(db: &Db, media_id: &str) -> sqlx::Result<i64> {
    sqlx::query("SELECT COUNT(*) FROM (SELECT 1 FROM messages WHERE media_id = $1 AND media_kind = 'server' AND media_removed = 0 LIMIT $2) t")
        .bind(media_id)
        .bind(MEDIA_REFS_MAX)
        .fetch_one(db)
        .await?
        .try_get(0)
}

/// Most messages from one sender that may carry one uploaded file, so that one sender can not
/// use up `MEDIA_REFS_MAX` for everyone.
pub const MEDIA_REFS_PER_SENDER: i64 = 5;

/// Whether one more message from `sender` may carry the uploaded file `media_id` (under
/// `MEDIA_REFS_MAX` in total and `MEDIA_REFS_PER_SENDER` from `sender`). Call it inside the
/// transaction that stores the message: on Postgres it locks the media row, so concurrent
/// forwards of one file are counted one after another.
pub(crate) async fn may_carry(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    is_sqlite: bool,
    media_id: &str,
    sender: &str,
) -> sqlx::Result<bool> {
    if !is_sqlite {
        sqlx::query("SELECT 1 FROM media WHERE id = $1 FOR UPDATE")
            .bind(media_id)
            .execute(&mut **tx)
            .await?;
    }
    let row = sqlx::query("SELECT (SELECT COUNT(*) FROM (SELECT 1 FROM messages WHERE media_id = $1 AND media_kind = 'server' AND media_removed = 0 LIMIT $2) t), (SELECT COUNT(*) FROM (SELECT 1 FROM messages WHERE media_id = $1 AND media_kind = 'server' AND media_removed = 0 AND author = $3 LIMIT $4) s)")
        .bind(media_id)
        .bind(MEDIA_REFS_MAX)
        .bind(sender)
        .bind(MEDIA_REFS_PER_SENDER)
        .fetch_one(&mut **tx)
        .await?;
    let (total, mine): (i64, i64) = (row.try_get(0)?, row.try_get(1)?);
    Ok(total < MEDIA_REFS_MAX && mine < MEDIA_REFS_PER_SENDER)
}

pub(crate) async fn media_view_ok(
    db: &Db,
    proof: &Proof<'_>,
    media_id: &str,
    user: Option<&User>,
) -> Result<(), ApiError> {
    let rows =
        sqlx::query("SELECT m.id FROM messages m WHERE m.media_id = $1 AND m.media_kind = 'server' AND m.media_removed = 0 ORDER BY m.id LIMIT $2")
            .bind(media_id)
            .bind(MEDIA_REFS_MAX)
            .fetch_all(db)
            .await?;
    if rows.is_empty() {
        let uploader: Option<String> = match sqlx::query("SELECT uploader FROM media WHERE id = $1")
            .bind(media_id)
            .fetch_optional(db)
            .await?
        {
            Some(r) => r.try_get(0)?,
            None => None,
        };
        return match (user, uploader) {
            (Some(u), Some(owner)) if u.username == owner => Ok(()),
            (_, _) => Err(media_hidden()),
        };
    }
    for r in &rows {
        if allowed(resolve_message(db, r.try_get(0)?, user, proof).await)?.is_some() {
            return Ok(());
        }
    }
    Err(media_hidden())
}

fn chunk_stream(
    db: Db,
    id: String,
    chunks: i64,
) -> impl futures_util::Stream<Item = Result<Vec<u8>, std::io::Error>> {
    futures_util::stream::unfold(0i64, move |seq| {
        let (db, id) = (db.clone(), id.clone());
        async move {
            if seq >= chunks {
                return None;
            }
            let row = sqlx::query("SELECT data FROM media_chunks WHERE media_id = $1 AND seq = $2")
                .bind(&id)
                .bind(seq)
                .fetch_optional(&db)
                .await;
            match row
                .ok()
                .flatten()
                .and_then(|r| r.try_get::<Vec<u8>, _>(0).ok())
            {
                Some(bytes) => Some((Ok(bytes), seq + 1)),
                None => Some((
                    Err(std::io::Error::other("media removed while streaming")),
                    chunks,
                )),
            }
        }
    })
}

/// Download a file
///
/// Streams an uploaded file with its stored `Content-Type`, as an attachment
/// (`Content-Disposition: attachment`), with `X-Content-Type-Options: nosniff` and a sandboxing
/// `Content-Security-Policy`. The token may come from the `Authorization` header or the
/// `rchat_token` cookie, so browsers can load it directly; guests may download when guest
/// access is on.
///
/// Once attached, the file is visible to anyone who can read one of the messages carrying it,
/// with the same checks as listing messages: in a server without a password anyone not banned
/// from it, in a password-protected server its members or guests holding a grant for it (the
/// `X-Guest-Grant` header); in a channel with permission overrides (thread replies use their
/// channel) also the view permission, and without read-history access only messages posted since you
/// joined count; in a direct message its two participants. Before it is attached only the
/// uploader can fetch it. Access is checked before `If-None-Match`, so a 304 is only sent to
/// callers allowed to see the file. General rate-limit bucket.
#[utoipa::path(get, path = "/api/v1/media/{id}", tag = "Media", params(("id" = String, Path, description = "Media id, 32 hex characters, from `MediaRef.id`"), ("X-Guest-Grant" = Option<String>, Header, description = "Guest grants from `POST /api/v1/servers/{name}/guest_access`, comma-separated, up to 100. Only read for guests viewing a password-protected server")), responses((status = 200, description = "File bytes, streamed. Carries a strong `ETag`, `Cache-Control: private, max-age=86400, immutable` and `Vary: X-Guest-Grant`"), (status = 304, description = "`If-None-Match` matched the media's ETag and you may see the file. Carries the same `ETag`, `Cache-Control` and `Vary`"), (status = 401, description = "Guest access is disabled and no valid token was sent", body = ApiErrorBody), (status = 403, description = "`Attachments are turned off on this server`: uploads and P2P attachments are both off (text only); only sent to callers who may see the file", body = ApiErrorBody), (status = 404, description = "`Media not found`: unknown id, the file expired or was deleted, or you may not read any message carrying it (banned, no access to its password-protected server, no view permission or no read-history access in its channel, or not a DM participant) or see the unattached upload; identical responses", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security((), ("bearer" = [])))]
pub(crate) async fn download_media(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let db = state.read();
    let user = match request_token(&headers) {
        Some(token) => user_for_token(&state, &token).await?,
        None => None,
    };
    require_guest_ok(&db, user.as_ref()).await?;
    let proof = Proof::headers(&headers, &state.limits);
    media_view_ok(&db, &proof, &id, user.as_ref()).await?;
    if Settings::cached(&db).await.text_only() {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "Attachments are turned off on this server".to_string(),
        ));
    }
    let row = sqlx::query(
        "SELECT filename, mime, size, CAST(CASE WHEN data IS NULL THEN 0 ELSE 1 END AS BIGINT), (SELECT COUNT(*) FROM media_chunks mc WHERE mc.media_id = media.id) FROM media WHERE id = $1",
    )
    .bind(&id)
    .fetch_optional(&db)
    .await?;
    let (filename, mime, size, inline, chunks): (String, String, i64, i64, i64) = match &row {
        Some(r) => (
            r.try_get(0)?,
            r.try_get(1)?,
            r.try_get(2)?,
            r.try_get(3)?,
            r.try_get(4)?,
        ),
        None => return Err(media_hidden()),
    };
    let etag = format!("\"{id}\"");
    let cache = "private, max-age=86400, immutable";
    let fresh = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|t| t.trim() == etag || t.trim() == "*"));
    if fresh {
        return Response::builder()
            .status(StatusCode::NOT_MODIFIED)
            .header(header::ETAG, &etag)
            .header(header::CACHE_CONTROL, cache)
            .header(header::VARY, "X-Guest-Grant")
            .body(Body::empty())
            .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()));
    }
    let body = match (inline != 0, chunks > 0, &state.s3) {
        (true, _, _) => {
            let bytes: Option<Vec<u8>> = sqlx::query("SELECT data FROM media WHERE id = $1")
                .bind(&id)
                .fetch_optional(&db)
                .await?
                .map(|r| r.try_get(0))
                .transpose()?
                .flatten();
            Body::from(bytes.unwrap_or_default())
        }
        (false, true, _) => Body::from_stream(chunk_stream(db.clone(), id.clone(), chunks)),
        (false, false, _) if size == 0 => Body::empty(),
        (false, false, Some(bucket)) => {
            let stream = bucket
                .get_object_stream(s3_key(&id))
                .await
                .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            Body::from_stream(stream.bytes)
        }
        (false, false, None) => {
            return Err(ApiError(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Media stored in S3 but S3 is not configured".to_string(),
            ));
        }
    };
    let mut res = Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_DISPOSITION, content_disposition(&filename))
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(
            header::CONTENT_SECURITY_POLICY,
            "default-src 'none'; sandbox",
        )
        .header(header::ETAG, &etag)
        .header(header::CACHE_CONTROL, cache)
        .header(header::VARY, "X-Guest-Grant");
    if chunks > 0 || (inline == 0 && size == 0) {
        res = res.header(header::CONTENT_LENGTH, size);
    }
    res.body(body)
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

pub(crate) fn content_disposition(filename: &str) -> String {
    let fallback: String = filename
        .chars()
        .map(|c| match c {
            '"' | '\\' => '_',
            c if c.is_ascii_graphic() || c == ' ' => c,
            _ => '_',
        })
        .collect();
    let mut encoded = String::with_capacity(filename.len());
    for b in filename.bytes() {
        match b {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'!'
            | b'#'
            | b'$'
            | b'&'
            | b'+'
            | b'-'
            | b'.'
            | b'^'
            | b'_'
            | b'`'
            | b'|'
            | b'~' => encoded.push(char::from(b)),
            _ => {
                let _ = write!(encoded, "%{b:02X}");
            }
        }
    }
    format!("attachment; filename=\"{fallback}\"; filename*=UTF-8''{encoded}")
}

const SWEEP_BATCH: i64 = 200;

/// Files past their time: the instance default (`ttl` unset) or their own `ttl`; `ttl` 0 stays.
async fn sweep_batch(db: &Db, at: i64) -> sqlx::Result<(Vec<String>, Vec<WsEvent>)> {
    let mut tx = db.begin().await?;
    let mut ids = Vec::new();
    for (sql, by) in [
        (
            "SELECT id FROM media WHERE ttl IS NULL AND uploaded_at <= $1 LIMIT $2",
            at - MEDIA_TTL_SECS,
        ),
        (
            "SELECT id FROM media WHERE ttl > 0 AND (uploaded_at + ttl) <= $1 LIMIT $2",
            at,
        ),
    ] {
        let rows = sqlx::query(sql)
            .bind(by)
            .bind(SWEEP_BATCH - ids.len() as i64)
            .fetch_all(&mut *tx)
            .await?;
        for r in &rows {
            ids.push(r.try_get::<String, _>(0)?);
        }
        if ids.len() as i64 >= SWEEP_BATCH {
            break;
        }
    }
    if ids.is_empty() {
        tx.commit().await?;
        return Ok((ids, Vec::new()));
    }
    let list = placeholders(1, ids.len());
    let bind_ids = |sql: String| {
        let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
        for id in &ids {
            query = query.bind(id.clone());
        }
        query
    };
    let rows = bind_ids(format!(
        "SELECT m.id, m.channel_id, m.dm_id, m.media_filename, c.server, d.user_a, d.user_b FROM messages m LEFT JOIN channels c ON c.id = m.channel_id LEFT JOIN dms d ON d.id = m.dm_id WHERE m.media_id IN ({list}) AND m.media_removed = 0 AND m.media_kind != 'p2p'"
    ))
    .fetch_all(&mut *tx)
    .await?;
    let mut events = Vec::with_capacity(rows.len());
    for r in &rows {
        let dm_users = match (
            r.try_get::<Option<String>, _>(5)?,
            r.try_get::<Option<String>, _>(6)?,
        ) {
            (Some(a), Some(b)) => Some(vec![a, b]),
            (_, _) => None,
        };
        events.push(WsEvent::MediaRemoved {
            server: r.try_get(4)?,
            channel_id: r.try_get(1)?,
            dm_id: r.try_get(2)?,
            dm_users,
            message_id: r.try_get(0)?,
            removed_by_author: false,
        });
    }
    bind_ids(format!(
        "UPDATE messages SET media_removed = 1 WHERE media_id IN ({list}) AND media_kind != 'p2p'"
    ))
    .execute(&mut *tx)
    .await?;
    bind_ids(format!("DELETE FROM media WHERE id IN ({list})"))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok((ids, events))
}

pub(crate) async fn sweep(db: &Db, s3: Option<&Bucket>) -> sqlx::Result<Vec<WsEvent>> {
    let mut conn = db.acquire().await?;
    if let Some(cap) = crate::api::upload_expiry::stored_cap(&mut conn).await {
        crate::api::upload_expiry::clamp(&mut conn, cap).await?;
    }
    drop(conn);
    let at = now();
    let mut events = Vec::new();
    loop {
        let (ids, batch) = sweep_batch(db, at).await?;
        events.extend(batch);
        for id in &ids {
            s3_delete(s3, id).await;
        }
        if (ids.len() as i64) < SWEEP_BATCH {
            return Ok(events);
        }
    }
}

pub async fn sweep_expired(state: &AppState) {
    let events = match sweep(&state.db, state.s3.as_deref()).await {
        Ok(events) => events,
        Err(e) => {
            tracing::warn!("media sweep failed: {e}");
            return;
        }
    };
    for ev in events {
        state.hub.broadcast(ev);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        Charge, FILENAME_MAX, MEDIA_TTL_SECS, MIME_MAX, NEUTRAL_MIME, Room, SWEEP_BATCH,
        UPLOADS_PER_ACCOUNT, Waits, Watch, check_budget, clean_filename, clean_mime,
        content_disposition, delete_media, download_media, form_within, media_view_ok, paced,
        read_chunks, read_json_part, read_small, reading_slot, save_within, share_held, share_kib,
        store_media, sweep, take_room,
    };
    use crate::api::access::Proof;
    use crate::api::test_util::{done, mem_user, temp_state};
    use crate::api::{ApiError, Authed};
    use crate::db::{now, open_started as open};
    use axum::extract::{Path, State};
    use axum::http::StatusCode;
    use sqlx::Row;

    #[test]
    fn the_upload_buffer_is_sized_from_its_limits() {
        let mib = 1024 * 1024;
        let small = super::Upload::new(super::UploadLimits {
            budget: 7 * mib,
            buffer: 64 * mib,
        });
        assert_eq!(small.limits.budget, 7 * mib);
        assert_eq!(small.buffer.available_permits(), 64 * 1024);
        let large = super::Upload::new(super::UploadLimits {
            budget: 0,
            buffer: 512 * mib,
        });
        assert_eq!(large.buffer.available_permits(), 512 * 1024);
        assert_eq!(large.limits.budget, 0);
    }

    #[test]
    fn file_names_are_cleaned_and_capped() {
        let long = format!("{}.tar.gz", "a".repeat(300));
        let cut = clean_filename(&long);
        assert!(cut.len() <= FILENAME_MAX, "{}", cut.len());
        assert!(cut.ends_with(".gz"), "{cut}");
        let wide = format!("{}.txt", "\u{00e9}".repeat(200));
        let cut = clean_filename(&wide);
        assert!(cut.len() <= FILENAME_MAX && cut.ends_with(".txt"), "{cut}");
        assert_eq!(clean_filename("../../etc/passwd"), "passwd");
        assert_eq!(clean_filename("C:\\Users\\me\\a.png"), "a.png");
        assert_eq!(clean_filename("a\r\nb\u{0}.txt"), "ab.txt");
        assert_eq!(clean_filename("evil\u{202e}gpj.exe"), "evilgpj.exe");
        assert_eq!(clean_filename("  spaced.txt  "), "spaced.txt");
        for empty in ["", "   ", "\n", "..", "dir/"] {
            assert_eq!(clean_filename(empty), "file", "{empty:?}");
        }
        assert_eq!(clean_filename(&"b".repeat(400)).len(), FILENAME_MAX);
    }

    #[test]
    fn content_types_are_kept_only_when_well_formed() {
        assert_eq!(clean_mime("image/png"), "image/png");
        assert_eq!(clean_mime("Text/Plain; charset=utf-8"), "text/plain");
        let padded = format!("text/plain; x={}", "y".repeat(10_000));
        assert_eq!(clean_mime(&padded), "text/plain");
        for bad in [
            "text plain",
            "text/plain extra",
            "a/b/c",
            "text/",
            "/plain",
            "",
            "image/png\r\nX-Evil: 1",
        ] {
            assert_eq!(clean_mime(bad), NEUTRAL_MIME, "{bad:?}");
        }
        let long = format!("application/{}", "x".repeat(MIME_MAX));
        assert_eq!(clean_mime(&long), NEUTRAL_MIME);
    }

    /// Serves the routes of `state` on a local port.
    async fn serve(
        state: &crate::state::AppState,
    ) -> (
        std::net::SocketAddr,
        tokio::task::JoinHandle<std::io::Result<()>>,
    ) {
        use crate::server::client_ip::{ClientIp, ProxyTrust};
        let trusted = ProxyTrust::from_config(false, Some("127.0.0.1")).expect("trust");
        let app = crate::api::routes(
            state.clone(),
            &crate::config::Roles::ALL,
            ClientIp(trusted),
            None,
        )
        .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await
        });
        (addr, server)
    }

    async fn add_alice(db: &crate::db::Db) {
        crate::db::NewUser::plain("alice").hash("x").add(db).await;
        sqlx::query("INSERT INTO tokens(token, username, created_at) VALUES($1, 'alice', 0)")
            .bind(crate::db::secret_key("tok-alice"))
            .execute(db)
            .await
            .expect("token");
    }

    /// Uploads a file of `kib` KiB as alice through the routes of `state`.
    async fn post_file(state: &crate::state::AppState, kib: usize) -> (StatusCode, String) {
        let (addr, server) = serve(state).await;
        let mut body = b"--XB\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.bin\"\r\nContent-Type: application/octet-stream\r\n\r\n".to_vec();
        body.extend(vec![7u8; kib * 1024]);
        body.extend_from_slice(b"\r\n--XB--\r\n");
        let res = reqwest::Client::new()
            .post(format!("http://{addr}/media"))
            .bearer_auth("tok-alice")
            .header("content-type", "multipart/form-data; boundary=XB")
            .body(body)
            .send()
            .await
            .expect("upload");
        let status = res.status();
        let text = res.text().await.expect("body");
        server.abort();
        (status, text)
    }

    #[tokio::test]
    async fn uploads_over_the_configured_size_are_refused() {
        let (state, path) = temp_state("media_configured_size").await;
        add_alice(&state.db).await;
        let small = state
            .clone()
            .with_limits(std::sync::Arc::new(crate::limits::Limits {
                upload_max_mib: 1,
                ..Default::default()
            }));
        let (status, text) = post_file(&small, 1536).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{text}");
        assert!(text.contains("File exceeds 1MB limit"), "{text}");
        let (status, text) = post_file(&small, 2560).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{text}");
        let (status, text) = post_file(&small, 1000).await;
        assert_eq!(status, StatusCode::OK, "{text}");
        let (status, text) = post_file(&state, 1536).await;
        assert_eq!(status, StatusCode::OK, "the default allows it: {text}");
        let (status, text) = post_file(&state, 25 * 1024 + 1).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{text}");
        assert!(text.contains("File exceeds 25MB limit"), "{text}");
        done(state, path).await;
    }

    #[tokio::test]
    async fn the_budget_refuses_the_upload_that_crosses_it_and_frees_with_time() {
        let (state, path) = temp_state("media_budget").await;
        let db = &state.db;
        let mib = 1024 * 1024;
        store_media(
            db,
            &"aa".repeat(16),
            "a",
            NEUTRAL_MIME,
            3 * mib,
            None,
            "alice",
            now(),
        )
        .await
        .expect("store");
        store_media(
            db,
            &"bb".repeat(16),
            "b",
            NEUTRAL_MIME,
            9 * mib,
            None,
            "bob",
            now(),
        )
        .await
        .expect("store");
        let budget = 4 * mib as u64;
        assert!(
            check_budget(db, Charge::own("alice"), mib as u64, budget)
                .await
                .is_ok()
        );
        let refused = check_budget(db, Charge::own("alice"), mib as u64 + 1, budget).await;
        match refused {
            Err(ApiError(code, msg)) => {
                assert_eq!(code, StatusCode::TOO_MANY_REQUESTS);
                assert_eq!(
                    msg,
                    "Upload limit reached: you can upload up to 4 MiB a day. Space frees up 1 day after each upload, or sooner when a file is removed. The site admin sets this limit"
                );
                assert!(msg.is_ascii());
            }
            Ok(()) => panic!("crossing the budget is refused"),
        }
        assert!(
            check_budget(db, Charge::own("alice"), u64::MAX, 0)
                .await
                .is_ok(),
            "0 = no limit"
        );
        sqlx::query("UPDATE media SET uploaded_at = $1 WHERE uploader = 'alice'")
            .bind(now() - MEDIA_TTL_SECS - 1)
            .execute(db)
            .await
            .expect("age");
        assert!(
            check_budget(db, Charge::own("alice"), budget, budget)
                .await
                .is_ok(),
            "space frees up once files are a day old"
        );
        done(state, path).await;
    }

    /// The plan SQLite makes for `sql`, with `binds` text and number parameters.
    async fn plan(db: &crate::db::Db, sql: &str, texts: &[usize], binds: usize) -> String {
        let mut query = sqlx::query(sqlx::AssertSqlSafe(format!("EXPLAIN QUERY PLAN {sql}")));
        for n in 1..=binds {
            query = match texts.contains(&n) {
                true => query.bind("alice"),
                false => query.bind(1_i64),
            };
        }
        let rows = query.fetch_all(db).await.expect("plan");
        rows.iter()
            .map(|r| r.get::<String, _>(3))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[tokio::test]
    async fn the_budget_sums_use_the_indexes_of_who_is_charged() {
        let (state, path) = temp_state("media_budget_plan").await;
        let db = &state.db;
        for (what, sql, texts, binds, indexes) in [
            (
                "an account",
                super::ACCOUNT_USED,
                &[1][..],
                3,
                &["idx_media_uploader", "idx_media_charged_to"][..],
            ),
            (
                "a server's webhooks",
                super::HOOKS_USED,
                &[1][..],
                3,
                &["idx_media_charged_server"][..],
            ),
            (
                "the insert",
                super::STORE,
                &[1, 2, 3, 5, 9, 10, 11][..],
                12,
                &[
                    "idx_media_uploader",
                    "idx_media_charged_to",
                    "idx_media_charged_server",
                ][..],
            ),
        ] {
            let plan = plan(db, sql, texts, binds).await;
            for index in indexes {
                assert!(plan.contains(index), "{what}: {index} is used\n{plan}");
            }
            assert!(
                !plan.contains("idx_media_uploaded_at") && !plan.contains("SCAN media"),
                "{what}: no walk over every recent file\n{plan}"
            );
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn concurrent_uploads_never_pass_the_budget_together() {
        let (state, path) = temp_state("media_budget_race").await;
        let kib = 1024u64;
        let budget = 10 * kib;
        let data = vec![7u8; kib as usize];
        let uploads = (0..40).map(|_| {
            save_within(
                &state,
                "a.bin",
                NEUTRAL_MIME,
                &data,
                "alice",
                Charge::own("alice"),
                budget,
            )
        });
        let results = futures_util::future::join_all(uploads).await;
        let stored = results.iter().filter(|r| r.is_ok()).count();
        for r in &results {
            if let Err(ApiError(code, msg)) = r {
                assert_eq!(*code, StatusCode::TOO_MANY_REQUESTS, "{msg}");
            }
        }
        let (rows, used): (i64, i64) = {
            let row = sqlx::query(
                "SELECT COUNT(*), CAST(COALESCE(SUM(size), 0) AS BIGINT) FROM media WHERE uploader = 'alice'",
            )
            .fetch_one(&state.db)
            .await
            .expect("sum");
            (row.get(0), row.get(1))
        };
        assert_eq!(rows as usize, stored);
        assert!(
            used as u64 <= budget,
            "{used} bytes stored past a {budget} byte budget"
        );
        assert_eq!(stored, 10, "the budget is filled exactly");
        let chunks: i64 = sqlx::query("SELECT COUNT(*) FROM media_chunks")
            .fetch_one(&state.db)
            .await
            .expect("chunks")
            .get(0);
        assert_eq!(chunks, 10, "refused uploads leave no chunks behind");
        done(state, path).await;
    }

    const MAX: usize = 25 * 1024 * 1024;

    fn test_waits(room_ms: u64, idle_ms: u64) -> Waits {
        Waits {
            room: std::time::Duration::from_millis(room_ms),
            idle: std::time::Duration::from_millis(idle_ms),
            body: std::time::Duration::from_secs(60),
        }
    }

    fn pieces(
        n: usize,
        kib: usize,
    ) -> impl futures_util::Stream<Item = Result<axum::body::Bytes, std::io::Error>> {
        use futures_util::StreamExt;
        futures_util::stream::iter(0..n).then(move |_| async move {
            tokio::task::yield_now().await;
            Ok(axum::body::Bytes::from(vec![7u8; kib * 1024]))
        })
    }

    /// A body that sends one piece of `kib` KiB and then nothing.
    fn stalled(
        kib: usize,
    ) -> impl futures_util::Stream<Item = Result<axum::body::Bytes, std::io::Error>> {
        use futures_util::StreamExt;
        pieces(1, kib).chain(futures_util::stream::pending())
    }

    fn slot(db: &crate::db::Db, who: &str) -> crate::api::budget::Slot {
        reading_slot(db, who).expect("slot")
    }

    /// Takes room as an upload handler does, then reads `stream` as its file part.
    async fn read(
        stream: impl futures_util::Stream<Item = Result<axum::body::Bytes, std::io::Error>>
        + Send
        + 'static,
        declared: Option<u64>,
        max: usize,
        room: Room,
        waits: Waits,
        slot: crate::api::budget::Slot,
    ) -> Result<super::Buffered, ApiError> {
        let held = take_room(slot, declared, max, room, waits.room).await?;
        let watch = Watch::default();
        read_chunks(
            paced(stream, usize::MAX, waits, watch.clone()),
            max,
            held,
            &watch,
        )
        .await
    }

    /// The whole buffer, with no share per account.
    fn whole(buffer: &std::sync::Arc<tokio::sync::Semaphore>) -> Room {
        Room {
            buffer: buffer.clone(),
            share: u32::MAX,
        }
    }

    #[tokio::test]
    async fn the_whole_body_is_reserved_once_and_given_back() {
        let (state, path) = temp_state("media_reserve").await;
        let db = &state.db;
        let room = std::sync::Arc::new(tokio::sync::Semaphore::new(64));
        let first = read(
            pieces(3, 16),
            Some(48 * 1024),
            MAX,
            whole(&room),
            test_waits(50, 5000),
            slot(db, "a"),
        )
        .await
        .expect("fits");
        assert_eq!(first.data.len(), 48 * 1024);
        assert_eq!(room.available_permits(), 16);
        let busy = read(
            pieces(2, 16),
            Some(32 * 1024),
            MAX,
            whole(&room),
            test_waits(50, 5000),
            slot(db, "b"),
        )
        .await;
        assert_eq!(
            busy.err().map(|ApiError(c, _)| c),
            Some(StatusCode::SERVICE_UNAVAILABLE),
            "no room for the declared length: refused before reading"
        );
        assert_eq!(room.available_permits(), 16, "a refused body holds nothing");
        drop(first);
        assert_eq!(
            room.available_permits(),
            64,
            "a stored body gives its room back"
        );
        let lying = read(
            pieces(3, 16),
            Some(16 * 1024),
            MAX,
            whole(&room),
            test_waits(50, 5000),
            slot(db, "c"),
        )
        .await;
        assert_eq!(
            lying.err().map(|ApiError(c, _)| c),
            Some(StatusCode::PAYLOAD_TOO_LARGE),
            "never more than the room taken"
        );
        let big = read(
            pieces(MAX / (16 * 1024) + 1, 16),
            None,
            MAX,
            whole(&std::sync::Arc::new(tokio::sync::Semaphore::new(
                MAX / 1024,
            ))),
            test_waits(50, 5000),
            slot(db, "d"),
        )
        .await;
        assert_eq!(
            big.err().map(|ApiError(c, _)| c),
            Some(StatusCode::PAYLOAD_TOO_LARGE)
        );
        assert_eq!(room.available_permits(), 64);
        done(state, path).await;
    }

    #[tokio::test]
    async fn stalled_uploads_of_one_account_do_not_block_others() {
        let (state, path) = temp_state("media_stalled").await;
        let db = state.db.clone();
        let room = std::sync::Arc::new(tokio::sync::Semaphore::new(100));
        let waits = test_waits(5000, 300);
        let stuck: Vec<_> = (0..UPLOADS_PER_ACCOUNT)
            .map(|_| {
                let (room, held) = (room.clone(), slot(&db, "mallory"));
                tokio::spawn(read(
                    stalled(1),
                    Some(30 * 1024),
                    MAX,
                    whole(&room),
                    waits,
                    held,
                ))
            })
            .collect();
        let ceiling = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while room.available_permits() > 10 {
            assert!(
                std::time::Instant::now() < ceiling,
                "each body reserves its declared size"
            );
            tokio::task::yield_now().await;
        }
        assert!(
            matches!(
                reading_slot(&db, "mallory"),
                Err(ApiError(StatusCode::TOO_MANY_REQUESTS, _))
            ),
            "one account reads at most {UPLOADS_PER_ACCOUNT} bodies at once"
        );
        let small = read(
            pieces(1, 8),
            Some(8 * 1024),
            MAX,
            whole(&room),
            waits,
            slot(&db, "alice"),
        )
        .await
        .expect("another account's upload goes through");
        drop(small);
        let started = std::time::Instant::now();
        let large = read(
            pieces(4, 8),
            Some(32 * 1024),
            MAX,
            whole(&room),
            waits,
            slot(&db, "bob"),
        )
        .await
        .expect("room comes back once the stalled bodies are dropped");
        assert_eq!(large.data.len(), 32 * 1024);
        assert!(started.elapsed() < std::time::Duration::from_secs(4));
        for upload in stuck {
            let res = upload.await.expect("task");
            assert_eq!(
                res.err().map(|ApiError(c, _)| c),
                Some(StatusCode::REQUEST_TIMEOUT)
            );
        }
        drop(large);
        assert_eq!(room.available_permits(), 100);
        assert!(
            reading_slot(&db, "mallory").is_ok(),
            "the account's places are given back"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn concurrent_large_uploads_all_finish() {
        let (state, path) = temp_state("media_concurrent").await;
        let room = std::sync::Arc::new(tokio::sync::Semaphore::new(100));
        let uploads = (0..8).map(|n| {
            let (room, held) = (room.clone(), slot(&state.db, &format!("user{n}")));
            tokio::spawn(async move {
                let body = read(
                    pieces(5, 8),
                    Some(40 * 1024),
                    MAX,
                    whole(&room),
                    test_waits(20_000, 5000),
                    held,
                )
                .await?;
                tokio::task::yield_now().await;
                Ok::<usize, ApiError>(body.data.len())
            })
        });
        for done in futures_util::future::join_all(uploads).await {
            assert_eq!(
                done.expect("task").ok(),
                Some(40 * 1024),
                "every upload finishes"
            );
        }
        assert_eq!(room.available_permits(), 100);
        done(state, path).await;
    }

    #[test]
    fn one_account_gets_three_uploads_a_quarter_or_one_upload() {
        let mib = 1024 * 1024;
        let body = |max: u64| ((max + 1) * mib) as usize;
        assert_eq!(share_kib(256 * mib, body(25)), 78 * 1024);
        assert!(
            3 * (25 * 1024 + 1) <= share_kib(256 * mib, body(25)),
            "three uploads of the most size at the defaults"
        );
        assert_eq!(share_kib(2048 * mib, body(25)), 512 * 1024, "a quarter");
        assert_eq!(share_kib(256 * mib, body(128)), 129 * 1024, "one upload");
        assert_eq!(share_kib(1024 * mib, body(512)), 513 * 1024);
        assert_eq!(share_kib(50 * mib, body(25)), 26 * 1024);
        assert_eq!(share_kib(32 * mib, body(25)), 26 * 1024);
        assert_eq!(
            share_kib(32 * mib, body(32)),
            32 * 1024,
            "at most the buffer"
        );
    }

    #[tokio::test]
    async fn one_account_holds_at_most_its_share_of_the_buffer() {
        let (state, path) = temp_state("media_share").await;
        let db = state.db.clone();
        let buffer = std::sync::Arc::new(tokio::sync::Semaphore::new(100));
        let room = || Room {
            buffer: buffer.clone(),
            share: 25,
        };
        let waits = test_waits(5000, 3000);
        let max = 25 * 1024;
        let stuck = tokio::spawn(read(
            stalled(1),
            Some(max as u64),
            max,
            room(),
            waits,
            slot(&db, "mallory"),
        ));
        let ceiling = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while buffer.available_permits() > 75 {
            assert!(std::time::Instant::now() < ceiling, "the upload is held");
            tokio::task::yield_now().await;
        }
        let more = read(
            pieces(1, 1),
            Some(1024),
            max,
            room(),
            waits,
            slot(&db, "mallory"),
        )
        .await;
        match more {
            Err(ApiError(code, msg)) => {
                assert_eq!(code, StatusCode::TOO_MANY_REQUESTS);
                assert!(msg.starts_with("Too many uploads at once: up to "), "{msg}");
                assert!(msg.ends_with(" per account") && msg.is_ascii(), "{msg}");
            }
            Ok(_) => panic!("one account holds at most its share"),
        }
        assert_eq!(
            buffer.available_permits(),
            75,
            "a refused body holds nothing"
        );
        let others: Vec<_> = ["alice", "bob", "carol"]
            .into_iter()
            .map(|who| {
                let (room, held) = (room(), slot(&db, who));
                tokio::spawn(read(pieces(3, 8), Some(24 * 1024), max, room, waits, held))
            })
            .collect();
        for upload in others {
            let body = upload.await.expect("task").expect("other accounts upload");
            assert_eq!(body.data.len(), 24 * 1024);
        }
        assert_eq!(
            stuck.await.expect("task").err().map(|ApiError(c, _)| c),
            Some(StatusCode::REQUEST_TIMEOUT)
        );
        let again = read(
            pieces(1, 1),
            Some(1024),
            max,
            room(),
            waits,
            slot(&db, "mallory"),
        )
        .await
        .expect("the share is given back");
        drop(again);
        assert_eq!(buffer.available_permits(), 100);
        done(state, path).await;
    }

    #[tokio::test]
    async fn json_parts_are_capped_and_timed_outside_the_buffer() {
        let waits = test_waits(5000, 300);
        let two = 2 * 1024 * 1024;
        let small = read_small(pieces(2, 8), Some(16 * 1024), two, waits)
            .await
            .expect("fits");
        assert_eq!(small.len(), 16 * 1024);
        for (body, declared) in [(pieces(3, 1024), None), (pieces(3, 1024), Some(1024))] {
            match read_small(body, declared, two, waits).await {
                Err(ApiError(code, msg)) => {
                    assert_eq!(code, StatusCode::PAYLOAD_TOO_LARGE);
                    assert_eq!(msg, "JSON exceeds 2MB limit");
                }
                Ok(_) => panic!("3 MiB is over the cap"),
            }
        }
        let started = std::time::Instant::now();
        let declared = read_small(
            futures_util::stream::pending::<Result<axum::body::Bytes, std::io::Error>>(),
            Some(3 * 1024 * 1024),
            two,
            waits,
        )
        .await;
        assert_eq!(
            declared.err().map(|ApiError(c, _)| c),
            Some(StatusCode::PAYLOAD_TOO_LARGE),
            "refused on its declared length before reading"
        );
        assert!(started.elapsed() < std::time::Duration::from_millis(250));
        let stuck = read_small(stalled(1), None, two, waits).await;
        assert_eq!(
            stuck.err().map(|ApiError(c, _)| c),
            Some(StatusCode::REQUEST_TIMEOUT)
        );
    }

    /// A multipart request with the boundary `XB` whose body is `stream`.
    fn form_request(
        stream: impl futures_util::Stream<Item = Result<axum::body::Bytes, std::io::Error>>
        + Send
        + 'static,
    ) -> axum::extract::Request {
        axum::http::Request::builder()
            .header(
                axum::http::header::CONTENT_TYPE,
                "multipart/form-data; boundary=XB",
            )
            .body(axum::body::Body::from_stream(stream))
            .expect("request")
    }

    #[tokio::test]
    async fn a_form_is_paced_as_one_body() {
        use futures_util::StreamExt;
        let waits = Waits {
            room: std::time::Duration::from_secs(5),
            idle: std::time::Duration::from_millis(300),
            body: std::time::Duration::from_millis(1500),
        };
        let failed = |watch: &Watch, e: axum::extract::multipart::MultipartError| {
            let over = || ApiError(StatusCode::PAYLOAD_TOO_LARGE, String::new());
            watch
                .error(over, ApiError(StatusCode::BAD_REQUEST, e.to_string()))
                .0
        };
        let first = |stream| async move {
            let (mut form, watch) = form_within(form_request(stream), 128 * 1024, waits)
                .await
                .expect("form");
            let started = std::time::Instant::now();
            let code = match form.next_field().await {
                Ok(_) => StatusCode::OK,
                Err(e) => failed(&watch, e),
            };
            (code, started.elapsed())
        };
        let header =
            futures_util::stream::iter([Ok::<_, std::io::Error>(axum::body::Bytes::from_static(
                b"--XB\r\nContent-Disposition: form-data; name=\"payload_json\"\r\n",
            ))]);
        for (what, stream) in [
            ("a preamble", stalled(1).boxed()),
            (
                "a part header",
                header.chain(futures_util::stream::pending()).boxed(),
            ),
        ] {
            let (code, took) = first(stream).await;
            assert_eq!(code, StatusCode::REQUEST_TIMEOUT, "{what} that stalls");
            assert!(
                took < std::time::Duration::from_millis(1200),
                "{what} ends at the idle wait: {took:?}"
            );
        }
        let (code, _) = first(pieces(4, 64).boxed()).await;
        assert_eq!(code, StatusCode::PAYLOAD_TOO_LARGE, "past its most bytes");
        let part = axum::body::Bytes::from_static(
            b"--XB\r\nContent-Disposition: form-data; name=\"payload_json\"\r\n\r\n{}\r\n",
        );
        let endless = futures_util::stream::unfold((), move |_| {
            let part = part.clone();
            async move {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                Some((Ok::<_, std::io::Error>(part), ()))
            }
        });
        let (mut form, watch) = form_within(form_request(endless), usize::MAX, waits)
            .await
            .expect("form");
        let started = std::time::Instant::now();
        let parts = async {
            let mut read = 0;
            loop {
                let field = match form.next_field().await {
                    Ok(Some(field)) => field,
                    Ok(None) => return (read, None),
                    Err(e) => return (read, Some(failed(&watch, e))),
                };
                match read_json_part(field, 1024, &watch).await {
                    Ok(_) => read += 1,
                    Err(ApiError(code, _)) => return (read, Some(code)),
                }
            }
        };
        let (read, code) = tokio::time::timeout(std::time::Duration::from_secs(6), parts)
            .await
            .expect("the body wait ends many parts");
        assert!(read > 3, "{read} parts");
        assert_eq!(code, Some(StatusCode::REQUEST_TIMEOUT));
        let took = started.elapsed();
        assert!(
            took >= std::time::Duration::from_millis(1400)
                && took < std::time::Duration::from_secs(4),
            "{took:?}"
        );
    }

    #[tokio::test]
    async fn multipart_bodies_take_their_room_before_they_are_parsed() {
        use tokio::io::AsyncWriteExt;
        let (state, path) = temp_state("media_preamble").await;
        add_alice(&state.db).await;
        let (addr, server) = serve(&state).await;
        let until = |kib: u64, why: &'static str| {
            let db = state.db.clone();
            async move {
                let ceiling = std::time::Instant::now() + std::time::Duration::from_secs(10);
                while share_held(&db, "alice") != kib {
                    assert!(std::time::Instant::now() < ceiling, "{why}");
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
            }
        };
        let mut socks = Vec::new();
        for _ in 0..2 {
            let mut sock = tokio::net::TcpStream::connect(addr).await.expect("connect");
            let head = format!(
                "POST /media HTTP/1.1\r\nHost: {addr}\r\nAuthorization: Bearer tok-alice\r\nContent-Type: multipart/form-data; boundary=XB\r\nContent-Length: {}\r\n\r\n",
                1024 * 1024
            );
            sock.write_all(head.as_bytes()).await.expect("head");
            sock.write_all(&[b'x'; 64 * 1024]).await.expect("preamble");
            socks.push(sock);
        }
        until(2 * 1024, "a preamble holds room for its whole body").await;
        drop(socks);
        until(0, "and gives it back when the client goes").await;
        server.abort();
        let (status, text) = post_file(&state, 8).await;
        assert_eq!(status, StatusCode::OK, "{text}");
        assert_eq!(share_held(&state.db, "alice"), 0);
        done(state, path).await;
    }

    #[tokio::test]
    async fn webhook_uploads_count_against_the_owner_and_the_server() {
        let (state, path) = temp_state("media_hook_budget").await;
        let kib = 1024u64;
        let budget = 10 * kib;
        let data = vec![7u8; 6 * kib as usize];
        let hook = |account, server| Charge {
            account,
            hooks_of: Some(server),
        };
        let save = |uploader: &'static str, charge: Charge<'static>| {
            let (state, data) = (state.clone(), data.clone());
            async move {
                save_within(
                    &state,
                    "a.bin",
                    NEUTRAL_MIME,
                    &data,
                    uploader,
                    charge,
                    budget,
                )
                .await
            }
        };
        let refused = |r: Result<(String, i64), ApiError>| {
            matches!(r, Err(ApiError(StatusCode::TOO_MANY_REQUESTS, _)))
        };
        assert!(save("@1", hook("alice", "s1")).await.is_ok());
        match save("@2", hook("alice", "s2")).await {
            Err(ApiError(StatusCode::TOO_MANY_REQUESTS, msg)) => assert_eq!(
                msg,
                "Upload limit reached: this webhook's owner, and all webhooks of its server together, can upload up to 10240 bytes a day. Space frees up 1 day after each upload, or sooner when a file is removed. The site admin sets this limit",
                "a second webhook of the same owner"
            ),
            _ => panic!("a second webhook of the same owner is refused"),
        }
        assert!(
            refused(save("alice", Charge::own("alice")).await),
            "the owner's own uploads share the budget"
        );
        assert!(refused(
            check_budget(&state.db, hook("alice", "s3"), 6 * kib, budget)
                .await
                .map(|_| (String::new(), 0))
        ));
        assert!(
            refused(save("@3", hook("bob", "s1")).await),
            "the server's webhooks together"
        );
        assert!(save("@4", hook("bob", "s2")).await.is_ok());
        assert!(save("carol", Charge::own("carol")).await.is_ok());
        let charged: Vec<(String, Option<String>, Option<String>)> =
            sqlx::query("SELECT uploader, charged_to, charged_server FROM media ORDER BY uploader")
                .fetch_all(&state.db)
                .await
                .expect("rows")
                .iter()
                .map(|r| (r.get(0), r.get(1), r.get(2)))
                .collect();
        assert_eq!(
            charged,
            vec![
                (
                    "@1".to_string(),
                    Some("alice".to_string()),
                    Some("s1".to_string())
                ),
                (
                    "@4".to_string(),
                    Some("bob".to_string()),
                    Some("s2".to_string())
                ),
                ("carol".to_string(), None, None),
            ]
        );
        done(state, path).await;
    }

    #[test]
    fn disposition_keeps_unicode() {
        assert_eq!(
            content_disposition("résumé.pdf"),
            "attachment; filename=\"r_sum_.pdf\"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf"
        );
        assert_eq!(
            content_disposition("a \"b\"\\c.txt"),
            "attachment; filename=\"a _b__c.txt\"; filename*=UTF-8''a%20%22b%22%5Cc.txt"
        );
        assert_eq!(
            content_disposition("😀.png"),
            "attachment; filename=\"_.png\"; filename*=UTF-8''%F0%9F%98%80.png"
        );
    }

    #[tokio::test]
    async fn shared_legacy_blob_survives_one_removal() {
        let (state, path) = temp_state("media_shared").await;
        let id = "dd".repeat(16);
        sqlx::query("INSERT INTO media(id, filename, mime, size, data, uploaded_at) VALUES($1, 'a.txt', 'text/plain', 1, $2, $3)")
            .bind(&id)
            .bind(vec![0u8])
            .bind(now())
            .execute(&state.db)
            .await
            .expect("insert media");
        let mut ids = Vec::new();
        for _ in 0..2 {
            let mid: i64 = sqlx::query("INSERT INTO messages(dm_id, author, content, media_id, media_filename, media_kind, created_at) VALUES(NULL, 'alice', '', $1, 'a.txt', 'server', $2) RETURNING id")
                .bind(&id)
                .bind(now())
                .fetch_one(&state.db)
                .await
                .expect("insert message")
                .try_get(0)
                .expect("message id");
            ids.push(mid);
        }
        let blob = |state: crate::state::AppState, id: String| async move {
            sqlx::query("SELECT 1 FROM media WHERE id = $1")
                .bind(id)
                .fetch_optional(&state.db)
                .await
                .expect("read media")
                .is_some()
        };
        for (n, mid) in ids.iter().enumerate() {
            let _ = delete_media(
                State(state.clone()),
                Path(*mid),
                Authed(mem_user("alice", false)),
            )
            .await
            .expect("remove attachment");
            assert_eq!(blob(state.clone(), id.clone()).await, n == 0);
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn sweep_skips_p2p() {
        let path = crate::db::temp_db_path("sweep");
        let _ = std::fs::remove_file(&path);
        let db = open(path.to_str()).await.expect("open db");
        let old = now() - 90000;
        sqlx::query("INSERT INTO media(id, filename, mime, size, data, uploaded_at) VALUES($1, 'a.txt', 'text/plain', 1, $2, $3)")
            .bind("ab".repeat(16))
            .bind(vec![0u8])
            .bind(old)
            .execute(&db)
            .await
            .expect("insert media");
        sqlx::query("INSERT INTO messages(author, content, media_id, media_filename, media_removed, media_spoiler, media_kind, created_at) VALUES('u', '', $1, 'a.txt', 0, 0, 'server', $2)")
            .bind("ab".repeat(16))
            .bind(old)
            .execute(&db)
            .await
            .expect("insert server message");
        sqlx::query("INSERT INTO messages(author, content, media_id, media_filename, media_removed, media_spoiler, media_kind, media_hoster, media_expires_at, media_size, media_mime, created_at) VALUES('u', '', $1, 'b.txt', 0, 0, 'p2p', 'u', $2, 1, 'text/plain', $3)")
            .bind("ab".repeat(16))
            .bind(old)
            .bind(old)
            .execute(&db)
            .await
            .expect("insert p2p message");
        sweep(&db, None).await.expect("sweep");
        let rows =
            sqlx::query("SELECT media_kind, media_removed, media_hoster FROM messages ORDER BY id")
                .fetch_all(&db)
                .await
                .expect("read messages");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].try_get::<i64, _>(1).unwrap(), 1);
        assert_eq!(rows[1].try_get::<String, _>(0).unwrap(), "p2p");
        assert_eq!(rows[1].try_get::<i64, _>(1).unwrap(), 0);
        assert_eq!(rows[1].try_get::<String, _>(2).unwrap(), "u");
        let blobs = sqlx::query("SELECT 1 FROM media")
            .fetch_all(&db)
            .await
            .expect("read media");
        assert!(blobs.is_empty());
        db.close().await;
        let _ = std::fs::remove_file(&path);
    }

    async fn general(db: &crate::db::Db) -> i64 {
        sqlx::query("SELECT id FROM channels WHERE server = 'rchat'")
            .fetch_one(db)
            .await
            .expect("general")
            .try_get(0)
            .expect("id")
    }

    #[tokio::test]
    async fn empty_uploads_download_as_empty_files() {
        let (state, path) = temp_state("media_empty").await;
        let id = "ef".repeat(16);
        store_media(
            &state.db,
            &id,
            "empty.txt",
            "text/plain",
            0,
            Some(&[]),
            "alice",
            now(),
        )
        .await
        .expect("store media");
        let cid = general(&state.db).await;
        sqlx::query("INSERT INTO messages(channel_id, author, content, media_id, media_filename, created_at) VALUES($1, 'alice', '', $2, 'empty.txt', 1)")
            .bind(cid)
            .bind(&id)
            .execute(&state.db)
            .await
            .expect("attach");
        let res = download_media(State(state.clone()), axum::http::HeaderMap::new(), Path(id))
            .await
            .expect("download");
        assert_eq!(res.status(), axum::http::StatusCode::OK);
        assert_eq!(res.headers()[axum::http::header::CONTENT_LENGTH], "0");
        let body = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .expect("body");
        assert!(body.is_empty());
        done(state, path).await;
    }

    #[tokio::test]
    async fn p2p_messages_never_open_server_media() {
        let (state, path) = temp_state("media_p2p_ref").await;
        let db = &state.db;
        let id = "c4".repeat(16);
        store_media(
            db,
            &id,
            "a.txt",
            "text/plain",
            1,
            Some(&[1]),
            "alice",
            now(),
        )
        .await
        .expect("store media");
        let dm: i64 =
            sqlx::query("INSERT INTO dms(user_a, user_b) VALUES('alice', 'carol') RETURNING id")
                .fetch_one(db)
                .await
                .expect("dm")
                .try_get(0)
                .expect("dm id");
        sqlx::query("INSERT INTO messages(dm_id, author, content, media_id, media_filename, created_at) VALUES($1, 'alice', '', $2, 'a.txt', 1)")
            .bind(dm)
            .bind(&id)
            .execute(db)
            .await
            .expect("attach in a private DM");
        let cid = general(db).await;
        let p2p: i64 = sqlx::query("INSERT INTO messages(channel_id, author, content, media_id, media_filename, media_kind, media_hoster, media_size, media_mime, media_sha256, created_at) VALUES($1, 'bob', '', $2, 'a.txt', 'p2p', 'bob', 1, 'text/plain', $3, 2) RETURNING id")
            .bind(cid)
            .bind(&id)
            .bind("ab".repeat(32))
            .fetch_one(db)
            .await
            .expect("bob's P2P message reusing the id")
            .try_get(0)
            .expect("id");
        let headers = axum::http::HeaderMap::new();
        let view = |who: &'static str| {
            let headers = headers.clone();
            let id = id.clone();
            let state = state.clone();
            async move {
                media_view_ok(
                    &state.db,
                    &Proof::headers(&headers, &state.limits),
                    &id,
                    Some(&mem_user(who, false)),
                )
                .await
                .is_ok()
            }
        };
        assert!(view("carol").await);
        assert!(!view("bob").await, "a readable P2P row is not a reference");
        let _ = delete_media(
            State(state.clone()),
            Path(p2p),
            Authed(mem_user("bob", false)),
        )
        .await
        .expect("remove");
        let row = sqlx::query("SELECT media_sha256, media_removed FROM messages WHERE id = $1")
            .bind(p2p)
            .fetch_one(db)
            .await
            .expect("row");
        assert_eq!(row.try_get::<Option<String>, _>(0).expect("hash"), None);
        assert_eq!(row.try_get::<i64, _>(1).expect("removed"), 2);
        done(state, path).await;
    }

    #[tokio::test]
    async fn text_only_instances_serve_no_files() {
        let (state, path) = temp_state("media_text_only").await;
        let db = &state.db;
        let id = "c5".repeat(16);
        store_media(
            db,
            &id,
            "a.txt",
            "text/plain",
            1,
            Some(&[1]),
            "alice",
            now(),
        )
        .await
        .expect("store media");
        let cid = general(db).await;
        sqlx::query("INSERT INTO messages(channel_id, author, content, media_id, media_filename, created_at) VALUES($1, 'alice', '', $2, 'a.txt', 1)")
            .bind(cid)
            .bind(&id)
            .execute(db)
            .await
            .expect("attach");
        let get = || {
            download_media(
                State(state.clone()),
                axum::http::HeaderMap::new(),
                Path(id.clone()),
            )
        };
        for (key, on, ok) in [
            ("asset_uploads", false, true),
            ("p2p_attachments", false, false),
            ("asset_uploads", true, true),
        ] {
            sqlx::query("INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
                .bind(key)
                .bind(if on { "1" } else { "0" })
                .execute(db)
                .await
                .expect("setting");
            crate::api::Settings::forget(db);
            match get().await {
                Ok(res) => assert!(ok && res.status() == axum::http::StatusCode::OK),
                Err(ApiError(status, msg)) => {
                    assert!(!ok);
                    assert_eq!(status, axum::http::StatusCode::FORBIDDEN);
                    assert_eq!(msg, "Attachments are turned off on this server");
                }
            }
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn banned_users_cannot_fetch_an_open_servers_media() {
        let (state, path) = temp_state("media_banned").await;
        let id = "be".repeat(16);
        store_media(
            &state.db,
            &id,
            "a.txt",
            "text/plain",
            1,
            Some(&[1]),
            "alice",
            now(),
        )
        .await
        .expect("store media");
        let cid = general(&state.db).await;
        sqlx::query("INSERT INTO messages(channel_id, author, content, media_id, media_filename, created_at) VALUES($1, 'alice', '', $2, 'a.txt', 1)")
            .bind(cid)
            .bind(&id)
            .execute(&state.db)
            .await
            .expect("attach");
        let headers = axum::http::HeaderMap::new();
        let see = |who: &'static str, admin: bool| {
            let (state, headers, id) = (state.clone(), headers.clone(), id.clone());
            async move {
                media_view_ok(
                    &state.db,
                    &Proof::headers(&headers, &state.limits),
                    &id,
                    Some(&mem_user(who, admin)),
                )
                .await
                .is_ok()
            }
        };
        assert!(see("carol", false).await && see("root", true).await);
        sqlx::query("INSERT INTO server_bans(server, username, created_at) VALUES('rchat', 'carol', 1), ('rchat', 'root', 1)")
            .execute(&state.db)
            .await
            .expect("ban");
        assert!(!see("carol", false).await);
        assert!(!see("root", true).await);
        assert!(see("dave", false).await);
        assert!(
            media_view_ok(
                &state.db,
                &Proof::headers(&headers, &state.limits),
                &id,
                None
            )
            .await
            .is_ok()
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn downloads_stream_in_chunks_and_revalidate() {
        let (state, path) = temp_state("media_stream").await;
        let id = "ee".repeat(16);
        let blob: Vec<u8> = (0..700_000u32).map(|i| (i % 251) as u8).collect();
        store_media(
            &state.db,
            &id,
            "big.bin",
            "application/octet-stream",
            blob.len() as i64,
            Some(&blob),
            "alice",
            now(),
        )
        .await
        .expect("store media");
        let chunks: i64 = sqlx::query("SELECT COUNT(*) FROM media_chunks WHERE media_id = $1")
            .bind(&id)
            .fetch_one(&state.db)
            .await
            .expect("chunks")
            .try_get(0)
            .expect("n");
        assert_eq!(chunks, 3);
        let cid = general(&state.db).await;
        sqlx::query("INSERT INTO messages(channel_id, author, content, media_id, media_filename, created_at) VALUES($1, 'alice', '', $2, 'big.bin', 1)")
            .bind(cid)
            .bind(&id)
            .execute(&state.db)
            .await
            .expect("attach");
        let get = |headers: axum::http::HeaderMap| {
            let state = state.clone();
            let id = id.clone();
            async move {
                download_media(State(state), headers, Path(id))
                    .await
                    .expect("download")
            }
        };
        let res = get(axum::http::HeaderMap::new()).await;
        assert_eq!(res.status(), axum::http::StatusCode::OK);
        let etag = res.headers()[axum::http::header::ETAG].clone();
        assert_eq!(
            res.headers()[axum::http::header::CONTENT_LENGTH],
            blob.len().to_string().as_str()
        );
        assert!(
            res.headers()[axum::http::header::CACHE_CONTROL]
                .to_str()
                .expect("cache header")
                .contains("immutable")
        );
        assert_eq!(res.headers()[axum::http::header::VARY], "X-Guest-Grant");
        let body = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .expect("body");
        assert_eq!(body.as_ref(), blob.as_slice());
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(axum::http::header::IF_NONE_MATCH, etag);
        let cached = get(headers).await;
        assert_eq!(cached.status(), axum::http::StatusCode::NOT_MODIFIED);
        assert_eq!(cached.headers()[axum::http::header::VARY], "X-Guest-Grant");
        sqlx::query("DELETE FROM media WHERE id = $1")
            .bind(&id)
            .execute(&state.db)
            .await
            .expect("delete media");
        let left: i64 = sqlx::query("SELECT COUNT(*) FROM media_chunks")
            .fetch_one(&state.db)
            .await
            .expect("chunks")
            .try_get(0)
            .expect("n");
        assert_eq!(left, 0);
        done(state, path).await;
    }

    #[tokio::test]
    async fn restricted_channel_and_dm_media_follow_message_reads() {
        let (state, path) = temp_state("media_channel_perms").await;
        let db = &state.db;
        let cid = general(db).await;
        let attach = |n: u8, sql: &'static str, key: i64, created_at: i64| {
            let state = state.clone();
            async move {
                let id = format!("{n:02x}").repeat(16);
                store_media(
                    &state.db,
                    &id,
                    "a.txt",
                    "text/plain",
                    1,
                    Some(&[1]),
                    "alice",
                    now(),
                )
                .await
                .expect("store media");
                sqlx::query(sqlx::AssertSqlSafe(sql))
                    .bind(key)
                    .bind(&id)
                    .bind(created_at)
                    .execute(&state.db)
                    .await
                    .expect("attach");
                id
            }
        };
        let old = attach(1, "INSERT INTO messages(channel_id, author, content, media_id, media_filename, created_at) VALUES($1, 'alice', '', $2, 'a.txt', $3)", cid, 50).await;
        let fresh = attach(2, "INSERT INTO messages(channel_id, author, content, media_id, media_filename, created_at) VALUES($1, 'alice', '', $2, 'a.txt', $3)", cid, 150).await;
        let root: i64 = sqlx::query("INSERT INTO messages(channel_id, author, content, created_at) VALUES($1, 'alice', 'root', 150) RETURNING id")
            .bind(cid)
            .fetch_one(db)
            .await
            .expect("root")
            .try_get(0)
            .expect("root id");
        let reply = attach(3, "INSERT INTO messages(channel_id, thread_root_id, author, content, media_id, media_filename, created_at) VALUES((SELECT channel_id FROM messages WHERE id = $1), $1, 'alice', '', $2, 'a.txt', $3)", root, 150).await;
        let dm: i64 =
            sqlx::query("INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id")
                .fetch_one(db)
                .await
                .expect("dm")
                .try_get(0)
                .expect("dm id");
        let in_dm = attach(4, "INSERT INTO messages(dm_id, author, content, media_id, media_filename, created_at) VALUES($1, 'alice', '', $2, 'a.txt', $3)", dm, 150).await;
        for (name, joined) in [("bob", 100), ("carol", 100), ("hist", 100)] {
            crate::api::test_util::add_member(db, "rchat", name, 0, 0, joined).await;
        }
        sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'u:bob', 1, 1, 0), ($1, 'u:hist', 1, 1, 1)")
            .bind(cid)
            .execute(db)
            .await
            .expect("restrict");
        crate::api::test_util::restrict_ruled(db).await;
        let headers = axum::http::HeaderMap::new();
        let see = |who: Option<&'static str>, id: String| {
            let (state, headers) = (state.clone(), headers.clone());
            async move {
                let user = who.map(|w| mem_user(w, w == "root"));
                media_view_ok(
                    &state.db,
                    &Proof::headers(&headers, &state.limits),
                    &id,
                    user.as_ref(),
                )
                .await
                .is_ok()
            }
        };
        for id in [&old, &fresh, &reply] {
            assert!(!see(Some("carol"), id.clone()).await, "carol {id}");
            assert!(!see(None, id.clone()).await, "guest {id}");
            assert!(see(Some("hist"), id.clone()).await, "hist {id}");
            assert!(see(Some("root"), id.clone()).await, "root {id}");
        }
        assert!(!see(Some("bob"), old.clone()).await);
        assert!(see(Some("bob"), fresh.clone()).await);
        assert!(see(Some("bob"), reply.clone()).await);
        assert!(see(Some("alice"), in_dm.clone()).await && see(Some("bob"), in_dm.clone()).await);
        assert!(!see(Some("carol"), in_dm.clone()).await);
        assert!(!see(None, in_dm.clone()).await);
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(
            axum::http::header::IF_NONE_MATCH,
            format!("\"{fresh}\"").parse().expect("etag"),
        );
        let cached = download_media(State(state.clone()), headers, Path(fresh.clone())).await;
        assert_eq!(
            cached.err().map(|ApiError(c, m)| (c, m)),
            Some((
                axum::http::StatusCode::NOT_FOUND,
                "Media not found".to_string()
            ))
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn guests_prove_access_to_protected_media_by_header_only() {
        let (state, path) = temp_state("media_guest_grant").await;
        let db = &state.db;
        sqlx::query("INSERT INTO servers(name, display_name, password_hash, created_at) VALUES('locked', 'locked', 'x', 0)")
            .execute(db)
            .await
            .expect("server");
        let cid: i64 = sqlx::query("INSERT INTO channels(server, name, created_at) VALUES('locked', 'vault', 0) RETURNING id")
            .fetch_one(db)
            .await
            .expect("channel")
            .try_get(0)
            .expect("channel id");
        let id = "ab".repeat(16);
        store_media(
            db,
            &id,
            "a.txt",
            "text/plain",
            1,
            Some(&[1]),
            "alice",
            now(),
        )
        .await
        .expect("store media");
        sqlx::query("INSERT INTO messages(channel_id, author, content, media_id, media_filename, created_at) VALUES($1, 'alice', '', $2, 'a.txt', 1)")
            .bind(cid)
            .bind(&id)
            .execute(db)
            .await
            .expect("attach");
        sqlx::query("INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at) VALUES($1, 'locked', 0, 4000000000)")
            .bind(crate::db::secret_key(&crate::api::test_util::test_grant("g1")))
            .execute(db)
            .await
            .expect("grant");
        let grant = crate::api::test_util::test_grant("g1");
        let mut with_header = axum::http::HeaderMap::new();
        with_header.insert("x-guest-grant", grant.parse().expect("header"));
        assert!(
            media_view_ok(db, &Proof::headers(&with_header, &state.limits), &id, None)
                .await
                .is_ok()
        );
        let hidden =
            download_media(State(state.clone()), axum::http::HeaderMap::new(), Path(id)).await;
        assert_eq!(
            hidden.err().map(|ApiError(c, m)| (c, m)),
            Some((
                axum::http::StatusCode::NOT_FOUND,
                "Media not found".to_string()
            ))
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn sweep_handles_more_than_one_batch() {
        let (state, path) = temp_state("media_sweep_batches").await;
        let db = &state.db;
        let cid = general(db).await;
        let old = now() - 90000;
        let total = SWEEP_BATCH + 37;
        for n in 0..total {
            let id = format!("{n:032x}");
            sqlx::query("INSERT INTO media(id, filename, mime, size, data, uploaded_at) VALUES($1, 'a.txt', 'text/plain', 1, $2, $3)")
                .bind(&id)
                .bind(vec![1u8])
                .bind(old)
                .execute(db)
                .await
                .expect("media");
            sqlx::query("INSERT INTO messages(channel_id, author, content, media_id, media_filename, created_at) VALUES($1, 'u', '', $2, 'a.txt', 1)")
                .bind(cid)
                .bind(&id)
                .execute(db)
                .await
                .expect("message");
        }
        let events = sweep(db, None).await.expect("sweep");
        assert_eq!(events.len() as i64, total);
        assert!(events.iter().all(|e| matches!(
            e,
            crate::ws::WsEvent::MediaRemoved { server: Some(s), .. } if s == "rchat"
        )));
        let left: i64 = sqlx::query("SELECT COUNT(*) FROM media")
            .fetch_one(db)
            .await
            .expect("count")
            .try_get(0)
            .expect("n");
        assert_eq!(left, 0);
        done(state, path).await;
    }
}
