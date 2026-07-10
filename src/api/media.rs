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
    ApiError, Authed, MediaRef, grant_matches, header_grants, request_token, require_guest_ok,
    user_for_token,
};
use crate::db::{Db, MediaKind, User, now, setting_on};
use crate::state::AppState;
use crate::ws::WsEvent;

const MAX_SIZE: usize = 25 * 1024 * 1024;
pub(crate) const MEDIA_TTL_SECS: i64 = 86400;

type SweptMessage = (i64, Option<i64>, Option<i64>, Option<String>);

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

#[utoipa::path(post, path = "/api/media", request_body(content = Vec<u8>, content_type = "multipart/form-data"), responses((status = 200, body = MediaRef)), security(("bearer" = [])))]
pub(crate) async fn upload_media(
    State(state): State<AppState>,
    Authed(_user): Authed,
    mut multipart: Multipart,
) -> Result<Json<MediaRef>, ApiError> {
    if !setting_on(&state.db, "asset_uploads").await {
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
    let blob: Option<Vec<u8>> = match &state.s3 {
        Some(bucket) => {
            bucket
                .put_object_with_content_type(s3_key(&id), &data, &mime)
                .await
                .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            None
        }
        None => Some(data.to_vec()),
    };
    sqlx::query(
        "INSERT INTO media(id, filename, mime, size, data, uploaded_at) VALUES($1, $2, $3, $4, $5, $6)",
    )
    .bind(&id)
    .bind(&filename)
    .bind(&mime)
    .bind(data.len() as i64)
    .bind(blob)
    .bind(uploaded_at)
    .execute(&state.db)
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
            sqlx::query("DELETE FROM media WHERE id = $1")
                .bind(&media_id)
                .execute(&mut *tx)
                .await?;
            sqlx::query("UPDATE messages SET media_removed = 2 WHERE id = $1")
                .bind(id)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            s3_delete(state.s3.as_deref(), &media_id).await;
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
    state: &AppState,
    headers: &axum::http::HeaderMap,
    media_id: &str,
    user: Option<&User>,
    query_grant: Option<&str>,
) -> Result<(), ApiError> {
    let rows = sqlx::query(
        "SELECT s.name, s.password_hash, d.user_a, d.user_b FROM messages m LEFT JOIN channels c ON c.id = m.channel_id LEFT JOIN dms d ON d.id = m.dm_id LEFT JOIN servers s ON s.name = c.server WHERE m.media_id = $1 AND m.media_removed = 0",
    )
    .bind(media_id)
    .fetch_all(&state.db)
    .await?;
    if rows.is_empty() {
        return match user {
            Some(_) => Ok(()),
            None => Err(ApiError(StatusCode::FORBIDDEN, "Not allowed".to_string())),
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
                            .fetch_optional(&state.db)
                            .await?
                            .is_some()
                }
                None => {
                    let mut matched = false;
                    for grant in &grants {
                        if grant_matches(&state.db, grant, sv).await? {
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

#[utoipa::path(get, path = "/api/media/{id}", params(("id" = String, Path), MediaQuery), responses((status = 200, description = "File bytes")), security((), ("bearer" = [])))]
pub(crate) async fn download_media(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
    axum::extract::Query(q): axum::extract::Query<MediaQuery>,
) -> Result<Response, ApiError> {
    let user = match request_token(&headers) {
        Some(token) => user_for_token(&state, &token).await,
        None => None,
    };
    require_guest_ok(&state.db, user.as_ref()).await?;
    media_view_ok(&state, &headers, &id, user.as_ref(), q.grant.as_deref()).await?;
    let row = sqlx::query("SELECT filename, mime, data FROM media WHERE id = $1")
        .bind(&id)
        .fetch_optional(&state.db)
        .await?;
    let (filename, mime, data): (String, String, Option<Vec<u8>>) = match &row {
        Some(r) => (r.try_get(0)?, r.try_get(1)?, r.try_get(2)?),
        None => {
            return Err(ApiError(
                StatusCode::NOT_FOUND,
                "Media not found".to_string(),
            ));
        }
    };
    let body = match (data, &state.s3) {
        (Some(bytes), _) => Body::from(bytes),
        (None, Some(bucket)) => {
            let stream = bucket
                .get_object_stream(s3_key(&id))
                .await
                .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            Body::from_stream(stream.bytes)
        }
        (None, None) => {
            return Err(ApiError(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Media stored in S3 but S3 is not configured".to_string(),
            ));
        }
    };
    let safe: String = filename
        .chars()
        .map(|c| match c {
            '"' | '\\' => '_',
            c if c.is_ascii_graphic() || c == ' ' => c,
            _ => '_',
        })
        .collect();
    Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{safe}\""),
        )
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(
            header::CONTENT_SECURITY_POLICY,
            "default-src 'none'; sandbox",
        )
        .body(body)
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

async fn sweep(db: &Db, s3: Option<&Bucket>) -> sqlx::Result<Vec<WsEvent>> {
    let cutoff = now() - MEDIA_TTL_SECS;
    let mut tx = db.begin().await?;
    let rows = sqlx::query("SELECT id FROM media WHERE uploaded_at <= $1")
        .bind(cutoff)
        .fetch_all(&mut *tx)
        .await?;
    let mut ids = Vec::with_capacity(rows.len());
    for r in &rows {
        ids.push(r.try_get::<String, _>(0)?);
    }
    let mut events = Vec::new();
    for id in &ids {
        let rows = sqlx::query(
            "SELECT id, channel_id, dm_id, media_filename FROM messages WHERE media_id = $1 AND media_removed = 0 AND media_kind != 'p2p'",
        )
        .bind(id)
        .fetch_all(&mut *tx)
        .await?;
        let mut swept: Vec<SweptMessage> = Vec::with_capacity(rows.len());
        for r in &rows {
            swept.push((r.try_get(0)?, r.try_get(1)?, r.try_get(2)?, r.try_get(3)?));
        }
        for (message_id, channel_id, dm_id, filename) in swept {
            let server: Option<String> = match channel_id {
                Some(cid) => {
                    match sqlx::query("SELECT server FROM channels WHERE id = $1")
                        .bind(cid)
                        .fetch_optional(&mut *tx)
                        .await?
                    {
                        Some(r) => Some(r.try_get(0)?),
                        None => None,
                    }
                }
                None => None,
            };
            let dm_users: Option<Vec<String>> = match dm_id {
                Some(did) => {
                    match sqlx::query("SELECT user_a, user_b FROM dms WHERE id = $1")
                        .bind(did)
                        .fetch_optional(&mut *tx)
                        .await?
                    {
                        Some(r) => Some(vec![r.try_get(0)?, r.try_get(1)?]),
                        None => None,
                    }
                }
                None => None,
            };
            events.push(WsEvent::MediaRemoved {
                server,
                channel_id,
                dm_id,
                dm_users,
                message_id,
                filename: filename.unwrap_or_default(),
                removed_by_author: false,
            });
        }
        sqlx::query(
            "UPDATE messages SET media_removed = 1 WHERE media_id = $1 AND media_kind != 'p2p'",
        )
        .bind(id)
        .execute(&mut *tx)
        .await?;
        sqlx::query("DELETE FROM media WHERE id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    for id in &ids {
        s3_delete(s3, id).await;
    }
    Ok(events)
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
    use super::sweep;
    use crate::db::{now, open};
    use sqlx::Row;

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
}
