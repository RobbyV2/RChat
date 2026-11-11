use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use rchat_pow::*;
use serde_json::Value;

fn seed() -> [u8; 32] {
    seed_of("c1.1.solve")
}

fn vectors() -> Value {
    serde_json::from_str(include_str!("vectors.json")).unwrap()
}

#[test]
fn every_thread_count_gives_a_valid_solution() {
    let (k, target) = (16, target_for(16, 1 << 16));
    for threads in [1, 2, 8] {
        let cancel = AtomicBool::new(false);
        let nonces = solve_parallel(&seed(), k, target, threads, |_| {}, &cancel).expect("solved");
        assert!(verify(&seed(), k, target, &nonces), "{threads} threads");
        assert!(
            nonces.iter().all(|n| (n >> 56) < threads as u64),
            "worker j searches from j * 2^56"
        );
    }
}

#[test]
fn threads_search_different_nonce_ranges() {
    let (k, target) = (16, target_for(16, 1 << 18));
    let cancel = AtomicBool::new(false);
    let nonces = solve_parallel(&seed(), k, target, 4, |_| {}, &cancel).unwrap();
    assert!(verify(&seed(), k, target, &nonces));
    assert!(
        nonces.iter().any(|n| n >> 56 != 0),
        "16 winners all from the first thread: {nonces:?}"
    );
}

#[test]
fn one_thread_finds_the_smallest_winners() {
    let v = vectors();
    let seed = seed_of(v["challenge"].as_str().unwrap());
    let target = v["target"].as_str().unwrap().parse().unwrap();
    let cancel = AtomicBool::new(false);
    let nonces = solve_parallel(&seed, 4, target, 1, |_| {}, &cancel).unwrap();
    assert_eq!(encode_nonces(&nonces), v["nonces_wire"].as_str().unwrap());
    assert_eq!(nonces, solve(&seed, 4, target).0);
}

#[test]
fn progress_reaches_k_and_counts_every_try() {
    let (k, target) = (16, target_for(16, 1 << 16));
    for threads in [1, 3] {
        let seen = Mutex::new(Vec::new());
        let cancel = AtomicBool::new(false);
        let nonces = solve_parallel(
            &seed(),
            k,
            target,
            threads,
            |p| seen.lock().unwrap().push(p),
            &cancel,
        )
        .unwrap();
        let seen = seen.into_inner().unwrap();
        assert_eq!(seen.iter().map(|p| p.solved).max(), Some(k));
        assert!(seen.iter().all(|p| p.solved <= k && p.tries > 0));
        let tries = seen.iter().map(|p| p.tries).max().unwrap();
        let least: u64 = nonces.iter().map(|n| (n & ((1 << 56) - 1)) + 1).sum();
        assert!(
            tries >= least,
            "{tries} tries for winners that need {least}"
        );
        if threads == 1 {
            assert_eq!(tries, solve(&seed(), k, target).1);
            assert!(
                seen.windows(2)
                    .all(|w| w[0].solved <= w[1].solved && w[0].tries <= w[1].tries)
            );
        }
    }
}

#[test]
fn cancel_stops_every_thread_within_one_chunk() {
    let cancel = AtomicBool::new(false);
    let tries = AtomicU64::new(0);
    let out = solve_parallel(
        &seed(),
        16,
        1,
        4,
        |p| {
            tries.fetch_max(p.tries, Ordering::SeqCst);
            cancel.store(true, Ordering::SeqCst);
        },
        &cancel,
    );
    assert_eq!(out, None);
    let tries = tries.load(Ordering::SeqCst);
    assert!(
        (CHUNK..=4 * CHUNK).contains(&tries),
        "{tries} tries after cancel"
    );
}

#[test]
fn a_cancelled_solve_does_no_work() {
    let cancel = AtomicBool::new(true);
    let calls = AtomicU64::new(0);
    let out = solve_parallel(
        &seed(),
        4,
        u64::MAX,
        2,
        |_| {
            calls.fetch_add(1, Ordering::SeqCst);
        },
        &cancel,
    );
    assert_eq!(out, None);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn sub_puzzle_counts_outside_the_range() {
    let cancel = AtomicBool::new(false);
    assert_eq!(
        solve_parallel(&seed(), 0, 1, 2, |_| {}, &cancel),
        Some(vec![])
    );
    assert_eq!(
        solve_parallel(&seed(), K_MAX + 1, u64::MAX, 2, |_| {}, &cancel),
        None
    );
    let all = solve_parallel(&seed(), K_MAX, u64::MAX, 0, |_| {}, &cancel).unwrap();
    assert_eq!(all, vec![0; K_MAX as usize], "no threads asked means one");
}
