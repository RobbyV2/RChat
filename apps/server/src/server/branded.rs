use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use futures_util::{StreamExt, stream};

use crate::api::brand::{Asset, Stored, image_response, stored_asset};
use crate::state::AppState;

/// The title and the home-screen title the web app's pages are built with.
const BUILT_TITLE: &str = "<title>RChat</title>";
const BUILT_APPLE_TITLE: &str = "<meta name=\"apple-mobile-web-app-title\" content=\"RChat\"/>";

/// The most bytes of a page that is read whole to change its titles. A longer page passes as
/// it is.
const PAGE_MAX: usize = 8 * 1024 * 1024;

/// The colors of the installed app's frame, as the web app's own manifest has them.
const THEME_COLOR: &str = "#141218";

/// The brand image that answers a path of the web app's own icons.
fn icon_for(path: &str) -> Option<Asset> {
    match path {
        "/favicon.ico" => Some(Asset::Mark32),
        "/rchat_r.png" | "/icons/icon_192.png" => Some(Asset::Mark192),
        "/icons/apple_touch_icon.png" => Some(Asset::Mark180),
        "/icons/icon_512.png" => Some(Asset::Mark512),
        "/icons/icon_maskable_512.png" => Some(Asset::MarkMaskable),
        _ => None,
    }
}

/// The installed app's manifest with the brand's names and, for each size it uploaded, its
/// mark; the other icons are the web app's own.
pub(crate) fn manifest(brand: &Stored) -> serde_json::Value {
    let icon = |kind: Asset, built: &str, sizes: &str, purpose: &str| {
        serde_json::json!({
            "src": brand.asset(kind).unwrap_or_else(|| built.to_string()),
            "sizes": sizes,
            "type": "image/png",
            "purpose": purpose,
        })
    };
    let mut manifest = serde_json::json!({
        "name": brand.app(),
        "short_name": brand.short(),
        "start_url": "/",
        "display": "standalone",
        "theme_color": THEME_COLOR,
        "background_color": THEME_COLOR,
        "icons": [
            icon(Asset::Mark192, "/icons/icon_192.png", "192x192", "any"),
            icon(Asset::Mark512, "/icons/icon_512.png", "512x512", "any"),
            icon(Asset::MarkMaskable, "/icons/icon_maskable_512.png", "512x512", "maskable"),
        ],
    });
    let about: String = brand
        .about
        .lines()
        .next()
        .unwrap_or_default()
        .chars()
        .take(200)
        .collect();
    if !about.is_empty() {
        manifest["description"] = serde_json::Value::from(about);
    }
    manifest
}

/// What the brand itself answers for `path` of the web app: its manifest, and its mark in
/// place of the web app's icons. `None` for every other path, and for an icon whose size the
/// brand did not upload: the web app answers those.
pub(crate) async fn file(state: &AppState, brand: &Stored, path: &str) -> Option<Response> {
    if path == "/manifest.webmanifest" {
        let mut res = manifest(brand).to_string().into_response();
        let headers = res.headers_mut();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/manifest+json"),
        );
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
        return Some(res);
    }
    let kind = icon_for(path)?;
    brand.assets.get(kind.as_str())?;
    match stored_asset(&state.read(), kind).await {
        Ok(Some((bytes, etag))) => Some(image_response(bytes, &etag, None)),
        Ok(None) => None,
        Err(e) => {
            tracing::warn!("could not read a brand image: {e}");
            None
        }
    }
}

/// Whether the brand names the app other than the web app's pages are built with.
pub(crate) fn retitles(brand: &Stored) -> bool {
    brand.app() != crate::instance::DEFAULT_NAME
}

/// Whether a request asks for a page.
pub(crate) fn wants_html(headers: &HeaderMap) -> bool {
    headers
        .get(header::ACCEPT)
        .and_then(|accept| accept.to_str().ok())
        .is_some_and(|accept| accept.contains("text/html"))
}

/// `text` as text inside an HTML element or a quoted attribute.
pub(crate) fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#x27;"),
            c => out.push(c),
        }
    }
    out
}

/// `page` with the app name in its title and home-screen title; `None` when it has neither.
pub(crate) fn retitled_html(page: &str, app_name: &str) -> Option<String> {
    if !page.contains(BUILT_TITLE) && !page.contains(BUILT_APPLE_TITLE) {
        return None;
    }
    let name = escape_html(app_name);
    Some(
        page.replacen(BUILT_TITLE, &format!("<title>{name}</title>"), 1)
            .replacen(
                BUILT_APPLE_TITLE,
                &format!("<meta name=\"apple-mobile-web-app-title\" content=\"{name}\"/>"),
                1,
            ),
    )
}

/// `res` with the app name in its titles when it is a page the proxy can read: an HTML
/// answer that is not encoded and fits `PAGE_MAX`. Every other answer passes as it is.
pub(crate) async fn retitled(res: Response, app_name: &str) -> Response {
    let html = res
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|kind| kind.to_str().ok())
        .is_some_and(|kind| kind.starts_with("text/html"));
    let known_short = res
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|len| len.to_str().ok())
        .and_then(|len| len.parse::<usize>().ok())
        .is_none_or(|len| len <= PAGE_MAX);
    if !html
        || !known_short
        || res.status() != StatusCode::OK
        || res.headers().contains_key(header::CONTENT_ENCODING)
    {
        return res;
    }
    let (mut parts, body) = res.into_parts();
    let mut chunks = body.into_data_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = chunks.next().await {
        match chunk {
            Ok(chunk) if chunk.len() <= PAGE_MAX - bytes.len() => bytes.extend_from_slice(&chunk),
            Ok(chunk) => {
                let prefix = stream::iter([Ok(Bytes::from(bytes)), Ok(chunk)]);
                return Response::from_parts(parts, Body::from_stream(prefix.chain(chunks)));
            }
            Err(e) => {
                tracing::warn!("a page of the frontend could not be read: {e}");
                return (StatusCode::BAD_GATEWAY, "Frontend server not available").into_response();
            }
        }
    }
    let changed = std::str::from_utf8(&bytes)
        .ok()
        .and_then(|page| retitled_html(page, app_name));
    // The page is whole now: it goes out with its length, however the frontend sent it.
    parts.headers.remove(header::TRANSFER_ENCODING);
    parts.headers.remove(header::CONTENT_LENGTH);
    let body = match changed {
        Some(page) => {
            parts.headers.remove(header::ETAG);
            Body::from(page)
        }
        None => Body::from(bytes),
    };
    Response::from_parts(parts, body)
}

#[cfg(test)]
mod tests;
