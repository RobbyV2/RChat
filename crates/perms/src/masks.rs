use crate::Mask;
use crate::registry::{BITS, Scope, State, value};

const fn pick(everyone: Option<bool>, channel: Option<bool>) -> Mask {
    let (mut i, mut m) = (0, 0);
    while i < BITS.len() {
        let b = BITS[i];
        let live = matches!(b.hosted, State::Live);
        let ev = match everyone {
            Some(want) => b.everyone == want,
            None => true,
        };
        let ch = match channel {
            Some(want) => matches!(b.scope, Scope::Channel) == want,
            None => true,
        };
        if live && ev && ch {
            m |= b.value;
        }
        i += 1;
    }
    m
}

pub const VIEW: Mask = value("ViewChannels");
pub const SEND: Mask = value("SendMessages");
pub const HISTORY: Mask = value("ReadHistory");
pub const MANAGE_CHANNELS: Mask = value("ManageChannels");
pub const MANAGE_ROLES: Mask = value("ManageRoles");

/// What @everyone holds unless the server says otherwise.
pub const BASE: Mask = pick(Some(true), None);
/// The bits a channel overwrite may carry.
pub const CHANNEL: Mask = pick(None, Some(true));
/// The moderation bits among them.
pub const MOD_CHANNEL: Mask = CHANNEL & !BASE;
/// What a channel's "send" switch covers.
pub const SEND_GROUP: Mask = SEND
    | value("AddReactions")
    | value("AttachFiles")
    | value("EmbedLinks")
    | value("CreatePolls")
    | value("StartThreads");
/// What a voice channel asks for.
pub const VOICE: Mask = value("Connect") | value("Speak") | value("Video");
/// What Manage channels passes in every channel.
pub const MANAGER_PASS: Mask = (BASE & CHANNEL) | value("BypassSlowmode");
/// What a timed-out member keeps.
pub const TIMED_OUT_KEEP: Mask = VIEW | HISTORY | value("ViewAuditLog");
/// What an incoming webhook holds in its channel.
pub const WEBHOOK: Mask = VIEW | HISTORY | SEND | value("AttachFiles") | value("EmbedLinks");
/// What a read link holds in its channel, and what every visitor may hold.
pub const READ_LINK: Mask = VIEW | HISTORY;
/// What guest chat adds to a visitor.
pub const GUEST_CHAT: Mask = SEND;
/// What guest voice adds to a visitor.
pub const GUEST_VOICE: Mask = value("Connect") | value("Speak");
/// The management bits: every live bit @everyone does not start with.
pub const MGMT: Mask = pick(Some(false), None);
/// Every live hosted bit.
pub const ALL: Mask = crate::registry::ALL_HOSTED;
