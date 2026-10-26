use std::fmt::Write;

use axum::Json;
use axum::body::Body;
use axum::extract::{Multipart, Path, State};
use axum::http::{StatusCode, header};
use axum::response::Response;
use rand::Rng;
use s3::Bucket;
use sqlx::Row;

use crate::api::messages::{MsgScope, message_scope, require_can_delete};
use crate::api::{
    ApiError, Authed, MediaRef, Settings, grant_matches, header_grants, placeholders,
    request_token, require_guest_ok, user_for_token,
};
use crate::db::{Db, MediaKind, User, now};
use crate::state::AppState;
use crate::ws::WsEvent;

const MAX_SIZE: usize = 25 * 1024 * 1024;
pub(crate) const MEDIA_TTL_SECS: i64 = 86400;

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
    let mut tx = db.begin().await?;
    sqlx::query(
        "INSERT INTO media(id, filename, mime, size, data, uploader, uploaded_at) VALUES($1, $2, $3, $4, NULL, $5, $6)",
    )
    .bind(id)
    .bind(filename)
    .bind(mime)
    .bind(size)
    .bind(uploader)
    .bind(uploaded_at)
    .execute(&mut *tx)
    .await?;
    for (seq, chunk) in in_db.unwrap_or_default().chunks(MEDIA_CHUNK).enumerate() {
        sqlx::query("INSERT INTO media_chunks(media_id, seq, data) VALUES($1, $2, $3)")
            .bind(id)
            .bind(seq as i64)
            .bind(chunk.to_vec())
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

#[utoipa::path(post, path = "/api/media", request_body(content = Vec<u8>, content_type = "multipart/form-data"), responses((status = 200, description = "File stored; returns a media reference with its expiry time to attach to a message", body = MediaRef)), security(("bearer" = [])))]
pub(crate) async fn upload_media(
    State(state): State<AppState>,
    Authed(user): Authed,
    mut multipart: Multipart,
) -> Result<Json<MediaRef>, ApiError> {
    if !Settings::cached(&state.db).await.asset_uploads {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "File uploads are disabled".to_string(),
        ));
    }
    let field = multipart
        .next_field()
        .await
        .map_err(|e| ApiError(StatusCode::BAD_REQUEST, e.to_string()))?
        .ok_or_else(|| ApiError(StatusCode::BAD_REQUEST, "No file provided".to_string()))?;
    let filename = field.file_name().unwrap_or("file").to_string();
    let mime = field
        .content_type()
        .unwrap_or("application/octet-stream")
        .to_string();
    let data = field
        .bytes()
        .await
        .map_err(|e| ApiError(StatusCode::PAYLOAD_TOO_LARGE, e.to_string()))?;
    if data.len() > MAX_SIZE {
        return Err(ApiError(
            StatusCode::PAYLOAD_TOO_LARGE,
            "File exceeds 25MB limit".to_string(),
        ));
    }
    let id = fresh_id(&state.db).await?;
    let uploaded_at = now();
    let in_db = match &state.s3 {
        Some(bucket) => {
            bucket
                .put_object_with_content_type(s3_key(&id), &data, &mime)
                .await
                .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            None
        }
        None => Some(data.as_ref()),
    };
    store_media(
        &state.db,
        &id,
        &filename,
        &mime,
        data.len() as i64,
        in_db,
        &user.username,
        uploaded_at,
    )
    .await?;
    Ok(Json(MediaRef::server(
        id,
        filename,
        false,
        uploaded_at + MEDIA_TTL_SECS,
    )))
}

#[utoipa::path(delete, path = "/api/messages/{id}/media", params(("id" = i64, Path)), responses((status = 200, description = "Removed")), security(("bearer" = [])))]
pub(crate) async fn delete_media(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Authed(user): Authed,
) -> Result<Json<serde_json::Value>, ApiError> {
    let scope = message_scope(&state.db, id).await?;
    require_can_delete(&state.db, &user, &scope).await?;
    let MsgScope {
        channel_id,
        dm_id,
        thread_root_id: _,
        author: _,
        media_id,
        media_filename,
        media_kind,
        server,
        dm_users,
    } = scope;
    let media_id = match media_id {
        Some(media_id) => media_id,
        None => {
            return Err(ApiError(StatusCode::NOT_FOUND, "No attachment".to_string()));
        }
    };
    match media_kind {
        MediaKind::P2p => {
            sqlx::query("UPDATE messages SET media_removed = 2, media_hoster = NULL, media_expires_at = NULL, media_size = NULL, media_mime = NULL WHERE id = $1")
                .bind(id)
                .execute(&state.db)
                .await?;
        }
        MediaKind::Server => {
            let mut tx = state.db.begin().await?;
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
        filename: media_filename.unwrap_or_default(),
        removed_by_author: true,
    });
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(serde::Deserialize, utoipa::IntoParams)]
pub struct MediaQuery {
    grant: Option<String>,
}

async fn media_view_ok(
    db: &Db,
    headers: &axum::http::HeaderMap,
    media_id: &str,
    user: Option<&User>,
    query_grant: Option<&str>,
) -> Result<(), ApiError> {
    let rows = sqlx::query(
        "SELECT s.name, s.password_hash, d.user_a, d.user_b FROM messages m LEFT JOIN channels c ON c.id = m.channel_id LEFT JOIN dms d ON d.id = m.dm_id LEFT JOIN servers s ON s.name = c.server WHERE m.media_id = $1 AND m.media_removed = 0",
    )
    .bind(media_id)
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
            (Some(_), None) => Ok(()),
            (_, _) => Err(ApiError(StatusCode::FORBIDDEN, "Not allowed".to_string())),
        };
    }
    let mut grants = header_grants(headers);
    if let Some(g) = query_grant {
        grants.extend(
            g.split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
        );
    }
    for r in &rows {
        let (server, hash, user_a, user_b): (
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        ) = (r.try_get(0)?, r.try_get(1)?, r.try_get(2)?, r.try_get(3)?);
        let ok = match (&server, &hash) {
            (Some(_), None) => true,
            (Some(sv), Some(_)) => match user {
                Some(u) => {
                    u.is_site_admin
                        || sqlx::query("SELECT 1 FROM members WHERE server = $1 AND username = $2")
                            .bind(sv)
                            .bind(&u.username)
                            .fetch_optional(db)
                            .await?
                            .is_some()
                }
                None => {
                    let mut matched = false;
                    for grant in &grants {
                        if grant_matches(db, grant, sv).await? {
                            matched = true;
                            break;
                        }
                    }
                    matched
                }
            },
            (None, _) => match (user, &user_a, &user_b) {
                (Some(u), Some(a), Some(b)) => u.username == *a || u.username == *b,
                (_, _, _) => false,
            },
        };
        if ok {
            return Ok(());
        }
    }
    Err(ApiError(StatusCode::FORBIDDEN, "Not allowed".to_string()))
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

#[utoipa::path(get, path = "/api/media/{id}", params(("id" = String, Path), MediaQuery), responses((status = 200, description = "File bytes, streamed. Carries a strong `ETag` and `Cache-Control: private, max-age=86400, immutable`"), (status = 304, description = "`If-None-Match` matched the media's ETag")), security((), ("bearer" = [])))]
pub(crate) async fn download_media(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
    axum::extract::Query(q): axum::extract::Query<MediaQuery>,
) -> Result<Response, ApiError> {
    let db = state.read();
    let user = match request_token(&headers) {
        Some(token) => user_for_token(&state, &token).await,
        None => None,
    };
    require_guest_ok(&db, user.as_ref()).await?;
    media_view_ok(&db, &headers, &id, user.as_ref(), q.grant.as_deref()).await?;
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
        None => {
            return Err(ApiError(
                StatusCode::NOT_FOUND,
                "Media not found".to_string(),
            ));
        }
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
        .header(header::CACHE_CONTROL, cache);
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
    let mut ids = Vec::with_capacity(rows.len());
    for r in &rows {
        ids.push(r.try_get::<String, _>(0)?);
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
            filename: r.try_get::<Option<String>, _>(3)?.unwrap_or_default(),
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
        MediaQuery, SWEEP_BATCH, content_disposition, delete_media, download_media, store_media,
        sweep,
    };
    use crate::api::Authed;
    use crate::api::test_util::{done, mem_user, temp_state};
    use crate::db::{now, open};
    use axum::extract::{Path, State};
    use sqlx::Row;

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
        let path = std::env::temp_dir().join(format!("rchat_sweep_{}.db", std::process::id()));
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
        let res = download_media(
            State(state.clone()),
            axum::http::HeaderMap::new(),
            Path(id),
            axum::extract::Query(MediaQuery { grant: None }),
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
                download_media(
                    State(state),
                    headers,
                    Path(id),
                    axum::extract::Query(MediaQuery { grant: None }),
                )
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
        let body = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .expect("body");
        assert_eq!(body.as_ref(), blob.as_slice());
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(axum::http::header::IF_NONE_MATCH, etag);
        let cached = get(headers).await;
        assert_eq!(cached.status(), axum::http::StatusCode::NOT_MODIFIED);
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
