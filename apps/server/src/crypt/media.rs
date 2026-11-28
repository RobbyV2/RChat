//! Uploaded files stored encrypted. Each chunk of a file is sealed under the `media` data key in
//! the instance scope `i`, bound to the file id, the chunk's number and the number of chunks, so
//! a chunk can't be moved, dropped or cut off unnoticed. In the database each chunk is a record;
//! in S3 a file is one object, `0x52 0x03 | key id u32 BE | chunk count u32 BE` followed by one
//! frame `nonce(24) | ciphertext | tag(16)` per chunk. The file's name and what else is kept
//! about it are one record beside it (`media.name_sealed`).

use serde::{Deserialize, Serialize};
use sqlx::AnyConnection;

use super::ring::Ring;
use super::{
    CryptError, Key, MAGIC, NONCE_LEN, Purpose, TAG_LEN, decrypt, encrypt, open, row_aad, seal,
};
use crate::db::Db;

/// The key scope of every file.
pub const SCOPE: &str = "i";
/// The bytes of a chunk: every chunk but the last holds this many.
pub const CHUNK: usize = 256 * 1024;
/// The version byte of a sealed S3 object.
pub const OBJECT: u8 = 0x03;
/// The bytes before the first frame of a sealed S3 object.
pub const OBJECT_HEADER: usize = 10;
/// What a frame adds to its chunk.
pub const FRAME_OVERHEAD: usize = NONCE_LEN + TAG_LEN;

/// How many chunks a file of `size` bytes has.
pub fn chunks(size: u64) -> u64 {
    size.div_ceil(CHUNK as u64)
}

/// The bytes chunk `seq` of a file of `size` bytes holds.
pub fn chunk_len(size: u64, seq: u64) -> usize {
    size.saturating_sub(seq * CHUNK as u64).min(CHUNK as u64) as usize
}

/// The bytes of the sealed S3 object of a file of `size` bytes.
pub fn object_len(size: u64) -> u64 {
    OBJECT_HEADER as u64 + size + chunks(size) * FRAME_OVERHEAD as u64
}

fn chunk_aad(id: &str, seq: u64, total: u64, key_id: u32) -> Vec<u8> {
    row_aad(
        "media_chunks",
        "data",
        &format!("{id}/{seq}/{total}"),
        key_id,
    )
}

fn facts_aad(id: &str, key_id: u32) -> Vec<u8> {
    row_aad("media", "name_sealed", id, key_id)
}

/// What is kept encrypted about a file beside its bytes. Later facts come as optional fields; a
/// reader takes the ones it knows.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Facts {
    /// The file's name.
    #[serde(rename = "f")]
    pub name: String,
    /// An image's ThumbHash and its size, shown while it loads.
    #[serde(rename = "t", default, skip_serializing_if = "Option::is_none")]
    pub thumbhash: Option<String>,
    #[serde(rename = "w", default, skip_serializing_if = "Option::is_none")]
    pub width: Option<i64>,
    #[serde(rename = "h", default, skip_serializing_if = "Option::is_none")]
    pub height: Option<i64>,
}

impl Facts {
    /// The facts of a file named `name` with nothing else known.
    pub fn named(name: String) -> Facts {
        Facts {
            name,
            ..Facts::default()
        }
    }

    /// The placeholder, when all three parts are there.
    pub fn placeholder(self) -> Option<(String, i64, i64)> {
        let Facts {
            name: _,
            thumbhash,
            width,
            height,
        } = self;
        Some((thumbhash?, width?, height?))
    }
}

#[derive(Serialize, Deserialize)]
struct Kept {
    v: u8,
    #[serde(flatten)]
    facts: Facts,
}

const VERSION: u8 = 1;

/// The `media` key of one data key id, scoped to files.
#[derive(Clone)]
pub struct MediaKey {
    key_id: u32,
    key: Key,
}

impl MediaKey {
    fn of(ring: &Ring, key_id: u32, dek: &Key) -> MediaKey {
        MediaKey {
            key_id,
            key: ring.subkeys.get(key_id, dek, SCOPE),
        }
    }

    /// The stored active `media` key, read on the caller's connection; it never makes one.
    pub async fn stored_on(ring: &Ring, conn: &mut AnyConnection) -> anyhow::Result<Option<Self>> {
        Ok(ring
            .stored_data_key_on(conn, Purpose::Media)
            .await?
            .map(|(id, dek)| MediaKey::of(ring, id, &dek)))
    }

    /// The `media` key a record names, through the pool. `None` when it is not held.
    pub async fn named(db: &Db, key_id: u32) -> anyhow::Result<Option<Self>> {
        let ring = crate::db::ring(db);
        Ok(match ring.key_by_id(db, key_id).await? {
            Some((Purpose::Media, dek)) => Some(MediaKey::of(&ring, key_id, &dek)),
            _ => None,
        })
    }

    /// `named` on the caller's connection.
    pub async fn named_on(
        ring: &Ring,
        conn: &mut AnyConnection,
        key_id: u32,
    ) -> anyhow::Result<Option<Self>> {
        Ok(match ring.key_by_id_on(conn, key_id).await? {
            Some((Purpose::Media, dek)) => Some(MediaKey::of(ring, key_id, &dek)),
            _ => None,
        })
    }

    pub fn id(&self) -> u32 {
        self.key_id
    }

    /// The record of chunk `seq` of the `total` chunks of file `id`.
    pub fn seal_chunk(&self, id: &str, seq: u64, total: u64, plain: &[u8]) -> Vec<u8> {
        seal(
            self.key_id,
            &self.key,
            &chunk_aad(id, seq, total, self.key_id),
            plain,
        )
    }

    pub fn open_chunk(
        &self,
        id: &str,
        seq: u64,
        total: u64,
        record: &[u8],
    ) -> Result<Vec<u8>, CryptError> {
        open(&self.key, &chunk_aad(id, seq, total, self.key_id), record)
    }

    /// The record of `facts` about file `id`.
    pub fn seal_facts(&self, id: &str, facts: &Facts) -> Vec<u8> {
        let kept = serde_json::to_vec(&Kept {
            v: VERSION,
            facts: facts.clone(),
        })
        .unwrap_or_default();
        seal(self.key_id, &self.key, &facts_aad(id, self.key_id), &kept)
    }

    pub fn open_facts(&self, id: &str, record: &[u8]) -> Option<Facts> {
        let plain = open(&self.key, &facts_aad(id, self.key_id), record).ok()?;
        let Kept { v, facts } = serde_json::from_slice(&plain).ok()?;
        (v == VERSION).then_some(facts)
    }

    /// The sealed S3 object of file `id` holding `data`.
    pub fn seal_object(&self, id: &str, data: &[u8]) -> Vec<u8> {
        let total = chunks(data.len() as u64);
        let mut out = Vec::with_capacity(object_len(data.len() as u64) as usize);
        out.extend_from_slice(&[MAGIC, OBJECT]);
        out.extend_from_slice(&self.key_id.to_be_bytes());
        out.extend_from_slice(&(total as u32).to_be_bytes());
        for (seq, chunk) in data.chunks(CHUNK).enumerate() {
            let nonce: [u8; NONCE_LEN] = rand::random();
            let aad = chunk_aad(id, seq as u64, total, self.key_id);
            out.extend_from_slice(&nonce);
            out.extend_from_slice(&encrypt(&self.key, &nonce, &aad, chunk));
        }
        out
    }

    fn open_frame(
        &self,
        id: &str,
        seq: u64,
        total: u64,
        frame: &[u8],
    ) -> Result<Vec<u8>, CryptError> {
        let (nonce, sealed) = frame.split_at(NONCE_LEN);
        decrypt(
            &self.key,
            nonce,
            &chunk_aad(id, seq, total, self.key_id),
            sealed,
        )
    }
}

/// The key id and chunk count the first bytes of a sealed S3 object name.
pub fn object_header(bytes: &[u8]) -> Result<(u32, u64), CryptError> {
    let [MAGIC, OBJECT, a, b, c, d, e, f, g, h, ..] = *bytes else {
        return Err(CryptError::Format);
    };
    Ok((
        u32::from_be_bytes([a, b, c, d]),
        u64::from(u32::from_be_bytes([e, f, g, h])),
    ))
}

/// Opens a sealed S3 object of a file of a known size as its bytes arrive.
pub struct ObjectReader {
    id: String,
    size: u64,
    total: u64,
    key: MediaKey,
    /// The next chunk; `None` until the header is read.
    seq: Option<u64>,
    buf: Vec<u8>,
}

impl ObjectReader {
    pub fn new(id: &str, size: u64, key: MediaKey) -> ObjectReader {
        ObjectReader {
            id: id.to_string(),
            size,
            total: chunks(size),
            key,
            seq: None,
            buf: Vec::new(),
        }
    }

    /// Takes the next `bytes` of the object; returns the chunks they complete, in order.
    pub fn feed(&mut self, bytes: &[u8]) -> Result<Vec<Vec<u8>>, CryptError> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        let mut seq = match self.seq {
            Some(seq) => seq,
            None if self.buf.len() < OBJECT_HEADER => return Ok(out),
            None => {
                let (key_id, total) = object_header(&self.buf)?;
                if key_id != self.key.key_id || total != self.total {
                    return Err(CryptError::Format);
                }
                self.buf.drain(..OBJECT_HEADER);
                0
            }
        };
        loop {
            self.seq = Some(seq);
            if seq >= self.total {
                return match self.buf.is_empty() {
                    true => Ok(out),
                    false => Err(CryptError::Format),
                };
            }
            let want = chunk_len(self.size, seq) + FRAME_OVERHEAD;
            if self.buf.len() < want {
                return Ok(out);
            }
            let frame: Vec<u8> = self.buf.drain(..want).collect();
            out.push(self.key.open_frame(&self.id, seq, self.total, &frame)?);
            seq += 1;
        }
    }

    /// Whether the whole object arrived and nothing more.
    pub fn finished(&self) -> bool {
        self.seq == Some(self.total) && self.buf.is_empty()
    }
}
