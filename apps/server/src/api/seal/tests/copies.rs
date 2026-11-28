use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use serde_json::json;

use super::super::{RequireReq, Source, copy_place, put_required};
use super::{dm_of, dm_switch, staffed, switch, users};
use crate::api::test_util::{each_db_keyed, mem_user};
use crate::api::{Authed, MaybeAuthed};
use crate::db::{Db, is_sqlite};
use crate::state::AppState;

async fn require(state: &AppState, on: bool) {
    put_required(
        State(state.clone()),
        Authed(mem_user("root", true)),
        Json(RequireReq { on }),
    )
    .await
    .map(|_| ())
    .expect("site");
}

async fn set_bio(state: &AppState, who: &str, bio: serde_json::Value) -> Option<String> {
    crate::api::auth::patch_me(
        State(state.clone()),
        Authed(
            crate::db::get_user(&state.db, who)
                .await
                .expect("load")
                .expect("user"),
        ),
        Json(serde_json::from_value(json!({ "bio": bio })).expect("patch")),
    )
    .await
    .expect("patch")
    .0
    .bio
}

async fn shown_bio(state: &AppState, who: &str) -> Option<String> {
    let viewer = crate::db::get_user(&state.db, who).await.expect("load");
    crate::api::users::profile(
        State(state.clone()),
        MaybeAuthed(viewer),
        HeaderMap::new(),
        Path(who.to_string()),
        Query(serde_json::from_value(json!({})).expect("query")),
    )
    .await
    .expect("profile")
    .0
    .bio
}

/// The stored bio of `who`: its plain column and whether it has a record.
async fn stored_bio(db: &Db, who: &str) -> (Option<String>, bool) {
    let (plain, record): (Option<String>, Option<Vec<u8>>) =
        sqlx::query_as("SELECT bio, bio_sealed FROM users WHERE username = $1")
            .bind(who)
            .fetch_one(db)
            .await
            .expect("user");
    (plain, record.is_some())
}

#[tokio::test]
async fn bios_follow_the_site_requirement() {
    for (state, temp) in each_db_keyed("seal_bios").await {
        let db = &state.db;
        users(db, &["alice", "bob"]).await;
        assert_eq!(
            set_bio(&state, "alice", json!("plain about"))
                .await
                .as_deref(),
            Some("plain about")
        );
        assert_eq!(
            stored_bio(db, "alice").await,
            (Some("plain about".into()), false)
        );

        require(&state, true).await;
        assert_eq!(
            set_bio(&state, "alice", json!("sealed about"))
                .await
                .as_deref(),
            Some("sealed about")
        );
        assert_eq!(
            stored_bio(db, "alice").await,
            (None, true),
            "only the record"
        );
        assert_eq!(
            shown_bio(&state, "alice").await.as_deref(),
            Some("sealed about")
        );
        let me = crate::api::auth::me_payload(
            db,
            &crate::db::get_user(db, "alice")
                .await
                .expect("load")
                .expect("alice"),
        )
        .await
        .expect("me");
        assert_eq!(me.bio.as_deref(), Some("sealed about"));
        set_bio(&state, "bob", json!("bob's own")).await;
        assert_eq!(stored_bio(db, "bob").await, (None, true));
        assert_eq!(set_bio(&state, "bob", json!(null)).await, None);
        assert_eq!(stored_bio(db, "bob").await, (None, false), "cleared");

        set_bio(&state, "bob", json!("bob's own")).await;
        sqlx::query("UPDATE users SET bio_sealed = (SELECT bio_sealed FROM users WHERE username = 'bob') WHERE username = 'alice'")
            .execute(db)
            .await
            .expect("move");
        assert_eq!(
            shown_bio(&state, "alice").await,
            None,
            "a record moved to another account does not open"
        );

        require(&state, false).await;
        set_bio(&state, "alice", json!("plain again")).await;
        assert_eq!(
            stored_bio(db, "alice").await,
            (Some("plain again".into()), false)
        );
        assert_eq!(shown_bio(&state, "bob").await.as_deref(), Some("bob's own"));
        temp.done(state).await;
    }
}

async fn set_server_bio(state: &AppState, who: &str, bio: serde_json::Value) -> Option<String> {
    crate::api::profiles::patch_profile(
        State(state.clone()),
        Authed(mem_user(who, false)),
        Path("rchat".to_string()),
        Json(serde_json::from_value(json!({ "bio": bio })).expect("patch")),
    )
    .await
    .unwrap_or_else(|e| panic!("patch: {}", e.1))
    .0
    .bio
}

async fn own_server_bio(state: &AppState, who: &str) -> Option<String> {
    crate::api::profiles::get_profile(
        State(state.clone()),
        Authed(mem_user(who, false)),
        Path("rchat".to_string()),
    )
    .await
    .unwrap_or_else(|e| panic!("read: {}", e.1))
    .0
    .bio
}

/// The stored server bio of `who`: its plain column and whether it has a record.
async fn stored_server_bio(db: &Db, who: &str) -> (Option<String>, bool) {
    let (plain, record): (Option<String>, Option<Vec<u8>>) = sqlx::query_as(
        "SELECT bio, bio_sealed FROM member_profiles WHERE server = 'rchat' AND username = $1",
    )
    .bind(who)
    .fetch_one(db)
    .await
    .expect("profile");
    (plain, record.is_some())
}

#[tokio::test]
async fn server_bios_follow_the_switch_of_their_server() {
    for (state, temp) in each_db_keyed("seal_server_bios").await {
        let db = &state.db;
        users(db, &["alice", "bob"]).await;
        staffed(db).await;
        assert_eq!(
            set_server_bio(&state, "bob", json!("plain here"))
                .await
                .as_deref(),
            Some("plain here")
        );
        assert_eq!(
            stored_server_bio(db, "bob").await,
            (Some("plain here".into()), false)
        );

        switch(&state, "alice", true).await.expect("on");
        assert_eq!(
            stored_server_bio(db, "bob").await,
            (Some("plain here".into()), false),
            "what was stored before stays until it is written again"
        );
        assert_eq!(
            set_server_bio(&state, "bob", json!("sealed here"))
                .await
                .as_deref(),
            Some("sealed here")
        );
        assert_eq!(
            stored_server_bio(db, "bob").await,
            (None, true),
            "only the record"
        );
        assert_eq!(
            own_server_bio(&state, "bob").await.as_deref(),
            Some("sealed here")
        );
        assert_eq!(
            crate::api::profiles::bio_and_banner(db, "rchat", "bob")
                .await
                .unwrap_or_else(|e| panic!("card: {}", e.1))
                .0
                .as_deref(),
            Some("sealed here")
        );
        crate::api::profiles::patch_profile(
            State(state.clone()),
            Authed(mem_user("bob", false)),
            Path("rchat".to_string()),
            Json(serde_json::from_value(json!({ "banner_color": "#112233" })).expect("patch")),
        )
        .await
        .map(|_| ())
        .unwrap_or_else(|e| panic!("banner: {}", e.1));
        assert_eq!(
            own_server_bio(&state, "bob").await.as_deref(),
            Some("sealed here"),
            "a change of another part keeps it"
        );
        assert_eq!(stored_server_bio(db, "bob").await, (None, true));

        set_server_bio(&state, "alice", json!("alice here")).await;
        sqlx::query("UPDATE member_profiles SET bio_sealed = (SELECT bio_sealed FROM member_profiles WHERE username = 'alice') WHERE username = 'bob'")
            .execute(db)
            .await
            .expect("move");
        assert_eq!(
            own_server_bio(&state, "bob").await,
            None,
            "a record moved to another member does not open"
        );

        assert_eq!(set_server_bio(&state, "alice", json!(null)).await, None);
        let left: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM member_profiles WHERE username = 'alice' AND (bio IS NOT NULL OR bio_sealed IS NOT NULL)",
        )
        .fetch_one(db)
        .await
        .expect("count");
        assert_eq!(left, 0, "cleared");

        switch(&state, "alice", false).await.expect("off");
        set_server_bio(&state, "bob", json!("plain again")).await;
        assert_eq!(
            stored_server_bio(db, "bob").await,
            (Some("plain again".into()), false)
        );

        require(&state, true).await;
        set_server_bio(&state, "bob", json!("the site requires it")).await;
        assert_eq!(stored_server_bio(db, "bob").await, (None, true));
        assert_eq!(
            own_server_bio(&state, "bob").await.as_deref(),
            Some("the site requires it")
        );
        temp.done(state).await;
    }
}

#[tokio::test]
async fn a_copy_follows_its_server_its_dm_or_the_site() {
    for (state, temp) in each_db_keyed("seal_copy_place").await {
        let db = &state.db;
        staffed(db).await;
        users(db, &["alice", "bob"]).await;
        let dm = dm_of(&state, "alice", "bob").await;
        let on = |state: AppState, source: Source<'static>| async move {
            let mut conn = state.db.acquire().await.expect("conn");
            copy_place(&mut conn, is_sqlite(&state.db), source)
                .await
                .expect("place")
                .floor()
                .is_some()
        };
        let all = || {
            [
                Source::Server("rchat"),
                Source::Dm(dm),
                Source::Site,
                Source::Server("gone"),
                Source::Dm(-1),
            ]
        };
        for source in all() {
            assert!(!on(state.clone(), source).await, "{source:?} is off");
        }
        switch(&state, "alice", true).await.expect("server");
        dm_switch(&state, dm, "bob", true).await.expect("dm");
        let mut seen = Vec::new();
        for source in all() {
            seen.push(on(state.clone(), source).await);
        }
        assert_eq!(seen, [true, true, false, false, false]);
        switch(&state, "alice", false).await.expect("server off");
        dm_switch(&state, dm, "bob", false).await.expect("dm off");
        require(&state, true).await;
        for source in all() {
            assert!(
                on(state.clone(), source).await,
                "{source:?} follows the site"
            );
        }
        temp.done(state).await;
    }
}
