use std::cell::Cell;

use serde::{Deserialize, Serialize};

use super::{CallKind, CallPhase};

use crate::api::access::ViewRules;
use crate::api::pings::{Ping, ThreadPings};
use crate::api::{
    Channel, ChannelLayout, Embed, Member, Message, ServerSummaryLite, Settings, UserRef,
};

thread_local! {
    static BUS_WIRE: Cell<bool> = const { Cell::new(false) };
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserScope {
    pub servers: Vec<String>,
    pub views: Vec<String>,
    pub users: Vec<String>,
}

impl UserScope {
    pub fn is_empty(&self) -> bool {
        let UserScope {
            servers,
            views,
            users,
        } = self;
        servers.is_empty() && views.is_empty() && users.is_empty()
    }
}

fn routing_only<T>(_: &T) -> bool {
    !BUS_WIRE.with(Cell::get)
}

pub fn to_bus_json<T: Serialize>(value: &T) -> serde_json::Result<String> {
    struct Restore(bool);
    impl Drop for Restore {
        fn drop(&mut self) {
            BUS_WIRE.with(|w| w.set(self.0));
        }
    }
    let _restore = Restore(BUS_WIRE.with(|w| w.replace(true)));
    serde_json::to_string(value)
}

/// What a `message_updated` carries: the whole message (DMs, call logs), or for an edit in a
/// server channel only which message changed, so viewers without read history of it learn
/// nothing; clients holding it re-read it through the gated REST list.
#[derive(Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Updated {
    Stub(EditStub),
    Full { message: Box<Message> },
}

#[derive(Clone, Serialize, Deserialize)]
pub struct EditStub {
    pub id: i64,
    pub thread_root_id: Option<i64>,
    pub edited_at: Option<i64>,
    pub stub: bool,
}

impl Updated {
    pub fn full(message: Message) -> Self {
        Updated::Full {
            message: Box::new(message),
        }
    }

    pub fn stub(id: i64, thread_root_id: Option<i64>, edited_at: Option<i64>) -> Self {
        Updated::Stub(EditStub {
            id,
            thread_root_id,
            edited_at,
            stub: true,
        })
    }

    pub fn id(&self) -> i64 {
        match self {
            Updated::Stub(EditStub {
                id,
                thread_root_id: _,
                edited_at: _,
                stub: _,
            }) => *id,
            Updated::Full { message } => message.id,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WsEvent {
    Message {
        server: Option<String>,
        channel_id: Option<i64>,
        dm_id: Option<i64>,
        dm_users: Option<Vec<String>>,
        message: Box<Message>,
    },
    MessageUpdated {
        #[serde(default)]
        server: Option<String>,
        #[serde(default)]
        channel_id: Option<i64>,
        #[serde(flatten)]
        update: Updated,
        #[serde(default, skip_serializing_if = "routing_only")]
        dm_users: Vec<String>,
    },
    MessageDeleted {
        server: Option<String>,
        channel_id: Option<i64>,
        dm_id: Option<i64>,
        dm_users: Option<Vec<String>>,
        id: i64,
        thread_root_id: Option<i64>,
    },
    /// Messages of one channel, thread (`thread_root_id`) or DM deleted together by a bulk
    /// delete; ids only. A viewer without read history of some of them gets only the ids it
    /// could read (`created` is routing only).
    MessagesDeleted {
        server: Option<String>,
        channel_id: Option<i64>,
        dm_id: Option<i64>,
        dm_users: Option<Vec<String>>,
        thread_root_id: Option<i64>,
        ids: Vec<i64>,
        #[serde(default, skip_serializing_if = "routing_only")]
        created: Vec<i64>,
    },
    MediaRemoved {
        server: Option<String>,
        channel_id: Option<i64>,
        dm_id: Option<i64>,
        dm_users: Option<Vec<String>>,
        message_id: i64,
        removed_by_author: bool,
    },
    EmbedsResolved {
        server: Option<String>,
        channel_id: Option<i64>,
        dm_id: Option<i64>,
        dm_users: Option<Vec<String>>,
        message_id: i64,
        embeds: Vec<Embed>,
    },
    EmbedsRemoved {
        server: Option<String>,
        channel_id: Option<i64>,
        dm_id: Option<i64>,
        dm_users: Option<Vec<String>>,
        message_id: i64,
        ord: i64,
        banner: bool,
    },
    ReactionAdded {
        server: Option<String>,
        channel_id: Option<i64>,
        dm_id: Option<i64>,
        dm_users: Option<Vec<String>>,
        message_id: i64,
        thread_root_id: Option<i64>,
        emoji: String,
        username: String,
        count: i64,
    },
    ReactionRemoved {
        server: Option<String>,
        channel_id: Option<i64>,
        dm_id: Option<i64>,
        dm_users: Option<Vec<String>>,
        message_id: i64,
        thread_root_id: Option<i64>,
        emoji: String,
        username: String,
        count: i64,
    },
    PollUpdated {
        server: Option<String>,
        channel_id: Option<i64>,
        dm_id: Option<i64>,
        dm_users: Option<Vec<String>>,
        message_id: i64,
        thread_root_id: Option<i64>,
        created_at: i64,
        poll: Box<crate::api::polls::Poll>,
    },
    MessagePinned {
        server: Option<String>,
        channel_id: Option<i64>,
        dm_id: Option<i64>,
        dm_users: Option<Vec<String>>,
        message_id: i64,
        pinned_at: i64,
        pinned_by: String,
    },
    MessageUnpinned {
        server: Option<String>,
        channel_id: Option<i64>,
        dm_id: Option<i64>,
        dm_users: Option<Vec<String>>,
        message_id: i64,
    },
    ChannelCreated {
        server: String,
        channel: Channel,
    },
    ChannelRenamed {
        server: String,
        channel: Channel,
    },
    ChannelUpdated {
        server: String,
        channel: Channel,
    },
    ChannelDeleted {
        server: String,
        channel_id: i64,
        #[serde(default, skip_serializing_if = "routing_only")]
        rules: Option<ViewRules>,
    },
    ServerCreated {
        server: ServerSummaryLite,
    },
    ServerRenamed {
        old_name: String,
        server: ServerSummaryLite,
    },
    ServerUpdated {
        server: ServerSummaryLite,
    },
    ServerDeleted {
        name: String,
    },
    MemberJoined {
        server: String,
        member: Member,
    },
    MemberLeft {
        server: String,
        username: String,
    },
    MemberKicked {
        server: String,
        username: String,
        banned: bool,
    },
    MembersPurged {
        server: String,
        #[serde(default, skip_serializing_if = "routing_only")]
        usernames: Vec<String>,
    },
    AdminChanged {
        server: String,
        username: String,
        is_admin: bool,
        perms: i64,
    },
    RolesChanged {
        server: String,
    },
    /// The server's upload expiry changed; clients load the server again.
    UploadExpiryChanged {
        server: String,
    },
    ChannelPermsChanged {
        server: String,
        channel_id: i64,
    },
    LayoutChanged {
        server: String,
        layout: ChannelLayout,
        #[serde(default, skip_serializing_if = "routing_only")]
        created: Option<i64>,
        #[serde(default, skip_serializing_if = "routing_only")]
        deleted: Option<ViewRules>,
    },
    UserUpdated {
        user: UserRef,
        #[serde(default, skip_serializing_if = "routing_only")]
        scope: UserScope,
    },
    UserRegistered {
        user: UserRef,
    },
    PresenceChanged {
        server: String,
        username: String,
        online: bool,
        online_count: i64,
    },
    PresenceMode {
        username: String,
        appear_offline: bool,
        // `users.presence_seq` of this value: the newest one wins.
        #[serde(default, skip_serializing_if = "routing_only")]
        seq: i64,
    },
    PresenceSnapshot {
        server: String,
        online: Vec<String>,
        online_count: i64,
    },
    ServerBanned {
        server: String,
        username: String,
    },
    ReadUpdated {
        username: String,
        scope: String,
        last_read: i64,
        pings_until: i64,
    },
    Ping {
        username: String,
        ping: Ping,
    },
    PingCount {
        username: String,
        scope: String,
        pings: i64,
        pings_until: i64,
        thread_pings: Vec<ThreadPings>,
    },
    VoiceState {
        server: String,
        channel_id: i64,
        users: Vec<String>,
    },
    /// A user in a voice channel was muted there by a timeout, or the timeout ended. Apps stop
    /// sending and playing a muted user's audio.
    VoiceMuted {
        server: String,
        channel_id: i64,
        username: String,
        muted: bool,
    },
    /// A timeout of `username` in `server` started or changed (`until`, `remaining` seconds and
    /// the reason) or ended (`until` null). Only to that user and to members with the Timeout
    /// members permission; the user's own copy has no reason unless they hold it too.
    MemberTimeout {
        server: String,
        username: String,
        until: Option<i64>,
        remaining: i64,
        reason: Option<String>,
    },
    CallState {
        dm_id: i64,
        dm_users: Vec<String>,
        state: CallPhase,
        from: String,
        kind: CallKind,
        /// The caller started with video on.
        #[serde(default)]
        video: bool,
        /// Active P2P calls only: the call's id, which the caller puts in the PeerJS metadata.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        call_id: Option<String>,
        /// Active calls only: when the call was answered, in unix seconds.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        answered_at: Option<i64>,
        /// Active P2P calls only: the peer id of the caller's tab and of the tab that accepted.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        peers: Vec<CallPeer>,
        /// P2P calls only: relay hosts a side declared (the caller's while ringing, both once
        /// active), so the other side can ask before it connects through them.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        relays: Vec<CallRelays>,
    },
    P2pAvailability {
        hoster: String,
        peer_id: Option<String>,
        ids: Vec<String>,
        online: bool,
        #[serde(default, skip_serializing_if = "routing_only")]
        scope_servers: Vec<String>,
        #[serde(default, skip_serializing_if = "routing_only")]
        scope_users: Vec<String>,
    },
    RtcSignal {
        to: String,
        from: String,
        channel_id: Option<i64>,
        dm_id: Option<i64>,
        payload: serde_json::Value,
    },
    VoiceEnded {
        server: Option<String>,
        channel_id: Option<i64>,
        dm_id: Option<i64>,
        dm_users: Option<Vec<String>>,
        reason: String,
    },
    Error {
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<crate::api::Reason>,
    },
    DmCreated {
        dm_id: i64,
        dm_users: Vec<String>,
    },
    /// `username` closed the DM; to that user's connections only.
    DmClosed {
        username: String,
        dm_id: i64,
    },
    /// The DM is back in `username`'s list; to that user's connections only.
    DmReopened {
        username: String,
        dm_id: i64,
    },
    /// `username` marked these group-mentioned messages of channel `scope` seen in the inbox
    /// (at most 1000 ids); to that user's connections only.
    GroupPingsSeen {
        username: String,
        scope: String,
        message_ids: Vec<i64>,
    },
    /// `username` blocked a user; to that user's connections only.
    UserBlocked {
        username: String,
        blocked: crate::api::blocks::BlockedUser,
    },
    /// `username` unblocked `blocked`; to that user's connections only.
    UserUnblocked {
        username: String,
        blocked: String,
    },
    /// `username` voted in or took back their vote in poll `message_id`; to their own
    /// connections only, so their other tabs load the poll again.
    PollVoted {
        username: String,
        message_id: i64,
    },
    /// Progress of `username`'s bulk delete job; to their own connections only.
    BulkDeleteProgress {
        username: String,
        job: crate::api::bulk_delete::BulkJob,
    },
    /// A friend request between `username` and `request.user` was sent or arrived; to
    /// `username`'s connections only.
    FriendRequestAdded {
        username: String,
        request: crate::api::friends::FriendRequest,
    },
    /// The friend request between `username` and `other` is gone (accepted, denied or
    /// cancelled); to `username`'s connections only.
    FriendRequestRemoved {
        username: String,
        other: String,
    },
    /// `friend.user` is now a friend of `username`; to `username`'s connections only.
    FriendAdded {
        username: String,
        friend: crate::api::friends::Friend,
    },
    /// `friend` is no longer a friend of `username`; to `username`'s connections only.
    FriendRemoved {
        username: String,
        friend: String,
    },
    /// `friend` (a friend of `username`) came online or went offline; to `username`'s
    /// connections only.
    FriendPresence {
        username: String,
        friend: String,
        online: bool,
    },
    /// `username` changed their privacy settings; to that user's connections only.
    PrivacyChanged {
        username: String,
        privacy: crate::api::friends::Privacy,
    },
    /// Internal, never delivered: `username` became visible on the site (`online`), or stopped
    /// being visible (after the offline grace, or at once when they appear offline). The hub's
    /// replica emits it on every instance (`Hub::take_shown`), and each instance tells the
    /// friends connected to it (`friend_presence`).
    UserShown {
        username: String,
        online: bool,
    },
    Banned {
        username: String,
    },
    SettingsChanged {
        settings: Settings,
    },
    TokensRevoked {
        username: String,
    },
    /// Answer to `p2p_hosting`, to that connection only: which of the `checked` ids are still
    /// live P2P attachments of the sender, so its app stops serving removed ones.
    P2pHosted {
        live: Vec<String>,
        checked: Vec<String>,
        /// Hex key the hoster checks download tokens with, valid for `peer_id`.
        key: String,
        peer_id: String,
        /// Server time in unix seconds, so the hoster can check token expiry on a skewed clock.
        now: i64,
    },
    /// Answer to `p2p_peer`, to that connection only: where to fetch the attachment of
    /// `message_id` and the token for it, or `error`.
    P2pPeer {
        message_id: i64,
        peer_id: Option<String>,
        token: Option<String>,
        expires_at: Option<i64>,
        error: Option<String>,
        /// Relay hosts the hoster declared for this file.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        relays: Vec<String>,
    },
    Resync,
    /// Someone is typing in `scope` (`c{channel}`, `t{root}` or `d{dm}`) until `until` (unix
    /// seconds), or stopped when `until` is 0. Never sent to the typer's own connections.
    Typing {
        server: Option<String>,
        channel_id: Option<i64>,
        dm_id: Option<i64>,
        dm_users: Option<Vec<String>>,
        scope: String,
        username: String,
        display_name: String,
        until: i64,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CallPeer {
    pub user: String,
    pub peer_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CallRelays {
    pub user: String,
    pub hosts: Vec<String>,
}
