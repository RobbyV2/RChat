use std::sync::Arc;

use axum::body::to_bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};

use super::image::tests::{halves, png};
use super::*;
use crate::api::error::ReasonKind;
use crate::api::test_util::{done, mem_user, temp_state};
use crate::limits::Limits;
use crate::ws::WsEvent;

const WHOLE: CropQuery = CropQuery {
    x: None,
    y: None,
    size: None,
};

async fn account(state: &AppState, name: &str) {
    crate::db::NewUser::plain(name).add(&state.db).await;
}

async fn put(
    state: &AppState,
    by: &str,
    crop: CropQuery,
    headers: HeaderMap,
    body: Vec<u8>,
) -> Result<MeUpdated, ApiError> {
    put_my_avatar(
        State(state.clone()),
        Authed(mem_user(by, false)),
        Query(crop),
        headers,
        Body::from(body),
    )
    .await
    .map(|Json(me)| me)
}

async fn upload(state: &AppState, by: &str) -> String {
    put(state, by, WHOLE, HeaderMap::new(), png(&halves(120, 80)))
        .await
        .expect("upload")
        .user
        .avatar_image
        .expect("a picture id")
}

async fn remove(state: &AppState, by: &str) -> MeUpdated {
    delete_my_avatar(State(state.clone()), Authed(mem_user(by, false)))
        .await
        .expect("remove")
        .0
}

async fn served(state: &AppState, id: &str, size: &str, headers: HeaderMap) -> Response {
    get_avatar(
        State(state.clone()),
        headers,
        Path((id.to_string(), size.to_string())),
    )
    .await
    .unwrap_or_else(IntoResponse::into_response)
}

fn refusal<T>(res: Result<T, ApiError>) -> (u16, String, Option<ReasonKind>, Option<String>) {
    match res {
        Ok(_) => (200, String::new(), None, None),
        Err(ApiError(code, msg, reason)) => (
            code.as_u16(),
            msg,
            reason.as_ref().map(|r| r.kind),
            reason.and_then(|r| r.control.or(r.field)),
        ),
    }
}

async fn stored(state: &AppState) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM avatar_images")
        .fetch_one(&state.db)
        .await
        .expect("count")
}

#[tokio::test]
async fn an_upload_sets_the_picture_and_each_size_is_served_for_good() {
    let (state, path) = temp_state("avatar_upload").await;
    account(&state, "alice").await;
    let mut rx = state.hub.subscribe();
    let id = upload(&state, "alice").await;
    assert_eq!(id.len(), 32);
    assert!(matches!(
        rx.try_recv(),
        Ok(WsEvent::UserUpdated { user, scope: _ }) if user.avatar_image.as_deref() == Some(id.as_str())
    ));
    let account = crate::api::user_ref(&state.db, "alice").await;
    assert_eq!(account.avatar_image.as_deref(), Some(id.as_str()));
    assert_eq!(account.avatar_kind, crate::db::AvatarKind::Identicon);
    for side in SIZES {
        let res = served(&state, &id, &side.to_string(), HeaderMap::new()).await;
        assert_eq!(res.status(), StatusCode::OK);
        let headers = res.headers().clone();
        assert_eq!(headers[header::CONTENT_TYPE], "image/jpeg");
        assert_eq!(
            headers[header::CACHE_CONTROL],
            "public, max-age=31536000, immutable"
        );
        assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(headers["cross-origin-resource-policy"], "cross-origin");
        assert_eq!(
            headers[header::CONTENT_SECURITY_POLICY],
            "default-src 'none'; sandbox"
        );
        let etag = headers[header::ETAG].clone();
        let bytes = to_bytes(res.into_body(), usize::MAX).await.expect("body");
        let image = ::image::load_from_memory(&bytes).expect("an image");
        assert_eq!((image.width(), image.height()), (side, side));
        let mut again = HeaderMap::new();
        again.insert(header::IF_NONE_MATCH, etag);
        let fresh = served(&state, &id, &side.to_string(), again).await;
        assert_eq!(fresh.status(), StatusCode::NOT_MODIFIED);
        assert!(fresh.headers().contains_key(header::CACHE_CONTROL));
    }
    for (id, size) in [
        (id.as_str(), "100"),
        (id.as_str(), "064"),
        (&"0".repeat(32), "64"),
        ("../x", "64"),
        (&id.to_uppercase(), "64"),
    ] {
        let res = served(&state, id, size, HeaderMap::new()).await;
        assert_eq!(res.status(), StatusCode::NOT_FOUND, "{id} {size}");
    }
    done(state, path).await;
}

#[tokio::test]
async fn a_new_picture_replaces_the_one_before_and_removing_goes_back_to_the_built_in_avatar() {
    let (state, path) = temp_state("avatar_replace").await;
    account(&state, "alice").await;
    account(&state, "bob").await;
    let first = upload(&state, "alice").await;
    let second = upload(&state, "alice").await;
    let other = upload(&state, "bob").await;
    assert_ne!(first, second);
    assert_eq!(stored(&state).await, 2);
    let gone = served(&state, &first, "64", HeaderMap::new()).await;
    assert_eq!(gone.status(), StatusCode::NOT_FOUND);
    let mut rx = state.hub.subscribe();
    assert_eq!(remove(&state, "alice").await.user.avatar_image, None);
    assert!(matches!(
        rx.try_recv(),
        Ok(WsEvent::UserUpdated { user, scope: _ }) if user.avatar_image.is_none()
    ));
    assert_eq!(remove(&state, "alice").await.user.avatar_image, None);
    assert!(rx.try_recv().is_err(), "nothing changed, nothing is sent");
    assert_eq!(stored(&state).await, 1);
    let kept = served(&state, &other, "64", HeaderMap::new()).await;
    assert_eq!(kept.status(), StatusCode::OK);
    done(state, path).await;
}

#[tokio::test]
async fn the_crop_chooses_the_square_and_a_bad_crop_or_file_is_refused() {
    let (state, path) = temp_state("avatar_crop").await;
    account(&state, "alice").await;
    let source = png(&halves(200, 100));
    let left = CropQuery {
        x: Some(0),
        y: Some(0),
        size: Some(100),
    };
    let id = put(&state, "alice", left, HeaderMap::new(), source.clone())
        .await
        .expect("cropped")
        .user
        .avatar_image
        .expect("id");
    let res = served(&state, &id, "64", HeaderMap::new()).await;
    let bytes = to_bytes(res.into_body(), usize::MAX).await.expect("body");
    let image = ::image::load_from_memory(&bytes)
        .expect("image")
        .into_rgb8();
    assert!(
        image.pixels().all(|p| p.0[0] > 200 && p.0[2] < 60),
        "only the red half"
    );
    let outside = CropQuery {
        x: Some(150),
        y: Some(0),
        size: Some(100),
    };
    let partial = CropQuery {
        x: Some(1),
        y: None,
        size: Some(50),
    };
    for (crop, body, error, field) in [
        (
            outside,
            source.clone(),
            "The crop must be a square of at least 16 pixels inside the picture",
            "crop",
        ),
        (
            partial,
            source.clone(),
            "Send x, y and size together",
            "crop",
        ),
        (
            WHOLE,
            b"<svg xmlns='http://www.w3.org/2000/svg'/>".to_vec(),
            "The picture must be a PNG, JPEG, GIF or WebP image",
            "image",
        ),
    ] {
        assert_eq!(
            refusal(put(&state, "alice", crop, HeaderMap::new(), body).await),
            (
                400,
                error.to_string(),
                Some(ReasonKind::Invalid),
                Some(field.to_string())
            )
        );
    }
    assert_eq!(stored(&state).await, 1, "a refused upload stores nothing");
    done(state, path).await;
}

#[tokio::test]
async fn an_upload_over_the_limit_is_refused_with_the_limit() {
    let (mut state, path) = temp_state("avatar_limit").await;
    account(&state, "alice").await;
    state.limits = Arc::new(Limits {
        avatar_upload_max_mib: 1,
        ..Limits::default()
    });
    let over = vec![0u8; 1024 * 1024 + 1];
    let mut declared = HeaderMap::new();
    declared.insert(header::CONTENT_LENGTH, (over.len() as u64).into());
    let limit = |error: &str| {
        (
            413,
            error.to_string(),
            Some(ReasonKind::Limit),
            Some("avatar_upload_max_mib".to_string()),
        )
    };
    assert_eq!(
        refusal(put(&state, "alice", WHOLE, declared, over.clone()).await),
        limit("Picture exceeds 1MB limit")
    );
    assert_eq!(
        refusal(put(&state, "alice", WHOLE, HeaderMap::new(), over).await),
        limit("Picture exceeds the size limit")
    );
    assert_eq!(Limits::default().avatar_upload_max_mib, 8);
    assert_eq!(Limits::default().avatar_upload_bytes(), 8 * 1024 * 1024);
    done(state, path).await;
}

#[tokio::test]
async fn the_switch_stops_uploads_and_serving_but_not_removing() {
    let (state, path) = temp_state("avatar_switch").await;
    account(&state, "alice").await;
    assert!(Feature::ProfilePictures.default_on());
    assert!(Settings::cached(&state.db).await.profile_pictures);
    let id = upload(&state, "alice").await;
    sqlx::query("UPDATE settings SET value = '0' WHERE key = 'profile_pictures'")
        .execute(&state.db)
        .await
        .expect("off");
    Settings::forget(&state.db);
    assert_eq!(
        refusal(
            put(
                &state,
                "alice",
                WHOLE,
                HeaderMap::new(),
                png(&halves(64, 64))
            )
            .await
        ),
        (
            403,
            "Profile pictures are turned off on this site".to_string(),
            Some(ReasonKind::OffSite),
            Some("profile_pictures".to_string())
        )
    );
    let hidden = served(&state, &id, "64", HeaderMap::new()).await;
    assert_eq!(hidden.status(), StatusCode::NOT_FOUND);
    assert_eq!(remove(&state, "alice").await.user.avatar_image, None);
    assert_eq!(stored(&state).await, 0);
    done(state, path).await;
}

#[tokio::test]
async fn the_sweep_removes_only_old_pictures_nothing_names() {
    let (state, path) = temp_state("avatar_sweep").await;
    account(&state, "alice").await;
    let used = upload(&state, "alice").await;
    let picture = image::encode(&png(&halves(64, 64)), None).expect("picture");
    let mut conn = state.db.acquire().await.expect("conn");
    let old = store(&mut conn, "alice", None, &picture)
        .await
        .expect("old");
    let fresh = store(&mut conn, "alice", None, &picture)
        .await
        .expect("fresh");
    drop(conn);
    let t = now();
    sqlx::query("UPDATE avatar_images SET created_at = $1 WHERE id IN ($2, $3)")
        .bind(t - UNUSED_KEEP - 1)
        .bind(&old)
        .bind(&used)
        .execute(&state.db)
        .await
        .expect("aged");
    assert_eq!(sweep(&state.db, t).await.expect("sweep"), 1);
    let left: Vec<String> = sqlx::query_scalar("SELECT id FROM avatar_images ORDER BY id")
        .fetch_all(&state.db)
        .await
        .expect("left");
    let mut kept = vec![used, fresh];
    kept.sort();
    assert_eq!(left, kept);
    done(state, path).await;
}
