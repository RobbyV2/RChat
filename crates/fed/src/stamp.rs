use std::collections::HashMap;

use sha2::{Digest, Sha256};

use crate::limits::stamp::SEEN_FOR;
use crate::pb::CallHead;

pub const STAMP_TAG: &[u8] = b"rchat-fed-stamp1\0";
const PUZZLE_TAG: &[u8] = b"rchat-pow1";

pub fn stamp_seed(aud: &str, iss: &str, jti: &[u8], iat: i64) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(STAMP_TAG);
    hash.update(aud.as_bytes());
    hash.update([0]);
    hash.update(iss.as_bytes());
    hash.update([0]);
    hash.update(jti);
    hash.update(iat.to_be_bytes());
    hash.finalize().into()
}

pub fn target(k: usize, work: u64) -> u64 {
    let k = k as u128;
    let scaled = (k << 64) / u128::from(work).max(k).max(1);
    u64::try_from(scaled).unwrap_or(u64::MAX).max(1)
}

fn wins(seed: &[u8; 32], puzzle: usize, nonce: u64, target: u64) -> bool {
    let mut hash = Sha256::new();
    hash.update(PUZZLE_TAG);
    hash.update(seed);
    hash.update([puzzle as u8]);
    hash.update(nonce.to_le_bytes());
    let digest = hash.finalize();
    let mut first = [0u8; 8];
    first.copy_from_slice(&digest[..8]);
    u64::from_be_bytes(first) < target
}

pub fn solve(seed: &[u8; 32], k: usize, work: u64) -> Vec<u8> {
    let target = target(k, work);
    (0..k)
        .flat_map(|puzzle| {
            let nonce = (0u64..)
                .find(|nonce| wins(seed, puzzle, *nonce, target))
                .unwrap_or(u64::MAX);
            nonce.to_le_bytes()
        })
        .collect()
}

pub fn stamp_for(aud: &str, iss: &str, jti: &[u8], iat: i64, work: u64, k: usize) -> Vec<u8> {
    solve(&stamp_seed(aud, iss, jti, iat), k, work)
}

pub fn stamp_ok(head: &CallHead, work: u64, k: usize) -> bool {
    if k > 255 || head.stamp.len() != 8 * k {
        return false;
    }
    let seed = stamp_seed(&head.aud, &head.iss, &head.jti, head.iat);
    let target = target(k, work);
    let (nonces, _) = head.stamp.as_chunks::<8>();
    nonces
        .iter()
        .enumerate()
        .all(|(puzzle, nonce)| wins(&seed, puzzle, u64::from_le_bytes(*nonce), target))
}

#[derive(Clone, Debug, Default)]
pub struct StampSeen {
    rows: HashMap<String, i64>,
}

impl StampSeen {
    pub fn once(&mut self, jti: &str, now: i64) -> bool {
        self.rows.retain(|_, at| *at > now - SEEN_FOR);
        if self.rows.contains_key(jti) {
            return false;
        }
        self.rows.insert(jti.to_string(), now);
        true
    }
}
