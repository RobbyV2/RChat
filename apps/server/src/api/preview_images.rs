use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::Response;
use sha2::Digest;
use sqlx::Row;
use tokio::sync::Semaphore;
use url::Url;

use crate::api::access::{Proof, resolve_message};
use crate::api::budget::{Budget, slow_down};
use crate::api::embeds::preview_policy;
use crate::api::{
    ApiError, ApiErrorBody, Settings, request_token, require_guest_ok, user_for_token,
};
use crate::db::{Db, now};
use crate::net_guard::Policy;
use crate::state::AppState;

/// Largest preview image the server fetches and serves.
pub(crate) const IMAGE_MAX: usize = 5 * 1024 * 1024;
/// Largest width or height of a preview image.
const SIDE_MAX: u32 = 8192;
/// Most pixels of a preview image, so viewers' browsers never decode a huge canvas.
const PIXELS_MAX: u64 = 24_000_000;
/// How long a fetched image is served before it is fetched again.
const KEEP_SECS: i64 = 7 * 86400;
/// How long a failed fetch is remembered, so viewers can't make the server fetch it again.
const FAILED_SECS: i64 = 3600;
/// Most bytes all cached images take together; the oldest go first.
const CACHE_BYTES: i64 = 128 * 1024 * 1024;
/// Most cached entries, failures included.
const CACHE_ROWS: i64 = 20_000;
/// Most preview images fetched at once by this process, for all viewers together.
const FETCHES_MAX: usize = 8;
/// How long a fetch waits for one of `FETCHES_MAX` before the image is answered as not found
/// (and tried again on a later view).
const FETCH_WAIT: Duration = Duration::from_secs(2);
/// Most preview images held in memory for answers at once by this process; past it (after
/// `SERVE_WAIT`) the answer is 503.
const SERVES_MAX: usize = 16;
/// Most KiB of preview images held in memory for answers at once by this process.
const SERVE_KIB: usize = 32 * 1024;
/// How long an answer waits for room in `SERVE_KIB` before it is refused with 503.
const SERVE_WAIT: Duration = Duration::from_secs(2);
/// Image requests per client address (an IPv6 /64 as one) per minute.
const REQUESTS_PER_MINUTE: u32 = 120;

static FETCHES: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(FETCHES_MAX)));
static SERVES: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(SERVES_MAX)));
static SERVE_BYTES: LazyLock<Arc<Semaphore>> =
    LazyLock::new(|| Arc::new(Semaphore::new(SERVE_KIB)));
static REQUESTS: LazyLock<Budget> =
    LazyLock::new(|| Budget::new(REQUESTS_PER_MINUTE, Duration::from_secs(60), 100_000));

fn not_found() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, "Image not found".to_string())
}

fn busy() -> ApiError {
    ApiError(
        StatusCode::SERVICE_UNAVAILABLE,
        "Too many preview images right now, try again in a moment".to_string(),
    )
}

/// The raster types previews may show, recognized from their first bytes, with their size in
/// pixels read from the header. SVG and anything else is refused.
pub(crate) fn sniff(bytes: &[u8]) -> Option<(&'static str, u32, u32)> {
    let be16 = |at: usize| Some(u16::from_be_bytes(bytes.get(at..at + 2)?.try_into().ok()?));
    let le16 = |at: usize| Some(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?));
    let be32 = |at: usize| Some(u32::from_be_bytes(bytes.get(at..at + 4)?.try_into().ok()?));
    let le24 = |at: usize| {
        let b = bytes.get(at..at + 3)?;
        Some(u32::from(b[0]) | u32::from(b[1]) << 8 | u32::from(b[2]) << 16)
    };
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") && bytes.get(12..16) == Some(b"IHDR") {
        return Some(("image/png", be32(16)?, be32(20)?));
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        let (w, h) = (le16(6)?, le16(8)?);
        let (fw, fh) = gif_first_frame(bytes)?;
        // Browsers grow the canvas to the first frame when it is larger than the screen.
        return Some(("image/gif", u32::from(w.max(fw)), u32::from(h.max(fh))));
    }
    if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        let (w, h) = match bytes.get(12..16)? {
            b"VP8 " if bytes.get(23..26) == Some(&[0x9d, 0x01, 0x2a]) => {
                (le16(26)? & 0x3fff, le16(28)? & 0x3fff)
            }
            b"VP8L" if bytes.get(20) == Some(&0x2f) => {
                let bits = u32::from_le_bytes(bytes.get(21..25)?.try_into().ok()?);
                return Some((
                    "image/webp",
                    (bits & 0x3fff) + 1,
                    ((bits >> 14) & 0x3fff) + 1,
                ));
            }
            b"VP8X" => return Some(("image/webp", le24(24)? + 1, le24(27)? + 1)),
            _ => return None,
        };
        return Some(("image/webp", u32::from(w), u32::from(h)));
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        let mut at = 2;
        loop {
            if *bytes.get(at)? != 0xff {
                return None;
            }
            let marker = *bytes.get(at + 1)?;
            match marker {
                0xff => at += 1,
                0x01 | 0xd0..=0xd7 => at += 2,
                0xd8..=0xda => return None,
                0xc0..=0xcf if !matches!(marker, 0xc4 | 0xc8 | 0xcc) => {
                    return Some((
                        "image/jpeg",
                        u32::from(be16(at + 7)?),
                        u32::from(be16(at + 5)?),
                    ));
                }
                _ => at += 2 + usize::from(be16(at + 2)?),
            }
        }
    }
    None
}

/// How far the first frame of a GIF reaches (left + width, top + height), found by walking
/// past the global color table and the extension blocks to the first image descriptor.
fn gif_first_frame(bytes: &[u8]) -> Option<(u16, u16)> {
    let le16 = |at: usize| Some(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?));
    let flags = *bytes.get(10)?;
    let mut at = 13;
    if flags & 0x80 != 0 {
        at += 3 << ((flags & 0x07) + 1);
    }
    loop {
        match *bytes.get(at)? {
            0x2c => {
                let reach = |offset: usize, size: usize| {
                    u16::try_from(u32::from(le16(at + offset)?) + u32::from(le16(at + size)?)).ok()
                };
                return Some((reach(1, 5)?, reach(3, 7)?));
            }
            0x21 => {
                at += 2;
                loop {
                    let len = usize::from(*bytes.get(at)?);
                    at += 1 + len;
                    if len == 0 {
                        break;
                    }
                }
            }
            _ => return None,
        }
    }
}

/// The sniffed type of a preview image within the size and pixel caps.
fn acceptable(bytes: &[u8]) -> Option<&'static str> {
    let (mime, w, h) = sniff(bytes)?;
    let fits = w > 0
        && h > 0
        && w <= SIDE_MAX
        && h <= SIDE_MAX
        && u64::from(w) * u64::from(h) <= PIXELS_MAX;
    fits.then_some(mime)
}

/// The URLs to try for an image: an `http` URL on the default port is tried over `https` first.
fn attempts(url: &Url) -> Vec<Url> {
    let mut out = Vec::new();
    if url.scheme() == "http" && url.port().is_none() {
        let mut secure = url.clone();
        if secure.set_scheme("https").is_ok() {
            out.push(secure);
        }
    }
    out.push(url.clone());
    out
}

/// Fetches one preview image through the outbound guard: every hop is checked (and pinned to the
/// addresses checked), at most 4 redirects, no cookies or referrer, only raster types recognized
/// from their bytes, refused before reading when the declared length or type is wrong, and cut
/// off past `IMAGE_MAX`.
pub(crate) async fn fetch_image(
    start: &Url,
    policy: &Policy,
) -> anyhow::Result<(&'static str, Vec<u8>)> {
    let mut last = anyhow::anyhow!("no attempt");
    for first in attempts(start) {
        match fetch_from(&first, policy).await {
            Ok(found) => return Ok(found),
            Err(e) => last = e,
        }
    }
    Err(last)
}

async fn fetch_from(start: &Url, policy: &Policy) -> anyhow::Result<(&'static str, Vec<u8>)> {
    let mut url = start.clone();
    for _ in 0..5 {
        let checked = crate::net_guard::check(&url, policy).await?;
        let mut resp = checked
            .client(Duration::from_secs(5), Duration::from_secs(5))?
            .get(url.clone())
            .header("user-agent", "rchat-embed/1.0")
            .header("accept", "image/png, image/jpeg, image/gif, image/webp")
            .send()
            .await?;
        if resp.status().is_redirection() {
            let loc = resp
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| anyhow::anyhow!("redirect without location"))?;
            url = url.join(loc)?;
            continue;
        }
        if !resp.status().is_success() {
            anyhow::bail!("status {}", resp.status());
        }
        if resp.content_length().is_some_and(|n| n > IMAGE_MAX as u64) {
            anyhow::bail!("too large");
        }
        let declared = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !declared.is_empty()
            && !(declared.starts_with("image/") || declared.starts_with("application/octet-stream"))
            || declared.contains("svg")
        {
            anyhow::bail!("not an image");
        }
        let mut buf: Vec<u8> = Vec::new();
        while let Some(chunk) = resp.chunk().await? {
            buf.extend_from_slice(&chunk);
            if buf.len() > IMAGE_MAX {
                anyhow::bail!("too large");
            }
        }
        let mime = acceptable(&buf).ok_or_else(|| anyhow::anyhow!("not an accepted image"))?;
        return Ok((mime, buf));
    }
    anyhow::bail!("too many redirects")
}

static IN_FLIGHT: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(Default::default);

fn cache_key(source: &str) -> String {
    hex::encode(sha2::Sha256::digest(source.as_bytes()))
}

/// A cached copy: the image's type and size, or `None` for a fetch that failed lately.
async fn cached(db: &Db, key: &str) -> sqlx::Result<Option<Option<(String, i64)>>> {
    let t = now();
    let row = sqlx::query(
        "SELECT mime, size FROM preview_images WHERE key = $1 AND ((mime <> '' AND fetched_at > $2) OR (mime = '' AND fetched_at > $3))",
    )
    .bind(key)
    .bind(t - KEEP_SECS)
    .bind(t - FAILED_SECS)
    .fetch_optional(db)
    .await?;
    row.map(|r| {
        let mime: String = r.try_get(0)?;
        Ok(match mime.is_empty() {
            true => None,
            false => Some((mime, r.try_get(1)?)),
        })
    })
    .transpose()
}

/// The bytes of a cached image.
async fn blob(db: &Db, key: &str) -> sqlx::Result<Option<Vec<u8>>> {
    sqlx::query("SELECT data FROM preview_images WHERE key = $1 AND mime <> ''")
        .bind(key)
        .fetch_optional(db)
        .await?
        .map(|r| r.try_get(0))
        .transpose()
}

async fn remember(db: &Db, key: &str, found: Option<(&str, &[u8])>) -> sqlx::Result<()> {
    let (mime, data) = found.unwrap_or(("", &[]));
    sqlx::query(
        "INSERT INTO preview_images(key, mime, data, size, fetched_at) VALUES($1, $2, $3, $4, $5) ON CONFLICT(key) DO UPDATE SET mime = excluded.mime, data = excluded.data, size = excluded.size, fetched_at = excluded.fetched_at",
    )
    .bind(key)
    .bind(mime)
    .bind(data.to_vec())
    .bind(data.len() as i64)
    .bind(now())
    .execute(db)
    .await?;
    trim(db).await
}

/// Drops the oldest cached images until the cache fits `CACHE_BYTES` and `CACHE_ROWS`.
pub(crate) async fn trim(db: &Db) -> sqlx::Result<()> {
    trim_to(db, CACHE_BYTES, CACHE_ROWS).await
}

async fn trim_to(db: &Db, bytes: i64, rows: i64) -> sqlx::Result<()> {
    loop {
        let r = sqlx::query(
            "SELECT CAST(COALESCE(SUM(size), 0) AS BIGINT), COUNT(*) FROM preview_images",
        )
        .fetch_one(db)
        .await?;
        let (size, count): (i64, i64) = (r.try_get(0)?, r.try_get(1)?);
        if size <= bytes && count <= rows {
            return Ok(());
        }
        let average = (size / count.max(1)).max(1);
        let over = (count - rows).max((size - bytes + average - 1) / average);
        let n = sqlx::query("DELETE FROM preview_images WHERE key IN (SELECT key FROM preview_images ORDER BY fetched_at, key LIMIT $1)")
            .bind(over.clamp(1, 200))
            .execute(db)
            .await?
            .rows_affected();
        if n == 0 {
            return Ok(());
        }
    }
}

/// The type and size of the image at `source`, from the cache or fetched once (concurrent
/// requests for the same image wait for one fetch, and at most `FETCHES_MAX` fetches run at
/// once). `None` when it can't be shown.
pub(crate) async fn image(
    db: &Db,
    source: &str,
    policy: &Policy,
) -> sqlx::Result<Option<(String, i64)>> {
    let key = cache_key(source);
    if let Some(hit) = cached(db, &key).await? {
        return Ok(hit);
    }
    let lock = match IN_FLIGHT.lock() {
        Ok(mut map) => map.entry(key.clone()).or_default().clone(),
        Err(_) => Arc::default(),
    };
    let held = lock.lock().await;
    let out = match cached(db, &key).await? {
        Some(hit) => Ok(hit),
        None => match tokio::time::timeout(FETCH_WAIT, FETCHES.clone().acquire_owned()).await {
            Ok(Ok(permit)) => {
                let fetched = match Url::parse(source) {
                    Ok(url) => {
                        tokio::time::timeout(Duration::from_secs(10), fetch_image(&url, policy))
                            .await
                    }
                    Err(e) => Ok(Err(e.into())),
                };
                drop(permit);
                remembered(db, &key, fetched).await
            }
            // Too busy: not remembered, so a later view tries again.
            Ok(Err(_)) | Err(_) => Ok(None),
        },
    };
    drop(held);
    if let Ok(mut map) = IN_FLIGHT.lock()
        && map
            .get(&key)
            .is_some_and(|l| Arc::ptr_eq(l, &lock) && Arc::strong_count(l) <= 2)
    {
        map.remove(&key);
    }
    out
}

/// Stores the outcome of a fetch and returns what `image` answers.
async fn remembered(
    db: &Db,
    key: &str,
    fetched: Result<anyhow::Result<(&'static str, Vec<u8>)>, tokio::time::error::Elapsed>,
) -> sqlx::Result<Option<(String, i64)>> {
    match fetched {
        Ok(Ok((mime, data))) => {
            remember(db, key, Some((mime, &data))).await?;
            Ok(Some((mime.to_string(), data.len() as i64)))
        }
        Ok(Err(e)) => {
            tracing::debug!("preview image skipped: {e}");
            remember(db, key, None).await?;
            Ok(None)
        }
        Err(_) => {
            remember(db, key, None).await?;
            Ok(None)
        }
    }
}

/// Where a shown preview's image comes from: `None` when the message has no such preview, it
/// or its image was removed, or its link is only inside a spoiler.
async fn source_of(db: &Db, message_id: i64, ord: i64) -> sqlx::Result<Option<String>> {
    let row = sqlx::query(
        "SELECT me.url, e.image_url, m.content FROM message_embeds me JOIN embeds e ON e.url = me.url JOIN messages m ON m.id = me.message_id WHERE me.message_id = $1 AND me.ord = $2 AND me.removed = 0 AND me.banner_removed = 0",
    )
    .bind(message_id)
    .bind(ord)
    .fetch_optional(db)
    .await?;
    let Some(r) = row else {
        return Ok(None);
    };
    let (url, source, content): (String, Option<String>, String) =
        (r.try_get(0)?, r.try_get(1)?, r.try_get(2)?);
    if content.contains("||") && crate::api::embeds::spoilered_urls(&content).contains(&url) {
        return Ok(None);
    }
    Ok(source)
}

pub(crate) async fn serve(
    state: &AppState,
    headers: &HeaderMap,
    message_id: i64,
    ord: i64,
    policy: &Policy,
) -> Result<Response, ApiError> {
    let db = &state.db;
    if let Some(ip) = crate::api::budget::client() {
        let key = format!(
            "{}\n{}",
            crate::db::pool_key(db),
            crate::api::budget::group(ip)
        );
        if !REQUESTS.take(&key) {
            return Err(slow_down());
        }
    }
    let user = match request_token(headers) {
        Some(token) => user_for_token(state, &token).await?,
        None => None,
    };
    require_guest_ok(db, user.as_ref()).await?;
    if !Settings::cached(db).await.asset_previews {
        return Err(not_found());
    }
    let proof = Proof::headers(headers, &state.limits);
    resolve_message(db, message_id, user.as_ref(), &proof)
        .await
        .map_err(|e| match e {
            e @ ApiError(StatusCode::INTERNAL_SERVER_ERROR, _) => e,
            _ => not_found(),
        })?;
    let source = source_of(db, message_id, ord)
        .await?
        .ok_or_else(not_found)?;
    let (mime, size) = image(db, &source, policy).await?.ok_or_else(not_found)?;
    let etag = format!("\"{}\"", &cache_key(&source)[..32]);
    let cache = "private, max-age=86400";
    let fresh = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|t| t.trim() == etag));
    let res = Response::builder()
        .header(header::ETAG, &etag)
        .header(header::CACHE_CONTROL, cache)
        .header(header::VARY, "X-Guest-Grant")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(
            header::CONTENT_SECURITY_POLICY,
            "default-src 'none'; sandbox",
        )
        .header(header::REFERRER_POLICY, "no-referrer");
    if fresh {
        return res
            .status(StatusCode::NOT_MODIFIED)
            .body(Body::empty())
            .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()));
    }
    let kib = u32::try_from((size.max(0) as u64).div_ceil(1024))
        .unwrap_or(u32::MAX)
        .min(SERVE_KIB as u32);
    let serving = tokio::time::timeout(SERVE_WAIT, SERVES.clone().acquire_owned())
        .await
        .ok()
        .and_then(Result::ok)
        .ok_or_else(busy)?;
    let bytes = tokio::time::timeout(SERVE_WAIT, SERVE_BYTES.clone().acquire_many_owned(kib))
        .await
        .ok()
        .and_then(Result::ok)
        .ok_or_else(busy)?;
    let data = blob(db, &cache_key(&source)).await?.ok_or_else(not_found)?;
    let len = data.len();
    // The permits stay held until the body is sent or dropped.
    let held = (serving, bytes);
    let chunks = axum::body::Bytes::from(data);
    let body = futures_util::stream::iter((0..len).step_by(SERVE_CHUNK).map(move |at| {
        let _ = &held;
        Ok::<_, std::convert::Infallible>(chunks.slice(at..len.min(at + SERVE_CHUNK)))
    }));
    res.header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_LENGTH, len)
        .body(Body::from_stream(body))
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

/// The size of the pieces a preview image is sent in.
const SERVE_CHUNK: usize = 64 * 1024;

/// Get a link preview's image
///
/// Serves the image of one link preview, as `Embed.image_url` names it. The instance fetches
/// the image from the linked page's host (public addresses only, at most 5 MiB, PNG, JPEG, GIF
/// or WebP recognized from its bytes, at most 8192 pixels a side) and keeps a copy for a week,
/// so viewers never contact that host. `Content-Type` comes from the bytes, with
/// `X-Content-Type-Options: nosniff` and a sandboxing `Content-Security-Policy`. The `v` query
/// parameter only versions the address and is ignored.
///
/// Visible to anyone who can read the message (same checks as listing messages: the bearer
/// token or the `rchat_token` cookie, or `X-Guest-Grant` for guests), while link previews are
/// on and the preview and its image are not removed. A preview whose link is only inside a
/// spoiler has no image. General rate-limit bucket, and at most 120 image requests per minute
/// per client address (an IPv6 /64 as one). The instance fetches only a few images at once; an
/// image it could not fetch in time answers 404 and is tried again on a later view.
#[utoipa::path(get, path = "/api/v1/messages/{id}/embeds/{ord}/image", tag = "Messages", params(("id" = i64, Path, description = "Message id"), ("ord" = i64, Path, description = "Position of the preview in the message's `embeds` (its `ord`)"), ("X-Guest-Grant" = Option<String>, Header, description = "Guest grants from `POST /api/v1/servers/{name}/guest_access`, comma-separated, up to 100. Only read for guests viewing a password-protected server")), responses((status = 200, description = "Image bytes. Carries an `ETag`, `Cache-Control: private, max-age=86400` and `Vary: X-Guest-Grant`"), (status = 304, description = "`If-None-Match` matched the image's ETag and you may see it"), (status = 400, description = "Non-numeric id or ord (plain-text framework error)", content_type = "text/plain", body = String), (status = 401, description = "Guest access is disabled and no valid token was sent", body = ApiErrorBody), (status = 404, description = "`Image not found`: link previews are off, no such message or you cannot read it, no such preview, the preview or its image was removed, it has no image, or the image could not be fetched or is not an accepted image; identical responses", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket (plain text), or too many image requests from this address (JSON `Too many attempts. Try again later`)", content((ApiErrorBody = "application/json"), (String = "text/plain"))), (status = 503, description = "`Too many preview images right now, try again in a moment`: the instance holds as many preview images in memory as it allows", body = ApiErrorBody)), security((), ("bearer" = [])))]
pub(crate) async fn preview_image(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, ord)): Path<(i64, i64)>,
) -> Result<Response, ApiError> {
    serve(&state, &headers, id, ord, &preview_policy()).await
}

/// A local stand-in for a remote host: answers every connection with `reply` and counts them.
#[cfg(test)]
pub(crate) mod fake {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use crate::net_guard::{AllowedHost, Http, Policy};

    pub(crate) struct Upstream {
        pub port: u16,
        hits: Arc<AtomicUsize>,
    }

    impl Upstream {
        pub(crate) fn hits(&self) -> usize {
            self.hits.load(Ordering::SeqCst)
        }

        /// A policy that lets only this upstream through, as an operator allowlist would.
        pub(crate) fn policy(&self) -> Policy {
            Policy {
                http: Http::Always,
                web_ports_only: false,
                allowed: vec![
                    AllowedHost::parse(&format!("127.0.0.1:{}", self.port)).expect("host"),
                ],
                own: Vec::new(),
                own_hosts: Vec::new(),
            }
        }

        pub(crate) fn url(&self, path: &str) -> String {
            format!("http://127.0.0.1:{}{path}", self.port)
        }
    }

    pub(crate) fn response(status: &str, headers: &[(&str, String)], body: &[u8]) -> Vec<u8> {
        let mut out = format!("HTTP/1.1 {status}\r\nconnection: close\r\n");
        for (k, v) in headers {
            out.push_str(&format!("{k}: {v}\r\n"));
        }
        out.push_str("\r\n");
        let mut out = out.into_bytes();
        out.extend_from_slice(body);
        out
    }

    pub(crate) async fn upstream(reply: Vec<u8>) -> Upstream {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let hits = Arc::new(AtomicUsize::new(0));
        let counted = hits.clone();
        let reply = Arc::new(reply);
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                counted.fetch_add(1, Ordering::SeqCst);
                let reply = reply.clone();
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 4096];
                    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        match sock.read(&mut chunk).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => buf.extend_from_slice(&chunk[..n]),
                        }
                    }
                    let _ = sock.write_all(&reply).await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        Upstream { port, hits }
    }

    /// The first bytes of a PNG of `w` by `h` pixels.
    pub(crate) fn png(w: u32, h: u32) -> Vec<u8> {
        let mut out = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
        out.extend_from_slice(&w.to_be_bytes());
        out.extend_from_slice(&h.to_be_bytes());
        out.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::fake::{png, response, upstream};
    use super::*;
    use crate::api::test_util::{done, temp_state};

    #[test]
    fn only_raster_headers_within_the_caps_are_accepted() {
        assert_eq!(sniff(&png(640, 480)), Some(("image/png", 640, 480)));
        assert_eq!(
            sniff(&gif(800, 600, 800, 600)),
            Some(("image/gif", 800, 600))
        );
        let jpeg = [
            0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01,
            0xe0, 0x02, 0x80,
        ];
        assert_eq!(sniff(&jpeg), Some(("image/jpeg", 640, 480)));
        let mut webp = b"RIFF\0\0\0\0WEBPVP8X\x0a\0\0\0\0\0\0\0".to_vec();
        webp.extend_from_slice(&[0x7f, 0x02, 0x00, 0xdf, 0x01, 0x00]);
        assert_eq!(sniff(&webp), Some(("image/webp", 640, 480)));
        assert_eq!(sniff(b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>"), None);
        assert_eq!(sniff(b"<?xml version=\"1.0\"?><svg/>"), None);
        assert_eq!(sniff(b"\0\0\0\x1cftypavif"), None);
        assert_eq!(acceptable(&png(640, 480)), Some("image/png"));
        assert_eq!(acceptable(&png(8193, 10)), None);
        assert_eq!(acceptable(&png(6000, 6000)), None);
        assert_eq!(acceptable(&png(0, 10)), None);
    }

    /// A GIF with a `w` by `h` screen, a global color table, a graphic control extension and
    /// a first frame of `fw` by `fh` at 0,0.
    fn gif(w: u16, h: u16, fw: u16, fh: u16) -> Vec<u8> {
        let mut out = b"GIF89a".to_vec();
        out.extend_from_slice(&w.to_le_bytes());
        out.extend_from_slice(&h.to_le_bytes());
        out.extend_from_slice(&[0x81, 0, 0]);
        out.extend_from_slice(&[0; 12]);
        out.extend_from_slice(&[0x21, 0xf9, 4, 0, 0, 0, 0, 0]);
        out.extend_from_slice(&[0x2c, 0, 0, 0, 0]);
        out.extend_from_slice(&fw.to_le_bytes());
        out.extend_from_slice(&fh.to_le_bytes());
        out.extend_from_slice(&[0, 2, 1, 0, 0, 0x3b]);
        out
    }

    #[test]
    fn a_gif_frame_larger_than_its_screen_counts() {
        assert_eq!(acceptable(&gif(1, 1, 1, 1)), Some("image/gif"));
        assert_eq!(sniff(&gif(1, 1, 640, 480)), Some(("image/gif", 640, 480)));
        assert_eq!(acceptable(&gif(1, 1, 65535, 65535)), None);
        assert_eq!(acceptable(&gif(1, 1, 9000, 1)), None);
        let mut moved = gif(10, 10, 10, 10);
        moved[34..36].copy_from_slice(&65530u16.to_le_bytes());
        assert_eq!(acceptable(&moved), None, "a frame placed far outside");
        assert_eq!(
            sniff(&gif(10, 10, 10, 10)[..20]),
            None,
            "no image descriptor"
        );
    }

    #[tokio::test]
    async fn fetches_are_capped_for_the_whole_process() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let (state, path) = temp_state("preview_fetch_cap").await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let open = Arc::new(AtomicUsize::new(0));
        let most = Arc::new(AtomicUsize::new(0));
        let hits = Arc::new(AtomicUsize::new(0));
        let reply = response("200 OK", &[], &png(4, 4));
        {
            let (open, most, hits) = (open.clone(), most.clone(), hits.clone());
            tokio::spawn(async move {
                while let Ok((mut sock, _)) = listener.accept().await {
                    let (open, most, hits, reply) =
                        (open.clone(), most.clone(), hits.clone(), reply.clone());
                    tokio::spawn(async move {
                        let now = open.fetch_add(1, Ordering::SeqCst) + 1;
                        most.fetch_max(now, Ordering::SeqCst);
                        hits.fetch_add(1, Ordering::SeqCst);
                        let mut buf = [0u8; 4096];
                        let _ = sock.read(&mut buf).await;
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        open.fetch_sub(1, Ordering::SeqCst);
                        let _ = sock.write_all(&reply).await;
                        let _ = sock.shutdown().await;
                    });
                }
            });
        }
        let policy = Policy {
            http: crate::net_guard::Http::Always,
            web_ports_only: false,
            allowed: vec![
                crate::net_guard::AllowedHost::parse(&format!("127.0.0.1:{port}")).expect("host"),
            ],
            own: Vec::new(),
            own_hosts: Vec::new(),
        };
        let views = (0..50).map(|n| {
            let (db, policy) = (state.db.clone(), policy.clone());
            tokio::spawn(async move {
                image(&db, &format!("http://127.0.0.1:{port}/{n}.png"), &policy)
                    .await
                    .expect("image")
            })
        });
        let shown = futures_util::future::join_all(views).await;
        assert!(hits.load(Ordering::SeqCst) > 0);
        assert!(
            most.load(Ordering::SeqCst) <= FETCHES_MAX,
            "{} upstream connections at once",
            most.load(Ordering::SeqCst)
        );
        assert!(shown.into_iter().any(|r| r.expect("task").is_some()));
        done(state, path).await;
    }

    #[tokio::test]
    async fn image_requests_are_limited_per_address() {
        let (state, path) = temp_state("preview_image_rate").await;
        let status = |r: Result<Response, ApiError>| match r {
            Ok(res) => res.status(),
            Err(ApiError(code, _)) => code,
        };
        let ask = |ip: &str| {
            let (state, ip) = (state.clone(), ip.parse().expect("ip"));
            async move {
                crate::api::budget::as_client(
                    ip,
                    serve(&state, &HeaderMap::new(), 999, 0, &Policy::previews()),
                )
                .await
            }
        };
        for _ in 0..REQUESTS_PER_MINUTE {
            assert_eq!(status(ask("2001:db8:5::1").await), StatusCode::NOT_FOUND);
        }
        assert_eq!(
            status(ask("2001:db8:5::2").await),
            StatusCode::TOO_MANY_REQUESTS,
            "the same /64"
        );
        assert_eq!(status(ask("2001:db8:6::1").await), StatusCode::NOT_FOUND);
        done(state, path).await;
    }

    #[tokio::test]
    async fn private_and_local_targets_are_refused_without_a_request() {
        let policy = Policy::previews();
        for url in [
            "http://127.0.0.1/x.png",
            "https://10.0.0.1/x.png",
            "http://192.168.0.1/cgi-bin/x",
            "http://169.254.169.254/latest/meta-data",
            "http://[::1]/x.png",
            "http://[::ffff:127.0.0.1]/x.png",
            "http://localhost/x.png",
            "https://93.184.216.34:8443/x.png",
            "ftp://93.184.216.34/x.png",
        ] {
            let started = std::time::Instant::now();
            assert!(
                fetch_image(&Url::parse(url).expect("url"), &policy)
                    .await
                    .is_err(),
                "{url}"
            );
            assert!(started.elapsed() < Duration::from_secs(3), "{url}");
        }
        let inner = upstream(response("200 OK", &[], &png(1, 1))).await;
        let outer = upstream(response(
            "302 Found",
            &[("location", inner.url("/x.png"))],
            b"",
        ))
        .await;
        assert!(
            fetch_image(&Url::parse(&outer.url("/r")).expect("url"), &outer.policy())
                .await
                .is_err(),
            "a redirect into an address that is not allowed is refused"
        );
        assert_eq!(outer.hits(), 1);
        assert_eq!(inner.hits(), 0, "the refused hop is never contacted");
        assert_eq!(
            attempts(&Url::parse("http://a.example/x").expect("url")).len(),
            2
        );
        assert_eq!(
            attempts(&Url::parse("http://a.example/x").expect("url"))[0].scheme(),
            "https"
        );
        assert_eq!(
            attempts(&Url::parse("http://a.example:81/x").expect("url")).len(),
            1
        );
    }

    #[tokio::test]
    async fn oversize_and_wrong_types_are_refused() {
        let fetch = |up: super::fake::Upstream| async move {
            fetch_image(&Url::parse(&up.url("/i")).expect("url"), &up.policy()).await
        };
        let declared = upstream(response(
            "200 OK",
            &[("content-length", (IMAGE_MAX + 1).to_string())],
            &png(10, 10),
        ))
        .await;
        assert!(fetch(declared).await.is_err(), "declared too large");
        let mut big = png(10, 10);
        big.resize(IMAGE_MAX + 10, 0);
        let streamed = upstream(response("200 OK", &[], &big)).await;
        assert!(fetch(streamed).await.is_err(), "streamed past the cap");
        let svg = upstream(response(
            "200 OK",
            &[("content-type", "image/svg+xml".to_string())],
            b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
        ))
        .await;
        assert!(fetch(svg).await.is_err(), "svg");
        let html = upstream(response(
            "200 OK",
            &[("content-type", "text/html".to_string())],
            &png(10, 10),
        ))
        .await;
        assert!(fetch(html).await.is_err(), "declared as html");
        let huge = upstream(response("200 OK", &[], &png(20_000, 20_000))).await;
        assert!(fetch(huge).await.is_err(), "too many pixels");
        let fine = upstream(response(
            "200 OK",
            &[("content-type", "image/jpeg".to_string())],
            &png(10, 10),
        ))
        .await;
        let (mime, data) = fetch(fine).await.expect("png");
        assert_eq!(mime, "image/png", "the type comes from the bytes");
        assert_eq!(data, png(10, 10));
    }

    #[tokio::test]
    async fn the_cache_stays_within_its_bounds() {
        let (state, path) = temp_state("preview_cache_trim").await;
        let db = &state.db;
        for n in 0..10 {
            sqlx::query("INSERT INTO preview_images(key, mime, data, size, fetched_at) VALUES($1, 'image/png', $2, 100, $3)")
                .bind(format!("k{n}"))
                .bind(vec![0u8; 100])
                .bind(n)
                .execute(db)
                .await
                .expect("row");
        }
        trim_to(db, 450, 100).await.expect("trim");
        let left: Vec<String> = sqlx::query("SELECT key FROM preview_images ORDER BY key")
            .fetch_all(db)
            .await
            .expect("rows")
            .iter()
            .map(|r| r.try_get(0).expect("key"))
            .collect();
        assert!(left.len() <= 4, "{left:?}");
        assert!(left.contains(&"k9".to_string()), "the newest stay");
        done(state, path).await;
    }

    async fn token(db: &Db, user: &str) -> String {
        crate::db::NewUser::plain(user).add(db).await;
        let token = format!("tok-{user}");
        sqlx::query("INSERT INTO tokens(token, username, created_at) VALUES($1, $2, 0)")
            .bind(crate::db::secret_key(&token))
            .bind(user)
            .execute(db)
            .await
            .expect("token");
        token
    }

    fn bearer(token: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(
            header::AUTHORIZATION,
            format!("Bearer {token}").parse().expect("header"),
        );
        h
    }

    #[tokio::test]
    async fn only_readers_of_the_message_get_its_preview_image() {
        let (state, path) = temp_state("preview_image_access").await;
        let db = &state.db;
        let alice = token(db, "alice").await;
        let _bob = token(db, "bob").await;
        let carol = token(db, "carol").await;
        let dm: i64 =
            sqlx::query("INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id")
                .fetch_one(db)
                .await
                .expect("dm")
                .try_get(0)
                .expect("id");
        let up = upstream(response("200 OK", &[], &png(32, 16))).await;
        let image = up.url("/og.png");
        let page = "https://page.example/post";
        let mid: i64 = sqlx::query("INSERT INTO messages(dm_id, author, content, created_at) VALUES($1, 'alice', $2, 1) RETURNING id")
            .bind(dm)
            .bind(format!("see {page} and ||https://hidden.example/||"))
            .fetch_one(db)
            .await
            .expect("msg")
            .try_get(0)
            .expect("id");
        for (url, ord) in [(page, 0), ("https://hidden.example/", 1)] {
            sqlx::query(
                "INSERT INTO embeds(url, title, image_url, fetched_at) VALUES($1, 'T', $2, $3)",
            )
            .bind(url)
            .bind(&image)
            .bind(now())
            .execute(db)
            .await
            .expect("embed");
            sqlx::query("INSERT INTO message_embeds(message_id, ord, url, banner_removed, removed) VALUES($1, $2, $3, 0, 0)")
                .bind(mid)
                .bind(ord)
                .bind(url)
                .execute(db)
                .await
                .expect("message embed");
        }
        let policy = up.policy();
        let status = |r: &Result<Response, ApiError>| match r {
            Ok(res) => res.status(),
            Err(ApiError(code, _)) => *code,
        };
        for headers in [bearer(&carol), HeaderMap::new()] {
            let denied = serve(&state, &headers, mid, 0, &policy).await;
            assert_eq!(status(&denied), StatusCode::NOT_FOUND);
        }
        assert_eq!(
            up.hits(),
            0,
            "nothing is fetched for someone who can't see it"
        );
        let shown = serve(&state, &bearer(&alice), mid, 0, &policy)
            .await
            .expect("image");
        assert_eq!(shown.status(), StatusCode::OK);
        let h = shown.headers();
        assert_eq!(h[header::CONTENT_TYPE], "image/png");
        assert_eq!(h[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(h[header::CACHE_CONTROL], "private, max-age=86400");
        assert_eq!(
            h[header::CONTENT_SECURITY_POLICY],
            "default-src 'none'; sandbox"
        );
        let again = serve(&state, &bearer(&alice), mid, 0, &policy)
            .await
            .expect("cached");
        assert_eq!(again.status(), StatusCode::OK);
        assert_eq!(up.hits(), 1, "the second view comes from the cache");
        let spoilered = serve(&state, &bearer(&alice), mid, 1, &policy).await;
        assert_eq!(status(&spoilered), StatusCode::NOT_FOUND, "spoilered link");
        sqlx::query(
            "UPDATE message_embeds SET banner_removed = 1 WHERE message_id = $1 AND ord = 0",
        )
        .bind(mid)
        .execute(db)
        .await
        .expect("remove banner");
        let removed = serve(&state, &bearer(&alice), mid, 0, &policy).await;
        assert_eq!(status(&removed), StatusCode::NOT_FOUND, "banner removed");
        done(state, path).await;
    }
}
