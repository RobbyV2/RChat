//! Uploaded files stored encrypted (`crypt::media`): sealed from the first byte when the upload
//! names a place that seals, sealed when a plain file is posted in a place that seals, and opened
//! as they are downloaded.

use futures_util::StreamExt;
use sqlx::{AnyConnection, Row};

use super::{MEDIA_CHUNK, SWEEP_BATCH, s3_key};
use crate::api::access::{Proof, resolve_channel, resolve_dm};
use crate::api::seal::rotate::Outcome;
use crate::api::seal::{NEEDS_KEY, channel_place, dm_place};
use crate::api::{ApiError, MediaRef};
use crate::crypt::media::{Facts, MediaKey, ObjectReader, chunks};
use crate::db::{Db, MediaKind, User, is_sqlite};
use crate::state::AppState;

/// The refusal of an upload whose `place` is not one.
pub(crate) const BAD_PLACE: &str = "place must be c:<channel id> or d:<dm id>";
/// A stored file that does not open with the keys this site holds.
pub(crate) const UNREADABLE: &str = "This file can't be opened";

/// The answer for a stored file that does not open.
pub(crate) fn unreadable() -> ApiError {
    ApiError(
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        UNREADABLE.to_string(),
        None,
    )
}

/// The S3 object of a file stored sealed.
pub(crate) fn sealed_key(id: &str) -> String {
    format!("sealed/{id}")
}

/// Where an upload will be posted, as `?place=` names it: `c:<channel id>` or `d:<dm id>`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Place {
    Channel(i64),
    Dm(i64),
}

impl Place {
    pub(crate) fn parse(text: &str) -> Option<Place> {
        let (kind, id) = text.split_once(':')?;
        let id: i64 = id.parse().ok().filter(|id| *id > 0)?;
        match kind {
            "c" => Some(Place::Channel(id)),
            "d" => Some(Place::Dm(id)),
            _ => None,
        }
    }
}

/// The key a file posted in `place` is stored under now: `None` while the place stores plain.
/// The place resolves through the access gate for `user`; one they can't see is a 404.
pub(crate) async fn upload_key(
    db: &Db,
    user: &User,
    place: Place,
) -> Result<Option<MediaKey>, ApiError> {
    match place {
        Place::Channel(id) => resolve_channel(db, id, Some(user), &Proof::none())
            .await
            .map(|_| ())?,
        Place::Dm(id) => resolve_dm(db, id, user).await.map(|_| ())?,
    }
    place_key(db, place).await
}

/// The key a file posted in `place` is stored under now, for a caller already allowed there (an
/// incoming webhook in its own channel).
pub(crate) async fn place_key(db: &Db, place: Place) -> Result<Option<MediaKey>, ApiError> {
    let sqlite = is_sqlite(db);
    let mut conn = db.acquire().await?;
    let floors = match place {
        Place::Channel(id) => channel_place(&mut conn, sqlite, id).await?.1,
        Place::Dm(id) => dm_place(&mut conn, sqlite, id).await?,
    };
    match floors.floor() {
        Some(_) => key_on(db, &mut conn).await.map(Some),
        None => Ok(None),
    }
}

/// The stored active media key, on the caller's connection; a sealed place without one refuses
/// the write.
pub(crate) async fn key_on(db: &Db, conn: &mut AnyConnection) -> Result<MediaKey, ApiError> {
    match MediaKey::stored_on(&crate::db::ring(db), conn).await {
        Ok(Some(key)) => Ok(key),
        Ok(None) => Err(ApiError::keys(NEEDS_KEY)),
        Err(e) => Err(ApiError::internal(e)),
    }
}

/// How a plain file was found when it was to be sealed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Sealing {
    /// Its rows are sealed now.
    Sealed,
    /// It is kept in S3: it is marked for `seal_object`, which seals it once the caller's
    /// transaction is in, or the next sweep.
    InS3,
    /// It was sealed already, or is gone.
    Nothing,
}

/// The facts of the plain file `id`, as its row holds them.
fn plain_facts(row: &sqlx::any::AnyRow) -> sqlx::Result<Facts> {
    Ok(Facts {
        name: row.try_get("filename")?,
    })
}

/// Seals the plain file `id` on `conn` under `key`: its database chunks (an older copy kept
/// inline becomes chunks) and its facts. A file kept in S3 is marked for `seal_object` instead.
pub(crate) async fn seal_rows(
    conn: &mut AnyConnection,
    id: &str,
    key: &MediaKey,
) -> Result<Sealing, ApiError> {
    let row = sqlx::query("SELECT filename, size, data, (SELECT COUNT(*) FROM media_chunks c WHERE c.media_id = media.id) AS stored FROM media WHERE id = $1 AND seal_key IS NULL")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await?;
    let Some(row) = row else {
        return Ok(Sealing::Nothing);
    };
    let facts = plain_facts(&row)?;
    let (size, inline, stored): (i64, Option<Vec<u8>>, i64) =
        (row.try_get(1)?, row.try_get(2)?, row.try_get(3)?);
    let total = chunks(size as u64);
    let data = match (inline, stored) {
        (Some(data), _) => data,
        (None, 0) if size > 0 => {
            sqlx::query("UPDATE media SET plain_object = 1 WHERE id = $1")
                .bind(id)
                .execute(&mut *conn)
                .await?;
            return Ok(Sealing::InS3);
        }
        (None, _) => {
            let mut data = Vec::with_capacity(size as usize);
            let rows =
                sqlx::query("SELECT data FROM media_chunks WHERE media_id = $1 ORDER BY seq")
                    .bind(id)
                    .fetch_all(&mut *conn)
                    .await?;
            for r in &rows {
                data.extend_from_slice(&r.try_get::<Vec<u8>, _>(0)?);
            }
            data
        }
    };
    if data.len() as i64 != size {
        return Err(ApiError::internal(format!(
            "the stored file {id} has the wrong size"
        )));
    }
    sqlx::query("DELETE FROM media_chunks WHERE media_id = $1")
        .bind(id)
        .execute(&mut *conn)
        .await?;
    for (seq, chunk) in data.chunks(MEDIA_CHUNK).enumerate() {
        sqlx::query("INSERT INTO media_chunks(media_id, seq, data) VALUES($1, $2, $3)")
            .bind(id)
            .bind(seq as i64)
            .bind(key.seal_chunk(id, seq as u64, total, chunk))
            .execute(&mut *conn)
            .await?;
    }
    mark(conn, id, key, &facts).await?;
    Ok(Sealing::Sealed)
}

/// Marks the file `id` sealed under `key` with its sealed facts, and blanks its plain ones.
async fn mark(
    conn: &mut AnyConnection,
    id: &str,
    key: &MediaKey,
    facts: &Facts,
) -> Result<u64, ApiError> {
    Ok(sqlx::query("UPDATE media SET seal_key = $1, name_sealed = $2, filename = '', data = NULL WHERE id = $3 AND seal_key IS NULL")
        .bind(i64::from(key.id()))
        .bind(key.seal_facts(id, facts))
        .bind(id)
        .execute(&mut *conn)
        .await?
        .rows_affected())
}

/// Sealing of S3 objects at once in this process: each holds its object twice in memory.
static SEALING: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

/// Seals the plain S3 object of file `id`: the sealed object is written beside it, the row
/// marked, then the plain object deleted and the row's mark for it cleared. A sealed file whose
/// plain object was left (`plain_object`) only has that object deleted. Returns whether this
/// call changed something.
pub(crate) async fn seal_object(state: &AppState, id: &str) -> Result<bool, ApiError> {
    let Some(bucket) = state.s3.as_deref() else {
        return Ok(false);
    };
    let _permit = SEALING.acquire().await.map_err(ApiError::internal)?;
    let db = &state.db;
    let row = sqlx::query("SELECT filename, size, seal_key, plain_object FROM media WHERE id = $1 AND data IS NULL AND NOT EXISTS (SELECT 1 FROM media_chunks c WHERE c.media_id = media.id)")
        .bind(id)
        .fetch_optional(db)
        .await?;
    let Some(row) = row else {
        return Ok(false);
    };
    let facts = plain_facts(&row)?;
    let (size, sealed, left): (i64, Option<i64>, Option<i64>) =
        (row.try_get(1)?, row.try_get(2)?, row.try_get(3)?);
    if sealed.is_some() {
        return match left {
            Some(_) => plain_gone(state, id).await.map(|_| true),
            None => Ok(false),
        };
    }
    let key = key_on(db, &mut *db.acquire().await?).await?;
    let data = match size {
        0 => Vec::new(),
        _ => bucket
            .get_object(s3_key(id))
            .await
            .map_err(ApiError::internal)?
            .to_vec(),
    };
    if data.len() as i64 != size {
        return Err(ApiError::internal(format!(
            "the stored file {id} has the wrong size"
        )));
    }
    bucket
        .put_object_with_content_type(
            sealed_key(id),
            &key.seal_object(id, &data),
            super::NEUTRAL_MIME,
        )
        .await
        .map_err(ApiError::internal)?;
    drop(data);
    let marked = {
        let mut conn = db.acquire().await?;
        sqlx::query("UPDATE media SET plain_object = 1 WHERE id = $1")
            .bind(id)
            .execute(&mut *conn)
            .await?;
        mark(&mut conn, id, &key, &facts).await?
    };
    if marked == 1 {
        plain_gone(state, id).await?;
        return Ok(true);
    }
    let gone = sqlx::query("SELECT 1 FROM media WHERE id = $1")
        .bind(id)
        .fetch_optional(db)
        .await?
        .is_none();
    if gone && let Err(e) = bucket.delete_object(sealed_key(id)).await {
        tracing::warn!("s3 delete failed for {}: {e}", sealed_key(id));
    }
    Ok(false)
}

/// Deletes the plain S3 object of the sealed file `id` and clears its mark; a failed delete
/// keeps the mark for the next sweep.
async fn plain_gone(state: &AppState, id: &str) -> Result<(), ApiError> {
    let Some(bucket) = state.s3.as_deref() else {
        return Ok(());
    };
    bucket
        .delete_object(s3_key(id))
        .await
        .map_err(ApiError::internal)?;
    sqlx::query("UPDATE media SET plain_object = NULL WHERE id = $1 AND seal_key IS NOT NULL")
        .bind(id)
        .execute(&state.db)
        .await?;
    Ok(())
}

/// The facts of a stored file: its plain ones, or its sealed record opened. A record that does
/// not open is the 500 `This file can't be opened`.
pub(crate) async fn facts_on(
    db: &Db,
    conn: &mut AnyConnection,
    id: &str,
    plain: String,
    seal_key: Option<i64>,
    record: Option<&[u8]>,
) -> Result<Facts, ApiError> {
    let Some(key_id) = seal_key else {
        return Ok(Facts { name: plain });
    };
    let key = MediaKey::named_on(&crate::db::ring(db), conn, key_id as u32)
        .await
        .map_err(ApiError::internal)?;
    key.zip(record)
        .and_then(|(key, record)| key.open_facts(id, record))
        .ok_or_else(unreadable)
}

/// Seals the plain server file a message carries, on its transaction, when the place it is
/// posted in seals (`seals`). A file kept in S3 is named in the answer: `seal_later` seals it
/// once the transaction is in.
pub(crate) async fn at_send(
    db: &Db,
    conn: &mut AnyConnection,
    media: Option<&MediaRef>,
    seals: bool,
) -> Result<Option<String>, ApiError> {
    let Some(media) = media.filter(|m| seals && m.kind == MediaKind::Server) else {
        return Ok(None);
    };
    seal_file_on(db, conn, &media.id).await
}

/// `at_send` for a file known by its id, on the caller's transaction.
pub(crate) async fn seal_file_on(
    db: &Db,
    conn: &mut AnyConnection,
    id: &str,
) -> Result<Option<String>, ApiError> {
    let key = key_on(db, conn).await?;
    Ok(match seal_rows(conn, id, &key).await? {
        Sealing::InS3 => Some(id.to_string()),
        Sealing::Sealed | Sealing::Nothing => None,
    })
}

/// Files kept in S3 marked for sealing or for the deletion of a plain object they left (a
/// background sealing that did not finish, a delete that failed), a batch per run.
pub(crate) async fn sweep(state: &AppState) -> Result<usize, ApiError> {
    if state.s3.is_none() {
        return Ok(0);
    }
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM media WHERE plain_object IS NOT NULL ORDER BY plain_object, id LIMIT $1",
    )
    .bind(SWEEP_BATCH)
    .fetch_all(&state.db)
    .await?;
    let mut done = 0;
    for id in &ids {
        match seal_object(state, id).await {
            Ok(changed) => done += usize::from(changed),
            Err(ApiError(_, e, _)) => tracing::warn!("the file {id} could not be encrypted: {e}"),
        }
    }
    Ok(done)
}

/// Seals the plain file `id` now: its rows in a transaction of their own, or its S3 object.
pub(crate) async fn seal_now(state: &AppState, id: &str) -> Result<bool, ApiError> {
    let db = &state.db;
    let mut tx = match is_sqlite(db) {
        true => db.begin_with("BEGIN IMMEDIATE").await?,
        false => db.begin().await?,
    };
    let key = key_on(db, &mut tx).await?;
    let done = seal_rows(&mut tx, id, &key).await?;
    tx.commit().await?;
    match done {
        Sealing::Sealed => Ok(true),
        Sealing::InS3 => seal_object(state, id).await,
        Sealing::Nothing => Ok(false),
    }
}

/// Seals the file `id` again under the active `media` key when a key of `retiring` sealed it:
/// its database chunks and name, or its S3 object written over. The object names its key, so a
/// stop between writing it and marking the row is mended the next time; an object written for a
/// file deleted or stored plain meanwhile is removed. `None` when the file is not under a
/// retiring key.
pub(crate) async fn reseal_now(
    state: &AppState,
    id: &str,
    retiring: &[u32],
) -> Result<Option<Outcome>, ApiError> {
    let db = &state.db;
    let row = sqlx::query("SELECT size, seal_key, name_sealed, (SELECT COUNT(*) FROM media_chunks c WHERE c.media_id = media.id) FROM media WHERE id = $1 AND seal_key IS NOT NULL")
        .bind(id)
        .fetch_optional(db)
        .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let (size, key_id): (i64, i64) = (row.try_get(0)?, row.try_get(1)?);
    let (record, stored): (Option<Vec<u8>>, i64) = (row.try_get(2)?, row.try_get(3)?);
    let Ok(key_id) = u32::try_from(key_id) else {
        return Ok(Some(Outcome::Lost));
    };
    if !retiring.contains(&key_id) {
        return Ok(None);
    }
    let Some(old) = MediaKey::named(db, key_id)
        .await
        .map_err(ApiError::internal)?
    else {
        return Ok(Some(Outcome::Lost));
    };
    let Some(facts) = record.as_deref().and_then(|r| old.open_facts(id, r)) else {
        return Ok(Some(Outcome::Lost));
    };
    let fresh = {
        let ring = crate::db::ring(db);
        let mut conn = db.acquire().await?;
        MediaKey::stored_on(&ring, &mut conn)
            .await
            .map_err(ApiError::internal)?
    };
    let Some(fresh) = fresh.filter(|k| !retiring.contains(&k.id())) else {
        return Ok(Some(Outcome::Left));
    };
    let total = chunks(size as u64);
    let in_s3 = stored == 0 && size > 0;
    let _permit = SEALING.acquire().await.map_err(ApiError::internal)?;
    let resealed = match (in_s3, state.s3.as_deref()) {
        (true, None) => return Ok(Some(Outcome::Left)),
        (true, Some(bucket)) => {
            let object = bucket
                .get_object(sealed_key(id))
                .await
                .map_err(ApiError::internal)?
                .to_vec();
            let named = crate::crypt::media::object_header(&object)
                .map_err(ApiError::internal)?
                .0;
            if named != fresh.id() {
                let mut reader = ObjectReader::new(id, size as u64, old.clone());
                let Ok(parts) = reader.feed(&object) else {
                    return Ok(Some(Outcome::Lost));
                };
                if !reader.finished() {
                    return Ok(Some(Outcome::Lost));
                }
                drop(object);
                let data = parts.concat();
                bucket
                    .put_object_with_content_type(
                        sealed_key(id),
                        &fresh.seal_object(id, &data),
                        super::NEUTRAL_MIME,
                    )
                    .await
                    .map_err(ApiError::internal)?;
            }
            Vec::new()
        }
        (false, _) => {
            let rows: Vec<Vec<u8>> = sqlx::query_scalar(
                "SELECT data FROM media_chunks WHERE media_id = $1 ORDER BY seq",
            )
            .bind(id)
            .fetch_all(db)
            .await?;
            let mut sealed = Vec::with_capacity(rows.len());
            for (seq, record) in rows.iter().enumerate() {
                match old.open_chunk(id, seq as u64, total, record) {
                    Ok(plain) => sealed.push(fresh.seal_chunk(id, seq as u64, total, &plain)),
                    Err(_) => return Ok(Some(Outcome::Lost)),
                }
            }
            sealed
        }
    };
    let mut tx = match is_sqlite(db) {
        true => db.begin_with("BEGIN IMMEDIATE").await?,
        false => db.begin().await?,
    };
    let marked = sqlx::query(
        "UPDATE media SET seal_key = $1, name_sealed = $2 WHERE id = $3 AND seal_key = $4",
    )
    .bind(i64::from(fresh.id()))
    .bind(fresh.seal_facts(id, &facts))
    .bind(id)
    .bind(i64::from(key_id))
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if marked == 1 {
        for (seq, chunk) in resealed.iter().enumerate() {
            sqlx::query("UPDATE media_chunks SET data = $1 WHERE media_id = $2 AND seq = $3")
                .bind(chunk)
                .bind(id)
                .bind(seq as i64)
                .execute(&mut *tx)
                .await?;
        }
    }
    tx.commit().await?;
    if marked == 0 && in_s3 {
        let now: Option<Option<i64>> =
            sqlx::query_scalar("SELECT seal_key FROM media WHERE id = $1")
                .bind(id)
                .fetch_optional(db)
                .await?;
        if matches!(now, None | Some(None))
            && let Some(bucket) = state.s3.as_deref()
            && let Err(e) = bucket.delete_object(sealed_key(id)).await
        {
            tracing::warn!("s3 delete failed for {}: {e}", sealed_key(id));
        }
    }
    Ok(Some(Outcome::Moved))
}

/// Stores the sealed file `id` plain again: its database chunks opened and written back, or a
/// plain S3 object written before the sealed one goes. A file that does not open stays as it
/// is. Returns whether this call wrote it.
pub(crate) async fn unseal_now(state: &AppState, id: &str) -> Result<bool, ApiError> {
    let db = &state.db;
    let row = sqlx::query("SELECT mime, size, seal_key, name_sealed, (SELECT COUNT(*) FROM media_chunks c WHERE c.media_id = media.id) FROM media WHERE id = $1 AND seal_key IS NOT NULL")
        .bind(id)
        .fetch_optional(db)
        .await?;
    let Some(row) = row else {
        return Ok(false);
    };
    let (mime, size, key_id): (String, i64, i64) =
        (row.try_get(0)?, row.try_get(1)?, row.try_get(2)?);
    let (record, stored): (Option<Vec<u8>>, i64) = (row.try_get(3)?, row.try_get(4)?);
    let key = MediaKey::named(db, key_id as u32)
        .await
        .map_err(ApiError::internal)?;
    let Some((key, facts)) = key.and_then(|key| {
        let facts = key.open_facts(id, record.as_deref()?)?;
        Some((key, facts))
    }) else {
        tracing::warn!("the stored file {id} can't be opened");
        return Ok(false);
    };
    let total = chunks(size as u64);
    let in_s3 = stored == 0 && size > 0;
    let data = match (in_s3, state.s3.as_deref()) {
        (false, _) => {
            let rows: Vec<Vec<u8>> = sqlx::query_scalar(
                "SELECT data FROM media_chunks WHERE media_id = $1 ORDER BY seq",
            )
            .bind(id)
            .fetch_all(db)
            .await?;
            let mut data = Vec::with_capacity(size as usize);
            for (seq, record) in rows.iter().enumerate() {
                match key.open_chunk(id, seq as u64, total, record) {
                    Ok(plain) => data.extend_from_slice(&plain),
                    Err(_) => return Ok(false),
                }
            }
            data
        }
        (true, Some(bucket)) => {
            let object = bucket
                .get_object(sealed_key(id))
                .await
                .map_err(ApiError::internal)?;
            let mut reader = ObjectReader::new(id, size as u64, key.clone());
            let Ok(parts) = reader.feed(&object.to_vec()) else {
                return Ok(false);
            };
            if !reader.finished() {
                return Ok(false);
            }
            parts.concat()
        }
        (true, None) => return Ok(false),
    };
    if data.len() as i64 != size {
        return Ok(false);
    }
    if let (true, Some(bucket)) = (in_s3, state.s3.as_deref()) {
        bucket
            .put_object_with_content_type(s3_key(id), &data, &mime)
            .await
            .map_err(ApiError::internal)?;
    }
    let mut tx = match is_sqlite(db) {
        true => db.begin_with("BEGIN IMMEDIATE").await?,
        false => db.begin().await?,
    };
    let marked = sqlx::query("UPDATE media SET filename = $1, seal_key = NULL, name_sealed = NULL, plain_object = NULL WHERE id = $2 AND seal_key = $3")
        .bind(&facts.name)
        .bind(id)
        .bind(key_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if marked == 1 && !in_s3 {
        sqlx::query("DELETE FROM media_chunks WHERE media_id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        for (seq, chunk) in data.chunks(MEDIA_CHUNK).enumerate() {
            sqlx::query("INSERT INTO media_chunks(media_id, seq, data) VALUES($1, $2, $3)")
                .bind(id)
                .bind(seq as i64)
                .bind(chunk.to_vec())
                .execute(&mut *tx)
                .await?;
        }
    }
    tx.commit().await?;
    if marked == 1
        && let Some(bucket) = state.s3.as_deref()
        && let Err(e) = bucket.delete_object(sealed_key(id)).await
    {
        tracing::warn!("s3 delete failed for {}: {e}", sealed_key(id));
    }
    Ok(marked == 1)
}

/// Seals `id` in S3 after the caller's transaction, in the background; the mark `seal_rows`
/// left keeps it for the sweep when this does not finish.
pub(crate) fn seal_later(state: &AppState, id: String) {
    let state = state.clone();
    tokio::spawn(async move {
        if let Err(ApiError(_, e, _)) = seal_object(&state, &id).await {
            tracing::warn!("the file {id} could not be encrypted: {e}");
        }
    });
}

/// The plain bytes of the sealed file `id`, kept as database chunks, chunk by chunk from the
/// chunk `first` on.
pub(crate) fn chunk_stream(
    db: Db,
    id: String,
    size: u64,
    key: MediaKey,
    first: u64,
) -> impl futures_util::Stream<Item = Result<Vec<u8>, std::io::Error>> {
    let total = chunks(size);
    futures_util::stream::unfold(first, move |seq| {
        let (db, id, key) = (db.clone(), id.clone(), key.clone());
        async move {
            if seq >= total {
                return None;
            }
            let row = sqlx::query("SELECT data FROM media_chunks WHERE media_id = $1 AND seq = $2")
                .bind(&id)
                .bind(seq as i64)
                .fetch_optional(&db)
                .await;
            let record = row
                .ok()
                .flatten()
                .and_then(|r| r.try_get::<Vec<u8>, _>(0).ok());
            let opened = record
                .ok_or_else(|| std::io::Error::other("media removed while streaming"))
                .and_then(|record| {
                    key.open_chunk(&id, seq, total, &record)
                        .map_err(|_| std::io::Error::other("a stored chunk can't be opened"))
                });
            match opened {
                Ok(bytes) => Some((Ok(bytes), seq + 1)),
                Err(e) => Some((Err(e), total)),
            }
        }
    })
}

/// The plain bytes of a sealed S3 object as they arrive, under the key the object names (the
/// row's key, or the one a key rotation wrote it under before marking the row).
pub(crate) fn object_stream<S, E>(
    bytes: S,
    db: Db,
    id: String,
    size: u64,
    key: MediaKey,
) -> impl futures_util::Stream<Item = Result<Vec<u8>, std::io::Error>>
where
    S: futures_util::Stream<Item = Result<axum::body::Bytes, E>> + Unpin,
    E: std::fmt::Display,
{
    struct Read<S> {
        bytes: S,
        db: Db,
        id: String,
        size: u64,
        key: Option<MediaKey>,
        reader: Option<ObjectReader>,
        head: Vec<u8>,
        ready: std::collections::VecDeque<Vec<u8>>,
        ended: bool,
    }
    let fail = |what: &str| std::io::Error::other(what.to_owned());
    let start = Read {
        bytes,
        db,
        id,
        size,
        key: Some(key),
        reader: None,
        head: Vec::new(),
        ready: std::collections::VecDeque::new(),
        ended: false,
    };
    futures_util::stream::unfold(start, move |mut r| async move {
        loop {
            if let Some(chunk) = r.ready.pop_front() {
                return Some((Ok(chunk), r));
            }
            if r.ended {
                return None;
            }
            let part = match r.bytes.next().await {
                Some(Ok(part)) => part.to_vec(),
                Some(Err(e)) => {
                    r.ended = true;
                    return Some((Err(std::io::Error::other(e.to_string())), r));
                }
                None if r.reader.as_ref().is_some_and(ObjectReader::finished) => return None,
                None => {
                    r.ended = true;
                    return Some((Err(fail("a stored object ended early")), r));
                }
            };
            let part = match r.reader.is_some() {
                true => part,
                false => {
                    r.head.extend_from_slice(&part);
                    let Ok((named, _)) = crate::crypt::media::object_header(&r.head) else {
                        continue;
                    };
                    let key = match r.key.take() {
                        Some(key) if key.id() == named => Some(key),
                        Some(_) | None => MediaKey::named(&r.db, named).await.ok().flatten(),
                    };
                    let Some(key) = key else {
                        r.ended = true;
                        return Some((Err(fail("a stored object can't be opened")), r));
                    };
                    r.reader = Some(ObjectReader::new(&r.id, r.size, key));
                    std::mem::take(&mut r.head)
                }
            };
            let Some(reader) = r.reader.as_mut() else {
                continue;
            };
            match reader.feed(&part) {
                Ok(done) => r.ready.extend(done),
                Err(_) => {
                    r.ended = true;
                    return Some((Err(fail("a stored object can't be opened")), r));
                }
            }
        }
    })
}

#[cfg(test)]
mod tests;
