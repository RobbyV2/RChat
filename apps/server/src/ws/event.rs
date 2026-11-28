use std::cell::Cell;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::{CallKind, CallPhase};

use crate::api::access::ViewRules;
use crate::api::pings::{Ping, ThreadPings};
use crate::api::{
    Channel, ChannelLayout, Embed, Member, Message, PublicSettings, Role, ServerSummaryLite,
    UserRef,
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

fn absent_or_client<T>(value: &Option<T>) -> bool {
    value.is_none() || routing_only(value)
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
#[derive(Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(untagged)]
pub enum Updated {
    Stub(EditStub),
    Full { message: Box<Message> },
}

#[derive(Clone, Serialize, Deserialize, utoipa::ToSchema)]
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

/// What a user in a voice room says about their own mic and sound.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct SeatAudio {
    pub username: String,
    pub muted: bool,
    pub deafened: bool,
}

#[derive(Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RefusedRequest {
    Call { attempt_id: u64 },
    VoiceJoin { channel_id: i64 },
    Other,
}

#[derive(Clone, Serialize, Deserialize, utoipa::ToSchema)]
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
        #[schema(ignore)]
        dm_users: Vec<String>,
    },
    MessageDeleted {
        server: Option<String>,
        channel_id: Option<i64>,
        dm_id: Option<i64>,
        dm_users: Option<Vec<String>>,
        id: i64,
        thread_root_id: Option<i64>,
        /// A `join` or `leave` message, which outsiders of a server that keeps its members to
        /// itself never see. An absent flag leaves the message kind unknown.
        #[serde(default, skip_serializing_if = "absent_or_client")]
        #[schema(ignore)]
        notice: Option<bool>,
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
        #[schema(ignore)]
        created: Vec<i64>,
        /// All membership notice ids in the batch. An absent list leaves their kinds unknown.
        #[serde(default, skip_serializing_if = "absent_or_client")]
        #[schema(ignore)]
        notices: Option<Vec<i64>>,
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
        #[schema(ignore)]
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
        #[schema(ignore)]
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
    /// A role's name, color, icon, mention setting or how it shows changed; its permissions did
    /// not.
    RoleUpdated {
        server: String,
        role: Role,
    },
    /// The rank order or the display order of a server's roles changed. `order` lists every
    /// role, the highest first, and `display` the display position of each in the same order.
    RolesReordered {
        server: String,
        order: Vec<i64>,
        display: Vec<Option<i64>>,
        version: i64,
    },
    /// A member was given or lost a role: `role_ids` are the roles they hold now.
    MemberRolesChanged {
        server: String,
        username: String,
        role_ids: Vec<i64>,
    },
    /// The server's upload expiry changed; clients load the server again.
    UploadExpiryChanged {
        server: String,
    },
    ChannelPermsChanged {
        server: String,
        channel_id: i64,
    },
    /// The permission rules of several channels changed at once (a category's rules reached the
    /// channels that copy them).
    ChannelsPermsChanged {
        server: String,
        channel_ids: Vec<i64>,
    },
    LayoutChanged {
        server: String,
        #[schema(value_type = ChannelLayout)]
        layout: Arc<ChannelLayout>,
        #[serde(default, skip_serializing_if = "routing_only")]
        #[schema(ignore)]
        created: Option<i64>,
        #[serde(default, skip_serializing_if = "routing_only")]
        #[schema(ignore)]
        deleted: Option<ViewRules>,
        /// The layout before a move or a category change: a connection that doesn't manage
        /// channels and sees no difference gets nothing.
        #[serde(default, skip_serializing_if = "routing_only")]
        #[schema(ignore)]
        before: Option<ChannelLayout>,
        /// The layout produced by this edit when `layout` carries a more recent snapshot.
        #[serde(default, skip_serializing_if = "absent_or_client")]
        #[schema(ignore)]
        after: Option<Arc<ChannelLayout>>,
    },
    UserUpdated {
        user: UserRef,
        #[serde(default, skip_serializing_if = "routing_only")]
        #[schema(ignore)]
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
        #[schema(ignore)]
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
    /// Who is in a voice channel now. In the snapshot a connection gets when it opens or
    /// subscribes, `audio` also lists what each of them not at the default says about their own
    /// mic and sound; changes after that come as `voice_audio`.
    VoiceState {
        server: String,
        channel_id: i64,
        users: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        audio: Option<Vec<SeatAudio>>,
    },
    /// A user in a voice channel is muted there (a timeout, or no Speak permission in the
    /// channel), or no longer is; or, with `staff`, staff muted a guest for everyone in the
    /// server's voice, or ended that. Apps stop sending and playing a muted user's audio.
    VoiceMuted {
        server: String,
        channel_id: i64,
        username: String,
        muted: bool,
        #[serde(default)]
        staff: bool,
    },
    /// What a user in a voice channel says about their own mic (`muted`) and sound (`deafened`)
    /// changed.
    VoiceAudio {
        server: String,
        channel_id: i64,
        username: String,
        muted: bool,
        deafened: bool,
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
    /// The name or avatar `username` shows in `server` changed: `profile` is the look now, null
    /// when they use the account's. `bio` says their description or banner color there changed:
    /// ask for the card again. To the server and to that user.
    MemberProfile {
        server: String,
        username: String,
        profile: Option<crate::api::profiles::MemberLook>,
        bio: bool,
        #[serde(default, skip_serializing_if = "routing_only")]
        #[schema(ignore)]
        view_only: bool,
    },
    /// The reports of `server` changed, or without one the reports to the instance: ask for the
    /// open count again. Only to the members of the server who hold Manage reports, or to
    /// whoever handles the instance's reports. It never says what changed, and it never goes
    /// to someone who can't see the report that changed: the account it is about (`about`),
    /// or a moderator who can't view the channel of its message (`channel`: its id and
    /// whether it was private).
    ReportsChanged {
        server: Option<String>,
        #[serde(default, skip_serializing_if = "routing_only")]
        #[schema(ignore)]
        about: Option<String>,
        #[serde(default, skip_serializing_if = "routing_only")]
        #[schema(ignore)]
        channel: Option<(i64, bool)>,
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
        #[schema(ignore)]
        scope_servers: Vec<String>,
        #[serde(default, skip_serializing_if = "routing_only")]
        #[schema(ignore)]
        scope_users: Vec<String>,
    },
    RtcSignal {
        to: String,
        from: String,
        channel_id: Option<i64>,
        dm_id: Option<i64>,
        #[schema(value_type = Object)]
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
        request: Option<RefusedRequest>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<crate::api::Reason>,
    },
    /// The name a guest connection has in voice rooms, sent to it first.
    GuestName {
        name: String,
    },
    DmCreated {
        dm_id: i64,
        dm_users: Vec<String>,
    },
    /// Whether the DM stores new messages encrypted changed; to its participants only.
    DmUpdated {
        dm_id: i64,
        dm_users: Vec<String>,
        seal: crate::api::seal::SealView,
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
    /// `username`'s scheduled message was scheduled, edited, held by slow mode or failed; to
    /// their own connections only. Its `place` is always null.
    ScheduledUpdated {
        username: String,
        scheduled: Box<crate::api::scheduled::ScheduledMessage>,
    },
    /// `username`'s scheduled message `id` is gone: deleted, or sent as `sent_message_id`; to
    /// their own connections only.
    ScheduledRemoved {
        username: String,
        id: i64,
        sent_message_id: Option<i64>,
    },
    /// The site admin `username` confirmed opening channel `channel_id` as staff; to their own
    /// connections only, so they deliver its events until it closes.
    StaffViewOpened {
        username: String,
        channel_id: i64,
    },
    /// Progress of a job over stored messages `username` started; to their own connections
    /// only.
    SealJobProgress {
        username: String,
        job: crate::api::seal::SealJob,
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
        settings: PublicSettings,
    },
    /// The instance's brand changed: its names, texts, links, suggested instances or images.
    BrandChanged {
        brand: crate::api::brand::Brand,
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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct CallPeer {
    pub user: String,
    pub peer_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct CallRelays {
    pub user: String,
    pub hosts: Vec<String>,
}
