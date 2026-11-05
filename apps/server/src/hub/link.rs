use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;

use tokio::sync::{mpsc, oneshot};

use super::replica::{Envelope, Op, Outcome, Purge, Replica};

pub(super) struct Store {
    pub(super) replica: Replica,
    pub(super) last_id: String,
    pub(super) own: u64,
    pub(super) dirty: bool,
}

pub(super) enum Reply {
    Forget,
    Waiter(oneshot::Sender<Outcome>),
}

pub(super) struct Posted {
    pub(super) op: Op,
    pub(super) reply: Reply,
}

type Reads = BTreeMap<(String, String), (i64, i64)>;

pub(super) struct Link {
    pub(super) out: mpsc::Sender<Envelope>,
    pub(super) seq: Mutex<u64>,
    pub(super) pending: Mutex<BTreeMap<u64, Posted>>,
    pub(super) publishing: AtomicBool,
    pub(super) following: AtomicBool,
    pub(super) caught_up: AtomicBool,
    pub(super) diverged: AtomicBool,
    pub(super) overflow: AtomicBool,
    pub(super) reads: Mutex<Option<Reads>>,
    pub(super) signals: Mutex<HashMap<SignalKey, VecDeque<u64>>>,
}

pub(super) type SignalKey = (Option<i64>, Option<i64>);

#[derive(Default)]
pub(super) struct Resolved {
    pub(super) reposts: Vec<Op>,
    pub(super) retry: Vec<Op>,
    pub(super) late: Vec<(Op, Outcome)>,
}

impl Link {
    pub(super) fn take_through(&self, seq: u64) -> BTreeMap<u64, Posted> {
        let mut pending = self.pending.lock().unwrap();
        let later = pending.split_off(&seq.saturating_add(1));
        std::mem::replace(&mut *pending, later)
    }

    pub(super) fn resolve<F: FnMut(u64, &Op) -> Option<Outcome>>(
        &self,
        taken: BTreeMap<u64, Posted>,
        mut applied: F,
    ) -> Resolved {
        let settled: Vec<(Posted, Option<Outcome>)> = taken
            .into_iter()
            .map(|(seq, posted)| {
                let outcome = applied(seq, &posted.op);
                (posted, outcome)
            })
            .collect();
        let mut later: HashSet<String> = match settled.iter().any(|(_, o)| o.is_none()) {
            true => self
                .pending
                .lock()
                .unwrap()
                .values()
                .filter_map(|p| p.op.hoster().map(str::to_string))
                .collect(),
            false => HashSet::new(),
        };
        let mut done = Resolved::default();
        for (Posted { op, reply }, outcome) in settled.into_iter().rev() {
            let hoster = op.hoster().map(str::to_string);
            match (outcome, reply) {
                (Some(_), Reply::Forget) => later.extend(hoster),
                (Some(outcome), Reply::Waiter(waiter)) => {
                    later.extend(hoster);
                    if let Err(outcome) = waiter.send(outcome) {
                        done.late.push((op, outcome));
                    }
                }
                (None, Reply::Waiter(waiter)) => {
                    if waiter.send(Outcome::Lost).is_err() && op.must_apply() {
                        done.retry.push(op);
                    }
                }
                (None, Reply::Forget) => match hoster {
                    Some(h) if later.contains(&h) => {}
                    hoster => {
                        later.extend(hoster);
                        done.reposts.push(op);
                    }
                },
            }
        }
        done.reposts.reverse();
        done.retry.reverse();
        done.late.reverse();
        done
    }
}

pub(super) fn late_purge(op: Op, outcome: Outcome) -> Purge {
    match (op, outcome) {
        (Op::DropConn { user, conn: _ }, Outcome::Dropped(ends, drop)) => Purge {
            ends,
            p2p: vec![(user, drop)],
        },
        (_, Outcome::Departed(purge)) => purge,
        (_, Outcome::Ends(ends)) => Purge {
            ends,
            p2p: Vec::new(),
        },
        (_, Outcome::Ended(Ok(end))) => Purge {
            ends: vec![end],
            p2p: Vec::new(),
        },
        (_, _) => Purge::default(),
    }
}
