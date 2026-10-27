use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};

use axum::extract::ws::Utf8Bytes;
use tokio::sync::{OnceCell, mpsc};

use crate::ws::WsEvent;

const INBOX: usize = 512;
const CHANNELS_KEPT: usize = 100_000;

pub struct Fanned {
    pub ev: WsEvent,
    pub seq: u64,
    json: OnceLock<Option<Utf8Bytes>>,
}

impl Fanned {
    pub fn new(ev: WsEvent, seq: u64) -> Fanned {
        Fanned {
            ev,
            seq,
            json: OnceLock::new(),
        }
    }

    pub fn frame(&self) -> Option<Utf8Bytes> {
        self.json
            .get_or_init(|| {
                let json = match &self.ev {
                    WsEvent::MembersPurged {
                        server,
                        usernames: _,
                    } => serde_json::to_string(&WsEvent::RolesChanged {
                        server: server.clone(),
                    }),
                    ev => serde_json::to_string(ev),
                };
                json.ok().map(Utf8Bytes::from)
            })
            .clone()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Topic {
    All,
    Admin,
    User(String),
    Server(String),
    View(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target<'a> {
    Admins,
    User(&'a str),
    Server(&'a str),
    View(&'a str),
}

#[derive(Debug, PartialEq, Eq)]
pub enum Route<'a> {
    Everyone,
    To(Vec<Target<'a>>),
}

fn scoped<'a>(server: &'a Option<String>, dm_users: &'a Option<Vec<String>>) -> Vec<Target<'a>> {
    match (server, dm_users) {
        (Some(s), _) => vec![Target::Server(s)],
        (None, Some(users)) => users.iter().map(|u| Target::User(u)).collect(),
        (None, None) => Vec::new(),
    }
}

fn users(list: &[String]) -> Vec<Target<'_>> {
    list.iter().map(|u| Target::User(u)).collect()
}

pub fn route(ev: &WsEvent) -> Route<'_> {
    let to = Route::To;
    match ev {
        WsEvent::Message {
            server,
            channel_id: _,
            dm_id: _,
            dm_users,
            message: _,
        }
        | WsEvent::MessageDeleted {
            server,
            channel_id: _,
            dm_id: _,
            dm_users,
            id: _,
            thread_root_id: _,
        }
        | WsEvent::MediaRemoved {
            server,
            channel_id: _,
            dm_id: _,
            dm_users,
            message_id: _,
            filename: _,
            removed_by_author: _,
        }
        | WsEvent::EmbedsResolved {
            server,
            channel_id: _,
            dm_id: _,
            dm_users,
            message_id: _,
            embeds: _,
        }
        | WsEvent::EmbedsRemoved {
            server,
            channel_id: _,
            dm_id: _,
            dm_users,
            message_id: _,
            ord: _,
            banner: _,
        }
        | WsEvent::VoiceEnded {
            server,
            channel_id: _,
            dm_id: _,
            dm_users,
            reason: _,
        } => to(scoped(server, dm_users)),
        WsEvent::MessageUpdated {
            message: _,
            dm_users,
        }
        | WsEvent::DmCreated { dm_id: _, dm_users }
        | WsEvent::CallState {
            dm_id: _,
            dm_users,
            state: _,
            from: _,
            kind: _,
        } => to(users(dm_users)),
        WsEvent::ChannelCreated { server, channel: _ }
        | WsEvent::ChannelRenamed { server, channel: _ }
        | WsEvent::ChannelUpdated { server, channel: _ }
        | WsEvent::ChannelDeleted {
            server,
            channel_id: _,
        }
        | WsEvent::RolesChanged { server }
        | WsEvent::ChannelPermsChanged {
            server,
            channel_id: _,
        }
        | WsEvent::VoiceState {
            server,
            channel_id: _,
            users: _,
        } => to(vec![Target::Server(server)]),
        WsEvent::MemberJoined { server, member } => to(vec![
            Target::Server(server),
            Target::User(&member.user.username),
        ]),
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
        } => to(vec![Target::Server(server), Target::User(username)]),
        WsEvent::MembersPurged { server, usernames } => {
            let mut targets = vec![Target::Server(server)];
            targets.extend(users(usernames));
            to(targets)
        }
        WsEvent::PresenceChanged {
            server,
            username: _,
            online: _,
            online_count: _,
        } => to(vec![Target::View(server)]),
        WsEvent::PresenceSnapshot {
            server: _,
            online: _,
            online_count: _,
        } => to(Vec::new()),
        WsEvent::ServerBanned {
            server: _,
            username,
        }
        | WsEvent::PresenceMode {
            username,
            appear_offline: _,
        }
        | WsEvent::ReadUpdated {
            username,
            scope: _,
            last_read: _,
        }
        | WsEvent::TokensRevoked { username } => to(vec![Target::User(username)]),
        WsEvent::RtcSignal {
            to: user,
            from: _,
            channel_id: _,
            dm_id: _,
            payload: _,
        } => to(vec![Target::User(user)]),
        WsEvent::ServerCreated { server } => {
            let mut targets = vec![Target::Admins, Target::Server(&server.name)];
            targets.extend(server.creator.as_deref().map(Target::User));
            to(targets)
        }
        WsEvent::ServerRenamed { old_name, server } => to(vec![
            Target::Admins,
            Target::Server(old_name),
            Target::Server(&server.name),
        ]),
        WsEvent::ServerUpdated { server } => to(vec![Target::Admins, Target::Server(&server.name)]),
        WsEvent::ServerDeleted { name } => to(vec![Target::Admins, Target::Server(name)]),
        WsEvent::P2pAvailability {
            hoster,
            peer_id: _,
            ids: _,
            online: _,
            scope_servers,
            scope_users,
        } => {
            let mut targets = vec![Target::User(hoster)];
            targets.extend(scope_servers.iter().map(|s| Target::Server(s)));
            targets.extend(users(scope_users));
            to(targets)
        }
        WsEvent::UserRegistered { user: _ } => to(vec![Target::Admins]),
        WsEvent::UserUpdated { user, scope } if !scope.is_empty() => {
            let crate::ws::UserScope {
                servers,
                views,
                users: partners,
            } = scope;
            let mut targets = vec![Target::User(&user.username)];
            targets.extend(servers.iter().map(|s| Target::Server(s)));
            targets.extend(views.iter().map(|s| Target::View(s)));
            targets.extend(users(partners));
            to(targets)
        }
        WsEvent::UserUpdated { user: _, scope: _ }
        | WsEvent::Banned { username: _ }
        | WsEvent::SettingsChanged { settings: _ } => Route::Everyone,
        WsEvent::Error { message: _ } | WsEvent::Resync => to(Vec::new()),
    }
}

fn grants(ev: &WsEvent) -> Vec<(Target<'_>, Topic)> {
    match ev {
        WsEvent::MemberJoined { server, member } => vec![(
            Target::User(&member.user.username),
            Topic::Server(server.clone()),
        )],
        WsEvent::ServerCreated { server } => server
            .creator
            .as_deref()
            .map(|c| (Target::User(c), Topic::Server(server.name.clone())))
            .into_iter()
            .collect(),
        WsEvent::ServerRenamed { old_name, server } if *old_name != server.name => vec![
            (Target::Server(old_name), Topic::Server(server.name.clone())),
            (Target::View(old_name), Topic::View(server.name.clone())),
        ],
        _ => Vec::new(),
    }
}

struct Reg {
    tx: mpsc::Sender<Arc<Fanned>>,
    lagged: Arc<AtomicBool>,
    topics: HashMap<Topic, u64>,
}

impl Reg {
    fn push(&self, ev: &Arc<Fanned>) {
        if let Err(mpsc::error::TrySendError::Full(_)) = self.tx.try_send(ev.clone()) {
            self.lagged.store(true, Ordering::Relaxed);
        }
    }
}

#[derive(Default)]
struct Index {
    conns: HashMap<u64, Reg>,
    wild: HashSet<u64>,
    admins: HashSet<u64>,
    users: HashMap<String, HashSet<u64>>,
    servers: HashMap<String, HashSet<u64>>,
    views: HashMap<String, HashSet<u64>>,
}

impl Index {
    fn bucket<'a, 'b>(
        &'a mut self,
        topic: &'b Topic,
    ) -> Option<(&'a mut HashMap<String, HashSet<u64>>, &'b str)> {
        match topic {
            Topic::All | Topic::Admin => None,
            Topic::User(u) => Some((&mut self.users, u)),
            Topic::Server(s) => Some((&mut self.servers, s)),
            Topic::View(s) => Some((&mut self.views, s)),
        }
    }

    fn link(&mut self, conn: u64, topic: &Topic) {
        if *topic == Topic::All {
            self.wild.insert(conn);
            return;
        }
        match self.bucket(topic) {
            None => {
                self.admins.insert(conn);
            }
            Some((map, key)) => {
                let key = key.to_string();
                map.entry(key).or_default().insert(conn);
            }
        }
    }

    fn unlink(&mut self, conn: u64, topic: &Topic) {
        if *topic == Topic::All {
            self.wild.remove(&conn);
            return;
        }
        match self.bucket(topic) {
            None => {
                self.admins.remove(&conn);
            }
            Some((map, key)) => {
                if let Some(set) = map.get_mut(key) {
                    set.remove(&conn);
                    if set.is_empty() {
                        map.remove(key);
                    }
                }
            }
        }
    }

    fn add(&mut self, conn: u64, topic: Topic, at: u64) {
        let Some(reg) = self.conns.get_mut(&conn) else {
            return;
        };
        if let Some(seen) = reg.topics.get_mut(&topic) {
            *seen = (*seen).max(at);
            return;
        }
        reg.topics.insert(topic.clone(), at);
        self.link(conn, &topic);
    }

    fn members(&self, target: Target) -> Option<&HashSet<u64>> {
        match target {
            Target::Admins => Some(&self.admins),
            Target::User(u) => self.users.get(u),
            Target::Server(s) => self.servers.get(s),
            Target::View(s) => self.views.get(s),
        }
    }

    fn push(&self, conn: u64, ev: &Arc<Fanned>) {
        if let Some(reg) = self.conns.get(&conn) {
            reg.push(ev);
        }
    }
}

#[derive(Default)]
pub struct Router {
    index: RwLock<Index>,
    seq: AtomicU64,
}

pub struct Inbox {
    pub rx: mpsc::Receiver<Arc<Fanned>>,
    pub lagged: Arc<AtomicBool>,
}

impl Inbox {
    pub fn lagged(&self) -> bool {
        self.lagged.swap(false, Ordering::Relaxed)
    }

    pub fn drain(&mut self) -> Option<u64> {
        let mut last = None;
        while let Ok(ev) = self.rx.try_recv() {
            last = Some(ev.seq);
        }
        self.lagged.store(false, Ordering::Relaxed);
        last
    }
}

impl Router {
    pub fn open(&self, conn: u64, topics: &HashSet<Topic>) -> Inbox {
        let (tx, rx) = mpsc::channel(INBOX);
        let lagged = Arc::new(AtomicBool::new(false));
        let mut index = self.index.write().unwrap();
        index.conns.insert(
            conn,
            Reg {
                tx,
                lagged: lagged.clone(),
                topics: HashMap::new(),
            },
        );
        for topic in topics {
            index.add(conn, topic.clone(), 0);
        }
        Inbox { rx, lagged }
    }

    pub fn close(&self, conn: u64) {
        let mut index = self.index.write().unwrap();
        if let Some(reg) = index.conns.remove(&conn) {
            for topic in reg.topics.keys() {
                index.unlink(conn, topic);
            }
        }
    }

    pub fn add(&self, conn: u64, topics: &[Topic]) {
        let mut index = self.index.write().unwrap();
        for topic in topics {
            index.add(conn, topic.clone(), 0);
        }
    }

    pub fn reconcile(&self, conn: u64, want: &HashSet<Topic>, through: u64) {
        let mut index = self.index.write().unwrap();
        let Some(reg) = index.conns.get(&conn) else {
            return;
        };
        let stale: Vec<Topic> = reg
            .topics
            .iter()
            .filter(|(t, at)| !want.contains(*t) && **at <= through)
            .map(|(t, _)| t.clone())
            .collect();
        let fresh: Vec<Topic> = want
            .iter()
            .filter(|t| !reg.topics.contains_key(*t))
            .cloned()
            .collect();
        for topic in stale {
            if let Some(reg) = index.conns.get_mut(&conn) {
                reg.topics.remove(&topic);
            }
            index.unlink(conn, &topic);
        }
        for topic in fresh {
            index.add(conn, topic, 0);
        }
    }

    pub fn topics(&self, conn: u64) -> HashSet<Topic> {
        self.index
            .read()
            .unwrap()
            .conns
            .get(&conn)
            .map(|reg| reg.topics.keys().cloned().collect())
            .unwrap_or_default()
    }

    pub fn connections(&self) -> usize {
        self.index.read().unwrap().conns.len()
    }

    pub fn deliver(&self, ev: WsEvent) {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        let added = grants(&ev);
        if !added.is_empty() {
            let mut index = self.index.write().unwrap();
            for (from, topic) in added {
                let conns: Vec<u64> = index
                    .members(from)
                    .map(|set| set.iter().copied().collect())
                    .unwrap_or_default();
                for conn in conns {
                    index.add(conn, topic.clone(), seq);
                }
            }
        }
        let fanned = Arc::new(Fanned::new(ev, seq));
        let index = self.index.read().unwrap();
        match route(&fanned.ev) {
            Route::Everyone => {
                for reg in index.conns.values() {
                    reg.push(&fanned);
                }
            }
            Route::To(targets) => match targets.as_slice() {
                [one] => {
                    let set = index.members(*one);
                    if let Some(set) = set {
                        for conn in set {
                            index.push(*conn, &fanned);
                        }
                    }
                    for conn in &index.wild {
                        if !set.is_some_and(|set| set.contains(conn)) {
                            index.push(*conn, &fanned);
                        }
                    }
                }
                many => {
                    let mut seen = HashSet::new();
                    for conn in &index.wild {
                        if seen.insert(*conn) {
                            index.push(*conn, &fanned);
                        }
                    }
                    for target in many {
                        if let Some(set) = index.members(*target) {
                            for conn in set {
                                if seen.insert(*conn) {
                                    index.push(*conn, &fanned);
                                }
                            }
                        }
                    }
                }
            },
        }
    }
}

type ChannelSlot = Arc<OnceCell<Option<(String, bool)>>>;

#[derive(Default)]
pub struct Channels {
    slots: Mutex<HashMap<i64, ChannelSlot>>,
}

impl Channels {
    pub fn slot(&self, channel_id: i64) -> ChannelSlot {
        let mut slots = self.slots.lock().unwrap();
        if slots.len() >= CHANNELS_KEPT && !slots.contains_key(&channel_id) {
            slots.clear();
        }
        slots.entry(channel_id).or_default().clone()
    }

    fn forget_server(&self, name: &str) {
        self.slots
            .lock()
            .unwrap()
            .retain(|_, slot| match slot.get() {
                Some(Some((owner, _))) => owner != name,
                Some(None) => true,
                None => false,
            });
    }

    pub fn observe(&self, ev: &WsEvent) {
        match ev {
            WsEvent::ChannelCreated { server: _, channel }
            | WsEvent::ChannelRenamed { server: _, channel }
            | WsEvent::ChannelUpdated { server: _, channel } => {
                self.slots.lock().unwrap().remove(&channel.id);
            }
            WsEvent::ChannelDeleted {
                server: _,
                channel_id,
            }
            | WsEvent::ChannelPermsChanged {
                server: _,
                channel_id,
            } => {
                self.slots.lock().unwrap().remove(channel_id);
            }
            WsEvent::ServerRenamed {
                old_name,
                server: _,
            } => self.forget_server(old_name),
            WsEvent::ServerUpdated { server } => self.forget_server(&server.name),
            WsEvent::ServerDeleted { name } => self.forget_server(name),
            _ => {}
        }
    }

    pub fn clear(&self) {
        self.slots.lock().unwrap().clear();
    }

    pub fn len(&self) -> usize {
        self.slots.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &str) -> String {
        v.to_string()
    }

    fn topics(list: &[Topic]) -> HashSet<Topic> {
        list.iter().cloned().collect()
    }

    fn drain(inbox: &mut Inbox) -> Vec<u64> {
        std::iter::from_fn(|| inbox.rx.try_recv().ok())
            .map(|f| f.seq)
            .collect()
    }

    fn roles(server: &str) -> WsEvent {
        WsEvent::RolesChanged { server: s(server) }
    }

    #[test]
    fn events_reach_only_their_topics() {
        let router = Router::default();
        let mut club = router.open(1, &topics(&[Topic::Server(s("club"))]));
        let mut other = router.open(2, &topics(&[Topic::Server(s("other"))]));
        let mut both = router.open(
            3,
            &topics(&[Topic::Server(s("club")), Topic::User(s("carol"))]),
        );
        router.deliver(roles("club"));
        router.deliver(WsEvent::MemberKicked {
            server: s("club"),
            username: s("carol"),
            banned: false,
        });
        router.deliver(WsEvent::Banned { username: s("x") });
        assert_eq!(drain(&mut club), vec![1, 2, 3]);
        assert_eq!(drain(&mut other), vec![3]);
        assert_eq!(drain(&mut both), vec![1, 2, 3]);
        router.close(1);
        router.deliver(roles("club"));
        assert_eq!(drain(&mut both), vec![4]);
        assert_eq!(router.connections(), 2);
    }

    #[test]
    fn joins_are_heard_before_the_connection_catches_up() {
        let router = Router::default();
        let mut alice = router.open(1, &topics(&[Topic::User(s("alice"))]));
        router.deliver(WsEvent::RolesChanged { server: s("club") });
        router.deliver(WsEvent::MemberJoined {
            server: s("club"),
            member: crate::api::Member {
                user: crate::api::UserRef {
                    username: s("alice"),
                    display_name: s("alice"),
                    avatar_kind: crate::db::AvatarKind::Identicon,
                    avatar_color: None,
                },
                is_admin: false,
                is_creator: false,
                online: false,
                perms: 0,
                role_ids: Vec::new(),
            },
        });
        router.deliver(roles("club"));
        assert_eq!(drain(&mut alice), vec![2, 3]);
        let mine = topics(&[Topic::User(s("alice"))]);
        router.reconcile(1, &mine, 1);
        router.deliver(roles("club"));
        assert_eq!(drain(&mut alice), vec![4]);
        router.reconcile(1, &mine, 4);
        router.deliver(roles("club"));
        assert!(drain(&mut alice).is_empty());
    }

    #[test]
    fn renames_carry_listeners_along() {
        let router = Router::default();
        let mut viewer = router.open(1, &topics(&[Topic::View(s("a")), Topic::Server(s("a"))]));
        router.deliver(WsEvent::ServerRenamed {
            old_name: s("a"),
            server: crate::api::ServerSummaryLite {
                name: s("b"),
                display_name: s("b"),
                creator: None,
                has_password: false,
                banner_color: None,
                name_color: None,
            },
        });
        router.deliver(WsEvent::PresenceChanged {
            server: s("b"),
            username: s("x"),
            online: true,
            online_count: 1,
        });
        router.deliver(roles("b"));
        assert_eq!(drain(&mut viewer), vec![1, 2, 3]);
    }

    #[test]
    fn updates_reach_the_server_and_admins_only() {
        let router = Router::default();
        let mut member = router.open(1, &topics(&[Topic::Server(s("a"))]));
        let mut admin = router.open(2, &topics(&[Topic::Admin]));
        let mut other = router.open(3, &topics(&[Topic::Server(s("b"))]));
        let channel = crate::api::Channel {
            id: 9,
            name: s("general"),
            kind: crate::db::ChannelKind::Text,
            slowmode_seconds: 5,
        };
        router.deliver(WsEvent::ServerUpdated {
            server: crate::api::ServerSummaryLite {
                name: s("a"),
                display_name: s("a"),
                creator: None,
                has_password: true,
                banner_color: None,
                name_color: None,
            },
        });
        router.deliver(WsEvent::ChannelUpdated {
            server: s("a"),
            channel,
        });
        assert_eq!(drain(&mut member), vec![1, 2]);
        assert_eq!(drain(&mut admin), vec![1]);
        assert!(drain(&mut other).is_empty());
    }

    #[test]
    fn wildcard_listeners_hear_everything_once() {
        let router = Router::default();
        let mut early = router.open(1, &topics(&[Topic::All]));
        let mut admin = router.open(2, &topics(&[Topic::Admin]));
        router.deliver(roles("club"));
        router.deliver(WsEvent::UserRegistered {
            user: crate::api::UserRef {
                username: s("new"),
                display_name: s("new"),
                avatar_kind: crate::db::AvatarKind::Identicon,
                avatar_color: None,
            },
        });
        assert_eq!(drain(&mut early), vec![1, 2]);
        assert_eq!(drain(&mut admin), vec![2]);
        router.reconcile(1, &HashSet::new(), 0);
        router.deliver(roles("club"));
        assert!(drain(&mut early).is_empty());
    }

    #[test]
    fn overflow_marks_the_connection_lagged() {
        let router = Router::default();
        let mut inbox = router.open(1, &topics(&[Topic::Server(s("club"))]));
        for _ in 0..INBOX + 5 {
            router.deliver(roles("club"));
        }
        assert!(inbox.lagged());
        assert!(!inbox.lagged());
        assert_eq!(drain(&mut inbox).len(), INBOX);
    }

    #[test]
    fn serialized_once_and_purges_hide_the_list() {
        let fanned = Fanned::new(
            WsEvent::MembersPurged {
                server: s("club"),
                usernames: vec![s("bob")],
            },
            1,
        );
        let first = fanned.frame().unwrap();
        assert_eq!(
            first.as_str(),
            r#"{"type":"roles_changed","server":"club"}"#
        );
        assert_eq!(fanned.frame().unwrap().as_str(), first.as_str());
        assert_eq!(
            serde_json::to_string(&fanned.ev).unwrap(),
            r#"{"type":"members_purged","server":"club"}"#
        );
        assert!(
            crate::ws::to_bus_json(&fanned.ev)
                .unwrap()
                .contains(r#""usernames":["bob"]"#)
        );
    }

    #[tokio::test]
    async fn channel_cache_forgets_on_changes() {
        let channels = Channels::default();
        let fill = |cid: i64, owner: &str, open: bool| {
            let slot = channels.slot(cid);
            slot.set(Some((s(owner), open))).unwrap();
        };
        fill(1, "a", true);
        fill(2, "a", true);
        fill(3, "b", false);
        channels.observe(&WsEvent::ChannelPermsChanged {
            server: s("a"),
            channel_id: 1,
        });
        assert!(channels.slot(1).get().is_none());
        channels.observe(&WsEvent::ServerDeleted { name: s("a") });
        assert!(channels.slot(2).get().is_none());
        assert_eq!(channels.slot(3).get(), Some(&Some((s("b"), false))));
        channels.clear();
        assert!(channels.slot(3).get().is_none());
    }
}
