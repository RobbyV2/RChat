use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use utoipa::ToSchema;

use crate::api::access::perms::Perm;
use crate::api::access::{Proof, not_found, resolve_separator, resolve_server};
use crate::api::audit::{self, Action, Actor, Details, Entry, Target, TargetKind};
use crate::api::categories::{NEXT_POSITION, announce, bump, load_layout};
use crate::api::{
    ApiError, ApiErrorBody, Authed, ChannelLayout, NAME_MAX, OkResp, ProfanityTarget, Separator,
    check_profanity, ok,
};
use crate::db::Db;
use crate::state::AppState;

/// How a category header is drawn.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum CategoryStyle {
    /// The name in small capitals.
    #[default]
    Default,
    /// The name exactly as written, followed by a dotted line.
    Dots,
    /// The name exactly as written, followed by a solid line.
    Line,
}

impl CategoryStyle {
    pub fn as_str(self) -> &'static str {
        match self {
            CategoryStyle::Default => "default",
            CategoryStyle::Dots => "dots",
            CategoryStyle::Line => "line",
        }
    }

    /// The stored column; anything unknown reads as `default`.
    pub fn stored(value: &str) -> Self {
        match value {
            "dots" => CategoryStyle::Dots,
            "line" => CategoryStyle::Line,
            _ => CategoryStyle::Default,
        }
    }
}

/// How a separator line is drawn.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum SeparatorStyle {
    /// The label followed by a dotted line.
    #[default]
    Dots,
    /// The label followed by a solid line.
    Line,
    /// The label alone, without a line (a bare line when the label is empty).
    Plain,
}

impl SeparatorStyle {
    pub fn as_str(self) -> &'static str {
        match self {
            SeparatorStyle::Dots => "dots",
            SeparatorStyle::Line => "line",
            SeparatorStyle::Plain => "plain",
        }
    }

    /// The stored column; anything unknown reads as `dots`.
    pub fn stored(value: &str) -> Self {
        match value {
            "line" => SeparatorStyle::Line,
            "plain" => SeparatorStyle::Plain,
            _ => SeparatorStyle::Dots,
        }
    }
}

/// Request body for creating a separator.
#[derive(Deserialize, ToSchema)]
pub struct NewSeparatorReq {
    /// Text on the line, kept exactly as written after trimming surrounding whitespace: at most
    /// 100 characters, no control characters, and it must pass the category-name profanity
    /// filter. Empty or left out: a bare line.
    #[serde(default)]
    #[schema(example = "updates")]
    label: String,
    /// How the line is drawn; `dots` when left out.
    #[serde(default)]
    style: SeparatorStyle,
    /// Category to list it at the end of; `null` or left out lists it at the end of the channels
    /// without one.
    #[serde(default)]
    category_id: Option<i64>,
}

/// Request body for changing a separator. Fields left out stay as they are. Its place changes
/// with `PUT /api/v1/servers/{name}/layout`.
#[derive(Deserialize, ToSchema)]
pub struct SeparatorPatch {
    /// New text on the line, as for creating one; empty for a bare line.
    #[serde(default)]
    label: Option<String>,
    /// New style.
    #[serde(default)]
    style: Option<SeparatorStyle>,
}

async fn clean_label(db: &Db, raw: &str) -> Result<String, ApiError> {
    let label = raw.trim().to_string();
    if label.chars().count() > NAME_MAX {
        return Err(ApiError::invalid(
            format!("Separator label must be at most {NAME_MAX} characters"),
            "label",
        ));
    }
    if label.chars().any(char::is_control) {
        return Err(ApiError::invalid(
            "Separator label cannot contain control characters",
            "label",
        ));
    }
    if !label.is_empty() {
        check_profanity(db, ProfanityTarget::CategoryNames, &label).await?;
    }
    Ok(label)
}

fn separator_entry(server: &str, actor: &Actor, action: Action, id: i64, label: &str) -> Entry {
    Entry::new(server, actor, action).target(Target::with_id(
        TargetKind::Separator,
        id,
        (!label.is_empty()).then_some(label),
    ))
}

fn placed(layout: Option<&ChannelLayout>, id: i64) -> Result<Separator, ApiError> {
    layout
        .and_then(|l| l.separators.iter().find(|s| s.id == id))
        .cloned()
        .ok_or_else(not_found)
}

/// Create a separator
///
/// Adds a decorative separator, a line with an optional label, at the end of a category or of
/// the channels without one. A server can have at most 50 separators by default
/// (`SERVER_SEPARATORS_MAX`). Requires the Manage channels permission. Raises the layout version
/// and emits `layout_changed` to the server. General rate-limit bucket.
#[utoipa::path(
    post,
    path = "/api/v1/servers/{name}/separators",
    tag = "Channels",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    request_body = NewSeparatorReq,
    responses(
        (status = 200, description = "The created separator", body = Separator),
        (status = 400, description = "Invalid label (longer than 100 characters, with control characters or blocked by the profanity filter; reason `invalid`) or `A server can have at most 50 separators` with the configured number (`SERVER_SEPARATORS_MAX`, reason `limit`). Malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Manage channels permission", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses). `Not found`: `category_id` is not a category of this server", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn create_separator(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Json(req): Json<NewSeparatorReq>,
) -> Result<Json<Separator>, ApiError> {
    let NewSeparatorReq {
        label,
        style,
        category_id,
    } = req;
    let label = clean_label(&state.db, &label).await?;
    let access =
        resolve_server(&state.db, &name.to_lowercase(), Some(&user), &Proof::none()).await?;
    access.require_perm(&state.db, Perm::ManageChannels).await?;
    let server = access.name().to_string();
    let actor = access.audit_actor(&state.db, Perm::ManageChannels).await?;
    let mut tx = state.db.begin().await?;
    bump(&mut tx, &server, None).await?;
    let before = load_layout(&mut tx, &server).await?;
    let count: i64 = sqlx::query("SELECT COUNT(*) FROM channel_separators WHERE server = $1")
        .bind(&server)
        .fetch_one(&mut *tx)
        .await?
        .try_get(0)?;
    let most = state.limits.server_separators_max;
    if count >= most {
        return Err(ApiError::limit(
            StatusCode::BAD_REQUEST,
            format!("A server can have at most {most} separators"),
            &rchat_settings::items::SERVER_SEPARATORS_MAX,
        ));
    }
    let sql = format!(
        "INSERT INTO channel_separators(server, category_id, label, style, position, created_at) SELECT $1, $2, $3, $4, {NEXT_POSITION}, $5 WHERE $2 IS NULL OR EXISTS(SELECT 1 FROM channel_categories WHERE id = $2 AND server = $1) RETURNING id"
    );
    let id: i64 = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(&server)
        .bind(category_id)
        .bind(&label)
        .bind(style.as_str())
        .bind(state.clock.unix())
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(not_found)?
        .try_get(0)?;
    audit::record(
        &mut tx,
        separator_entry(&server, &actor, Action::SeparatorCreate, id, &label).details(
            Details::new()
                .change("label", None::<String>, label.as_str())
                .change("style", None::<String>, style.as_str()),
        ),
    )
    .await?;
    let layout = load_layout(&mut tx, &server).await?;
    tx.commit().await?;
    let separator = placed(layout.as_ref(), id)?;
    if let Some(layout) = layout {
        announce(&state, &server, layout, None, before);
    }
    Ok(Json(separator))
}

/// Change a separator
///
/// Changes the label or style of a separator. Requires the Manage channels permission in its
/// server. Raises the layout version and emits `layout_changed` to the server. General
/// rate-limit bucket.
#[utoipa::path(
    patch,
    path = "/api/v1/separators/{id}",
    tag = "Channels",
    params(("id" = i64, Path, description = "Separator id")),
    request_body = SeparatorPatch,
    responses(
        (status = 200, description = "The changed separator", body = Separator),
        (status = 400, description = "Invalid label (longer than 100 characters, with control characters or blocked by the profanity filter; reason `invalid`). A non-integer `id`, malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 404, description = "`Not found`: no such separator, one in a server you have no access to, or you lack the Manage channels permission there (identical responses)", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn update_separator(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(id): Path<i64>,
    Json(req): Json<SeparatorPatch>,
) -> Result<Json<Separator>, ApiError> {
    let access = resolve_separator(&state.db, id, &user).await?;
    let SeparatorPatch { label, style } = req;
    let label = match label {
        Some(raw) => Some(clean_label(&state.db, &raw).await?),
        None => None,
    };
    let server = access.name().to_string();
    let actor = access.audit_actor(&state.db, Perm::ManageChannels).await?;
    let mut tx = state.db.begin().await?;
    bump(&mut tx, &server, None).await?;
    let before = load_layout(&mut tx, &server).await?;
    let was = placed(before.as_ref(), id)?;
    let label = label.unwrap_or_else(|| was.label.clone());
    let style = style.unwrap_or(was.style);
    sqlx::query(
        "UPDATE channel_separators SET label = $1, style = $2 WHERE id = $3 AND server = $4",
    )
    .bind(&label)
    .bind(style.as_str())
    .bind(id)
    .bind(&server)
    .execute(&mut *tx)
    .await?;
    let changes = Details::new()
        .change("label", was.label.as_str(), label.as_str())
        .change("style", was.style.as_str(), style.as_str());
    if changes.has_changes() {
        audit::record(
            &mut tx,
            separator_entry(&server, &actor, Action::SeparatorUpdate, id, &label).details(changes),
        )
        .await?;
    }
    let layout = load_layout(&mut tx, &server).await?;
    tx.commit().await?;
    let separator = placed(layout.as_ref(), id)?;
    if let Some(layout) = layout {
        announce(&state, &server, layout, None, before);
    }
    Ok(Json(separator))
}

/// Delete a separator
///
/// Deletes a separator; the channels around it stay where they are. Requires the Manage
/// channels permission in its server. Raises the layout version and emits `layout_changed` to
/// the server. General rate-limit bucket.
#[utoipa::path(
    delete,
    path = "/api/v1/separators/{id}",
    tag = "Channels",
    params(("id" = i64, Path, description = "Separator id")),
    responses(
        (status = 200, description = "Separator deleted", body = OkResp),
        (status = 400, description = "A non-integer `id` gives a plain-text 400", content_type = "text/plain", body = String),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 404, description = "`Not found`: no such separator, one in a server you have no access to, or you lack the Manage channels permission there (identical responses)", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn delete_separator(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(id): Path<i64>,
) -> Result<Json<OkResp>, ApiError> {
    let access = resolve_separator(&state.db, id, &user).await?;
    let server = access.name().to_string();
    let actor = access.audit_actor(&state.db, Perm::ManageChannels).await?;
    let mut tx = state.db.begin().await?;
    bump(&mut tx, &server, None).await?;
    let before = load_layout(&mut tx, &server).await?;
    let gone = placed(before.as_ref(), id)?;
    sqlx::query("DELETE FROM channel_separators WHERE id = $1 AND server = $2")
        .bind(id)
        .bind(&server)
        .execute(&mut *tx)
        .await?;
    audit::record(
        &mut tx,
        separator_entry(&server, &actor, Action::SeparatorDelete, id, &gone.label).details(
            Details::new()
                .change("label", gone.label.as_str(), None::<String>)
                .change("style", gone.style.as_str(), None::<String>),
        ),
    )
    .await?;
    let layout = load_layout(&mut tx, &server).await?;
    tx.commit().await?;
    if let Some(layout) = layout {
        announce(&state, &server, layout, None, before);
    }
    Ok(ok())
}

#[cfg(test)]
mod tests;
