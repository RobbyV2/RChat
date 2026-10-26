use axum::Json;
use axum::Router;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::get;
use serde::Serialize;
use utoipa::ToSchema;

use crate::state::AppState;

#[derive(Serialize, ToSchema)]
pub struct Health {
    pub ok: bool,
}

#[derive(Serialize, ToSchema)]
pub struct Readiness {
    pub ok: bool,
    pub db: bool,
    pub bus: bool,
}

#[utoipa::path(get, path = "/api/health", responses((status = 200, description = "Process is up", body = Health)))]
pub(crate) async fn health() -> Json<Health> {
    Json(Health { ok: true })
}

#[utoipa::path(get, path = "/api/ready", responses((status = 200, description = "Database reachable and, when REDIS_URL is set, this instance can write to and read from the realtime bus and has caught up", body = Readiness), (status = 503, description = "Not ready to take traffic", body = Readiness)))]
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
