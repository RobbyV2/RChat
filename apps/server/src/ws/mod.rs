use std::collections::HashSet;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::api::access::{ws_server_open, ws_voice_viewable};
use crate::api::{Channel, ServerSummaryLite};
use crate::db::{ChannelKind, Db};
pub use crate::hub::Hub;
use crate::state::AppState;

mod access;
pub mod calls;
mod conn;
mod event;
mod filter;
mod p2p;
mod protocol;
mod repost;
mod rewrite;
mod typing;

pub(crate) use access::LogGate;
pub(crate) use calls::end_dm_call;
pub use conn::{__path_handler, handler};
pub use event::{
    CallPeer, CallRelays, EditStub, USER_SCOPE_DMS, USER_SCOPE_SERVERS, USER_SCOPE_SMALL, Updated,
    UserScope, WsEvent, to_bus_json, user_scope,
};
pub(crate) use p2p::presence_mode;
pub use protocol::{
    CLOSE_NO_AUTH, CLOSE_TOO_MANY, CLOSE_TOO_MANY_ADDR, CLOSE_TOO_MANY_GUESTS, CLOSE_TOO_OFTEN,
};
pub use repost::{
    announce_expired_passwords, announce_purge, depart, settle, spawn_aftermath, sweep_and_log,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CallPhase {
    Ringing,
    Active,
    Ended,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CallKind {
    Rtc,
    P2p,
}

const P2P_IDS_CAP: usize = 256;
const P2P_ID_MAX: usize = 128;
const P2P_WHO_CAP: usize = 64;
const P2P_WHO_EVERY: Duration = Duration::from_secs(2);
const P2P_WHO_TTL: Duration = Duration::from_secs(10);
const P2P_WHO_CACHE_MAX: usize = 1024;
const SUBSCRIBE_CAP: usize = 100;
const GUEST_SUBSCRIBE_CAP: usize = 50;
// Server access checks a connection may run for `subscribe`: a burst, then this many per second.
const SUB_CHECKS_BURST: f64 = 200.0;
const SUB_CHECKS_RATE: f64 = 20.0;
const GUEST_SUB_CHECKS_BURST: f64 = 100.0;
const GUEST_SUB_CHECKS_RATE: f64 = 5.0;
const FRAME_MAX: usize = 64 * 1024;
pub(crate) const SIGNAL_MAX: usize = 20 * 1024;
const OUT_FRAMES: usize = 256;
const SEND_TIMEOUT: Duration = Duration::from_secs(10);
const MSG_RATE: f64 = 50.0;
const MSG_BURST: f64 = 200.0;
pub(crate) const VOICE_ROOM_MAX: usize = 25;
pub const PURGE_CHUNK: usize = 500;
const PING_EVERY: Duration = Duration::from_secs(30);
const SILENT_LIMIT: Duration = Duration::from_secs(90);
const REAUTH_RETRY: Duration = Duration::from_secs(2);
const REAUTH_GIVE_UP: Duration = Duration::from_secs(30);
const LOG_EVERY: Duration = Duration::from_secs(10);
const LAG_REAUTH_EVERY: Duration = Duration::from_secs(2);
const P2P_ANNOUNCE_EVERY: Duration = Duration::from_secs(1);
const P2P_SCOPE_TTL: Duration = Duration::from_secs(60);
pub const TYPING_TTL: i64 = 8;
const TYPING_REFRESH: Duration = Duration::from_secs(2);
const TYPING_RATE: f64 = 1.0;
const TYPING_BURST: f64 = 4.0;
const TYPING_SCOPE_MAX: usize = 24;

pub(crate) async fn evict_unviewable(state: &AppState, server: &str, channel_id: Option<i64>) {
    for (cid, users) in state.hub.rooms_in(server, channel_id) {
        if let Ok(Some((owner, _))) = channel_now(&state.read(), cid).await
            && owner != server
        {
            continue;
        }
        for user in users {
            let open = ws_server_open(&state.read(), server, Some(&user), false, None)
                .await
                .unwrap_or(false);
            if !open || !ws_voice_viewable(&state.read(), server, cid, &user).await {
                state.hub.evict_voice(&user, cid);
            }
        }
    }
}

async fn channel_now(db: &Db, id: i64) -> sqlx::Result<Option<(String, Channel)>> {
    let row =
        sqlx::query("SELECT server, name, kind, slowmode_seconds, restrict_view, restrict_send, topic, category_id, position FROM channels WHERE id = $1")
            .bind(id)
            .fetch_optional(db)
            .await?;
    match row {
        Some(r) => Ok(Some((
            r.try_get(0)?,
            Channel {
                id,
                name: r.try_get(1)?,
                kind: ChannelKind::parse(&r.try_get::<String, _>(2)?)?,
                slowmode_seconds: r.try_get(3)?,
                restrict_view: r.try_get::<i64, _>(4)? != 0,
                restrict_send: r.try_get::<i64, _>(5)? != 0,
                topic: r.try_get(6)?,
                category_id: r.try_get(7)?,
                position: r.try_get(8)?,
            },
        ))),
        None => Ok(None),
    }
}

async fn admin_state(db: &Db, server: &str, user: &str) -> sqlx::Result<Option<(bool, i64)>> {
    let row =
        sqlx::query("SELECT is_admin, perms FROM members WHERE server = $1 AND username = $2")
            .bind(server)
            .bind(user)
            .fetch_optional(db)
            .await?;
    match row {
        Some(r) => Ok(Some((r.try_get::<i64, _>(0)? != 0, r.try_get(1)?))),
        None => Ok(None),
    }
}

async fn refresh_lite(db: &Db, name: &str) -> sqlx::Result<Option<ServerSummaryLite>> {
    let row = sqlx::query(
        "SELECT name, display_name, creator, password_hash, banner_color, name_color FROM servers WHERE name = $1 AND COALESCE(password_hash, '') <> '!purging'",
    )
    .bind(name)
    .fetch_optional(db)
    .await?;
    match row {
        Some(r) => Ok(Some(ServerSummaryLite {
            name: r.try_get(0)?,
            display_name: r.try_get(1)?,
            creator: r.try_get(2)?,
            has_password: r.try_get::<Option<String>, _>(3)?.is_some(),
            banner_color: r.try_get(4)?,
            name_color: r.try_get(5)?,
        })),
        None => Ok(None),
    }
}

async fn server_password_hash(db: &Db, server: &str) -> sqlx::Result<Option<Option<String>>> {
    Ok(
        sqlx::query("SELECT password_hash FROM servers WHERE name = $1")
            .bind(server)
            .fetch_optional(db)
            .await?
            .map(|r| r.try_get(0).unwrap_or(None)),
    )
}

async fn is_member(db: &Db, server: &str, user: &str) -> sqlx::Result<bool> {
    Ok(
        sqlx::query("SELECT 1 FROM members WHERE server = $1 AND username = $2")
            .bind(server)
            .bind(user)
            .fetch_optional(db)
            .await?
            .is_some(),
    )
}

async fn guest_sub_ok(db: &Db, server: &str, grant: Option<&str>) -> sqlx::Result<bool> {
    ws_server_open(db, server, None, false, grant).await
}

async fn authed_sub_ok(db: &Db, server: &str, user: &str, site_admin: bool) -> sqlx::Result<bool> {
    ws_server_open(db, server, Some(user), site_admin, None).await
}

async fn member_servers_of(db: &Db, user: &str) -> sqlx::Result<HashSet<String>> {
    Ok(
        sqlx::query("SELECT server FROM members WHERE username = $1")
            .bind(user)
            .fetch_all(db)
            .await?
            .iter()
            .filter_map(|r| r.try_get(0).ok())
            .collect(),
    )
}

async fn token_live(db: &Db, token: Option<&str>) -> sqlx::Result<bool> {
    match token {
        Some(token) => Ok(sqlx::query("SELECT 1 FROM tokens WHERE token = $1")
            .bind(crate::db::secret_key(token))
            .fetch_optional(db)
            .await?
            .is_some()),
        None => Ok(false),
    }
}

async fn session_of(db: &Db, token: &str) -> sqlx::Result<bool> {
    Ok(sqlx::query(
        "SELECT 1 FROM tokens t JOIN users u ON u.username = t.username WHERE t.token = $1 AND u.password_hash <> '!purging'",
    )
    .bind(crate::db::secret_key(token))
    .fetch_optional(db)
    .await?
    .is_some())
}

#[cfg(test)]
pub(crate) use repost::current;
#[cfg(test)]
mod tests;
