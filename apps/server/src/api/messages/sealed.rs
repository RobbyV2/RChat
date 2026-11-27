//! Search of encrypted messages. Plain rows keep the plain index; an encrypted row is found by
//! its keyed grams, or read and opened. A place that was never encrypted costs a search nothing.

use std::collections::{BTreeSet, HashMap};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use sqlx::Row;
use sqlx::any::AnyRow;

use super::{
    BODY_COL, Bind, FTS_BATCH, FTS_MIN_CHARS, FTS_ROUNDS, LIKE_BUDGET, Quotes, SEARCH_OFFSET_MAX,
    SEARCH_PAGE, SEARCH_WINDOW, Scan, Scope, SearchCursor, SearchQuery, SearchResult, Stream,
    attach_embeds, bind_all, plain_page, rows_messages, search_sql,
};
use crate::api::ApiError;
use crate::api::seal::SITE_SINCE;
use crate::crypt::body::{Opener, Parts, Scope as SealScope};
use crate::crypt::grams::{Grams, array, bucket, found, term};
use crate::db::{Db, is_sqlite, pool_key};

/// Candidates one search reads in all, as the channel index walk does.
const CANDIDATES: usize = (FTS_BATCH * FTS_ROUNDS as i64) as usize;

static EVER: LazyLock<Mutex<HashMap<String, (Instant, bool)>>> = LazyLock::new(Default::default);
const EVER_TTL: Duration = Duration::from_secs(5);

/// Whether a server of the site ever stored messages encrypted, as last read, at most 5 seconds
/// old. A switch turned on shows here within that time; the rows it covers are read after it.
async fn ever(db: &Db) -> sqlx::Result<bool> {
    let key = pool_key(db);
    let hit = EVER.lock().ok().and_then(|cache| {
        cache
            .get(&key)
            .filter(|(at, _)| at.elapsed() < EVER_TTL)
            .map(|(_, ever)| *ever)
    });
    if let Some(ever) = hit {
        return Ok(ever);
    }
    let ever: i64 = sqlx::query_scalar(
        "SELECT CASE WHEN EXISTS(SELECT 1 FROM servers WHERE seal_since IS NOT NULL) OR EXISTS(SELECT 1 FROM settings WHERE key = $1) THEN 1 ELSE 0 END",
    )
    .bind(SITE_SINCE)
    .fetch_one(db)
    .await?;
    if let Ok(mut cache) = EVER.lock() {
        cache.insert(key, (Instant::now(), ever != 0));
    }
    Ok(ever != 0)
}

/// Forgets what `ever` read, for a switch that just turned on.
pub(crate) fn forget(db: &Db) {
    if let Ok(mut cache) = EVER.lock() {
        cache.remove(&pool_key(db));
    }
}

/// The channels a search reads that may hold encrypted messages: those of servers that ever
/// stored messages encrypted, or all of them once the site required it.
pub(super) async fn channels(
    db: &Db,
    current: &Db,
    scope: &Scope,
    sq: &SearchQuery,
) -> Result<Vec<i64>, ApiError> {
    if !ever(current).await? {
        return Ok(Vec::new());
    }
    let mut binds = Vec::new();
    let mut place = scope.place();
    if let Some(server) = &sq.server {
        binds.push(Bind::S(server.to_lowercase()));
        place.push_str(&format!(
            " AND c.server = ${}",
            scope.binds.len() + binds.len()
        ));
    }
    if let Some(id) = sq.channel_id {
        binds.push(Bind::I(id));
        place.push_str(&format!(" AND c.id = ${}", scope.binds.len() + binds.len()));
    }
    binds.push(Bind::S(SITE_SINCE.to_owned()));
    let since = scope.binds.len() + binds.len();
    let sql = format!(
        "SELECT c.id FROM channels c WHERE {place} AND (EXISTS(SELECT 1 FROM servers s WHERE s.name = c.server AND s.seal_since IS NOT NULL) OR EXISTS(SELECT 1 FROM settings WHERE key = ${since})) ORDER BY c.id"
    );
    Ok(bind_all(
        bind_all(sqlx::query(sqlx::AssertSqlSafe(sql)), &scope.binds),
        &binds,
    )
    .fetch_all(db)
    .await?
    .iter()
    .map(|r| r.try_get(0))
    .collect::<sqlx::Result<_>>()?)
}

/// The keyed terms the channel index walk looks for in the streams of encrypted channels, as
/// the JSON `[[channel, term, bucket, set], ...]` of the runs `runs` of the text, `set` 0 for
/// the search key and 1 on for the keys a rotation replaces. `None` when no stream is of one,
/// or the site has no search key.
pub(super) async fn keyed_terms(
    db: &Db,
    streams: &[Stream],
    sealed: &[i64],
    runs: &[String],
) -> Result<Option<String>, ApiError> {
    let wanted: BTreeSet<i64> = streams
        .iter()
        .map(|s| s.channel)
        .filter(|c| sealed.binary_search(c).is_ok())
        .collect();
    if wanted.is_empty() || runs.is_empty() {
        return Ok(None);
    }
    let keyers = Grams::every_of_channels(db, wanted)
        .await
        .map_err(ApiError::internal)?;
    let mut terms = Vec::new();
    for (channel, set, keyer) in &keyers {
        for run in runs {
            let gram = keyer.gram(run);
            terms.push(serde_json::json!([channel, term(gram), bucket(gram), set]));
        }
    }
    Ok((!terms.is_empty()).then(|| serde_json::Value::Array(terms).to_string()))
}

/// The grams each channel's candidates must hold, as `Scan::Sealed` takes them: none for text
/// shorter than a run, without a search key, or while a rotation of it has messages left under
/// the old one (then every encrypted candidate is read).
async fn needles(db: &Db, channels: &[i64], text: &str) -> Result<Option<String>, ApiError> {
    if text.chars().count() < FTS_MIN_CHARS
        || crate::db::ring(db).rotating(crate::crypt::Purpose::Search)
    {
        return Ok(None);
    }
    let keyers = Grams::of_channels(db, channels.iter().copied())
        .await
        .map_err(ApiError::internal)?;
    if keyers.is_empty() {
        return Ok(None);
    }
    let by_channel: serde_json::Map<String, serde_json::Value> = keyers
        .iter()
        .map(|(channel, keyer)| (channel.to_string(), array(&keyer.needle(text)).into()))
        .collect();
    Ok(Some(serde_json::Value::Object(by_channel).to_string()))
}

/// The rows of `rows` whose opened text holds `text`, in their order.
async fn matching(db: &Db, rows: Vec<AnyRow>, text: &str) -> Result<Vec<AnyRow>, ApiError> {
    let opener = Opener::of_rows(db, &rows, BODY_COL).await?;
    let mut kept = Vec::new();
    for row in rows {
        let (id, channel, author): (i64, Option<i64>, String) =
            (row.try_get(0)?, row.try_get(1)?, row.try_get(4)?);
        let record = row.try_get::<Option<Vec<u8>>, _>(BODY_COL)?;
        let plain = Parts::text(row.try_get::<String, _>(5)?);
        let opened = opener.message(
            id,
            SealScope::of(channel, None),
            &author,
            record.as_deref(),
            plain,
        );
        if !opened.unreadable && found(&opened.parts.content, text) {
            kept.push(row);
        }
    }
    Ok(kept)
}

/// The search results of matching rows.
async fn results(db: &Db, kept: &[AnyRow]) -> Result<Vec<SearchResult>, ApiError> {
    let mut msgs = rows_messages(db, kept, Quotes::Skip).await?;
    attach_embeds(db, &mut msgs).await?;
    msgs.into_iter()
        .zip(kept)
        .map(|(message, row)| {
            Ok(SearchResult {
                message,
                server: row.try_get("server")?,
                channel_name: row.try_get("name")?,
            })
        })
        .collect()
}

async fn candidates(
    db: &Db,
    scope: &Scope,
    sq: &SearchQuery,
    scan: Scan,
    limit: i64,
) -> Result<Vec<AnyRow>, ApiError> {
    let (sql, binds) = search_sql(db, scope, sq.clone(), scan, limit);
    let query = bind_all(
        bind_all(sqlx::query(sqlx::AssertSqlSafe(sql)), &scope.binds),
        &binds,
    );
    match is_sqlite(db) {
        true => Ok(query.fetch_all(db).await?),
        false => {
            let mut tx = db.begin().await?;
            sqlx::query("SET LOCAL jit = off").execute(&mut *tx).await?;
            let rows = query.fetch_all(&mut *tx).await?;
            tx.commit().await?;
            Ok(rows)
        }
    }
}

/// The newest encrypted message of the JSON channel list `list` on SQLite, 0 without one.
async fn newest(db: &Db, list: &str) -> Result<i64, ApiError> {
    Ok(sqlx::query_scalar::<_, Option<i64>>("SELECT MAX(id) FROM messages WHERE channel_id IN (SELECT value FROM json_each($1)) AND body IS NOT NULL AND grams IS NULL")
        .bind(list)
        .fetch_one(db)
        .await?
        .unwrap_or(0))
}

/// The encrypted messages of `channels` that hold `text`, newest first below `before`, at most
/// `want`, and when it stopped before the oldest message the id from which up every match is in
/// the list. Candidates are read in rounds that grow from a few times `want`; SQLite reads
/// windows of ids that grow as it goes down, Postgres each channel's newest candidates.
async fn pass(
    db: &Db,
    current: &Db,
    scope: &Scope,
    sq: &SearchQuery,
    text: &str,
    channels: &[i64],
    want: usize,
) -> Result<(Vec<SearchResult>, Option<i64>), ApiError> {
    let sqlite = is_sqlite(db);
    let needles = match sqlite {
        true => None,
        false => needles(current, channels, text).await?,
    };
    let list = serde_json::to_string(channels).expect("channel ids");
    let bottom = sq.after.unwrap_or(0).max(0).saturating_add(1);
    let mut hi = match (sq.before, sqlite) {
        (Some(before), _) => before,
        (None, true) => newest(db, &list).await?.saturating_add(1),
        (None, false) => i64::MAX,
    };
    let mut size = SEARCH_WINDOW;
    let mut limit = (want as i64).saturating_mul(4).clamp(1, FTS_BATCH);
    let (mut read, mut scanned) = (0usize, 0i64);
    let mut kept: Vec<AnyRow> = Vec::new();
    let bound = 'walk: loop {
        if hi <= bottom {
            break None;
        }
        let lo = match sqlite {
            true => hi.saturating_sub(size).max(bottom),
            false => bottom,
        };
        let mut top = hi;
        loop {
            let scan = Scan::Sealed {
                lo,
                hi: top,
                channels: list.clone(),
                needles: needles.clone(),
            };
            let rows = candidates(db, scope, sq, scan, limit).await?;
            read += rows.len();
            let full = rows.len() as i64 == limit;
            if let Some(last) = rows.last() {
                top = last.try_get(0)?;
            }
            kept.extend(matching(current, rows, text).await?);
            if kept.len() >= want {
                kept.truncate(want);
                break 'walk match kept.last() {
                    Some(last) => Some(last.try_get(0)?),
                    None => Some(top),
                };
            }
            if !full {
                break;
            }
            if read >= CANDIDATES {
                break 'walk Some(top);
            }
            limit = limit.saturating_mul(4).min(FTS_BATCH);
        }
        scanned = scanned.saturating_add(hi - lo);
        hi = lo;
        size = size.saturating_mul(8);
        if hi > bottom && (read >= CANDIDATES || scanned >= LIKE_BUDGET) {
            break Some(hi);
        }
    };
    Ok((results(current, &kept).await?, bound))
}

/// A page of a search whose channels include encrypted ones: the plain matches and the
/// encrypted ones together, newest first. When either stopped before the oldest message, the
/// page ends where it stopped and the cursor goes on from there.
pub(super) async fn merged(
    db: &Db,
    current: &Db,
    scope: &Scope,
    sq: SearchQuery,
    text: &str,
    channels: &[i64],
    fts: bool,
) -> Result<(Vec<SearchResult>, Option<SearchCursor>), ApiError> {
    let skip = sq.offset.unwrap_or(0).clamp(0, SEARCH_OFFSET_MAX) as usize;
    let page = SEARCH_PAGE as usize;
    let want = page + skip;
    let plain_sq = SearchQuery {
        offset: None,
        ..sq.clone()
    };
    let (plain, plain_next) =
        plain_page(db, current, scope, plain_sq.clone(), fts, want as i64).await?;
    let (sealed, sealed_next) = pass(db, current, scope, &plain_sq, text, channels, want).await?;
    let bound = [plain_next.and_then(|c| c.before), sealed_next]
        .into_iter()
        .flatten()
        .max();
    let mut all: Vec<SearchResult> = plain
        .into_iter()
        .chain(sealed)
        .filter(|r| bound.is_none_or(|b| r.message.id >= b))
        .collect();
    all.sort_by_key(|r| std::cmp::Reverse(r.message.id));
    all.dedup_by_key(|r| r.message.id);
    let held = all.len();
    let results: Vec<SearchResult> = all.into_iter().skip(skip).take(page).collect();
    let next = match (held >= want, bound) {
        (true, _) => results.last().map(|r| SearchCursor::before(r.message.id)),
        (false, Some(bound)) => Some(SearchCursor {
            before: Some(bound),
            skip: (skip - skip.min(held)) as i64,
            pass: None,
        }),
        (false, None) => None,
    };
    Ok((results, next))
}

#[cfg(test)]
mod tests;
