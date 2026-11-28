//! GIF search through this server: the operator's provider (KLIPY or GIPHY) is asked with the
//! operator's key, and the files of the results are fetched through `GET /api/v1/gifs/file`, so
//! the provider sees this server only, never who searched or who looks.

use std::sync::RwLock;

use axum::Json;
use axum::extract::{Query, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use hmac::{Hmac, KeyInit, Mac};
use rchat_settings::items as st;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use url::Url;
use utoipa::{IntoParams, ToSchema};

use crate::api::features::Feature;
use crate::api::{ApiError, ApiErrorBody, Authed, Settings};
use crate::db::Db;
use crate::net_guard::Policy;
use crate::state::AppState;

/// Results of one page.
const PAGE: usize = 24;
/// Characters of a search.
const QUERY_MAX: usize = 100;
/// Bytes of a provider answer read.
const ANSWER_MAX: usize = 2 * 1024 * 1024;

/// Where searches go.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Provider {
    /// KLIPY's Tenor-compatible API.
    Klipy,
    Giphy,
}

/// How this server asks its provider: set once at start from `GIF_PROVIDER`, `GIF_API_KEY` and
/// `GIF_RATING`.
#[derive(Clone, Debug)]
pub struct GifConfig {
    provider: Provider,
    key: String,
    rating: String,
    base: Url,
    policy: Policy,
}

impl GifConfig {
    /// The config of `provider` with `key`, `rating` one of `g`, `pg`, `pg-13` or `r`.
    pub fn new(provider: Provider, key: String, rating: String) -> GifConfig {
        let base = match provider {
            Provider::Klipy => "https://api.klipy.com",
            Provider::Giphy => "https://api.giphy.com",
        };
        GifConfig {
            provider,
            key,
            rating,
            base: Url::parse(base).expect("provider base"),
            policy: crate::api::embeds::preview_policy(),
        }
    }

    /// The config the settings name, or none without a key.
    pub fn from_env(e: &rchat_settings::Env) -> anyhow::Result<Option<GifConfig>> {
        let provider = match e.choice(&st::GIF_PROVIDER)? {
            "giphy" => Provider::Giphy,
            _ => Provider::Klipy,
        };
        let rating = e.choice(&st::GIF_RATING)?.to_string();
        Ok(e.secret(&st::GIF_API_KEY)?
            .map(|key| GifConfig::new(provider, key, rating)))
    }

    #[cfg(test)]
    pub(crate) fn at(mut self, base: &str, policy: Policy) -> GifConfig {
        self.base = Url::parse(base).expect("base");
        self.policy = policy;
        self
    }
}

static CONFIG: RwLock<Option<GifConfig>> = RwLock::new(None);

/// Sets how this process asks its provider.
pub fn configure(config: Option<GifConfig>) {
    *CONFIG.write().unwrap_or_else(|e| e.into_inner()) = config;
}

fn config() -> Option<GifConfig> {
    CONFIG.read().unwrap_or_else(|e| e.into_inner()).clone()
}

/// One GIF of a search.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct Gif {
    /// The provider's id.
    pub id: String,
    /// What the provider calls it; may be empty.
    pub title: String,
    /// The link to send: the GIF file at the provider. A message holding it shows the GIF.
    pub url: String,
    /// A smaller version for the picker, through `GET /api/v1/gifs/file` on this server.
    pub preview: String,
    /// Pixels across of the preview.
    pub width: u32,
    /// Pixels down of the preview.
    pub height: u32,
}

/// A page of GIFs.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct GifPage {
    /// Up to 24, in the provider's order.
    pub items: Vec<Gif>,
    /// Pass as `next` for the page after this one; `null` on the last page.
    pub next: Option<String>,
}

#[derive(Deserialize, IntoParams)]
pub struct GifSearch {
    /// What to look for, 1 to 100 characters.
    q: String,
    /// The `next` of the page before.
    next: Option<String>,
}

#[derive(Deserialize, IntoParams)]
pub struct GifTrending {
    /// The `next` of the page before.
    next: Option<String>,
}

#[derive(Deserialize, IntoParams)]
pub struct GifFile {
    /// The provider's file address, as a search answer names it.
    u: String,
    /// Its signature, as a search answer names it.
    s: String,
}

fn off() -> ApiError {
    ApiError::off_site(
        StatusCode::NOT_FOUND,
        "GIFs are turned off on this site",
        &st::FEATURE_GIFS,
    )
}

/// The provider config while the switch is on; refused without one.
async fn ready(db: &Db) -> Result<GifConfig, ApiError> {
    if !Settings::cached(db).await.on(Feature::Gifs) {
        return Err(off());
    }
    config().ok_or_else(off)
}

fn sign(pepper: &[u8], url: &str) -> String {
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(pepper).expect("hmac key");
    mac.update(b"gif-file\n");
    mac.update(url.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// The address on this server of the provider's file `url`.
fn file_path(pepper: &[u8], url: &str) -> String {
    let q = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("u", url)
        .append_pair("s", &sign(pepper, url))
        .finish();
    format!("/api/v1/gifs/file?{q}")
}

fn rating_word(provider: Provider, rating: &str) -> &'static str {
    match (provider, rating) {
        (Provider::Klipy, "g") => "high",
        (Provider::Klipy, "pg") => "medium",
        (Provider::Klipy, "r") => "off",
        (Provider::Klipy, _) => "low",
        (Provider::Giphy, "g") => "g",
        (Provider::Giphy, "pg") => "pg",
        (Provider::Giphy, "r") => "r",
        (Provider::Giphy, _) => "pg-13",
    }
}

/// The request for a page: a search for `q`, or what trends. It holds the key and the search, so
/// no error about it is logged with its address.
fn request(config: &GifConfig, q: Option<&str>, next: Option<&str>) -> Result<Url, ApiError> {
    let GifConfig {
        provider,
        key,
        rating,
        base,
        policy: _,
    } = config;
    let path = match (provider, q) {
        (Provider::Klipy, Some(_)) => "/v2/search",
        (Provider::Klipy, None) => "/v2/featured",
        (Provider::Giphy, Some(_)) => "/v1/gifs/search",
        (Provider::Giphy, None) => "/v1/gifs/trending",
    };
    let mut url = base.join(path).map_err(ApiError::internal)?;
    {
        let mut pairs = url.query_pairs_mut();
        let limit = PAGE.to_string();
        match provider {
            Provider::Klipy => {
                pairs
                    .append_pair("key", key)
                    .append_pair("limit", &limit)
                    .append_pair("media_filter", "gif,tinygif")
                    .append_pair("contentfilter", rating_word(*provider, rating));
                if let Some(pos) = next {
                    pairs.append_pair("pos", pos);
                }
            }
            Provider::Giphy => {
                pairs
                    .append_pair("api_key", key)
                    .append_pair("limit", &limit)
                    .append_pair("rating", rating_word(*provider, rating));
                if let Some(offset) = next.filter(|n| n.bytes().all(|b| b.is_ascii_digit())) {
                    pairs.append_pair("offset", offset);
                }
            }
        }
        if let Some(q) = q {
            pairs.append_pair("q", q);
        }
    }
    Ok(url)
}

#[derive(Deserialize)]
struct Format {
    url: String,
    #[serde(default)]
    dims: Vec<u32>,
}

#[derive(Deserialize)]
struct KlipyItem {
    id: serde_json::Value,
    #[serde(default)]
    title: String,
    #[serde(default)]
    content_description: String,
    media_formats: std::collections::HashMap<String, Format>,
}

#[derive(Deserialize)]
struct KlipyPage {
    #[serde(default)]
    results: Vec<KlipyItem>,
    #[serde(default)]
    next: Option<String>,
}

#[derive(Deserialize)]
struct GiphyImage {
    url: String,
    #[serde(default)]
    width: String,
    #[serde(default)]
    height: String,
}

#[derive(Deserialize)]
struct GiphyImages {
    original: GiphyImage,
    fixed_width: Option<GiphyImage>,
}

#[derive(Deserialize)]
struct GiphyItem {
    id: String,
    #[serde(default)]
    title: String,
    images: GiphyImages,
}

#[derive(Deserialize)]
struct GiphyPagination {
    #[serde(default)]
    offset: u64,
    #[serde(default)]
    count: u64,
    #[serde(default)]
    total_count: u64,
}

#[derive(Deserialize)]
struct GiphyPage {
    #[serde(default)]
    data: Vec<GiphyItem>,
    pagination: Option<GiphyPagination>,
}

fn web(url: &str) -> bool {
    Url::parse(url).is_ok_and(|u| matches!(u.scheme(), "https" | "http") && u.has_host())
}

/// A provider's answer as a page; items without a usable file are left out.
fn page_of(provider: Provider, pepper: &[u8], body: &[u8]) -> Result<GifPage, ApiError> {
    let bad =
        |_| ApiError::unavailable("The GIF provider answered with something unreadable", None);
    match provider {
        Provider::Klipy => {
            let KlipyPage { results, next } = serde_json::from_slice(body).map_err(bad)?;
            let items = results
                .into_iter()
                .filter_map(|item| {
                    let KlipyItem {
                        id,
                        title,
                        content_description,
                        mut media_formats,
                    } = item;
                    let gif = media_formats.remove("gif")?;
                    let small = media_formats.remove("tinygif").unwrap_or(Format {
                        url: gif.url.clone(),
                        dims: gif.dims.clone(),
                    });
                    if !web(&gif.url) || !web(&small.url) {
                        return None;
                    }
                    let [width, height] = small.dims.get(..2)?.try_into().ok()?;
                    let id = match id {
                        serde_json::Value::String(s) => s,
                        other => other.to_string(),
                    };
                    let title = match title.is_empty() {
                        true => content_description,
                        false => title,
                    };
                    Some(Gif {
                        id,
                        title,
                        preview: file_path(pepper, &small.url),
                        url: gif.url,
                        width,
                        height,
                    })
                })
                .collect();
            let next = next.filter(|n| !n.is_empty() && n != "0");
            Ok(GifPage { items, next })
        }
        Provider::Giphy => {
            let GiphyPage { data, pagination } = serde_json::from_slice(body).map_err(bad)?;
            let items: Vec<Gif> = data
                .into_iter()
                .filter_map(|item| {
                    let GiphyItem { id, title, images } = item;
                    let GiphyImages {
                        original,
                        fixed_width,
                    } = images;
                    let small = fixed_width.unwrap_or(GiphyImage {
                        url: original.url.clone(),
                        width: original.width.clone(),
                        height: original.height.clone(),
                    });
                    if !web(&original.url) || !web(&small.url) {
                        return None;
                    }
                    Some(Gif {
                        id,
                        title,
                        preview: file_path(pepper, &small.url),
                        url: original.url,
                        width: small.width.parse().ok()?,
                        height: small.height.parse().ok()?,
                    })
                })
                .collect();
            let next = pagination
                .filter(|p| p.count > 0 && p.offset + p.count < p.total_count)
                .map(|p| (p.offset + p.count).to_string());
            Ok(GifPage { items, next })
        }
    }
}

async fn fetch(config: &GifConfig, url: &Url) -> Result<Vec<u8>, ApiError> {
    let failed = |e: String| {
        tracing::warn!("GIF provider request failed: {e}");
        ApiError::unavailable("The GIF provider can't be reached right now", None)
    };
    let checked = crate::net_guard::check(url, &config.policy)
        .await
        .map_err(|e| failed(e.to_string()))?;
    let mut resp = checked
        .client(
            std::time::Duration::from_secs(5),
            std::time::Duration::from_secs(5),
        )
        .map_err(|e| failed(e.without_url().to_string()))?
        .get(url.clone())
        .header("user-agent", "rchat-gifs/1.0")
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|e| failed(e.without_url().to_string()))?;
    if !resp.status().is_success() {
        return Err(failed(format!("status {}", resp.status())));
    }
    let mut body = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| failed(e.without_url().to_string()))?
    {
        body.extend_from_slice(&chunk);
        if body.len() > ANSWER_MAX {
            return Err(failed("answer too large".to_string()));
        }
    }
    Ok(body)
}

async fn page(
    state: &AppState,
    q: Option<&str>,
    next: Option<&str>,
) -> Result<Json<GifPage>, ApiError> {
    let config = ready(&state.db).await?;
    let pepper = crate::db::pepper(&state.db).await?;
    let url = request(&config, q, next)?;
    let body = fetch(&config, &url).await?;
    Ok(Json(page_of(config.provider, &pepper, &body)?))
}

/// Search GIFs
///
/// GIFs matching `q` from the provider this site set up (`GIF_PROVIDER`, `GIF_API_KEY`), 24 a
/// page. The provider is asked by this server; the previews are files on this server. Requires
/// a bearer token and the `gifs` switch. General rate-limit bucket.
#[utoipa::path(get, path = "/api/v1/gifs/search", tag = "Media", params(GifSearch), responses((status = 200, description = "A page of GIFs", body = GifPage), (status = 400, description = "`q` is blank or over 100 characters (`reason.field` `q`)", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 404, description = "`GIFs are turned off on this site` (`reason.kind` `off_site`, `reason.control` `gifs`): the switch is off or no provider key is set", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody), (status = 503, description = "The provider can't be reached or answered with something unreadable", body = ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn search_gifs(
    State(state): State<AppState>,
    Authed(_user): Authed,
    Query(query): Query<GifSearch>,
) -> Result<Json<GifPage>, ApiError> {
    let GifSearch { q, next } = query;
    let q = q.trim();
    if q.is_empty() || q.chars().count() > QUERY_MAX {
        return Err(ApiError::invalid("Search for 1 to 100 characters", "q"));
    }
    page(&state, Some(q), next.as_deref()).await
}

/// Trending GIFs
///
/// What trends at the provider this site set up, 24 a page, as `GET /api/v1/gifs/search`
/// answers it. Requires a bearer token and the `gifs` switch. General rate-limit bucket.
#[utoipa::path(get, path = "/api/v1/gifs/trending", tag = "Media", params(GifTrending), responses((status = 200, description = "A page of GIFs", body = GifPage), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 404, description = "`GIFs are turned off on this site` (`reason.kind` `off_site`, `reason.control` `gifs`)", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody), (status = 503, description = "The provider can't be reached or answered with something unreadable", body = ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn trending_gifs(
    State(state): State<AppState>,
    Authed(_user): Authed,
    Query(query): Query<GifTrending>,
) -> Result<Json<GifPage>, ApiError> {
    page(&state, None, query.next.as_deref()).await
}

/// Get a GIF preview
///
/// A file a GIF search named as `preview`, fetched from the provider by this server: only
/// addresses a search answer signed, only images recognized from their bytes, at most 5 MiB.
/// Cached for a day. No authentication: the signature is the permission. 404 while the `gifs`
/// switch is off. General rate-limit bucket.
#[utoipa::path(get, path = "/api/v1/gifs/file", tag = "Media", params(GifFile), responses((status = 200, description = "The image", content((Vec<u8> = "image/gif"), (Vec<u8> = "image/webp"), (Vec<u8> = "image/png"), (Vec<u8> = "image/jpeg"))), (status = 404, description = "`Not found`: a signature that does not match, or the switch is off", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody), (status = 503, description = "The provider's file can't be fetched", body = ApiErrorBody)), security(()))]
pub(crate) async fn gif_file(
    State(state): State<AppState>,
    Query(query): Query<GifFile>,
) -> Result<Response, ApiError> {
    let config = ready(&state.db).await?;
    let GifFile { u, s } = query;
    let pepper = crate::db::pepper(&state.db).await?;
    let want = sign(&pepper, &u);
    let same: bool = subtle::ConstantTimeEq::ct_eq(want.as_bytes(), s.as_bytes()).into();
    let url = Url::parse(&u)
        .ok()
        .filter(|_| same && want.len() == s.len());
    let url = url.ok_or_else(crate::api::access::not_found)?;
    let (mime, bytes) = crate::api::preview_images::fetch_image(&url, &config.policy)
        .await
        .map_err(|e| {
            tracing::warn!("GIF file fetch failed: {e}");
            ApiError::unavailable("The GIF can't be fetched right now", None)
        })?;
    let mut res = bytes.into_response();
    let headers = res.headers_mut();
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
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=86400"),
    );
    Ok(res)
}

#[cfg(test)]
mod tests;
