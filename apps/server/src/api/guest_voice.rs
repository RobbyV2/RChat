use axum::Json;
use axum::extract::{Path, State};

use crate::api::access::perms::Perm;
use crate::api::access::{Proof, not_found, resolve_server};
use crate::api::audit::{self, Action, Actor, Details, Entry, Target};
use crate::api::{ApiError, ApiErrorBody, Authed, OkResp, ok};
use crate::db::User;
use crate::hub::VoiceSeat;
use crate::state::AppState;
use crate::ws::{GUEST_VOICE_BLOCK, REMOVED_BY_STAFF, is_guest};

/// Staff acting on a guest in a server's voice: the server's key, who is logged, and where the
/// guest was in voice when they checked.
struct OnGuest {
    server: String,
    actor: Actor,
    seat: VoiceSeat,
}

/// Where staff holding `perm` in `server` act on the guest named `guest` in its voice.
/// Everything else answers the same 404.
async fn staff_on_guest(
    state: &AppState,
    user: &User,
    server: &str,
    guest: &str,
    perm: Perm,
) -> Result<OnGuest, ApiError> {
    let db = &state.db;
    let access = resolve_server(db, server, Some(user), &Proof::none()).await?;
    if let Err(e) = access.require_perm(db, perm).await {
        return Err(match e.failed() {
            true => e,
            false => not_found(),
        });
    }
    let key = access.name().to_string();
    let seat = match is_guest(guest) {
        true => state.hub.voice_seat(guest, &key),
        false => None,
    }
    .ok_or_else(not_found)?;
    let bypassed = access
        .bypassed(|m| async move { m.require_perm(db, perm).await })
        .await;
    let actor = access.audit_actor(db, perm).await?.staff_if(bypassed);
    Ok(OnGuest {
        server: key,
        actor,
        seat,
    })
}

async fn log(state: &AppState, at: &OnGuest, action: Action, guest: &str) -> Result<(), ApiError> {
    let OnGuest {
        server,
        actor,
        seat:
            VoiceSeat {
                channel_id,
                addr: _,
                hushed: _,
            },
    } = at;
    let mut tx = state.db.begin().await?;
    let details = match audit::channel_ref(&mut *tx, *channel_id).await? {
        Some(channel) => Details::new().channel(&channel),
        None => Details::new(),
    };
    audit::record(
        &mut tx,
        Entry::new(server, actor, action)
            .target(Target::guest(guest))
            .details(details),
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

async fn disconnect_at(state: &AppState, at: &OnGuest, guest: &str) -> Result<(), ApiError> {
    log(state, at, Action::VoiceDisconnect, guest).await?;
    state.hub.kick_from_voice(
        guest,
        &at.server,
        at.seat.addr.as_deref(),
        REMOVED_BY_STAFF,
        GUEST_VOICE_BLOCK,
    );
    Ok(())
}

async fn hush_at(state: &AppState, at: &OnGuest, guest: &str, muted: bool) -> Result<(), ApiError> {
    if at.seat.hushed != muted {
        let action = match muted {
            true => Action::VoiceMute,
            false => Action::VoiceUnmute,
        };
        log(state, at, action, guest).await?;
        state
            .hub
            .hush_voice(guest, &at.server, at.seat.addr.as_deref(), muted);
    }
    Ok(())
}

/// Disconnect a guest from voice
///
/// Takes the guest connection named `guest` (`@guest:` and 16 hex digits, as `voice_state` lists
/// it), and every other guest connection from the address it came from, out of this server's
/// voice channels, telling each `Removed from voice by staff`. For 10 minutes those connections,
/// and every guest connection from that address, can't join this server's voice channels;
/// joining is refused with the time left. The block is kept in memory only and ends by itself.
/// Members and accounts are not affected, even from that address. Requires the Kick permission.
/// Logged in the audit log as `member.voice_disconnect`. Emits `voice_state` and, to each guest
/// taken out, `voice_ended`. General rate-limit bucket.
#[utoipa::path(
    post,
    path = "/api/v1/servers/{name}/voice/{guest}/disconnect",
    tag = "Moderation",
    params(("name" = String, Path, description = "Server name, case-insensitive"), ("guest" = String, Path, description = "The guest's voice name, for example `@guest:0123456789abcdef`")),
    responses(
        (status = 200, description = "The guest is out of this server's voice", body = OkResp),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "`You are banned from this server`", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses); or `Not found`: no guest of that name is in this server's voice, or you don't hold Kick in this server (identical responses)", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn disconnect_guest(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path((name, guest)): Path<(String, String)>,
) -> Result<Json<OkResp>, ApiError> {
    let at = staff_on_guest(&state, &user, &name, &guest, Perm::Kick).await?;
    disconnect_at(&state, &at, &guest).await?;
    Ok(ok())
}

async fn set_hushed(
    state: &AppState,
    user: &User,
    name: &str,
    guest: &str,
    muted: bool,
) -> Result<Json<OkResp>, ApiError> {
    let at = staff_on_guest(state, user, name, guest, Perm::TimeoutMembers).await?;
    hush_at(state, &at, guest, muted).await?;
    Ok(ok())
}

/// Mute a guest for everyone
///
/// Mutes the guest connection named `guest` (`@guest:` and 16 hex digits, as `voice_state` lists
/// it), and every guest connection from the address it came from, for everyone in this server's
/// voice: apps stop playing their audio, and they can't unmute themselves. The mute holds in
/// every voice channel of this server, also after a leave, a rejoin or a reload from that
/// address, until staff unmute it or for 24 hours. It is kept in memory only. Members and
/// accounts are not affected, even from that address. Succeeds without changes when the guest is
/// muted already. Requires the Timeout members permission. Logged in the audit log as
/// `member.voice_mute`. Emits `voice_muted` with `staff: true`. General rate-limit bucket.
#[utoipa::path(
    put,
    path = "/api/v1/servers/{name}/voice/{guest}/mute",
    tag = "Moderation",
    params(("name" = String, Path, description = "Server name, case-insensitive"), ("guest" = String, Path, description = "The guest's voice name, for example `@guest:0123456789abcdef`")),
    responses(
        (status = 200, description = "The guest is muted for everyone", body = OkResp),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "`You are banned from this server`", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses); or `Not found`: no guest of that name is in this server's voice, or you don't hold Timeout members in this server (identical responses)", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn mute_guest(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path((name, guest)): Path<(String, String)>,
) -> Result<Json<OkResp>, ApiError> {
    set_hushed(&state, &user, &name, &guest, true).await
}

/// Unmute a guest for everyone
///
/// Ends the mute of the guest connection named `guest` in this server's voice, for every guest
/// connection that mute covered. Succeeds without changes when it isn't muted. Same permission
/// and answers as muting. Logged in the audit log as `member.voice_unmute`. Emits `voice_muted`
/// with `staff: true` and `muted: false`. General rate-limit bucket.
#[utoipa::path(
    delete,
    path = "/api/v1/servers/{name}/voice/{guest}/mute",
    tag = "Moderation",
    params(("name" = String, Path, description = "Server name, case-insensitive"), ("guest" = String, Path, description = "The guest's voice name, for example `@guest:0123456789abcdef`")),
    responses(
        (status = 200, description = "The guest is not muted for everyone", body = OkResp),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "`You are banned from this server`", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses); or `Not found`: no guest of that name is in this server's voice, or you don't hold Timeout members in this server (identical responses)", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn unmute_guest(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path((name, guest)): Path<(String, String)>,
) -> Result<Json<OkResp>, ApiError> {
    set_hushed(&state, &user, &name, &guest, false).await
}

#[cfg(test)]
mod tests {
    use std::net::IpAddr;
    use std::path::PathBuf;

    use sqlx::Row;

    use super::*;
    use crate::api::test_util::{add_member, done, mem_user, temp_state};
    use crate::db::Db;

    const GUEST: &str = "@guest:00000000000000aa";
    const OTHER_GUEST: &str = "@guest:00000000000000bb";

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
        talk: i64,
        other: i64,
    }

    /// `club` (creator alice) with kim (role: Kick), tim (role: Timeout members), carol, and dave
    /// who is not a member; root is a site admin. `club` and `other` each have a voice channel,
    /// and `vault` has a password.
    async fn club(tag: &str) -> Club {
        let (state, path) = temp_state(tag).await;
        let db = &state.db;
        for name in ["alice", "kim", "tim", "carol", "dave", "root"] {
            crate::db::NewUser::plain(name).add(db).await;
        }
        exec(
            db,
            "UPDATE users SET is_site_admin = 1 WHERE username = 'root'",
        )
        .await;
        exec(db, "INSERT INTO servers(name, display_name, creator, created_at) VALUES('club', 'Club', 'alice', 0), ('other', 'Other', 'alice', 0)").await;
        exec(db, "INSERT INTO servers(name, display_name, creator, password_hash, created_at) VALUES('vault', 'Vault', 'alice', 'hash', 0)").await;
        let talk = id_of(db, "INSERT INTO channels(server, name, kind, created_at) VALUES('club', 'talk', 'voice', 0) RETURNING id").await;
        let other = id_of(db, "INSERT INTO channels(server, name, kind, created_at) VALUES('other', 'talk', 'voice', 0) RETURNING id").await;
        for server in ["club", "other", "vault"] {
            add_member(db, server, "alice", 1, 0, 0).await;
        }
        for name in ["kim", "tim", "carol"] {
            add_member(db, "club", name, 0, 0, 0).await;
        }
        let kick = id_of(db, "INSERT INTO roles(server, name, color, perms) VALUES('club', 'kick', '#ffffff', 4) RETURNING id").await;
        let mute = id_of(db, "INSERT INTO roles(server, name, color, perms) VALUES('club', 'mute', '#ffffff', 128) RETURNING id").await;
        exec(db, &format!("INSERT INTO user_roles(server, username, role_id) VALUES('club', 'kim', {kick}), ('club', 'tim', {mute})")).await;
        Club {
            state,
            path,
            talk,
            other,
        }
    }

    fn addr() -> IpAddr {
        "10.9.8.7".parse().expect("addr")
    }

    async fn guest_from(state: &AppState, name: &str, server: &str, channel_id: i64, from: IpAddr) {
        let conn = state.hub.next_conn();
        state
            .hub
            .guest_voice_join(name, conn, server, channel_id, 0, Some(from))
            .await
            .expect("guest joins");
    }

    async fn guest_in(state: &AppState, name: &str, server: &str, channel_id: i64) {
        guest_from(state, name, server, channel_id, addr()).await;
    }

    fn blocked() -> Option<String> {
        Some("Removed from voice by staff. Try again in 10 minutes".to_string())
    }

    fn who(name: &str) -> Authed {
        Authed(mem_user(name, name == "root"))
    }

    fn path(server: &str, guest: &str) -> Path<(String, String)> {
        Path((server.to_string(), guest.to_string()))
    }

    fn status<T>(res: Result<T, ApiError>) -> Result<(), (u16, String)> {
        res.map(|_| ())
            .map_err(|ApiError(code, msg, _)| (code.as_u16(), msg))
    }

    fn missing() -> Result<(), (u16, String)> {
        Err((404, "Not found".to_string()))
    }

    async fn disconnect(
        state: &AppState,
        by: &str,
        server: &str,
        guest: &str,
    ) -> Result<(), (u16, String)> {
        status(disconnect_guest(State(state.clone()), who(by), path(server, guest)).await)
    }

    async fn mute(state: &AppState, by: &str, guest: &str, on: bool) -> Result<(), (u16, String)> {
        status(match on {
            true => mute_guest(State(state.clone()), who(by), path("club", guest)).await,
            false => unmute_guest(State(state.clone()), who(by), path("club", guest)).await,
        })
    }

    /// The club's audit log, oldest first: (actor, staff, action, target kind, target name,
    /// channel id from the details).
    async fn audit(db: &Db) -> Vec<(Option<String>, i64, String, String, String, i64)> {
        sqlx::query("SELECT actor, staff, action, target_kind, target_name, details FROM audit_log WHERE server = 'club' ORDER BY id")
            .fetch_all(db)
            .await
            .expect("audit")
            .iter()
            .map(|r| {
                let details: serde_json::Value =
                    serde_json::from_str(&r.try_get::<String, _>(5).expect("details"))
                        .expect("json");
                (
                    r.try_get(0).expect("actor"),
                    r.try_get(1).expect("staff"),
                    r.try_get(2).expect("action"),
                    r.try_get(3).expect("kind"),
                    r.try_get(4).expect("name"),
                    details["channel"]["id"].as_i64().expect("channel"),
                )
            })
            .collect()
    }

    #[tokio::test]
    async fn disconnecting_a_guest_needs_kick_in_that_server() {
        let Club {
            state,
            path,
            talk,
            other,
        } = club("guest_voice_disconnect").await;
        let db = &state.db;
        guest_in(&state, GUEST, "club", talk).await;
        guest_in(&state, OTHER_GUEST, "other", other).await;
        state.hub.voice_join("carol", 77, "club", talk).await;
        for by in ["carol", "tim", "dave"] {
            assert_eq!(
                disconnect(&state, by, "club", GUEST).await,
                missing(),
                "{by}"
            );
        }
        for name in [OTHER_GUEST, "@guest:00000000000000cc", "carol", "@guest:"] {
            assert_eq!(
                disconnect(&state, "kim", "club", name).await,
                missing(),
                "{name} is not a guest in the club's voice"
            );
        }
        assert_eq!(
            disconnect(&state, "kim", "vault", GUEST).await,
            Err((404, crate::api::access::DENIED.to_string())),
            "a server the caller can't open"
        );
        assert_eq!(state.hub.room_in(GUEST, "club"), Some(talk));
        assert!(audit(db).await.is_empty());

        let (tab, elsewhere) = ("@guest:00000000000000ee", "@guest:00000000000000ff");
        guest_in(&state, tab, "club", talk).await;
        guest_from(
            &state,
            elsewhere,
            "club",
            talk,
            "10.9.8.6".parse().expect("addr"),
        )
        .await;
        disconnect(&state, "kim", "club", GUEST)
            .await
            .expect("kim kicks");
        assert_eq!(state.hub.room_in(GUEST, "club"), None);
        assert_eq!(
            state.hub.room_in(tab, "club"),
            None,
            "another guest from that address goes too"
        );
        assert_eq!(
            state.hub.rooms_in("club", None),
            vec![(talk, vec!["carol".to_string(), elsewhere.to_string()])],
            "members and guests from other addresses stay"
        );
        for name in [GUEST, tab, "@guest:00000000000000ab"] {
            assert_eq!(
                state
                    .hub
                    .guest_voice_join(name, 1, "club", talk, 0, Some(addr()))
                    .await
                    .err(),
                blocked(),
                "{name}"
            );
        }
        state.hub.voice_leave(elsewhere).await;
        assert_eq!(
            state.hub.room_in(OTHER_GUEST, "other"),
            Some(other),
            "another server's guest stays"
        );
        assert_eq!(
            audit(db).await,
            vec![(
                Some("kim".to_string()),
                0,
                "member.voice_disconnect".to_string(),
                "guest".to_string(),
                GUEST.to_string(),
                talk
            )]
        );
        assert_eq!(
            disconnect(&state, "kim", "club", GUEST).await,
            missing(),
            "gone already"
        );

        let third = "@guest:00000000000000dd";
        state.hub.voice_join(third, 78, "club", talk).await;
        disconnect(&state, "root", "club", third)
            .await
            .expect("a site admin may");
        assert_eq!(state.hub.room_in(third, "club"), None);
        let last = audit(db).await.pop().expect("entry");
        assert_eq!(
            (last.0, last.1, last.2.as_str(), last.4.as_str()),
            (None, 1, "member.voice_disconnect", third),
            "logged as the unnamed instance staff"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn muting_a_guest_for_everyone_needs_timeout_members() {
        let Club {
            state,
            path,
            talk,
            other: _,
        } = club("guest_voice_mute").await;
        let db = &state.db;
        guest_in(&state, GUEST, "club", talk).await;
        for by in ["carol", "kim", "dave"] {
            assert_eq!(mute(&state, by, GUEST, true).await, missing(), "{by}");
            assert_eq!(mute(&state, by, GUEST, false).await, missing(), "{by}");
        }
        assert!(!state.hub.hushed(GUEST, "club"));

        mute(&state, "tim", GUEST, true).await.expect("tim mutes");
        assert!(state.hub.hushed(GUEST, "club"));
        mute(&state, "tim", GUEST, true)
            .await
            .expect("muting again is fine");
        mute(&state, "tim", GUEST, false)
            .await
            .expect("tim unmutes");
        assert!(!state.hub.hushed(GUEST, "club"));
        mute(&state, "tim", GUEST, false)
            .await
            .expect("unmuting again is fine");
        mute(&state, "root", GUEST, true)
            .await
            .expect("a site admin may");
        assert!(state.hub.hushed(GUEST, "club"));
        let entries = audit(db).await;
        let rows: Vec<(Option<&str>, i64, &str, &str)> = entries
            .iter()
            .map(|(actor, staff, action, kind, name, channel)| {
                assert_eq!((name.as_str(), *channel), (GUEST, talk));
                (actor.as_deref(), *staff, action.as_str(), kind.as_str())
            })
            .collect();
        assert_eq!(
            rows,
            vec![
                (Some("tim"), 0, "member.voice_mute", "guest"),
                (Some("tim"), 0, "member.voice_unmute", "guest"),
                (None, 1, "member.voice_mute", "guest"),
            ],
            "one entry per change"
        );

        exec(db, &format!("INSERT INTO member_timeouts(server, username, until, created_at) VALUES('club', 'tim', {}, 0)", crate::db::now() + 600)).await;
        assert_eq!(
            mute(&state, "tim", GUEST, false).await,
            missing(),
            "a timed out moderator can't"
        );

        state.hub.voice_leave(GUEST).await;
        assert!(state.hub.hushed(GUEST, "club"), "the mute outlives a leave");
        assert_eq!(
            mute(&state, "root", GUEST, false).await,
            missing(),
            "not in voice any more"
        );
        guest_in(&state, OTHER_GUEST, "club", talk).await;
        assert!(
            state.hub.hushed(OTHER_GUEST, "club"),
            "a reload from that address is muted"
        );
        mute(&state, "root", OTHER_GUEST, false)
            .await
            .expect("root unmutes the reload");
        assert!(!state.hub.hushed(OTHER_GUEST, "club") && !state.hub.hushed(GUEST, "club"));
        assert_eq!(
            audit(db)
                .await
                .pop()
                .map(|(_, _, action, _, name, _)| (action, name)),
            Some(("member.voice_unmute".to_string(), OTHER_GUEST.to_string()))
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn staff_actions_cover_the_address_read_at_the_check() {
        let Club {
            state,
            path,
            talk,
            other: _,
        } = club("guest_voice_check").await;
        guest_in(&state, GUEST, "club", talk).await;
        let user = |name: &str| mem_user(name, false);
        let kick = staff_on_guest(&state, &user("kim"), "club", GUEST, Perm::Kick)
            .await
            .expect("kim may");
        let hush = staff_on_guest(&state, &user("tim"), "club", GUEST, Perm::TimeoutMembers)
            .await
            .expect("tim may");
        state.hub.voice_leave(GUEST).await;
        guest_in(&state, OTHER_GUEST, "club", talk).await;
        hush_at(&state, &hush, GUEST, true)
            .await
            .expect("tim mutes");
        assert!(
            state.hub.hushed(OTHER_GUEST, "club"),
            "the guest's reload came back before the mute"
        );
        disconnect_at(&state, &kick, GUEST)
            .await
            .expect("kim kicks");
        assert_eq!(state.hub.room_in(OTHER_GUEST, "club"), None);
        assert_eq!(
            state
                .hub
                .guest_voice_join("@guest:00000000000000ee", 1, "club", talk, 0, Some(addr()))
                .await
                .err(),
            blocked()
        );
        done(state, path).await;
    }
}
