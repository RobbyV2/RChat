use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::time::Instant;
use tracing::{debug, warn};

use super::event::WsEvent;
use super::filter::wants;
use super::guests::leave_closed_voice;
use super::p2p::{Hosting, P2pScope, Who, announce_hosting, p2p_scope};
use super::{
    GUEST_SUB_CHECKS_BURST, GUEST_SUB_CHECKS_RATE, GUEST_SUBSCRIBE_CAP, LOG_EVERY,
    P2P_ANNOUNCE_EVERY, P2P_SCOPE_TTL, REAUTH_GIVE_UP, REAUTH_RETRY, SUB_CHECKS_BURST,
    SUB_CHECKS_RATE, SUBSCRIBE_CAP, authed_sub_ok, guest_sub_ok,
};

use crate::api::access::{
    ViewRules, is_member, is_membership_notice, presence_mode, ws_channel_now, ws_channel_policy,
    ws_channel_seen, ws_closed_servers, ws_grant_deadline, ws_member_servers,
    ws_server_password_hash, ws_thread_start, ws_view_under,
};
use crate::api::policy::{ServerJoining, TempChange};
use crate::api::{Settings, restricted, token_row};
use crate::db::{Db, User, now, setting_on};
use crate::fanout::Topic;
use crate::hub::{Epoch, Hub, PRESENCE_SERVERS_MAX, Scope};
use crate::limits::Limits;
use crate::limits::bucket::{Policy, Single};
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

pub(super) static COPY_FULL: LogGate = LogGate::new(LOG_EVERY, |n| {
    warn!("refused {n} more realtime connections: this copy holds WS_SOCKETS_MAX connections")
});
pub(super) static AUTH_FAILED: LogGate = LogGate::new(LOG_EVERY, |n| {
    warn!(
        "refused {n} more realtime connection(s) in the last {}s because their account could not be loaded",
        LOG_EVERY.as_secs()
    )
});

const FLOOR_TTL: Duration = Duration::from_secs(30);

/// The thread an event about a channel message belongs to: the root it names, or a message
/// whose thread is looked up.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) enum InThread {
    Root(i64),
    Of(i64),
}

/// When the thread of an `InThread` started: `Top` for a message outside any thread, `At` the
/// root's `created_at`, `Gone` when the message or its root no longer exists.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Rooted {
    Top,
    At(i64),
    Gone,
}

/// Per channel: the server that owns it, whether this connection views it, and the unix second
/// that answer ends at (a site admin's staff view of the channel), `None` for an answer that
/// holds until the channel's rules or the connection's memberships change.
type Viewable = HashMap<i64, (String, bool, Option<i64>)>;

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

// At most one run per `every`: a run asked for sooner waits until `due`.
pub(super) struct Pace {
    bucket: Single,
    pub(super) due: Option<Instant>,
}

impl Pace {
    pub(super) fn new(every: Duration) -> Pace {
        let policy = Policy::Window {
            limit: 1,
            window: every,
        };
        Pace {
            bucket: Single::new(policy, Instant::now().into_std()),
            due: None,
        }
    }

    pub(super) fn hit(&mut self, now: Instant) -> bool {
        let ran = self.bucket.take(1.0, now.into_std());
        self.due = match ran {
            true => None,
            false => self.next(now),
        };
        ran
    }

    pub(super) fn fire(&mut self, now: Instant) {
        self.bucket.spend(1.0, now.into_std());
        self.due = None;
    }

    // When the next run may start, at `now` or later.
    pub(super) fn next(&self, now: Instant) -> Option<Instant> {
        self.bucket
            .ready_at(1.0, now.into_std())
            .map(Instant::from_std)
    }
}

// A connection's `subscribe` requests: each costs `SUB_FRAME_COST` plus one per server it
// newly checks, from a bucket of checks. A request past the bucket waits, and a later one
// replaces it.
pub(super) struct SubPace {
    bucket: Single,
    cap: usize,
    pub(super) wanted: Option<(Vec<String>, HashMap<String, String>)>,
    pub(super) due: Option<Instant>,
}

pub(super) const SUB_FRAME_COST: f64 = 10.0;

impl SubPace {
    pub(super) fn new(signed_in: bool) -> SubPace {
        let (per_sec, burst, cap) = match signed_in {
            true => (SUB_CHECKS_RATE, SUB_CHECKS_BURST, SUBSCRIBE_CAP),
            false => (
                GUEST_SUB_CHECKS_RATE,
                GUEST_SUB_CHECKS_BURST,
                GUEST_SUBSCRIBE_CAP,
            ),
        };
        SubPace {
            bucket: Single::new(Policy::Tokens { burst, per_sec }, Instant::now().into_std()),
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
        if !self.bucket.take(cost, now.into_std()) {
            self.due = self
                .bucket
                .ready_at(cost, now.into_std())
                .map(Instant::from_std);
            self.wanted = Some((servers, grants));
            return None;
        }
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
    /// The name a guest connection has in voice rooms (`guests::guest_name`).
    pub(super) guest: Option<String>,
    /// Where a guest connection came from (`budget::group`), which a block from voice covers.
    pub(super) addr: Option<IpAddr>,
    /// When the account was created (it keys anonymous poll votes).
    pub(super) since: Option<i64>,
    pub(super) token: Option<String>,
    pub(super) site_admin: bool,
    pub(super) member_servers: HashSet<String>,
    pub(super) subs: HashSet<String>,
    /// Servers it reads from outside that keep their members to themselves
    /// (`members_visible` off).
    pub(super) closed: HashSet<String>,
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
    /// The last edit observed for each followed server, shared across its connections.
    pub(super) layouts: HashMap<String, Arc<crate::api::ChannelLayout>>,
    pub(super) sub: SubPace,
    pub(super) viewable: Viewable,
    pub(super) floors: HashMap<i64, (Instant, Option<Option<i64>>)>,
    threads: HashMap<InThread, Rooted>,
    pub(super) retry: Retry,
    pub(super) topics_dirty: bool,
    /// How the instance opens servers to people who aren't members (its joining rule and
    /// whether it allows public reading), as this connection last saw it.
    pub(super) reading: Option<(ServerJoining, bool)>,
    /// What the instance asks of accounts with a temporary password, as this connection last
    /// saw it.
    pub(super) password_change: Option<TempChange>,
    pub(super) password_expires: Option<i64>,
    pub(super) restricted: bool,
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
            guest: None,
            addr: None,
            since: None,
            token: None,
            site_admin,
            member_servers,
            subs: HashSet::new(),
            closed: HashSet::new(),
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
            layouts: HashMap::new(),
            sub,
            viewable: HashMap::new(),
            floors: HashMap::new(),
            threads: HashMap::new(),
            retry: Retry::new(),
            topics_dirty: false,
            reading: None,
            password_change: None,
            password_expires: None,
            restricted: false,
        }
    }

    /// The instance's settings changed. A guest's connection ends when guest access went off
    /// (`false`). When the rules for reading servers by name changed, what the connection
    /// follows without being a member is checked again, so it stops following servers that
    /// closed to it. `false` also when the connection must close.
    pub(super) async fn settings_changed(
        &mut self,
        state: &AppState,
        conn: u64,
        settings: &Settings,
    ) -> bool {
        if self.user.is_none() && !settings.guests_enabled {
            return false;
        }
        let before = self.password_change.replace(settings.password_change);
        if before == Some(TempChange::Encouraged)
            && settings.password_change == TempChange::Required
            && self.token.is_some()
        {
            Settings::keep(&state.db, *settings);
            if !self.check_token(&state.read(), &state.limits).await {
                return false;
            }
        }
        let reading = Some((settings.server_joining, settings.public_reading));
        if std::mem::replace(&mut self.reading, reading) == reading {
            return true;
        }
        if self.subs.is_empty() && self.looking.is_none() {
            return true;
        }
        Settings::keep(&state.db, *settings);
        self.refresh(state, conn).await
    }

    pub(super) fn topics(&self) -> HashSet<Topic> {
        let mut topics = HashSet::new();
        if self.site_admin {
            topics.insert(Topic::Admin);
        }
        if let Some(name) = self.user.as_ref().or(self.guest.as_ref()) {
            topics.insert(Topic::User(name.clone()));
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

    /// The read-history floor after the channel view gate. Only channels with a limiting
    /// rule need a per-connection lookup, remembered for 30 seconds.
    pub(super) async fn floor(
        &mut self,
        state: &AppState,
        server: &str,
        cid: i64,
    ) -> Option<Option<i64>> {
        let slot = state.hub.channels().slot(cid);
        let db = state.read();
        let policy = slot
            .get_or_try_init(|| ws_channel_policy(&db, cid))
            .await
            .ok()?
            .as_ref()?;
        if policy.server != server {
            return None;
        }
        if !policy.limits_history {
            return Some(None);
        }
        if let Some((at, floor)) = self.floors.get(&cid)
            && at.elapsed() < FLOOR_TTL
        {
            return *floor;
        }
        let floor = crate::api::access::ws_read_floor(&db, server, cid, self.user.as_deref()).await;
        if self.floors.len() > 1000 {
            self.floors.clear();
        }
        self.floors.insert(cid, (Instant::now(), floor));
        floor
    }

    /// When `thread` started, remembered once known: a root's time and a reply's root never
    /// change. `Gone` is asked again next time, so a message a lagging read pool doesn't show yet
    /// is found later.
    pub(super) async fn rooted(&mut self, db: &Db, thread: InThread) -> sqlx::Result<Rooted> {
        if let Some(rooted) = self.threads.get(&thread) {
            return Ok(*rooted);
        }
        let (id, root) = match thread {
            InThread::Root(id) => (id, true),
            InThread::Of(id) => (id, false),
        };
        let rooted = match ws_thread_start(db, id, root).await? {
            Some(None) => Rooted::Top,
            Some(Some(at)) => Rooted::At(at),
            None => Rooted::Gone,
        };
        if rooted != Rooted::Gone {
            if self.threads.len() > 1000 {
                self.threads.clear();
            }
            self.threads.insert(thread, rooted);
        }
        Ok(rooted)
    }

    pub(super) fn held(&self, name: &str) -> bool {
        self.member_servers.contains(name) || self.subs.contains(name)
    }

    /// The owner of channel `cid` and whether this connection views it, while that answer
    /// holds.
    pub(super) fn seen(&self, cid: i64) -> Option<(&str, bool)> {
        match self.viewable.get(&cid) {
            Some((_, _, Some(until))) if *until <= now() => None,
            Some((owner, view, _)) => Some((owner.as_str(), *view)),
            None => None,
        }
    }

    /// Whether this connection reads `server` from outside while it keeps its members to
    /// itself.
    pub(super) fn closes(&self, server: &str) -> bool {
        self.closed.contains(server) && !self.member_servers.contains(server)
    }

    /// Notes which servers this connection reads from outside keep their members to themselves.
    /// The site admin sees every member list; a failed read counts each of them as closed.
    pub(super) async fn note_closed(&mut self, db: &Db) {
        let outside: Vec<&str> = self
            .subs
            .iter()
            .filter(|s| !self.member_servers.contains(*s))
            .map(String::as_str)
            .collect();
        if self.site_admin {
            self.closed.clear();
            return;
        }
        self.closed = match ws_closed_servers(db, &outside).await {
            Ok(closed) => closed,
            Err(_) => outside.into_iter().map(str::to_string).collect(),
        };
    }

    /// Keeps `closed` in step with a server's `members_visible` from an event.
    pub(super) fn note_option(&mut self, server: &str, visible: bool) {
        match visible || self.site_admin || !self.subs.contains(server) {
            true => self.closed.remove(server),
            false => self.closed.insert(server.to_string()),
        };
    }

    /// Whether `ev` shows the members of a server this connection reads from outside while it
    /// keeps them to itself: who is in it, joins and leaves, admins, presence, and a member's
    /// name changes that reach it only through such servers. Events about the connection's own
    /// user still arrive. `join` and `leave` messages, and their deletions, are hidden whoever they
    /// are about, like in the channel's history.
    fn hides_members(&self, ev: &WsEvent) -> bool {
        let me = self.user.as_deref();
        let (server, about) = match ev {
            WsEvent::Message {
                server: Some(server),
                channel_id: _,
                dm_id: _,
                dm_users: _,
                message,
            } if is_membership_notice(&message.kind) => return self.closes(server),
            WsEvent::MessageDeleted {
                server: Some(server),
                channel_id: _,
                dm_id: _,
                dm_users: _,
                id: _,
                thread_root_id: _,
                notice: None | Some(true),
            } => return self.closes(server),
            WsEvent::MemberJoined { server, member } => (server, Some(&member.user.username)),
            WsEvent::MemberLeft { server, username }
            | WsEvent::MemberKicked {
                server,
                username,
                banned: _,
            }
            | WsEvent::AdminChanged {
                server,
                username,
                is_admin: _,
                perms: _,
            }
            | WsEvent::MemberRolesChanged {
                server,
                username,
                role_ids: _,
            }
            | WsEvent::PresenceChanged {
                server,
                username,
                online: _,
                online_count: _,
            }
            | WsEvent::MemberProfile {
                server,
                username,
                profile: _,
                bio: _,
                view_only: _,
            } => (server, Some(username)),
            WsEvent::MembersPurged { server, usernames } => {
                (server, usernames.iter().find(|u| Some(u.as_str()) == me))
            }
            WsEvent::PresenceSnapshot {
                server,
                online: _,
                online_count: _,
            } => (server, None),
            WsEvent::RoleUpdated { server: _, role: _ }
            | WsEvent::RolesReordered {
                server: _,
                order: _,
                display: _,
                version: _,
            } => return false,
            WsEvent::UserUpdated { user, scope } => {
                let mut held = scope
                    .servers
                    .iter()
                    .chain(scope.views.iter())
                    .filter(|s| self.held(s))
                    .peekable();
                return Some(user.username.as_str()) != me
                    && !me.is_some_and(|me| scope.users.iter().any(|u| u == me))
                    && held.peek().is_some()
                    && held.all(|s| self.closes(s));
            }
            _ => return false,
        };
        about.is_none_or(|u| Some(u.as_str()) != me) && self.closes(server)
    }

    pub(super) fn wants(&self, ev: &WsEvent) -> bool {
        if self.hides_members(ev) {
            return false;
        }
        let me = self.user.as_deref();
        match self.retry.pending() {
            false => {
                wants(ev, me, self.site_admin, &self.member_servers, &self.subs)
                    || self.guest_voice_wants(ev)
            }
            true => wants(ev, None, false, &HashSet::new(), &HashSet::new()),
        }
    }

    /// The name this connection has in voice rooms: its user's, or a guest's own.
    pub(super) fn voice_name(&self) -> Option<&str> {
        self.user.as_deref().or(self.guest.as_deref())
    }

    // What a guest gets as itself in voice: signals to it and the end of its voice.
    fn guest_voice_wants(&self, ev: &WsEvent) -> bool {
        let Some(name) = &self.guest else {
            return false;
        };
        match ev {
            WsEvent::RtcSignal {
                to,
                from: _,
                channel_id: _,
                dm_id: _,
                payload: _,
            } => to == name,
            WsEvent::VoiceEnded {
                server: None,
                channel_id: _,
                dm_id: _,
                dm_users: Some(users),
                reason: _,
            } => users.contains(name),
            _ => false,
        }
    }

    pub(super) fn hold(&mut self, e: sqlx::Error, started: Instant) -> bool {
        self.layouts.clear();
        self.viewable.clear();
        self.floors.clear();
        self.missed = true;
        self.retry.fail(e, started)
    }

    pub(super) async fn token_live(&mut self, db: &Db, limits: &Limits) -> sqlx::Result<bool> {
        let Some(token) = self.token.as_deref() else {
            return Ok(false);
        };
        match socket_account(db, limits, token).await? {
            SocketAccount::Open {
                password_expires, ..
            } => {
                self.password_expires = password_expires;
                Ok(true)
            }
            SocketAccount::Restricted => {
                self.restricted = true;
                Ok(false)
            }
            SocketAccount::Missing => Ok(false),
        }
    }

    pub(super) async fn check_token(&mut self, db: &Db, limits: &Limits) -> bool {
        let started = Instant::now();
        match self.token_live(db, limits).await {
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

pub(super) enum SocketAccount {
    Open {
        username: String,
        is_site_admin: bool,
        since: i64,
        password_expires: Option<i64>,
    },
    Restricted,
    Missing,
}

pub(super) async fn socket_account(
    db: &Db,
    limits: &Limits,
    token: &str,
) -> sqlx::Result<SocketAccount> {
    let Some(row) = token_row(db, limits, token).await? else {
        return Ok(SocketAccount::Missing);
    };
    let user = User::from_row(&row)?;
    if restricted(db, &user).await {
        Ok(SocketAccount::Restricted)
    } else {
        Ok(SocketAccount::Open {
            username: user.username,
            is_site_admin: user.is_site_admin,
            since: user.created_at,
            password_expires: user.temp.and_then(|temp| temp.expires_at),
        })
    }
}

pub(super) async fn reauthorize(state: &AppState, access: &mut Access) -> sqlx::Result<bool> {
    let db = &state.read();
    // The appear-offline setting comes from the primary: a replica behind it would announce a
    // stale value, and only a newer one replaces what the presence replica holds.
    if access.user.is_some()
        && access.token.is_some()
        && !access.token_live(db, &state.limits).await?
    {
        return Ok(false);
    }
    let (servers, mode) = match &access.user {
        Some(user) => {
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
    access.layouts.clear();
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
    leave_closed_voice(&state.hub, access);
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
    access.note_closed(db).await;
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
) -> sqlx::Result<Option<(String, bool, Option<i64>)>> {
    let Some((owner, _)) = ws_channel_now(db, cid).await? else {
        return Ok(None);
    };
    let (view, until) = ws_channel_seen(db, &owner, cid, username).await?;
    Ok(Some((owner, view, until)))
}

pub(super) async fn channel_gate(
    state: &AppState,
    access: &mut Access,
    server: &str,
    cid: i64,
) -> Option<bool> {
    if let Some((owner, view)) = access.seen(cid) {
        return Some(view && owner == server);
    }
    let started = Instant::now();
    let slot = state.hub.channels().slot(cid);
    let read = state.read();
    let shared = slot.get_or_try_init(|| ws_channel_policy(&read, cid)).await;
    let looked = match shared {
        Ok(Some(policy)) if policy.public_view => Ok(Some((policy.server.clone(), true, None))),
        Ok(Some(_)) => channel_view(&read, access.user.as_deref(), cid).await,
        Ok(None) => Ok(None),
        Err(e) => Err(e),
    };
    match looked {
        Ok(Some((owner, view, until))) => {
            let open = view && owner == server;
            access.viewable.insert(cid, (owner, view, until));
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
