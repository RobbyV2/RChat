use std::fmt::Write;

use axum::Json;
use axum::body::Body;
use axum::extract::multipart::MultipartRejection;
use axum::extract::{FromRequest, Multipart, Path, Query, Request, State};
use axum::http::{StatusCode, header};
use axum::response::Response;
use rand::Rng;
use s3::Bucket;
use sqlx::Row;

use crate::api::access::{MsgScope, Proof, resolve_message};
use crate::api::audit;
use crate::api::form_heads::Heads;
use crate::api::{
    ApiError, ApiErrorBody, Authed, MediaRef, OkResp, Settings, allowed, bad, ok, placeholders,
    request_token, require_guest_ok, user_for_token,
};
use crate::crypt::media::{Facts, MediaKey, chunk_len, chunks};
use crate::db::{Db, MediaKind, User, now};
use crate::state::AppState;
use crate::ws::WsEvent;

#[cfg(test)]
pub(crate) mod s3_stub;
pub(crate) mod sealed;

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
    std::sync::LazyLock::new(crate::api::budget::Slots::default);

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

#[cfg(test)]
tokio::task_local! {
    static TEST_WAITS: Waits;
}

/// Runs `f` with `idle` and `body` as the waits of upload bodies and downloads.
#[cfg(test)]
pub(crate) async fn with_waits<T>(
    idle: std::time::Duration,
    body: std::time::Duration,
    f: impl std::future::Future<Output = T>,
) -> T {
    let waits = Waits {
        room: BUFFER_WAIT,
        idle,
        body,
    };
    TEST_WAITS.scope(waits, f).await
}

fn waits() -> Waits {
    #[cfg(test)]
    if let Ok(waits) = TEST_WAITS.try_with(|waits| *waits) {
        return waits;
    }
    WAITS
}

/// One of the `UPLOADS_PER_ACCOUNT` places of the account an upload is charged to, held while
/// its body is read and stored. 429 when the account already reads that many.
pub(crate) fn reading_slot(db: &Db, account: &str) -> Result<crate::api::budget::Slot, ApiError> {
    READING
        .enter(
            format!("{}\n{account}", crate::db::pool_key(db)),
            UPLOADS_PER_ACCOUNT,
        )
        .ok_or_else(|| {
            ApiError::limit(
                StatusCode::TOO_MANY_REQUESTS,
                format!("Too many uploads at once: up to {UPLOADS_PER_ACCOUNT} per account"),
                "uploads_per_account",
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
    ApiError::limit(
        StatusCode::PAYLOAD_TOO_LARGE,
        format!("File exceeds {}MB limit", max / (1024 * 1024)),
        "upload_max_mib",
    )
}

/// 413 for JSON over `max` bytes.
pub(crate) fn json_over(max: usize) -> ApiError {
    ApiError::limit(
        StatusCode::PAYLOAD_TOO_LARGE,
        format!("JSON exceeds {}MB limit", max / (1024 * 1024)),
        "json_max_mib",
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
        true => waits().room,
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
            ApiError::limit(
                StatusCode::TOO_MANY_REQUESTS,
                format!(
                    "Too many uploads at once: up to {} per account",
                    fmt_bytes(u64::from(room.share) * 1024)
                ),
                "upload_buffer_share",
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
        ApiError::capacity(
            StatusCode::SERVICE_UNAVAILABLE,
            "Too many uploads right now, try again in a moment",
            "upload_buffer_mib",
            None,
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
                ApiError(StatusCode::PAYLOAD_TOO_LARGE, e, None),
            ),
        })?;
    Ok(Buffered { data, _held: held })
}

/// Reads a raw upload body of at most `max` bytes in the room `held` took for it, with the waits
/// of an upload body: `over()` past `max`, 408 when it stalls.
pub(crate) async fn read_raw(
    body: Body,
    max: usize,
    held: Held,
    over: fn() -> ApiError,
) -> Result<Buffered, ApiError> {
    let watch = Watch::default();
    let most = held.most.min(max);
    let stream = paced(body.into_data_stream(), most, waits(), watch.clone());
    let data = collect(stream, most).await.map_err(|stop| match stop {
        Stop::Over => over(),
        Stop::Failed(e) => watch.error(over, bad(&e)),
    })?;
    Ok(Buffered { data, _held: held })
}

/// A response body of `data`, sent in `MEDIA_CHUNK` pieces copied out of it, that holds `held`
/// until its last piece is taken. With the waits of an upload body: once nothing is taken for 30
/// seconds, or the whole takes over 10 minutes, the body ends short and `data` and `held` go.
pub(crate) fn send_held(data: Vec<u8>, held: Held) -> Body {
    let waits = waits();
    let (pieces, taken) = tokio::sync::mpsc::channel(1);
    tokio::spawn(async move {
        let end = tokio::time::Instant::now() + waits.body;
        for piece in data.chunks(MEDIA_CHUNK) {
            let next = (tokio::time::Instant::now() + waits.idle).min(end);
            let piece = axum::body::Bytes::copy_from_slice(piece);
            if !matches!(
                tokio::time::timeout_at(next, pieces.send(piece)).await,
                Ok(Ok(()))
            ) {
                break;
            }
        }
        drop((data, held));
    });
    Body::from_stream(futures_util::stream::unfold(
        taken,
        |mut taken| async move {
            let piece = taken.recv().await?;
            Some((Ok::<_, std::convert::Infallible>(piece), taken))
        },
    ))
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
    read_small(stream, declared, max, waits()).await
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
        None,
    )
}

type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// What a malformed multipart body gets, as the framework words it.
const MALFORMED_FORM: &str = "Error parsing `multipart/form-data` request";

/// Why a body was cut off before its end.
#[derive(Clone, Copy, Debug)]
enum Cut {
    /// More than its most bytes came.
    Over,
    /// Nothing came for `Waits::idle`, or the whole took longer than `Waits::body`.
    Stalled,
    /// A part's head of a form passed `HEAD_MAX`.
    Head,
}

impl std::fmt::Display for Cut {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Cut::Over => "The body is too large",
            Cut::Stalled => "The upload stopped sending data",
            Cut::Head => MALFORMED_FORM,
        })
    }
}

impl std::error::Error for Cut {}

/// Why a body was cut off, once it was.
#[derive(Clone, Default)]
pub(crate) struct Watch(std::sync::Arc<std::sync::OnceLock<Cut>>);

impl Watch {
    /// The error for a failed read of the body: 408 when it stalled, `over()` when it passed its
    /// most bytes, 400 when a part's head of a form passed `HEAD_MAX`, else `other`.
    pub(crate) fn error(&self, over: impl FnOnce() -> ApiError, other: ApiError) -> ApiError {
        match self.0.get() {
            Some(Cut::Stalled) => stalled(),
            Some(Cut::Over) => over(),
            Some(Cut::Head) => bad(MALFORMED_FORM),
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
/// with 408 and many parts can not make it last longer. Each part's head is at most `HEAD_MAX`
/// bytes (400 past it), and the parser gets the body in pieces (`in_pieces`). Its parts are read
/// with `next_part` and `read_file` or `read_json_part`, which poll the parser through `Quiet`.
/// The `Watch` says why when the pace or a head's cap cut it off.
pub(crate) async fn form(
    req: Request,
    most: usize,
) -> Result<(Multipart, Watch), MultipartRejection> {
    form_within(req, most, waits()).await
}

async fn form_within(
    req: Request,
    most: usize,
    waits: Waits,
) -> Result<(Multipart, Watch), MultipartRejection> {
    let watch = Watch::default();
    let (parts, body) = req.into_parts();
    let body = paced(body.into_data_stream(), most, waits, watch.clone());
    let boundary = parts
        .headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| multer::parse_boundary(v).ok());
    let body = match boundary {
        Some(boundary) => Body::from_stream(in_pieces(body, &boundary, watch.clone())),
        None => Body::from_stream(body),
    };
    let form = Multipart::from_request(Request::from_parts(parts, body), &()).await?;
    Ok((form, watch))
}

/// Fewest bytes handed to the multipart parser at once, but at the end of a body.
const PIECE: usize = 16 * 1024;

/// `stream`, the body of a form with the boundary `boundary`, as the multipart parser takes it:
/// in pieces of at least `PIECE` bytes, ended where a part's head passes `HEAD_MAX` (`watch` then
/// says so). From the parser's first poll, a task of its own reads `stream` (`feed`), so the
/// parser's waker fires once a piece however the body is sent. When `stream` fails, the bytes
/// before are handed on and the body ends there; `watch` says why when the pace cut it off. The
/// end comes a poll after the last piece, so the parser never hears of it in the read that brings
/// that piece.
fn in_pieces<S>(
    stream: S,
    boundary: &str,
    watch: Watch,
) -> impl futures_util::Stream<Item = Result<axum::body::Bytes, BoxError>> + Send + 'static
where
    S: futures_util::Stream<Item = Result<axum::body::Bytes, BoxError>> + Send + 'static,
{
    let (pieces, taken) = tokio::sync::mpsc::channel(1);
    let reader = feed(stream, Heads::new(boundary), watch, pieces);
    futures_util::stream::unfold((Some(reader), taken), |(reader, mut taken)| async move {
        if let Some(reader) = reader {
            tokio::spawn(reader);
        }
        match taken.recv().await {
            Some(piece) => Some((Ok(piece), (None, taken))),
            None => {
                tokio::task::yield_now().await;
                None
            }
        }
    })
}

/// Reads `stream` into `pieces` for `in_pieces`, a piece at a time and each only once the one
/// before was taken, until the body ends, fails or passes a head's cap, or the parser is dropped.
async fn feed<S>(
    stream: S,
    mut heads: Heads,
    watch: Watch,
    pieces: tokio::sync::mpsc::Sender<axum::body::Bytes>,
) where
    S: futures_util::Stream<Item = Result<axum::body::Bytes, BoxError>>,
{
    use futures_util::StreamExt;
    let mut stream = std::pin::pin!(stream);
    let mut pending = Vec::new();
    let mut more = true;
    while more {
        let Ok(room) = pieces.reserve().await else {
            return;
        };
        let read = async {
            loop {
                match stream.next().await {
                    Some(Ok(chunk)) if pending.is_empty() && chunk.len() >= PIECE => {
                        return (Some(chunk), true);
                    }
                    Some(Ok(chunk)) => {
                        pending.extend_from_slice(&chunk);
                        if pending.len() >= PIECE {
                            return (None, true);
                        }
                    }
                    Some(Err(_)) | None => return (None, false),
                }
            }
        };
        let (whole, rest) = tokio::select! {
            read = read => read,
            () = pieces.closed() => return,
        };
        let piece = whole.unwrap_or_else(|| std::mem::take(&mut pending).into());
        let piece = match heads.scan(&piece) {
            Ok(()) => {
                more = rest;
                piece
            }
            Err(n) => {
                let _ = watch.0.set(Cut::Head);
                more = false;
                piece.slice(..n)
            }
        };
        if !piece.is_empty() {
            room.send(piece);
        }
    }
}

/// What `Quiet` polls its future or stream with: a waker that marks it asked for, then wakes
/// the task that polls `Quiet`.
struct Asked {
    again: std::sync::atomic::AtomicBool,
    task: futures_util::task::AtomicWaker,
}

impl std::task::Wake for Asked {
    fn wake(self: std::sync::Arc<Self>) {
        self.wake_by_ref();
    }

    fn wake_by_ref(self: &std::sync::Arc<Self>) {
        self.again.store(true, std::sync::atomic::Ordering::SeqCst);
        self.task.wake();
    }
}

/// A future or stream polled only on its first poll, after it gave an item, and after its own
/// waker fired: any other poll of the task it runs in returns `Pending` without reaching it.
/// Hyper polls a request's handler on every read of an HTTP/1 connection, and the multipart
/// parser looks through all it holds on every poll, so the routes poll the parser through this.
pub(crate) struct Quiet<T> {
    inner: std::pin::Pin<Box<T>>,
    asked: std::sync::Arc<Asked>,
    waker: std::task::Waker,
}

impl<T> Quiet<T> {
    pub(crate) fn new(inner: T) -> Quiet<T> {
        let asked = std::sync::Arc::new(Asked {
            again: std::sync::atomic::AtomicBool::new(true),
            task: futures_util::task::AtomicWaker::new(),
        });
        let waker = std::task::Waker::from(std::sync::Arc::clone(&asked));
        Quiet {
            inner: Box::pin(inner),
            asked,
            waker,
        }
    }

    fn poll_with<R>(
        &mut self,
        cx: &mut std::task::Context<'_>,
        poll: impl FnOnce(std::pin::Pin<&mut T>, &mut std::task::Context<'_>) -> std::task::Poll<R>,
    ) -> std::task::Poll<R> {
        use std::sync::atomic::Ordering::SeqCst;
        self.asked.task.register(cx.waker());
        if !self.asked.again.swap(false, SeqCst) {
            return std::task::Poll::Pending;
        }
        let mut own = std::task::Context::from_waker(&self.waker);
        let polled = poll(self.inner.as_mut(), &mut own);
        if polled.is_ready() {
            self.asked.again.store(true, SeqCst);
        }
        polled
    }
}

impl<F: std::future::Future> std::future::Future for Quiet<F> {
    type Output = F::Output;

    fn poll(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<F::Output> {
        self.get_mut().poll_with(cx, F::poll)
    }
}

impl<S: futures_util::Stream> futures_util::Stream for Quiet<S> {
    type Item = S::Item;

    fn poll_next(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<S::Item>> {
        self.get_mut().poll_with(cx, S::poll_next)
    }
}

/// The next part of a form read through `form`, its parser polled through `Quiet`.
pub(crate) async fn next_part(
    form: &mut Multipart,
) -> Result<Option<axum::extract::multipart::Field<'_>>, axum::extract::multipart::MultipartError> {
    Quiet::new(form.next_field()).await
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

/// Reads `stream` to its end, at most `most` bytes, polling it through `Quiet`.
async fn collect<S, E>(stream: S, most: usize) -> Result<Vec<u8>, Stop>
where
    S: futures_util::Stream<Item = Result<axum::body::Bytes, E>>,
    E: std::fmt::Display,
{
    use futures_util::StreamExt;
    let mut stream = Quiet::new(stream);
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
    ApiError::limit(
        StatusCode::TOO_MANY_REQUESTS,
        format!(
            "Upload limit reached: {who} can upload up to {} a day. Space frees up 1 day after each upload, or sooner when a file is removed. The site admin sets this limit",
            fmt_bytes(budget)
        ),
        "upload_budget_mib",
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

/// Deletes the S3 object of file `id`, plain or sealed.
async fn s3_delete(s3: Option<&Bucket>, id: &str) {
    let Some(bucket) = s3 else {
        return;
    };
    for key in [s3_key(id), sealed::sealed_key(id)] {
        if let Err(e) = bucket.delete_object(&key).await {
            tracing::warn!("s3 delete failed for {key}: {e}");
        }
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
        sealed: None,
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
    /// The key the file is stored under, from its first byte.
    sealed: Option<&'a MediaKey>,
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
        .bind(match file.sealed {
            Some(_) => "",
            None => file.filename,
        })
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
    if let Some(key) = file.sealed {
        let facts = Facts {
            name: file.filename.to_string(),
        };
        sqlx::query("UPDATE media SET seal_key = $1, name_sealed = $2 WHERE id = $3")
            .bind(i64::from(key.id()))
            .bind(key.seal_facts(file.id, &facts))
            .bind(file.id)
            .execute(&mut *tx)
            .await?;
    }
    let data = file.in_db.unwrap_or_default();
    let total = chunks(data.len() as u64);
    for (seq, chunk) in data.chunks(MEDIA_CHUNK).enumerate() {
        let stored = match file.sealed {
            Some(key) => key.seal_chunk(file.id, seq as u64, total, chunk),
            None => chunk.to_vec(),
        };
        sqlx::query("INSERT INTO media_chunks(media_id, seq, data) VALUES($1, $2, $3)")
            .bind(file.id)
            .bind(seq as i64)
            .bind(stored)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Where an upload will be posted.
#[derive(Debug, Default, serde::Deserialize, utoipa::IntoParams)]
pub struct UploadQuery {
    /// `c:<channel id>` or `d:<dm id>`: the channel (a thread's channel for a thread reply) or
    /// DM the file will be posted in. While that place stores new messages encrypted, the file
    /// is stored encrypted from its first byte; otherwise it is encrypted when it is posted in
    /// such a place.
    pub place: Option<String>,
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
/// With `place` naming the channel or DM the file will be posted in, a place that stores new
/// messages encrypted gets the file stored encrypted from its first byte (the place must be one
/// you can see). Without it, the file is encrypted when it is posted in such a place.
///
/// Requires a bearer token and the instance's uploads setting. Strict rate-limit bucket.
#[utoipa::path(post, path = "/api/v1/media", tag = "Media", params(UploadQuery), request_body(content = Vec<u8>, content_type = "multipart/form-data", description = "A multipart form whose first part is the file"), responses((status = 200, description = "File stored; returns a media reference with its expiry time to attach to a message", body = MediaRef), (status = 400, description = "`place must be c:<channel id> or d:<dm id>`, or no file part (JSON `No file provided`) or a malformed multipart body (JSON \"Error parsing `multipart/form-data` request\"), which includes a part head over 16 KiB: from the start of the body, or the end of the part before, to the blank line after the part's headers. A body that is not `multipart/form-data` or has no valid boundary gets a plain-text 400 from the framework", content((ApiErrorBody = "application/json"), (String = "text/plain"))), (status = 401, description = "Not signed in", body = ApiErrorBody), (status = 403, description = "File uploads are disabled on this instance", body = ApiErrorBody), (status = 404, description = "`Not found`: `place` names a channel you cannot see or a DM you are not in", body = ApiErrorBody), (status = 409, description = "`This site needs an encryption key first`: `place` stores messages encrypted and the key to store files encrypted is not there (reason `keys`)", body = ApiErrorBody), (status = 413, description = "File over `limits.upload_bytes`, by default 25 MiB (`UPLOAD_MAX_MIB`): `File exceeds 25MB limit` with the configured number. A request body over that size plus 1 MiB is cut off while the file is read and answers with this status and the JSON error \"Error parsing `multipart/form-data` request\"", body = ApiErrorBody), (status = 408, description = "`The upload stopped sending data`: the body sent nothing for 30 seconds or took over 10 minutes", body = ApiErrorBody), (status = 429, description = "Too many requests in the strict bucket (shared with register, login, word hints, password change and guest access) or the general bucket, the per-account budget is used up (JSON `Upload limit reached: you can upload up to 2 GiB a day. ...` with the configured size; space frees up 24 hours after each upload, or sooner when a file is removed, and the site operator sets the limit with `UPLOAD_BUDGET_MIB`), or 3 of your uploads, or uploads holding your share of the upload buffer, are already being read (JSON `Too many uploads at once: ...`)", body = ApiErrorBody), (status = 503, description = "`Too many uploads right now, try again in a moment`: the instance holds as many upload bodies in memory as it allows (each upload takes room for its whole declared size first)", body = ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn upload_media(
    State(state): State<AppState>,
    Authed(user): Authed,
    headers: axum::http::HeaderMap,
    Query(UploadQuery { place }): Query<UploadQuery>,
    UploadForm(mut multipart, watch): UploadForm,
) -> Result<Json<MediaRef>, ApiError> {
    if !Settings::cached(&state.db).await.asset_uploads {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "File uploads are disabled".to_string(),
            None,
        ));
    }
    let key = match place.as_deref() {
        Some(text) => {
            let place = sealed::Place::parse(text).ok_or_else(|| bad(sealed::BAD_PLACE))?;
            sealed::upload_key(&state.db, &user, place).await?
        }
        None => None,
    };
    check_budget(&state.db, Charge::own(&user.username), 1, budget()).await?;
    let slot = reading_slot(&state.db, &user.username)?;
    let body = state.limits.upload_body_bytes();
    let held = reserve(slot, declared_length(&headers), body, true).await?;
    let max = state.limits.upload_bytes();
    let field = next_part(&mut multipart)
        .await
        .map_err(|e| {
            watch.error(
                || too_large(max),
                ApiError(StatusCode::BAD_REQUEST, e.to_string(), None),
            )
        })?
        .ok_or_else(|| bad("No file provided"))?;
    let filename = clean_filename(field.file_name().unwrap_or("file"));
    let mime = clean_mime(field.content_type().unwrap_or(NEUTRAL_MIME));
    let body = read_file(field, max, held, &watch).await?;
    let (id, uploaded_at) = save_within(
        &state,
        &filename,
        &mime,
        &body.data,
        &user.username,
        Charge::own(&user.username),
        budget(),
        key.as_ref(),
    )
    .await?;
    Ok(Json(MediaRef::server(
        id,
        filename,
        body.data.len() as i64,
        false,
        Some(uploaded_at + MEDIA_TTL_SECS),
    )))
}

/// Stores an uploaded file for `uploader`, counted against `charge` (S3 when configured, else
/// the database). Returns its id and upload time.
#[cfg(test)]
pub(crate) async fn save_upload(
    state: &AppState,
    filename: &str,
    mime: &str,
    data: &[u8],
    uploader: &str,
    charge: Charge<'_>,
) -> Result<(String, i64), ApiError> {
    save_within(
        state,
        filename,
        mime,
        data,
        uploader,
        charge,
        budget(),
        None,
    )
    .await
}

/// `save_upload` within `budget` bytes, stored under `sealed` from its first byte when given.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn save_within(
    state: &AppState,
    filename: &str,
    mime: &str,
    data: &[u8],
    uploader: &str,
    charge: Charge<'_>,
    budget: u64,
    sealed: Option<&MediaKey>,
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
    let uploaded_at = state.clock.unix();
    let in_db = match (&state.s3, sealed) {
        (Some(bucket), Some(key)) => {
            bucket
                .put_object_with_content_type(
                    sealed::sealed_key(&id),
                    &key.seal_object(&id, data),
                    NEUTRAL_MIME,
                )
                .await
                .map_err(ApiError::internal)?;
            None
        }
        (Some(bucket), None) => {
            bucket
                .put_object_with_content_type(s3_key(&id), data, mime)
                .await
                .map_err(ApiError::internal)?;
            None
        }
        (None, _) => Some(data),
    };
    let file = NewMedia {
        id: &id,
        filename,
        mime,
        size: data.len() as i64,
        in_db,
        uploader,
        uploaded_at,
        sealed,
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
/// this. The author can always do this. In a server channel, members with Manage messages in
/// the channel and a rank above the author (see `Role.position`) can too. Emits
/// `media_removed` to all who can see the message. Forwarded copies keep their own
/// reference to the file (and so the file). Moderators of the destination use this endpoint on
/// the copy. Requires a bearer token. General rate-limit bucket.
#[utoipa::path(delete, path = "/api/v1/messages/{id}/media", tag = "Media", params(("id" = i64, Path, description = "Message id")), responses((status = 200, description = "Removed; the body is `{\"ok\": true}`", body = OkResp), (status = 401, description = "Not signed in", body = ApiErrorBody), (status = 403, description = "Not the author, and no Manage messages permission in the channel or no rank above the author", body = ApiErrorBody), (status = 404, description = "`Not found`: no such message, its author's account is being deleted, or you cannot read it (hidden channel, before your join without read history, a server you have no access to, or a DM you are not in); identical responses; or it has no attachment (`No attachment`)", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)), security(("bearer" = [])))]
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
        media_kind,
        server,
        dm_users,
    } = message.into_scope();
    let media_id = match media_id {
        Some(media_id) => media_id,
        None => {
            return Err(ApiError(
                StatusCode::NOT_FOUND,
                "No attachment".to_string(),
                None,
            ));
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
            sqlx::query("UPDATE messages SET media_removed = 2, media_hoster = NULL, media_expires_at = NULL, media_size = NULL, media_mime = NULL, media_sha256 = NULL, media_alt = NULL WHERE id = $1")
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
            sqlx::query("UPDATE messages SET media_removed = 2, media_alt = NULL WHERE id = $1")
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
    ApiError(StatusCode::NOT_FOUND, "Media not found".to_string(), None)
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
    let mut staff = None;
    for r in &rows {
        let id: i64 = r.try_get(0)?;
        let Some(message) = allowed(resolve_message(db, id, user, proof).await)? else {
            continue;
        };
        match message.channel().filter(|c| c.staff_view()) {
            Some(channel) => {
                staff.get_or_insert((channel.server().name().to_string(), channel.id(), id));
            }
            None => return Ok(()),
        }
    }
    match (staff, user) {
        (Some((server, channel, message)), Some(admin)) => {
            crate::api::staff_audit::media(db, admin, &server, channel, message, media_id).await
        }
        (_, _) => Err(media_hidden()),
    }
}

/// The plain chunks of file `id`, each checked to hold the bytes a chunk of a file of `size`
/// holds, so a chunk sealed meanwhile ends the body instead of passing as file bytes.
fn chunk_stream(
    db: Db,
    id: String,
    chunks: i64,
    size: u64,
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
                Some(bytes) if bytes.len() == chunk_len(size, seq as u64) => {
                    Some((Ok(bytes), seq + 1))
                }
                Some(_) => Some((
                    Err(std::io::Error::other("media changed while streaming")),
                    chunks,
                )),
                None => Some((
                    Err(std::io::Error::other("media removed while streaming")),
                    chunks,
                )),
            }
        }
    })
}

/// Bytes `start..=end` of a file of `size` bytes kept in `media_chunks`: only the rows that hold
/// them, the first and last trimmed. Each row must hold the bytes a chunk of that file holds; one
/// that doesn't (a chunk sealed meanwhile) ends the body with an error.
fn chunk_range_stream(
    db: Db,
    id: String,
    size: u64,
    start: u64,
    end: u64,
) -> impl futures_util::Stream<Item = Result<Vec<u8>, std::io::Error>> {
    let piece = MEDIA_CHUNK as u64;
    let last = end / piece;
    futures_util::stream::unfold(Some(start / piece), move |seq| {
        let (db, id) = (db.clone(), id.clone());
        async move {
            let seq = seq.filter(|seq| *seq <= last)?;
            let row = sqlx::query("SELECT data FROM media_chunks WHERE media_id = $1 AND seq = $2")
                .bind(&id)
                .bind(seq as i64)
                .fetch_optional(&db)
                .await;
            let bytes = row
                .ok()
                .flatten()
                .and_then(|r| r.try_get::<Vec<u8>, _>(0).ok());
            let at = seq * piece;
            let from = start.max(at) - at;
            let to = (end + 1).min(at + piece) - at;
            match bytes {
                Some(bytes)
                    if to as usize <= bytes.len() && bytes.len() == chunk_len(size, seq) =>
                {
                    Some((
                        Ok(bytes[from as usize..to as usize].to_vec()),
                        Some(seq + 1),
                    ))
                }
                Some(_) => Some((
                    Err(std::io::Error::other("media chunks out of shape")),
                    None,
                )),
                None => Some((
                    Err(std::io::Error::other("media removed while streaming")),
                    None,
                )),
            }
        }
    })
}

/// Bytes `start..=end` of a file from `stream`, which yields its bytes from offset `at` on. The
/// stream is not read past `end`.
fn cut_stream<S>(
    stream: S,
    at: u64,
    start: u64,
    end: u64,
) -> impl futures_util::Stream<Item = Result<Vec<u8>, std::io::Error>>
where
    S: futures_util::Stream<Item = Result<Vec<u8>, std::io::Error>> + Unpin,
{
    futures_util::stream::unfold((stream, at), move |(mut stream, mut at)| async move {
        while at <= end {
            match futures_util::StreamExt::next(&mut stream).await? {
                Ok(bytes) => {
                    let next = at + bytes.len() as u64;
                    if next > start {
                        let from = (start.max(at) - at) as usize;
                        let to = ((end + 1).min(next) - at) as usize;
                        return Some((Ok(bytes[from..to].to_vec()), (stream, next)));
                    }
                    at = next;
                }
                Err(e) => return Some((Err(e), (stream, end + 1))),
            }
        }
        None
    })
}

/// Where an S3 range read is: not started (it starts on the first poll), reading, or over.
enum S3Range {
    Start {
        bucket: std::sync::Arc<Bucket>,
        key: String,
        start: u64,
        end: u64,
    },
    Reading {
        reader: tokio::io::DuplexStream,
        task: AbortOnDrop<Result<u16, s3::error::S3Error>>,
        key: String,
    },
    Over,
}

/// A spawned task that is stopped when its handle is dropped: an S3 read nobody reads any more.
struct AbortOnDrop<T>(tokio::task::JoinHandle<T>);

impl<T> Drop for AbortOnDrop<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Most bytes one 206 from S3 storage sends, so each read ends well within the S3 request's
/// timeout; `Content-Range` says which bytes, and the client asks for the next ones.
pub(crate) const S3_WINDOW: u64 = 8 * 1024 * 1024;

/// `wanted` cut to at most `S3_WINDOW` bytes from its start.
pub(crate) fn s3_window(wanted: Wanted) -> Wanted {
    match wanted {
        Wanted::Part { start, end } => Wanted::Part {
            start,
            end: end.min(start.saturating_add(S3_WINDOW - 1)),
        },
        Wanted::Whole | Wanted::Unsatisfiable => wanted,
    }
}

/// Bytes `start..=end` of the S3 object `key`, read with a ranged GET as they are sent. The GET
/// starts on the first poll; a failed one ends the body with an error, logged.
fn s3_range_stream(
    bucket: std::sync::Arc<Bucket>,
    key: String,
    start: u64,
    end: u64,
) -> impl futures_util::Stream<Item = Result<Vec<u8>, std::io::Error>> {
    use tokio::io::AsyncReadExt;
    let first = S3Range::Start {
        bucket,
        key,
        start,
        end,
    };
    futures_util::stream::unfold(first, |at| async move {
        let (mut reader, task, key) = match at {
            S3Range::Start {
                bucket,
                key,
                start,
                end,
            } => {
                let (mut writer, reader) = tokio::io::duplex(MEDIA_CHUNK);
                let path = key.clone();
                let task = AbortOnDrop(tokio::spawn(async move {
                    bucket
                        .get_object_range_to_writer(path, start, Some(end), &mut writer)
                        .await
                }));
                (reader, task, key)
            }
            S3Range::Reading { reader, task, key } => (reader, task, key),
            S3Range::Over => return None,
        };
        let mut buf = vec![0u8; 64 * 1024];
        match reader.read(&mut buf).await {
            Ok(0) => {
                let mut task = task;
                let failed = match (&mut task.0).await {
                    Ok(Ok(_)) => return None,
                    Ok(Err(e)) => e.to_string(),
                    Err(e) => e.to_string(),
                };
                tracing::warn!(%key, "S3 range read failed: {failed}");
                Some((Err(std::io::Error::other(failed)), S3Range::Over))
            }
            Ok(n) => {
                buf.truncate(n);
                Some((Ok(buf), S3Range::Reading { reader, task, key }))
            }
            Err(e) => {
                tracing::warn!(%key, "S3 range read failed: {e}");
                Some((Err(e), S3Range::Over))
            }
        }
    })
}

/// The policy a downloaded file is served under: nothing loads, and opened as a page it is
/// sandboxed.
const MEDIA_CSP: &str = "default-src 'none'; sandbox";

/// The bytes of a file of `size` bytes that a `Range` header asks for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Wanted {
    /// No range, more than one, or one this server doesn't read: the whole file.
    Whole,
    /// Bytes `start..=end`.
    Part { start: u64, end: u64 },
    /// One range that starts at or past the end.
    Unsatisfiable,
}

/// Reads one `bytes=a-b`, `bytes=a-` or `bytes=-n` range of a file of `size` bytes.
pub(crate) fn wanted_range(header: Option<&str>, size: u64) -> Wanted {
    let Some(raw) = header.map(str::trim) else {
        return Wanted::Whole;
    };
    let spec = match raw.split_once('=') {
        Some((unit, spec)) if unit.trim().eq_ignore_ascii_case("bytes") => spec.trim(),
        Some(_) | None => return Wanted::Whole,
    };
    if spec.contains(',') {
        return Wanted::Whole;
    }
    let Some((first, last)) = spec.split_once('-') else {
        return Wanted::Whole;
    };
    let number = |text: &str| match text.trim() {
        "" => None,
        digits if digits.bytes().all(|b| b.is_ascii_digit()) => digits.parse::<u64>().ok(),
        _ => None,
    };
    match (first.trim().is_empty(), last.trim().is_empty()) {
        (true, true) => Wanted::Whole,
        (true, false) => match number(last) {
            None => Wanted::Whole,
            Some(0) => Wanted::Unsatisfiable,
            Some(_) if size == 0 => Wanted::Unsatisfiable,
            Some(n) => Wanted::Part {
                start: size - n.min(size),
                end: size - 1,
            },
        },
        (false, open) => {
            let (Some(start), end) = (number(first), (!open).then(|| number(last))) else {
                return Wanted::Whole;
            };
            match end {
                Some(None) => Wanted::Whole,
                Some(Some(end)) if end < start => Wanted::Whole,
                _ if start >= size => Wanted::Unsatisfiable,
                Some(Some(end)) => Wanted::Part {
                    start,
                    end: end.min(size - 1),
                },
                None => Wanted::Part {
                    start,
                    end: size - 1,
                },
            }
        }
    }
}

/// Whether a `Range` may be served: no `If-Range`, or one naming `etag` exactly. Dates never
/// match, since media responses carry no `Last-Modified`.
fn if_range_ok(headers: &axum::http::HeaderMap, etag: &str) -> bool {
    headers
        .get(header::IF_RANGE)
        .is_none_or(|v| v.to_str().is_ok_and(|v| v.trim() == etag))
}

/// Download a file
///
/// Streams an uploaded file with its stored `Content-Type`, as an attachment
/// (`Content-Disposition: attachment`), with `X-Content-Type-Options: nosniff` and a sandboxing
/// `Content-Security-Policy`. The token may come from the `Authorization` header or the
/// `rchat_token` cookie, so browsers can load it directly; guests may download when guest
/// access is on.
///
/// Every answer carries `Accept-Ranges: bytes`. One `Range` (`bytes=a-b`, `bytes=a-` or
/// `bytes=-n`) answers 206 with those bytes, `Content-Range` and their `Content-Length`; a range
/// that starts at or past the end answers 416 with `Content-Range: bytes */size`. Several ranges,
/// a header this server doesn't read, or an `If-Range` other than the file's `ETag` get the whole
/// file. With S3 storage a 206 holds at most 8 MiB from the range's start, and `Content-Range`
/// names the bytes sent. `HEAD` answers the same without the body.
///
/// Once attached, the file is visible to anyone who can read one of the messages carrying it,
/// with the same checks as listing messages: in a server without a password anyone not banned
/// from it, in a password-protected server its members or guests holding a grant for it (the
/// `X-Guest-Grant` header); in a channel with permission overrides (thread replies use their
/// channel) also the view permission, and without read-history access only messages posted since you
/// joined count; in a direct message its two participants. Before it is attached only the
/// uploader can fetch it. Access is checked before `If-None-Match`, so a 304 is only sent to
/// callers allowed to see the file. General rate-limit bucket.
#[utoipa::path(get, path = "/api/v1/media/{id}", tag = "Media", params(("id" = String, Path, description = "Media id, 32 hex characters, from `MediaRef.id`"), ("X-Guest-Grant" = Option<String>, Header, description = "Guest grants from `POST /api/v1/servers/{name}/guest_access`, comma-separated, up to 100. Only read for guests viewing a password-protected server"), ("Range" = Option<String>, Header, description = "One byte range: `bytes=a-b`, `bytes=a-` (to the end) or `bytes=-n` (the last n bytes). Several ranges or another form get the whole file"), ("If-Range" = Option<String>, Header, description = "The file's `ETag`: the range is served only while it matches, else the whole file")), responses((status = 200, description = "File bytes, streamed. Carries a strong `ETag`, `Cache-Control: private, max-age=86400, immutable`, `Vary: X-Guest-Grant` and `Accept-Ranges: bytes`"), (status = 206, description = "The bytes of the one `Range` asked for, streamed, with `Content-Range: bytes a-b/size`, their `Content-Length` and the same headers as 200. With S3 storage at most 8 MiB from the range's start; `Content-Range` names the bytes sent"), (status = 304, description = "`If-None-Match` matched the media's ETag and you may see the file. Carries the same `ETag`, `Cache-Control`, `Vary`, `Content-Security-Policy` and `X-Content-Type-Options`"), (status = 416, description = "The `Range` starts at or past the end of the file: no body, `Content-Range: bytes */size`"), (status = 401, description = "Guest access is disabled and no valid token was sent", body = ApiErrorBody), (status = 403, description = "`Attachments are turned off on this server`: uploads and P2P attachments are both off (text only); only sent to callers who may see the file", body = ApiErrorBody), (status = 404, description = "`Media not found`: unknown id, the file expired or was deleted, or you may not read any message carrying it (banned, no access to its password-protected server, no view permission or no read-history access in its channel, or not a DM participant) or see the unattached upload; identical responses", body = ApiErrorBody), (status = 500, description = "`This file can't be opened`: it is stored encrypted and its key is not held. A stored encrypted chunk that does not open ends the body early", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)), security((), ("bearer" = [])))]
pub(crate) async fn download_media(
    State(state): State<AppState>,
    method: axum::http::Method,
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
            None,
        ));
    }
    let row = sqlx::query(
        "SELECT filename, mime, size, CAST(CASE WHEN data IS NULL THEN 0 ELSE 1 END AS BIGINT), (SELECT COUNT(*) FROM media_chunks mc WHERE mc.media_id = media.id), seal_key, name_sealed FROM media WHERE id = $1",
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
    let (seal_key, record): (Option<i64>, Option<Vec<u8>>) = match &row {
        Some(r) => (r.try_get(5)?, r.try_get(6)?),
        None => (None, None),
    };
    let key = match seal_key {
        Some(key_id) => Some(
            MediaKey::named(&state.db, key_id as u32)
                .await
                .map_err(ApiError::internal)?
                .ok_or_else(sealed::unreadable)?,
        ),
        None => None,
    };
    let filename = match (&key, seal_key) {
        (Some(key), Some(_)) => {
            record
                .as_deref()
                .and_then(|record| key.open_facts(&id, record))
                .ok_or_else(sealed::unreadable)?
                .name
        }
        _ => filename,
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
            .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
            .header(header::CONTENT_SECURITY_POLICY, MEDIA_CSP)
            .body(Body::empty())
            .map_err(ApiError::internal);
    }
    let asked = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .filter(|_| if_range_ok(&headers, &etag));
    let stored = u64::try_from(size).unwrap_or_default();
    let (body, wanted, total) = match (key, inline != 0, chunks > 0, &state.s3) {
        (Some(key), _, true, _) => {
            let wanted = wanted_range(asked, stored);
            let body = match wanted {
                Wanted::Whole => {
                    Body::from_stream(sealed::chunk_stream(db.clone(), id.clone(), stored, key, 0))
                }
                Wanted::Part { start, end } => {
                    let first = start / MEDIA_CHUNK as u64;
                    let opened = sealed::chunk_stream(db.clone(), id.clone(), stored, key, first);
                    Body::from_stream(cut_stream(
                        Box::pin(opened),
                        first * MEDIA_CHUNK as u64,
                        start,
                        end,
                    ))
                }
                Wanted::Unsatisfiable => Body::empty(),
            };
            (body, wanted, stored)
        }
        (Some(_), _, false, _) if size == 0 => (Body::empty(), wanted_range(asked, 0), 0),
        (Some(key), _, false, Some(bucket)) => {
            let wanted = s3_window(wanted_range(asked, stored));
            let body = match wanted {
                _ if method == axum::http::Method::HEAD => Body::empty(),
                Wanted::Unsatisfiable => Body::empty(),
                Wanted::Whole | Wanted::Part { .. } => {
                    let mut open = (**bucket).clone();
                    open.set_request_timeout(None);
                    let stream = open
                        .get_object_stream(sealed::sealed_key(&id))
                        .await
                        .map_err(ApiError::internal)?;
                    let opened = sealed::object_stream(stream.bytes, id.clone(), stored, key);
                    match wanted {
                        Wanted::Part { start, end } => {
                            Body::from_stream(cut_stream(Box::pin(opened), 0, start, end))
                        }
                        Wanted::Whole | Wanted::Unsatisfiable => Body::from_stream(opened),
                    }
                }
            };
            (body, wanted, stored)
        }
        (Some(_), _, false, None) => {
            return Err(ApiError(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Media stored in S3 but S3 is not configured".to_string(),
                None,
            ));
        }
        (None, true, _, _) => {
            let bytes: Vec<u8> = sqlx::query("SELECT data FROM media WHERE id = $1")
                .bind(&id)
                .fetch_optional(&db)
                .await?
                .map(|r| r.try_get::<Option<Vec<u8>>, _>(0))
                .transpose()?
                .flatten()
                .unwrap_or_default();
            let total = bytes.len() as u64;
            let wanted = wanted_range(asked, total);
            let body = match wanted {
                Wanted::Whole => Body::from(bytes),
                Wanted::Part { start, end } => {
                    Body::from(bytes[start as usize..=end as usize].to_vec())
                }
                Wanted::Unsatisfiable => Body::empty(),
            };
            (body, wanted, total)
        }
        (None, false, true, _) => {
            let wanted = wanted_range(asked, stored);
            let body = match wanted {
                Wanted::Whole => {
                    Body::from_stream(chunk_stream(db.clone(), id.clone(), chunks, stored))
                }
                Wanted::Part { start, end } => Body::from_stream(chunk_range_stream(
                    db.clone(),
                    id.clone(),
                    stored,
                    start,
                    end,
                )),
                Wanted::Unsatisfiable => Body::empty(),
            };
            (body, wanted, stored)
        }
        (None, false, false, _) if size == 0 => (Body::empty(), wanted_range(asked, 0), 0),
        (None, false, false, Some(bucket)) => {
            let wanted = s3_window(wanted_range(asked, stored));
            let body = match wanted {
                _ if method == axum::http::Method::HEAD => Body::empty(),
                Wanted::Whole => {
                    let mut open = (**bucket).clone();
                    open.set_request_timeout(None);
                    let key = s3_key(&id);
                    let stream = open
                        .get_object_stream(&key)
                        .await
                        .map_err(ApiError::internal)?;
                    Body::from_stream(futures_util::StreamExt::map(stream.bytes, move |piece| {
                        piece.inspect_err(|e| tracing::warn!(%key, "S3 read failed: {e}"))
                    }))
                }
                Wanted::Part { start, end } => {
                    let mut stream =
                        Box::pin(s3_range_stream(bucket.clone(), s3_key(&id), start, end));
                    let first = match futures_util::StreamExt::next(&mut stream).await {
                        Some(Ok(bytes)) => bytes,
                        Some(Err(e)) => return Err(ApiError::internal(e)),
                        None => {
                            return Err(ApiError::internal("S3 range came back empty"));
                        }
                    };
                    Body::from_stream(futures_util::StreamExt::chain(
                        futures_util::stream::once(async move { Ok(first) }),
                        stream,
                    ))
                }
                Wanted::Unsatisfiable => Body::empty(),
            };
            (body, wanted, stored)
        }
        (None, false, false, None) => {
            return Err(ApiError(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Media stored in S3 but S3 is not configured".to_string(),
                None,
            ));
        }
    };
    let res = Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_DISPOSITION, content_disposition(&filename))
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CONTENT_SECURITY_POLICY, MEDIA_CSP)
        .header(header::ETAG, &etag)
        .header(header::CACHE_CONTROL, cache)
        .header(header::VARY, "X-Guest-Grant")
        .header(header::ACCEPT_RANGES, "bytes");
    let res = match wanted {
        Wanted::Whole if inline == 0 => res.header(header::CONTENT_LENGTH, size),
        Wanted::Whole => res,
        Wanted::Part { start, end } => res
            .status(StatusCode::PARTIAL_CONTENT)
            .header(
                header::CONTENT_RANGE,
                format!("bytes {start}-{end}/{total}"),
            )
            .header(header::CONTENT_LENGTH, end - start + 1),
        Wanted::Unsatisfiable => res
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{total}"))
            .header(header::CONTENT_LENGTH, 0),
    };
    res.body(body).map_err(ApiError::internal)
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
        "SELECT m.id, m.channel_id, m.dm_id, c.server, d.user_a, d.user_b FROM messages m LEFT JOIN channels c ON c.id = m.channel_id LEFT JOIN dms d ON d.id = m.dm_id WHERE m.media_id IN ({list}) AND m.media_removed = 0 AND m.media_kind != 'p2p'"
    ))
    .fetch_all(&mut *tx)
    .await?;
    let mut events = Vec::with_capacity(rows.len());
    for r in &rows {
        let dm_users = match (
            r.try_get::<Option<String>, _>(4)?,
            r.try_get::<Option<String>, _>(5)?,
        ) {
            (Some(a), Some(b)) => Some(vec![a, b]),
            (_, _) => None,
        };
        events.push(WsEvent::MediaRemoved {
            server: r.try_get(3)?,
            channel_id: r.try_get(1)?,
            dm_id: r.try_get(2)?,
            dm_users,
            message_id: r.try_get(0)?,
            removed_by_author: false,
        });
    }
    bind_ids(format!(
        "UPDATE messages SET media_removed = 1, media_alt = NULL WHERE media_id IN ({list}) AND media_kind != 'p2p'"
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
        Charge, FILENAME_MAX, MEDIA_TTL_SECS, MIME_MAX, NEUTRAL_MIME, PIECE, Quiet, Room,
        SWEEP_BATCH, UPLOADS_PER_ACCOUNT, Waits, Wanted, Watch, check_budget, clean_filename,
        clean_mime, content_disposition, delete_media, download_media, form_within, in_pieces,
        media_view_ok, next_part, paced, read_chunks, read_json_part, read_small, reading_slot,
        save_within, share_held, share_kib, store_media, sweep, take_room, wanted_range,
    };
    use crate::api::access::Proof;
    use crate::api::form_heads::HEAD_MAX;
    use crate::api::test_util::{done, mem_user, temp_state};
    use crate::api::{ApiError, Authed};
    use crate::db::{now, open_started as open};
    use axum::extract::{Path, State};
    use axum::http::Method;
    use axum::http::StatusCode;

    const GET: Method = Method::GET;
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
        let mut body = b"--XB\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.bin\"\r\nContent-Type: application/octet-stream\r\n\r\n".to_vec();
        body.extend(vec![7u8; kib * 1024]);
        body.extend_from_slice(b"\r\n--XB--\r\n");
        post_form(state, body).await
    }

    /// Posts `body`, a form with the boundary `XB`, to the upload route as alice.
    async fn post_form(state: &crate::state::AppState, body: Vec<u8>) -> (StatusCode, String) {
        let (addr, server) = serve(state).await;
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
        assert_eq!(
            text,
            r#"{"error":"File exceeds 1MB limit","reason":{"kind":"limit","control":"upload_max_mib"}}"#
        );
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
            Err(ApiError(code, msg, _)) => {
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
                None,
            )
        });
        let results = futures_util::future::join_all(uploads).await;
        let stored = results.iter().filter(|r| r.is_ok()).count();
        for r in &results {
            if let Err(ApiError(code, msg, _)) = r {
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
            busy.err().map(|ApiError(c, _, _)| c),
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
            lying.err().map(|ApiError(c, _, _)| c),
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
            big.err().map(|ApiError(c, _, _)| c),
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
                Err(ApiError(StatusCode::TOO_MANY_REQUESTS, _, _))
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
                res.err().map(|ApiError(c, _, _)| c),
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
            Err(ApiError(code, msg, _)) => {
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
            stuck.await.expect("task").err().map(|ApiError(c, _, _)| c),
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
                Err(ApiError(code, msg, _)) => {
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
            declared.err().map(|ApiError(c, _, _)| c),
            Some(StatusCode::PAYLOAD_TOO_LARGE),
            "refused on its declared length before reading"
        );
        assert!(started.elapsed() < std::time::Duration::from_millis(250));
        let stuck = read_small(stalled(1), None, two, waits).await;
        assert_eq!(
            stuck.err().map(|ApiError(c, _, _)| c),
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

    /// A form with the boundary `XB` whose first part has a head of `head` bytes and the data
    /// `hello`.
    fn form_with_head(head: usize) -> Vec<u8> {
        let mut body =
            b"--XB\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.txt\"\r\nX-Pad: "
                .to_vec();
        body.resize(head - 4, b'p');
        body.extend_from_slice(b"\r\n\r\nhello\r\n--XB--\r\n");
        body
    }

    /// A part of a form: its name, its file name and its data.
    type Part = (Option<String>, Option<String>, axum::body::Bytes);

    /// Every part of `form`, in order, read as the routes read them.
    async fn all_parts(mut form: axum::extract::Multipart) -> Vec<Part> {
        let mut parts = Vec::new();
        while let Some(field) = next_part(&mut form).await.expect("parsed") {
            let name = field.name().map(str::to_string);
            let file = field.file_name().map(str::to_string);
            let data = read_json_part(field, usize::MAX, &Watch::default()).await;
            parts.push((name, file, data.expect("data").into()));
        }
        parts
    }

    /// A form with the boundary `XB`: a `payload_json` part and a file of `len` bytes.
    fn json_and_file(len: u32) -> Vec<u8> {
        let mut body = b"--XB\r\nContent-Disposition: form-data; name=\"payload_json\"\r\n\r\n{\"content\": \"hi\"}\r\n--XB\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.bin\"\r\nContent-Type: application/octet-stream\r\n\r\n".to_vec();
        body.extend((0..len).map(|n| (n % 251) as u8));
        body.extend_from_slice(b"\r\n--XB--\r\n");
        body
    }

    /// A form with the boundary `XB` whose second part has a head of `HEAD_MAX` bytes that starts
    /// `at` bytes into the body.
    fn later_head_at(at: usize) -> Vec<u8> {
        let mut body =
            b"--XB\r\nContent-Disposition: form-data; name=\"payload_json\"\r\n\r\n".to_vec();
        body.resize(at - 2, b' ');
        body.extend_from_slice(b"{}");
        body.extend_from_slice(b"\r\n--XB\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.bin\"\r\nX-Pad: ");
        body.resize(at + HEAD_MAX - 4, b'p');
        body.extend_from_slice(b"\r\n\r\n");
        body.extend((0..20_000u32).map(|n| (n % 251) as u8));
        body.extend_from_slice(b"\r\n--XB--\r\n");
        body
    }

    /// A form whose boundary is almost as long as a head may be, and whose file is lines that
    /// almost close it.
    fn long_boundary_form() -> (String, Vec<u8>) {
        let boundary = "b".repeat(HEAD_MAX - 120);
        let mut body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.bin\"\r\n\r\n"
        )
        .into_bytes();
        let near = format!("\r\n--{}x", &boundary[..boundary.len() - 10]);
        while body.len() < 64 * 1024 {
            body.extend_from_slice(near.as_bytes());
        }
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        (boundary, body)
    }

    /// What the parser got of a form read through `in_pieces`.
    #[derive(Clone, Default)]
    struct Handed {
        /// Pieces handed to it.
        pieces: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        /// Bytes handed to it.
        bytes: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        /// Times it polled for more.
        polls: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    }

    impl Handed {
        fn pieces(&self) -> usize {
            self.pieces.load(std::sync::atomic::Ordering::Relaxed)
        }

        fn bytes(&self) -> usize {
            self.bytes.load(std::sync::atomic::Ordering::Relaxed)
        }

        fn polls(&self) -> usize {
            self.polls.load(std::sync::atomic::Ordering::Relaxed)
        }
    }

    /// The parser of a form with the boundary `boundary` whose body is `stream` read through
    /// `in_pieces`, and what it got.
    async fn counted_form(
        stream: impl futures_util::Stream<Item = Result<axum::body::Bytes, super::BoxError>>
        + Send
        + 'static,
        boundary: &str,
    ) -> (axum::extract::Multipart, Handed) {
        use axum::extract::FromRequest;
        use futures_util::StreamExt;
        use std::sync::atomic::Ordering;
        let handed = Handed::default();
        let count = handed.clone();
        let mut pieces = Box::pin(in_pieces(stream, boundary, Watch::default()));
        let counted = futures_util::stream::poll_fn(move |cx| {
            count.polls.fetch_add(1, Ordering::Relaxed);
            let next = pieces.poll_next_unpin(cx);
            if let std::task::Poll::Ready(Some(Ok(piece))) = &next {
                count.pieces.fetch_add(1, Ordering::Relaxed);
                count.bytes.fetch_add(piece.len(), Ordering::Relaxed);
            }
            next
        });
        let req = axum::http::Request::builder()
            .header(
                axum::http::header::CONTENT_TYPE,
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(axum::body::Body::from_stream(counted))
            .expect("request");
        let form = axum::extract::Multipart::from_request(req, &())
            .await
            .expect("form");
        (form, handed)
    }

    /// Every part of `body`, a form with the boundary `boundary` sent `size` bytes at a time with
    /// a pending poll between them, read through `in_pieces` and polled again on every chunk that
    /// comes, as hyper polls a handler on every read of an HTTP/1 connection: the parts, how many
    /// pieces the parser is handed, and how many times it polls for more.
    async fn read_counting(body: &[u8], boundary: &str, size: usize) -> (Vec<Part>, usize, usize) {
        use futures_util::StreamExt;
        let came = std::sync::Arc::new(tokio::sync::Notify::new());
        let chunks: Vec<_> = body
            .chunks(size)
            .map(axum::body::Bytes::copy_from_slice)
            .collect();
        let ping = std::sync::Arc::clone(&came);
        let sent = futures_util::stream::iter(chunks).then(move |chunk| {
            let ping = std::sync::Arc::clone(&ping);
            async move {
                tokio::task::yield_now().await;
                ping.notify_one();
                Ok::<_, super::BoxError>(chunk)
            }
        });
        let (form, handed) = counted_form(sent, boundary).await;
        let mut read = std::pin::pin!(all_parts(form));
        let parts = loop {
            tokio::select! {
                biased;
                parts = &mut read => break parts,
                () = came.notified() => {}
            }
        };
        (parts, handed.pieces(), handed.polls())
    }

    /// A waker that counts how often it wakes.
    #[derive(Default)]
    struct Wakes(std::sync::atomic::AtomicUsize);

    impl std::task::Wake for Wakes {
        fn wake(self: std::sync::Arc<Self>) {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn a_quiet_future_is_polled_only_when_it_asked() {
        use std::future::Future;
        use std::sync::atomic::{AtomicUsize, Ordering};
        let polls = AtomicUsize::new(0);
        let (send, mut taken) = tokio::sync::mpsc::channel::<u8>(1);
        let mut quiet = Quiet::new(std::future::poll_fn(|cx| {
            polls.fetch_add(1, Ordering::SeqCst);
            taken.poll_recv(cx)
        }));
        let wakes = std::sync::Arc::new(Wakes::default());
        let waker = std::task::Waker::from(std::sync::Arc::clone(&wakes));
        let mut cx = std::task::Context::from_waker(&waker);
        for _ in 0..10 {
            assert!(std::pin::Pin::new(&mut quiet).poll(&mut cx).is_pending());
        }
        assert_eq!(polls.load(Ordering::SeqCst), 1, "only its first poll");
        send.send(5).await.expect("sent");
        assert_eq!(
            wakes.0.load(Ordering::SeqCst),
            1,
            "its waker wakes the task"
        );
        assert_eq!(
            std::pin::Pin::new(&mut quiet).poll(&mut cx),
            std::task::Poll::Ready(Some(5))
        );
        assert_eq!(polls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_quiet_stream_is_polled_again_after_each_item() {
        use futures_util::Stream;
        let mut quiet = Quiet::new(futures_util::stream::iter([1, 2]));
        let mut noop = std::task::Context::from_waker(std::task::Waker::noop());
        for item in [Some(1), Some(2), None] {
            assert_eq!(
                std::pin::Pin::new(&mut quiet).poll_next(&mut noop),
                std::task::Poll::Ready(item)
            );
        }
    }

    #[tokio::test]
    async fn the_parser_runs_once_a_piece_however_often_the_handler_is_polled() {
        let (long, long_body) = long_boundary_form();
        let forms = [
            ("XB".to_string(), json_and_file(70_000)),
            ("XB".to_string(), form_with_head(HEAD_MAX)),
            ("XB".to_string(), later_head_at(10_000)),
            (long, long_body),
        ];
        for (boundary, body) in forms {
            let (whole, _, _) = read_counting(&body, &boundary, body.len()).await;
            assert!(!whole.is_empty());
            for size in [1, 7, 4096, PIECE + 3, body.len()] {
                let (parts, pieces, polls) = read_counting(&body, &boundary, size).await;
                let what = format!("{} bytes in chunks of {size}", body.len());
                assert_eq!(parts, whole, "{what}");
                assert!(
                    pieces <= body.len() / PIECE + 1,
                    "{pieces} pieces for {what}"
                );
                assert!(
                    polls <= 3 * (pieces + parts.len()) + 4,
                    "{polls} polls for {pieces} pieces of {what}"
                );
            }
        }
    }

    #[tokio::test]
    async fn a_part_head_past_its_cap_is_refused() {
        let (state, path) = temp_state("media_head_cap").await;
        add_alice(&state.db).await;
        let (status, text) = post_form(&state, form_with_head(HEAD_MAX)).await;
        assert_eq!(status, StatusCode::OK, "{text}");
        let (status, text) = post_form(&state, form_with_head(HEAD_MAX + 1)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{text}");
        assert_eq!(
            text,
            r#"{"error":"Error parsing `multipart/form-data` request"}"#
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_body_that_comes_whole_after_a_wait_is_parsed() {
        use futures_util::StreamExt;
        let body = axum::body::Bytes::from(form_with_head(200));
        let late = futures_util::stream::once(async move {
            tokio::task::yield_now().await;
            Ok::<_, std::io::Error>(body)
        });
        let (mut form, _watch) = form_within(
            form_request(late.boxed()),
            usize::MAX,
            test_waits(5000, 5000),
        )
        .await
        .expect("form");
        let field = next_part(&mut form).await.expect("parsed").expect("a part");
        assert_eq!(field.bytes().await.expect("data"), "hello");
    }

    #[tokio::test]
    async fn the_end_of_a_form_comes_a_poll_after_its_last_piece() {
        use futures_util::StreamExt;
        let body = axum::body::Bytes::from(form_with_head(200));
        let whole = futures_util::stream::iter([Ok::<_, super::BoxError>(body.clone())]);
        let mut pieces = Box::pin(in_pieces(whole, "XB", Watch::default()));
        let first = pieces.next().await.expect("a piece").expect("data");
        assert_eq!(first, body);
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let mut noop = std::task::Context::from_waker(std::task::Waker::noop());
        assert!(
            pieces.poll_next_unpin(&mut noop).is_pending(),
            "the end waits a poll"
        );
        assert!(pieces.next().await.is_none());
    }

    /// `stream`, and a receiver that ends once `stream` is dropped.
    fn watched<S: futures_util::Stream>(
        stream: S,
    ) -> (
        impl futures_util::Stream<Item = S::Item>,
        tokio::sync::oneshot::Receiver<()>,
    ) {
        use futures_util::StreamExt;
        let (alive, gone) = tokio::sync::oneshot::channel::<()>();
        let stream = stream.map(move |item| {
            let _alive = &alive;
            item
        });
        (stream, gone)
    }

    /// Whether `gone` ends within a few seconds.
    async fn let_go(gone: tokio::sync::oneshot::Receiver<()>) -> bool {
        tokio::time::timeout(std::time::Duration::from_secs(5), gone)
            .await
            .is_ok()
    }

    #[tokio::test]
    async fn a_form_lets_go_of_its_body_when_it_is_dropped() {
        use futures_util::StreamExt;
        let opened = || {
            let mut part =
                b"--XB\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.bin\"\r\n\r\n"
                    .to_vec();
            part.resize(part.len() + 2 * PIECE, 7);
            futures_util::stream::iter([Ok::<_, std::io::Error>(axum::body::Bytes::from(part))])
        };
        let waits = test_waits(60_000, 60_000);
        let (body, gone) = watched(opened().chain(futures_util::stream::pending()));
        let (form, _watch) = form_within(form_request(body.boxed()), usize::MAX, waits)
            .await
            .expect("form");
        drop(form);
        assert!(let_go(gone).await, "before it is read");
        let data = futures_util::stream::repeat_with(|| {
            Ok::<_, std::io::Error>(axum::body::Bytes::from(vec![7u8; 64 * 1024]))
        });
        let quiet = opened().chain(futures_util::stream::pending()).boxed();
        for (what, stream, chunks) in [
            ("while it waits for bytes", quiet, 0),
            (
                "while a piece waits for the parser",
                opened().chain(data).boxed(),
                1,
            ),
        ] {
            let (body, gone) = watched(stream);
            let (mut form, _watch) = form_within(form_request(body.boxed()), usize::MAX, waits)
                .await
                .expect("form");
            let mut field = next_part(&mut form).await.expect("parsed").expect("a part");
            for _ in 0..chunks {
                field.chunk().await.expect("data").expect("a chunk");
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            drop(field);
            drop(form);
            assert!(let_go(gone).await, "{what}");
        }
    }

    #[tokio::test]
    async fn a_form_is_read_at_most_a_piece_ahead_of_the_parser() {
        use futures_util::StreamExt;
        use std::sync::Arc;
        use std::sync::atomic::{AtomicUsize, Ordering};
        let read = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&read);
        let head = axum::body::Bytes::from_static(
            b"--XB\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.bin\"\r\n\r\n",
        );
        let data = futures_util::stream::repeat_with(|| axum::body::Bytes::from(vec![7u8; PIECE]));
        let body = futures_util::stream::iter([head])
            .chain(data)
            .map(move |chunk| {
                count.fetch_add(chunk.len(), Ordering::Relaxed);
                Ok::<_, super::BoxError>(chunk)
            });
        let (mut form, handed) = counted_form(body, "XB").await;
        let mut field = next_part(&mut form).await.expect("parsed").expect("a part");
        for _ in 0..3 {
            field.chunk().await.expect("data").expect("a chunk");
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            let ahead = read.load(Ordering::Relaxed) - handed.bytes();
            assert!(ahead <= PIECE, "{ahead} bytes read ahead of the parser");
        }
    }

    #[tokio::test]
    async fn a_failed_body_lets_go_of_its_stream_and_says_why() {
        use futures_util::StreamExt;
        let opened = || {
            futures_util::stream::iter([Ok::<_, std::io::Error>(axum::body::Bytes::from_static(
                b"--XB\r\nContent-Disposition: form-data; name=\"payload_json\"\r\n\r\n{",
            ))])
        };
        let reset = futures_util::stream::once(async { Err(std::io::Error::other("reset")) });
        let over = futures_util::stream::iter([Ok(axum::body::Bytes::from(vec![b' '; 64 * 1024]))]);
        for (what, rest, code) in [
            (
                "a transport error",
                reset.chain(futures_util::stream::pending()).boxed(),
                StatusCode::BAD_REQUEST,
            ),
            (
                "a stall",
                futures_util::stream::pending().boxed(),
                StatusCode::REQUEST_TIMEOUT,
            ),
            (
                "more than its most bytes",
                over.chain(futures_util::stream::pending()).boxed(),
                StatusCode::PAYLOAD_TOO_LARGE,
            ),
        ] {
            let (body, gone) = watched(opened().chain(rest));
            let (mut form, watch) =
                form_within(form_request(body.boxed()), 32 * 1024, test_waits(5000, 300))
                    .await
                    .expect("form");
            let field = next_part(&mut form).await.expect("parsed").expect("a part");
            let failed = read_json_part(field, usize::MAX, &watch).await;
            assert_eq!(
                failed.err().map(|ApiError(c, _, _)| c),
                Some(code),
                "{what}"
            );
            assert!(let_go(gone).await, "{what}");
            drop(form);
        }
    }

    #[tokio::test]
    async fn parts_read_the_same_in_any_pieces() {
        use futures_util::StreamExt;
        let body = json_and_file(70_000);
        let read = |sizes: usize| {
            let body = body.clone();
            async move {
                let pieces: Vec<_> = body
                    .chunks(sizes)
                    .map(axum::body::Bytes::copy_from_slice)
                    .collect();
                let sent = futures_util::stream::iter(pieces).then(|piece| async move {
                    tokio::task::yield_now().await;
                    Ok::<_, std::io::Error>(piece)
                });
                let (form, _watch) = form_within(
                    form_request(sent.boxed()),
                    usize::MAX,
                    test_waits(5000, 5000),
                )
                .await
                .expect("form");
                all_parts(form).await
            }
        };
        let whole = read(body.len()).await;
        assert_eq!(whole.len(), 2);
        assert_eq!(whole[0].2, r#"{"content": "hi"}"#);
        assert_eq!(whole[1].1.as_deref(), Some("a.bin"));
        assert_eq!(whole[1].2.len(), 70_000);
        for sizes in [1, 7, 4096, 16 * 1024 + 3] {
            assert_eq!(read(sizes).await, whole, "in pieces of {sizes} bytes");
        }
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
            let over = || ApiError(StatusCode::PAYLOAD_TOO_LARGE, String::new(), None);
            watch
                .error(over, ApiError(StatusCode::BAD_REQUEST, e.to_string(), None))
                .0
        };
        let first = |stream| async move {
            let (mut form, watch) = form_within(form_request(stream), 128 * 1024, waits)
                .await
                .expect("form");
            let started = std::time::Instant::now();
            let code = match next_part(&mut form).await {
                Ok(Some(field)) => match read_json_part(field, usize::MAX, &watch).await {
                    Ok(_) => StatusCode::OK,
                    Err(ApiError(code, _, _)) => code,
                },
                Ok(None) => StatusCode::OK,
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
        let opened =
            futures_util::stream::iter([Ok::<_, std::io::Error>(axum::body::Bytes::from_static(
                b"--XB\r\nContent-Disposition: form-data; name=\"payload_json\"\r\n\r\n",
            ))]);
        let (code, _) = first(opened.chain(pieces(4, 64)).boxed()).await;
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
                let field = match next_part(&mut form).await {
                    Ok(Some(field)) => field,
                    Ok(None) => return (read, None),
                    Err(e) => return (read, Some(failed(&watch, e))),
                };
                match read_json_part(field, 1024, &watch).await {
                    Ok(_) => read += 1,
                    Err(ApiError(code, _, _)) => return (read, Some(code)),
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
            sock.write_all(&[b'x'; 8 * 1024]).await.expect("preamble");
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
                    None,
                )
                .await
            }
        };
        let refused = |r: Result<(String, i64), ApiError>| {
            matches!(r, Err(ApiError(StatusCode::TOO_MANY_REQUESTS, _, _)))
        };
        assert!(save("@1", hook("alice", "s1")).await.is_ok());
        match save("@2", hook("alice", "s2")).await {
            Err(ApiError(StatusCode::TOO_MANY_REQUESTS, msg, _)) => assert_eq!(
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
        let res = download_media(
            State(state.clone()),
            GET,
            axum::http::HeaderMap::new(),
            Path(id),
        )
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
                GET,
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
                Err(ApiError(status, msg, _)) => {
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
                download_media(State(state), GET, headers, Path(id))
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

    #[test]
    fn s3_answers_hold_at_most_one_window() {
        let window = super::S3_WINDOW;
        assert_eq!(window, 8 * 1024 * 1024);
        let part = |start, end| Wanted::Part { start, end };
        let cases = [
            (part(0, 99), part(0, 99)),
            (part(0, window - 1), part(0, window - 1)),
            (part(0, window), part(0, window - 1)),
            (part(10, 50_000_000), part(10, window + 9)),
            (part(u64::MAX - 5, u64::MAX), part(u64::MAX - 5, u64::MAX)),
            (Wanted::Whole, Wanted::Whole),
            (Wanted::Unsatisfiable, Wanted::Unsatisfiable),
        ];
        for (asked, sent) in cases {
            assert_eq!(super::s3_window(asked), sent, "{asked:?}");
        }
    }

    #[test]
    fn range_headers_name_one_byte_range() {
        let part = |start, end| Wanted::Part { start, end };
        let cases: &[(Option<&str>, u64, Wanted)] = &[
            (None, 100, Wanted::Whole),
            (Some("bytes=0-9"), 100, part(0, 9)),
            (Some("bytes=10-"), 100, part(10, 99)),
            (Some("bytes=-5"), 100, part(95, 99)),
            (Some("bytes=-500"), 100, part(0, 99)),
            (Some("bytes=90-500"), 100, part(90, 99)),
            (Some("BYTES = 1-2"), 100, part(1, 2)),
            (Some("bytes=99-99"), 100, part(99, 99)),
            (Some("bytes=100-"), 100, Wanted::Unsatisfiable),
            (Some("bytes=100-200"), 100, Wanted::Unsatisfiable),
            (Some("bytes=-0"), 100, Wanted::Unsatisfiable),
            (Some("bytes=0-"), 0, Wanted::Unsatisfiable),
            (Some("bytes=-1"), 0, Wanted::Unsatisfiable),
            (Some("bytes=0-1,4-5"), 100, Wanted::Whole),
            (Some("bytes=9-3"), 100, Wanted::Whole),
            (Some("bytes=-"), 100, Wanted::Whole),
            (Some("bytes=a-b"), 100, Wanted::Whole),
            (Some("bytes=+1-2"), 100, Wanted::Whole),
            (Some("bytes=1-2x"), 100, Wanted::Whole),
            (Some("bytes=99999999999999999999999-"), 100, Wanted::Whole),
            (Some("items=0-9"), 100, Wanted::Whole),
            (Some("bytes 0-9"), 100, Wanted::Whole),
        ];
        for (header, size, wanted) in cases {
            assert_eq!(
                wanted_range(*header, *size),
                *wanted,
                "{header:?} of {size}"
            );
        }
    }

    async fn ranged(
        state: &crate::state::AppState,
        id: &str,
        pairs: &[(axum::http::HeaderName, &str)],
    ) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
        let mut headers = axum::http::HeaderMap::new();
        for (name, value) in pairs {
            headers.insert(name.clone(), value.parse().expect("header value"));
        }
        let res = download_media(State(state.clone()), GET, headers, Path(id.to_string()))
            .await
            .expect("download");
        let (parts, body) = res.into_parts();
        let body = axum::body::to_bytes(body, usize::MAX).await.expect("body");
        (parts.status, parts.headers, body.to_vec())
    }

    #[tokio::test]
    async fn downloads_answer_one_byte_range() {
        use axum::http::header::{
            ACCEPT_RANGES, CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_RANGE,
            CONTENT_SECURITY_POLICY, ETAG, IF_NONE_MATCH, IF_RANGE, RANGE, X_CONTENT_TYPE_OPTIONS,
        };
        let (state, path) = temp_state("media_ranges").await;
        let id = "e1".repeat(16);
        let blob: Vec<u8> = (0..700_000u32).map(|i| (i % 251) as u8).collect();
        store_media(
            &state.db,
            &id,
            "clip.mp4",
            "video/mp4",
            blob.len() as i64,
            Some(&blob),
            "alice",
            now(),
        )
        .await
        .expect("store media");
        let cid = general(&state.db).await;
        sqlx::query("INSERT INTO messages(channel_id, author, content, media_id, media_filename, created_at) VALUES($1, 'alice', '', $2, 'clip.mp4', 1)")
            .bind(cid)
            .bind(&id)
            .execute(&state.db)
            .await
            .expect("attach");
        let etag = format!("\"{id}\"");

        let (status, headers, body) = ranged(&state, &id, &[]).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers[ACCEPT_RANGES], "bytes");
        assert_eq!(headers[CONTENT_LENGTH], "700000");
        assert!(headers.get(CONTENT_RANGE).is_none());
        assert_eq!(body, blob);

        let chunk = super::MEDIA_CHUNK;
        for (asked, start, end) in [
            ("bytes=0-9", 0, 9),
            ("bytes=262140-262150", chunk - 4, chunk + 6),
            ("bytes=100000-600000", 100_000, 600_000),
            ("bytes=524288-524288", 2 * chunk, 2 * chunk),
            ("bytes=699990-", 699_990, 699_999),
            ("bytes=-5", 699_995, 699_999),
            ("bytes=-800000", 0, 699_999),
            ("bytes=5-999999", 5, 699_999),
        ] {
            let (status, headers, body) = ranged(&state, &id, &[(RANGE, asked)]).await;
            assert_eq!(status, StatusCode::PARTIAL_CONTENT, "{asked}");
            assert_eq!(
                headers[CONTENT_RANGE],
                format!("bytes {start}-{end}/700000").as_str(),
                "{asked}"
            );
            assert_eq!(
                headers[CONTENT_LENGTH],
                (end - start + 1).to_string().as_str(),
                "{asked}"
            );
            assert_eq!(body, blob[start..=end], "{asked}");
            assert_eq!(headers[ACCEPT_RANGES], "bytes");
            assert_eq!(headers[ETAG], etag.as_str());
            assert!(
                headers[CONTENT_DISPOSITION]
                    .to_str()
                    .expect("disposition")
                    .starts_with("attachment;")
            );
            assert_eq!(headers[X_CONTENT_TYPE_OPTIONS], "nosniff");
            assert_eq!(
                headers[CONTENT_SECURITY_POLICY],
                "default-src 'none'; sandbox"
            );
            assert!(
                headers[CACHE_CONTROL]
                    .to_str()
                    .expect("cache")
                    .contains("immutable")
            );
        }

        for asked in ["bytes=700000-", "bytes=800000-900000", "bytes=-0"] {
            let (status, headers, body) = ranged(&state, &id, &[(RANGE, asked)]).await;
            assert_eq!(status, StatusCode::RANGE_NOT_SATISFIABLE, "{asked}");
            assert_eq!(headers[CONTENT_RANGE], "bytes */700000");
            assert_eq!(headers[CONTENT_LENGTH], "0");
            assert_eq!(headers[X_CONTENT_TYPE_OPTIONS], "nosniff");
            assert!(body.is_empty());
        }

        for asked in ["bytes=0-1,5-6", "bytes=abc", "bytes=9-3", "lines=1-2"] {
            let (status, headers, body) = ranged(&state, &id, &[(RANGE, asked)]).await;
            assert_eq!(status, StatusCode::OK, "{asked}");
            assert_eq!(headers[ACCEPT_RANGES], "bytes");
            assert_eq!(body.len(), blob.len(), "{asked}");
        }

        let (status, _, body) =
            ranged(&state, &id, &[(RANGE, "bytes=0-9"), (IF_RANGE, &etag)]).await;
        assert_eq!((status, body.len()), (StatusCode::PARTIAL_CONTENT, 10));
        let weak = format!("W/{etag}");
        for stale in [
            "\"other\"",
            "W/\"other\"",
            weak.as_str(),
            "Wed, 21 Oct 2015 07:28:00 GMT",
        ] {
            let (status, _, body) =
                ranged(&state, &id, &[(RANGE, "bytes=0-9"), (IF_RANGE, stale)]).await;
            assert_eq!(
                (status, body.len()),
                (StatusCode::OK, blob.len()),
                "{stale}"
            );
        }

        let (status, headers, body) =
            ranged(&state, &id, &[(RANGE, "bytes=0-9"), (IF_NONE_MATCH, &etag)]).await;
        assert_eq!(status, StatusCode::NOT_MODIFIED);
        assert!(headers.get(CONTENT_RANGE).is_none());
        assert!(body.is_empty());
        done(state, path).await;
    }

    #[tokio::test]
    async fn ranges_of_files_kept_whole_or_empty() {
        use axum::http::header::{CONTENT_LENGTH, CONTENT_RANGE, RANGE};
        let (state, path) = temp_state("media_ranges_inline").await;
        let cid = general(&state.db).await;
        let inline = "e2".repeat(16);
        sqlx::query("INSERT INTO media(id, filename, mime, size, data, uploaded_at) VALUES($1, 'a.bin', 'application/octet-stream', 10, $2, $3)")
            .bind(&inline)
            .bind((0u8..10).collect::<Vec<u8>>())
            .bind(now())
            .execute(&state.db)
            .await
            .expect("inline media");
        let empty = "e3".repeat(16);
        store_media(
            &state.db,
            &empty,
            "e.txt",
            "text/plain",
            0,
            Some(&[]),
            "alice",
            now(),
        )
        .await
        .expect("empty media");
        for id in [&inline, &empty] {
            sqlx::query("INSERT INTO messages(channel_id, author, content, media_id, media_filename, created_at) VALUES($1, 'alice', '', $2, 'a.bin', 1)")
                .bind(cid)
                .bind(id)
                .execute(&state.db)
                .await
                .expect("attach");
        }
        let (status, headers, body) = ranged(&state, &inline, &[(RANGE, "bytes=2-4")]).await;
        assert_eq!(status, StatusCode::PARTIAL_CONTENT);
        assert_eq!(headers[CONTENT_RANGE], "bytes 2-4/10");
        assert_eq!(headers[CONTENT_LENGTH], "3");
        assert_eq!(body, vec![2, 3, 4]);
        let (status, headers, _) = ranged(&state, &inline, &[(RANGE, "bytes=10-")]).await;
        assert_eq!(status, StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(headers[CONTENT_RANGE], "bytes */10");
        let (status, headers, body) = ranged(&state, &empty, &[(RANGE, "bytes=0-")]).await;
        assert_eq!(status, StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(headers[CONTENT_RANGE], "bytes */0");
        assert!(body.is_empty());
        let (status, headers, body) = ranged(&state, &empty, &[]).await;
        assert_eq!((status, body.len()), (StatusCode::OK, 0));
        assert_eq!(headers[CONTENT_LENGTH], "0");
        done(state, path).await;
    }

    #[tokio::test]
    async fn get_and_head_answer_ranges_through_the_router() {
        use crate::config::{AppConfig, Roles};
        use crate::server::client_ip::ProxyTrust;
        use crate::server::route_builder::{api_router, resolve_versions};
        let (state, path) = temp_state("media_ranges_router").await;
        let id = "e5".repeat(16);
        let blob: Vec<u8> = (0..300_000u32).map(|i| (i % 253) as u8).collect();
        store_media(
            &state.db,
            &id,
            "clip.webm",
            "video/webm",
            blob.len() as i64,
            Some(&blob),
            "alice",
            now(),
        )
        .await
        .expect("store media");
        let cid = general(&state.db).await;
        sqlx::query("INSERT INTO messages(channel_id, author, content, media_id, media_filename, created_at) VALUES($1, 'alice', '', $2, 'clip.webm', 1)")
            .bind(cid)
            .bind(&id)
            .execute(&state.db)
            .await
            .expect("attach");
        let config = AppConfig {
            roles: Roles {
                web: false,
                ..Roles::ALL
            },
            proxy_trust: ProxyTrust::Any,
            ..AppConfig::defaults()
        };
        let app = resolve_versions(api_router(&config, state.clone()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let url = format!(
            "http://{}/api/v1/media/{id}",
            listener.local_addr().expect("addr")
        );
        let server = tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await;
        });
        let client = reqwest::Client::new();
        let get = client
            .get(&url)
            .header("range", "bytes=262000-262200")
            .send()
            .await
            .expect("get");
        assert_eq!(get.status().as_u16(), 206);
        assert_eq!(get.headers()["accept-ranges"], "bytes");
        assert_eq!(get.headers()["content-range"], "bytes 262000-262200/300000");
        assert_eq!(get.headers()["content-length"], "201");
        let mut answers = vec![get.headers().clone()];
        assert_eq!(
            get.bytes().await.expect("body").as_ref(),
            &blob[262_000..=262_200]
        );
        let head = client
            .head(&url)
            .header("range", "bytes=-10")
            .send()
            .await
            .expect("head");
        assert_eq!(head.status().as_u16(), 206);
        assert_eq!(
            head.headers()["content-range"],
            "bytes 299990-299999/300000"
        );
        assert_eq!(head.headers()["content-length"], "10");
        answers.push(head.headers().clone());
        assert!(head.bytes().await.expect("body").is_empty());
        let whole = client.head(&url).send().await.expect("head");
        assert_eq!(whole.status().as_u16(), 200);
        assert_eq!(whole.headers()["accept-ranges"], "bytes");
        assert_eq!(whole.headers()["content-length"], "300000");
        let past = client
            .get(&url)
            .header("range", "bytes=300000-")
            .send()
            .await
            .expect("get");
        assert_eq!(past.status().as_u16(), 416);
        assert_eq!(past.headers()["content-range"], "bytes */300000");
        let past_head = client
            .head(&url)
            .header("range", "bytes=300000-")
            .send()
            .await
            .expect("head");
        assert_eq!(past_head.status().as_u16(), 416);
        assert_eq!(past_head.headers()["content-range"], "bytes */300000");
        let full = client.get(&url).send().await.expect("get");
        assert_eq!(full.status().as_u16(), 200);
        let etag = full.headers()["etag"].clone();
        let cached = client
            .get(&url)
            .header("if-none-match", etag)
            .send()
            .await
            .expect("get");
        assert_eq!(cached.status().as_u16(), 304);
        for answer in [&full, &whole, &past, &past_head, &cached] {
            answers.push(answer.headers().clone());
        }
        for headers in &answers {
            let policies: Vec<_> = headers
                .get_all("content-security-policy")
                .iter()
                .map(|v| v.to_str().expect("policy"))
                .collect();
            assert_eq!(
                policies,
                ["default-src 'none'; sandbox", "frame-ancestors 'none'"]
            );
            assert_eq!(headers["x-content-type-options"], "nosniff");
        }
        server.abort();
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_range_over_chunks_out_of_shape_ends_in_an_error() {
        use axum::http::header::RANGE;
        let (state, path) = temp_state("media_ranges_bad_rows").await;
        let cid = general(&state.db).await;
        let chunk = super::MEDIA_CHUNK;
        let blob: Vec<u8> = (0..(2 * chunk + 100) as u32)
            .map(|i| (i % 249) as u8)
            .collect();
        let mut ids = Vec::new();
        for (n, fault) in ["short", "missing"].into_iter().enumerate() {
            let id = format!("e{}", 6 + n).repeat(16);
            store_media(
                &state.db,
                &id,
                "clip.mp4",
                "video/mp4",
                blob.len() as i64,
                Some(&blob),
                "alice",
                now(),
            )
            .await
            .expect("store media");
            let broken = match fault {
                "short" => {
                    sqlx::query("UPDATE media_chunks SET data = $2 WHERE media_id = $1 AND seq = 1")
                        .bind(&id)
                        .bind(vec![0u8; 10])
                        .execute(&state.db)
                        .await
                }
                _ => {
                    sqlx::query("DELETE FROM media_chunks WHERE media_id = $1 AND seq = 1")
                        .bind(&id)
                        .execute(&state.db)
                        .await
                }
            };
            assert_eq!(broken.expect("break a row").rows_affected(), 1);
            sqlx::query("INSERT INTO messages(channel_id, author, content, media_id, media_filename, created_at) VALUES($1, 'alice', '', $2, 'clip.mp4', 1)")
                .bind(cid)
                .bind(&id)
                .execute(&state.db)
                .await
                .expect("attach");
            ids.push(id);
        }
        for id in &ids {
            let mut headers = axum::http::HeaderMap::new();
            headers.insert(
                RANGE,
                format!("bytes=10-{}", 2 * chunk + 50)
                    .parse()
                    .expect("range"),
            );
            let res = download_media(State(state.clone()), GET, headers, Path(id.clone()))
                .await
                .expect("download");
            assert_eq!(res.status(), StatusCode::PARTIAL_CONTENT, "{id}");
            let body = axum::body::to_bytes(res.into_body(), usize::MAX).await;
            assert!(body.is_err(), "{id}");
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_range_never_opens_hidden_media() {
        let (state, path) = temp_state("media_ranges_hidden").await;
        let id = "e4".repeat(16);
        store_media(
            &state.db,
            &id,
            "a.txt",
            "text/plain",
            3,
            Some(&[1, 2, 3]),
            "alice",
            now(),
        )
        .await
        .expect("store media");
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(
            axum::http::header::RANGE,
            "bytes=0-1".parse().expect("range"),
        );
        let hidden = download_media(State(state.clone()), GET, headers, Path(id)).await;
        assert_eq!(
            hidden.err().map(|ApiError(c, m, _)| (c, m)),
            Some((StatusCode::NOT_FOUND, "Media not found".to_string()))
        );
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
            assert!(!see(Some("root"), id.clone()).await, "root {id}");
        }
        crate::api::staff_audit::tests::confirmed(db, "root", "rchat", cid).await;
        for _ in 0..2 {
            for id in [&old, &fresh, &reply] {
                assert!(see(Some("root"), id.clone()).await, "root {id}");
            }
        }
        let noted: Vec<String> = sqlx::query(
            "SELECT detail FROM instance_audit WHERE action = 'staff.media' AND actor = 'root' AND target = 'rchat' ORDER BY id",
        )
        .fetch_all(db)
        .await
        .expect("entries")
        .iter()
        .map(|r| {
            let detail: String = r.try_get(0).expect("detail");
            let detail: serde_json::Value = serde_json::from_str(&detail).expect("json");
            assert_eq!(detail["channel"], serde_json::json!(cid));
            assert!(detail["message"].is_i64());
            assert_eq!(detail.as_object().map(|o| o.len()), Some(3), "{detail}");
            detail["media"].as_str().expect("media").to_string()
        })
        .collect();
        assert_eq!(noted, vec![old.clone(), fresh.clone(), reply.clone()]);
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
        let cached = download_media(State(state.clone()), GET, headers, Path(fresh.clone())).await;
        assert_eq!(
            cached.err().map(|ApiError(c, m, _)| (c, m)),
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
        let hidden = download_media(
            State(state.clone()),
            GET,
            axum::http::HeaderMap::new(),
            Path(id),
        )
        .await;
        assert_eq!(
            hidden.err().map(|ApiError(c, m, _)| (c, m)),
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
