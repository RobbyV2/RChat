//! Copies of content kept beside messages: report text and notes, webhook delivery payloads,
//! account bios and P2P backups. Each is sealed under the `content` data key in the instance
//! scope `i`, bound to its table, the column of its record and its row.

use std::collections::BTreeSet;
use std::sync::Arc;

use sqlx::AnyConnection;
use zeroize::Zeroizing;

use super::ring::Ring;
use super::{Key, Purpose, header, open, row_aad, seal};
use crate::db::Db;

/// The key scope of every copy.
pub const SCOPE: &str = "i";

/// Where a sealed copy is kept: its table and the column of its record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Column {
    pub table: &'static str,
    pub column: &'static str,
}

/// `reports.sealed`: the snapshot, the answers and the note of a report, by report id.
pub const REPORTS: Column = Column {
    table: "reports",
    column: "sealed",
};
/// `report_events.detail_sealed`: the detail of a history line that holds a note, by its id.
pub const REPORT_EVENTS: Column = Column {
    table: "report_events",
    column: "detail_sealed",
};
/// `webhook_deliveries.payload_sealed`: what a queued delivery is about, by delivery id.
pub const DELIVERIES: Column = Column {
    table: "webhook_deliveries",
    column: "payload_sealed",
};
/// `users.bio_sealed`: an account's description, by username.
pub const BIOS: Column = Column {
    table: "users",
    column: "bio_sealed",
};
/// `p2p_backups.data_sealed`: a backup version, by `<username>/<ik>/<version>`.
pub const BACKUPS: Column = Column {
    table: "p2p_backups",
    column: "data_sealed",
};

/// The binding of a P2P backup version.
pub fn backup_binding(username: &str, ik: &str, version: i64) -> String {
    format!("{username}/{ik}/{version}")
}

/// Seals copies under the active `content` key.
pub struct Sealer {
    key_id: u32,
    key: Key,
}

impl Sealer {
    /// The sealer of the stored active `content` key, read on the caller's connection, so a
    /// transaction never makes one. `None` when there is none.
    pub async fn of(ring: &Ring, conn: &mut AnyConnection) -> anyhow::Result<Option<Sealer>> {
        let Some((key_id, dek)) = ring.stored_data_key_on(conn, Purpose::Content).await? else {
            return Ok(None);
        };
        Ok(Some(Sealer {
            key_id,
            key: ring.subkeys.get(key_id, &dek, SCOPE),
        }))
    }

    /// The record of `plain` kept in `at` for the row `binding`.
    pub fn seal(&self, at: Column, binding: &str, plain: &[u8]) -> Vec<u8> {
        let aad = row_aad(at.table, at.column, binding, self.key_id);
        seal(self.key_id, &self.key, &aad, plain)
    }
}

/// Opens sealed copies. It holds the key of every record it was made for.
pub struct Opener {
    ring: Arc<Ring>,
}

fn wanted<'a>(ring: &Ring, records: impl IntoIterator<Item = &'a [u8]>) -> BTreeSet<u32> {
    records
        .into_iter()
        .filter_map(|record| header(record).ok())
        .map(|h| h.key_id)
        .filter(|id| ring.held(*id).is_none())
        .collect()
}

impl Opener {
    /// An opener holding the key of every record in `records`, read through the pool.
    pub async fn of<'a>(
        db: &Db,
        records: impl IntoIterator<Item = &'a [u8]>,
    ) -> sqlx::Result<Opener> {
        let ring = crate::db::ring(db);
        for id in wanted(&ring, records) {
            ring.key_by_id(db, id)
                .await
                .map_err(|e| sqlx::Error::Protocol(e.to_string()))?;
        }
        Ok(Opener { ring })
    }

    /// An opener for `rows`, whose column `at` holds a record or null.
    pub async fn of_rows(db: &Db, rows: &[sqlx::any::AnyRow], at: usize) -> sqlx::Result<Opener> {
        use sqlx::Row;
        let mut records = Vec::new();
        for row in rows {
            records.extend(row.try_get::<Option<Vec<u8>>, _>(at)?);
        }
        Opener::of(db, records.iter().map(Vec::as_slice)).await
    }

    /// `of` on the caller's connection, for a caller inside a transaction.
    pub async fn on<'a>(
        db: &Db,
        conn: &mut AnyConnection,
        records: impl IntoIterator<Item = &'a [u8]>,
    ) -> sqlx::Result<Opener> {
        let ring = crate::db::ring(db);
        for id in wanted(&ring, records) {
            ring.key_by_id_on(conn, id)
                .await
                .map_err(|e| sqlx::Error::Protocol(e.to_string()))?;
        }
        Ok(Opener { ring })
    }

    fn key(&self, record: &[u8]) -> Option<(u32, Key)> {
        let key_id = header(record).ok()?.key_id;
        let (Purpose::Content, dek) = self.ring.held(key_id)? else {
            return None;
        };
        Some((key_id, self.ring.subkeys.get(key_id, &dek, SCOPE)))
    }

    /// What the record in `at` for the row `binding` holds. `None` for a record that does not
    /// open, which is logged and counted.
    pub fn open(&self, at: Column, binding: &str, record: &[u8]) -> Option<Zeroizing<Vec<u8>>> {
        let opened = self.key(record).and_then(|(key_id, key)| {
            let aad = row_aad(at.table, at.column, binding, key_id);
            open(&key, &aad, record).ok()
        });
        if opened.is_none() {
            tracing::warn!(
                "the stored record of {}.{} {binding} can't be opened",
                at.table,
                at.column
            );
            self.ring.note_unreadable();
        }
        opened.map(Zeroizing::new)
    }

    /// The text in a record, `None` when it does not open or holds no text.
    pub fn text(&self, at: Column, binding: &str, record: &[u8]) -> Option<String> {
        let plain = self.open(at, binding, record)?;
        std::str::from_utf8(&plain).ok().map(str::to_owned)
    }

    /// `plain` sealed again for the same row under the key of `record`, which this opener
    /// opened, so a rewrite needs no other key.
    pub fn reseal(
        &self,
        at: Column,
        binding: &str,
        record: &[u8],
        plain: &[u8],
    ) -> Option<Vec<u8>> {
        let (key_id, key) = self.key(record)?;
        let aad = row_aad(at.table, at.column, binding, key_id);
        Some(seal(key_id, &key, &aad, plain))
    }
}

/// The text of a column that has a sealed copy beside it: its record opened, else its plain
/// value. An unreadable record reads as `None`.
pub fn text_or(
    opener: &Opener,
    at: Column,
    binding: &str,
    record: Option<&[u8]>,
    plain: Option<String>,
) -> Option<String> {
    match record {
        Some(record) => opener.text(at, binding, record),
        None => plain,
    }
}

/// The description of `user`: its sealed record opened, else its plain column. An unreadable
/// record reads as none.
pub async fn bio_of(db: &Db, user: &crate::db::User) -> sqlx::Result<Option<String>> {
    let Some(record) = &user.bio_sealed else {
        return Ok(user.bio.clone());
    };
    let opener = Opener::of(db, [record.as_slice()]).await?;
    Ok(opener.text(BIOS, &user.username, record))
}
