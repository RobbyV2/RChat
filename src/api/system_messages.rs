use axum::Json;
use axum::extract::{Path, State};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use utoipa::ToSchema;

use crate::api::access::{Proof, ServerAccess, not_found, resolve_channel, resolve_server};
use crate::api::messages::load_broadcast;
use crate::api::{ApiError, ApiErrorBody, Authed};
use crate::db::{ChannelKind, Db, Perm, User, now};
use crate::state::AppState;
use crate::ws::WsEvent;

/// A member gets at most one join and one leave message per server in this many seconds.
pub const THROTTLE_SECS: i64 = 600;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SystemKind {
    Join,
    Leave,
}

impl SystemKind {
    fn kind(self) -> &'static str {
        match self {
            SystemKind::Join => "join",
            SystemKind::Leave => "leave",
        }
    }

    fn toggle(self) -> &'static str {
        match self {
            SystemKind::Join => "join_messages",
            SystemKind::Leave => "leave_messages",
        }
    }
}

const CONFIGURED: &str = "(SELECT c.id FROM channels c WHERE c.id = s.system_channel_id AND c.server = s.name AND c.kind = 'text')";

const FALLBACK: &str =
    "(SELECT MIN(c.id) FROM channels c WHERE c.server = s.name AND c.kind = 'text')";

/// Posts a `join` or `leave` system message for `username` in the server's system channel (the
/// configured text channel, else the first text channel) unless that kind is turned off or the
/// member got the same kind in this server within `THROTTLE_SECS`. Returns the new message id.
pub(crate) async fn post_system(
    conn: &mut sqlx::AnyConnection,
    server: &str,
    username: &str,
    kind: SystemKind,
) -> sqlx::Result<Option<i64>> {
    let t = now();
    let sql = format!(
        "INSERT INTO messages(channel_id, author, content, kind, created_at) SELECT x.ch, $2, '', '{kind}', $3 FROM (SELECT COALESCE({CONFIGURED}, {FALLBACK}) AS ch FROM servers s WHERE s.name = $1 AND s.{toggle} <> 0) x WHERE x.ch IS NOT NULL AND NOT EXISTS(SELECT 1 FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.author = $2 AND m.kind = '{kind}' AND m.created_at > $4 AND c.server = $1) RETURNING id",
        kind = kind.kind(),
        toggle = kind.toggle(),
    );
    sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(server)
        .bind(username)
        .bind(t)
        .bind(t - THROTTLE_SECS)
        .fetch_optional(&mut *conn)
        .await?
        .map(|r| r.try_get(0))
        .transpose()
}

/// Sends a system message posted by `post_system` to the server like any new message. The
/// membership change is already committed, so a failed read only skips the broadcast.
pub(crate) async fn announce_system(state: &AppState, server: &str, id: Option<i64>) {
    let Some(id) = id else {
        return;
    };
    match load_broadcast(&state.db, id).await {
        Ok(Some(row)) => state.hub.broadcast(WsEvent::Message {
            server: Some(server.to_string()),
            channel_id: row.channel_id,
            dm_id: None,
            dm_users: None,
            message: Box::new(row),
        }),
        Ok(None) => {}
        Err(ApiError(_, e)) => tracing::warn!("system message {id} not broadcast: {e}"),
    }
}

/// Join and leave message settings of a server.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct SystemMessages {
    /// Text channel that gets join and leave messages; `null` for the default channel (the
    /// server's first text channel). A deleted channel falls back to the default.
    pub channel_id: Option<i64>,
    /// Whether a message is posted when someone joins (not for guests).
    pub join_messages: bool,
    /// Whether a message is posted when a member leaves, is kicked or is banned.
    pub leave_messages: bool,
}

/// Changes to the join and leave message settings. Omitted fields stay unchanged.
#[derive(Deserialize, ToSchema)]
pub struct SystemMessagesPatch {
    /// A text channel of the server you can see, or `null` for the default channel.
    #[serde(default, deserialize_with = "crate::api::auth::present")]
    #[schema(value_type = Option<i64>)]
    channel_id: Option<Option<i64>>,
    /// Turns join messages on or off.
    join_messages: Option<bool>,
    /// Turns leave messages on or off.
    leave_messages: Option<bool>,
}

async fn manage(state: &AppState, user: &User, name: &str) -> Result<ServerAccess, ApiError> {
    let access = resolve_server(&state.db, name, Some(user), &Proof::none()).await?;
    access.require_perm(&state.db, Perm::DeleteServer).await?;
    Ok(access)
}

async fn load(db: &Db, server: &str) -> Result<SystemMessages, ApiError> {
    let sql = format!(
        "SELECT {CONFIGURED}, s.join_messages, s.leave_messages FROM servers s WHERE s.name = $1"
    );
    let row = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(server)
        .fetch_optional(db)
        .await?
        .ok_or_else(not_found)?;
    Ok(SystemMessages {
        channel_id: row.try_get(0)?,
        join_messages: row.try_get::<i64, _>(1)? != 0,
        leave_messages: row.try_get::<i64, _>(2)? != 0,
    })
}

/// Get join and leave message settings
///
/// Returns where join and leave messages go and whether each kind is on. Requires the Delete
/// server permission. `channel_id` can be a channel you cannot see (set by another admin);
/// clients show it as "Hidden channel". General rate-limit bucket.
#[utoipa::path(
    get,
    path = "/api/servers/{name}/system_messages",
    tag = "Servers",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    responses(
        (status = 200, description = "The settings", body = SystemMessages),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Delete server permission", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses)", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn get_system_messages(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
) -> Result<Json<SystemMessages>, ApiError> {
    let access = manage(&state, &user, &name).await?;
    Ok(Json(load(&state.db, access.name()).await?))
}

/// Update join and leave message settings
///
/// Picks the channel for join and leave messages and turns each kind on or off. `channel_id`
/// must be a text channel of this server that you can see; `null` goes back to the default
/// channel (the first text channel). Requires the Delete server permission. Emits no WebSocket
/// event. General rate-limit bucket.
#[utoipa::path(
    patch,
    path = "/api/servers/{name}/system_messages",
    tag = "Servers",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    request_body = SystemMessagesPatch,
    responses(
        (status = 200, description = "The settings after the update", body = SystemMessages),
        (status = 400, description = "Malformed JSON or a missing `Content-Type` (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Delete server permission", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password` for a server you have no access to; `Not found` for a channel that does not exist, belongs to another server, is a voice channel or is hidden from you (identical responses)", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn update_system_messages(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Json(req): Json<SystemMessagesPatch>,
) -> Result<Json<SystemMessages>, ApiError> {
    let SystemMessagesPatch {
        channel_id,
        join_messages,
        leave_messages,
    } = req;
    let access = manage(&state, &user, &name).await?;
    let key = access.name().to_string();
    if let Some(Some(id)) = channel_id {
        let channel = resolve_channel(&state.db, id, Some(&user), &Proof::none()).await?;
        if channel.server().name() != key || channel.kind() != ChannelKind::Text {
            return Err(not_found());
        }
    }
    let mut tx = state.db.begin().await?;
    if let Some(id) = channel_id {
        sqlx::query("UPDATE servers SET system_channel_id = $1 WHERE name = $2")
            .bind(id)
            .bind(&key)
            .execute(&mut *tx)
            .await?;
    }
    for (sql, value) in [
        (
            "UPDATE servers SET join_messages = $1 WHERE name = $2",
            join_messages,
        ),
        (
            "UPDATE servers SET leave_messages = $1 WHERE name = $2",
            leave_messages,
        ),
    ] {
        if let Some(on) = value {
            sqlx::query(sql)
                .bind(i64::from(on))
                .bind(&key)
                .execute(&mut *tx)
                .await?;
        }
    }
    tx.commit().await?;
    Ok(Json(load(&state.db, &key).await?))
}

#[cfg(test)]
mod tests {
    use axum::extract::Query;
    use axum::http::{HeaderMap, StatusCode};
    use serde_json::json;

    use super::*;
    use crate::api::auth::hash_password;
    use crate::api::messages::channel_messages;
    use crate::api::servers::{
        ban_member, delete_channel, guest_access, join_server, kick_member, leave_server,
    };
    use crate::api::test_util::{add_member, done, mem_user, temp_state};
    use crate::api::{MaybeAuthed, Message};
    use crate::db::Db;

    async fn exec(db: &Db, sql: &str) {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .execute(db)
            .await
            .expect(sql);
    }

    async fn id_of(db: &Db, sql: &str) -> i64 {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .fetch_one(db)
            .await
            .expect(sql)
            .try_get(0)
            .expect("id")
    }

    async fn rows(db: &Db, server: &str) -> Vec<(i64, String, String, String)> {
        sqlx::query("SELECT m.channel_id, c.name, m.kind, m.author FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.server = $1 AND m.kind IN ('join', 'leave') ORDER BY m.id")
            .bind(server)
            .fetch_all(db)
            .await
            .expect("rows")
            .iter()
            .map(|r| {
                (
                    r.try_get(0).expect("channel"),
                    r.try_get(1).expect("name"),
                    r.try_get(2).expect("kind"),
                    r.try_get(3).expect("author"),
                )
            })
            .collect()
    }

    fn names(list: &[(i64, String, String, String)]) -> Vec<String> {
        list.iter()
            .map(|(_, c, k, a)| format!("{k} {a} #{c}"))
            .collect()
    }

    struct World {
        state: AppState,
        path: std::path::PathBuf,
        voice: i64,
        general: i64,
        random: i64,
    }

    async fn world(tag: &str) -> World {
        let (state, path) = temp_state(tag).await;
        let db = &state.db;
        for name in ["alice", "bob", "carol", "dora", "erin", "frank"] {
            sqlx::query("INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, created_at) VALUES($1, $2, '', 'text', 'identicon', 1)")
                .bind(name)
                .bind(name.to_uppercase())
                .execute(db)
                .await
                .expect("user");
        }
        exec(db, "INSERT INTO servers(name, display_name, creator, created_at) VALUES('club', 'Club', 'alice', 1)").await;
        add_member(db, "club", "alice", 1, 0, 1).await;
        add_member(db, "club", "dora", 1, Perm::DeleteServer as i64, 1).await;
        let voice = id_of(db, "INSERT INTO channels(server, name, kind, created_at) VALUES('club', 'lounge', 'voice', 1) RETURNING id").await;
        let general = id_of(db, "INSERT INTO channels(server, name, kind, created_at) VALUES('club', 'general', 'text', 1) RETURNING id").await;
        let random = id_of(db, "INSERT INTO channels(server, name, kind, created_at) VALUES('club', 'random', 'text', 1) RETURNING id").await;
        World {
            state,
            path,
            voice,
            general,
            random,
        }
    }

    async fn join(state: &AppState, who: &str, server: &str) -> Result<(), ApiError> {
        join_server(
            State(state.clone()),
            Authed(mem_user(who, false)),
            Path(server.to_string()),
            None,
        )
        .await
        .map(|_| ())
    }

    async fn leave(state: &AppState, who: &str) -> Result<(), ApiError> {
        leave_server(
            State(state.clone()),
            Authed(mem_user(who, false)),
            Path("club".to_string()),
        )
        .await
        .map(|_| ())
    }

    fn target(who: &str) -> Json<crate::api::servers::UsernameReq> {
        Json(serde_json::from_value(json!({ "username": who })).expect("body"))
    }

    async fn patch(
        state: &AppState,
        who: &str,
        body: serde_json::Value,
    ) -> Result<SystemMessages, ApiError> {
        update_system_messages(
            State(state.clone()),
            Authed(mem_user(who, false)),
            Path("club".to_string()),
            Json(serde_json::from_value(body).expect("patch")),
        )
        .await
        .map(|Json(s)| s)
    }

    async fn settings(state: &AppState, who: &str) -> Result<SystemMessages, ApiError> {
        get_system_messages(
            State(state.clone()),
            Authed(mem_user(who, false)),
            Path("club".to_string()),
        )
        .await
        .map(|Json(s)| s)
    }

    async fn backdate(db: &Db) {
        exec(
            db,
            &format!(
                "UPDATE messages SET created_at = created_at - {} WHERE kind IN ('join', 'leave')",
                THROTTLE_SECS + 1
            ),
        )
        .await;
    }

    fn system_events(rx: &mut tokio::sync::broadcast::Receiver<WsEvent>) -> Vec<String> {
        std::iter::from_fn(|| rx.try_recv().ok())
            .filter_map(|ev| match ev {
                WsEvent::Message {
                    server,
                    channel_id,
                    message,
                    ..
                } => Some(format!(
                    "{} {} '{}' {:?} c{:?}={:?}",
                    message.kind,
                    message.author.username,
                    message.content,
                    server,
                    channel_id,
                    message.channel_id
                )),
                _ => None,
            })
            .collect()
    }

    #[tokio::test]
    async fn joins_and_leaves_post_in_the_first_text_channel_with_a_throttle() {
        let World {
            state,
            path,
            voice,
            general,
            random: _,
        } = world("system_default").await;
        let db = &state.db;
        let mut rx = state.hub.subscribe();
        join(&state, "bob", "club").await.expect("join");
        let events = system_events(&mut rx);
        assert_eq!(
            events,
            vec![format!(
                "join bob '' Some(\"club\") c{:?}={:?}",
                Some(general),
                Some(general)
            )]
        );
        assert!(general > voice, "the voice channel is older but not text");
        join(&state, "bob", "club").await.expect("already a member");
        assert_eq!(names(&rows(db, "club").await), ["join bob #general"]);
        leave(&state, "bob").await.expect("leave");
        assert_eq!(system_events(&mut rx).len(), 1);
        join(&state, "bob", "club").await.expect("rejoin");
        leave(&state, "bob").await.expect("leave again");
        assert_eq!(
            names(&rows(db, "club").await),
            ["join bob #general", "leave bob #general"],
            "one join and one leave per 10 minutes"
        );
        assert!(system_events(&mut rx).is_empty());
        backdate(db).await;
        join(&state, "bob", "club").await.expect("join later");
        leave(&state, "bob").await.expect("leave later");
        assert_eq!(
            names(&rows(db, "club").await),
            [
                "join bob #general",
                "leave bob #general",
                "join bob #general",
                "leave bob #general"
            ]
        );
        let loaded = crate::api::messages::load_message(
            db,
            id_of(db, "SELECT MAX(id) FROM messages WHERE kind = 'leave'").await,
            crate::api::messages::Quotes::Skip,
        )
        .await
        .expect("load")
        .expect("leave row");
        assert_eq!(
            (
                loaded.kind.as_str(),
                loaded.content.as_str(),
                loaded.author.display_name.as_str()
            ),
            ("leave", "", "BOB"),
            "the leaver stays the author after leaving"
        );
        let pings = id_of(db, "SELECT COUNT(*) FROM pings").await;
        assert_eq!(pings, 0, "system messages never ping");
        done(state, path).await;
    }

    #[tokio::test]
    async fn kicks_and_bans_post_leave_messages_and_guests_post_nothing() {
        let World {
            state,
            path,
            voice: _,
            general: _,
            random: _,
        } = world("system_moderation").await;
        let db = &state.db;
        for who in ["bob", "carol"] {
            join(&state, who, "club").await.expect("join");
        }
        let _ = kick_member(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            Path("club".to_string()),
            target("bob"),
        )
        .await
        .expect("kick");
        let _ = ban_member(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            Path("club".to_string()),
            target("carol"),
        )
        .await
        .expect("ban");
        let _ = ban_member(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            Path("club".to_string()),
            target("erin"),
        )
        .await
        .expect("ban a non-member");
        assert_eq!(
            names(&rows(db, "club").await),
            [
                "join bob #general",
                "join carol #general",
                "leave bob #general",
                "leave carol #general"
            ]
        );

        let hash = hash_password("pw").await.expect("hash");
        sqlx::query("INSERT INTO servers(name, display_name, creator, password_hash, created_at) VALUES('vault', 'Vault', 'alice', $1, 1)")
            .bind(hash)
            .execute(db)
            .await
            .expect("vault");
        add_member(db, "vault", "alice", 1, 0, 1).await;
        exec(db, "INSERT INTO channels(server, name, kind, created_at) VALUES('vault', 'general', 'text', 1)").await;
        let _ = guest_access(
            State(state.clone()),
            MaybeAuthed(None),
            Path("vault".to_string()),
            Json(serde_json::from_value(json!({ "password": "pw" })).expect("body")),
        )
        .await
        .expect("guest grant");
        assert_eq!(
            id_of(
                db,
                "SELECT COUNT(*) FROM guest_grants WHERE server = 'vault'"
            )
            .await,
            1
        );
        assert!(rows(db, "vault").await.is_empty(), "guests are not joins");
        done(state, path).await;
    }

    #[tokio::test]
    async fn the_configured_channel_is_used_and_falls_back_when_deleted() {
        let World {
            state,
            path,
            voice,
            general,
            random,
        } = world("system_configured").await;
        let db = &state.db;
        let defaults = settings(&state, "alice").await.expect("settings");
        assert_eq!(
            (
                defaults.channel_id,
                defaults.join_messages,
                defaults.leave_messages
            ),
            (None, true, true)
        );
        let set = patch(&state, "dora", json!({ "channel_id": random }))
            .await
            .expect("Delete server permission is enough");
        assert_eq!(set.channel_id, Some(random));
        join(&state, "bob", "club").await.expect("join");
        assert_eq!(names(&rows(db, "club").await), ["join bob #random"]);

        let _ = delete_channel(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            Path(random),
        )
        .await
        .expect("delete random");
        assert_eq!(
            settings(&state, "alice")
                .await
                .expect("settings")
                .channel_id,
            None
        );
        assert_eq!(
            id_of(
                db,
                "SELECT COUNT(*) FROM servers WHERE system_channel_id IS NOT NULL"
            )
            .await,
            0
        );
        join(&state, "carol", "club").await.expect("join");
        assert_eq!(
            names(&rows(db, "club").await),
            ["join carol #general"],
            "bob's row went with #random"
        );

        let other = id_of(db, "SELECT id FROM channels WHERE server = 'rchat'").await;
        let hidden = id_of(db, "INSERT INTO channels(server, name, kind, created_at) VALUES('club', 'staff', 'text', 1) RETURNING id").await;
        exec(db, &format!("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES({hidden}, 'u:dora', 0, 0, 0)")).await;
        crate::api::test_util::restrict_ruled(db).await;
        for id in [voice, other, random, 999_999, hidden] {
            match patch(&state, "dora", json!({ "channel_id": id })).await {
                Err(ApiError(code, msg)) => {
                    assert_eq!((code, msg.as_str()), (StatusCode::NOT_FOUND, "Not found"))
                }
                Ok(_) => panic!("channel {id} accepted"),
            }
        }
        match patch(&state, "bob", json!({ "join_messages": false })).await {
            Err(ApiError(code, _)) => assert_eq!(code, StatusCode::FORBIDDEN),
            Ok(_) => panic!("plain member changed settings"),
        }
        match settings(&state, "bob").await {
            Err(ApiError(code, _)) => assert_eq!(code, StatusCode::FORBIDDEN),
            Ok(_) => panic!("plain member read settings"),
        }
        let off = patch(
            &state,
            "alice",
            json!({ "channel_id": general, "join_messages": false, "leave_messages": false }),
        )
        .await
        .expect("turn off");
        assert_eq!(
            (off.channel_id, off.join_messages, off.leave_messages),
            (Some(general), false, false)
        );
        let before = rows(db, "club").await.len();
        backdate(db).await;
        leave(&state, "bob").await.expect("leave");
        join(&state, "frank", "club").await.expect("join");
        assert_eq!(rows(db, "club").await.len(), before, "both kinds are off");
        let back = patch(
            &state,
            "alice",
            json!({ "channel_id": null, "join_messages": true }),
        )
        .await
        .expect("default again");
        assert_eq!(
            (back.channel_id, back.join_messages, back.leave_messages),
            (None, true, false)
        );
        join(&state, "erin", "club").await.expect("join");
        assert_eq!(
            names(&rows(db, "club").await).last().map(String::as_str),
            Some("join erin #general")
        );
        done(state, path).await;
    }

    async fn list(state: &AppState, who: &str, cid: i64) -> Result<Vec<Message>, ApiError> {
        channel_messages(
            State(state.clone()),
            MaybeAuthed(Some(mem_user(who, false))),
            HeaderMap::new(),
            Path(cid),
            Query(serde_json::from_value(json!({})).expect("query")),
        )
        .await
        .map(|Json(list)| list)
    }

    #[tokio::test]
    async fn a_view_restricted_system_channel_stays_hidden() {
        let World {
            state,
            path,
            voice: _,
            general: _,
            random,
        } = world("system_restricted").await;
        let db = &state.db;
        add_member(db, "club", "carol", 0, 0, 1).await;
        exec(db, &format!("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES({random}, 'u:bob', 1, 1, 1)")).await;
        crate::api::test_util::restrict_ruled(db).await;
        patch(&state, "alice", json!({ "channel_id": random }))
            .await
            .expect("restricted channel is still a valid choice");
        let mut rx = state.hub.subscribe();
        join(&state, "bob", "club").await.expect("join");
        let events = system_events(&mut rx);
        assert_eq!(events.len(), 1);
        assert!(events[0].ends_with(&format!("c{:?}={:?}", Some(random), Some(random))));
        assert!(
            !crate::api::access::ws_channel_viewable(db, "club", random, Some("carol")).await,
            "the channel gate drops the broadcast for carol"
        );
        assert!(crate::api::access::ws_channel_viewable(db, "club", random, Some("bob")).await);
        match list(&state, "carol", random).await {
            Err(ApiError(code, _)) => assert_eq!(code, StatusCode::NOT_FOUND),
            Ok(_) => panic!("carol read the restricted channel"),
        }
        let seen = list(&state, "bob", random).await.expect("bob reads");
        assert_eq!(
            seen.iter()
                .map(|m| (m.kind.as_str(), m.author.username.as_str()))
                .collect::<Vec<_>>(),
            [("join", "bob")]
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn system_rows_take_no_reactions_replies_threads_edits_pins_or_forwards() {
        let World {
            state,
            path,
            voice: _,
            general,
            random: _,
        } = world("system_exclusions").await;
        let db = &state.db;
        join(&state, "bob", "club").await.expect("join");
        let row = id_of(db, "SELECT id FROM messages WHERE kind = 'join'").await;
        let alice = || Authed(mem_user("alice", false));
        assert!(
            crate::api::reactions::add_reaction(
                State(state.clone()),
                Path((row, "👍".to_string())),
                alice()
            )
            .await
            .is_err()
        );
        assert!(
            crate::api::pins::pin_message(State(state.clone()), Path(row), alice())
                .await
                .is_err()
        );
        assert!(
            crate::api::messages::edit_message(
                State(state.clone()),
                Path(row),
                Authed(mem_user("bob", false)),
                Json(serde_json::from_value(json!({ "content": "hi" })).expect("edit")),
            )
            .await
            .is_err()
        );
        for body in [
            json!({ "content": "hi", "reply_to": row }),
            json!({ "content": "", "forward_of": row }),
        ] {
            assert!(
                crate::api::messages::send_channel_message(
                    State(state.clone()),
                    Path(general),
                    alice(),
                    Json(serde_json::from_value(body.clone()).expect("send")),
                )
                .await
                .is_err(),
                "{body}"
            );
        }
        assert!(
            crate::api::messages::send_thread_message(
                State(state.clone()),
                Path(row),
                alice(),
                Json(serde_json::from_value(json!({ "content": "hi" })).expect("send")),
            )
            .await
            .is_err()
        );
        assert_eq!(
            id_of(db, "SELECT COUNT(*) FROM messages WHERE kind = 'user'").await,
            0
        );
        exec(db, "UPDATE channels SET slowmode_seconds = 60").await;
        let _ = crate::api::messages::send_channel_message(
            State(state.clone()),
            Path(general),
            Authed(mem_user("bob", false)),
            Json(serde_json::from_value(json!({ "content": "hello" })).expect("send")),
        )
        .await
        .expect("a join message does not start slow mode");
        done(state, path).await;
    }
}
