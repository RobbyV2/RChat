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
    /// The database answered a trivial query, or every connection of this copy is in use.
    pub db: bool,
    /// The realtime bus is healthy: always `true` without `REDIS_URL`; with it, this
    /// instance is publishing to and following the Redis stream and has caught up.
    pub bus: bool,
}

/// Check that the process is up
///
/// Liveness probe: answers 200 whenever the process can serve HTTP, without touching the
/// database. Served by every role, needs no authentication and is not rate limited.
#[utoipa::path(get, path = "/api/v1/health", tag = "Health", responses((status = 200, description = "Process is up", body = Health)), security(()))]
pub(crate) async fn health() -> Json<Health> {
    Json(Health { ok: true })
}

/// Check that the instance can take traffic
///
/// Readiness probe for load balancers: 200 when the database answers (or every database
/// connection of this copy is in use) and, when `REDIS_URL` is set, the realtime bus is
/// publishing, following and caught up; 503 otherwise, with the same body showing which part
/// failed. Served by every role, needs no authentication and is not rate limited.
#[utoipa::path(get, path = "/api/v1/ready", tag = "Health", responses((status = 200, description = "Database reachable and, when REDIS_URL is set, this instance can write to and read from the realtime bus and has caught up", body = Readiness), (status = 503, description = "Not ready to take traffic", body = Readiness)), security(()))]
pub(crate) async fn ready(State(state): State<AppState>) -> (StatusCode, Json<Readiness>) {
    let db = db_ready(&state.db).await;
    let bus = state.hub.ready();
    let ok = db && bus;
    let status = match ok {
        true => StatusCode::OK,
        false => StatusCode::SERVICE_UNAVAILABLE,
    };
    (status, Json(Readiness { ok, db, bus }))
}

/// Whether the database answers. A pool whose every connection is in use counts: the database
/// is answering this copy's other requests.
async fn db_ready(db: &crate::db::Db) -> bool {
    let full = || db.size() >= db.options().get_max_connections() && db.num_idle() == 0;
    if full() {
        return true;
    }
    match sqlx::query("SELECT 1").execute(db).await {
        Ok(_) => true,
        Err(sqlx::Error::PoolTimedOut) => full(),
        Err(_) => false,
    }
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/health", get(health))
        .route("/ready", get(ready))
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use sqlx::any::AnyPoolOptions;

    use super::db_ready;

    fn pool(wait: Duration) -> AnyPoolOptions {
        sqlx::any::install_default_drivers();
        AnyPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(wait)
    }

    #[tokio::test]
    async fn a_busy_pool_is_ready_and_a_missing_database_is_not() {
        let path = crate::db::temp_db_path("ready");
        let url = format!("sqlite://{}?mode=rwc", path.display());
        let db = pool(Duration::from_secs(5))
            .connect(&url)
            .await
            .expect("pool");
        assert!(db_ready(&db).await);
        let held = db.acquire().await.expect("the only connection");
        let started = Instant::now();
        assert!(
            db_ready(&db).await,
            "every connection is in use: the database answers"
        );
        assert!(started.elapsed() < Duration::from_secs(2));
        drop(held);
        db.close().await;
        assert!(!db_ready(&db).await, "closed");
        let _ = std::fs::remove_file(&path);
        let refused = pool(Duration::from_millis(500))
            .connect_lazy("postgres://rchat:pw@127.0.0.1:1/rchat")
            .expect("lazy pool");
        assert!(!db_ready(&refused).await, "nothing listens");
        let missing = pool(Duration::from_millis(500))
            .connect_lazy("sqlite:///nonexistent-rchat-dir/rchat.db?mode=ro")
            .expect("lazy pool");
        assert!(!db_ready(&missing).await, "no database file");
    }
}
