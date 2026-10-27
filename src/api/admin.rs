use std::time::Duration;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::api::messages::{MsgScope, message_scope};
use crate::api::{
    ApiError, Authed, Paged, ProfanitySwitch, ServerSummaryLite, Settings, UserRef, decode_cursor,
    encode_cursor,
};
use crate::db::{AvatarKind, Db, User, now, purge_messages, user_row};
use crate::state::AppState;
use crate::ws::WsEvent;

#[derive(Serialize)]
pub struct Overview {
    pub server_count: i64,
    pub user_count: i64,
}

#[derive(Deserialize)]
pub struct AdminQuery {
    offset: Option<i64>,
    limit: Option<i64>,
    q: Option<String>,
    cursor: Option<String>,
}

struct AdminPage {
    offset: i64,
    limit: i64,
    q: String,
    after: Option<String>,
}

impl AdminQuery {
    fn page(&self) -> Result<AdminPage, ApiError> {
        let AdminQuery {
            offset,
            limit,
            q,
            cursor,
        } = self;
        let after = match cursor.as_deref().filter(|c| !c.trim().is_empty()) {
            Some(raw) => Some(decode_cursor(raw, 1)?.remove(0)),
            None => None,
        };
        Ok(AdminPage {
            offset: offset.unwrap_or(0).clamp(0, crate::api::OFFSET_MAX),
            limit: limit.unwrap_or(50).clamp(1, 50),
            q: q.as_deref().unwrap_or("").trim().to_lowercase(),
            after,
        })
    }
}

async fn name_page(
    db: &crate::db::Db,
    sql: &str,
    first: &str,
    page: &AdminPage,
) -> Result<(Vec<sqlx::any::AnyRow>, Option<String>), ApiError> {
    let AdminPage {
        offset,
        limit,
        q: _,
        after,
    } = page;
    let mut rows = match after {
        Some(after) => {
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "{sql} AND {first} > $2 ORDER BY {first} LIMIT $3"
            )))
            .bind(first_bind(page))
            .bind(after)
            .bind(limit + 1)
            .fetch_all(db)
            .await?
        }
        None => {
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "{sql} ORDER BY {first} LIMIT $2 OFFSET $3"
            )))
            .bind(first_bind(page))
            .bind(limit + 1)
            .bind(offset)
            .fetch_all(db)
            .await?
        }
    };
    let more = rows.len() as i64 > *limit;
    rows.truncate(*limit as usize);
    let next = match (more, rows.last()) {
        (true, Some(r)) => Some(encode_cursor(&[&r.try_get::<String, _>(0)?])),
        _ => None,
    };
    Ok((rows, next))
}

fn first_bind(page: &AdminPage) -> String {
    like_pattern(&page.q, is_fuzzy(&page.q))
}

pub fn fuzzy_match(q: &str, name: &str) -> bool {
    let (q, name) = (q.to_lowercase(), name.to_lowercase());
    let mut rest = name.as_str();
    name.contains(&q)
        || q.chars().all(|c| match rest.find(c) {
            Some(i) => {
                rest = &rest[i + c.len_utf8()..];
                true
            }
            None => false,
        })
}

pub(crate) fn is_fuzzy(q: &str) -> bool {
    !q.is_empty() && q.chars().count() <= 8
}

pub(crate) fn like_pattern(q: &str, fuzzy: bool) -> String {
    let mut p = String::from("%");
    for c in q.chars() {
        if matches!(c, '%' | '_' | '\\') {
            p.push('\\');
        }
        p.push(c);
        if fuzzy {
            p.push('%');
        }
    }
    if !fuzzy {
        p.push('%');
    }
    p
}

#[derive(Deserialize)]
pub struct BanReq {
    username: String,
}

#[derive(Serialize)]
pub struct OkResp {
    pub ok: bool,
}

#[derive(Clone, Copy, Deserialize, Default)]
pub struct ProfanityTargetsPatch {
    messages: Option<bool>,
    links: Option<bool>,
    usernames: Option<bool>,
    server_names: Option<bool>,
    channel_names: Option<bool>,
    role_names: Option<bool>,
    file_names: Option<bool>,
    bios: Option<bool>,
}

impl ProfanityTargetsPatch {
    fn get(&self, switch: ProfanitySwitch) -> Option<bool> {
        let ProfanityTargetsPatch {
            messages,
            links,
            usernames,
            server_names,
            channel_names,
            role_names,
            file_names,
            bios,
        } = *self;
        match switch {
            ProfanitySwitch::Messages => messages,
            ProfanitySwitch::Links => links,
            ProfanitySwitch::Usernames => usernames,
            ProfanitySwitch::ServerNames => server_names,
            ProfanitySwitch::ChannelNames => channel_names,
            ProfanitySwitch::RoleNames => role_names,
            ProfanitySwitch::FileNames => file_names,
            ProfanitySwitch::Bios => bios,
        }
    }
}

#[derive(Deserialize)]
pub struct SettingsPatch {
    profanity_filter: Option<bool>,
    #[serde(default)]
    profanity_targets: ProfanityTargetsPatch,
    asset_previews: Option<bool>,
    asset_uploads: Option<bool>,
    guests_enabled: Option<bool>,
}

fn require_site_admin(user: &User) -> Result<(), ApiError> {
    match user.is_site_admin {
        true => Ok(()),
        false => Err(ApiError(StatusCode::NOT_FOUND, "Not found".to_string())),
    }
}

/// Get the instance settings
///
/// The instance-wide feature switches clients need to adapt their UI: profanity filter and
/// its targets, link previews, uploads and guest access. No authentication. Values may lag
/// a change by up to 5 seconds per server process; live changes also arrive as the
/// `settings_changed` WebSocket event. General rate-limit bucket.
#[utoipa::path(get, path = "/api/settings", tag = "Instance", responses((status = 200, description = "Site-wide feature toggles: profanity filter (master switch `profanity_filter` plus per-target `profanity_targets`), link previews, uploads, and guest access", body = Settings), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(()))]
pub(crate) async fn get_settings(State(state): State<AppState>) -> Json<Settings> {
    Json(Settings::cached(&state.db).await)
}

pub(crate) async fn patch_settings(
    State(state): State<AppState>,
    Authed(user): Authed,
    Json(req): Json<SettingsPatch>,
) -> Result<Json<Settings>, ApiError> {
    require_site_admin(&user)?;
    let SettingsPatch {
        profanity_filter,
        profanity_targets,
        asset_previews,
        asset_uploads,
        guests_enabled,
    } = req;
    let pairs = [
        ("profanity_filter", profanity_filter),
        ("asset_previews", asset_previews),
        ("asset_uploads", asset_uploads),
        ("guests_enabled", guests_enabled),
    ]
    .into_iter()
    .chain(
        ProfanitySwitch::ALL
            .into_iter()
            .map(|t| (t.key(), profanity_targets.get(t))),
    );
    for (key, value) in pairs {
        if let Some(on) = value {
            sqlx::query(
                "INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            )
            .bind(key)
            .bind(match on {
                true => "1",
                false => "0",
            })
            .execute(&state.db)
            .await?;
        }
    }
    let settings = Settings::load(&state.db).await;
    state.hub.broadcast(WsEvent::SettingsChanged { settings });
    Ok(Json(settings))
}

pub(crate) async fn overview(
    State(state): State<AppState>,
    Authed(user): Authed,
) -> Result<Json<Overview>, ApiError> {
    require_site_admin(&user)?;
    let server_count: i64 =
        sqlx::query("SELECT COUNT(*) FROM servers WHERE COALESCE(password_hash, '') <> '!purging'")
            .fetch_one(&state.db)
            .await?
            .try_get(0)?;
    let user_count: i64 =
        sqlx::query("SELECT COUNT(*) FROM users WHERE password_hash <> '!purging'")
            .fetch_one(&state.db)
            .await?
            .try_get(0)?;
    Ok(Json(Overview {
        server_count,
        user_count,
    }))
}

pub(crate) async fn list_users(
    State(state): State<AppState>,
    Authed(user): Authed,
    Query(query): Query<AdminQuery>,
) -> Result<Paged<UserRef>, ApiError> {
    require_site_admin(&user)?;
    let page = query.page()?;
    let q = page.q.clone();
    let fuzzy = is_fuzzy(&q);
    let (rows, next) = name_page(
        &state.read(),
        "SELECT username, display_name, avatar_kind, avatar_color FROM users WHERE (lower(username) LIKE $1 ESCAPE '\\' OR lower(display_name) LIKE $1 ESCAPE '\\') AND password_hash <> '!purging'",
        "username",
        &page,
    )
    .await?;
    let mut users = Vec::with_capacity(rows.len());
    for r in &rows {
        let username: String = r.try_get(0)?;
        let display_name: String = r.try_get(1)?;
        if fuzzy && !(fuzzy_match(&q, &username) || fuzzy_match(&q, &display_name)) {
            continue;
        }
        users.push(UserRef {
            username,
            display_name,
            avatar_kind: AvatarKind::parse(&r.try_get::<String, _>(2)?)?,
            avatar_color: r.try_get(3)?,
        });
    }
    Ok(Paged(users, next))
}

pub(crate) async fn list_servers(
    State(state): State<AppState>,
    Authed(user): Authed,
    Query(query): Query<AdminQuery>,
) -> Result<Paged<ServerSummaryLite>, ApiError> {
    require_site_admin(&user)?;
    let page = query.page()?;
    let q = page.q.clone();
    let fuzzy = is_fuzzy(&q);
    let (rows, next) = name_page(
        &state.read(),
        "SELECT name, display_name, creator, password_hash, banner_color, name_color FROM servers WHERE (lower(name) LIKE $1 ESCAPE '\\' OR lower(display_name) LIKE $1 ESCAPE '\\') AND COALESCE(password_hash, '') <> '!purging'",
        "name",
        &page,
    )
    .await?;
    let mut servers = Vec::with_capacity(rows.len());
    for r in &rows {
        let name: String = r.try_get(0)?;
        let display_name: String = r.try_get(1)?;
        if fuzzy && !(fuzzy_match(&q, &name) || fuzzy_match(&q, &display_name)) {
            continue;
        }
        servers.push(ServerSummaryLite {
            name,
            display_name,
            creator: r.try_get(2)?,
            has_password: r.try_get::<Option<String>, _>(3)?.is_some(),
            banner_color: r.try_get(4)?,
            name_color: r.try_get(5)?,
        });
    }
    Ok(Paged(servers, next))
}

pub(crate) async fn delete_server(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
) -> Result<Json<OkResp>, ApiError> {
    require_site_admin(&user)?;
    let name = name.to_lowercase();
    if name == "rchat" {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "The rchat server cannot be deleted".to_string(),
        ));
    }
    match remove_server(&state, &name).await? {
        true => Ok(Json(OkResp { ok: true })),
        false => Err(ApiError(
            StatusCode::NOT_FOUND,
            "Server not found".to_string(),
        )),
    }
}

pub(crate) const PURGING_HASH: &str = crate::db::PURGING_HASH;

pub(crate) const PURGE_LEASE: i64 = 300;
pub const PURGE_SWEEP_SECS: u64 = 120;
const LEASE_RENEW: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PurgeKind {
    Server,
    User,
    Ban,
}

impl PurgeKind {
    fn tag(self) -> &'static str {
        match self {
            PurgeKind::Server => "server",
            PurgeKind::User => "user",
            PurgeKind::Ban => "ban",
        }
    }

    fn tags(self) -> [&'static str; 2] {
        match self {
            PurgeKind::Server => [PurgeKind::Server.tag(), PurgeKind::Server.tag()],
            PurgeKind::User | PurgeKind::Ban => [PurgeKind::User.tag(), PurgeKind::Ban.tag()],
        }
    }

    fn parse(tag: &str) -> Option<PurgeKind> {
        match tag {
            "server" => Some(PurgeKind::Server),
            "user" => Some(PurgeKind::User),
            "ban" => Some(PurgeKind::Ban),
            _ => None,
        }
    }
}

async fn note_purge(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    kind: PurgeKind,
    key: &str,
    claimed_at: i64,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO pending_purges(kind, key, created_at, claimed_at) VALUES($1, $2, $3, $4) ON CONFLICT(kind, key) DO NOTHING",
    )
    .bind(kind.tag())
    .bind(key)
    .bind(now())
    .bind(claimed_at)
    .execute(&mut **tx)
    .await
    .map(|_| ())
}

pub(crate) async fn remove_server(state: &AppState, name: &str) -> Result<bool, ApiError> {
    let mut tx = state.db.begin().await?;
    let hidden = sqlx::query("UPDATE servers SET password_hash = $1 WHERE name = $2 AND COALESCE(password_hash, '') <> $1")
        .bind(PURGING_HASH)
        .bind(name)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if hidden == 0 {
        return Ok(false);
    }
    for table in [
        "guest_grants",
        "user_roles",
        "members",
        "server_bans",
        "interactions",
    ] {
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "DELETE FROM {table} WHERE server = $1"
        )))
        .bind(name)
        .execute(&mut *tx)
        .await?;
    }
    note_purge(&mut tx, PurgeKind::Server, name, now()).await?;
    tx.commit().await?;
    state.hub.broadcast(WsEvent::ServerDeleted {
        name: name.to_string(),
    });
    spawn_purge(state, PurgeKind::Server, name);
    Ok(true)
}

async fn hide_user_rows(
    state: &AppState,
    key: &str,
    kind: PurgeKind,
) -> Result<Option<Vec<String>>, ApiError> {
    let mut tx = state.db.begin().await?;
    let hidden = sqlx::query(
        "UPDATE users SET password_hash = $1 WHERE username = $2 AND password_hash <> $1",
    )
    .bind(PURGING_HASH)
    .bind(key)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if hidden == 0 {
        let pending = user_row(&mut *tx, key)
            .await?
            .is_some_and(|u| u.password_hash == PURGING_HASH);
        if !pending {
            return Err(ApiError(
                StatusCode::NOT_FOUND,
                "User not found".to_string(),
            ));
        }
        if kind == PurgeKind::Ban {
            ban_name(&mut tx, key).await?;
            sqlx::query("UPDATE pending_purges SET kind = $1 WHERE kind = $2 AND key = $3")
                .bind(PurgeKind::Ban.tag())
                .bind(PurgeKind::User.tag())
                .bind(key)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        return Ok(None);
    }
    let servers = member_servers(&mut tx, key).await?;
    for sql in [
        "DELETE FROM tokens WHERE username = $1",
        "DELETE FROM members WHERE username = $1",
        "DELETE FROM user_roles WHERE username = $1",
        "DELETE FROM interactions WHERE username = $1",
        "DELETE FROM server_bans WHERE username = $1",
    ] {
        sqlx::query(sql).bind(key).execute(&mut *tx).await?;
    }
    sqlx::query("DELETE FROM channel_perms WHERE subject = $1")
        .bind(format!("u:{key}"))
        .execute(&mut *tx)
        .await?;
    if kind == PurgeKind::Ban {
        ban_name(&mut tx, key).await?;
    }
    note_purge(&mut tx, kind, key, now()).await?;
    tx.commit().await?;
    Ok(Some(servers))
}

async fn ban_name(tx: &mut sqlx::Transaction<'_, sqlx::Any>, key: &str) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO banned_usernames(username) VALUES($1) ON CONFLICT(username) DO NOTHING",
    )
    .bind(key)
    .execute(&mut **tx)
    .await
    .map(|_| ())
}

async fn hide_user(state: &AppState, key: &str, kind: PurgeKind) -> Result<(), ApiError> {
    let Some(servers) = hide_user_rows(state, key, kind).await? else {
        return Ok(());
    };
    state.hub.broadcast(WsEvent::TokensRevoked {
        username: key.to_string(),
    });
    remove_user_events(state, key.to_string(), servers);
    spawn_purge(state, kind, key);
    Ok(())
}

fn spawn_purge(state: &AppState, kind: PurgeKind, key: &str) {
    let (state, key) = (state.clone(), key.to_string());
    tokio::spawn(async move {
        if let Err(e) = finish_purge(&state, kind, &key).await {
            tracing::warn!(
                "purge of {} {key} paused, the sweeper resumes it: {e}",
                kind.tag()
            );
        }
    });
}

struct Lease {
    renew: Option<tokio::task::JoinHandle<()>>,
    job: (Db, PurgeKind, String),
}

impl Lease {
    fn start(db: &Db, kind: PurgeKind, key: &str, every: Duration) -> Lease {
        let job = (db.clone(), kind, key.to_string());
        let (db, key) = (db.clone(), key.to_string());
        let renew = tokio::spawn(async move {
            let mut ticks = tokio::time::interval(every);
            ticks.tick().await;
            loop {
                ticks.tick().await;
                if let Err(e) = stamp_purge(&db, kind, &key, now()).await {
                    tracing::warn!("renewing the {} {key} purge lease failed: {e}", kind.tag());
                }
            }
        });
        Lease {
            renew: Some(renew),
            job,
        }
    }

    async fn end(mut self, finished: bool) {
        let Some(renew) = self.renew.take() else {
            return;
        };
        renew.abort();
        let _ = renew.await;
        if !finished {
            let (db, kind, key) = &self.job;
            release_purge(db, *kind, key).await;
        }
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        let Some(renew) = self.renew.take() else {
            return;
        };
        renew.abort();
        let (db, kind, key) = self.job.clone();
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            rt.spawn(async move {
                let _ = renew.await;
                release_purge(&db, kind, &key).await;
            });
        }
    }
}

pub(crate) async fn finish_purge(state: &AppState, kind: PurgeKind, key: &str) -> sqlx::Result<()> {
    let lease = Lease::start(&state.db, kind, key, LEASE_RENEW);
    let out = run_purge(state, kind, key).await;
    lease.end(out.is_ok()).await;
    out
}

async fn run_purge(state: &AppState, kind: PurgeKind, key: &str) -> sqlx::Result<()> {
    match kind {
        PurgeKind::Server => {
            purge_messages(
                &state.db,
                "channel_id IN (SELECT id FROM channels WHERE server = $1)",
                key,
            )
            .await?;
            let mut tx = state.db.begin().await?;
            sqlx::query("DELETE FROM servers WHERE name = $1 AND password_hash = $2")
                .bind(key)
                .bind(PURGING_HASH)
                .execute(&mut *tx)
                .await?;
            clear_purge(&mut tx, kind, key).await?;
            tx.commit().await
        }
        PurgeKind::User | PurgeKind::Ban => {
            purge_messages(&state.db, "author = $1", key).await?;
            purge_messages(
                &state.db,
                "dm_id IN (SELECT id FROM dms WHERE user_a = $1 UNION ALL SELECT id FROM dms WHERE user_b = $1)",
                key,
            )
            .await?;
            let mut tx = state.db.begin().await?;
            sqlx::query("UPDATE users SET password_hash = password_hash WHERE username = $1")
                .bind(key)
                .execute(&mut *tx)
                .await?;
            let purging = user_row(&mut *tx, key)
                .await?
                .is_none_or(|u| u.password_hash == PURGING_HASH);
            if purging {
                drop_user_rows(&mut tx, key).await?;
            }
            clear_purge(&mut tx, kind, key).await?;
            tx.commit().await
        }
    }
}

async fn clear_purge(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    kind: PurgeKind,
    key: &str,
) -> sqlx::Result<()> {
    let kinds = kind.tags();
    sqlx::query("DELETE FROM pending_purges WHERE kind IN ($1, $2) AND key = $3")
        .bind(kinds[0])
        .bind(kinds[1])
        .bind(key)
        .execute(&mut **tx)
        .await
        .map(|_| ())
}

async fn claim_purge(state: &AppState, kind: PurgeKind, key: &str, t: i64) -> sqlx::Result<bool> {
    Ok(sqlx::query(
        "UPDATE pending_purges SET claimed_at = $1 WHERE kind = $2 AND key = $3 AND claimed_at < $4",
    )
    .bind(t)
    .bind(kind.tag())
    .bind(key)
    .bind(t - PURGE_LEASE)
    .execute(&state.db)
    .await?
    .rows_affected()
        == 1)
}

async fn stamp_purge(db: &Db, kind: PurgeKind, key: &str, at: i64) -> sqlx::Result<u64> {
    let [a, b] = kind.tags();
    Ok(
        sqlx::query(
            "UPDATE pending_purges SET claimed_at = $1 WHERE kind IN ($2, $3) AND key = $4",
        )
        .bind(at)
        .bind(a)
        .bind(b)
        .bind(key)
        .execute(db)
        .await?
        .rows_affected(),
    )
}

async fn release_purge(db: &Db, kind: PurgeKind, key: &str) {
    let released = stamp_purge(db, kind, key, 0).await;
    if let Err(e) = released {
        tracing::warn!("releasing the {} {key} purge failed: {e}", kind.tag());
    }
}

pub async fn resume_purges(state: &AppState) -> sqlx::Result<u64> {
    let t = now();
    let rows = sqlx::query(
        "SELECT kind, key FROM pending_purges WHERE claimed_at < $1 ORDER BY created_at LIMIT 100",
    )
    .bind(t - PURGE_LEASE)
    .fetch_all(&state.db)
    .await?;
    let mut done = 0;
    for r in &rows {
        let (tag, key): (String, String) = (r.try_get(0)?, r.try_get(1)?);
        let Some(kind) = PurgeKind::parse(&tag) else {
            continue;
        };
        match claim_purge(state, kind, &key, now()).await {
            Ok(true) => {}
            Ok(false) => continue,
            Err(e) => {
                tracing::warn!("claiming the {tag} {key} purge failed: {e}");
                continue;
            }
        }
        match finish_purge(state, kind, &key).await {
            Ok(()) => done += 1,
            Err(e) => {
                tracing::warn!("purge of {tag} {key} failed, retrying on the next sweep: {e}");
            }
        }
    }
    Ok(done)
}

async fn drop_user_rows(tx: &mut sqlx::Transaction<'_, sqlx::Any>, key: &str) -> sqlx::Result<()> {
    for sql in [
        "DELETE FROM messages WHERE author = $1",
        "DELETE FROM dms WHERE user_a = $1",
        "DELETE FROM dms WHERE user_b = $1",
        "DELETE FROM members WHERE username = $1",
        "DELETE FROM user_roles WHERE username = $1",
        "DELETE FROM interactions WHERE username = $1",
        "DELETE FROM server_bans WHERE username = $1",
        "DELETE FROM tokens WHERE username = $1",
        "DELETE FROM users WHERE username = $1",
    ] {
        sqlx::query(sql).bind(key).execute(&mut **tx).await?;
    }
    sqlx::query("DELETE FROM channel_perms WHERE subject = $1")
        .bind(format!("u:{key}"))
        .execute(&mut **tx)
        .await?;
    Ok(())
}

pub(crate) async fn ban_user(
    State(state): State<AppState>,
    Authed(user): Authed,
    Json(req): Json<BanReq>,
) -> Result<Json<OkResp>, ApiError> {
    require_site_admin(&user)?;
    let BanReq { username } = req;
    let key = username.to_lowercase();
    if key == user.username {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Cannot ban yourself".to_string(),
        ));
    }
    hide_user(&state, &key, PurgeKind::Ban).await?;
    Ok(Json(OkResp { ok: true }))
}

async fn member_servers(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    username: &str,
) -> sqlx::Result<Vec<String>> {
    let rows = sqlx::query("SELECT server FROM members WHERE username = $1")
        .bind(username)
        .fetch_all(&mut **tx)
        .await?;
    let mut servers = Vec::with_capacity(rows.len());
    for r in &rows {
        servers.push(r.try_get(0)?);
    }
    Ok(servers)
}

fn remove_user_events(state: &AppState, username: String, servers: Vec<String>) {
    state.hub.broadcast(WsEvent::Banned {
        username: username.clone(),
    });
    for server in servers {
        state.hub.broadcast(WsEvent::MemberLeft {
            server,
            username: username.clone(),
        });
    }
}

pub(crate) async fn delete_user(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(username): Path<String>,
) -> Result<Json<OkResp>, ApiError> {
    require_site_admin(&user)?;
    let key = username.to_lowercase();
    if key == user.username {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Cannot delete yourself".to_string(),
        ));
    }
    hide_user(&state, &key, PurgeKind::User).await?;
    Ok(Json(OkResp { ok: true }))
}

pub(crate) async fn user_servers(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(username): Path<String>,
    Query(query): Query<AdminQuery>,
) -> Result<Paged<ServerSummaryLite>, ApiError> {
    require_site_admin(&user)?;
    let page = query.page()?;
    let rows = sqlx::query(
        "SELECT name, display_name, creator, password_hash, banner_color, name_color FROM servers WHERE creator = $1 AND name > $2 AND COALESCE(password_hash, '') <> '!purging' ORDER BY name LIMIT $3 OFFSET $4",
    )
    .bind(username.to_lowercase())
    .bind(page.after.clone().unwrap_or_default())
    .bind(page.limit + 1)
    .bind(match page.after {
        Some(_) => 0,
        None => page.offset,
    })
    .fetch_all(&state.read())
    .await?;
    let more = rows.len() as i64 > page.limit;
    let mut servers = Vec::with_capacity(rows.len());
    for r in &rows {
        servers.push(ServerSummaryLite {
            name: r.try_get(0)?,
            display_name: r.try_get(1)?,
            creator: r.try_get(2)?,
            has_password: r.try_get::<Option<String>, _>(3)?.is_some(),
            banner_color: r.try_get(4)?,
            name_color: r.try_get(5)?,
        });
    }
    servers.truncate(page.limit as usize);
    let next = match (more, servers.last()) {
        (true, Some(s)) => Some(encode_cursor(&[&s.name])),
        _ => None,
    };
    Ok(Paged(servers, next))
}

pub(crate) async fn delete_message(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(id): Path<i64>,
) -> Result<Json<OkResp>, ApiError> {
    require_site_admin(&user)?;
    let scope = message_scope(&state.db, id).await?;
    sqlx::query("DELETE FROM messages WHERE id = $1")
        .bind(id)
        .execute(&state.db)
        .await?;
    let MsgScope {
        channel_id,
        dm_id,
        thread_root_id,
        author: _,
        media_id: _,
        media_filename: _,
        media_kind: _,
        server,
        dm_users,
    } = scope;
    state.hub.broadcast(WsEvent::MessageDeleted {
        server,
        channel_id,
        dm_id,
        dm_users,
        id,
        thread_root_id,
    });
    Ok(Json(OkResp { ok: true }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::auth::{AuthResp, RegisterReq, register};
    use crate::api::test_util::{done, temp_state};
    use crate::db::{Db, get_user, now};
    use serde_json::json;

    async fn reg(state: &AppState, name: &str) -> Result<Json<AuthResp>, ApiError> {
        let req: RegisterReq = serde_json::from_value(json!({
            "username": name,
            "password": "a",
            "avatar_kind": "identicon"
        }))
        .expect("register req");
        register(State(state.clone()), Json(req)).await
    }

    async fn settle(db: &Db) {
        for _ in 0..200 {
            if count(db, "SELECT COUNT(*) FROM pending_purges").await == 0 {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        panic!("purge did not finish");
    }

    fn drained(rx: &mut tokio::sync::broadcast::Receiver<WsEvent>) -> Vec<WsEvent> {
        std::iter::from_fn(|| rx.try_recv().ok()).collect()
    }

    async fn count(db: &Db, sql: &str) -> i64 {
        sqlx::query(sqlx::AssertSqlSafe(sql))
            .fetch_one(db)
            .await
            .expect("count query")
            .try_get(0)
            .expect("count value")
    }

    #[tokio::test]
    async fn ban_cascade() {
        let (state, path) = temp_state("ban").await;
        let _ = reg(&state, "alice").await.expect("register alice");
        let _ = reg(&state, "bob").await.expect("register bob");
        let db = &state.db;
        sqlx::query(
            "INSERT INTO servers(name, display_name, creator, created_at) VALUES('bobs', 'Bobs', 'bob', $1)",
        )
        .bind(now())
        .execute(db)
        .await
        .expect("insert server");
        sqlx::query("INSERT INTO members(server, username, joined_at) VALUES('bobs', 'bob', 1)")
            .execute(db)
            .await
            .expect("bob joins bobs");
        let cid: i64 = sqlx::query("SELECT id FROM channels WHERE server = 'rchat'")
            .fetch_one(db)
            .await
            .expect("general channel")
            .try_get(0)
            .expect("channel id");
        sqlx::query("INSERT INTO messages(channel_id, author, content, created_at) VALUES($1, 'bob', 'hi', $2)")
            .bind(cid)
            .bind(now())
            .execute(db)
            .await
            .expect("bob message");
        let dm: i64 =
            sqlx::query("INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id")
                .fetch_one(db)
                .await
                .expect("open dm")
                .try_get(0)
                .expect("dm id");
        sqlx::query("INSERT INTO messages(dm_id, author, content, created_at) VALUES($1, 'alice', 'yo', $2)")
            .bind(dm)
            .bind(now())
            .execute(db)
            .await
            .expect("dm message");
        let alice = get_user(db, "alice")
            .await
            .expect("query alice")
            .expect("alice");
        let mut rx = state.hub.subscribe();
        let _ = ban_user(
            State(state.clone()),
            Authed(alice),
            Json(BanReq {
                username: "Bob".to_string(),
            }),
        )
        .await
        .expect("ban");
        let events = drained(&mut rx);
        assert!(matches!(&events[0], WsEvent::TokensRevoked { username } if username == "bob"));
        assert!(matches!(&events[1], WsEvent::Banned { username } if username == "bob"));
        let mut left: Vec<String> = events[2..]
            .iter()
            .filter_map(|ev| match ev {
                WsEvent::MemberLeft { server, username } if username == "bob" => {
                    Some(server.clone())
                }
                _ => None,
            })
            .collect();
        left.sort();
        assert_eq!(left, ["bobs", "rchat"]);
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM tokens WHERE username = 'bob'").await,
            0
        );
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM members WHERE username = 'bob'").await,
            0
        );
        settle(db).await;
        assert!(
            drained(&mut rx)
                .iter()
                .all(|ev| !matches!(ev, WsEvent::Banned { .. } | WsEvent::MemberLeft { .. }))
        );
        assert_eq!(count(db, "SELECT COUNT(*) FROM pending_purges").await, 0);
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM users WHERE username = 'bob'").await,
            0
        );
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM tokens WHERE username = 'bob'").await,
            0
        );
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM members WHERE username = 'bob'").await,
            0
        );
        assert_eq!(
            count(
                db,
                "SELECT COUNT(*) FROM dms WHERE user_a = 'bob' OR user_b = 'bob'"
            )
            .await,
            0
        );
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM messages WHERE author = 'bob'").await,
            0
        );
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM messages WHERE dm_id IS NOT NULL").await,
            0
        );
        assert_eq!(
            count(
                db,
                "SELECT COUNT(*) FROM banned_usernames WHERE username = 'bob'"
            )
            .await,
            1
        );
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM servers WHERE name = 'bobs'").await,
            1
        );
        let again = reg(&state, "bob").await;
        match again {
            Err(ApiError(StatusCode::BAD_REQUEST, msg)) => assert_eq!(msg, "Username is banned"),
            _ => panic!("expected banned re-register rejection"),
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn server_deletion_hides_first_and_finishes_after_interruption() {
        let (state, path) = temp_state("delete_server").await;
        let _ = reg(&state, "alice").await.expect("register alice");
        let db = &state.db;
        let mut rx = state.hub.subscribe();
        sqlx::query(
            "INSERT INTO servers(name, display_name, creator, created_at) VALUES('club', 'Club', 'alice', 1)",
        )
        .execute(db)
        .await
        .expect("server");
        sqlx::query("INSERT INTO members(server, username, joined_at) VALUES('club', 'alice', 1)")
            .execute(db)
            .await
            .expect("member");
        let cid: i64 = sqlx::query(
            "INSERT INTO channels(server, name, created_at) VALUES('club', 'general', 1) RETURNING id",
        )
        .fetch_one(db)
        .await
        .expect("channel")
        .try_get(0)
        .expect("channel id");
        sqlx::query("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 600) INSERT INTO messages(channel_id, author, content, created_at) SELECT $1, 'alice', 'x', i FROM n")
            .bind(cid)
            .execute(db)
            .await
            .expect("messages");
        let mut tx = db.begin().await.expect("tx");
        sqlx::query("UPDATE servers SET password_hash = $1 WHERE name = 'club'")
            .bind(PURGING_HASH)
            .execute(&mut *tx)
            .await
            .expect("hide");
        sqlx::query("DELETE FROM members WHERE server = 'club'")
            .execute(&mut *tx)
            .await
            .expect("members");
        note_purge(&mut tx, PurgeKind::Server, "club", 0)
            .await
            .expect("note");
        tx.commit().await.expect("commit");
        assert!(
            crate::api::servers::server_lite(db, "club")
                .await
                .expect("lite")
                .is_none()
        );
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE server = 'club')").await,
            600
        );
        assert_eq!(resume_purges(&state).await.expect("resume"), 1);
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM servers WHERE name = 'club'").await,
            0
        );
        assert_eq!(count(db, "SELECT COUNT(*) FROM pending_purges").await, 0);
        assert_eq!(resume_purges(&state).await.expect("idle"), 0);

        sqlx::query(
            "INSERT INTO servers(name, display_name, creator, created_at) VALUES('club2', 'Club2', 'alice', 1)",
        )
        .execute(db)
        .await
        .expect("server2");
        while rx.try_recv().is_ok() {}
        assert!(remove_server(&state, "club2").await.expect("remove"));
        assert!(matches!(
            rx.try_recv(),
            Ok(WsEvent::ServerDeleted { name }) if name == "club2"
        ));
        assert!(
            crate::api::servers::server_lite(db, "club2")
                .await
                .expect("lite")
                .is_none()
        );
        assert!(!remove_server(&state, "club2").await.expect("gone"));
        assert!(!remove_server(&state, "nope").await.expect("missing"));
        assert!(rx.try_recv().is_err());
        settle(db).await;
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM servers WHERE name = 'club2'").await,
            0
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_purging_user_is_hidden_everywhere() {
        use crate::api::MaybeAuthed;
        use crate::api::auth::{LoginReq, login};
        use crate::api::dms::{dm_page, dms_by_ids, open_dm};
        use crate::api::messages::{recent_channel_messages, search, unreads};
        use crate::api::users::profile;
        use axum::extract::RawQuery;
        use axum::http::HeaderMap;

        let (state, path) = temp_state("purging_hidden").await;
        let _ = reg(&state, "alice").await.expect("register alice");
        let bob_token = reg(&state, "bob").await.expect("register bob").0.token;
        let _ = reg(&state, "carol").await.expect("register carol");
        let db = &state.db;
        let cid: i64 = sqlx::query("SELECT id FROM channels WHERE server = 'rchat'")
            .fetch_one(db)
            .await
            .expect("general")
            .try_get(0)
            .expect("channel id");
        let mut posted = Vec::new();
        for author in ["alice", "bob"] {
            let id: i64 = sqlx::query("INSERT INTO messages(channel_id, author, content, created_at) VALUES($1, $2, 'needle', $3) RETURNING id")
                .bind(cid)
                .bind(author)
                .bind(now())
                .fetch_one(db)
                .await
                .expect("message")
                .try_get(0)
                .expect("id");
            posted.push(id);
        }
        let [alice_msg, bob_msg] = posted[..] else {
            panic!("two messages");
        };
        let dm: i64 =
            sqlx::query("INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id")
                .fetch_one(db)
                .await
                .expect("dm")
                .try_get(0)
                .expect("dm id");
        sqlx::query(
            "INSERT INTO messages(dm_id, author, content, created_at) VALUES($1, 'bob', 'hey', $2)",
        )
        .bind(dm)
        .bind(now())
        .execute(db)
        .await
        .expect("dm message");
        let alice = get_user(db, "alice").await.expect("q").expect("alice");
        let before = overview(State(state.clone()), Authed(alice.clone()))
            .await
            .expect("overview")
            .0;

        let servers = hide_user_rows(&state, "bob", PurgeKind::User)
            .await
            .expect("hide")
            .expect("hidden now");
        assert_eq!(servers, ["rchat"]);

        assert!(get_user(db, "bob").await.expect("q").is_none());
        assert!(user_row(db, "bob").await.expect("q").is_some());
        assert!(
            crate::api::user_for_token(&state, &bob_token)
                .await
                .is_none()
        );
        assert!(matches!(
            crate::ws::current(
                &state,
                WsEvent::Banned {
                    username: "bob".to_string()
                }
            )
            .await,
            Some(WsEvent::Banned { .. })
        ));
        assert!(matches!(
            crate::ws::current(
                &state,
                WsEvent::MemberLeft {
                    server: "rchat".to_string(),
                    username: "bob".to_string()
                }
            )
            .await,
            Some(WsEvent::MemberLeft { .. })
        ));
        let login_req: LoginReq =
            serde_json::from_value(json!({"username": "bob", "password": "a"})).expect("login");
        assert!(matches!(
            login(State(state.clone()), Json(login_req)).await,
            Err(ApiError(StatusCode::UNAUTHORIZED, _))
        ));
        let card = profile(
            State(state.clone()),
            MaybeAuthed(Some(alice.clone())),
            HeaderMap::new(),
            Path("bob".to_string()),
            Query(serde_json::from_value(json!({"server": "rchat"})).expect("pq")),
        )
        .await;
        assert!(matches!(card, Err(ApiError(StatusCode::NOT_FOUND, _))));
        let opened = open_dm(
            State(state.clone()),
            Authed(alice.clone()),
            Json(serde_json::from_value(json!({"username": "bob"})).expect("open")),
        )
        .await;
        assert!(matches!(opened, Err(ApiError(StatusCode::NOT_FOUND, _))));
        let listed = dm_page(db, "alice", 0, None, 50).await.expect("dms").items;
        assert!(listed.iter().all(|d| d.other.username != "bob"));
        assert!(
            dms_by_ids(db, "alice", &[dm])
                .await
                .expect("ids")
                .is_empty()
        );
        let unread = unreads(
            State(state.clone()),
            Authed(alice.clone()),
            Query(serde_json::from_value(json!({"all": true})).expect("uq")),
        )
        .await
        .expect("unreads")
        .0;
        assert!(unread.items.iter().all(|u| u.scope != format!("d{dm}")));
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM members WHERE username = 'bob'").await,
            0
        );
        assert!(
            crate::api::messages::load_message(db, bob_msg)
                .await
                .expect("load")
                .is_none()
        );
        assert!(
            crate::api::messages::load_message(db, alice_msg)
                .await
                .expect("load")
                .is_some()
        );
        assert!(matches!(
            crate::api::messages::message_scope(db, bob_msg).await,
            Err(ApiError(StatusCode::NOT_FOUND, _))
        ));
        let carol = get_user(db, "carol").await.expect("q").expect("carol");
        let carol_unread = unreads(
            State(state.clone()),
            Authed(carol),
            Query(serde_json::from_value(json!({"all": true})).expect("uq")),
        )
        .await
        .expect("unreads")
        .0;
        let general = carol_unread
            .items
            .iter()
            .find(|u| u.scope == format!("c{cid}"))
            .expect("general unread");
        assert_eq!(general.latest, alice_msg);
        let history = recent_channel_messages(db, cid, 50).await.expect("history");
        assert!(history.iter().all(|m| m.author.username != "bob"));
        assert!(history.iter().any(|m| m.author.username == "alice"));
        let Paged(found, _) = search(
            State(state.clone()),
            MaybeAuthed(Some(alice.clone())),
            HeaderMap::new(),
            RawQuery(Some("q=needle".to_string())),
        )
        .await
        .expect("search");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].message.author.username, "alice");
        let Paged(users, _) = list_users(
            State(state.clone()),
            Authed(alice.clone()),
            Query(AdminQuery {
                offset: None,
                limit: None,
                q: None,
                cursor: None,
            }),
        )
        .await
        .expect("users");
        assert!(users.iter().all(|u| u.username != "bob"));
        let after = overview(State(state.clone()), Authed(alice.clone()))
            .await
            .expect("overview")
            .0;
        assert_eq!(after.user_count, before.user_count - 1);
        match reg(&state, "bob").await {
            Err(ApiError(StatusCode::BAD_REQUEST, msg)) => assert_eq!(msg, "Username is taken"),
            _ => panic!("expected the name to stay taken"),
        }
        sqlx::query("UPDATE pending_purges SET claimed_at = 0")
            .execute(db)
            .await
            .expect("expire lease");
        assert_eq!(resume_purges(&state).await.expect("resume"), 1);
        assert!(user_row(db, "bob").await.expect("q").is_none());
        assert_eq!(
            count(
                db,
                "SELECT COUNT(*) FROM messages WHERE author = 'bob' OR dm_id IS NOT NULL"
            )
            .await,
            0
        );
        let _ = reg(&state, "bob").await.expect("name free after the purge");
        done(state, path).await;
    }

    #[tokio::test]
    async fn banning_a_pending_delete_keeps_the_name_reserved() {
        let (state, path) = temp_state("ban_pending").await;
        let _ = reg(&state, "alice").await.expect("register alice");
        let _ = reg(&state, "bob").await.expect("register bob");
        let db = &state.db;
        let alice = get_user(db, "alice").await.expect("q").expect("alice");
        assert!(
            hide_user_rows(&state, "bob", PurgeKind::User)
                .await
                .expect("hide")
                .is_some()
        );
        let mut rx = state.hub.subscribe();
        let _ = ban_user(
            State(state.clone()),
            Authed(alice.clone()),
            Json(BanReq {
                username: "bob".to_string(),
            }),
        )
        .await
        .expect("ban a pending delete");
        assert!(rx.try_recv().is_err());
        assert_eq!(
            count(
                db,
                "SELECT COUNT(*) FROM banned_usernames WHERE username = 'bob'"
            )
            .await,
            1
        );
        assert_eq!(
            count(
                db,
                "SELECT COUNT(*) FROM pending_purges WHERE kind = 'ban' AND key = 'bob'"
            )
            .await,
            1
        );
        let _ = delete_user(
            State(state.clone()),
            Authed(alice.clone()),
            Path("bob".to_string()),
        )
        .await
        .expect("delete stays idempotent");
        match reg(&state, "bob").await {
            Err(ApiError(StatusCode::BAD_REQUEST, msg)) => assert_eq!(msg, "Username is banned"),
            _ => panic!("expected banned"),
        }
        let missing = ban_user(
            State(state.clone()),
            Authed(alice),
            Json(BanReq {
                username: "nobody".to_string(),
            }),
        )
        .await;
        assert!(matches!(missing, Err(ApiError(StatusCode::NOT_FOUND, _))));
        finish_purge(&state, PurgeKind::User, "bob")
            .await
            .expect("the in-flight delete finishes");
        assert_eq!(count(db, "SELECT COUNT(*) FROM pending_purges").await, 0);
        assert!(user_row(db, "bob").await.expect("q").is_none());
        match reg(&state, "bob").await {
            Err(ApiError(StatusCode::BAD_REQUEST, msg)) => assert_eq!(msg, "Username is banned"),
            _ => panic!("expected banned after the purge"),
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn release_covers_a_user_purge_turned_ban() {
        let (state, path) = temp_state("release_kinds").await;
        let db = &state.db;
        sqlx::query("INSERT INTO pending_purges(kind, key, created_at, claimed_at) VALUES('ban', 'bob', 1, $1)")
            .bind(now())
            .execute(db)
            .await
            .expect("job");
        release_purge(db, PurgeKind::User, "bob").await;
        assert_eq!(
            count(
                db,
                "SELECT claimed_at FROM pending_purges WHERE key = 'bob'"
            )
            .await,
            0
        );
        assert_eq!(
            stamp_purge(db, PurgeKind::User, "bob", 7)
                .await
                .expect("stamp"),
            1
        );
        assert_eq!(
            count(
                db,
                "SELECT claimed_at FROM pending_purges WHERE key = 'bob'"
            )
            .await,
            7
        );
        assert!(PURGE_LEASE < 600 && (PURGE_SWEEP_SECS as i64) < PURGE_LEASE);
        assert!((LEASE_RENEW.as_secs() as i64) * 2 < PURGE_LEASE);
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_lease_is_claimed_once_and_released_when_the_purge_dies() {
        let (state, path) = temp_state("lease_guard").await;
        let db = &state.db;
        sqlx::query("INSERT INTO pending_purges(kind, key, created_at, claimed_at) VALUES('user', 'bob', 1, 1)")
            .execute(db)
            .await
            .expect("job");
        let claimed = |at| claim_purge(&state, PurgeKind::User, "bob", at);
        assert!(claimed(now()).await.expect("claim"));
        assert!(!claimed(now()).await.expect("second claim"));
        assert!(
            !claimed(now() + PURGE_LEASE - 1)
                .await
                .expect("inside the lease")
        );
        let stamp = "SELECT claimed_at FROM pending_purges WHERE key = 'bob'";
        sqlx::query("UPDATE pending_purges SET claimed_at = 1")
            .execute(db)
            .await
            .expect("reset");
        let held = db.clone();
        let died = tokio::spawn(async move {
            let _lease = Lease::start(&held, PurgeKind::User, "bob", Duration::from_millis(20));
            tokio::time::sleep(Duration::from_millis(120)).await;
            panic!("purge blew up");
        })
        .await;
        assert!(died.is_err());
        let mut released = false;
        for _ in 0..50 {
            tokio::time::sleep(Duration::from_millis(10)).await;
            if count(db, stamp).await == 0 {
                released = true;
                break;
            }
        }
        assert!(released, "the lease was released after the panic");
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(count(db, stamp).await, 0, "the renewer stopped");
        let lease = Lease::start(db, PurgeKind::User, "bob", Duration::from_millis(20));
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert!(count(db, stamp).await > 1, "the renewer stamps the lease");
        lease.end(false).await;
        assert_eq!(count(db, stamp).await, 0);
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert_eq!(count(db, stamp).await, 0);
        done(state, path).await;
    }

    #[tokio::test]
    async fn resume_skips_claimed_jobs_and_survives_a_failing_one() {
        let (state, path) = temp_state("resume_failing").await;
        let db = &state.db;
        for (name, created, claimed) in [("bad", 1, 0), ("good", 2, 0), ("busy", 3, now())] {
            sqlx::query("INSERT INTO servers(name, display_name, password_hash, created_at) VALUES($1, $1, '!purging', 1)")
                .bind(name)
                .execute(db)
                .await
                .expect("server");
            sqlx::query("INSERT INTO pending_purges(kind, key, created_at, claimed_at) VALUES('server', $1, $2, $3)")
                .bind(name)
                .bind(created)
                .bind(claimed)
                .execute(db)
                .await
                .expect("job");
        }
        sqlx::query("CREATE TRIGGER fail_bad BEFORE DELETE ON servers WHEN old.name = 'bad' BEGIN SELECT RAISE(ABORT, 'boom'); END")
            .execute(db)
            .await
            .expect("trigger");
        assert_eq!(resume_purges(&state).await.expect("resume"), 1);
        let left = |name: &'static str| {
            let db = db.clone();
            async move {
                count(
                    &db,
                    &format!("SELECT COUNT(*) FROM servers WHERE name = '{name}'"),
                )
                .await
            }
        };
        assert_eq!(left("good").await, 0);
        assert_eq!(left("bad").await, 1);
        assert_eq!(left("busy").await, 1);
        assert_eq!(
            count(
                db,
                "SELECT claimed_at FROM pending_purges WHERE key = 'bad'"
            )
            .await,
            0
        );
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM pending_purges WHERE key = 'good'").await,
            0
        );
        sqlx::query("DROP TRIGGER fail_bad")
            .execute(db)
            .await
            .expect("drop trigger");
        assert_eq!(resume_purges(&state).await.expect("retry"), 1);
        assert_eq!(left("bad").await, 0);
        assert_eq!(left("busy").await, 1);
        done(state, path).await;
    }

    #[tokio::test]
    async fn admin_lists_walk_by_cursor() {
        let (state, path) = temp_state("admin_cursor").await;
        let db = &state.db;
        for n in 0..57 {
            sqlx::query("INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, created_at) VALUES($1, $1, '', 'text', 'identicon', 0)")
                .bind(format!("user{n:02}"))
                .execute(db)
                .await
                .expect("user");
            sqlx::query("INSERT INTO servers(name, display_name, creator, created_at) VALUES($1, $1, 'user00', 0)")
                .bind(format!("srv{n:02}"))
                .execute(db)
                .await
                .expect("server");
        }
        let root = || Authed(crate::api::test_util::mem_user("root", true));
        let query = |q: &str, cursor: Option<String>| AdminQuery {
            offset: None,
            limit: None,
            q: Some(q.to_string()),
            cursor,
        };
        let mut seen = Vec::new();
        let mut cursor = None;
        loop {
            let Paged(users, next) =
                list_users(State(state.clone()), root(), Query(query("user", cursor)))
                    .await
                    .expect("users");
            seen.extend(users.into_iter().map(|u| u.username));
            match next {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        let want: Vec<String> = (0..57).map(|n| format!("user{n:02}")).collect();
        assert_eq!(seen, want);
        let Paged(first, next) = user_servers(
            State(state.clone()),
            root(),
            Path("user00".to_string()),
            Query(query("", None)),
        )
        .await
        .expect("owned");
        assert_eq!(first.len(), 50);
        let Paged(rest, end) = user_servers(
            State(state.clone()),
            root(),
            Path("user00".to_string()),
            Query(query("", next)),
        )
        .await
        .expect("owned rest");
        assert_eq!(rest.len(), 7);
        assert!(end.is_none());
        let Paged(servers, _) =
            list_servers(State(state.clone()), root(), Query(query("srv5", None)))
                .await
                .expect("servers");
        assert_eq!(servers.len(), 12);
        done(state, path).await;
    }
}
