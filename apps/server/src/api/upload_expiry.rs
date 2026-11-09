use axum::Json;
use axum::extract::{Path, State};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use utoipa::ToSchema;

use crate::api::access::perms::Perm;
use crate::api::access::{Proof, ServerAccess, resolve_server};
use crate::api::audit;
use crate::api::media::MEDIA_TTL_SECS;
use crate::api::{ApiError, ApiErrorBody, Authed, Settings, bad};
use crate::db::{Db, User};
use crate::state::AppState;
use crate::ws::WsEvent;

/// Shortest custom time a server can keep its files, in seconds (1 hour).
pub const CUSTOM_MIN: i64 = 3600;
/// Longest custom time, in seconds (365 days).
pub const CUSTOM_MAX: i64 = 365 * DAY;
/// Most days an operator can cap server choices at; 0 is no cap.
pub const CAP_DAYS_MAX: i64 = 365;
/// The `settings` key of the cap.
pub const CAP_KEY: &str = "upload_expiry_max_days";
const DAY: i64 = 86400;

/// How a server keeps uploaded files.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum ExpiryMode {
    /// The instance's time (`limits.media_retention_secs`, 1 day).
    Default,
    /// `seconds` after upload.
    Custom,
    /// Kept until removed, when the instance allows it (`upload_expiry_max_days` is 0).
    Never,
}

/// A server's choice for how long uploaded files stay.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct UploadExpiry {
    /// `default`, `custom` or `never`.
    pub mode: ExpiryMode,
    /// Seconds after upload for `custom`, 3600 (1 hour) to 31536000 (365 days); `null`
    /// otherwise.
    #[serde(default)]
    pub seconds: Option<i64>,
}

impl UploadExpiry {
    pub const DEFAULT: UploadExpiry = UploadExpiry {
        mode: ExpiryMode::Default,
        seconds: None,
    };

    /// From `servers.upload_expiry`: `NULL` the instance default, 0 never, else seconds.
    pub fn from_stored(value: Option<i64>) -> UploadExpiry {
        match value {
            None => UploadExpiry::DEFAULT,
            Some(0) => UploadExpiry {
                mode: ExpiryMode::Never,
                seconds: None,
            },
            Some(s) => UploadExpiry {
                mode: ExpiryMode::Custom,
                seconds: Some(s),
            },
        }
    }

    pub fn stored(self) -> Option<i64> {
        let UploadExpiry { mode, seconds } = self;
        match mode {
            ExpiryMode::Default => None,
            ExpiryMode::Never => Some(0),
            ExpiryMode::Custom => seconds,
        }
    }

    /// The `media.ttl` of a file posted in a server with this choice, under the instance cap
    /// (`cap_days`, 0 for none): `None` for the instance default, `Some(0)` kept until removed,
    /// else seconds after upload.
    pub fn ttl(self, cap_days: i64) -> Option<i64> {
        let cap = cap_days.max(0) * DAY;
        let UploadExpiry { mode, seconds } = self;
        match mode {
            ExpiryMode::Default => None,
            ExpiryMode::Never if cap > 0 => Some(cap),
            ExpiryMode::Never => Some(0),
            ExpiryMode::Custom => seconds.map(|s| match cap > 0 && s > cap {
                true => cap,
                false => s,
            }),
        }
    }

    /// Seconds a new file stays, `None` when it is kept until removed.
    pub fn lifetime(self, cap_days: i64) -> Option<i64> {
        match self.ttl(cap_days) {
            None => Some(MEDIA_TTL_SECS),
            Some(0) => None,
            Some(s) => Some(s),
        }
    }
}

/// When a file uploaded at `uploaded_at` with `media.ttl` value `ttl` goes, `None` if kept.
pub fn deadline(uploaded_at: i64, ttl: Option<i64>) -> Option<i64> {
    match ttl {
        None => Some(uploaded_at + MEDIA_TTL_SECS),
        Some(0) => None,
        Some(s) => Some(uploaded_at + s),
    }
}

/// The choice of the server that channel `id` belongs to.
pub(crate) async fn channel_choice(
    conn: &mut sqlx::AnyConnection,
    id: i64,
) -> sqlx::Result<UploadExpiry> {
    let row = sqlx::query(
        "SELECT s.upload_expiry FROM channels c JOIN servers s ON s.name = c.server WHERE c.id = $1",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(match row {
        Some(r) => UploadExpiry::from_stored(r.try_get(0)?),
        None => UploadExpiry::DEFAULT,
    })
}

/// A server's upload expiry and what it means for new files now.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct UploadExpiryState {
    /// The server's choice.
    pub upload_expiry: UploadExpiry,
    /// Seconds new files stay after upload, after the instance cap; `null` when they are kept
    /// until removed.
    pub upload_ttl: Option<i64>,
}

impl UploadExpiryState {
    pub fn of(choice: UploadExpiry, settings: &Settings) -> UploadExpiryState {
        UploadExpiryState {
            upload_expiry: choice,
            upload_ttl: choice.lifetime(settings.upload_expiry_max_days),
        }
    }
}

pub(crate) async fn stored(db: &Db, server: &str) -> Result<UploadExpiry, ApiError> {
    let row = sqlx::query("SELECT upload_expiry FROM servers WHERE name = $1")
        .bind(server)
        .fetch_optional(db)
        .await?
        .ok_or_else(crate::api::access::not_found)?;
    Ok(UploadExpiry::from_stored(row.try_get(0)?))
}

/// The originals (not forwards) of the live server files posted in `server`.
const POSTED_IN: &str = "SELECT m.media_id FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.server = $2 AND m.media_kind = 'server' AND m.media_removed = 0 AND m.fwd_created_at IS NULL AND m.media_id IS NOT NULL";

/// Gives the files posted in `server` the `ttl` of its choice, and their messages (forwards
/// included) the matching expiry time.
pub(crate) async fn retime(
    conn: &mut sqlx::AnyConnection,
    server: &str,
    ttl: Option<i64>,
) -> sqlx::Result<()> {
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "UPDATE media SET ttl = $1 WHERE id IN ({POSTED_IN})"
    )))
    .bind(ttl)
    .bind(server)
    .execute(&mut *conn)
    .await?;
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "UPDATE messages SET media_expires_at = (SELECT CASE WHEN md.ttl = 0 THEN NULL ELSE md.uploaded_at + COALESCE(md.ttl, $1) END FROM media md WHERE md.id = messages.media_id) WHERE media_kind = 'server' AND media_removed = 0 AND media_id IN ({POSTED_IN})"
    )))
    .bind(MEDIA_TTL_SECS)
    .bind(server)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// After the operator changes the cap: every server with its own choice gets it again under
/// the new cap.
pub(crate) async fn retime_all(db: &Db, cap_days: i64) -> sqlx::Result<()> {
    let rows =
        sqlx::query("SELECT name, upload_expiry FROM servers WHERE upload_expiry IS NOT NULL")
            .fetch_all(db)
            .await?;
    for row in rows {
        let name: String = row.try_get(0)?;
        let choice = UploadExpiry::from_stored(row.try_get(1)?);
        let mut conn = db.acquire().await?;
        retime(&mut conn, &name, choice.ttl(cap_days)).await?;
    }
    let mut conn = db.acquire().await?;
    clamp(&mut conn, cap_days).await?;
    Ok(())
}

/// The cap as stored (0 for none), or `None` when it can't be read or is not a number. Steps that
/// shorten or delete files skip a cap they could not read rather than use a fail-closed one.
pub(crate) async fn stored_cap(conn: &mut sqlx::AnyConnection) -> Option<i64> {
    let row = sqlx::query("SELECT value FROM settings WHERE key = $1")
        .bind(CAP_KEY)
        .fetch_optional(&mut *conn)
        .await;
    let value = match row {
        Ok(None) => return Some(0),
        Ok(Some(row)) => row.try_get::<String, _>(0).ok(),
        Err(e) => {
            tracing::warn!("the upload expiry cap could not be read, the files wait: {e}");
            return None;
        }
    };
    let days = value.and_then(|v| v.trim().parse::<i64>().ok());
    if days.is_none() {
        tracing::warn!("the stored upload expiry cap is not a number, the files wait");
    }
    days.map(|d| d.clamp(0, CAP_DAYS_MAX))
}

/// Files kept longer than the cap (`cap_days`, 0 for none) or until removed get the cap,
/// wherever they were posted, and their messages the matching time. Returns how many changed.
pub(crate) async fn clamp(conn: &mut sqlx::AnyConnection, cap_days: i64) -> sqlx::Result<u64> {
    if cap_days <= 0 {
        return Ok(0);
    }
    let cap = cap_days * DAY;
    sqlx::query("UPDATE messages SET media_expires_at = (SELECT md.uploaded_at + $1 FROM media md WHERE md.id = messages.media_id) WHERE media_kind = 'server' AND media_removed = 0 AND media_id IN (SELECT id FROM media WHERE ttl IS NOT NULL AND (ttl = 0 OR ttl > $1))")
        .bind(cap)
        .execute(&mut *conn)
        .await?;
    Ok(
        sqlx::query("UPDATE media SET ttl = $1 WHERE ttl IS NOT NULL AND (ttl = 0 OR ttl > $1)")
            .bind(cap)
            .execute(&mut *conn)
            .await?
            .rows_affected(),
    )
}

/// File `id` lost its original message: it goes like any other upload, and the messages still
/// carrying it (forwards) show that time. The database does the same when an original is deleted
/// (`messages_media_release`).
pub(crate) async fn release(conn: &mut sqlx::AnyConnection, id: &str) -> sqlx::Result<()> {
    sqlx::query("UPDATE messages SET media_expires_at = (SELECT uploaded_at + $2 FROM media WHERE id = $1) WHERE media_id = $1 AND media_kind = 'server' AND media_removed = 0 AND EXISTS(SELECT 1 FROM media WHERE id = $1 AND ttl IS NOT NULL)")
        .bind(id)
        .bind(MEDIA_TTL_SECS)
        .execute(&mut *conn)
        .await?;
    sqlx::query("UPDATE media SET ttl = NULL WHERE id = $1 AND ttl IS NOT NULL")
        .bind(id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

async fn manage(state: &AppState, user: &User, name: &str) -> Result<ServerAccess, ApiError> {
    let access = resolve_server(&state.db, name, Some(user), &Proof::none()).await?;
    access.require_perm(&state.db, Perm::DeleteServer).await?;
    Ok(access)
}

/// Get a server's upload expiry
///
/// How long files uploaded in the server stay, and what that means for new files under the
/// instance's cap. Members read the same values in the server detail. Requires the Delete
/// server permission. General rate-limit bucket.
#[utoipa::path(
    get,
    path = "/api/v1/servers/{name}/upload_expiry",
    tag = "Servers",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    responses(
        (status = 200, description = "The setting", body = UploadExpiryState),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Delete server permission", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses)", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn get_upload_expiry(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
) -> Result<Json<UploadExpiryState>, ApiError> {
    let access = manage(&state, &user, &name).await?;
    let choice = stored(&state.db, access.name()).await?;
    Ok(Json(UploadExpiryState::of(
        choice,
        &Settings::cached(&state.db).await,
    )))
}

/// Set a server's upload expiry
///
/// Chooses how long files uploaded in the server stay: the instance default, a custom time
/// (`seconds`, 3600 to 31536000) or `never` (kept until removed). While the instance has a cap
/// (`upload_expiry_max_days` in `GET /api/v1/settings`, 0 for none), `never` and longer times are
/// refused; a choice saved before the cap was lowered is shortened to it. Applies to files
/// already posted in the server too: their messages get the new expiry time, and files past it
/// are removed by the next sweep. Files in DMs keep the instance default. Requires the Delete
/// server permission. Emits `upload_expiry_changed` to the server's members, who load the server
/// again. General rate-limit bucket.
#[utoipa::path(
    put,
    path = "/api/v1/servers/{name}/upload_expiry",
    tag = "Servers",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    request_body = UploadExpiry,
    responses(
        (status = 200, description = "The setting after the change", body = UploadExpiryState),
        (status = 400, description = "`seconds` missing or outside 3600 to 31536000 for `custom`, or given for another mode; `This instance keeps files at most N days` for `never` or a longer time while the instance has a cap. Malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Delete server permission", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses)", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn set_upload_expiry(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Json(req): Json<UploadExpiry>,
) -> Result<Json<UploadExpiryState>, ApiError> {
    let access = manage(&state, &user, &name).await?;
    let UploadExpiry { mode, seconds } = req;
    match (mode, seconds) {
        (ExpiryMode::Custom, Some(s)) if (CUSTOM_MIN..=CUSTOM_MAX).contains(&s) => {}
        (ExpiryMode::Custom, _) => {
            return Err(bad("Choose a time from 1 hour to 365 days"));
        }
        (ExpiryMode::Default | ExpiryMode::Never, None) => {}
        (ExpiryMode::Default | ExpiryMode::Never, Some(_)) => {
            return Err(bad("Only a custom expiry takes seconds"));
        }
    }
    let key = access.name().to_string();
    let actor = access.audit_actor(&state.db, Perm::DeleteServer).await?;
    let settings = Settings::cached(&state.db).await;
    let cap = settings.upload_expiry_max_days;
    if cap > 0 && (mode == ExpiryMode::Never || seconds.is_some_and(|s| s > cap * DAY)) {
        let days = match cap {
            1 => "1 day".to_string(),
            n => format!("{n} days"),
        };
        return Err(bad(&format!("This instance keeps files at most {days}")));
    }
    let was = stored(&state.db, &key).await?;
    let mut tx = state.db.begin().await?;
    sqlx::query("UPDATE servers SET upload_expiry = $1 WHERE name = $2")
        .bind(req.stored())
        .bind(&key)
        .execute(&mut *tx)
        .await?;
    retime(&mut tx, &key, req.ttl(settings.upload_expiry_max_days)).await?;
    let details = audit::Details::new().change("upload_expiry", audit_value(was), audit_value(req));
    if details.has_changes() {
        audit::record(
            &mut tx,
            audit::Entry::new(&key, &actor, audit::Action::ServerUpdate)
                .target(audit::Target::server(&access.lite().display_name))
                .details(details),
        )
        .await?;
    }
    tx.commit().await?;
    state
        .hub
        .broadcast(WsEvent::UploadExpiryChanged { server: key });
    Ok(Json(UploadExpiryState::of(req, &settings)))
}

fn audit_value(choice: UploadExpiry) -> serde_json::Value {
    let UploadExpiry { mode, seconds } = choice;
    match (mode, seconds) {
        (ExpiryMode::Custom, Some(s)) => s.into(),
        (ExpiryMode::Never, _) => "never".into(),
        (ExpiryMode::Default | ExpiryMode::Custom, _) => "default".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::{ExpiryMode, UploadExpiry};

    const fn custom(s: i64) -> UploadExpiry {
        UploadExpiry {
            mode: ExpiryMode::Custom,
            seconds: Some(s),
        }
    }
    const NEVER: UploadExpiry = UploadExpiry {
        mode: ExpiryMode::Never,
        seconds: None,
    };

    #[test]
    fn each_mode_gives_its_file_lifetime_under_the_cap() {
        let day = 86400;
        for (choice, cap, ttl, lifetime) in [
            (UploadExpiry::DEFAULT, 0, None, Some(day)),
            (UploadExpiry::DEFAULT, 1, None, Some(day)),
            (custom(3600), 0, Some(3600), Some(3600)),
            (custom(3600), 1, Some(3600), Some(3600)),
            (custom(30 * day), 0, Some(30 * day), Some(30 * day)),
            (custom(30 * day), 7, Some(7 * day), Some(7 * day)),
            (custom(7 * day), 7, Some(7 * day), Some(7 * day)),
            (NEVER, 0, Some(0), None),
            (NEVER, 90, Some(90 * day), Some(90 * day)),
        ] {
            assert_eq!(choice.ttl(cap), ttl, "{choice:?} cap {cap}");
            assert_eq!(choice.lifetime(cap), lifetime, "{choice:?} cap {cap}");
        }
    }

    #[test]
    fn the_stored_column_round_trips() {
        for (choice, stored) in [
            (UploadExpiry::DEFAULT, None),
            (NEVER, Some(0)),
            (custom(7200), Some(7200)),
        ] {
            assert_eq!(choice.stored(), stored);
            assert_eq!(UploadExpiry::from_stored(stored), choice);
        }
    }

    use axum::Json;
    use axum::extract::{Path, State};
    use axum::http::StatusCode;
    use sqlx::Row;

    use super::{CUSTOM_MAX, CUSTOM_MIN, UploadExpiryState, get_upload_expiry, set_upload_expiry};
    use crate::api::access::perms::ALL_PERMS;
    use crate::api::media::{Charge, MEDIA_TTL_SECS, check_budget, save_upload, sweep};
    use crate::api::messages::{SendReq, send_channel_message, send_dm_message};
    use crate::api::test_util::{add_member, done, mem_user, temp_state};
    use crate::api::{ApiError, Authed, Settings};
    use crate::db::{Db, now};
    use crate::state::AppState;

    const DAY: i64 = 86400;

    async fn exec(db: &Db, sql: &str) {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .execute(db)
            .await
            .expect(sql);
    }

    /// Server `club` made by alice (all permissions), with bob as a plain member; returns its
    /// text channel.
    async fn club(state: &AppState) -> i64 {
        let db = &state.db;
        for name in ["alice", "bob", "carol"] {
            exec(db, &format!("INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, created_at) VALUES('{name}', '{name}', 'x', 'text', 'identicon', 1)")).await;
        }
        exec(db, "INSERT INTO servers(name, display_name, creator, created_at) VALUES('club', 'Club', 'alice', 1)").await;
        exec(db, "INSERT INTO servers(name, display_name, creator, password_hash, created_at) VALUES('hidden', 'Hidden', 'alice', 'x', 1)").await;
        exec(
            db,
            "INSERT INTO channels(server, name, created_at) VALUES('club', 'general', 1)",
        )
        .await;
        add_member(db, "club", "alice", 1, ALL_PERMS, 1).await;
        add_member(db, "club", "bob", 0, 0, 1).await;
        add_member(db, "hidden", "alice", 1, ALL_PERMS, 1).await;
        sqlx::query("SELECT id FROM channels WHERE server = 'club'")
            .fetch_one(db)
            .await
            .expect("channel")
            .try_get(0)
            .expect("id")
    }

    fn req(content: &str, media_id: Option<String>) -> Json<SendReq> {
        Json(SendReq {
            content: content.to_string(),
            media_id,
            media_spoiler: None,
            p2p: None,
            reply_to: None,
            mention_reply: false,
            forward_of: None,
            poll: None,
        })
    }

    async fn upload(state: &AppState, who: &str) -> String {
        save_upload(state, "a.txt", "text/plain", b"x", who, Charge::own(who))
            .await
            .expect("upload")
            .0
    }

    async fn post_file(state: &AppState, cid: i64) -> (String, i64, Option<i64>) {
        let id = upload(state, "alice").await;
        let m = send_channel_message(
            State(state.clone()),
            Path(cid),
            Authed(mem_user("alice", false)),
            req("", Some(id.clone())),
        )
        .await
        .expect("send")
        .0;
        let expires = m.media.as_ref().and_then(|x| x.expires_at);
        (id, m.id, expires)
    }

    async fn ttl(db: &Db, id: &str) -> Option<Option<i64>> {
        sqlx::query("SELECT ttl FROM media WHERE id = $1")
            .bind(id)
            .fetch_optional(db)
            .await
            .expect("media")
            .map(|r| r.try_get(0).expect("ttl"))
    }

    async fn age(db: &Db, id: &str, secs: i64) {
        sqlx::query("UPDATE media SET uploaded_at = $1 WHERE id = $2")
            .bind(now() - secs)
            .bind(id)
            .execute(db)
            .await
            .expect("age");
    }

    async fn set(
        state: &AppState,
        who: &str,
        server: &str,
        choice: UploadExpiry,
    ) -> Result<UploadExpiryState, ApiError> {
        set_upload_expiry(
            State(state.clone()),
            Authed(mem_user(who, false)),
            Path(server.to_string()),
            Json(choice),
        )
        .await
        .map(|j| j.0)
    }

    async fn message_expiry(db: &Db, id: i64) -> Option<i64> {
        sqlx::query("SELECT media_expires_at FROM messages WHERE id = $1")
            .bind(id)
            .fetch_one(db)
            .await
            .expect("message")
            .try_get(0)
            .expect("expiry")
    }

    #[tokio::test]
    async fn files_follow_their_server_choice_and_the_sweep_honors_it() {
        let (state, path) = temp_state("upload_expiry_modes").await;
        let db = &state.db;
        let cid = club(&state).await;
        let (file, msg, expires) = post_file(&state, cid).await;
        assert_eq!(ttl(db, &file).await, Some(None), "the instance default");
        let uploaded: i64 = sqlx::query("SELECT uploaded_at FROM media WHERE id = $1")
            .bind(&file)
            .fetch_one(db)
            .await
            .expect("media")
            .try_get(0)
            .expect("uploaded_at");
        assert_eq!(expires, Some(uploaded + MEDIA_TTL_SECS));

        let kept = set(&state, "alice", "club", NEVER).await.expect("never");
        assert_eq!(
            kept,
            UploadExpiryState {
                upload_expiry: NEVER,
                upload_ttl: None
            }
        );
        assert_eq!(ttl(db, &file).await, Some(Some(0)));
        assert_eq!(message_expiry(db, msg).await, None);
        age(db, &file, 30 * DAY).await;
        sweep(db, None).await.expect("sweep");
        assert_eq!(
            ttl(db, &file).await,
            Some(Some(0)),
            "never: the sweep keeps it"
        );

        let (fresh, fresh_msg, fresh_expires) = post_file(&state, cid).await;
        assert_eq!(ttl(db, &fresh).await, Some(Some(0)));
        assert_eq!(fresh_expires, None);

        let hour = set(&state, "alice", "club", custom(3600))
            .await
            .expect("custom");
        assert_eq!(hour.upload_ttl, Some(3600));
        assert_eq!(ttl(db, &fresh).await, Some(Some(3600)));
        assert!(message_expiry(db, fresh_msg).await.is_some());
        sweep(db, None).await.expect("sweep");
        assert_eq!(ttl(db, &file).await, None, "past a custom time: removed");
        assert_eq!(ttl(db, &fresh).await, Some(Some(3600)), "inside it: kept");
        let removed: i64 = sqlx::query("SELECT media_removed FROM messages WHERE id = $1")
            .bind(msg)
            .fetch_one(db)
            .await
            .expect("message")
            .try_get(0)
            .expect("removed");
        assert_eq!(removed, 1);

        set(&state, "alice", "club", UploadExpiry::DEFAULT)
            .await
            .expect("default");
        assert_eq!(ttl(db, &fresh).await, Some(None));
        done(state, path).await;
    }

    #[tokio::test]
    async fn the_instance_cap_shortens_choices_now_and_later() {
        let (state, path) = temp_state("upload_expiry_cap").await;
        let db = &state.db;
        let cid = club(&state).await;
        set(&state, "alice", "club", NEVER).await.expect("never");
        let (file, _, _) = post_file(&state, cid).await;
        assert_eq!(ttl(db, &file).await, Some(Some(0)));
        let admin = |body: serde_json::Value| {
            crate::api::admin::patch_settings(
                State(state.clone()),
                Authed(mem_user("root", true)),
                Json(serde_json::from_value(body).expect("patch")),
            )
        };
        let capped = admin(serde_json::json!({"upload_expiry_max_days": 7}))
            .await
            .expect("cap");
        assert_eq!(capped.0.upload_expiry_max_days, 7);
        assert_eq!(
            ttl(db, &file).await,
            Some(Some(7 * DAY)),
            "a lowered cap applies to kept files"
        );
        let state_now = get_upload_expiry(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            Path("club".into()),
        )
        .await
        .expect("get")
        .0;
        assert_eq!(
            state_now,
            UploadExpiryState {
                upload_expiry: NEVER,
                upload_ttl: Some(7 * DAY)
            }
        );
        let (later, _, expires) = post_file(&state, cid).await;
        assert_eq!(ttl(db, &later).await, Some(Some(7 * DAY)));
        assert!(expires.is_some());
        let _ = admin(serde_json::json!({"upload_expiry_max_days": 0}))
            .await
            .expect("no cap");
        assert_eq!(
            ttl(db, &later).await,
            Some(Some(0)),
            "lifting the cap gives the choice back"
        );
        let _ = admin(serde_json::json!({"upload_expiry_max_days": 7}))
            .await
            .expect("cap again");
        let refused = |r: Result<UploadExpiryState, ApiError>| matches!(r, Err(ApiError(StatusCode::BAD_REQUEST, m)) if m == "This instance keeps files at most 7 days");
        assert!(refused(set(&state, "alice", "club", NEVER).await));
        assert!(refused(set(&state, "alice", "club", custom(8 * DAY)).await));
        set(&state, "alice", "club", custom(7 * DAY))
            .await
            .expect("at the cap");
        set(&state, "alice", "club", custom(3 * DAY))
            .await
            .expect("under it");
        assert_eq!(ttl(db, &later).await, Some(Some(3 * DAY)));
        for bad in [-1, 366] {
            assert!(
                admin(serde_json::json!({"upload_expiry_max_days": bad}))
                    .await
                    .is_err()
            );
        }
        Settings::forget(db);
        done(state, path).await;
    }

    #[tokio::test]
    async fn only_managers_change_it_and_others_get_uniform_404s() {
        let (state, path) = temp_state("upload_expiry_gate").await;
        club(&state).await;
        let code = |r: Result<UploadExpiryState, ApiError>| r.err().map(|ApiError(c, _)| c);
        assert_eq!(
            code(set(&state, "bob", "club", NEVER).await),
            Some(StatusCode::FORBIDDEN)
        );
        assert_eq!(
            code(set(&state, "carol", "hidden", NEVER).await),
            Some(StatusCode::NOT_FOUND)
        );
        assert_eq!(
            code(set(&state, "carol", "nowhere", NEVER).await),
            Some(StatusCode::NOT_FOUND)
        );
        let get = get_upload_expiry(
            State(state.clone()),
            Authed(mem_user("bob", false)),
            Path("club".into()),
        )
        .await;
        assert!(matches!(get, Err(ApiError(StatusCode::FORBIDDEN, _))));
        for bad in [
            custom(3599),
            custom(CUSTOM_MAX + 1),
            UploadExpiry {
                mode: ExpiryMode::Custom,
                seconds: None,
            },
            UploadExpiry {
                mode: ExpiryMode::Never,
                seconds: Some(3600),
            },
        ] {
            assert_eq!(
                code(set(&state, "alice", "club", bad).await),
                Some(StatusCode::BAD_REQUEST),
                "{bad:?}"
            );
        }
        assert_eq!(
            code(set(&state, "carol", "hidden", custom(1)).await),
            Some(StatusCode::NOT_FOUND)
        );
        assert!(
            set(&state, "alice", "club", custom(CUSTOM_MIN))
                .await
                .is_ok()
        );
        let detail = crate::api::servers::get_server(
            State(state.clone()),
            crate::api::MaybeAuthed(Some(mem_user("bob", false))),
            axum::http::HeaderMap::new(),
            Path("club".into()),
        )
        .await
        .expect("detail")
        .0;
        assert_eq!(detail.upload_expiry, custom(CUSTOM_MIN));
        assert_eq!(detail.upload_ttl, Some(CUSTOM_MIN));
        done(state, path).await;
    }

    #[tokio::test]
    async fn dms_keep_the_default_and_a_deleted_message_lets_its_file_go() {
        let (state, path) = temp_state("upload_expiry_dm").await;
        let db = &state.db;
        let cid = club(&state).await;
        set(&state, "alice", "club", NEVER).await.expect("never");
        let dm: i64 =
            sqlx::query("INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id")
                .fetch_one(db)
                .await
                .expect("dm")
                .try_get(0)
                .expect("id");
        let id = upload(&state, "alice").await;
        let sent = send_dm_message(
            State(state.clone()),
            Path(dm),
            Authed(mem_user("alice", false)),
            req("", Some(id.clone())),
        )
        .await
        .expect("dm file")
        .0;
        assert_eq!(ttl(db, &id).await, Some(None));
        assert!(sent.media.and_then(|m| m.expires_at).is_some());

        let (kept, msg, _) = post_file(&state, cid).await;
        age(db, &kept, 3 * DAY).await;
        sqlx::query("DELETE FROM messages WHERE id = $1")
            .bind(msg)
            .execute(db)
            .await
            .expect("delete");
        assert_eq!(ttl(db, &kept).await, Some(None), "its last message is gone");
        sweep(db, None).await.expect("sweep");
        assert_eq!(ttl(db, &kept).await, None);
        done(state, path).await;
    }

    #[tokio::test]
    async fn kept_files_count_against_the_budget_until_they_go() {
        let (state, path) = temp_state("upload_expiry_budget").await;
        let db = &state.db;
        let cid = club(&state).await;
        set(&state, "alice", "club", NEVER).await.expect("never");
        let (kept, _, _) = post_file(&state, cid).await;
        age(db, &kept, 10 * DAY).await;
        assert!(
            check_budget(db, Charge::own("alice"), 1, 1).await.is_err(),
            "a kept file still counts"
        );
        exec(db, "UPDATE media SET ttl = NULL").await;
        assert!(
            check_budget(db, Charge::own("alice"), 1, 1).await.is_ok(),
            "an expired one does not"
        );
        done(state, path).await;
    }

    /// alice's file posted in a never server, forwarded by her to her DM with bob.
    async fn kept_and_forwarded(state: &AppState) -> (String, i64, i64) {
        let db = &state.db;
        let cid = club(state).await;
        set(state, "alice", "club", NEVER).await.expect("never");
        let (file, original, _) = post_file(state, cid).await;
        let dm: i64 =
            sqlx::query("INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id")
                .fetch_one(db)
                .await
                .expect("dm")
                .try_get(0)
                .expect("id");
        let mut fwd = req("", None);
        fwd.0.forward_of = Some(original);
        let copy = send_dm_message(
            State(state.clone()),
            Path(dm),
            Authed(mem_user("alice", false)),
            fwd,
        )
        .await
        .expect("forward")
        .0;
        assert_eq!(
            copy.media.as_ref().map(|m| m.id.clone()),
            Some(file.clone())
        );
        (file, original, copy.id)
    }

    #[tokio::test]
    async fn deleting_the_original_lets_a_forwarded_file_go_and_frees_the_budget() {
        let (state, path) = temp_state("upload_expiry_release_original").await;
        let db = &state.db;
        let (file, original, copy) = kept_and_forwarded(&state).await;
        age(db, &file, 3 * DAY).await;
        assert!(check_budget(db, Charge::own("alice"), 1, 1).await.is_err());
        sqlx::query("DELETE FROM messages WHERE id = $1")
            .bind(original)
            .execute(db)
            .await
            .expect("delete the original");
        assert_eq!(
            ttl(db, &file).await,
            Some(None),
            "the forward does not keep it"
        );
        let uploaded: i64 = sqlx::query("SELECT uploaded_at FROM media WHERE id = $1")
            .bind(&file)
            .fetch_one(db)
            .await
            .expect("media")
            .try_get(0)
            .expect("uploaded_at");
        assert_eq!(message_expiry(db, copy).await, Some(uploaded + DAY));
        assert!(check_budget(db, Charge::own("alice"), 1, 1).await.is_ok());
        sweep(db, None).await.expect("sweep");
        assert_eq!(ttl(db, &file).await, None);
        done(state, path).await;
    }

    #[tokio::test]
    async fn removing_the_original_attachment_lets_a_forwarded_file_go() {
        let (state, path) = temp_state("upload_expiry_release_attachment").await;
        let db = &state.db;
        let (file, original, copy) = kept_and_forwarded(&state).await;
        let _ = crate::api::media::delete_media(
            State(state.clone()),
            Path(original),
            Authed(mem_user("alice", false)),
        )
        .await
        .expect("remove the attachment");
        assert_eq!(ttl(db, &file).await, Some(None));
        assert!(message_expiry(db, copy).await.is_some());
        done(state, path).await;
    }

    #[tokio::test]
    async fn the_cap_reaches_every_kept_file_even_one_saved_from_a_stale_cache() {
        let (state, path) = temp_state("upload_expiry_cap_everywhere").await;
        let db = &state.db;
        let (file, _, copy) = kept_and_forwarded(&state).await;
        let (stray, _, _) = post_file(&state, club_channel(db).await).await;
        exec(
            db,
            "UPDATE settings SET value = '7' WHERE key = 'upload_expiry_max_days'",
        )
        .await;
        Settings::forget(db);
        sweep(db, None).await.expect("sweep");
        assert_eq!(
            ttl(db, &file).await,
            Some(Some(7 * DAY)),
            "the sweep applies the cap"
        );
        assert_eq!(ttl(db, &stray).await, Some(Some(7 * DAY)));
        assert!(message_expiry(db, copy).await.is_some());
        exec(db, "UPDATE media SET ttl = 0").await;
        let _ = crate::api::admin::patch_settings(
            State(state.clone()),
            Authed(mem_user("root", true)),
            Json(
                serde_json::from_value(serde_json::json!({"upload_expiry_max_days": 5}))
                    .expect("patch"),
            ),
        )
        .await
        .expect("cap");
        assert_eq!(
            ttl(db, &file).await,
            Some(Some(5 * DAY)),
            "setting the cap applies it at once"
        );
        assert_eq!(ttl(db, &stray).await, Some(Some(5 * DAY)));
        Settings::forget(db);
        done(state, path).await;
    }

    async fn removed(db: &Db, id: i64) -> i64 {
        sqlx::query("SELECT media_removed FROM messages WHERE id = $1")
            .bind(id)
            .fetch_one(db)
            .await
            .expect("message")
            .try_get(0)
            .expect("removed")
    }

    #[tokio::test]
    async fn unreadable_settings_never_shorten_a_kept_file() {
        let (state, path) = temp_state("upload_expiry_unreadable").await;
        let db = &state.db;
        let cid = club(&state).await;
        set(&state, "alice", "club", NEVER).await.expect("never");
        let (file, msg, _) = post_file(&state, cid).await;
        age(db, &file, 10 * DAY).await;
        Settings::forget(db);
        exec(db, "ALTER TABLE settings RENAME TO settings_away").await;
        sweep(db, None).await.expect("sweep");
        exec(db, "ALTER TABLE settings_away RENAME TO settings").await;
        assert_eq!(ttl(db, &file).await, Some(Some(0)), "the file stays kept");
        assert_eq!(removed(db, msg).await, 0);
        exec(
            db,
            "UPDATE settings SET value = '7' WHERE key = 'upload_expiry_max_days'",
        )
        .await;
        Settings::forget(db);
        sweep(db, None).await.expect("sweep");
        assert_eq!(
            ttl(db, &file).await,
            None,
            "a cap that was read still applies"
        );
        assert_eq!(removed(db, msg).await, 1);
        Settings::forget(db);
        done(state, path).await;
    }

    #[tokio::test]
    async fn setting_the_cap_retimes_with_the_value_asked_for() {
        let (state, path) = temp_state("upload_expiry_cap_asked").await;
        let db = &state.db;
        let cid = club(&state).await;
        set(&state, "alice", "club", NEVER).await.expect("never");
        let (file, msg, _) = post_file(&state, cid).await;
        age(db, &file, 3 * DAY).await;
        // The stored cap reads back as nonsense, which settings take as a 1 day cap.
        exec(db, "CREATE TRIGGER garble AFTER UPDATE ON settings WHEN new.key = 'upload_expiry_max_days' AND new.value = '7' BEGIN UPDATE settings SET value = 'x' WHERE key = 'upload_expiry_max_days'; END").await;
        let _ = crate::api::admin::patch_settings(
            State(state.clone()),
            Authed(mem_user("root", true)),
            Json(
                serde_json::from_value(serde_json::json!({"upload_expiry_max_days": 7}))
                    .expect("patch"),
            ),
        )
        .await
        .expect("cap");
        assert_eq!(
            ttl(db, &file).await,
            Some(Some(7 * DAY)),
            "the cap asked for"
        );
        Settings::forget(db);
        sweep(db, None).await.expect("sweep");
        assert_eq!(
            ttl(db, &file).await,
            Some(Some(7 * DAY)),
            "a cap that reads as nonsense is not applied"
        );
        assert_eq!(removed(db, msg).await, 0);
        Settings::forget(db);
        done(state, path).await;
    }

    #[tokio::test]
    async fn members_hear_that_the_expiry_changed() {
        let (state, path) = temp_state("upload_expiry_event").await;
        club(&state).await;
        let mut rx = state.hub.subscribe();
        set(&state, "alice", "club", NEVER).await.expect("never");
        let mut heard = false;
        while let Ok(ev) = rx.try_recv() {
            heard |= matches!(ev, crate::ws::WsEvent::UploadExpiryChanged { ref server } if server == "club");
        }
        assert!(heard);
        done(state, path).await;
    }

    async fn club_channel(db: &Db) -> i64 {
        sqlx::query("SELECT id FROM channels WHERE server = 'club'")
            .fetch_one(db)
            .await
            .expect("channel")
            .try_get(0)
            .expect("id")
    }
}
