use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tokio::sync::{broadcast, mpsc, oneshot, watch};
use tracing::warn;

use crate::fanout::{Channels, Inbox, Router, Topic};
use crate::ws::{CallKind, WsEvent};

mod limits;
mod link;
mod replica;

use limits::{Pacing, signal_burst_for, take_token};
use link::{Link, Posted, Reply, Resolved, Store, late_purge};

pub use limits::{
    ACCEPT_BURST, ACCEPT_EVERY, AUTH_WAIT, AddrSlot, CALL_BURST, CALL_EVERY, CONNECT_BURST,
    CONNECTS_PER_MINUTE, CONNS_PER_USER, DM_CALL_BURST, DM_CALL_EVERY, GUESTS_MAX, GUESTS_PER_IP,
    Limits, SIGNAL_BURST, SIGNAL_BYTES_PER_SEC, SOCKETS_PER_IP, TYPING_USER_BURST,
    TYPING_USER_EVERY, VOICE_BURST, VOICE_EVERY,
};
pub use replica::{
    Aftermath, Applied, CallEnd, Envelope, Op, Outcome, P2pDrop, Purge, Replica, Scope,
};

pub const DEAD_AFTER_MS: i64 = 30_000;
pub const PRESENCE_GRACE_MS: i64 = 10_000;
pub const PRESENCE_SERVERS_MAX: usize = 1000;
// Coming back online (after appear offline, or a dark or closed spell) is allowed
// `SHOW_BURST` times at once, then once per `SHOW_EVERY_MS`; a show past that waits and the
// state at the end wins. Going offline by appear offline is never delayed.
pub const SHOW_BURST: i64 = 4;
pub const SHOW_EVERY_MS: i64 = PRESENCE_GRACE_MS;
const REANNOUNCE_EVERY: Duration = Duration::from_secs(10);
const CONNECT_USERS_MAX: usize = 10_000;
const GAPS_KEPT: usize = 32;
const OUT_CAP: usize = 10_000;
const PENDING_CAP: usize = 50_000;
pub const CALL_TIMEOUT: Duration = match cfg!(test) {
    true => Duration::from_secs(2),
    false => Duration::from_secs(10),
};
pub const READ_FLUSH: Duration = Duration::from_millis(500);
pub const RELEASE_BURST: u32 = 30;
pub const RELEASE_EVERY: Duration = Duration::from_secs(2);
const RELEASE_USERS_MAX: usize = 10_000;
const PACED_USERS_MAX: usize = 10_000;
// Unconfirmed RTC signals kept for a repost, per call or voice room; older ones are dropped.
const SIGNALS_PENDING: usize = 64;
const SIGNAL_CALLS_MAX: usize = 1024;

static DROPPED: AtomicU64 = AtomicU64::new(0);

pub fn owner(conn: u64) -> u32 {
    (conn >> 32) as u32
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn stream_pos(id: &str) -> (u64, u64) {
    let (ms, seq) = id.split_once('-').unwrap_or((id, "0"));
    (ms.parse().unwrap_or(0), seq.parse().unwrap_or(0))
}

#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct Epoch {
    pub count: u64,
    pub lossy: u64,
}

struct Inner {
    instance: u32,
    tx: broadcast::Sender<WsEvent>,
    store: Mutex<Store>,
    order: Mutex<()>,
    router: Router,
    channels: Channels,
    conns: AtomicU64,
    link: Option<Link>,
    epoch: watch::Sender<Epoch>,
    settings: watch::Sender<u64>,
    aftermath: mpsc::UnboundedSender<Aftermath>,
    aftermath_rx: Mutex<Option<mpsc::UnboundedReceiver<Aftermath>>>,
    shown: mpsc::UnboundedSender<(String, bool)>,
    shown_rx: Mutex<Option<mpsc::UnboundedReceiver<(String, bool)>>>,
    release: Mutex<HashMap<String, (f64, Instant)>>,
    connects: Mutex<HashMap<String, (f64, Instant)>>,
    pacing: Pacing,
    addrs: Mutex<HashMap<IpAddr, (usize, usize)>>,
    guests: AtomicUsize,
    limits: Mutex<Limits>,
    auth_wait: Mutex<Duration>,
    reannounced: Mutex<(Option<Instant>, bool)>,
    tap: std::sync::OnceLock<mpsc::Sender<WsEvent>>,
}

enum Waited {
    Got(Outcome),
    TimedOut,
}

#[derive(Clone)]
pub struct Hub {
    inner: Arc<Inner>,
}

impl Default for Hub {
    fn default() -> Self {
        Self::new()
    }
}

impl Hub {
    fn build(link: Option<Link>) -> Hub {
        let (aftermath, aftermath_rx) = mpsc::unbounded_channel();
        let (shown, shown_rx) = mpsc::unbounded_channel();
        Hub {
            inner: Arc::new(Inner {
                instance: rand::random(),
                tx: broadcast::channel(1024).0,
                store: Mutex::new(Store {
                    replica: Replica::default(),
                    last_id: String::new(),
                    own: 0,
                    dirty: true,
                }),
                order: Mutex::new(()),
                router: Router::default(),
                channels: Channels::default(),
                conns: AtomicU64::new(0),
                link,
                epoch: watch::channel(Epoch::default()).0,
                settings: watch::channel(0).0,
                aftermath,
                aftermath_rx: Mutex::new(Some(aftermath_rx)),
                shown,
                shown_rx: Mutex::new(Some(shown_rx)),
                release: Mutex::new(HashMap::new()),
                connects: Mutex::new(HashMap::new()),
                pacing: Pacing::default(),
                addrs: Mutex::new(HashMap::new()),
                guests: AtomicUsize::new(0),
                limits: Mutex::new(Limits::default()),
                auth_wait: Mutex::new(AUTH_WAIT),
                reannounced: Mutex::new((None, false)),
                tap: std::sync::OnceLock::new(),
            }),
        }
    }

    pub fn new() -> Hub {
        Self::build(None)
    }

    pub fn replicated() -> (Hub, mpsc::Receiver<Envelope>) {
        let (out, rx) = mpsc::channel(OUT_CAP);
        let link = Link {
            out,
            seq: Mutex::new(0),
            pending: Mutex::new(BTreeMap::new()),
            publishing: AtomicBool::new(false),
            following: AtomicBool::new(false),
            caught_up: AtomicBool::new(false),
            diverged: AtomicBool::new(false),
            overflow: AtomicBool::new(false),
            reads: Mutex::new(None),
            signals: Mutex::new(HashMap::new()),
        };
        (Self::build(Some(link)), rx)
    }

    pub fn instance(&self) -> u32 {
        self.inner.instance
    }

    pub fn next_conn(&self) -> u64 {
        let seq = self.inner.conns.fetch_add(1, Ordering::Relaxed) & 0xffff_ffff;
        ((self.inner.instance as u64) << 32) | seq
    }

    pub fn subscribe(&self) -> broadcast::Receiver<WsEvent> {
        self.inner.tx.subscribe()
    }

    pub fn open(&self, conn: u64, topics: &HashSet<Topic>) -> Inbox {
        self.inner.router.open(conn, topics)
    }

    pub fn close(&self, conn: u64) {
        self.inner.router.close(conn);
    }

    pub fn listen(&self, conn: u64, topics: &[Topic]) {
        self.inner.router.add(conn, topics);
    }

    pub fn reconcile(&self, conn: u64, want: &HashSet<Topic>, through: u64) {
        self.inner.router.reconcile(conn, want, through);
    }

    pub fn topics(&self, conn: u64) -> HashSet<Topic> {
        self.inner.router.topics(conn)
    }

    pub fn connections(&self) -> usize {
        self.inner.router.connections()
    }

    /// Whether `user` has an open signed-in connection on any instance, whatever they view.
    /// It is true for users who appear offline: callers must check `appear_offline` before
    /// showing it to anyone else. This instance's connections are read from the router, so a
    /// closed one counts as gone at once: unlike server presence, there is no grace here.
    pub fn is_online_anywhere(&self, user: &str) -> bool {
        let me = self.inner.instance;
        self.inner.router.has_user(user)
            || self.replica(|r| {
                r.seen
                    .get(user)
                    .is_some_and(|seen| seen.conns.keys().any(|c| owner(*c) != me))
            })
    }

    /// Whether `user` is shown online on the site: connected anywhere (or inside the offline
    /// grace) and not appearing offline. Friends see this.
    pub fn shown_anywhere(&self, user: &str) -> bool {
        self.replica(|r| r.seen.get(user).is_some_and(|seen| seen.up && !seen.hidden))
    }

    /// Delivers `ev` to this instance's connections only. Each instance sends it itself, for
    /// events every instance derives from the replica.
    pub fn deliver_local(&self, ev: WsEvent) {
        if self.inner.tx.receiver_count() > 0 {
            let _ = self.inner.tx.send(ev.clone());
        }
        self.inner.router.deliver(ev);
    }

    /// Whether `user` has an open connection on this instance.
    pub fn listens_here(&self, user: &str) -> bool {
        self.inner.router.has_user(user)
    }

    pub fn channels(&self) -> &Channels {
        &self.inner.channels
    }

    pub fn epoch(&self) -> watch::Receiver<Epoch> {
        self.inner.epoch.subscribe()
    }

    /// Counts the `settings_changed` events this process saw, its own and those from the bus.
    pub fn settings_changes(&self) -> watch::Receiver<u64> {
        self.inner.settings.subscribe()
    }

    pub fn is_replicated(&self) -> bool {
        self.inner.link.is_some()
    }

    pub fn ready(&self) -> bool {
        self.inner.link.as_ref().is_none_or(|l| {
            l.publishing.load(Ordering::Relaxed)
                && l.following.load(Ordering::Relaxed)
                && l.caught_up.load(Ordering::Relaxed)
                && !l.diverged.load(Ordering::Relaxed)
        })
    }

    fn flag(&self, pick: fn(&Link) -> &AtomicBool, on: bool) {
        if let Some(link) = &self.inner.link {
            pick(link).store(on, Ordering::Relaxed);
        }
    }

    pub fn set_publishing(&self, up: bool) {
        self.flag(|l| &l.publishing, up);
    }

    pub fn set_following(&self, up: bool) {
        self.flag(|l| &l.following, up);
    }

    pub fn set_caught_up(&self, done: bool) {
        self.flag(|l| &l.caught_up, done);
    }

    pub fn set_diverged(&self, gap: bool) {
        self.flag(|l| &l.diverged, gap);
    }

    pub fn resync(&self, lossy: bool) {
        self.inner.channels.clear();
        self.inner.epoch.send_modify(|e| {
            e.count += 1;
            e.lossy += lossy as u64;
        });
    }

    pub fn take_aftermath(&self) -> Option<mpsc::UnboundedReceiver<Aftermath>> {
        self.inner.aftermath_rx.lock().unwrap().take()
    }

    /// Users who became visible on the site (`true`) or stopped being visible (`false`), in
    /// order, as this instance's replica sees it (`WsEvent::UserShown`, never delivered).
    pub fn take_shown(&self) -> Option<mpsc::UnboundedReceiver<(String, bool)>> {
        self.inner.shown_rx.lock().unwrap().take()
    }

    fn dispatch(&self, events: Vec<WsEvent>, live: bool) {
        for ev in events {
            self.inner.channels.observe(&ev);
            if !live {
                continue;
            }
            if let WsEvent::UserShown { username, online } = ev {
                let _ = self.inner.shown.send((username, online));
                continue;
            }
            if let WsEvent::SettingsChanged { settings: _ } = ev {
                self.inner.settings.send_modify(|n| *n += 1);
            }
            if self.inner.tx.receiver_count() > 0 {
                let _ = self.inner.tx.send(ev.clone());
            }
            self.inner.router.deliver(ev);
        }
    }

    fn local(&self, op: Op) -> Outcome {
        let mut store = self.inner.store.lock().unwrap();
        let Applied {
            events,
            outcome,
            purge,
            purged: _,
            evicted,
        } = store.replica.apply(self.inner.instance, op, now_ms());
        let order = self.inner.order.lock().unwrap();
        drop(store);
        self.dispatch(events, true);
        drop(order);
        self.evict(&evicted);
        if !purge.is_empty() {
            let _ = self.inner.aftermath.send(Aftermath::Settle(purge));
        }
        outcome
    }

    fn post(&self, op: Op) {
        match &self.inner.link {
            None => {
                self.local(op);
            }
            Some(link) => {
                let mut seq = link.seq.lock().unwrap();
                self.send(link, &mut seq, op, Reply::Forget);
            }
        }
    }

    fn send(&self, link: &Link, seq: &mut u64, op: Op, reply: Reply) {
        *seq += 1;
        let keep = match reply {
            Reply::Forget => op.repostable(),
            Reply::Waiter(_) => true,
        };
        if keep {
            let mut pending = link.pending.lock().unwrap();
            if let Some(key) = op.signal_key() {
                let mut signals = link.signals.lock().unwrap();
                if signals.len() >= SIGNAL_CALLS_MAX {
                    signals.retain(|_, kept| kept.iter().any(|s| pending.contains_key(s)));
                }
                let kept = signals.entry(key).or_default();
                kept.retain(|s| pending.contains_key(s));
                while kept.len() >= SIGNALS_PENDING {
                    if let Some(old) = kept.pop_front() {
                        pending.remove(&old);
                    }
                }
                kept.push_back(*seq);
            }
            while pending.len() >= PENDING_CAP {
                let Some((_, evicted)) = pending.pop_first() else {
                    break;
                };
                if let Reply::Waiter(waiter) = evicted.reply {
                    let _ = waiter.send(Outcome::Lost);
                }
                link.overflow.store(true, Ordering::Relaxed);
            }
            pending.insert(
                *seq,
                Posted {
                    op: op.clone(),
                    reply,
                },
            );
        }
        let env = Envelope {
            origin: self.inner.instance,
            seq: *seq,
            op,
        };
        if let Err(mpsc::error::TrySendError::Full(_)) = link.out.try_send(env) {
            let n = DROPPED.fetch_add(1, Ordering::Relaxed);
            if n.is_multiple_of(1000) {
                warn!(
                    "realtime publish queue is full ({OUT_CAP} ops); dropped {} op(s) so far, they are reposted or re-announced once the bus recovers",
                    n + 1
                );
            }
        }
    }

    fn settle_own<F: FnMut(u64, &Op) -> Option<Outcome>>(
        &self,
        link: &Link,
        through: u64,
        applied: F,
    ) {
        let mut seq = link.seq.lock().unwrap();
        let Resolved {
            reposts,
            retry,
            late,
        } = link.resolve(link.take_through(through), applied);
        for op in retry {
            warn!("a realtime cleanup op was lost on the bus; posting it again");
            let (waiter, _) = oneshot::channel();
            self.send(link, &mut seq, op, Reply::Waiter(waiter));
        }
        if !reposts.is_empty() {
            let (now, checked): (Vec<Op>, Vec<Op>) =
                reposts.into_iter().partition(|op| op.hoster().is_some());
            warn!(
                "{} realtime ops were lost on the bus; posting them again ({} after a database check)",
                now.len() + checked.len(),
                checked.len()
            );
            for op in now {
                self.send(link, &mut seq, op, Reply::Forget);
            }
            if !checked.is_empty() {
                let _ = self.inner.aftermath.send(Aftermath::Repost(checked));
            }
        }
        drop(seq);
        for (op, outcome) in late {
            let purge = late_purge(op, outcome);
            if !purge.is_empty() {
                let _ = self.inner.aftermath.send(Aftermath::Settle(purge));
            }
        }
    }

    async fn call(&self, op: Op) -> Waited {
        let link = match &self.inner.link {
            None => return Waited::Got(self.local(op)),
            Some(link) => link,
        };
        let (tx, rx) = oneshot::channel();
        {
            let mut seq = link.seq.lock().unwrap();
            self.send(link, &mut seq, op, Reply::Waiter(tx));
        }
        match tokio::time::timeout(CALL_TIMEOUT, rx).await {
            Ok(Ok(outcome)) => Waited::Got(outcome),
            Ok(Err(_)) => Waited::Got(Outcome::Done),
            Err(_) => Waited::TimedOut,
        }
    }

    async fn ask(&self, op: Op) -> Outcome {
        match self.call(op).await {
            Waited::Got(outcome) => outcome,
            Waited::TimedOut => {
                warn!("realtime bus did not confirm an op in time");
                Outcome::Lost
            }
        }
    }

    async fn call_applied(&self, op: Op) -> Outcome {
        loop {
            match self.call(op.clone()).await {
                Waited::Got(Outcome::Lost) => {
                    warn!("realtime op was lost on the bus, posting it again")
                }
                Waited::Got(outcome) => return outcome,
                Waited::TimedOut => {
                    warn!(
                        "realtime bus did not confirm a cleanup op in time; it finishes once the bus recovers"
                    );
                    return Outcome::Done;
                }
            }
        }
    }

    pub fn ingest(&self, id: &str, env: Envelope, live: bool) {
        let link = match &self.inner.link {
            Some(link) => link,
            None => return,
        };
        let Envelope { origin, seq, op } = env;
        let mine = origin == self.inner.instance;
        let (t_ms, _) = stream_pos(id);
        let mut store = self.inner.store.lock().unwrap();
        store.last_id = id.to_string();
        if !store.replica.admit(origin, seq) {
            return;
        }
        let skipped = mine && seq > store.own + 1;
        if mine {
            store.own = store.own.max(seq);
        }
        let beat = matches!(op, Op::Heartbeat);
        let reannounce = matches!(op, Op::Reannounce);
        let Applied {
            events,
            outcome,
            purge,
            purged,
            evicted,
        } = store.replica.apply(origin, op, t_ms as i64);
        store.dirty |= !beat || !events.is_empty() || !purged.is_empty();
        let order = self.inner.order.lock().unwrap();
        drop(store);
        self.dispatch(events, live);
        drop(order);
        self.evict(&evicted);
        if reannounce && live {
            self.reannounce();
        }
        if mine {
            let mut outcome = Some(outcome);
            self.settle_own(link, seq, |s, _| match s == seq {
                true => outcome.take(),
                false => None,
            });
            if !purge.is_empty() {
                let _ = self.inner.aftermath.send(Aftermath::Settle(purge));
            }
            if link.overflow.swap(false, Ordering::Relaxed) {
                warn!("realtime ops were dropped while the bus was unreachable; resyncing clients");
                self.resync(true);
            }
        }
        if skipped {
            warn!("realtime ops before {seq} from this instance were lost; re-announcing");
            self.resync(false);
        }
        if live && purged.contains(&self.inner.instance) {
            self.resync(false);
        }
    }

    pub fn snapshot_state(&self, force: bool) -> Option<(String, Replica)> {
        let mut store = self.inner.store.lock().unwrap();
        let gap = self
            .inner
            .link
            .as_ref()
            .is_some_and(|l| l.diverged.load(Ordering::Relaxed));
        if store.last_id.is_empty() || gap || !(force || store.dirty) {
            return None;
        }
        store.dirty = false;
        Some((store.last_id.clone(), store.replica.detached()))
    }

    pub fn mark_dirty(&self) {
        self.inner.store.lock().unwrap().dirty = true;
    }

    pub fn snapshot(&self) -> Option<(String, String)> {
        let (id, replica) = self.snapshot_state(true)?;
        serde_json::to_string(&replica).ok().map(|json| (id, json))
    }

    pub fn restore(&self, last_id: &str, json: &str) -> serde_json::Result<()> {
        let replica: Replica = serde_json::from_str(json)?;
        let legacy = replica.legacy;
        let me = self.inner.instance;
        let applied = replica.peers.get(&me).map_or(0, |p| p.seq);
        let mut store = self.inner.store.lock().unwrap();
        let before = std::mem::replace(&mut store.replica, replica);
        store.last_id = last_id.to_string();
        store.own = store.own.max(applied);
        store.dirty = true;
        self.inner.channels.clear();
        let after = &store.replica;
        if let Some(link) = &self.inner.link {
            self.settle_own(link, applied, |seq, op| match after.kept(me, seq) {
                true => after.recovered(&before, me, op),
                false => None,
            });
        }
        drop(store);
        if legacy {
            warn!(
                "restored a realtime snapshot from an older version; asking every instance to announce its connections again"
            );
            self.post(Op::Reannounce);
        }
        Ok(())
    }

    fn evict(&self, conns: &[u64]) {
        for conn in conns {
            if owner(*conn) == self.inner.instance {
                self.inner.router.evict(*conn);
            }
        }
    }

    // Every connection on this instance announces itself again. Repeated requests within
    // `REANNOUNCE_EVERY` are folded into one more at its end.
    fn reannounce(&self) {
        let now = Instant::now();
        let mut at = self.inner.reannounced.lock().unwrap();
        let wait = match at.0 {
            Some(last) if now.duration_since(last) < REANNOUNCE_EVERY => {
                REANNOUNCE_EVERY - now.duration_since(last)
            }
            _ => {
                at.0 = Some(now);
                drop(at);
                self.resync(false);
                return;
            }
        };
        if std::mem::replace(&mut at.1, true) {
            return;
        }
        drop(at);
        let Ok(rt) = tokio::runtime::Handle::try_current() else {
            self.inner.reannounced.lock().unwrap().1 = false;
            return;
        };
        let hub = self.clone();
        rt.spawn(async move {
            tokio::time::sleep(wait).await;
            *hub.inner.reannounced.lock().unwrap() = (Some(Instant::now()), false);
            hub.resync(false);
        });
    }

    pub fn heartbeat(&self) {
        if self.is_replicated() {
            self.post(Op::Heartbeat);
        }
    }

    /// Ends the offline grace of users whose time is up. Replicated hubs do it on every op
    /// (heartbeats keep them coming), so this only acts without a bus.
    pub fn tick(&self) {
        if !self.is_replicated() {
            self.local(Op::Heartbeat);
        }
    }

    #[cfg(test)]
    fn pending_len(&self) -> (usize, bool) {
        let link = self.inner.link.as_ref().expect("replicated");
        (
            link.pending.lock().unwrap().len(),
            link.overflow.load(Ordering::Relaxed),
        )
    }

    #[cfg(test)]
    pub(crate) fn expire_presence(&self) {
        let mut store = self.inner.store.lock().unwrap();
        let mut evs = Vec::new();
        let t = store.replica.clock.max(now_ms()) + PRESENCE_GRACE_MS;
        store.replica.expire(t, &mut evs);
        let order = self.inner.order.lock().unwrap();
        drop(store);
        self.dispatch(evs, true);
        drop(order);
    }

    pub async fn flush(&self) {
        if self.is_replicated() {
            self.call(Op::Heartbeat).await;
        }
    }

    pub async fn depart(&self) -> Option<Purge> {
        if !self.is_replicated() {
            return None;
        }
        match self.call_applied(Op::Depart).await {
            Outcome::Departed(purge) => Some(purge),
            _ => None,
        }
    }

    pub fn coalesce_reads(&self) {
        if let Some(link) = &self.inner.link {
            link.reads.lock().unwrap().get_or_insert_default();
        }
    }

    pub fn flush_reads(&self) {
        let Some(link) = &self.inner.link else {
            return;
        };
        let batch = match link.reads.lock().unwrap().as_mut() {
            Some(reads) => std::mem::take(reads),
            None => return,
        };
        for ((username, scope), (last_read, pings_until)) in batch {
            self.post(Op::Broadcast {
                event: WsEvent::ReadUpdated {
                    username,
                    scope,
                    last_read,
                    pings_until,
                },
            });
        }
    }

    /// Sends a copy of every event this process broadcasts (not those replicated from other
    /// processes) to `tx`, when `wanted` says so. Full taps drop events. Set once.
    pub fn set_tap(&self, tx: mpsc::Sender<WsEvent>) {
        let _ = self.inner.tap.set(tx);
    }

    fn tapped(&self, ev: &WsEvent) {
        if let Some(tx) = self.inner.tap.get()
            && crate::api::webhooks::wanted(ev)
            && tx.try_send(ev.clone()).is_err()
        {
            tracing::warn!("outgoing webhook queue is full; an event was dropped");
        }
    }

    pub fn broadcast(&self, ev: WsEvent) {
        self.tapped(&ev);
        if let (
            WsEvent::ReadUpdated {
                username,
                scope,
                last_read,
                pings_until,
            },
            Some(link),
        ) = (&ev, &self.inner.link)
            && let Some(reads) = link.reads.lock().unwrap().as_mut()
        {
            let at = reads
                .entry((username.clone(), scope.clone()))
                .or_insert((*last_read, *pings_until));
            *at = (at.0.max(*last_read), at.1.max(*pings_until));
            return;
        }
        self.post(Op::Broadcast { event: ev });
    }

    pub async fn broadcast_confirmed(&self, ev: WsEvent) -> bool {
        self.tapped(&ev);
        !matches!(self.ask(Op::Broadcast { event: ev }).await, Outcome::Lost)
    }

    pub async fn voice_join(
        &self,
        user: &str,
        conn: u64,
        server: &str,
        channel_id: i64,
    ) -> Vec<CallEnd> {
        self.voice_join_capped(user, conn, server, channel_id, 0)
            .await
            .unwrap_or_default()
    }

    pub async fn voice_join_capped(
        &self,
        user: &str,
        conn: u64,
        server: &str,
        channel_id: i64,
        cap: usize,
    ) -> Result<Vec<CallEnd>, String> {
        let op = Op::VoiceJoin {
            user: user.to_string(),
            conn,
            server: server.to_string(),
            channel_id,
            cap,
        };
        match self.ask(op).await {
            Outcome::Ends(ends) => Ok(ends),
            Outcome::Full => Err(format!("This voice channel is full ({cap} people)")),
            Outcome::Lost => Err("Realtime service unavailable".to_string()),
            _ => Ok(Vec::new()),
        }
    }

    pub async fn voice_leave(&self, user: &str) {
        let op = Op::VoiceLeave {
            user: user.to_string(),
        };
        self.call_applied(op).await;
    }

    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    pub async fn call_start(
        &self,
        user: &str,
        conn: u64,
        dm_id: i64,
        dm_users: Vec<String>,
        kind: CallKind,
        video: bool,
        log_id: i64,
        peer_id: Option<String>,
    ) -> Result<(), String> {
        let side = (peer_id, Vec::new());
        self.call_start_from(user, conn, dm_id, dm_users, (kind, video), log_id, side)
            .await
    }

    // `side` is the caller's tab peer id and the relay hosts it declared.
    #[allow(clippy::too_many_arguments)]
    pub async fn call_start_from(
        &self,
        user: &str,
        conn: u64,
        dm_id: i64,
        dm_users: Vec<String>,
        (kind, video): (CallKind, bool),
        log_id: i64,
        (peer_id, relays): (Option<String>, Vec<String>),
    ) -> Result<(), String> {
        let op = Op::CallStart {
            user: user.to_string(),
            conn,
            dm_id,
            dm_users,
            kind,
            video,
            log_id,
            call_id: crate::identity::random_id(),
            peer_id,
            relays,
        };
        match self.ask(op).await {
            Outcome::Started(res) => res,
            _ => Err("Realtime service unavailable".to_string()),
        }
    }

    #[cfg(test)]
    pub async fn call_accept(
        &self,
        user: &str,
        conn: u64,
        dm_id: i64,
        peer_id: Option<String>,
    ) -> Result<(i64, Vec<String>), String> {
        self.call_accept_from(user, conn, dm_id, (peer_id, Vec::new()))
            .await
    }

    pub async fn call_accept_from(
        &self,
        user: &str,
        conn: u64,
        dm_id: i64,
        (peer_id, relays): (Option<String>, Vec<String>),
    ) -> Result<(i64, Vec<String>), String> {
        let op = Op::CallAccept {
            user: user.to_string(),
            conn,
            dm_id,
            peer_id,
            relays,
        };
        match self.ask(op).await {
            Outcome::Accepted(res) => res,
            _ => Err("Realtime service unavailable".to_string()),
        }
    }

    pub async fn call_end(&self, user: &str, dm_id: i64) -> Result<CallEnd, String> {
        let op = Op::CallEnd {
            user: user.to_string(),
            dm_id,
        };
        match self.ask(op).await {
            Outcome::Ended(res) => res,
            _ => Err("Realtime service unavailable".to_string()),
        }
    }

    fn replica<R>(&self, read: impl FnOnce(&Replica) -> R) -> R {
        read(&self.inner.store.lock().unwrap().replica)
    }

    pub fn rtc_shared(
        &self,
        a: &str,
        b: &str,
        channel_id: Option<i64>,
        dm_id: Option<i64>,
    ) -> bool {
        self.replica(|r| r.rtc_shared(a, b, channel_id, dm_id))
    }

    pub fn in_p2p_call(&self, a: &str, b: &str) -> bool {
        self.replica(|r| r.in_p2p_call(a, b))
    }

    /// The kind of the call in DM `dm_id`, while there is one.
    pub fn call_kind(&self, dm_id: i64) -> Option<CallKind> {
        self.replica(|r| r.calls.get(&dm_id).map(|c| c.kind))
    }

    #[cfg(test)]
    pub fn call_relays(&self, dm_id: i64) -> Option<Vec<(String, Vec<String>)>> {
        self.replica(|r| r.calls.get(&dm_id).map(|c| c.relays.clone()))
    }

    /// Whether `user` is in the voice room `channel_id` of `server` now.
    pub fn in_room(&self, server: &str, channel_id: i64, user: &str) -> bool {
        self.replica(|r| r.in_room(server, channel_id, user))
    }

    /// Whether `user` has joined the answered RTC call in DM `dm_id` (see `rtc_shared`).
    pub fn in_active_call(&self, dm_id: i64, user: &str) -> bool {
        self.replica(|r| r.in_active_call(dm_id, user))
    }

    /// The server of the voice room `channel_id`, while anyone is in it.
    pub fn room_server(&self, channel_id: i64) -> Option<String> {
        self.replica(|r| r.rooms.get(&channel_id).map(|room| room.server.clone()))
    }

    pub async fn drop_conn(&self, user: &str, conn: u64) -> (Vec<CallEnd>, P2pDrop) {
        let op = Op::DropConn {
            user: user.to_string(),
            conn,
        };
        match self.call_applied(op).await {
            Outcome::Dropped(ends, drop) => (ends, drop),
            _ => (Vec::new(), P2pDrop::Kept),
        }
    }

    pub async fn sweep_voice(&self, idle: i64) -> Vec<CallEnd> {
        match self.ask(Op::SweepVoice { idle }).await {
            Outcome::Ends(ends) => ends,
            _ => Vec::new(),
        }
    }

    #[cfg(test)]
    pub fn set_p2p(&self, user: &str, conn: u64, peer_id: String, ids: Vec<String>) {
        self.set_p2p_relayed(user, conn, peer_id, ids, BTreeMap::new());
    }

    pub fn set_p2p_relayed(
        &self,
        user: &str,
        conn: u64,
        peer_id: String,
        ids: Vec<String>,
        relays: BTreeMap<String, Vec<String>>,
    ) {
        self.post(Op::SetP2p {
            user: user.to_string(),
            conn,
            peer_id,
            ids,
            relays,
        });
    }

    // The ids `user` hosts across all their tabs.
    pub fn p2p_ids(&self, user: &str) -> Option<Vec<String>> {
        self.replica(|r| {
            let mut ids: Vec<String> = Vec::new();
            for id in r.p2p.get(user)?.values().flat_map(|h| h.ids.iter()) {
                if !ids.contains(id) {
                    ids.push(id.clone());
                }
            }
            Some(ids)
        })
    }

    // The peer id of the newest tab of `user` that hosts the file `id`, and the relay hosts
    // that tab declared for it.
    pub fn p2p_host_of(&self, user: &str, id: &str) -> Option<(String, Vec<String>)> {
        self.replica(|r| {
            r.p2p
                .get(user)?
                .values()
                .rev()
                .find(|h| h.ids.iter().any(|x| x == id))
                .map(|h| {
                    (
                        h.peer_id.clone(),
                        h.relays.get(id).cloned().unwrap_or_default(),
                    )
                })
        })
    }

    // Peer id requests for downloads: a burst of RELEASE_BURST, then one every RELEASE_EVERY,
    // per user and per process.
    pub fn release_ok(&self, user: &str) -> bool {
        take_token(
            &mut self.inner.release.lock().unwrap(),
            user,
            RELEASE_BURST,
            RELEASE_EVERY,
            RELEASE_USERS_MAX,
        )
    }

    /// Whether `user` may open another realtime connection now: within the burst and rate
    /// both on this instance and across the cluster. The cluster part reads the connections
    /// the replica has seen open, against the replica clock (the last op, at most a heartbeat
    /// old), and starts over once the user has been offline past the grace.
    pub fn connect_ok(&self, user: &str) -> bool {
        let Limits {
            conns_per_user: _,
            connect_burst,
            connect_every,
            sockets_per_ip: _,
            guests_per_ip: _,
            guests_max: _,
            voice_room_max: _,
        } = self.limits();
        let every = connect_every.as_millis() as i64;
        let (opened, clock) =
            self.replica(|r| (r.seen.get(user).map_or(0, |seen| seen.opened), r.clock));
        if opened.saturating_sub((i64::from(connect_burst) - 1) * every) > clock {
            return false;
        }
        take_token(
            &mut self.inner.connects.lock().unwrap(),
            user,
            connect_burst,
            connect_every,
            CONNECT_USERS_MAX,
        )
    }

    pub fn limits(&self) -> Limits {
        *self.inner.limits.lock().unwrap()
    }

    /// Counts a new realtime socket from `addr` (an IPv6 /64 counts as one address), or `None`
    /// when the address already has `sockets_per_ip` open on this instance.
    pub fn addr_slot(&self, addr: IpAddr) -> Option<AddrSlot> {
        let addr = crate::api::budget::group(addr);
        let cap = self.limits().sockets_per_ip;
        let mut addrs = self.inner.addrs.lock().unwrap();
        let entry = addrs.entry(addr).or_insert((0, 0));
        if entry.0 >= cap {
            return None;
        }
        entry.0 += 1;
        drop(addrs);
        Some(AddrSlot {
            hub: self.clone(),
            addr,
            guest: false,
        })
    }

    /// Whether this instance holds as many guest sockets as `guests_max` allows.
    pub fn guests_full(&self) -> bool {
        self.inner.guests.load(Ordering::Relaxed) >= self.limits().guests_max
    }

    /// Whether `user` may join or leave voice now.
    pub fn voice_ok(&self, user: &str) -> bool {
        self.voice_ok_at(user, Instant::now())
    }

    /// Whether `user` may join or leave voice at `now`.
    pub fn voice_ok_at(&self, user: &str, now: Instant) -> bool {
        self.inner.pacing.voice.take_at(user, 1.0, now)
    }

    /// How long a new realtime socket has to send its `auth` frame.
    pub fn auth_wait(&self) -> Duration {
        *self.inner.auth_wait.lock().unwrap()
    }

    #[cfg(test)]
    pub fn set_auth_wait(&self, wait: Duration) {
        *self.inner.auth_wait.lock().unwrap() = wait;
    }

    /// Realtime sockets open from `addr` on this instance: all, and those of guests.
    #[cfg(test)]
    pub fn addr_open(&self, addr: IpAddr) -> (usize, usize) {
        let addr = crate::api::budget::group(addr);
        let addrs = self.inner.addrs.lock().unwrap();
        addrs.get(&addr).copied().unwrap_or((0, 0))
    }

    /// Whether `user` may start a call on DM `dm_id` now: paced per account and per DM.
    pub fn call_ok(&self, user: &str, dm_id: i64) -> bool {
        let Pacing {
            voice: _,
            calls,
            dm_calls,
            accepts: _,
            signals: _,
            typing: _,
        } = &self.inner.pacing;
        dm_calls.take(&format!("{user}\0{dm_id}"), 1.0) && calls.take(user, 1.0)
    }

    /// Whether `user` may answer a call now, apart from their voice hops.
    pub fn accept_ok(&self, user: &str) -> bool {
        self.inner.pacing.accepts.take(user, 1.0)
    }

    /// Whether `user` may send `bytes` more of RTC signalling now.
    pub fn signal_ok(&self, user: &str, bytes: usize) -> bool {
        self.inner.pacing.signals.take(user, bytes as f64)
    }

    /// Whether `user` may show a typing indicator now, across all their connections.
    pub fn typing_ok(&self, user: &str) -> bool {
        self.inner.pacing.typing.take(user, 1.0)
    }

    /// Why a call between `user` and `other` would be refused now, read from the replica.
    pub fn call_busy(&self, user: &str, other: &str) -> Option<String> {
        self.replica(|r| match (r.in_call(user), r.in_call(other)) {
            (true, _) => Some("You are already in a call".to_string()),
            (false, true) => Some(format!("{other} is already in a call")),
            (false, false) => None,
        })
    }

    pub(crate) fn set_limits(&self, limits: Limits) {
        self.inner
            .pacing
            .signals
            .set_burst(signal_burst_for(limits.voice_room_max) as f64);
        *self.inner.limits.lock().unwrap() = limits;
    }

    /// The signalling bytes one account may send at once (see `signal_burst_for`).
    pub fn signal_burst(&self) -> usize {
        signal_burst_for(self.limits().voice_room_max)
    }

    pub fn p2p_of(&self, user: &str) -> Option<(String, Vec<String>)> {
        self.replica(|r| {
            r.p2p
                .get(user)
                .and_then(|hosts| hosts.last_key_value())
                .map(|(_, h)| (h.peer_id.clone(), h.ids.clone()))
        })
    }

    fn presence<R>(&self, server: &str, read: impl FnOnce(&BTreeSet<String>) -> R) -> Option<R> {
        self.replica(|r| r.index.presence.get(server).map(read))
    }

    pub fn online_set(&self, server: &str) -> HashSet<String> {
        self.presence(server, |users| users.iter().cloned().collect())
            .unwrap_or_default()
    }

    pub fn online_after(&self, server: &str, after: Option<&str>, n: usize) -> Vec<String> {
        self.presence(server, |users| {
            let range = match after {
                Some(a) => users
                    .range::<str, _>((std::ops::Bound::Excluded(a), std::ops::Bound::Unbounded)),
                None => users.range::<str, _>(..),
            };
            range.take(n).cloned().collect()
        })
        .unwrap_or_default()
    }

    pub fn online_among<'a>(&self, server: &str, names: &'a [String]) -> HashSet<&'a str> {
        self.presence(server, |users| {
            names
                .iter()
                .filter(|n| users.contains(n.as_str()))
                .map(String::as_str)
                .collect()
        })
        .unwrap_or_default()
    }

    pub fn online_count(&self, server: &str) -> i64 {
        self.presence(server, |users| users.len() as i64)
            .unwrap_or(0)
    }

    pub fn is_online(&self, server: &str, username: &str) -> bool {
        self.presence(server, |users| users.contains(username))
            .unwrap_or(false)
    }

    /// Announces an open connection of `user`, `lit` unless it waits for the database. With
    /// `scope`, it also replaces the user's member servers and appear-offline flag, which all
    /// their connections share.
    pub fn announce(&self, user: &str, conn: u64, lit: bool, scope: Option<Scope>) {
        self.post(Op::Online {
            user: user.to_string(),
            conn,
            lit,
            cap: self.limits().conns_per_user,
            scope,
            every: self.limits().connect_every.as_millis() as usize,
        });
    }

    pub fn set_online<S: AsRef<str>>(&self, user: &str, conn: u64, servers: &[S]) {
        let servers = servers.iter().map(|s| s.as_ref().to_string()).collect();
        let scope = Scope {
            servers,
            ..Scope::default()
        };
        self.announce(user, conn, true, Some(scope));
    }

    /// Changes the member servers or appear-offline flag (with its version) of `user` by a
    /// delta.
    pub fn rescope(
        &self,
        user: &str,
        add: Vec<String>,
        remove: Vec<String>,
        hidden: Option<(bool, i64)>,
    ) {
        if add.is_empty() && remove.is_empty() && hidden.is_none() {
            return;
        }
        self.post(Op::Rescope {
            user: user.to_string(),
            add,
            remove,
            hidden: hidden.map(|(hidden, _)| hidden),
            seq: hidden.map_or(0, |(_, seq)| seq),
        });
    }

    pub fn reannounce_all(&self) {
        self.post(Op::Reannounce);
    }

    pub fn force_offline(&self, server: &str, user: &str) {
        self.post(Op::ForceOffline {
            server: server.to_string(),
            user: user.to_string(),
        });
    }

    pub fn rooms_in(&self, server: &str, channel_id: Option<i64>) -> Vec<(i64, Vec<String>)> {
        self.replica(|replica| {
            replica
                .index
                .server_rooms
                .get(server)
                .into_iter()
                .flatten()
                .filter(|cid| channel_id.is_none_or(|c| c == **cid))
                .filter_map(|cid| {
                    replica
                        .rooms
                        .get(cid)
                        .map(|room| (*cid, room.users.iter().map(|(u, _)| u.clone()).collect()))
                })
                .collect()
        })
    }

    pub fn evict_voice(&self, user: &str, channel_id: i64) {
        self.post(Op::EvictVoice {
            user: user.to_string(),
            channel_id,
        });
    }

    pub fn voice_snapshot(&self) -> Vec<WsEvent> {
        self.replica(Replica::voice_snapshot)
    }

    pub fn voice_snapshot_for<'a, I: IntoIterator<Item = &'a String>>(
        &self,
        servers: I,
        user: Option<&str>,
    ) -> Vec<WsEvent> {
        self.replica(|r| r.voice_snapshot_for(servers, user))
    }
}

#[cfg(test)]
pub(crate) mod tests;
