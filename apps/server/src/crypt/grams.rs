//! Keyed search grams: the three-character runs of encrypted message text, each hashed with the
//! search key of its channel, so the search index holds no text.

use std::collections::BTreeSet;

use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;

use super::body::Scope;
use super::ring::Ring;
use super::{Key, Purpose};
use crate::db::Db;

/// Distinct grams a document keeps as terms on SQLite; past it the terms fold into this many
/// buckets.
pub const BUCKETS: usize = 512;
/// Characters of a query its grams come from on Postgres.
pub const NEEDLE_CHARS: usize = 32;

/// Text as search compares it: each character lowercased on its own, so the fold of joined
/// texts is the join of their folds.
pub fn fold(text: &str) -> String {
    text.chars().flat_map(char::to_lowercase).collect()
}

/// The three-character runs of folded text, in order, repeats included.
pub fn windows(folded: &str) -> Vec<String> {
    let chars: Vec<char> = folded.chars().collect();
    chars.windows(3).map(|w| w.iter().collect()).collect()
}

/// Whether `body` holds `query`, compared folded.
pub fn found(body: &str, query: &str) -> bool {
    fold(body).contains(&fold(query))
}

/// The search key of one channel.
pub struct Grams {
    key: Key,
}

impl Grams {
    pub fn new(key: Key) -> Grams {
        Grams { key }
    }

    /// The keyer of `scope` under the stored `search` key, on the caller's connection. `None`
    /// for a DM, which is never searched, and while the site has no search key.
    pub async fn of_on(
        ring: &Ring,
        conn: &mut sqlx::AnyConnection,
        scope: Scope,
    ) -> anyhow::Result<Option<Grams>> {
        let Scope::Channel(_) = scope else {
            return Ok(None);
        };
        let Some((id, dek)) = ring.stored_data_key_on(conn, Purpose::Search).await? else {
            return Ok(None);
        };
        Ok(Some(Grams::new(ring.subkeys.get(id, &dek, &scope.key()))))
    }

    /// The keyers of `channels` under the stored `search` key. Empty while the site has none.
    pub async fn of_channels(
        db: &Db,
        channels: impl IntoIterator<Item = i64>,
    ) -> anyhow::Result<Vec<(i64, Grams)>> {
        let ring = crate::db::ring(db);
        let Some((id, dek)) = ring.stored_data_key(db, Purpose::Search).await? else {
            return Ok(Vec::new());
        };
        Ok(channels
            .into_iter()
            .map(|channel| {
                let scope = Scope::Channel(channel).key();
                (channel, Grams::new(ring.subkeys.get(id, &dek, &scope)))
            })
            .collect())
    }

    /// The gram of one run: the first four bytes of `HMAC-SHA256(key, run)` as a big-endian
    /// number, in 31 bits.
    pub fn gram(&self, run: &str) -> i32 {
        let mut mac =
            <Hmac<Sha256> as KeyInit>::new_from_slice(&self.key[..]).expect("hmac takes any key");
        mac.update(run.as_bytes());
        let bytes = mac.finalize().into_bytes();
        (u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) & 0x7fff_ffff) as i32
    }

    /// The distinct grams of a document, in order.
    pub fn document(&self, text: &str) -> Vec<i32> {
        windows(&fold(text))
            .iter()
            .map(|run| self.gram(run))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    }

    /// The grams every document holding `query` holds, from its first `NEEDLE_CHARS`
    /// characters. Empty for a query shorter than a run.
    pub fn needle(&self, query: &str) -> Vec<i32> {
        let head: String = fold(query).chars().take(NEEDLE_CHARS).collect();
        self.document(&head)
    }
}

/// The SQLite term of a gram: `k` and 8 hex digits.
pub fn term(gram: i32) -> String {
    format!("k{gram:08x}")
}

/// The SQLite bucket term of a gram, for documents with more than `BUCKETS` grams.
pub fn bucket(gram: i32) -> String {
    format!("k#{:03x}", gram as u32 as usize % BUCKETS)
}

/// The SQLite terms of a document's grams: one per gram, or past `BUCKETS` grams one per
/// bucket they fall in.
pub fn postings(grams: &[i32]) -> Vec<String> {
    match grams.len() > BUCKETS {
        true => grams
            .iter()
            .map(|g| bucket(*g))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect(),
        false => grams.iter().map(|g| term(*g)).collect(),
    }
}

/// Grams as Postgres reads an `integer[]`: `{1,2,3}`.
pub fn array(grams: &[i32]) -> String {
    let list: Vec<String> = grams.iter().map(i32::to_string).collect();
    format!("{{{}}}", list.join(","))
}
