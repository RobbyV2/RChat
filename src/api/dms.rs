use axum::Json;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use serde::Deserialize;
use sqlx::Row;
use sqlx::any::AnyRow;
use utoipa::{IntoParams, ToSchema};

use crate::api::servers::Page;
use crate::api::{
    ApiError, Authed, DmSummary, Paged, cursor_int, decode_cursor, encode_cursor, page_bounds,
    placeholders, split_list, user_from, user_ref, user_refs,
};
use crate::db::{Db, LIVE_DM, get_user};
use crate::state::AppState;
use crate::ws::WsEvent;

#[derive(Deserialize, ToSchema)]
pub struct OpenDmReq {
    username: String,
}

#[derive(Deserialize, IntoParams)]
pub struct DmListQuery {
    offset: Option<i64>,
    limit: Option<i64>,
    cursor: Option<String>,
    ids: Option<String>,
}

fn dm_half(col: &str, keyset: bool, limit: usize) -> String {
    let bound = match keyset {
        true => " AND (last_message_id, id) < ($2, $3)",
        false => "",
    };
    let partner = match col {
        "user_a" => "user_b",
        _ => "user_a",
    };
    format!(
        "SELECT id, user_a, user_b, last_message_id FROM (SELECT id, user_a, user_b, last_message_id FROM dms WHERE {col} = $1 AND user_a <> user_b{bound} AND NOT EXISTS(SELECT 1 FROM users pu WHERE pu.username = dms.{partner} AND pu.password_hash = '!purging') ORDER BY last_message_id DESC, id DESC LIMIT ${limit}) h_{col}"
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

async fn summaries(db: &Db, viewer: &str, rows: &[AnyRow]) -> Result<Vec<DmSummary>, ApiError> {
    let mut parsed = Vec::with_capacity(rows.len());
    for r in rows {
        let (id, a, b): (i64, String, String) = (r.try_get(0)?, r.try_get(1)?, r.try_get(2)?);
        let is_self = a == b;
        let other = match a == viewer {
            true => b,
            false => a,
        };
        parsed.push((id, other, is_self));
    }
    let names: Vec<String> = parsed.iter().map(|(_, other, _)| other.clone()).collect();
    let refs = user_refs(db, &names).await;
    Ok(parsed
        .into_iter()
        .map(|(id, other, is_self)| DmSummary {
            id,
            other: user_from(&refs, &other),
            is_self,
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
                    sqlx::query("SELECT id, user_a, user_b, last_message_id FROM dms WHERE user_a = $1 AND user_b = $1")
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
        items: summaries(db, viewer, &rows).await?,
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
        "SELECT id, user_a, user_b FROM dms WHERE (user_a = $1 OR user_b = $1) AND id IN ({}) AND {LIVE_DM} ORDER BY CASE WHEN user_a = user_b THEN 0 ELSE 1 END, last_message_id DESC, id DESC",
        placeholders(2, ids.len())
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(viewer);
    for id in ids {
        query = query.bind(*id);
    }
    let rows = query.fetch_all(db).await?;
    summaries(db, viewer, &rows).await
}

#[utoipa::path(get, path = "/api/dms", params(DmListQuery), responses((status = 200, description = "A page (`cursor` or legacy `offset`, `limit` default 50, max 100) of the signed-in user's DM conversations: the self DM first, then by latest message (call logs included) newest first, DMs without messages last by id newest first. When more follow, the `X-Next-Cursor` response header holds the `cursor` for the next page (`dms_cursor` in `/api/me` for the page after the first). With `ids` (comma-separated, max 100) returns just those DMs, skipping ones the user is not part of", body = Vec<DmSummary>, headers(("x-next-cursor" = String, description = "Cursor for the next page; absent on the last page")))), security(("bearer" = [])))]
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

#[utoipa::path(post, path = "/api/dms", request_body = OpenDmReq, responses((status = 200, description = "The DM with the given user, created if it did not exist yet", body = DmSummary)), security(("bearer" = [])))]
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
    let dm = DmSummary {
        id,
        other: user_ref(&state.db, &target).await,
        is_self: a == b,
    };
    if created {
        state.hub.broadcast(WsEvent::DmCreated {
            dm_id: id,
            dm_users: vec![a, b],
        });
    }
    Ok(Json(dm))
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
