//! Sealed message and poll text: the record stored in a `body` column, and the one place that
//! opens it.

use std::collections::BTreeSet;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::grams::Grams;
use super::ring::Ring;
use super::{Key, Purpose, header, open, row_aad, seal};
use crate::db::Db;

pub const MESSAGES: &str = "messages";
pub const POLLS: &str = "polls";
pub const OPTIONS: &str = "poll_options";
pub const SNAPSHOTS: &str = "poll_snapshots";
pub const COLUMN: &str = "body";

/// The channel or DM a row belongs to. It names the key and is bound into message records.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Scope {
    Channel(i64),
    Dm(i64),
}

impl Scope {
    pub fn of(channel_id: Option<i64>, dm_id: Option<i64>) -> Option<Scope> {
        match (channel_id, dm_id) {
            (Some(id), _) => Some(Scope::Channel(id)),
            (None, Some(id)) => Some(Scope::Dm(id)),
            (None, None) => None,
        }
    }

    pub(crate) fn key(self) -> String {
        match self {
            Scope::Channel(id) => format!("c:{id}"),
            Scope::Dm(id) => format!("d:{id}"),
        }
    }

    fn bound(self) -> String {
        match self {
            Scope::Channel(id) => format!("c{id}"),
            Scope::Dm(id) => format!("d{id}"),
        }
    }
}

/// The text of a message that is stored sealed: its content, its webhook cards, the name of
/// its file and the name of a file a forward left behind.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Parts {
    pub content: String,
    pub embeds: Option<String>,
    pub filename: Option<String>,
    pub dropped: Option<String>,
    pub alt: Option<String>,
}

impl Parts {
    /// Parts holding only `content`.
    pub fn text(content: impl Into<String>) -> Parts {
        Parts {
            content: content.into(),
            ..Parts::default()
        }
    }
}

#[derive(Serialize, Deserialize)]
struct Plain {
    v: u8,
    c: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    e: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    f: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    d: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    a: Option<String>,
}

const VERSION: u8 = 1;

fn encode(parts: &Parts) -> Vec<u8> {
    let Parts {
        content,
        embeds,
        filename,
        dropped,
        alt,
    } = parts.clone();
    serde_json::to_vec(&Plain {
        v: VERSION,
        c: content,
        e: embeds,
        f: filename,
        d: dropped,
        a: alt,
    })
    .unwrap_or_default()
}

fn decode(plain: &[u8]) -> Option<Parts> {
    let Plain { v, c, e, f, d, a } = serde_json::from_slice(plain).ok()?;
    (v == VERSION).then_some(Parts {
        content: c,
        embeds: e,
        filename: f,
        dropped: d,
        alt: a,
    })
}

fn message_binding(id: i64, scope: Scope, author: &str) -> String {
    format!("{id}/{}/{author}", scope.bound())
}

/// Seals the rows of one channel or DM under the active `content` key.
pub struct Writer {
    key_id: u32,
    key: Key,
    scope: Scope,
    grams: Option<Grams>,
}

impl Writer {
    /// The writer of `scope`, on the connection of the caller's transaction, under the stored
    /// active `content` key. `None` when there is none: that key is made and committed on its
    /// own before a place turns on.
    pub async fn of(
        ring: &Ring,
        conn: &mut sqlx::AnyConnection,
        scope: Scope,
    ) -> anyhow::Result<Option<Writer>> {
        let Some((key_id, dek)) = ring.stored_data_key_on(conn, Purpose::Content).await? else {
            return Ok(None);
        };
        let grams = match ring.scans() {
            true => None,
            false => Grams::of_on(ring, conn, scope).await?,
        };
        Ok(Some(Writer {
            key_id,
            key: ring.subkeys.get(key_id, &dek, &scope.key()),
            scope,
            grams,
        }))
    }

    /// The `messages.grams` of a message holding `parts`, as Postgres reads an `integer[]`:
    /// `None` for a DM and while there is no search key or `SEARCH_SEALED=scan`, so a search
    /// reads the row itself.
    pub fn grams(&self, parts: &Parts) -> Option<String> {
        self.grams
            .as_ref()
            .map(|grams| super::grams::array(&grams.document(&parts.content)))
    }

    fn record(&self, table: &str, binding: &str, plain: &[u8]) -> Vec<u8> {
        let aad = row_aad(table, COLUMN, binding, self.key_id);
        seal(self.key_id, &self.key, &aad, plain)
    }

    /// The `messages.body` of the message `id` by `author`.
    pub fn message(&self, id: i64, author: &str, parts: &Parts) -> Vec<u8> {
        self.record(
            MESSAGES,
            &message_binding(id, self.scope, author),
            &encode(parts),
        )
    }

    /// The `body` of the row `id` of `table`, one of `POLLS` (by message id), `OPTIONS` (by
    /// option id) and `SNAPSHOTS` (by message id), holding `text`.
    pub fn text(&self, table: &str, id: i64, text: &str) -> Vec<u8> {
        self.record(table, &id.to_string(), &encode(&Parts::text(text)))
    }
}

/// What a row holds once opened. `unreadable` is a record that did not open; its parts are
/// empty.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Opened {
    pub parts: Parts,
    pub unreadable: bool,
}

/// Opens `body` columns. Every read of message or poll text goes through it: a row without a
/// record holds its plain columns.
pub struct Opener {
    ring: Arc<Ring>,
}

impl Opener {
    /// An opener for `rows`, whose column `at` is a `body`.
    pub async fn of_rows(db: &Db, rows: &[sqlx::any::AnyRow], at: usize) -> sqlx::Result<Opener> {
        use sqlx::Row;
        let mut records = Vec::new();
        for row in rows {
            records.extend(row.try_get::<Option<Vec<u8>>, _>(at)?);
        }
        Opener::of(db, records.iter().map(Vec::as_slice)).await
    }

    /// An opener holding the key of every record in `records`.
    pub async fn of<'a>(
        db: &Db,
        records: impl IntoIterator<Item = &'a [u8]>,
    ) -> sqlx::Result<Opener> {
        let ring = crate::db::ring(db);
        let wanted: BTreeSet<u32> = records
            .into_iter()
            .filter_map(|record| header(record).ok())
            .map(|h| h.key_id)
            .filter(|id| ring.held(*id).is_none())
            .collect();
        for id in wanted {
            ring.key_by_id(db, id)
                .await
                .map_err(|e| sqlx::Error::Protocol(e.to_string()))?;
        }
        Ok(Opener { ring })
    }

    fn plain(&self, scope: Scope, table: &str, binding: &str, record: &[u8]) -> Option<Parts> {
        let key_id = header(record).ok()?.key_id;
        let (Purpose::Content, dek) = self.ring.held(key_id)? else {
            return None;
        };
        let key = self.ring.subkeys.get(key_id, &dek, &scope.key());
        let aad = row_aad(table, COLUMN, binding, key_id);
        decode(&open(&key, &aad, record).ok()?)
    }

    fn opened(
        &self,
        scope: Option<Scope>,
        table: &str,
        binding: &str,
        body: Option<&[u8]>,
        plain: Parts,
    ) -> Opened {
        let Some(record) = body else {
            return Opened {
                parts: plain,
                unreadable: false,
            };
        };
        match scope.and_then(|scope| self.plain(scope, table, binding, record)) {
            Some(parts) => Opened {
                parts,
                unreadable: false,
            },
            None => {
                tracing::warn!("the stored record of {table} {binding} can't be opened");
                self.ring.note_unreadable();
                Opened {
                    parts: Parts::default(),
                    unreadable: true,
                }
            }
        }
    }

    /// The text of the message `id`: its record opened, else its plain columns.
    pub fn message(
        &self,
        id: i64,
        scope: Option<Scope>,
        author: &str,
        body: Option<&[u8]>,
        plain: Parts,
    ) -> Opened {
        let binding = scope.map(|scope| message_binding(id, scope, author));
        self.opened(
            scope,
            MESSAGES,
            binding.as_deref().unwrap_or_default(),
            body,
            plain,
        )
    }

    /// The text of the row `id` of `table` (see `Writer::text`). An unreadable record reads as
    /// empty.
    pub fn text(
        &self,
        table: &str,
        id: i64,
        scope: Option<Scope>,
        body: Option<&[u8]>,
        plain: String,
    ) -> String {
        self.opened(scope, table, &id.to_string(), body, Parts::text(plain))
            .parts
            .content
    }
}

/// The text of one message row, for a caller that read a single row.
pub async fn open_body(
    db: &Db,
    id: i64,
    scope: Option<Scope>,
    author: &str,
    body: Option<Vec<u8>>,
    plain: Parts,
) -> sqlx::Result<Opened> {
    let opener = Opener::of(db, body.as_deref()).await?;
    Ok(opener.message(id, scope, author, body.as_deref(), plain))
}
