use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};

use crate::K_MAX;
use crate::puzzle::solve_chunk;

/// Tries a thread makes between two looks at `cancel`, and between two progress calls.
pub const CHUNK: u64 = 1 << 16;
const THREADS_MAX: usize = 256;

/// Totals of a running solve, as one of its threads saw them after a chunk.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Progress {
    pub solved: u32,
    pub tries: u64,
}

/// Solves the sub-puzzles in order on `threads` threads (at least 1): thread `j` tries the
/// nonces from `j * 2^56` up, and the first winner of a sub-puzzle moves every thread to the
/// next one. `None` when `cancel` was set before the last sub-puzzle fell, or `k` is over 64.
pub fn solve_parallel(
    seed: &[u8; 32],
    k: u32,
    target: u64,
    threads: usize,
    progress: impl Fn(Progress) + Sync,
    cancel: &AtomicBool,
) -> Option<Vec<u64>> {
    if k > K_MAX {
        return None;
    }
    let solved = AtomicU32::new(0);
    let tries = AtomicU64::new(0);
    let nonces: Vec<AtomicU64> = (0..k).map(|_| AtomicU64::new(0)).collect();
    std::thread::scope(|s| {
        for j in 0..threads.clamp(1, THREADS_MAX) as u64 {
            let (solved, tries, nonces, progress) = (&solved, &tries, &nonces, &progress);
            s.spawn(move || {
                let (mut sub, mut at) = (0, 0u64);
                loop {
                    let now = solved.load(Ordering::SeqCst);
                    if now >= k || cancel.load(Ordering::SeqCst) {
                        break;
                    }
                    if now != sub {
                        (sub, at) = (now, 0);
                    }
                    let start = (j << 56) + at;
                    let hit = solve_chunk(seed, sub as u8, target, start, CHUNK);
                    let tried = hit.map_or(CHUNK, |n| n - start + 1);
                    at += tried;
                    let total = tries.fetch_add(tried, Ordering::SeqCst) + tried;
                    if let Some(n) = hit
                        && solved
                            .compare_exchange(sub, sub + 1, Ordering::SeqCst, Ordering::SeqCst)
                            .is_ok()
                    {
                        nonces[sub as usize].store(n, Ordering::SeqCst);
                    }
                    progress(Progress {
                        solved: solved.load(Ordering::SeqCst),
                        tries: total,
                    });
                }
            });
        }
    });
    (solved.into_inner() >= k).then(|| nonces.into_iter().map(AtomicU64::into_inner).collect())
}
