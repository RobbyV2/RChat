use axum::Json;
use axum::extract::{Path, Request, State};
use axum::middleware::Next;
use axum::response::Response;
use percent_encoding::percent_decode;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::Row;

use crate::api::reauth::{AuthedSession, Purpose, ReAuth, ReAuthBody, Session};
use crate::api::{ApiError, access, instance_audit};
use crate::db::{Db, User, now};
use crate::state::AppState;
use crate::ws::WsEvent;

/// The request header a site admin may give a reason in.
pub const REASON_HEADER: &str = "x-staff-reason";
/// The longest reason, in characters.
pub const REASON_MAX: usize = 512;
/// How long one `staff.view_server`, `staff.media` or `report.view` entry stands for the same
/// view again.
pub const REPEAT_SECS: i64 = 3600;
/// How long a private channel stays open to a site admin after a confirmation.
pub const CHANNEL_OPEN_SECS: i64 = 900;
/// The `reason.control` of the 403 (`reason.kind` `confirm`) that asks a site admin to confirm
/// before a private channel opens.
pub const CONFIRM: &str = "staff_view";

pub const CONFIRM_FIRST: &str = "Confirm to open this channel";
pub const NOT_RECORDED: &str = "Staff access could not be recorded";
pub const BAD_REASON: &str = "X-Staff-Reason must be at most 512 characters of percent-encoded UTF-8 without control characters";

const VIEW_SERVER: &str = "staff.view_server";
const VIEW_CHANNEL: &str = "staff.view_channel";
const SEARCH: &str = "staff.search";
const MEDIA: &str = "staff.media";
const REPORT_VIEW: &str = "report.view";
const P2P_DATA: &str = "staff.p2p_data";

/// The most entries of one admin, action and target a repeat check reads.
const RECENT: i64 = 200;

struct Scope {
    db: Db,
    reason: Option<Vec<u8>>,
}

tokio::task_local! {
    static SCOPE: Scope;
}

/// Runs a request with the database staff entries are written to and the reason its headers
/// give, so the access gate can note a staff view whichever database it reads from.
pub async fn with_request(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let reason = req
        .headers()
        .get(REASON_HEADER)
        .map(|v| v.as_bytes().to_vec());
    let scope = Scope {
        db: state.db.clone(),
        reason,
    };
    SCOPE.scope(scope, next.run(req)).await
}

/// Runs `f` as a request that gave `reason` in its header.
#[cfg(test)]
pub(crate) async fn with_reason<F: std::future::Future>(db: &Db, reason: &str, f: F) -> F::Output {
    let scope = Scope {
        db: db.clone(),
        reason: Some(reason.as_bytes().to_vec()),
    };
    SCOPE.scope(scope, f).await
}

fn primary(db: &Db) -> Db {
    SCOPE
        .try_with(|s| s.db.clone())
        .unwrap_or_else(|_| crate::db::writer(db))
}

/// A reason as its header carries it: percent-encoded UTF-8, trimmed. Empty is no reason.
pub(crate) fn parse_reason(raw: &[u8]) -> Result<Option<String>, ApiError> {
    let bad = || ApiError::invalid(BAD_REASON, "X-Staff-Reason");
    let text = percent_decode(raw).decode_utf8().map_err(|_| bad())?;
    let text = text.trim();
    if text.chars().count() > REASON_MAX || text.chars().any(char::is_control) {
        return Err(bad());
    }
    Ok(match text.is_empty() {
        true => None,
        false => Some(text.to_string()),
    })
}

fn reason() -> Result<Option<String>, ApiError> {
    match SCOPE.try_with(|s| s.reason.clone()) {
        Ok(Some(raw)) => parse_reason(&raw),
        Ok(None) | Err(_) => Ok(None),
    }
}

fn not_recorded(cause: impl std::fmt::Display) -> ApiError {
    tracing::error!("staff access not recorded: {cause}");
    ApiError::unavailable(NOT_RECORDED, None)
}

/// The 403 a site admin gets for `channel` when only instance powers open it, until they
/// confirm with `POST /api/v1/admin/channels/{id}/staff_view`. Nobody else ever gets it.
pub fn confirm_first(channel: i64) -> ApiError {
    ApiError::confirm(
        axum::http::StatusCode::FORBIDDEN,
        CONFIRM_FIRST,
        CONFIRM,
        channel,
    )
}

/// Whether `e` is a `confirm_first` answer.
pub fn asks_to_confirm(e: &ApiError) -> bool {
    e.status() == axum::http::StatusCode::FORBIDDEN
        && e.reason().is_some_and(|r| {
            r.kind == crate::api::ReasonKind::Confirm && r.control.as_deref() == Some(CONFIRM)
        })
}

fn with_reason_field(detail: Value, reason: Option<String>) -> Value {
    let mut fields = match detail {
        Value::Object(fields) => fields,
        _ => serde_json::Map::new(),
    };
    if let Some(reason) = reason {
        fields.insert("reason".to_string(), Value::from(reason));
    }
    Value::Object(fields)
}

/// Writes a staff entry before the answer it stands for. A failure is a 503, so nothing is
/// shown that the log does not have.
async fn write(
    db: &Db,
    actor: &str,
    action: &str,
    target: Option<&str>,
    detail: Value,
) -> Result<(), ApiError> {
    let detail = with_reason_field(detail, reason()?);
    match instance_audit::record(&primary(db), actor, action, target, detail).await {
        Ok(()) => Ok(()),
        Err(e) => Err(not_recorded(e.error())),
    }
}

/// When `actor` last wrote an entry of `action` on `target` after `since` whose detail `same`
/// accepts.
async fn latest(
    db: &Db,
    actor: &str,
    action: &str,
    target: &str,
    since: i64,
    same: impl Fn(&Value) -> bool,
) -> Result<Option<i64>, ApiError> {
    let rows = sqlx::query(
        "SELECT at, detail FROM instance_audit WHERE actor = $1 AND action = $2 AND target = $3 AND at > $4 ORDER BY id DESC LIMIT $5",
    )
    .bind(actor)
    .bind(action)
    .bind(target)
    .bind(since)
    .bind(RECENT)
    .fetch_all(&primary(db))
    .await
    .map_err(not_recorded)?;
    for r in &rows {
        let detail: String = r.try_get(1).map_err(not_recorded)?;
        if same(&serde_json::from_str(&detail).unwrap_or(Value::Null)) {
            return Ok(Some(r.try_get(0).map_err(not_recorded)?));
        }
    }
    Ok(None)
}

/// Whether `actor` has an entry of `action` on `target` after `since` whose detail `same`
/// accepts.
async fn recent(
    db: &Db,
    actor: &str,
    action: &str,
    target: &str,
    since: i64,
    same: impl Fn(&Value) -> bool,
) -> Result<bool, ApiError> {
    Ok(latest(db, actor, action, target, since, same)
        .await?
        .is_some())
}

async fn write_once(
    db: &Db,
    actor: &str,
    action: &str,
    target: &str,
    detail: Value,
    same: impl Fn(&Value) -> bool,
) -> Result<(), ApiError> {
    reason()?;
    match recent(db, actor, action, target, now() - REPEAT_SECS, same).await? {
        true => Ok(()),
        false => write(db, actor, action, Some(target), detail).await,
    }
}

fn field_is(detail: &Value, key: &str, value: &Value) -> bool {
    detail.get(key) == Some(value)
}

/// A site admin opened `server` with instance powers: one entry an hour per admin and server.
pub(crate) async fn view_server(db: &Db, admin: &User, server: &str) -> Result<(), ApiError> {
    write_once(db, &admin.username, VIEW_SERVER, server, json!({}), |_| {
        true
    })
    .await
}

/// Until when channel `channel` of `server` is open to `admin`: `CHANNEL_OPEN_SECS` after
/// their last confirmation, or `None` when it is closed.
pub(crate) async fn open_until(
    db: &Db,
    admin: &str,
    server: &str,
    channel: i64,
) -> Result<Option<i64>, ApiError> {
    let id = Value::from(channel);
    let at = latest(
        db,
        admin,
        VIEW_CHANNEL,
        server,
        now() - CHANNEL_OPEN_SECS,
        |d| field_is(d, "channel", &id),
    )
    .await?;
    Ok(at.map(|at| at + CHANNEL_OPEN_SECS))
}

/// Whether `admin` confirmed opening channel `channel` of `server` in the last
/// `CHANNEL_OPEN_SECS`.
pub(crate) async fn channel_open(
    db: &Db,
    admin: &str,
    server: &str,
    channel: i64,
) -> Result<bool, ApiError> {
    Ok(open_until(db, admin, server, channel).await?.is_some())
}

/// The channels of `admin` that are open now, for a search.
pub(crate) async fn open_channels(db: &Db, admin: &str) -> Result<Vec<i64>, ApiError> {
    let rows = sqlx::query(
        "SELECT detail FROM instance_audit WHERE actor = $1 AND action = $2 AND at > $3 ORDER BY id DESC LIMIT $4",
    )
    .bind(admin)
    .bind(VIEW_CHANNEL)
    .bind(now() - CHANNEL_OPEN_SECS)
    .bind(RECENT)
    .fetch_all(&primary(db))
    .await
    .map_err(not_recorded)?;
    let mut ids = Vec::new();
    for r in &rows {
        let detail: String = r.try_get(0).map_err(not_recorded)?;
        let id = serde_json::from_str::<Value>(&detail)
            .ok()
            .and_then(|d| d.get("channel").and_then(Value::as_i64));
        match id {
            Some(id) if !ids.contains(&id) => ids.push(id),
            Some(_) | None => {}
        }
    }
    Ok(ids)
}

/// A search by `admin` found `hits` messages in `channels`, which only instance powers open.
pub(crate) async fn search(
    db: &Db,
    admin: &User,
    hits: usize,
    channels: &[i64],
) -> Result<(), ApiError> {
    write(
        db,
        &admin.username,
        SEARCH,
        None,
        json!({"hits": hits, "channels": channels}),
    )
    .await
}

/// `admin` loaded the file `media` through the message `message`, which only instance powers
/// open: one entry an hour per admin and file.
pub(crate) async fn media(
    db: &Db,
    admin: &User,
    server: &str,
    channel: i64,
    message: i64,
    media: &str,
) -> Result<(), ApiError> {
    let id = Value::from(media);
    write_once(
        db,
        &admin.username,
        MEDIA,
        server,
        json!({"channel": channel, "message": message, "media": media}),
        |d| field_is(d, "media", &id),
    )
    .await
}

/// `admin` read the reports to the moderators of `server` with instance powers: one entry an
/// hour per admin and server.
pub(crate) async fn report_view(db: &Db, admin: &str, server: &str) -> Result<(), ApiError> {
    write_once(db, admin, REPORT_VIEW, server, json!({}), |_| true).await
}

/// How many P2P backups and synced identities the instance holds for `account`.
pub(crate) async fn p2p_counts(
    conn: &mut sqlx::AnyConnection,
    account: &str,
) -> sqlx::Result<(i64, i64)> {
    let row = sqlx::query(
        "SELECT (SELECT COUNT(*) FROM p2p_backups WHERE username = $1), (SELECT COUNT(*) FROM p2p_identities WHERE username = $1)",
    )
    .bind(account)
    .fetch_one(&mut *conn)
    .await?;
    Ok((row.try_get(0)?, row.try_get(1)?))
}

/// `admin` started the purge of the account `account` at `t`, which removed the P2P backups and
/// synced identities the instance held for it, counted by `HiddenUser::p2p_held`: written in
/// the transaction that hides the account, so the entry and the removal commit together.
/// Nothing is written when it held none.
pub(crate) async fn p2p_purge_in(
    conn: &mut sqlx::AnyConnection,
    admin: &str,
    account: &str,
    (backups, identities): (i64, i64),
    t: i64,
) -> Result<(), ApiError> {
    let reason = reason()?;
    if backups == 0 && identities == 0 {
        return Ok(());
    }
    let detail = with_reason_field(
        json!({"op": "purge", "backups": backups, "identities": identities}),
        reason,
    );
    match instance_audit::record_in(conn, admin, P2P_DATA, Some(account), detail, t).await {
        Ok(()) => Ok(()),
        Err(e) => Err(not_recorded(e.error())),
    }
}

/// Request body of `POST /api/v1/admin/channels/{id}/staff_view`.
#[derive(Deserialize, utoipa::ToSchema)]
pub struct StaffViewReq {
    /// How the admin confirms: the account password or words, a `phrase` proof (purpose
    /// `staff_view`, context the channel id as decimal text) or a fresh provider sign-in.
    pub reauth: ReAuthBody,
}

/// Answer of `POST /api/v1/admin/channels/{id}/staff_view`.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct StaffView {
    /// Unix seconds until which the channel stays open to the admin.
    pub until: i64,
    /// Seconds from now until it closes, for a client whose clock differs from the server's.
    pub remaining: i64,
}

/// Open a private channel as the instance
///
/// Opens a private channel to the site admin. Everyone else, and every channel that does not
/// exist, gets the same 404. A channel that only instance powers open (its rules hide it from
/// the admin's own membership, or the admin is no member) answers 403 `Confirm to open this
/// channel` with `reason.control` `staff_view` on every route until this request confirms. It
/// checks `reauth` (`fresh_session` is refused), writes a `staff.view_channel` entry to the
/// instance audit log and opens the channel for `CHANNEL_OPEN_SECS`; after that the 403 comes
/// back. A channel the admin's own membership views without read history reads as it does for
/// members until this request confirms it, which opens its whole history the same way. A
/// channel the admin's own membership opens fully needs none of this, and no entry is written
/// for it. The optional `X-Staff-Reason` header (at most 512 characters,
/// percent-encoded UTF-8) is kept with the entry, here and on every other request that writes
/// a staff entry. When the entry can't be written the answer is 503 and nothing opens. The
/// admin's own connections get `staff_view_opened`, so their WS delivers the channel's events
/// until it closes.
#[utoipa::path(post, path = "/api/v1/admin/channels/{id}/staff_view", tag = "Admin", operation_id = "admin_staff_view", params(("id" = i64, Path, description = "Channel id")), request_body = StaffViewReq, responses((status = 200, description = "Until when the channel stays open", body = StaffView), (status = 400, description = "`X-Staff-Reason` that is too long or not percent-encoded text, or malformed JSON (plain-text framework error)", body = crate::api::ApiErrorBody), (status = 401, description = "Missing or unknown bearer token, or a confirmation that does not match", body = crate::api::ApiErrorBody), (status = 404, description = "`Not found`: the caller is not a site administrator, or no such channel", body = crate::api::ApiErrorBody), (status = 503, description = "`Staff access could not be recorded`: nothing opened", body = crate::api::ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", body = crate::api::ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn staff_view(
    State(state): State<AppState>,
    AuthedSession(session): AuthedSession,
    Path(id): Path<i64>,
    Json(StaffViewReq { reauth }): Json<StaffViewReq>,
) -> Result<Json<StaffView>, ApiError> {
    staff_view_at(&state, session, id, reauth, state.clock.unix()).await
}

pub(crate) async fn staff_view_at(
    state: &AppState,
    session: Session,
    id: i64,
    reauth: ReAuthBody,
    t: i64,
) -> Result<Json<StaffView>, ApiError> {
    if !session.user.is_site_admin {
        return Err(access::not_found());
    }
    let (server, needed) = access::staff_channel_server(&state.db, &session.user, id).await?;
    reason()?;
    let reauth = ReAuth::try_from(reauth)?;
    let purpose = Purpose::StaffView {
        channel: id.to_string(),
    };
    crate::api::reauth::check_at(state, &session, reauth, purpose, t).await?;
    if needed {
        write(
            &state.db,
            &session.user.username,
            VIEW_CHANNEL,
            Some(&server),
            json!({"channel": id}),
        )
        .await?;
        state.hub.broadcast(WsEvent::StaffViewOpened {
            username: session.user.username.clone(),
            channel_id: id,
        });
    }
    Ok(Json(StaffView {
        until: t + CHANNEL_OPEN_SECS,
        remaining: CHANNEL_OPEN_SECS,
    }))
}

#[cfg(test)]
pub(crate) mod tests;
