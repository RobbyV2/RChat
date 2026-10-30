use std::collections::HashMap;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use utoipa::ToSchema;

use crate::api::access::{Proof, ServerAccess, resolve_server};
use crate::api::audit::{self, Details, Entry, Target};
use crate::api::{ApiError, ApiErrorBody, OkResp, bad, ok, placeholders};
use crate::api::{Authed, check_len};
use crate::db::{Db, Perm, get_user, now};
use crate::state::AppState;
use crate::ws::{Hub, WsEvent};

/// Longest timeout: 28 days.
pub const TIMEOUT_MAX: i64 = 28 * 86400;

/// Longest timeout reason, in characters.
pub const REASON_MAX: usize = 300;

/// Request body for timing out a member.
#[derive(Deserialize, ToSchema)]
pub struct TimeoutReq {
    /// How long the timeout lasts from now, 1 second to 28 days (2419200).
    #[schema(example = 600)]
    pub seconds: i64,
    /// Why, shown to moderators and in the audit log; at most 300 characters.
    #[serde(default)]
    pub reason: Option<String>,
}

/// A timeout that is running now.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct MemberTimeout {
    /// When it ends, in unix seconds.
    pub until: i64,
    /// Seconds left when the response or event was made.
    pub remaining: i64,
    /// The reason the moderator gave.
    pub reason: Option<String>,
}

/// Running timeouts of `usernames` in `server`.
pub(crate) async fn running_timeouts(
    db: &Db,
    server: &str,
    usernames: &[String],
) -> Result<HashMap<String, MemberTimeout>, ApiError> {
    let mut out = HashMap::new();
    if usernames.is_empty() {
        return Ok(out);
    }
    let t = now();
    let sql = format!(
        "SELECT username, until, reason FROM member_timeouts WHERE server = $1 AND until > $2 AND username IN ({})",
        placeholders(3, usernames.len())
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(server).bind(t);
    for name in usernames {
        query = query.bind(name);
    }
    for r in &query.fetch_all(db).await? {
        let until: i64 = r.try_get(1)?;
        out.insert(
            r.try_get(0)?,
            MemberTimeout {
                until,
                remaining: until - t,
                reason: r.try_get(2)?,
            },
        );
    }
    Ok(out)
}

/// The event that tells moderators of `server` and `username` about a timeout (`None`: ended).
pub(crate) fn timeout_event(
    server: &str,
    username: &str,
    timeout: Option<MemberTimeout>,
) -> WsEvent {
    WsEvent::MemberTimeout {
        server: server.to_string(),
        username: username.to_string(),
        until: timeout.as_ref().map(|t| t.until),
        remaining: timeout.as_ref().map_or(0, |t| t.remaining),
        reason: timeout.and_then(|t| t.reason),
    }
}

/// Server-mutes or unmutes `username` in the voice channel of `server` they are in, if any.
pub(crate) fn announce_voice_mute(hub: &Hub, server: &str, username: &str, muted: bool) {
    for (channel_id, users) in hub.rooms_in(server, None) {
        if users.iter().any(|u| u == username) {
            hub.broadcast(WsEvent::VoiceMuted {
                server: server.to_string(),
                channel_id,
                username: username.to_string(),
                muted,
            });
        }
    }
}

struct Stored {
    until: i64,
    reason: Option<String>,
}

async fn stored(
    conn: &mut sqlx::AnyConnection,
    server: &str,
    username: &str,
) -> Result<Option<Stored>, ApiError> {
    let row = sqlx::query(
        "SELECT until, reason FROM member_timeouts WHERE server = $1 AND username = $2 AND until > $3",
    )
    .bind(server)
    .bind(username)
    .bind(now())
    .fetch_optional(&mut *conn)
    .await?;
    match row {
        Some(r) => Ok(Some(Stored {
            until: r.try_get(0)?,
            reason: r.try_get(1)?,
        })),
        None => Ok(None),
    }
}

/// On Postgres, locks the membership row so concurrent changes to one member's timeout run one
/// after another (SQLite has a single writer already).
async fn lock_member(
    conn: &mut sqlx::AnyConnection,
    server: &str,
    username: &str,
) -> Result<(), ApiError> {
    if conn.backend_name() == "PostgreSQL" {
        sqlx::query("SELECT 1 FROM members WHERE server = $1 AND username = $2 FOR UPDATE")
            .bind(server)
            .bind(username)
            .fetch_optional(&mut *conn)
            .await?;
    }
    Ok(())
}

/// Who may set or end a timeout of `target` in this server, and how it is logged.
async fn moderator(db: &Db, access: &ServerAccess, target: &str) -> Result<audit::Actor, ApiError> {
    access.require_perm(db, Perm::TimeoutMembers).await?;
    access.require_moderate(db, target).await?;
    let bypassed = access
        .bypassed(|m| async move {
            m.require_perm(db, Perm::TimeoutMembers).await?;
            m.require_moderate(db, target).await
        })
        .await;
    Ok(access
        .audit_actor(db, Perm::TimeoutMembers)
        .await?
        .staff_if(bypassed))
}

fn clean_reason(reason: Option<String>) -> Result<Option<String>, ApiError> {
    match reason
        .map(|r| r.trim().to_string())
        .filter(|r| !r.is_empty())
    {
        Some(r) => {
            check_len(&r, REASON_MAX, "Reason")?;
            Ok(Some(r))
        }
        None => Ok(None),
    }
}

/// Time out a member
///
/// Times out `username` for `seconds` (1 second to 28 days) from now, replacing any running
/// timeout. While timed out they can read but not send, reply, forward into the server, edit,
/// react, start or reply in threads, pin or unpin, vote, type, or join voice channels; when they
/// are in a voice channel they are muted there until the timeout ends. DMs are not affected.
/// Leaving and rejoining the server does not end it. Requires the Timeout members permission,
/// and the member's server permissions must be a strict subset of yours (so you can't time out
/// yourself, the owner or admins above you). Logged in the audit log as `member.timeout`. Emits
/// `member_timeout` to the member and to members who hold Timeout members, and `voice_muted`
/// when they are in voice. General rate-limit bucket.
#[utoipa::path(
    put,
    path = "/api/servers/{name}/timeouts/{username}",
    tag = "Moderation",
    params(("name" = String, Path, description = "Server name, case-insensitive"), ("username" = String, Path, description = "Member to time out, case-insensitive")),
    request_body = TimeoutReq,
    responses(
        (status = 200, description = "The running timeout", body = MemberTimeout),
        (status = 400, description = "`seconds` outside 1 to 2419200, a reason over 300 characters, or `You can't time out yourself`. Malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Timeout members permission, or the member's server permissions are not a strict subset of yours", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses); or the user is not a member (`Not a member`)", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn set_timeout(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path((name, username)): Path<(String, String)>,
    Json(req): Json<TimeoutReq>,
) -> Result<Json<MemberTimeout>, ApiError> {
    let TimeoutReq { seconds, reason } = req;
    let target = username.to_lowercase();
    let access = resolve_server(&state.db, &name, Some(&user), &Proof::none()).await?;
    access.require_perm(&state.db, Perm::TimeoutMembers).await?;
    if target == user.username {
        return Err(bad("You can't time out yourself"));
    }
    if !(1..=TIMEOUT_MAX).contains(&seconds) {
        return Err(bad("Timeouts last from 1 second to 28 days"));
    }
    let reason = clean_reason(reason)?;
    let key = access.name().to_string();
    let member = sqlx::query("SELECT 1 FROM members WHERE server = $1 AND username = $2")
        .bind(&key)
        .bind(&target)
        .fetch_optional(&state.db)
        .await?
        .is_some();
    if !member {
        return Err(ApiError(StatusCode::NOT_FOUND, "Not a member".to_string()));
    }
    let actor = moderator(&state.db, &access, &target).await?;
    let t = now();
    let until = t + seconds;
    let mut tx = state.db.begin().await?;
    lock_member(&mut tx, &key, &target).await?;
    let before = stored(&mut tx, &key, &target).await?;
    sqlx::query(
        "INSERT INTO member_timeouts(server, username, until, reason, set_by, created_at) VALUES($1, $2, $3, $4, $5, $6) ON CONFLICT(server, username) DO UPDATE SET until = excluded.until, reason = excluded.reason, set_by = excluded.set_by, created_at = excluded.created_at",
    )
    .bind(&key)
    .bind(&target)
    .bind(until)
    .bind(reason.as_deref())
    .bind(&user.username)
    .bind(t)
    .execute(&mut *tx)
    .await?;
    let before_until = before.map(|b| b.until);
    audit::record(
        &mut tx,
        Entry::new(&key, &actor, audit::Action::MemberTimeout)
            .target(Target::user(&target))
            .details(
                Details::new()
                    .change("until", before_until, until)
                    .set("duration", seconds)
                    .set("reason", reason.clone()),
            ),
    )
    .await?;
    tx.commit().await?;
    let timeout = MemberTimeout {
        until,
        remaining: seconds,
        reason,
    };
    state
        .hub
        .broadcast(timeout_event(&key, &target, Some(timeout.clone())));
    announce_voice_mute(&state.hub, &key, &target, true);
    Ok(Json(timeout))
}

/// Remove a timeout
///
/// Ends the running timeout of `username` early. Succeeds without changes when there is none.
/// Same permissions as timing out (the user need not be a member any more). Logged in the audit
/// log as `member.untimeout`. Emits `member_timeout` with `until: null` to the user and to
/// members who hold Timeout members, and `voice_muted` when they are in voice. General
/// rate-limit bucket.
#[utoipa::path(
    delete,
    path = "/api/servers/{name}/timeouts/{username}",
    tag = "Moderation",
    params(("name" = String, Path, description = "Server name, case-insensitive"), ("username" = String, Path, description = "Timed out user, case-insensitive")),
    responses(
        (status = 200, description = "No timeout is running any more", body = OkResp),
        (status = 400, description = "`You can't remove your own timeout`", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Timeout members permission, or the user's server permissions are not a strict subset of yours", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses); or the user does not exist (`User not found`)", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn remove_timeout(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path((name, username)): Path<(String, String)>,
) -> Result<Json<OkResp>, ApiError> {
    let target = username.to_lowercase();
    let access = resolve_server(&state.db, &name, Some(&user), &Proof::none()).await?;
    access.require_perm(&state.db, Perm::TimeoutMembers).await?;
    if target == user.username && !user.is_site_admin {
        return Err(bad("You can't remove your own timeout"));
    }
    if get_user(&state.db, &target).await?.is_none() {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "User not found".to_string(),
        ));
    }
    let key = access.name().to_string();
    let actor = moderator(&state.db, &access, &target).await?;
    let mut tx = state.db.begin().await?;
    lock_member(&mut tx, &key, &target).await?;
    let t = now();
    let before = match sqlx::query(
        "DELETE FROM member_timeouts WHERE server = $1 AND username = $2 RETURNING until, reason",
    )
    .bind(&key)
    .bind(&target)
    .fetch_optional(&mut *tx)
    .await?
    {
        Some(r) => Some(Stored {
            until: r.try_get(0)?,
            reason: r.try_get(1)?,
        })
        .filter(|s| s.until > t),
        None => None,
    };
    if let Some(Stored { until, reason }) = &before {
        audit::record(
            &mut tx,
            Entry::new(&key, &actor, audit::Action::MemberUntimeout)
                .target(Target::user(&target))
                .details(
                    Details::new()
                        .change("until", *until, None::<i64>)
                        .set("remaining", (*until - t).max(0))
                        .set("reason", reason.clone()),
                ),
        )
        .await?;
    }
    tx.commit().await?;
    if before.is_some() {
        state.hub.broadcast(timeout_event(&key, &target, None));
        announce_voice_mute(&state.hub, &key, &target, false);
    }
    Ok(ok())
}

/// Tells moderators, the members and voice channels about timeouts that ended in
/// `(since, until]`, so their apps clear without a reload. The checks never need this.
pub async fn announce_expired_timeouts(
    state: &AppState,
    since: i64,
    until: i64,
) -> sqlx::Result<()> {
    let rows = sqlx::query(
        "SELECT server, username FROM member_timeouts WHERE until > $1 AND until <= $2",
    )
    .bind(since)
    .bind(until)
    .fetch_all(&state.read())
    .await?;
    for r in &rows {
        let (server, username): (String, String) = (r.try_get(0)?, r.try_get(1)?);
        let running = sqlx::query(
            "SELECT 1 FROM member_timeouts WHERE server = $1 AND username = $2 AND until > $3",
        )
        .bind(&server)
        .bind(&username)
        .bind(now())
        .fetch_optional(&state.db)
        .await?;
        if running.is_some() {
            continue;
        }
        state.hub.broadcast(timeout_event(&server, &username, None));
        announce_voice_mute(&state.hub, &server, &username, false);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use axum::extract::RawQuery;
    use axum::http::HeaderMap;
    use serde::de::DeserializeOwned;
    use serde_json::{Value, json};

    use super::*;
    use crate::api::access::{TIMED_OUT, ws_typing_place};
    use crate::api::messages::{
        PageQuery, channel_messages, edit_message, send_channel_message, send_dm_message,
        send_thread_message,
    };
    use crate::api::pins::{pin_message, unpin_message};
    use crate::api::reactions::{add_reaction, remove_reaction};
    use crate::api::servers::{join_server, leave_server, list_members, my_servers_by_names};
    use crate::api::test_util::{add_member, done, mem_user, temp_state};
    use crate::api::{MaybeAuthed, Paged};

    fn req<T: DeserializeOwned>(v: Value) -> T {
        serde_json::from_value(v).expect("request body")
    }

    fn who(name: &str) -> Authed {
        Authed(mem_user(name, name == "root"))
    }

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

    struct Club {
        state: AppState,
        path: PathBuf,
        general: i64,
        carols: i64,
        bobs: i64,
        dm: i64,
    }

    /// `club` (creator alice) with mo (role: Timeout members and Manage messages), bob (role:
    /// Manage messages, so he could pin), carol, and dave who is not a member; root is a site
    /// admin. Messages by carol and bob in #general, a DM between bob and carol.
    async fn club(tag: &str) -> Club {
        let (state, path) = temp_state(tag).await;
        let db = &state.db;
        for name in ["alice", "mo", "bob", "carol", "dave", "root"] {
            exec(db, &format!("INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, created_at) VALUES('{name}', '{name}', '', 'text', 'identicon', 0)")).await;
        }
        exec(
            db,
            "UPDATE users SET is_site_admin = 1 WHERE username = 'root'",
        )
        .await;
        exec(db, "INSERT INTO servers(name, display_name, creator, created_at) VALUES('club', 'Club', 'alice', 0)").await;
        let general = id_of(db, "INSERT INTO channels(server, name, created_at) VALUES('club', 'general', 0) RETURNING id").await;
        add_member(db, "club", "alice", 1, 0, 0).await;
        for name in ["mo", "bob", "carol"] {
            add_member(db, "club", name, 0, 0, 0).await;
        }
        let mods = id_of(db, "INSERT INTO roles(server, name, color, perms) VALUES('club', 'mods', '#ffffff', 130) RETURNING id").await;
        let pins = id_of(db, "INSERT INTO roles(server, name, color, perms) VALUES('club', 'pins', '#ffffff', 2) RETURNING id").await;
        exec(db, &format!("INSERT INTO user_roles(server, username, role_id) VALUES('club', 'mo', {mods}), ('club', 'bob', {pins})")).await;
        let carols = id_of(db, &format!("INSERT INTO messages(channel_id, author, content, created_at) VALUES({general}, 'carol', 'hi', {}) RETURNING id", now())).await;
        let bobs = id_of(db, &format!("INSERT INTO messages(channel_id, author, content, created_at) VALUES({general}, 'bob', 'mine', {}) RETURNING id", now())).await;
        let dm = id_of(
            db,
            "INSERT INTO dms(user_a, user_b) VALUES('bob', 'carol') RETURNING id",
        )
        .await;
        Club {
            state,
            path,
            general,
            carols,
            bobs,
            dm,
        }
    }

    async fn time_out(
        state: &AppState,
        by: &str,
        target: &str,
        body: Value,
    ) -> Result<MemberTimeout, ApiError> {
        set_timeout(
            State(state.clone()),
            who(by),
            Path(("club".to_string(), target.to_string())),
            Json(req(body)),
        )
        .await
        .map(|Json(t)| t)
    }

    async fn untime(state: &AppState, by: &str, target: &str) -> Result<(), ApiError> {
        remove_timeout(
            State(state.clone()),
            who(by),
            Path(("club".to_string(), target.to_string())),
        )
        .await
        .map(|_| ())
    }

    fn status<T>(res: Result<T, ApiError>) -> Result<(), (u16, String)> {
        res.map(|_| ())
            .map_err(|ApiError(code, msg)| (code.as_u16(), msg))
    }

    fn timed_out_err() -> Result<(), (u16, String)> {
        Err((403, TIMED_OUT.to_string()))
    }

    static MEDIA: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    /// Every write `user` can make in the club's #general, with its result.
    async fn writes(c: &Club, user: &str) -> Vec<(&'static str, Result<(), (u16, String)>)> {
        let state = &c.state;
        let s = || State(state.clone());
        let media = format!(
            "m{}",
            MEDIA.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        exec(&state.db, &format!("INSERT INTO media(id, filename, mime, size, uploader, uploaded_at) VALUES('{media}', 'a.txt', 'text/plain', 1, '{user}', {})", now())).await;
        vec![
            (
                "send",
                status(
                    send_channel_message(
                        s(),
                        Path(c.general),
                        who(user),
                        Json(req(json!({"content": "hello"}))),
                    )
                    .await,
                ),
            ),
            (
                "reply",
                status(
                    send_channel_message(
                        s(),
                        Path(c.general),
                        who(user),
                        Json(req(json!({"content": "re", "reply_to": c.carols}))),
                    )
                    .await,
                ),
            ),
            (
                "forward",
                status(
                    send_channel_message(
                        s(),
                        Path(c.general),
                        who(user),
                        Json(req(json!({"content": "", "forward_of": c.carols}))),
                    )
                    .await,
                ),
            ),
            (
                "attachment",
                status(
                    send_channel_message(
                        s(),
                        Path(c.general),
                        who(user),
                        Json(req(json!({"content": "", "media_id": media}))),
                    )
                    .await,
                ),
            ),
            (
                "thread",
                status(
                    send_thread_message(
                        s(),
                        Path(c.carols),
                        who(user),
                        Json(req(json!({"content": "t"}))),
                    )
                    .await,
                ),
            ),
            (
                "edit",
                status(
                    edit_message(
                        s(),
                        Path(c.bobs),
                        who(user),
                        Json(req(json!({"content": "changed"}))),
                    )
                    .await,
                ),
            ),
            (
                "react",
                status(add_reaction(s(), Path((c.carols, "👍".to_string())), who(user)).await),
            ),
            (
                "pin",
                status(pin_message(s(), Path(c.carols), who(user)).await),
            ),
            (
                "unpin",
                status(unpin_message(s(), Path(c.carols), who(user)).await),
            ),
            (
                "typing",
                match ws_typing_place(&state.db, user, &format!("c{}", c.general)).await {
                    Some(_) => Ok(()),
                    None => timed_out_err(),
                },
            ),
            (
                "thread typing",
                match ws_typing_place(&state.db, user, &format!("t{}", c.carols)).await {
                    Some(_) => Ok(()),
                    None => timed_out_err(),
                },
            ),
        ]
    }

    async fn reads_and_dms_work(c: &Club, user: &str) {
        let s = || State(c.state.clone());
        let q: PageQuery = req(json!({}));
        let _ = channel_messages(
            s(),
            MaybeAuthed(Some(mem_user(user, false))),
            HeaderMap::new(),
            Path(c.general),
            axum::extract::Query(q),
        )
        .await
        .expect("reading still works");
        let _ = send_dm_message(
            s(),
            Path(c.dm),
            who(user),
            Json(req(json!({"content": "dm"}))),
        )
        .await
        .expect("DMs are not affected");
        let _ = remove_reaction(s(), Path((c.carols, "👍".to_string())), who(user))
            .await
            .expect("taking a reaction back is not a write the timeout blocks");
    }

    #[tokio::test]
    async fn a_timeout_blocks_every_write_in_the_server_until_it_ends() {
        let c = club("timeout_writes").await;
        let state = &c.state;
        for (what, res) in writes(&c, "bob").await {
            assert_eq!(res, Ok(()), "{what} before the timeout");
        }
        let t = time_out(
            state,
            "mo",
            "bob",
            json!({"seconds": 600, "reason": "spam"}),
        )
        .await
        .expect("time out");
        assert!(t.until >= now() + 599 && t.remaining == 600);
        assert_eq!(t.reason.as_deref(), Some("spam"));
        for (what, res) in writes(&c, "bob").await {
            assert_eq!(res, timed_out_err(), "{what} while timed out");
        }
        reads_and_dms_work(&c, "bob").await;
        for (what, res) in writes(&c, "carol").await {
            if what != "pin" && what != "unpin" && what != "edit" {
                assert_eq!(res, Ok(()), "{what} for someone else");
            }
        }
        untime(state, "mo", "bob").await.expect("remove early");
        for (what, res) in writes(&c, "bob").await {
            assert_eq!(res, Ok(()), "{what} after removal");
        }
        time_out(state, "mo", "bob", json!({"seconds": 60}))
            .await
            .expect("again");
        assert_eq!(writes(&c, "bob").await[0].1, timed_out_err());
        exec(
            &state.db,
            &format!(
                "UPDATE member_timeouts SET until = {} WHERE username = 'bob'",
                now()
            ),
        )
        .await;
        for (what, res) in writes(&c, "bob").await {
            assert_eq!(res, Ok(()), "{what} once it expired");
        }
        done(c.state, c.path).await;
    }

    #[tokio::test]
    async fn timeouts_follow_the_kick_hierarchy() {
        let c = club("timeout_rules").await;
        let state = &c.state;
        let try_out = |by: &'static str, target: &'static str, body: Value| async move {
            status(time_out(state, by, target, body).await)
        };
        let ten = json!({"seconds": 600});
        assert_eq!(
            try_out("carol", "bob", ten.clone()).await,
            Err((403, "Missing permission".to_string()))
        );
        assert_eq!(
            try_out("mo", "mo", ten.clone()).await,
            Err((400, "You can't time out yourself".to_string()))
        );
        assert_eq!(
            try_out("mo", "alice", ten.clone()).await,
            Err((403, "You can't moderate this member".to_string()))
        );
        assert_eq!(
            try_out("mo", "dave", ten.clone()).await,
            Err((404, "Not a member".to_string()))
        );
        assert_eq!(
            try_out("mo", "nobody", ten.clone()).await,
            Err((404, "Not a member".to_string()))
        );
        for seconds in [0, -5, TIMEOUT_MAX + 1] {
            assert_eq!(
                try_out("mo", "bob", json!({"seconds": seconds}))
                    .await
                    .map_err(|e| e.0),
                Err(400)
            );
        }
        assert_eq!(
            try_out(
                "mo",
                "bob",
                json!({"seconds": 60, "reason": "x".repeat(REASON_MAX + 1)})
            )
            .await
            .map_err(|e| e.0),
            Err(400)
        );
        assert_eq!(
            try_out("mo", "bob", json!({"seconds": TIMEOUT_MAX, "reason": "  "})).await,
            Ok(())
        );
        assert_eq!(
            sqlx::query("SELECT reason FROM member_timeouts WHERE username = 'bob'")
                .fetch_one(&state.db)
                .await
                .expect("row")
                .try_get::<Option<String>, _>(0)
                .expect("reason"),
            None
        );
        assert_eq!(try_out("alice", "mo", ten.clone()).await, Ok(()));
        assert_eq!(
            status(untime(state, "mo", "bob").await),
            timed_out_err(),
            "a timed-out moderator loses the power"
        );
        exec(
            &state.db,
            "DELETE FROM member_timeouts WHERE username = 'mo'",
        )
        .await;
        assert_eq!(status(untime(state, "mo", "bob").await), Ok(()));
        assert_eq!(
            status(untime(state, "carol", "mo").await),
            Err((403, "Missing permission".to_string()))
        );
        assert_eq!(
            try_out("root", "alice", ten.clone()).await,
            Ok(()),
            "site admins act as staff"
        );
        assert_eq!(
            status(untime(state, "alice", "alice").await),
            timed_out_err(),
            "a timed-out admin can't lift their own timeout"
        );
        assert_eq!(status(untime(state, "root", "alice").await), Ok(()));
        done(c.state, c.path).await;
    }

    type Logged = (Option<String>, i64, String, Option<String>, Value);

    #[tokio::test]
    async fn timeouts_are_audit_logged() {
        let c = club("timeout_audit").await;
        let state = &c.state;
        time_out(
            state,
            "mo",
            "bob",
            json!({"seconds": 600, "reason": "spam"}),
        )
        .await
        .expect("set");
        time_out(state, "mo", "bob", json!({"seconds": 3600}))
            .await
            .expect("change");
        untime(state, "mo", "bob").await.expect("remove");
        untime(state, "mo", "bob").await.expect("nothing to remove");
        time_out(
            state,
            "root",
            "carol",
            json!({"seconds": 60, "reason": "r"}),
        )
        .await
        .expect("staff");
        let rows = sqlx::query("SELECT actor, staff, action, target_name, details FROM audit_log WHERE server = 'club' ORDER BY id")
            .fetch_all(&state.db)
            .await
            .expect("audit");
        let got: Vec<Logged> = rows
            .iter()
            .map(|r| {
                (
                    r.try_get(0).expect("actor"),
                    r.try_get(1).expect("staff"),
                    r.try_get(2).expect("action"),
                    r.try_get(3).expect("target"),
                    serde_json::from_str(&r.try_get::<String, _>(4).expect("details"))
                        .expect("json"),
                )
            })
            .collect();
        assert_eq!(got.len(), 4, "a removal without a timeout is not logged");
        let actions: Vec<&str> = got.iter().map(|g| g.2.as_str()).collect();
        assert_eq!(
            actions,
            [
                "member.timeout",
                "member.timeout",
                "member.untimeout",
                "member.timeout"
            ]
        );
        assert_eq!(got[0].0.as_deref(), Some("mo"));
        assert_eq!(got[0].3.as_deref(), Some("bob"));
        assert_eq!(got[0].4["duration"], 600);
        assert_eq!(got[0].4["reason"], "spam");
        assert_eq!(got[0].4["changes"][0]["field"], "until");
        assert_eq!(got[0].4["changes"][0]["before"], Value::Null);
        assert_eq!(got[1].4["duration"], 3600);
        assert_eq!(got[1].4["reason"], Value::Null);
        assert!(
            got[1].4["changes"][0]["before"].is_i64(),
            "a change keeps the old end"
        );
        assert_eq!(got[2].4["changes"][0]["after"], Value::Null);
        assert!(got[2].4["remaining"].as_i64().is_some_and(|r| r > 3500));
        assert_eq!(
            (got[3].0.clone(), got[3].1),
            (None, 1),
            "staff stays unnamed"
        );
        done(c.state, c.path).await;
    }

    #[tokio::test]
    async fn moderators_see_timeouts_and_rejoining_keeps_them() {
        let c = club("timeout_seen").await;
        let state = &c.state;
        time_out(
            state,
            "mo",
            "bob",
            json!({"seconds": 600, "reason": "spam"}),
        )
        .await
        .expect("set");
        let listed = |viewer: &'static str| async move {
            let Paged(members, _) = list_members(
                State(state.clone()),
                MaybeAuthed(Some(mem_user(viewer, viewer == "root"))),
                HeaderMap::new(),
                Path("club".to_string()),
                RawQuery(None),
            )
            .await
            .unwrap_or_else(|e| panic!("list: {}", e.1));
            members
                .into_iter()
                .filter_map(|m| m.timeout.map(|t| (m.user.username, t.reason)))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            listed("mo").await,
            [("bob".to_string(), Some("spam".to_string()))]
        );
        assert_eq!(listed("alice").await.len(), 1);
        assert_eq!(listed("carol").await, []);
        assert_eq!(listed("bob").await, [], "only moderators see the icon");
        let mine = |user: &'static str| async move {
            my_servers_by_names(&state.db, user, &["club".to_string()])
                .await
                .expect("mine")[0]
                .timed_out_until
        };
        assert!(mine("bob").await.is_some_and(|u| u > now()));
        assert_eq!(mine("carol").await, None);
        let _ = leave_server(State(state.clone()), who("bob"), Path("club".to_string()))
            .await
            .expect("leave");
        let _ = join_server(
            State(state.clone()),
            who("bob"),
            Path("club".to_string()),
            None,
        )
        .await
        .expect("rejoin");
        assert!(mine("bob").await.is_some());
        assert_eq!(
            writes(&c, "bob").await[0].1,
            timed_out_err(),
            "rejoining does not end it"
        );
        exec(
            &state.db,
            &format!(
                "UPDATE member_timeouts SET until = {} WHERE username = 'bob'",
                now() - 1
            ),
        )
        .await;
        assert_eq!(mine("bob").await, None);
        assert_eq!(listed("mo").await, []);
        done(c.state, c.path).await;
    }

    #[tokio::test]
    async fn ended_timeouts_are_announced_once() {
        let c = club("timeout_expiry").await;
        let state = &c.state;
        let t = now();
        let lounge = id_of(&state.db, "INSERT INTO channels(server, name, kind, created_at) VALUES('club', 'lounge', 'voice', 0) RETURNING id").await;
        let _ = state.hub.voice_join("bob", 1, "club", lounge).await;
        exec(&state.db, &format!("INSERT INTO member_timeouts(server, username, until, created_at) VALUES('club', 'bob', {}, 0), ('club', 'carol', {}, 0)", t - 3, t + 600)).await;
        let mut rx = state.hub.subscribe();
        let mut drain = || {
            let mut got = Vec::new();
            while let Ok(ev) = rx.try_recv() {
                match ev {
                    WsEvent::MemberTimeout {
                        server: _,
                        username,
                        until,
                        remaining: _,
                        reason: _,
                    } => got.push(format!("timeout {username} {until:?}")),
                    WsEvent::VoiceMuted {
                        server: _,
                        channel_id,
                        username,
                        muted,
                    } => got.push(format!("muted {username} {channel_id} {muted}")),
                    _ => {}
                }
            }
            got
        };
        announce_expired_timeouts(state, t - 5, t)
            .await
            .expect("announce");
        assert_eq!(
            drain(),
            [
                "timeout bob None".to_string(),
                format!("muted bob {lounge} false"),
            ]
        );
        announce_expired_timeouts(state, t, t + 5)
            .await
            .expect("announce");
        assert_eq!(
            drain(),
            Vec::<String>::new(),
            "nothing ended in the next window"
        );
        done(c.state, c.path).await;
    }

    #[tokio::test]
    async fn a_timed_out_member_keeps_only_read_powers() {
        let c = club("timeout_powers").await;
        let state = &c.state;
        let chans = id_of(&state.db, "INSERT INTO roles(server, name, color, perms) VALUES('club', 'chans', '#ffffff', 65) RETURNING id").await;
        exec(
            &state.db,
            &format!(
                "INSERT INTO user_roles(server, username, role_id) VALUES('club', 'mo', {chans})"
            ),
        )
        .await;
        time_out(state, "alice", "mo", json!({"seconds": 600}))
            .await
            .expect("set");
        let rename = |name: &'static str| {
            crate::api::servers::update_channel(
                State(state.clone()),
                who("mo"),
                Path(c.general),
                Json(req(json!({ "name": name }))),
            )
        };
        let audit = || {
            crate::api::audit::list_audit(
                State(state.clone()),
                who("mo"),
                Path("club".to_string()),
                axum::extract::Query(req(json!({}))),
            )
        };
        assert_eq!(status(rename("lobby").await), timed_out_err());
        assert!(status(time_out(state, "mo", "carol", json!({"seconds": 60})).await).is_err());
        assert!(status(audit().await).is_ok(), "reading the audit log stays");
        let sees =
            |who: &'static str| crate::api::access::ws_sees_timeouts(&state.db, "club", who, false);
        let mods = id_of(&state.db, "INSERT INTO roles(server, name, color, perms) VALUES('club', 'mods', '#ffffff', 128) RETURNING id").await;
        exec(
            &state.db,
            &format!(
                "INSERT INTO user_roles(server, username, role_id) VALUES('club', 'mo', {mods})"
            ),
        )
        .await;
        assert!(
            sees("mo").await.expect("sees"),
            "a timed-out moderator keeps timeout events, a read-only view"
        );
        time_out(
            state,
            "alice",
            "carol",
            json!({"seconds": 60, "reason": "spam"}),
        )
        .await
        .expect("alice times out carol");
        let Paged(members, _) = list_members(
            State(state.clone()),
            MaybeAuthed(Some(mem_user("mo", false))),
            HeaderMap::new(),
            Path("club".to_string()),
            RawQuery(None),
        )
        .await
        .unwrap_or_else(|e| panic!("list: {}", e.1));
        let mut listed: Vec<(String, Option<String>)> = members
            .into_iter()
            .filter_map(|m| m.timeout.map(|t| (m.user.username, t.reason)))
            .collect();
        listed.sort();
        assert_eq!(
            listed,
            [
                ("carol".to_string(), Some("spam".to_string())),
                ("mo".to_string(), None)
            ],
            "the member list keeps timeouts"
        );
        let card = crate::api::users::profile(
            State(state.clone()),
            MaybeAuthed(Some(mem_user("mo", false))),
            HeaderMap::new(),
            Path("carol".to_string()),
            axum::extract::Query(req(json!({"server": "club"}))),
        )
        .await
        .unwrap_or_else(|e| panic!("profile: {}", e.1))
        .0
        .member
        .expect("member")
        .timeout
        .map(|t| t.reason);
        assert_eq!(
            card,
            Some(Some("spam".to_string())),
            "so does the profile card"
        );
        assert!(
            status(time_out(state, "mo", "carol", json!({"seconds": 60})).await).is_err(),
            "writes stay cut"
        );
        exec(
            &state.db,
            "UPDATE member_timeouts SET until = 1 WHERE username = 'mo'",
        )
        .await;
        assert!(status(rename("lobby").await).is_ok(), "lifts at expiry");
        assert!(sees("mo").await.expect("sees"), "and sees timeouts again");
        assert!(status(time_out(state, "mo", "carol", json!({"seconds": 60})).await).is_ok());
        done(c.state, c.path).await;
    }

    #[tokio::test]
    async fn the_member_never_sees_the_reason_over_rest() {
        let c = club("timeout_reason_rest").await;
        let state = &c.state;
        time_out(
            state,
            "mo",
            "bob",
            json!({"seconds": 600, "reason": "spam"}),
        )
        .await
        .expect("set");
        let seen = |viewer: &'static str| async move {
            crate::api::users::profile(
                State(state.clone()),
                MaybeAuthed(Some(mem_user(viewer, false))),
                HeaderMap::new(),
                Path("bob".to_string()),
                axum::extract::Query(req(json!({"server": "club"}))),
            )
            .await
            .unwrap_or_else(|e| panic!("profile: {}", e.1))
            .0
            .member
            .expect("member")
            .timeout
            .map(|t| t.reason)
        };
        assert_eq!(seen("mo").await, Some(Some("spam".to_string())));
        assert_eq!(seen("bob").await, None, "his own profile has no timeout");
        let mine = my_servers_by_names(&state.db, "bob", &["club".to_string()])
            .await
            .expect("mine")
            .remove(0);
        let json = serde_json::to_value(&mine).expect("json");
        assert!(json.get("timed_out_until").is_some());
        assert!(
            json.get("timed_out_remaining")
                .is_some_and(|r| r.as_i64().is_some_and(|r| (590..=600).contains(&r)))
        );
        assert!(!json.to_string().contains("spam") && !json.to_string().contains("\"mo\""));
        done(c.state, c.path).await;
    }
}
