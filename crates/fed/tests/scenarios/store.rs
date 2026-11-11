use rchat_fed::health::{Dir, Event, Host, StrikeWhy, fresh, step};
use rchat_fed::levels::Service;
use rchat_fed::store::{Applied, ApplyError, HostStore, MemoryStore, RETRY_MAX, Row, apply_cas};

use crate::support::{T0, hello, in_ok, kids, ours, said, strike_on};

const B: &str = "b.example";

fn setup() -> MemoryStore {
    let mut db = MemoryStore::default();
    let host = step(&fresh(B, None), &said(hello(), T0), T0, &ours());
    db.put(B, Row { rev: 1, host });
    db
}

fn out_fail() -> Event {
    Event::OutFail {
        svc: Service::Letters,
        unauthenticated: false,
        their_now: None,
    }
}

fn overwrite(db: &mut MemoryStore, e: &Event, now: i64, cached: &Row) {
    let rev = db.read(B).map_or(0, |row| row.rev);
    let host = step(&cached.host, e, now, &ours());
    db.put(B, Row { rev: rev + 1, host });
}

fn paused(h: &Host, svc: Service) -> bool {
    h.pauses.iter().any(|(key, _)| *key == (svc, Dir::In))
}

#[test]
fn a_stale_whole_record_save_erases_a_pending_identity_question() {
    let mut db = setup();
    let copy1 = db.read(B).unwrap();
    let copy2 = db.read(B).unwrap();
    overwrite(&mut db, &in_ok("kEvil"), T0 + 1, &copy1);
    assert_eq!(
        db.read(B).unwrap().host.pending_keys,
        Some(kids(&["kEvil"]))
    );
    overwrite(&mut db, &out_fail(), T0 + 2, &copy2);
    assert_eq!(db.read(B).unwrap().host.pending_keys, None);
}

#[test]
fn compare_and_set_keeps_both_copies_changes() {
    let mut db = setup();
    let copy1 = db.read(B);
    let copy2 = db.read(B);
    let ours = ours();
    assert_eq!(
        apply_cas(&mut db, B, &in_ok("kEvil"), T0 + 1, &ours, copy1),
        Ok(Applied {
            writes: 1,
            retries: 0
        })
    );
    assert_eq!(
        apply_cas(&mut db, B, &out_fail(), T0 + 2, &ours, copy2),
        Ok(Applied {
            writes: 1,
            retries: 1
        })
    );
    let row = db.read(B).unwrap();
    assert_eq!(row.rev, 3);
    assert_eq!(row.host.pending_keys, Some(kids(&["kEvil"])));
    assert_eq!(row.host.circuit.fails, 1);
}

#[test]
fn concurrent_strikes_keep_counting_no_lost_doubling() {
    let mut db = setup();
    let ours = ours();
    for i in 0..10 {
        let stale = db.read(B);
        let letters = strike_on(Service::Letters, StrikeWhy::Malformed, "kB");
        let profiles = strike_on(Service::Profiles, StrikeWhy::Malformed, "kB");
        apply_cas(&mut db, B, &letters, T0 + 10 + i, &ours, None).unwrap();
        apply_cas(&mut db, B, &profiles, T0 + 10 + i, &ours, stale).unwrap();
    }
    let host = db.read(B).unwrap().host;
    assert!(paused(&host, Service::Letters));
    assert!(paused(&host, Service::Profiles));
}

#[test]
fn a_hundred_ordinary_calls_over_100_seconds_write_the_host_row_at_most_once() {
    let mut db = setup();
    let ours = ours();
    let writes = |db: &mut MemoryStore, from: i64, to: i64| {
        (from..=to)
            .map(|t| {
                apply_cas(db, B, &in_ok("kB"), T0 + t, &ours, None)
                    .unwrap()
                    .writes
            })
            .sum::<u32>()
    };
    assert!(writes(&mut db, 1, 100) <= 1);
    let rev = db.read(B).unwrap().rev;
    assert_eq!(writes(&mut db, 101, 200), 0);
    assert_eq!(db.read(B).unwrap().rev, rev);
}

#[test]
fn an_event_for_a_host_without_a_row_is_refused() {
    let mut db = MemoryStore::default();
    assert_eq!(
        apply_cas(&mut db, B, &in_ok("kB"), T0, &ours(), None),
        Err(ApplyError::NoRow)
    );
    assert!(!db.cas(B, 0, &fresh(B, None)));
}

#[test]
fn last_seen_flushes_are_monotonic_whatever_order_copies_flush_in() {
    let mut db = MemoryStore::default();
    db.flush_last_seen(B, "kB", 1_800_000_100);
    db.flush_last_seen(B, "kB", 1_800_000_050);
    assert_eq!(db.last_seen(B, "kB"), Some(1_800_000_100));
    db.flush_last_seen(B, "kB", 1_800_000_200);
    assert_eq!(db.last_seen(B, "kB"), Some(1_800_000_200));
    assert_eq!(db.last_seen(B, "kOther"), None);
}

struct Contended {
    inner: MemoryStore,
    reads: std::cell::Cell<u32>,
}

impl HostStore for Contended {
    fn read(&self, host: &str) -> Option<Row> {
        self.reads.set(self.reads.get() + 1);
        self.inner.read(host)
    }
    fn cas(&mut self, _host: &str, _expect: u64, _next: &Host) -> bool {
        false
    }
    fn flush_last_seen(&mut self, host: &str, kid: &str, at: i64) {
        self.inner.flush_last_seen(host, kid, at);
    }
}

#[test]
fn a_write_that_keeps_losing_the_compare_and_set_gives_up_after_a_few_tries() {
    let mut db = Contended {
        inner: setup(),
        reads: std::cell::Cell::new(0),
    };
    assert_eq!(
        apply_cas(&mut db, B, &in_ok("kEvil"), T0 + 1, &ours(), None),
        Err(ApplyError::Contended)
    );
    assert_eq!(db.reads.get(), 1 + RETRY_MAX);
    assert_eq!(
        apply_cas(&mut db, B, &in_ok("kB"), T0 + 2, &ours(), None),
        Ok(Applied {
            writes: 0,
            retries: 0
        })
    );
}
