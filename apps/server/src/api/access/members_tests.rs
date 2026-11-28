use axum::Json;
use axum::extract::{Path, Query, RawQuery, State};
use axum::http::{HeaderMap, StatusCode};
use rchat_perms::Mask;
use rchat_perms::masks::{BASE, VIEW_MEMBERS};
use serde_json::json;
use sqlx::Row;

use super::perms::Perm;
use crate::api::error::ReasonKind;
use crate::api::servers::{list_interacted, list_members, mentions, update_server};
use crate::api::test_util::{add_member, each_db, mem_user};
use crate::api::users::Names;
use crate::api::{ApiError, Authed, MaybeAuthed, Member, Paged, Settings};
use crate::db::{Db, NewUser};
use crate::state::AppState;

async fn exec(db: &Db, sql: &str) {
    sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
        .execute(db)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
}

async fn id_of(db: &Db, sql: &str) -> i64 {
    sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
        .fetch_one(db)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"))
        .try_get(0)
        .expect("id")
}

/// A server `club` with its owner `own`, members holding Kick (`kick`), Manage roles (`roles`),
/// Manage server (`srv`) or Time out members (`tmo`) through a role of their own, a plain member
/// `low`, an account outside it (`out`) and a site admin (`root`), and two text channels.
struct Club {
    state: AppState,
    general: i64,
    quiet: i64,
}

impl Club {
    async fn new(state: AppState) -> Club {
        let db = &state.db;
        exec(db, "INSERT INTO servers(name, display_name, creator, created_at) VALUES('club', 'Club', 'own', 0)").await;
        let general = id_of(db, "INSERT INTO channels(server, name, created_at) VALUES('club', 'general', 0) RETURNING id").await;
        let quiet = id_of(db, "INSERT INTO channels(server, name, created_at) VALUES('club', 'quiet', 0) RETURNING id").await;
        for name in ["own", "kick", "roles", "srv", "tmo", "low", "out"] {
            NewUser::plain(name).at(1).add(db).await;
        }
        NewUser::plain("root").admin(true).at(1).add(db).await;
        add_member(db, "club", "own", 1, 0, 0).await;
        add_member(db, "club", "low", 0, 0, 0).await;
        for (name, perms) in [
            ("kick", Perm::Kick as i64),
            ("roles", Perm::ManageRoles as i64),
            ("srv", Perm::ManageServer as i64),
            ("tmo", Perm::TimeoutMembers as i64),
        ] {
            let role = id_of(db, &format!("INSERT INTO roles(server, name, color, perms) VALUES('club', 'r{name}', '#ffffff', {perms}) RETURNING id")).await;
            add_member(db, "club", name, 0, 0, 0).await;
            exec(db, &format!("INSERT INTO user_roles(server, username, role_id) VALUES('club', '{name}', {role})")).await;
        }
        exec(db, &format!("INSERT INTO messages(channel_id, author, content, created_at) VALUES({general}, 'kick', 'hello', 1)")).await;
        Club {
            state,
            general,
            quiet,
        }
    }

    async fn everyone(&self, bits: Mask) {
        exec(
            &self.state.db,
            &format!("UPDATE servers SET everyone_perms = {bits} WHERE name = 'club'"),
        )
        .await;
    }

    async fn rule(&self, channel: i64, subject: &str, allow: Mask, deny: Mask) {
        exec(&self.state.db, &format!("INSERT INTO channel_perms(channel_id, subject, allow, deny) VALUES({channel}, '{subject}', {allow}, {deny})")).await;
    }

    async fn setting(&self, key: &str, value: &str) {
        let db = &self.state.db;
        sqlx::query("INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
            .bind(key)
            .bind(value)
            .execute(db)
            .await
            .expect("setting");
        Settings::load(db).await;
    }

    async fn list(&self, by: &str, query: &str) -> Result<Vec<Member>, ApiError> {
        let Paged(rows, _) = list_members(
            State(self.state.clone()),
            MaybeAuthed(Some(mem_user(by, by == "root"))),
            HeaderMap::new(),
            Path("club".to_string()),
            RawQuery(Some(query.to_string())),
        )
        .await?;
        Ok(rows)
    }

    async fn names(&self, by: &str, query: &str) -> Result<Vec<String>, ApiError> {
        let mut names: Vec<String> = self
            .list(by, query)
            .await?
            .into_iter()
            .map(|m| m.user.username)
            .collect();
        names.sort();
        Ok(names)
    }

    async fn in_channel(&self, by: &str, channel: i64) -> Result<Vec<String>, ApiError> {
        self.names(by, &format!("channel_id={channel}")).await
    }
}

fn why<T>(res: Result<T, ApiError>) -> (StatusCode, String, Option<(ReasonKind, Option<String>)>) {
    match res {
        Ok(_) => (StatusCode::OK, String::new(), None),
        Err(ApiError(code, text, reason)) => {
            (code, text, reason.map(|r| (r.kind, r.control.clone())))
        }
    }
}

const ALL: [&str; 6] = ["kick", "low", "own", "roles", "srv", "tmo"];
const SERVER_TEXT: &str = "You can't view the members of this server";

#[tokio::test]
async fn view_members_decides_who_gets_the_member_list() {
    for (state, temp) in each_db("member_list_bits").await {
        let c = Club::new(state.clone()).await;
        assert_eq!(c.names("low", "").await.expect("by default"), ALL);
        c.everyone(BASE & !VIEW_MEMBERS).await;
        assert_eq!(
            why(c.names("low", "").await),
            (StatusCode::FORBIDDEN, SERVER_TEXT.to_string(), None),
            "everyone lost View members"
        );
        assert_eq!(why(c.names("tmo", "").await).0, StatusCode::FORBIDDEN);
        for moderator in ["own", "kick", "roles", "srv", "root"] {
            assert_eq!(
                c.names(moderator, "").await.expect(moderator),
                ALL,
                "{moderator}"
            );
        }
        c.rule(c.quiet, "everyone", VIEW_MEMBERS, 0).await;
        assert_eq!(
            c.in_channel("low", c.quiet).await.expect("allowed here"),
            ALL
        );
        assert_eq!(
            why(c.in_channel("low", c.general).await).0,
            StatusCode::FORBIDDEN
        );
        temp.done(state).await;
    }
}

#[tokio::test]
async fn a_channel_can_keep_the_member_list_from_its_viewers() {
    for (state, temp) in each_db("member_list_channel").await {
        let c = Club::new(state.clone()).await;
        c.rule(c.quiet, "everyone", 0, VIEW_MEMBERS).await;
        assert_eq!(
            why(c.in_channel("low", c.quiet).await),
            (
                StatusCode::FORBIDDEN,
                "You can't view the members of this channel".to_string(),
                None
            )
        );
        assert_eq!(c.in_channel("low", c.general).await.expect("there"), ALL);
        assert_eq!(c.in_channel("kick", c.quiet).await.expect("moderator"), ALL);
        exec(&state.db, "INSERT INTO servers(name, display_name, creator, created_at) VALUES('other', 'Other', 'own', 0)").await;
        let theirs = id_of(&state.db, "INSERT INTO channels(server, name, created_at) VALUES('other', 'general', 0) RETURNING id").await;
        assert_eq!(
            why(c.in_channel("low", theirs).await).0,
            StatusCode::NOT_FOUND,
            "a channel of another server"
        );
        temp.done(state).await;
    }
}

#[tokio::test]
async fn hiding_members_keeps_the_list_to_moderators_and_staff() {
    for (state, temp) in each_db("member_list_hidden").await {
        let c = Club::new(state.clone()).await;
        let patch = |by: &str, hide: bool| {
            update_server(
                State(state.clone()),
                Authed(mem_user(by, false)),
                Path("club".to_string()),
                Json(serde_json::from_value(json!({ "hide_members": hide })).expect("patch")),
            )
        };
        assert_eq!(
            why(patch("low", true).await).0,
            StatusCode::FORBIDDEN,
            "a member without Manage server can't"
        );
        let Json(updated) = patch("srv", true).await.expect("Manage server");
        assert!(updated.server.hide_members);
        let audit: String = sqlx::query("SELECT details FROM audit_log WHERE server = 'club' AND action = 'server.update' ORDER BY id DESC LIMIT 1")
            .fetch_one(&state.db)
            .await
            .expect("audit")
            .try_get(0)
            .expect("details");
        assert!(
            audit.contains("hide_members"),
            "the change is in the audit log: {audit}"
        );
        assert_eq!(
            why(c.names("low", "").await),
            (
                StatusCode::FORBIDDEN,
                SERVER_TEXT.to_string(),
                Some((ReasonKind::OffServer, Some("hide_members".to_string())))
            )
        );
        assert_eq!(why(c.names("tmo", "").await).0, StatusCode::FORBIDDEN);
        for seer in ["own", "kick", "roles", "srv", "root"] {
            assert_eq!(c.names(seer, "").await.expect(seer), ALL, "{seer}");
        }
        assert!(
            c.names("low", "suggest=1&q=k")
                .await
                .expect("suggest")
                .is_empty()
        );
        let Names(suggested) = mentions(
            State(state.clone()),
            MaybeAuthed(Some(mem_user("low", false))),
            HeaderMap::new(),
            Path("club".to_string()),
            Query(serde_json::from_value(json!({ "q": "k" })).expect("query")),
        )
        .await
        .expect("mentions");
        assert!(suggested.is_empty());
        let authors = c
            .list("low", "usernames=kick&usernames=srv&usernames=out")
            .await
            .expect("authors");
        assert_eq!(
            authors
                .iter()
                .map(|m| (m.user.username.as_str(), m.online))
                .collect::<Vec<_>>(),
            [("kick", false)],
            "only who wrote a message the caller reads"
        );
        let interacted = list_interacted(
            State(state.clone()),
            MaybeAuthed(Some(mem_user("low", false))),
            HeaderMap::new(),
            Path("club".to_string()),
            Query(serde_json::from_value(json!({})).expect("paging")),
            Query(serde_json::from_value(json!({})).expect("scope")),
        )
        .await;
        assert_eq!(why(interacted).0, StatusCode::FORBIDDEN);
        let _ = patch("own", false).await.expect("shown again");
        assert_eq!(c.names("low", "").await.expect("back"), ALL);
        temp.done(state).await;
    }
}

#[tokio::test]
async fn the_site_switch_turns_member_lists_off_for_everyone_but_staff() {
    for (state, temp) in each_db("member_list_site").await {
        let c = Club::new(state.clone()).await;
        c.setting("member_lists", "0").await;
        for name in ["own", "kick", "low"] {
            assert_eq!(
                why(c.names(name, "").await),
                (
                    StatusCode::FORBIDDEN,
                    "Member lists are turned off on this site".to_string(),
                    Some((ReasonKind::OffSite, Some("member_lists".to_string())))
                ),
                "{name}"
            );
        }
        assert_eq!(c.names("root", "").await.expect("staff"), ALL);
        c.setting("member_lists", "1").await;
        assert_eq!(c.names("low", "").await.expect("on again"), ALL);
        temp.done(state).await;
    }
}
