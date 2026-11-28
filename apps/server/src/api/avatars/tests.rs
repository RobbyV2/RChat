use std::sync::Arc;

use axum::body::to_bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};

use super::*;
use crate::api::error::ReasonKind;
use crate::api::test_util::{done, mem_user, temp_state};
use crate::db::now;
use crate::limits::Limits;
use crate::ws::WsEvent;
use rchat_avatar::samples::{halves, png, read};

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
        let (image, _) = read(&bytes).expect("an image");
        assert_eq!(image.dimensions(), (side, side));
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
    let (image, _) = read(&bytes).expect("image");
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
    let picture = Picture {
        still: rchat_avatar::encode(&png(&halves(64, 64)), None).expect("picture"),
        animated: None,
    };
    let mut conn = state.db.acquire().await.expect("conn");
    let old = store(&state.db, &mut conn, "alice", None, &picture)
        .await
        .expect("old");
    let fresh = store(&state.db, &mut conn, "alice", None, &picture)
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

async fn icon_of(state: &AppState, server: &str) -> Option<String> {
    sqlx::query_scalar("SELECT icon_image FROM servers WHERE name = $1")
        .bind(server)
        .fetch_one(&state.db)
        .await
        .expect("server")
}

#[tokio::test]
async fn a_manager_sets_and_removes_the_server_picture_and_others_are_refused() {
    let (state, path) = temp_state("server_icon").await;
    for name in ["alice", "bob", "carol"] {
        account(&state, name).await;
    }
    for sql in [
        "INSERT INTO servers(name, display_name, creator, created_at) VALUES('club', 'Club', 'alice', 1)",
        "INSERT INTO members(server, username, is_admin, joined_at) VALUES('club', 'alice', 1, 1)",
        "INSERT INTO members(server, username, joined_at) VALUES('club', 'bob', 1)",
    ] {
        sqlx::query(sql).execute(&state.db).await.expect("seed");
    }
    let set = |by: &'static str| {
        let state = state.clone();
        async move {
            put_server_icon(
                State(state),
                Authed(mem_user(by, false)),
                Path("club".to_string()),
                Query(WHOLE),
                HeaderMap::new(),
                Body::from(png(&halves(90, 90))),
            )
            .await
            .map(|Json(server)| server)
        }
    };
    let unset = |by: &'static str| {
        let state = state.clone();
        async move {
            delete_server_icon(
                State(state),
                Authed(mem_user(by, false)),
                Path("club".to_string()),
            )
            .await
            .map(|Json(server)| server)
        }
    };
    assert_eq!(
        refusal(set("bob").await).0,
        403,
        "a member without Manage server"
    );
    assert_eq!(refusal(unset("bob").await).0, 403);
    assert_eq!(
        refusal(set("carol").await).0,
        403,
        "an open server shows to anyone, and takes Manage server to change"
    );
    let unknown = put_server_icon(
        State(state.clone()),
        Authed(mem_user("alice", false)),
        Path("nowhere".to_string()),
        Query(WHOLE),
        HeaderMap::new(),
        Body::from(png(&halves(90, 90))),
    )
    .await;
    assert_eq!(refusal(unknown).0, 404);
    assert_eq!(stored(&state).await, 0);
    let mut rx = state.hub.subscribe();
    let server = set("alice").await.expect("set");
    let id = server.icon_image.clone().expect("a picture id");
    assert_eq!(icon_of(&state, "club").await.as_deref(), Some(id.as_str()));
    assert!(matches!(
        rx.try_recv(),
        Ok(WsEvent::ServerUpdated { server }) if server.icon_image.as_deref() == Some(id.as_str())
    ));
    let shown = served(&state, &id, "128", HeaderMap::new()).await;
    assert_eq!(shown.status(), StatusCode::OK);
    let again = set("alice").await.expect("replace");
    assert_ne!(again.icon_image.as_deref(), Some(id.as_str()));
    assert_eq!(stored(&state).await, 1, "the picture before is removed");
    let audited: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_log WHERE server = 'club' AND action = 'server.update'",
    )
    .fetch_one(&state.db)
    .await
    .expect("audit");
    assert_eq!(audited, 2);
    sqlx::query("UPDATE avatar_images SET created_at = 0")
        .execute(&state.db)
        .await
        .expect("aged");
    assert_eq!(
        sweep(&state.db, now()).await.expect("sweep"),
        0,
        "a server names it"
    );
    assert_eq!(unset("alice").await.expect("removed").icon_image, None);
    assert_eq!(icon_of(&state, "club").await, None);
    assert_eq!(stored(&state).await, 0);
    assert!(matches!(rx.try_recv(), Ok(WsEvent::ServerUpdated { .. })));
    assert!(matches!(rx.try_recv(), Ok(WsEvent::ServerUpdated { .. })));
    assert_eq!(
        unset("alice").await.expect("nothing to remove").icon_image,
        None
    );
    assert!(rx.try_recv().is_err(), "nothing changed, nothing is sent");
    done(state, path).await;
}

#[tokio::test]
async fn an_animated_upload_keeps_its_animation_within_the_bounds() {
    use rchat_avatar::samples::{frames, gif};
    let (mut state, path) = temp_state("avatar_animated").await;
    account(&state, "alice").await;
    let animated = |state: &AppState, count: u32| {
        let state = state.clone();
        async move {
            put(
                &state,
                "alice",
                WHOLE,
                HeaderMap::new(),
                gif(64, count, 100),
            )
            .await
        }
    };
    let id = animated(&state, 5)
        .await
        .expect("upload")
        .user
        .avatar_image
        .expect("id");
    assert!(id.ends_with("-a") && id.len() == 34, "{id}");
    let moving = |state: &AppState, id: &str, size: &str| {
        let (state, id, size) = (state.clone(), id.to_string(), size.to_string());
        async move {
            get_animated(State(state), HeaderMap::new(), Path((id, size)))
                .await
                .unwrap_or_else(IntoResponse::into_response)
        }
    };
    for size in ["128", "512"] {
        let res = moving(&state, &id, size).await;
        assert_eq!(res.status(), StatusCode::OK, "{size}");
        assert_eq!(res.headers()[header::CONTENT_TYPE], "image/gif");
        assert_eq!(
            res.headers()[header::CACHE_CONTROL],
            "public, max-age=31536000, immutable"
        );
        let bytes = to_bytes(res.into_body(), usize::MAX).await.expect("body");
        assert_eq!(frames(&bytes), 5);
    }
    assert_eq!(
        moving(&state, &id, "64").await.status(),
        StatusCode::NOT_FOUND
    );
    let still = served(&state, &id, "64", HeaderMap::new()).await;
    assert_eq!(
        still.status(),
        StatusCode::OK,
        "the stills are served as before"
    );
    let plain = upload(&state, "alice").await;
    assert!(!plain.ends_with("-a"));
    assert_eq!(
        moving(&state, &plain, "128").await.status(),
        StatusCode::NOT_FOUND
    );
    state.limits = Arc::new(Limits {
        avatar_animation_max_frames: 4,
        ..Limits::default()
    });
    assert_eq!(
        refusal(animated(&state, 5).await),
        (
            413,
            "The animation has too many frames: up to 4".to_string(),
            Some(ReasonKind::Limit),
            Some("avatar_animation_max_frames".to_string())
        )
    );
    state.limits = Arc::new(Limits::default());
    sqlx::query("UPDATE settings SET value = '0' WHERE key = 'animated_profile_pictures'")
        .execute(&state.db)
        .await
        .expect("off");
    Settings::forget(&state.db);
    let first_frame = animated(&state, 5)
        .await
        .expect("upload")
        .user
        .avatar_image
        .expect("id");
    assert!(!first_frame.ends_with("-a"), "only the still is kept");
    done(state, path).await;
}
