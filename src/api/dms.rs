use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use serde::Deserialize;
use sqlx::Row;
use utoipa::ToSchema;

use crate::api::{ApiError, Authed, DmSummary, user_ref};
use crate::db::get_user;
use crate::state::AppState;
use crate::ws::WsEvent;

#[derive(Deserialize, ToSchema)]
pub struct OpenDmReq {
    username: String,
}

#[utoipa::path(get, path = "/api/dms", responses((status = 200, body = Vec<DmSummary>)), security(("bearer" = [])))]
pub(crate) async fn list_dms(
    State(state): State<AppState>,
    Authed(user): Authed,
) -> Result<Json<Vec<DmSummary>>, ApiError> {
    let rows = sqlx::query(
        "SELECT id, user_a, user_b FROM dms WHERE user_a = $1 OR user_b = $2 ORDER BY id",
    )
    .bind(&user.username)
    .bind(&user.username)
    .fetch_all(&state.db)
    .await?;
    let mut dms = Vec::with_capacity(rows.len());
    for r in &rows {
        let (id, a, b): (i64, String, String) = (r.try_get(0)?, r.try_get(1)?, r.try_get(2)?);
        let is_self = a == b;
        let other = match a == user.username {
            true => b,
            false => a,
        };
        dms.push(DmSummary {
            id,
            other: user_ref(&state.db, &other).await,
            is_self,
        });
    }
    Ok(Json(dms))
}

#[utoipa::path(post, path = "/api/dms", request_body = OpenDmReq, responses((status = 200, body = DmSummary)), security(("bearer" = [])))]
pub(crate) async fn open_dm(
    State(state): State<AppState>,
    Authed(user): Authed,
    Json(req): Json<OpenDmReq>,
) -> Result<Json<DmSummary>, ApiError> {
    let OpenDmReq { username } = req;
    let target = username.to_lowercase();
    match get_user(&state.db, &target).await? {
        Some(_) => {}
        None => {
            return Err(ApiError(
                StatusCode::NOT_FOUND,
                "User not found".to_string(),
            ));
        }
    }
    let (a, b) = match user.username <= target {
        true => (user.username.clone(), target.clone()),
        false => (target.clone(), user.username.clone()),
    };
    let existing: Option<i64> =
        match sqlx::query("SELECT id FROM dms WHERE user_a = $1 AND user_b = $2")
            .bind(&a)
            .bind(&b)
            .fetch_optional(&state.db)
            .await?
        {
            Some(r) => Some(r.try_get(0)?),
            None => None,
        };
    let (id, created) = match existing {
        Some(id) => (id, false),
        None => {
            let id: i64 =
                sqlx::query("INSERT INTO dms(user_a, user_b) VALUES($1, $2) RETURNING id")
                    .bind(&a)
                    .bind(&b)
                    .fetch_one(&state.db)
                    .await?
                    .try_get(0)?;
            (id, true)
        }
    };
    let dm = DmSummary {
        id,
        other: user_ref(&state.db, &target).await,
        is_self: a == b,
    };
    if created {
        state.hub.broadcast(WsEvent::DmCreated {
            dm_users: vec![a, b],
        });
    }
    Ok(Json(dm))
}
