use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use sqlx::Row;

use super::*;
use crate::api::categories::{
    create_category, current_layout, delete_category, rename_category, reorder_layout, seen_part,
};
use crate::api::servers::{create_channel, get_server};
use crate::api::test_util::{add_member, each_db, mem_user};
use crate::api::{CategoryStyle, LayoutCategory, MaybeAuthed, SeparatorStyle};
use crate::limits::Limits;
use crate::ws::WsEvent;

fn body<T: serde::de::DeserializeOwned>(v: serde_json::Value) -> Json<T> {
    Json(serde_json::from_value(v).expect("body"))
}

fn who(name: &str) -> Authed {
    Authed(mem_user(name, false))
}

fn rchat() -> Path<String> {
    Path("rchat".to_string())
}

async fn id_of(db: &crate::db::Db, sql: &str) -> i64 {
    sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
        .fetch_one(db)
        .await
        .expect(sql)
        .try_get(0)
        .expect("id")
}

async fn new_separator(
    state: &AppState,
    by: &str,
    v: serde_json::Value,
) -> Result<Separator, ApiError> {
    create_separator(State(state.clone()), who(by), rchat(), body(v))
        .await
        .map(|Json(s)| s)
}

async fn channel(state: &AppState, name: &str, category: Option<i64>, private: bool) -> i64 {
    create_channel(
        State(state.clone()),
        who("alice"),
        rchat(),
        body(
            serde_json::json!({ "name": name, "category_id": category, "restrict_view": private }),
        ),
    )
    .await
    .expect("channel")
    .0
    .id
}

async fn layout(state: &AppState) -> ChannelLayout {
    current_layout(&state.db, "rchat")
        .await
        .expect("layout")
        .expect("server")
}

fn places(layout: &ChannelLayout) -> Vec<(i64, Option<i64>, i64)> {
    layout
        .separators
        .iter()
        .map(|s| (s.id, s.category_id, s.after))
        .collect()
}

async fn detail(state: &AppState, by: &str) -> crate::api::ServerDetail {
    get_server(
        State(state.clone()),
        MaybeAuthed(Some(mem_user(by, false))),
        HeaderMap::new(),
        rchat(),
    )
    .await
    .expect("server")
    .0
}

#[tokio::test]
async fn separators_sit_between_channels_and_move_with_the_layout() {
    for (state, temp) in each_db("separators_layout").await {
        let db = &state.db;
        add_member(db, "rchat", "alice", 1, 0, 0).await;
        let general = id_of(db, "SELECT id FROM channels WHERE server = 'rchat'").await;
        let team = create_category(
            State(state.clone()),
            who("alice"),
            rchat(),
            body(serde_json::json!({ "name": "Team", "style": "dots" })),
        )
        .await
        .expect("team")
        .0;
        assert_eq!(team.style, CategoryStyle::Dots);
        let plans = channel(&state, "plans", Some(team.id), false).await;
        let mut rx = state.hub.subscribe();
        let news = new_separator(
            &state,
            "alice",
            serde_json::json!({ "label": "  \u{27a4} Updates \u{2605}  " }),
        )
        .await
        .expect("news");
        assert_eq!(
            (
                news.label.as_str(),
                news.style,
                news.category_id,
                news.after
            ),
            ("\u{27a4} Updates \u{2605}", SeparatorStyle::Dots, None, 1),
            "trimmed, symbols and casing kept, below the channel above it"
        );
        match rx.try_recv() {
            Ok(WsEvent::LayoutChanged { layout, .. }) => {
                assert_eq!(layout.separators, std::slice::from_ref(&news));
            }
            _ => panic!("expected layout_changed"),
        }
        let rule = new_separator(
            &state,
            "alice",
            serde_json::json!({ "style": "line", "category_id": team.id }),
        )
        .await
        .expect("rule");
        assert_eq!(
            (rule.label.as_str(), rule.category_id, rule.after),
            ("", Some(team.id), 1)
        );
        let later = channel(&state, "later", None, false).await;
        let now = layout(&state).await;
        assert_eq!(now.uncategorized, [general, later]);
        assert_eq!(
            places(&now),
            [(news.id, None, 1), (rule.id, Some(team.id), 1)],
            "a new channel lists below the separators of its list"
        );
        let moved = reorder_layout(
            State(state.clone()),
            who("alice"),
            rchat(),
            body(serde_json::json!({
                "version": now.version,
                "uncategorized": [later, general],
                "categories": [{ "id": team.id, "channels": [plans] }],
                "separators": [
                    { "id": rule.id, "category_id": null, "after": 0 },
                    { "id": news.id, "category_id": team.id, "after": 0 },
                ],
            })),
        )
        .await
        .expect("reorder")
        .0;
        assert_eq!(
            places(&moved),
            [(rule.id, None, 0), (news.id, Some(team.id), 0)]
        );
        assert_eq!(places(&layout(&state).await), places(&moved), "stored");
        let kept = reorder_layout(
            State(state.clone()),
            who("alice"),
            rchat(),
            body(serde_json::json!({
                "version": moved.version,
                "uncategorized": [general, later],
                "categories": [{ "id": team.id, "channels": [plans] }],
            })),
        )
        .await
        .expect("reorder without separators")
        .0;
        assert_eq!(
            places(&kept),
            places(&moved),
            "an order without separators keeps them"
        );
        let edited = update_separator(
            State(state.clone()),
            who("alice"),
            Path(news.id),
            body(serde_json::json!({ "label": "News", "style": "plain" })),
        )
        .await
        .expect("edit")
        .0;
        assert_eq!(
            (edited.label.as_str(), edited.style, edited.category_id),
            ("News", SeparatorStyle::Plain, Some(team.id))
        );
        let _ = rename_category(
            State(state.clone()),
            who("alice"),
            Path(team.id),
            body(serde_json::json!({ "name": "Crew" })),
        )
        .await
        .expect("rename");
        assert_eq!(
            layout(&state).await.categories[0].style,
            CategoryStyle::Dots,
            "a rename without a style keeps it"
        );
        let _ = delete_category(State(state.clone()), who("alice"), Path(team.id))
            .await
            .expect("delete category");
        let after = layout(&state).await;
        assert_eq!(after.uncategorized, [general, later, plans]);
        assert_eq!(
            places(&after),
            [(rule.id, None, 0), (news.id, None, 2)],
            "the separators of a deleted category follow its channels out"
        );
        let _ = delete_separator(State(state.clone()), who("alice"), Path(rule.id))
            .await
            .expect("delete");
        assert_eq!(places(&layout(&state).await), [(news.id, None, 2)]);
        let actions: Vec<String> = sqlx::query(
            "SELECT action FROM audit_log WHERE action LIKE 'channel.separator%' ORDER BY id",
        )
        .fetch_all(db)
        .await
        .expect("audit")
        .iter()
        .map(|r| r.try_get(0).expect("action"))
        .collect();
        assert_eq!(
            actions,
            [
                "channel.separator_create",
                "channel.separator_create",
                "channel.separator_update",
                "channel.separator_delete"
            ]
        );
        temp.done(state).await;
    }
}

#[tokio::test]
async fn separators_follow_what_each_viewer_sees() {
    for (state, temp) in each_db("separators_seen").await {
        let db = &state.db;
        add_member(db, "rchat", "alice", 1, 0, 0).await;
        add_member(db, "rchat", "bob", 0, 0, 0).await;
        let general = id_of(db, "SELECT id FROM channels WHERE server = 'rchat'").await;
        let staff = channel(&state, "staff", None, true).await;
        let top = new_separator(&state, "alice", serde_json::json!({ "label": "Top" }))
            .await
            .expect("top");
        let hush = create_category(
            State(state.clone()),
            who("alice"),
            rchat(),
            body(serde_json::json!({ "name": "Hush" })),
        )
        .await
        .expect("hush")
        .0;
        let _ = channel(&state, "secret", Some(hush.id), true).await;
        let inner = new_separator(
            &state,
            "alice",
            serde_json::json!({ "label": "Inner", "category_id": hush.id }),
        )
        .await
        .expect("inner");
        let mine = detail(&state, "alice").await;
        assert_eq!(
            mine.separators
                .iter()
                .map(|s| (s.id, s.after))
                .collect::<Vec<_>>(),
            [(top.id, 2), (inner.id, 1)]
        );
        let bobs = detail(&state, "bob").await;
        assert!(
            bobs.categories.is_empty(),
            "the hidden category is left out"
        );
        assert_eq!(
            bobs.separators
                .iter()
                .map(|s| (s.id, s.after))
                .collect::<Vec<_>>(),
            [(top.id, 1)],
            "only the separator of a list bob sees, after the channels he sees"
        );
        let full = layout(&state).await;
        let seen = seen_part(&full, |c| c == general, false);
        assert_eq!(seen.separators.len(), 1);
        assert_eq!(seen.version, bobs.layout_version);
        assert_ne!(
            seen.version,
            seen_part(&full, |c| c == general || c == staff, false).version
        );
        let shown = seen_part(&full, |c| c == general, true);
        assert_eq!(shown.categories.len(), 1);
        assert_eq!(
            (shown.separators[1].id, shown.separators[1].after),
            (inner.id, 0)
        );
        temp.done(state).await;
    }
}

#[tokio::test]
async fn separator_writes_check_the_label_the_cap_and_who_asks() {
    for (state, temp) in each_db("separators_checks").await {
        let db = &state.db;
        add_member(db, "rchat", "alice", 1, 0, 0).await;
        add_member(db, "rchat", "bob", 0, 0, 0).await;
        let status = |r: Result<Separator, ApiError>| r.map(|_| ()).map_err(|ApiError(c, _, _)| c);
        let long = "x".repeat(NAME_MAX + 1);
        for bad in [long.as_str(), "line\nbreak"] {
            let Err(ApiError(code, _, reason)) =
                new_separator(&state, "alice", serde_json::json!({ "label": bad })).await
            else {
                panic!("{bad:?} is refused");
            };
            assert_eq!(code, StatusCode::BAD_REQUEST, "{bad:?}");
            assert_eq!(
                reason.and_then(|r| r.field).as_deref(),
                Some("label"),
                "{bad:?}"
            );
        }
        let stars = "\u{2605}".repeat(NAME_MAX);
        let ok = new_separator(&state, "alice", serde_json::json!({ "label": stars }))
            .await
            .expect("100 characters");
        assert_eq!(
            status(new_separator(&state, "bob", serde_json::json!({})).await),
            Err(StatusCode::FORBIDDEN)
        );
        let edit = |by: &str, id: i64| {
            update_separator(
                State(state.clone()),
                who(by),
                Path(id),
                body(serde_json::json!({ "label": "x" })),
            )
        };
        assert_eq!(
            status(edit("bob", ok.id).await.map(|Json(s)| s)),
            Err(StatusCode::NOT_FOUND)
        );
        assert_eq!(
            status(edit("alice", ok.id + 1000).await.map(|Json(s)| s)),
            Err(StatusCode::NOT_FOUND),
            "an unknown id answers the same"
        );
        assert_eq!(
            delete_separator(State(state.clone()), who("bob"), Path(ok.id))
                .await
                .map(|_| ())
                .map_err(|ApiError(c, _, _)| c),
            Err(StatusCode::NOT_FOUND)
        );
        sqlx::query(
            "INSERT INTO servers(name, display_name, created_at) VALUES('other', 'Other', 1)",
        )
        .execute(db)
        .await
        .expect("other");
        let elsewhere = id_of(
            db,
            "INSERT INTO channel_categories(server, name, position, created_at) VALUES('other', 'Far', 0, 1) RETURNING id",
        )
        .await;
        assert_eq!(
            status(
                new_separator(
                    &state,
                    "alice",
                    serde_json::json!({ "category_id": elsewhere })
                )
                .await
            ),
            Err(StatusCode::NOT_FOUND)
        );
        let now = layout(&state).await;
        let general = now.uncategorized[0];
        for wrong in [
            serde_json::json!([]),
            serde_json::json!([{ "id": ok.id, "after": 2 }]),
            serde_json::json!([{ "id": ok.id, "category_id": elsewhere, "after": 0 }]),
            serde_json::json!([{ "id": ok.id, "after": 0 }, { "id": ok.id, "after": 1 }]),
        ] {
            let res = reorder_layout(
                State(state.clone()),
                who("alice"),
                rchat(),
                body(serde_json::json!({
                    "version": now.version,
                    "uncategorized": [general],
                    "categories": [],
                    "separators": wrong,
                })),
            )
            .await;
            assert!(
                matches!(res, Err(ApiError(StatusCode::BAD_REQUEST, _, _))),
                "{wrong}"
            );
        }
        let capped = state.clone().with_limits(Arc::new(Limits {
            server_separators_max: 1,
            ..Limits::default()
        }));
        let Err(ApiError(code, msg, reason)) =
            new_separator(&capped, "alice", serde_json::json!({})).await
        else {
            panic!("a second separator past the cap");
        };
        assert_eq!(
            (code, msg.as_str()),
            (
                StatusCode::BAD_REQUEST,
                "A server can have at most 1 separators"
            )
        );
        assert_eq!(
            reason.and_then(|r| r.control).as_deref(),
            Some("server_separators_max")
        );
        temp.done(state).await;
    }
}

#[test]
fn a_layout_lists_separators_by_place() {
    let layout = ChannelLayout {
        version: 1,
        uncategorized: vec![1, 2],
        categories: vec![LayoutCategory {
            id: 9,
            name: "Team".to_string(),
            style: CategoryStyle::Line,
            channels: vec![3],
        }],
        separators: vec![
            Separator {
                id: 5,
                label: String::new(),
                style: SeparatorStyle::Dots,
                category_id: None,
                after: 2,
            },
            Separator {
                id: 6,
                label: "a".to_string(),
                style: SeparatorStyle::Line,
                category_id: Some(9),
                after: 0,
            },
        ],
    };
    let seen = seen_part(&layout, |c| c == 2, false);
    assert!(seen.categories.is_empty());
    assert_eq!(
        seen.separators
            .iter()
            .map(|s| (s.id, s.after))
            .collect::<Vec<_>>(),
        [(5, 1)]
    );
    let restyled = ChannelLayout {
        categories: vec![LayoutCategory {
            style: CategoryStyle::Dots,
            ..layout.categories[0].clone()
        }],
        ..layout.clone()
    };
    assert_ne!(
        seen_part(&layout, |_| true, false).version,
        seen_part(&restyled, |_| true, false).version,
        "a category style is part of what is seen"
    );
}
