use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use tokio::sync::Semaphore;
use url::{Host, Url};
use utoipa::IntoParams;

use crate::api::messages::{message_scope, require_can_delete};
use crate::api::{ApiError, ApiErrorBody, Authed, Embed};
use crate::db::{Db, now};
use crate::state::AppState;
use crate::ws::WsEvent;

const MAX_BODY: usize = 1024 * 1024;
const CACHE_TTL: i64 = 86400;
const MAX_URLS: usize = 3;

pub(crate) fn ip_ok(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, c, _] = v4.octets();
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || v4.is_documentation()
                || a == 0
                || a >= 240
                || (a == 100 && (64..128).contains(&b))
                || (a == 192 && b == 0 && c == 0)
                || (a == 198 && (18..20).contains(&b)))
        }
        IpAddr::V6(v6) => {
            let seg = v6.segments();
            let embedded = |hi: u16, lo: u16| {
                ip_ok(IpAddr::V4(std::net::Ipv4Addr::from(
                    (u32::from(hi) << 16) | u32::from(lo),
                )))
            };
            match seg {
                [0, 0, 0, 0, 0, 0 | 0xffff, hi, lo]
                | [0, 0, 0, 0, 0xffff, 0, hi, lo]
                | [0x64, 0xff9b, 0, 0, 0, 0, hi, lo]
                | [0x2002, hi, lo, ..] => embedded(hi, lo),
                [0x2001, second, ..] => second >= 0x200 && second != 0xdb8,
                [0x3fff, second, ..] => second >= 0x1000,
                [first, ..] => first & 0xe000 == 0x2000,
            }
        }
    }
}

async fn guard(url: &Url) -> anyhow::Result<Vec<SocketAddr>> {
    match url.scheme() {
        "http" | "https" => {}
        other => anyhow::bail!("scheme {other} not allowed"),
    }
    let port = url.port_or_known_default().unwrap_or(0);
    if port != 80 && port != 443 {
        anyhow::bail!("port {port} not allowed");
    }
    match url.host() {
        Some(Host::Ipv4(ip)) if ip_ok(IpAddr::V4(ip)) => Ok(Vec::new()),
        Some(Host::Ipv6(ip)) if ip_ok(IpAddr::V6(ip)) => Ok(Vec::new()),
        Some(Host::Domain(domain)) => {
            let addrs: Vec<SocketAddr> = tokio::net::lookup_host((domain, port)).await?.collect();
            match !addrs.is_empty() && addrs.iter().all(|a| ip_ok(a.ip())) {
                true => Ok(addrs),
                false => anyhow::bail!("address not globally routable"),
            }
        }
        _ => anyhow::bail!("address not globally routable"),
    }
}

async fn fetch_html(start: &Url) -> anyhow::Result<(Url, String)> {
    let mut url = start.clone();
    for _ in 0..4 {
        let addrs = guard(&url).await?;
        let mut builder = reqwest::Client::builder()
            .redirect(Policy::none())
            .no_proxy()
            .timeout(Duration::from_secs(5));
        if let Some(Host::Domain(domain)) = url.host() {
            builder = builder.resolve_to_addrs(domain, &addrs);
        }
        let mut resp = builder
            .build()?
            .get(url.clone())
            .header("user-agent", "rchat-embed/1.0")
            .header("accept", "text/html")
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
        let ct = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if !ct.contains("html") {
            anyhow::bail!("not html");
        }
        let mut buf: Vec<u8> = Vec::new();
        while let Some(chunk) = resp.chunk().await? {
            buf.extend_from_slice(&chunk);
            if buf.len() >= MAX_BODY {
                break;
            }
        }
        return Ok((url, String::from_utf8_lossy(&buf).into_owned()));
    }
    anyhow::bail!("too many redirects")
}

fn decode_entities(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

fn cap(s: &str, n: usize) -> Option<String> {
    let t = decode_entities(s.trim());
    match t.is_empty() {
        true => None,
        false => Some(t.chars().take(n).collect()),
    }
}

fn image_url(raw: &str, base: &Url) -> Option<String> {
    let joined = base.join(decode_entities(raw.trim()).as_str()).ok()?;
    match joined.scheme() {
        "http" | "https" => Some(joined.to_string().chars().take(1000).collect()),
        _ => None,
    }
}

struct Meta {
    site_name: Option<String>,
    title: Option<String>,
    description: Option<String>,
    image: Option<String>,
}

impl Meta {
    fn is_empty(&self) -> bool {
        self.site_name.is_none()
            && self.title.is_none()
            && self.description.is_none()
            && self.image.is_none()
    }
}

fn parse_meta(html: &str, base: &Url) -> Meta {
    let mut meta = Meta {
        site_name: None,
        title: None,
        description: None,
        image: None,
    };
    let mut fallback_title: Option<String> = None;
    let mut fallback_desc: Option<String> = None;
    let dom = match tl::parse(html, tl::ParserOptions::default()) {
        Ok(dom) => dom,
        Err(_) => return meta,
    };
    let parser = dom.parser();
    for node in dom.nodes() {
        let tag = match node.as_tag() {
            Some(tag) => tag,
            None => continue,
        };
        let name = tag.name().as_utf8_str();
        if name.eq_ignore_ascii_case("title") && fallback_title.is_none() {
            fallback_title = cap(&tag.inner_text(parser), 300);
            continue;
        }
        if !name.eq_ignore_ascii_case("meta") {
            continue;
        }
        let attr = |key: &str| {
            tag.attributes()
                .get(key)
                .flatten()
                .map(|v| v.as_utf8_str().into_owned())
        };
        let key = attr("property")
            .or_else(|| attr("name"))
            .unwrap_or_default();
        let content = match attr("content") {
            Some(content) => content,
            None => continue,
        };
        match key.as_str() {
            "og:site_name" if meta.site_name.is_none() => meta.site_name = cap(&content, 200),
            "og:title" if meta.title.is_none() => meta.title = cap(&content, 300),
            "og:description" if meta.description.is_none() => meta.description = cap(&content, 600),
            "og:image" | "og:image:url" if meta.image.is_none() => {
                meta.image = image_url(&content, base)
            }
            "twitter:title" if meta.title.is_none() => meta.title = cap(&content, 300),
            "twitter:description" if meta.description.is_none() => {
                meta.description = cap(&content, 600)
            }
            "twitter:image" | "twitter:image:src" if meta.image.is_none() => {
                meta.image = image_url(&content, base)
            }
            "description" if fallback_desc.is_none() => fallback_desc = cap(&content, 600),
            _ => {}
        }
    }
    meta.title = meta.title.or(fallback_title);
    meta.description = meta.description.or(fallback_desc);
    meta
}

const SECRET_PARAMS: &[&str] = &[
    "password",
    "passwd",
    "pass",
    "pwd",
    "token",
    "access_token",
    "refresh_token",
    "id_token",
    "auth",
    "secret",
    "api_key",
    "apikey",
    "key",
    "sig",
    "signature",
    "code",
];

fn is_invite(url: &Url) -> bool {
    let mut parts = url.path().split('/').skip(1);
    matches!(
        (parts.next(), parts.next(), parts.next(), parts.next()),
        (Some("invite"), Some(name), None | Some(""), None) if !name.is_empty()
    )
}

fn scrub(mut url: Url) -> Url {
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_fragment(None);
    let kept: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(k, _)| {
            let k = k.to_ascii_lowercase();
            !SECRET_PARAMS.contains(&k.as_str()) && !k.starts_with("x-amz-")
        })
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    match kept.is_empty() {
        true => url.set_query(None),
        false => {
            url.query_pairs_mut().clear().extend_pairs(kept);
        }
    }
    url
}

fn extract_urls(content: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for word in content.split(|c: char| c.is_whitespace() || c == '<' || c == '>') {
        let trimmed = word.trim_end_matches(['.', ',', ';', ':', '!', '?', ')', ']', '"', '\'']);
        if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
            continue;
        }
        match Url::parse(trimmed) {
            Ok(url) if url.host().is_some() && !is_invite(&url) => {
                let s = scrub(url).to_string();
                if !out.contains(&s) {
                    out.push(s);
                    if out.len() == MAX_URLS {
                        break;
                    }
                }
            }
            _ => continue,
        }
    }
    out
}

const FETCH_CONCURRENCY: usize = 16;
const QUEUE_MAX: usize = 256;

static QUEUED: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(QUEUE_MAX)));

static FETCHING: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(FETCH_CONCURRENCY));
static IN_FLIGHT: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(Default::default);

const FAILED_FOR: Duration = Duration::from_secs(60);
const FAILED_MAX: usize = 10_000;

static FAILED: LazyLock<Mutex<HashMap<String, Instant>>> = LazyLock::new(Default::default);

fn failed_lately(url: &str, now: Instant) -> bool {
    FAILED
        .lock()
        .ok()
        .and_then(|map| map.get(url).copied())
        .is_some_and(|at| now.duration_since(at) < FAILED_FOR)
}

fn note_failure(url: &str, now: Instant) {
    if let Ok(mut map) = FAILED.lock() {
        if map.len() >= FAILED_MAX {
            map.retain(|_, at| now.duration_since(*at) < FAILED_FOR);
            if map.len() >= FAILED_MAX {
                map.clear();
            }
        }
        map.insert(url.to_string(), now);
    }
}

async fn resolve(db: &Db, url: &str) -> anyhow::Result<Option<Embed>> {
    let lock = match IN_FLIGHT.lock() {
        Ok(mut map) => map.entry(url.to_string()).or_default().clone(),
        Err(_) => Arc::default(),
    };
    let held = lock.lock().await;
    let out = match failed_lately(url, Instant::now()) {
        true => Ok(None),
        false => {
            let out = resolve_once(db, url).await;
            if !matches!(out, Ok(Some(_))) {
                note_failure(url, Instant::now());
            }
            out
        }
    };
    drop(held);
    if let Ok(mut map) = IN_FLIGHT.lock()
        && map
            .get(url)
            .is_some_and(|l| Arc::ptr_eq(l, &lock) && Arc::strong_count(l) <= 2)
    {
        map.remove(url);
    }
    out
}

async fn resolve_once(db: &Db, url: &str) -> anyhow::Result<Option<Embed>> {
    let embed = |site_name, title, description, image_url| Embed {
        ord: 0,
        url: url.to_string(),
        site_name,
        title,
        description,
        image_url,
        banner_removed: false,
    };
    let cached = sqlx::query(
        "SELECT site_name, title, description, image_url FROM embeds WHERE url = $1 AND fetched_at > $2",
    )
    .bind(url)
    .bind(now() - CACHE_TTL)
    .fetch_optional(db)
    .await?;
    if let Some(r) = cached {
        return Ok(Some(embed(
            r.try_get(0)?,
            r.try_get(1)?,
            r.try_get(2)?,
            r.try_get(3)?,
        )));
    }
    let parsed = Url::parse(url)?;
    let _permit = FETCHING.acquire().await?;
    let (final_url, html) =
        tokio::time::timeout(Duration::from_secs(5), fetch_html(&parsed)).await??;
    let meta = parse_meta(&html, &final_url);
    if meta.is_empty() {
        return Ok(None);
    }
    let Meta {
        site_name,
        title,
        description,
        image,
    } = meta;
    sqlx::query(
        "INSERT INTO embeds(url, site_name, title, description, image_url, fetched_at) VALUES($1, $2, $3, $4, $5, $6) ON CONFLICT(url) DO UPDATE SET site_name = excluded.site_name, title = excluded.title, description = excluded.description, image_url = excluded.image_url, fetched_at = excluded.fetched_at",
    )
    .bind(url)
    .bind(&site_name)
    .bind(&title)
    .bind(&description)
    .bind(&image)
    .bind(now())
    .execute(db)
    .await?;
    Ok(Some(embed(site_name, title, description, image)))
}

async fn live_server(db: &Db, message_id: i64) -> sqlx::Result<Option<Option<String>>> {
    sqlx::query(
        "SELECT c.server FROM messages m LEFT JOIN channels c ON c.id = m.channel_id WHERE m.id = $1",
    )
    .bind(message_id)
    .fetch_optional(db)
    .await?
    .map(|r| r.try_get::<Option<String>, _>(0))
    .transpose()
}

#[derive(Serialize, Deserialize)]
pub struct UnfurlJob {
    server: Option<String>,
    channel_id: Option<i64>,
    dm_id: Option<i64>,
    dm_users: Option<Vec<String>>,
    message_id: i64,
    urls: Vec<String>,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn spawn_unfurl(
    state: &AppState,
    server: Option<String>,
    channel_id: Option<i64>,
    dm_id: Option<i64>,
    dm_users: Option<Vec<String>>,
    message_id: i64,
    content: &str,
) {
    let urls = extract_urls(content);
    if urls.is_empty() {
        return;
    }
    let job = UnfurlJob {
        server,
        channel_id,
        dm_id,
        dm_users,
        message_id,
        urls,
    };
    let Ok(permit) = QUEUED.clone().try_acquire_owned() else {
        tracing::debug!("embed queue full, no previews for message {message_id}");
        return;
    };
    let state = state.clone();
    tokio::spawn(async move {
        let _permit = permit;
        match &state.bus {
            Some(bus) if !bus.unfurls_locally() => {
                if let Err(e) = bus.enqueue_unfurl(&job).await {
                    tracing::warn!(
                        "embed job for message {message_id} not queued, unfurling here: {e}"
                    );
                    unfurl(&state, job).await;
                }
            }
            Some(_) | None => unfurl(&state, job).await,
        }
    });
}

pub async fn unfurl(state: &AppState, job: UnfurlJob) {
    let UnfurlJob {
        server,
        channel_id,
        dm_id,
        dm_users,
        message_id,
        urls,
    } = job;
    if !matches!(live_server(&state.db, message_id).await, Ok(Some(_))) {
        return;
    }
    let mut embeds: Vec<Embed> = Vec::new();
    for url in urls {
        match resolve(&state.db, &url).await {
            Ok(Some(mut embed)) => {
                embed.ord = embeds.len() as i64;
                embeds.push(embed);
            }
            Ok(None) => {}
            Err(e) => tracing::debug!("unfurl {url} skipped: {e}"),
        }
    }
    if embeds.is_empty() {
        return;
    }
    for embed in &embeds {
        let inserted = sqlx::query(
            "INSERT INTO message_embeds(message_id, ord, url, banner_removed, removed) VALUES($1, $2, $3, 0, 0) ON CONFLICT(message_id, ord) DO NOTHING",
        )
        .bind(message_id)
        .bind(embed.ord)
        .bind(&embed.url)
        .execute(&state.db)
        .await;
        match inserted {
            Ok(_) => {}
            Err(e) => {
                tracing::debug!("embed insert for message {message_id} skipped: {e}");
                return;
            }
        }
    }
    let server = match live_server(&state.db, message_id).await {
        Ok(Some(current)) => current,
        Ok(None) => return,
        Err(_) => server,
    };
    state.hub.broadcast(WsEvent::EmbedsResolved {
        server,
        channel_id,
        dm_id,
        dm_users,
        message_id,
        embeds,
    });
}

/// What to remove from the link preview.
#[derive(Deserialize, IntoParams)]
pub struct BannerQuery {
    /// `1` hides only the preview image (the embed's `banner_removed` becomes `true`); any
    /// other value, or omitting it, removes the whole preview.
    #[param(example = 1)]
    banner: Option<i64>,
}

/// Remove a link preview
///
/// Removes one link preview (embed) from a message, or with `banner=1` only its image. Requires
/// a bearer token and being the message's author, or in servers having the Delete messages
/// permission. Repeating a removal succeeds again. Emits `embeds_removed` (with `ord` and
/// `banner`) to clients in the server that can see the channel, or to both DM participants.
/// General rate-limit bucket.
#[utoipa::path(delete, path = "/api/messages/{id}/embeds/{ord}", tag = "Messages", params(("id" = i64, Path, description = "Message id"), ("ord" = i64, Path, description = "Position of the preview in the message's `embeds` (its `ord`, starting at 0)"), BannerQuery), responses((status = 200, description = "Removed; body `{\"ok\": true}`", body = crate::api::servers::OkResp), (status = 400, description = "Non-numeric id, ord or banner (plain-text framework error)", content_type = "text/plain", body = String), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 403, description = "Not the author and no Delete messages permission in the server (in DMs only the author may remove previews)", body = ApiErrorBody), (status = 404, description = "Message not found (or its author's account is being deleted), or no preview with this `ord`", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn delete_embed(
    State(state): State<AppState>,
    Path((id, ord)): Path<(i64, i64)>,
    Query(q): Query<BannerQuery>,
    Authed(user): Authed,
) -> Result<Json<serde_json::Value>, ApiError> {
    let scope = message_scope(&state.db, id).await?;
    require_can_delete(&state.db, &user, &scope).await?;
    let banner = q.banner == Some(1);
    let col = match banner {
        true => "banner_removed",
        false => "removed",
    };
    let sql = format!("UPDATE message_embeds SET {col} = 1 WHERE message_id = $1 AND ord = $2");
    let res = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .bind(ord)
        .execute(&state.db)
        .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "Embed not found".to_string(),
        ));
    }
    state.hub.broadcast(WsEvent::EmbedsRemoved {
        server: scope.server,
        channel_id: scope.channel_id,
        dm_id: scope.dm_id,
        dm_users: scope.dm_users,
        message_id: id,
        ord,
        banner,
    });
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invite_links_and_secrets_never_reach_the_fetcher() {
        let urls = extract_urls(
            "join https://chat.example/invite/club/?password=hunter2 or http://other.example/invite/x and https://site.example/page?token=abc&id=7#frag https://u:p@site.example/a?password=x&q=1",
        );
        assert_eq!(
            urls,
            [
                "https://site.example/page?id=7",
                "https://site.example/a?q=1"
            ]
        );
        assert!(
            urls.iter()
                .all(|u| !u.contains("hunter2") && !u.contains("password"))
        );
        assert_eq!(
            extract_urls("https://x.example/invite/club/sub https://x.example/invites/a"),
            [
                "https://x.example/invite/club/sub",
                "https://x.example/invites/a"
            ]
        );
        assert_eq!(
            extract_urls("https://s3.example/o?X-Amz-Signature=s&X-Amz-Credential=c&v=1"),
            ["https://s3.example/o?v=1"]
        );
    }

    #[test]
    fn scrubbed_urls_match_the_client() {
        for (posted, stored) in [
            (
                "https://dl.example/f.zip?sig=abc&exp=9",
                "https://dl.example/f.zip?exp=9",
            ),
            (
                "https://site.example/page?code=123",
                "https://site.example/page",
            ),
            (
                "https://site.example/a?q=a+b&Key=k#x",
                "https://site.example/a?q=a+b",
            ),
            ("https://Site.Example/Path", "https://site.example/Path"),
            (
                "https://site.example/a?q=%2F&x",
                "https://site.example/a?q=%2F&x=",
            ),
        ] {
            assert_eq!(extract_urls(posted), [stored], "app/lib/embed_links.ts");
        }
    }

    #[test]
    fn translated_and_special_ranges_are_not_routable() {
        let bad = [
            "64:ff9b::a9fe:a9fe",
            "64:ff9b::7f00:1",
            "64:ff9b:1::1",
            "2002:c0a8:0101::1",
            "2002:7f00:1::",
            "::a9fe:a9fe",
            "::ffff:10.0.0.1",
            "::1",
            "::",
            "fec0::1",
            "fe80::1",
            "fd00::1",
            "2001::1",
            "2001:db8::1",
            "::ffff:0:a9fe:a9fe",
            "::ffff:0:7f00:1",
            "100::1",
            "ff02::1",
            "2001:10::1",
            "2001:2::1",
            "3fff::1",
            "4000::1",
            "192.0.0.8",
            "198.18.0.1",
            "198.19.255.255",
            "192.0.2.1",
            "203.0.113.9",
            "169.254.169.254",
            "100.64.0.1",
            "10.1.2.3",
        ];
        for ip in bad {
            assert!(!ip_ok(ip.parse().expect("ip")), "{ip}");
        }
        let good = [
            "93.184.216.34",
            "64:ff9b::5db8:d822",
            "2002:5db8:d822::1",
            "2606:4700::1111",
            "2001:4860:4860::8888",
            "2a00:1450:4001::200e",
            "::ffff:0:5db8:d822",
            "198.20.0.1",
        ];
        for ip in good {
            assert!(ip_ok(ip.parse().expect("ip")), "{ip}");
        }
    }

    #[tokio::test]
    async fn unfurl_skips_deleted_messages_and_uses_the_current_server() {
        let (state, path) = crate::api::test_util::temp_state("unfurl_live").await;
        let db = &state.db;
        let cid: i64 = sqlx::query("SELECT id FROM channels WHERE server = 'rchat'")
            .fetch_one(db)
            .await
            .expect("general")
            .try_get(0)
            .expect("id");
        let mid: i64 = sqlx::query("INSERT INTO messages(channel_id, author, content, created_at) VALUES($1, 'a', 'x', 1) RETURNING id")
            .bind(cid)
            .fetch_one(db)
            .await
            .expect("msg")
            .try_get(0)
            .expect("id");
        assert_eq!(
            live_server(db, mid).await.expect("q"),
            Some(Some("rchat".to_string()))
        );
        assert_eq!(live_server(db, mid + 1).await.expect("q"), None);
        crate::api::test_util::done(state, path).await;
    }

    #[test]
    fn failed_urls_are_skipped_for_a_while() {
        let url = "https://dead.example/failed-skip";
        let start = Instant::now();
        assert!(!failed_lately(url, start));
        note_failure(url, start);
        assert!(failed_lately(url, start + Duration::from_secs(5)));
        assert!(!failed_lately(url, start + FAILED_FOR));
    }
}
