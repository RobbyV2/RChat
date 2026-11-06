use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;

use tokio::time::Instant;
use tracing::{debug, warn};

use super::event::WsEvent;
use super::filter::wants;
use super::p2p::{Hosting, P2pScope, Who, announce_hosting, p2p_scope};
use super::{
    GUEST_SUB_CHECKS_BURST, GUEST_SUB_CHECKS_RATE, GUEST_SUBSCRIBE_CAP, LOG_EVERY,
    P2P_ANNOUNCE_EVERY, P2P_SCOPE_TTL, REAUTH_GIVE_UP, REAUTH_RETRY, SUB_CHECKS_BURST,
    SUB_CHECKS_RATE, SUBSCRIBE_CAP, authed_sub_ok, guest_sub_ok,
};

use crate::api::access::{
    ViewRules, is_member, presence_mode, ws_channel_now, ws_channel_public, ws_channel_view,
    ws_grant_deadline, ws_member_servers, ws_server_password_hash, ws_view_under,
};
use crate::api::token_row;
use crate::db::{Db, now, setting_on};
use crate::fanout::Topic;
use crate::hub::{Epoch, Hub, PRESENCE_SERVERS_MAX, Scope};
use crate::limits::Limits;
use crate::state::AppState;

struct Gate {
    last: Option<Instant>,
    hidden: u64,
    flushing: bool,
}

pub(crate) struct LogGate {
    state: Mutex<Gate>,
    every: Duration,
    summary: fn(u64),
}

impl LogGate {
    pub(crate) const fn new(every: Duration, summary: fn(u64)) -> LogGate {
        LogGate {
            state: Mutex::new(Gate {
                last: None,
                hidden: 0,
                flushing: false,
            }),
            every,
            summary,
        }
    }

    fn gate(&self) -> std::sync::MutexGuard<'_, Gate> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(crate) fn admit(&'static self, now: Instant) -> bool {
        let due = {
            let mut gate = self.gate();
            match gate.last {
                Some(at) if now.duration_since(at) < self.every => {
                    gate.hidden += 1;
                    if std::mem::replace(&mut gate.flushing, true) {
                        return false;
                    }
                    at + self.every
                }
                _ => {
                    gate.last = Some(now);
                    return true;
                }
            }
        };
        match tokio::runtime::Handle::try_current() {
            Ok(rt) => {
                rt.spawn(async move {
                    tokio::time::sleep_until(due).await;
                    self.flush(Instant::now());
                });
            }
            Err(_) => self.gate().flushing = false,
        }
        false
    }

    pub(super) fn flush(&self, now: Instant) {
        let hidden = {
            let mut gate = self.gate();
            gate.flushing = false;
            gate.last = Some(now);
            std::mem::take(&mut gate.hidden)
        };
        if hidden > 0 {
            (self.summary)(hidden);
        }
    }
}

static REAUTH_FAILED: LogGate = LogGate::new(LOG_EVERY, |n| {
    warn!(
        "re-authorizing realtime connections failed {n} more time(s) in the last {}s; their events are held back while they retry",
        LOG_EVERY.as_secs()
    )
});
static REAUTH_GAVE_UP: LogGate = LogGate::new(LOG_EVERY, |n| {
    warn!(
        "closed {n} more realtime connection(s) in the last {}s whose re-authorization kept failing",
        LOG_EVERY.as_secs()
    )
});
pub(super) static ADDR_FULL: LogGate = LogGate::new(LOG_EVERY, |n| {
    warn!(
        "refused {n} more realtime connection(s) in the last {}s from addresses at WS_SOCKETS_PER_IP",
        LOG_EVERY.as_secs()
    )
});
pub(super) static AUTH_FAILED: LogGate = LogGate::new(LOG_EVERY, |n| {
    warn!(
        "refused {n} more realtime connection(s) in the last {}s because their account could not be loaded",
        LOG_EVERY.as_secs()
    )
});

const FLOOR_TTL: Duration = Duration::from_secs(30);

type Viewable = HashMap<i64, (String, bool)>;

pub(super) struct Retry {
    pub(super) at: Option<Instant>,
    pub(super) wait: Duration,
    pub(super) since: Option<Instant>,
}

impl Retry {
    fn new() -> Retry {
        Retry {
            at: None,
            wait: REAUTH_RETRY,
            since: None,
        }
    }

    pub(super) fn pending(&self) -> bool {
        self.at.is_some()
    }

    fn fail(&mut self, e: sqlx::Error, started: Instant) -> bool {
        let now = Instant::now();
        let deadline = *self.since.get_or_insert(started) + REAUTH_GIVE_UP;
        if now >= deadline {
            match REAUTH_GAVE_UP.admit(now) {
                true => warn!(
                    "closed a realtime connection whose re-authorization kept failing for {}s, so its client reconnects: {e}",
                    REAUTH_GIVE_UP.as_secs()
                ),
                false => {
                    debug!("closed a realtime connection whose re-authorization kept failing: {e}")
                }
            }
            return false;
        }
        if self.pending() {
            debug!("re-authorizing a realtime connection failed again before its retry: {e}");
            return true;
        }
        match REAUTH_FAILED.admit(now) {
            true => warn!(
                "re-authorizing a realtime connection failed; its events are held back while it retries: {e}"
            ),
            false => debug!("re-authorizing a realtime connection failed: {e}"),
        }
        let delay = self.wait + self.wait.mul_f64(rand::random::<f64>() / 2.0);
        self.at = Some((now + delay).min(deadline));
        self.wait *= 2;
        true
    }
}

pub(super) struct Pace {
    pub(super) every: Duration,
    pub(super) last: Option<Instant>,
    pub(super) due: Option<Instant>,
}

impl Pace {
    pub(super) fn new(every: Duration) -> Pace {
        Pace {
            every,
            last: None,
            due: None,
        }
    }

    pub(super) fn hit(&mut self, now: Instant) -> bool {
        match self.last {
            Some(last) if now < last + self.every => {
                self.due = Some(last + self.every);
                false
            }
            Some(_) | None => {
                self.fire(now);
                true
            }
        }
    }

    pub(super) fn fire(&mut self, now: Instant) {
        self.last = Some(now);
        self.due = None;
    }
}

// A connection's `subscribe` requests: each costs `SUB_FRAME_COST` plus one per server it
// newly checks, from a bucket of checks. A request past the bucket waits, and a later one
// replaces it.
pub(super) struct SubPace {
    tokens: f64,
    at: Instant,
    rate: f64,
    burst: f64,
    cap: usize,
    pub(super) wanted: Option<(Vec<String>, HashMap<String, String>)>,
    pub(super) due: Option<Instant>,
}

pub(super) const SUB_FRAME_COST: f64 = 10.0;

impl SubPace {
    pub(super) fn new(signed_in: bool) -> SubPace {
        let (rate, burst, cap) = match signed_in {
            true => (SUB_CHECKS_RATE, SUB_CHECKS_BURST, SUBSCRIBE_CAP),
            false => (
                GUEST_SUB_CHECKS_RATE,
                GUEST_SUB_CHECKS_BURST,
                GUEST_SUBSCRIBE_CAP,
            ),
        };
        SubPace {
            tokens: burst,
            at: Instant::now(),
            rate,
            burst,
            cap,
            wanted: None,
            due: None,
        }
    }

    pub(super) fn want(&mut self, servers: Vec<String>, grants: HashMap<String, String>) {
        let mut seen = HashSet::new();
        let servers: Vec<String> = servers
            .into_iter()
            .map(|s| s.to_lowercase())
            .filter(|s| seen.insert(s.clone()))
            .take(self.cap)
            .collect();
        let grants = grants
            .into_iter()
            .map(|(s, g)| (s.to_lowercase(), g))
            .filter(|(s, _)| seen.contains(s))
            .collect();
        self.wanted = Some((servers, grants));
    }

    // Takes the wanted list when the bucket holds its cost (`fresh` new checks), or sets when
    // to try again.
    pub(super) fn take(
        &mut self,
        fresh: impl Fn(&[String], &HashMap<String, String>) -> usize,
        now: Instant,
    ) -> Option<(Vec<String>, HashMap<String, String>)> {
        let (servers, grants) = self.wanted.take()?;
        let cost = SUB_FRAME_COST + fresh(&servers, &grants) as f64;
        self.tokens =
            (self.tokens + now.duration_since(self.at).as_secs_f64() * self.rate).min(self.burst);
        self.at = now;
        if self.tokens < cost {
            self.due = Some(now + Duration::from_secs_f64((cost - self.tokens) / self.rate));
            self.wanted = Some((servers, grants));
            return None;
        }
        self.tokens -= cost;
        self.due = None;
        Some((servers, grants))
    }
}

pub(super) async fn catch_up(
    state: &AppState,
    conn: u64,
    access: &mut Access,
    inbox: &mut crate::fanout::Inbox,
    lag: &mut Pace,
    seq: u64,
) -> (u64, bool) {
    let through = inbox.drain().unwrap_or(seq).max(seq);
    if !lag.hit(Instant::now()) {
        return (through, true);
    }
    access.missed = true;
    (through, access.refresh(state, conn).await)
}

pub(super) struct Access {
    pub(super) user: Option<String>,
    /// When the account was created (it keys anonymous poll votes).
    pub(super) since: Option<i64>,
    pub(super) token: Option<String>,
    pub(super) site_admin: bool,
    pub(super) member_servers: HashSet<String>,
    pub(super) subs: HashSet<String>,
    pub(super) grants: HashMap<String, String>,
    pub(super) deadlines: HashMap<String, i64>,
    pub(super) viewing: Option<String>,
    pub(super) looking: Option<String>,
    pub(super) peek: Option<String>,
    pub(super) hidden: bool,
    mode: i64,
    pub(super) announced: bool,
    pub(super) moved: Vec<String>,
    hidden_moved: bool,
    pub(super) dark: bool,
    pub(super) missed: bool,
    pub(super) hosting: Option<Hosting>,
    pub(super) hosted_scope: Option<(Instant, P2pScope)>,
    pub(super) hosting_pace: Pace,
    pub(super) who: Who,
    pub(super) sub: SubPace,
    pub(super) viewable: Viewable,
    pub(super) floors: HashMap<i64, (Instant, Option<Option<i64>>)>,
    pub(super) retry: Retry,
    pub(super) topics_dirty: bool,
}

impl Access {
    pub(super) fn new(
        user: Option<String>,
        site_admin: bool,
        member_servers: HashSet<String>,
    ) -> Access {
        let sub = SubPace::new(user.is_some());
        Access {
            user,
            since: None,
            token: None,
            site_admin,
            member_servers,
            subs: HashSet::new(),
            grants: HashMap::new(),
            deadlines: HashMap::new(),
            viewing: None,
            looking: None,
            peek: None,
            hidden: false,
            mode: 0,
            announced: false,
            moved: Vec::new(),
            hidden_moved: false,
            dark: false,
            missed: false,
            hosting: None,
            hosted_scope: None,
            hosting_pace: Pace::new(P2P_ANNOUNCE_EVERY),
            who: Who::new(),
            sub,
            viewable: HashMap::new(),
            floors: HashMap::new(),
            retry: Retry::new(),
            topics_dirty: false,
        }
    }

    pub(super) fn topics(&self) -> HashSet<Topic> {
        let mut topics = HashSet::new();
        if self.site_admin {
            topics.insert(Topic::Admin);
        }
        if let Some(user) = &self.user {
            topics.insert(Topic::User(user.clone()));
        }
        for server in self.member_servers.iter().chain(self.subs.iter()) {
            topics.insert(Topic::Server(server.clone()));
        }
        for server in self.subs.iter().chain(self.viewing.iter()) {
            topics.insert(Topic::View(server.clone()));
        }
        topics
    }

    // What this connection announces for its user: every member server (at most
    // `PRESENCE_SERVERS_MAX`, by name), whatever is open, and whether they appear offline.
    fn scope(&self) -> Scope {
        let mut servers: Vec<String> = self.member_servers.iter().cloned().collect();
        servers.sort_unstable();
        servers.truncate(PRESENCE_SERVERS_MAX);
        Scope {
            servers,
            hidden: self.hidden,
            seq: self.mode,
        }
    }

    pub(super) fn shows(&self, server: &str) -> bool {
        self.announced && !self.dark && !self.hidden && self.member_servers.contains(server)
    }

    // The first call announces the connection with the user's full scope. Later membership
    // or appear-offline changes go out as a delta of the servers they touched.
    pub(super) fn sync(&mut self, hub: &Hub, conn: u64) {
        let Some(user) = &self.user else {
            return;
        };
        if self.dark {
            return;
        }
        if !self.announced {
            hub.announce(user, conn, true, Some(self.scope()));
            self.announced = true;
            self.moved.clear();
            self.hidden_moved = false;
            return;
        }
        if self.moved.is_empty() && !self.hidden_moved {
            return;
        }
        let mut moved = std::mem::take(&mut self.moved);
        moved.sort_unstable();
        moved.dedup();
        let (add, remove) = moved
            .into_iter()
            .partition(|s| self.member_servers.contains(s));
        let hidden = std::mem::take(&mut self.hidden_moved).then_some((self.hidden, self.mode));
        hub.rescope(user, add, remove, hidden);
    }

    pub(super) fn view(&mut self, hub: &Hub, conn: u64, target: Option<String>) {
        self.topics_dirty |= self.viewing != target;
        self.viewing = target;
        self.sync(hub, conn);
    }

    pub(super) fn set_peek(&mut self, server: Option<String>) {
        if self.peek == server {
            return;
        }
        if let Some(old) = self.peek.take() {
            self.subs.remove(&old);
            self.topics_dirty = true;
        }
        if let Some(server) = server
            && self.subs.insert(server.clone())
        {
            self.peek = Some(server);
            self.topics_dirty = true;
        }
    }

    pub(super) fn tidy_peek(&mut self) {
        if self.peek.as_ref().is_some_and(|p| !self.subs.contains(p)) {
            self.peek = None;
        }
    }

    // Takes the appear-offline value of version `seq` unless a newer one is already known (an
    // event queued before the connection reread the setting).
    pub(super) fn set_hidden(&mut self, hub: &Hub, conn: u64, hidden: bool, seq: i64) {
        if seq < self.mode {
            return;
        }
        self.mode = seq;
        self.hidden = hidden;
        self.hidden_moved = true;
        self.sync(hub, conn);
    }

    pub(super) fn take_mode(&mut self, (hidden, seq): (bool, i64)) {
        if seq >= self.mode {
            self.mode = seq;
            self.hidden = hidden;
        }
    }

    // While the database retry is pending the connection is dark: open, but it shows nobody
    // and leaves the scope alone, since its membership may be stale.
    fn reshow(&mut self, hub: &Hub, conn: u64) {
        if let Some(user) = &self.user {
            let lit = !self.retry.pending();
            hub.announce(user, conn, lit, lit.then(|| self.scope()));
            self.dark = !lit;
            self.announced = true;
            self.moved.clear();
            self.hidden_moved = false;
        }
    }

    pub(super) async fn announce(&mut self, state: &AppState, conn: u64) {
        self.reshow(&state.hub, conn);
        self.announce_hosting(state, conn).await;
    }

    async fn scope_of_hosting(&mut self, state: &AppState) -> Option<P2pScope> {
        let user = self.user.as_deref()?;
        if let Some((at, scope)) = &self.hosted_scope
            && at.elapsed() < P2P_SCOPE_TTL
        {
            return Some(scope.clone());
        }
        let scope = p2p_scope(&state.read(), user).await;
        self.hosted_scope = Some((Instant::now(), scope.clone()));
        Some(scope)
    }

    pub(super) async fn announce_hosting(&mut self, state: &AppState, conn: u64) {
        if self.dark || self.hosting.is_none() {
            return;
        }
        let Some(scope) = self.scope_of_hosting(state).await else {
            return;
        };
        if let (Some(user), Some(hosting)) = (&self.user, &self.hosting) {
            announce_hosting(state, user, conn, hosting.clone(), scope).await;
        }
    }

    pub(super) async fn host(&mut self, state: &AppState, conn: u64, hosting: Hosting) {
        if self.hosting.as_ref() == Some(&hosting) {
            return;
        }
        self.hosting = Some(hosting);
        if self.hosting_pace.hit(Instant::now()) {
            self.announce_hosting(state, conn).await;
        }
    }

    /// The read-history floor of channel `cid` for this connection (see `ws_read_floor`),
    /// remembered for 30 seconds.
    pub(super) async fn floor(
        &mut self,
        state: &AppState,
        server: &str,
        cid: i64,
    ) -> Option<Option<i64>> {
        if let Some((at, floor)) = self.floors.get(&cid)
            && at.elapsed() < FLOOR_TTL
        {
            return *floor;
        }
        let floor =
            crate::api::access::ws_read_floor(&state.read(), server, cid, self.user.as_deref())
                .await;
        if self.floors.len() > 1000 {
            self.floors.clear();
        }
        self.floors.insert(cid, (Instant::now(), floor));
        floor
    }

    pub(super) fn held(&self, name: &str) -> bool {
        self.member_servers.contains(name) || self.subs.contains(name)
    }

    pub(super) fn wants(&self, ev: &WsEvent) -> bool {
        let me = self.user.as_deref();
        match self.retry.pending() {
            false => wants(ev, me, self.site_admin, &self.member_servers, &self.subs),
            true => wants(ev, None, false, &HashSet::new(), &HashSet::new()),
        }
    }

    pub(super) fn hold(&mut self, e: sqlx::Error, started: Instant) -> bool {
        self.viewable.clear();
        self.floors.clear();
        self.missed = true;
        self.retry.fail(e, started)
    }

    pub(super) async fn check_token(&mut self, db: &Db) -> bool {
        let started = Instant::now();
        match token_live(db, self.token.as_deref()).await {
            Ok(live) => live,
            Err(e) => self.hold(e, started),
        }
    }

    pub(super) fn note_epoch(&mut self, lossy: &mut u64, now: Epoch) {
        self.missed |= now.lossy != *lossy;
        *lossy = now.lossy;
    }

    pub(super) fn settle(&mut self, res: sqlx::Result<bool>, started: Instant) -> bool {
        match res {
            Ok(open) => {
                self.retry = Retry::new();
                open
            }
            Err(e) => self.hold(e, started),
        }
    }

    pub(super) async fn refresh(&mut self, state: &AppState, conn: u64) -> bool {
        self.retry.at = None;
        let started = Instant::now();
        let res = reauthorize(state, self).await;
        if !self.settle(res, started) {
            return false;
        }
        if !self.retry.pending() && !self.dark {
            self.reshow(&state.hub, conn);
        }
        true
    }

    pub(super) async fn past_deadlines(&mut self, state: &AppState, conn: u64) -> bool {
        let t = now();
        let due: Vec<String> = self
            .deadlines
            .iter()
            .filter(|(_, at)| **at <= t)
            .map(|(server, _)| server.clone())
            .collect();
        for server in due {
            if !self.recheck(state, conn, &server).await {
                return false;
            }
            if !self.retry.pending() {
                self.deadlines.remove(&server);
            }
        }
        true
    }

    pub(super) async fn recheck(&mut self, state: &AppState, conn: u64, name: &str) -> bool {
        if self.retry.pending() || !self.held(name) {
            return true;
        }
        let started = Instant::now();
        match still_held(&state.read(), self, name, &state.limits).await {
            Ok(true) => true,
            Ok(false) => self.refresh(state, conn).await,
            Err(e) => self.hold(e, started),
        }
    }
}

pub(super) async fn token_live(db: &Db, token: Option<&str>) -> sqlx::Result<bool> {
    match token {
        Some(token) => Ok(token_row(db, token).await?.is_some()),
        None => Ok(false),
    }
}

pub(super) async fn reauthorize(state: &AppState, access: &mut Access) -> sqlx::Result<bool> {
    let db = &state.read();
    // The appear-offline setting comes from the primary: a replica behind it would announce a
    // stale value, and only a newer one replaces what the presence replica holds.
    let (servers, mode) = match &access.user {
        Some(user) => {
            if let Some(token) = &access.token
                && token_row(db, token).await?.is_none()
            {
                return Ok(false);
            }
            let Some(mode) = presence_mode(&state.db, user).await? else {
                return Ok(false);
            };
            (ws_member_servers(db, user).await?, Some(mode))
        }
        None => {
            if !setting_on(db, "guests_enabled").await? {
                return Ok(false);
            }
            (HashSet::new(), None)
        }
    };
    let mut kept = HashSet::new();
    for server in access.subs.iter() {
        let allowed = match &access.user {
            Some(user) => authed_sub_ok(db, server, user, access.site_admin).await?,
            None => {
                let grant = access.grants.get(server).map(String::as_str);
                guest_sub_ok(db, server, grant, &state.limits).await?
            }
        };
        if allowed {
            kept.insert(server.clone());
        }
    }
    access.viewable.clear();
    access.floors.clear();
    if access.member_servers != servers {
        access.hosted_scope = None;
    }
    access.member_servers = servers;
    if let Some(mode) = mode {
        access.take_mode(mode);
    }
    access.grants.retain(|server, _| kept.contains(server));
    access.deadlines = grant_deadlines(db, &access.grants).await?;
    access.subs = kept;
    access.tidy_peek();
    if let (Some(user), Some(server), None) = (&access.user, &access.looking, &access.peek)
        && !access.member_servers.contains(server)
        && !access.subs.contains(server)
        && authed_sub_ok(db, server, user, access.site_admin).await?
    {
        access.peek = Some(server.clone());
        access.subs.insert(server.clone());
    }
    if access
        .viewing
        .as_ref()
        .is_some_and(|s| !access.member_servers.contains(s))
    {
        access.viewing = None;
    }
    access.topics_dirty = true;
    Ok(true)
}

pub(super) async fn grant_deadlines(
    db: &Db,
    grants: &HashMap<String, String>,
) -> sqlx::Result<HashMap<String, i64>> {
    let mut deadlines = HashMap::new();
    for (server, grant) in grants {
        if let Some(at) = ws_grant_deadline(db, server, grant).await? {
            deadlines.insert(server.clone(), at);
        }
    }
    Ok(deadlines)
}

pub(super) async fn still_held(
    db: &Db,
    access: &Access,
    name: &str,
    limits: &Limits,
) -> sqlx::Result<bool> {
    if ws_server_password_hash(db, name).await?.is_none() {
        return Ok(true);
    }
    match &access.user {
        Some(user) => {
            if access.member_servers.contains(name) && !is_member(db, name, user).await? {
                return Ok(false);
            }
            authed_sub_ok(db, name, user, access.site_admin).await
        }
        None => {
            let grant = access.grants.get(name).map(String::as_str);
            guest_sub_ok(db, name, grant, limits).await
        }
    }
}

async fn channel_view(
    db: &Db,
    username: Option<&str>,
    cid: i64,
) -> sqlx::Result<Option<(String, bool)>> {
    let Some((owner, _)) = ws_channel_now(db, cid).await? else {
        return Ok(None);
    };
    let view = ws_channel_view(db, &owner, cid, username).await?;
    Ok(Some((owner, view)))
}

pub(super) async fn channel_gate(
    state: &AppState,
    access: &mut Access,
    server: &str,
    cid: i64,
) -> Option<bool> {
    if let Some((owner, view)) = access.viewable.get(&cid) {
        return Some(*view && owner == server);
    }
    let started = Instant::now();
    let slot = state.hub.channels().slot(cid);
    let read = state.read();
    let shared = slot
        .get_or_try_init(|| ws_channel_public(&read, cid))
        .await
        .cloned();
    let looked = match shared {
        Ok(Some((owner, true))) => Ok(Some((owner, true))),
        Ok(Some((_, false))) => channel_view(&state.read(), access.user.as_deref(), cid).await,
        Ok(None) => Ok(None),
        Err(e) => Err(e),
    };
    match looked {
        Ok(Some((owner, view))) => {
            let open = view && owner == server;
            access.viewable.insert(cid, (owner, view));
            Some(open)
        }
        Ok(None) => Some(false),
        Err(e) => access.hold(e, started).then_some(false),
    }
}

/// Whether a connection could view a channel that is now deleted: its own memo when it has one,
/// else the channel's view rules taken before the delete. Without rules (an event from an older
/// node) only the memo counts. `None` when the connection must close.
pub(super) async fn deleted_gate(
    state: &AppState,
    access: &mut Access,
    server: &str,
    known: Option<bool>,
    rules: Option<&ViewRules>,
) -> Option<bool> {
    if let Some(view) = known {
        return Some(view);
    }
    let Some(rules) = rules else {
        return Some(false);
    };
    let started = Instant::now();
    match ws_view_under(&state.read(), server, rules, access.user.as_deref()).await {
        Ok(view) => Some(view),
        Err(e) => access.hold(e, started).then_some(false),
    }
}
