use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use serde_json::{Value, json};
use sqlx::Row;

use super::*;
use crate::api::access::perms::Perm;
use crate::api::servers::{get_server, my_servers_page, search_servers, update_server};
use crate::api::test_util::{each_db, mem_user, profanity_on};
use crate::api::{Authed, MaybeAuthed};
use crate::db::NewUser;
use crate::state::AppState;
use crate::ws::WsEvent;

async fn exec(db: &Db, sql: &str) {
    sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
        .execute(db)
        .await
        .expect(sql);
}

async fn club(db: &Db) {
    for name in ["alice", "bob"] {
        NewUser::plain(name).add(db).await;
    }
    exec(db, "INSERT INTO servers(name, display_name, creator, created_at, banner_color) VALUES('club', 'Club', 'alice', 0, '#112233')").await;
    exec(db, &format!("INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES('club', 'alice', 1, {}, 0), ('club', 'bob', 0, 0, 0)", Perm::ManageServer as i64)).await;
}

async fn patch(state: &AppState, who: &str, body: Value) -> Result<Value, (StatusCode, String)> {
    update_server(
        State(state.clone()),
        Authed(mem_user(who, false)),
        Path("club".to_string()),
        Json(serde_json::from_value(body).expect("body")),
    )
    .await
    .map(|Json(u)| serde_json::to_value(u).expect("json"))
    .map_err(|ApiError(code, text, _)| (code, text))
}

async fn stored(db: &Db) -> (Option<String>, Option<String>) {
    let r = sqlx::query("SELECT description, icon_kind FROM servers WHERE name = 'club'")
        .fetch_one(db)
        .await
        .expect("server");
    (
        r.try_get(0).expect("description"),
        r.try_get(1).expect("icon"),
    )
}

#[test]
fn icon_kinds_read_as_a_letter_unless_they_say_identicon() {
    assert_eq!(IconKind::stored(None), IconKind::Letter);
    assert_eq!(IconKind::stored(Some("letter")), IconKind::Letter);
    assert_eq!(IconKind::stored(Some("identicon")), IconKind::Identicon);
    assert_eq!(IconKind::stored(Some("square")), IconKind::Letter);
    for kind in [IconKind::Letter, IconKind::Identicon] {
        assert_eq!(IconKind::stored(Some(kind.as_str())), kind);
        assert_eq!(
            serde_json::to_value(kind).expect("json"),
            json!(kind.as_str())
        );
    }
    assert!(serde_json::from_value::<IconKind>(json!("Identicon")).is_err());
}

#[tokio::test]
async fn a_server_about_is_cleaned_filtered_audited_and_live() {
    for (state, temp) in each_db("server_about").await {
        let db = &state.db;
        club(db).await;
        let mut rx = state.hub.subscribe();
        assert_eq!(
            patch(&state, "bob", json!({ "description": "hi" })).await,
            Err((StatusCode::FORBIDDEN, "Missing permission".to_string()))
        );
        let set = patch(
            &state,
            "alice",
            json!({ "description": "  Rust help\u{0007}\r\n\n\n\nand chat \t", "icon_kind": "identicon" }),
        )
        .await
        .expect("set");
        assert_eq!(set["description"], json!("Rust help\n\nand chat"));
        assert_eq!(set["icon_kind"], json!("identicon"));
        assert_eq!(
            stored(db).await,
            (
                Some("Rust help\n\nand chat".to_string()),
                Some("identicon".to_string())
            )
        );
        match rx.try_recv() {
            Ok(WsEvent::ServerUpdated { server }) => {
                assert_eq!(server.description.as_deref(), Some("Rust help\n\nand chat"));
                assert_eq!(server.icon_kind, IconKind::Identicon);
            }
            _ => panic!("expected server_updated"),
        }
        let details: String = sqlx::query(
            "SELECT details FROM audit_log WHERE server = 'club' AND action = 'server.update'",
        )
        .fetch_one(db)
        .await
        .expect("entry")
        .try_get(0)
        .expect("details");
        let details: Value = serde_json::from_str(&details).expect("details json");
        assert_eq!(
            details["changes"],
            json!([
                { "field": "description", "before": null, "after": "Rust help\n\nand chat" },
                { "field": "icon_kind", "before": "letter", "after": "identicon" },
            ])
        );

        let max = "\u{1F600}".repeat(ABOUT_MAX);
        assert_eq!(
            patch(&state, "alice", json!({ "description": max }))
                .await
                .expect("max")["description"],
            json!(max)
        );
        assert_eq!(
            patch(&state, "alice", json!({ "description": format!("{max}a") })).await,
            Err((
                StatusCode::BAD_REQUEST,
                "Description must be at most 300 characters".to_string()
            ))
        );
        assert!(
            serde_json::from_value::<crate::api::servers::ServerPatch>(
                json!({ "icon_kind": "square" })
            )
            .is_err(),
            "an unknown icon kind is refused"
        );
        profanity_on(db).await;
        let rude = patch(&state, "alice", json!({ "description": "what the fuck" })).await;
        assert!(matches!(&rude, Err((StatusCode::BAD_REQUEST, m)) if m.contains("profanity")));
        assert_eq!(stored(db).await.0, Some(max.clone()), "a refusal keeps it");
        assert_eq!(
            patch(&state, "alice", json!({ "name_color": "#ffffff" }))
                .await
                .expect("kept")["description"],
            json!(max),
            "an update without it keeps it"
        );
        let cleared = patch(
            &state,
            "alice",
            json!({ "description": null, "icon_kind": "letter" }),
        )
        .await
        .expect("cleared");
        assert_eq!(cleared["description"], Value::Null);
        assert_eq!(cleared["icon_kind"], json!("letter"));
        assert_eq!(stored(db).await, (None, Some("letter".to_string())));
        assert_eq!(
            patch(&state, "alice", json!({ "description": "  \n " }))
                .await
                .expect("blank")["description"],
            Value::Null
        );
        temp.done(state).await;
    }
}

#[tokio::test]
async fn the_about_reaches_the_detail_the_rail_and_server_search() {
    for (state, temp) in each_db("server_about_reach").await {
        let db = &state.db;
        club(db).await;
        exec(db, "UPDATE servers SET description = 'All about rust', icon_kind = 'identicon' WHERE name = 'club'").await;
        let Json(detail) = get_server(
            State(state.clone()),
            MaybeAuthed(Some(mem_user("bob", false))),
            HeaderMap::new(),
            Path("club".to_string()),
        )
        .await
        .map_err(|e| e.1)
        .expect("detail");
        assert_eq!(detail.description.as_deref(), Some("All about rust"));
        assert_eq!(detail.icon_kind, IconKind::Identicon);
        let page = my_servers_page(db, "bob", 0, None, 50)
            .await
            .map_err(|e| e.1)
            .expect("servers");
        assert_eq!(
            page.items
                .iter()
                .map(|s| (s.name.as_str(), s.icon_kind))
                .collect::<Vec<_>>(),
            [("club", IconKind::Identicon)]
        );
        let Json(found) = search_servers(
            State(state.clone()),
            MaybeAuthed(Some(mem_user("bob", false))),
            Query(serde_json::from_value(json!({ "q": "club" })).expect("query")),
        )
        .await
        .map_err(|e| e.1)
        .expect("search");
        let found = serde_json::to_value(found).expect("json");
        assert_eq!(found[0]["name"], json!("club"));
        assert_eq!(found[0]["description"], json!("All about rust"));
        assert_eq!(found[0]["icon_kind"], json!("identicon"));
        assert_eq!(found[0]["banner_color"], json!("#112233"));
        let lite = crate::api::access::resolve_server(
            db,
            "club",
            Some(&mem_user("bob", false)),
            &crate::api::access::Proof::none(),
        )
        .await
        .map_err(|e| e.1)
        .expect("club")
        .lite()
        .clone();
        let snap = crate::api::reports::snapshot::server(db, &lite)
            .await
            .map_err(|e| e.1)
            .expect("snapshot");
        assert_eq!(
            snap.description.as_deref(),
            Some("All about rust"),
            "a report keeps the description"
        );
        exec(
            db,
            "UPDATE servers SET icon_kind = NULL WHERE name = 'club'",
        )
        .await;
        let page = my_servers_page(db, "bob", 0, None, 50)
            .await
            .map_err(|e| e.1)
            .expect("servers");
        assert_eq!(
            page.items[0].icon_kind,
            IconKind::Letter,
            "unset reads as a letter"
        );
        temp.done(state).await;
    }
}
