//! Uploaded profile pictures: an account or a server profile names one by its id, and anyone
//! who was shown that id reads it. An id is random and never reused, so a picture's address
//! never changes what it serves.

use std::sync::{Arc, LazyLock};

use axum::Json;
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use rand::Rng;
use serde::Deserialize;
use sqlx::Row;
use utoipa::IntoParams;

use crate::api::access::not_found;
use crate::api::auth::MeUpdated;
use crate::api::features::Feature;
use crate::api::media::{declared_length, read_raw, reading_slot, reserve};
use crate::api::{ApiError, ApiErrorBody, Authed, Settings};
use crate::db::{Db, User, now};
use crate::state::AppState;

use rchat_avatar::{Crop, Encoded, Mime, Refused, SIZES};

#[cfg(test)]
mod tests;

/// Uploads decoded at once in this process.
const DECODES: usize = 2;
/// Seconds a stored picture that nothing names is kept before the sweep removes it.
const UNUSED_KEEP: i64 = 3600;

/// The columns of `avatar_images` that hold a picture's files, in the order of `SIZES`.
const FILES: [&str; 3] = ["s64", "s128", "s512"];

static DECODING: LazyLock<Arc<tokio::sync::Semaphore>> =
    LazyLock::new(|| Arc::new(tokio::sync::Semaphore::new(DECODES)));

/// The square of the uploaded image to keep. Send all three or none.
#[derive(Deserialize, IntoParams)]
pub struct CropQuery {
    /// Left edge of the square, in pixels of the image as it shows.
    x: Option<u32>,
    /// Top edge of the square.
    y: Option<u32>,
    /// Side of the square, at least 16.
    size: Option<u32>,
}

fn crop_of(query: CropQuery) -> Result<Option<Crop>, ApiError> {
    let CropQuery { x, y, size } = query;
    match (x, y, size) {
        (None, None, None) => Ok(None),
        (Some(x), Some(y), Some(size)) => Ok(Some(Crop { x, y, size })),
        (_, _, _) => Err(ApiError::invalid("Send x, y and size together", "crop")),
    }
}

fn turned_off() -> ApiError {
    ApiError::off_site(
        StatusCode::FORBIDDEN,
        "Profile pictures are turned off on this site",
        Feature::ProfilePictures.key(),
    )
}

fn over(max: usize) -> ApiError {
    ApiError::limit(
        StatusCode::PAYLOAD_TOO_LARGE,
        format!("Picture exceeds {}MB limit", max / (1024 * 1024)),
        "avatar_upload_max_mib",
    )
}

fn over_unsized() -> ApiError {
    ApiError::limit(
        StatusCode::PAYLOAD_TOO_LARGE,
        "Picture exceeds the size limit",
        "avatar_upload_max_mib",
    )
}

fn refused(why: Refused) -> ApiError {
    match why {
        Refused::NotImage => ApiError::invalid(
            "The picture must be a PNG, JPEG, GIF or WebP image",
            "image",
        ),
        Refused::TooLarge => ApiError::invalid(
            "The picture has too many pixels: up to 40 megapixels",
            "image",
        ),
        Refused::Crop => ApiError::invalid(
            "The crop must be a square of at least 16 pixels inside the picture",
            "crop",
        ),
    }
}

/// The picture in an upload body of `user`: read within `AVATAR_UPLOAD_MAX_MIB` and the upload
/// buffer, then decoded, cropped and encoded off the request threads. Refused while the
/// `profile_pictures` switch is off.
pub(crate) async fn uploaded(
    state: &AppState,
    user: &User,
    headers: &HeaderMap,
    crop: CropQuery,
    body: Body,
) -> Result<Encoded, ApiError> {
    if !Settings::cached(&state.db)
        .await
        .on(Feature::ProfilePictures)
    {
        return Err(turned_off());
    }
    let crop = crop_of(crop)?;
    let max = state.limits.avatar_upload_bytes();
    let declared = declared_length(headers);
    if declared.is_some_and(|n| n > max as u64) {
        return Err(over(max));
    }
    let slot = reading_slot(&state.db, &user.username)?;
    let held = reserve(slot, declared, max, true).await?;
    let body = read_raw(body, max, held, over_unsized).await?;
    let permit = DECODING
        .clone()
        .acquire_owned()
        .await
        .map_err(ApiError::internal)?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        rchat_avatar::encode(&body.data, crop)
    })
    .await
    .map_err(ApiError::internal)?
    .map_err(refused)
}

/// Stores `picture` for `owner`, in `server` or for the account, and gives its new id.
pub(crate) async fn store(
    conn: &mut sqlx::AnyConnection,
    owner: &str,
    server: Option<&str>,
    picture: &Encoded,
) -> Result<String, ApiError> {
    let mut bytes = [0u8; 16];
    rand::rng().fill_bytes(&mut bytes);
    let id = hex::encode(bytes);
    let [small, medium, large] = picture.files();
    sqlx::query("INSERT INTO avatar_images(id, owner, server, mime, s64, s128, s512, created_at) VALUES($1, $2, $3, $4, $5, $6, $7, $8)")
        .bind(&id)
        .bind(owner)
        .bind(server)
        .bind(picture.mime().as_str())
        .bind(small.clone())
        .bind(medium.clone())
        .bind(large.clone())
        .bind(now())
        .execute(&mut *conn)
        .await?;
    Ok(id)
}

/// Removes the stored picture `id`.
pub(crate) async fn discard(conn: &mut sqlx::AnyConnection, id: &str) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM avatar_images WHERE id = $1")
        .bind(id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Removes the pictures no account and no server profile names, once they are an hour old.
pub(crate) async fn sweep(db: &Db, at: i64) -> sqlx::Result<u64> {
    Ok(sqlx::query("DELETE FROM avatar_images WHERE created_at < $1 AND NOT EXISTS (SELECT 1 FROM users u WHERE u.avatar_image = avatar_images.id) AND NOT EXISTS (SELECT 1 FROM member_profiles p WHERE p.avatar_image = avatar_images.id)")
        .bind(at - UNUSED_KEEP)
        .execute(db)
        .await?
        .rows_affected())
}

/// Sets the account picture of `username` to `next` and removes the one before, whose id it
/// gives.
async fn replace(
    state: &AppState,
    username: &str,
    next: Option<&Encoded>,
) -> Result<Option<String>, ApiError> {
    let mut tx = state.db.begin().await?;
    let before: Option<String> = sqlx::query("SELECT avatar_image FROM users WHERE username = $1")
        .bind(username)
        .fetch_optional(&mut *tx)
        .await?
        .map(|r| r.try_get(0))
        .transpose()?
        .flatten();
    let id = match next {
        Some(picture) => Some(store(&mut tx, username, None, picture).await?),
        None => None,
    };
    sqlx::query("UPDATE users SET avatar_image = $1 WHERE username = $2")
        .bind(id)
        .bind(username)
        .execute(&mut *tx)
        .await?;
    if let Some(old) = &before {
        discard(&mut tx, old).await?;
    }
    tx.commit().await?;
    Ok(before)
}

/// Upload your profile picture
///
/// Sets the profile picture of the account from the image in the request body: a PNG, JPEG,
/// GIF or WebP file (an animation gives its first frame) of at most
/// `limits.avatar_upload_bytes` of `GET /api/v1/instance`, by default 8 MiB
/// (`AVATAR_UPLOAD_MAX_MIB`), and at most 40 megapixels. The server turns the image as its
/// EXIF orientation says, keeps the square `x`, `y`, `size` (without them the centered largest
/// square), and stores it at 64, 128 and 512 pixels as PNG when it has transparency and as
/// JPEG otherwise. Nothing else of the file is kept. The picture before is removed. The
/// built-in avatar (`avatar_kind`) stays as it is and shows where pictures are not shown.
/// Emits `user_updated` to users who share a server or DM with the user. Requires a bearer
/// token and the `profile_pictures` switch. Strict rate-limit bucket.
#[utoipa::path(put, path = "/api/v1/me/avatar", tag = "Account", params(CropQuery), request_body(content = Vec<u8>, content_type = "application/octet-stream", description = "The image file"), responses((status = 200, description = "The picture is set; `avatar_image` is its id", body = MeUpdated), (status = 400, description = "`The picture must be a PNG, JPEG, GIF or WebP image` or `The picture has too many pixels: up to 40 megapixels` (`reason.field` `image`); `The crop must be a square of at least 16 pixels inside the picture` or `Send x, y and size together` (`reason.field` `crop`)", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 403, description = "`Profile pictures are turned off on this site` (`reason.kind` `off_site`, `reason.control` `profile_pictures`)", body = ApiErrorBody), (status = 408, description = "`The upload stopped sending data`: the body sent nothing for 30 seconds or took over 10 minutes", body = ApiErrorBody), (status = 413, description = "`Picture exceeds 8MB limit` with the configured number, or `Picture exceeds the size limit` for a body that did not declare its length (`reason.kind` `limit`, `reason.control` `avatar_upload_max_mib`)", body = ApiErrorBody), (status = 429, description = "Too many requests in the strict bucket, or 3 of your uploads are already being read (`Too many uploads at once: ...`)", body = ApiErrorBody), (status = 503, description = "`Too many uploads right now, try again in a moment`", body = ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn put_my_avatar(
    State(state): State<AppState>,
    Authed(user): Authed,
    Query(crop): Query<CropQuery>,
    headers: HeaderMap,
    body: Body,
) -> Result<Json<MeUpdated>, ApiError> {
    let picture = uploaded(&state, &user, &headers, crop, body).await?;
    replace(&state, &user.username, Some(&picture)).await?;
    Ok(Json(
        crate::api::auth::profile_changed(&state, &user.username).await?,
    ))
}

/// Remove your profile picture
///
/// Removes the profile picture of the account, which shows its built-in avatar again. Removing
/// a picture that is not there changes nothing. Works while the `profile_pictures` switch is
/// off. Emits `user_updated` to users who share a server or DM with the user when a picture
/// was removed. Requires a bearer token. Strict rate-limit bucket.
#[utoipa::path(delete, path = "/api/v1/me/avatar", tag = "Account", responses((status = 200, description = "The account without a picture", body = MeUpdated), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 429, description = "Too many requests in the strict bucket", body = ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn delete_my_avatar(
    State(state): State<AppState>,
    Authed(user): Authed,
) -> Result<Json<MeUpdated>, ApiError> {
    match replace(&state, &user.username, None).await? {
        Some(_) => Ok(Json(
            crate::api::auth::profile_changed(&state, &user.username).await?,
        )),
        None => Ok(Json(crate::api::auth::me_updated(&state.db, user).await?)),
    }
}

/// The headers of every picture answer: nothing may read it as another type or run it, other
/// origins may show it, and its address serves the same bytes for good.
fn picture_headers(headers: &mut HeaderMap, mime: Mime, etag: &str) {
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(mime.as_str()),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; sandbox"),
    );
    headers.insert(
        HeaderName::from_static("cross-origin-resource-policy"),
        HeaderValue::from_static("cross-origin"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=31536000, immutable"),
    );
    if let Ok(value) = HeaderValue::from_str(etag) {
        headers.insert(header::ETAG, value);
    }
}

fn column(size: &str) -> Option<&'static str> {
    SIZES
        .iter()
        .position(|side| side.to_string() == size)
        .map(|at| FILES[at])
}

/// Get a profile picture
///
/// The profile picture `id` (`avatar_image` of a user or of a server profile) as a square of
/// `size` pixels: 64, 128 or 512. `image/png` or `image/jpeg`, with
/// `X-Content-Type-Options: nosniff`. An id never serves another picture, so the answer is
/// cached for a year (`immutable`); a changed picture has a new id. No authentication: the id
/// is 128 random bits that only people who were shown the user have. 404 while the
/// `profile_pictures` switch is off. General rate-limit bucket.
#[utoipa::path(get, path = "/api/v1/avatars/{id}/{size}", tag = "Media", params(("id" = String, Path, description = "Picture id, 32 hex characters"), ("size" = u32, Path, description = "Side in pixels: 64, 128 or 512")), responses((status = 200, description = "The picture", content((Vec<u8> = "image/png"), (Vec<u8> = "image/jpeg"))), (status = 304, description = "`If-None-Match` names this picture"), (status = 404, description = "`Not found`: no such picture or size, or the `profile_pictures` switch is off", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)), security(()))]
pub(crate) async fn get_avatar(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, size)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    let column = column(&size).ok_or_else(not_found)?;
    let hex = id.len() == 32 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    let db = state.read();
    if !hex || !Settings::cached(&db).await.on(Feature::ProfilePictures) {
        return Err(not_found());
    }
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT mime, {column} FROM avatar_images WHERE id = $1"
    )))
    .bind(&id)
    .fetch_optional(&db)
    .await?
    .ok_or_else(not_found)?;
    let mime = Mime::parse(&row.try_get::<String, _>(0)?).ok_or_else(not_found)?;
    let etag = format!("\"{id}-{size}\"");
    let fresh = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|t| t.trim() == etag || t.trim() == "*"));
    let mut res = match fresh {
        true => StatusCode::NOT_MODIFIED.into_response(),
        false => row.try_get::<Vec<u8>, _>(1)?.into_response(),
    };
    picture_headers(res.headers_mut(), mime, &etag);
    Ok(res)
}
