use axum::Json;
use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use utoipa::ToSchema;

use super::admin::require_site_admin;
use super::{ApiError, Authed, MaybeAuthed, OkResp, ok};
use crate::state::AppState;

/// A scheduled instance banner and its display interval.
#[derive(Serialize, ToSchema)]
pub struct Announcement {
    /// Opaque announcement identifier used for dismissal.
    pub id: String,
    /// Plain text shown in the banner.
    pub message: String,
    /// Inclusive start time in Unix seconds.
    pub starts_at: i64,
    /// Exclusive end time in Unix seconds.
    pub ends_at: i64,
}

/// The announcements visible to the caller at the time of the request.
#[derive(Serialize, ToSchema)]
pub struct Feed {
    /// Active banners in display order, excluding those dismissed by the account.
    pub announcements: Vec<Announcement>,
    /// Server clock in Unix seconds when visibility was evaluated.
    pub server_time: i64,
    /// Earliest scheduled visibility change in Unix seconds, or null if none is pending.
    pub next_change: Option<i64>,
}

impl IntoResponse for Feed {
    fn into_response(self) -> Response {
        ([(header::CACHE_CONTROL, "private, no-store")], Json(self)).into_response()
    }
}

/// Request body of `POST /api/v1/admin/announcements`.
#[derive(Deserialize, ToSchema)]
pub struct Schedule {
    /// The text.
    pub message: String,
    /// Unix seconds; 0 starts it now.
    pub starts_at: i64,
    /// Unix seconds; the announcement shows until just before.
    pub ends_at: i64,
}

fn row(r: &sqlx::any::AnyRow) -> sqlx::Result<Announcement> {
    Ok(Announcement {
        id: r.try_get(0)?,
        message: r.try_get(1)?,
        starts_at: r.try_get(2)?,
        ends_at: r.try_get(3)?,
    })
}

fn invalid(message: impl Into<String>) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, message.into(), None)
}

/// Get visible announcements.
///
/// Returns active banners in display order. Signing in excludes banners dismissed by the account. Future notices expose only the time of the next transition.
#[utoipa::path(get, path="/api/v1/announcements", tag="Instance", responses((status=200, description="Visible announcements and the next scheduled change", body=Feed)), security((), ("bearer"=[])))]
pub(crate) async fn active(
    State(state): State<AppState>,
    MaybeAuthed(user): MaybeAuthed,
) -> Result<Feed, ApiError> {
    let t = state.clock.unix();
    let rows = sqlx::query("SELECT a.id, CASE WHEN a.starts_at <= $1 THEN a.message ELSE '' END, a.starts_at, a.ends_at FROM announcements a WHERE a.ends_at > $1 AND NOT EXISTS (SELECT 1 FROM announcement_dismissals d WHERE d.announcement_id = a.id AND d.username = $2) ORDER BY a.starts_at, a.id")
        .bind(t).bind(user.map(|u| u.username)).fetch_all(&state.db).await?;
    let mut announcements = Vec::new();
    let mut next_change: Option<i64> = None;
    for r in &rows {
        let a = row(r)?;
        let next = if a.starts_at <= t {
            let end = a.ends_at;
            announcements.push(a);
            end
        } else {
            a.starts_at
        };
        next_change = Some(next_change.map_or(next, |x| x.min(next)));
    }
    Ok(Feed {
        announcements,
        next_change,
        server_time: t,
    })
}

/// Dismiss a current announcement.
///
/// Stores the dismissal for the signed-in account on every client. Repeating the request succeeds.
#[utoipa::path(put, path="/api/v1/announcements/{id}/dismiss", tag="Instance", params(("id"=String,Path,description="Announcement identifier from the feed")), responses((status=200, description="Dismissal processed", body=OkResp)), security(("bearer"=[])))]
pub(crate) async fn dismiss(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(id): Path<String>,
) -> Result<Json<OkResp>, ApiError> {
    sqlx::query("INSERT INTO announcement_dismissals(username, announcement_id) SELECT $1, id FROM announcements WHERE id = $2 AND starts_at <= $3 AND ends_at > $3 ON CONFLICT DO NOTHING")
        .bind(user.username).bind(id).bind(state.clock.unix()).execute(&state.db).await?;
    Ok(ok())
}

/// List announcements
///
/// The announcements that show now or later, by start time. General rate-limit bucket.
#[utoipa::path(get, path = "/api/v1/admin/announcements", tag = "Admin", operation_id = "admin_list_announcements", responses((status = 200, description = "Current and upcoming announcements", body = Vec<Announcement>), (status = 401, description = "Missing or unknown bearer token", body = crate::api::ApiErrorBody), (status = 404, description = "`Not found`: the caller is not a site administrator", body = crate::api::ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", body = crate::api::ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn list(
    State(state): State<AppState>,
    Authed(user): Authed,
) -> Result<Json<Vec<Announcement>>, ApiError> {
    require_site_admin(&user)?;
    let rows = sqlx::query("SELECT id, message, starts_at, ends_at FROM announcements WHERE ends_at > $1 ORDER BY starts_at, id")
        .bind(state.clock.unix()).fetch_all(&state.db).await?;
    Ok(Json(rows.iter().map(row).collect::<sqlx::Result<_>>()?))
}

/// Schedule an announcement
///
/// Publishes or schedules an announcement with an exclusive end time. A start of zero starts
/// it now. General rate-limit bucket.
#[utoipa::path(post, path = "/api/v1/admin/announcements", tag = "Admin", operation_id = "admin_schedule_announcement", request_body = Schedule, responses((status = 200, description = "The announcement", body = Announcement), (status = 400, description = "A message or time the request does not take, or malformed JSON (plain-text framework error)", body = crate::api::ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = crate::api::ApiErrorBody), (status = 404, description = "`Not found`: the caller is not a site administrator", body = crate::api::ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", body = crate::api::ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn schedule(
    State(state): State<AppState>,
    Authed(user): Authed,
    Json(req): Json<Schedule>,
) -> Result<Json<Announcement>, ApiError> {
    require_site_admin(&user)?;
    let message = super::brand::clean_text(&req.message, 1, 500, false).map_err(invalid)?;
    let t = state.clock.unix();
    if req.starts_at < 0
        || req.ends_at <= t
        || req.ends_at <= req.starts_at
        || req.ends_at > 253_402_300_799
    {
        return Err(invalid(
            "Choose an end date after the start and in the future.",
        ));
    }
    let a = Announcement {
        id: crate::identity::random_id(),
        message,
        starts_at: req.starts_at.max(t),
        ends_at: req.ends_at,
    };
    let mut tx = state.db.begin().await?;
    // Serialize the bounded queue, including simultaneous schedules on different server copies.
    sqlx::query("UPDATE settings SET value = value WHERE key = 'instance_id'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM announcements WHERE ends_at <= $1")
        .bind(t)
        .execute(&mut *tx)
        .await?;
    let added = sqlx::query("INSERT INTO announcements(id,message,starts_at,ends_at) SELECT $1,$2,$3,$4 WHERE (SELECT COUNT(*) FROM announcements) < 64")
        .bind(&a.id).bind(&a.message).bind(a.starts_at).bind(a.ends_at).execute(&mut *tx).await?;
    if added.rows_affected() == 0 {
        return Err(invalid("The queue already has 64 announcements."));
    }
    super::instance_audit::record_in(&mut tx,&user.username,"branding.change",Some(&a.id),serde_json::json!({"key":"announcements","action":"schedule","starts_at":a.starts_at,"ends_at":a.ends_at}),t).await?;
    tx.commit().await?;
    super::brand::announce(&state).await;
    Ok(Json(a))
}

/// Cancel an announcement
///
/// Removes a scheduled or active announcement. General rate-limit bucket.
#[utoipa::path(delete, path = "/api/v1/admin/announcements/{id}", tag = "Admin", operation_id = "admin_remove_announcement", params(("id" = String, Path, description = "Announcement identifier")), responses((status = 200, description = "The announcement is gone", body = OkResp), (status = 401, description = "Missing or unknown bearer token", body = crate::api::ApiErrorBody), (status = 404, description = "`Not found`: the caller is not a site administrator, or no such announcement", body = crate::api::ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", body = crate::api::ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn remove(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(id): Path<String>,
) -> Result<Json<OkResp>, ApiError> {
    require_site_admin(&user)?;
    let mut tx = state.db.begin().await?;
    if sqlx::query("DELETE FROM announcements WHERE id = $1")
        .bind(&id)
        .execute(&mut *tx)
        .await?
        .rows_affected()
        > 0
    {
        super::instance_audit::record_in(
            &mut tx,
            &user.username,
            "branding.change",
            Some(&id),
            serde_json::json!({"key":"announcements","action":"remove"}),
            state.clock.unix(),
        )
        .await?;
    }
    tx.commit().await?;
    super::brand::announce(&state).await;
    Ok(ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::test_util::{each_db, mem_user};
    use crate::db::now;

    #[tokio::test]
    async fn future_text_is_private_and_dismissals_follow_the_account() {
        for (state, temp) in each_db("announcement_feed").await {
            let t = now();
            let alice = || mem_user("alice", false);
            let admin = || Authed(mem_user("admin", true));
            let from = |start| {
                Json(Schedule {
                    starts_at: start,
                    ends_at: t + 3600,
                    message: format!("Notice {start}"),
                })
            };
            crate::db::NewUser::plain("alice").add(&state.db).await;
            assert!(
                schedule(State(state.clone()), Authed(alice()), from(0))
                    .await
                    .is_err()
            );
            let live = schedule(State(state.clone()), admin(), from(0))
                .await
                .expect("publish")
                .0;
            let _ = schedule(State(state.clone()), admin(), from(t + 600))
                .await
                .expect("schedule");
            let guest = active(State(state.clone()), MaybeAuthed(None))
                .await
                .expect("guest");
            assert_eq!(guest.announcements.len(), 1);
            assert_eq!(guest.announcements[0].id, live.id);
            assert_eq!(guest.next_change, Some(t + 600));
            for _ in 0..2 {
                let _ = dismiss(State(state.clone()), Authed(alice()), Path(live.id.clone()))
                    .await
                    .expect("dismiss");
            }
            assert!(
                active(State(state.clone()), MaybeAuthed(Some(alice())))
                    .await
                    .expect("account")
                    .announcements
                    .is_empty()
            );
            assert_eq!(
                active(
                    State(state.clone()),
                    MaybeAuthed(Some(mem_user("bob", false)))
                )
                .await
                .expect("other account")
                .announcements
                .len(),
                1
            );
            let _ = remove(State(state.clone()), admin(), Path(live.id))
                .await
                .expect("cancel");
            assert!(
                active(State(state.clone()), MaybeAuthed(None))
                    .await
                    .expect("removed")
                    .announcements
                    .is_empty()
            );
            temp.done(state).await;
        }
    }
}
