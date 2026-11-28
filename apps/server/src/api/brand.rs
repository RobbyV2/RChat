use std::collections::BTreeMap;

use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::Row;
use utoipa::ToSchema;

use crate::api::access::not_found;
use crate::api::admin::require_site_admin;
use crate::api::policy::Policy;
use crate::api::{ApiError, ApiErrorBody, Authed, OkResp, ok};
use crate::db::Db;
use crate::state::AppState;
use crate::ws::WsEvent;

/// The control that names the instance.
pub const INSTANCE_NAME: &str = rchat_settings::items::INSTANCE_NAME.key();
/// The control that names the app this instance serves.
pub const APP_NAME: &str = rchat_settings::items::BRAND_APP_NAME.key();
/// The control that holds the app's short name, for home screens.
pub const SHORT_NAME: &str = rchat_settings::items::BRAND_SHORT_NAME.key();
/// The control that holds the text about the app.
pub const ABOUT: &str = rchat_settings::items::BRAND_ABOUT.key();
/// The control that holds the app's links.
pub const LINKS: &str = rchat_settings::items::BRAND_LINKS.key();
/// The control that holds the note under the sign-in form.
pub const LOGIN_NOTE: &str = rchat_settings::items::BRAND_LOGIN_NOTE.key();
/// The control that lists the instances the app suggests.
pub const SUGGESTIONS: &str = rchat_settings::items::INSTANCE_SUGGESTIONS.key();

/// Every brand control, in the order the admin page shows them.
pub const KEYS: [&str; 7] = [
    INSTANCE_NAME,
    APP_NAME,
    SHORT_NAME,
    ABOUT,
    LINKS,
    LOGIN_NOTE,
    SUGGESTIONS,
];

pub const NAME_MAX: usize = rchat_settings::items::INSTANCE_NAME.max();
pub const SHORT_NAME_MAX: usize = rchat_settings::items::BRAND_SHORT_NAME.max();
pub const ABOUT_MAX: usize = rchat_settings::items::BRAND_ABOUT.max();
pub const LOGIN_NOTE_MAX: usize = rchat_settings::items::BRAND_LOGIN_NOTE.max();
pub const LINKS_MAX: usize = 4;
pub const LABEL_MAX: usize = 32;
pub const SUGGESTIONS_MAX: usize = 20;
/// The longest address of a link or a suggested instance, in characters.
pub const URL_MAX: usize = 500;
/// The most bytes one brand image holds.
pub const IMAGE_MAX_BYTES: usize = 1024 * 1024;

/// A link the app shows with its about text and under the sign-in form.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct Link {
    /// 1 to 32 characters.
    #[schema(example = "Help")]
    pub label: String,
    /// An `https` address.
    #[schema(example = "https://help.example.com")]
    pub url: String,
}

/// An instance the app suggests when someone adds one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct Suggestion {
    /// The instance's address: an `http` or `https` origin.
    #[schema(example = "https://chat.example.com")]
    pub url: String,
    /// Up to 32 characters; may be empty.
    #[serde(default)]
    #[schema(example = "Example")]
    pub label: String,
}

/// Whether the instance's suggestions come after the app's own list or replace it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum SuggestionMode {
    #[default]
    Add,
    Replace,
}

/// The instances the app suggests.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct Suggestions {
    /// `add` (after the list the app was built with) or `replace` (instead of it).
    #[serde(default)]
    pub mode: SuggestionMode,
    /// Up to 20 instances.
    #[serde(default)]
    pub list: Vec<Suggestion>,
}

/// A line of text as a brand control stores it: trimmed, `min` to `max` characters, without
/// control characters. With `lines` it may hold line breaks.
pub fn clean_text(raw: &str, min: usize, max: usize, lines: bool) -> Result<String, String> {
    let text = raw.replace("\r\n", "\n");
    let text = text.trim();
    let count = text.chars().count();
    if count < min || count > max {
        return Err(match min {
            0 => format!("expected up to {max} characters"),
            _ => format!("expected {min} to {max} characters"),
        });
    }
    if text
        .chars()
        .any(|c| c.is_control() && !(lines && c == '\n'))
    {
        return Err(match lines {
            true => "expected text without control characters".to_string(),
            false => "expected one line without control characters".to_string(),
        });
    }
    Ok(text.to_string())
}

/// An address as a brand control stores it, when it is one of `schemes` with a host and no
/// sign-in part.
fn clean_url(raw: &str, schemes: &[&str]) -> Option<url::Url> {
    let raw = raw.trim();
    if raw.chars().count() > URL_MAX || raw.chars().any(char::is_control) {
        return None;
    }
    let url = url::Url::parse(raw).ok()?;
    let plain = url.username().is_empty() && url.password().is_none() && url.host_str().is_some();
    (schemes.contains(&url.scheme()) && plain).then_some(url)
}

/// `links` as the control stores them (a JSON array), or what was expected of them.
pub fn clean_links(links: Vec<Link>) -> Result<String, String> {
    let expected = || {
        format!(
            "expected up to {LINKS_MAX} links, each with a label of 1 to {LABEL_MAX} characters and an https address"
        )
    };
    if links.len() > LINKS_MAX {
        return Err(expected());
    }
    let mut kept = Vec::with_capacity(links.len());
    for Link { label, url } in links {
        let label = clean_text(&label, 1, LABEL_MAX, false).map_err(|_| expected())?;
        let url = clean_url(&url, &["https"]).ok_or_else(expected)?;
        kept.push(Link {
            label,
            url: url.to_string(),
        });
    }
    serde_json::to_string(&kept).map_err(|_| expected())
}

/// `suggestions` as the control stores them (a JSON object), or what was expected of them.
/// Each address is kept as its origin, and an origin is listed once.
pub fn clean_suggestions(suggestions: Suggestions) -> Result<String, String> {
    let expected = || {
        format!(
            "expected mode add or replace and up to {SUGGESTIONS_MAX} instances, each with an http or https address and a label of up to {LABEL_MAX} characters"
        )
    };
    let Suggestions { mode, list } = suggestions;
    if list.len() > SUGGESTIONS_MAX {
        return Err(expected());
    }
    let mut kept: Vec<Suggestion> = Vec::with_capacity(list.len());
    for Suggestion { url, label } in list {
        let label = clean_text(&label, 0, LABEL_MAX, false).map_err(|_| expected())?;
        let url = clean_url(&url, &["http", "https"]).ok_or_else(expected)?;
        let origin = url.origin().ascii_serialization();
        if !kept.iter().any(|s| s.url == origin) {
            kept.push(Suggestion { url: origin, label });
        }
    }
    serde_json::to_string(&Suggestions { mode, list: kept }).map_err(|_| expected())
}

/// The stored form of links written as JSON, as the server config writes them.
pub fn parse_links(raw: &str) -> Result<String, String> {
    match raw.trim() {
        "" => clean_links(Vec::new()),
        json => clean_links(
            serde_json::from_str(json)
                .map_err(|_| "expected a JSON list of {label, url}".to_string())?,
        ),
    }
}

/// The stored form of suggestions written as JSON, as the server config writes them.
pub fn parse_suggestions(raw: &str) -> Result<String, String> {
    match raw.trim() {
        "" => clean_suggestions(Suggestions::default()),
        json => clean_suggestions(
            serde_json::from_str(json)
                .map_err(|_| "expected JSON {mode, list: [{url, label}]}".to_string())?,
        ),
    }
}

/// The brand of the instance and of the app it serves, as stored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stored {
    pub instance_name: String,
    /// Empty: the instance name.
    pub app_name: String,
    /// Empty: the app name.
    pub short_name: String,
    pub about: String,
    pub links: Vec<Link>,
    pub login_note: String,
    pub suggestions: Suggestions,
    /// The version of each uploaded image, by kind.
    pub assets: BTreeMap<String, String>,
}

impl Default for Stored {
    fn default() -> Stored {
        Stored {
            instance_name: crate::instance::DEFAULT_NAME.to_string(),
            app_name: String::new(),
            short_name: String::new(),
            about: String::new(),
            links: Vec::new(),
            login_note: String::new(),
            suggestions: Suggestions::default(),
            assets: BTreeMap::new(),
        }
    }
}

impl Stored {
    /// The brand from the `settings` rows `rows` and the image versions `assets`. A value that
    /// can't be read counts as unset.
    pub(crate) fn of(
        rows: &std::collections::HashMap<String, String>,
        assets: BTreeMap<String, String>,
    ) -> Stored {
        let text = |key: &str| rows.get(key).cloned().unwrap_or_default();
        let instance_name = match text(INSTANCE_NAME) {
            name if name.trim().is_empty() => crate::instance::DEFAULT_NAME.to_string(),
            name => name,
        };
        Stored {
            instance_name,
            app_name: text(APP_NAME),
            short_name: text(SHORT_NAME),
            about: text(ABOUT),
            links: rows
                .get(LINKS)
                .and_then(|json| serde_json::from_str(json).ok())
                .unwrap_or_default(),
            login_note: text(LOGIN_NOTE),
            suggestions: rows
                .get(SUGGESTIONS)
                .and_then(|json| serde_json::from_str(json).ok())
                .unwrap_or_default(),
            assets,
        }
    }

    /// The name of the app: its own, or the instance's.
    pub fn app(&self) -> &str {
        match self.app_name.is_empty() {
            true => &self.instance_name,
            false => &self.app_name,
        }
    }

    /// The app's short name: its own, or the first 16 characters of the app name.
    pub fn short(&self) -> String {
        match self.short_name.is_empty() {
            true => self.app().chars().take(SHORT_NAME_MAX).collect(),
            false => self.short_name.clone(),
        }
    }

    /// The path of the image `kind` with its version, when one is uploaded.
    pub fn asset(&self, kind: Asset) -> Option<String> {
        self.assets
            .get(kind.as_str())
            .map(|etag| format!("/brand/{}.png?v={etag}", kind.as_str()))
    }

    /// Whether anything differs from an instance that set no brand.
    pub fn is_set(&self) -> bool {
        *self != Stored::default()
    }

    pub fn view(&self) -> Brand {
        Brand {
            instance_name: self.instance_name.clone(),
            app_name: self.app().to_string(),
            short_name: self.short(),
            about: self.about.clone(),
            links: self.links.clone(),
            login_note: self.login_note.clone(),
            suggestions: self.suggestions.clone(),
            assets: Asset::ALL
                .into_iter()
                .filter_map(|kind| Some((kind.as_str().to_string(), self.asset(kind)?)))
                .collect(),
        }
    }
}

/// The brand of this instance and of the app it serves.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct Brand {
    /// The instance's name, as in `GET /api/v1/instance`.
    #[schema(example = "Example Chat")]
    pub instance_name: String,
    /// The name of the app this instance serves: its own, or the instance's name.
    #[schema(example = "Example Chat")]
    pub app_name: String,
    /// Up to 16 characters, for home screens.
    #[schema(example = "Example")]
    pub short_name: String,
    /// Plain text about the app, up to 1,000 characters; empty when unset.
    pub about: String,
    /// Up to 4 links.
    pub links: Vec<Link>,
    /// Plain text to show under the sign-in form, up to 300 characters; empty when unset.
    pub login_note: String,
    /// The instances the app suggests when someone adds one.
    pub suggestions: Suggestions,
    /// The uploaded images by kind (`logo`, `mark-32`, `mark-180`, `mark-192`, `mark-512`,
    /// `mark-maskable`), each as a path on this instance with its version. A kind that is
    /// missing has no image: the app shows its own.
    #[schema(example = json!({"logo": "/brand/logo.png?v=3f2a9c1e5b7d0a46"}))]
    pub assets: BTreeMap<String, String>,
}

/// A brand image: the logo, or the mark at one of the sizes the app needs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Asset {
    Logo,
    Mark32,
    Mark180,
    Mark192,
    Mark512,
    MarkMaskable,
}

impl Asset {
    pub const ALL: [Asset; 6] = [
        Asset::Logo,
        Asset::Mark32,
        Asset::Mark180,
        Asset::Mark192,
        Asset::Mark512,
        Asset::MarkMaskable,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Asset::Logo => "logo",
            Asset::Mark32 => "mark-32",
            Asset::Mark180 => "mark-180",
            Asset::Mark192 => "mark-192",
            Asset::Mark512 => "mark-512",
            Asset::MarkMaskable => "mark-maskable",
        }
    }

    pub fn parse(kind: &str) -> Option<Asset> {
        Asset::ALL.into_iter().find(|a| a.as_str() == kind)
    }

    /// Whether a PNG of `width` by `height` pixels is this image: the logo is up to 2048 by
    /// 1024, a mark is a square of exactly its size (512 for the maskable one).
    pub fn fits(self, width: u32, height: u32) -> bool {
        let square = |side: u32| width == side && height == side;
        match self {
            Asset::Logo => (1..=2048).contains(&width) && (1..=1024).contains(&height),
            Asset::Mark32 => square(32),
            Asset::Mark180 => square(180),
            Asset::Mark192 => square(192),
            Asset::Mark512 | Asset::MarkMaskable => square(512),
        }
    }

    /// The size a PNG of this kind must have, for an error.
    fn size(self) -> &'static str {
        match self {
            Asset::Logo => "up to 2048 by 1024 pixels",
            Asset::Mark32 => "32 by 32 pixels",
            Asset::Mark180 => "180 by 180 pixels",
            Asset::Mark192 => "192 by 192 pixels",
            Asset::Mark512 | Asset::MarkMaskable => "512 by 512 pixels",
        }
    }
}

const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

/// The width and height of a PNG from its first chunk; `None` when `bytes` do not start as a
/// PNG does (the signature, then an `IHDR` chunk of 13 bytes).
pub fn png_size(bytes: &[u8]) -> Option<(u32, u32)> {
    let rest = bytes.strip_prefix(&PNG_SIGNATURE)?;
    let (head, rest) = rest.split_at_checked(8)?;
    if head != [0, 0, 0, 13, b'I', b'H', b'D', b'R'] {
        return None;
    }
    let width = u32::from_be_bytes(rest.get(0..4)?.try_into().ok()?);
    let height = u32::from_be_bytes(rest.get(4..8)?.try_into().ok()?);
    Some((width, height))
}

/// Refuses `bytes` unless they are a PNG that fits `kind`, within `IMAGE_MAX_BYTES`.
pub fn check_image(kind: Asset, bytes: &[u8]) -> Result<(), ApiError> {
    if bytes.len() > IMAGE_MAX_BYTES {
        return Err(ApiError::limit(
            StatusCode::PAYLOAD_TOO_LARGE,
            "The image is over 1 MiB",
            "brand_image_bytes",
        ));
    }
    let Some((width, height)) = png_size(bytes) else {
        return Err(ApiError::invalid("The image must be a PNG", "image"));
    };
    match kind.fits(width, height) {
        true => Ok(()),
        false => Err(ApiError::invalid(
            format!("The image must be {}", kind.size()),
            "image",
        )),
    }
}

/// The version of an image: the first 16 hex characters of its SHA-256.
pub fn etag_of(bytes: &[u8]) -> String {
    hex::encode(&Sha256::digest(bytes)[..8])
}

/// The versions of the uploaded images, by kind.
pub(crate) async fn asset_versions(db: &Db) -> sqlx::Result<BTreeMap<String, String>> {
    let mut found = BTreeMap::new();
    for row in sqlx::query("SELECT kind, etag FROM brand_assets")
        .fetch_all(db)
        .await?
    {
        let kind: String = row.try_get(0)?;
        if Asset::parse(&kind).is_some() {
            found.insert(kind, row.try_get(1)?);
        }
    }
    Ok(found)
}

/// Tells every client the brand as it is now, read again.
pub(crate) async fn announce(state: &AppState) -> Brand {
    let brand = Policy::load(&state.db).await.brand.view();
    state.hub.broadcast(WsEvent::BrandChanged {
        brand: brand.clone(),
    });
    brand
}

/// Get the brand
///
/// The names, texts, links, suggested instances and images that this instance sets for itself
/// and for the app it serves. Clients show them in place of their own. Changes also arrive as
/// the `brand_changed` WebSocket event. No authentication. Values may lag a change by up to 5
/// seconds per server process. General rate-limit bucket.
#[utoipa::path(get, path = "/api/v1/brand", tag = "Instance", responses((status = 200, description = "The instance's name, the app's name and short name, the about text, links, the sign-in note, the suggested instances and the paths of the uploaded images", body = Brand), (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)), security(()))]
pub(crate) async fn get_brand(State(state): State<AppState>) -> Json<Brand> {
    Json(Policy::cached(&state.read()).await.brand.view())
}

fn asset_of(kind: &str) -> Result<Asset, ApiError> {
    Asset::parse(kind).ok_or_else(not_found)
}

/// Upload a brand image
///
/// Stores the PNG in the body as the image `kind` (`logo`, `mark-32`, `mark-180`, `mark-192`,
/// `mark-512` or `mark-maskable`), replacing the one before. The logo is up to 2048 by 1024
/// pixels; a mark is a square of exactly its size (512 for the maskable one). At most 1 MiB.
/// Anything that is not a PNG of that size is refused with 400. Strict rate-limit bucket.
#[utoipa::path(put, path = "/api/v1/admin/brand/{kind}", tag = "Admin", operation_id = "admin_put_brand_asset", params(("kind" = String, Path, description = "`logo`, `mark-32`, `mark-180`, `mark-192`, `mark-512` or `mark-maskable`")), request_body(content = String, content_type = "image/png", description = "The PNG file"), responses((status = 200, description = "The branding after the change", body = Brand), (status = 400, description = "Not a PNG of the size the kind takes, or over 1 MiB", body = crate::api::ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = crate::api::ApiErrorBody), (status = 404, description = "`Not found`: the caller is not a site administrator, or an unknown `kind`", body = crate::api::ApiErrorBody), (status = 429, description = "Too many requests in the strict bucket", body = crate::api::ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn put_asset(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(kind): Path<String>,
    body: Bytes,
) -> Result<Json<Brand>, ApiError> {
    require_site_admin(&user)?;
    let kind = asset_of(&kind)?;
    check_image(kind, &body)?;
    let etag = etag_of(&body);
    let t = state.clock.unix();
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "INSERT INTO brand_assets(kind, bytes, etag, updated_at) VALUES($1, $2, $3, $4) ON CONFLICT(kind) DO UPDATE SET bytes = excluded.bytes, etag = excluded.etag, updated_at = excluded.updated_at",
    )
    .bind(kind.as_str())
    .bind(body.to_vec())
    .bind(&etag)
    .bind(t)
    .execute(&mut *tx)
    .await?;
    crate::api::instance_audit::record_in(
        &mut tx,
        &user.username,
        "branding.change",
        Some(kind.as_str()),
        serde_json::json!({ "key": kind.as_str() }),
        t,
    )
    .await?;
    tx.commit().await?;
    Ok(Json(announce(&state).await))
}

/// Remove a brand image
///
/// Removes the image `kind`, so the app shows its own again. Removing one that is not there
/// changes nothing.
#[utoipa::path(delete, path = "/api/v1/admin/brand/{kind}", tag = "Admin", operation_id = "admin_delete_brand_asset", params(("kind" = String, Path, description = "`logo`, `mark-32`, `mark-180`, `mark-192`, `mark-512` or `mark-maskable`")), responses((status = 200, description = "The image is gone", body = OkResp), (status = 401, description = "Missing or unknown bearer token", body = crate::api::ApiErrorBody), (status = 404, description = "`Not found`: the caller is not a site administrator, or an unknown `kind`", body = crate::api::ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", body = crate::api::ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn delete_asset(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(kind): Path<String>,
) -> Result<Json<OkResp>, ApiError> {
    require_site_admin(&user)?;
    let kind = asset_of(&kind)?;
    let t = state.clock.unix();
    let mut tx = state.db.begin().await?;
    let removed = sqlx::query("DELETE FROM brand_assets WHERE kind = $1")
        .bind(kind.as_str())
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if removed > 0 {
        crate::api::instance_audit::record_in(
            &mut tx,
            &user.username,
            "branding.change",
            Some(kind.as_str()),
            serde_json::json!({ "key": kind.as_str() }),
            t,
        )
        .await?;
    }
    tx.commit().await?;
    if removed > 0 {
        announce(&state).await;
    }
    Ok(ok())
}

/// The query of a brand image request.
#[derive(Deserialize)]
pub struct AssetQuery {
    /// The version the client read in `GET /api/v1/brand`.
    v: Option<String>,
}

/// The headers of every brand image answer: a PNG that nothing may read as anything else and
/// that other sites may show.
fn image_headers(headers: &mut HeaderMap) {
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("image/png"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        HeaderName::from_static("cross-origin-resource-policy"),
        HeaderValue::from_static("cross-origin"),
    );
}

/// The stored image `kind` as (bytes, version).
pub(crate) async fn stored_asset(db: &Db, kind: Asset) -> sqlx::Result<Option<(Vec<u8>, String)>> {
    sqlx::query("SELECT bytes, etag FROM brand_assets WHERE kind = $1")
        .bind(kind.as_str())
        .fetch_optional(db)
        .await?
        .map(|row| Ok((row.try_get(0)?, row.try_get(1)?)))
        .transpose()
}

/// The answer that serves the image `bytes` at version `etag` to a request that asked for the
/// version `asked`: cached for a year when the versions match, checked again each time
/// otherwise.
pub(crate) fn image_response(bytes: Vec<u8>, etag: &str, asked: Option<&str>) -> Response {
    let mut res = bytes.into_response();
    let headers = res.headers_mut();
    image_headers(headers);
    let cache = match asked == Some(etag) {
        true => "public, max-age=31536000, immutable",
        false => "no-cache",
    };
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    if let Ok(value) = HeaderValue::from_str(&format!("\"{etag}\"")) {
        headers.insert(header::ETAG, value);
    }
    res
}

/// Get a brand image
///
/// The uploaded image `{kind}.png` (`logo`, `mark-32`, `mark-180`, `mark-192`, `mark-512` or
/// `mark-maskable`), always as `image/png` with `X-Content-Type-Options: nosniff`. With the
/// version `v` that `GET /api/v1/brand` gives, it is cached for a year; a new upload has a new
/// version. No authentication. General rate-limit bucket.
#[utoipa::path(get, path = "/brand/{file}", tag = "Instance", params(("file" = String, Path, description = "The image kind with `.png`, for example `logo.png`"), ("v" = Option<String>, Query, description = "The version from `GET /api/v1/brand`")), responses((status = 200, description = "The PNG", content_type = "image/png", body = Vec<u8>), (status = 404, description = "`Not found`: no such kind, or no image uploaded for it", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)), security(()))]
pub(crate) async fn get_asset(
    State(state): State<AppState>,
    Path(file): Path<String>,
    Query(query): Query<AssetQuery>,
) -> Result<Response, ApiError> {
    let kind = file
        .strip_suffix(".png")
        .and_then(Asset::parse)
        .ok_or_else(not_found)?;
    let Some((bytes, etag)) = stored_asset(&state.read(), kind).await? else {
        return Err(not_found());
    };
    Ok(image_response(bytes, &etag, query.v.as_deref()))
}

/// The brand images, served outside the API paths.
pub fn asset_routes() -> Router<AppState> {
    Router::new().route("/brand/{file}", get(get_asset))
}

#[cfg(test)]
mod tests;
