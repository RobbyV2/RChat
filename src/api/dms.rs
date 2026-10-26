use axum::Json;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use serde::Deserialize;
use sqlx::Row;
use sqlx::any::AnyRow;
use utoipa::{IntoParams, ToSchema};

use crate::api::{
    ApiError, Authed, DmSummary, page_bounds, placeholders, split_list, user_from, user_ref,
    user_refs,
};
use crate::db::{Db, get_user};
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
    ids: Option<String>,
}

fn dm_select(cond: &str) -> String {
    format!(
        "SELECT id, user_a, user_b FROM (SELECT d.id, d.user_a, d.user_b, (SELECT MAX(m.id) FROM messages m WHERE m.dm_id = d.id) AS latest FROM dms d WHERE (d.user_a = $1 OR d.user_b = $1){cond}) x ORDER BY CASE WHEN user_a = user_b THEN 0 ELSE 1 END, COALESCE(latest, 0) DESC, id DESC"
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
    limit: i64,
) -> Result<(Vec<DmSummary>, bool), ApiError> {
    let sql = format!("{} LIMIT $2 OFFSET $3", dm_select(""));
    let mut rows = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(viewer)
        .bind(limit + 1)
        .bind(offset)
        .fetch_all(db)
        .await?;
    let more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);
    Ok((summaries(db, viewer, &rows).await?, more))
}

pub(crate) async fn dms_by_ids(
    db: &Db,
    viewer: &str,
    ids: &[i64],
) -> Result<Vec<DmSummary>, ApiError> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let sql = dm_select(&format!(" AND d.id IN ({})", placeholders(2, ids.len())));
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(viewer);
    for id in ids {
        query = query.bind(*id);
    }
    let rows = query.fetch_all(db).await?;
    summaries(db, viewer, &rows).await
}

#[utoipa::path(get, path = "/api/dms", params(DmListQuery), responses((status = 200, description = "A page (`offset`, `limit` default 50, max 100) of the signed-in user's DM conversations: the self DM first, then by latest message (call logs included) newest first, DMs without messages last by id newest first. With `ids` (comma-separated, max 100) returns just those DMs, skipping ones the user is not part of", body = Vec<DmSummary>)), security(("bearer" = [])))]
pub(crate) async fn list_dms(
    State(state): State<AppState>,
    Authed(user): Authed,
    Query(q): Query<DmListQuery>,
) -> Result<Json<Vec<DmSummary>>, ApiError> {
    let DmListQuery { offset, limit, ids } = q;
    match ids {
        Some(raw) => {
            let ids: Vec<i64> = split_list(&raw)
                .iter()
                .filter_map(|s| s.parse().ok())
                .collect();
            Ok(Json(dms_by_ids(&state.db, &user.username, &ids).await?))
        }
        None => {
            let (offset, limit) = page_bounds(offset, limit);
            Ok(Json(
                dm_page(&state.db, &user.username, offset, limit).await?.0,
            ))
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
        let (first, more) = dm_page(db, "alice", 0, 5).await.expect("page");
        assert_eq!(first.len(), 5);
        assert!(more);
        let (rest, more) = dm_page(db, "alice", 5, 5).await.expect("page");
        assert_eq!(rest.len(), 1);
        assert!(!more);
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
        let (next, more) = dm_page(db, "alice", 50, 50).await.expect("next");
        assert_eq!(next.len(), 6);
        assert!(!more);
        assert!(next.iter().all(|d| !ids.contains(&d.id)));
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
