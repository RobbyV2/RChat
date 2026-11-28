use crate::Mask;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Scope {
    Server,
    Channel,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum State {
    Live,
    Reserved,
}

/// A P2P wire bit: its value, its state, and the first rules version that knows it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Wire {
    pub value: u32,
    pub state: State,
    pub since: i64,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Bit {
    pub name: &'static str,
    pub label: &'static str,
    pub value: Mask,
    pub scope: Scope,
    pub everyone: bool,
    pub hosted: State,
    pub p2p: Option<Wire>,
}

const fn bit(
    name: &'static str,
    label: &'static str,
    value: Mask,
    scope: Scope,
    everyone: bool,
    hosted: State,
    p2p: Option<Wire>,
) -> Bit {
    Bit {
        name,
        label,
        value,
        scope,
        everyone,
        hosted,
        p2p,
    }
}

const fn wire(value: u32, state: State, since: i64) -> Option<Wire> {
    Some(Wire {
        value,
        state,
        since,
    })
}

use Scope::{Channel, Server};
use State::{Live, Reserved};

pub const BITS: &[Bit] = &[
    bit(
        "ManageChannels",
        "Manage channels",
        1,
        Server,
        false,
        Live,
        wire(1, Live, 2),
    ),
    bit(
        "DeleteMessages",
        "Manage messages",
        1 << 1,
        Channel,
        false,
        Live,
        wire(2, Live, 2),
    ),
    bit(
        "Kick",
        "Kick and ban",
        1 << 2,
        Server,
        false,
        Live,
        wire(4, Live, 2),
    ),
    bit(
        "DeleteServer",
        "Delete server",
        1 << 3,
        Server,
        false,
        Live,
        None,
    ),
    bit(
        "ManageAdmins",
        "Manage admins",
        1 << 4,
        Server,
        false,
        Live,
        None,
    ),
    bit(
        "MentionEveryone",
        "Mention everyone",
        1 << 5,
        Channel,
        false,
        Live,
        wire(128, Live, 2),
    ),
    bit(
        "ViewAuditLog",
        "View audit log",
        1 << 6,
        Server,
        false,
        Live,
        None,
    ),
    bit(
        "TimeoutMembers",
        "Time out members",
        1 << 7,
        Server,
        false,
        Live,
        wire(1 << 24, Live, 5),
    ),
    bit(
        "ManageWebhooks",
        "Manage webhooks",
        1 << 8,
        Server,
        false,
        Live,
        None,
    ),
    bit(
        "ManageReports",
        "Manage reports",
        1 << 9,
        Server,
        false,
        Live,
        None,
    ),
    bit(
        "MoveMembers",
        "Move members",
        1 << 10,
        Channel,
        false,
        Reserved,
        wire(1 << 26, Reserved, 5),
    ),
    bit(
        "ManageAutomations",
        "Manage automations",
        1 << 11,
        Server,
        false,
        Reserved,
        None,
    ),
    bit(
        "ManageServer",
        "Manage server",
        1 << 12,
        Server,
        false,
        Live,
        wire(8, Live, 2),
    ),
    bit(
        "ManageInvites",
        "Manage invites",
        1 << 13,
        Server,
        false,
        Live,
        None,
    ),
    bit(
        "ManageRoles",
        "Manage roles",
        1 << 14,
        Server,
        false,
        Live,
        wire(16, Live, 2),
    ),
    bit(
        "AssignRoles",
        "Assign roles",
        1 << 15,
        Server,
        false,
        Live,
        wire(1 << 27, Live, 5),
    ),
    bit(
        "ManageProfiles",
        "Reset server profiles",
        1 << 16,
        Server,
        false,
        Live,
        wire(1 << 23, Live, 5),
    ),
    bit(
        "ViewChannels",
        "View channels",
        1 << 17,
        Channel,
        true,
        Live,
        wire(256, Live, 2),
    ),
    bit(
        "SendMessages",
        "Send messages",
        1 << 18,
        Channel,
        true,
        Live,
        wire(512, Live, 2),
    ),
    bit(
        "ReadHistory",
        "Read history",
        1 << 19,
        Channel,
        true,
        Live,
        wire(1 << 25, Reserved, 5),
    ),
    bit(
        "AddReactions",
        "Add reactions",
        1 << 20,
        Channel,
        true,
        Live,
        wire(1 << 12, Live, 5),
    ),
    bit(
        "AttachFiles",
        "Attach files",
        1 << 21,
        Channel,
        true,
        Live,
        wire(1 << 13, Live, 5),
    ),
    bit(
        "EmbedLinks",
        "Embed links",
        1 << 22,
        Channel,
        true,
        Live,
        wire(1 << 14, Live, 5),
    ),
    bit(
        "CreatePolls",
        "Create polls",
        1 << 23,
        Channel,
        true,
        Live,
        wire(1 << 15, Reserved, 5),
    ),
    bit(
        "StartThreads",
        "Start threads",
        1 << 24,
        Channel,
        true,
        Live,
        wire(1 << 16, Live, 5),
    ),
    bit(
        "Connect",
        "Connect",
        1 << 25,
        Channel,
        true,
        Live,
        wire(1 << 17, Live, 5),
    ),
    bit(
        "Speak",
        "Speak",
        1 << 26,
        Channel,
        true,
        Live,
        wire(1 << 18, Live, 5),
    ),
    bit(
        "Video",
        "Video",
        1 << 27,
        Channel,
        true,
        Live,
        wire(1 << 19, Live, 5),
    ),
    bit(
        "ChangeProfile",
        "Change server profile",
        1 << 28,
        Server,
        true,
        Reserved,
        wire(1 << 22, Reserved, 5),
    ),
    bit(
        "PinMessages",
        "Pin messages",
        1 << 29,
        Channel,
        false,
        Live,
        wire(1 << 20, Live, 5),
    ),
    bit(
        "BypassSlowmode",
        "Bypass slow mode",
        1 << 30,
        Channel,
        false,
        Live,
        wire(1 << 21, Live, 5),
    ),
    bit(
        "ManageLook",
        "Manage look",
        1 << 31,
        Server,
        false,
        Reserved,
        wire(1024, Reserved, 2),
    ),
    bit(
        "ManageApps",
        "Manage apps",
        1 << 32,
        Server,
        false,
        Reserved,
        wire(2048, Reserved, 2),
    ),
    bit(
        "BanMembers",
        "Ban members",
        1 << 33,
        Server,
        false,
        Reserved,
        wire(32, Live, 2),
    ),
    bit(
        "CreateInvites",
        "Create invites",
        1 << 34,
        Server,
        false,
        Reserved,
        wire(64, Live, 2),
    ),
    bit(
        "ViewMembers",
        "View members",
        1 << 35,
        Channel,
        true,
        Live,
        None,
    ),
];

pub const fn value(name: &str) -> Mask {
    let mut i = 0;
    while i < BITS.len() {
        if same(BITS[i].name, name) {
            return BITS[i].value;
        }
        i += 1;
    }
    panic!("unknown permission bit")
}

const fn same(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut i = 0;
    while i < a.len() {
        if a[i] != b[i] {
            return false;
        }
        i += 1;
    }
    true
}

/// Every bit that is live on hosted servers.
pub const ALL_HOSTED: Mask = {
    let (mut i, mut m) = (0, 0);
    while i < BITS.len() {
        if matches!(BITS[i].hosted, State::Live) {
            m |= BITS[i].value;
        }
        i += 1;
    }
    m
};

/// The wire bits a room under `rules` knows.
pub const fn p2p_known(rules: i64) -> u32 {
    let (mut i, mut m) = (0, 0);
    while i < BITS.len() {
        if let Some(Wire {
            value,
            state: State::Live,
            since,
        }) = BITS[i].p2p
            && since <= rules
        {
            m |= value;
        }
        i += 1;
    }
    m
}

fn state(s: State) -> &'static str {
    match s {
        State::Live => "live",
        State::Reserved => "reserved",
    }
}

/// The registry as JSON, for labels and for the checks other languages run against it.
pub fn json() -> String {
    let rows: Vec<String> = BITS
        .iter()
        .map(|b| {
            let Bit {
                name,
                label,
                value,
                scope,
                everyone,
                hosted,
                p2p,
            } = *b;
            let scope = match scope {
                Scope::Server => "server",
                Scope::Channel => "channel",
            };
            let p2p = match p2p {
                Some(Wire {
                    value,
                    state: s,
                    since,
                }) => format!(
                    "{{\"value\":{value},\"state\":\"{}\",\"since\":{since}}}",
                    state(s)
                ),
                None => "null".to_string(),
            };
            format!(
                "{{\"name\":\"{name}\",\"label\":\"{label}\",\"value\":{value},\"scope\":\"{scope}\",\"everyone\":{everyone},\"hosted\":\"{}\",\"p2p\":{p2p}}}",
                state(hosted)
            )
        })
        .collect();
    format!("[{}]", rows.join(","))
}
