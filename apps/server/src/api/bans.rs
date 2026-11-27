use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::Row;
use utoipa::ToSchema;

use crate::api::access::may_delete_in;
use crate::api::bulk_delete::{JOB_LEASE, run_job};
use crate::api::timeouts::clean_reason;
use crate::api::{ApiError, bad, placeholders};
use crate::db::{Db, User, now};
use crate::state::AppState;

/// Shortest timed ban: one minute.
pub const BAN_MIN: i64 = 60;
/// Longest timed ban: two years.
pub const BAN_MAX: i64 = 63_072_000;
/// Furthest back a ban deletes the member's messages: seven days.
pub const PURGE_HOURS_MAX: i64 = 168;
/// Most places (channels and threads) one ban deletes messages in.
pub const PURGE_PLACES_MAX: usize = 200;
/// Expired bans the sweep lifts per pass.
const SWEEP_BATCH: i64 = 500;

/// A ban that still holds at `$3`.
pub(crate) const LIVE_BAN_SQL: &str = "SELECT 1 FROM server_bans WHERE server = $1 AND username = $2 AND (expires_at IS NULL OR expires_at > $3)";

/// Whether `username` is banned from `server` now. A ban past its end no longer holds, whether
/// or not the sweep has deleted it.
pub(crate) async fn banned<'e, E>(ex: E, server: &str, username: &str) -> sqlx::Result<bool>
where
    E: sqlx::Executor<'e, Database = sqlx::Any>,
{
    Ok(sqlx::query(LIVE_BAN_SQL)
        .bind(server)
        .bind(username)
        .bind(now())
        .fetch_optional(ex)
        .await?
        .is_some())
}

/// Request body for banning a user.
#[derive(Deserialize, ToSchema)]
pub struct BanReq {
    /// Target username, case-insensitive.
    #[schema(example = "alice")]
    pub username: String,
    /// How long the ban lasts from now, 60 seconds to two years (63072000). Omitted or `null`:
    /// until someone lifts it.
    #[serde(default)]
    #[schema(example = 86400)]
    pub duration_secs: Option<i64>,
    /// Why, at most 300 characters. Shown in the ban list and the audit log.
    #[serde(default)]
    pub reason: Option<String>,
    /// Also delete the messages the user sent in the last this many hours, 0 to 168. Omitted or
    /// 0: none.
    #[serde(default)]
    #[schema(example = 24)]
    pub purge_hours: Option<i64>,
}

impl BanReq {
    #[cfg(test)]
    pub(crate) fn forever(username: &str) -> BanReq {
        BanReq {
            username: username.to_string(),
            duration_secs: None,
            reason: None,
            purge_hours: None,
        }
    }
}

/// The outcome of a ban.
#[derive(Serialize, Deserialize, ToSchema)]
pub struct BanResp {
    /// Always `true`.
    #[schema(example = true)]
    pub ok: bool,
    /// When the ban ends, Unix seconds; `null` for a ban without an end.
    pub expires_at: Option<i64>,
    /// Channels and threads whose messages of the user are being deleted in the background, by
    /// bulk delete jobs of yours. While they run, your own bulk deletes may answer 429.
    pub purge_places: i64,
    /// Channels and threads with messages of the user in the range that you may not delete in,
    /// or that were over the limit of 200 places. They are left as they are.
    pub purge_skipped: i64,
    /// Channels and threads with messages of the user in the range where a bulk delete of yours
    /// is already running. They are left as they are.
    pub purge_busy: i64,
}

/// The checked options of a ban.
pub(crate) struct BanOptions {
    pub expires_at: Option<i64>,
    pub reason: Option<String>,
    pub purge_hours: i64,
}

pub(crate) fn options(
    duration_secs: Option<i64>,
    reason: Option<String>,
    purge_hours: Option<i64>,
    t: i64,
) -> Result<BanOptions, ApiError> {
    let expires_at = match duration_secs {
        None => None,
        Some(d) if (BAN_MIN..=BAN_MAX).contains(&d) => Some(t + d),
        Some(_) => return Err(bad("Ban length must be 60 to 63072000 seconds")),
    };
    let purge_hours = match purge_hours {
        None => 0,
        Some(h) if (0..=PURGE_HOURS_MAX).contains(&h) => h,
        Some(_) => return Err(bad("Messages can be deleted from the last 0 to 168 hours")),
    };
    Ok(BanOptions {
        expires_at,
        reason: clean_reason(reason)?,
        purge_hours,
    })
}

/// How a purge was started: jobs to run, places left alone because `actor` may not delete there
/// (or over the limit), and places where a job of `actor` already runs.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Purge {
    pub jobs: Vec<i64>,
    pub skipped: i64,
    pub busy: i64,
}

/// Starts one bulk delete job of `actor` per text channel and thread of `server` that holds
/// messages `author` sent at or after `since` and where `actor` may delete them. Each job only
/// takes that author's messages from the first one in range to the newest one there now.
/// Channels `actor` can't see are left out without a count.
pub(crate) async fn enqueue_purge(
    db: &Db,
    actor: &User,
    server: &str,
    author: &str,
    since: i64,
) -> Result<Purge, ApiError> {
    let channels: Vec<i64> =
        sqlx::query("SELECT id FROM channels WHERE server = $1 AND kind = 'text' ORDER BY id")
            .bind(server)
            .fetch_all(db)
            .await?
            .iter()
            .map(|r| r.try_get(0))
            .collect::<sqlx::Result<_>>()?;
    let mut purge = Purge::default();
    let t = now();
    for channel_id in channels {
        let places = sqlx::query("SELECT thread_root_id, MIN(id), MAX(id), COUNT(*) FROM messages WHERE channel_id = $1 AND author = $2 AND created_at >= $3 GROUP BY thread_root_id ORDER BY thread_root_id")
            .bind(channel_id)
            .bind(author)
            .bind(since)
            .fetch_all(db)
            .await?;
        if places.is_empty() {
            continue;
        }
        match may_delete_in(db, actor, channel_id, author).await? {
            Some(true) => {}
            Some(false) => {
                purge.skipped += places.len() as i64;
                continue;
            }
            None => continue,
        }
        for r in &places {
            let root: Option<i64> = r.try_get(0)?;
            let (first, last, estimate): (i64, i64, i64) =
                (r.try_get(1)?, r.try_get(2)?, r.try_get(3)?);
            if purge.jobs.len() >= PURGE_PLACES_MAX {
                purge.skipped += 1;
                continue;
            }
            let scope = match root {
                Some(root) => format!("t{root}"),
                None => format!("c{channel_id}"),
            };
            let inserted = sqlx::query("INSERT INTO bulk_delete_jobs(username, scope, channel_id, except_ids, after_id, upto_id, cursor_id, estimate, claimed_at, created_at, author_filter) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10) ON CONFLICT DO NOTHING RETURNING id")
                .bind(&actor.username)
                .bind(&scope)
                .bind(channel_id)
                .bind(json!([]).to_string())
                .bind(first - 1)
                .bind(last)
                .bind(last + 1)
                .bind(estimate)
                .bind(t)
                .bind(author)
                .fetch_optional(db)
                .await?;
            match inserted {
                Some(r) => purge.jobs.push(r.try_get(0)?),
                None => purge.busy += 1,
            }
        }
    }
    Ok(purge)
}

/// Runs the purge jobs one after another in the background, holding the lease of the ones that
/// wait so the jobs sweep leaves them to this runner.
pub(crate) fn spawn_purge(state: &AppState, jobs: Vec<i64>) {
    if jobs.is_empty() {
        return;
    }
    let state = state.clone();
    tokio::spawn(async move {
        for (i, id) in jobs.iter().enumerate() {
            let waiting = &jobs[i + 1..];
            let run = run_job(&state, *id);
            tokio::pin!(run);
            loop {
                tokio::select! {
                    () = &mut run => break,
                    () = tokio::time::sleep(LEASE_HOLD) => {
                        if let Err(e) = hold_lease(&state.db, waiting, now()).await {
                            tracing::warn!("holding the lease of purge jobs did not work: {e}");
                        }
                    }
                }
            }
        }
    });
}

/// How often a purge renews the lease of its waiting jobs.
const LEASE_HOLD: std::time::Duration = std::time::Duration::from_secs(JOB_LEASE as u64 / 3);

/// Renews the lease of the running jobs among `jobs` to `t`.
pub(crate) async fn hold_lease(db: &Db, jobs: &[i64], t: i64) -> sqlx::Result<u64> {
    if jobs.is_empty() {
        return Ok(0);
    }
    let sql = format!(
        "UPDATE bulk_delete_jobs SET claimed_at = $1 WHERE status = 'running' AND id IN ({})",
        placeholders(2, jobs.len())
    );
    let mut q = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(t);
    for id in jobs {
        q = q.bind(id);
    }
    Ok(q.execute(db).await?.rows_affected())
}

/// Deletes bans that ended at or before `t`, each with a `member.unban` audit entry marked
/// `expired`. Returns how many it lifted.
pub(crate) async fn sweep_expired(db: &Db, t: i64) -> sqlx::Result<u64> {
    let rows = sqlx::query("SELECT server, username FROM server_bans WHERE expires_at IS NOT NULL AND expires_at <= $1 ORDER BY expires_at LIMIT $2")
        .bind(t)
        .bind(SWEEP_BATCH)
        .fetch_all(db)
        .await?;
    let mut lifted = 0;
    for r in &rows {
        let (server, username): (String, String) = (r.try_get(0)?, r.try_get(1)?);
        let mut tx = db.begin().await?;
        let gone = sqlx::query("DELETE FROM server_bans WHERE server = $1 AND username = $2 AND expires_at IS NOT NULL AND expires_at <= $3")
            .bind(&server)
            .bind(&username)
            .bind(t)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        if gone > 0 {
            sqlx::query("INSERT INTO audit_log(server, actor, staff, action, target_kind, target_id, target_name, target_staff, details, created_at) VALUES($1, NULL, 0, 'member.unban', 'user', NULL, $2, 0, $3, $4)")
                .bind(&server)
                .bind(&username)
                .bind(json!({"expired": true}).to_string())
                .bind(t)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        lifted += gone;
    }
    Ok(lifted)
}

#[cfg(test)]
mod tests {
    use axum::Json;
    use axum::extract::{Path, Query, State};
    use axum::http::StatusCode;

    use super::*;
    use crate::api::servers::{MembersQuery, ban_member, join_server, list_bans};
    use crate::api::test_util::{add_member, each_db, mem_user};
    use crate::api::{Authed, Paged};

    const KICK: i64 = 4;
    const DELETE: i64 = 2;

    async fn exec(db: &Db, sql: &str) {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .execute(db)
            .await
            .expect(sql);
    }

    async fn count(db: &Db, sql: &str) -> i64 {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .fetch_one(db)
            .await
            .expect(sql)
            .try_get(0)
            .expect("count")
    }

    /// Server `club` with channels `general` and `side`, the manager `alice` (Kick and Delete
    /// messages), the moderator `mo` (Kick only) and the member `bob`.
    async fn club(db: &Db) -> (i64, i64) {
        for name in ["alice", "mo", "bob"] {
            crate::db::NewUser::plain(name).add(db).await;
        }
        exec(
            db,
            "INSERT INTO servers(name, display_name, created_at) VALUES('club', 'Club', 1)",
        )
        .await;
        let mut ids = Vec::new();
        for name in ["general", "side"] {
            let id: i64 = sqlx::query("INSERT INTO channels(server, name, kind, created_at) VALUES('club', $1, 'text', 1) RETURNING id")
                .bind(name)
                .fetch_one(db)
                .await
                .expect("channel")
                .try_get(0)
                .expect("id");
            ids.push(id);
        }
        add_member(db, "club", "alice", 1, KICK | DELETE, 1).await;
        add_member(db, "club", "mo", 1, KICK, 1).await;
        add_member(db, "club", "bob", 0, 0, 1).await;
        (ids[0], ids[1])
    }

    async fn post(db: &Db, channel: i64, root: Option<i64>, author: &str, at: i64) -> i64 {
        sqlx::query("INSERT INTO messages(channel_id, thread_root_id, author, content, created_at) VALUES($1, $2, $3, 'hi', $4) RETURNING id")
            .bind(channel)
            .bind(root)
            .bind(author)
            .bind(at)
            .fetch_one(db)
            .await
            .expect("message")
            .try_get(0)
            .expect("id")
    }

    async fn ban(
        state: &AppState,
        actor: &str,
        body: serde_json::Value,
    ) -> Result<BanResp, StatusCode> {
        ban_member(
            State(state.clone()),
            Authed(mem_user(actor, false)),
            Path("club".to_string()),
            Json(serde_json::from_value(body).expect("body")),
        )
        .await
        .map(|Json(done)| done)
        .map_err(|e| e.0)
    }

    async fn joins(state: &AppState, who: &str) -> bool {
        join_server(
            State(state.clone()),
            Authed(mem_user(who, false)),
            Path("club".to_string()),
            None,
        )
        .await
        .is_ok()
    }

    async fn listed(state: &AppState) -> Vec<(String, Option<i64>, Option<String>)> {
        let Paged(list, _) = list_bans(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            Path("club".to_string()),
            Query(MembersQuery {
                offset: None,
                limit: None,
                cursor: None,
            }),
        )
        .await
        .expect("bans");
        list.into_iter()
            .map(|b| (b.user.username, b.expires_at, b.reason))
            .collect()
    }

    #[test]
    fn ban_options_are_bounded() {
        let ok = |d, p| options(d, None, p, 100).is_ok();
        assert!(ok(None, None));
        assert!(ok(Some(BAN_MIN), Some(0)));
        assert!(ok(Some(BAN_MAX), Some(PURGE_HOURS_MAX)));
        assert!(!ok(Some(BAN_MIN - 1), None));
        assert!(!ok(Some(BAN_MAX + 1), None));
        assert!(!ok(None, Some(-1)));
        assert!(!ok(None, Some(PURGE_HOURS_MAX + 1)));
        assert!(options(None, Some("x".repeat(301)), None, 100).is_err());
        let o = options(Some(60), Some("  spam  ".to_string()), Some(3), 100).expect("options");
        assert_eq!(
            (o.expires_at, o.reason.as_deref(), o.purge_hours),
            (Some(160), Some("spam"), 3)
        );
        assert_eq!(
            options(None, Some("  ".to_string()), None, 100)
                .expect("blank")
                .reason,
            None
        );
    }

    #[tokio::test]
    async fn a_timed_ban_ends_by_itself_and_the_sweep_records_it() {
        for (state, temp) in each_db("ban_timed").await {
            let db = &state.db;
            club(db).await;
            assert_eq!(
                ban(
                    &state,
                    "alice",
                    serde_json::json!({"username": "bob", "duration_secs": 59})
                )
                .await
                .err(),
                Some(StatusCode::BAD_REQUEST)
            );
            let done = ban(
                &state,
                "alice",
                serde_json::json!({"username": "bob", "duration_secs": 3600, "reason": "spam"}),
            )
            .await
            .expect("ban");
            let until = done.expires_at.expect("an end");
            assert!((now() + 3590..=now() + 3600).contains(&until));
            assert_eq!(
                (done.purge_places, done.purge_skipped, done.purge_busy),
                (0, 0, 0)
            );
            assert_eq!(
                listed(&state).await,
                vec![("bob".to_string(), Some(until), Some("spam".to_string()))]
            );
            assert!(banned(db, "club", "bob").await.expect("banned"));
            assert!(!joins(&state, "bob").await);
            assert_eq!(sweep_expired(db, now()).await.expect("sweep"), 0);

            let same = ban(
                &state,
                "alice",
                serde_json::json!({"username": "bob", "duration_secs": 3600, "reason": "spam"}),
            )
            .await
            .expect("the same ban again");
            assert!(same.expires_at.expect("an end") >= until);
            let replaced = ban(
                &state,
                "alice",
                serde_json::json!({"username": "bob", "duration_secs": 60, "reason": "again"}),
            )
            .await
            .expect("replace");
            assert!(replaced.expires_at.expect("an end") < until);
            assert_eq!(
                count(db, "SELECT COUNT(*) FROM server_bans WHERE server = 'club' AND username = 'bob' AND reason = 'again'").await,
                1
            );

            let forever = ban(&state, "alice", serde_json::json!({"username": "bob"}))
                .await
                .expect("without an end");
            assert_eq!(forever.expires_at, None);
            assert_eq!(
                count(db, "SELECT COUNT(*) FROM server_bans WHERE server = 'club' AND username = 'bob' AND expires_at IS NULL AND reason IS NULL").await,
                1,
                "banning again replaces the end and the reason"
            );
            exec(db, "UPDATE server_bans SET expires_at = 5").await;
            assert!(!banned(db, "club", "bob").await.expect("ended"));
            assert!(listed(&state).await.is_empty());
            assert!(
                joins(&state, "bob").await,
                "an ended ban admits before the sweep"
            );
            assert_eq!(count(db, "SELECT COUNT(*) FROM server_bans").await, 1);
            assert_eq!(sweep_expired(db, now()).await.expect("sweep"), 1);
            assert_eq!(count(db, "SELECT COUNT(*) FROM server_bans").await, 0);
            let details: String = sqlx::query("SELECT details FROM audit_log WHERE server = 'club' AND action = 'member.unban' AND target_name = 'bob' AND actor IS NULL AND staff = 0")
                .fetch_one(db)
                .await
                .expect("the expiry entry")
                .try_get(0)
                .expect("details");
            let details: serde_json::Value = serde_json::from_str(&details).expect("json");
            assert_eq!(details["expired"], serde_json::json!(true));
            assert_eq!(sweep_expired(db, now()).await.expect("again"), 0);
            temp.done(state).await;
        }
    }

    #[tokio::test]
    async fn a_ban_without_an_end_is_never_swept() {
        for (state, temp) in each_db("ban_forever").await {
            let db = &state.db;
            club(db).await;
            let done = ban(&state, "alice", serde_json::json!({"username": "bob"}))
                .await
                .expect("ban");
            assert_eq!(done.expires_at, None);
            assert_eq!(
                sweep_expired(db, now() + BAN_MAX * 2).await.expect("sweep"),
                0
            );
            assert!(banned(db, "club", "bob").await.expect("banned"));
            temp.done(state).await;
        }
    }

    #[tokio::test]
    async fn a_ban_deletes_recent_messages_where_the_actor_may() {
        for (state, temp) in each_db("ban_purge").await {
            let db = &state.db;
            let (general, side) = club(db).await;
            let t = now();
            let old = post(db, general, None, "bob", t - 3 * 3600).await;
            let recent = post(db, general, None, "bob", t - 600).await;
            let other = post(db, general, None, "alice", t - 600).await;
            let root = post(db, side, None, "alice", t - 900).await;
            let reply = post(db, side, Some(root), "bob", t - 300).await;
            let old_reply = post(db, side, Some(root), "bob", t - 9 * 3600).await;

            let user = crate::db::get_user(db, "mo")
                .await
                .expect("mo")
                .expect("mo");
            assert_eq!(
                may_delete_in(db, &user, general, "bob")
                    .await
                    .expect("gate"),
                Some(false)
            );
            assert_eq!(
                may_delete_in(db, &user, general, "mo").await.expect("own"),
                Some(true)
            );
            let skipped = enqueue_purge(db, &user, "club", "bob", t - 3600)
                .await
                .expect("purge");
            assert_eq!(
                skipped,
                Purge {
                    jobs: Vec::new(),
                    skipped: 2,
                    busy: 0,
                }
            );

            let alice = crate::db::get_user(db, "alice")
                .await
                .expect("alice")
                .expect("alice");
            assert_eq!(
                may_delete_in(db, &alice, general, "bob")
                    .await
                    .expect("gate"),
                Some(true)
            );
            assert_eq!(
                may_delete_in(db, &alice, i64::MAX, "bob")
                    .await
                    .expect("gate"),
                None
            );
            let purge = enqueue_purge(db, &alice, "club", "bob", t - 3600)
                .await
                .expect("purge");
            assert_eq!((purge.jobs.len(), purge.skipped, purge.busy), (2, 0, 0));
            let scopes: Vec<String> = sqlx::query("SELECT scope FROM bulk_delete_jobs WHERE username = 'alice' AND author_filter = 'bob' ORDER BY id")
                .fetch_all(db)
                .await
                .expect("jobs")
                .iter()
                .map(|r| r.try_get(0).expect("scope"))
                .collect();
            assert_eq!(scopes, vec![format!("c{general}"), format!("t{root}")]);
            let again = enqueue_purge(db, &alice, "club", "bob", t - 3600)
                .await
                .expect("purge");
            assert_eq!(
                (again.jobs.len(), again.skipped, again.busy),
                (0, 0, 2),
                "places where a job of alice runs are busy, not skipped"
            );
            exec(db, "UPDATE bulk_delete_jobs SET claimed_at = 0").await;
            assert_eq!(hold_lease(db, &purge.jobs, now()).await.expect("hold"), 2);
            assert_eq!(
                crate::api::bulk_delete::resume_jobs(&state)
                    .await
                    .expect("resume"),
                0,
                "the sweep leaves held purge jobs to their runner"
            );
            for id in purge.jobs {
                run_job(&state, id).await;
            }
            let left: Vec<i64> = sqlx::query("SELECT id FROM messages ORDER BY id")
                .fetch_all(db)
                .await
                .expect("messages")
                .iter()
                .map(|r| r.try_get(0).expect("id"))
                .collect();
            assert!(!left.contains(&recent) && !left.contains(&reply));
            for kept in [old, other, root, old_reply] {
                assert!(left.contains(&kept), "{kept} stays");
            }
            temp.done(state).await;
        }
    }

    #[tokio::test]
    async fn a_purge_says_nothing_of_channels_the_actor_cannot_see() {
        for (state, temp) in each_db("ban_purge_hidden").await {
            let db = &state.db;
            let (general, _) = club(db).await;
            crate::db::NewUser::plain("dee").add(db).await;
            add_member(db, "club", "dee", 1, KICK | DELETE, 1).await;
            let secret: i64 = sqlx::query("INSERT INTO channels(server, name, kind, created_at, restrict_view) VALUES('club', 'secret', 'text', 1, 1) RETURNING id")
                .fetch_one(db)
                .await
                .expect("channel")
                .try_get(0)
                .expect("id");
            let t = now();
            post(db, general, None, "bob", t - 60).await;
            let root = post(db, secret, None, "bob", t - 60).await;
            post(db, secret, Some(root), "bob", t - 30).await;
            for (actor, places, skipped) in [("dee", 1, 0), ("mo", 0, 1)] {
                let user = crate::db::get_user(db, actor)
                    .await
                    .expect("user")
                    .expect("user");
                assert_eq!(
                    may_delete_in(db, &user, secret, "bob").await.expect("gate"),
                    None
                );
                let purge = enqueue_purge(db, &user, "club", "bob", t - 3600)
                    .await
                    .expect("purge");
                assert_eq!(
                    (purge.jobs.len(), purge.skipped, purge.busy),
                    (places, skipped, 0),
                    "{actor}"
                );
            }
            temp.done(state).await;
        }
    }

    #[tokio::test]
    async fn the_ban_list_pages_over_bans_in_force() {
        for (state, temp) in each_db("ban_list_live").await {
            let db = &state.db;
            club(db).await;
            for (name, at, until) in [("eve", 30, "5"), ("fay", 20, "5"), ("gus", 10, "NULL")] {
                exec(db, &format!("INSERT INTO server_bans(server, username, banned_by, created_at, expires_at) VALUES('club', '{name}', 'alice', {at}, {until})")).await;
            }
            let Paged(list, next) = list_bans(
                State(state.clone()),
                Authed(mem_user("alice", false)),
                Path("club".to_string()),
                Query(MembersQuery {
                    offset: None,
                    limit: Some(1),
                    cursor: None,
                }),
            )
            .await
            .expect("bans");
            assert_eq!(
                list.iter()
                    .map(|b| b.user.username.as_str())
                    .collect::<Vec<_>>(),
                vec!["gus"]
            );
            assert_eq!(next, None);
            temp.done(state).await;
        }
    }

    #[tokio::test]
    async fn the_ban_route_counts_purged_and_skipped_places() {
        for (state, temp) in each_db("ban_purge_route").await {
            let db = &state.db;
            let (general, _) = club(db).await;
            crate::db::NewUser::plain("carol").add(db).await;
            add_member(db, "club", "carol", 0, 0, 1).await;
            post(db, general, None, "bob", now() - 60).await;
            post(db, general, None, "carol", now() - 60).await;
            assert_eq!(
                ban(
                    &state,
                    "alice",
                    serde_json::json!({"username": "bob", "purge_hours": 169})
                )
                .await
                .err(),
                Some(StatusCode::BAD_REQUEST)
            );
            let by_mo = ban(
                &state,
                "mo",
                serde_json::json!({"username": "carol", "purge_hours": 1}),
            )
            .await
            .expect("ban");
            assert_eq!(
                (by_mo.purge_places, by_mo.purge_skipped, by_mo.purge_busy),
                (0, 1, 0)
            );
            let by_alice = ban(
                &state,
                "alice",
                serde_json::json!({"username": "bob", "purge_hours": 1}),
            )
            .await
            .expect("ban");
            assert_eq!(
                (
                    by_alice.purge_places,
                    by_alice.purge_skipped,
                    by_alice.purge_busy
                ),
                (1, 0, 0)
            );
            temp.done(state).await;
        }
    }
}
