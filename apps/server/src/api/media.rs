use std::fmt::Write;

use axum::Json;
use axum::body::Body;
use axum::extract::{Multipart, Path, State};
use axum::http::{StatusCode, header};
use axum::response::Response;
use rand::Rng;
use s3::Bucket;
use sqlx::Row;

use crate::api::access::{MsgScope, Proof, resolve_message};
use crate::api::audit;
use crate::api::{
    ApiError, ApiErrorBody, Authed, MediaRef, OkResp, Settings, allowed, bad, header_grants, ok,
    placeholders, request_token, require_guest_ok, user_for_token,
};
use crate::db::{Db, MediaKind, User, now};
use crate::state::AppState;
use crate::ws::WsEvent;

pub(crate) const MAX_SIZE: usize = 25 * 1024 * 1024;
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
    /// Most bytes of one account's files kept at once (uploads live a day); 0 for no limit.
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

static LIMITS: std::sync::OnceLock<UploadLimits> = std::sync::OnceLock::new();
static BUFFER: std::sync::OnceLock<std::sync::Arc<tokio::sync::Semaphore>> =
    std::sync::OnceLock::new();

/// Sets the upload limits once at startup.
pub fn configure(limits: UploadLimits) {
    let _ = LIMITS.set(limits);
}

fn limits() -> UploadLimits {
    LIMITS.get().copied().unwrap_or_default()
}

/// Upload bodies in memory, counted in KiB.
fn buffer() -> std::sync::Arc<tokio::sync::Semaphore> {
    BUFFER
        .get_or_init(|| {
            let kib = (limits().buffer / 1024).clamp(MAX_SIZE as u64 / 1024, u32::MAX as u64);
            std::sync::Arc::new(tokio::sync::Semaphore::new(kib as usize))
        })
        .clone()
}

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

fn too_large() -> ApiError {
    ApiError(
        StatusCode::PAYLOAD_TOO_LARGE,
        "File exceeds 25MB limit".to_string(),
    )
}

/// An upload body held in memory, counted against the instance-wide upload buffer and its
/// account's uploads at once until it is dropped.
pub(crate) struct Buffered {
    pub data: Vec<u8>,
    _held: tokio::sync::OwnedSemaphorePermit,
    _slot: crate::api::budget::Slot,
}

/// Reads one multipart file part of a request that declared `declared` bytes (`None`: not
/// declared). Room in the upload buffer for the whole file (the declared length, at most
/// `MAX_SIZE`) is taken once before reading, so a body never waits for more room while it holds
/// some; when the buffer stays full the upload is refused with 503. A body that sends nothing
/// for `IDLE_WAIT`, or takes longer than `BODY_WAIT`, is dropped with 408 and its room given
/// back. `slot` is the account's place among its uploads at once.
pub(crate) async fn read_file(
    field: axum::extract::multipart::Field<'_>,
    declared: Option<u64>,
    slot: crate::api::budget::Slot,
) -> Result<Buffered, ApiError> {
    read_chunks(field, declared, buffer(), WAITS, slot).await
}

async fn read_chunks<S, E>(
    stream: S,
    declared: Option<u64>,
    buffer: std::sync::Arc<tokio::sync::Semaphore>,
    waits: Waits,
    slot: crate::api::budget::Slot,
) -> Result<Buffered, ApiError>
where
    S: futures_util::Stream<Item = Result<axum::body::Bytes, E>>,
    E: std::fmt::Display,
{
    use futures_util::StreamExt;
    let most = declared.map_or(MAX_SIZE, |n| n.min(MAX_SIZE as u64) as usize);
    let kib = u32::try_from(most.div_ceil(1024)).map_err(|_| too_large())?;
    let held = tokio::time::timeout(waits.room, buffer.acquire_many_owned(kib))
        .await
        .ok()
        .and_then(Result::ok)
        .ok_or_else(|| {
            ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                "Too many uploads right now, try again in a moment".to_string(),
            )
        })?;
    let stalled = || {
        ApiError(
            StatusCode::REQUEST_TIMEOUT,
            "The upload stopped sending data".to_string(),
        )
    };
    let end = tokio::time::Instant::now() + waits.body;
    let mut stream = std::pin::pin!(stream);
    let mut data: Vec<u8> = Vec::new();
    loop {
        let next = (tokio::time::Instant::now() + waits.idle).min(end);
        let chunk = match tokio::time::timeout_at(next, stream.next()).await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(_) => return Err(stalled()),
        };
        let chunk = chunk.map_err(|e| ApiError(StatusCode::PAYLOAD_TOO_LARGE, e.to_string()))?;
        if data.len() + chunk.len() > most {
            return Err(too_large());
        }
        data.extend_from_slice(&chunk);
    }
    Ok(Buffered {
        data,
        _held: held,
        _slot: slot,
    })
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
    let whose = match charge.hooks_of {
        Some(_) => "files from this webhook's owner (or from all webhooks of its server)",
        None => "your files",
    };
    ApiError(
        StatusCode::TOO_MANY_REQUESTS,
        format!(
            "Upload limit reached: up to {} of {whose} are kept at once, and each is deleted 1 day after upload",
            fmt_bytes(budget)
        ),
    )
}

/// The files counted against an account: its own uploads and those charged to it.
const ACCOUNT_USED: &str = "SELECT CAST(COALESCE(SUM(size), 0) AS BIGINT) FROM media WHERE (uploader = $1 OR charged_to = $1) AND uploaded_at > $2";
/// The files of a server's webhooks.
const HOOKS_USED: &str = "SELECT CAST(COALESCE(SUM(size), 0) AS BIGINT) FROM media WHERE charged_server = $1 AND uploaded_at > $2";

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
            .bind(now() - MEDIA_TTL_SECS)
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

/// Stores `file` unless it takes `charge` past `budget` bytes of live files (0 for no limit):
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
    let inserted = sqlx::query(
        "INSERT INTO media(id, filename, mime, size, data, uploader, uploaded_at, charged_to, charged_server) SELECT $1, $2, $3, $4, NULL, $5, $6, $9, $10 WHERE $7 = 0 OR ((SELECT COALESCE(SUM(size), 0) FROM media WHERE (uploader = $11 OR charged_to = $11) AND uploaded_at > $8) + $4 <= $7 AND ($10 IS NULL OR (SELECT COALESCE(SUM(size), 0) FROM media WHERE charged_server = $10 AND uploaded_at > $8) + $4 <= $7))",
    )
    .bind(file.id)
    .bind(file.filename)
    .bind(file.mime)
    .bind(file.size)
    .bind(file.uploader)
    .bind(file.uploaded_at)
    .bind(budget.min(i64::MAX as u64) as i64)
    .bind(file.uploaded_at - MEDIA_TTL_SECS)
    .bind(charged_to)
    .bind(charge.hooks_of.map(str::to_string))
    .bind(charge.account)
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
/// message. The file is deleted 24 hours after upload whether attached or not, and messages
/// carrying it then show it as removed (`media_removed` event). At most 25 MiB per file, and
/// at most the instance's per-account budget (`UPLOAD_BUDGET_MIB`, 2 GiB unless set) of your
/// files kept at once (files your webhooks sent count too). At most 3 of your uploads are read
/// at once; a body that sends nothing for 30 seconds (or takes over 10 minutes) is dropped with
/// 408.
///
/// Requires a bearer token and the instance's uploads setting. Strict rate-limit bucket.
#[utoipa::path(post, path = "/api/media", tag = "Media", request_body(content = Vec<u8>, content_type = "multipart/form-data", description = "A multipart form whose first part is the file"), responses((status = 200, description = "File stored; returns a media reference with its expiry time to attach to a message", body = MediaRef), (status = 400, description = "No file part (JSON `No file provided`) or a malformed multipart body (JSON). A body that is not `multipart/form-data` or has no valid boundary gets a plain-text 400 from the framework", content((ApiErrorBody = "application/json"), (String = "text/plain"))), (status = 401, description = "Not signed in", body = ApiErrorBody), (status = 403, description = "File uploads are disabled on this instance", body = ApiErrorBody), (status = 413, description = "File over 25 MiB (`File exceeds 25MB limit`). A request body over 26 MiB is cut off while the file is read and answers with this status and the JSON error \"Error parsing `multipart/form-data` request\"", body = ApiErrorBody), (status = 408, description = "`The upload stopped sending data`: the body sent nothing for 30 seconds or took over 10 minutes", body = ApiErrorBody), (status = 429, description = "Too many requests in the strict bucket (shared with register, login, word hints, password change and guest access) or the general bucket (plain text), the per-account budget is used up (JSON `Upload limit reached: ...`; space frees up as your files expire), or 3 of your uploads are already being read (JSON `Too many uploads at once: ...`)", content((ApiErrorBody = "application/json"), (String = "text/plain"))), (status = 503, description = "`Too many uploads right now, try again in a moment`: the instance holds as many upload bodies in memory as it allows (each upload takes room for its whole declared size first)", body = ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn upload_media(
    State(state): State<AppState>,
    Authed(user): Authed,
    headers: axum::http::HeaderMap,
    mut multipart: Multipart,
) -> Result<Json<MediaRef>, ApiError> {
    if !Settings::cached(&state.db).await.asset_uploads {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "File uploads are disabled".to_string(),
        ));
    }
    check_budget(&state.db, Charge::own(&user.username), 1, budget()).await?;
    let slot = reading_slot(&state.db, &user.username)?;
    let declared = declared_length(&headers);
    let field = multipart
        .next_field()
        .await
        .map_err(|e| ApiError(StatusCode::BAD_REQUEST, e.to_string()))?
        .ok_or_else(|| bad("No file provided"))?;
    let filename = clean_filename(field.file_name().unwrap_or("file"));
    let mime = clean_mime(field.content_type().unwrap_or(NEUTRAL_MIME));
    let body = read_file(field, declared, slot).await?;
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
        uploaded_at + MEDIA_TTL_SECS,
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

async fn save_within(
    state: &AppState,
    filename: &str,
    mime: &str,
    data: &[u8],
    uploader: &str,
    charge: Charge<'_>,
    budget: u64,
) -> Result<(String, i64), ApiError> {
    if data.len() > MAX_SIZE {
        return Err(too_large());
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
#[utoipa::path(delete, path = "/api/messages/{id}/media", tag = "Media", params(("id" = i64, Path, description = "Message id")), responses((status = 200, description = "Removed; the body is `{\"ok\": true}`", body = OkResp), (status = 401, description = "Not signed in", body = ApiErrorBody), (status = 403, description = "Not the author and no Manage messages permission in the server", body = ApiErrorBody), (status = 404, description = "`Not found`: no such message, its author's account is being deleted, or you cannot read it (hidden channel, before your join without read history, a server you have no access to, or a DM you are not in); identical responses; or it has no attachment (`No attachment`)", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(("bearer" = [])))]
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
            if !shared {
                sqlx::query("DELETE FROM media WHERE id = $1")
                    .bind(&media_id)
                    .execute(&mut *tx)
                    .await?;
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
    headers: &axum::http::HeaderMap,
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
    let proof = Proof::grants(header_grants(headers));
    for r in &rows {
        if allowed(resolve_message(db, r.try_get(0)?, user, &proof).await)?.is_some() {
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
#[utoipa::path(get, path = "/api/media/{id}", tag = "Media", params(("id" = String, Path, description = "Media id, 32 hex characters, from `MediaRef.id`"), ("X-Guest-Grant" = Option<String>, Header, description = "Guest grants from `POST /api/servers/{name}/guest_access`, comma-separated, up to 100. Only read for guests viewing a password-protected server")), responses((status = 200, description = "File bytes, streamed. Carries a strong `ETag`, `Cache-Control: private, max-age=86400, immutable` and `Vary: X-Guest-Grant`"), (status = 304, description = "`If-None-Match` matched the media's ETag and you may see the file. Carries the same `ETag`, `Cache-Control` and `Vary`"), (status = 401, description = "Guest access is disabled and no valid token was sent", body = ApiErrorBody), (status = 403, description = "`Attachments are turned off on this server`: uploads and P2P attachments are both off (text only); only sent to callers who may see the file", body = ApiErrorBody), (status = 404, description = "`Media not found`: unknown id, the file expired or was deleted, or you may not read any message carrying it (banned, no access to its password-protected server, no view permission or no read-history access in its channel, or not a DM participant) or see the unattached upload; identical responses", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security((), ("bearer" = [])))]
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
    media_view_ok(&db, &headers, &id, user.as_ref()).await?;
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

async fn sweep_batch(db: &Db, cutoff: i64) -> sqlx::Result<(Vec<String>, Vec<WsEvent>)> {
    let mut tx = db.begin().await?;
    let rows = sqlx::query("SELECT id FROM media WHERE uploaded_at <= $1 LIMIT $2")
        .bind(cutoff)
        .bind(SWEEP_BATCH)
        .fetch_all(&mut *tx)
        .await?;
    let ids = rows
        .iter()
        .map(|r| r.try_get::<String, _>(0))
        .collect::<sqlx::Result<Vec<_>>>()?;
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

async fn sweep(db: &Db, s3: Option<&Bucket>) -> sqlx::Result<Vec<WsEvent>> {
    let cutoff = now() - MEDIA_TTL_SECS;
    let mut events = Vec::new();
    loop {
        let (ids, batch) = sweep_batch(db, cutoff).await?;
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
        Charge, FILENAME_MAX, MAX_SIZE, MEDIA_TTL_SECS, MIME_MAX, NEUTRAL_MIME, SWEEP_BATCH,
        UPLOADS_PER_ACCOUNT, Waits, check_budget, clean_filename, clean_mime, content_disposition,
        delete_media, download_media, media_view_ok, read_chunks, reading_slot, save_within,
        store_media, sweep,
    };
    use crate::api::test_util::{done, mem_user, temp_state};
    use crate::api::{ApiError, Authed};
    use crate::db::{now, open};
    use axum::extract::{Path, State};
    use axum::http::StatusCode;
    use sqlx::Row;

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
                assert!(msg.starts_with("Upload limit reached"), "{msg}");
                assert!(msg.contains("4 MiB"), "{msg}");
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

    #[tokio::test]
    async fn the_whole_body_is_reserved_once_and_given_back() {
        let (state, path) = temp_state("media_reserve").await;
        let db = &state.db;
        let room = std::sync::Arc::new(tokio::sync::Semaphore::new(64));
        let first = read_chunks(
            pieces(3, 16),
            Some(48 * 1024),
            room.clone(),
            test_waits(50, 5000),
            slot(db, "a"),
        )
        .await
        .expect("fits");
        assert_eq!(first.data.len(), 48 * 1024);
        assert_eq!(room.available_permits(), 16);
        let busy = read_chunks(
            pieces(2, 16),
            Some(32 * 1024),
            room.clone(),
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
        let lying = read_chunks(
            pieces(3, 16),
            Some(16 * 1024),
            room.clone(),
            test_waits(50, 5000),
            slot(db, "c"),
        )
        .await;
        assert_eq!(
            lying.err().map(|ApiError(c, _)| c),
            Some(StatusCode::PAYLOAD_TOO_LARGE),
            "never more than the room taken"
        );
        let big = read_chunks(
            pieces(MAX_SIZE / (16 * 1024) + 1, 16),
            None,
            std::sync::Arc::new(tokio::sync::Semaphore::new(MAX_SIZE / 1024)),
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
                tokio::spawn(read_chunks(stalled(1), Some(30 * 1024), room, waits, held))
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
        let small = read_chunks(
            pieces(1, 8),
            Some(8 * 1024),
            room.clone(),
            waits,
            slot(&db, "alice"),
        )
        .await
        .expect("another account's upload goes through");
        drop(small);
        let started = std::time::Instant::now();
        let large = read_chunks(
            pieces(4, 8),
            Some(32 * 1024),
            room.clone(),
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
                let body = read_chunks(
                    pieces(5, 8),
                    Some(40 * 1024),
                    room,
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
        assert!(
            refused(save("@2", hook("alice", "s2")).await),
            "a second webhook of the same owner"
        );
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
                media_view_ok(&state.db, &headers, &id, Some(&mem_user(who, false)))
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
                media_view_ok(&state.db, &headers, &id, Some(&mem_user(who, admin)))
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
        assert!(media_view_ok(&state.db, &headers, &id, None).await.is_ok());
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
                media_view_ok(&state.db, &headers, &id, user.as_ref())
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
        assert!(media_view_ok(db, &with_header, &id, None).await.is_ok());
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
