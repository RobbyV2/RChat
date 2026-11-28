//! The files of a stored picture as its row keeps them: plain, or each one a record sealed
//! under the `content` data key that `seal_key` of the row names, bound to its column and the
//! picture id. A picture of a server (a server profile's or the server's own) is stored the way
//! its server stores content, an account's the way the site requires. Every read and write of
//! the file columns goes through here.

use sqlx::{AnyConnection, Row};

use crate::api::ApiError;
use crate::api::seal::{self, Source};
use crate::crypt::copies::{self, PICTURES};
use crate::db::Db;

/// The files of one picture in the order of `PICTURES`: the three stills, then the two
/// animations, which a picture may lack.
pub(crate) type Files = [Option<Vec<u8>>; 5];

/// A picture's row: its files as stored, and the data key they are sealed under.
pub(crate) struct Kept {
    files: Files,
    key: Option<i64>,
}

fn source(server: Option<&str>) -> Source<'_> {
    match server {
        Some(name) => Source::Server(name),
        None => Source::Site,
    }
}

fn sealed(sealer: &copies::Sealer, id: &str, plain: &Files) -> Files {
    std::array::from_fn(|at| {
        plain[at]
            .as_ref()
            .map(|file| sealer.seal(PICTURES[at], id, file))
    })
}

/// Stores the new picture `id` of `owner` with the files `plain`, sealed when its place is.
pub(super) async fn insert(
    db: &Db,
    conn: &mut AnyConnection,
    id: &str,
    owner: &str,
    server: Option<&str>,
    mime: &str,
    plain: Files,
) -> Result<(), ApiError> {
    let sealer = seal::copy_sealer_of(db, conn, source(server)).await?;
    let (files, key) = match &sealer {
        Some(sealer) => (sealed(sealer, id, &plain), Some(i64::from(sealer.key_id()))),
        None => (plain, None),
    };
    let [s64, s128, s512, a128, a512] = files;
    sqlx::query("INSERT INTO avatar_images(id, owner, server, mime, s64, s128, s512, a128, a512, created_at, seal_key) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)")
        .bind(id)
        .bind(owner)
        .bind(server)
        .bind(mime)
        .bind(s64)
        .bind(s128)
        .bind(s512)
        .bind(a128)
        .bind(a512)
        .bind(crate::db::now())
        .bind(key)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// The file `at` (an index of `PICTURES`) of the picture `id` and the picture's content type.
/// `None` when there is no such picture or file, or its record does not open.
pub(super) async fn file(
    db: &Db,
    id: &str,
    at: usize,
) -> Result<Option<(String, Vec<u8>)>, ApiError> {
    let column = PICTURES[at].column;
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT mime, {column}, seal_key FROM avatar_images WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(db)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let mime: String = row.try_get(0)?;
    let Some(stored) = row.try_get::<Option<Vec<u8>>, _>(1)? else {
        return Ok(None);
    };
    let plain = match row.try_get::<Option<i64>, _>(2)? {
        None => Some(stored),
        Some(_) => copies::Opener::of(db, [stored.as_slice()])
            .await?
            .open(PICTURES[at], id, &stored)
            .map(|plain| plain.to_vec()),
    };
    Ok(plain.map(|plain| (mime, plain)))
}

/// The row of the picture `id`.
pub(crate) async fn kept(db: &Db, id: &str) -> Result<Option<Kept>, ApiError> {
    let row = sqlx::query(
        "SELECT s64, s128, s512, a128, a512, seal_key FROM avatar_images WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let mut files = Files::default();
    for (at, file) in files.iter_mut().enumerate() {
        *file = row.try_get(at)?;
    }
    Ok(Some(Kept {
        files,
        key: row.try_get(5)?,
    }))
}

impl Kept {
    /// The data key the files are sealed under; `None` for plain files.
    pub(crate) fn key(&self) -> Option<u32> {
        self.key.and_then(|key| u32::try_from(key).ok())
    }

    /// The files in plain. `None` when a record does not open.
    pub(crate) async fn plain(&self, db: &Db, id: &str) -> Result<Option<Files>, ApiError> {
        if self.key.is_none() {
            return Ok(Some(self.files.clone()));
        }
        let records = self.files.iter().flatten().map(Vec::as_slice);
        let opener = copies::Opener::of(db, records).await?;
        let mut plain = Files::default();
        for (at, record) in self.files.iter().enumerate() {
            let Some(record) = record else {
                continue;
            };
            let Some(opened) = opener.open(PICTURES[at], id, record) else {
                return Ok(None);
            };
            plain[at] = Some(opened.to_vec());
        }
        Ok(Some(plain))
    }

    /// Writes `plain` over the files of the picture `id`, sealed by `sealer` or plain without
    /// one, unless the row changed since it was read.
    pub(crate) async fn rewrite(
        &self,
        conn: &mut AnyConnection,
        id: &str,
        plain: &Files,
        sealer: Option<&copies::Sealer>,
    ) -> Result<(), ApiError> {
        let (files, key) = match sealer {
            Some(sealer) => (sealed(sealer, id, plain), Some(i64::from(sealer.key_id()))),
            None => (plain.clone(), None),
        };
        let was = match self.key {
            Some(_) => "seal_key = $8",
            None => "seal_key IS NULL AND $8 = 0",
        };
        let [s64, s128, s512, a128, a512] = files;
        sqlx::query(sqlx::AssertSqlSafe(format!("UPDATE avatar_images SET s64 = $1, s128 = $2, s512 = $3, a128 = $4, a512 = $5, seal_key = $6 WHERE id = $7 AND {was}")))
            .bind(s64)
            .bind(s128)
            .bind(s512)
            .bind(a128)
            .bind(a512)
            .bind(key)
            .bind(id)
            .bind(self.key.unwrap_or(0))
            .execute(&mut *conn)
            .await?;
        Ok(())
    }
}

/// Seals the plain picture `id` when the place it belongs to is stored encrypted now.
pub(crate) async fn seal_plain(db: &Db, id: &str, server: Option<&str>) -> Result<(), ApiError> {
    let Some(row) = kept(db, id).await?.filter(|row| row.key.is_none()) else {
        return Ok(());
    };
    let mut tx = db.begin().await?;
    let Some(sealer) = seal::copy_sealer_of(db, &mut tx, source(server)).await? else {
        return Ok(());
    };
    row.rewrite(&mut tx, id, &row.files, Some(&sealer)).await?;
    tx.commit().await?;
    Ok(())
}

/// Stores the sealed picture `id` plain again; one that does not open stays.
pub(crate) async fn unseal(db: &Db, id: &str) -> Result<(), ApiError> {
    let Some(row) = kept(db, id).await?.filter(|row| row.key.is_some()) else {
        return Ok(());
    };
    let Some(plain) = row.plain(db, id).await? else {
        return Ok(());
    };
    let mut conn = db.acquire().await?;
    row.rewrite(&mut conn, id, &plain, None).await
}
