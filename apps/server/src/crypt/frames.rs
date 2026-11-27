//! The frames this instance keeps in Redis (realtime hub entries, the hub snapshot and queued
//! jobs), sealed under the `bus` data key once every live copy opens them. Readers take plain
//! and sealed frames alike.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use super::ring::{DATABASE_KEK, Ring};
use super::{Key, MAGIC, Purpose, SERVER_RECORD, bus_aad, header, open, seal};
use crate::db::Db;
use crate::hub::CopyNote;

/// How long a key id that opened no frame is not looked up again.
const MISS_KEPT: Duration = Duration::from_secs(60);

/// Where a frame is kept, bound into its associated data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stream {
    Hub,
    Snapshot,
    Jobs,
}

impl Stream {
    pub fn name(self) -> &'static str {
        match self {
            Stream::Hub => "hub",
            Stream::Snapshot => "snapshot",
            Stream::Jobs => "jobs",
        }
    }
}

/// Whether frames sealed under a data key that `kek` wraps open on every copy of `others`, the
/// last announcement of every other live copy: each opens sealed frames and holds that key.
pub fn ready(kek: &str, others: &[Option<CopyNote>]) -> bool {
    others.iter().all(|other| {
        other
            .as_ref()
            .is_some_and(|note| note.bus && note.keks.iter().any(|id| id == kek))
    })
}

/// Whether `bytes` is a sealed frame rather than plain text.
pub fn is_sealed(bytes: &[u8]) -> bool {
    matches!(bytes, [MAGIC, SERVER_RECORD, ..])
}

/// Seals and opens bus frames. Frames go plain until `decide` finds every copy ready.
pub struct Frames {
    keys: Option<(Arc<Ring>, Db)>,
    sealing: RwLock<Option<(u32, Key)>>,
    misses: Mutex<HashMap<u32, Instant>>,
    opens: AtomicBool,
}

/// What `decide` found: whether this copy opens frames under the active `bus` data key (with
/// why not), and the key to seal under.
struct Usable {
    blocked: Option<String>,
    key: Option<(u32, Key)>,
}

impl Frames {
    pub fn new(ring: Arc<Ring>, db: Db) -> Frames {
        let opens = ring.ready();
        Frames {
            keys: Some((ring, db)),
            sealing: RwLock::new(None),
            misses: Mutex::new(HashMap::new()),
            opens: AtomicBool::new(opens),
        }
    }

    /// Frames that are never sealed and never open.
    pub fn plain() -> Frames {
        Frames {
            keys: None,
            sealing: RwLock::new(None),
            misses: Mutex::new(HashMap::new()),
            opens: AtomicBool::new(false),
        }
    }

    /// Whether this copy opens sealed frames, as its copy announcement says: it holds a root key
    /// and the active `bus` data key, if there is one, unwraps here.
    pub fn opens(&self) -> bool {
        self.opens.load(Ordering::Relaxed)
    }

    /// The ids of the root keys this copy holds, for its copy announcement.
    pub fn keks(&self) -> Vec<String> {
        self.keys
            .as_ref()
            .map(|(ring, _)| ring.kek_ids())
            .unwrap_or_default()
    }

    /// Seals frames under the active `bus` data key from now on when every copy of `others`
    /// opens them, else writes them plain. Answers whether frames are sealed now. On an error
    /// frames go plain, which every copy reads.
    pub async fn decide(&self, others: &[Option<CopyNote>]) -> anyhow::Result<bool> {
        let found = match &self.keys {
            Some((ring, db)) => usable_key(ring, db, others).await,
            None => Ok(Usable {
                blocked: Some("no root key is held here".to_owned()),
                key: None,
            }),
        };
        let found = match found {
            Ok(found) => found,
            Err(e) => {
                *self.sealing.write().unwrap_or_else(|e| e.into_inner()) = None;
                return Err(e);
            }
        };
        let opens = found.blocked.is_none();
        if self.opens.swap(opens, Ordering::Relaxed) && !opens && self.keys.is_some() {
            tracing::warn!(
                "this copy can't open sealed realtime frames: {}",
                found.blocked.as_deref().unwrap_or_default()
            );
        }
        let sealed = found.key.is_some();
        *self.sealing.write().unwrap_or_else(|e| e.into_inner()) = found.key;
        Ok(sealed)
    }

    /// Whether frames are sealed now.
    pub fn sealed(&self) -> bool {
        self.sealing
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
    }

    /// `plain` sealed for `stream` and `binding`, or `None` while frames go plain.
    pub fn seal(&self, stream: Stream, binding: &str, plain: &[u8]) -> Option<Vec<u8>> {
        let sealing = self.sealing.read().unwrap_or_else(|e| e.into_inner());
        let (id, key) = sealing.as_ref()?;
        Some(seal(*id, key, &bus_aad(stream.name(), binding, *id), plain))
    }

    /// The plain text of a sealed frame of `stream` and `binding`. Its data key is read once,
    /// then held; a key id that is not a bus key here is looked up again only after a while.
    pub async fn open(
        &self,
        stream: Stream,
        binding: &str,
        record: &[u8],
    ) -> anyhow::Result<Vec<u8>> {
        let Some((ring, db)) = &self.keys else {
            anyhow::bail!("no key opens bus frames here");
        };
        let id = header(record)?.key_id;
        let missed = || {
            self.misses
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(&id)
                .is_some_and(|at| at.elapsed() < MISS_KEPT)
        };
        let found = match ring.held(id) {
            Some(held) => Some(held),
            None if missed() => None,
            None => {
                let looked = ring.key_by_id(db, id).await?;
                if !matches!(looked, Some((Purpose::Bus, _))) {
                    let mut misses = self.misses.lock().unwrap_or_else(|e| e.into_inner());
                    misses.retain(|_, at| at.elapsed() < MISS_KEPT);
                    misses.insert(id, Instant::now());
                }
                looked
            }
        };
        let key = match found {
            Some((Purpose::Bus, key)) => key,
            Some((Purpose::Content | Purpose::Media | Purpose::Secrets | Purpose::Search, _))
            | None => anyhow::bail!("no bus key {id} is held here"),
        };
        Ok(open(&key, &bus_aad(stream.name(), binding, id), record)?)
    }

    /// The text of a frame of `stream` and `binding` that may be sealed.
    pub async fn text(
        &self,
        stream: Stream,
        binding: &str,
        bytes: Vec<u8>,
    ) -> anyhow::Result<String> {
        let plain = match is_sealed(&bytes) {
            true => self.open(stream, binding, &bytes).await?,
            false => bytes,
        };
        Ok(String::from_utf8(plain)?)
    }
}

/// The active `bus` data key when every copy of `others` opens frames sealed under it. The data
/// keys are read again first, so a key another copy replaced stops sealing here, and a first one
/// is made only under a root key every copy holds: a copy without it would not start beside it.
/// An active key that does not unwrap here leaves this copy unable to open sealed frames.
async fn usable_key(ring: &Ring, db: &Db, others: &[Option<CopyNote>]) -> anyhow::Result<Usable> {
    if !ring.ready() {
        return Ok(Usable {
            blocked: Some("no root key is held here".to_owned()),
            key: None,
        });
    }
    ring.note_keys(db).await?;
    let stored = match ring.stored_data_key(db, Purpose::Bus).await {
        Ok(stored) => stored,
        Err(e) if e.downcast_ref::<sqlx::Error>().is_some() => return Err(e),
        Err(e) => {
            return Ok(Usable {
                blocked: Some(e.to_string()),
                key: None,
            });
        }
    };
    let stored = match stored {
        Some(stored) => Some(stored),
        None => match ring.first_kek().is_some_and(|kek| ready(&kek, others)) {
            true => ring.data_key(db, Purpose::Bus).await?,
            false => None,
        },
    };
    let Some((id, key)) = stored else {
        return Ok(Usable {
            blocked: None,
            key: None,
        });
    };
    let key = wrapped_by(db, id)
        .await?
        .filter(|kek| kek != DATABASE_KEK && ready(kek, others))
        .map(|_| (id, key));
    Ok(Usable { blocked: None, key })
}

/// The id of the root key that wraps the data key `id`.
async fn wrapped_by(db: &Db, id: u32) -> sqlx::Result<Option<String>> {
    sqlx::query_scalar("SELECT kek FROM data_keys WHERE id = $1")
        .bind(i64::from(id))
        .fetch_optional(db)
        .await
}

#[cfg(test)]
mod tests;
