pub(super) mod postgres;

use std::collections::BTreeSet;
use std::time::{Duration, Instant};

use sqlx::Row;

use super::pool::{Db, is_sqlite};
use super::schema::has_fts;

const NEXT: &str = "messages_fts_channel_next";
const DONE: &str = "messages_fts_channel_done";
const INLINE_BYTES: i64 = 128;
const BUILD_BATCH: i64 = 128;
const MERGE_TERMS: usize = 512;
const SHORT_SPAN: usize = 4;

/// A literal containing a longer run between spaces cannot occur in an ASCII body
/// made entirely of short runs. Unicode bodies use the native tokenizer.
pub(crate) fn has_long_span(text: &str) -> bool {
    text.split(' ').any(|span| span.len() > SHORT_SPAN)
}

/// Four ASCII characters distinguish a signature bucket from every three-character term.
pub(crate) fn term_bucket(term: &str) -> String {
    let hash = term.bytes().fold(2166136261u32, |h, b| {
        (h ^ u32::from(b)).wrapping_mul(16777619)
    });
    format!("#{:03x}", hash as usize % MERGE_TERMS)
}

pub async fn has_channel_index(db: &Db) -> sqlx::Result<bool> {
    let mut conn = db.acquire().await?;
    if stored_next(&mut conn).await? != Some(0) {
        return Ok(false);
    }
    Ok(is_sqlite(db)
        || super::indexes::index_valid(&mut conn, "idx_messages_channel_text").await? == Some(true))
}

fn documents(predicate: &str) -> String {
    format!(
        "INSERT INTO search_documents(id, readable_at, sent_at)
        SELECT m.id, min(m.created_at, COALESCE(root.created_at, m.created_at)), m.created_at
        FROM messages m LEFT JOIN messages root ON root.id = m.thread_root_id
        WHERE {predicate} AND m.channel_id IS NOT NULL AND m.kind IN ('user', 'poll')
        ORDER BY m.id"
    )
}

// Short ASCII input has the same folds in SQLite lower() and the trigram tokenizer.
// Other documents, and encrypted ones, have a searchable catch-all posting until their terms
// are merged.
fn write_terms() -> String {
    let long_span = "[^ ]".repeat(SHORT_SPAN + 1);
    format!("
        INSERT INTO search_postings(stream, term, id)
            SELECT d.stream, (CASE WHEN new.content GLOB '*{long_span}*' THEN '' ELSE '~' END) || grams.term, d.id FROM search_documents d
            JOIN (SELECT DISTINCT lower(substr(new.content, p.i, 3)) AS term FROM search_positions p
                  WHERE octet_length(new.content) <= {INLINE_BYTES} AND octet_length(new.content) = length(new.content)
                  AND p.i <= length(new.content)-2) grams WHERE d.id = new.id;
        INSERT INTO search_postings(stream, term, id)
            SELECT stream, '', id FROM search_documents WHERE id = new.id AND
            (octet_length(new.content) > {INLINE_BYTES} OR octet_length(new.content) <> length(new.content)
             OR EXISTS(SELECT 1 FROM messages WHERE id = new.id AND body IS NOT NULL));
        INSERT INTO search_merge(id) SELECT id FROM search_postings WHERE id = new.id AND term = '';")
}

/// SQL for whether the index holds message `id`: every id above the build's top, and the ids
/// the build has reached from the bottom.
fn held(id: &str) -> String {
    format!(
        "({id} > (SELECT CAST(value AS INTEGER) FROM settings WHERE key = '{NEXT}')
          OR {id} <= (SELECT CAST(value AS INTEGER) FROM settings WHERE key = '{DONE}'))"
    )
}

fn triggers() -> Vec<String> {
    let next = format!("(SELECT CAST(value AS INTEGER) FROM settings WHERE key = '{NEXT}')");
    let row = "SELECT stream FROM search_documents WHERE id = new.id";

    let layout = "old.channel_id IS NOT new.channel_id OR old.kind <> new.kind
        OR old.thread_root_id IS NOT new.thread_root_id OR old.created_at <> new.created_at";
    let replies = format!(
        "m.thread_root_id = new.id AND old.created_at <> new.created_at AND {}",
        held("m.id")
    );
    // A stream is one channel's run of messages whose ids, sent dates and readable dates all
    // grow together, so a seek by date is an exact id floor. A message joins the stream that
    // ends closest below it and never one that ends later. The streams holding the messages a
    // member may read are then the same whatever older messages the channel holds. During the
    // build, messages above its top and the ones it reaches keep to their own streams.
    vec![
        format!("CREATE TRIGGER IF NOT EXISTS search_documents_insert AFTER INSERT ON search_documents BEGIN
            UPDATE search_documents SET stream =
                (SELECT s.id FROM messages m JOIN search_streams s ON s.channel_id = m.channel_id
                 WHERE m.id = new.id AND s.last_at <= new.readable_at AND s.last_sent <= new.sent_at AND s.last_id < new.id
                 AND (new.id <= {next} OR s.last_id > {next})
                 ORDER BY s.last_at DESC, s.last_id DESC LIMIT 1)
            WHERE id = new.id;
            INSERT INTO search_streams(channel_id, first_id, first_at, first_sent, last_id, last_at, last_sent)
                SELECT channel_id, new.id, new.readable_at, new.sent_at, new.id, new.readable_at, new.sent_at
                FROM messages WHERE id = new.id AND ({row}) IS NULL;
            UPDATE search_documents SET stream = last_insert_rowid() WHERE id = new.id AND stream IS NULL;
            UPDATE search_streams SET last_id = new.id, last_at = new.readable_at, last_sent = new.sent_at
                WHERE id = ({row}) AND last_id < new.id;
            INSERT INTO search_input(id, content) SELECT id, content FROM messages WHERE id = new.id;
            END"),
        format!("CREATE TRIGGER IF NOT EXISTS search_input_terms INSTEAD OF INSERT ON search_input
            BEGIN {} END", write_terms()),
        "CREATE TRIGGER IF NOT EXISTS search_documents_delete AFTER DELETE ON search_documents BEGIN
            DELETE FROM search_postings WHERE id = old.id;
            DELETE FROM search_merge WHERE id = old.id;
            DELETE FROM search_streams WHERE id = old.stream AND NOT EXISTS(SELECT 1 FROM search_documents WHERE stream = old.stream);
            UPDATE search_streams SET (first_id, first_at, first_sent) = (SELECT id, readable_at, sent_at FROM search_documents WHERE stream = old.stream ORDER BY readable_at, id LIMIT 1)
                WHERE id = old.stream AND first_id = old.id;
            UPDATE search_streams SET (last_id, last_at, last_sent) = (SELECT id, readable_at, sent_at FROM search_documents WHERE stream = old.stream ORDER BY readable_at DESC, id DESC LIMIT 1)
                WHERE id = old.stream AND last_id = old.id;
            END".to_owned(),
        format!("CREATE TRIGGER IF NOT EXISTS search_message_insert AFTER INSERT ON messages WHEN {}
            BEGIN {}; END", held("new.id"), documents("m.id = new.id")),
        format!("CREATE TRIGGER IF NOT EXISTS search_root_insert AFTER INSERT ON messages
            WHEN EXISTS(SELECT 1 FROM messages WHERE thread_root_id=new.id AND id<>new.id AND created_at>new.created_at)
            BEGIN
            DELETE FROM search_documents WHERE id IN
                (SELECT id FROM messages WHERE thread_root_id=new.id AND id<>new.id AND created_at>new.created_at);
            {}; END", documents(&format!("m.thread_root_id=new.id AND m.id<>new.id AND m.created_at>new.created_at AND {}", held("m.id")))),
        "CREATE TRIGGER IF NOT EXISTS search_message_delete AFTER DELETE ON messages
            BEGIN DELETE FROM search_documents WHERE id = old.id; END".to_owned(),
        format!("CREATE TRIGGER IF NOT EXISTS search_message_edit AFTER UPDATE OF content ON messages
            WHEN old.content <> new.content AND NOT ({layout}) BEGIN
            DELETE FROM search_postings WHERE id = new.id; DELETE FROM search_merge WHERE id = new.id;
            INSERT INTO search_input(id, content) VALUES(new.id, new.content); END"),
        format!("CREATE TRIGGER IF NOT EXISTS search_message_seal AFTER UPDATE OF body ON messages
            WHEN old.body IS NOT new.body AND NOT ({layout}) BEGIN
            DELETE FROM search_postings WHERE id = new.id; DELETE FROM search_merge WHERE id = new.id;
            INSERT INTO search_input(id, content) VALUES(new.id, new.content); END"),
        format!("CREATE TRIGGER IF NOT EXISTS search_message_update AFTER UPDATE OF channel_id, kind, created_at, thread_root_id ON messages
            WHEN {layout} BEGIN
            DELETE FROM search_documents WHERE id = new.id;
            {};
            DELETE FROM search_documents WHERE old.created_at <> new.created_at AND id IN
                (SELECT m.id FROM messages m WHERE m.thread_root_id = new.id);
            {}; END", documents(&format!("m.id = new.id AND {}", held("new.id"))), documents(&replies)),
    ]
}

async fn stored(conn: &mut sqlx::AnyConnection, key: &str) -> sqlx::Result<Option<i64>> {
    sqlx::query("SELECT CAST(value AS BIGINT) FROM settings WHERE key = $1")
        .bind(key)
        .fetch_optional(&mut *conn)
        .await?
        .map(|r| r.try_get(0))
        .transpose()
}

async fn store(conn: &mut sqlx::AnyConnection, key: &str, value: i64) -> sqlx::Result<()> {
    sqlx::query("INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(key)
        .bind(value.to_string())
        .execute(&mut *conn)
        .await
        .map(|_| ())
}

async fn stored_next(conn: &mut sqlx::AnyConnection) -> sqlx::Result<Option<i64>> {
    stored(conn, NEXT).await
}

async fn store_next(conn: &mut sqlx::AnyConnection, next: i64) -> sqlx::Result<()> {
    store(conn, NEXT, next).await
}

/// The `settings` key of how the last start indexed encrypted messages: `keyed` or `scan`.
const SEALED_MODE: &str = "search_sealed";
/// A term trigger that leaves encrypted messages out of the index; a database that has it gets
/// `search_input_terms` in its place.
const UNSEALED_TERMS: &str = "search_input_insert";

/// Puts every encrypted message the index holds back on its catch-all posting, to be merged
/// again: where the index left them out, or gave them no keyed terms.
async fn requeue_sealed(conn: &mut sqlx::AnyConnection) -> sqlx::Result<()> {
    let sealed = "FROM messages m JOIN search_documents d ON d.id = m.id WHERE m.body IS NOT NULL AND m.grams IS NULL AND m.channel_id IS NOT NULL";
    for sql in [
        format!(
            "INSERT OR IGNORE INTO search_postings(stream, term, id) SELECT d.stream, '', d.id {sealed}"
        ),
        format!("INSERT OR IGNORE INTO search_merge(id) SELECT d.id {sealed}"),
    ] {
        sqlx::query(sqlx::AssertSqlSafe(sql))
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

/// Creates the channel index and its triggers where the database lacks them, in one short write.
/// The messages that exist then wait for `build_step`; searches read the index once it holds
/// them all.
pub(super) async fn create(pool: &Db) -> anyhow::Result<()> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let position = stored_next(&mut tx).await?;
    let unsealed: Option<String> =
        sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = $1")
            .bind(UNSEALED_TERMS)
            .fetch_optional(&mut *tx)
            .await?;
    if unsealed.is_some() {
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "DROP TRIGGER {UNSEALED_TERMS}"
        )))
        .execute(&mut *tx)
        .await?;
    }
    for ddl in [
        "CREATE VIEW IF NOT EXISTS search_input AS SELECT id, content FROM messages",
        "CREATE TABLE IF NOT EXISTS search_postings(stream INTEGER NOT NULL, term TEXT NOT NULL, id INTEGER NOT NULL, PRIMARY KEY(stream, term, id)) WITHOUT ROWID",
        "CREATE INDEX IF NOT EXISTS search_postings_message ON search_postings(id)",
        "CREATE TABLE IF NOT EXISTS search_merge(id INTEGER PRIMARY KEY)",
        "CREATE TABLE IF NOT EXISTS search_positions(i INTEGER PRIMARY KEY)",
        "CREATE TABLE IF NOT EXISTS search_streams(id INTEGER PRIMARY KEY, channel_id INTEGER NOT NULL, first_id INTEGER NOT NULL, first_at INTEGER NOT NULL, first_sent INTEGER NOT NULL, last_id INTEGER NOT NULL, last_at INTEGER NOT NULL, last_sent INTEGER NOT NULL)",
        "CREATE INDEX IF NOT EXISTS search_streams_since ON search_streams(channel_id, last_at, last_id)",
        "CREATE TABLE IF NOT EXISTS search_documents(id INTEGER PRIMARY KEY, readable_at INTEGER NOT NULL, sent_at INTEGER NOT NULL, stream INTEGER)",
        "CREATE INDEX IF NOT EXISTS search_documents_date ON search_documents(stream, readable_at, id)",
        "CREATE INDEX IF NOT EXISTS search_documents_sent ON search_documents(stream, sent_at, id)",
        "CREATE INDEX IF NOT EXISTS search_documents_stream ON search_documents(stream, id, readable_at)",
    ] {
        sqlx::query(ddl).execute(&mut *tx).await?;
    }
    sqlx::query("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < $1) INSERT OR IGNORE INTO search_positions(i) SELECT i FROM n")
        .bind(INLINE_BYTES)
        .execute(&mut *tx)
        .await?;
    if position.is_none() {
        let waiting: Option<i64> = sqlx::query("SELECT MAX(id) FROM messages")
            .fetch_one(&mut *tx)
            .await?
            .try_get(0)?;
        let (next, done) = match waiting {
            Some(top) => (top.max(0), i64::MIN),
            None => (0, i64::MAX),
        };
        store_next(&mut tx, next).await?;
        store(&mut tx, DONE, done).await?;
    }
    for stmt in triggers() {
        sqlx::query(sqlx::AssertSqlSafe(stmt))
            .execute(&mut *tx)
            .await?;
    }
    let mode = match super::ring(pool).scans() {
        true => "scan",
        false => "keyed",
    };
    let last: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = $1")
        .bind(SEALED_MODE)
        .fetch_optional(&mut *tx)
        .await?;
    if unsealed.is_some() || (mode == "keyed" && last.as_deref() == Some("scan")) {
        requeue_sealed(&mut tx).await?;
    }
    if last.as_deref() != Some(mode) {
        sqlx::query("INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
            .bind(SEALED_MODE)
            .bind(mode)
            .execute(&mut *tx)
            .await?;
    }
    let next = stored_next(&mut tx).await?.unwrap_or(0);
    tx.commit().await?;
    if position.is_none() {
        match next {
            0 => tracing::info!("created the channel search index"),
            next => tracing::info!(
                "created the channel search index; messages up to id {next} are indexed in the background"
            ),
        }
    }
    Ok(())
}

/// Indexes up to `batch` of the messages the index does not hold yet, oldest first, in one short
/// write. `true` once the index holds every message.
pub(crate) async fn build_step(db: &Db, batch: i64) -> anyhow::Result<bool> {
    let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
    let Some(next) = stored_next(&mut tx).await? else {
        anyhow::bail!("the database has no channel search index");
    };
    if next <= 0 {
        tx.commit().await?;
        return Ok(true);
    }
    let done = stored(&mut tx, DONE).await?.unwrap_or(i64::MIN);
    // Bound both the rows and the amount of text marked while the writer is held.
    let sizes = sqlx::query(
        "SELECT id, octet_length(content) FROM messages WHERE id > $1 AND id <= $2 ORDER BY id LIMIT $3",
    )
    .bind(done)
    .bind(next)
    .bind(batch.max(1).saturating_add(1))
    .fetch_all(&mut *tx)
    .await?;
    let mut bytes = 0i64;
    let mut high = None;
    let mut left = false;
    for row in sizes.iter().take(batch.max(1) as usize) {
        high = Some(row.try_get::<i64, _>(0)?);
        bytes += row.try_get::<i64, _>(1)?;
        if bytes >= 64 * 1024 {
            break;
        }
    }
    if let Some(high) = high {
        left = sizes
            .last()
            .map(|row| row.try_get::<i64, _>(0))
            .transpose()?
            .is_some_and(|last| last > high);
        sqlx::query(sqlx::AssertSqlSafe(documents("m.id > $1 AND m.id <= $2")))
            .bind(done)
            .bind(high)
            .execute(&mut *tx)
            .await?;
        store(&mut tx, DONE, if left { high } else { i64::MAX }).await?;
    } else {
        store(&mut tx, DONE, i64::MAX).await?;
    }
    if !left {
        store_next(&mut tx, 0).await?;
    }
    tx.commit().await?;
    Ok(!left)
}

/// The private tokenizer uses the database engine's Unicode folds, including its
/// treatment of stored NULs. It never reads the instance's global postings.
pub(crate) struct Tokenizer(sqlx::SqliteConnection);

impl Tokenizer {
    pub(crate) async fn open() -> sqlx::Result<Self> {
        use sqlx::Connection;
        let mut conn = sqlx::SqliteConnection::connect("sqlite::memory:").await?;
        sqlx::query("CREATE VIRTUAL TABLE sample USING fts5(body, tokenize='trigram', content='')")
            .execute(&mut conn)
            .await?;
        sqlx::query("CREATE VIRTUAL TABLE terms USING fts5vocab(sample, 'row')")
            .execute(&mut conn)
            .await?;
        Ok(Self(conn))
    }

    async fn load(&mut self, body: &str) -> sqlx::Result<()> {
        sqlx::query("INSERT INTO sample(sample) VALUES('delete-all')")
            .execute(&mut self.0)
            .await?;
        sqlx::query("INSERT INTO sample(rowid,body) VALUES(1,$1)")
            .bind(body)
            .execute(&mut self.0)
            .await?;
        Ok(())
    }

    pub(crate) async fn terms(&mut self, body: &str) -> sqlx::Result<Vec<String>> {
        self.load(body).await?;
        sqlx::query_scalar("SELECT term FROM terms")
            .fetch_all(&mut self.0)
            .await
    }

    pub(crate) async fn matches(&mut self, body: &str, phrase: &str) -> sqlx::Result<bool> {
        self.load(body).await?;
        Ok(sqlx::query("SELECT 1 FROM sample WHERE sample MATCH $1")
            .bind(phrase)
            .fetch_optional(&mut self.0)
            .await?
            .is_some())
    }
}

async fn merge_document(
    db: &Db,
    tokenizer: &mut Tokenizer,
    id: i64,
    body: &str,
) -> anyhow::Result<()> {
    let mut terms = tokenizer.terms(body).await?;
    if terms.len() > MERGE_TERMS {
        terms = terms
            .iter()
            .map(|term| term_bucket(term))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
    }
    if body.is_ascii() && !body.as_bytes().contains(&0) && !has_long_span(body) {
        for term in &mut terms {
            term.insert(0, '~');
        }
    }
    let terms = serde_json::to_string(&terms)?;
    let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
    // Recheck both the pending entry and the source after doing the text work without a writer.
    let stream: Option<i64> = sqlx::query_scalar("SELECT d.stream FROM search_merge q JOIN search_documents d ON d.id=q.id JOIN messages m ON m.id=q.id WHERE q.id=$1 AND m.content=$2")
        .bind(id).bind(body).fetch_optional(&mut *tx).await?;
    if let Some(stream) = stream {
        sqlx::query("DELETE FROM search_postings WHERE stream=$1 AND term='' AND id=$2")
            .bind(stream)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "INSERT INTO search_postings(stream,term,id) SELECT $1,value,$2 FROM json_each($3)",
        )
        .bind(stream)
        .bind(id)
        .bind(terms)
        .execute(&mut *tx)
        .await?;
        sqlx::query("DELETE FROM search_merge WHERE id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// The keyed terms of the encrypted message `id` in `channel`: `None` while it has to stay on its
/// catch-all posting, with no search key (`SEARCH_SEALED=scan`, or none made yet) or a record
/// that does not open.
async fn sealed_terms(
    db: &Db,
    id: i64,
    channel: i64,
    author: &str,
    record: &[u8],
) -> anyhow::Result<Option<Vec<String>>> {
    use crate::crypt::Purpose;
    use crate::crypt::body::{Parts, Scope, open_body};
    let ring = super::ring(db);
    if ring.scans() {
        return Ok(None);
    }
    let scope = Scope::Channel(channel);
    let opened = open_body(
        db,
        id,
        Some(scope),
        author,
        Some(record.to_vec()),
        Parts::default(),
    )
    .await?;
    if opened.unreadable {
        return Ok(None);
    }
    let Some((key_id, dek)) = ring.data_key(db, Purpose::Search).await? else {
        return Ok(None);
    };
    let keyer = crate::crypt::grams::Grams::new(ring.subkeys.get(key_id, &dek, &scope.key()));
    Ok(Some(crate::crypt::grams::postings(
        &keyer.document(&opened.parts.content),
    )))
}

/// Gives an encrypted message its keyed terms in place of its catch-all posting, or leaves it on
/// the catch-all, where a search opens it.
async fn merge_sealed(
    db: &Db,
    id: i64,
    channel: Option<i64>,
    author: &str,
    record: Vec<u8>,
) -> anyhow::Result<()> {
    let terms = match channel {
        Some(channel) => sealed_terms(db, id, channel, author, &record).await?,
        None => None,
    };
    let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
    let stream: Option<i64> = sqlx::query_scalar("SELECT d.stream FROM search_merge q JOIN search_documents d ON d.id=q.id JOIN messages m ON m.id=q.id WHERE q.id=$1 AND m.body=$2")
        .bind(id).bind(&record).fetch_optional(&mut *tx).await?;
    if let Some(stream) = stream {
        if let Some(terms) = terms {
            sqlx::query("DELETE FROM search_postings WHERE stream=$1 AND term='' AND id=$2")
                .bind(stream)
                .bind(id)
                .execute(&mut *tx)
                .await?;
            sqlx::query("INSERT OR IGNORE INTO search_postings(stream,term,id) SELECT $1,value,$2 FROM json_each($3)")
                .bind(stream)
                .bind(id)
                .bind(serde_json::to_string(&terms)?)
                .execute(&mut *tx)
                .await?;
        }
        sqlx::query("DELETE FROM search_merge WHERE id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

pub async fn build_channel_index(db: &Db) -> anyhow::Result<()> {
    if is_sqlite(db) && !has_fts(db) {
        return Ok(());
    }
    let Some(next) = stored_next(&mut *db.acquire().await?).await? else {
        return Ok(());
    };
    let mut complete = next == 0;
    while !complete {
        let step = Instant::now();
        if is_sqlite(db) {
            complete = build_step(db, BUILD_BATCH).await?;
        } else {
            complete = postgres::backfill(db).await?;
        }
        tokio::time::sleep(step.elapsed().max(Duration::from_millis(2))).await;
    }
    if is_sqlite(db) {
        let mut tokenizer = None;
        let reader = super::reader(db);
        let mut last = 0i64;
        loop {
            let row = sqlx::query("SELECT q.id,m.content,m.body,m.channel_id,m.author FROM search_merge q CROSS JOIN messages m WHERE m.id=q.id AND q.id>$1 ORDER BY q.id LIMIT 1")
                .bind(last).fetch_optional(&reader).await?;
            let Some(row) = row else { break };
            last = row.try_get(0)?;
            let step = Instant::now();
            match row.try_get::<Option<Vec<u8>>, _>(2)? {
                Some(record) => {
                    merge_sealed(db, last, row.try_get(3)?, row.try_get(4)?, record).await?
                }
                None => {
                    if tokenizer.is_none() {
                        tokenizer = Some(Tokenizer::open().await?);
                    }
                    let tokenizer = tokenizer.as_mut().expect("tokenizer");
                    merge_document(db, tokenizer, last, row.try_get(1)?).await?
                }
            }
            tokio::time::sleep(step.elapsed().max(Duration::from_millis(2))).await;
        }
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests;
