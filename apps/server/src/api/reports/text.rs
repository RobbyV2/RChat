//! The text a report keeps (its snapshot, its answers and its note) and the notes of its
//! history, stored plain or sealed as copies of the content they come from.

use serde::{Deserialize, Serialize};
use sqlx::{AnyConnection, Row};

use crate::api::ApiError;
use crate::api::seal::{Source, copy_sealer_of};
use crate::crypt::copies::{Opener, REPORT_EVENTS, REPORTS, Sealer};
use crate::db::Db;

/// What the plain columns of a sealed report hold.
pub(super) const BLANK_SNAPSHOT: &str = "{}";
pub(super) const BLANK_ANSWERS: &str = "[]";
/// What the plain column of a sealed history line holds.
pub(super) const BLANK_DETAIL: &str = "{}";
/// The refusal of a change that needs the text of a report whose record does not open.
pub(super) const UNREADABLE: &str = "This report can't be opened";

/// A report's text, as its plain columns hold it when it is stored plain.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct Text {
    pub snapshot: String,
    pub answers: String,
    pub note: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Kept {
    v: u8,
    s: String,
    a: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    n: Option<String>,
}

const VERSION: u8 = 1;

impl Text {
    /// The text of a sealed report's plain columns.
    pub fn blank() -> Text {
        Text {
            snapshot: BLANK_SNAPSHOT.to_owned(),
            answers: BLANK_ANSWERS.to_owned(),
            note: None,
        }
    }

    /// The record of this text for the report `id`.
    pub fn seal(&self, sealer: &Sealer, id: i64) -> Vec<u8> {
        sealer.seal(REPORTS, &id.to_string(), &self.encode())
    }

    /// The record of this text for the report `id` under the key of `record`, which `opener`
    /// opened.
    pub fn reseal(&self, opener: &Opener, id: i64, record: &[u8]) -> Option<Vec<u8>> {
        opener.reseal(REPORTS, &id.to_string(), record, &self.encode())
    }

    fn encode(&self) -> Vec<u8> {
        let Text {
            snapshot,
            answers,
            note,
        } = self.clone();
        serde_json::to_vec(&Kept {
            v: VERSION,
            s: snapshot,
            a: answers,
            n: note,
        })
        .unwrap_or_default()
    }

    /// The text in the record of the report `id`, `None` when it does not open.
    pub fn open(opener: &Opener, id: i64, record: &[u8]) -> Option<Text> {
        let plain = opener.open(REPORTS, &id.to_string(), record)?;
        let Kept { v, s, a, n } = serde_json::from_slice(&plain).ok()?;
        (v == VERSION).then_some(Text {
            snapshot: s,
            answers: a,
            note: n,
        })
    }

    /// The text of a report row: its record opened, else its plain columns. A record that does
    /// not open reads as a blank report.
    pub fn of(opener: &Opener, id: i64, record: Option<&[u8]>, plain: Text) -> Text {
        match record {
            Some(record) => Text::open(opener, id, record).unwrap_or_else(Text::blank),
            None => plain,
        }
    }
}

/// The detail of the history line `id`: its record opened, else its plain column. A record that
/// does not open reads as an empty detail.
pub(super) fn detail_of(opener: &Opener, id: i64, record: Option<&[u8]>, plain: String) -> String {
    match record {
        Some(record) => opener
            .text(REPORT_EVENTS, &id.to_string(), record)
            .unwrap_or_else(|| BLANK_DETAIL.to_owned()),
        None => plain,
    }
}

/// The record of the detail of the history line `id`.
pub(super) fn detail_record(sealer: &Sealer, id: i64, detail: &str) -> Vec<u8> {
    sealer.seal(REPORT_EVENTS, &id.to_string(), detail.as_bytes())
}

/// The place the content of a report came from: its DM, else its server, else only the site.
pub(super) fn source_of(server: Option<&str>, dm: Option<i64>) -> Source<'_> {
    match (dm, server) {
        (Some(dm), _) => Source::Dm(dm),
        (None, Some(server)) => Source::Server(server),
        (None, None) => Source::Site,
    }
}

/// The sealer of what is written about the report `id` now: while the place its content came
/// from stores content sealed, or while the report itself is stored sealed. `None` otherwise.
pub(super) async fn sealer_of(
    db: &Db,
    conn: &mut AnyConnection,
    id: i64,
) -> Result<Option<Sealer>, ApiError> {
    let row = sqlx::query("SELECT server, dm_id, sealed FROM reports WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await?;
    let (server, dm, sealed): (Option<String>, Option<i64>, Option<Vec<u8>>) = match &row {
        Some(row) => (row.try_get(0)?, row.try_get(1)?, row.try_get(2)?),
        None => (None, None, None),
    };
    if let Some(sealer) = copy_sealer_of(db, conn, source_of(server.as_deref(), dm)).await? {
        return Ok(Some(sealer));
    }
    match sealed {
        Some(_) => Sealer::of(&crate::db::ring(db), conn)
            .await
            .map_err(ApiError::internal),
        None => Ok(None),
    }
}

/// Writes the record of the report `id`, which was inserted with blank columns.
pub(super) async fn store_record(
    conn: &mut AnyConnection,
    id: i64,
    record: Vec<u8>,
) -> sqlx::Result<()> {
    sqlx::query("UPDATE reports SET sealed = $1 WHERE id = $2")
        .bind(record)
        .bind(id)
        .execute(&mut *conn)
        .await
        .map(|_| ())
}
