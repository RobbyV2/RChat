use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use serde::Deserialize;
use sqlx::Row;
use sqlx::any::AnyRow;
use utoipa::{IntoParams, ToSchema};

use crate::api::access::resolve_dm;
use crate::api::blocks::{check_dm, not_blocking};
use crate::api::messages::read_dm_latest;
use crate::api::servers::Page;
use crate::api::{
    ApiError, ApiErrorBody, Authed, DmSummary, OkResp, Paged, cursor_int, decode_cursor,
    encode_cursor, ok, page_bounds, placeholders, split_list, user_from, user_ref, user_refs,
};
use crate::db::{Db, LIVE_DM, User, get_user};
use crate::state::AppState;
use crate::ws::WsEvent;

/// The user to open a DM with.
#[derive(Deserialize, ToSchema)]
pub struct OpenDmReq {
    /// Username, case-insensitive. Your own username opens your self DM.
    #[schema(example = "bob")]
    username: String,
}

/// Paging or selection for the DM list.
#[derive(Deserialize, IntoParams)]
pub struct DmListQuery {
    /// Legacy offset into the list, 0 to 1000000 (clamped), default 0. Ignored when `cursor` is
    /// given.
    offset: Option<i64>,
    /// Page size, 1 to 100 (clamped), default 50.
    limit: Option<i64>,
    /// Opaque cursor from the `X-Next-Cursor` header of the previous page (or `dms_cursor` from
    /// `GET /api/v1/me`). Empty means the first page.
    cursor: Option<String>,
    /// Comma-separated DM ids to fetch instead of a page; up to 100 distinct ids, entries that
    /// are not integers or not your DMs are skipped. Paging parameters are then ignored.
    #[param(example = "12,40")]
    ids: Option<String>,
}

fn dm_half(col: &str, keyset: bool, limit: usize) -> String {
    let bound = match keyset {
        true => " AND (last_message_id, id) < ($2, $3)",
        false => "",
    };
    let (partner, closed) = match col {
        "user_a" => ("user_b", "closed_a"),
        _ => ("user_a", "closed_b"),
    };
    format!(
        "SELECT id, user_a, user_b, last_message_id FROM (SELECT id, user_a, user_b, last_message_id FROM dms WHERE {col} = $1 AND user_a <> user_b AND {closed} = 0{bound} AND NOT EXISTS(SELECT 1 FROM users pu WHERE pu.username = dms.{partner} AND pu.password_hash = '!purging') ORDER BY last_message_id DESC, id DESC LIMIT ${limit}) h_{col}"
    )
}

fn dm_union(keyset: bool) -> String {
    let (limit, offset) = match keyset {
        true => (4, 5),
        false => (2, 3),
    };
    format!(
        "SELECT id, user_a, user_b, last_message_id FROM ({} UNION ALL {}) x ORDER BY last_message_id DESC, id DESC LIMIT ${limit} OFFSET ${offset}",
        dm_half("user_a", keyset, limit),
        dm_half("user_b", keyset, limit),
    )
}

async fn summaries(
    db: &Db,
    viewer: &str,
    rows: &[AnyRow],
    closed_col: Option<usize>,
) -> Result<Vec<DmSummary>, ApiError> {
    let mut parsed = Vec::with_capacity(rows.len());
    for r in rows {
        let (id, a, b): (i64, String, String) = (r.try_get(0)?, r.try_get(1)?, r.try_get(2)?);
        let closed = match closed_col {
            Some(col) => r.try_get::<i64, _>(col)? != 0,
            None => false,
        };
        let is_self = a == b;
        let other = match a == viewer {
            true => b,
            false => a,
        };
        parsed.push((id, other, is_self, closed));
    }
    let names: Vec<String> = parsed
        .iter()
        .map(|(_, other, _, _)| other.clone())
        .collect();
    let refs = user_refs(db, &names).await;
    Ok(parsed
        .into_iter()
        .map(|(id, other, is_self, closed)| DmSummary {
            id,
            other: user_from(&refs, &other),
            is_self,
            closed,
        })
        .collect())
}

pub(crate) async fn dm_page(
    db: &Db,
    viewer: &str,
    offset: i64,
    cursor: Option<&str>,
    limit: i64,
) -> Result<Page<DmSummary>, ApiError> {
    let mut rows: Vec<AnyRow> = Vec::with_capacity(limit as usize + 1);
    match cursor {
        Some(raw) => {
            let parts = decode_cursor(raw, 2)?;
            let sql = dm_union(true);
            rows.extend(
                sqlx::query(sqlx::AssertSqlSafe(sql))
                    .bind(viewer)
                    .bind(cursor_int(&parts[0])?)
                    .bind(cursor_int(&parts[1])?)
                    .bind(limit + 1)
                    .bind(0i64)
                    .fetch_all(db)
                    .await?,
            );
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
            let sql = dm_union(false);
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
            Some(match a == b {
                true => encode_cursor(&[&i64::MAX.to_string(), &i64::MAX.to_string()]),
                false => encode_cursor(&[&latest.to_string(), &id.to_string()]),
            })
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
        "SELECT id, user_a, user_b, CASE WHEN user_a = $1 THEN closed_a ELSE closed_b END FROM dms WHERE (user_a = $1 OR user_b = $1) AND id IN ({}) AND {LIVE_DM} ORDER BY CASE WHEN user_a = user_b THEN 0 ELSE 1 END, last_message_id DESC, id DESC",
        placeholders(2, ids.len())
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(viewer);
    for id in ids {
        query = query.bind(*id);
    }
    let rows = query.fetch_all(db).await?;
    summaries(db, viewer, &rows, Some(3)).await
}

/// List your DMs
///
/// Returns the signed-in user's DM conversations, a page at a time or selected by id. Requires
/// a bearer token. General rate-limit bucket.
#[utoipa::path(get, path = "/api/v1/dms", tag = "Direct messages", params(DmListQuery), responses((status = 200, description = "A page (`cursor` or legacy `offset`, `limit` default 50, max 100) of the signed-in user's DM conversations: the self DM first, then by latest message (call logs included) newest first, DMs without messages last by id newest first. When more follow, the `X-Next-Cursor` response header holds the `cursor` for the next page (`dms_cursor` in `/api/v1/me` for the page after the first). DMs the user closed are left out of pages. With `ids` (comma-separated, max 100) returns just those DMs, self DM first, without `X-Next-Cursor`, skipping ones the user is not part of; closed ones are included with `closed: true`", body = Vec<DmSummary>, headers(("x-next-cursor" = String, description = "Cursor for the next page; absent on the last page"))), (status = 400, description = "Invalid cursor (JSON), or a non-integer `offset`/`limit` (plain-text framework error)", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(("bearer" = [])))]
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
    } = q;
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
            } = dm_page(db, &user.username, offset, cursor, limit).await?;
            Ok(Paged(items, next))
        }
    }
}

/// Open a DM
///
/// Returns the one-to-one conversation between the signed-in user and `username`, creating it
/// if it does not exist yet. Opening a DM with yourself returns your self DM. A newly created
/// DM emits `dm_created` to both users. If the signed-in user had closed it, it is reopened for
/// them and `dm_reopened` (`{username, dm_id}`) goes to their connections. Requires a bearer
/// token. General rate-limit bucket.
#[utoipa::path(post, path = "/api/v1/dms", tag = "Direct messages", request_body = OpenDmReq, responses((status = 200, description = "The DM with the given user, created if it did not exist yet", body = DmSummary), (status = 400, description = "Malformed JSON or a missing `Content-Type` (plain-text framework error; 415 for the latter)", content_type = "text/plain", body = String), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 404, description = "User not found", body = ApiErrorBody), (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn open_dm(
    State(state): State<AppState>,
    Authed(user): Authed,
    Json(req): Json<OpenDmReq>,
) -> Result<Json<DmSummary>, ApiError> {
    let OpenDmReq { username } = req;
    let target = username.to_lowercase();
    match get_user(&state.db, &target).await? {
        Some(_) => {}
        None => {
            return Err(ApiError(
                StatusCode::NOT_FOUND,
                "User not found".to_string(),
            ));
        }
    }
    let (a, b) = match user.username <= target {
        true => (user.username.clone(), target.clone()),
        false => (target.clone(), user.username.clone()),
    };
    let existing: Option<i64> =
        match sqlx::query("SELECT id FROM dms WHERE user_a = $1 AND user_b = $2")
            .bind(&a)
            .bind(&b)
            .fetch_optional(&state.db)
            .await?
        {
            Some(r) => Some(r.try_get(0)?),
            None => None,
        };
    let (id, created) = match existing {
        Some(id) => (id, false),
        None => {
            check_dm(&state.db, &user.username, &target).await?;
            let id: i64 =
                sqlx::query("INSERT INTO dms(user_a, user_b) VALUES($1, $2) RETURNING id")
                    .bind(&a)
                    .bind(&b)
                    .fetch_one(&state.db)
                    .await?
                    .try_get(0)?;
            (id, true)
        }
    };
    if !created && set_closed(&state.db, id, &user.username, false).await? {
        state.hub.broadcast(WsEvent::DmReopened {
            username: user.username.clone(),
            dm_id: id,
        });
    }
    let dm = DmSummary {
        id,
        other: user_ref(&state.db, &target).await,
        is_self: a == b,
        closed: false,
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
        Err(ApiError(_, e)) => {
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
            Err(ApiError(_, e)) => tracing::warn!("dm {id} not reopened: {e}"),
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
#[utoipa::path(post, path = "/api/v1/dms/{id}/close", tag = "Direct messages", params(("id" = i64, Path, description = "DM conversation id")), responses((status = 200, description = "Closed; body `{\"ok\": true}`", body = OkResp), (status = 400, description = "Non-numeric id (plain-text framework error)", content_type = "text/plain", body = String), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 404, description = "`Not found`: no such DM, you are not a participant, or a participant's account is being deleted; identical responses", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(("bearer" = [])))]
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
    use crate::api::test_util::{done, mem_user, temp_state};
    use crate::db::now;

    async fn add_user(db: &Db, name: &str, display: &str) {
        sqlx::query("INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, avatar_color, created_at) VALUES($1, $2, '', 'text', 'color', '#123456', $3)")
            .bind(name)
            .bind(display)
            .bind(now())
            .execute(db)
            .await
            .expect("insert user");
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
        sqlx::query("INSERT INTO messages(dm_id, author, content, kind, created_at) VALUES($1, 'alice', 'x', $2, $3)")
            .bind(dm)
            .bind(kind)
            .bind(now())
            .execute(db)
            .await
            .expect("insert message");
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
            }),
        )
        .await
        .expect("list dms")
        .0
        .iter()
        .map(|d| d.id)
        .collect()
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
        let first = dm_page(db, "alice", 0, None, 5).await.expect("page");
        assert_eq!(first.items.len(), 5);
        assert!(first.more);
        let rest = dm_page(db, "alice", 5, None, 5).await.expect("page");
        assert_eq!(rest.items.len(), 1);
        assert!(!rest.more);
        let mut walked = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let page = dm_page(db, "alice", 0, cursor.as_deref(), 2)
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
        let next = dm_page(db, "alice", 50, None, 50).await.expect("next");
        assert_eq!(next.items.len(), 6);
        assert!(!next.more);
        assert!(next.items.iter().all(|d| !ids.contains(&d.id)));
        let after = dm_page(db, "alice", 0, me.dms_cursor.as_deref(), 50)
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
                dm_page(&state.db, &who, 0, None, 50)
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
            Err(ApiError(StatusCode::NOT_FOUND, _))
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
}
