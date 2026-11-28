use axum::Json;
use axum::extract::State;
use serde::{Deserialize, Serialize};

use super::admin::require_site_admin;
use super::reauth::{AuthedSession, Purpose, ReAuth, ReAuthBody, check};
use super::seal::SealJob;
use super::{ApiError, Authed};
use crate::crypt::ring::{BACKED_UP_SETTING, RingStatus};
use crate::db::Db;
use crate::state::AppState;

/// The encryption state of the instance. It never holds key material.
#[derive(Serialize, utoipa::ToSchema)]
#[schema(as = AdminEncryption)]
pub struct EncryptionView {
    #[serde(flatten)]
    pub status: RingStatus,
    /// `ready`; `first_need` (no key yet, the first switch makes the key file); `keys` (no key,
    /// and none can be made here); or `updating` (a copy of this site lacks a key or the build).
    pub readiness: &'static str,
    /// Whether the key file should be backed up.
    pub needs_backup: bool,
    /// Whether the site requires encrypted storage, and whether the server configuration sets
    /// that.
    pub required: crate::api::seal::RequiredView,
    /// Stored records that did not open since this copy started.
    pub unreadable: u64,
    /// Whether "every copy runs this build" is confirmed; left out where nobody has to confirm.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub copies_confirmed: Option<bool>,
    /// The servers and DMs whose new messages are stored encrypted.
    pub places: SealedPlaces,
    /// The newest jobs that encrypt or decrypt stored messages.
    pub jobs: Vec<SealJob>,
    /// The data key rotation that runs, or that left records under the old keys.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rotation: Option<crate::api::seal::rotate::RotationView>,
}

/// How many places store new messages encrypted.
#[derive(Clone, Copy, Debug, Serialize, utoipa::ToSchema)]
pub struct SealedPlaces {
    /// Servers.
    pub servers: i64,
    /// DMs.
    pub dms: i64,
}

/// How long the counted places are shown before they are counted again: the page asks every
/// 2 seconds while a job runs.
const PLACES_FOR: std::time::Duration = std::time::Duration::from_secs(30);

type Counted = std::collections::HashMap<String, (tokio::time::Instant, SealedPlaces)>;

static PLACES: std::sync::Mutex<Option<Counted>> = std::sync::Mutex::new(None);

async fn sealed_places(db: &Db) -> sqlx::Result<SealedPlaces> {
    let key = crate::db::pool_key(db);
    let cached = PLACES
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get_or_insert_with(Counted::new)
        .get(&key)
        .filter(|(at, _)| at.elapsed() < PLACES_FOR)
        .map(|(_, places)| *places);
    if let Some(places) = cached {
        return Ok(places);
    }
    let places = count_places(db).await?;
    PLACES
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get_or_insert_with(Counted::new)
        .insert(key, (tokio::time::Instant::now(), places));
    Ok(places)
}

async fn count_places(db: &Db) -> sqlx::Result<SealedPlaces> {
    let servers =
        sqlx::query_scalar("SELECT COUNT(*) FROM servers WHERE seal <> 0 OR seal_forced <> 0")
            .fetch_one(db)
            .await?;
    let dms = sqlx::query_scalar("SELECT COUNT(*) FROM dms WHERE seal <> 0")
        .fetch_one(db)
        .await?;
    Ok(SealedPlaces { servers, dms })
}

/// Get the encryption state
///
/// Where the instance's keys come from, their fingerprints, whether the key file is backed up,
/// whether the site requires encrypted storage, how many places store messages encrypted, and
/// the newest jobs and key rotation. It never holds key material. General rate-limit bucket.
#[utoipa::path(get, path = "/api/v1/admin/encryption", tag = "Admin", operation_id = "admin_encryption", responses((status = 200, description = "The encryption state", body = EncryptionView), (status = 401, description = "Missing or unknown bearer token", body = crate::api::ApiErrorBody), (status = 404, description = "`Not found`: the caller is not a site administrator", body = crate::api::ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", body = crate::api::ApiErrorBody)), security(("bearer" = [])))]
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
    let readiness = match crate::api::seal::copies(&state).await? {
        Some(false) => crate::api::seal::readiness(&state).await?.name(),
        Some(true) | None => state
            .crypt
            .readiness(crate::db::is_sqlite(&state.db), &state.hub.other_copies())
            .name(),
    };
    Ok(Json(EncryptionView {
        needs_backup: status.needs_backup(),
        status,
        readiness,
        required: crate::api::seal::required_view(&state).await?,
        unreadable: state.crypt.unreadable(),
        copies_confirmed: crate::api::seal::copies(&state).await?,
        places: sealed_places(&state.db).await?,
        jobs: crate::api::seal::jobs::recent(&state.db).await?,
        rotation: crate::api::seal::rotate::current(&state.db)
            .await?
            .map(|r| r.view()),
    }))
}

/// What "Rotate data keys" takes: the purposes (every one when left out) and the confirmation.
#[derive(Deserialize, utoipa::ToSchema)]
pub struct RotateReq {
    /// `content`, `media`, `secrets`, `search` or `bus`; every purpose when left out.
    pub purposes: Option<Vec<String>>,
    /// How the caller confirms it is them.
    pub reauth: ReAuthBody,
}

const BAD_PURPOSE: &str = "purposes must be content, media, secrets, search or bus";

/// Rotate data keys
///
/// `POST /api/v1/admin/encryption/rotate`: "Rotate data keys", after confirming it is you.
#[utoipa::path(post, path = "/api/v1/admin/encryption/rotate", tag = "Admin", operation_id = "admin_rotate_keys", request_body = RotateReq, responses((status = 200, description = "The rotation that started", body = crate::api::seal::rotate::Rotation), (status = 400, description = "`purposes must be content, media, secrets, search or bus`, or malformed JSON (plain-text framework error)", body = crate::api::ApiErrorBody), (status = 401, description = "Missing or unknown bearer token, or a confirmation that does not match", body = crate::api::ApiErrorBody), (status = 404, description = "`Not found`: the caller is not a site administrator", body = crate::api::ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", body = crate::api::ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn post_rotate(
    State(state): State<AppState>,
    AuthedSession(session): AuthedSession,
    Json(RotateReq { purposes, reauth }): Json<RotateReq>,
) -> Result<Json<crate::api::seal::rotate::Rotation>, ApiError> {
    require_site_admin(&session.user)?;
    let purposes = match purposes {
        None => crate::crypt::Purpose::ALL.to_vec(),
        Some(names) => names
            .iter()
            .map(|n| {
                crate::crypt::Purpose::parse(n)
                    .ok_or_else(|| ApiError::invalid(BAD_PURPOSE, "purposes"))
            })
            .collect::<Result<_, _>>()?,
    };
    check(
        &state,
        &session,
        ReAuth::try_from(reauth)?,
        Purpose::RotateKeys,
    )
    .await?;
    let rotation = crate::api::seal::rotate::start(&state, &purposes).await?;
    super::instance_audit::record_in(
        &mut *state.db.acquire().await?,
        &session.user.username,
        "encryption.rotate",
        None,
        serde_json::json!({"purposes": rotation.purposes}),
        state.clock.unix(),
    )
    .await?;
    Ok(Json(rotation))
}

/// What "Key copy saved" takes.
#[derive(Deserialize, utoipa::ToSchema)]
pub struct BackedUpReq {
    /// How the caller confirms it is them.
    pub reauth: ReAuthBody,
}

/// Answer of `PUT /api/v1/admin/encryption/backed_up`.
#[derive(Serialize, utoipa::ToSchema)]
pub struct BackedUpView {
    /// Unix seconds.
    pub backed_up_at: i64,
}

/// Confirm the key copy is saved
///
/// `PUT /api/v1/admin/encryption/backed_up`: "Key copy saved", after confirming it is you.
#[utoipa::path(put, path = "/api/v1/admin/encryption/backed_up", tag = "Admin", operation_id = "admin_keys_backed_up", request_body = BackedUpReq, responses((status = 200, description = "When it was confirmed", body = BackedUpView), (status = 400, description = "Malformed JSON (plain-text framework error)", body = crate::api::ApiErrorBody), (status = 401, description = "Missing or unknown bearer token, or a confirmation that does not match", body = crate::api::ApiErrorBody), (status = 404, description = "`Not found`: the caller is not a site administrator", body = crate::api::ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", body = crate::api::ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn put_backed_up(
    State(state): State<AppState>,
    AuthedSession(session): AuthedSession,
    Json(BackedUpReq { reauth }): Json<BackedUpReq>,
) -> Result<Json<BackedUpView>, ApiError> {
    require_site_admin(&session.user)?;
    check(
        &state,
        &session,
        ReAuth::try_from(reauth)?,
        Purpose::KeysSaved,
    )
    .await?;
    let at = state.clock.unix();
    let mut tx = state.db.begin().await?;
    sqlx::query("INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(BACKED_UP_SETTING)
        .bind(at.to_string())
        .execute(&mut *tx)
        .await?;
    super::instance_audit::record_in(
        &mut tx,
        &session.user.username,
        "encryption.backed_up",
        None,
        serde_json::json!({}),
        at,
    )
    .await?;
    tx.commit().await?;
    Ok(Json(BackedUpView { backed_up_at: at }))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::Json;
    use axum::extract::State;
    use serde_json::json;

    use super::{BackedUpReq, admin_status, put_backed_up};
    use crate::api::Authed;
    use crate::api::reauth::{AuthedSession, Session};
    use crate::api::test_util::{mem_user, temp_state};
    use crate::crypt::Purpose;
    use crate::crypt::ring::{KeyConfig, Ring};
    use crate::state::AppState;

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
        assert_eq!(
            view.status
                .data_keys
                .iter()
                .map(|k| k.purpose.as_str())
                .collect::<Vec<_>>(),
            ["secrets", "content"]
        );
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

    const PASSWORD: &str = "correct horse battery staple";

    async fn saved(state: &AppState, who: &str, password: &str, n: u32) -> Option<u16> {
        let user = crate::db::get_user(&state.db, who)
            .await
            .expect("load")
            .expect("user");
        let session = Session {
            user,
            token: format!("keys-saved-{who}-{n}"),
            created_at: crate::db::now(),
        };
        let body: BackedUpReq =
            serde_json::from_value(json!({"reauth": {"password": password}})).expect("body");
        put_backed_up(State(state.clone()), AuthedSession(session), Json(body))
            .await
            .err()
            .map(|e| e.0.as_u16())
    }

    #[tokio::test]
    async fn the_key_copy_is_marked_saved_by_the_site_admin_after_a_confirmation() {
        let (state, _path) = temp_state("admin_keys_saved").await;
        let db = &state.db;
        let hash = crate::api::auth::hash_password(PASSWORD)
            .await
            .expect("hash");
        for name in ["root", "bob"] {
            crate::db::NewUser::plain(name).hash(&hash).add(db).await;
        }
        sqlx::query("UPDATE users SET is_site_admin = 1 WHERE username = 'root'")
            .execute(db)
            .await
            .expect("admin");
        let marked = || async {
            sqlx::query_scalar::<_, String>(
                "SELECT value FROM settings WHERE key = 'keys_backed_up_at'",
            )
            .fetch_optional(db)
            .await
            .expect("read")
        };
        assert_eq!(saved(&state, "bob", PASSWORD, 0).await, Some(404));
        assert_eq!(saved(&state, "root", "wrong", 1).await, Some(401));
        assert_eq!(marked().await, None);
        assert_eq!(saved(&state, "root", PASSWORD, 2).await, None);
        let at: i64 = marked().await.expect("marked").parse().expect("seconds");
        let view = admin_status(State(state.clone()), Authed(mem_user("root", true)))
            .await
            .expect("status")
            .0;
        assert_eq!(view.status.backed_up_at, Some(at));
        let audited: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM instance_audit WHERE action = 'encryption.backed_up' AND actor = 'root'",
        )
        .fetch_one(db)
        .await
        .expect("audit");
        assert_eq!(audited, 1);
    }

    #[tokio::test]
    async fn the_status_counts_the_places_that_store_encrypted_and_lists_the_newest_jobs() {
        let (state, _path) = temp_state("admin_places").await;
        let db = &state.db;
        for name in ["alice", "bob"] {
            crate::db::NewUser::plain(name).add(db).await;
        }
        sqlx::query("INSERT INTO dms(user_a, user_b, seal) VALUES('alice', 'bob', 41)")
            .execute(db)
            .await
            .expect("dm");
        sqlx::query("UPDATE servers SET seal_forced = 17 WHERE name = 'rchat'")
            .execute(db)
            .await
            .expect("forced");
        for (place, state) in [("s:rchat", "done"), ("*", "running")] {
            sqlx::query("INSERT INTO seal_jobs(place, direction, upto_id, state, created_at) VALUES($1, 'seal', 10, $2, 1)")
                .bind(place)
                .bind(state)
                .execute(db)
                .await
                .expect("job");
        }
        let view = admin_status(State(state.clone()), Authed(mem_user("root", true)))
            .await
            .expect("status")
            .0;
        assert_eq!((view.places.servers, view.places.dms), (1, 1));
        assert_eq!(
            view.jobs
                .iter()
                .map(|j| j.place.as_str())
                .collect::<Vec<_>>(),
            ["*", "s:rchat"]
        );
    }
}
