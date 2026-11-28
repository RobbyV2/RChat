//! The text of scheduled messages as it is stored: in the plain column, or as a record beside
//! a blank one in a place that stores its messages encrypted.

use sqlx::{AnyConnection, Row};

use crate::api::ApiError;
use crate::api::seal::jobs::Target;
use crate::api::seal::{self, SITE_SQL};
use crate::crypt::body::{Opener, Parts, Scope};
use crate::db::{Db, is_sqlite};

/// The error of a row whose record doesn't open.
pub const UNREADABLE: &str = "This site can't read it anymore";

/// Rows read in one step of sealing or unsealing.
const BATCH: i64 = 200;

/// The states a row is sealed or unsealed in: one being sent is left to its sender.
const PENDING: &str = "status IN ('waiting', 'failed', 'paused')";

/// The text of a row, opened. Only `Texts::open` makes one.
pub(super) struct Text(Option<String>);

impl Text {
    /// The text; `None` when the stored record doesn't open.
    pub(super) fn read(&self) -> Option<&str> {
        self.0.as_deref()
    }

    /// The text as it is shown: empty when the stored record doesn't open.
    pub(super) fn shown(&self) -> String {
        self.0.clone().unwrap_or_default()
    }
}

/// Opens the text of rows read with their `body`.
pub(super) struct Texts {
    opener: Opener,
}

impl Texts {
    /// For `rows`, whose column `at` is the `body`.
    pub(super) async fn of_rows(
        db: &Db,
        rows: &[sqlx::any::AnyRow],
        at: usize,
    ) -> sqlx::Result<Texts> {
        Ok(Texts {
            opener: Opener::of_rows(db, rows, at).await?,
        })
    }

    pub(super) fn open(
        &self,
        id: i64,
        scope: Option<Scope>,
        author: &str,
        body: Option<&[u8]>,
        content: String,
    ) -> Text {
        let opened = self
            .opener
            .scheduled(id, scope, author, body, Parts::text(content));
        Text((!opened.unreadable).then_some(opened.parts.content))
    }
}

/// Stores `content` as the text of row `id` in the form its place has now, inside the caller's
/// transaction: a record beside a blank column where messages are stored encrypted, the plain
/// column and no record elsewhere. The place is held against a switch until the transaction
/// ends.
pub(super) async fn store(
    db: &Db,
    conn: &mut AnyConnection,
    id: i64,
    scope: Option<Scope>,
    author: &str,
    content: &str,
) -> Result<(), ApiError> {
    let writer = match scope {
        Some(scope) => seal::writer_of(db, conn, scope).await?,
        None => None,
    };
    let record = writer
        .as_ref()
        .map(|w| w.scheduled(id, author, &Parts::text(content)));
    let plain = match record {
        Some(_) => "",
        None => content,
    };
    sqlx::query("UPDATE scheduled_messages SET content = $1, body = $2 WHERE id = $3")
        .bind(plain)
        .bind(record)
        .bind(id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

async fn write_tx(db: &Db) -> sqlx::Result<sqlx::Transaction<'_, sqlx::Any>> {
    match is_sqlite(db) {
        true => db.begin_with("BEGIN IMMEDIATE").await,
        false => db.begin().await,
    }
}

/// Seals the row `id` when it waits or failed with plain text in a place that stores its
/// messages encrypted. The row is written only while it holds the text that was read.
async fn seal_row(db: &Db, id: i64) -> Result<bool, ApiError> {
    let mut tx = write_tx(db).await?;
    let sql = format!(
        "SELECT channel_id, dm_id, username, content, body FROM scheduled_messages WHERE id = $1 AND body IS NULL AND {PENDING}"
    );
    let row = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(row) = row else {
        return Ok(false);
    };
    let Some(scope) = Scope::of(row.try_get(0)?, row.try_get(1)?) else {
        return Ok(false);
    };
    let Some(writer) = seal::writer_of(db, &mut tx, scope).await? else {
        return Ok(false);
    };
    let author: String = row.try_get(2)?;
    let content: String = row.try_get(3)?;
    let written = sqlx::query("UPDATE scheduled_messages SET body = $1, content = '' WHERE id = $2 AND body IS NULL AND content = $3")
        .bind(writer.scheduled(id, &author, &Parts::text(content.as_str())))
        .bind(id)
        .bind(&content)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    tx.commit().await?;
    Ok(written > 0)
}

/// Seals the waiting and failed rows that hold plain text in a place that stores its messages
/// encrypted now: rows scheduled before its switch, or by a copy that wrote them plain.
/// Returns how many it sealed.
pub(crate) async fn seal_pending(db: &Db) -> Result<u64, ApiError> {
    let sql = format!(
        "SELECT m.id FROM scheduled_messages m WHERE m.id > $1 AND m.body IS NULL AND m.{PENDING} AND ({SITE_SQL} > 0 OR EXISTS(SELECT 1 FROM channels c JOIN servers s ON s.name = c.server WHERE c.id = m.channel_id AND (s.seal > 0 OR s.seal_forced > 0)) OR EXISTS(SELECT 1 FROM dms d WHERE d.id = m.dm_id AND d.seal > 0)) ORDER BY m.id LIMIT $2"
    );
    let (mut at, mut sealed) = (0, 0);
    loop {
        let ids: Vec<i64> = sqlx::query_scalar(sqlx::AssertSqlSafe(sql.clone()))
            .bind(at)
            .bind(BATCH)
            .fetch_all(db)
            .await?;
        for id in &ids {
            sealed += u64::from(seal_row(db, *id).await?);
        }
        match ids.last() {
            Some(last) if ids.len() as i64 == BATCH => at = *last,
            _ => return Ok(sealed),
        }
    }
}

fn place_sql(target: &Target) -> &'static str {
    match target {
        Target::Server(_) => "channel_id IN (SELECT id FROM channels WHERE server = $1)",
        Target::Dm(_) => "dm_id = $1",
        Target::All => "$1 = ''",
    }
}

fn bound<'q, O>(
    query: sqlx::query::QueryScalar<'q, sqlx::Any, O, sqlx::any::AnyArguments>,
    target: &Target,
) -> sqlx::query::QueryScalar<'q, sqlx::Any, O, sqlx::any::AnyArguments> {
    match target {
        Target::Server(name) => query.bind(name.clone()),
        Target::Dm(id) => query.bind(*id),
        Target::All => query.bind(String::new()),
    }
}

/// How many rows of `target` hold their text in a record.
pub(crate) async fn still_sealed(db: &Db, target: &Target) -> Result<i64, ApiError> {
    let sql = format!(
        "SELECT COUNT(*) FROM scheduled_messages WHERE body IS NOT NULL AND {}",
        place_sql(target)
    );
    let query = sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(sql));
    Ok(bound(query, target).fetch_one(db).await?)
}

/// Stores the row `id` plain again, while its record holds what was read. A record that does
/// not open stays.
async fn unseal_row(db: &Db, id: i64) -> Result<bool, ApiError> {
    let sql = format!(
        "SELECT id, channel_id, dm_id, username, content, body FROM scheduled_messages WHERE id = $1 AND body IS NOT NULL AND {PENDING}"
    );
    let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_all(db)
        .await?;
    let Some(row) = rows.first() else {
        return Ok(false);
    };
    let texts = Texts::of_rows(db, &rows, 5).await?;
    let record: Vec<u8> = row.try_get(5)?;
    let author: String = row.try_get(3)?;
    let text = texts.open(
        id,
        Scope::of(row.try_get(1)?, row.try_get(2)?),
        &author,
        Some(&record),
        row.try_get(4)?,
    );
    let Some(content) = text.read() else {
        return Ok(false);
    };
    let written = sqlx::query(
        "UPDATE scheduled_messages SET content = $1, body = NULL WHERE id = $2 AND body = $3",
    )
    .bind(content)
    .bind(id)
    .bind(record)
    .execute(db)
    .await?
    .rows_affected();
    Ok(written > 0)
}

/// Stores the waiting and failed rows of `target` plain again, for a job that decrypts its
/// stored messages. Returns how many it wrote.
pub(crate) async fn unseal_pending(db: &Db, target: &Target) -> Result<u64, ApiError> {
    let sql = format!(
        "SELECT id FROM scheduled_messages WHERE body IS NOT NULL AND {PENDING} AND {} AND id > $2 ORDER BY id LIMIT $3",
        place_sql(target)
    );
    let (mut at, mut written) = (0, 0);
    loop {
        let query = sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(sql.clone()));
        let ids = bound(query, target)
            .bind(at)
            .bind(BATCH)
            .fetch_all(db)
            .await?;
        for id in &ids {
            written += u64::from(unseal_row(db, *id).await?);
        }
        match ids.last() {
            Some(last) if ids.len() as i64 == BATCH => at = *last,
            _ => return Ok(written),
        }
    }
}
