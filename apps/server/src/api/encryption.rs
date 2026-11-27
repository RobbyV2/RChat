use axum::Json;
use axum::extract::State;
use serde::Serialize;

use super::admin::require_site_admin;
use super::{ApiError, Authed};
use crate::crypt::ring::RingStatus;
use crate::state::AppState;

#[derive(Serialize)]
pub struct EncryptionView {
    #[serde(flatten)]
    pub status: RingStatus,
    /// `ready`; `first_need` (no key yet, the first switch makes the key file); `keys` (no key,
    /// and none can be made here); or `updating` (a copy of this site lacks a key or the build).
    pub readiness: &'static str,
    /// Whether the key file should be backed up.
    pub needs_backup: bool,
}

pub(crate) async fn admin_status(
    State(state): State<AppState>,
    Authed(user): Authed,
) -> Result<Json<EncryptionView>, ApiError> {
    require_site_admin(&user)?;
    let status = state
        .crypt
        .status(&state.db)
        .await
        .map_err(ApiError::internal)?;
    let readiness = state
        .crypt
        .readiness(crate::db::is_sqlite(&state.db), &state.hub.other_copies())
        .name();
    Ok(Json(EncryptionView {
        needs_backup: status.needs_backup(),
        status,
        readiness,
    }))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::extract::State;

    use super::admin_status;
    use crate::api::Authed;
    use crate::api::test_util::{mem_user, temp_state};
    use crate::crypt::Purpose;
    use crate::crypt::ring::{KeyConfig, Ring};

    #[tokio::test]
    async fn only_the_site_admin_reads_the_key_status_and_it_holds_no_key() {
        let (state, path) = temp_state("admin_encryption").await;
        let hidden = admin_status(State(state.clone()), Authed(mem_user("bob", false))).await;
        assert_eq!(hidden.err().map(|e| e.0.as_u16()), Some(404));
        let view = admin_status(State(state.clone()), Authed(mem_user("root", true)))
            .await
            .expect("status")
            .0;
        assert_eq!(
            (view.status.source.as_str(), view.readiness),
            ("none", "keys")
        );
        assert!(!view.needs_backup && view.status.fingerprints.is_empty());

        let ring = Arc::new(Ring::load(&KeyConfig::default(), path.to_str()).expect("ring"));
        let state = state.with_crypt(ring.clone());
        let view = admin_status(State(state.clone()), Authed(mem_user("root", true)))
            .await
            .expect("status")
            .0;
        assert_eq!(
            (view.status.source.as_str(), view.readiness),
            ("none", "first_need"),
            "beside a SQLite file the first switch makes the key"
        );
        assert_eq!(
            ring.ensure_ring(&state.db, false).await.expect("ring"),
            Ok(())
        );
        ring.data_key(&state.db, Purpose::Content)
            .await
            .expect("key");
        let view = admin_status(State(state.clone()), Authed(mem_user("root", true)))
            .await
            .expect("status")
            .0;
        assert_eq!(
            (view.status.source.as_str(), view.readiness),
            ("file", "ready")
        );
        assert!(view.needs_backup);
        let keys = format!("{}.keys", path.display());
        let secret = std::fs::read_to_string(&keys).expect("key file");
        let secret = secret.trim().split_once(':').expect("id:key").1;
        let sent = serde_json::to_string(&view).expect("json");
        assert!(!sent.contains(secret), "{sent}");
        assert!(sent.contains("\"fingerprints\":[\"k1:"), "{sent}");
        assert_eq!(view.status.data_keys.len(), 1);
        sqlx::query("INSERT INTO settings(key, value) VALUES('keys_backed_up_at', '5')")
            .execute(&state.db)
            .await
            .expect("mark");
        let view = admin_status(State(state.clone()), Authed(mem_user("root", true)))
            .await
            .expect("status")
            .0;
        assert!(!view.needs_backup);
        assert_eq!(view.status.backed_up_at, Some(5));
        let _ = std::fs::remove_file(keys);
    }
}
