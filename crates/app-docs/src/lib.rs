use std::fmt;
use std::panic::{AssertUnwindSafe, catch_unwind};
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{Doc, GetString, ReadTxn, StateVector, Transact, Update};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    /// The bytes are not an update this crate takes. The document is as it was.
    Update,
    /// The bytes are not a state vector.
    StateVector,
    /// The document can no longer be relied on. Load it again from its stored updates.
    Broken,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Error::Update => "not a document update",
            Error::StateVector => "not a state vector",
            Error::Broken => "the document must be loaded again",
        })
    }
}

impl std::error::Error for Error {}

// The CRDT library panics on some bytes it should refuse. A panic never leaves this crate.
fn guard<T>(f: impl FnOnce() -> T) -> Option<T> {
    catch_unwind(AssertUnwindSafe(f)).ok()
}

// An update is taken only when its own encoding reads back: one that does not can wait inside a
// document for what it builds on, and then no state of that document can be encoded.
fn decode(bytes: &[u8]) -> Result<Update, Error> {
    if !plausible(bytes) {
        return Err(Error::Update);
    }
    let read = |bytes: &[u8]| guard(|| Update::decode_v1(bytes).ok()).flatten();
    let update = read(bytes).ok_or(Error::Update)?;
    let again = guard(|| update.encode_v1()).ok_or(Error::Update)?;
    read(&again).map(|_| update).ok_or(Error::Update)
}

fn read_uint(bytes: &[u8], at: &mut usize) -> Option<u64> {
    let mut n = 0u64;
    for shift in (0..64).step_by(7) {
        let byte = *bytes.get(*at)?;
        *at += 1;
        n |= u64::from(byte & 0x7f) << shift;
        if byte < 0x80 {
            return Some(n);
        }
    }
    None
}

// The library reserves room for every client and block an update declares before it reads them.
// An update cannot hold more of either than it has bytes.
fn plausible(bytes: &[u8]) -> bool {
    let mut at = 0;
    let most = bytes.len() as u64;
    match read_uint(bytes, &mut at) {
        Some(0) => true,
        Some(clients) => {
            clients <= most && read_uint(bytes, &mut at).is_some_and(|blocks| blocks <= most)
        }
        None => false,
    }
}

fn write_uint(out: &mut Vec<u8>, mut n: u64) {
    while n >= 0x80 {
        out.push(n as u8 | 0x80);
        n >>= 7;
    }
    out.push(n as u8);
}

/// One document field of an app record, as the server holds it: the client library's updates
/// applied in the order they were accepted. The server never edits a document itself.
#[derive(Default)]
pub struct Document {
    doc: Doc,
    broken: bool,
}

impl Document {
    pub fn new() -> Self {
        Self::default()
    }

    /// A document from its stored updates, oldest first (the first may be a compacted state).
    pub fn load<I, B>(updates: I) -> Result<Self, Error>
    where
        I: IntoIterator<Item = B>,
        B: AsRef<[u8]>,
    {
        let mut doc = Self::new();
        for update in updates {
            doc.apply(update.as_ref())?;
        }
        Ok(doc)
    }

    fn read<T>(&self, f: impl FnOnce(&Doc) -> T) -> Result<T, Error> {
        match self.broken {
            true => Err(Error::Broken),
            false => guard(|| f(&self.doc)).ok_or(Error::Broken),
        }
    }

    /// Applies one update. An update that builds on one not yet applied is held until that one
    /// arrives. One the library gives up on part way leaves the document broken.
    pub fn apply(&mut self, update: &[u8]) -> Result<(), Error> {
        if self.broken {
            return Err(Error::Broken);
        }
        let update = decode(update)?;
        match guard(|| self.doc.transact_mut().apply_update(update)) {
            Some(Ok(())) => Ok(()),
            Some(Err(_)) | None => {
                self.broken = true;
                Err(Error::Broken)
            }
        }
    }

    /// The whole document as one update the client library reads. Storing it in place of the
    /// updates applied so far is compaction. The bytes are the client library's own for text; for
    /// other content they can differ in order, so compare documents by `state_vector`.
    pub fn compact(&self) -> Result<Vec<u8>, Error> {
        self.read(|doc| {
            doc.transact()
                .encode_state_as_update_v1(&StateVector::default())
        })
    }

    /// What this document holds, in the client library's bytes: for a reader to send back, and
    /// to mark where a saved version ends.
    pub fn state_vector(&self) -> Result<Vec<u8>, Error> {
        let vector = self.read(|doc| doc.transact().state_vector())?;
        let mut clocks: Vec<(u64, u32)> = vector
            .iter()
            .filter(|(_, clock)| **clock > 0)
            .map(|(id, clock)| (id.get(), *clock))
            .collect();
        clocks.sort_unstable_by_key(|(client, _)| std::cmp::Reverse(*client));
        let mut out = Vec::new();
        write_uint(&mut out, clocks.len() as u64);
        for (client, clock) in clocks {
            write_uint(&mut out, client);
            write_uint(&mut out, clock.into());
        }
        Ok(out)
    }

    /// The update that brings a reader at `state_vector` up to this document.
    pub fn state_since(&self, state_vector: &[u8]) -> Result<Vec<u8>, Error> {
        let clients = read_uint(state_vector, &mut 0).ok_or(Error::StateVector)?;
        if clients > state_vector.len() as u64 {
            return Err(Error::StateVector);
        }
        let vector = guard(|| StateVector::decode_v1(state_vector).ok())
            .flatten()
            .ok_or(Error::StateVector)?;
        self.read(|doc| doc.transact().encode_state_as_update_v1(&vector))
    }

    /// The bytes of the current content, which the size limit counts.
    pub fn size(&self) -> Result<usize, Error> {
        self.compact().map(|state| state.len())
    }

    /// The text under a root name, without marks or embeds. Empty when the root holds no text.
    pub fn plain_text(&self, root: &str) -> Result<String, Error> {
        self.read(|doc| {
            let txn = doc.transact();
            txn.get_text(root)
                .map(|text| text.get_string(&txn))
                .unwrap_or_default()
        })
    }
}

/// Two updates as one that leaves the same document, for folding a saved version into the next.
/// Refused when the two cannot be told apart from a broken update, as when they disagree about
/// the same edit.
pub fn merge(a: &[u8], b: &[u8]) -> Result<Vec<u8>, Error> {
    decode(a)?;
    decode(b)?;
    let merged = guard(|| yrs::merge_updates_v1([a, b]).ok())
        .flatten()
        .ok_or(Error::Update)?;
    decode(&merged).map(|_| merged)
}
