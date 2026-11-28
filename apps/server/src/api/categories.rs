use std::collections::{HashMap, HashSet};

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use sqlx::{AnyConnection, Row};
use utoipa::ToSchema;

use crate::api::access::{Proof, grants, resolve_category, resolve_server};
use crate::api::audit::{self, Action, Actor, Details, Entry, Target, TargetKind};
use crate::api::servers::check_name;
use crate::api::{
    ApiError, ApiErrorBody, Authed, Category, CategoryStyle, ChannelLayout, LayoutCategory, OkResp,
    ProfanityTarget, Separator, SeparatorStyle, ok,
};
use crate::db::Db;
use crate::state::AppState;
use crate::ws::WsEvent;

const STALE: &str = "The channel list changed. Reload it and try again";

/// The place of a new channel or separator: after everything listed in its server.
pub(crate) const NEXT_POSITION: &str = "(SELECT COALESCE(MAX(p) + 1, 0) FROM (SELECT position AS p FROM channels WHERE server = $1 UNION ALL SELECT position AS p FROM channel_separators WHERE server = $1) AS listed)";

/// Request body for creating or renaming a channel category.
#[derive(Deserialize, ToSchema)]
pub struct CategoryReq {
    /// Category name. Surrounding whitespace is trimmed; must not be blank, at most 100
    /// characters and must pass the category-name profanity filter. Names may repeat.
    #[schema(example = "Games")]
    name: String,
    /// How its header is drawn. Leave it out to keep the current style (`default` for a new
    /// category).
    #[serde(default)]
    style: Option<CategoryStyle>,
}

/// Where a separator goes in a new layout.
#[derive(Deserialize, ToSchema)]
pub struct SeparatorPlace {
    /// Separator id.
    id: i64,
    /// Category to list it in; `null` lists it among the channels without one.
    #[serde(default)]
    category_id: Option<i64>,
    /// How many channels of that list go above it. Separators with the same value keep the
    /// order they are sent in.
    after: i64,
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
    /// Where each separator goes, every separator of the server exactly once, top first. Leave
    /// it out to keep each separator in its list after as many channels as before.
    #[serde(default)]
    separators: Option<Vec<SeparatorPlace>>,
}

fn conflict() -> ApiError {
    ApiError::conflict(StatusCode::CONFLICT, STALE)
}

pub(crate) async fn server_categories(db: &Db, server: &str) -> Result<Vec<Category>, ApiError> {
    let rows = sqlx::query(
        "SELECT id, name, position, style FROM channel_categories WHERE server = $1 ORDER BY position, id",
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
            style: CategoryStyle::stored(&r.try_get::<String, _>(3)?),
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

/// The full layout of `server` as stored, `None` when the server is gone. Channels and
/// separators whose category no longer exists count as uncategorized. Channels and separators
/// share one order: a separator sits below the channels of its list placed at or above it.
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
        "SELECT id, name, style FROM channel_categories WHERE server = $1 ORDER BY position, id",
    )
    .bind(server)
    .fetch_all(&mut *conn)
    .await?;
    let mut categories = Vec::with_capacity(cats.len());
    for r in &cats {
        categories.push(LayoutCategory {
            id: r.try_get(0)?,
            name: r.try_get(1)?,
            style: CategoryStyle::stored(&r.try_get::<String, _>(2)?),
            channels: Vec::new(),
        });
    }
    let at: HashMap<i64, usize> = categories
        .iter()
        .enumerate()
        .map(|(i, c)| (c.id, i + 1))
        .collect();
    let rows = sqlx::query(
        "SELECT id, category_id, position FROM channels WHERE server = $1 ORDER BY position, id",
    )
    .bind(server)
    .fetch_all(&mut *conn)
    .await?;
    let mut uncategorized = Vec::new();
    let mut spots: Vec<Vec<i64>> = vec![Vec::new(); categories.len() + 1];
    for r in &rows {
        let id: i64 = r.try_get(0)?;
        let category: Option<i64> = r.try_get(1)?;
        let group = category.and_then(|c| at.get(&c).copied()).unwrap_or(0);
        match group {
            0 => uncategorized.push(id),
            i => categories[i - 1].channels.push(id),
        }
        spots[group].push(r.try_get(2)?);
    }
    let seps = sqlx::query(
        "SELECT id, category_id, label, style, position FROM channel_separators WHERE server = $1 ORDER BY position, id",
    )
    .bind(server)
    .fetch_all(&mut *conn)
    .await?;
    let mut placed: Vec<Vec<Separator>> = vec![Vec::new(); categories.len() + 1];
    for r in &seps {
        let category: Option<i64> = r.try_get(1)?;
        let group = category.and_then(|c| at.get(&c).copied()).unwrap_or(0);
        let position: i64 = r.try_get(4)?;
        placed[group].push(Separator {
            id: r.try_get(0)?,
            label: r.try_get(2)?,
            style: SeparatorStyle::stored(&r.try_get::<String, _>(3)?),
            category_id: (group > 0).then(|| categories[group - 1].id),
            after: spots[group].partition_point(|p| *p <= position) as i64,
        });
    }
    Ok(Some(ChannelLayout {
        version,
        uncategorized,
        categories,
        separators: placed.into_iter().flatten().collect(),
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

/// A channel or a separator in a list.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Item {
    Channel(i64),
    Separator(i64),
}

/// The channels and separators of `layout` in list order, each with its category.
fn items(layout: &ChannelLayout) -> Vec<(Item, Option<i64>)> {
    let ChannelLayout {
        version: _,
        uncategorized,
        categories,
        separators,
    } = layout;
    let known: HashSet<i64> = categories.iter().map(|c| c.id).collect();
    let groups = std::iter::once((None, uncategorized))
        .chain(categories.iter().map(|c| (Some(c.id), &c.channels)));
    let mut out = Vec::new();
    for (category, channels) in groups {
        let mut seps: Vec<&Separator> = separators
            .iter()
            .filter(|s| s.category_id.filter(|c| known.contains(c)) == category)
            .collect();
        seps.sort_by_key(|s| s.after.clamp(0, channels.len() as i64));
        let mut seps = seps.into_iter().peekable();
        for (k, channel) in channels
            .iter()
            .map(Some)
            .chain(std::iter::once(None))
            .enumerate()
        {
            while let Some(sep) =
                seps.next_if(|s| s.after.clamp(0, channels.len() as i64) <= k as i64)
            {
                out.push((Item::Separator(sep.id), category));
            }
            if let Some(id) = channel {
                out.push((Item::Channel(*id), category));
            }
        }
    }
    out
}

/// Stores `layout` as the order of `server`: category positions follow `categories`, channel
/// and separator positions run through the whole list. Rows that already match are left alone.
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
    let rows =
        sqlx::query("SELECT id, category_id, position FROM channel_separators WHERE server = $1")
            .bind(server)
            .fetch_all(&mut *conn)
            .await?;
    let mut sat = HashMap::new();
    for r in &rows {
        sat.insert(
            r.try_get::<i64, _>(0)?,
            (r.try_get::<Option<i64>, _>(1)?, r.try_get::<i64, _>(2)?),
        );
    }
    for (pos, (item, category)) in items(layout).into_iter().enumerate() {
        let pos = pos as i64;
        let sql = match item {
            Item::Channel(id) if was.get(&id) != Some(&(category, pos)) => {
                match was.get(&id).is_some_and(|(had, _)| *had != category) {
                    true => {
                        "UPDATE channels SET category_id = $1, position = $2, perm_sync = 0 WHERE id = $3"
                    }
                    false => "UPDATE channels SET category_id = $1, position = $2 WHERE id = $3",
                }
            }
            Item::Separator(id) if sat.get(&id) != Some(&(category, pos)) => {
                "UPDATE channel_separators SET category_id = $1, position = $2 WHERE id = $3"
            }
            Item::Channel(_) | Item::Separator(_) => continue,
        };
        let (Item::Channel(id) | Item::Separator(id)) = item;
        sqlx::query(sql)
            .bind(category)
            .bind(pos)
            .bind(id)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

/// The part of `layout` someone sees: only the channels `visible` accepts, only the categories
/// holding one of them unless they `manage` channels, and the separators of the lists left,
/// each after the seen channels above it. Someone who doesn't manage channels gets the version
/// of what they see (`seen_version`).
pub(crate) fn seen_part(
    layout: &ChannelLayout,
    visible: impl Fn(i64) -> bool,
    manages: bool,
) -> ChannelLayout {
    let ChannelLayout {
        version,
        uncategorized,
        categories,
        separators,
    } = layout;
    let shown =
        |list: &[i64]| -> Vec<i64> { list.iter().copied().filter(|c| visible(*c)).collect() };
    let kept: Vec<LayoutCategory> = categories
        .iter()
        .map(
            |LayoutCategory {
                 id,
                 name,
                 style,
                 channels,
             }| LayoutCategory {
                id: *id,
                name: name.clone(),
                style: *style,
                channels: shown(channels),
            },
        )
        .filter(|c| manages || !c.channels.is_empty())
        .collect();
    let lists: HashMap<i64, &Vec<i64>> = categories.iter().map(|c| (c.id, &c.channels)).collect();
    let listed: HashSet<i64> = kept.iter().map(|c| c.id).collect();
    let separators = separators
        .iter()
        .filter_map(|sep| {
            let list = match sep.category_id {
                Some(c) if lists.contains_key(&c) => listed.contains(&c).then(|| lists[&c])?,
                Some(_) | None => uncategorized,
            };
            let after = list
                .iter()
                .take(sep.after.max(0) as usize)
                .filter(|c| visible(**c))
                .count() as i64;
            Some(Separator {
                after,
                ..sep.clone()
            })
        })
        .collect();
    let mut seen = ChannelLayout {
        version: *version,
        uncategorized: shown(uncategorized),
        categories: kept,
        separators,
    };
    if !manages {
        seen.version = seen_version(&seen);
    }
    seen
}

/// Emits `layout_changed`. With `created`, only connections that can view that new channel get
/// it, so creating a hidden channel tells nobody else anything. With `before`, connections that
/// don't manage channels get it only when the part they see changed.
pub(crate) fn announce(
    state: &AppState,
    server: &str,
    layout: ChannelLayout,
    created: Option<i64>,
    before: Option<ChannelLayout>,
) {
    state.hub.broadcast(WsEvent::LayoutChanged {
        server: server.to_string(),
        layout: layout.into(),
        created,
        deleted: None,
        before,
        after: None,
    });
}

/// The `layout_version` of someone who doesn't manage channels: a hash of `seen`, the part of
/// the layout they can see (its own `version` left out), so a change they can't see leaves it
/// alone. Between 0 and 2^53 - 1.
pub(crate) fn seen_version(seen: &ChannelLayout) -> i64 {
    let ChannelLayout {
        version: _,
        uncategorized,
        categories,
        separators,
    } = seen;
    let mut hash = Sha256::new();
    let text = |hash: &mut Sha256, text: &str| {
        hash.update((text.len() as u64).to_be_bytes());
        hash.update(text.as_bytes());
    };
    hash.update(b"rchat-layout\0");
    hash.update((uncategorized.len() as u64).to_be_bytes());
    for id in uncategorized {
        hash.update(id.to_be_bytes());
    }
    for LayoutCategory {
        id,
        name,
        style,
        channels,
    } in categories
    {
        hash.update(id.to_be_bytes());
        text(&mut hash, name);
        text(&mut hash, style.as_str());
        hash.update((channels.len() as u64).to_be_bytes());
        for channel in channels {
            hash.update(channel.to_be_bytes());
        }
    }
    hash.update((separators.len() as u64).to_be_bytes());
    for Separator {
        id,
        label,
        style,
        category_id,
        after,
    } in separators
    {
        hash.update(id.to_be_bytes());
        text(&mut hash, label);
        text(&mut hash, style.as_str());
        hash.update(category_id.unwrap_or(-1).to_be_bytes());
        hash.update(after.to_be_bytes());
    }
    let mut top = [0u8; 8];
    top.copy_from_slice(&hash.finalize()[..8]);
    (u64::from_be_bytes(top) >> 11) as i64
}

async fn clean_name(db: &Db, raw: &str) -> Result<String, ApiError> {
    let name = raw.trim().to_string();
    check_name(db, ProfanityTarget::CategoryNames, "Category name", &name).await?;
    Ok(name)
}

/// Create a category
///
/// Adds a channel category at the bottom of the server's channel list. A server can have at
/// most 100 categories by default (`SERVER_CATEGORIES_MAX`). Requires the Manage channels permission. Raises the layout version and
/// emits `layout_changed` to the server. General rate-limit bucket.
#[utoipa::path(
    post,
    path = "/api/v1/servers/{name}/categories",
    tag = "Channels",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    request_body = CategoryReq,
    responses(
        (status = 200, description = "The created category", body = Category),
        (status = 400, description = "Invalid category name (blank, longer than 100 characters or blocked by the profanity filter) or `A server can have at most 100 categories` with the configured number (`SERVER_CATEGORIES_MAX`, reason `limit`). Malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Manage channels permission", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses)", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)
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
    let may_manage_channels = access.grant::<grants::ManageChannels>(&state.db).await?;
    let server = access.name().to_string();
    let actor = may_manage_channels.actor().clone();
    let mut tx = state.db.begin().await?;
    bump(&mut tx, &server, None).await?;
    let before = load_layout(&mut tx, &server).await?;
    let count: i64 = sqlx::query("SELECT COUNT(*) FROM channel_categories WHERE server = $1")
        .bind(&server)
        .fetch_one(&mut *tx)
        .await?
        .try_get(0)?;
    let most = state.limits.server_categories_max;
    if count >= most {
        return Err(ApiError::limit(
            StatusCode::BAD_REQUEST,
            format!("A server can have at most {most} categories"),
            &rchat_settings::items::SERVER_CATEGORIES_MAX,
        ));
    }
    let style = req.style.unwrap_or_default();
    let row = sqlx::query(
        "INSERT INTO channel_categories(server, name, position, created_at, style) SELECT $1, $2, COALESCE(MAX(position) + 1, 0), $3, $4 FROM channel_categories WHERE server = $1 RETURNING id, position",
    )
    .bind(&server)
    .bind(&category_name)
    .bind(state.clock.unix())
    .bind(style.as_str())
    .fetch_one(&mut *tx)
    .await?;
    let category = Category {
        id: row.try_get(0)?,
        name: category_name,
        position: row.try_get(1)?,
        style,
    };
    let details = Details::new().change("name", None::<String>, category.name.as_str());
    let details = match style {
        CategoryStyle::Default => details,
        CategoryStyle::Dots | CategoryStyle::Line => {
            details.change("style", None::<String>, style.as_str())
        }
    };
    audit::record(
        &mut tx,
        category_entry(&server, &actor, Action::CategoryCreate, &category).details(details),
    )
    .await?;
    let layout = load_layout(&mut tx, &server).await?;
    tx.commit().await?;
    if let Some(layout) = layout {
        announce(&state, &server, layout, None, before);
    }
    Ok(Json(category))
}

/// Rename a category
///
/// Renames a channel category and, with `style`, changes how its header is drawn. Requires the
/// Manage channels permission in its server. Raises the layout version and emits
/// `layout_changed` to the server. General rate-limit bucket.
#[utoipa::path(
    patch,
    path = "/api/v1/categories/{id}",
    tag = "Channels",
    params(("id" = i64, Path, description = "Category id")),
    request_body = CategoryReq,
    responses(
        (status = 200, description = "The renamed category", body = Category),
        (status = 400, description = "Invalid category name (blank, longer than 100 characters or blocked by the profanity filter). A non-integer `id`, malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 404, description = "`Not found`: no such category, one in a server you have no access to, or you lack the Manage channels permission there (identical responses)", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)
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
    let actor = access
        .grant::<grants::ManageChannels>(&state.db)
        .await?
        .actor()
        .clone();
    let mut tx = state.db.begin().await?;
    bump(&mut tx, &server, None).await?;
    let before = load_layout(&mut tx, &server).await?;
    let was =
        sqlx::query("SELECT name, style FROM channel_categories WHERE id = $1 AND server = $2")
            .bind(id)
            .bind(&server)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(crate::api::access::not_found)?;
    let (was_name, was_style): (String, CategoryStyle) = (
        was.try_get(0)?,
        CategoryStyle::stored(&was.try_get::<String, _>(1)?),
    );
    let style = req.style.unwrap_or(was_style);
    let row = sqlx::query(
        "UPDATE channel_categories SET name = $1, style = $2 WHERE id = $3 AND server = $4 RETURNING position",
    )
    .bind(&category_name)
    .bind(style.as_str())
    .bind(id)
    .bind(&server)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(crate::api::access::not_found)?;
    let category = Category {
        id,
        name: category_name,
        position: row.try_get(0)?,
        style,
    };
    let changes = Details::new()
        .change("name", was_name, category.name.as_str())
        .change("style", was_style.as_str(), style.as_str());
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
        announce(&state, &server, layout, None, before);
    }
    Ok(Json(category))
}

/// Delete a category
///
/// Deletes a channel category. Its channels and separators move to the end of the channels
/// without a category, in the same order; no channel or separator is deleted. Requires the
/// Manage channels permission in its server. Raises the layout version and emits
/// `layout_changed` to the server. General rate-limit bucket.
#[utoipa::path(
    delete,
    path = "/api/v1/categories/{id}",
    tag = "Channels",
    params(("id" = i64, Path, description = "Category id")),
    responses(
        (status = 200, description = "Category deleted", body = OkResp),
        (status = 400, description = "A non-integer `id` gives a plain-text 400", content_type = "text/plain", body = String),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 404, description = "`Not found`: no such category, one in a server you have no access to, or you lack the Manage channels permission there (identical responses)", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)
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
    let actor = access
        .grant::<grants::ManageChannels>(&state.db)
        .await?
        .actor()
        .clone();
    let mut tx = state.db.begin().await?;
    bump(&mut tx, &server, None).await?;
    let mut layout = load_layout(&mut tx, &server)
        .await?
        .ok_or_else(crate::api::access::not_found)?;
    let Some(at) = layout.categories.iter().position(|c| c.id == id) else {
        return Err(crate::api::access::not_found());
    };
    let before = layout.clone();
    let gone = layout.categories.remove(at);
    audit::record(
        &mut tx,
        Entry::new(&server, &actor, Action::CategoryDelete)
            .target(Target::with_id(TargetKind::Category, id, Some(&gone.name)))
            .details(Details::new().change("name", gone.name.as_str(), None::<String>)),
    )
    .await?;
    let below = layout.uncategorized.len() as i64;
    for sep in &mut layout.separators {
        if sep.category_id == Some(id) {
            sep.category_id = None;
            sep.after += below;
        }
    }
    layout.uncategorized.extend(gone.channels);
    write_layout(&mut tx, &server, &layout).await?;
    sqlx::query("DELETE FROM channel_categories WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    announce(&state, &server, layout, None, Some(before));
    Ok(ok())
}

/// The order a layout puts channels, categories and separators in.
#[derive(PartialEq)]
struct Shape {
    uncategorized: Vec<i64>,
    categories: Vec<i64>,
    items: Vec<(Item, Option<i64>)>,
}

fn shape(layout: &ChannelLayout) -> Shape {
    Shape {
        uncategorized: layout.uncategorized.clone(),
        categories: layout.categories.iter().map(|c| c.id).collect(),
        items: items(layout),
    }
}

fn category_entry(server: &str, actor: &Actor, action: Action, category: &Category) -> Entry {
    Entry::new(server, actor, action).target(Target::with_id(
        TargetKind::Category,
        category.id,
        Some(&category.name),
    ))
}

fn check_order(req: &LayoutReq, current: &ChannelLayout) -> Result<(), ApiError> {
    let wrong = || {
        ApiError::invalid(
            "The order must list every channel and category exactly once",
            "order",
        )
    };
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
    if seen.len() != want.len() {
        return Err(wrong());
    }
    let Some(places) = &req.separators else {
        return Ok(());
    };
    let wrong = || {
        ApiError::invalid(
            "The order must list every separator exactly once, after channels of its list",
            "separators",
        )
    };
    let want: HashSet<i64> = current.separators.iter().map(|s| s.id).collect();
    let lists: HashMap<Option<i64>, usize> = std::iter::once((None, req.uncategorized.len()))
        .chain(
            req.categories
                .iter()
                .map(|c| (Some(c.id), c.channels.len())),
        )
        .collect();
    let mut seen = HashSet::new();
    for SeparatorPlace {
        id,
        category_id,
        after,
    } in places
    {
        let fits = lists
            .get(category_id)
            .is_some_and(|n| (0..=*n as i64).contains(after));
        if !want.contains(id) || !seen.insert(*id) || !fits {
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
/// Replaces the order of the server's channel list: which category each channel and separator
/// is in, the order of channels and separators within it and the order of the categories. The
/// body must list every channel and category of the server exactly once (and every separator,
/// when it has `separators`) and name the `layout_version` it is based on; when the layout
/// changed since, nothing is stored and the answer is 409, so reload the server and try again.
/// Of two concurrent reorders from the same version, one wins and the other gets 409. Requires
/// the Manage channels permission. Raises the layout version and emits `layout_changed` to the
/// server, where each connection only gets the channels it can see. General rate-limit bucket.
#[utoipa::path(
    put,
    path = "/api/v1/servers/{name}/layout",
    tag = "Channels",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    request_body = LayoutReq,
    responses(
        (status = 200, description = "The stored layout with its new version", body = ChannelLayout),
        (status = 400, description = "`The order must list every channel and category exactly once`: an id is missing, repeated or not part of this server. `The order must list every separator exactly once, after channels of its list`: a separator is missing, repeated, not part of this server, in a category the order does not list, or after more channels than its list has. Malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Manage channels permission", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or a password-protected one you have no access to (identical responses)", body = ApiErrorBody),
        (status = 409, description = "`The channel list changed. Reload it and try again`: `version` is not the current layout version", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)
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
    if listed as i64 > rchat_settings::items::SERVER_CHANNELS_MAX.max()
        || req.categories.len() as i64 > rchat_settings::items::SERVER_CATEGORIES_MAX.max()
        || req.separators.as_ref().map_or(0, Vec::len) as i64
            > rchat_settings::items::SERVER_SEPARATORS_MAX.max()
    {
        return Err(ApiError::invalid(
            "The order must list every channel and category exactly once",
            "order",
        ));
    }
    let access =
        resolve_server(&state.db, &name.to_lowercase(), Some(&user), &Proof::none()).await?;
    let may_manage_channels = access.grant::<grants::ManageChannels>(&state.db).await?;
    let server = access.name().to_string();
    let actor = may_manage_channels.actor().clone();
    let mut tx = state.db.begin().await?;
    if !bump(&mut tx, &server, Some(req.version)).await? {
        return Err(conflict());
    }
    let current = load_layout(&mut tx, &server)
        .await?
        .ok_or_else(crate::api::access::not_found)?;
    check_order(&req, &current)?;
    let was = shape(&current);
    let before = current.clone();
    let ChannelLayout {
        version,
        uncategorized: _,
        categories: old_categories,
        separators: old_separators,
    } = current;
    let looks: HashMap<i64, (String, CategoryStyle)> = old_categories
        .into_iter()
        .map(|c| (c.id, (c.name, c.style)))
        .collect();
    let LayoutReq {
        version: _,
        uncategorized,
        categories,
        separators,
    } = req;
    let categories: Vec<LayoutCategory> = categories
        .into_iter()
        .map(|c| {
            let (name, style) = looks.get(&c.id).cloned().unwrap_or_default();
            LayoutCategory {
                id: c.id,
                name,
                style,
                channels: c.channels,
            }
        })
        .collect();
    let separators = match separators {
        Some(places) => {
            let old: HashMap<i64, Separator> =
                old_separators.into_iter().map(|s| (s.id, s)).collect();
            places
                .into_iter()
                .filter_map(|p| {
                    old.get(&p.id).map(|s| Separator {
                        category_id: p.category_id,
                        after: p.after,
                        ..s.clone()
                    })
                })
                .collect()
        }
        None => {
            let lists: HashMap<Option<i64>, usize> = std::iter::once((None, uncategorized.len()))
                .chain(categories.iter().map(|c| (Some(c.id), c.channels.len())))
                .collect();
            old_separators
                .into_iter()
                .map(|s| Separator {
                    after: s
                        .after
                        .min(lists.get(&s.category_id).copied().unwrap_or(0) as i64),
                    ..s
                })
                .collect()
        }
    };
    let layout = ChannelLayout {
        version,
        uncategorized,
        categories,
        separators,
    };
    write_layout(&mut tx, &server, &layout).await?;
    if shape(&layout) != was {
        audit::record(&mut tx, Entry::new(&server, &actor, Action::ChannelReorder)).await?;
    }
    tx.commit().await?;
    announce(&state, &server, layout.clone(), None, Some(before));
    Ok(Json(layout))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::limits::Limits;

    #[tokio::test]
    async fn the_category_cap_is_configurable() {
        use crate::api::test_util::{add_member, done, mem_user, temp_state};
        let (state, path) = temp_state("category_cap").await;
        add_member(&state.db, "rchat", "alice", 1, 0, 0).await;
        let state = state.with_limits(std::sync::Arc::new(Limits {
            server_categories_max: 1,
            ..Limits::default()
        }));
        let category = |name: &str| {
            create_category(
                State(state.clone()),
                Authed(mem_user("alice", false)),
                Path("rchat".to_string()),
                Json(CategoryReq {
                    name: name.to_string(),
                    style: None,
                }),
            )
        };
        let _ = category("one").await.expect("first category");
        let Err(ApiError(code, msg, reason)) = category("two").await else {
            panic!("a second category past the cap");
        };
        assert_eq!(
            (code, msg.as_str()),
            (
                StatusCode::BAD_REQUEST,
                "A server can have at most 1 categories"
            )
        );
        assert_eq!(
            reason.and_then(|r| r.control).as_deref(),
            Some("server_categories_max")
        );
        done(state, path).await;
    }

    fn layout(
        version: i64,
        uncategorized: &[i64],
        categories: &[(i64, &str, &[i64])],
    ) -> ChannelLayout {
        ChannelLayout {
            version,
            uncategorized: uncategorized.to_vec(),
            categories: categories
                .iter()
                .map(|(id, name, channels)| LayoutCategory {
                    id: *id,
                    name: name.to_string(),
                    style: CategoryStyle::Default,
                    channels: channels.to_vec(),
                })
                .collect(),
            separators: Vec::new(),
        }
    }

    #[test]
    fn the_seen_version_follows_only_the_seen_layout() {
        let seen = seen_version(&layout(3, &[1, 2], &[(7, "Games", &[3])]));
        assert_eq!(
            seen,
            seen_version(&layout(9, &[1, 2], &[(7, "Games", &[3])]))
        );
        for other in [
            layout(3, &[2, 1], &[(7, "Games", &[3])]),
            layout(3, &[1], &[(7, "Games", &[2, 3])]),
            layout(3, &[1, 2, 3], &[(7, "Games", &[])]),
            layout(3, &[1, 2], &[(7, "Game", &[3])]),
            layout(3, &[1, 2], &[(8, "Games", &[3])]),
            layout(3, &[1, 2], &[(7, "Games", &[3]), (8, "", &[])]),
        ] {
            assert_ne!(seen_version(&other), seen, "{other:?}");
        }
        for v in [seen, seen_version(&layout(0, &[], &[]))] {
            assert!((0..1 << 53).contains(&v), "{v}");
        }
    }
}
