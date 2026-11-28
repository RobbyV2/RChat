//! Uploaded pictures: an account, a server profile or a server names one by its id, and anyone
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

use crate::api::access::perms::Perm;
use crate::api::access::{Proof, ServerAccess, not_found, resolve_server};
use crate::api::audit;
use crate::api::auth::MeUpdated;
use crate::api::features::Feature;
use crate::api::media::{declared_length, read_raw, reading_slot, reserve};
use crate::api::{ApiError, ApiErrorBody, Authed, ServerSummaryLite, Settings};
use crate::db::{Db, User, now};
use crate::state::AppState;
use crate::ws::WsEvent;

use rchat_avatar::{ANIMATED_SIZES, Animated, Bounds, Crop, Encoded, Mime, Refused, SIZES};

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

fn refused(why: Refused, bounds: &Bounds) -> ApiError {
    let limit = |error: String, control: &str| {
        ApiError::limit(StatusCode::PAYLOAD_TOO_LARGE, error, control)
    };
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
        Refused::Frames => limit(
            format!("The animation has too many frames: up to {}", bounds.frames),
            "avatar_animation_max_frames",
        ),
        Refused::Duration => limit(
            format!(
                "The animation is too long: up to {} seconds",
                bounds.millis / 1000
            ),
            "avatar_animation_max_secs",
        ),
        Refused::AnimationPixels => limit(
            format!(
                "The animation is too large: up to {} megapixels over all its frames",
                bounds.pixels / 1_000_000
            ),
            "avatar_animation_max_megapixels",
        ),
        Refused::AnimationBytes => limit(
            format!(
                "The animation is over {}MB once made smaller: use fewer frames",
                bounds.bytes / (1024 * 1024)
            ),
            "avatar_upload_max_mib",
        ),
    }
}

/// A picture made from an upload, not stored yet: its stills, and its animation when the
/// upload has one and the site keeps animations.
pub(crate) struct Picture {
    still: Encoded,
    animated: Option<Animated>,
}

/// The picture in an upload body of `user`: read within `AVATAR_UPLOAD_MAX_MIB` and the upload
/// buffer, then decoded, cropped and encoded off the request threads. An animated upload keeps
/// its animation while the `animated_profile_pictures` switch is on, within the bounds of
/// `Limits::avatar_animation_bounds`. Refused while the `profile_pictures` switch is off.
pub(crate) async fn uploaded(
    state: &AppState,
    user: &User,
    headers: &HeaderMap,
    crop: CropQuery,
    body: Body,
) -> Result<Picture, ApiError> {
    let settings = Settings::cached(&state.db).await;
    if !settings.on(Feature::ProfilePictures) {
        return Err(turned_off());
    }
    let animations = settings.on(Feature::AnimatedProfilePictures);
    let bounds = state.limits.avatar_animation_bounds();
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
        let still = rchat_avatar::encode(&body.data, crop)?;
        let animated = match animations {
            true => rchat_avatar::animate(&body.data, crop, &bounds)?,
            false => None,
        };
        Ok(Picture { still, animated })
    })
    .await
    .map_err(ApiError::internal)?
    .map_err(|why| refused(why, &bounds))
}

/// The end of the id of a picture that has an animation.
const ANIMATED: &str = "-a";

/// Stores `picture` for `owner`, in `server` or for the account, and gives its new id: 32 hex
/// characters, with `-a` after them when the picture has an animation.
pub(crate) async fn store(
    conn: &mut sqlx::AnyConnection,
    owner: &str,
    server: Option<&str>,
    picture: &Picture,
) -> Result<String, ApiError> {
    let Picture { still, animated } = picture;
    let mut bytes = [0u8; 16];
    rand::rng().fill_bytes(&mut bytes);
    let id = match animated {
        Some(_) => format!("{}{ANIMATED}", hex::encode(bytes)),
        None => hex::encode(bytes),
    };
    let [small, medium, large] = still.files();
    sqlx::query("INSERT INTO avatar_images(id, owner, server, mime, s64, s128, s512, a128, a512, created_at) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)")
        .bind(&id)
        .bind(owner)
        .bind(server)
        .bind(still.mime().as_str())
        .bind(small.clone())
        .bind(medium.clone())
        .bind(large.clone())
        .bind(animated.as_ref().map(|a| a.small().to_vec()))
        .bind(animated.as_ref().and_then(|a| a.large().map(<[u8]>::to_vec)))
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

/// Removes the pictures no account, no server profile and no server names, once they are an
/// hour old.
pub(crate) async fn sweep(db: &Db, at: i64) -> sqlx::Result<u64> {
    Ok(sqlx::query("DELETE FROM avatar_images WHERE created_at < $1 AND NOT EXISTS (SELECT 1 FROM users u WHERE u.avatar_image = avatar_images.id) AND NOT EXISTS (SELECT 1 FROM member_profiles p WHERE p.avatar_image = avatar_images.id) AND NOT EXISTS (SELECT 1 FROM servers s WHERE s.icon_image = avatar_images.id)")
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
    next: Option<&Picture>,
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
/// GIF or WebP file of at most
/// `limits.avatar_upload_bytes` of `GET /api/v1/instance`, by default 8 MiB
/// (`AVATAR_UPLOAD_MAX_MIB`), and at most 40 megapixels. The server turns the image as its
/// EXIF orientation says, keeps the square `x`, `y`, `size` (without them the centered largest
/// square), and stores it at 64, 128 and 512 pixels as PNG when it has transparency and as
/// JPEG otherwise. An animated GIF, WebP or PNG also keeps its animation, as animated GIFs of
/// 128 and 512 pixels, while the `animated_profile_pictures` switch is on: the id then ends in
/// `-a`, and an animation past `AVATAR_ANIMATION_MAX_FRAMES` (250), `AVATAR_ANIMATION_MAX_SECS`
/// (20) or `AVATAR_ANIMATION_MAX_MEGAPIXELS` (400, over all frames) is refused with 413.
/// Nothing else of the file is kept. The picture before is removed. The
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

/// Sets the picture of the server `key` to `next` and removes the one before, in one
/// transaction with its audit line. Gives whether a picture was there before.
async fn replace_icon(
    state: &AppState,
    access: &ServerAccess,
    user: &User,
    next: Option<&Picture>,
) -> Result<bool, ApiError> {
    let key = access.name();
    let actor = access.audit_actor(&state.db, Perm::ManageServer).await?;
    let mut tx = state.db.begin().await?;
    let before: Option<String> = sqlx::query("SELECT icon_image FROM servers WHERE name = $1")
        .bind(key)
        .fetch_optional(&mut *tx)
        .await?
        .map(|r| r.try_get(0))
        .transpose()?
        .flatten();
    let id = match next {
        Some(picture) => Some(store(&mut tx, &user.username, Some(key), picture).await?),
        None => None,
    };
    sqlx::query("UPDATE servers SET icon_image = $1 WHERE name = $2")
        .bind(&id)
        .bind(key)
        .execute(&mut *tx)
        .await?;
    if let Some(old) = &before {
        discard(&mut tx, old).await?;
    }
    if before.is_some() || id.is_some() {
        audit::record(
            &mut tx,
            audit::Entry::new(key, &actor, audit::Action::ServerUpdate)
                .target(audit::Target::server(&access.lite().display_name))
                .details(audit::Details::new().change(
                    "icon_picture",
                    before.is_some(),
                    id.is_some(),
                )),
        )
        .await?;
    }
    tx.commit().await?;
    Ok(before.is_some())
}

/// The server a manager opens to change its picture.
async fn managed(state: &AppState, user: &User, name: &str) -> Result<ServerAccess, ApiError> {
    let access = resolve_server(&state.db, name, Some(user), &Proof::none()).await?;
    access.require_perm(&state.db, Perm::ManageServer).await?;
    Ok(access)
}

/// The server after its picture changed: tells everyone who sees it, and gives the answer.
async fn icon_changed(
    state: &AppState,
    user: &User,
    key: &str,
) -> Result<Json<ServerSummaryLite>, ApiError> {
    let server = resolve_server(&state.db, key, Some(user), &Proof::none())
        .await?
        .lite()
        .clone();
    state.hub.broadcast(WsEvent::ServerUpdated {
        server: server.clone(),
    });
    Ok(Json(server))
}

/// Upload a server picture
///
/// Sets the picture of the server from the image in the request body, under the rules of
/// `PUT /api/v1/me/avatar` (types, `limits.avatar_upload_bytes`, 40 megapixels, the crop `x`,
/// `y`, `size`, the stored sizes). It shows over the server's icon (`icon_kind`), which stays
/// as it is and shows where pictures are not shown. The picture before is removed. Needs the
/// Manage server permission. Logged in the audit log as `server.update`. Emits
/// `server_updated`. Requires the `profile_pictures` switch. Strict rate-limit bucket.
#[utoipa::path(put, path = "/api/v1/servers/{name}/icon", tag = "Servers", params(("name" = String, Path, description = "Server name, case-insensitive"), CropQuery), request_body(content = Vec<u8>, content_type = "application/octet-stream", description = "The image file"), responses((status = 200, description = "The server; `icon_image` is the id of the picture", body = ServerSummaryLite), (status = 400, description = "As `PUT /api/v1/me/avatar`: not an image of a known type, over 40 megapixels, or a crop outside the picture", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 403, description = "Missing the Manage server permission, or `Profile pictures are turned off on this site` (`reason.kind` `off_site`, `reason.control` `profile_pictures`)", body = ApiErrorBody), (status = 404, description = "`Server not found or wrong password`: no such server, or one you have no access to (identical responses)", body = ApiErrorBody), (status = 408, description = "`The upload stopped sending data`", body = ApiErrorBody), (status = 413, description = "`Picture exceeds 8MB limit` with the configured number (`reason.control` `avatar_upload_max_mib`)", body = ApiErrorBody), (status = 429, description = "Too many requests in the strict bucket, or 3 of your uploads are already being read", body = ApiErrorBody), (status = 503, description = "`Too many uploads right now, try again in a moment`", body = ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn put_server_icon(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Query(crop): Query<CropQuery>,
    headers: HeaderMap,
    body: Body,
) -> Result<Json<ServerSummaryLite>, ApiError> {
    let access = managed(&state, &user, &name).await?;
    let picture = uploaded(&state, &user, &headers, crop, body).await?;
    replace_icon(&state, &access, &user, Some(&picture)).await?;
    icon_changed(&state, &user, access.name()).await
}

/// Remove a server picture
///
/// Removes the picture of the server, which shows its icon (`icon_kind`) again. Removing a
/// picture that is not there changes nothing. Needs the Manage server permission. Works while
/// the `profile_pictures` switch is off. Logged in the audit log as `server.update` and emits
/// `server_updated` when a picture was removed. Strict rate-limit bucket.
#[utoipa::path(delete, path = "/api/v1/servers/{name}/icon", tag = "Servers", params(("name" = String, Path, description = "Server name, case-insensitive")), responses((status = 200, description = "The server without a picture", body = ServerSummaryLite), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 403, description = "Missing the Manage server permission", body = ApiErrorBody), (status = 404, description = "`Server not found or wrong password`: no such server, or one you have no access to (identical responses)", body = ApiErrorBody), (status = 429, description = "Too many requests in the strict bucket", body = ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn delete_server_icon(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
) -> Result<Json<ServerSummaryLite>, ApiError> {
    let access = managed(&state, &user, &name).await?;
    match replace_icon(&state, &access, &user, None).await? {
        true => icon_changed(&state, &user, access.name()).await,
        false => Ok(Json(access.lite().clone())),
    }
}

/// The headers of every picture answer: nothing may read it as another type or run it, other
/// origins may show it, and its address serves the same bytes for good.
fn picture_headers(headers: &mut HeaderMap, mime: &'static str, etag: &str) {
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
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

/// Whether `id` has the form of a picture id: 32 hex characters, and `-a` after them for a
/// picture with an animation.
fn well_formed(id: &str) -> bool {
    let hex = id.strip_suffix(ANIMATED).unwrap_or(id);
    hex.len() == 32 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn fresh(headers: &HeaderMap, etag: &str) -> bool {
    headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|t| t.trim() == etag || t.trim() == "*"))
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
#[utoipa::path(get, path = "/api/v1/avatars/{id}/{size}", tag = "Media", params(("id" = String, Path, description = "Picture id: 32 hex characters, with `-a` after them when the picture has an animation"), ("size" = u32, Path, description = "Side in pixels: 64, 128 or 512")), responses((status = 200, description = "The picture", content((Vec<u8> = "image/png"), (Vec<u8> = "image/jpeg"))), (status = 304, description = "`If-None-Match` names this picture"), (status = 404, description = "`Not found`: no such picture or size, or the `profile_pictures` switch is off", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)), security(()))]
pub(crate) async fn get_avatar(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, size)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    let column = column(&size).ok_or_else(not_found)?;
    let db = state.read();
    if !well_formed(&id) || !Settings::cached(&db).await.on(Feature::ProfilePictures) {
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
    let mut res = match fresh(&headers, &etag) {
        true => StatusCode::NOT_MODIFIED.into_response(),
        false => row.try_get::<Vec<u8>, _>(1)?.into_response(),
    };
    picture_headers(res.headers_mut(), mime.as_str(), &etag);
    Ok(res)
}

/// Get an animated picture
///
/// The animation of the picture `id` as an animated GIF of `size` pixels: 128 or 512. Only a
/// picture whose id ends in `-a` has one, and its 512 pixel animation is missing when it would
/// have passed the upload size: ask for 128 then. Cached like the stills. No authentication.
/// 404 while the `profile_pictures` or the `animated_profile_pictures` switch is off. General
/// rate-limit bucket.
#[utoipa::path(get, path = "/api/v1/avatars/{id}/{size}/animated", tag = "Media", params(("id" = String, Path, description = "Picture id ending in `-a`"), ("size" = u32, Path, description = "Side in pixels: 128 or 512")), responses((status = 200, description = "The animation", content_type = "image/gif", body = Vec<u8>), (status = 304, description = "`If-None-Match` names this animation"), (status = 404, description = "`Not found`: no such picture, no animation of that size, or a switch is off", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)), security(()))]
pub(crate) async fn get_animated(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, size)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    let column = ANIMATED_SIZES
        .iter()
        .position(|side| side.to_string() == size)
        .map(|at| ["a128", "a512"][at])
        .ok_or_else(not_found)?;
    let db = state.read();
    let settings = Settings::cached(&db).await;
    let shown = settings.on(Feature::ProfilePictures)
        && settings.on(Feature::AnimatedProfilePictures)
        && well_formed(&id)
        && id.ends_with(ANIMATED);
    if !shown {
        return Err(not_found());
    }
    let etag = format!("\"{id}-{size}-animated\"");
    let mut res = match fresh(&headers, &etag) {
        true => StatusCode::NOT_MODIFIED.into_response(),
        false => sqlx::query(sqlx::AssertSqlSafe(format!(
            "SELECT {column} FROM avatar_images WHERE id = $1"
        )))
        .bind(&id)
        .fetch_optional(&db)
        .await?
        .map(|row| row.try_get::<Option<Vec<u8>>, _>(0))
        .transpose()?
        .flatten()
        .ok_or_else(not_found)?
        .into_response(),
    };
    picture_headers(res.headers_mut(), Animated::MIME, &etag);
    Ok(res)
}
