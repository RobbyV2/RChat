use std::sync::Arc;

use super::*;

const SEC: Duration = Duration::from_secs(1);

#[test]
fn tokens_refill_and_cap() {
    let start = Instant::now();
    let policy = Policy::Tokens {
        burst: 4.0,
        per_sec: 1.0,
    };
    let keyed: Keyed = Keyed::new(policy, 10);
    let mut single = Single::new(policy, start);
    for _ in 0..4 {
        assert!(keyed.take("a", 1.0, start));
        assert!(single.take(1.0, start));
    }
    assert!(!keyed.take("a", 1.0, start));
    assert!(!single.take(1.0, start));
    assert!(keyed.take("b", 1.0, start), "each key has its own bucket");
    let later = start + SEC;
    assert!(keyed.take("a", 1.0, later));
    assert!(!keyed.take("a", 1.0, later));
    assert!(single.take(1.0, later));
    assert!(!single.take(1.0, later));
    let idle = start + 60 * SEC;
    assert_eq!(keyed.remaining("a", idle), 4.0);
    assert_eq!(single.remaining(idle), 4.0);
    assert_eq!((0..10).filter(|_| keyed.take("a", 1.0, idle)).count(), 4);
    assert_eq!((0..10).filter(|_| single.take(1.0, idle)).count(), 4);
    assert_eq!(
        Policy::every(5.0, Duration::from_millis(250)),
        Policy::Tokens {
            burst: 5.0,
            per_sec: 4.0
        }
    );
    assert_eq!(
        Policy::per_minute(30, 120),
        Policy::Tokens {
            burst: 30.0,
            per_sec: 2.0
        }
    );
}

#[test]
fn window_resets_after_its_length() {
    let start = Instant::now();
    let policy = Policy::Window {
        limit: 2,
        window: 60 * SEC,
    };
    let keyed: Keyed = Keyed::new(policy, 10);
    assert!(keyed.take("a", 1.0, start));
    assert!(keyed.take("a", 1.0, start + SEC));
    assert!(!keyed.take("a", 1.0, start + 59 * SEC));
    assert_eq!(keyed.remaining("a", start + 59 * SEC), 0.0);
    assert_eq!(keyed.remaining("a", start + 60 * SEC), 2.0);
    assert!(keyed.take("a", 1.0, start + 60 * SEC), "a new window");
    assert!(keyed.take("a", 1.0, start + 119 * SEC));
    assert!(!keyed.take("a", 1.0, start + 119 * SEC));
    let mut single = Single::new(policy, start);
    let first = start + 30 * SEC;
    assert!(single.take(1.0, first) && single.take(1.0, first));
    assert!(
        !single.take(1.0, start + 60 * SEC),
        "the window runs from its first use"
    );
    assert_eq!(
        single.ready_at(1.0, start + 60 * SEC),
        Some(first + 60 * SEC)
    );
    assert!(single.take(1.0, first + 60 * SEC));
    assert_eq!(
        single.ready_at(1.0, first + 60 * SEC),
        Some(first + 60 * SEC)
    );
}

#[test]
fn windows_count_per_key() {
    let start = Instant::now();
    let b: Keyed = Keyed::new(
        Policy::Window {
            limit: 2,
            window: 60 * SEC,
        },
        10,
    );
    assert!(b.take("a", 1.0, start));
    assert!(b.take("a", 1.0, start));
    assert!(!b.take("a", 1.0, start));
    assert!(b.remaining("a", start) < 1.0);
    assert!(b.take("b", 1.0, start));
    assert!(b.remaining("b", start) >= 1.0);
    let short: Keyed = Keyed::new(
        Policy::Window {
            limit: 1,
            window: Duration::from_millis(1),
        },
        10,
    );
    assert!(short.take("a", 1.0, start));
    assert!(short.take("a", 1.0, start + Duration::from_millis(5)));
}

#[test]
fn max_keys_evicts_the_oldest_key() {
    let start = Instant::now();
    let window: Keyed = Keyed::new(
        Policy::Window {
            limit: 1,
            window: 60 * SEC,
        },
        3,
    );
    for (n, key) in (0..).zip(["a", "b", "c"]) {
        assert!(window.take(key, 1.0, start + n * SEC));
    }
    assert!(
        window.take("d", 1.0, start + 3 * SEC),
        "a new key gets a place"
    );
    assert_eq!(window.len(), 3);
    assert!(
        !window.take("b", 1.0, start + 4 * SEC) && !window.take("c", 1.0, start + 4 * SEC),
        "younger keys are kept"
    );
    assert!(
        window.take("a", 1.0, start + 4 * SEC),
        "only the oldest made room"
    );
    let tokens: Keyed = Keyed::new(
        Policy::Tokens {
            burst: 1.0,
            per_sec: 0.001,
        },
        2,
    );
    assert!(tokens.take("a", 1.0, start));
    assert!(tokens.take("b", 1.0, start + SEC));
    assert!(!tokens.take("a", 1.0, start + 2 * SEC));
    assert!(tokens.take("c", 1.0, start + 3 * SEC));
    assert!(
        !tokens.take("a", 1.0, start + 4 * SEC),
        "a key in use is not the oldest"
    );
    assert!(
        tokens.take("b", 1.0, start + 4 * SEC),
        "the least recently used key made room"
    );
    for n in 0..1000 {
        window.spend(&format!("x{n}"), 1.0, start + 5 * SEC);
        tokens.take("a", 1.0, start + 5 * SEC + n * SEC);
    }
    assert!(queued(&window) <= 2 * 3 + 16 + 1);
    assert!(queued(&tokens) <= 2 * 2 + 16 + 1);
    let lru: Keyed = Keyed::new(
        Policy::Tokens {
            burst: 1.0,
            per_sec: 0.001,
        },
        2,
    );
    for (n, key) in (0..).zip(["a", "b", "a", "b"]) {
        lru.take(key, 1.0, start + n * SEC);
    }
    assert!(lru.take("c", 1.0, start + 4 * SEC));
    assert_eq!(lru.len(), 2, "a key used again keeps max_keys a bound");
    assert!(
        !lru.take("b", 1.0, start + 5 * SEC),
        "the least recently used key made room"
    );
    assert!(lru.take("a", 1.0, start + 5 * SEC));
}

#[test]
fn a_queue_stays_near_its_live_keys() {
    let b: Keyed = Keyed::new(Policy::per_minute(30, 600), 200_000);
    let start = Instant::now();
    for n in 0..20_000u64 {
        let key = format!("k{}", n % 5);
        b.take(&key, 1.0, start + Duration::from_millis(n));
        for (queued, live) in b.queued() {
            assert!(
                queued <= 2 * live + 16,
                "{queued} queued for {live} keys at take {n}"
            );
        }
    }
}

fn queued<K: Hash + Eq + Clone>(keyed: &Keyed<K>) -> usize {
    keyed.queued().iter().map(|(queued, _)| queued).sum()
}

#[test]
fn maps_with_room_for_many_keys_are_sharded_and_keep_max_keys_a_bound() {
    let policy = Policy::per_minute(1, 1);
    for (max_keys, shards) in [
        (1, 1),
        (10, 1),
        (2047, 1),
        (2048, 2),
        (10_000, 8),
        (100_000, 64),
        (1_000_000, 64),
    ] {
        let keyed: Keyed<u32> = Keyed::new(policy, max_keys);
        assert_eq!(keyed.shard_count(), shards, "{max_keys}");
    }
    let start = Instant::now();
    let keyed: Keyed<u32> = Keyed::new(policy, 10_000);
    for n in 0..50_000u32 {
        assert!(keyed.take(&n, 1.0, start + Duration::from_millis(u64::from(n))));
        assert!(keyed.len() <= 10_000);
    }
    assert_eq!(keyed.len(), 10_000, "every shard fills its share");
    let at = start + 50 * SEC;
    let kept = (40_000..50_000u32)
        .filter(|n| keyed.remaining(n, at) < 1.0)
        .count();
    assert!(
        kept > 9_500,
        "the keys used last are kept, {kept} of the last 10000"
    );
    assert!(
        (0..10_000u32).all(|n| keyed.remaining(&n, at) == 1.0),
        "the first keys made room"
    );
}

#[test]
fn a_sharded_map_changes_and_prunes_every_shard() {
    let start = Instant::now();
    let keyed: Keyed<u32> = Keyed::new(
        Policy::Tokens {
            burst: 2.0,
            per_sec: 1.0,
        },
        100_000,
    );
    for n in 0..1000 {
        assert!(keyed.take(&n, 2.0, start));
    }
    keyed.set_policy(Policy::Tokens {
        burst: 8.0,
        per_sec: 1.0,
    });
    assert_eq!(
        keyed.policy(),
        Policy::Tokens {
            burst: 8.0,
            per_sec: 1.0
        }
    );
    assert!(
        (0..1000).all(|n| keyed.remaining(&n, start) == 6.0),
        "every key is under the new policy"
    );
    keyed.prune(start + 60 * SEC);
    assert!(keyed.is_empty(), "every shard is pruned");
}

#[test]
fn uses_of_a_sharded_map_are_atomic_under_contention() {
    let start = Instant::now();
    let keyed: Arc<Keyed<u32>> = Arc::new(Keyed::new(
        Policy::Window {
            limit: 5,
            window: 60 * SEC,
        },
        100_000,
    ));
    let threads: Vec<_> = (0..16)
        .map(|_| {
            let keyed = keyed.clone();
            std::thread::spawn(move || {
                (0..20_000u32)
                    .filter(|n| keyed.take(&(n % 1000), 1.0, start))
                    .count()
            })
        })
        .collect();
    let won: usize = threads.into_iter().map(|t| t.join().expect("thread")).sum();
    assert_eq!(won, 5 * 1000, "each key gives exactly its limit");
}

#[test]
fn cost_above_one_spends_that_many() {
    let start = Instant::now();
    let policy = Policy::Tokens {
        burst: 10.0,
        per_sec: 2.0,
    };
    let keyed: Keyed = Keyed::new(policy, 10);
    assert!(keyed.take("a", 7.0, start));
    assert_eq!(keyed.remaining("a", start), 3.0);
    assert!(!keyed.take("a", 4.0, start), "more than is left");
    assert_eq!(keyed.remaining("a", start), 3.0, "a refusal takes nothing");
    assert!(keyed.take("a", 3.0, start));
    assert!(keyed.take("a", 4.0, start + 2 * SEC));
    let window: Keyed = Keyed::new(
        Policy::Window {
            limit: 5,
            window: 60 * SEC,
        },
        10,
    );
    assert!(window.take("a", 3.0, start));
    assert!(!window.take("a", 3.0, start));
    assert!(window.take("a", 2.0, start));
    let mut single = Single::new(policy, start);
    assert!(single.take(6.0, start));
    assert!(!single.take(5.0, start));
    assert_eq!(
        single.ready_at(5.0, start),
        Some(start + Duration::from_millis(500))
    );
    assert!(single.take(5.0, start + Duration::from_millis(500)));
}

#[test]
fn spending_past_empty_owes_at_most_a_full_bucket() {
    let start = Instant::now();
    let policy = Policy::Tokens {
        burst: 4.0,
        per_sec: 1.0,
    };
    let mut single = Single::new(policy, start);
    let left: Vec<f64> = (0..10).map(|_| single.spend(1.0, start)).collect();
    assert_eq!(
        left,
        [3.0, 2.0, 1.0, 0.0, -1.0, -2.0, -3.0, -4.0, -5.0, -5.0]
    );
    assert_eq!(single.remaining(start), -4.0);
    assert!(!single.take(1.0, start + 4 * SEC));
    assert!(single.take(1.0, start + 5 * SEC));
    let keyed: Keyed = Keyed::new(
        Policy::Window {
            limit: 2,
            window: 60 * SEC,
        },
        10,
    );
    for _ in 0..5 {
        keyed.spend("a", 1.0, start);
    }
    assert_eq!(keyed.remaining("a", start), -2.0);
    assert_eq!(keyed.remaining("a", start + 60 * SEC), 2.0);
}

#[test]
fn reserved_uses_are_atomic_and_can_be_refunded() {
    let start = Instant::now();
    let keyed: Arc<Keyed> = Arc::new(Keyed::new(
        Policy::Window {
            limit: 5,
            window: 60 * SEC,
        },
        10,
    ));
    let threads: Vec<_> = (0..32)
        .map(|_| {
            let keyed = keyed.clone();
            std::thread::spawn(move || keyed.reserve("k", 1.0, start))
        })
        .collect();
    let won: Vec<Instant> = threads
        .into_iter()
        .filter_map(|t| t.join().expect("thread"))
        .collect();
    assert_eq!(won.len(), 5, "no more than the limit under contention");
    assert!(keyed.reserve("k", 1.0, start).is_none());
    keyed.refund("k", 1.0, won[0]);
    assert_eq!(keyed.used("k"), Some(4.0));
    assert!(
        keyed.reserve("k", 1.0, start).is_some(),
        "a refund gives one use back"
    );
    assert!(keyed.reserve("k", 1.0, start).is_none());
    let next = keyed
        .reserve("k", 1.0, start + 60 * SEC)
        .expect("a new window");
    keyed.refund("k", 1.0, won[0]);
    assert_eq!(
        keyed.used("k"),
        Some(1.0),
        "an old window's refund is ignored"
    );
    keyed.refund("k", 1.0, next);
    assert_eq!(keyed.used("k"), Some(0.0));
    keyed.refund("k", 1.0, next);
    assert_eq!(
        keyed.used("k"),
        Some(0.0),
        "a refund never lifts a window past its limit"
    );
}

#[test]
fn a_token_given_back_can_be_taken_again_up_to_the_burst() {
    let b: Keyed = Keyed::new(Policy::per_minute(3, 60), 10);
    let t0 = Instant::now();
    let mut stamps = Vec::new();
    for n in 0..3 {
        stamps.push(b.reserve("a", 1.0, t0).unwrap_or_else(|| panic!("{n}")));
    }
    assert!(!b.take("a", 1.0, t0));
    b.refund("a", 1.0, stamps[0]);
    assert!(b.take("a", 1.0, t0), "the token came back");
    assert!(!b.take("a", 1.0, t0), "only one");
    let later = b.reserve("a", 1.0, t0 + SEC).expect("one refilled");
    b.refund("a", 1.0, stamps[1]);
    assert!(
        b.take("a", 1.0, t0 + SEC),
        "a token comes back after later takes too"
    );
    for _ in 0..10 {
        b.refund("a", 1.0, later);
    }
    let taken = (0..10).filter(|_| b.take("a", 1.0, t0 + SEC)).count();
    assert_eq!(taken, 3, "a bucket holds at most its burst");
    b.refund("b", 1.0, t0);
    let fresh = (0..10).filter(|_| b.take("b", 1.0, t0)).count();
    assert_eq!(fresh, 3, "a key without a bucket gains nothing");
}

#[test]
fn a_held_use_goes_back_unless_it_is_spent() {
    let t0 = Instant::now();
    let b: Keyed = Keyed::new(Policy::per_minute(2, 60), 10);
    let under = b.under(Policy::per_minute(2, 60));
    let dropped = under.hold("a".to_string(), 1.0, t0).expect("first");
    let kept = under.hold("a".to_string(), 1.0, t0).expect("second");
    assert!(
        under.hold("a".to_string(), 1.0, t0).is_err(),
        "both are held"
    );
    drop(dropped);
    assert_eq!(b.used("a"), Some(1.0), "a dropped use goes back");
    kept.spend();
    assert_eq!(b.used("a"), Some(1.0), "a spent use stays");
    let window = Policy::Window {
        limit: 1,
        window: 60 * SEC,
    };
    let windows: Keyed = Keyed::new(window, 10);
    let late = windows.under(window).hold("w".to_string(), 1.0, t0);
    assert!(windows.take("w", 1.0, t0 + 60 * SEC), "a new window");
    drop(late);
    assert_eq!(
        windows.used("w"),
        Some(1.0),
        "a use held in a window that ended gives nothing back"
    );
}

#[test]
fn a_bucket_says_how_long_to_wait() {
    let t0 = Instant::now();
    let b: Keyed = Keyed::new(Policy::per_minute(5, 60), 10);
    for n in 0..5 {
        assert!(b.take("a", 1.0, t0), "{n}");
    }
    assert!(!b.take("a", 1.0, t0));
    assert_eq!(b.wait("a", 1.0, t0), SEC);
    assert_eq!(
        b.wait("b", 1.0, t0),
        Duration::ZERO,
        "a fresh key waits for nothing"
    );
    let half = t0 + Duration::from_millis(500);
    assert_eq!(b.wait("a", 1.0, half), Duration::from_millis(500));
    assert!(b.take("a", 1.0, t0 + SEC), "one came back");
    assert!(!b.take("a", 1.0, t0 + SEC));
    let later = t0 + 3600 * SEC;
    assert_eq!((0..20).filter(|_| b.take("a", 1.0, later)).count(), 5);
    assert!(
        !b.take("a", 1.0, t0),
        "a clock that steps back gives nothing"
    );
    assert_eq!(b.wait("a", 1.0, t0), SEC + 3600 * SEC);
    let window: Keyed = Keyed::new(
        Policy::Window {
            limit: 1,
            window: 60 * SEC,
        },
        10,
    );
    assert!(window.take("a", 1.0, t0));
    assert_eq!(window.wait("a", 1.0, t0 + 59 * SEC), SEC);
    assert_eq!(window.wait("a", 1.0, t0 + 60 * SEC), Duration::ZERO);
    let stopped: Keyed = Keyed::new(
        Policy::Tokens {
            burst: 1.0,
            per_sec: 0.0,
        },
        10,
    );
    assert!(stopped.take("a", 1.0, t0));
    assert_eq!(stopped.wait("a", 1.0, t0), Duration::MAX, "never");
    let quick: Keyed = Keyed::new(Policy::per_minute(1, 10_000), 10);
    assert!(quick.take("k", 1.0, Instant::now()));
    assert!(!quick.take("k", 1.0, Instant::now()));
    assert!(
        quick.take("k", 1.0, Instant::now() + Duration::from_millis(20)),
        "and again 20 ms later"
    );
}

#[test]
fn a_policy_given_with_the_use_counts_on_the_same_buckets() {
    let t0 = Instant::now();
    let b: Keyed = Keyed::new(
        Policy::Window {
            limit: u32::MAX,
            window: 60 * SEC,
        },
        10,
    );
    let two = Policy::Window {
        limit: 2,
        window: 60 * SEC,
    };
    let first = b.under(two).reserve("a", 1.0, t0).expect("one");
    assert!(b.under(two).take("a", 1.0, t0));
    assert!(
        !b.under(two).take("a", 1.0, t0),
        "two is the limit asked for"
    );
    let three = Policy::Window {
        limit: 3,
        window: 60 * SEC,
    };
    assert!(
        b.under(three).take("a", 1.0, t0),
        "the next use can ask for more"
    );
    assert!(
        b.under(two).take("b", 1.0, t0),
        "each key has its own count"
    );
    b.under(two).refund("a", 1.0, first);
    assert_eq!(b.used("a"), Some(2.0));
    assert_eq!(b.under(two).wait("a", 1.0, t0 + 59 * SEC), SEC);
    assert_eq!(b.under(two).remaining("a", t0), 0.0);
    assert!(b.take("a", 1.0, t0), "the stored policy holds more");
    let tokens: Keyed = Keyed::new(Policy::per_minute(1, 1), 10);
    let wide = Policy::per_minute(30, 60);
    assert_eq!(
        (0..40)
            .filter(|_| tokens.under(wide).take("k", 1.0, t0))
            .count(),
        30
    );
    assert_eq!(tokens.under(wide).wait("k", 1.0, t0), SEC);
    let narrow = Policy::per_minute(5, 60);
    assert_eq!(
        (0..10)
            .filter(|_| tokens.under(narrow).take("n", 1.0, t0))
            .count(),
        5,
        "a smaller burst holds less"
    );
}

#[test]
fn full_keys_are_pruned_and_policies_change_in_place() {
    let start = Instant::now();
    let keyed: Keyed<u32> = Keyed::new(
        Policy::Tokens {
            burst: 2.0,
            per_sec: 1.0,
        },
        10,
    );
    assert!(keyed.take(&1, 2.0, start));
    assert!(keyed.take(&2, 1.0, start));
    assert_eq!(keyed.remaining(&3, start), 2.0, "an unknown key is full");
    assert_eq!(keyed.len(), 2, "reading adds no key");
    keyed.prune(start + SEC);
    assert_eq!(keyed.len(), 1, "a refilled key is dropped");
    keyed.set_policy(Policy::Tokens {
        burst: 8.0,
        per_sec: 1.0,
    });
    assert_eq!(keyed.remaining(&1, start + SEC), 7.0);
    assert_eq!(keyed.remaining(&9, start), 8.0);
    keyed.prune(start + 60 * SEC);
    assert!(keyed.is_empty());
}
