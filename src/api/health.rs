use axum::Json;
use axum::Router;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::get;
use serde::Serialize;
use utoipa::ToSchema;

use crate::state::AppState;

/// Liveness result.
#[derive(Serialize, ToSchema)]
pub struct Health {
    /// Always `true`.
    pub ok: bool,
}

/// Readiness result.
#[derive(Serialize, ToSchema)]
pub struct Readiness {
    /// `db` and `bus` are both `true`.
    pub ok: bool,
    /// The database answered a trivial query.
    pub db: bool,
    /// The realtime bus is healthy: always `true` without `REDIS_URL`; with it, this
    /// instance is publishing to and following the Redis stream and has caught up.
    pub bus: bool,
}

/// Check that the process is up
///
/// Liveness probe: answers 200 whenever the process can serve HTTP, without touching the
/// database. Served by every role, needs no authentication and is not rate limited.
#[utoipa::path(get, path = "/api/health", tag = "Health", responses((status = 200, description = "Process is up", body = Health)), security(()))]
pub(crate) async fn health() -> Json<Health> {
    Json(Health { ok: true })
}

/// Check that the instance can take traffic
///
/// Readiness probe for load balancers: 200 when the database answers and, when `REDIS_URL`
/// is set, the realtime bus is publishing, following and caught up; 503 otherwise, with the
/// same body showing which part failed. Served by every role, needs no authentication and is
/// not rate limited.
#[utoipa::path(get, path = "/api/ready", tag = "Health", responses((status = 200, description = "Database reachable and, when REDIS_URL is set, this instance can write to and read from the realtime bus and has caught up", body = Readiness), (status = 503, description = "Not ready to take traffic", body = Readiness)), security(()))]
pub(crate) async fn ready(State(state): State<AppState>) -> (StatusCode, Json<Readiness>) {
    let db = sqlx::query("SELECT 1").execute(&state.db).await.is_ok();
    let bus = state.hub.ready();
    let ok = db && bus;
    let status = match ok {
        true => StatusCode::OK,
        false => StatusCode::SERVICE_UNAVAILABLE,
    };
    (status, Json(Readiness { ok, db, bus }))
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/health", get(health))
        .route("/ready", get(ready))
}
