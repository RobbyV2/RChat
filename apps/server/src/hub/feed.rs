use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use tokio::sync::mpsc::error::TryRecvError;
use tokio::sync::{Notify, mpsc};

use super::{Aftermath, Op, Purge};

/// How items past a feed's bound fold into the one lot it holds: no item is lost, and the lot
/// gives back what the items asked for.
pub trait Fold: Sized {
    type Lot: Default;
    fn fold(lot: &mut Self::Lot, item: Self);
    fn unfold(lot: Self::Lot) -> Vec<Self>;
}

struct Shared<T: Fold> {
    held: Mutex<Option<T::Lot>>,
    queued: AtomicUsize,
    bound: AtomicUsize,
    wake: Notify,
}

impl<T: Fold> Shared<T> {
    fn held(&self) -> MutexGuard<'_, Option<T::Lot>> {
        self.held.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// The sending side of a feed from the hub to one consumer.
pub struct FeedTx<T: Fold> {
    tx: mpsc::UnboundedSender<T>,
    shared: Arc<Shared<T>>,
}

/// A queue to one consumer. At most `bound` items wait in order (any number while it is 0).
/// Past it, and until the consumer has taken the waiting items, new items fold into one lot,
/// which the consumer gets after them. Items keep their order: once a lot is held, every item
/// joins it.
pub struct Feed<T: Fold> {
    rx: mpsc::UnboundedReceiver<T>,
    shared: Arc<Shared<T>>,
    ready: VecDeque<T>,
}

pub fn feed<T: Fold>(bound: usize) -> (FeedTx<T>, Feed<T>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let shared = Arc::new(Shared {
        held: Mutex::new(None),
        queued: AtomicUsize::new(0),
        bound: AtomicUsize::new(bound),
        wake: Notify::new(),
    });
    (
        FeedTx {
            tx,
            shared: shared.clone(),
        },
        Feed {
            rx,
            shared,
            ready: VecDeque::new(),
        },
    )
}

impl<T: Fold> FeedTx<T> {
    pub fn send(&self, item: T) {
        let mut held = self.shared.held();
        let bound = self.shared.bound.load(Ordering::Relaxed);
        let full = bound > 0 && self.shared.queued.load(Ordering::Relaxed) >= bound;
        if held.is_some() || full {
            T::fold(held.get_or_insert_with(Default::default), item);
            drop(held);
            self.shared.wake.notify_one();
            return;
        }
        if self.tx.send(item).is_ok() {
            self.shared.queued.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Items that wait in order from now on; 0 for any number.
    pub fn set_bound(&self, bound: usize) {
        self.shared.bound.store(bound, Ordering::Relaxed);
    }

    /// Items waiting in order now.
    #[cfg(test)]
    pub fn queued(&self) -> usize {
        self.shared.queued.load(Ordering::Relaxed)
    }
}

impl<T: Fold> Feed<T> {
    pub fn try_recv(&mut self) -> Result<T, TryRecvError> {
        if let Some(item) = self.ready.pop_front() {
            return Ok(item);
        }
        let mut held = self.shared.held();
        let closed = match self.rx.try_recv() {
            Ok(item) => {
                self.shared.queued.fetch_sub(1, Ordering::Relaxed);
                return Ok(item);
            }
            Err(TryRecvError::Empty) => false,
            Err(TryRecvError::Disconnected) => true,
        };
        if let Some(lot) = held.take() {
            drop(held);
            self.ready = T::unfold(lot).into();
            if let Some(item) = self.ready.pop_front() {
                return Ok(item);
            }
        }
        Err(match closed {
            true => TryRecvError::Disconnected,
            false => TryRecvError::Empty,
        })
    }

    pub async fn recv(&mut self) -> Option<T> {
        loop {
            match self.try_recv() {
                Ok(item) => return Some(item),
                Err(TryRecvError::Disconnected) => return None,
                Err(TryRecvError::Empty) => {}
            }
            tokio::select! {
                got = self.rx.recv() => {
                    if let Some(item) = got {
                        self.shared.queued.fetch_sub(1, Ordering::Relaxed);
                        return Some(item);
                    }
                }
                () = self.shared.wake.notified() => {}
            }
        }
    }
}

/// Who became visible on the site or stopped being visible: past the bound, the latest state
/// of each user.
#[derive(Default)]
pub struct Shown {
    order: VecDeque<String>,
    latest: HashMap<String, bool>,
}

impl Fold for (String, bool) {
    type Lot = Shown;

    fn fold(lot: &mut Shown, (user, online): (String, bool)) {
        if lot.latest.insert(user.clone(), online).is_none() {
            lot.order.push_back(user);
        }
    }

    fn unfold(lot: Shown) -> Vec<(String, bool)> {
        let Shown { order, mut latest } = lot;
        order
            .into_iter()
            .filter_map(|user| latest.remove(&user).map(|online| (user, online)))
            .collect()
    }
}

/// Follow-up work of the hub: past the bound, the purges as one and the reposts as one.
#[derive(Default)]
pub struct Work {
    settle: Purge,
    repost: Vec<Op>,
}

impl Fold for Aftermath {
    type Lot = Work;

    fn fold(lot: &mut Work, item: Aftermath) {
        match item {
            Aftermath::Settle(Purge { ends, p2p }) => {
                lot.settle.ends.extend(ends);
                lot.settle.p2p.extend(p2p);
            }
            Aftermath::Repost(ops) => lot.repost.extend(ops),
        }
    }

    fn unfold(lot: Work) -> Vec<Aftermath> {
        let Work { settle, repost } = lot;
        let mut out = Vec::new();
        if !settle.is_empty() {
            out.push(Aftermath::Settle(settle));
        }
        if !repost.is_empty() {
            out.push(Aftermath::Repost(repost));
        }
        out
    }
}
