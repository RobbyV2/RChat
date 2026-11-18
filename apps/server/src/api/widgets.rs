use axum::Json;
use axum::extract::{FromRequestParts, Path, Query, State};
use axum::http::{HeaderMap, header, request::Parts};
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use sqlx::Row;
use sqlx::any::AnyRow;
use utoipa::{IntoParams, ToSchema};

use super::access::{
    Proof, ResolvedChannel, ServerAccess, Via, not_found, perms::Perm, resolve_channel,
    resolve_reading, resolve_server,
};
use super::{
    ApiError, Authed, LIST_PAGE, MaybeAuthed, Message, Paged, Settings, audit, bad, guest_chat,
    messages, require_guest_ok, servers, unauthorized,
};
use crate::db::{ChannelKind, Db, User, now};
use crate::identity::random_id;
use crate::state::AppState;
use crate::ws::WsEvent;

/// A request without account credentials can use guest access. A presented account
/// credential must still identify a live session.
pub(crate) struct WidgetViewer(pub Option<User>);

impl FromRequestParts<AppState> for WidgetViewer {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        let MaybeAuthed(user) = MaybeAuthed::from_request_parts(parts, state).await?;
        if user.is_none() && parts.headers.contains_key(header::AUTHORIZATION) {
            return Err(unauthorized());
        }
        Ok(Self(user))
    }
}

/// Which audience may use the channel and whether it supports participation.
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    PublicRead,
    PublicChat,
    Members,
    ReadLink,
    Voice,
}

impl Mode {
    fn word(self) -> &'static str {
        match self {
            Self::PublicRead => "public_read",
            Self::PublicChat => "public_chat",
            Self::Members => "members",
            Self::ReadLink => "read_link",
            Self::Voice => "voice",
        }
    }
}

/// Manager choices for one embedded channel.
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct WidgetConfig {
    /// Channel in the managed server.
    pub channel_id: i64,
    /// Audience and interaction mode.
    pub mode: Mode,
    /// Whether this widget accepts sessions.
    pub enabled: bool,
    /// Allow text entry when the viewer may post.
    pub composer: bool,
    /// Allowed HTTP or HTTPS parent origins. An empty list permits public framing.
    pub origins: Vec<String>,
}

/// A managed widget and its current configuration.
#[derive(Serialize, ToSchema)]
pub struct Widget {
    /// Public widget id.
    pub id: String,
    /// Server name.
    pub server: String,
    #[serde(flatten)]
    /// Configuration chosen by the manager.
    pub config: WidgetConfig,
    /// A read link's revocable key, visible only to managers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_key: Option<String>,
    #[serde(skip)]
    revision: String,
}

const COLUMNS: &str = "id,server,channel_id,mode,enabled,composer,origins,revision";

fn from_row(row: AnyRow) -> Result<Widget, ApiError> {
    let mode: String = row.try_get(3)?;
    Ok(Widget {
        id: row.try_get(0)?,
        server: row.try_get(1)?,
        config: WidgetConfig {
            channel_id: row.try_get(2)?,
            mode: serde_json::from_value(mode.into()).map_err(|_| not_found())?,
            enabled: row.try_get::<i64, _>(4)? != 0,
            composer: row.try_get::<i64, _>(5)? != 0,
            origins: serde_json::from_str(&row.try_get::<String, _>(6)?)
                .map_err(|_| not_found())?,
        },
        read_key: None,
        revision: row.try_get(7)?,
    })
}

fn signature(revision: &str, what: &str) -> Hmac<Sha256> {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(revision.as_bytes()).expect("HMAC accepts any key");
    mac.update(what.as_bytes());
    mac
}
impl Widget {
    fn for_manager(mut self) -> Self {
        if self.config.mode == Mode::ReadLink {
            self.read_key = Some(hex::encode(
                signature(&self.revision, "read link")
                    .finalize()
                    .into_bytes(),
            ));
        }
        self
    }
    fn enabled(&self, settings: &Settings) -> bool {
        settings.widgets
            && self.config.enabled
            && (self.config.mode != Mode::ReadLink || settings.widget_read_links)
    }
    pub(crate) fn valid_ticket(&self, ticket: &str, parent: &str) -> bool {
        let Some((until, tag)) = ticket.split_once('.') else {
            return false;
        };
        until.parse::<i64>().is_ok_and(|t| t > now())
            && hex::decode(tag).is_ok_and(|bytes| {
                signature(
                    &self.revision,
                    &format!("widget {} {until} {parent}", self.id),
                )
                .verify_slice(&bytes)
                .is_ok()
            })
    }
}

async fn fetch(db: &Db, id: &str) -> Result<Widget, ApiError> {
    let sql = format!("SELECT {COLUMNS} FROM widgets WHERE id=$1");
    from_row(
        sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(id)
            .fetch_optional(db)
            .await?
            .ok_or_else(not_found)?,
    )
}

/// Return the configured frame ancestors for the widget document.
///
/// The widget document uses this value for its frame-ancestors policy. Disabled and unknown widgets return 404.
#[utoipa::path(get, path = "/api/v1/widgets/{id}/framing", tag = "Widgets", params(("id" = String, Path, description = "Widget id")), responses((status = 200, description = "Allowed frame ancestors", body = String), (status = 404, description = "Widget unavailable")))]
pub(crate) async fn framing(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<String>, ApiError> {
    let w = fetch(&state.db, &id).await?;
    if !w.enabled(&Settings::cached(&state.db).await) {
        return Err(not_found());
    }
    if w.config.origins.is_empty() {
        let channel = resolve_channel(&state.db, w.config.channel_id, None, &Proof::none())
            .await
            .map_err(|e| if e.failed() { e } else { not_found() })?;
        if channel.restricted(&state.db).await? {
            return Err(not_found());
        }
    }
    Ok(Json(if w.config.origins.is_empty() {
        "*".into()
    } else {
        format!("'self' {}", w.config.origins.join(" "))
    }))
}

fn origin(s: &str) -> Result<String, ApiError> {
    let err = || bad("Enter a full HTTP or HTTPS origin without a path");
    let u = crate::instance::origin_url(s, "Origin", &["http", "https"]).map_err(|_| err())?;
    if u.path() != "/" || u.password().is_some() {
        return Err(err());
    }
    Ok(u.origin().ascii_serialization())
}

async fn manager(db: &Db, server: &str, user: &User) -> Result<ServerAccess, ApiError> {
    let access = resolve_server(db, server, Some(user), &Proof::none()).await?;
    access.require_perm(db, Perm::DeleteServer).await?;
    Ok(access)
}

#[derive(Deserialize, IntoParams)]
pub struct WidgetListQuery {
    /// Page size, clamped to 1-50. Defaults to 50.
    limit: Option<i64>,
    /// Cursor from the previous page's X-Next-Cursor header.
    cursor: Option<String>,
}

/// List a page of the server's widget configurations, ordered by id.
///
/// Requires permission to manage the server. A read link includes its current read key.
#[utoipa::path(get, path = "/api/v1/servers/{name}/widgets", tag = "Widgets", params(("name" = String, Path, description = "Server name"), WidgetListQuery), responses((status = 200, description = "Configured widgets", body = Vec<Widget>, headers(("X-Next-Cursor" = String, description = "Cursor for the next page, absent on the last page"))), (status = 400, description = "Invalid cursor or page size"), (status = 404, description = "Server unavailable")), security(("bearer" = [])))]
pub(crate) async fn list(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Query(query): Query<WidgetListQuery>,
) -> Result<Paged<Widget>, ApiError> {
    if !Settings::cached(&state.db).await.widgets {
        return Err(not_found());
    }
    let access = manager(&state.db, &name, &user).await?;
    let WidgetListQuery { limit, cursor } = query;
    let after = cursor.unwrap_or_default();
    if !after.is_empty() && (after.len() != 32 || !after.bytes().all(|b| b.is_ascii_hexdigit())) {
        return Err(bad("Invalid cursor"));
    }
    let limit = limit.unwrap_or(LIST_PAGE).clamp(1, LIST_PAGE);
    let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {COLUMNS} FROM widgets WHERE server=$1 AND id>$2 ORDER BY id LIMIT $3"
    )))
    .bind(access.name())
    .bind(after)
    .bind(limit + 1)
    .fetch_all(&state.db)
    .await?;
    let more = rows.len() > limit as usize;
    let widgets = rows
        .into_iter()
        .take(limit as usize)
        .map(|r| from_row(r).map(Widget::for_manager))
        .collect::<Result<Vec<_>, _>>()?;
    let next = match (more, widgets.last()) {
        (true, Some(w)) => Some(w.id.clone()),
        _ => None,
    };
    Ok(Paged(widgets, next))
}

/// Create a chat or voice widget in one channel.
///
/// Requires permission to manage the server. Private and members-only widgets require an explicit list of parent origins.
#[utoipa::path(post, path = "/api/v1/servers/{name}/widgets", tag = "Widgets", params(("name" = String, Path, description = "Server name")), request_body = WidgetConfig, responses((status = 200, description = "Saved widget configuration", body = Widget)), security(("bearer" = [])))]
pub(crate) async fn create(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Json(config): Json<WidgetConfig>,
) -> Result<Json<Widget>, ApiError> {
    save(&state, &user, &name, None, config).await
}

/// Change the channel, access or appearance of a widget. Replaces its live sessions and read key.
///
/// Requires permission to manage the server. Saving replaces the widget revision, invalidating existing sessions and read keys.
#[utoipa::path(put, path = "/api/v1/servers/{name}/widgets/{id}", tag = "Widgets", params(("name" = String, Path, description = "Server name"), ("id" = String, Path, description = "Widget id")), request_body = WidgetConfig, responses((status = 200, description = "Saved widget configuration", body = Widget)), security(("bearer" = [])))]
pub(crate) async fn update(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path((name, id)): Path<(String, String)>,
    Json(config): Json<WidgetConfig>,
) -> Result<Json<Widget>, ApiError> {
    save(&state, &user, &name, Some(id), config).await
}

async fn save(
    state: &AppState,
    user: &User,
    name: &str,
    id: Option<String>,
    mut config: WidgetConfig,
) -> Result<Json<Widget>, ApiError> {
    let db = &state.db;
    let access = manager(db, name, user).await?;
    let settings = Settings::cached(db).await;
    if config.enabled
        && (!settings.widgets || config.mode == Mode::ReadLink && !settings.widget_read_links)
    {
        return Err(bad("Widgets of this kind are turned off on this site"));
    }
    let server = access.name().to_string();
    let actor = access.audit_actor(db, Perm::DeleteServer).await?;
    let lite = access.lite().clone();
    let channel = access.channel(db, config.channel_id).await?;
    if channel.kind() == ChannelKind::Voice && !matches!(config.mode, Mode::Voice | Mode::Members)
        || channel.kind() == ChannelKind::Text && config.mode == Mode::Voice
    {
        return Err(bad("Choose a channel of the right kind"));
    }
    if config.origins.len() > 32 {
        return Err(bad("Choose up to 32 origins"));
    }
    config.origins = config
        .origins
        .iter()
        .map(|s| origin(s))
        .collect::<Result<_, _>>()?;
    config.origins.sort();
    config.origins.dedup();
    let public = resolve_reading(db, &server, None).await?.is_some();
    if matches!(config.mode, Mode::PublicRead | Mode::PublicChat)
        && (!public || channel.restricted(db).await?)
    {
        return Err(bad("Choose a public text channel"));
    }
    if config.origins.is_empty()
        && (!public
            || matches!(config.mode, Mode::ReadLink | Mode::Members)
            || channel.restricted(db).await?)
    {
        return Err(bad("Set at least one allowed origin for this widget"));
    }
    let origins = serde_json::to_string(&config.origins).expect("string list");
    let revision = random_id();
    let fresh = id.is_none();
    let id = id.unwrap_or_else(random_id);
    let sql = if fresh {
        "INSERT INTO widgets(id,server,channel_id,mode,enabled,composer,origins,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8)"
    } else {
        "UPDATE widgets SET channel_id=$3,mode=$4,enabled=$5,composer=$6,origins=$7,revision=$8 WHERE id=$1 AND server=$2"
    };
    let mut tx = db.begin().await?;
    if sqlx::query(sql)
        .bind(&id)
        .bind(&server)
        .bind(config.channel_id)
        .bind(config.mode.word())
        .bind(i64::from(config.enabled))
        .bind(i64::from(config.composer))
        .bind(origins)
        .bind(&revision)
        .execute(&mut *tx)
        .await?
        .rows_affected()
        != 1
    {
        return Err(not_found());
    }
    let at = audit::channel_ref(&mut *tx, config.channel_id)
        .await?
        .ok_or_else(not_found)?;
    audit::record(
        &mut tx,
        audit::Entry::new(&server, &actor, audit::Action::ServerUpdate)
            .target(audit::Target::server(&server))
            .details(
                audit::Details::new()
                    .channel(&at)
                    .set("widget", id.as_str())
                    .set("mode", config.mode.word())
                    .set("enabled", config.enabled),
            ),
    )
    .await?;
    tx.commit().await?;
    // Open frames of this server read their room again.
    state.hub.broadcast(WsEvent::ServerUpdated { server: lite });
    Ok(Json(
        Widget {
            id,
            server,
            config,
            revision,
            read_key: None,
        }
        .for_manager(),
    ))
}

/// Information supplied by the widget document when opening a session.
#[derive(Deserialize, ToSchema)]
pub struct Open {
    /// Origin of the immediate parent document.
    parent: String,
    /// Revocable read-link key from the URL fragment, when required.
    read_key: Option<String>,
}
/// An origin-bound session for this widget.
#[derive(Serialize, ToSchema)]
pub struct Session {
    /// Access mode used to offer the appropriate sign-in or password form.
    mode: Mode,
    /// Short-lived credential scoped to this widget configuration and parent origin.
    ticket: String,
}

/// Open an embed session for its configured parent origin and mode.
///
/// The widget supplies the parent document's origin and, for a read link, its key. The returned ticket belongs to that origin and widget revision.
#[utoipa::path(post, path = "/api/v1/widgets/{id}/session", tag = "Widgets", params(("id" = String, Path, description = "Widget id")), request_body = Open, responses((status = 200, description = "Widget session", body = Session), (status = 404, description = "Widget unavailable")))]
pub(crate) async fn open(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<Open>,
) -> Result<Json<Session>, ApiError> {
    if headers
        .get("sec-fetch-site")
        .is_some_and(|v| v != "same-origin")
    {
        return Err(not_found());
    }
    let w = fetch(&state.db, &id).await?;
    let parent = origin(&req.parent).map_err(|_| not_found())?;
    let own = state.instance.origin(None, &headers);
    if !w.enabled(&Settings::cached(&state.db).await)
        || !w.config.origins.is_empty() && parent != own && !w.config.origins.contains(&parent)
    {
        return Err(not_found());
    }
    if w.config.mode == Mode::ReadLink
        && !req
            .read_key
            .and_then(|s| hex::decode(s).ok())
            .is_some_and(|tag| {
                signature(&w.revision, "read link")
                    .verify_slice(&tag)
                    .is_ok()
            })
    {
        return Err(not_found());
    }
    let until = now() + 86400;
    let tag = signature(&w.revision, &format!("widget {id} {until} {parent}"))
        .finalize()
        .into_bytes();
    Ok(Json(Session {
        mode: w.config.mode,
        ticket: format!("{until}.{}", hex::encode(tag)),
    }))
}

fn header<'a>(headers: &'a HeaderMap, key: &str) -> Result<&'a str, ApiError> {
    headers
        .get(key)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(not_found)
}

pub(crate) async fn scoped(
    state: &AppState,
    id: &str,
    ticket: &str,
    parent: &str,
) -> Result<Widget, ApiError> {
    let w = fetch(&state.db, id).await?;
    if !w.enabled(&Settings::cached(&state.db).await) || !w.valid_ticket(ticket, parent) {
        return Err(not_found());
    }
    Ok(w)
}

pub(crate) struct Room {
    pub widget: Widget,
    pub channel: ResolvedChannel,
    pub participate: bool,
    pub may_stay: bool,
}
async fn authorized_channel(
    state: &AppState,
    id: &str,
    ticket: &str,
    parent: &str,
    user: Option<&User>,
    proof: &Proof<'_>,
) -> Result<(Widget, ResolvedChannel), ApiError> {
    let db = &state.db;
    let widget = scoped(state, id, ticket, parent).await?;
    require_guest_ok(db, user).await.map_err(|_| not_found())?;
    let config = &widget.config;
    let channel = match config.mode {
        Mode::ReadLink => super::access::read_link_channel(db, config.channel_id, user).await?,
        _ => resolve_channel(db, config.channel_id, user, proof).await?,
    };
    if channel.server().name() != widget.server {
        return Err(not_found());
    }
    if matches!(config.mode, Mode::PublicChat | Mode::PublicRead)
        && (resolve_reading(db, &widget.server, None).await?.is_none()
            || channel.restricted(db).await?)
    {
        return Err(not_found());
    }
    if config.mode == Mode::Members && !channel.server().is_member() {
        return Err(not_found());
    }
    if config.origins.is_empty()
        && (channel.restricted(db).await?
            || resolve_reading(db, &widget.server, None).await?.is_none())
    {
        return Err(not_found());
    }
    Ok((widget, channel))
}

pub(crate) async fn room(
    state: &AppState,
    id: &str,
    ticket: &str,
    parent: &str,
    user: Option<&User>,
    proof: &Proof<'_>,
) -> Result<Room, ApiError> {
    let db = &state.db;
    let (widget, channel) = authorized_channel(state, id, ticket, parent, user, proof).await?;
    let config = &widget.config;
    let settings = Settings::cached(db).await;
    let interactive = match channel.kind() {
        ChannelKind::Text => {
            matches!(config.mode, Mode::PublicChat | Mode::Members)
                && config.composer
                && settings.widget_chat
        }
        ChannelKind::Voice => matches!(config.mode, Mode::Voice | Mode::Members) && settings.calls,
    };
    let may_stay = interactive
        && channel.kind() == ChannelKind::Voice
        && match user {
            None => channel.guest_participation(db).await?,
            Some(_) => {
                channel.server().via() != Via::Staff && channel.member_rights(db).await?.view
            }
        };
    let participate = if channel.kind() == ChannelKind::Voice {
        may_stay && super::allowed(channel.timeout_gate(db).await)?.is_some()
    } else if !interactive {
        false
    } else if user.is_none() {
        channel.guest_participation(db).await?
    } else {
        channel.can_send_text(db).await?
    };
    Ok(Room {
        widget,
        channel,
        participate,
        may_stay,
    })
}

/// Authorized channel identity available before opening its content.
#[derive(Serialize, ToSchema)]
pub struct RoomMetadata {
    /// Canonical server identifier.
    server: String,
    /// Channel id within this instance.
    channel_id: i64,
    /// Text or voice.
    kind: ChannelKind,
}

impl RoomMetadata {
    fn from_channel(channel: &ResolvedChannel) -> Self {
        Self {
            server: channel.server().name().into(),
            channel_id: channel.id(),
            kind: channel.kind(),
        }
    }
}

/// Discover the widget's authorized room before opening its content.
///
/// Uses the same widget session, parent origin, account and password-grant checks as the view.
/// Only channel identity and kind are returned. History, roster, media and live subscriptions open separately.
#[utoipa::path(get, path = "/api/v1/widgets/{id}/room", tag = "Widgets", params(("id" = String, Path, description = "Widget id")), responses((status = 200, description = "Authorized room metadata", body = RoomMetadata), (status = 401, description = "The supplied account session has expired"), (status = 404, description = "Widget unavailable")), security((), ("bearer" = [])))]
pub(crate) async fn metadata(
    State(state): State<AppState>,
    WidgetViewer(user): WidgetViewer,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<RoomMetadata>, ApiError> {
    let (_, channel) = authorized_channel(
        &state,
        &id,
        header(&headers, "x-widget-session")?,
        header(&headers, "x-widget-parent")?,
        user.as_ref(),
        &Proof::headers(&headers, &state.limits),
    )
    .await?;
    Ok(Json(RoomMetadata::from_channel(&channel)))
}

/// The single channel and controls available to this viewer.
#[derive(Serialize, ToSchema)]
pub struct View {
    /// Identity of the authorized room.
    #[serde(flatten)]
    room: RoomMetadata,
    /// Channel name.
    name: String,
    /// Whether the viewer may send text or join voice here.
    participate: bool,
    /// Readable top-level chat history, oldest first.
    messages: Vec<Message>,
    /// Voice participants visible to this viewer.
    users: Vec<String>,
}

/// Read only the widget's configured channel, subject to its viewer's access.
///
/// Send X-Widget-Session and X-Widget-Parent. Members authenticate normally and guests in protected voice rooms also supply their password grant.
#[utoipa::path(get, path = "/api/v1/widgets/{id}/view", tag = "Widgets", params(("id" = String, Path, description = "Widget id")), responses((status = 200, description = "Visible channel", body = View), (status = 401, description = "The supplied account session has expired"), (status = 404, description = "Widget unavailable")), security((), ("bearer" = [])))]
pub(crate) async fn view(
    State(state): State<AppState>,
    WidgetViewer(user): WidgetViewer,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<View>, ApiError> {
    let Room {
        widget,
        channel,
        mut participate,
        ..
    } = room(
        &state,
        &id,
        header(&headers, "x-widget-session")?,
        header(&headers, "x-widget-parent")?,
        user.as_ref(),
        &Proof::headers(&headers, &state.limits),
    )
    .await?;
    if participate && user.is_none() && channel.kind() == ChannelKind::Text {
        participate = guest_chat::paused_until(&state.db, &widget.server, &headers)
            .await?
            .is_none();
    }
    let messages = if channel.kind() == ChannelKind::Text {
        messages::read_channel(
            &state.db,
            &channel,
            user.as_ref(),
            &messages::PageQuery::default(),
        )
        .await?
    } else {
        vec![]
    };
    let users = if channel.kind() == ChannelKind::Voice && channel.shows_membership_notices() {
        state
            .hub
            .rooms_in(&widget.server, Some(channel.id()))
            .into_iter()
            .flat_map(|(_, u)| u)
            .collect()
    } else {
        vec![]
    };
    Ok(Json(View {
        room: RoomMetadata::from_channel(&channel),
        name: channel.name().into(),
        participate,
        messages,
        users,
    }))
}

/// Preview readable messages in the widget's configured text channel.
///
/// Uses the same widget session and viewer credentials as the room. Omitted ids leave plain links.
#[utoipa::path(post, path = "/api/v1/widgets/{id}/locations", tag = "Widgets", params(("id" = String, Path, description = "Widget id")), request_body = messages::LocateBatchReq, responses((status = 200, description = "Readable message previews in this channel", body = Vec<messages::MessageLocation>), (status = 400, description = "More than 50 ids"), (status = 401, description = "The supplied account session has expired"), (status = 404, description = "Widget unavailable"), (status = 429, description = "Too many requests")), security((), ("bearer" = [])))]
pub(crate) async fn locations(
    State(state): State<AppState>,
    WidgetViewer(user): WidgetViewer,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<messages::LocateBatchReq>,
) -> Result<Json<Vec<messages::MessageLocation>>, ApiError> {
    let proof = Proof::headers(&headers, &state.limits);
    let (_, channel) = authorized_channel(
        &state,
        &id,
        header(&headers, "x-widget-session")?,
        header(&headers, "x-widget-parent")?,
        user.as_ref(),
        &proof,
    )
    .await?;
    if channel.kind() != ChannelKind::Text {
        return Err(not_found());
    }
    messages::locations(
        &state,
        &state.db,
        user.as_ref(),
        &proof,
        req,
        Some(&channel),
    )
    .await
}

/// Send text through an interactive chat widget.
///
/// Send the same widget session, parent origin and authentication headers as for reading. Guests also present their X-Guest-Session after their first send.
#[utoipa::path(post, path = "/api/v1/widgets/{id}/messages", tag = "Widgets", params(("id" = String, Path, description = "Widget id")), request_body = guest_chat::GuestText, responses((status = 200, description = "Posted channel message", body = WidgetPost), (status = 401, description = "The supplied account session has expired"), (status = 404, description = "Widget unavailable")), security((), ("bearer" = [])))]
pub(crate) async fn post(
    State(state): State<AppState>,
    WidgetViewer(user): WidgetViewer,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(text): Json<guest_chat::GuestText>,
) -> Result<Json<WidgetPost>, ApiError> {
    let r = room(
        &state,
        &id,
        header(&headers, "x-widget-session")?,
        header(&headers, "x-widget-parent")?,
        user.as_ref(),
        &Proof::headers(&headers, &state.limits),
    )
    .await?;
    if !r.participate || r.channel.kind() != ChannelKind::Text || text.thread_root_id.is_some() {
        return Err(not_found());
    }
    let path = Path(r.channel.id());
    let (message, session) = match user {
        None => {
            let Json(p) = guest_chat::post(State(state), path, headers, Json(text)).await?;
            (p.message, Some(p.session))
        }
        Some(u) => {
            let req = messages::SendReq::text(text.content, text.reply_to);
            let Json(m) =
                messages::send_channel_message(State(state), path, Authed(u), Json(req)).await?;
            (m, None)
        }
    };
    Ok(Json(WidgetPost { message, session }))
}

/// Result of sending text from the widget.
#[derive(Serialize, ToSchema)]
pub struct WidgetPost {
    /// Posted channel message.
    message: Message,
    /// Server-scoped guest credential for later sends, absent for accounts.
    session: Option<String>,
}

/// Redeem the server password for this voice room.
///
/// Send the widget session and parent origin. An accepted server password has the same expiry and use limits as in the main client.
#[utoipa::path(post, path = "/api/v1/widgets/{id}/guest-access", tag = "Widgets", params(("id" = String, Path, description = "Widget id")), request_body = servers::GuestAccessReq, responses((status = 200, description = "Server password grant", body = servers::GuestGrant), (status = 404, description = "Widget unavailable")))]
pub(crate) async fn guest_access(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    req: Json<servers::GuestAccessReq>,
) -> Result<Json<servers::GuestGrant>, ApiError> {
    let w = scoped(
        &state,
        &id,
        header(&headers, "x-widget-session")?,
        header(&headers, "x-widget-parent")?,
    )
    .await?;
    if w.config.mode != Mode::Voice {
        return Err(not_found());
    }
    servers::guest_access(State(state), MaybeAuthed(None), Path(w.server), req).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::test_util::{add_member, done, mem_user, site_sets, temp_state};

    #[tokio::test]
    async fn a_presented_widget_login_must_identify_a_live_account() {
        let (state, path) = temp_state("widget_credentials").await;
        let (mut parts, _) = axum::http::Request::new(()).into_parts();
        let guest = WidgetViewer::from_request_parts(&mut parts, &state)
            .await
            .unwrap();
        assert!(guest.0.is_none());
        crate::db::NewUser::plain("cellist").add(&state.db).await;
        sqlx::query("INSERT INTO tokens(token, username, created_at) VALUES($1, 'cellist', 0)")
            .bind(crate::db::secret_key("cellist-widget"))
            .execute(&state.db)
            .await
            .unwrap();
        parts.headers.insert(
            header::AUTHORIZATION,
            "Bearer cellist-widget".parse().unwrap(),
        );
        let WidgetViewer(account) = WidgetViewer::from_request_parts(&mut parts, &state)
            .await
            .unwrap();
        assert_eq!(account.map(|u| u.username), Some("cellist".to_string()));
        sqlx::query("DELETE FROM tokens WHERE username = 'cellist'")
            .execute(&state.db)
            .await
            .unwrap();
        for credential in ["Bearer cellist-widget", "Basic cellist"] {
            parts
                .headers
                .insert(header::AUTHORIZATION, credential.parse().unwrap());
            assert!(matches!(
                WidgetViewer::from_request_parts(&mut parts, &state).await,
                Err(ApiError(axum::http::StatusCode::UNAUTHORIZED, ref error, _)) if error == "Unauthorized"
            ));
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn manager_pages_include_enabled_and_disabled_widgets_once() {
        let (state, path) = temp_state("widget_pages").await;
        let mut tx = state.db.begin().await.unwrap();
        for i in (1..=52).rev() {
            sqlx::query("INSERT INTO widgets(id,server,channel_id,mode,enabled,composer,origins,revision) SELECT $1,server,id,'public_read',$2,0,'[]','revision' FROM channels WHERE server='rchat' AND kind='text' LIMIT 1")
                .bind(format!("{i:032x}")).bind(i % 2).execute(&mut *tx).await.unwrap();
        }
        tx.commit().await.unwrap();
        let page = |cursor, limit| {
            list(
                State(state.clone()),
                Authed(mem_user("manager", true)),
                Path("rchat".into()),
                Query(WidgetListQuery { cursor, limit }),
            )
        };
        let Paged(first, next) = page(None, Some(500)).await.unwrap();
        assert_eq!(first.len(), 50);
        assert_eq!(first.iter().filter(|w| !w.config.enabled).count(), 25);
        let Paged(rest, end) = page(Some(next.unwrap()), None).await.unwrap();
        assert_eq!(end, None);
        let ids: Vec<_> = first.into_iter().chain(rest).map(|w| w.id).collect();
        assert_eq!(
            ids,
            (1..=52).map(|i| format!("{i:032x}")).collect::<Vec<_>>()
        );
        done(state, path).await;
    }

    const HOST: &str = "https://host.example";

    type Reply<T> = Result<T, (u16, String)>;

    fn failed(ApiError(status, message, _): ApiError) -> (u16, String) {
        (status.as_u16(), message)
    }

    fn code<T>(reply: &Reply<T>) -> u16 {
        match reply {
            Ok(_) => 200,
            Err((status, _)) => *status,
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
            .expect(sql)
    }

    /// The built-in server with a manager, a member and an account from outside, its text
    /// channel and a voice channel, with widgets, widget chat and guest text on.
    async fn world(tag: &str) -> (AppState, std::path::PathBuf, i64, i64) {
        let (state, path) = temp_state(tag).await;
        let db = &state.db;
        for name in ["manager", "member", "outsider"] {
            crate::db::NewUser::plain(name).hash("x").add(db).await;
        }
        add_member(db, "rchat", "manager", 1, 0, 0).await;
        add_member(db, "rchat", "member", 0, 0, 0).await;
        site_sets(
            &state,
            serde_json::json!({
                "widgets": true,
                "widget_chat": true,
                "widget_read_links": true,
                "guests_enabled": true,
                "guest_chat_enabled": true,
                "guest_voice_enabled": true,
            }),
        )
        .await;
        exec(
            db,
            "UPDATE servers SET guest_chat_opt_in = 1, guest_voice_opt_in = 1 WHERE name = 'rchat'",
        )
        .await;
        let text = id_of(
            db,
            "SELECT id FROM channels WHERE server = 'rchat' AND kind = 'text' ORDER BY id LIMIT 1",
        )
        .await;
        let voice = id_of(db, "INSERT INTO channels(server, name, kind, created_at) VALUES('rchat', 'lounge', 'voice', 0) RETURNING id").await;
        (state, path, text, voice)
    }

    fn config(channel_id: i64, mode: &str, origins: &[&str]) -> serde_json::Value {
        serde_json::json!({
            "channel_id": channel_id,
            "mode": mode,
            "enabled": true,
            "composer": true,
            "origins": origins,
        })
    }

    async fn saved(
        state: &AppState,
        by: &str,
        id: Option<&str>,
        body: serde_json::Value,
    ) -> Reply<Widget> {
        let config: WidgetConfig = serde_json::from_value(body).expect("config");
        save(
            state,
            &mem_user(by, false),
            "rchat",
            id.map(String::from),
            config,
        )
        .await
        .map(|Json(w)| w)
        .map_err(failed)
    }

    async fn made(state: &AppState, body: serde_json::Value) -> Widget {
        saved(state, "manager", None, body).await.expect("widget")
    }

    async fn ticket(
        state: &AppState,
        id: &str,
        parent: &str,
        read_key: Option<String>,
        site: Option<&str>,
    ) -> Reply<String> {
        let mut headers = HeaderMap::new();
        if let Some(site) = site {
            headers.insert("sec-fetch-site", site.parse().expect("site"));
        }
        open(
            State(state.clone()),
            Path(id.to_string()),
            headers,
            Json(Open {
                parent: parent.to_string(),
                read_key,
            }),
        )
        .await
        .map(|Json(session)| session.ticket)
        .map_err(failed)
    }

    fn scope(ticket: &str, parent: &str, extra: &[(&str, &str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("x-widget-session", ticket.parse().expect("ticket"));
        headers.insert("x-widget-parent", parent.parse().expect("parent"));
        for (k, v) in extra {
            headers.insert(
                axum::http::HeaderName::from_bytes(k.as_bytes()).expect("name"),
                v.parse().expect("header"),
            );
        }
        headers
    }

    fn viewer(name: Option<&str>) -> WidgetViewer {
        WidgetViewer(name.map(|n| mem_user(n, false)))
    }

    async fn room_of(state: &AppState, id: &str, headers: HeaderMap, who: Option<&str>) -> u16 {
        code(
            &metadata(
                State(state.clone()),
                viewer(who),
                Path(id.to_string()),
                headers,
            )
            .await
            .map_err(failed),
        )
    }

    async fn view_of(
        state: &AppState,
        id: &str,
        headers: HeaderMap,
        who: Option<&str>,
    ) -> Reply<View> {
        view(
            State(state.clone()),
            viewer(who),
            Path(id.to_string()),
            headers,
        )
        .await
        .map(|Json(v)| v)
        .map_err(failed)
    }

    async fn post_as(
        state: &AppState,
        id: &str,
        headers: HeaderMap,
        who: Option<&str>,
        body: serde_json::Value,
    ) -> Reply<WidgetPost> {
        let text: guest_chat::GuestText = serde_json::from_value(body).expect("text");
        post(
            State(state.clone()),
            viewer(who),
            Path(id.to_string()),
            headers,
            Json(text),
        )
        .await
        .map(|Json(p)| p)
        .map_err(failed)
    }

    fn say(text: &str) -> serde_json::Value {
        serde_json::json!({ "content": text })
    }

    #[tokio::test]
    async fn a_widget_shows_one_channel_of_its_kind_to_its_audience() {
        let (state, path, text, voice) = world("widget_save_rules").await;
        let db = &state.db;
        let bad = |body: serde_json::Value, what: &'static str| {
            let state = state.clone();
            async move {
                assert_eq!(
                    code(&saved(&state, "manager", None, body).await),
                    400,
                    "{what}"
                );
            }
        };
        bad(
            config(text, "voice", &[HOST]),
            "a voice mode on a text channel",
        )
        .await;
        bad(
            config(voice, "public_chat", &[HOST]),
            "a chat mode on a voice channel",
        )
        .await;
        bad(
            config(voice, "public_read", &[HOST]),
            "a reading mode on a voice channel",
        )
        .await;
        bad(
            config(voice, "read_link", &[HOST]),
            "a read link on a voice channel",
        )
        .await;
        bad(config(text, "members", &[]), "members without origins").await;
        bad(
            config(text, "read_link", &[]),
            "a read link without origins",
        )
        .await;
        bad(
            config(text, "public_chat", &["https://host.example/page"]),
            "an origin with a path",
        )
        .await;
        bad(
            config(text, "public_chat", &["ftp://host.example"]),
            "not HTTP",
        )
        .await;
        let many: Vec<String> = (0..33).map(|i| format!("https://h{i}.example")).collect();
        let many: Vec<&str> = many.iter().map(String::as_str).collect();
        bad(config(text, "public_chat", &many), "more than 32 origins").await;
        made(&state, config(voice, "members", &[HOST])).await;
        made(&state, config(voice, "voice", &[])).await;
        let public = made(&state, config(text, "public_chat", &[])).await;
        assert!(public.config.origins.is_empty());
        let listed = made(
            &state,
            config(
                text,
                "public_read",
                &["https://B.example", "https://b.example/"],
            ),
        )
        .await;
        assert_eq!(listed.config.origins, ["https://b.example"]);
        assert_ne!(
            code(&saved(&state, "member", None, config(text, "public_chat", &[])).await),
            200,
            "only managers"
        );

        let hidden = id_of(db, "INSERT INTO channels(server, name, restrict_view, created_at) VALUES('rchat', 'staff', 1, 0) RETURNING id").await;
        bad(
            config(hidden, "public_read", &[HOST]),
            "a public mode on a hidden channel",
        )
        .await;
        bad(
            config(hidden, "voice", &[]),
            "a hidden channel without origins",
        )
        .await;
        made(&state, config(hidden, "members", &[HOST])).await;
        exec(
            db,
            "UPDATE servers SET public_read = 0 WHERE name = 'rchat'",
        )
        .await;
        bad(
            config(text, "public_chat", &[HOST]),
            "a public mode on a server nobody outside reads",
        )
        .await;
        bad(
            config(voice, "voice", &[]),
            "no origins on a server nobody outside reads",
        )
        .await;
        exec(
            db,
            "UPDATE servers SET public_read = NULL WHERE name = 'rchat'",
        )
        .await;

        site_sets(&state, serde_json::json!({ "widget_read_links": false })).await;
        bad(config(text, "read_link", &[HOST]), "read links are off").await;
        site_sets(&state, serde_json::json!({ "widgets": false })).await;
        bad(config(text, "public_chat", &[]), "widgets are off").await;
        let mut off = config(text, "public_chat", &[]);
        off["enabled"] = false.into();
        made(&state, off).await;
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_widget_session_belongs_to_its_parent_and_its_revision() {
        let (state, path, text, _) = world("widget_sessions").await;
        let db = &state.db;
        let w = made(&state, config(text, "public_chat", &[HOST])).await;
        let id = w.id.as_str();
        assert_eq!(
            code(&ticket(&state, id, "https://other.example", None, None).await),
            404,
            "another parent"
        );
        assert_eq!(
            code(&ticket(&state, id, "not an origin", None, None).await),
            404
        );
        assert_eq!(
            code(&ticket(&state, id, HOST, None, Some("cross-site")).await),
            404,
            "not from the widget page"
        );
        assert_eq!(
            code(&ticket(&state, "0".repeat(32).as_str(), HOST, None, None).await),
            404
        );
        let t = ticket(&state, id, HOST, None, Some("same-origin"))
            .await
            .expect("ticket");
        assert_eq!(room_of(&state, id, scope(&t, HOST, &[]), None).await, 200);
        assert_eq!(
            room_of(&state, id, scope(&t, "https://other.example", &[]), None).await,
            404,
            "the ticket names its parent"
        );
        assert_eq!(
            room_of(&state, id, scope("1.ab", HOST, &[]), None).await,
            404
        );
        let until = now() - 1;
        let tag = signature(&w.revision, &format!("widget {id} {until} {HOST}"))
            .finalize()
            .into_bytes();
        let expired = format!("{until}.{}", hex::encode(tag));
        assert_eq!(
            room_of(&state, id, scope(&expired, HOST, &[]), None).await,
            404,
            "an expired ticket"
        );
        let other = made(&state, config(text, "public_chat", &[HOST])).await;
        assert_eq!(
            room_of(&state, &other.id, scope(&t, HOST, &[]), None).await,
            404,
            "another widget"
        );
        assert_eq!(
            framing(State(state.clone()), Path(id.to_string()))
                .await
                .map(|Json(f)| f)
                .map_err(failed),
            Ok("'self' https://host.example".to_string())
        );

        saved(
            &state,
            "manager",
            Some(id),
            config(text, "public_chat", &[HOST]),
        )
        .await
        .expect("saved again");
        assert_eq!(
            room_of(&state, id, scope(&t, HOST, &[]), None).await,
            404,
            "saving replaces the revision"
        );
        let t = ticket(&state, id, HOST, None, None)
            .await
            .expect("a new ticket");
        assert_eq!(room_of(&state, id, scope(&t, HOST, &[]), None).await, 200);
        let mut off = config(text, "public_chat", &[HOST]);
        off["enabled"] = false.into();
        saved(&state, "manager", Some(id), off)
            .await
            .expect("disabled");
        assert_eq!(
            code(&ticket(&state, id, HOST, None, None).await),
            404,
            "a disabled widget"
        );
        assert_eq!(
            code(
                &framing(State(state.clone()), Path(id.to_string()))
                    .await
                    .map_err(failed)
            ),
            404
        );

        let public = made(&state, config(text, "public_read", &[])).await;
        assert_eq!(
            framing(State(state.clone()), Path(public.id.clone()))
                .await
                .map(|Json(f)| f)
                .map_err(failed),
            Ok("*".to_string())
        );
        let t = ticket(&state, &public.id, "https://anywhere.example", None, None)
            .await
            .expect("any parent");
        assert_eq!(
            room_of(
                &state,
                &public.id,
                scope(&t, "https://anywhere.example", &[]),
                None
            )
            .await,
            200
        );
        exec(
            db,
            &format!("UPDATE channels SET restrict_view = 1 WHERE id = {text}"),
        )
        .await;
        assert_eq!(
            code(
                &framing(State(state.clone()), Path(public.id.clone()))
                    .await
                    .map_err(failed)
            ),
            404
        );
        assert_eq!(
            room_of(
                &state,
                &public.id,
                scope(&t, "https://anywhere.example", &[]),
                None
            )
            .await,
            404
        );
        exec(
            db,
            &format!("UPDATE channels SET restrict_view = 0 WHERE id = {text}"),
        )
        .await;

        let link = made(&state, config(text, "read_link", &[HOST])).await;
        let key = link.read_key.clone().expect("a read key for managers");
        assert_eq!(
            code(&ticket(&state, &link.id, HOST, None, None).await),
            404,
            "no key"
        );
        assert_eq!(
            code(&ticket(&state, &link.id, HOST, Some("00".repeat(32)), None).await),
            404,
            "a wrong key"
        );
        let t = ticket(&state, &link.id, HOST, Some(key.clone()), None)
            .await
            .expect("the key");
        assert_eq!(
            room_of(&state, &link.id, scope(&t, HOST, &[]), None).await,
            200
        );
        site_sets(&state, serde_json::json!({ "widget_read_links": false })).await;
        assert_eq!(
            room_of(&state, &link.id, scope(&t, HOST, &[]), None).await,
            404,
            "read links turned off"
        );
        assert_eq!(
            code(&ticket(&state, &link.id, HOST, Some(key), None).await),
            404
        );
        site_sets(&state, serde_json::json!({ "widgets": false })).await;
        assert_eq!(
            room_of(&state, &public.id, scope(&t, HOST, &[]), None).await,
            404,
            "widgets turned off"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn frames_follow_the_reading_rules_of_their_channel() {
        let (state, path, text, voice) = world("widget_audience").await;
        let db = &state.db;
        let public = made(&state, config(text, "public_read", &[])).await;
        let t = ticket(&state, &public.id, HOST, None, None)
            .await
            .expect("ticket");
        let headers = || scope(&t, HOST, &[]);
        assert_eq!(room_of(&state, &public.id, headers(), None).await, 200);
        exec(
            db,
            "UPDATE servers SET public_read = 0 WHERE name = 'rchat'",
        )
        .await;
        assert_eq!(
            room_of(&state, &public.id, headers(), None).await,
            404,
            "the server closed to readers"
        );
        assert_eq!(
            room_of(&state, &public.id, headers(), Some("member")).await,
            404,
            "a public mode stays public"
        );
        exec(
            db,
            "UPDATE servers SET public_read = NULL WHERE name = 'rchat'",
        )
        .await;
        site_sets(&state, serde_json::json!({ "guests_enabled": false })).await;
        assert_eq!(
            room_of(&state, &public.id, headers(), None).await,
            404,
            "guests turned off"
        );
        site_sets(&state, serde_json::json!({ "guests_enabled": true })).await;

        for channel in [text, voice] {
            let members = made(&state, config(channel, "members", &[HOST])).await;
            let t = ticket(&state, &members.id, HOST, None, None)
                .await
                .expect("ticket");
            let headers = || scope(&t, HOST, &[]);
            assert_eq!(
                room_of(&state, &members.id, headers(), None).await,
                404,
                "a guest"
            );
            assert_eq!(
                room_of(&state, &members.id, headers(), Some("outsider")).await,
                404,
                "not a member"
            );
            assert_eq!(
                room_of(&state, &members.id, headers(), Some("member")).await,
                200
            );
        }
        let hidden = id_of(db, "INSERT INTO channels(server, name, restrict_view, created_at) VALUES('rchat', 'staff', 1, 0) RETURNING id").await;
        exec(db, &format!("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES({hidden}, 'u:manager', 1, 1, 1)")).await;
        let staff = made(&state, config(hidden, "members", &[HOST])).await;
        let t = ticket(&state, &staff.id, HOST, None, None)
            .await
            .expect("ticket");
        assert_eq!(
            room_of(&state, &staff.id, scope(&t, HOST, &[]), Some("member")).await,
            404,
            "a member who can't see it"
        );
        assert_eq!(
            room_of(&state, &staff.id, scope(&t, HOST, &[]), Some("manager")).await,
            200
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn frames_take_text_only_where_mode_composer_and_switches_allow() {
        let (state, path, text, _) = world("widget_posts").await;
        let db = &state.db;
        let frame = |mode: &'static str, composer: bool| {
            let state = state.clone();
            async move {
                let mut body = config(text, mode, &[HOST]);
                body["composer"] = composer.into();
                let w = made(&state, body).await;
                let t = ticket(
                    &state,
                    &w.id,
                    HOST,
                    mode.eq("read_link")
                        .then(|| w.read_key.clone().expect("key")),
                    None,
                )
                .await
                .expect("ticket");
                (w.id, t)
            }
        };
        let participate = |id: String, t: String, who: Option<&'static str>| {
            let state = state.clone();
            async move {
                view_of(&state, &id, scope(&t, HOST, &[]), who)
                    .await
                    .map(|v| v.participate)
            }
        };
        for (mode, composer) in [
            ("public_read", true),
            ("read_link", true),
            ("public_chat", false),
        ] {
            let (id, t) = frame(mode, composer).await;
            assert_eq!(
                participate(id.clone(), t.clone(), None).await,
                Ok(false),
                "{mode} {composer}"
            );
            assert_eq!(
                code(&post_as(&state, &id, scope(&t, HOST, &[]), None, say("hi")).await),
                404,
                "{mode} {composer}"
            );
        }
        let (chat, t) = frame("public_chat", true).await;
        let headers = |extra: &[(&str, &str)]| scope(&t, HOST, extra);
        for (site, server, open) in [
            (false, false, false),
            (true, false, false),
            (false, true, false),
            (true, true, true),
        ] {
            site_sets(&state, serde_json::json!({ "guest_chat_enabled": site })).await;
            exec(
                db,
                &format!(
                    "UPDATE servers SET guest_chat_opt_in = {} WHERE name = 'rchat'",
                    i64::from(server)
                ),
            )
            .await;
            assert_eq!(
                participate(chat.clone(), t.clone(), None).await,
                Ok(open),
                "site {site}, server {server}"
            );
            let sent = post_as(&state, &chat, headers(&[]), None, say("from the frame")).await;
            assert_eq!(
                code(&sent),
                if open { 200 } else { 404 },
                "site {site}, server {server}"
            );
        }
        let first = post_as(&state, &chat, headers(&[]), None, say("first"))
            .await
            .expect("guest post");
        let session = first.session.clone().expect("a guest session");
        let again = post_as(
            &state,
            &chat,
            headers(&[("x-guest-session", &session)]),
            None,
            say("again"),
        )
        .await
        .expect("again");
        assert_eq!(again.message.author.username, first.message.author.username);
        assert!(crate::ws::is_guest(&first.message.author.username));
        let root = first.message.id;
        assert_eq!(
            code(
                &post_as(
                    &state,
                    &chat,
                    headers(&[]),
                    None,
                    serde_json::json!({ "content": "x", "thread_root_id": root })
                )
                .await
            ),
            404,
            "no threads in a frame"
        );
        let account = post_as(
            &state,
            &chat,
            headers(&[]),
            Some("member"),
            say("as a member"),
        )
        .await
        .expect("member");
        assert_eq!(account.message.author.username, "member");
        assert!(account.session.is_none());
        assert_eq!(
            code(&post_as(&state, &chat, headers(&[]), Some("outsider"), say("x")).await),
            404,
            "an account that can't send here"
        );
        let Json(_) = guest_chat::pause(
            State(state.clone()),
            Authed(mem_user("manager", false)),
            Path(first.message.id),
        )
        .await
        .expect("pause");
        assert_eq!(
            participate(chat.clone(), t.clone(), None).await,
            Ok(false),
            "a new guest from the same address"
        );
        let elsewhere = std::net::IpAddr::from([10, 0, 0, 2]);
        assert_eq!(
            crate::api::budget::as_client(elsewhere, participate(chat.clone(), t.clone(), None))
                .await,
            Ok(true),
            "a guest from another address"
        );
        let paused = view_of(
            &state,
            &chat,
            headers(&[("x-guest-session", &session)]),
            None,
        )
        .await
        .expect("view");
        assert!(!paused.participate, "the paused guest");
        site_sets(&state, serde_json::json!({ "widget_chat": false })).await;
        assert_eq!(
            participate(chat.clone(), t.clone(), Some("member")).await,
            Ok(false),
            "widget chat off"
        );
        assert_eq!(
            code(&post_as(&state, &chat, headers(&[]), Some("member"), say("x")).await),
            404
        );
        site_sets(&state, serde_json::json!({ "widget_chat": true })).await;
        let (members, mt) = frame("members", true).await;
        let sent = post_as(
            &state,
            &members,
            scope(&mt, HOST, &[]),
            Some("member"),
            say("members only"),
        )
        .await
        .expect("member");
        assert_eq!(sent.message.author.username, "member");
        assert_eq!(
            code(&post_as(&state, &members, scope(&mt, HOST, &[]), None, say("x")).await),
            404,
            "a guest in a members frame"
        );
        exec(
            db,
            &format!("UPDATE channels SET restrict_send = 1 WHERE id = {text}"),
        )
        .await;
        assert_eq!(
            participate(chat.clone(), t.clone(), None).await,
            Ok(false),
            "a read-only channel"
        );
        assert_eq!(
            code(&post_as(&state, &chat, headers(&[]), None, say("x")).await),
            404
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn voice_frames_take_passwords_and_follow_guest_voice() {
        let (state, path, text, voice) = world("widget_voice").await;
        let db = &state.db;
        let chat = made(&state, config(text, "public_chat", &[HOST])).await;
        let t = ticket(&state, &chat.id, HOST, None, None)
            .await
            .expect("ticket");
        let body =
            || Json(serde_json::from_value(serde_json::json!({ "password": "x" })).expect("body"));
        assert_eq!(
            code(
                &guest_access(
                    State(state.clone()),
                    Path(chat.id.clone()),
                    scope(&t, HOST, &[]),
                    body()
                )
                .await
                .map_err(failed)
            ),
            404,
            "a chat frame"
        );
        let locate = |id: String, t: String, ids: Vec<i64>| {
            let state = state.clone();
            async move {
                let req = serde_json::from_value(serde_json::json!({ "ids": ids })).expect("ids");
                locations(
                    State(state),
                    viewer(None),
                    Path(id),
                    scope(&t, HOST, &[]),
                    Json(req),
                )
                .await
                .map(|Json(found)| found.len())
                .map_err(failed)
            }
        };
        let here = id_of(db, &format!("INSERT INTO messages(channel_id, author, content, created_at) VALUES({text}, 'member', 'here', 1) RETURNING id")).await;
        let other = id_of(db, "INSERT INTO channels(server, name, created_at) VALUES('rchat', 'other', 0) RETURNING id").await;
        let away = id_of(db, &format!("INSERT INTO messages(channel_id, author, content, created_at) VALUES({other}, 'member', 'away', 1) RETURNING id")).await;
        assert_eq!(
            locate(chat.id.clone(), t.clone(), vec![here, away]).await,
            Ok(1),
            "only its own channel"
        );

        let room = made(&state, config(voice, "voice", &[])).await;
        let t = ticket(&state, &room.id, HOST, None, None)
            .await
            .expect("ticket");
        assert_eq!(
            code(&locate(room.id.clone(), t.clone(), vec![here]).await),
            404,
            "a voice frame has no cards"
        );
        let participate = || async {
            view_of(&state, &room.id, scope(&t, HOST, &[]), None)
                .await
                .map(|v| v.participate)
        };
        assert_eq!(participate().await, Ok(true));
        assert_eq!(
            code(&post_as(&state, &room.id, scope(&t, HOST, &[]), None, say("x")).await),
            404,
            "no text in voice"
        );
        for (site, server) in [(false, true), (true, false), (false, false)] {
            site_sets(&state, serde_json::json!({ "guest_voice_enabled": site })).await;
            exec(
                db,
                &format!(
                    "UPDATE servers SET guest_voice_opt_in = {} WHERE name = 'rchat'",
                    i64::from(server)
                ),
            )
            .await;
            assert_eq!(
                participate().await,
                Ok(false),
                "site {site}, server {server}"
            );
            assert_eq!(
                view_of(&state, &room.id, scope(&t, HOST, &[]), Some("member"))
                    .await
                    .map(|v| v.participate),
                Ok(true),
                "members keep their own rights"
            );
        }

        let hash = crate::api::auth::hash_password("vault password")
            .await
            .expect("hash");
        sqlx::query("INSERT INTO servers(name, display_name, creator, password_hash, guest_voice_opt_in, created_at) VALUES('vault', 'Vault', 'manager', $1, 1, 0)")
            .bind(hash)
            .execute(db)
            .await
            .expect("vault");
        site_sets(&state, serde_json::json!({ "guest_voice_enabled": true })).await;
        add_member(db, "vault", "manager", 1, 0, 0).await;
        let vault_voice = id_of(db, "INSERT INTO channels(server, name, kind, created_at) VALUES('vault', 'booth', 'voice', 0) RETURNING id").await;
        let vault_config: WidgetConfig =
            serde_json::from_value(config(vault_voice, "voice", &[HOST])).expect("config");
        let Json(locked) = save(
            &state,
            &mem_user("manager", false),
            "vault",
            None,
            vault_config,
        )
        .await
        .expect("vault widget");
        let t = ticket(&state, &locked.id, HOST, None, None)
            .await
            .expect("ticket");
        assert_eq!(
            room_of(&state, &locked.id, scope(&t, HOST, &[]), None).await,
            404,
            "no password yet"
        );
        let wrong = guest_access(
            State(state.clone()),
            Path(locked.id.clone()),
            scope(&t, HOST, &[]),
            body(),
        )
        .await;
        assert!(wrong.is_err(), "a wrong password");
        let right = Json(
            serde_json::from_value(serde_json::json!({ "password": "vault password" }))
                .expect("body"),
        );
        let Json(granted) = guest_access(
            State(state.clone()),
            Path(locked.id.clone()),
            scope(&t, HOST, &[]),
            right,
        )
        .await
        .expect("the password");
        let grant = serde_json::to_value(&granted).expect("grant")["grant"]
            .as_str()
            .expect("a grant")
            .to_string();
        assert_eq!(
            room_of(
                &state,
                &locked.id,
                scope(&t, HOST, &[("x-guest-grant", &grant)]),
                None
            )
            .await,
            200
        );
        assert_eq!(
            view_of(
                &state,
                &locked.id,
                scope(&t, HOST, &[("x-guest-grant", &grant)]),
                None
            )
            .await
            .map(|v| v.participate),
            Ok(true)
        );
        done(state, path).await;
    }
}
