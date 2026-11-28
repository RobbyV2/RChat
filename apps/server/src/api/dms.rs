use std::collections::{HashMap, HashSet};

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use serde::Deserialize;
use sqlx::Row;
use sqlx::any::AnyRow;
use utoipa::{IntoParams, ToSchema};

use crate::api::access::resolve_dm;
use crate::api::blocks::{NOT_ACCEPTING, YOU_FRIENDS_ONLY, check_dm, not_blocking};
use crate::api::messages::read_dm_latest;
use crate::api::policy::DmCreation;
use crate::api::servers::Page;
use crate::api::{
    ApiError, ApiErrorBody, Authed, DmSummary, OkResp, Paged, bad, cursor_int, decode_cursor,
    encode_cursor, ok, page_bounds, placeholders, split_list, user_from, user_refs,
};
use crate::db::{Db, LIVE_DM, User, get_user, is_sqlite};
use crate::state::AppState;
use crate::ws::WsEvent;

/// The user to open a DM with.
#[derive(Deserialize, ToSchema)]
pub struct OpenDmReq {
    /// Username, case-insensitive. Your own username opens your self DM.
    #[schema(example = "bob")]
    username: String,
}

/// How the DM list is ordered. The conversation with yourself always comes first.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum DmSort {
    /// Latest message or call first; DMs without messages last, newest first.
    #[default]
    Recent,
    /// Least recent message or call first; DMs without messages first, oldest first.
    Oldest,
    /// By the other person's display name, then username, A to Z by code point (ASCII letters
    /// ignore case).
    Name,
}

/// The order and filter of a DM list page; a cursor only continues the one it came from.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct DmOrder {
    pub(crate) sort: DmSort,
    pub(crate) friends: bool,
}

enum DmKey {
    Activity(i64, i64),
    Name(String, String),
}

impl DmOrder {
    fn tag(self) -> Option<&'static str> {
        let DmOrder { sort, friends } = self;
        match (sort, friends) {
            (DmSort::Recent, false) => None,
            (DmSort::Recent, true) => Some("rf"),
            (DmSort::Oldest, false) => Some("o"),
            (DmSort::Oldest, true) => Some("of"),
            (DmSort::Name, false) => Some("n"),
            (DmSort::Name, true) => Some("nf"),
        }
    }

    fn start(self) -> DmKey {
        match self.sort {
            DmSort::Recent => DmKey::Activity(i64::MAX, i64::MAX),
            DmSort::Oldest => DmKey::Activity(i64::MIN, i64::MIN),
            DmSort::Name => DmKey::Name(String::new(), String::new()),
        }
    }

    fn encode(self, key: &DmKey) -> String {
        let (a, b) = match key {
            DmKey::Activity(latest, id) => (latest.to_string(), id.to_string()),
            DmKey::Name(name, partner) => (hex::encode(name), partner.clone()),
        };
        match self.tag() {
            Some(tag) => encode_cursor(&[tag, &a, &b]),
            None => encode_cursor(&[&a, &b]),
        }
    }

    fn decode(self, raw: &str) -> Result<DmKey, ApiError> {
        let invalid = || bad("Invalid cursor");
        let parts = match self.tag() {
            None => decode_cursor(raw, 2)?,
            Some(tag) => match decode_cursor(raw, 3)? {
                parts if parts[0] == tag => parts[1..].to_vec(),
                _ => return Err(invalid()),
            },
        };
        match self.sort {
            DmSort::Recent | DmSort::Oldest => Ok(DmKey::Activity(
                cursor_int(&parts[0])?,
                cursor_int(&parts[1])?,
            )),
            DmSort::Name => {
                let name = hex::decode(&parts[0]).map_err(|_| invalid())?;
                Ok(DmKey::Name(
                    String::from_utf8(name).map_err(|_| invalid())?,
                    parts[1].clone(),
                ))
            }
        }
    }
}

/// Paging, order or selection for the DM list.
#[derive(Deserialize, IntoParams)]
pub struct DmListQuery {
    /// Legacy offset into the list, 0 to 1000000 (clamped), default 0. Ignored when `cursor` is
    /// given.
    offset: Option<i64>,
    /// Page size, 1 to 100 (clamped), default 50.
    limit: Option<i64>,
    /// Opaque cursor from the `X-Next-Cursor` header of the previous page (or `dms_cursor` from
    /// `GET /api/v1/me`, which is for the default order). Empty means the first page. A cursor
    /// only works with the `sort` and `friends` it came from.
    cursor: Option<String>,
    /// Comma-separated DM ids to fetch instead of a page; up to 100 distinct ids, entries that
    /// are not integers or not your DMs are skipped. Paging parameters are then ignored.
    #[param(example = "12,40")]
    ids: Option<String>,
    /// Order of the pages, default `recent`.
    #[param(inline)]
    sort: Option<DmSort>,
    /// `true`: only DMs with accepted friends (and the one with yourself). Default `false`.
    friends: Option<bool>,
}

fn dm_half(col: &str, order: DmOrder, keyset: bool, sqlite: bool, limit: usize) -> String {
    let DmOrder { sort, friends } = order;
    let (partner, closed) = match col {
        "user_a" => ("user_b", "closed_a"),
        _ => ("user_a", "closed_b"),
    };
    let collate = match sqlite {
        true => "",
        false => " COLLATE \"C\"",
    };
    let name = format!("lower(COALESCE(u.display_name, d.{partner}){collate})");
    let who = format!("d.{partner}{collate}");
    let (columns, join, by, bound) = match sort {
        DmSort::Recent => (
            String::new(),
            String::new(),
            "d.last_message_id DESC, d.id DESC".to_string(),
            " AND (d.last_message_id, d.id) < ($2, $3)".to_string(),
        ),
        DmSort::Oldest => (
            String::new(),
            String::new(),
            "d.last_message_id, d.id".to_string(),
            " AND (d.last_message_id, d.id) > ($2, $3)".to_string(),
        ),
        DmSort::Name => (
            format!(", {name} AS name_key, d.{partner} AS partner"),
            format!(" LEFT JOIN users u ON u.username = d.{partner}"),
            format!("{name}, {who}"),
            format!(" AND ({name}, {who}) > ($2, $3)"),
        ),
    };
    let bound = match keyset {
        true => bound.as_str(),
        false => "",
    };
    let friends = match friends {
        true => format!(
            " AND EXISTS(SELECT 1 FROM friends f WHERE f.username = $1 AND f.friend = d.{partner})"
        ),
        false => String::new(),
    };
    format!(
        "SELECT * FROM (SELECT d.id, d.user_a, d.user_b, d.last_message_id{columns} FROM dms d{join} WHERE d.{col} = $1 AND d.user_a <> d.user_b AND d.{closed} = 0{bound} AND NOT EXISTS(SELECT 1 FROM users pu WHERE pu.username = d.{partner} AND pu.password_hash = '!purging'){friends} ORDER BY {by} LIMIT ${limit}) h_{col}"
    )
}

fn dm_union(order: DmOrder, keyset: bool, sqlite: bool) -> String {
    let (limit, offset) = match keyset {
        true => (4, 5),
        false => (2, 3),
    };
    let collate = match sqlite {
        true => "",
        false => " COLLATE \"C\"",
    };
    let (columns, by) = match order.sort {
        DmSort::Recent => ("", "last_message_id DESC, id DESC".to_string()),
        DmSort::Oldest => ("", "last_message_id, id".to_string()),
        DmSort::Name => (
            ", name_key, partner",
            format!("name_key{collate}, partner{collate}"),
        ),
    };
    format!(
        "SELECT id, user_a, user_b, last_message_id{columns} FROM ({} UNION ALL {}) x ORDER BY {by} LIMIT ${limit} OFFSET ${offset}",
        dm_half("user_a", order, keyset, sqlite, limit),
        dm_half("user_b", order, keyset, sqlite, limit),
    )
}

struct DmRow {
    id: i64,
    other: String,
    is_self: bool,
    closed: bool,
    latest: i64,
}

async fn summaries(
    db: &Db,
    viewer: &str,
    rows: &[AnyRow],
    closed_col: Option<usize>,
) -> Result<Vec<DmSummary>, ApiError> {
    let mut parsed = Vec::with_capacity(rows.len());
    for r in rows {
        let (id, a, b, latest): (i64, String, String, i64) =
            (r.try_get(0)?, r.try_get(1)?, r.try_get(2)?, r.try_get(3)?);
        let closed = match closed_col {
            Some(col) => r.try_get::<i64, _>(col)? != 0,
            None => false,
        };
        let is_self = a == b;
        let other = match a == viewer {
            true => b,
            false => a,
        };
        parsed.push(DmRow {
            id,
            other,
            is_self,
            closed,
            latest,
        });
    }
    summaries_of(db, viewer, parsed).await
}

async fn summaries_of(
    db: &Db,
    viewer: &str,
    parsed: Vec<DmRow>,
) -> Result<Vec<DmSummary>, ApiError> {
    let names: Vec<String> = parsed.iter().map(|d| d.other.clone()).collect();
    let refs = user_refs(db, &names).await;
    let latest: Vec<i64> = parsed
        .iter()
        .filter(|d| d.latest > 0)
        .map(|d| d.latest)
        .collect();
    let mut sent_at: HashMap<i64, i64> = HashMap::with_capacity(latest.len());
    if !latest.is_empty() {
        let sql = format!(
            "SELECT id, created_at FROM messages WHERE id IN ({})",
            placeholders(1, latest.len())
        );
        let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
        for id in &latest {
            query = query.bind(*id);
        }
        for r in query.fetch_all(db).await? {
            sent_at.insert(r.try_get(0)?, r.try_get(1)?);
        }
    }
    let others: Vec<&str> = parsed
        .iter()
        .filter(|d| !d.is_self)
        .map(|d| d.other.as_str())
        .collect();
    let mut friends: HashSet<String> = HashSet::with_capacity(others.len());
    if !others.is_empty() {
        let sql = format!(
            "SELECT friend FROM friends WHERE username = $1 AND friend IN ({})",
            placeholders(2, others.len())
        );
        let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(viewer);
        for name in &others {
            query = query.bind(*name);
        }
        for r in query.fetch_all(db).await? {
            friends.insert(r.try_get(0)?);
        }
    }
    let ids: Vec<i64> = parsed.iter().map(|d| d.id).collect();
    let seals = crate::api::seal::dm_views(db, &ids).await?;
    Ok(parsed
        .into_iter()
        .map(
            |DmRow {
                 id,
                 other,
                 is_self,
                 closed,
                 latest,
             }| DmSummary {
                id,
                friend: !is_self && friends.contains(&other),
                other: user_from(&refs, &other),
                is_self,
                closed,
                last_message_id: (latest > 0).then_some(latest),
                last_message_at: sent_at.get(&latest).copied(),
                seal: seals.get(&id).copied().unwrap_or_default(),
            },
        )
        .collect())
}

pub(crate) async fn dm_page(
    db: &Db,
    viewer: &str,
    order: DmOrder,
    offset: i64,
    cursor: Option<&str>,
    limit: i64,
) -> Result<Page<DmSummary>, ApiError> {
    let sqlite = is_sqlite(db);
    let mut rows: Vec<AnyRow> = Vec::with_capacity(limit as usize + 1);
    match cursor {
        Some(raw) => {
            let sql = sqlx::AssertSqlSafe(dm_union(order, true, sqlite));
            let query = match order.decode(raw)? {
                DmKey::Activity(latest, id) => sqlx::query(sql).bind(viewer).bind(latest).bind(id),
                DmKey::Name(name, partner) => {
                    sqlx::query(sql).bind(viewer).bind(name).bind(partner)
                }
            };
            rows.extend(query.bind(limit + 1).bind(0i64).fetch_all(db).await?);
        }
        None => {
            if offset == 0 {
                rows.extend(
                    sqlx::query("SELECT id, user_a, user_b, last_message_id FROM dms WHERE user_a = $1 AND user_b = $1 AND closed_a = 0")
                        .bind(viewer)
                        .fetch_all(db)
                        .await?,
                );
            }
            let skip = (offset - 1).max(0);
            let want = limit + 1 - rows.len() as i64;
            let sql = dm_union(order, false, sqlite);
            rows.extend(
                sqlx::query(sqlx::AssertSqlSafe(sql))
                    .bind(viewer)
                    .bind(want + skip)
                    .bind(skip)
                    .fetch_all(db)
                    .await?
                    .into_iter()
                    .take(want as usize),
            );
        }
    }
    let more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);
    let next = match (more, rows.last()) {
        (true, Some(r)) => {
            let (id, a, b, latest): (i64, String, String, i64) =
                (r.try_get(0)?, r.try_get(1)?, r.try_get(2)?, r.try_get(3)?);
            let key = match (a == b, order.sort) {
                (true, _) => order.start(),
                (false, DmSort::Recent | DmSort::Oldest) => DmKey::Activity(latest, id),
                (false, DmSort::Name) => DmKey::Name(r.try_get(4)?, r.try_get(5)?),
            };
            Some(order.encode(&key))
        }
        _ => None,
    };
    Ok(Page {
        items: summaries(db, viewer, &rows, None).await?,
        more,
        next,
    })
}

pub(crate) async fn dms_by_ids(
    db: &Db,
    viewer: &str,
    ids: &[i64],
) -> Result<Vec<DmSummary>, ApiError> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT id, user_a, user_b, last_message_id, CASE WHEN user_a = $1 THEN closed_a ELSE closed_b END FROM dms WHERE (user_a = $1 OR user_b = $1) AND id IN ({}) AND {LIVE_DM} ORDER BY CASE WHEN user_a = user_b THEN 0 ELSE 1 END, last_message_id DESC, id DESC",
        placeholders(2, ids.len())
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(viewer);
    for id in ids {
        query = query.bind(*id);
    }
    let rows = query.fetch_all(db).await?;
    summaries(db, viewer, &rows, Some(4)).await
}

/// List your DMs
///
/// Returns the signed-in user's DM conversations, a page at a time (ordered by `sort`, optionally
/// only friends) or selected by id. Requires a bearer token. General rate-limit bucket.
#[utoipa::path(get, path = "/api/v1/dms", tag = "Direct messages", params(DmListQuery), responses((status = 200, description = "A page (`cursor` or legacy `offset`, `limit` default 50, max 100) of the signed-in user's DM conversations: the self DM first, then in the `sort` order. `recent` (default): by latest message (call logs included) newest first, DMs without messages last by id newest first. `oldest`: the reverse, DMs without messages first by id oldest first. `name`: by the other person's display name, then username, A to Z by code point (ASCII letters ignore case). `friends=true` leaves out DMs with people who are not accepted friends; the self DM stays. When more follow, the `X-Next-Cursor` response header holds the `cursor` for the next page (`dms_cursor` in `/api/v1/me` for the page after the first of the default order); a cursor only works with the `sort` and `friends` it came from. DMs the user closed are left out of pages. With `ids` (comma-separated, max 100) returns just those DMs, self DM first, without `X-Next-Cursor`, skipping ones the user is not part of; closed ones are included with `closed: true`", body = Vec<DmSummary>, headers(("x-next-cursor" = String, description = "Cursor for the next page; absent on the last page"))), (status = 400, description = "Invalid cursor (JSON): malformed, or from another `sort` or `friends`. Or a non-integer `offset`/`limit`, an unknown `sort` or a `friends` other than `true`/`false` (plain-text framework error)", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn list_dms(
    State(state): State<AppState>,
    Authed(user): Authed,
    Query(q): Query<DmListQuery>,
) -> Result<Paged<DmSummary>, ApiError> {
    let DmListQuery {
        offset,
        limit,
        cursor,
        ids,
        sort,
        friends,
    } = q;
    let order = DmOrder {
        sort: sort.unwrap_or_default(),
        friends: friends.unwrap_or(false),
    };
    let db = &state.read();
    match ids {
        Some(raw) => {
            let ids: Vec<i64> = split_list(&raw)
                .iter()
                .filter_map(|s| s.parse().ok())
                .collect();
            Ok(Paged(dms_by_ids(db, &user.username, &ids).await?, None))
        }
        None => {
            let (offset, limit) = page_bounds(offset, limit);
            let cursor = cursor.as_deref().filter(|c| !c.trim().is_empty());
            let Page {
                items,
                more: _,
                next,
            } = dm_page(db, &user.username, order, offset, cursor, limit).await?;
            Ok(Paged(items, next))
        }
    }
}

/// The one answer to a new DM that can't start: no account by that name, one that takes DMs
/// only from friends, or one that blocked you.
pub const NO_CONVERSATION: &str = "Could not start a conversation with that user.";

/// Open a DM
///
/// Returns the one-to-one conversation between the signed-in user and `username`, creating it
/// if it does not exist yet. Opening a DM with yourself returns your self DM. A newly created
/// DM emits `dm_created` to both users. If the signed-in user had closed it, it is reopened for
/// them and `dm_reopened` (`{username, dm_id}`) goes to their connections. Requires a bearer
/// token. A new DM with a name no account has, with an account that takes DMs only from its
/// friends, or with one that blocked you gets one answer, `404 Could not start a conversation
/// with that user.`; your own settings answer `403` (you take DMs only from friends, checked
/// before the name; or you blocked them). The instance may limit new conversations
/// (`dm_creation` in `GET /api/v1/settings`): under `friends` only a DM with a friend is
/// created, under `nobody` none is, and the others get the same 404 with the reason `off_site`.
/// DMs that exist and the self DM always open; writing in them keeps its own checks. A DM that
/// does not exist yet counts as an action on another account, also for a name with no account:
/// new DMs and friend requests share 30 per 10 minutes per account. General rate-limit bucket.
#[utoipa::path(post, path = "/api/v1/dms", tag = "Direct messages", request_body = OpenDmReq, responses((status = 200, description = "The DM with the given user, created if it did not exist yet", body = DmSummary), (status = 400, description = "Malformed JSON or a missing `Content-Type` (plain-text framework error; 415 for the latter)", content_type = "text/plain", body = String), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 403, description = "`You only accept DMs from friends. Change this in Settings > Privacy.` or `You blocked this user. Unblock them to send messages.`: your own settings", body = ApiErrorBody), (status = 404, description = "`Could not start a conversation with that user.`: no such user, one that does not take DMs from you or blocked you, or the instance does not let you start this conversation (identical answers; the last with the reason `off_site`)", body = ApiErrorBody), (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String), (status = 429, description = "`Too many actions on other accounts. Try again later.` with a `Retry-After` header (JSON): more than 30 new DMs and friend requests in 10 minutes. Or too many requests in the general bucket", body = ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn open_dm(
    State(state): State<AppState>,
    Authed(user): Authed,
    Json(req): Json<OpenDmReq>,
) -> Result<Json<DmSummary>, ApiError> {
    let OpenDmReq { username } = req;
    let target = username.to_lowercase();
    let unknown = || ApiError(StatusCode::NOT_FOUND, NO_CONVERSATION.to_string(), None);
    let (a, b) = match user.username <= target {
        true => (user.username.clone(), target.clone()),
        false => (target.clone(), user.username.clone()),
    };
    let existing: Option<(i64, i64)> =
        match sqlx::query("SELECT id, last_message_id FROM dms WHERE user_a = $1 AND user_b = $2")
            .bind(&a)
            .bind(&b)
            .fetch_optional(&state.db)
            .await?
        {
            Some(r) => Some((r.try_get(0)?, r.try_get(1)?)),
            None => None,
        };
    if existing.is_none() && a != b {
        crate::api::lookup::contact(&state, &user)?;
    }
    let (id, latest, created) = match existing {
        Some((id, latest)) => match get_user(&state.db, &target).await? {
            Some(_) => (id, latest, false),
            None => return Err(unknown()),
        },
        None => {
            let allowed = a == b
                || match crate::api::policy::effective(&state.db, Some(&user))
                    .await
                    .dm_creation()
                {
                    DmCreation::Everyone => true,
                    DmCreation::Friends => {
                        crate::api::friends::are_friends(&state.db, &user.username, &target).await?
                    }
                    DmCreation::Nobody => false,
                };
            if !allowed {
                return Err(crate::api::policy::refused(DmCreation::KEY, unknown()));
            }
            if a != b && crate::api::friends::dm_refused(&state.db, &user.username, &target).await?
            {
                return Err(ApiError(
                    StatusCode::FORBIDDEN,
                    YOU_FRIENDS_ONLY.to_string(),
                    None,
                ));
            }
            if get_user(&state.db, &target).await?.is_none() {
                return Err(unknown());
            }
            match check_dm(&state.db, &user.username, &target).await {
                Err(ApiError(StatusCode::FORBIDDEN, text, _)) if text == NOT_ACCEPTING => {
                    return Err(unknown());
                }
                checked => checked?,
            }
            let id: i64 =
                sqlx::query("INSERT INTO dms(user_a, user_b) VALUES($1, $2) RETURNING id")
                    .bind(&a)
                    .bind(&b)
                    .fetch_one(&state.db)
                    .await?
                    .try_get(0)?;
            (id, 0, true)
        }
    };
    if !created && set_closed(&state.db, id, &user.username, false).await? {
        state.hub.broadcast(WsEvent::DmReopened {
            username: user.username.clone(),
            dm_id: id,
        });
    }
    let row = DmRow {
        id,
        other: target,
        is_self: a == b,
        closed: false,
        latest,
    };
    let Some(dm) = summaries_of(&state.db, &user.username, vec![row])
        .await?
        .pop()
    else {
        return Err(unknown());
    };
    if created {
        state.hub.broadcast(WsEvent::DmCreated {
            dm_id: id,
            dm_users: vec![a, b],
        });
    }
    Ok(Json(dm))
}

async fn set_closed(db: &Db, id: i64, username: &str, closed: bool) -> Result<bool, ApiError> {
    let mut changed = false;
    for (col, side) in [("closed_a", "user_a"), ("closed_b", "user_b")] {
        let sql =
            format!("UPDATE dms SET {col} = $1 WHERE id = $2 AND {side} = $3 AND {col} <> $1");
        changed |= sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(i64::from(closed))
            .bind(id)
            .bind(username)
            .execute(db)
            .await?
            .rows_affected()
            > 0;
    }
    Ok(changed)
}

/// Reopens a DM for `recipients` (the participants a new message in it from `actor` reaches)
/// and tells each one whose list it was hidden from. A participant left out, or one who blocked
/// `actor`, stays closed.
pub(crate) async fn reopen_for(state: &AppState, id: i64, actor: &str, recipients: &[String]) {
    let recipients = match not_blocking(&state.db, actor, recipients).await {
        Ok(users) => users,
        Err(ApiError(_, e, _)) => {
            tracing::warn!("dm {id} not reopened: {e}");
            return;
        }
    };
    let mut done: Vec<&str> = Vec::with_capacity(recipients.len());
    for user in &recipients {
        if done.contains(&user.as_str()) {
            continue;
        }
        done.push(user);
        match set_closed(&state.db, id, user, false).await {
            Ok(true) => state.hub.broadcast(WsEvent::DmReopened {
                username: user.clone(),
                dm_id: id,
            }),
            Ok(false) => {}
            Err(ApiError(_, e, _)) => tracing::warn!("dm {id} not reopened: {e}"),
        }
    }
}

/// Closes `user`'s side of their DM with `other`, if there is one, like `POST
/// /api/v1/dms/{id}/close`, and returns its id.
pub(crate) async fn close_with(
    state: &AppState,
    user: &User,
    other: &str,
) -> Result<Option<i64>, ApiError> {
    let (a, b) = match user.username.as_str() <= other {
        true => (user.username.as_str(), other),
        false => (other, user.username.as_str()),
    };
    let Some(row) = sqlx::query("SELECT id FROM dms WHERE user_a = $1 AND user_b = $2")
        .bind(a)
        .bind(b)
        .fetch_optional(&state.db)
        .await?
    else {
        return Ok(None);
    };
    let id: i64 = row.try_get(0)?;
    if set_closed(&state.db, id, &user.username, true).await? {
        state.hub.broadcast(WsEvent::DmClosed {
            username: user.username.clone(),
            dm_id: id,
        });
    }
    read_dm_latest(state, user, id).await?;
    Ok(Some(id))
}

/// Close a DM
///
/// Hides a DM from the signed-in user's DM list on all their devices; the history is kept and
/// the other participant's list is unchanged. The DM comes back when a new message (or call)
/// arrives in it from either side, or when the user opens it again with `POST /api/v1/dms`. Closing
/// marks the DM read up to its newest message and its pings seen (`read_updated`). Emits
/// `dm_closed` (`{username, dm_id}`) to the user's connections when it was open. Closing a
/// closed DM changes nothing. Requires a bearer token and being a participant. General
/// rate-limit bucket.
#[utoipa::path(post, path = "/api/v1/dms/{id}/close", tag = "Direct messages", params(("id" = i64, Path, description = "DM conversation id")), responses((status = 200, description = "Closed; body `{\"ok\": true}`", body = OkResp), (status = 400, description = "Non-numeric id (plain-text framework error)", content_type = "text/plain", body = String), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 404, description = "`Not found`: no such DM, you are not a participant, or a participant's account is being deleted; identical responses", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn close_dm(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Authed(user): Authed,
) -> Result<Json<OkResp>, ApiError> {
    resolve_dm(&state.db, id, &user).await?;
    if set_closed(&state.db, id, &user.username, true).await? {
        state.hub.broadcast(WsEvent::DmClosed {
            username: user.username.clone(),
            dm_id: id,
        });
    }
    read_dm_latest(&state, &user, id).await?;
    Ok(ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::auth::me_payload;
    use crate::api::test_util::{done, mem_user, pg_done, pg_state, temp_state};
    use crate::db::{is_sqlite, now};

    async fn add_user(db: &Db, name: &str, display: &str) {
        crate::db::NewUser::plain(name)
            .shown(display)
            .color("#123456")
            .at(now())
            .add(db)
            .await;
    }

    async fn add_dm(db: &Db, a: &str, b: &str) -> i64 {
        sqlx::query("INSERT INTO dms(user_a, user_b) VALUES($1, $2) RETURNING id")
            .bind(a)
            .bind(b)
            .fetch_one(db)
            .await
            .expect("insert dm")
            .try_get(0)
            .expect("dm id")
    }

    async fn add_msg(db: &Db, dm: i64, kind: &str) {
        add_msg_at(db, dm, kind, now()).await;
    }

    async fn add_msg_at(db: &Db, dm: i64, kind: &str, at: i64) -> i64 {
        sqlx::query("INSERT INTO messages(dm_id, author, content, kind, created_at) VALUES($1, 'alice', 'x', $2, $3) RETURNING id")
            .bind(dm)
            .bind(kind)
            .bind(at)
            .fetch_one(db)
            .await
            .expect("insert message")
            .try_get(0)
            .expect("message id")
    }

    async fn list(
        state: &AppState,
        offset: Option<i64>,
        limit: Option<i64>,
        ids: Option<&str>,
    ) -> Vec<i64> {
        list_dms(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            Query(DmListQuery {
                offset,
                limit,
                cursor: None,
                ids: ids.map(str::to_string),
                sort: None,
                friends: None,
            }),
        )
        .await
        .expect("list dms")
        .0
        .iter()
        .map(|d| d.id)
        .collect()
    }

    fn answer(res: Result<impl Sized, ApiError>) -> Option<(StatusCode, String, Option<String>)> {
        res.err().map(|ApiError(code, text, reason)| {
            (
                code,
                text,
                reason.map(|r| serde_json::to_string(&r).expect("reason")),
            )
        })
    }

    async fn open(state: &AppState, by: &str, name: &str) -> Result<Json<DmSummary>, ApiError> {
        open_dm(
            State(state.clone()),
            Authed(mem_user(by, false)),
            Json(OpenDmReq {
                username: name.to_string(),
            }),
        )
        .await
    }

    async fn count(db: &Db, sql: &str) -> i64 {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .fetch_one(db)
            .await
            .expect(sql)
            .try_get(0)
            .expect("count")
    }

    async fn set(db: &Db, sql: &str) {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .execute(db)
            .await
            .expect(sql);
    }

    #[tokio::test]
    async fn a_new_dm_that_cannot_start_answers_one_way() {
        let (state, path) = temp_state("dm_uniform").await;
        let db = &state.db;
        for name in ["alice", "bob", "carol", "yan", "zed", "zoe"] {
            add_user(db, name, name).await;
        }
        set(db, "INSERT INTO privacy(username, dms, friend_requests) VALUES('zed', 'friends', 'everyone')").await;
        set(db, "INSERT INTO blocks(blocker, blocked, created_at) VALUES('yan', 'alice', 1), ('alice', 'carol', 1)").await;
        let uniform = Some((StatusCode::NOT_FOUND, NO_CONVERSATION.to_string(), None));
        for name in ["ghost", "Ghost", "zed", "yan"] {
            assert_eq!(
                answer(open(&state, "alice", name).await),
                uniform,
                "{name}: no account, friends only and a block answer alike"
            );
        }
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM dms").await,
            0,
            "nothing is created"
        );
        assert_eq!(
            answer(open(&state, "alice", "carol").await),
            Some((
                StatusCode::FORBIDDEN,
                "You blocked this user. Unblock them to send messages.".to_string(),
                None
            )),
            "alice's own block says so"
        );
        assert!(open(&state, "alice", "bob").await.is_ok());
        let me = open(&state, "alice", "alice").await.expect("self DM").0;
        assert!(me.is_self);
        set(db, "INSERT INTO privacy(username, dms, friend_requests) VALUES('alice', 'friends', 'everyone')").await;
        let own = Some((
            StatusCode::FORBIDDEN,
            crate::api::blocks::YOU_FRIENDS_ONLY.to_string(),
            None,
        ));
        for name in ["ghost", "zoe"] {
            assert_eq!(
                answer(open(&state, "alice", name).await),
                own,
                "{name}: alice's own setting comes before the name"
            );
        }
        assert!(
            open(&state, "alice", "bob").await.is_ok(),
            "a DM that exists still opens"
        );
        assert!(open(&state, "alice", "alice").await.is_ok());
        set(db, "DELETE FROM privacy WHERE username = 'alice'").await;
        set(
            db,
            "UPDATE settings SET value = 'friends' WHERE key = 'dm_creation'",
        )
        .await;
        crate::api::Settings::forget(db);
        let off = answer(open(&state, "alice", "ghost").await);
        assert_eq!(answer(open(&state, "alice", "zoe").await), off);
        let (code, text, reason) = off.expect("refused");
        assert_eq!(
            (code, text.as_str()),
            (StatusCode::NOT_FOUND, NO_CONVERSATION)
        );
        assert!(reason.expect("a reason").contains("dm_creation"));
        done(state, path).await;
    }

    #[tokio::test]
    async fn an_existing_dm_keeps_its_write_guards() {
        let (state, path) = temp_state("dm_existing").await;
        let db = &state.db;
        for name in ["alice", "zed"] {
            add_user(db, name, name).await;
        }
        let dm = open(&state, "alice", "zed").await.expect("dm").0;
        set(db, "INSERT INTO privacy(username, dms, friend_requests) VALUES('zed', 'friends', 'everyone')").await;
        assert_eq!(
            open(&state, "alice", "zed")
                .await
                .expect("still opens")
                .0
                .id,
            dm.id
        );
        let sent = crate::api::messages::send_dm_message(
            State(state.clone()),
            Path(dm.id),
            Authed(mem_user("alice", false)),
            Json(serde_json::from_value(serde_json::json!({ "content": "hi" })).expect("req")),
        )
        .await;
        assert_eq!(
            answer(sent),
            Some((
                StatusCode::FORBIDDEN,
                crate::api::blocks::NOT_ACCEPTING.to_string(),
                None
            )),
            "writing keeps today's answer"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn your_own_settings_answer_before_theirs() {
        let (state, path) = temp_state("dm_own_first").await;
        let db = &state.db;
        for name in ["alice", "carol", "dave", "erin"] {
            add_user(db, name, name).await;
        }
        set(db, "INSERT INTO privacy(username, dms, friend_requests) VALUES('dave', 'friends', 'everyone')").await;
        set(
            db,
            "INSERT INTO blocks(blocker, blocked, created_at) VALUES('carol', 'alice', 1)",
        )
        .await;
        let write = |dm: i64| {
            let state = state.clone();
            async move {
                answer(
                    crate::api::messages::send_dm_message(
                        State(state),
                        Path(dm),
                        Authed(mem_user("alice", false)),
                        Json(
                            serde_json::from_value(serde_json::json!({ "content": "hi" }))
                                .expect("req"),
                        ),
                    )
                    .await,
                )
            }
        };
        let theirs = ["carol", "dave", "erin"];
        let mut dms = Vec::new();
        for name in theirs {
            dms.push(add_dm(db, "alice", name).await);
        }
        set(db, "INSERT INTO blocks(blocker, blocked, created_at) VALUES('alice', 'carol', 1), ('alice', 'dave', 1), ('alice', 'erin', 1)").await;
        let blocked = Some((
            StatusCode::FORBIDDEN,
            "You blocked this user. Unblock them to send messages.".to_string(),
            None,
        ));
        for (name, dm) in theirs.into_iter().zip(dms.iter().copied()) {
            assert_eq!(write(dm).await, blocked, "{name}: alice's own block first");
        }
        set(db, "DELETE FROM dms").await;
        for name in theirs {
            assert_eq!(
                answer(open(&state, "alice", name).await),
                blocked,
                "{name}: a new DM says alice's own block, whatever {name} chose"
            );
        }
        set(db, "DELETE FROM blocks WHERE blocker = 'alice'").await;
        set(db, "INSERT INTO privacy(username, dms, friend_requests) VALUES('alice', 'friends', 'everyone')").await;
        let mut dms = Vec::new();
        for name in theirs {
            dms.push(add_dm(db, "alice", name).await);
        }
        let own = Some((
            StatusCode::FORBIDDEN,
            crate::api::blocks::YOU_FRIENDS_ONLY.to_string(),
            None,
        ));
        for (name, dm) in theirs.into_iter().zip(dms) {
            assert_eq!(write(dm).await, own, "{name}: alice's own DM setting first");
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn dm_order_paging_and_batch() {
        let (state, path) = temp_state("dm_order").await;
        let db = &state.db;
        add_user(db, "alice", "Alice").await;
        add_user(db, "bob", "Bobby").await;
        let me = add_dm(db, "alice", "alice").await;
        let bob = add_dm(db, "alice", "bob").await;
        let carol = add_dm(db, "alice", "carol").await;
        let dave = add_dm(db, "alice", "dave").await;
        let erin = add_dm(db, "alice", "erin").await;
        let frank = add_dm(db, "alice", "frank").await;
        let other = add_dm(db, "bob", "carol").await;
        add_msg(db, bob, "user").await;
        add_msg(db, erin, "user").await;
        add_msg(db, other, "user").await;
        add_msg(db, carol, "call").await;
        let order = vec![me, carol, erin, bob, frank, dave];
        assert_eq!(list(&state, None, None, None).await, order);
        assert_eq!(list(&state, Some(0), Some(2), None).await, order[..2]);
        assert_eq!(list(&state, Some(2), Some(2), None).await, order[2..4]);
        assert_eq!(list(&state, Some(4), Some(2), None).await, order[4..]);
        assert_eq!(list(&state, Some(-5), Some(0), None).await, order[..1]);
        let first = dm_page(db, "alice", DmOrder::default(), 0, None, 5)
            .await
            .expect("page");
        assert_eq!(first.items.len(), 5);
        assert!(first.more);
        let rest = dm_page(db, "alice", DmOrder::default(), 5, None, 5)
            .await
            .expect("page");
        assert_eq!(rest.items.len(), 1);
        assert!(!rest.more);
        let mut walked = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let page = dm_page(db, "alice", DmOrder::default(), 0, cursor.as_deref(), 2)
                .await
                .expect("cursor page");
            walked.extend(page.items.iter().map(|d| d.id));
            match page.next {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        assert_eq!(walked, order);
        let picked = format!("{dave},{other},abc,{carol},{dave}");
        assert_eq!(
            list(&state, None, None, Some(&picked)).await,
            vec![carol, dave]
        );
        assert!(list(&state, None, None, Some("")).await.is_empty());
        let dms = dms_by_ids(db, "alice", &[me, bob, dave])
            .await
            .expect("by ids");
        assert!(dms[0].is_self && dms[0].other.display_name == "Alice");
        assert_eq!(dms[1].other.display_name, "Bobby");
        assert_eq!(dms[1].other.avatar_color.as_deref(), Some("#123456"));
        assert_eq!(dms[2].other.username, "dave");
        assert_eq!(dms[2].other.avatar_color.as_deref(), Some("#9e9e9e"));
        done(state, path).await;
    }

    #[test]
    fn split_list_caps_and_dedupes() {
        let raw: Vec<String> = (0..300).map(|n| (n % 150).to_string()).collect();
        let out = split_list(&format!(" a, ,a,{}", raw.join(",")));
        assert_eq!(out.len(), 100);
        assert_eq!(out[..3], ["a", "0", "1"]);
        assert_eq!(out[99], "98");
    }

    #[tokio::test]
    async fn me_payload_first_pages() {
        let (state, path) = temp_state("me_pages").await;
        let db = &state.db;
        add_user(db, "alice", "Alice").await;
        add_dm(db, "alice", "alice").await;
        for n in 0..55 {
            add_dm(db, "alice", &format!("u{n:02}")).await;
        }
        let user = crate::db::get_user(db, "alice")
            .await
            .expect("load")
            .expect("alice");
        let me = me_payload(db, &user).await.expect("me");
        assert_eq!(me.dms.len(), 50);
        assert!(me.dms_more);
        assert!(me.dms[0].is_self);
        assert_eq!(me.dms[1].other.username, "u54");
        assert!(me.servers.is_empty());
        assert!(!me.servers_more);
        let ids: Vec<i64> = me.dms.iter().map(|d| d.id).collect();
        let next = dm_page(db, "alice", DmOrder::default(), 50, None, 50)
            .await
            .expect("next");
        assert_eq!(next.items.len(), 6);
        assert!(!next.more);
        assert!(next.items.iter().all(|d| !ids.contains(&d.id)));
        let after = dm_page(
            db,
            "alice",
            DmOrder::default(),
            0,
            me.dms_cursor.as_deref(),
            50,
        )
        .await
        .expect("cursor");
        let a: Vec<i64> = after.items.iter().map(|d| d.id).collect();
        let b: Vec<i64> = next.items.iter().map(|d| d.id).collect();
        assert_eq!(a, b);
        done(state, path).await;
    }

    #[tokio::test]
    async fn closing_hides_until_a_message_or_open() {
        use crate::api::messages::{send_dm_message, unreads};
        let (state, path) = temp_state("dm_close").await;
        let db = &state.db;
        for name in ["alice", "bob", "carol"] {
            add_user(db, name, name).await;
        }
        let open = |by: &str, name: &str| {
            let state = state.clone();
            let (by, name) = (by.to_string(), name.to_string());
            async move {
                open_dm(
                    State(state),
                    Authed(mem_user(&by, false)),
                    Json(OpenDmReq { username: name }),
                )
                .await
                .expect("open dm")
                .0
            }
        };
        let close = |by: &str, id: i64| {
            let done = close_dm(State(state.clone()), Path(id), Authed(mem_user(by, false)));
            async move { done.await.map(|_| ()) }
        };
        let send = |by: &str, id: i64, text: &str| {
            let sent = send_dm_message(
                State(state.clone()),
                Path(id),
                Authed(mem_user(by, false)),
                Json(serde_json::from_value(serde_json::json!({ "content": text })).expect("req")),
            );
            async move { sent.await.map(|_| ()) }
        };
        let listed = |who: &str| {
            let state = state.clone();
            let who = who.to_string();
            async move {
                dm_page(&state.db, &who, DmOrder::default(), 0, None, 50)
                    .await
                    .expect("page")
                    .items
                    .iter()
                    .map(|d| d.id)
                    .collect::<Vec<i64>>()
            }
        };
        let unread = |who: &str| {
            let state = state.clone();
            let who = who.to_string();
            async move {
                unreads(
                    State(state),
                    Authed(mem_user(&who, false)),
                    Query(serde_json::from_value(serde_json::json!({})).expect("query")),
                )
                .await
                .expect("unreads")
                .0
                .items
                .iter()
                .map(|u| (u.scope.clone(), u.pings))
                .collect::<Vec<(String, i64)>>()
            }
        };
        let me = open("alice", "alice").await;
        let dm = open("alice", "bob").await;
        send("bob", dm.id, "hi @alice").await.expect("send");
        assert_eq!(unread("alice").await, [(format!("d{}", dm.id), 1)]);
        let mut rx = state.hub.subscribe();
        assert!(matches!(
            close("carol", dm.id).await,
            Err(ApiError(StatusCode::NOT_FOUND, _, _))
        ));
        close("alice", dm.id).await.expect("close");
        assert!(matches!(
            rx.try_recv(),
            Ok(WsEvent::DmClosed { username, dm_id }) if username == "alice" && dm_id == dm.id
        ));
        assert!(matches!(
            rx.try_recv(),
            Ok(WsEvent::ReadUpdated { username, .. }) if username == "alice"
        ));
        assert!(rx.try_recv().is_err());
        assert_eq!(listed("alice").await, [me.id]);
        assert_eq!(listed("bob").await, [dm.id]);
        assert!(unread("alice").await.is_empty());
        let found = dms_by_ids(db, "alice", &[dm.id, me.id]).await.expect("ids");
        assert_eq!(
            found.iter().map(|d| (d.id, d.closed)).collect::<Vec<_>>(),
            [(me.id, false), (dm.id, true)]
        );
        assert!(!dms_by_ids(db, "bob", &[dm.id]).await.expect("ids")[0].closed);
        close("alice", dm.id).await.expect("close again");
        assert!(rx.try_recv().is_err());

        send("bob", dm.id, "back").await.expect("send");
        assert!(matches!(
            rx.try_recv(),
            Ok(WsEvent::DmReopened { username, dm_id }) if username == "alice" && dm_id == dm.id
        ));
        assert!(matches!(rx.try_recv(), Ok(WsEvent::Message { .. })));
        assert_eq!(listed("alice").await, [me.id, dm.id]);
        assert_eq!(unread("alice").await, [(format!("d{}", dm.id), 0)]);

        close("alice", dm.id).await.expect("close");
        close("bob", dm.id).await.expect("bob closes");
        while rx.try_recv().is_ok() {}
        send("alice", dm.id, "both").await.expect("send");
        let mut reopened = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            if let WsEvent::DmReopened { username, dm_id: _ } = ev {
                reopened.push(username);
            }
        }
        assert_eq!(reopened, ["alice", "bob"]);

        close("alice", dm.id).await.expect("close");
        reopen_for(&state, dm.id, "alice", &["bob".to_string()]).await;
        assert_eq!(listed("alice").await, [me.id]);
        while rx.try_recv().is_ok() {}
        assert!(!open("alice", "Bob").await.closed);
        assert!(matches!(
            rx.try_recv(),
            Ok(WsEvent::DmReopened { username, .. }) if username == "alice"
        ));
        assert_eq!(listed("alice").await, [me.id, dm.id]);
        open("alice", "bob").await;
        assert!(rx.try_recv().is_err());

        close("alice", me.id).await.expect("close self");
        assert_eq!(listed("alice").await, [dm.id]);
        assert!(dms_by_ids(db, "alice", &[me.id]).await.expect("ids")[0].closed);
        send("alice", me.id, "note").await.expect("note");
        assert_eq!(listed("alice").await, [me.id, dm.id]);
        done(state, path).await;
    }

    #[tokio::test]
    async fn dm_created_carries_id() {
        let (state, path) = temp_state("dm_created").await;
        add_user(&state.db, "alice", "Alice").await;
        add_user(&state.db, "bob", "Bob").await;
        let mut rx = state.hub.subscribe();
        let open = |name: &str| {
            let state = state.clone();
            let name = name.to_string();
            async move {
                open_dm(
                    State(state),
                    Authed(mem_user("alice", false)),
                    Json(OpenDmReq { username: name }),
                )
                .await
                .expect("open dm")
                .0
            }
        };
        let dm = open("Bob").await;
        assert!(matches!(
            rx.try_recv(),
            Ok(WsEvent::DmCreated { dm_id, dm_users }) if dm_id == dm.id && dm_users == ["alice", "bob"]
        ));
        assert_eq!(open("bob").await.id, dm.id);
        assert!(rx.try_recv().is_err());
        done(state, path).await;
    }

    const ORDERS: [DmOrder; 6] = [
        DmOrder {
            sort: DmSort::Recent,
            friends: false,
        },
        DmOrder {
            sort: DmSort::Oldest,
            friends: false,
        },
        DmOrder {
            sort: DmSort::Name,
            friends: false,
        },
        DmOrder {
            sort: DmSort::Recent,
            friends: true,
        },
        DmOrder {
            sort: DmSort::Oldest,
            friends: true,
        },
        DmOrder {
            sort: DmSort::Name,
            friends: true,
        },
    ];

    async fn walk(db: &Db, order: DmOrder, size: i64) -> Vec<DmSummary> {
        let mut walked = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let page = dm_page(db, "alice", order, 0, cursor.as_deref(), size)
                .await
                .expect("cursor page");
            assert!(page.items.len() as i64 <= size);
            walked.extend(page.items);
            match page.next {
                Some(next) => cursor = Some(next),
                None => return walked,
            }
        }
    }

    async fn walk_offsets(db: &Db, order: DmOrder, size: i64) -> Vec<i64> {
        let mut walked = Vec::new();
        loop {
            let got = dm_page(db, "alice", order, walked.len() as i64, None, size)
                .await
                .expect("offset page");
            walked.extend(got.items.iter().map(|d| d.id));
            if !got.more {
                return walked;
            }
        }
    }

    async fn add_friends(db: &Db, pairs: &[(&str, &str)]) {
        for (a, b) in pairs {
            sqlx::query("INSERT INTO friends(username, friend, created_at) VALUES($1, $2, 1)")
                .bind(a)
                .bind(b)
                .execute(db)
                .await
                .expect("friend");
        }
    }

    async fn sorts_and_friends_filter(state: &AppState) {
        let db = &state.db;
        for (name, display) in [
            ("alice", "Alice"),
            ("aaron", "Mia"),
            ("abe", "bea"),
            ("bob", "Zoe"),
            ("carol", "amy"),
            ("dave", "Bea"),
            ("frank", "Mia"),
            ("gina", "Gina"),
            ("hank", "Hank"),
        ] {
            add_user(db, name, display).await;
        }
        sqlx::query("UPDATE users SET password_hash = '!purging' WHERE username = 'hank'")
            .execute(db)
            .await
            .expect("purging");
        let me = add_dm(db, "alice", "alice").await;
        let aaron = add_dm(db, "aaron", "alice").await;
        let bob = add_dm(db, "alice", "bob").await;
        let carol = add_dm(db, "alice", "carol").await;
        let abe = add_dm(db, "abe", "alice").await;
        let dave = add_dm(db, "alice", "dave").await;
        let erin = add_dm(db, "alice", "erin").await;
        let frank = add_dm(db, "alice", "frank").await;
        let gina = add_dm(db, "alice", "gina").await;
        let hank = add_dm(db, "alice", "hank").await;
        let other = add_dm(db, "bob", "carol").await;
        sqlx::query("UPDATE dms SET closed_a = 1 WHERE id = $1")
            .bind(gina)
            .execute(db)
            .await
            .expect("close");
        add_msg_at(db, carol, "user", 100).await;
        add_msg_at(db, other, "user", 110).await;
        add_msg_at(db, aaron, "user", 120).await;
        let call = add_msg_at(db, bob, "call", 130).await;
        add_msg_at(db, frank, "user", 140).await;
        let latest = add_msg_at(db, carol, "user", 150).await;
        let closed = add_msg_at(db, gina, "user", 160).await;
        add_msg_at(db, hank, "user", 170).await;
        add_friends(
            db,
            &[
                ("alice", "carol"),
                ("carol", "alice"),
                ("alice", "abe"),
                ("abe", "alice"),
                ("alice", "frank"),
                ("frank", "alice"),
                ("alice", "bob"),
                ("bob", "alice"),
                ("alice", "gina"),
                ("alice", "hank"),
                ("dave", "alice"),
            ],
        )
        .await;
        sqlx::query(
            "INSERT INTO friend_requests(sender, recipient, created_at) VALUES('alice', 'erin', 1)",
        )
        .execute(db)
        .await
        .expect("request");
        let expected: [Vec<i64>; 6] = [
            vec![me, carol, frank, bob, aaron, erin, dave, abe],
            vec![me, abe, dave, erin, aaron, bob, frank, carol],
            vec![me, carol, abe, dave, erin, aaron, frank, bob],
            vec![me, carol, frank, bob, abe],
            vec![me, abe, bob, frank, carol],
            vec![me, carol, abe, frank, bob],
        ];
        for (order, want) in ORDERS.iter().zip(&expected) {
            for size in [1, 2, 3, 100] {
                let ids: Vec<i64> = walk(db, *order, size).await.iter().map(|d| d.id).collect();
                assert_eq!(&ids, want, "{order:?} by cursor, pages of {size}");
            }
            for size in [1, 2, 3] {
                assert_eq!(
                    &walk_offsets(db, *order, size).await,
                    want,
                    "{order:?} by offset, pages of {size}"
                );
            }
        }

        let listed = walk(db, DmOrder::default(), 50).await;
        let find = |id: i64| listed.iter().find(|d| d.id == id).expect("listed");
        let fields = |d: &DmSummary| (d.last_message_id, d.last_message_at, d.friend);
        assert_eq!(fields(find(carol)), (Some(latest), Some(150), true));
        assert_eq!(fields(find(bob)), (Some(call), Some(130), true));
        assert_eq!(fields(find(abe)), (None, None, true));
        assert_eq!(fields(find(dave)), (None, None, false));
        assert_eq!(fields(find(erin)), (None, None, false));
        assert_eq!(fields(find(me)), (None, None, false));
        let json = serde_json::to_value(find(abe)).expect("json");
        assert!(json["last_message_id"].is_null() && json["last_message_at"].is_null());
        assert_eq!(json["friend"], true);
        let by_id = dms_by_ids(db, "alice", &[gina, dave])
            .await
            .expect("by ids");
        assert_eq!(
            by_id
                .iter()
                .map(|d| (d.id, d.closed, d.last_message_id, d.friend))
                .collect::<Vec<_>>(),
            [(gina, true, Some(closed), true), (dave, false, None, false)]
        );
        let opened = open_dm(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            Json(OpenDmReq {
                username: "Carol".to_string(),
            }),
        )
        .await
        .expect("open")
        .0;
        assert_eq!(
            (
                opened.id,
                opened.last_message_id,
                opened.last_message_at,
                opened.friend
            ),
            (carol, Some(latest), Some(150), true)
        );
        let fresh = open_dm(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            Json(OpenDmReq {
                username: "gina".to_string(),
            }),
        )
        .await
        .expect("reopen")
        .0;
        assert_eq!((fresh.id, fresh.last_message_at), (gina, Some(160)));

        for from in ORDERS {
            for size in [1, 2] {
                let cursor = dm_page(db, "alice", from, 0, None, size)
                    .await
                    .expect("page")
                    .next
                    .expect("more");
                for to in ORDERS.into_iter().filter(|o| *o != from) {
                    let Err(ApiError(code, msg, _)) =
                        dm_page(db, "alice", to, 0, Some(&cursor), size).await
                    else {
                        panic!("{from:?} cursor taken by {to:?}");
                    };
                    assert_eq!(
                        (code, msg.as_str()),
                        (StatusCode::BAD_REQUEST, "Invalid cursor")
                    );
                }
            }
        }

        let page = |sort: DmSort, cursor: Option<String>| {
            list_dms(
                State(state.clone()),
                Authed(mem_user("alice", false)),
                Query(DmListQuery {
                    offset: None,
                    limit: Some(2),
                    cursor,
                    ids: None,
                    sort: Some(sort),
                    friends: Some(true),
                }),
            )
        };
        let Paged(first, next) = page(DmSort::Name, None).await.expect("first");
        assert_eq!(first.iter().map(|d| d.id).collect::<Vec<_>>(), [me, carol]);
        let Paged(second, _) = page(DmSort::Name, next.clone()).await.expect("second");
        assert_eq!(second.iter().map(|d| d.id).collect::<Vec<_>>(), [abe, gina]);
        assert!(matches!(
            page(DmSort::Oldest, next).await,
            Err(ApiError(StatusCode::BAD_REQUEST, _, _))
        ));
    }

    #[tokio::test]
    async fn dm_list_sorts_and_friends_filter_page_without_gaps() {
        let (state, path) = temp_state("dm_sorts").await;
        sorts_and_friends_filter(&state).await;
        done(state, path).await;
        if let Some((state, pg)) = pg_state("dm_sorts").await {
            sorts_and_friends_filter(&state).await;
            pg_done(state, pg).await;
        }
    }

    async fn names_fold_ascii_only(db: &Db) {
        add_user(db, "alice", "Alice").await;
        let mut dms = Vec::new();
        for (name, display) in [
            ("u1", "\u{0411}\u{043e}\u{0440}\u{0438}\u{0441}"),
            ("u2", "\u{0430}\u{043d}\u{043d}\u{0430}"),
            ("u3", "\u{00c9}zra"),
            ("u4", "\u{00e9}a"),
            ("u5", "bob"),
            ("u6", "Zed"),
            ("u7", "adam"),
        ] {
            add_user(db, name, display).await;
            dms.push(add_dm(db, "alice", name).await);
        }
        let me = add_dm(db, "alice", "alice").await;
        let [boris, anna, ezra, ea, bob, zed, adam] = dms[..] else {
            panic!("seven dms");
        };
        let order = DmOrder {
            sort: DmSort::Name,
            friends: false,
        };
        for size in [1, 2, 100] {
            let ids: Vec<i64> = walk(db, order, size).await.iter().map(|d| d.id).collect();
            assert_eq!(
                ids,
                [me, adam, bob, zed, ezra, ea, boris, anna],
                "pages of {size}"
            );
        }
    }

    #[tokio::test]
    async fn name_order_folds_only_ascii_letters() {
        let (state, path) = temp_state("dm_names").await;
        names_fold_ascii_only(&state.db).await;
        done(state, path).await;
        if let Some((state, pg)) = pg_state("dm_names").await {
            names_fold_ascii_only(&state.db).await;
            pg_done(state, pg).await;
        }
    }

    async fn plan(db: &Db, sql: &str) -> String {
        let mut tx = db.begin().await.expect("begin");
        let (explain, column) = match is_sqlite(db) {
            true => ("EXPLAIN QUERY PLAN", 3),
            false => {
                sqlx::query("SET LOCAL enable_seqscan = off")
                    .execute(&mut *tx)
                    .await
                    .expect("no scans where an index works");
                ("EXPLAIN", 0)
            }
        };
        sqlx::query(sqlx::AssertSqlSafe(format!("{explain} {sql}")))
            .fetch_all(&mut *tx)
            .await
            .expect("explain")
            .iter()
            .map(|r| r.try_get::<String, _>(column).expect("plan line"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    async fn big_account(db: &Db) {
        let started = tokio::time::Instant::now();
        let names: Vec<(String, String)> = (0..2000)
            .map(|n| {
                let side = match n % 2 {
                    0 => "a",
                    _ => "u",
                };
                (
                    format!("{side}{n:04}"),
                    format!("Name {:04}", (n * 7919) % 2000),
                )
            })
            .collect();
        let mut tx = db.begin().await.expect("begin");
        crate::db::NewUser::plain("alice").add(&mut *tx).await;
        for (name, display) in &names {
            crate::db::NewUser::plain(name)
                .shown(display)
                .add(&mut *tx)
                .await;
        }
        tx.commit().await.expect("users");
        sqlx::query("INSERT INTO dms(user_a, user_b) SELECT CASE WHEN username < 'alice' THEN username ELSE 'alice' END, CASE WHEN username < 'alice' THEN 'alice' ELSE username END FROM users ORDER BY username")
            .execute(db)
            .await
            .expect("dms");
        sqlx::query("INSERT INTO dms(user_a, user_b) SELECT a.username, b.username FROM users a JOIN users b ON a.username < b.username AND substr(a.username, 4, 2) = substr(b.username, 4, 2) WHERE a.username <> 'alice' AND b.username <> 'alice'")
            .execute(db)
            .await
            .expect("other dms");
        sqlx::query("INSERT INTO friends(username, friend, created_at) SELECT 'alice', username, 1 FROM users WHERE username LIKE '%3' OR username LIKE '%6'")
            .execute(db)
            .await
            .expect("friends");
        sqlx::query("WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 112) INSERT INTO messages(dm_id, author, content, created_at) SELECT d.id, 'alice', 'x', 1000 + g.n FROM dms d CROSS JOIN g WHERE d.id <= 2001 AND d.id % 10 <> 0 AND d.user_a <> d.user_b ORDER BY g.n, (d.id * 7919) % 2003")
            .execute(db)
            .await
            .expect("messages");
        let count: i64 = sqlx::query("SELECT COUNT(*) FROM messages WHERE dm_id IS NOT NULL")
            .fetch_one(db)
            .await
            .expect("count")
            .try_get(0)
            .expect("count");
        assert!(count >= 200_000, "{count} messages");
        let analyze = match is_sqlite(db) {
            true => "ANALYZE",
            false => "VACUUM ANALYZE",
        };
        sqlx::query(analyze).execute(db).await.expect("analyze");
        eprintln!("dm list speed: seeded in {:?}", started.elapsed());
    }

    async fn big_account_lists_fast(db: &Db) {
        big_account(db).await;
        let friends: i64 = sqlx::query("SELECT COUNT(*) FROM friends WHERE username = 'alice'")
            .fetch_one(db)
            .await
            .expect("count")
            .try_get(0)
            .expect("count");
        let sqlite = is_sqlite(db);
        for order in ORDERS {
            let all = walk(db, order, 100).await;
            let ids: std::collections::HashSet<i64> = all.iter().map(|d| d.id).collect();
            let want = match order.friends {
                true => friends + 1,
                false => 2001,
            };
            assert_eq!(
                (all.len() as i64, ids.len() as i64),
                (want, want),
                "{order:?}"
            );
            assert!(all[0].is_self);
            let keys: Vec<(i64, i64)> = all[1..]
                .iter()
                .map(|d| (d.last_message_id.unwrap_or(0), d.id))
                .collect();
            match order.sort {
                DmSort::Recent => assert!(keys.windows(2).all(|w| w[0] > w[1]), "{order:?}"),
                DmSort::Oldest => assert!(keys.windows(2).all(|w| w[0] < w[1]), "{order:?}"),
                DmSort::Name => assert!(
                    all[1..].windows(2).all(|w| (
                        w[0].other.display_name.to_lowercase(),
                        &w[0].other.username
                    ) < (
                        w[1].other.display_name.to_lowercase(),
                        &w[1].other.username
                    )),
                    "{order:?}"
                ),
            }
            assert!(all.iter().all(|d| !order.friends || d.friend || d.is_self));
            let middle = dm_page(db, "alice", order, 0, None, 200)
                .await
                .expect("page")
                .next
                .expect("more");
            let mut best = [std::time::Duration::MAX; 2];
            for _ in 0..11 {
                for (n, cursor) in [None, Some(middle.as_str())].into_iter().enumerate() {
                    let started = tokio::time::Instant::now();
                    let page = dm_page(db, "alice", order, 0, cursor, 50)
                        .await
                        .expect("page");
                    best[n] = best[n].min(started.elapsed());
                    assert_eq!(page.items.len(), 50);
                }
            }
            eprintln!(
                "dm list speed {}: {order:?} first page {:?}, later page {:?}",
                match sqlite {
                    true => "sqlite",
                    false => "postgres",
                },
                best[0],
                best[1]
            );
            assert!(
                best.iter().all(|t| *t < std::time::Duration::from_secs(1)),
                "{order:?}: {best:?}"
            );
            for keyset in [false, true] {
                let key = match (order.sort, keyset) {
                    (DmSort::Name, true) => ("'name 1000'", "'u0001'"),
                    (_, true) => ("150000", "1000"),
                    (_, false) => ("51", "0"),
                };
                let sql = dm_union(order, keyset, sqlite)
                    .replace("$5", "0")
                    .replace("$4", "51")
                    .replace("$3", key.1)
                    .replace("$2", key.0)
                    .replace("$1", "'alice'");
                let plan = plan(db, &sql).await;
                let lines: Vec<&str> = plan.lines().map(str::trim).collect();
                assert!(
                    !lines.iter().any(|l| l.ends_with("SCAN d")
                        || l.ends_with("SCAN u")
                        || l.contains("Seq Scan on dms")
                        || l.contains("Seq Scan on users")),
                    "{order:?} keyset {keyset}:\n{plan}"
                );
                if order.sort != DmSort::Name {
                    assert!(
                        plan.contains("idx_dms_a_latest") && plan.contains("idx_dms_b_latest"),
                        "{order:?} keyset {keyset}:\n{plan}"
                    );
                }
            }
        }
    }

    #[test]
    fn the_list_documents_its_order_and_filter() {
        use utoipa::OpenApi;
        let doc = serde_json::to_value(crate::api::openapi::ApiDoc::openapi()).expect("doc");
        let params = doc["paths"]["/api/v1/dms"]["get"]["parameters"]
            .as_array()
            .expect("params");
        let param = |name: &str| {
            params
                .iter()
                .find(|p| p["name"] == name)
                .unwrap_or_else(|| panic!("{name}"))
        };
        assert!(
            param("friends")["schema"]["type"]
                .to_string()
                .contains("boolean")
        );
        fn enums(v: &serde_json::Value, out: &mut Vec<String>) {
            match v {
                serde_json::Value::Object(map) => {
                    for (key, value) in map {
                        match (key.as_str(), value.as_array()) {
                            ("enum", Some(list)) => {
                                out.extend(list.iter().filter_map(|x| x.as_str().map(String::from)))
                            }
                            _ => enums(value, out),
                        }
                    }
                }
                serde_json::Value::Array(list) => list.iter().for_each(|x| enums(x, out)),
                _ => {}
            }
        }
        let schema = &param("sort")["schema"];
        assert!(!schema.to_string().contains("$ref"), "{schema}");
        let mut values = Vec::new();
        enums(schema, &mut values);
        assert_eq!(values, ["recent", "oldest", "name"], "{schema}");
        let schemas = &doc["components"]["schemas"];
        let summary = &schemas["DmSummary"]["properties"];
        for field in ["last_message_id", "last_message_at", "friend"] {
            assert!(summary[field]["description"].is_string(), "{field}");
        }
    }

    #[tokio::test]
    async fn a_big_dm_list_pages_in_a_few_ms() {
        let (state, path) = temp_state("dm_speed").await;
        big_account_lists_fast(&state.db).await;
        done(state, path).await;
        if let Some((state, pg)) = pg_state("dm_speed").await {
            big_account_lists_fast(&state.db).await;
            pg_done(state, pg).await;
        }
    }
}
