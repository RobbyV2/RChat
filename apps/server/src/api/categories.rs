use std::collections::{HashMap, HashSet};

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::Deserialize;
use sqlx::{AnyConnection, Row};
use utoipa::ToSchema;

use crate::api::access::{Proof, resolve_category, resolve_server};
use crate::api::audit::{self, Action, Actor, Details, Entry, Target, TargetKind};
use crate::api::servers::{CHANNEL_MAX, check_name};
use crate::api::{
    ApiError, ApiErrorBody, Authed, Category, ChannelLayout, LayoutCategory, OkResp,
    ProfanityTarget, bad, ok,
};
use crate::db::{Db, Perm, now};
use crate::state::AppState;
use crate::ws::WsEvent;

pub const CATEGORY_MAX: i64 = 100;

const STALE: &str = "The channel list changed. Reload it and try again";

/// Request body for creating or renaming a channel category.
#[derive(Deserialize, ToSchema)]
pub struct CategoryReq {
    /// Category name. Surrounding whitespace is trimmed; must not be blank, at most 100
    /// characters and must pass the category-name profanity filter. Names may repeat.
    #[schema(example = "Games")]
    name: String,
}

/// A category and its channels in a new layout.
#[derive(Deserialize, ToSchema)]
pub struct CategoryOrder {
    /// Category id.
    id: i64,
    /// Ids of the channels to list under it, top first.
    channels: Vec<i64>,
}

/// Request body for reordering a server's channel list. Together, `uncategorized` and the
/// `channels` of every category must list each channel of the server exactly once, and
/// `categories` must list each category exactly once.
#[derive(Deserialize, ToSchema)]
pub struct LayoutReq {
    /// The `layout_version` the order is based on.
    version: i64,
    /// Ids of channels without a category, top first.
    uncategorized: Vec<i64>,
    /// Categories, top first, with their channels.
    categories: Vec<CategoryOrder>,
}

fn conflict() -> ApiError {
    ApiError(StatusCode::CONFLICT, STALE.to_string())
}

pub(crate) async fn server_categories(db: &Db, server: &str) -> Result<Vec<Category>, ApiError> {
    let rows = sqlx::query(
        "SELECT id, name, position FROM channel_categories WHERE server = $1 ORDER BY position, id",
    )
    .bind(server)
    .fetch_all(db)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        out.push(Category {
            id: r.try_get(0)?,
            name: r.try_get(1)?,
            position: r.try_get(2)?,
        });
    }
    Ok(out)
}

pub(crate) async fn layout_version(db: &Db, server: &str) -> Result<i64, ApiError> {
    Ok(
        sqlx::query("SELECT layout_version FROM servers WHERE name = $1")
            .bind(server)
            .fetch_optional(db)
            .await?
            .map(|r| r.try_get::<i64, _>(0))
            .transpose()?
            .unwrap_or(0),
    )
}

/// The full layout of `server` as stored, `None` when the server is gone. Channels whose
/// category no longer exists count as uncategorized.
pub(crate) async fn load_layout(
    conn: &mut AnyConnection,
    server: &str,
) -> sqlx::Result<Option<ChannelLayout>> {
    let Some(row) = sqlx::query("SELECT layout_version FROM servers WHERE name = $1")
        .bind(server)
        .fetch_optional(&mut *conn)
        .await?
    else {
        return Ok(None);
    };
    let version: i64 = row.try_get(0)?;
    let cats = sqlx::query(
        "SELECT id, name FROM channel_categories WHERE server = $1 ORDER BY position, id",
    )
    .bind(server)
    .fetch_all(&mut *conn)
    .await?;
    let mut categories = Vec::with_capacity(cats.len());
    for r in &cats {
        categories.push(LayoutCategory {
            id: r.try_get(0)?,
            name: r.try_get(1)?,
            channels: Vec::new(),
        });
    }
    let at: HashMap<i64, usize> = categories
        .iter()
        .enumerate()
        .map(|(i, c)| (c.id, i))
        .collect();
    let rows =
        sqlx::query("SELECT id, category_id FROM channels WHERE server = $1 ORDER BY position, id")
            .bind(server)
            .fetch_all(&mut *conn)
            .await?;
    let mut uncategorized = Vec::new();
    for r in &rows {
        let id: i64 = r.try_get(0)?;
        let category: Option<i64> = r.try_get(1)?;
        match category.and_then(|c| at.get(&c)) {
            Some(i) => categories[*i].channels.push(id),
            None => uncategorized.push(id),
        }
    }
    Ok(Some(ChannelLayout {
        version,
        uncategorized,
        categories,
    }))
}

pub(crate) async fn current_layout(db: &Db, server: &str) -> sqlx::Result<Option<ChannelLayout>> {
    let mut conn = db.acquire().await?;
    load_layout(&mut conn, server).await
}

/// Channel ids of a layout in list order: channels without a category, then each category's.
pub(crate) fn listed(layout: &ChannelLayout) -> Vec<i64> {
    layout
        .uncategorized
        .iter()
        .chain(layout.categories.iter().flat_map(|c| c.channels.iter()))
        .copied()
        .collect()
}

/// Channel ids of `server` in list order; empty when the server is gone.
pub(crate) async fn channel_order(db: &Db, server: &str) -> sqlx::Result<Vec<i64>> {
    Ok(current_layout(db, server)
        .await?
        .map(|layout| listed(&layout))
        .unwrap_or_default())
}

/// Where `id` sits in `order` counting only the ids `visible` accepts: positions in a payload
/// are always dense within the list its reader can see.
pub(crate) fn rank(order: &[i64], id: i64, mut visible: impl FnMut(i64) -> bool) -> i64 {
    order
        .iter()
        .take_while(|c| **c != id)
        .filter(|c| visible(**c))
        .count() as i64
}

/// Raises the layout version of `server`, only from `expect` when given. False when the
/// version moved on (or the server is gone).
pub(crate) async fn bump(
    conn: &mut AnyConnection,
    server: &str,
    expect: Option<i64>,
) -> sqlx::Result<bool> {
    let done = match expect {
        Some(version) => {
            sqlx::query("UPDATE servers SET layout_version = layout_version + 1 WHERE name = $1 AND layout_version = $2")
                .bind(server)
                .bind(version)
                .execute(&mut *conn)
                .await?
        }
        None => {
            sqlx::query("UPDATE servers SET layout_version = layout_version + 1 WHERE name = $1")
                .bind(server)
                .execute(&mut *conn)
                .await?
        }
    };
    Ok(done.rows_affected() == 1)
}

/// Stores `layout` as the order of `server`: category positions follow `categories`, channel
/// positions run through the whole list. Rows that already match are left alone.
pub(crate) async fn write_layout(
    conn: &mut AnyConnection,
    server: &str,
    layout: &ChannelLayout,
) -> sqlx::Result<()> {
    let cats = sqlx::query("SELECT id, position FROM channel_categories WHERE server = $1")
        .bind(server)
        .fetch_all(&mut *conn)
        .await?;
    let mut had = HashMap::new();
    for r in &cats {
        had.insert(r.try_get::<i64, _>(0)?, r.try_get::<i64, _>(1)?);
    }
    for (pos, c) in layout.categories.iter().enumerate() {
        let pos = pos as i64;
        if had.get(&c.id) != Some(&pos) {
            sqlx::query("UPDATE channel_categories SET position = $1 WHERE id = $2")
                .bind(pos)
                .bind(c.id)
                .execute(&mut *conn)
                .await?;
        }
    }
    let rows = sqlx::query("SELECT id, category_id, position FROM channels WHERE server = $1")
        .bind(server)
        .fetch_all(&mut *conn)
        .await?;
    let mut was = HashMap::new();
    for r in &rows {
        was.insert(
            r.try_get::<i64, _>(0)?,
            (r.try_get::<Option<i64>, _>(1)?, r.try_get::<i64, _>(2)?),
        );
    }
    let mut places: Vec<(i64, Option<i64>)> =
        layout.uncategorized.iter().map(|id| (*id, None)).collect();
    for c in &layout.categories {
        places.extend(c.channels.iter().map(|id| (*id, Some(c.id))));
    }
    for (pos, (id, category)) in places.into_iter().enumerate() {
        let pos = pos as i64;
        if was.get(&id) != Some(&(category, pos)) {
            sqlx::query("UPDATE channels SET category_id = $1, position = $2 WHERE id = $3")
                .bind(category)
                .bind(pos)
                .bind(id)
                .execute(&mut *conn)
                .await?;
        }
    }
    Ok(())
}

/// Emits `layout_changed`. With `created`, only connections that can view that new channel get
/// it, so creating a hidden channel tells nobody else anything.
pub(crate) fn announce(
    state: &AppState,
    server: &str,
    layout: ChannelLayout,
    created: Option<i64>,
) {
    state.hub.broadcast(WsEvent::LayoutChanged {
        server: server.to_string(),
        layout,
        created,
        deleted: None,
    });
}

async fn clean_name(db: &Db, raw: &str) -> Result<String, ApiError> {
    let name = raw.trim().to_string();
    check_name(db, ProfanityTarget::CategoryNames, "Category name", &name).await?;
    Ok(name)
}

/// Create a category
///
/// Adds a channel category at the bottom of the server's channel list. A server can have at
/// most 100 categories. Requires the Manage channels permission. Raises the layout version and
/// emits `layout_changed` to the server. General rate-limit bucket.
#[utoipa::path(
    post,
    path = "/api/servers/{name}/categories",
    tag = "Channels",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    request_body = CategoryReq,
    responses(
        (status = 200, description = "The created category", body = Category),
        (status = 400, description = "Invalid category name (blank, longer than 100 characters or blocked by the profanity filter) or the server already has 100 categories. Malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Manage channels permission", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses)", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn create_category(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Json(req): Json<CategoryReq>,
) -> Result<Json<Category>, ApiError> {
    let category_name = clean_name(&state.db, &req.name).await?;
    let access =
        resolve_server(&state.db, &name.to_lowercase(), Some(&user), &Proof::none()).await?;
    access.require_perm(&state.db, Perm::ManageChannels).await?;
    let server = access.name().to_string();
    let actor = access.audit_actor(&state.db, Perm::ManageChannels).await?;
    let mut tx = state.db.begin().await?;
    bump(&mut tx, &server, None).await?;
    let count: i64 = sqlx::query("SELECT COUNT(*) FROM channel_categories WHERE server = $1")
        .bind(&server)
        .fetch_one(&mut *tx)
        .await?
        .try_get(0)?;
    if count >= CATEGORY_MAX {
        return Err(bad(&format!(
            "A server can have at most {CATEGORY_MAX} categories"
        )));
    }
    let row = sqlx::query(
        "INSERT INTO channel_categories(server, name, position, created_at) SELECT $1, $2, COALESCE(MAX(position) + 1, 0), $3 FROM channel_categories WHERE server = $1 RETURNING id, position",
    )
    .bind(&server)
    .bind(&category_name)
    .bind(now())
    .fetch_one(&mut *tx)
    .await?;
    let category = Category {
        id: row.try_get(0)?,
        name: category_name,
        position: row.try_get(1)?,
    };
    audit::record(
        &mut tx,
        category_entry(&server, &actor, Action::CategoryCreate, &category)
            .details(Details::new().change("name", None::<String>, category.name.as_str())),
    )
    .await?;
    let layout = load_layout(&mut tx, &server).await?;
    tx.commit().await?;
    if let Some(layout) = layout {
        announce(&state, &server, layout, None);
    }
    Ok(Json(category))
}

/// Rename a category
///
/// Renames a channel category. Requires the Manage channels permission in its server. Raises
/// the layout version and emits `layout_changed` to the server. General rate-limit bucket.
#[utoipa::path(
    patch,
    path = "/api/categories/{id}",
    tag = "Channels",
    params(("id" = i64, Path, description = "Category id")),
    request_body = CategoryReq,
    responses(
        (status = 200, description = "The renamed category", body = Category),
        (status = 400, description = "Invalid category name (blank, longer than 100 characters or blocked by the profanity filter). A non-integer `id`, malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 404, description = "`Not found`: no such category, one in a server you have no access to, or you lack the Manage channels permission there (identical responses)", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn rename_category(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(id): Path<i64>,
    Json(req): Json<CategoryReq>,
) -> Result<Json<Category>, ApiError> {
    let access = resolve_category(&state.db, id, &user).await?;
    let category_name = clean_name(&state.db, &req.name).await?;
    let server = access.name().to_string();
    let actor = access.audit_actor(&state.db, Perm::ManageChannels).await?;
    let mut tx = state.db.begin().await?;
    bump(&mut tx, &server, None).await?;
    let was: Option<String> =
        sqlx::query("SELECT name FROM channel_categories WHERE id = $1 AND server = $2")
            .bind(id)
            .bind(&server)
            .fetch_optional(&mut *tx)
            .await?
            .map(|r| r.try_get(0))
            .transpose()?;
    let row = sqlx::query(
        "UPDATE channel_categories SET name = $1 WHERE id = $2 AND server = $3 RETURNING position",
    )
    .bind(&category_name)
    .bind(id)
    .bind(&server)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(crate::api::access::not_found)?;
    let category = Category {
        id,
        name: category_name,
        position: row.try_get(0)?,
    };
    let changes = Details::new().change("name", was, category.name.as_str());
    if changes.has_changes() {
        audit::record(
            &mut tx,
            category_entry(&server, &actor, Action::CategoryUpdate, &category).details(changes),
        )
        .await?;
    }
    let layout = load_layout(&mut tx, &server).await?;
    tx.commit().await?;
    if let Some(layout) = layout {
        announce(&state, &server, layout, None);
    }
    Ok(Json(category))
}

/// Delete a category
///
/// Deletes a channel category. Its channels move to the end of the channels without a
/// category, in the same order; no channel is deleted. Requires the Manage channels permission
/// in its server. Raises the layout version and emits `layout_changed` to the server. General
/// rate-limit bucket.
#[utoipa::path(
    delete,
    path = "/api/categories/{id}",
    tag = "Channels",
    params(("id" = i64, Path, description = "Category id")),
    responses(
        (status = 200, description = "Category deleted", body = OkResp),
        (status = 400, description = "A non-integer `id` gives a plain-text 400", content_type = "text/plain", body = String),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 404, description = "`Not found`: no such category, one in a server you have no access to, or you lack the Manage channels permission there (identical responses)", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn delete_category(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(id): Path<i64>,
) -> Result<Json<OkResp>, ApiError> {
    let access = resolve_category(&state.db, id, &user).await?;
    let server = access.name().to_string();
    let actor = access.audit_actor(&state.db, Perm::ManageChannels).await?;
    let mut tx = state.db.begin().await?;
    bump(&mut tx, &server, None).await?;
    let mut layout = load_layout(&mut tx, &server)
        .await?
        .ok_or_else(crate::api::access::not_found)?;
    let Some(at) = layout.categories.iter().position(|c| c.id == id) else {
        return Err(crate::api::access::not_found());
    };
    let gone = layout.categories.remove(at);
    audit::record(
        &mut tx,
        Entry::new(&server, &actor, Action::CategoryDelete)
            .target(Target::with_id(TargetKind::Category, id, Some(&gone.name)))
            .details(Details::new().change("name", gone.name.as_str(), None::<String>)),
    )
    .await?;
    layout.uncategorized.extend(gone.channels);
    write_layout(&mut tx, &server, &layout).await?;
    sqlx::query("DELETE FROM channel_categories WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    announce(&state, &server, layout, None);
    Ok(ok())
}

type Shape = (Vec<i64>, Vec<(i64, Vec<i64>)>);

fn shape(layout: &ChannelLayout) -> Shape {
    (
        layout.uncategorized.clone(),
        layout
            .categories
            .iter()
            .map(|c| (c.id, c.channels.clone()))
            .collect(),
    )
}

fn category_entry(server: &str, actor: &Actor, action: Action, category: &Category) -> Entry {
    Entry::new(server, actor, action).target(Target::with_id(
        TargetKind::Category,
        category.id,
        Some(&category.name),
    ))
}

fn check_order(req: &LayoutReq, current: &ChannelLayout) -> Result<(), ApiError> {
    let wrong = || bad("The order must list every channel and category exactly once");
    let want_cats: HashSet<i64> = current.categories.iter().map(|c| c.id).collect();
    let mut cats = HashSet::new();
    for c in &req.categories {
        if !want_cats.contains(&c.id) || !cats.insert(c.id) {
            return Err(wrong());
        }
    }
    if cats.len() != want_cats.len() {
        return Err(wrong());
    }
    let want: HashSet<i64> = current
        .uncategorized
        .iter()
        .chain(current.categories.iter().flat_map(|c| c.channels.iter()))
        .copied()
        .collect();
    let mut seen = HashSet::new();
    for id in req
        .uncategorized
        .iter()
        .chain(req.categories.iter().flat_map(|c| c.channels.iter()))
    {
        if !want.contains(id) || !seen.insert(*id) {
            return Err(wrong());
        }
    }
    match seen.len() == want.len() {
        true => Ok(()),
        false => Err(wrong()),
    }
}

/// Reorder channels and categories
///
/// Replaces the order of the server's channel list: which category each channel is in, the
/// order of channels within it and the order of the categories. The body must list every
/// channel and category of the server exactly once and name the `layout_version` it is based
/// on; when the layout changed since, nothing is stored and the answer is 409, so reload the
/// server and try again. Of two concurrent reorders from the same version, one wins and the
/// other gets 409. Requires the Manage channels permission. Raises the layout version and
/// emits `layout_changed` to the server, where each connection only gets the channels it can
/// see. General rate-limit bucket.
#[utoipa::path(
    put,
    path = "/api/servers/{name}/layout",
    tag = "Channels",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    request_body = LayoutReq,
    responses(
        (status = 200, description = "The stored layout with its new version", body = ChannelLayout),
        (status = 400, description = "`The order must list every channel and category exactly once`: an id is missing, repeated or not part of this server. Malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Manage channels permission", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses)", body = ApiErrorBody),
        (status = 409, description = "`The channel list changed. Reload it and try again`: `version` is not the current layout version", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn reorder_layout(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Json(req): Json<LayoutReq>,
) -> Result<Json<ChannelLayout>, ApiError> {
    let listed = req.uncategorized.len()
        + req
            .categories
            .iter()
            .map(|c| c.channels.len())
            .sum::<usize>();
    if listed as i64 > CHANNEL_MAX || req.categories.len() as i64 > CATEGORY_MAX {
        return Err(bad(
            "The order must list every channel and category exactly once",
        ));
    }
    let access =
        resolve_server(&state.db, &name.to_lowercase(), Some(&user), &Proof::none()).await?;
    access.require_perm(&state.db, Perm::ManageChannels).await?;
    let server = access.name().to_string();
    let actor = access.audit_actor(&state.db, Perm::ManageChannels).await?;
    let mut tx = state.db.begin().await?;
    if !bump(&mut tx, &server, Some(req.version)).await? {
        return Err(conflict());
    }
    let current = load_layout(&mut tx, &server)
        .await?
        .ok_or_else(crate::api::access::not_found)?;
    check_order(&req, &current)?;
    let was = shape(&current);
    let names: HashMap<i64, String> = current
        .categories
        .into_iter()
        .map(|c| (c.id, c.name))
        .collect();
    let layout = ChannelLayout {
        version: current.version,
        uncategorized: req.uncategorized,
        categories: req
            .categories
            .into_iter()
            .map(|c| LayoutCategory {
                name: names.get(&c.id).cloned().unwrap_or_default(),
                id: c.id,
                channels: c.channels,
            })
            .collect(),
    };
    write_layout(&mut tx, &server, &layout).await?;
    if shape(&layout) != was {
        audit::record(&mut tx, Entry::new(&server, &actor, Action::ChannelReorder)).await?;
    }
    tx.commit().await?;
    announce(&state, &server, layout.clone(), None);
    Ok(Json(layout))
}
