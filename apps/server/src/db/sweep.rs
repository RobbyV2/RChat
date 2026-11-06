use sqlx::Row;

use super::pool::{Db, reader};
use super::{now, recount_members};
use crate::limits::Limits;

/// Servers checked per read by `fix_member_counts`.
const COUNT_BATCH: i64 = 500;

/// Recounts every server whose `member_count` differs from its member rows (an update lost to a
/// crash or an older binary, a recount that failed). Reads `batch` servers at a time in name order
/// on the read pool, without locks, and recounts only the ones that are off. Returns how many it
/// fixed.
pub(crate) async fn fix_member_counts(db: &Db, batch: i64) -> sqlx::Result<u64> {
    let read = reader(db);
    let mut after = String::new();
    let mut fixed = 0;
    loop {
        let names = sqlx::query("SELECT name FROM servers WHERE name > $1 ORDER BY name LIMIT $2")
            .bind(&after)
            .bind(batch)
            .fetch_all(&read)
            .await?;
        let Some(last) = names.last() else {
            return Ok(fixed);
        };
        let last: String = last.try_get(0)?;
        let off = sqlx::query("SELECT s.name FROM servers s WHERE s.name > $1 AND s.name <= $2 AND s.member_count <> (SELECT COUNT(*) FROM members m WHERE m.server = s.name)")
            .bind(&after)
            .bind(&last)
            .fetch_all(&read)
            .await?;
        for row in &off {
            recount_members(db, &row.try_get::<String, _>(0)?).await?;
            fixed += 1;
        }
        if (names.len() as i64) < batch {
            return Ok(fixed);
        }
        after = last;
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Swept {
    pub guest_grants: u64,
    pub server_passwords: u64,
    pub login_attempts: u64,
    pub password_attempts: u64,
    pub embeds: u64,
    pub pings: u64,
    pub config_shares: u64,
    pub audit_log: u64,
    pub member_timeouts: u64,
    pub bulk_delete_jobs: u64,
    pub webhook_deliveries: u64,
    pub member_counts: u64,
}

async fn delete_batched(db: &Db, sql: &'static str, cutoff: i64) -> sqlx::Result<u64> {
    let mut total = 0;
    loop {
        let n = sqlx::query(sql)
            .bind(cutoff)
            .bind(PURGE_BATCH)
            .execute(db)
            .await?
            .rows_affected();
        total += n;
        if n < PURGE_BATCH as u64 {
            return Ok(total);
        }
        tokio::task::yield_now().await;
    }
}

pub const SERVER_PASSWORD_KEEP: i64 = 30 * 86400;

pub const PING_KEEP: i64 = 30 * 86400;

/// How long audit log entries are kept.
pub const AUDIT_KEEP: i64 = 90 * 86400;

/// How long an ended timeout row is kept before the sweep deletes it (the checks ignore it).
pub const TIMEOUT_KEEP: i64 = 3600;

/// Most seen and retracted pings kept per recipient. Seen pings stay until they age out, so the
/// inbox can list them and taking a reaction back and adding it again does not ping again; this
/// caps them.
pub const PINGS_KEPT: i64 = 2000;

/// Deletes what has aged out, with the retention times of `limits`.
pub async fn sweep_stale(db: &Db, limits: &Limits) -> sqlx::Result<Swept> {
    let t = now();
    let stale_grants = delete_batched(
        db,
        "DELETE FROM guest_grants WHERE \"grant\" IN (SELECT \"grant\" FROM guest_grants WHERE last_used_at < $1 AND (last_used_at > 0 OR created_at < $1) LIMIT $2)",
        t - limits.guest_grant_ttl(),
    )
    .await?;
    let ended_grants = delete_batched(
        db,
        "DELETE FROM guest_grants WHERE \"grant\" IN (SELECT g.\"grant\" FROM guest_grants g WHERE g.password_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM server_passwords p WHERE p.id = g.password_id AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at > $1)) LIMIT $2)",
        t,
    )
    .await?;
    Ok(Swept {
        guest_grants: stale_grants + ended_grants,
        server_passwords: delete_batched(
            db,
            "DELETE FROM server_passwords WHERE id IN (SELECT id FROM server_passwords WHERE revoked_at < $1 OR expires_at < $1 OR used_up_at < $1 LIMIT $2)",
            t - SERVER_PASSWORD_KEEP,
        )
        .await?,
        login_attempts: delete_batched(
            db,
            "DELETE FROM login_attempts WHERE username IN (SELECT username FROM login_attempts WHERE last_at < $1 LIMIT $2)",
            t - 2 * 86400,
        )
        .await?,
        password_attempts: delete_batched(
            db,
            "DELETE FROM change_attempts WHERE session IN (SELECT session FROM change_attempts WHERE last_at < $1 LIMIT $2)",
            t - 2 * 86400,
        )
        .await?,
        embeds: delete_batched(
            db,
            "DELETE FROM embeds WHERE url IN (SELECT e.url FROM embeds e WHERE e.fetched_at < $1 AND NOT EXISTS(SELECT 1 FROM message_embeds me WHERE me.url = e.url) LIMIT $2)",
            t - limits.embed_cache_ttl(),
        )
        .await?
            + delete_batched(
                db,
                "DELETE FROM preview_images WHERE key IN (SELECT key FROM preview_images WHERE fetched_at < $1 LIMIT $2)",
                t - 7 * 86400,
            )
            .await?,
        pings: delete_batched(
            db,
            "DELETE FROM pings WHERE id IN (SELECT id FROM pings WHERE created_at < $1 LIMIT $2)",
            t - PING_KEEP,
        )
        .await?
            + trim_kept_pings(db).await?
            + delete_batched(
                db,
                "DELETE FROM group_pings WHERE id IN (SELECT id FROM group_pings WHERE created_at < $1 LIMIT $2)",
                t - PING_KEEP,
            )
            .await?
            + delete_batched(
                db,
                "DELETE FROM group_pings_read WHERE (username, message_id) IN (SELECT username, message_id FROM group_pings_read WHERE created_at < $1 LIMIT $2)",
                t - PING_KEEP,
            )
            .await?
            + delete_batched(
                db,
                "DELETE FROM friend_pings WHERE id IN (SELECT id FROM friend_pings WHERE created_at < $1 LIMIT $2)",
                t - PING_KEEP,
            )
            .await?,
        config_shares: delete_batched(
            db,
            "DELETE FROM config_shares WHERE id IN (SELECT id FROM config_shares WHERE expires_at <= $1 LIMIT $2)",
            t,
        )
        .await?,
        audit_log: delete_batched(
            db,
            "DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE created_at < $1 LIMIT $2)",
            t - AUDIT_KEEP,
        )
        .await?,
        member_timeouts: delete_batched(
            db,
            "DELETE FROM member_timeouts WHERE (server, username) IN (SELECT server, username FROM member_timeouts WHERE until < $1 LIMIT $2)",
            t - TIMEOUT_KEEP,
        )
        .await?,
        bulk_delete_jobs: delete_batched(
            db,
            "DELETE FROM bulk_delete_jobs WHERE id IN (SELECT id FROM bulk_delete_jobs WHERE status <> 'running' AND finished_at < $1 LIMIT $2)",
            t - crate::api::bulk_delete::JOB_KEEP,
        )
        .await?,
        webhook_deliveries: delete_batched(
            db,
            "DELETE FROM webhook_deliveries WHERE id IN (SELECT id FROM webhook_deliveries WHERE created_at < $1 LIMIT $2)",
            t - crate::api::webhooks::DELIVERY_KEEP,
        )
        .await?,
        member_counts: fix_member_counts(db, COUNT_BATCH).await?,
    })
}

pub const PURGE_BATCH: i64 = 500;

/// Recipients with more than `PINGS_KEPT` seen pings handled per sweep.
const KEPT_USERS_MAX: i64 = 1000;

/// Recipients above the seen-ping cap. `seen IN (1, 2)` keeps it on the covering
/// `idx_pings_user (username, seen, id)`, so no ping row is looked up.
pub(crate) const KEPT_USERS_SQL: &str = "SELECT username FROM pings WHERE seen IN (1, 2) GROUP BY username HAVING COUNT(*) > $1 LIMIT $2";

/// Keeps the newest `PINGS_KEPT` seen and retracted pings of each recipient. One pass over the
/// covering per-user index finds the recipients above the cap; only their pings are looked at.
async fn trim_kept_pings(db: &Db) -> sqlx::Result<u64> {
    let users = sqlx::query(KEPT_USERS_SQL)
        .bind(PINGS_KEPT)
        .bind(KEPT_USERS_MAX)
        .fetch_all(db)
        .await?;
    let mut total = 0;
    for row in &users {
        let username: String = row.try_get(0)?;
        let Some(cut) = sqlx::query("SELECT id FROM pings WHERE username = $1 AND seen <> 0 ORDER BY id DESC LIMIT 1 OFFSET $2")
            .bind(&username)
            .bind(PINGS_KEPT)
            .fetch_optional(db)
            .await?
        else {
            continue;
        };
        let cut: i64 = cut.try_get(0)?;
        loop {
            let n = sqlx::query("DELETE FROM pings WHERE id IN (SELECT id FROM pings WHERE username = $1 AND seen <> 0 AND id <= $2 LIMIT $3)")
                .bind(&username)
                .bind(cut)
                .bind(PURGE_BATCH)
                .execute(db)
                .await?
                .rows_affected();
            total += n;
            if n < PURGE_BATCH as u64 {
                break;
            }
            tokio::task::yield_now().await;
        }
    }
    Ok(total)
}

pub async fn purge_messages(db: &Db, cond: &'static str, key: &str) -> sqlx::Result<u64> {
    let sql = format!(
        "DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE {cond} LIMIT {PURGE_BATCH})"
    );
    let mut total = 0;
    loop {
        let n = sqlx::query(sqlx::AssertSqlSafe(sql.clone()))
            .bind(key)
            .execute(db)
            .await?
            .rows_affected();
        total += n;
        if n == 0 {
            return Ok(total);
        }
        tokio::task::yield_now().await;
    }
}
