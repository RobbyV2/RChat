use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use utoipa::{IntoParams, ToSchema};

use crate::api::access::{Proof, resolve_channel, resolve_dm};
use crate::api::admin::like_pattern;
use crate::api::messages::{COLS, Quotes, attach_embeds, rows_messages};
use crate::api::reactions::attach_reactions;
use crate::api::{
    ApiError, ApiErrorBody, Authed, MaybeAuthed, Message, Paged, bad, check_len, cursor_int,
    decode_cursor, encode_cursor, require_guest_ok,
};
use crate::db::{Db, LIVE_AUTHOR, User};
use crate::state::AppState;

/// Threads in one page of a thread list.
pub const THREADS_PAGE: i64 = 50;

/// Longest `q` of a thread list, in characters.
pub const THREADS_QUERY_MAX: usize = 200;

/// Query of the thread lists of a channel and of a DM.
#[derive(Default, Deserialize, IntoParams)]
pub struct ThreadsQuery {
    /// Only threads whose root text, or the root author's username, display name or webhook
    /// name, contains this, ignoring case. Case folding depends on the database: Postgres folds
    /// every letter, SQLite only ASCII letters (other letters match in the same case). At most
    /// 200 characters, no NUL. Blank lists every thread.
    q: Option<String>,
    /// Opaque cursor from the `X-Next-Cursor` header of the previous page.
    cursor: Option<String>,
}

/// A thread: its root message and its newest reply.
#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct ThreadItem {
    /// The root message as message lists show it; `reply_count` counts its replies.
    pub root: Message,
    /// Id of the newest reply.
    pub last_reply_id: i64,
    /// When the newest reply was sent, Unix seconds.
    pub last_reply_at: i64,
}

/// Which conversation a thread list reads.
#[derive(Clone, Copy)]
enum Home {
    Channel(i64),
    Dm(i64),
}

/// The text a thread search looks for, trimmed; both sides are lowercased in SQL, as message
/// search does, so the two backends agree.
fn search_text(q: Option<String>) -> Result<Option<String>, ApiError> {
    let text = q.map(|q| q.trim().to_string()).filter(|q| !q.is_empty());
    match text {
        Some(q) if q.contains('\0') => Err(bad("Search text must not contain NUL")),
        Some(q) => {
            check_len(&q, THREADS_QUERY_MAX, "Search text")?;
            Ok(Some(q))
        }
        None => Ok(None),
    }
}

fn before_of(cursor: Option<String>) -> Result<i64, ApiError> {
    match cursor.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        Some(raw) => {
            let parts = decode_cursor(raw, 1)?;
            cursor_int(&parts[0])
        }
        None => Ok(i64::MAX),
    }
}

/// The page query of a thread list over `col` (`channel_id` or `dm_id`): `$1` the channel or DM,
/// `$2` the read-history floor, `$3` the cursor, `$4` the page size and, with `search`, `$5` the
/// `LIKE` pattern. The replies are grouped through `idx_messages_channel_threads` or
/// `idx_messages_dm_threads`.
pub(crate) fn list_sql(col: &str, search: bool) -> String {
    let matching = match search {
        true => {
            " AND (lower(m.content) LIKE lower($5) ESCAPE '\\' OR lower(COALESCE(m.webhook_name, '')) LIKE lower($5) ESCAPE '\\' OR EXISTS(SELECT 1 FROM users tu WHERE tu.username = m.author AND (lower(tu.username) LIKE lower($5) ESCAPE '\\' OR lower(tu.display_name) LIKE lower($5) ESCAPE '\\')))"
        }
        false => "",
    };
    format!(
        "SELECT {COLS}, t.last_id, (SELECT lr.created_at FROM messages lr WHERE lr.id = t.last_id) FROM (SELECT r.thread_root_id AS root_id, MAX(r.id) AS last_id FROM messages r WHERE r.{col} = $1 AND r.thread_root_id IS NOT NULL GROUP BY r.thread_root_id) t JOIN messages m ON m.id = t.root_id WHERE m.{col} = $1 AND m.thread_root_id IS NULL AND m.kind IN ('user', 'poll') AND m.created_at >= $2 AND t.last_id < $3 AND {LIVE_AUTHOR}{matching} ORDER BY t.last_id DESC LIMIT $4"
    )
}

/// Top-level `user` and `poll` messages of `home` with at least one reply, sent at or after
/// `floor`, newest reply first, one page before the cursor.
async fn list(
    db: &Db,
    home: Home,
    floor: Option<i64>,
    viewer: Option<&User>,
    q: ThreadsQuery,
) -> Result<Paged<ThreadItem>, ApiError> {
    let ThreadsQuery { q, cursor } = q;
    let text = search_text(q)?;
    let before = before_of(cursor)?;
    let (col, key) = match home {
        Home::Channel(id) => ("channel_id", id),
        Home::Dm(id) => ("dm_id", id),
    };
    let query = sqlx::query(sqlx::AssertSqlSafe(list_sql(col, text.is_some())))
        .bind(key)
        .bind(floor.unwrap_or(i64::MIN))
        .bind(before)
        .bind(THREADS_PAGE + 1);
    let rows = match &text {
        Some(text) => query.bind(like_pattern(text, false)),
        None => query,
    }
    .fetch_all(db)
    .await?;
    let more = rows.len() as i64 > THREADS_PAGE;
    let rows = &rows[..rows.len().min(THREADS_PAGE as usize)];
    let mut roots = rows_messages(db, rows, Quotes::Since(floor)).await?;
    attach_embeds(db, &mut roots).await?;
    attach_reactions(db, &mut roots, viewer).await?;
    crate::api::polls::personalize(db, &mut roots, viewer).await?;
    let mut items = Vec::with_capacity(rows.len());
    for (root, r) in roots.into_iter().zip(rows) {
        let at = r.len() - 2;
        items.push(ThreadItem {
            root,
            last_reply_id: r.try_get(at)?,
            last_reply_at: r.try_get(at + 1)?,
        });
    }
    let next = match (more, items.last()) {
        (true, Some(last)) => Some(encode_cursor(&[&last.last_reply_id.to_string()])),
        (_, _) => None,
    };
    Ok(Paged(items, next))
}

/// List channel threads
///
/// Lists the threads of a text channel: its top-level messages with at least one reply, the
/// thread with the newest reply first, 50 a page. Access is checked like reading the channel's
/// messages (guests allowed when guest access is on, password-protected servers, bans, the
/// channel view permission); without read-history access only threads whose root was sent since
/// you joined are listed. `q` keeps the threads whose root text or root author's name contains
/// it, ignoring case (on SQLite only for ASCII letters). General rate-limit bucket.
#[utoipa::path(get, path = "/api/v1/channels/{id}/threads", tag = "Threads", params(("id" = i64, Path, description = "Channel id"), ThreadsQuery), responses((status = 200, description = "Up to 50 threads, newest reply first. When more follow, the `X-Next-Cursor` response header holds the `cursor` of the next page", body = Vec<ThreadItem>, headers(("x-next-cursor" = String, description = "Cursor for the next page; absent on the last page"))), (status = 400, description = "Invalid cursor, `q` over 200 characters or containing NUL. A non-numeric id gives a plain-text 400", body = ApiErrorBody), (status = 401, description = "No valid token and guest access is disabled (`Guest access is disabled`)", body = ApiErrorBody), (status = 404, description = "`Not found`: no such channel, a channel you cannot see, or one in a server you have no access to (password-protected without access, or banned); identical responses", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)), security((), ("bearer" = [])))]
pub(crate) async fn channel_threads(
    State(state): State<AppState>,
    MaybeAuthed(user): MaybeAuthed,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<ThreadsQuery>,
) -> Result<Paged<ThreadItem>, ApiError> {
    let db = &state.read();
    require_guest_ok(db, user.as_ref()).await?;
    let channel = resolve_channel(
        db,
        id,
        user.as_ref(),
        &Proof::headers(&headers, &state.limits),
    )
    .await?;
    let floor = channel.read_since(db).await?;
    list(db, Home::Channel(id), floor, user.as_ref(), q).await
}

/// List DM threads
///
/// Lists the threads of a direct-message conversation (also the one with yourself): its
/// top-level messages with at least one reply, the thread with the newest reply first, 50 a
/// page. Requires a bearer token and being one of the two participants. `q` keeps the threads
/// whose root text or root author's name contains it, ignoring case (on SQLite only for ASCII
/// letters). General rate-limit bucket.
#[utoipa::path(get, path = "/api/v1/dms/{id}/threads", tag = "Threads", params(("id" = i64, Path, description = "DM conversation id"), ThreadsQuery), responses((status = 200, description = "Up to 50 threads, newest reply first. When more follow, the `X-Next-Cursor` response header holds the `cursor` of the next page", body = Vec<ThreadItem>, headers(("x-next-cursor" = String, description = "Cursor for the next page; absent on the last page"))), (status = 400, description = "Invalid cursor, `q` over 200 characters or containing NUL. A non-numeric id gives a plain-text 400", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 404, description = "`Not found`: no such DM, you are not a participant, or a participant's account is being deleted; identical responses", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn dm_threads(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Authed(user): Authed,
    Query(q): Query<ThreadsQuery>,
) -> Result<Paged<ThreadItem>, ApiError> {
    let db = &state.read();
    resolve_dm(db, id, &user).await?;
    list(db, Home::Dm(id), None, Some(&user), q).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::access::ws_typing_place;
    use crate::api::messages::{
        dm_messages, mark_read, send_thread_message, thread_messages, unreads,
    };
    use crate::api::test_util::{add_member, done, each_db, mem_user, temp_state};
    use axum::Json;
    use axum::http::StatusCode;

    async fn id_of(db: &Db, sql: &str) -> i64 {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .fetch_one(db)
            .await
            .expect(sql)
            .try_get(0)
            .expect("id")
    }

    async fn add_user(db: &Db, name: &str, shown: &str) {
        crate::db::NewUser::plain(name)
            .shown(shown)
            .at(1)
            .add(db)
            .await;
    }

    async fn dm_of(db: &Db, a: &str, b: &str) -> i64 {
        id_of(
            db,
            &format!("INSERT INTO dms(user_a, user_b) VALUES('{a}', '{b}') RETURNING id"),
        )
        .await
    }

    async fn post(db: &Db, place: (Option<i64>, Option<i64>), author: &str, text: &str) -> i64 {
        sqlx::query("INSERT INTO messages(channel_id, dm_id, author, content, created_at) VALUES($1, $2, $3, $4, 200) RETURNING id")
            .bind(place.0)
            .bind(place.1)
            .bind(author)
            .bind(text)
            .fetch_one(db)
            .await
            .expect("message")
            .try_get(0)
            .expect("id")
    }

    async fn reply(
        state: &AppState,
        who: &str,
        root: i64,
        text: &str,
    ) -> Result<Message, ApiError> {
        send_thread_message(
            State(state.clone()),
            Path(root),
            Authed(mem_user(who, false)),
            Json(serde_json::from_value(serde_json::json!({ "content": text })).expect("req")),
        )
        .await
        .map(|Json(m)| m)
    }

    fn query(q: &str) -> Query<ThreadsQuery> {
        Query::try_from_uri(&format!("/threads?{q}").parse().expect("uri")).expect("query")
    }

    type Listed = Result<(Vec<(i64, i64)>, Option<String>), StatusCode>;

    fn listed(res: Result<Paged<ThreadItem>, ApiError>) -> Listed {
        match res {
            Ok(Paged(items, next)) => Ok((
                items
                    .iter()
                    .map(|t| (t.root.id, t.root.reply_count))
                    .collect(),
                next,
            )),
            Err(ApiError(code, _, _)) => Err(code),
        }
    }

    async fn dm_list(state: &AppState, who: &str, dm: i64, q: &str) -> Listed {
        listed(
            dm_threads(
                State(state.clone()),
                Path(dm),
                Authed(mem_user(who, false)),
                query(q),
            )
            .await,
        )
    }

    async fn channel_list(state: &AppState, who: Option<&str>, cid: i64, q: &str) -> Listed {
        listed(
            channel_threads(
                State(state.clone()),
                MaybeAuthed(who.map(|w| mem_user(w, false))),
                HeaderMap::new(),
                Path(cid),
                query(q),
            )
            .await,
        )
    }

    async fn replies_of(state: &AppState, who: &str, root: i64) -> Result<Vec<i64>, StatusCode> {
        thread_messages(
            State(state.clone()),
            MaybeAuthed(Some(mem_user(who, false))),
            HeaderMap::new(),
            Path(root),
            Query::try_from_uri(&"/thread".parse().expect("uri")).expect("query"),
        )
        .await
        .map(|Json(list)| list.iter().map(|m| m.id).collect())
        .map_err(|ApiError(code, _, _)| code)
    }

    fn code<T>(res: Result<T, ApiError>) -> Option<(StatusCode, String)> {
        res.err().map(|ApiError(code, e, _)| (code, e))
    }

    fn enc(text: &str) -> String {
        text.bytes().map(|b| format!("%{b:02X}")).collect()
    }

    async fn general(db: &Db) -> i64 {
        id_of(db, "SELECT id FROM channels WHERE server = 'rchat'").await
    }

    #[tokio::test]
    async fn dm_threads_keep_replies_out_of_the_conversation_and_list_newest_reply_first() {
        for (state, temp) in each_db("threads_dm").await {
            let db = &state.db;
            let dm = dm_of(db, "alice", "bob").await;
            let first = post(db, (None, Some(dm)), "alice", "first").await;
            let second = post(db, (None, Some(dm)), "bob", "second").await;
            let quiet = post(db, (None, Some(dm)), "bob", "quiet").await;
            let a = reply(&state, "bob", first, "on first")
                .await
                .expect("reply");
            assert_eq!((a.dm_id, a.thread_root_id), (Some(dm), Some(first)));
            reply(&state, "alice", second, "on second")
                .await
                .expect("reply");
            let b = reply(&state, "alice", first, "again").await.expect("reply");
            assert_eq!(
                dm_list(&state, "bob", dm, "").await,
                Ok((vec![(first, 2), (second, 1)], None))
            );
            assert_eq!(replies_of(&state, "bob", first).await, Ok(vec![a.id, b.id]));
            let main = dm_messages(
                State(state.clone()),
                Path(dm),
                Authed(mem_user("alice", false)),
                Query::try_from_uri(&"/m".parse().expect("uri")).expect("query"),
            )
            .await
            .map(|Json(list)| {
                list.iter()
                    .map(|m| (m.id, m.reply_count))
                    .collect::<Vec<_>>()
            })
            .map_err(|ApiError(code, _, _)| code);
            assert_eq!(main, Ok(vec![(first, 2), (second, 1), (quiet, 0)]));
            temp.done(state).await;
        }
    }

    #[tokio::test]
    async fn the_dm_with_yourself_has_threads() {
        for (state, temp) in each_db("threads_self").await {
            let db = &state.db;
            let dm = dm_of(db, "alice", "alice").await;
            let root = post(db, (None, Some(dm)), "alice", "notes").await;
            let r = reply(&state, "alice", root, "more notes")
                .await
                .expect("reply");
            assert_eq!(
                dm_list(&state, "alice", dm, "").await,
                Ok((vec![(root, 1)], None))
            );
            assert_eq!(replies_of(&state, "alice", root).await, Ok(vec![r.id]));
            assert_eq!(
                dm_list(&state, "bob", dm, "").await,
                Err(StatusCode::NOT_FOUND)
            );
            temp.done(state).await;
        }
    }

    #[tokio::test]
    async fn thread_lists_load_fifty_at_a_time() {
        for (state, temp) in each_db("threads_pages").await {
            let db = &state.db;
            let cid = general(db).await;
            add_member(db, "rchat", "alice", 0, 0, 1).await;
            let mut roots = Vec::new();
            for i in 0..(THREADS_PAGE + 10) {
                let root = post(db, (Some(cid), None), "alice", &format!("topic {i}")).await;
                roots.push(root);
            }
            for root in &roots {
                sqlx::query("INSERT INTO messages(channel_id, thread_root_id, author, content, created_at) VALUES($1, $2, 'alice', 'r', 300)")
                    .bind(cid)
                    .bind(root)
                    .execute(db)
                    .await
                    .expect("reply");
            }
            let newest: Vec<(i64, i64)> = roots.iter().rev().map(|r| (*r, 1)).collect();
            let (page, next) = channel_list(&state, Some("alice"), cid, "")
                .await
                .expect("first page");
            assert_eq!(page, newest[..THREADS_PAGE as usize]);
            let next = next.expect("more");
            let (rest, end) = channel_list(&state, Some("alice"), cid, &format!("cursor={next}"))
                .await
                .expect("second page");
            assert_eq!(rest, newest[THREADS_PAGE as usize..]);
            assert_eq!(end, None);
            assert_eq!(
                channel_list(&state, Some("alice"), cid, "cursor=zz").await,
                Err(StatusCode::BAD_REQUEST)
            );
            temp.done(state).await;
        }
    }

    #[tokio::test]
    async fn thread_search_matches_root_text_and_author_names() {
        for (state, temp) in each_db("threads_search").await {
            let db = &state.db;
            add_user(db, "alice", "Alice Liddell").await;
            add_user(db, "bob", "Robert").await;
            let dm = dm_of(db, "alice", "bob").await;
            let plans = post(db, (None, Some(dm)), "alice", "Weekend plans").await;
            let photos = post(db, (None, Some(dm)), "bob", "50% off_sale").await;
            reply(&state, "bob", plans, "ok").await.expect("reply");
            reply(&state, "alice", photos, "ok").await.expect("reply");
            assert_eq!(
                dm_list(&state, "alice", dm, "q=PLANS").await,
                Ok((vec![(plans, 1)], None))
            );
            assert_eq!(
                dm_list(&state, "alice", dm, "q=robert").await,
                Ok((vec![(photos, 1)], None))
            );
            assert_eq!(
                dm_list(&state, "alice", dm, "q=liddell").await,
                Ok((vec![(plans, 1)], None))
            );
            assert_eq!(
                dm_list(&state, "alice", dm, "q=50%25").await,
                Ok((vec![(photos, 1)], None))
            );
            assert_eq!(
                dm_list(&state, "alice", dm, "q=f_s").await,
                Ok((vec![(photos, 1)], None))
            );
            assert_eq!(
                dm_list(&state, "alice", dm, "q=nothing").await,
                Ok((vec![], None))
            );
            assert_eq!(
                dm_list(&state, "alice", dm, "q=%20%20").await,
                Ok((vec![(photos, 1), (plans, 1)], None))
            );
            let long = "x".repeat(THREADS_QUERY_MAX + 1);
            assert_eq!(
                dm_list(&state, "alice", dm, &format!("q={long}")).await,
                Err(StatusCode::BAD_REQUEST)
            );
            let arger = post(db, (None, Some(dm)), "alice", "Ärger im Büro").await;
            let privet = post(db, (None, Some(dm)), "bob", "Привет из дома").await;
            reply(&state, "bob", arger, "ok").await.expect("reply");
            reply(&state, "alice", privet, "ok").await.expect("reply");
            for (q, want) in [("ÄRGER", arger), ("Büro", arger), ("Привет", privet)] {
                assert_eq!(
                    dm_list(&state, "alice", dm, &format!("q={}", enc(q))).await,
                    Ok((vec![(want, 1)], None)),
                    "{q}"
                );
            }
            // Other letters in another case: Postgres folds them, SQLite folds only ASCII.
            for (q, want) in [("ärger", arger), ("привет", privet), ("BÜRO", arger)] {
                let found = match crate::db::is_sqlite(db) {
                    true => vec![],
                    false => vec![(want, 1)],
                };
                assert_eq!(
                    dm_list(&state, "alice", dm, &format!("q={}", enc(q))).await,
                    Ok((found, None)),
                    "{q}"
                );
            }
            let dotted = "İ".repeat(THREADS_QUERY_MAX);
            assert_eq!(
                dm_list(&state, "alice", dm, &format!("q={}", enc(&dotted))).await,
                Ok((vec![], None))
            );
            temp.done(state).await;
        }
    }

    #[tokio::test]
    async fn outsiders_and_members_without_access_get_the_same_404() {
        for (state, temp) in each_db("threads_access").await {
            let db = &state.db;
            for name in ["alice", "bob", "carol"] {
                add_user(db, name, name).await;
            }
            let cid = general(db).await;
            add_member(db, "rchat", "alice", 0, 0, 1).await;
            add_member(db, "rchat", "bob", 0, 0, 1).await;
            let hidden = id_of(db, "INSERT INTO channels(server, name, kind, created_at) VALUES('rchat', 'hidden', 'text', 1) RETURNING id").await;
            sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'u:alice', 1, 1, 1)")
                .bind(hidden)
                .execute(db)
                .await
                .expect("restrict");
            crate::api::test_util::restrict_ruled(db).await;
            sqlx::query(
                "INSERT INTO server_bans(server, username, created_at) VALUES('rchat', 'eve', 1)",
            )
            .execute(db)
            .await
            .expect("ban");
            let secret = post(db, (Some(hidden), None), "alice", "secret").await;
            reply(&state, "alice", secret, "inside")
                .await
                .expect("reply");
            let open = post(db, (Some(cid), None), "alice", "open").await;
            reply(&state, "alice", open, "inside").await.expect("reply");
            assert_eq!(
                channel_list(&state, Some("alice"), hidden, "").await,
                Ok((vec![(secret, 1)], None))
            );
            assert_eq!(
                channel_list(&state, Some("bob"), cid, "").await,
                Ok((vec![(open, 1)], None))
            );
            let missing = Err(StatusCode::NOT_FOUND);
            assert_eq!(channel_list(&state, Some("bob"), hidden, "").await, missing);
            assert_eq!(channel_list(&state, Some("eve"), cid, "").await, missing);
            assert_eq!(
                channel_list(&state, Some("bob"), 999_999, "").await,
                missing
            );
            assert_eq!(
                channel_list(&state, None, hidden, "").await,
                channel_list(&state, None, 999_999, "").await
            );
            let dm = dm_of(db, "alice", "bob").await;
            let root = post(db, (None, Some(dm)), "alice", "private").await;
            reply(&state, "bob", root, "private reply")
                .await
                .expect("reply");
            assert_eq!(dm_list(&state, "carol", dm, "").await, missing);
            assert_eq!(dm_list(&state, "carol", 999_999, "").await, missing);
            assert_eq!(
                replies_of(&state, "carol", root).await,
                Err(StatusCode::NOT_FOUND)
            );
            assert_eq!(
                code(reply(&state, "carol", root, "hi").await),
                Some((StatusCode::NOT_FOUND, "Not found".to_string()))
            );
            assert_eq!(
                ws_typing_place(db, "carol", &format!("t{root}")).await,
                None
            );
            let typing = ws_typing_place(db, "bob", &format!("t{root}"))
                .await
                .expect("typing place");
            assert_eq!(
                (
                    typing.dm_id,
                    typing.dm_users.map(|mut u| {
                        u.sort();
                        u
                    })
                ),
                (Some(dm), Some(vec!["alice".to_string(), "bob".to_string()]))
            );
            temp.done(state).await;
        }
    }

    #[tokio::test]
    async fn read_history_limits_the_channel_thread_list() {
        let (state, path) = temp_state("threads_history").await;
        let db = &state.db;
        add_member(db, "rchat", "alice", 0, 0, 1).await;
        add_member(db, "rchat", "bob", 0, 0, 250).await;
        let cid = general(db).await;
        sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'u:bob', 1, 1, 0)")
            .bind(cid)
            .execute(db)
            .await
            .expect("perms");
        let old = post(db, (Some(cid), None), "alice", "before bob").await;
        let new = id_of(db, &format!("INSERT INTO messages(channel_id, author, content, created_at) VALUES({cid}, 'alice', 'after bob', 300) RETURNING id")).await;
        for root in [old, new] {
            sqlx::query("INSERT INTO messages(channel_id, thread_root_id, author, content, created_at) VALUES($1, $2, 'alice', 'r', 400)")
                .bind(cid)
                .bind(root)
                .execute(db)
                .await
                .expect("reply");
        }
        assert_eq!(
            channel_list(&state, Some("alice"), cid, "").await,
            Ok((vec![(new, 1), (old, 1)], None))
        );
        assert_eq!(
            channel_list(&state, Some("bob"), cid, "").await,
            Ok((vec![(new, 1)], None))
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn dm_threads_need_a_live_unblocked_conversation_and_a_top_level_root() {
        let (state, path) = temp_state("threads_dm_write").await;
        let db = &state.db;
        add_user(db, "alice", "Alice").await;
        add_user(db, "bob", "Bob").await;
        let dm = dm_of(db, "alice", "bob").await;
        let root = post(db, (None, Some(dm)), "alice", "root").await;
        let first = reply(&state, "bob", root, "first").await.expect("reply");
        assert!(
            ws_typing_place(db, "bob", &format!("t{root}"))
                .await
                .is_some()
        );
        assert_eq!(
            code(reply(&state, "alice", first.id, "nested").await),
            Some((
                StatusCode::BAD_REQUEST,
                "Threads only start on top-level messages".to_string()
            ))
        );
        assert_eq!(
            replies_of(&state, "alice", first.id).await,
            Err(StatusCode::BAD_REQUEST)
        );
        sqlx::query("INSERT INTO blocks(blocker, blocked, created_at) VALUES('alice', 'bob', 1)")
            .execute(db)
            .await
            .expect("block");
        assert_eq!(
            code(reply(&state, "bob", root, "hi").await).map(|(c, _)| c),
            Some(StatusCode::FORBIDDEN)
        );
        assert_eq!(
            code(reply(&state, "alice", root, "hi").await).map(|(c, _)| c),
            Some(StatusCode::FORBIDDEN)
        );
        assert_eq!(ws_typing_place(db, "bob", &format!("t{root}")).await, None);
        assert_eq!(replies_of(&state, "bob", root).await, Ok(vec![first.id]));
        done(state, path).await;
    }

    #[tokio::test]
    async fn dm_thread_replies_ping_into_the_thread_and_leave_the_dm_read() {
        let (state, path) = temp_state("threads_dm_reads").await;
        let db = &state.db;
        add_user(db, "alice", "Alice").await;
        add_user(db, "bob", "Bob").await;
        let dm = dm_of(db, "alice", "bob").await;
        let root = post(db, (None, Some(dm)), "alice", "root").await;
        reply(&state, "bob", root, "@alice look")
            .await
            .expect("reply");
        let unread = |who: &'static str| {
            let state = state.clone();
            async move {
                let Json(list) = unreads(
                    State(state),
                    Authed(mem_user(who, false)),
                    Query::try_from_uri(&"/unreads".parse().expect("uri")).expect("query"),
                )
                .await
                .expect("unreads");
                list.items
                    .iter()
                    .filter(|u| u.scope == format!("d{dm}"))
                    .map(|u| {
                        (
                            u.latest,
                            u.last_read,
                            u.pings,
                            u.thread_pings
                                .iter()
                                .map(|t| (t.root_id, t.pings))
                                .collect(),
                        )
                    })
                    .collect::<Vec<(i64, i64, i64, Vec<(i64, i64)>)>>()
            }
        };
        assert_eq!(unread("alice").await, vec![(0, 0, 1, vec![(root, 1)])]);
        let read = mark_read(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            Json(
                serde_json::from_value(
                    serde_json::json!({ "scope": format!("t{root}"), "last_read": 0 }),
                )
                .expect("req"),
            ),
        )
        .await;
        assert!(read.is_ok());
        assert_eq!(unread("alice").await, vec![]);
        let res = mark_read(
            State(state.clone()),
            Authed(mem_user("carol", false)),
            Json(
                serde_json::from_value(
                    serde_json::json!({ "scope": format!("t{root}"), "last_read": 0 }),
                )
                .expect("req"),
            ),
        )
        .await;
        assert_eq!(code(res).map(|(c, _)| c), Some(StatusCode::NOT_FOUND));
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_search_pages_with_its_cursor() {
        for (state, temp) in each_db("threads_search_pages").await {
            let db = &state.db;
            let dm = dm_of(db, "alice", "bob").await;
            let mut matching = Vec::new();
            for i in 0..(THREADS_PAGE + 5) {
                let text = match i % 2 {
                    0 => format!("match {i}"),
                    _ => format!("other {i}"),
                };
                let root = post(db, (None, Some(dm)), "alice", &text).await;
                if i % 2 == 0 {
                    matching.push(root);
                }
            }
            for i in 0..(THREADS_PAGE + 5) {
                let text = format!("match {}", THREADS_PAGE + 5 + i);
                matching.push(post(db, (None, Some(dm)), "alice", &text).await);
            }
            let roots: Vec<i64> =
                sqlx::query("SELECT id FROM messages WHERE dm_id = $1 ORDER BY id")
                    .bind(dm)
                    .fetch_all(db)
                    .await
                    .expect("roots")
                    .iter()
                    .map(|r| r.get(0))
                    .collect();
            for root in &roots {
                sqlx::query("INSERT INTO messages(dm_id, thread_root_id, author, content, created_at) VALUES($1, $2, 'bob', 'r', 300)")
                    .bind(dm)
                    .bind(root)
                    .execute(db)
                    .await
                    .expect("reply");
            }
            let newest: Vec<(i64, i64)> = matching.iter().rev().map(|r| (*r, 1)).collect();
            let (page, next) = dm_list(&state, "alice", dm, "q=match")
                .await
                .expect("first");
            assert_eq!(page, newest[..THREADS_PAGE as usize]);
            let next = next.expect("more");
            let (rest, end) = dm_list(&state, "alice", dm, &format!("q=match&cursor={next}"))
                .await
                .expect("second");
            assert_eq!(rest, newest[THREADS_PAGE as usize..]);
            assert_eq!(end, None);
            temp.done(state).await;
        }
    }

    #[tokio::test]
    async fn a_dm_with_an_account_being_deleted_has_no_threads() {
        let (state, path) = temp_state("threads_purging").await;
        let db = &state.db;
        add_user(db, "alice", "Alice").await;
        add_user(db, "gone", "Gone").await;
        let dm = dm_of(db, "alice", "gone").await;
        let root = post(db, (None, Some(dm)), "alice", "root").await;
        reply(&state, "gone", root, "reply").await.expect("reply");
        assert_eq!(
            dm_list(&state, "alice", dm, "").await,
            Ok((vec![(root, 1)], None))
        );
        sqlx::query("UPDATE users SET password_hash = '!purging' WHERE username = 'gone'")
            .execute(db)
            .await
            .expect("purging");
        let missing = Err(StatusCode::NOT_FOUND);
        assert_eq!(dm_list(&state, "alice", dm, "").await, missing);
        assert_eq!(
            replies_of(&state, "alice", root).await,
            Err(StatusCode::NOT_FOUND)
        );
        assert_eq!(
            code(reply(&state, "alice", root, "hi").await).map(|(c, _)| c),
            Some(StatusCode::NOT_FOUND)
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn bulk_delete_of_a_dm_keeps_to_its_top_level_and_a_thread_to_its_replies() {
        for (state, temp) in each_db("threads_bulk").await {
            let db = &state.db;
            let dm = dm_of(db, "alice", "bob").await;
            let root = post(db, (None, Some(dm)), "alice", "root").await;
            let top = post(db, (None, Some(dm)), "alice", "top").await;
            let mine = reply(&state, "alice", root, "mine")
                .await
                .expect("reply")
                .id;
            let theirs = reply(&state, "bob", root, "theirs")
                .await
                .expect("reply")
                .id;
            let bulk = |body: serde_json::Value| {
                let state = state.clone();
                async move {
                    crate::api::bulk_delete::bulk_delete(
                        State(state),
                        Authed(mem_user("alice", false)),
                        Json(serde_json::from_value(body).expect("req")),
                    )
                    .await
                    .map(|Json(r)| (r.total, r.deletable, r.others, r.missing, r.deleted))
                    .map_err(|ApiError(code, _, _)| code)
                }
            };
            assert_eq!(
                bulk(
                    serde_json::json!({ "scope": format!("d{dm}"), "all": true, "dry_run": true })
                )
                .await
                .map(|(total, deletable, ..)| (total, deletable)),
                Ok((2, 2))
            );
            assert_eq!(
                bulk(serde_json::json!({ "scope": format!("d{dm}"), "ids": [mine, top], "dry_run": true }))
                    .await,
                Ok((2, 1, 0, 1, 0))
            );
            let mut rx = state.hub.subscribe();
            assert_eq!(
                bulk(serde_json::json!({ "scope": format!("t{root}"), "ids": [mine, theirs] }))
                    .await,
                Ok((2, 1, 1, 0, 1))
            );
            let gone = std::iter::from_fn(|| rx.try_recv().ok()).find_map(|ev| match ev {
                crate::ws::WsEvent::MessagesDeleted {
                    server,
                    dm_id,
                    dm_users,
                    thread_root_id,
                    ids,
                    ..
                } => Some((
                    server,
                    dm_id,
                    dm_users.map(|mut u| {
                        u.sort();
                        u
                    }),
                    thread_root_id,
                    ids,
                )),
                _ => None,
            });
            assert_eq!(
                gone,
                Some((
                    None,
                    Some(dm),
                    Some(vec!["alice".to_string(), "bob".to_string()]),
                    Some(root),
                    vec![mine]
                ))
            );
            assert_eq!(replies_of(&state, "bob", root).await, Ok(vec![theirs]));
            temp.done(state).await;
        }
    }

    #[tokio::test]
    async fn dm_quotes_stay_on_their_level() {
        let (state, path) = temp_state("threads_dm_quotes").await;
        let db = &state.db;
        let dm = dm_of(db, "alice", "bob").await;
        let root = post(db, (None, Some(dm)), "alice", "root").await;
        let inner = reply(&state, "bob", root, "inner").await.expect("reply").id;
        let send = |body: serde_json::Value| {
            let state = state.clone();
            async move {
                crate::api::messages::send_dm_message(
                    State(state),
                    Path(dm),
                    Authed(mem_user("alice", false)),
                    Json(serde_json::from_value(body).expect("req")),
                )
                .await
                .map(|Json(m)| m.id)
                .map_err(|ApiError(code, e, _)| (code, e))
            }
        };
        assert_eq!(
            send(serde_json::json!({ "content": "quoting", "reply_to": inner })).await,
            Err((
                StatusCode::BAD_REQUEST,
                "Cannot reply to that message".to_string()
            ))
        );
        assert!(
            send(serde_json::json!({ "content": "quoting", "reply_to": root }))
                .await
                .is_ok()
        );
        let in_thread = send_thread_message(
            State(state.clone()),
            Path(root),
            Authed(mem_user("alice", false)),
            Json(
                serde_json::from_value(serde_json::json!({ "content": "x", "reply_to": inner }))
                    .expect("req"),
            ),
        )
        .await;
        assert!(in_thread.is_ok());
        done(state, path).await;
    }

    #[tokio::test]
    async fn report_context_of_a_dm_reply_is_its_thread() {
        use crate::api::reports::snapshot::{Place, context};
        let (state, path) = temp_state("threads_report_context").await;
        let db = &state.db;
        let dm = dm_of(db, "alice", "bob").await;
        let root = post(db, (None, Some(dm)), "alice", "root").await;
        let first = reply(&state, "bob", root, "first").await.expect("reply").id;
        let top = post(db, (None, Some(dm)), "alice", "top").await;
        let last = reply(&state, "bob", root, "last").await.expect("reply").id;
        let ids = |list: Vec<crate::api::reports::snapshot::SnapMessage>| {
            list.iter().map(|m| m.id).collect::<Vec<_>>()
        };
        assert_eq!(
            ids(context(db, last, Place::Thread(root), None, 10)
                .await
                .expect("thread")),
            vec![root, first]
        );
        assert_eq!(
            ids(context(db, last + 1, Place::Dm(dm), None, 10)
                .await
                .expect("dm")),
            vec![root, top]
        );
        done(state, path).await;
    }
}
