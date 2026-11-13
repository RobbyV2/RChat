use std::collections::HashMap;
use std::time::Duration;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::api::access::{MsgScope, not_found, staff_message};
use crate::api::controls::{ConfigRecords, Control, ROWS_SQL};
use crate::api::features::{Feature, Registration};
use crate::api::policy::{
    DmCreation, FRIEND_REQUESTS, Policy, SERVER_CREATORS, SERVER_SEARCH, ServerCreation,
    ServerJoining,
};
use crate::api::reports::forms::{self, Form, ReportForms};
use crate::api::{
    ApiError, Authed, OkResp, Paged, ProfanitySwitch, ServerDetail, ServerSummaryLite, Settings,
    UserRef, bad, decode_cursor, encode_cursor, ok, reports, upload_expiry,
};
use crate::db::{AvatarKind, Db, User, get_user, now, purge_messages, recount_members, user_row};
use crate::state::AppState;
use crate::ws::WsEvent;

#[derive(Serialize)]
pub struct Overview {
    pub server_count: i64,
    pub user_count: i64,
    pub relay: RelayStatus,
}

#[derive(Serialize)]
pub struct RelayStatus {
    pub enabled: bool,
    pub turn: bool,
    pub port: Option<u16>,
    pub allocations: Option<usize>,
}

fn relay_status(state: &AppState) -> RelayStatus {
    let advert = state.instance.ice.relay.as_ref();
    let local = crate::relay::status();
    RelayStatus {
        enabled: advert.is_some(),
        turn: advert.is_some_and(|r| r.turn),
        port: advert.map(|r| r.port),
        allocations: local.map(|s| s.allocations),
    }
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

/// Whether a row found by a `like_pattern` search matches `q` by name or display name. A fuzzy
/// pattern only narrows the rows, so those are checked again here.
pub(crate) fn name_hit(q: &str, fuzzy: bool, name: &str, display_name: &str) -> bool {
    !fuzzy || fuzzy_match(q, name) || fuzzy_match(q, display_name)
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
    channel_topics: Option<bool>,
    category_names: Option<bool>,
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
            channel_topics,
            category_names,
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
            ProfanitySwitch::ChannelTopics => channel_topics,
            ProfanitySwitch::CategoryNames => category_names,
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
    p2p_attachments: Option<bool>,
    guests_enabled: Option<bool>,
    #[serde(default)]
    outgoing_webhooks: Option<bool>,
    server_reports: Option<bool>,
    instance_reports: Option<bool>,
    widgets: Option<bool>,
    widget_chat: Option<bool>,
    widget_read_links: Option<bool>,
    widget_bridge: Option<bool>,
    e2ee: Option<bool>,
    e2ee_compliance: Option<bool>,
    backup_phrase: Option<bool>,
    p2p_backup: Option<bool>,
    display_names: Option<bool>,
    onboarding: Option<bool>,
    password_login: Option<bool>,
    sfu: Option<bool>,
    p2p: Option<bool>,
    client_other_instances: Option<bool>,
    registration: Option<Registration>,
    upload_expiry_max_days: Option<i64>,
    server_creation: Option<ServerCreation>,
    server_creators: Option<Vec<String>>,
    server_joining: Option<ServerJoining>,
    server_search: Option<bool>,
    dm_creation: Option<DmCreation>,
    friend_requests: Option<bool>,
}

pub(crate) fn require_site_admin(user: &User) -> Result<(), ApiError> {
    match user.is_site_admin {
        true => Ok(()),
        false => Err(not_found()),
    }
}

/// Get the instance settings
///
/// The instance-wide feature switches clients need to adapt their UI: profanity filter and
/// its targets, link previews, uploads, P2P attachments, guest access, outgoing webhooks,
/// reports, widgets, encryption, backup phrases, P2P backups, display names, onboarding,
/// password sign-in and sign-up, the media server, P2P, whether the web app this instance
/// serves offers other instances, who may create servers, how people join them, whether
/// they can be searched, who may start direct conversations and whether friend requests are
/// on. A switched-off feature's endpoints answer 404, except that
/// uploads, P2P attachments and outgoing webhooks answer 403, guests get 401 while guest
/// access is off, and `client_other_instances` gates no endpoint. No authentication. Values
/// may lag a change by up to 5 seconds per server process; live changes also arrive as the
/// `settings_changed` WebSocket event. General rate-limit bucket.
#[utoipa::path(get, path = "/api/v1/settings", tag = "Instance", responses((status = 200, description = "Site-wide switches: profanity filter (master switch `profanity_filter` plus per-target `profanity_targets`), link previews, uploads, P2P attachments, guest access, outgoing webhooks, reports, widgets, encryption, backup phrases, P2P backups, display names, onboarding, password sign-in, the media server, P2P, other instances in this instance's web app, `registration`, `server_creation`, `server_joining`, `server_search`, `dm_creation` and `friend_requests`", body = Settings), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(()))]
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
        p2p_attachments,
        guests_enabled,
        outgoing_webhooks,
        server_reports,
        instance_reports,
        widgets,
        widget_chat,
        widget_read_links,
        widget_bridge,
        e2ee,
        e2ee_compliance,
        backup_phrase,
        p2p_backup,
        display_names,
        onboarding,
        password_login,
        sfu,
        p2p,
        client_other_instances,
        registration,
        upload_expiry_max_days,
        server_creation,
        server_creators,
        server_joining,
        server_search,
        dm_creation,
        friend_requests,
    } = req;
    if upload_expiry_max_days.is_some_and(|d| !(0..=upload_expiry::CAP_DAYS_MAX).contains(&d)) {
        return Err(bad("The longest file expiry must be 0 to 365 days"));
    }
    let creators = match server_creators {
        Some(entries) => {
            let stored = match entries
                .iter()
                .any(|e| e.trim().is_empty() || e.contains(','))
            {
                true => Err(format!(
                    "expected up to {} usernames or server:role entries",
                    crate::api::controls::NAMES_MAX
                )),
                false => Control::find(SERVER_CREATORS)
                    .ok_or_else(not_found)?
                    .parse(&entries.join(",")),
            };
            Some(stored.map_err(|expected| bad(&format!("{SERVER_CREATORS}: {expected}")))?)
        }
        None => None,
    };
    let feature = |f: Feature| match f {
        Feature::ServerReports => server_reports,
        Feature::InstanceReports => instance_reports,
        Feature::Widgets => widgets,
        Feature::WidgetChat => widget_chat,
        Feature::WidgetReadLinks => widget_read_links,
        Feature::WidgetBridge => widget_bridge,
        Feature::E2ee => e2ee,
        Feature::E2eeCompliance => e2ee_compliance,
        Feature::BackupPhrase => backup_phrase,
        Feature::P2pBackup => p2p_backup,
        Feature::DisplayNames => display_names,
        Feature::Onboarding => onboarding,
        Feature::PasswordLogin => password_login,
        Feature::Sfu => sfu,
        Feature::P2p => p2p,
        Feature::ClientOtherInstances => client_other_instances,
    };
    let switches = [
        ("profanity_filter", profanity_filter),
        ("asset_previews", asset_previews),
        ("asset_uploads", asset_uploads),
        ("p2p_attachments", p2p_attachments),
        ("guests_enabled", guests_enabled),
        ("outgoing_webhooks", outgoing_webhooks),
        (SERVER_SEARCH, server_search),
        (FRIEND_REQUESTS, friend_requests),
    ]
    .into_iter()
    .chain(
        ProfanitySwitch::ALL
            .into_iter()
            .map(|t| (t.key(), profanity_targets.get(t))),
    )
    .chain(Feature::ALL.into_iter().map(|f| (f.key(), feature(f))))
    .filter_map(|(key, on)| on.map(|on| (key, u8::from(on).to_string())));
    let pairs: Vec<(&str, String)> = switches
        .chain(registration.map(|r| (Registration::KEY, r.as_str().to_string())))
        .chain(upload_expiry_max_days.map(|d| (upload_expiry::CAP_KEY, d.to_string())))
        .chain(server_creation.map(|c| (ServerCreation::KEY, c.as_str().to_string())))
        .chain(creators.map(|list| (SERVER_CREATORS, list)))
        .chain(server_joining.map(|j| (ServerJoining::KEY, j.as_str().to_string())))
        .chain(dm_creation.map(|d| (DmCreation::KEY, d.as_str().to_string())))
        .collect();
    let records = ConfigRecords::load(&state.db).await?;
    let touched: Vec<&Control> = Control::all()
        .iter()
        .filter(|c| pairs.iter().any(|(key, _)| c.keys().contains(key)))
        .collect();
    if let Some(control) = touched.iter().find(|c| records.pins(c)) {
        return Err(bad(&format!("Set in the server config: {}", control.env)));
    }
    let mut tx = state.db.begin().await?;
    let before = control_rows(&mut tx).await?;
    let mut after = before.clone();
    for (key, value) in pairs {
        sqlx::query(
            "INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind(key)
        .bind(&value)
        .execute(&mut *tx)
        .await?;
        after.insert(key.to_string(), value);
    }
    let t = now();
    for control in touched {
        let shown = |rows: &HashMap<String, String>| {
            control.shown(control.read(rows).as_deref().unwrap_or(control.default))
        };
        let (from, to) = (shown(&before), shown(&after));
        if from != to {
            crate::api::instance_audit::record_in(
                &mut tx,
                &user.username,
                "settings.change",
                Some(control.key),
                serde_json::json!({"key": control.key, "from": from, "to": to}),
                t,
            )
            .await?;
        }
    }
    tx.commit().await?;
    let settings = Settings::load(&state.db).await;
    Policy::load(&state.db).await;
    if let Some(cap) = upload_expiry_max_days {
        upload_expiry::retime_all(&state.db, cap, upload_expiry::KeptLimits::of(&state.limits))
            .await?;
    }
    state.hub.broadcast(WsEvent::SettingsChanged { settings });
    Ok(Json(settings))
}

/// The `settings` rows of every control, by key.
async fn control_rows(conn: &mut sqlx::AnyConnection) -> sqlx::Result<HashMap<String, String>> {
    let mut rows = HashMap::new();
    for row in sqlx::query(sqlx::AssertSqlSafe(ROWS_SQL.as_str()))
        .fetch_all(&mut *conn)
        .await?
    {
        rows.insert(row.try_get::<String, _>(0)?, row.try_get::<String, _>(1)?);
    }
    Ok(rows)
}

/// One control in the config view: its stored value, what the server config said at the last
/// start that set it, and whether the config pins it.
#[derive(Serialize)]
pub struct ControlRow {
    pub key: &'static str,
    pub env: &'static str,
    pub value: String,
    pub config: Option<String>,
    pub pinned: bool,
}

/// One limit in the config view. Limits change only in the server config, at a start.
#[derive(Serialize)]
pub struct LimitRow {
    pub env: &'static str,
    pub value: Option<i64>,
    pub default: Option<i64>,
    pub range: String,
}

#[derive(Serialize)]
pub struct ConfigView {
    pub controls: Vec<ControlRow>,
    pub limits: Vec<LimitRow>,
}

pub(crate) async fn get_config(
    State(state): State<AppState>,
    Authed(user): Authed,
) -> Result<Json<ConfigView>, ApiError> {
    require_site_admin(&user)?;
    let records = ConfigRecords::load(&state.db).await?;
    let stored = control_rows(&mut *state.db.acquire().await?).await?;
    let controls = Control::all()
        .iter()
        .map(|c| ControlRow {
            key: c.key,
            env: c.env,
            value: c.shown(c.read(&stored).as_deref().unwrap_or(c.default)),
            config: records.config(c).map(|value| c.shown(value)),
            pinned: records.pins(c),
        })
        .collect();
    let defaults = crate::limits::Limits::default().rows();
    let limits = state
        .limits
        .rows()
        .into_iter()
        .zip(defaults)
        .map(|((env, value), (_, default))| LimitRow {
            env,
            value,
            default,
            range: crate::limits::Limits::range(env)
                .map_or(String::new(), |(lo, hi)| format!("{lo}-{hi}")),
        })
        .collect();
    Ok(Json(ConfigView { controls, limits }))
}

/// The whole forms document, turned-off categories included.
pub(crate) async fn get_report_forms(
    State(state): State<AppState>,
    Authed(user): Authed,
) -> Result<Json<ReportForms>, ApiError> {
    require_site_admin(&user)?;
    Ok(Json(Policy::load(&state.db).await.report_forms.clone()))
}

/// Request body of `PUT /api/v1/admin/report_forms`: every category, in list order, and the
/// revision the editor loaded.
#[derive(Deserialize)]
pub struct ReportFormsReq {
    #[serde(default)]
    rev: Option<i64>,
    forms: Vec<Form>,
}

/// Replaces the forms. A change takes the next revision and is noted in the instance audit
/// log; the same forms again change nothing. A `rev` that is not the stored one is a 409.
pub(crate) async fn put_report_forms(
    State(state): State<AppState>,
    Authed(user): Authed,
    Json(ReportFormsReq { rev, forms }): Json<ReportFormsReq>,
) -> Result<Json<ReportForms>, ApiError> {
    require_site_admin(&user)?;
    let control = Control::find(forms::KEY).ok_or_else(not_found)?;
    if ConfigRecords::load(&state.db).await?.pins(control) {
        return Err(reports::refused(&format!(
            "Set in the server config: {}",
            control.env
        )));
    }
    let mut tx = state.db.begin().await?;
    let stored: Option<String> = sqlx::query("SELECT value FROM settings WHERE key = $1")
        .bind(forms::KEY)
        .fetch_optional(&mut *tx)
        .await?
        .map(|r| r.try_get(0))
        .transpose()?;
    let before = stored
        .as_deref()
        .and_then(ReportForms::from_stored)
        .unwrap_or_default();
    let changed = || {
        ApiError(
            StatusCode::CONFLICT,
            "The forms changed. Load them again".to_string(),
        )
    };
    if rev.is_some_and(|rev| rev != before.rev) {
        return Err(changed());
    }
    let after = ReportForms {
        rev: before.rev + 1,
        forms,
    };
    after.check().map_err(|wrong| reports::refused(&wrong))?;
    if stored.is_some() && after.forms == before.forms {
        return Ok(Json(before));
    }
    let written = match &stored {
        Some(stored) => {
            sqlx::query("UPDATE settings SET value = $1 WHERE key = $2 AND value = $3")
                .bind(after.stored())
                .bind(forms::KEY)
                .bind(stored)
                .execute(&mut *tx)
                .await?
        }
        None => {
            sqlx::query(
                "INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO NOTHING",
            )
            .bind(forms::KEY)
            .bind(after.stored())
            .execute(&mut *tx)
            .await?
        }
    };
    if written.rows_affected() == 0 {
        return Err(changed());
    }
    crate::api::instance_audit::record_in(
        &mut tx,
        &user.username,
        "report_forms.change",
        None,
        serde_json::json!({"rev": after.rev}),
        now(),
    )
    .await?;
    tx.commit().await?;
    Policy::load(&state.db).await;
    let settings = Settings::load(&state.db).await;
    state.hub.broadcast(WsEvent::SettingsChanged { settings });
    Ok(Json(after))
}

/// Request body of `POST /api/v1/admin/servers`.
#[derive(Deserialize)]
pub struct AdminServerReq {
    /// The server's name, with the rules of `POST /api/v1/servers`.
    name: String,
    /// The account that gets the server: its admin with every permission.
    owner: String,
    /// Optional join password, 8 characters or more.
    password: Option<String>,
}

/// Creates a server for `owner`, whatever `server_creation` says: the operator's way to make
/// servers while people can't. The server has no creator, like one whose creator left.
pub(crate) async fn create_server_for(
    State(state): State<AppState>,
    Authed(user): Authed,
    Json(req): Json<AdminServerReq>,
) -> Result<Json<ServerDetail>, ApiError> {
    require_site_admin(&user)?;
    let AdminServerReq {
        name,
        owner,
        password,
    } = req;
    let Some(owner) = get_user(&state.db, &owner).await? else {
        return Err(bad("No such account"));
    };
    crate::api::servers::found_for(&state, &user, &name, password.as_deref(), &owner).await
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
        relay: relay_status(&state),
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
        if !name_hit(&q, fuzzy, &username, &display_name) {
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
        if !name_hit(&q, fuzzy, &name, &display_name) {
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
        return Err(bad("The rchat server cannot be deleted"));
    }
    match remove_server(&state, &name).await? {
        true => Ok(ok()),
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
        "members",
        "user_roles",
        "interactions",
        "server_bans",
        "member_timeouts",
    ] {
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "DELETE FROM {table} WHERE server = $1"
        )))
        .bind(name)
        .execute(&mut *tx)
        .await?;
    }
    crate::api::policy::move_creator_roles(&mut tx, name, None).await?;
    note_purge(&mut tx, PurgeKind::Server, name, now()).await?;
    tx.commit().await?;
    Policy::load(&state.db).await;
    state.hub.broadcast(WsEvent::ServerDeleted {
        name: name.to_string(),
    });
    spawn_purge(state, PurgeKind::Server, name);
    Ok(true)
}

pub(crate) async fn hide_user_rows(
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
        "DELETE FROM config_shares WHERE owner = $1",
        "DELETE FROM members WHERE username = $1",
        "DELETE FROM user_roles WHERE username = $1",
        "DELETE FROM interactions WHERE username = $1",
        "DELETE FROM server_bans WHERE username = $1",
        "DELETE FROM member_timeouts WHERE username = $1",
        "DELETE FROM here_pings WHERE username = $1",
        "DELETE FROM bulk_delete_jobs WHERE username = $1",
        "UPDATE server_passwords SET created_by = NULL WHERE created_by = $1",
        "UPDATE webhooks SET creator = NULL, creator_mentions = 0 WHERE creator = $1",
        "UPDATE outgoing_webhooks SET creator = NULL WHERE creator = $1",
        "UPDATE servers SET creator = NULL WHERE creator = $1",
        "UPDATE servers SET upload_expiry_by = NULL WHERE upload_expiry_by = $1",
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
    for server in &servers {
        if let Err(e) = recount_members(&state.db, server).await {
            tracing::warn!("member count of {server} not updated: {e}");
        }
    }
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
            crate::api::audit::purge_server(&state.db, key).await?;
            reports::purge_server(&state.db, key).await?;
            let mut tx = state.db.begin().await?;
            crate::db::no_statement_limit(&mut tx).await?;
            sqlx::query("DELETE FROM servers WHERE name = $1 AND password_hash = $2")
                .bind(key)
                .bind(PURGING_HASH)
                .execute(&mut *tx)
                .await?;
            clear_purge(&mut tx, kind, key).await?;
            tx.commit().await
        }
        PurgeKind::User | PurgeKind::Ban => {
            let pepper = crate::db::pepper(&state.db).await?;
            purge_messages(&state.db, "author = $1", key).await?;
            purge_messages(
                &state.db,
                "dm_id IN (SELECT id FROM dms WHERE user_a = $1 UNION ALL SELECT id FROM dms WHERE user_b = $1)",
                key,
            )
            .await?;
            let mut tx = state.db.begin().await?;
            crate::db::no_statement_limit(&mut tx).await?;
            sqlx::query("UPDATE users SET password_hash = password_hash WHERE username = $1")
                .bind(key)
                .execute(&mut *tx)
                .await?;
            let row = user_row(&mut *tx, key).await?;
            let purging = row.as_ref().is_none_or(|u| u.password_hash == PURGING_HASH);
            let gone = match purging {
                true => {
                    let gone = crate::api::friends::gone_of(&mut tx, key).await?;
                    let polls = crate::api::polls::forget_voter(
                        &mut tx,
                        &pepper,
                        key,
                        row.as_ref().map(|u| u.created_at),
                    )
                    .await?;
                    drop_user_rows(&mut tx, key).await?;
                    Some((gone, polls))
                }
                false => None,
            };
            clear_purge(&mut tx, kind, key).await?;
            tx.commit().await?;
            if let Some((gone, polls)) = gone {
                Policy::load(&state.db).await;
                for id in polls {
                    crate::api::polls::schedule_update(state, id);
                }
                crate::api::friends::announce_gone(state, key, gone).await;
            }
            Ok(())
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
        "UPDATE messages SET fwd_author = NULL WHERE fwd_author = $1",
        "DELETE FROM dms WHERE user_a = $1",
        "DELETE FROM dms WHERE user_b = $1",
        "DELETE FROM members WHERE username = $1",
        "DELETE FROM user_roles WHERE username = $1",
        "DELETE FROM interactions WHERE username = $1",
        "DELETE FROM server_bans WHERE username = $1",
        "DELETE FROM member_timeouts WHERE username = $1",
        "DELETE FROM tokens WHERE username = $1",
        "DELETE FROM config_shares WHERE owner = $1",
        "DELETE FROM pings WHERE username = $1",
        "DELETE FROM pings WHERE actor = $1",
        "DELETE FROM group_pings_read WHERE username = $1",
        "DELETE FROM here_pings WHERE username = $1",
        "DELETE FROM reactions WHERE username = $1",
        "UPDATE poll_options SET added_by = NULL WHERE added_by = $1",
        "UPDATE polls SET closed_by = NULL WHERE closed_by = $1",
        "UPDATE server_passwords SET created_by = NULL WHERE created_by = $1",
        "UPDATE messages SET pinned_by = NULL WHERE pinned_by = $1",
        "UPDATE servers SET creator = NULL WHERE creator = $1",
        "UPDATE servers SET upload_expiry_by = NULL WHERE upload_expiry_by = $1",
        "UPDATE server_bans SET banned_by = NULL WHERE banned_by = $1",
        "UPDATE member_timeouts SET set_by = NULL WHERE set_by = $1",
        "UPDATE media SET uploader = NULL WHERE uploader = $1",
        "UPDATE media SET charged_to = NULL WHERE charged_to = $1",
        "DELETE FROM read_state WHERE username = $1",
        "DELETE FROM blocks WHERE blocker = $1",
        "DELETE FROM blocks WHERE blocked = $1",
        "DELETE FROM friends WHERE username = $1",
        "DELETE FROM friends WHERE friend = $1",
        "DELETE FROM friend_requests WHERE sender = $1",
        "DELETE FROM friend_requests WHERE recipient = $1",
        "DELETE FROM friend_pings WHERE username = $1",
        "DELETE FROM friend_pings WHERE actor = $1",
        "DELETE FROM privacy WHERE username = $1",
        "DELETE FROM users WHERE username = $1",
    ] {
        sqlx::query(sql).bind(key).execute(&mut **tx).await?;
    }
    sqlx::query("DELETE FROM channel_perms WHERE subject = $1")
        .bind(format!("u:{key}"))
        .execute(&mut **tx)
        .await?;
    crate::api::bulk_delete::forget_author(tx, key).await?;
    crate::api::audit::forget_user(tx, key).await?;
    reports::forget_user(tx, key).await?;
    crate::api::policy::forget_creator(tx, key).await?;
    crate::api::instance_audit::forget_user(tx, key).await
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
        return Err(bad("Cannot ban yourself"));
    }
    hide_user(&state, &key, PurgeKind::Ban).await?;
    Ok(ok())
}

async fn member_servers(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    username: &str,
) -> sqlx::Result<Vec<String>> {
    let rows = sqlx::query("SELECT server FROM members WHERE username = $1")
        .bind(username)
        .fetch_all(&mut **tx)
        .await?;
    let servers = rows
        .iter()
        .map(|r| r.try_get(0))
        .collect::<sqlx::Result<Vec<_>>>()?;
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
        return Err(bad("Cannot delete yourself"));
    }
    hide_user(&state, &key, PurgeKind::User).await?;
    Ok(ok())
}

#[derive(Serialize)]
pub struct PhraseRemoved {
    pub removed: bool,
}

pub(crate) async fn remove_phrase(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(username): Path<String>,
) -> Result<Json<PhraseRemoved>, ApiError> {
    require_site_admin(&user)?;
    let key = username.to_lowercase();
    if key == user.username {
        return Err(bad("Cannot remove your own backup phrase here"));
    }
    if key.contains('\0') {
        return Ok(Json(PhraseRemoved { removed: false }));
    }
    let mut tx = state.db.begin().await?;
    let removed = sqlx::query(
        "UPDATE users SET recovery_pub = NULL, recovery_set_at = NULL WHERE username = $1 AND recovery_pub IS NOT NULL AND password_hash <> '!purging'",
    )
    .bind(&key)
    .execute(&mut *tx)
    .await?
    .rows_affected()
        == 1;
    if removed {
        crate::api::instance_audit::record_in(
            &mut tx,
            &user.username,
            "user.remove_phrase",
            Some(&key),
            serde_json::json!({}),
            now(),
        )
        .await?;
    }
    tx.commit().await?;
    Ok(Json(PhraseRemoved { removed }))
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
    let scope = staff_message(&state.db, &user, id).await?;
    let channel = match scope.channel_id {
        Some(cid) => crate::api::audit::channel_ref(&state.db, cid).await?,
        None => None,
    };
    let mut tx = state.db.begin().await?;
    sqlx::query("DELETE FROM messages WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    if let (Some(server), Some(channel)) = (&scope.server, &channel) {
        crate::api::audit::record(
            &mut tx,
            crate::api::audit::message_entry(
                server,
                &crate::api::audit::Actor::Staff,
                crate::api::audit::Action::MessageDelete,
                id,
                &scope.author,
                channel,
            ),
        )
        .await?;
    }
    tx.commit().await?;
    let MsgScope {
        channel_id,
        dm_id,
        thread_root_id,
        kind: _,
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
    Ok(ok())
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

    /// The site admin deletes alice, who made `club` (bob is a member), banned carol from it,
    /// timed bob out, uploaded a file, owned a webhook that posted one and was among the online
    /// members bob's `@here` pinged. Then someone registers `alice` again and joins `club`.
    async fn a_newcomer_takes_a_deleted_creators_name(state: AppState) -> AppState {
        use crate::api::servers::{create_server, get_server, join_server, list_members};
        use crate::api::test_util::mem_user;
        use crate::api::{MaybeAuthed, Member};
        use axum::extract::{Query, RawQuery};
        use axum::http::HeaderMap;
        let db = &state.db;
        let root = || Authed(mem_user("root", true));
        for name in ["root", "alice", "bob", "dora", "erin"] {
            let _ = reg(&state, name).await.expect("register");
        }
        let user = |name: &'static str| {
            let db = db.clone();
            async move { get_user(&db, name).await.expect("user").expect("exists") }
        };
        for (maker, server) in [("alice", "Club"), ("dora", "Den"), ("erin", "Eyrie")] {
            let made = create_server(
                State(state.clone()),
                Authed(user(maker).await),
                Json(serde_json::from_value(json!({ "name": server })).expect("req")),
            )
            .await
            .expect("create")
            .0;
            assert_eq!(made.creator.as_deref(), Some(maker));
        }
        let _ = join_server(
            State(state.clone()),
            Authed(user("bob").await),
            Path("club".to_string()),
            None,
        )
        .await
        .expect("bob joins");
        for sql in [
            "INSERT INTO server_bans(server, username, banned_by, created_at) VALUES('club', 'carol', 'alice', 1)",
            "INSERT INTO member_timeouts(server, username, until, reason, set_by, created_at) VALUES('club', 'bob', 99999999999, NULL, 'alice', 1)",
            "INSERT INTO media(id, filename, mime, size, uploader, uploaded_at) VALUES('own', 'a.txt', 'text/plain', 1, 'alice', 99999999999)",
            "INSERT INTO media(id, filename, mime, size, uploader, uploaded_at, charged_to, charged_server) VALUES('hook', 'h.txt', 'text/plain', 1, '@webhook:1', 99999999999, 'alice', 'club')",
        ] {
            sqlx::query(sql).execute(db).await.expect(sql);
        }
        let t = now() - 100;
        for sql in [
            format!("INSERT INTO messages(channel_id, author, content, created_at) SELECT id, 'bob', '@here hi', {t} FROM channels WHERE server = 'club'"),
            format!("INSERT INTO group_pings(message_id, channel_id, server, kind, actor, created_at) SELECT id, channel_id, 'club', 'here', 'bob', {t} FROM messages WHERE content = '@here hi'"),
            "INSERT INTO here_pings(ping_id, username) SELECT g.id, u.username FROM group_pings g, users u WHERE u.username IN ('alice', 'dora', 'erin', 'root')".to_string(),
        ] {
            sqlx::query(sqlx::AssertSqlSafe(sql.clone()))
                .execute(db)
                .await
                .expect(&sql);
        }
        let pinged = |name: &'static str| {
            let db = db.clone();
            async move {
                count(
                    &db,
                    &format!("SELECT COUNT(*) FROM here_pings WHERE username = '{name}'"),
                )
                .await
            }
        };
        let creator = |server: &'static str| {
            let db = db.clone();
            async move {
                sqlx::query("SELECT creator FROM servers WHERE name = $1")
                    .bind(server)
                    .fetch_one(&db)
                    .await
                    .expect("server")
                    .try_get::<Option<String>, _>(0)
                    .expect("creator")
            }
        };

        let _ = delete_user(State(state.clone()), root(), Path("alice".to_string()))
            .await
            .expect("delete alice");
        assert_eq!(
            creator("club").await,
            None,
            "the creator goes with the account, before the purge finishes"
        );
        assert_eq!(pinged("alice").await, 0, "so do the @here pings to it");
        settle(db).await;
        assert!(get_user(db, "alice").await.expect("q").is_none());
        assert_eq!(pinged("alice").await, 0);
        let _ = reg(&state, "alice").await.expect("the name is free again");
        let newcomer = user("alice").await;
        let joined = join_server(
            State(state.clone()),
            Authed(newcomer.clone()),
            Path("club".to_string()),
            None,
        )
        .await
        .expect("the newcomer joins")
        .0;
        assert_eq!(joined.creator, None, "the joined server names no creator");
        let detail = get_server(
            State(state.clone()),
            MaybeAuthed(Some(user("bob").await)),
            HeaderMap::new(),
            Path("club".to_string()),
        )
        .await
        .expect("detail")
        .0;
        assert_eq!(detail.creator, None, "the server detail names no creator");
        let members: Vec<Member> = list_members(
            State(state.clone()),
            MaybeAuthed(Some(user("bob").await)),
            HeaderMap::new(),
            Path("club".to_string()),
            RawQuery(None),
        )
        .await
        .expect("members")
        .0;
        let listed = members
            .iter()
            .find(|m| m.user.username == "alice")
            .expect("the newcomer is a member");
        assert!(
            !listed.is_creator && !listed.is_admin,
            "no Creator badge in the member list"
        );
        let profile = crate::api::users::profile(
            State(state.clone()),
            MaybeAuthed(Some(user("bob").await)),
            HeaderMap::new(),
            Path("alice".to_string()),
            Query(serde_json::from_value(json!({ "server": "club" })).expect("query")),
        )
        .await
        .expect("profile")
        .0;
        let card = profile.member.expect("the newcomer's membership");
        assert!(!card.is_creator, "no Creator badge on the profile card");
        let mine = crate::api::servers::my_servers_page(db, "alice", 0, None, 50)
            .await
            .expect("the newcomer's servers");
        assert!(
            mine.items.iter().all(|s| s.creator.is_none()),
            "the newcomer's own server list names no creator"
        );
        let made = user_servers(
            State(state.clone()),
            root(),
            Path("alice".to_string()),
            Query(serde_json::from_value(json!({})).expect("query")),
        )
        .await
        .expect("the site admin's list")
        .0;
        assert!(
            made.is_empty(),
            "the site admin's list shows no server made by the newcomer"
        );
        for (what, sql) in [
            (
                "who banned",
                "SELECT COUNT(*) FROM server_bans WHERE banned_by = 'alice'",
            ),
            (
                "who set a timeout",
                "SELECT COUNT(*) FROM member_timeouts WHERE set_by = 'alice'",
            ),
            (
                "an upload",
                "SELECT COUNT(*) FROM media WHERE uploader = 'alice'",
            ),
            (
                "a webhook's upload",
                "SELECT COUNT(*) FROM media WHERE charged_to = 'alice'",
            ),
        ] {
            assert_eq!(count(db, sql).await, 0, "{what} is not the newcomer's");
        }
        assert_eq!(
            count(
                db,
                "SELECT COUNT(*) FROM server_bans WHERE server = 'club' AND username = 'carol'"
            )
            .await,
            1,
            "the ban itself stays"
        );
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM media WHERE id = 'hook' AND uploader = '@webhook:1' AND charged_server = 'club'").await,
            1,
            "the webhook's file stays its webhook's"
        );
        sqlx::query(
            "UPDATE members SET joined_at = 0 WHERE server = 'club' AND username = 'alice'",
        )
        .execute(db)
        .await
        .expect("joined before the ping");
        let unseen = crate::api::pings::group_unseen(db, "alice", &[])
            .await
            .expect("unseen");
        assert!(
            unseen.is_empty(),
            "no @here ping addressed to the deleted account reaches the newcomer"
        );
        assert_eq!(pinged("root").await, 1, "other members' pings stay");

        let _ = ban_user(
            State(state.clone()),
            root(),
            Json(serde_json::from_value(json!({ "username": "dora" })).expect("ban")),
        )
        .await
        .expect("a site-wide ban");
        assert_eq!(creator("den").await, None, "a site-wide ban clears it too");
        settle(db).await;
        assert_eq!(creator("den").await, None);
        assert_eq!(pinged("dora").await, 0);

        // A delete an older build began: the account is hidden, its purge is still pending and
        // the server still names it.
        sqlx::query("UPDATE users SET password_hash = $1 WHERE username = 'erin'")
            .bind(PURGING_HASH)
            .execute(db)
            .await
            .expect("hidden");
        sqlx::query("INSERT INTO pending_purges(kind, key, created_at, claimed_at) VALUES('user', 'erin', 1, 0)")
            .execute(db)
            .await
            .expect("pending");
        assert_eq!(creator("eyrie").await.as_deref(), Some("erin"));
        assert_eq!(pinged("erin").await, 1);
        resume_purges(&state)
            .await
            .expect("the purge resumed at start");
        settle(db).await;
        assert!(get_user(db, "erin").await.expect("q").is_none());
        assert_eq!(
            creator("eyrie").await,
            None,
            "the resumed purge clears it with the account"
        );
        assert_eq!(pinged("erin").await, 0, "and its @here pings");
        state
    }

    #[tokio::test]
    async fn a_deleted_creators_name_gives_a_newcomer_nothing() {
        let (state, path) = temp_state("creator_cleared").await;
        done(a_newcomer_takes_a_deleted_creators_name(state).await, path).await;
        if let Some((state, temp)) = crate::api::test_util::pg_state("creator_cleared").await {
            crate::api::test_util::pg_done(
                a_newcomer_takes_a_deleted_creators_name(state).await,
                temp,
            )
            .await;
        }
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
        for sql in [
            "INSERT INTO server_passwords(server, hash, lookup, created_by, created_at) VALUES('rchat', '!lookup', 'l', 'bob', 1)",
            "INSERT INTO read_state(username, scope, last_read) VALUES('bob', 'c1', 1)",
            "INSERT INTO messages(channel_id, author, content, pinned_at, pinned_by, created_at) VALUES((SELECT id FROM channels WHERE server = 'rchat'), 'alice', 'pinned', 1, 'bob', 1)",
        ] {
            sqlx::query(sql).execute(db).await.expect(sql);
        }
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
        for sql in [
            "SELECT COUNT(*) FROM server_passwords WHERE created_by = 'bob'",
            "SELECT COUNT(*) FROM read_state WHERE username = 'bob'",
            "SELECT COUNT(*) FROM messages WHERE pinned_by = 'bob'",
        ] {
            assert_eq!(count(db, sql).await, 0, "{sql}");
        }
        assert_eq!(
            count(
                db,
                "SELECT COUNT(*) FROM server_passwords WHERE lookup = 'l' AND created_by IS NULL"
            )
            .await,
            1
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

    async fn delete_during_account_hide(state: &AppState) {
        let db = &state.db;
        for stmt in [
            "INSERT INTO servers(name, display_name, creator, created_at) VALUES('club', 'Club', 'alice', 1)",
            "INSERT INTO members(server, username, joined_at) VALUES('club', 'alice', 1), ('club', 'bob', 1)",
            "INSERT INTO roles(server, name, color, perms) VALUES('club', 'crew', '#ffffff', 0)",
            "INSERT INTO user_roles(server, username, role_id) SELECT 'club', 'bob', id FROM roles WHERE server = 'club'",
            "INSERT INTO interactions(server, username, last_at) VALUES('club', 'bob', 1)",
            "INSERT INTO server_bans(server, username, banned_by, created_at) VALUES('club', 'bob', 'alice', 1)",
        ] {
            sqlx::query(stmt).execute(db).await.expect(stmt);
        }
        let mut tx = db.begin().await.expect("tx");
        sqlx::query("DELETE FROM members WHERE username = 'bob'")
            .execute(&mut *tx)
            .await
            .expect("the hide removes the memberships first");
        let delete = {
            let state = state.clone();
            tokio::spawn(async move { remove_server(&state, "club").await })
        };
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        for stmt in [
            "DELETE FROM user_roles WHERE username = 'bob'",
            "DELETE FROM interactions WHERE username = 'bob'",
            "DELETE FROM server_bans WHERE username = 'bob'",
        ] {
            sqlx::query(stmt)
                .execute(&mut *tx)
                .await
                .expect("then the roles, interactions and bans, while the delete waits");
        }
        tx.commit().await.expect("commit");
        match delete.await.expect("task") {
            Ok(removed) => assert!(removed),
            Err(ApiError(code, msg)) => panic!("{code}: {msg}"),
        }
        for table in ["members", "user_roles", "interactions", "server_bans"] {
            assert_eq!(
                count(
                    db,
                    &format!("SELECT COUNT(*) FROM {table} WHERE server = 'club'")
                )
                .await,
                0,
                "{table}"
            );
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn deleting_a_server_while_an_account_is_hidden_does_not_deadlock() {
        let (state, path) = temp_state("delete_hide_race").await;
        delete_during_account_hide(&state).await;
        done(state, path).await;
        if let Some((state, pg)) = crate::api::test_util::pg_state("delete_hide_race").await {
            delete_during_account_hide(&state).await;
            crate::api::test_util::pg_done(state, pg).await;
        }
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
        assert!(matches!(
            crate::api::access::resolve_server(
                db,
                "club",
                Some(&crate::api::test_util::mem_user("root", true)),
                &crate::api::access::Proof::none()
            )
            .await,
            Err(ApiError(StatusCode::NOT_FOUND, _))
        ));
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
        assert!(matches!(
            crate::api::access::resolve_server(
                db,
                "club2",
                Some(&crate::api::test_util::mem_user("root", true)),
                &crate::api::access::Proof::none()
            )
            .await,
            Err(ApiError(StatusCode::NOT_FOUND, _))
        ));
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
                .expect("lookup")
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
            crate::api::messages::load_message(db, bob_msg, crate::api::messages::Quotes::Skip)
                .await
                .expect("load")
                .is_none()
        );
        assert!(
            crate::api::messages::load_message(db, alice_msg, crate::api::messages::Quotes::Skip)
                .await
                .expect("load")
                .is_some()
        );
        assert!(matches!(
            crate::api::access::staff_message(
                db,
                &crate::api::test_util::mem_user("root", true),
                bob_msg
            )
            .await,
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
    async fn purging_an_author_keeps_forwards_and_anonymizes_them() {
        use crate::api::messages::{
            Quotes, SendReq, load_message, send_channel_message, send_thread_message,
        };

        let (state, path) = temp_state("purge_forwards").await;
        for name in ["root", "alice", "bob", "carol"] {
            let _ = reg(&state, name).await.expect("register");
        }
        let db = &state.db;
        let cid: i64 = sqlx::query("SELECT id FROM channels WHERE server = 'rchat'")
            .fetch_one(db)
            .await
            .expect("general")
            .try_get(0)
            .expect("channel id");
        sqlx::query("INSERT INTO members(server, username, joined_at) SELECT 'rchat', username, 0 FROM users WHERE username IN ('alice', 'bob', 'carol') AND NOT EXISTS(SELECT 1 FROM members WHERE server = 'rchat' AND members.username = users.username)")
            .execute(db)
            .await
            .expect("members");
        let source: i64 = sqlx::query("INSERT INTO messages(channel_id, author, content, created_at) VALUES($1, 'bob', 'bob wrote this', 5) RETURNING id")
            .bind(cid)
            .fetch_one(db)
            .await
            .expect("source")
            .try_get(0)
            .expect("id");
        let who = |name: &'static str| async move {
            Authed(get_user(db, name).await.expect("q").expect("user"))
        };
        let req = |id: i64| -> SendReq {
            serde_json::from_value(json!({"content": "", "forward_of": id})).expect("send req")
        };
        let copy = send_channel_message(
            State(state.clone()),
            Path(cid),
            who("alice").await,
            Json(req(source)),
        )
        .await
        .expect("forward")
        .0;
        let reply: SendReq =
            serde_json::from_value(json!({"content": "carol replies"})).expect("send req");
        let reply = send_thread_message(
            State(state.clone()),
            Path(copy.id),
            who("carol").await,
            Json(reply),
        )
        .await
        .expect("thread reply")
        .0;
        let author_of = |id: i64| async move {
            load_message(db, id, Quotes::Skip)
                .await
                .expect("load")
                .expect("still there")
                .forward
                .expect("still a forward")
                .author
                .map(|a| a.username)
        };
        assert_eq!(author_of(copy.id).await.as_deref(), Some("bob"));

        let _ = hide_user_rows(&state, "bob", PurgeKind::User)
            .await
            .expect("hide")
            .expect("hidden now");
        assert_eq!(
            author_of(copy.id).await,
            None,
            "a pending purge hides the original author"
        );
        let again = send_channel_message(
            State(state.clone()),
            Path(cid),
            who("carol").await,
            Json(req(copy.id)),
        )
        .await
        .expect("forward the forward")
        .0;
        let again_ref = again.forward.expect("forward ref");
        assert!(again_ref.author.is_none(), "never the forwarder's name");
        assert_eq!(again_ref.created_at, 5);

        sqlx::query("UPDATE pending_purges SET claimed_at = 0")
            .execute(db)
            .await
            .expect("expire lease");
        assert_eq!(resume_purges(&state).await.expect("resume"), 1);
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM messages WHERE author = 'bob'").await,
            0
        );
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM messages WHERE fwd_author = 'bob'").await,
            0
        );
        let kept = load_message(db, copy.id, Quotes::Skip)
            .await
            .expect("load")
            .expect("the copy stays");
        assert_eq!(kept.content, "bob wrote this");
        assert_eq!(kept.reply_count, 1);
        assert!(
            load_message(db, reply.id, Quotes::Skip)
                .await
                .expect("load")
                .is_some(),
            "thread replies to the copy stay"
        );
        let _ = reg(&state, "bob").await.expect("name free after the purge");
        assert_eq!(
            author_of(copy.id).await,
            None,
            "a new account with the name never inherits the forward"
        );
        assert_eq!(author_of(again.id).await, None);
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
    async fn feature_switches_change_live_and_settings_changed_carries_them() {
        let (state, path) = temp_state("feature_switches").await;
        let mut rx = state.hub.subscribe();
        let root = || Authed(crate::api::test_util::mem_user("root", true));
        let patch = |body: serde_json::Value| -> SettingsPatch {
            serde_json::from_value(body).expect("patch")
        };
        let fresh = get_settings(State(state.clone())).await.0;
        let wire = serde_json::to_value(fresh).expect("json");
        for f in Feature::ALL {
            assert_eq!(fresh.on(f), f.default_on(), "{f:?}");
            assert_eq!(wire[f.key()], json!(f.default_on()), "{f:?}");
        }
        assert_eq!(wire["registration"], json!("open"));

        let mut flipped = serde_json::Map::new();
        for f in Feature::ALL {
            flipped.insert(f.key().to_string(), json!(!f.default_on()));
        }
        flipped.insert("registration".to_string(), json!("sso"));
        let flipped = serde_json::Value::Object(flipped);
        let refused = patch_settings(
            State(state.clone()),
            Authed(crate::api::test_util::mem_user("alice", false)),
            Json(patch(flipped.clone())),
        )
        .await;
        assert!(matches!(refused, Err(ApiError(StatusCode::NOT_FOUND, ref m)) if m == "Not found"));
        assert!(rx.try_recv().is_err(), "a refused patch sends nothing");
        let got = patch_settings(State(state.clone()), root(), Json(patch(flipped)))
            .await
            .expect("patch")
            .0;
        let event = match rx.try_recv().expect("settings_changed") {
            ev @ WsEvent::SettingsChanged { settings: _ } => {
                serde_json::to_value(ev).expect("json")
            }
            _ => panic!("expected settings_changed"),
        };
        assert_eq!(event["type"], json!("settings_changed"));
        Settings::forget(&state.db);
        let stored = Settings::load(&state.db).await;
        for (what, s) in [("response", got), ("stored", stored)] {
            for f in Feature::ALL {
                assert_eq!(s.on(f), !f.default_on(), "{what} {f:?}");
            }
            assert_eq!(s.registration, Registration::Sso, "{what}");
        }
        for f in Feature::ALL {
            assert_eq!(event["settings"][f.key()], json!(!f.default_on()), "{f:?}");
        }
        assert_eq!(event["settings"]["registration"], json!("sso"));

        let one = patch_settings(
            State(state.clone()),
            root(),
            Json(patch(json!({"p2p": true, "registration": "closed"}))),
        )
        .await
        .expect("one switch")
        .0;
        assert!(one.p2p && one.registration == Registration::Closed);
        assert!(!one.server_reports && one.e2ee, "the others stay");
        assert!(
            serde_json::from_value::<SettingsPatch>(json!({"registration": "invite"})).is_err()
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn page_changes_are_audited_with_the_old_and_new_value() {
        let (state, path) = temp_state("settings_audit").await;
        let root = || Authed(crate::api::test_util::mem_user("root", true));
        let patch = |body: serde_json::Value| -> Json<SettingsPatch> {
            Json(serde_json::from_value(body).expect("patch"))
        };
        let audit = || async {
            let rows =
                sqlx::query("SELECT actor, action, target, detail FROM instance_audit ORDER BY id")
                    .fetch_all(&state.db)
                    .await
                    .expect("audit");
            rows.iter()
                .map(|r| {
                    let detail: String = r.try_get(3).expect("detail");
                    json!({
                        "actor": r.try_get::<Option<String>, _>(0).expect("actor"),
                        "action": r.try_get::<String, _>(1).expect("action"),
                        "target": r.try_get::<Option<String>, _>(2).expect("target"),
                        "detail": serde_json::from_str::<serde_json::Value>(&detail).expect("json"),
                    })
                })
                .collect::<Vec<_>>()
        };
        let refused = patch_settings(
            State(state.clone()),
            Authed(crate::api::test_util::mem_user("alice", false)),
            patch(json!({"p2p": false})),
        )
        .await;
        assert!(refused.is_err());
        assert_eq!(audit().await, Vec::<serde_json::Value>::new());

        let _ = patch_settings(
            State(state.clone()),
            root(),
            patch(json!({
                "p2p": false,
                "e2ee": false,
                "registration": "closed",
                "profanity_targets": {"bios": false, "links": true},
            })),
        )
        .await
        .expect("patch");
        let row = |key: &str, from: &str, to: &str| {
            json!({
                "actor": "root",
                "action": "settings.change",
                "target": key,
                "detail": {"key": key, "from": from, "to": to},
            })
        };
        assert_eq!(
            audit().await,
            [
                row(
                    "profanity_targets",
                    "all",
                    "messages,links,usernames,server_names,channel_names,role_names,file_names,channel_topics,category_names"
                ),
                row("p2p", "on", "off"),
                row("registration", "open", "closed"),
            ],
            "one row per control that changed, none for e2ee, which stayed off"
        );
        let _ = patch_settings(State(state.clone()), root(), patch(json!({"p2p": false})))
            .await
            .expect("the same value");
        assert_eq!(audit().await.len(), 3, "no change, no row");
        let text = serde_json::to_string(&audit().await).expect("text");
        assert!(text.is_ascii());

        crate::api::instance_audit::record(
            &state.db,
            "root",
            "settings.config",
            Some("p2p"),
            json!({"key": "p2p", "from": "off", "to": "on", "by": "config"}),
        )
        .await
        .expect("a row an account made");
        let mut conn = state.db.acquire().await.expect("conn");
        crate::api::instance_audit::forget_user(&mut conn, "root")
            .await
            .expect("the account is deleted");
        crate::api::instance_audit::record_config(
            &mut conn,
            "settings.config",
            Some("p2p"),
            json!({"key": "p2p", "from": "on", "to": "off"}),
            now(),
        )
        .await
        .expect("a row the server config made");
        drop(conn);
        let rows = audit().await;
        let (config, deleted) = rows.split_last().expect("rows");
        assert_eq!(deleted.len(), 4);
        for row in deleted {
            assert!(row["actor"].is_null(), "{row}");
            assert!(
                row["detail"].get("by").is_none(),
                "a deleted account's row never carries the config mark: {row}"
            );
        }
        assert_eq!(
            config,
            &json!({
                "actor": null,
                "action": "settings.config",
                "target": "p2p",
                "detail": {"key": "p2p", "from": "on", "to": "off", "by": "config"},
            })
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn deleting_a_server_or_an_account_cleans_the_reports() {
        let (state, path) = temp_state("reports_cleanup").await;
        let db = &state.db;
        let _ = reg(&state, "bob").await.expect("bob");
        let _ = reg(&state, "carol").await.expect("carol");
        sqlx::query("INSERT INTO servers(name, display_name, creator, created_at) VALUES('club', 'Club', 'bob', 1)")
            .execute(db)
            .await
            .expect("server");
        for kind in ["server", "instance"] {
            sqlx::query("INSERT INTO reports(kind, server, server_name, target_kind, target_key, target_user, reporter, form, form_label, reason, snapshot, created_at, updated_at) VALUES($1, 'club', 'Club', 'user', 'u:carol', 'carol', 'bob', 'user', 'Report a user', 'spam', '{\"user\": {\"username\": \"carol\"}}', 5, 5)")
                .bind(kind)
                .execute(db)
                .await
                .expect("report");
        }
        let root = || Authed(crate::api::test_util::mem_user("root", true));
        let _ = delete_server(State(state.clone()), root(), Path("club".to_string()))
            .await
            .expect("delete the server");
        settle(db).await;
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM reports WHERE kind = 'server'").await,
            0,
            "reports to the server's moderators go with the server"
        );
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM reports WHERE kind = 'instance' AND server IS NULL AND server_name = 'Club' AND reporter = 'bob' AND target_user = 'carol'").await,
            1,
            "reports to the instance stay"
        );
        for name in ["bob", "carol"] {
            let _ = delete_user(State(state.clone()), root(), Path(name.to_string()))
                .await
                .expect("delete the account");
            settle(db).await;
        }
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM reports WHERE reporter IS NULL AND target_user IS NULL AND target_key LIKE 'd:%' AND snapshot NOT LIKE '%carol%'").await,
            1,
            "and name neither the reporter nor the reported account any more"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn the_admin_saves_the_report_forms() {
        use crate::api::reports::forms::{ReportForms, get_forms};
        use axum::http::{HeaderMap, header};
        let (state, path) = temp_state("report_forms_put").await;
        let mut rx = state.hub.subscribe();
        let root = || Authed(crate::api::test_util::mem_user("root", true));
        let alice = || Authed(crate::api::test_util::mem_user("alice", false));
        let body = |doc: &serde_json::Value| -> Json<ReportFormsReq> {
            Json(serde_json::from_value(doc.clone()).expect("body"))
        };
        let public = || async {
            let res = get_forms(State(state.clone()), alice(), HeaderMap::new())
                .await
                .expect("forms");
            let etag = res.headers()[header::ETAG]
                .to_str()
                .expect("etag")
                .to_string();
            let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
                .await
                .expect("body");
            let doc: serde_json::Value = serde_json::from_slice(&bytes).expect("json");
            let ids: Vec<String> = doc["forms"]
                .as_array()
                .expect("forms")
                .iter()
                .map(|f| f["id"].as_str().expect("id").to_string())
                .collect();
            (etag, ids)
        };
        let audit = || async { audit_rows(&state.db).await };

        for refused in [
            get_report_forms(State(state.clone()), alice())
                .await
                .map(|_| ()),
            put_report_forms(
                State(state.clone()),
                alice(),
                body(&serde_json::to_value(ReportForms::defaults()).expect("json")),
            )
            .await
            .map(|_| ()),
        ] {
            assert!(
                matches!(refused, Err(ApiError(StatusCode::NOT_FOUND, ref m)) if m == "Not found"),
                "the same answer as any unknown path"
            );
        }
        let before = get_report_forms(State(state.clone()), root())
            .await
            .expect("forms")
            .0;
        assert_eq!(before, ReportForms::defaults());
        assert_eq!(public().await.0, "\"1\"");

        let mut doc = serde_json::to_value(&before).expect("json");
        let same = put_report_forms(State(state.clone()), root(), body(&doc))
            .await
            .expect("the same forms")
            .0;
        assert_eq!(same.rev, 1, "nothing changed");
        assert!(audit().await.is_empty() && rx.try_recv().is_err());

        doc["forms"][1]["enabled"] = json!(false);
        doc["forms"].as_array_mut().expect("forms").push(json!({
            "id": "appeal",
            "label": "Appeal a ban",
            "line": "Ask for another look.",
            "base": "none",
            "fields": [{"id": "why", "kind": "long_text", "label": "Why", "required": true}],
        }));
        let saved = put_report_forms(State(state.clone()), root(), body(&doc))
            .await
            .expect("saved")
            .0;
        assert_eq!((saved.rev, saved.forms.len()), (2, 6));
        assert!(matches!(
            rx.try_recv(),
            Ok(WsEvent::SettingsChanged { settings: _ })
        ));
        assert_eq!(
            audit().await,
            [(
                Some("root".to_string()),
                "report_forms.change".to_string(),
                None,
                json!({"rev": 2}).to_string()
            )]
        );
        let (etag, ids) = public().await;
        assert_eq!(etag, "\"2\"", "the ETag follows the revision");
        assert_eq!(
            ids,
            ["user", "server", "general", "message", "appeal"],
            "a turned-off category is not in the public read"
        );
        let whole = get_report_forms(State(state.clone()), root())
            .await
            .expect("forms")
            .0;
        assert_eq!(whole, saved);
        assert!(!whole.forms[1].enabled, "the admin reads it");

        let stale = put_report_forms(State(state.clone()), root(), body(&doc)).await;
        assert!(
            matches!(stale, Err(ApiError(StatusCode::CONFLICT, ref m)) if m == "The forms changed. Load them again"),
            "an editor that loaded rev 1: {stale:?}"
        );
        assert_eq!(audit().await.len(), 1);
        doc["rev"] = json!(2);

        doc["forms"][5]["fields"][0]["max"] = json!(2001);
        let refused = put_report_forms(State(state.clone()), root(), body(&doc)).await;
        assert!(
            matches!(refused, Err(ApiError(StatusCode::BAD_REQUEST, ref m)) if m == "appeal.why: max must be 1 to 2000"),
            "{refused:?}"
        );
        assert_eq!(audit().await.len(), 1);
        assert_eq!(public().await.0, "\"2\"");

        doc["forms"][5]["fields"][0]["max"] = json!(500);
        let unchecked = json!({"forms": doc["forms"].clone()});
        let saved = put_report_forms(State(state.clone()), root(), body(&unchecked))
            .await
            .expect("no rev, no check")
            .0;
        assert_eq!(saved.rev, 3);

        sqlx::query("INSERT INTO settings(key, value) VALUES('env:pinned', 'p2p,report_forms')")
            .execute(&state.db)
            .await
            .expect("pinned by the server config");
        doc["rev"] = json!(3);
        doc["forms"][5]["fields"][0]["max"] = json!(400);
        let refused = put_report_forms(State(state.clone()), root(), body(&doc)).await;
        assert!(
            matches!(refused, Err(ApiError(StatusCode::BAD_REQUEST, ref m)) if m == "Set in the server config: REPORT_FORMS_FILE"),
            "{refused:?}"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_pinned_control_is_refused_with_its_env_name() {
        let env = [
            ("FEATURE_P2P", "off"),
            ("PROFANITY_TARGETS", "messages"),
            ("E2EE", "on"),
            ("SETTINGS_PINNED", "FEATURE_P2P,PROFANITY_TARGETS"),
        ];
        let (state, path) = crate::api::test_util::temp_state_env("pinned_patch", &env).await;
        let mut rx = state.hub.subscribe();
        let root = || Authed(crate::api::test_util::mem_user("root", true));
        let patch = |body: serde_json::Value| -> Json<SettingsPatch> {
            Json(serde_json::from_value(body).expect("patch"))
        };
        for (body, env) in [
            (json!({"p2p": true}), "FEATURE_P2P"),
            (json!({"e2ee": false, "p2p": false}), "FEATURE_P2P"),
            (
                json!({"e2ee": false, "profanity_targets": {"bios": true}}),
                "PROFANITY_TARGETS",
            ),
        ] {
            let refused = patch_settings(State(state.clone()), root(), patch(body.clone())).await;
            let want = format!("Set in the server config: {env}");
            assert!(
                matches!(refused, Err(ApiError(StatusCode::BAD_REQUEST, ref m)) if *m == want),
                "{body}"
            );
        }
        assert!(rx.try_recv().is_err(), "a refused patch sends nothing");
        Settings::forget(&state.db);
        let kept = Settings::load(&state.db).await;
        assert!(!kept.p2p && kept.e2ee && !kept.profanity_targets.bios);
        assert!(kept.profanity_targets.messages, "nothing was written");

        let got = patch_settings(
            State(state.clone()),
            root(),
            patch(json!({"e2ee": false, "profanity_filter": false})),
        )
        .await
        .expect("unpinned controls change")
        .0;
        assert!(!got.e2ee && !got.profanity_filter && !got.p2p);
        assert!(matches!(
            rx.try_recv(),
            Ok(WsEvent::SettingsChanged { settings: _ })
        ));

        sqlx::query("UPDATE settings SET value = 'p2p,e2ee' WHERE key = 'env:pinned'")
            .execute(&state.db)
            .await
            .expect("the newest start pins another one");
        let refused =
            patch_settings(State(state.clone()), root(), patch(json!({"e2ee": true}))).await;
        assert!(
            matches!(refused, Err(ApiError(StatusCode::BAD_REQUEST, ref m)) if m == "Set in the server config: E2EE"),
            "every copy reads the stored pins"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn the_upload_cap_follows_pins_and_is_audited_like_every_control() {
        let root = || Authed(crate::api::test_util::mem_user("root", true));
        let patch = |body: serde_json::Value| -> Json<SettingsPatch> {
            Json(serde_json::from_value(body).expect("patch"))
        };
        let pinned = [
            ("UPLOAD_EXPIRY_MAX_DAYS", "30"),
            ("SETTINGS_PINNED", "UPLOAD_EXPIRY_MAX_DAYS"),
        ];
        let (state, path) = crate::api::test_util::temp_state_env("cap_pinned", &pinned).await;
        assert_eq!(
            Settings::load(&state.db).await.upload_expiry_max_days,
            30,
            "the env sets it"
        );
        let refused = patch_settings(
            State(state.clone()),
            root(),
            patch(json!({"upload_expiry_max_days": 7})),
        )
        .await;
        assert!(
            matches!(refused, Err(ApiError(StatusCode::BAD_REQUEST, ref m)) if m == "Set in the server config: UPLOAD_EXPIRY_MAX_DAYS")
        );
        Settings::forget(&state.db);
        assert_eq!(Settings::load(&state.db).await.upload_expiry_max_days, 30);
        done(state, path).await;

        let (state, path) = temp_state("cap_audit").await;
        let got = patch_settings(
            State(state.clone()),
            root(),
            patch(json!({"upload_expiry_max_days": 7})),
        )
        .await
        .expect("patch")
        .0;
        assert_eq!(got.upload_expiry_max_days, 7);
        let rows = sqlx::query("SELECT actor, action, target, detail FROM instance_audit")
            .fetch_all(&state.db)
            .await
            .expect("audit");
        assert_eq!(rows.len(), 1);
        assert_eq!(
            (
                rows[0].try_get::<String, _>(0).expect("actor"),
                rows[0].try_get::<String, _>(1).expect("action"),
                rows[0].try_get::<String, _>(2).expect("target"),
                rows[0].try_get::<String, _>(3).expect("detail"),
            ),
            (
                "root".to_string(),
                "settings.change".to_string(),
                "upload_expiry_max_days".to_string(),
                json!({"key": "upload_expiry_max_days", "from": "0", "to": "7"}).to_string(),
            )
        );
        let view = get_config(State(state.clone()), root())
            .await
            .expect("config")
            .0;
        let view = serde_json::to_value(view).expect("json");
        let row = view["controls"]
            .as_array()
            .expect("controls")
            .iter()
            .find(|c| c["key"] == "upload_expiry_max_days")
            .expect("listed")
            .clone();
        assert_eq!(
            row,
            json!({"key": "upload_expiry_max_days", "env": "UPLOAD_EXPIRY_MAX_DAYS", "value": "7", "config": null, "pinned": false})
        );
        Settings::forget(&state.db);
        done(state, path).await;
    }

    #[tokio::test]
    async fn the_config_view_lists_controls_and_limits_for_the_admin_only() {
        use crate::api::controls::Control;
        use crate::limits::Limits;
        let env = [
            ("FEATURE_P2P", "off"),
            ("AUTH_REGISTRATION", "closed"),
            ("PROFANITY_TARGETS", "messages,links"),
            ("SETTINGS_PINNED", "FEATURE_P2P"),
            ("PASSWORD_PEPPER", "pepper-in-env"),
            ("RELAY_SECRET", "relay-in-env"),
        ];
        let (state, path) = crate::api::test_util::temp_state_env("config_view", &env).await;
        let state = state.with_limits(std::sync::Arc::new(Limits {
            upload_max_mib: 100,
            database_max_connections: Some(4),
            ..Limits::default()
        }));
        let root = || Authed(crate::api::test_util::mem_user("root", true));
        let refused = get_config(
            State(state.clone()),
            Authed(crate::api::test_util::mem_user("alice", false)),
        )
        .await;
        assert!(
            matches!(refused, Err(ApiError(StatusCode::NOT_FOUND, ref m)) if m == "Not found"),
            "the same answer as any unknown path"
        );
        let patch: SettingsPatch =
            serde_json::from_value(json!({"registration": "sso"})).expect("patch");
        let _ = patch_settings(State(state.clone()), root(), Json(patch))
            .await
            .expect("page change");

        let view = get_config(State(state.clone()), root())
            .await
            .expect("config")
            .0;
        let view = serde_json::to_value(view).expect("json");
        let controls = view["controls"].as_array().expect("controls");
        let listed: Vec<(&str, &str)> = controls
            .iter()
            .map(|c| {
                (
                    c["key"].as_str().expect("key"),
                    c["env"].as_str().expect("env"),
                )
            })
            .collect();
        let all: Vec<(&str, &str)> = Control::all().iter().map(|c| (c.key, c.env)).collect();
        assert_eq!(listed, all, "every control, in order");
        let control = |key: &str| {
            controls
                .iter()
                .find(|c| c["key"] == key)
                .unwrap_or_else(|| panic!("{key} is listed"))
                .clone()
        };
        assert_eq!(
            control("p2p"),
            json!({"key": "p2p", "env": "FEATURE_P2P", "value": "off", "config": "off", "pinned": true})
        );
        assert_eq!(
            control("registration"),
            json!({"key": "registration", "env": "AUTH_REGISTRATION", "value": "sso", "config": "closed", "pinned": false})
        );
        assert_eq!(
            control("sfu"),
            json!({"key": "sfu", "env": "FEATURE_SFU", "value": "off", "config": null, "pinned": false})
        );
        assert_eq!(
            control("profanity_targets"),
            json!({"key": "profanity_targets", "env": "PROFANITY_TARGETS", "value": "messages,links", "config": "messages,links", "pinned": false})
        );

        let limits = view["limits"].as_array().expect("limits");
        assert_eq!(limits.len(), Limits::default().rows().len());
        let limit = |env: &str| {
            limits
                .iter()
                .find(|l| l["env"] == env)
                .unwrap_or_else(|| panic!("{env} is listed"))
                .clone()
        };
        assert_eq!(
            limit("UPLOAD_MAX_MIB"),
            json!({"env": "UPLOAD_MAX_MIB", "value": 100, "default": 25, "range": "1-512"})
        );
        assert_eq!(
            limit("DATABASE_MAX_CONNECTIONS"),
            json!({"env": "DATABASE_MAX_CONNECTIONS", "value": 4, "default": null, "range": "1-1000"})
        );

        let text = view.to_string();
        assert!(text.is_ascii());
        let lower = text.to_lowercase();
        for secret in [
            "pepper",
            "secret",
            "signing",
            "token",
            "database_url",
            "redis_url",
            "s3_",
            "relay-in-env",
        ] {
            assert!(!lower.contains(secret), "{secret} is never listed");
        }
        for key in [
            "password_pepper",
            "relay_secret",
            "p2p_secret",
            "instance_signing_key",
        ] {
            let value: String = sqlx::query("SELECT value FROM settings WHERE key = $1")
                .bind(key)
                .fetch_one(&state.db)
                .await
                .expect(key)
                .try_get(0)
                .expect("value");
            assert!(!value.is_empty() && !text.contains(&value), "{key}");
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_change_on_one_copy_reaches_the_other_before_the_ttl() {
        use crate::instance::{Instance, InstanceConfig};
        let bus = crate::hub::tests::MemBus::new();
        let path = crate::db::temp_db_path("settings_bus");
        let wipe = || {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
            }
        };
        wipe();
        let a_db = crate::db::open_started(Some(&format!("sqlite://{}?mode=rwc", path.display())))
            .await
            .expect("one copy");
        let b_db = crate::db::open_started(Some(&format!("sqlite://{}?mode=rw", path.display())))
            .await
            .expect("another copy");
        assert_ne!(
            crate::db::pool_key(&a_db),
            crate::db::pool_key(&b_db),
            "each copy has its own cache"
        );
        let instance = Instance::load(&a_db, &InstanceConfig::default())
            .await
            .expect("instance");
        let a = AppState::new(a_db, bus.join(), None, None, instance.clone());
        let b = AppState::new(b_db, bus.join(), None, None, instance);
        Settings::follow(&a);
        Settings::follow(&b);
        assert!(Settings::cached(&b.db).await.p2p);
        let started = std::time::Instant::now();
        let patch: SettingsPatch =
            serde_json::from_value(json!({"p2p": false, "registration": "closed"})).expect("patch");
        let _ = patch_settings(
            State(a.clone()),
            Authed(crate::api::test_util::mem_user("root", true)),
            Json(patch),
        )
        .await
        .expect("patch");
        let mut seen = Settings::cached(&b.db).await;
        while seen.p2p && started.elapsed() < Duration::from_secs(2) {
            tokio::time::sleep(Duration::from_millis(10)).await;
            seen = Settings::cached(&b.db).await;
        }
        assert!(
            !seen.p2p && seen.registration == Registration::Closed,
            "the other copy follows settings_changed inside the 5 s cache time"
        );
        crate::db::close(&a.db).await;
        crate::db::close(&b.db).await;
        wipe();
    }

    #[tokio::test]
    async fn a_deleted_account_leaves_the_list_of_server_creators() {
        use crate::api::policy::{Creator, Policy, effective};
        use crate::api::servers::{CreateServerReq, create_server};
        let (state, path) = temp_state("creators_forget").await;
        let db = &state.db;
        for name in ["root", "bob", "carol", "dave"] {
            let _ = reg(&state, name).await.expect(name);
        }
        let patch: SettingsPatch = serde_json::from_value(json!({
            "server_creation": "some",
            "server_creators": ["Bob", "carol", "lobby:Staff", "bob:Staff", "dave"],
        }))
        .expect("patch");
        let _ = patch_settings(State(state.clone()), authed(db, "root").await, Json(patch))
            .await
            .expect("some people");
        let may = |name: &'static str| async move {
            let user = get_user(db, name).await.expect("user").expect("exists");
            effective(db, Some(&user))
                .await
                .can_create_servers()
                .await
                .expect("effective")
        };
        let stored = || async {
            sqlx::query("SELECT value FROM settings WHERE key = 'server_creators'")
                .fetch_one(db)
                .await
                .expect("row")
                .try_get::<String, _>(0)
                .expect("value")
        };
        assert!(may("bob").await && may("carol").await);
        assert!(!may("root").await, "the admin is not on the list");

        let _ = delete_user(
            State(state.clone()),
            authed(db, "root").await,
            Path("Bob".to_string()),
        )
        .await
        .expect("delete bob");
        settle(db).await;
        assert_eq!(
            stored().await,
            "carol,lobby:Staff,bob:Staff,dave",
            "the account's entry is gone, the role entries stay"
        );
        assert!(
            !Policy::cached(db)
                .await
                .server_creators
                .contains(&Creator::User("bob".to_string())),
            "this copy forgets it at once"
        );

        let _ = reg(&state, "bob")
            .await
            .expect("someone takes the freed name");
        assert!(!may("bob").await, "the newcomer got nothing from the name");
        let req: CreateServerReq = serde_json::from_value(json!({"name": "Mine"})).expect("req");
        let refused = create_server(State(state.clone()), authed(db, "bob").await, Json(req)).await;
        assert!(matches!(refused, Err(ApiError(StatusCode::NOT_FOUND, ref m)) if m == "Not found"));
        assert!(may("carol").await && may("dave").await, "the others stay");

        let _ = ban_user(
            State(state.clone()),
            authed(db, "root").await,
            Json(BanReq {
                username: "carol".to_string(),
            }),
        )
        .await
        .expect("ban carol");
        settle(db).await;
        assert_eq!(
            stored().await,
            "lobby:Staff,bob:Staff,dave",
            "a ban does the same"
        );
        assert!(may("dave").await);
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_renamed_or_deleted_server_takes_its_role_entries_along() {
        use crate::api::policy::effective;
        use crate::api::servers::{CreateServerReq, ServerPatch, create_server, update_server};
        let (state, path) = temp_state("creators_server_gone").await;
        let db = &state.db;
        for name in ["root", "alice", "carol", "dave"] {
            let _ = reg(&state, name).await.expect(name);
        }
        for (owner, name) in [("alice", "Lobby"), ("dave", "Den")] {
            let req: CreateServerReq =
                serde_json::from_value(json!({ "name": name })).expect("req");
            let _ = create_server(State(state.clone()), authed(db, owner).await, Json(req))
                .await
                .expect("create");
        }
        let staff = |server: &'static str, who: &'static str| async move {
            sqlx::query("INSERT INTO roles(server, name, color) VALUES($1, 'Staff', '#000000')")
                .bind(server)
                .execute(db)
                .await
                .expect("role");
            sqlx::query("INSERT INTO members(server, username, joined_at) VALUES($1, $2, 0) ON CONFLICT(server, username) DO NOTHING")
                .bind(server)
                .bind(who)
                .execute(db)
                .await
                .expect("member");
            sqlx::query("INSERT INTO user_roles(server, username, role_id) SELECT $1, $2, id FROM roles WHERE server = $1 AND name = 'Staff' ON CONFLICT(server, username, role_id) DO NOTHING")
                .bind(server)
                .bind(who)
                .execute(db)
                .await
                .expect("holds it");
        };
        staff("lobby", "carol").await;
        let patch: SettingsPatch = serde_json::from_value(json!({
            "server_creation": "some",
            "server_creators": ["Lobby:Staff", "lobby:Later", "alice", "lobby"],
        }))
        .expect("patch");
        let _ = patch_settings(State(state.clone()), authed(db, "root").await, Json(patch))
            .await
            .expect("some people");
        let may = |name: &'static str| async move {
            let user = get_user(db, name).await.expect("user").expect("exists");
            effective(db, Some(&user))
                .await
                .can_create_servers()
                .await
                .expect("effective")
        };
        let stored = || async {
            sqlx::query("SELECT value FROM settings WHERE key = 'server_creators'")
                .fetch_one(db)
                .await
                .expect("row")
                .try_get::<String, _>(0)
                .expect("value")
        };
        let rename = async |by: &str, server: &str, name: &str| {
            let patch: ServerPatch = serde_json::from_value(json!({ "name": name })).expect("req");
            update_server(
                State(state.clone()),
                authed(db, by).await,
                Path(server.to_string()),
                Json(patch),
            )
            .await
            .map(|_| ())
        };
        assert!(may("carol").await && !may("dave").await);

        rename("alice", "lobby", "Lounge").await.expect("rename");
        assert_eq!(
            stored().await,
            "lounge:Staff,lounge:Later,alice,lobby",
            "its role entries follow the server; the account named lobby is not one"
        );
        assert!(may("carol").await, "the same people keep the grant");
        rename("dave", "den", "Lobby")
            .await
            .expect("the freed name is taken");
        staff("lobby", "dave").await;
        assert!(!may("dave").await, "the old name gives nothing");

        let _ = delete_server(
            State(state.clone()),
            authed(db, "root").await,
            Path("lounge".to_string()),
        )
        .await
        .expect("delete");
        settle(db).await;
        assert_eq!(
            stored().await,
            "alice,lobby",
            "a deleted server's entries go"
        );
        assert!(!may("carol").await);
        rename("dave", "lobby", "Lounge")
            .await
            .expect("that name too");
        staff("lounge", "dave").await;
        assert!(!may("dave").await);
        assert!(may("alice").await, "accounts on the list stay");
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_deleted_account_leaves_the_details_of_the_instance_audit() {
        let (state, path) = temp_state("audit_details_forget").await;
        let db = &state.db;
        for name in ["root", "bob", "dave"] {
            let _ = reg(&state, name).await.expect(name);
        }
        let set = |body: serde_json::Value| async {
            let patch: SettingsPatch = serde_json::from_value(body).expect("patch");
            let _ = patch_settings(State(state.clone()), authed(db, "root").await, Json(patch))
                .await
                .expect("patch");
        };
        set(json!({"server_creators": ["bob", "Dave", "lobby:dave"]})).await;
        set(json!({"server_creators": ["dave"]})).await;
        for (name, owner) in [("Club", "dave"), ("Den", "bob")] {
            let req: AdminServerReq =
                serde_json::from_value(json!({"name": name, "owner": owner})).expect("req");
            let _ = create_server_for(State(state.clone()), authed(db, "root").await, Json(req))
                .await
                .expect("create");
        }
        let mut conn = db.acquire().await.expect("conn");
        crate::api::instance_audit::record_config(
            &mut conn,
            "settings.config",
            Some("server_creators"),
            json!({"key": "server_creators", "from": "dave", "to": "dave,bob"}),
            now(),
        )
        .await
        .expect("a start changed the list");
        drop(conn);

        let _ = delete_user(
            State(state.clone()),
            authed(db, "root").await,
            Path("dave".to_string()),
        )
        .await
        .expect("delete dave");
        settle(db).await;
        let details: Vec<(String, Option<String>, serde_json::Value)> = audit_rows(db)
            .await
            .into_iter()
            .map(|(_, action, target, detail)| {
                (action, target, serde_json::from_str(&detail).expect("json"))
            })
            .collect();
        assert_eq!(
            details,
            [
                (
                    "settings.change".to_string(),
                    Some("server_creators".to_string()),
                    json!({"key": "server_creators", "from": "", "to": "bob,lobby:dave"}),
                ),
                (
                    "settings.change".to_string(),
                    Some("server_creators".to_string()),
                    json!({"key": "server_creators", "from": "bob,lobby:dave", "to": ""}),
                ),
                (
                    "server.create".to_string(),
                    Some("club".to_string()),
                    json!({"owner": null}),
                ),
                (
                    "server.create".to_string(),
                    Some("den".to_string()),
                    json!({"owner": "bob"}),
                ),
                (
                    "settings.config".to_string(),
                    Some("server_creators".to_string()),
                    json!({"key": "server_creators", "from": "", "to": "bob", "by": "config"}),
                ),
            ],
            "the deleted name is gone from the lists and as an owner; the rest stays"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn the_admin_creates_a_server_for_an_owner_whatever_the_switch_says() {
        use crate::api::access::perms::ALL_PERMS;
        let (state, path) = temp_state("admin_create_server").await;
        let db = &state.db;
        for name in ["bob", "root"] {
            crate::db::NewUser::plain(name)
                .admin(name == "root")
                .add(db)
                .await;
        }
        let root = || Authed(crate::api::test_util::mem_user("root", true));
        let req = |body: serde_json::Value| -> Json<AdminServerReq> {
            Json(serde_json::from_value(body).expect("req"))
        };
        let patch: SettingsPatch =
            serde_json::from_value(json!({"server_creation": "nobody"})).expect("patch");
        let _ = patch_settings(State(state.clone()), root(), Json(patch))
            .await
            .expect("creation off");
        let refused = create_server_for(
            State(state.clone()),
            Authed(crate::api::test_util::mem_user("bob", false)),
            req(json!({"name": "Club", "owner": "bob"})),
        )
        .await;
        assert!(
            matches!(refused, Err(ApiError(StatusCode::NOT_FOUND, ref m)) if m == "Not found"),
            "only the site admin, and the same 404 as an unknown path"
        );
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM servers WHERE name = 'club'").await,
            0
        );

        let mut rx = state.hub.subscribe();
        let detail = create_server_for(
            State(state.clone()),
            root(),
            req(json!({"name": " Club ", "owner": "Bob"})),
        )
        .await
        .expect("create")
        .0;
        assert_eq!(
            (detail.name.as_str(), detail.display_name.as_str()),
            ("club", "Club")
        );
        assert_eq!(detail.creator, None);
        assert_eq!(detail.member_count, 1);
        assert_eq!(detail.channels.len(), 1);
        let row = sqlx::query("SELECT is_admin, perms, joined_via FROM members WHERE server = 'club' AND username = 'bob'")
            .fetch_one(db)
            .await
            .expect("the owner is a member");
        assert_eq!(
            (
                row.try_get::<i64, _>(0).expect("is_admin"),
                row.try_get::<i64, _>(1).expect("perms"),
                row.try_get::<Option<i64>, _>(2).expect("joined_via"),
            ),
            (1, ALL_PERMS, None),
            "an admin with every permission"
        );
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM servers WHERE name = 'club' AND creator IS NULL AND password_hash IS NULL AND member_count = 1").await,
            1
        );
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM members WHERE server = 'club'").await,
            1
        );
        let events = drained(&mut rx);
        assert!(
            events.iter().any(|ev| matches!(ev, WsEvent::ServerCreated { server } if server.name == "club" && server.creator.is_none())),
            "server_created without a creator"
        );
        assert!(
            events.iter().any(|ev| matches!(ev, WsEvent::MemberJoined { server, member } if server == "club" && member.user.username == "bob")),
            "the owner's apps hear member_joined"
        );
        let audit = sqlx::query(
            "SELECT actor, target, detail FROM instance_audit WHERE action = 'server.create'",
        )
        .fetch_all(db)
        .await
        .expect("audit");
        assert_eq!(audit.len(), 1);
        assert_eq!(
            (
                audit[0].try_get::<String, _>(0).expect("actor"),
                audit[0].try_get::<String, _>(1).expect("target"),
                audit[0].try_get::<String, _>(2).expect("detail"),
            ),
            (
                "root".to_string(),
                "club".to_string(),
                json!({"owner": "bob"}).to_string()
            )
        );

        let own = create_server_for(
            State(state.clone()),
            root(),
            req(json!({"name": "Vault", "owner": "root", "password": "long enough"})),
        )
        .await
        .expect("the admin as owner, with a password")
        .0;
        assert_eq!(own.creator, None);
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM servers WHERE name = 'vault' AND creator IS NULL AND password_hash IS NOT NULL").await,
            1
        );
        for (body, error) in [
            (
                json!({"name": "Club", "owner": "bob"}),
                "Server name is taken",
            ),
            (json!({"name": "  ", "owner": "bob"}), "Name required"),
            (
                json!({"name": "Other", "owner": "nobody"}),
                "No such account",
            ),
            (
                json!({"name": "Other", "owner": "bob", "password": "short"}),
                "Use at least 8 characters, or leave it blank for a generated one",
            ),
        ] {
            let refused = create_server_for(State(state.clone()), root(), req(body.clone())).await;
            assert!(
                matches!(refused, Err(ApiError(StatusCode::BAD_REQUEST, ref m)) if m == error),
                "{body}: {:?}",
                refused.err().map(|ApiError(_, m)| m)
            );
        }
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM servers WHERE name = 'other'").await,
            0
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn only_a_site_admin_turns_other_instances_off_and_clients_hear_it() {
        const KEY: &str = "client_other_instances";
        let (state, path) = temp_state("other_instances_switch").await;
        let mut rx = state.hub.subscribe();
        let root = || Authed(crate::api::test_util::mem_user("root", true));
        let patch = |on: bool| -> Json<SettingsPatch> {
            Json(serde_json::from_value(json!({ KEY: on })).expect("patch"))
        };
        let sent = |s: Settings| serde_json::to_value(s).expect("json")[KEY].clone();
        assert_eq!(
            sent(get_settings(State(state.clone())).await.0),
            json!(true)
        );

        let refused = patch_settings(
            State(state.clone()),
            Authed(crate::api::test_util::mem_user("alice", false)),
            patch(false),
        )
        .await;
        assert!(matches!(refused, Err(ApiError(StatusCode::NOT_FOUND, ref m)) if m == "Not found"));
        assert!(rx.try_recv().is_err(), "a refused patch sends nothing");
        Settings::forget(&state.db);
        assert_eq!(
            sent(get_settings(State(state.clone())).await.0),
            json!(true)
        );

        for on in [false, true] {
            let got = patch_settings(State(state.clone()), root(), patch(on))
                .await
                .expect("patch")
                .0;
            assert_eq!(sent(got), json!(on));
            for f in Feature::ALL.into_iter().filter(|f| f.key() != KEY) {
                assert_eq!(got.on(f), f.default_on(), "{f:?} stays");
            }
            let event = match rx.try_recv().expect("settings_changed") {
                ev @ WsEvent::SettingsChanged { settings: _ } => {
                    serde_json::to_value(ev).expect("json")
                }
                _ => panic!("expected settings_changed"),
            };
            assert_eq!(event["type"], json!("settings_changed"));
            assert_eq!(event["settings"][KEY], json!(on));
            Settings::forget(&state.db);
            assert_eq!(sent(get_settings(State(state.clone())).await.0), json!(on));
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn admin_lists_walk_by_cursor() {
        let (state, path) = temp_state("admin_cursor").await;
        let db = &state.db;
        for n in 0..57 {
            crate::db::NewUser::plain(&format!("user{n:02}"))
                .add(db)
                .await;
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

    async fn audit_rows(db: &Db) -> Vec<(Option<String>, String, Option<String>, String)> {
        sqlx::query("SELECT actor, action, target, detail FROM instance_audit ORDER BY id")
            .fetch_all(db)
            .await
            .expect("audit")
            .iter()
            .map(|r| {
                (
                    r.try_get(0).expect("actor"),
                    r.try_get(1).expect("action"),
                    r.try_get(2).expect("target"),
                    r.try_get(3).expect("detail"),
                )
            })
            .collect()
    }

    async fn authed(db: &Db, name: &str) -> Authed {
        Authed(get_user(db, name).await.expect("load").expect("user"))
    }

    fn phrase_of(user: &User) -> (Option<&str>, Option<i64>) {
        (user.recovery_pub.as_deref(), user.recovery_set_at)
    }

    #[tokio::test]
    async fn the_admin_removes_a_phrase_and_it_is_audited() {
        use crate::api::reauth::Session;
        use crate::api::recovery::{RecoverySet, set_phrase_at};
        use crate::api::test_util::PHRASE_KEY;
        let (state, path) = temp_state("admin_phrase").await;
        let db = &state.db;
        let _ = reg(&state, "root").await.expect("root");
        let bob_token = reg(&state, "bob").await.expect("bob").0.token;
        let _ = reg(&state, "carol").await.expect("carol");
        sqlx::query("UPDATE users SET is_site_admin = 1 WHERE username = 'root'")
            .execute(db)
            .await
            .expect("admin");
        sqlx::query("UPDATE users SET recovery_pub = $1, recovery_set_at = 7, bio = 'hi' WHERE username IN ('bob', 'root')")
            .bind(PHRASE_KEY)
            .execute(db)
            .await
            .expect("phrases");
        let before = get_user(db, "bob").await.expect("load").expect("bob");
        let remove = |who: Authed, name: &str| {
            remove_phrase(State(state.clone()), who, Path(name.to_string()))
        };
        let ApiError(code, msg) = remove(authed(db, "carol").await, "bob")
            .await
            .err()
            .expect("not an admin");
        let ApiError(delete_code, delete_msg) = delete_user(
            State(state.clone()),
            authed(db, "carol").await,
            Path("bob".to_string()),
        )
        .await
        .err()
        .expect("not an admin");
        assert_eq!((code, msg.as_str()), (StatusCode::NOT_FOUND, "Not found"));
        assert_eq!((code, msg), (delete_code, delete_msg));
        let ApiError(code, msg) = remove(authed(db, "carol").await, "nobody")
            .await
            .err()
            .expect("not an admin");
        assert_eq!((code, msg.as_str()), (StatusCode::NOT_FOUND, "Not found"));
        assert!(audit_rows(db).await.is_empty());
        let Json(PhraseRemoved { removed }) = remove(authed(db, "root").await, "Bob")
            .await
            .expect("removed");
        assert!(removed);
        let after = get_user(db, "bob").await.expect("load").expect("bob");
        assert_eq!(phrase_of(&after), (None, None));
        let kept = |u: &User| {
            let User {
                username,
                display_name,
                password_hash,
                password_kind,
                avatar_kind,
                avatar_color,
                banner_color,
                bio,
                is_site_admin,
                appear_offline,
                created_at,
                recovery_pub: _,
                recovery_set_at: _,
            } = u.clone();
            (
                (username, display_name, password_hash, password_kind),
                (avatar_kind, avatar_color, banner_color, bio),
                (is_site_admin, appear_offline, created_at),
            )
        };
        assert_eq!(kept(&after), kept(&before));
        assert!(
            crate::api::session_for_token(&state, &bob_token)
                .await
                .expect("lookup")
                .is_some(),
            "bob stays signed in"
        );
        let Json(PhraseRemoved { removed }) = remove(authed(db, "root").await, "bob")
            .await
            .expect("again");
        assert!(!removed);
        let Json(PhraseRemoved { removed }) = remove(authed(db, "root").await, "nobody")
            .await
            .expect("unknown");
        assert!(!removed);
        let Json(PhraseRemoved { removed }) = remove(authed(db, "root").await, "ali\0ce")
            .await
            .expect("nul");
        assert!(!removed);
        for own in ["root", "ROOT"] {
            let ApiError(code, msg) = remove(authed(db, "root").await, own)
                .await
                .err()
                .expect("own");
            assert_eq!(
                (code, msg.as_str()),
                (
                    StatusCode::BAD_REQUEST,
                    "Cannot remove your own backup phrase here"
                )
            );
        }
        let root = get_user(db, "root").await.expect("load").expect("root");
        assert_eq!(phrase_of(&root), (Some(PHRASE_KEY), Some(7)));
        assert_eq!(
            audit_rows(db).await,
            vec![(
                Some("root".to_string()),
                "user.remove_phrase".to_string(),
                Some("bob".to_string()),
                "{}".to_string()
            )]
        );
        let at: i64 = sqlx::query("SELECT at FROM instance_audit")
            .fetch_one(db)
            .await
            .expect("at")
            .try_get(0)
            .expect("at value");
        assert!((now() - at).abs() < 60);
        let fresh = || Session {
            user: after.clone(),
            token: bob_token.clone(),
            created_at: now(),
        };
        let set = |how: serde_json::Value| -> RecoverySet {
            serde_json::from_value(json!({"key": PHRASE_KEY, "reauth": how})).expect("set")
        };
        let ApiError(code, msg) =
            set_phrase_at(&state, fresh(), set(json!({"fresh_session": true})), now())
                .await
                .err()
                .expect("a fresh session alone sets no phrase");
        assert_eq!(
            (code, msg.as_str()),
            (StatusCode::UNAUTHORIZED, "Confirm with your password")
        );
        assert_eq!(
            phrase_of(&get_user(db, "bob").await.expect("load").expect("bob")),
            (None, None)
        );
        let _ = set_phrase_at(&state, fresh(), set(json!({"password": "a"})), now())
            .await
            .expect("the password sets a phrase again");
        assert_eq!(
            phrase_of(&get_user(db, "bob").await.expect("load").expect("bob")).0,
            Some(PHRASE_KEY)
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn only_the_admin_lists_the_instance_audit_newest_first() {
        use crate::api::instance_audit::{AuditQuery, Entry, list, record};
        let (state, path) = temp_state("admin_instance_audit").await;
        let db = &state.db;
        let _ = reg(&state, "root").await.expect("root");
        let _ = reg(&state, "carol").await.expect("carol");
        sqlx::query("UPDATE users SET is_site_admin = 1 WHERE username = 'root'")
            .execute(db)
            .await
            .expect("admin");
        for n in 0..57 {
            record(
                db,
                "root",
                "test.action",
                Some(&format!("user{n:02}")),
                json!({"n": n}),
            )
            .await
            .expect("record");
        }
        record(db, "root", "test.none", None, json!({}))
            .await
            .expect("no target");
        let query = |cursor: Option<String>| -> AuditQuery {
            serde_json::from_value(json!({ "cursor": cursor })).expect("query")
        };
        let ApiError(code, msg) = list(
            State(state.clone()),
            authed(db, "carol").await,
            Query(query(None)),
        )
        .await
        .err()
        .expect("not an admin");
        assert_eq!((code, msg.as_str()), (StatusCode::NOT_FOUND, "Not found"));
        let Paged(first, next) = list(
            State(state.clone()),
            authed(db, "root").await,
            Query(query(None)),
        )
        .await
        .expect("first page");
        assert_eq!(first.len(), 50);
        let Entry {
            id: _,
            at: _,
            actor,
            action,
            target,
            detail,
        } = &first[0];
        assert_eq!(
            (actor.as_deref(), action.as_str(), target.as_deref(), detail),
            (Some("root"), "test.none", None, &json!({}))
        );
        assert_eq!(first[1].target.as_deref(), Some("user56"));
        assert_eq!(first[1].detail, json!({"n": 56}));
        let Paged(rest, end) = list(
            State(state.clone()),
            authed(db, "root").await,
            Query(query(next)),
        )
        .await
        .expect("second page");
        assert_eq!(rest.len(), 8);
        assert_eq!(rest[7].target.as_deref(), Some("user00"));
        assert!(end.is_none());
        let ids: Vec<i64> = first.iter().chain(rest.iter()).map(|e| e.id).collect();
        assert!(ids.windows(2).all(|w| w[0] > w[1]));
        let ApiError(code, _) = list(
            State(state.clone()),
            authed(db, "root").await,
            Query(query(Some("zz".to_string()))),
        )
        .await
        .err()
        .expect("bad cursor");
        assert_eq!(code, StatusCode::BAD_REQUEST);
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_deleted_account_leaves_the_instance_audit() {
        use crate::api::instance_audit::record;
        let (state, path) = temp_state("admin_audit_forget").await;
        let db = &state.db;
        let _ = reg(&state, "root").await.expect("root");
        let _ = reg(&state, "bob").await.expect("bob");
        let _ = reg(&state, "carol").await.expect("carol");
        sqlx::query("UPDATE users SET is_site_admin = 1 WHERE username = 'root'")
            .execute(db)
            .await
            .expect("admin");
        record(db, "root", "user.remove_phrase", Some("bob"), json!({}))
            .await
            .expect("record");
        record(db, "bob", "test.action", Some("carol"), json!({}))
            .await
            .expect("record");
        record(db, "root", "sso.provider_update", Some("bob"), json!({}))
            .await
            .expect("a target that is not an account");
        let _ = delete_user(
            State(state.clone()),
            authed(db, "root").await,
            Path("bob".to_string()),
        )
        .await
        .expect("delete bob");
        settle(db).await;
        assert_eq!(
            audit_rows(db).await,
            vec![
                (
                    Some("root".to_string()),
                    "user.remove_phrase".to_string(),
                    None,
                    "{}".to_string()
                ),
                (
                    None,
                    "test.action".to_string(),
                    Some("carol".to_string()),
                    "{}".to_string()
                ),
                (
                    Some("root".to_string()),
                    "sso.provider_update".to_string(),
                    Some("bob".to_string()),
                    "{}".to_string()
                ),
            ]
        );
        done(state, path).await;
    }
}
