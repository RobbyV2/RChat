use axum::Json;
use axum::extract::{Path, State};
use rand::Rng;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use utoipa::ToSchema;

use crate::api::access::not_found;
use crate::api::{ApiError, ApiErrorBody, Authed, OkResp, bad, ok};
use crate::db::now;
use crate::state::AppState;

/// Lifetimes a share link can have, in seconds: 10 minutes, 1 hour, 1 day, 7 days, 30 days.
pub const EXPIRY_CHOICES: [i64; 5] = [600, 3600, 86400, 7 * 86400, 30 * 86400];
/// Active (unexpired) links one account can hold.
pub const ACTIVE_MAX: i64 = 20;
/// Largest stored config string, in bytes.
pub const BLOB_MAX: usize = 16 * 1024;
pub const BLOB_PREFIX: &str = "rc1.";
pub const ID_LEN: usize = 12;
const BASE62: &[u8; 62] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/// Request body for creating a config share link.
#[derive(Deserialize, ToSchema)]
pub struct NewConfigShare {
    /// The encoded config string (`rc1.` followed by base64url), at most 16384 bytes. The server
    /// stores it as is and never reads it.
    blob: String,
    /// Seconds until the link expires: one of 600, 3600, 86400, 604800 or 2592000.
    expires_in: i64,
}

/// A config share link of the signed-in user.
#[derive(Serialize, Deserialize, ToSchema)]
pub struct ConfigShare {
    /// Link id, 12 random base62 characters; the link is `/config/{id}/`.
    pub id: String,
    /// When it was created, Unix seconds.
    pub created_at: i64,
    /// When it stops working, Unix seconds.
    pub expires_at: i64,
}

/// The config string behind a share link.
#[derive(Serialize, Deserialize, ToSchema)]
pub struct SharedConfig {
    /// The encoded config string, as uploaded.
    pub blob: String,
    /// When the link stops working, Unix seconds.
    pub expires_at: i64,
}

pub fn new_id() -> String {
    let mut out = String::with_capacity(ID_LEN);
    let mut rng = rand::rng();
    while out.len() < ID_LEN {
        let mut byte = [0u8; 1];
        rng.fill_bytes(&mut byte);
        if byte[0] < 248 {
            out.push(BASE62[(byte[0] % 62) as usize] as char);
        }
    }
    out
}

pub fn valid_id(id: &str) -> bool {
    id.len() == ID_LEN && id.bytes().all(|b| b.is_ascii_alphanumeric())
}

pub fn check_blob(blob: &str) -> Result<(), ApiError> {
    match blob.strip_prefix(BLOB_PREFIX) {
        _ if blob.len() > BLOB_MAX => Err(bad("The config is too large to share (16 KiB max)")),
        Some(body)
            if !body.is_empty()
                && body
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') =>
        {
            Ok(())
        }
        _ => Err(bad("Not a config string")),
    }
}

pub fn check_expiry(expires_in: i64) -> Result<(), ApiError> {
    match EXPIRY_CHOICES.contains(&expires_in) {
        true => Ok(()),
        false => Err(bad(
            "Links can expire in 10 minutes, 1 hour, 1 day, 7 days or 30 days",
        )),
    }
}

/// Share config
///
/// Stores an encoded config string under a new random link id so it can be opened on another
/// device, for example by scanning a QR code. The server keeps the string as is and never reads
/// it. A link always expires (`expires_in`: 10 minutes, 1 hour, 1 day, 7 days or 30 days; there
/// is no "never") and anyone with the link can read it until then. An account has at most 20
/// active links. Guests cannot share. Strict rate-limit bucket.
#[utoipa::path(
    post,
    path = "/api/config_shares",
    tag = "Account",
    request_body = NewConfigShare,
    responses(
        (status = 200, description = "The new link", body = ConfigShare),
        (status = 400, description = "Not a config string, larger than 16384 bytes, an expiry that is not one of the choices, or already 20 active links. Malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token (guests cannot share)", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the strict bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn create_share(
    State(state): State<AppState>,
    Authed(user): Authed,
    Json(req): Json<NewConfigShare>,
) -> Result<Json<ConfigShare>, ApiError> {
    let NewConfigShare { blob, expires_in } = req;
    check_blob(&blob)?;
    check_expiry(expires_in)?;
    let t = now();
    let expires_at = t + expires_in;
    let id = new_id();
    let mut tx = state.db.begin().await?;
    sqlx::query("UPDATE users SET username = username WHERE username = $1")
        .bind(&user.username)
        .execute(&mut *tx)
        .await?;
    let inserted = sqlx::query(
        "INSERT INTO config_shares(id, owner, blob, created_at, expires_at) SELECT $1, $2, $3, $4, $5 WHERE (SELECT COUNT(*) FROM config_shares WHERE owner = $2 AND expires_at > $4) < $6",
    )
    .bind(&id)
    .bind(&user.username)
    .bind(&blob)
    .bind(t)
    .bind(expires_at)
    .bind(ACTIVE_MAX)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    tx.commit().await?;
    if inserted == 0 {
        return Err(bad(
            "You can have at most 20 active links. Revoke one first",
        ));
    }
    Ok(Json(ConfigShare {
        id,
        created_at: t,
        expires_at,
    }))
}

/// List your config links
///
/// Returns your active config share links, newest first (at most 20). The config strings are
/// not included. Strict rate-limit bucket.
#[utoipa::path(
    get,
    path = "/api/config_shares",
    tag = "Account",
    responses(
        (status = 200, description = "Your active links", body = [ConfigShare]),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the strict bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn list_shares(
    State(state): State<AppState>,
    Authed(user): Authed,
) -> Result<Json<Vec<ConfigShare>>, ApiError> {
    let rows = sqlx::query(
        "SELECT id, created_at, expires_at FROM config_shares WHERE owner = $1 AND expires_at > $2 ORDER BY created_at DESC, id LIMIT $3",
    )
    .bind(&user.username)
    .bind(now())
    .bind(ACTIVE_MAX)
    .fetch_all(&state.db)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        out.push(ConfigShare {
            id: r.try_get(0)?,
            created_at: r.try_get(1)?,
            expires_at: r.try_get(2)?,
        });
    }
    Ok(Json(out))
}

/// Open a config link
///
/// Returns the config string behind a share link. Public: no token needed. Missing, expired
/// and revoked links all answer the same 404. Strict rate-limit bucket.
#[utoipa::path(
    get,
    path = "/api/config_shares/{id}",
    tag = "Account",
    params(("id" = String, Path, description = "Link id")),
    responses(
        (status = 200, description = "The config string", body = SharedConfig),
        (status = 404, description = "`Not found`: no such link, or it expired or was revoked (identical responses)", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the strict bucket", content_type = "text/plain", body = String)
    ),
    security((), ("bearer" = []))
)]
pub(crate) async fn get_share(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<SharedConfig>, ApiError> {
    if !valid_id(&id) {
        return Err(not_found());
    }
    let row =
        sqlx::query("SELECT blob, expires_at FROM config_shares WHERE id = $1 AND expires_at > $2")
            .bind(&id)
            .bind(now())
            .fetch_optional(&state.db)
            .await?
            .ok_or_else(not_found)?;
    Ok(Json(SharedConfig {
        blob: row.try_get(0)?,
        expires_at: row.try_get(1)?,
    }))
}

/// Revoke a config link
///
/// Deletes one of your config share links; it stops working at once. Links of other accounts
/// answer the same 404 as missing ones. Strict rate-limit bucket.
#[utoipa::path(
    delete,
    path = "/api/config_shares/{id}",
    tag = "Account",
    params(("id" = String, Path, description = "Link id")),
    responses(
        (status = 200, description = "Revoked", body = OkResp),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 404, description = "`Not found`: no such link of yours (identical for other accounts' links)", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the strict bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn delete_share(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(id): Path<String>,
) -> Result<Json<OkResp>, ApiError> {
    if !valid_id(&id) {
        return Err(not_found());
    }
    let deleted = sqlx::query("DELETE FROM config_shares WHERE id = $1 AND owner = $2")
        .bind(&id)
        .bind(&user.username)
        .execute(&state.db)
        .await?
        .rows_affected();
    match deleted {
        0 => Err(not_found()),
        _ => Ok(ok()),
    }
}

#[cfg(test)]
mod tests {
    use axum::http::StatusCode;

    use super::*;
    use crate::api::test_util::{done, mem_user, temp_state};

    fn blob(n: usize) -> String {
        format!("{BLOB_PREFIX}{}", "A".repeat(n))
    }

    async fn share(
        state: &AppState,
        who: &str,
        blob: String,
        expires_in: i64,
    ) -> Result<ConfigShare, ApiError> {
        create_share(
            State(state.clone()),
            Authed(mem_user(who, false)),
            Json(NewConfigShare { blob, expires_in }),
        )
        .await
        .map(|Json(s)| s)
    }

    async fn open_link(state: &AppState, id: &str) -> Result<SharedConfig, ApiError> {
        get_share(State(state.clone()), Path(id.to_string()))
            .await
            .map(|Json(s)| s)
    }

    async fn list(state: &AppState, who: &str) -> Vec<String> {
        let Json(rows) = list_shares(State(state.clone()), Authed(mem_user(who, false)))
            .await
            .expect("list");
        rows.into_iter().map(|r| r.id).collect()
    }

    async fn revoke(state: &AppState, who: &str, id: &str) -> Result<(), ApiError> {
        delete_share(
            State(state.clone()),
            Authed(mem_user(who, false)),
            Path(id.to_string()),
        )
        .await
        .map(|_| ())
    }

    fn status(r: Result<impl Sized, ApiError>) -> StatusCode {
        match r {
            Ok(_) => StatusCode::OK,
            Err(ApiError(code, _)) => code,
        }
    }

    #[test]
    fn ids_are_random_base62() {
        let mut seen = std::collections::HashSet::new();
        for _ in 0..500 {
            let id = new_id();
            assert!(valid_id(&id), "{id}");
            assert!(seen.insert(id));
        }
        assert!((ID_LEN as f64) * 62f64.log2() >= 60.0);
        for bad_id in [
            "",
            "short",
            "abcdefghijk!",
            "abcdefghijklm",
            "../../etc/pa",
            "ÄÄÄÄÄÄ",
        ] {
            assert!(!valid_id(bad_id), "{bad_id}");
        }
    }

    #[test]
    fn blobs_and_expiries_are_checked() {
        assert!(check_blob(&blob(10)).is_ok());
        assert!(check_blob("rc1.ab-_09").is_ok());
        assert!(check_blob(&blob(BLOB_MAX - BLOB_PREFIX.len())).is_ok());
        let ApiError(_, too_big) =
            check_blob(&blob(BLOB_MAX - BLOB_PREFIX.len() + 1)).expect_err("cap");
        assert!(too_big.contains("16 KiB"), "{too_big}");
        for bad_blob in [
            "",
            "rc1.",
            "rc2.abc",
            "rc1.a b",
            "rc1.a+b",
            "rc1.a=",
            "{\"v\":1}",
        ] {
            assert!(check_blob(bad_blob).is_err(), "{bad_blob}");
        }
        for ok_in in EXPIRY_CHOICES {
            assert!(check_expiry(ok_in).is_ok());
        }
        for bad_in in [
            0,
            -600,
            1,
            599,
            601,
            7200,
            31 * 86400,
            365 * 86400,
            i64::MAX,
        ] {
            assert!(check_expiry(bad_in).is_err(), "{bad_in}");
        }
    }

    #[tokio::test]
    async fn concurrent_creates_never_pass_the_cap() {
        let (state, path) = temp_state("config_shares_race").await;
        for _ in 0..ACTIVE_MAX - 1 {
            share(&state, "alice", blob(4), 86400).await.expect("share");
        }
        let tries = (0..8).map(|_| share(&state, "alice", blob(4), 600));
        let results = futures_util::future::join_all(tries).await;
        let made = results.iter().filter(|r| r.is_ok()).count();
        assert_eq!(
            made,
            1,
            "{:?}",
            results
                .iter()
                .map(|r| r.as_ref().err().map(|e| e.0))
                .collect::<Vec<_>>()
        );
        assert_eq!(list(&state, "alice").await.len(), ACTIVE_MAX as usize);
        done(state, path).await;
    }

    #[tokio::test]
    async fn links_expire_cap_at_20_and_only_the_owner_revokes() {
        let (state, path) = temp_state("config_shares").await;
        let db = &state.db;
        assert_eq!(
            status(share(&state, "alice", blob(8), 3600 * 24 * 365).await),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            status(share(&state, "alice", blob(BLOB_MAX), 600).await),
            StatusCode::BAD_REQUEST
        );
        let first = share(&state, "alice", blob(8), 600).await.expect("share");
        assert!(valid_id(&first.id));
        assert_eq!(first.expires_at - first.created_at, 600);
        let got = open_link(&state, &first.id).await.expect("open");
        assert_eq!((got.blob, got.expires_at), (blob(8), first.expires_at));
        assert_eq!(
            status(open_link(&state, "nonexistent1").await),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            status(open_link(&state, "bad id").await),
            StatusCode::NOT_FOUND
        );

        let mut ids = vec![first.id.clone()];
        for _ in 1..ACTIVE_MAX {
            ids.push(
                share(&state, "alice", blob(4), 86400)
                    .await
                    .expect("share")
                    .id,
            );
        }
        let Err(ApiError(code, msg)) = share(&state, "alice", blob(4), 600).await else {
            panic!("21st link accepted");
        };
        assert_eq!(code, StatusCode::BAD_REQUEST);
        assert!(msg.contains("20"), "{msg}");
        assert!(share(&state, "bob", blob(4), 600).await.is_ok());
        assert_eq!(list(&state, "alice").await.len(), ACTIVE_MAX as usize);
        assert_eq!(list(&state, "bob").await.len(), 1);

        assert_eq!(
            status(revoke(&state, "bob", &first.id).await),
            StatusCode::NOT_FOUND
        );
        assert!(open_link(&state, &first.id).await.is_ok());
        assert_eq!(
            status(revoke(&state, "alice", &first.id).await),
            StatusCode::OK
        );
        assert_eq!(
            status(open_link(&state, &first.id).await),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            status(revoke(&state, "alice", &first.id).await),
            StatusCode::NOT_FOUND
        );
        assert!(!list(&state, "alice").await.contains(&first.id));
        assert!(share(&state, "alice", blob(4), 600).await.is_ok());

        sqlx::query("UPDATE config_shares SET expires_at = $1 WHERE id = $2")
            .bind(now())
            .bind(&ids[1])
            .execute(db)
            .await
            .expect("expire");
        assert_eq!(
            status(open_link(&state, &ids[1]).await),
            StatusCode::NOT_FOUND
        );
        assert!(!list(&state, "alice").await.contains(&ids[1]));
        assert!(
            share(&state, "alice", blob(4), 600).await.is_ok(),
            "expired links do not count"
        );
        let swept = crate::db::sweep_stale(db).await.expect("sweep");
        assert_eq!(swept.config_shares, 1);
        let left: i64 = sqlx::query("SELECT COUNT(*) FROM config_shares WHERE owner = 'alice'")
            .fetch_one(db)
            .await
            .expect("count")
            .try_get(0)
            .expect("n");
        assert_eq!(left, ACTIVE_MAX);
        done(state, path).await;
    }
}
