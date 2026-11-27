use std::collections::{BTreeSet, HashMap};

use sqlx::Row;

use super::{Floors, SITE_SQL, columns, place, writer};
use crate::api::ApiError;
use crate::crypt::body::{OPTIONS, POLLS, Parts, SNAPSHOTS, Scope, open_body};
use crate::crypt::grams::{Grams, array};
use crate::db::{Db, is_sqlite, now};

/// The `settings` key holding the last message id the sweep looked at.
const CURSOR: &str = "seal_sweep_id";
/// Rows this young are left for the next run: a copy may still be writing before them.
const LAG_SECS: i64 = 300;
const WINDOW: i64 = 20_000;
const BATCH: i64 = 200;
const WINDOWS_PER_RUN: usize = 20;

/// Seals the message `id` and its poll when it is stored plain in a place that seals it. The
/// row is written only while it still holds the text that was read. Returns whether it was
/// sealed.
pub(crate) async fn seal_row(db: &Db, id: i64) -> Result<bool, ApiError> {
    let sqlite = is_sqlite(db);
    let mut tx = match sqlite {
        true => db.begin_with("BEGIN IMMEDIATE").await?,
        false => db.begin().await?,
    };
    let row = sqlx::query("SELECT channel_id, dm_id, author, content, webhook_embeds, media_filename, fwd_dropped, media_alt FROM messages WHERE id = $1 AND body IS NULL AND kind IN ('user', 'poll')")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(row) = row else {
        return Ok(false);
    };
    let Some(scope) = Scope::of(row.try_get(0)?, row.try_get(1)?) else {
        return Ok(false);
    };
    let floors: Floors = place(&mut tx, sqlite, scope).await?;
    if floors.floor().is_none_or(|from| id < from) {
        return Ok(false);
    }
    let Some(writer) = writer(db, &mut tx, scope, floors).await? else {
        return Ok(false);
    };
    let author: String = row.try_get(2)?;
    let parts = Parts {
        content: row.try_get(3)?,
        embeds: row.try_get(4)?,
        filename: row.try_get(5)?,
        dropped: row.try_get(6)?,
        alt: row.try_get(7)?,
    };
    let blank = columns(Some(&writer), &parts);
    let grams = match sqlite {
        true => String::new(),
        false => format!(", grams = {}", super::grams_value(9)),
    };
    let query = sqlx::query(sqlx::AssertSqlSafe(format!("UPDATE messages SET body = $1, content = $2, webhook_embeds = $3, media_filename = $4, fwd_dropped = $7, media_alt = $8{grams} WHERE id = $5 AND body IS NULL AND content = $6")))
        .bind(writer.message(id, &author, &parts))
        .bind(&blank.content)
        .bind(&blank.embeds)
        .bind(&blank.filename)
        .bind(id)
        .bind(&parts.content)
        .bind(&blank.dropped)
        .bind(&blank.alt);
    let query = match sqlite {
        true => query,
        false => query.bind(writer.grams(&parts)),
    };
    let written = query.execute(&mut *tx).await?.rows_affected();
    if written == 0 {
        return Ok(false);
    }
    let question: Option<String> =
        sqlx::query_scalar("SELECT question FROM polls WHERE message_id = $1 AND body IS NULL")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    if let Some(question) = question {
        sqlx::query("UPDATE polls SET body = $1, question = '' WHERE message_id = $2 AND body IS NULL AND question = $3")
            .bind(writer.text(POLLS, id, &question))
            .bind(id)
            .bind(&question)
            .execute(&mut *tx)
            .await?;
        let options: Vec<(i64, String)> = sqlx::query_as(
            "SELECT id, text FROM poll_options WHERE message_id = $1 AND body IS NULL",
        )
        .bind(id)
        .fetch_all(&mut *tx)
        .await?;
        for (option, text) in options {
            sqlx::query("UPDATE poll_options SET body = $1, text = '' WHERE id = $2 AND body IS NULL AND text = $3")
                .bind(writer.text(OPTIONS, option, &text))
                .bind(option)
                .bind(&text)
                .execute(&mut *tx)
                .await?;
        }
    }
    let data: Option<String> = sqlx::query_scalar(
        "SELECT data FROM poll_snapshots WHERE message_id = $1 AND body IS NULL",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(data) = data {
        sqlx::query("UPDATE poll_snapshots SET body = $1, data = '' WHERE message_id = $2 AND body IS NULL AND data = $3")
            .bind(writer.text(SNAPSHOTS, id, &data))
            .bind(id)
            .bind(&data)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(true)
}

async fn cursor(db: &Db) -> sqlx::Result<Option<i64>> {
    let stored: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = $1")
        .bind(CURSOR)
        .fetch_optional(db)
        .await?;
    Ok(stored.and_then(|v| v.parse().ok()))
}

async fn keep(db: &Db, at: i64) -> sqlx::Result<()> {
    sqlx::query("INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(CURSOR)
        .bind(at.to_string())
        .execute(db)
        .await
        .map(|_| ())
}

const GRAMS_BATCH: i64 = 500;
const GRAMS_BATCHES: usize = 20;
/// The encrypted channel messages without grams after `($1, $2)` as `(channel, id)`, `$3` of them.
pub(crate) const WITHOUT_GRAMS: &str = "SELECT id, channel_id, author, body FROM messages WHERE body IS NOT NULL AND grams IS NULL AND channel_id IS NOT NULL AND (channel_id, id) > ($1, $2) ORDER BY channel_id, id LIMIT $3";

/// Gives encrypted channel messages on Postgres the keyed grams they lack: rows stored with
/// `SEARCH_SEALED=scan` or before the site had a search key. A record that does not open keeps
/// none, so a search still reads it; each start reads it once. Returns how many rows it gave
/// grams.
pub(crate) async fn fill_grams(db: &Db) -> Result<u64, ApiError> {
    let ring = crate::db::ring(db);
    if is_sqlite(db) || ring.scans() {
        return Ok(0);
    }
    let mut filled = 0;
    let mut from = ring.grams_from();
    for _ in 0..GRAMS_BATCHES {
        let (after_channel, after_id) = from.unwrap_or((i64::MIN, i64::MIN));
        let rows = sqlx::query(WITHOUT_GRAMS)
            .bind(after_channel)
            .bind(after_id)
            .bind(GRAMS_BATCH)
            .fetch_all(db)
            .await?;
        let channels: BTreeSet<i64> = rows
            .iter()
            .map(|r| r.try_get(1))
            .collect::<sqlx::Result<_>>()?;
        let keyers: HashMap<i64, Grams> = Grams::of_channels(db, channels)
            .await
            .map_err(ApiError::internal)?
            .into_iter()
            .collect();
        if keyers.is_empty() {
            break;
        }
        for row in &rows {
            let (id, channel, author): (i64, i64, String) =
                (row.try_get(0)?, row.try_get(1)?, row.try_get(2)?);
            from = Some((channel, id));
            let record: Vec<u8> = row.try_get(3)?;
            let opened = open_body(
                db,
                id,
                Some(Scope::Channel(channel)),
                &author,
                Some(record.clone()),
                Parts::default(),
            )
            .await?;
            let Some(keyer) = keyers.get(&channel).filter(|_| !opened.unreadable) else {
                continue;
            };
            filled += sqlx::query("UPDATE messages SET grams = CAST(CAST($1 AS TEXT) AS integer[]) WHERE id = $2 AND body = $3 AND grams IS NULL")
                .bind(array(&keyer.document(&opened.parts.content)))
                .bind(id)
                .bind(record)
                .execute(db)
                .await?
                .rows_affected();
        }
        if (rows.len() as i64) < GRAMS_BATCH {
            break;
        }
    }
    ring.set_grams_from(from);
    if filled > 0 {
        tracing::info!("gave {filled} encrypted messages their search grams");
    }
    Ok(filled)
}

/// Seals the messages that a sealed place got stored plain: rows a copy of an older build
/// wrote, or a copy that had not seen the switch yet. It walks forward from where the last run
/// stopped and returns how many rows it sealed.
pub(crate) async fn sweep(db: &Db) -> Result<u64, ApiError> {
    fill_grams(db).await?;
    let settled: Option<i64> = sqlx::query_scalar(
        "SELECT id FROM messages WHERE created_at <= $1 ORDER BY id DESC LIMIT 1",
    )
    .bind(now() - LAG_SECS)
    .fetch_optional(db)
    .await?;
    let Some(settled) = settled else {
        return Ok(0);
    };
    let first: Option<i64> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT MIN(f) FROM (SELECT MIN(seal) AS f FROM servers WHERE seal > 0 UNION ALL SELECT MIN(seal_forced) FROM servers WHERE seal_forced > 0 UNION ALL SELECT MIN(seal) FROM dms WHERE seal > 0 UNION ALL SELECT NULLIF({SITE_SQL}, 0)) x"
    )))
    .fetch_one(db)
    .await?;
    let stored = cursor(db).await?;
    let Some(first) = first else {
        if stored.is_none_or(|at| at < settled) {
            keep(db, settled).await?;
        }
        return Ok(0);
    };
    let start = stored.unwrap_or(0).max(first - 1);
    let (mut at, mut sealed) = (start, 0);
    for _ in 0..WINDOWS_PER_RUN {
        if at >= settled {
            break;
        }
        let end = settled.min(at + WINDOW);
        let ids: Vec<i64> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "SELECT m.id FROM messages m LEFT JOIN channels c ON c.id = m.channel_id LEFT JOIN servers s ON s.name = c.server LEFT JOIN dms d ON d.id = m.dm_id CROSS JOIN (SELECT {SITE_SQL} AS f) site WHERE m.id > $1 AND m.id <= $2 AND m.body IS NULL AND m.kind IN ('user', 'poll') AND ((s.seal > 0 AND m.id >= s.seal) OR (s.seal_forced > 0 AND m.id >= s.seal_forced) OR (d.seal > 0 AND m.id >= d.seal) OR (site.f > 0 AND m.id >= site.f)) ORDER BY m.id LIMIT $3"
        )))
        .bind(at)
        .bind(end)
        .bind(BATCH)
        .fetch_all(db)
        .await?;
        for id in &ids {
            if seal_row(db, *id).await? {
                sealed += 1;
            }
        }
        at = match ids.last() {
            Some(last) if ids.len() as i64 == BATCH => *last,
            Some(_) | None => end,
        };
    }
    if at != start || stored.is_none() {
        keep(db, at).await?;
    }
    if sealed > 0 {
        tracing::info!("sealed {sealed} messages that a sealed place stored plain");
    }
    Ok(sealed)
}
