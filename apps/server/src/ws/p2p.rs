use std::collections::{BTreeMap, HashMap, HashSet};

use serde::Deserialize;
use sqlx::Row;
use tokio::time::Instant;

use super::access::{Access, Pace};
use super::conn::{Out, sent};
use super::event::{UserScope, WsEvent, user_scope};
use super::{
    P2P_ID_MAX, P2P_IDS_CAP, P2P_WHO_CACHE_MAX, P2P_WHO_CAP, P2P_WHO_EVERY, P2P_WHO_TTL,
    authed_sub_ok, member_servers_of,
};

use crate::api::Settings;
use crate::api::access::ws_channel_read_since;
use crate::db::{Db, now};
use crate::hub::P2pDrop;
use crate::state::AppState;

// What a tab hosts: its peer id, the file ids, and the relay hosts declared per file id.
pub(super) type Hosting = (String, Vec<String>, BTreeMap<String, Vec<String>>);

// Relay hosts declared once for several hosted files.
#[derive(Deserialize)]
pub(super) struct RelaySet {
    pub(super) hosts: Vec<String>,
    pub(super) ids: Vec<String>,
}

pub(super) async fn announce_hosting(
    state: &AppState,
    user: &str,
    conn: u64,
    (peer_id, ids, relays): Hosting,
    scope: P2pScope,
) {
    state
        .hub
        .set_p2p_relayed(user, conn, peer_id.clone(), ids.clone(), relays);
    state.hub.broadcast(p2p_online(user, peer_id, ids, scope));
}

pub(super) async fn announce_drop(
    state: &AppState,
    user: &str,
    drop: P2pDrop,
    cached: Option<P2pScope>,
) {
    let scope = async || match cached {
        Some(scope) => scope,
        None => p2p_scope(&state.read(), user).await,
    };
    match drop {
        P2pDrop::Kept => {}
        P2pDrop::Offline => {
            let (scope_servers, scope_users) = scope().await;
            state
                .hub
                .broadcast(p2p_offline(user.to_string(), scope_servers, scope_users));
        }
        P2pDrop::Remaining(peer_id, ids) => {
            let scope = scope().await;
            state.hub.broadcast(p2p_online(user, peer_id, ids, scope));
        }
    }
}

pub(super) struct Who {
    pub(super) pace: Pace,
    pub(super) pending: Vec<String>,
    pub(super) peers: HashMap<String, (Instant, Option<Peer>)>,
    pub(super) media: HashMap<(String, String), (Instant, bool)>,
}

#[derive(Clone)]
pub(super) struct Peer {
    offline: bool,
    dm: bool,
    servers: Vec<String>,
}

impl Who {
    pub(super) fn new() -> Who {
        Who {
            pace: Pace::new(P2P_WHO_EVERY),
            pending: Vec::new(),
            peers: HashMap::new(),
            media: HashMap::new(),
        }
    }

    pub(super) fn ask(&mut self, hosters: Vec<String>) {
        for hoster in hosters {
            let hoster = hoster.to_lowercase();
            if self.pending.len() >= P2P_WHO_CAP {
                break;
            }
            if !self.pending.contains(&hoster) {
                self.pending.push(hoster);
            }
        }
    }

    pub(super) fn soon(&mut self, hoster: &str, now: Instant) {
        self.ask(vec![hoster.to_string()]);
        if self.pace.due.is_none() {
            self.pace.due = Some(
                self.pace
                    .last
                    .map_or(now, |last| (last + self.pace.every).max(now)),
            );
        }
    }

    pub(super) fn forget(&mut self) {
        self.peers.clear();
        self.media.clear();
    }

    fn trim(&mut self, now: Instant) {
        if self.peers.len() > P2P_WHO_CACHE_MAX {
            self.peers.retain(|_, (at, _)| now < *at + P2P_WHO_TTL);
        }
        if self.peers.len() > P2P_WHO_CACHE_MAX {
            self.peers.clear();
        }
        if self.media.len() > P2P_WHO_CACHE_MAX {
            self.media.retain(|_, (at, _)| now < *at + P2P_WHO_TTL);
        }
        if self.media.len() > P2P_WHO_CACHE_MAX {
            self.media.clear();
        }
    }
}

/// Whether `user` appears offline, and the version of that setting (`users.presence_seq`).
pub(crate) async fn presence_mode(db: &Db, user: &str) -> sqlx::Result<Option<(bool, i64)>> {
    sqlx::query("SELECT appear_offline, presence_seq FROM users WHERE username = $1")
        .bind(user)
        .fetch_optional(db)
        .await?
        .map(|row| Ok((row.try_get::<i64, _>(0)? != 0, row.try_get::<i64, _>(1)?)))
        .transpose()
}

async fn appear_offline(db: &Db, hoster: &str) -> sqlx::Result<Option<bool>> {
    sqlx::query("SELECT appear_offline FROM users WHERE username = $1")
        .bind(hoster)
        .fetch_optional(db)
        .await?
        .map(|row| row.try_get::<i64, _>(0).map(|v| v != 0))
        .transpose()
}

async fn peer_facts(db: &Db, me: &str, hoster: &str) -> sqlx::Result<Option<Peer>> {
    let Some(offline) = appear_offline(db, hoster).await? else {
        return Ok(None);
    };
    let dm = sqlx::query(
        "SELECT 1 FROM dms WHERE (user_a = $1 AND user_b = $2) OR (user_a = $2 AND user_b = $1)",
    )
    .bind(me)
    .bind(hoster)
    .fetch_optional(db)
    .await?
    .is_some();
    let servers = member_servers_of(db, hoster).await?.into_iter().collect();
    Ok(Some(Peer {
        offline,
        dm,
        servers,
    }))
}

// Whether `hoster` shows as hosting to `me`, and which of their files `me` can read. Peer ids
// are never part of it: a reader gets one per download, through `p2p_peer`.
pub(super) async fn p2p_visible(
    state: &AppState,
    access: &mut Access,
    me: &str,
    hoster: &str,
) -> Option<Vec<String>> {
    let ids = state.hub.p2p_ids(hoster)?;
    if me == hoster {
        return Some(ids);
    }
    let db = state.read();
    let calling = state.hub.in_p2p_call(me, hoster);
    let now = Instant::now();
    let peer = match access.who.peers.get(hoster) {
        Some((at, peer)) if now < *at + P2P_WHO_TTL => match peer.clone() {
            Some(peer) => Some(Peer {
                offline: appear_offline(&db, hoster).await.ok()??,
                ..peer
            }),
            None => None,
        },
        Some(_) | None => {
            let peer = peer_facts(&db, me, hoster).await.ok()?;
            access.who.trim(now);
            access
                .who
                .peers
                .insert(hoster.to_string(), (now, peer.clone()));
            peer
        }
    }?;
    if peer.offline && !calling {
        return None;
    }
    let shared = peer.dm
        || calling
        || peer
            .servers
            .iter()
            .any(|s| access.member_servers.contains(s) || access.subs.contains(s));
    if !shared {
        return None;
    }
    let ids = match Settings::cached(&db).await.p2p_attachments {
        true if !p2p_blocked(state, me, hoster).await => {
            readable_p2p_ids(&db, access, me, hoster, ids).await
        }
        true | false => Vec::new(),
    };
    Some(ids)
}

// Whether either of the two blocked the other, read from the primary; errors count as blocked.
async fn p2p_blocked(state: &AppState, me: &str, hoster: &str) -> bool {
    let blocks = (
        crate::api::blocks::is_blocked(&state.db, me, hoster).await,
        crate::api::blocks::is_blocked(&state.db, hoster, me).await,
    );
    !matches!(blocks, (Ok(false), Ok(false)))
}

pub(super) const NOT_AVAILABLE: &str = "File not available";
pub(super) const RECONNECTING: &str = "Reconnecting, try again in a moment";
pub(super) const TOO_FAST: &str = "Too many requests, slow down";
pub(super) const CALLING_TOO_OFTEN: &str = "Calling too often, try again in a moment";

pub(super) fn p2p_refused(message_id: i64, error: &str) -> WsEvent {
    WsEvent::P2pPeer {
        message_id,
        peer_id: None,
        token: None,
        expires_at: None,
        error: Some(error.to_string()),
        relays: Vec::new(),
    }
}

// The answer to `p2p_peer`: the peer id of the hoster's tab that has the attachment of
// `message_id`, and a token for it, only for a signed-in user who can read that message. The
// hoster must be online (not appearing offline) and still host the file, and neither of the two
// may have blocked the other. Requests are rate
// limited per user, whatever the answer.
pub(super) async fn p2p_release(
    state: &AppState,
    access: &Access,
    message_id: i64,
    peer_id: &str,
) -> WsEvent {
    let deny = |error: &str| p2p_refused(message_id, error);
    let Some(me) = access.user.clone() else {
        return deny("Create an account to download P2P files");
    };
    if !state.hub.release_ok(&me) {
        return deny("Too many downloads at once, try again in a moment");
    }
    if !crate::p2p::valid_peer_id(peer_id) {
        return deny(NOT_AVAILABLE);
    }
    let db = state.read();
    if !Settings::cached(&db).await.p2p_attachments {
        return deny(NOT_AVAILABLE);
    }
    let row = sqlx::query(
        "SELECT m.media_id, m.channel_id, c.server, d.user_a, d.user_b, m.created_at, m.media_hoster, m.media_expires_at FROM messages m LEFT JOIN channels c ON c.id = m.channel_id LEFT JOIN dms d ON d.id = m.dm_id WHERE m.id = $1 AND m.media_kind = 'p2p' AND m.media_removed = 0",
    )
    .bind(message_id)
    .fetch_optional(&db)
    .await;
    let Ok(Some(row)) = row else {
        return deny(NOT_AVAILABLE);
    };
    let (Ok(media_id), Ok(Some(hoster)), Ok(expires)) = (
        row.try_get::<String, _>(0),
        row.try_get::<Option<String>, _>(6),
        row.try_get::<Option<i64>, _>(7),
    ) else {
        return deny(NOT_AVAILABLE);
    };
    let now = now();
    let live = expires.is_none_or(|at| at > now);
    if hoster == me || !live {
        return deny(NOT_AVAILABLE);
    }
    if !row_readable(&db, access, &me, &mut ReadCache::default(), &row).await {
        return deny(NOT_AVAILABLE);
    }
    if p2p_blocked(state, &me, &hoster).await {
        return deny(NOT_AVAILABLE);
    }
    let shown = matches!(appear_offline(&db, &hoster).await, Ok(Some(false)))
        || state.hub.in_p2p_call(&me, &hoster);
    let Some((hoster_peer, relays)) = state.hub.p2p_host_of(&hoster, &media_id).filter(|_| shown)
    else {
        return deny(NOT_AVAILABLE);
    };
    let exp = now + crate::p2p::TOKEN_TTL;
    let grant = crate::p2p::Grant {
        v: 1,
        message_id,
        p2p_id: media_id,
        requester: me,
        hoster,
        hoster_peer: hoster_peer.clone(),
        requester_peer: peer_id.to_string(),
        exp,
    };
    WsEvent::P2pPeer {
        message_id,
        peer_id: Some(hoster_peer),
        token: Some(crate::p2p::issue(&state.instance.p2p_secret, &grant)),
        expires_at: Some(exp),
        error: None,
        relays,
    }
}

async fn readable_p2p_ids(
    db: &Db,
    access: &mut Access,
    me: &str,
    hoster: &str,
    ids: Vec<String>,
) -> Vec<String> {
    let now = Instant::now();
    let cached = |access: &Access, id: &String| {
        access
            .who
            .media
            .get(&(hoster.to_string(), id.clone()))
            .filter(|(at, _)| now < *at + P2P_WHO_TTL)
            .map(|(_, readable)| *readable)
    };
    let unknown: Vec<String> = ids
        .iter()
        .filter(|id| cached(access, id).is_none())
        .cloned()
        .collect();
    if !unknown.is_empty() {
        let found = lookup_p2p_ids(db, access, me, hoster, &unknown).await;
        access.who.trim(now);
        for id in unknown {
            let readable = found.contains(&id);
            access
                .who
                .media
                .insert((hoster.to_string(), id), (now, readable));
        }
    }
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        if cached(access, &id) == Some(true) && !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

async fn lookup_p2p_ids(
    db: &Db,
    access: &Access,
    me: &str,
    hoster: &str,
    ids: &[String],
) -> Vec<String> {
    let sql = format!(
        "SELECT m.media_id, m.channel_id, c.server, d.user_a, d.user_b, m.created_at FROM messages m LEFT JOIN channels c ON c.id = m.channel_id LEFT JOIN dms d ON d.id = m.dm_id WHERE m.media_kind = 'p2p' AND m.media_removed = 0 AND m.media_hoster = $1 AND m.media_id IN ({})",
        (2..ids.len() + 2)
            .map(|n| format!("${n}"))
            .collect::<Vec<_>>()
            .join(", ")
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(hoster);
    for id in ids {
        query = query.bind(id);
    }
    let Ok(rows) = query.fetch_all(db).await else {
        return Vec::new();
    };
    let mut cache = ReadCache::default();
    let mut out: Vec<String> = Vec::new();
    for r in &rows {
        let Ok(id) = r.try_get::<String, _>(0) else {
            continue;
        };
        if !out.contains(&id) && row_readable(db, access, me, &mut cache, r).await {
            out.push(id);
        }
    }
    out
}

#[derive(Default)]
struct ReadCache {
    servers: HashMap<String, bool>,
    channels: HashMap<i64, Option<Option<i64>>>,
}

// Whether `me` can read a message row with channel_id, server, user_a, user_b and created_at in
// columns 1 to 5: server access, channel view and the read-history floor, or DM membership.
async fn row_readable(
    db: &Db,
    access: &Access,
    me: &str,
    cache: &mut ReadCache,
    r: &sqlx::any::AnyRow,
) -> bool {
    let channel: Option<i64> = r.try_get(1).ok().flatten();
    let server: Option<String> = r.try_get(2).ok().flatten();
    let pair: (Option<String>, Option<String>) =
        (r.try_get(3).ok().flatten(), r.try_get(4).ok().flatten());
    match (channel, server, pair) {
        (Some(cid), Some(server), _) => {
            let open = match cache.servers.get(&server) {
                Some(open) => *open,
                None => {
                    let open = authed_sub_ok(db, &server, me, access.site_admin)
                        .await
                        .unwrap_or(false);
                    cache.servers.insert(server.clone(), open);
                    open
                }
            };
            let hidden = access
                .viewable
                .get(&cid)
                .is_some_and(|(owner, view)| !*view || *owner != server);
            let since = match (hidden, cache.channels.get(&cid)) {
                (true, _) => None,
                (false, Some(since)) => *since,
                (false, None) => {
                    let since = ws_channel_read_since(db, &server, cid, me).await;
                    cache.channels.insert(cid, since);
                    since
                }
            };
            let created_at: Option<i64> = r.try_get(5).ok();
            open && since.is_some_and(|floor| {
                floor.is_none_or(|floor| created_at.is_some_and(|at| at >= floor))
            })
        }
        (_, _, (Some(a), Some(b))) => a == me || b == me,
        (_, _, _) => false,
    }
}

pub(super) type P2pScope = (Vec<String>, Vec<String>);

pub(super) async fn p2p_scope(db: &Db, user: &str) -> P2pScope {
    let UserScope {
        mut servers,
        views,
        users,
    } = user_scope(db, user).await;
    servers.extend(views);
    (servers, users)
}

fn p2p_online(
    hoster: &str,
    peer_id: String,
    ids: Vec<String>,
    (scope_servers, scope_users): P2pScope,
) -> WsEvent {
    WsEvent::P2pAvailability {
        hoster: hoster.to_string(),
        peer_id: Some(peer_id),
        ids,
        online: true,
        scope_servers,
        scope_users,
    }
}

pub(super) fn p2p_offline(
    hoster: String,
    scope_servers: Vec<String>,
    scope_users: Vec<String>,
) -> WsEvent {
    WsEvent::P2pAvailability {
        hoster,
        peer_id: None,
        ids: Vec::new(),
        online: false,
        scope_servers,
        scope_users,
    }
}

pub(super) async fn answer_who(state: &AppState, access: &mut Access, out: &Out) -> bool {
    let me = access.user.clone();
    for hoster in std::mem::take(&mut access.who.pending) {
        let shown = match &me {
            Some(me) => p2p_visible(state, access, me, &hoster).await,
            None => None,
        };
        let ev = match shown {
            Some(ids) => WsEvent::P2pAvailability {
                hoster,
                peer_id: None,
                ids,
                online: true,
                scope_servers: Vec::new(),
                scope_users: Vec::new(),
            },
            None => p2p_offline(hoster, Vec::new(), Vec::new()),
        };
        if !sent(access, out.event(&ev)) {
            return false;
        }
    }
    true
}

/// Which of `ids` are live P2P attachments hosted by `user`: not removed, not expired. `None`
/// when the database can't say, so nothing is dropped by mistake.
pub(super) async fn live_hosted(db: &Db, user: &str, ids: &[String]) -> Option<Vec<String>> {
    if ids.is_empty() {
        return Some(Vec::new());
    }
    let sql = format!(
        "SELECT DISTINCT media_id FROM messages WHERE media_kind = 'p2p' AND media_removed = 0 AND media_hoster = $1 AND (media_expires_at IS NULL OR media_expires_at > $2) AND media_id IN ({})",
        crate::api::placeholders(3, ids.len())
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(user)
        .bind(crate::db::now());
    for id in ids {
        query = query.bind(id);
    }
    let rows = query.fetch_all(db).await.ok()?;
    Some(
        rows.iter()
            .filter_map(|r| r.try_get::<String, _>(0).ok())
            .collect(),
    )
}

pub(super) fn hosting_ids(ids: Vec<String>) -> Vec<String> {
    ids.into_iter()
        .filter(|id| id.len() <= P2P_ID_MAX)
        .take(P2P_IDS_CAP)
        .collect()
}

// The hosted ids and their declared relay hosts (no empty lists), from the per-id map and the
// shared sets. An id with an invalid list, or two different lists, is left out.
pub(super) fn hosting_relays(
    ids: Vec<String>,
    relays: BTreeMap<String, Vec<String>>,
    sets: Vec<RelaySet>,
) -> (Vec<String>, BTreeMap<String, Vec<String>>) {
    let hosted: HashSet<&String> = ids.iter().collect();
    let mut lists: BTreeMap<String, Option<Vec<String>>> = BTreeMap::new();
    let mut add = |id: String, hosts: Option<Vec<String>>| {
        if !hosted.contains(&id) {
            return;
        }
        let next = match (lists.remove(&id), hosts) {
            (None, hosts) => hosts,
            (Some(Some(a)), Some(b)) if a == b => Some(a),
            (Some(_), _) => None,
        };
        lists.insert(id, next);
    };
    for (id, hosts) in relays {
        add(id, crate::p2p::relay_hosts(hosts).ok());
    }
    for RelaySet { hosts, ids: set } in sets.into_iter().take(P2P_IDS_CAP) {
        let hosts = crate::p2p::relay_hosts(hosts).ok();
        for id in set.into_iter().take(P2P_IDS_CAP) {
            add(id, hosts.clone());
        }
    }
    let kept = ids
        .into_iter()
        .filter(|id| !matches!(lists.get(id), Some(None)))
        .collect();
    let relays = lists
        .into_iter()
        .filter_map(|(id, hosts)| hosts.filter(|h| !h.is_empty()).map(|h| (id, h)))
        .collect();
    (kept, relays)
}
