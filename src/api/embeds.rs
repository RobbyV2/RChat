use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use reqwest::redirect::Policy;
use serde::Deserialize;
use sqlx::Row;
use url::{Host, Url};
use utoipa::IntoParams;

use crate::api::messages::{message_scope, require_can_delete};
use crate::api::{ApiError, Authed, Embed};
use crate::db::{Db, now};
use crate::state::AppState;
use crate::ws::WsEvent;

const MAX_BODY: usize = 1024 * 1024;
const CACHE_TTL: i64 = 86400;
const MAX_URLS: usize = 3;

fn ip_ok(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, _, _] = v4.octets();
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || a == 0
                || a >= 240
                || (a == 100 && (64..128).contains(&b)))
        }
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => ip_ok(IpAddr::V4(v4)),
            None => {
                let seg = v6.segments()[0];
                !(v6.is_loopback()
                    || v6.is_unspecified()
                    || v6.is_multicast()
                    || (seg & 0xfe00) == 0xfc00
                    || (seg & 0xffc0) == 0xfe80)
            }
        },
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

fn extract_urls(content: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for word in content.split(|c: char| c.is_whitespace() || c == '<' || c == '>') {
        let trimmed = word.trim_end_matches(['.', ',', ';', ':', '!', '?', ')', ']', '"', '\'']);
        if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
            continue;
        }
        match Url::parse(trimmed) {
            Ok(url) if url.host().is_some() => {
                let s = url.to_string();
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

async fn resolve(db: &Db, url: &str) -> anyhow::Result<Option<Embed>> {
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
    let state = state.clone();
    tokio::spawn(async move {
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
        state.hub.broadcast(WsEvent::EmbedsResolved {
            server,
            channel_id,
            dm_id,
            dm_users,
            message_id,
            embeds,
        });
    });
}

#[derive(Deserialize, IntoParams)]
pub struct BannerQuery {
    banner: Option<i64>,
}

#[utoipa::path(delete, path = "/api/messages/{id}/embeds/{ord}", params(("id" = i64, Path), ("ord" = i64, Path), BannerQuery), responses((status = 200, description = "Removed")), security(("bearer" = [])))]
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
    let res = sqlx::query(&sql)
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
