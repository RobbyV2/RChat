use std::collections::HashMap;

use axum::http::{HeaderMap, StatusCode};
use sqlx::Row;

use crate::api::auth::{dummy_hash, verify_password};
use crate::api::{ApiError, ServerSummaryLite, header_grants};
use crate::db::{
    ChannelAccess, ChannelKind, Db, LIVE_AUTHOR, LIVE_DM, MediaKind, Perm, PermRow, User,
    can_grant, can_moderate, fold_access, now, perm_row, perm_subjects,
};

mod rules;

use rules::{
    channel_access, channel_viewable, effective_perms, grant_live, is_banned, live_grant_servers,
    member_perms,
};

pub const DENIED: &str = "Server not found or wrong password";
pub const PASSWORD_REQUIRED: &str = "Password required";
pub const NOT_FOUND: &str = "Not found";
pub const BANNED: &str = "You are banned from this server";

pub fn denied() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, DENIED.to_string())
}

pub fn password_required() -> ApiError {
    ApiError(StatusCode::UNAUTHORIZED, PASSWORD_REQUIRED.to_string())
}

pub fn not_found() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, NOT_FOUND.to_string())
}

fn banned() -> ApiError {
    ApiError(StatusCode::FORBIDDEN, BANNED.to_string())
}

fn forbidden(msg: &str) -> ApiError {
    ApiError(StatusCode::FORBIDDEN, msg.to_string())
}

fn hidden(e: ApiError) -> ApiError {
    match e {
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, _) => e,
        _ => not_found(),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Via {
    Public,
    Member,
    Password,
    Grant,
    Staff,
}

#[derive(Clone, Copy)]
enum Slot<'a> {
    Closed,
    Open(Option<&'a str>),
}

pub struct Proof<'a> {
    password: Slot<'a>,
    grants: Vec<String>,
}

impl<'a> Proof<'a> {
    pub fn none() -> Proof<'static> {
        Proof {
            password: Slot::Closed,
            grants: Vec::new(),
        }
    }

    pub fn grants(grants: Vec<String>) -> Proof<'static> {
        Proof {
            password: Slot::Closed,
            grants,
        }
    }

    pub fn headers(headers: &HeaderMap) -> Proof<'static> {
        Proof::grants(header_grants(headers))
    }

    pub fn password(password: Option<&'a str>) -> Proof<'a> {
        Proof {
            password: Slot::Open(password.map(str::trim).filter(|p| !p.is_empty())),
            grants: Vec::new(),
        }
    }

    pub fn and_grants(self, grants: Vec<String>) -> Proof<'a> {
        Proof { grants, ..self }
    }
}

#[cfg(test)]
thread_local! {
    static VERIFIES: std::cell::Cell<(u64, u64)> = const { std::cell::Cell::new((0, 0)) };
}

#[cfg(test)]
pub(crate) fn verify_counts() -> (u64, u64) {
    VERIFIES.with(|c| c.get())
}

async fn check_password(given: &str, hash: Option<&str>) -> bool {
    #[cfg(test)]
    VERIFIES.with(|c| {
        let (real, dummy) = c.get();
        c.set(match hash {
            Some(_) => (real + 1, dummy),
            None => (real, dummy + 1),
        });
    });
    match hash {
        Some(hash) => verify_password(given, hash).await,
        None => {
            verify_password(given, dummy_hash().await).await;
            false
        }
    }
}

#[derive(Clone, Copy)]
struct Who<'a> {
    username: Option<&'a str>,
    site_admin: bool,
}

impl<'a> Who<'a> {
    fn of(user: Option<&'a User>) -> Who<'a> {
        Who {
            username: user.map(|u| u.username.as_str()),
            site_admin: user.is_some_and(|u| u.is_site_admin),
        }
    }
}

struct Gate {
    lite: ServerSummaryLite,
    via: Via,
    banned: bool,
}

async fn exists(db: &Db, sql: &'static str, server: &str, username: &str) -> sqlx::Result<bool> {
    Ok(sqlx::query(sql)
        .bind(server)
        .bind(username)
        .fetch_optional(db)
        .await?
        .is_some())
}

async fn gate(db: &Db, name: &str, who: Who<'_>, proof: &Proof<'_>) -> Result<Gate, ApiError> {
    let key = name.to_lowercase();
    let row = sqlx::query(
        "SELECT name, display_name, creator, password_hash, banner_color, name_color FROM servers WHERE name = $1 AND COALESCE(password_hash, '') <> '!purging'",
    )
    .bind(&key)
    .fetch_optional(db)
    .await?;
    let (member, banned, history) = match who.username {
        Some(u) => (
            exists(
                db,
                "SELECT 1 FROM members WHERE server = $1 AND username = $2",
                &key,
                u,
            )
            .await?,
            exists(
                db,
                "SELECT 1 FROM server_bans WHERE server = $1 AND username = $2",
                &key,
                u,
            )
            .await?,
            exists(
                db,
                "SELECT 1 FROM interactions WHERE server = $1 AND username = $2",
                &key,
                u,
            )
            .await?,
        ),
        None => (false, false, false),
    };
    let mut granted = false;
    if who.username.is_none() {
        for grant in &proof.grants {
            if grant_live(db, grant, &key).await? {
                granted = true;
                break;
            }
        }
    }
    let Some(row) = row else {
        return Err(match proof.password {
            Slot::Open(Some(given)) => {
                check_password(given, None).await;
                denied()
            }
            Slot::Open(None) => password_required(),
            Slot::Closed => denied(),
        });
    };
    let hash: Option<String> = row.try_get(3)?;
    let lite = ServerSummaryLite {
        name: row.try_get(0)?,
        display_name: row.try_get(1)?,
        creator: row.try_get(2)?,
        has_password: hash.is_some(),
        banner_color: row.try_get(4)?,
        name_color: row.try_get(5)?,
    };
    let via = match (hash.as_deref(), member) {
        (_, true) => Via::Member,
        (None, false) => Via::Public,
        (Some(hash), false) => match (granted, who.site_admin, proof.password) {
            (true, _, _) => Via::Grant,
            (false, true, Slot::Closed) => Via::Staff,
            (false, _, Slot::Open(Some(given))) => match check_password(given, Some(hash)).await {
                true => Via::Password,
                false => return Err(denied()),
            },
            (false, _, Slot::Open(None)) if banned && history => return Err(self::banned()),
            (false, _, Slot::Open(None)) => return Err(password_required()),
            (false, _, Slot::Closed) if banned && history => return Err(self::banned()),
            (false, _, Slot::Closed) => return Err(denied()),
        },
    };
    Ok(Gate { lite, via, banned })
}

pub struct ServerAccess {
    lite: ServerSummaryLite,
    via: Via,
    user: Option<User>,
}

pub async fn resolve_server(
    db: &Db,
    name: &str,
    viewer: Option<&User>,
    proof: &Proof<'_>,
) -> Result<ServerAccess, ApiError> {
    match resolve_invite(db, name, viewer, proof).await? {
        InviteView::Banned(_) => Err(banned()),
        InviteView::Open(access) => Ok(access),
    }
}

pub enum InviteView {
    Banned(ServerSummaryLite),
    Open(ServerAccess),
}

pub async fn resolve_invite(
    db: &Db,
    name: &str,
    viewer: Option<&User>,
    proof: &Proof<'_>,
) -> Result<InviteView, ApiError> {
    let Gate { lite, via, banned } = gate(db, name, Who::of(viewer), proof).await?;
    match banned {
        true => Ok(InviteView::Banned(lite)),
        false => Ok(InviteView::Open(ServerAccess {
            lite,
            via,
            user: viewer.cloned(),
        })),
    }
}

impl ServerAccess {
    pub fn name(&self) -> &str {
        &self.lite.name
    }

    pub fn lite(&self) -> &ServerSummaryLite {
        &self.lite
    }

    pub fn via(&self) -> Via {
        self.via
    }

    pub fn is_member(&self) -> bool {
        self.via == Via::Member
    }

    pub fn viewer(&self) -> Option<&User> {
        self.user.as_ref()
    }

    pub fn require_member(&self) -> Result<(), ApiError> {
        match self.is_member() {
            true => Ok(()),
            false => Err(forbidden("Not a member")),
        }
    }

    pub async fn perms(&self, db: &Db) -> Result<i64, ApiError> {
        match &self.user {
            Some(user) => Ok(effective_perms(db, self.name(), user).await?),
            None => Ok(0),
        }
    }

    pub async fn member_perms(&self, db: &Db, username: &str) -> Result<i64, ApiError> {
        Ok(member_perms(db, self.name(), username).await?)
    }

    pub async fn has_perm(&self, db: &Db, perm: Perm) -> bool {
        self.perms(db).await.is_ok_and(|p| p & perm as i64 != 0)
    }

    pub async fn require_perm(&self, db: &Db, perm: Perm) -> Result<(), ApiError> {
        match self.has_perm(db, perm).await {
            true => Ok(()),
            false => Err(forbidden("Missing permission")),
        }
    }

    pub async fn manages_channels(&self, db: &Db) -> Result<bool, ApiError> {
        Ok(self.perms(db).await? & Perm::ManageChannels as i64 != 0)
    }

    pub fn site_admin(&self) -> bool {
        self.user.as_ref().is_some_and(|u| u.is_site_admin)
    }

    pub async fn require_moderate(&self, db: &Db, target: &str) -> Result<(), ApiError> {
        let mine = self.perms(db).await?;
        let theirs = self.member_perms(db, target).await?;
        match can_moderate(mine, self.site_admin(), theirs) {
            true => Ok(()),
            false => Err(forbidden("You can't moderate this member")),
        }
    }

    pub async fn require_grant(&self, db: &Db, perms: i64) -> Result<(), ApiError> {
        let mine = self.perms(db).await?;
        match can_grant(mine, self.site_admin(), perms) {
            true => Ok(()),
            false => Err(forbidden("You can't grant permissions you don't have")),
        }
    }

    pub async fn channel(self, db: &Db, id: i64) -> Result<ResolvedChannel, ApiError> {
        let row = sqlx::query(
            "SELECT server, kind, name, slowmode_seconds FROM channels WHERE id = $1 AND server = $2",
        )
        .bind(id)
        .bind(self.name())
        .fetch_optional(db)
        .await?
        .ok_or_else(not_found)?;
        let rights = channel_access(db, self.name(), id, self.user.as_ref()).await?;
        if !rights.view {
            return Err(not_found());
        }
        Ok(ResolvedChannel {
            id,
            kind: ChannelKind::parse(&row.try_get::<String, _>(1)?)?,
            name: row.try_get(2)?,
            slowmode: row.try_get(3)?,
            rights,
            server: self,
        })
    }
}

pub struct ResolvedChannel {
    server: ServerAccess,
    id: i64,
    kind: ChannelKind,
    name: String,
    slowmode: i64,
    rights: ChannelAccess,
}

pub async fn resolve_channel(
    db: &Db,
    id: i64,
    viewer: Option<&User>,
    proof: &Proof<'_>,
) -> Result<ResolvedChannel, ApiError> {
    let server: String = sqlx::query("SELECT server FROM channels WHERE id = $1")
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(not_found)?
        .try_get(0)?;
    resolve_server(db, &server, viewer, proof)
        .await
        .map_err(hidden)?
        .channel(db, id)
        .await
}

impl ResolvedChannel {
    pub fn id(&self) -> i64 {
        self.id
    }

    pub fn server(&self) -> &ServerAccess {
        &self.server
    }

    pub fn kind(&self) -> ChannelKind {
        self.kind
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub async fn read_since(&self, db: &Db) -> Result<Option<i64>, ApiError> {
        if self.rights.history {
            return Ok(None);
        }
        let Some(user) = &self.server.user else {
            return Ok(Some(now()));
        };
        let row = sqlx::query("SELECT joined_at FROM members WHERE server = $1 AND username = $2")
            .bind(self.server.name())
            .bind(&user.username)
            .fetch_optional(db)
            .await?;
        match &row {
            Some(r) => Ok(Some(r.try_get(0)?)),
            None => Ok(Some(now())),
        }
    }

    pub async fn send_gate(&self, db: &Db) -> Result<(), ApiError> {
        let Some(user) = &self.server.user else {
            return Err(forbidden("Not a member"));
        };
        self.server.require_member()?;
        if self.kind == ChannelKind::Voice {
            return Err(ApiError(
                StatusCode::BAD_REQUEST,
                "Voice channels cannot receive messages".to_string(),
            ));
        }
        if !self.rights.send {
            return Err(forbidden("No permission to send in this channel"));
        }
        if self.slowmode <= 0 {
            return Ok(());
        }
        let exempt = self.server.perms(db).await?
            & (Perm::ManageChannels as i64 | Perm::DeleteMessages as i64)
            != 0;
        if exempt {
            return Ok(());
        }
        let last: Option<i64> = sqlx::query(
            "SELECT created_at FROM messages WHERE channel_id = $1 AND author = $2 ORDER BY id DESC LIMIT 1",
        )
        .bind(self.id)
        .bind(&user.username)
        .fetch_optional(db)
        .await?
        .map(|r| r.try_get(0))
        .transpose()?;
        match last {
            Some(t) if now() - t < self.slowmode => Err(ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                format!("Slow mode: wait {}s", self.slowmode - (now() - t)),
            )),
            _ => Ok(()),
        }
    }
}

pub struct MsgScope {
    pub channel_id: Option<i64>,
    pub dm_id: Option<i64>,
    pub thread_root_id: Option<i64>,
    pub author: String,
    pub media_id: Option<String>,
    pub media_filename: Option<String>,
    pub media_kind: MediaKind,
    pub server: Option<String>,
    pub dm_users: Option<Vec<String>>,
}

pub struct ResolvedMessage {
    scope: MsgScope,
    channel: Option<ResolvedChannel>,
    user: Option<User>,
}

async fn dm_pair(db: &Db, id: i64, live: bool) -> Result<Option<Vec<String>>, ApiError> {
    let sql = match live {
        true => format!("SELECT user_a, user_b FROM dms WHERE id = $1 AND {LIVE_DM}"),
        false => "SELECT user_a, user_b FROM dms WHERE id = $1".to_string(),
    };
    let row = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_optional(db)
        .await?;
    match row {
        Some(r) => Ok(Some(vec![r.try_get(0)?, r.try_get(1)?])),
        None => Ok(None),
    }
}

pub async fn resolve_dm(db: &Db, id: i64, user: &User) -> Result<Vec<String>, ApiError> {
    match dm_pair(db, id, true).await? {
        Some(users) if users.contains(&user.username) => Ok(users),
        _ => Err(not_found()),
    }
}

async fn message_row(db: &Db, id: i64) -> Result<(MsgScope, i64), ApiError> {
    let sql = format!(
        "SELECT m.channel_id, m.dm_id, m.thread_root_id, m.author, m.media_id, m.media_filename, m.media_kind, m.created_at FROM messages m WHERE m.id = $1 AND {LIVE_AUTHOR}"
    );
    let r = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(not_found)?;
    Ok((
        MsgScope {
            channel_id: r.try_get(0)?,
            dm_id: r.try_get(1)?,
            thread_root_id: r.try_get(2)?,
            author: r.try_get(3)?,
            media_id: r.try_get(4)?,
            media_filename: r.try_get(5)?,
            media_kind: MediaKind::parse(&r.try_get::<String, _>(6)?)?,
            server: None,
            dm_users: None,
        },
        r.try_get(7)?,
    ))
}

pub async fn resolve_message(
    db: &Db,
    id: i64,
    viewer: Option<&User>,
    proof: &Proof<'_>,
) -> Result<ResolvedMessage, ApiError> {
    let (mut scope, created_at) = message_row(db, id).await?;
    let channel = match (scope.channel_id, scope.dm_id) {
        (Some(cid), _) => {
            let channel = resolve_channel(db, cid, viewer, proof).await?;
            if channel
                .read_since(db)
                .await?
                .is_some_and(|since| created_at < since)
            {
                return Err(not_found());
            }
            scope.server = Some(channel.server.name().to_string());
            Some(channel)
        }
        (None, Some(did)) => {
            let users = dm_pair(db, did, false).await?.ok_or_else(not_found)?;
            if !viewer.is_some_and(|u| users.contains(&u.username)) {
                return Err(not_found());
            }
            scope.dm_users = Some(users);
            None
        }
        (None, None) if viewer.is_some_and(|u| u.username == scope.author) => None,
        (None, None) => return Err(not_found()),
    };
    Ok(ResolvedMessage {
        scope,
        channel,
        user: viewer.cloned(),
    })
}

pub async fn staff_message(db: &Db, user: &User, id: i64) -> Result<MsgScope, ApiError> {
    if !user.is_site_admin {
        return Err(not_found());
    }
    let (mut scope, _) = message_row(db, id).await?;
    match (scope.channel_id, scope.dm_id) {
        (Some(cid), _) => {
            scope.server = sqlx::query("SELECT server FROM channels WHERE id = $1")
                .bind(cid)
                .fetch_optional(db)
                .await?
                .map(|r| r.try_get(0))
                .transpose()?;
        }
        (None, Some(did)) => scope.dm_users = dm_pair(db, did, false).await?,
        (None, None) => {}
    }
    Ok(scope)
}

impl ResolvedMessage {
    pub fn scope(&self) -> &MsgScope {
        &self.scope
    }

    pub fn into_scope(self) -> MsgScope {
        self.scope
    }

    pub fn channel(&self) -> Option<&ResolvedChannel> {
        self.channel.as_ref()
    }

    pub fn thread_channel(&self) -> Result<&ResolvedChannel, ApiError> {
        match (&self.channel, self.scope.thread_root_id) {
            (Some(channel), None) => Ok(channel),
            (_, _) => Err(ApiError(
                StatusCode::BAD_REQUEST,
                "Threads only start on channel messages".to_string(),
            )),
        }
    }

    pub async fn require_can_delete(&self, db: &Db) -> Result<(), ApiError> {
        let own = self
            .user
            .as_ref()
            .is_some_and(|u| u.username == self.scope.author);
        let allowed = own
            || match &self.channel {
                Some(channel) => channel.server.has_perm(db, Perm::DeleteMessages).await,
                None => false,
            };
        match allowed {
            true => Ok(()),
            false => Err(forbidden("Not allowed")),
        }
    }
}

/// Restricted text-channel rights of `user` across the servers it is a member of (unread
/// counts). Membership is the proof: rows of servers the user has not joined never load.
pub(crate) async fn member_channel_rights(
    db: &Db,
    user: &User,
) -> Result<HashMap<i64, ChannelAccess>, ApiError> {
    let rows = sqlx::query(
        "SELECT cp.channel_id, c.server, cp.subject, cp.can_view, cp.can_send, cp.can_read_history FROM channel_perms cp JOIN channels c ON c.id = cp.channel_id JOIN members mem ON mem.server = c.server AND mem.username = $1 WHERE c.kind = 'text'",
    )
    .bind(&user.username)
    .fetch_all(db)
    .await?;
    if rows.is_empty() {
        return Ok(HashMap::new());
    }
    let subjects = perm_subjects(db, None, &user.username).await?;
    let mut restricted: HashMap<i64, (String, Vec<PermRow>)> = HashMap::new();
    for r in &rows {
        let (id, server): (i64, String) = (r.try_get(0)?, r.try_get(1)?);
        restricted
            .entry(id)
            .or_insert_with(|| (server, Vec::new()))
            .1
            .push(perm_row(r, 2)?);
    }
    let mut manages: HashMap<String, bool> = HashMap::new();
    let mut out = HashMap::with_capacity(restricted.len());
    for (id, (server, perms)) in restricted {
        let manage = match manages.get(&server) {
            Some(m) => *m,
            None => {
                let m =
                    effective_perms(db, &server, user).await? & Perm::ManageChannels as i64 != 0;
                manages.insert(server, m);
                m
            }
        };
        out.insert(id, fold_access(&perms, &subjects, manage));
    }
    Ok(out)
}

/// Servers a guest may search: the ones its live grants in `proof` open.
pub(crate) async fn granted_servers(db: &Db, proof: &Proof<'_>) -> sqlx::Result<Vec<String>> {
    live_grant_servers(db, &proof.grants).await
}

/// Servers where `user` manages channels (search sees their restricted channels).
pub(crate) async fn channel_manager_servers(db: &Db, user: &User) -> sqlx::Result<Vec<String>> {
    rules::channel_manager_servers(db, user).await
}

/// WS event filtering and voice eviction: can `username` (or a guest) see channel `cid` of
/// `server` right now. Never answers a client with target data.
pub(crate) async fn ws_channel_view(
    db: &Db,
    server: &str,
    cid: i64,
    username: Option<&str>,
) -> sqlx::Result<bool> {
    let user = match username {
        Some(name) => crate::db::get_user(db, name).await?,
        None => None,
    };
    Ok(channel_access(db, server, cid, user.as_ref()).await?.view)
}

/// Same as `ws_channel_view`, with any error meaning "not viewable".
pub(crate) async fn ws_channel_viewable(
    db: &Db,
    server: &str,
    cid: i64,
    username: Option<&str>,
) -> bool {
    channel_viewable(db, server, cid, username).await
}

/// WS ban fan-out and `look`: whether `username` is banned from `server`. Only used to drop
/// events or skip a subscription, never sent to anyone else.
pub(crate) async fn ws_banned(db: &Db, server: &str, username: &str) -> sqlx::Result<bool> {
    is_banned(db, server, username).await
}

#[cfg(test)]
pub(crate) async fn reference_channel_access(
    db: &Db,
    server: &str,
    cid: i64,
    user: Option<&User>,
) -> sqlx::Result<ChannelAccess> {
    channel_access(db, server, cid, user).await
}

fn ws_result(res: Result<bool, ApiError>) -> sqlx::Result<bool> {
    match res {
        Ok(open) => Ok(open),
        Err(ApiError(StatusCode::INTERNAL_SERVER_ERROR, e)) => Err(sqlx::Error::Protocol(e)),
        Err(_) => Ok(false),
    }
}

pub(crate) async fn ws_server_open(
    db: &Db,
    name: &str,
    username: Option<&str>,
    site_admin: bool,
    grant: Option<&str>,
) -> sqlx::Result<bool> {
    let proof = Proof::grants(grant.map(str::to_string).into_iter().collect());
    let who = Who {
        username,
        site_admin,
    };
    ws_result(gate(db, name, who, &proof).await.map(|g| !g.banned))
}

pub(crate) async fn ws_voice_channel(
    db: &Db,
    username: &str,
    id: i64,
) -> Result<ResolvedChannel, String> {
    let user = crate::db::get_user(db, username)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Channel not found".to_string())?;
    match resolve_channel(db, id, Some(&user), &Proof::none()).await {
        Ok(channel) => Ok(channel),
        Err(ApiError(StatusCode::INTERNAL_SERVER_ERROR, e)) => Err(e),
        Err(_) => Err("Channel not found".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;

    use super::*;
    use crate::api::auth::{hash_password, verify_runs};
    use crate::api::routes;
    use crate::api::test_util::{add_member, done, mem_user, temp_state};
    use crate::config::Roles;
    use crate::server::client_ip::{ClientIp, ProxyTrust};
    use crate::state::AppState;

    const HANDLERS: [(&str, &str); 13] = [
        ("servers.rs", include_str!("servers.rs")),
        ("messages.rs", include_str!("messages.rs")),
        ("media.rs", include_str!("media.rs")),
        ("embeds.rs", include_str!("embeds.rs")),
        ("users.rs", include_str!("users.rs")),
        ("dms.rs", include_str!("dms.rs")),
        ("admin.rs", include_str!("admin.rs")),
        ("auth.rs", include_str!("auth.rs")),
        ("mod.rs", include_str!("mod.rs")),
        ("ws.rs", include_str!("../ws.rs")),
        ("hub.rs", include_str!("../hub.rs")),
        ("fanout.rs", include_str!("../fanout.rs")),
        ("db.rs", include_str!("../db.rs")),
    ];

    fn calls(code: &str, token: &str) -> bool {
        code.match_indices(token).any(|(at, _)| {
            !code[..at]
                .chars()
                .next_back()
                .is_some_and(|c| c == '.' || c == '_' || c.is_alphanumeric())
        })
    }

    #[test]
    fn the_gate_lint_sees_free_calls_only() {
        assert!(calls("let b = is_banned(db, s, u)", "is_banned("));
        assert!(calls("crate::db::grant_live(db, g, s)", "grant_live("));
        assert!(!calls("access.has_perm(db, p)", "has_perm(db"));
        assert!(!calls("ws_banned(db, s, u)", "is_banned("));
        assert!(!calls(
            "ws_channel_viewable(db, s, c, u)",
            "channel_viewable("
        ));
    }

    #[test]
    fn handlers_only_reach_servers_through_the_gate() {
        let banned = [
            "effective_perms(",
            "member_perms(db",
            "has_perm(db",
            "channel_access(",
            "channel_viewable(",
            "manages_channels(db",
            "is_banned(",
            "grant_live(",
            "live_grant_servers(",
            "server_lite(",
            "require_server(",
            "require_server_view(",
            "message_scope(",
        ];
        for (file, source) in HANDLERS {
            let code = [
                "#[cfg(test)]\nmod tests",
                "#[cfg(test)]\npub(crate) mod tests",
            ]
            .iter()
            .fold(source, |code, marker| {
                code.split(marker).next().expect("code")
            });
            for token in banned {
                assert!(!calls(code, token), "{file} calls {token}");
            }
        }
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

    struct Fixture {
        vault_channel: i64,
        vault_message: i64,
        hidden_channel: i64,
        hidden_message: i64,
    }

    async fn fixture(state: &AppState) -> Fixture {
        let db = &state.db;
        for (name, admin) in [("alice", 0), ("bob", 0), ("root", 1)] {
            sqlx::query("INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, is_site_admin, created_at) VALUES($1, $1, 'x', 'text', 'identicon', $2, 0)")
                .bind(name)
                .bind(admin)
                .execute(db)
                .await
                .expect("user");
            sqlx::query("INSERT INTO tokens(token, username, created_at) VALUES($1, $1, 0)")
                .bind(name)
                .execute(db)
                .await
                .expect("token");
        }
        let hash = hash_password("pw").await.expect("hash");
        sqlx::query("INSERT INTO servers(name, display_name, creator, password_hash, created_at) VALUES('vault', 'Vault', 'alice', $1, 0)")
            .bind(hash)
            .execute(db)
            .await
            .expect("vault");
        add_member(db, "vault", "alice", 1, 0, 0).await;
        add_member(db, "rchat", "alice", 0, 0, 0).await;
        add_member(db, "rchat", "bob", 0, 0, 0).await;
        let vault_channel = id_of(
            db,
            "INSERT INTO channels(server, name, created_at) VALUES('vault', 'general', 0) RETURNING id",
        )
        .await;
        let vault_message = id_of(db, &format!("INSERT INTO messages(channel_id, author, content, created_at) VALUES({vault_channel}, 'alice', 'secret', 1) RETURNING id")).await;
        let hidden_channel = id_of(
            db,
            "INSERT INTO channels(server, name, created_at) VALUES('rchat', 'staff', 0) RETURNING id",
        )
        .await;
        exec(db, &format!("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES({hidden_channel}, 'u:alice', 1, 1, 1)")).await;
        let hidden_message = id_of(db, &format!("INSERT INTO messages(channel_id, author, content, created_at) VALUES({hidden_channel}, 'alice', 'hush', 1) RETURNING id")).await;
        exec(
            db,
            "INSERT INTO roles(server, name, color, perms) VALUES('vault', 'r', '#ffffff', 0)",
        )
        .await;
        Fixture {
            vault_channel,
            vault_message,
            hidden_channel,
            hidden_message,
        }
    }

    struct Client {
        addr: SocketAddr,
        http: reqwest::Client,
        n: std::cell::Cell<u32>,
    }

    type Reply = (u16, Vec<(String, String)>, Vec<u8>);

    impl Client {
        async fn call(
            &self,
            method: &str,
            path: &str,
            token: Option<&str>,
            body: Option<&str>,
            headers: &[(&str, &str)],
        ) -> Reply {
            let n = self.n.get() + 1;
            self.n.set(n);
            let url = format!("http://{}/{}", self.addr, path.trim_start_matches('/'));
            let mut req = self
                .http
                .request(method.parse().expect("method"), url)
                .header("X-Forwarded-For", format!("10.9.{}.{}", n / 250, n % 250));
            if let Some(token) = token {
                req = req.bearer_auth(token);
            }
            if let Some(body) = body {
                req = req
                    .header("content-type", "application/json")
                    .body(body.to_string());
            }
            for (k, v) in headers {
                req = req.header(*k, *v);
            }
            let res = req.send().await.expect("request");
            let status = res.status().as_u16();
            let mut headers: Vec<(String, String)> = res
                .headers()
                .iter()
                .filter(|(k, _)| *k != axum::http::header::DATE)
                .map(|(k, v)| {
                    (
                        k.to_string(),
                        String::from_utf8_lossy(v.as_bytes()).into_owned(),
                    )
                })
                .collect();
            headers.sort();
            (status, headers, res.bytes().await.expect("body").to_vec())
        }
    }

    async fn serve(state: &AppState) -> (Client, tokio::task::JoinHandle<()>) {
        let trusted = ProxyTrust::from_config(false, Some("127.0.0.1")).expect("trust");
        let app = routes(state.clone(), &Roles::ALL, ClientIp(trusted)).with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let server = tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await;
        });
        let client = Client {
            addr,
            http: reqwest::Client::new(),
            n: std::cell::Cell::new(0),
        };
        (client, server)
    }

    type Route = (
        &'static str,
        &'static str,
        Option<&'static str>,
        &'static [(&'static str, &'static str)],
    );

    const SERVER_ROUTES: &[Route] = &[
        ("GET", "/servers/{s}", None, &[]),
        ("PATCH", "/servers/{s}", Some("{}"), &[]),
        ("DELETE", "/servers/{s}", None, &[]),
        ("GET", "/servers/{s}/members", None, &[]),
        ("GET", "/servers/{s}/members?q=a", None, &[]),
        ("GET", "/servers/{s}/interacted", None, &[]),
        ("POST", "/servers/{s}/leave", None, &[]),
        (
            "POST",
            "/servers/{s}/channels",
            Some(r#"{"name":"x"}"#),
            &[],
        ),
        (
            "POST",
            "/servers/{s}/kick",
            Some(r#"{"username":"alice"}"#),
            &[],
        ),
        ("GET", "/servers/{s}/bans", None, &[]),
        (
            "POST",
            "/servers/{s}/bans",
            Some(r#"{"username":"alice"}"#),
            &[],
        ),
        ("DELETE", "/servers/{s}/bans/alice", None, &[]),
        (
            "POST",
            "/servers/{s}/admins",
            Some(r#"{"username":"alice"}"#),
            &[],
        ),
        ("DELETE", "/servers/{s}/admins/alice", None, &[]),
        (
            "POST",
            "/servers/{s}/transfer_admin",
            Some(r#"{"username":"alice"}"#),
            &[],
        ),
        (
            "PATCH",
            "/servers/{s}/admins/alice/perms",
            Some(r#"{"perms":1}"#),
            &[],
        ),
        (
            "POST",
            "/servers/{s}/roles",
            Some(r##"{"name":"r","color":"#ffffff","perms":0}"##),
            &[],
        ),
        ("PATCH", "/servers/{s}/roles/1", Some("{}"), &[]),
        ("DELETE", "/servers/{s}/roles/1", None, &[]),
        (
            "POST",
            "/servers/{s}/roles/1/assign",
            Some(r#"{"username":"alice"}"#),
            &[],
        ),
        ("DELETE", "/servers/{s}/roles/1/assign/alice", None, &[]),
        ("POST", "/servers/{s}/join", None, &[]),
        ("POST", "/servers/{s}/join", Some("{}"), &[]),
        (
            "POST",
            "/servers/{s}/join",
            Some(r#"{"password":"wrong"}"#),
            &[],
        ),
        ("POST", "/servers/{s}/guest_access", Some("{}"), &[]),
        (
            "POST",
            "/servers/{s}/guest_access",
            Some(r#"{"password":"wrong"}"#),
            &[],
        ),
        ("GET", "/invites/{s}", None, &[]),
        (
            "GET",
            "/invites/{s}",
            None,
            &[("x-invite-password", "wrong")],
        ),
        ("GET", "/invites/{s}", None, &[("x-guest-grant", "bogus")]),
        ("GET", "/users/alice/profile?server={s}", None, &[]),
    ];

    const ID_ROUTES: &[(&str, &str, Option<&str>)] = &[
        ("PATCH", "/channels/{c}", Some("{}")),
        ("DELETE", "/channels/{c}", None),
        ("GET", "/channels/{c}/perms", None),
        (
            "PUT",
            "/channels/{c}/perms",
            Some(r#"{"subject":"u:bob","can_view":true,"can_send":true,"can_read_history":true}"#),
        ),
        ("DELETE", "/channels/{c}/perms/u:alice", None),
        ("GET", "/channels/{c}/messages", None),
        (
            "POST",
            "/channels/{c}/messages",
            Some(r#"{"content":"hi"}"#),
        ),
        ("POST", "/read", Some(r#"{"scope":"c{c}","last_read":1}"#)),
        ("DELETE", "/messages/{m}", None),
        ("DELETE", "/messages/{m}/media", None),
        ("DELETE", "/messages/{m}/embeds/0", None),
        ("GET", "/messages/{m}/thread", None),
        ("POST", "/messages/{m}/thread", Some(r#"{"content":"hi"}"#)),
    ];

    #[tokio::test]
    async fn protected_and_missing_targets_answer_identically() {
        let (state, path) = temp_state("access_uniform").await;
        let f = fixture(&state).await;
        let (client, server) = serve(&state).await;
        let viewers: [Option<&str>; 2] = [Some("bob"), None];
        for &(method, route, body, headers) in SERVER_ROUTES {
            for token in viewers {
                let mut replies = Vec::new();
                for name in ["vault", "ghost", "VAULT"] {
                    let path = route.replace("{s}", name);
                    replies.push(client.call(method, &path, token, body, headers).await);
                }
                assert_eq!(replies[0], replies[1], "{method} {route} as {token:?}");
                assert_eq!(replies[0], replies[2], "{method} {route} as {token:?}");
                assert!(replies[0].1.iter().any(|(k, _)| k == "content-type"));
                let (status, _, body) = &replies[0];
                let body = String::from_utf8_lossy(body);
                let want = match (route.starts_with("/users/"), token, body.as_ref()) {
                    (true, _, _) => *status == 200 && body.contains(r#""member":null"#),
                    (false, Some(_), r#"{"error":"Server not found or wrong password"}"#) => {
                        *status == 404
                    }
                    (false, _, r#"{"error":"Password required"}"#) => *status == 401,
                    (false, None, r#"{"error":"Unauthorized"}"#) => *status == 401,
                    (false, None, r#"{"error":"Server not found or wrong password"}"#) => {
                        *status == 404
                    }
                    (_, _, _) => false,
                };
                assert!(want, "{method} {route} as {token:?}: {status} {body}");
            }
        }
        let targets = [
            (f.vault_channel, f.vault_message),
            (999_999, 999_998),
            (f.hidden_channel, f.hidden_message),
        ];
        for &(method, route, body) in ID_ROUTES {
            for token in viewers {
                let mut replies = Vec::new();
                for (c, m) in targets {
                    let path = route
                        .replace("{c}", &c.to_string())
                        .replace("{m}", &m.to_string());
                    let body = body.map(|b| b.replace("{c}", &c.to_string()));
                    replies.push(
                        client
                            .call(method, &path, token, body.as_deref(), &[])
                            .await,
                    );
                }
                assert_eq!(replies[0], replies[1], "{method} {route} as {token:?}");
                assert_eq!(replies[0], replies[2], "{method} {route} as {token:?}");
                if token.is_some() {
                    assert_eq!(replies[0].0, 404, "{method} {route}");
                    assert_eq!(
                        replies[0].2, br#"{"error":"Not found"}"#,
                        "{method} {route}"
                    );
                }
            }
        }
        let media = [
            ("a".repeat(32), Some(f.vault_message)),
            ("b".repeat(32), Some(f.hidden_message)),
            ("c".repeat(32), None),
        ];
        for (id, message) in &media {
            sqlx::query("INSERT INTO media(id, filename, mime, size, data, uploader, uploaded_at) VALUES($1, 'a.txt', 'text/plain', 1, $2, 'alice', $3)")
                .bind(id)
                .bind(vec![1u8])
                .bind(now())
                .execute(&state.db)
                .await
                .expect("media");
            if let Some(m) = message {
                exec(&state.db, &format!("UPDATE messages SET media_id = '{id}', media_filename = 'a.txt' WHERE id = {m}")).await;
            }
        }
        for token in viewers {
            let unknown = client
                .call(
                    "GET",
                    &format!("/media/{}", "d".repeat(32)),
                    token,
                    None,
                    &[],
                )
                .await;
            assert_eq!(unknown.0, 404, "{token:?}");
            assert_eq!(unknown.2, br#"{"error":"Media not found"}"#);
            for (id, _) in &media {
                let reply = client
                    .call("GET", &format!("/media/{id}"), token, None, &[])
                    .await;
                assert_eq!(reply, unknown, "media {id} as {token:?}");
            }
        }
        let alice = client
            .call(
                "GET",
                &format!("/media/{}", "a".repeat(32)),
                Some("alice"),
                None,
                &[],
            )
            .await;
        assert_eq!(alice.0, 200);
        server.abort();
        done(state, path).await;
    }

    #[tokio::test]
    async fn the_password_step_is_driven_by_the_api() {
        let (state, path) = temp_state("access_password").await;
        fixture(&state).await;
        let (client, server) = serve(&state).await;
        let bob = Some("bob");
        let required = (401, br#"{"error":"Password required"}"#.to_vec());
        let denied = (
            404,
            br#"{"error":"Server not found or wrong password"}"#.to_vec(),
        );
        let short = |(status, _, body): Reply| (status, body);
        for name in ["vault", "ghost"] {
            let join = format!("/servers/{name}/join");
            assert_eq!(
                short(client.call("POST", &join, bob, None, &[]).await),
                required
            );
            let wrong = client
                .call("POST", &join, bob, Some(r#"{"password":"nope"}"#), &[])
                .await;
            assert_eq!(short(wrong), denied);
            let invite = format!("/invites/{name}");
            assert_eq!(
                short(client.call("GET", &invite, bob, None, &[]).await),
                required
            );
            let guest = format!("/servers/{name}/guest_access");
            assert_eq!(
                short(client.call("POST", &guest, None, Some("{}"), &[]).await),
                required
            );
        }
        let open = client
            .call(
                "POST",
                "/servers/rchat/join",
                bob,
                Some(r#"{"password":"ignored"}"#),
                &[],
            )
            .await;
        assert_eq!(open.0, 200);
        let public = client
            .call("POST", "/servers/rchat/guest_access", None, Some("{}"), &[])
            .await;
        assert_eq!(short(public), (200, br#"{"grant":null}"#.to_vec()));
        let card = client
            .call(
                "GET",
                "/invites/vault",
                bob,
                None,
                &[("x-invite-password", "pw")],
            )
            .await;
        assert_eq!(card.0, 200);
        let card: serde_json::Value = serde_json::from_slice(&card.2).expect("card");
        assert_eq!(card["status"], "joinable");
        assert_eq!(card["server"]["display_name"], "Vault");
        let grant = client
            .call(
                "POST",
                "/servers/vault/guest_access",
                None,
                Some(r#"{"password":"pw"}"#),
                &[],
            )
            .await;
        assert_eq!(grant.0, 200);
        let grant: serde_json::Value = serde_json::from_slice(&grant.2).expect("grant");
        let grant = grant["grant"].as_str().expect("grant").to_string();
        let viewed = client
            .call(
                "GET",
                "/servers/vault",
                None,
                None,
                &[("x-guest-grant", &grant)],
            )
            .await;
        assert_eq!(viewed.0, 200);
        let joined = client
            .call(
                "POST",
                "/servers/vault/join",
                bob,
                Some(r#"{"password":"pw"}"#),
                &[],
            )
            .await;
        assert_eq!(joined.0, 200);
        let again = client
            .call("POST", "/servers/vault/join", bob, None, &[])
            .await;
        assert_eq!(again.0, 200, "members join without the password");
        let viewed = client.call("GET", "/servers/vault", bob, None, &[]).await;
        assert_eq!(viewed.0, 200);
        server.abort();
        done(state, path).await;
    }

    #[tokio::test]
    async fn bans_show_only_after_access_is_proven() {
        let (state, path) = temp_state("access_bans").await;
        fixture(&state).await;
        let db = &state.db;
        exec(db, "INSERT INTO server_bans(server, username, banned_by, created_at) VALUES('vault', 'bob', 'alice', 0)").await;
        let bob = mem_user("bob", false);
        let code = |r: Result<ServerAccess, ApiError>| r.err().map(|ApiError(c, m)| (c, m));
        let none = resolve_server(db, "vault", Some(&bob), &Proof::none()).await;
        assert_eq!(
            code(none),
            Some((StatusCode::NOT_FOUND, DENIED.to_string()))
        );
        let asked = resolve_server(db, "vault", Some(&bob), &Proof::password(None)).await;
        assert_eq!(
            code(asked),
            Some((StatusCode::UNAUTHORIZED, PASSWORD_REQUIRED.to_string()))
        );
        let proven = resolve_server(db, "vault", Some(&bob), &Proof::password(Some("pw"))).await;
        assert_eq!(
            code(proven),
            Some((StatusCode::FORBIDDEN, BANNED.to_string()))
        );
        exec(
            db,
            "INSERT INTO interactions(server, username, last_at) VALUES('vault', 'bob', 1)",
        )
        .await;
        let history = resolve_server(db, "vault", Some(&bob), &Proof::none()).await;
        assert_eq!(
            code(history),
            Some((StatusCode::FORBIDDEN, BANNED.to_string()))
        );
        exec(db, "INSERT INTO server_bans(server, username, banned_by, created_at) VALUES('rchat', 'bob', 'alice', 0)").await;
        let public = resolve_server(db, "rchat", Some(&bob), &Proof::none()).await;
        assert_eq!(
            code(public),
            Some((StatusCode::FORBIDDEN, BANNED.to_string()))
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn passwords_are_hashed_for_missing_servers_too() {
        let (state, path) = temp_state("access_timing").await;
        fixture(&state).await;
        let db = &state.db;
        let bob = mem_user("bob", false);
        let before = verify_counts();
        let _ = resolve_server(db, "ghost", Some(&bob), &Proof::password(Some("x"))).await;
        assert_eq!(verify_counts(), (before.0, before.1 + 1));
        let _ = resolve_server(db, "vault", Some(&bob), &Proof::password(Some("x"))).await;
        assert_eq!(verify_counts(), (before.0 + 1, before.1 + 1));
        for name in ["ghost", "vault"] {
            let _ = resolve_server(db, name, Some(&bob), &Proof::password(None)).await;
            let _ = resolve_server(db, name, Some(&bob), &Proof::none()).await;
        }
        assert_eq!(verify_counts(), (before.0 + 1, before.1 + 1));
        let root = mem_user("root", true);
        let staff = resolve_server(db, "vault", Some(&root), &Proof::none()).await;
        assert_eq!(staff.map(|a| a.via()).ok(), Some(Via::Staff));
        let staff_join = resolve_server(db, "vault", Some(&root), &Proof::password(None)).await;
        assert!(matches!(
            staff_join,
            Err(ApiError(StatusCode::UNAUTHORIZED, _))
        ));
        done(state, path).await;
    }

    #[tokio::test]
    async fn banned_viewers_never_get_a_channel() {
        let (state, path) = temp_state("access_banned_handle").await;
        let fx = fixture(&state).await;
        let db = &state.db;
        let general = id_of(
            db,
            "SELECT id FROM channels WHERE server = 'rchat' AND name = 'general'",
        )
        .await;
        exec(db, "INSERT INTO server_bans(server, username, banned_by, created_at) VALUES('rchat', 'bob', 'alice', 0)").await;
        exec(db, "INSERT INTO server_bans(server, username, banned_by, created_at) VALUES('vault', 'bob', 'alice', 0)").await;
        let bob = mem_user("bob", false);
        let err = |e: ApiError| (e.0, e.1);
        let not_found = (StatusCode::NOT_FOUND, NOT_FOUND.to_string());
        for (name, proof) in [
            ("rchat", Proof::none()),
            ("vault", Proof::password(Some("pw"))),
        ] {
            let view = resolve_invite(db, name, Some(&bob), &proof).await;
            assert!(matches!(view, Ok(InviteView::Banned(ref lite)) if lite.name == name));
            let server = resolve_server(db, name, Some(&bob), &proof).await;
            assert_eq!(
                server.err().map(err),
                Some((StatusCode::FORBIDDEN, BANNED.to_string()))
            );
        }
        for cid in [general, fx.vault_channel] {
            let channel = resolve_channel(db, cid, Some(&bob), &Proof::none()).await;
            assert_eq!(channel.err().map(err), Some(not_found.clone()));
        }
        let message = resolve_message(db, fx.vault_message, Some(&bob), &Proof::none()).await;
        assert_eq!(message.err().map(err), Some(not_found));
        done(state, path).await;
    }

    #[tokio::test]
    async fn repeated_passwords_never_skip_the_verify() {
        let (state, path) = temp_state("access_verify_runs").await;
        fixture(&state).await;
        let db = &state.db;
        let bob = mem_user("bob", false);
        let attempt = |name: &'static str| {
            let bob = &bob;
            async move {
                let before = verify_runs();
                let res = resolve_server(db, name, Some(bob), &Proof::password(Some("p"))).await;
                let res = res.err().map(|ApiError(c, m)| (c, m));
                (res, verify_runs() - before)
            }
        };
        let first = attempt("ghost").await;
        let missing = attempt("ghost2").await;
        let protected = attempt("vault").await;
        let again = attempt("ghost").await;
        let vault_again = attempt("vault").await;
        let denied = Some((StatusCode::NOT_FOUND, DENIED.to_string()));
        for (res, runs) in [first, missing, protected, again, vault_again] {
            assert_eq!((res, runs), (denied.clone(), 1));
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn available_and_search_hide_protected_servers() {
        let (state, path) = temp_state("access_search").await;
        fixture(&state).await;
        let (client, server) = serve(&state).await;
        let bob = Some("bob");
        let available = |name: &'static str| {
            let client = &client;
            async move {
                let r = client
                    .call("GET", &format!("/servers/{name}/available"), bob, None, &[])
                    .await;
                (r.0, String::from_utf8(r.2).expect("utf8"))
            }
        };
        assert_eq!(
            available("ghost").await,
            (200, r#"{"available":true}"#.to_string())
        );
        assert_eq!(
            available("vault").await,
            (200, r#"{"available":false}"#.to_string())
        );
        assert_eq!(
            available("VAULT").await,
            (200, r#"{"available":false}"#.to_string())
        );
        assert_eq!(
            available("rchat").await,
            (200, r#"{"available":false}"#.to_string())
        );
        let long = format!("/servers/{}/available", "a".repeat(101));
        assert_eq!(client.call("GET", &long, bob, None, &[]).await.0, 400);
        let anon = client
            .call("GET", "/servers/ghost/available", None, None, &[])
            .await;
        assert_eq!(anon.0, 401);
        let gone = client
            .call("GET", "/servers/ghost/exists", bob, None, &[])
            .await;
        assert_ne!(gone.0, 200);
        let names = |r: Reply| -> Vec<String> {
            let v: serde_json::Value = serde_json::from_slice(&r.2).expect("json");
            v.as_array()
                .expect("list")
                .iter()
                .map(|m| m["name"].as_str().expect("name").to_string())
                .collect()
        };
        let search = "/server_search?q=vault";
        assert!(names(client.call("GET", search, bob, None, &[]).await).is_empty());
        assert!(names(client.call("GET", search, None, None, &[]).await).is_empty());
        assert!(names(client.call("GET", search, Some("root"), None, &[]).await).is_empty());
        assert_eq!(
            names(client.call("GET", search, Some("alice"), None, &[]).await),
            ["vault"]
        );
        assert_eq!(
            names(
                client
                    .call("GET", "/server_search?q=rchat", bob, None, &[])
                    .await
            ),
            ["rchat"]
        );
        server.abort();
        done(state, path).await;
    }
}
