use sha2::{Digest, Sha256};

/// 10 bytes, so one try hashes 10 + 32 + 1 + 8 = 51 bytes: one SHA-256 compression.
pub const DOMAIN: &[u8; 10] = b"rchat-pow1";

/// SHA-256(DOMAIN || seed || sub || nonce as 8 bytes little endian).
pub fn puzzle_hash(seed: &[u8; 32], sub: u8, nonce: u64) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(DOMAIN);
    h.update(seed);
    h.update([sub]);
    h.update(nonce.to_le_bytes());
    h.finalize().into()
}

/// The first 8 bytes of a hash, big endian.
pub fn value(hash: &[u8; 32]) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&hash[..8]);
    u64::from_be_bytes(b)
}

pub fn wins(seed: &[u8; 32], sub: u8, nonce: u64, target: u64) -> bool {
    value(&puzzle_hash(seed, sub, nonce)) < target
}

/// Tries `count` nonces of sub-puzzle `sub` from `start`. The first winner, if any.
pub fn solve_chunk(seed: &[u8; 32], sub: u8, target: u64, start: u64, count: u64) -> Option<u64> {
    (start..start.saturating_add(count)).find(|n| wins(seed, sub, *n, target))
}
