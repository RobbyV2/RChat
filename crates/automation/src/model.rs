//! An automation: a trigger, conditions and up to 10 actions, stored as one JSON body.

pub use crate::validate::validate;

use crate::access::Fired;
use crate::panel::Mode;
use crate::schedule::Schedule;
use serde::{Deserialize, Serialize};

fn utc() -> String {
    "UTC".to_string()
}

#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
pub struct Automation {
    pub name: String,
    #[serde(default = "enabled")]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    #[serde(default = "utc")]
    pub tz: String,
    pub trigger: Trigger,
    #[serde(default)]
    pub conditions: Vec<Condition>,
    pub actions: Vec<Action>,
    #[serde(default)]
    pub options: Options,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kit: Option<Kit>,
}

fn enabled() -> bool {
    true
}

impl Automation {
    /// Whether the member picks the role this action gives them or takes off them, the `picked`
    /// of `access::may_run`: with no condition deciding the run, the role comes from their own
    /// `choice` argument of the command, or it is a fixed role that a press or a reaction on the
    /// one message the trigger names stands for. A fixed role of a command, a role behind a
    /// keyword, chance or any other condition (one from a `choice` argument too), and
    /// `strip_roles` are never picked.
    pub fn picks(&self, kind: &ActionKind) -> bool {
        self.conditions.is_empty()
            && match kind.role() {
                Some(RoleRef::Arg { .. }) => matches!(self.trigger, Trigger::Command { .. }),
                Some(RoleRef::Id(_)) => self.trigger.is_press(),
                None => false,
            }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Options {
    /// Fire on other automations' messages too. Never on its own.
    pub react_to_automations: bool,
    /// No run notices.
    pub quiet: bool,
    /// Only the server creator may change, disable, delete or take over it.
    pub locked: bool,
}

/// A channel or a category. A category covers its channels, including ones added later.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Ref {
    Channel(i64),
    Category(i64),
}

#[derive(Clone, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    #[default]
    All,
    Only(Vec<Ref>),
    Except(Vec<Ref>),
}

impl Scope {
    pub fn refs(&self) -> &[Ref] {
        match self {
            Scope::All => &[],
            Scope::Only(refs) | Scope::Except(refs) => refs,
        }
    }

    /// Whether a channel, with the category it is in, is in scope.
    pub fn covers(&self, channel: i64, category: Option<i64>) -> bool {
        let named = self.refs().iter().any(|r| match r {
            Ref::Channel(id) => *id == channel,
            Ref::Category(id) => Some(*id) == category,
        });
        match self {
            Scope::All => true,
            Scope::Only(_) => named,
            Scope::Except(_) => !named,
        }
    }
}

#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Trigger {
    MessageSent {
        #[serde(default)]
        channels: Scope,
        #[serde(default)]
        edits: bool,
        /// Run in the send path, where `block` can stop the message.
        #[serde(default)]
        guard: bool,
    },
    MessageEdited {
        #[serde(default)]
        channels: Scope,
    },
    MessageDeleted {
        #[serde(default)]
        channels: Scope,
    },
    ReactionAdded {
        #[serde(default)]
        message: Option<i64>,
        #[serde(default)]
        emojis: Vec<String>,
        #[serde(default)]
        channels: Scope,
    },
    ReactionRemoved {
        #[serde(default)]
        message: Option<i64>,
        #[serde(default)]
        emojis: Vec<String>,
        #[serde(default)]
        channels: Scope,
    },
    MemberJoined {
        /// Run in the join path, before anything is announced.
        #[serde(default)]
        guard: bool,
    },
    MemberAdmitted,
    MemberLeft {
        #[serde(default)]
        kicked: Option<bool>,
        #[serde(default)]
        banned: Option<bool>,
    },
    ProfileUpdated,
    RoleAdded {
        #[serde(default)]
        roles: Vec<i64>,
    },
    RoleRemoved {
        #[serde(default)]
        roles: Vec<i64>,
    },
    /// A member joins a voice channel. A guest in voice is no member and fires nothing.
    VoiceJoined {
        #[serde(default)]
        channels: Scope,
    },
    /// A member leaves a voice channel or staff disconnect them. Never fires for a guest.
    VoiceLeft {
        #[serde(default)]
        channels: Scope,
    },
    Schedule {
        schedule: Schedule,
    },
    Command {
        name: String,
        #[serde(default)]
        description: String,
        #[serde(default)]
        args: Vec<Arg>,
        #[serde(default)]
        channels: Scope,
    },
    Component {
        panel: String,
    },
    CounterReached {
        counter: String,
        value: i64,
        #[serde(default)]
        every: Option<u32>,
    },
    JoinRate {
        joins: u32,
        seconds: u32,
    },
    StaffActionRate {
        actions: Vec<String>,
        count: u32,
        minutes: u32,
    },
    AuditEntry {
        #[serde(default)]
        actions: Vec<String>,
    },
    ReportFiled,
    FeedItem {
        url: String,
    },
}

impl Trigger {
    /// The trigger's name, as stored in `type`.
    pub fn name(&self) -> &'static str {
        match self {
            Trigger::MessageSent { .. } => "message_sent",
            Trigger::MessageEdited { .. } => "message_edited",
            Trigger::MessageDeleted { .. } => "message_deleted",
            Trigger::ReactionAdded { .. } => "reaction_added",
            Trigger::ReactionRemoved { .. } => "reaction_removed",
            Trigger::MemberJoined { .. } => "member_joined",
            Trigger::MemberAdmitted => "member_admitted",
            Trigger::MemberLeft { .. } => "member_left",
            Trigger::ProfileUpdated => "profile_updated",
            Trigger::RoleAdded { .. } => "role_added",
            Trigger::RoleRemoved { .. } => "role_removed",
            Trigger::VoiceJoined { .. } => "voice_joined",
            Trigger::VoiceLeft { .. } => "voice_left",
            Trigger::Schedule { .. } => "schedule",
            Trigger::Command { .. } => "command",
            Trigger::Component { .. } => "component",
            Trigger::CounterReached { .. } => "counter_reached",
            Trigger::JoinRate { .. } => "join_rate",
            Trigger::StaffActionRate { .. } => "staff_action_rate",
            Trigger::AuditEntry { .. } => "audit_entry",
            Trigger::ReportFiled => "report_filed",
            Trigger::FeedItem { .. } => "feed_item",
        }
    }

    /// Whether the automation runs in the send or join path, where it can block.
    pub fn is_guard(&self) -> bool {
        matches!(
            self,
            Trigger::MessageSent { guard: true, .. } | Trigger::MemberJoined { guard: true }
        )
    }

    /// Whose rights a run has besides its owner's: a member's own act (sending, editing or
    /// deleting a message, reacting, joining, leaving or being removed, a profile or voice change,
    /// a command, a press, a report) runs within that member's rights too; admissions, role
    /// changes, schedules, detectors, audit entries and feeds run as the owner; `counter_reached`
    /// as whoever moved the counter. See `access::actor` and `access::may_run`. A member trigger
    /// fires only for members: a guest's event (guests can be in voice) starts no run.
    pub fn fired(&self) -> Fired {
        match self {
            Trigger::MessageSent { .. }
            | Trigger::MessageEdited { .. }
            | Trigger::MessageDeleted { .. }
            | Trigger::ReactionAdded { .. }
            | Trigger::ReactionRemoved { .. }
            | Trigger::MemberJoined { .. }
            | Trigger::MemberLeft { .. }
            | Trigger::ProfileUpdated
            | Trigger::VoiceJoined { .. }
            | Trigger::VoiceLeft { .. }
            | Trigger::Command { .. }
            | Trigger::Component { .. }
            | Trigger::ReportFiled => Fired::Member,
            Trigger::CounterReached { .. } => Fired::Mover,
            Trigger::MemberAdmitted
            | Trigger::RoleAdded { .. }
            | Trigger::RoleRemoved { .. }
            | Trigger::Schedule { .. }
            | Trigger::JoinRate { .. }
            | Trigger::StaffActionRate { .. }
            | Trigger::AuditEntry { .. }
            | Trigger::FeedItem { .. } => Fired::Owner,
        }
    }

    /// Whether the event is a press, or a reaction on the one message the trigger names (a
    /// reaction role): what the member presses or reacts with stands for the automation's fixed
    /// roles.
    pub fn is_press(&self) -> bool {
        match self {
            Trigger::Component { .. } => true,
            Trigger::ReactionAdded { message, .. } | Trigger::ReactionRemoved { message, .. } => {
                message.is_some()
            }
            Trigger::MessageSent { .. }
            | Trigger::MessageEdited { .. }
            | Trigger::MessageDeleted { .. }
            | Trigger::MemberJoined { .. }
            | Trigger::MemberAdmitted
            | Trigger::MemberLeft { .. }
            | Trigger::ProfileUpdated
            | Trigger::RoleAdded { .. }
            | Trigger::RoleRemoved { .. }
            | Trigger::VoiceJoined { .. }
            | Trigger::VoiceLeft { .. }
            | Trigger::Schedule { .. }
            | Trigger::Command { .. }
            | Trigger::CounterReached { .. }
            | Trigger::JoinRate { .. }
            | Trigger::StaffActionRate { .. }
            | Trigger::AuditEntry { .. }
            | Trigger::ReportFiled
            | Trigger::FeedItem { .. } => false,
        }
    }

    /// Whether the event has a member for member and role actions to act on: every trigger but a
    /// schedule, the join rate detector and a feed.
    pub fn has_member(&self) -> bool {
        match self {
            Trigger::MessageSent { .. }
            | Trigger::MessageEdited { .. }
            | Trigger::MessageDeleted { .. }
            | Trigger::ReactionAdded { .. }
            | Trigger::ReactionRemoved { .. }
            | Trigger::MemberJoined { .. }
            | Trigger::MemberAdmitted
            | Trigger::MemberLeft { .. }
            | Trigger::ProfileUpdated
            | Trigger::RoleAdded { .. }
            | Trigger::RoleRemoved { .. }
            | Trigger::VoiceJoined { .. }
            | Trigger::VoiceLeft { .. }
            | Trigger::Command { .. }
            | Trigger::Component { .. }
            | Trigger::CounterReached { .. }
            | Trigger::StaffActionRate { .. }
            | Trigger::AuditEntry { .. }
            | Trigger::ReportFiled => true,
            Trigger::Schedule { .. } | Trigger::JoinRate { .. } | Trigger::FeedItem { .. } => false,
        }
    }

    /// Whether the event carries a message its actions can act on: one sent or edited, or the one
    /// reacted to.
    pub fn has_message(&self) -> bool {
        matches!(
            self,
            Trigger::MessageSent { .. }
                | Trigger::MessageEdited { .. }
                | Trigger::ReactionAdded { .. }
                | Trigger::ReactionRemoved { .. }
        )
    }

    /// Whether the event happens in a channel, which `Place::Here` names: where the message is,
    /// the reaction, the voice channel, where a command is run or the panel pressed, and for
    /// `counter_reached` where the counter moved (a move outside any channel runs nothing there).
    pub fn in_channel(&self) -> bool {
        self.scope().is_some()
            || matches!(
                self,
                Trigger::Component { .. } | Trigger::CounterReached { .. }
            )
    }

    /// The channel scope, for the triggers that have one.
    pub fn scope(&self) -> Option<&Scope> {
        match self {
            Trigger::MessageSent { channels, .. }
            | Trigger::MessageEdited { channels }
            | Trigger::MessageDeleted { channels }
            | Trigger::ReactionAdded { channels, .. }
            | Trigger::ReactionRemoved { channels, .. }
            | Trigger::VoiceJoined { channels }
            | Trigger::VoiceLeft { channels }
            | Trigger::Command { channels, .. } => Some(channels),
            Trigger::MemberJoined { .. }
            | Trigger::MemberAdmitted
            | Trigger::MemberLeft { .. }
            | Trigger::ProfileUpdated
            | Trigger::RoleAdded { .. }
            | Trigger::RoleRemoved { .. }
            | Trigger::Schedule { .. }
            | Trigger::Component { .. }
            | Trigger::CounterReached { .. }
            | Trigger::JoinRate { .. }
            | Trigger::StaffActionRate { .. }
            | Trigger::AuditEntry { .. }
            | Trigger::ReportFiled
            | Trigger::FeedItem { .. } => None,
        }
    }
}

/// One argument of a server command. Roles are named only through a fixed `choice` list.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
pub struct Arg {
    pub name: String,
    #[serde(default)]
    pub required: bool,
    #[serde(flatten)]
    pub kind: ArgKind,
}

#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ArgKind {
    Text { max: u16 },
    Member,
    Channel,
    Number { min: i64, max: i64 },
    Choice { options: Vec<ArgOption> },
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct ArgOption {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<i64>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Than {
    Under(u32),
    Over(u32),
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthorKind {
    Member,
    Webhook,
    Automation,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkMode {
    #[default]
    Any,
    Invites,
    NotAllowed,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Per {
    Member,
    Channel,
    Server,
}

#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Condition {
    Channel {
        scope: Scope,
    },
    HasRole {
        roles: Vec<i64>,
    },
    LacksRole {
        roles: Vec<i64>,
    },
    HasPerm {
        perm: u32,
    },
    IsStaff,
    AccountAge {
        minutes: Than,
    },
    MemberTime {
        minutes: Than,
    },
    Pending,
    AuthorKind {
        kind: AuthorKind,
    },
    HasAttachment {
        at_least: u32,
    },
    HasPoll,
    IsReply,
    InThread,
    Keywords {
        #[serde(default)]
        list: Vec<String>,
        #[serde(default)]
        allow: Vec<String>,
        /// Instance only: never evaluated on P2P content.
        #[serde(default)]
        profanity_preset: bool,
    },
    Regex {
        patterns: Vec<String>,
    },
    Links {
        #[serde(default)]
        mode: LinkMode,
        #[serde(default)]
        allow: Vec<String>,
        #[serde(default)]
        deny: Vec<String>,
    },
    Mentions {
        over: u32,
        #[serde(default)]
        unique: bool,
    },
    Caps {
        percent: u8,
        min_length: u32,
    },
    Emoji {
        over: u32,
    },
    Lines {
        over: u32,
    },
    Length {
        over: u32,
    },
    Rate {
        count: u32,
        seconds: u32,
        per: Per,
    },
    Duplicates {
        count: u32,
        seconds: u32,
    },
    Name {
        list: Vec<String>,
    },
    TimeWindow {
        days: Vec<crate::schedule::Day>,
        from: crate::schedule::Clock,
        to: crate::schedule::Clock,
    },
    Cooldown {
        seconds: u32,
        per: Per,
    },
    Counter {
        name: String,
        at_least: i64,
    },
    Reactions {
        emoji: String,
        at_least: u32,
    },
    Chance {
        percent: u8,
    },
    Any {
        of: Vec<Condition>,
    },
    Not {
        of: Box<Condition>,
    },
}

impl Condition {
    pub fn name(&self) -> &'static str {
        match self {
            Condition::Channel { .. } => "channel",
            Condition::HasRole { .. } => "has_role",
            Condition::LacksRole { .. } => "lacks_role",
            Condition::HasPerm { .. } => "has_perm",
            Condition::IsStaff => "is_staff",
            Condition::AccountAge { .. } => "account_age",
            Condition::MemberTime { .. } => "member_time",
            Condition::Pending => "pending",
            Condition::AuthorKind { .. } => "author_kind",
            Condition::HasAttachment { .. } => "has_attachment",
            Condition::HasPoll => "has_poll",
            Condition::IsReply => "is_reply",
            Condition::InThread => "in_thread",
            Condition::Keywords { .. } => "keywords",
            Condition::Regex { .. } => "regex",
            Condition::Links { .. } => "links",
            Condition::Mentions { .. } => "mentions",
            Condition::Caps { .. } => "caps",
            Condition::Emoji { .. } => "emoji",
            Condition::Lines { .. } => "lines",
            Condition::Length { .. } => "length",
            Condition::Rate { .. } => "rate",
            Condition::Duplicates { .. } => "duplicates",
            Condition::Name { .. } => "name",
            Condition::TimeWindow { .. } => "time_window",
            Condition::Cooldown { .. } => "cooldown",
            Condition::Counter { .. } => "counter",
            Condition::Reactions { .. } => "reactions",
            Condition::Chance { .. } => "chance",
            Condition::Any { .. } => "any",
            Condition::Not { .. } => "not",
        }
    }

    /// Whether the condition reads what the server can't see in an encrypted channel.
    pub fn reads_content(&self) -> bool {
        match self {
            Condition::Keywords { .. }
            | Condition::Regex { .. }
            | Condition::Links { .. }
            | Condition::Caps { .. }
            | Condition::Emoji { .. }
            | Condition::Lines { .. }
            | Condition::Length { .. }
            | Condition::Duplicates { .. }
            | Condition::HasPoll
            | Condition::IsReply
            | Condition::InThread
            | Condition::Reactions { .. } => true,
            Condition::Any { of } => of.iter().any(Condition::reads_content),
            Condition::Not { of } => of.reads_content(),
            Condition::Channel { .. }
            | Condition::HasRole { .. }
            | Condition::LacksRole { .. }
            | Condition::HasPerm { .. }
            | Condition::IsStaff
            | Condition::AccountAge { .. }
            | Condition::MemberTime { .. }
            | Condition::Pending
            | Condition::AuthorKind { .. }
            | Condition::HasAttachment { .. }
            | Condition::Mentions { .. }
            | Condition::Rate { .. }
            | Condition::Name { .. }
            | Condition::TimeWindow { .. }
            | Condition::Cooldown { .. }
            | Condition::Counter { .. }
            | Condition::Chance { .. } => false,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Amount {
    Fixed(i64),
    Random { min: i64, max: i64 },
}

/// Whose counter an action changes: the member of the event, or a `member` argument of a
/// command.
#[derive(Clone, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Target {
    #[default]
    Member,
    Arg(String),
}

/// The role of a role action: a role of the server, or the role of the option picked for a
/// `choice` argument of the command.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RoleRef {
    Id(i64),
    Arg { arg: String },
}

impl From<i64> for RoleRef {
    fn from(id: i64) -> RoleRef {
        RoleRef::Id(id)
    }
}

/// Where a post goes: the event's channel or a named one.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Place {
    #[default]
    Here,
    Channel(i64),
}

/// The webhook `RichEmbed` shape. The text fields are templates; `url` is a web address as
/// typed, never rendered: a `{name}` placeholder in it is refused.
#[derive(Clone, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Embed {
    pub title: Option<String>,
    pub description: Option<String>,
    pub url: Option<String>,
    /// `0xRRGGBB`.
    pub color: Option<i64>,
    pub fields: Vec<EmbedField>,
    pub footer: Option<EmbedFooter>,
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct EmbedField {
    pub name: String,
    pub value: String,
    #[serde(default)]
    pub inline: bool,
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct EmbedFooter {
    pub text: String,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ButtonStyle {
    #[default]
    Plain,
    Primary,
    Danger,
}

/// What a button does when pressed.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(tag = "do", rename_all = "snake_case")]
pub enum Press {
    Role {
        role: i64,
    },
    Run,
    /// Opens a web address, as typed: `url` is never rendered, and a `{name}` placeholder in it
    /// is refused.
    Link {
        url: String,
    },
    Jump {
        channel: i64,
    },
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct SelectOption {
    pub value: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emoji: Option<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<i64>,
}

/// One interactive part of an automation message. `cid` names it in a press.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Component {
    Button {
        cid: String,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        emoji: Option<String>,
        #[serde(default)]
        style: ButtonStyle,
        #[serde(flatten)]
        press: Press,
    },
    Select {
        cid: String,
        #[serde(default, skip_serializing_if = "String::is_empty")]
        placeholder: String,
        #[serde(default)]
        min: u8,
        #[serde(default = "one")]
        max: u8,
        options: Vec<SelectOption>,
    },
}

impl Component {
    pub fn cid(&self) -> &str {
        match self {
            Component::Button { cid, .. } | Component::Select { cid, .. } => cid,
        }
    }
}

fn one() -> u8 {
    1
}

/// The rows of components under a message: at most 5 rows of 5 buttons; a select fills a row.
pub type Components = Vec<Vec<Component>>;

pub const COMPONENT_ROWS: usize = 5;
pub const ROW_BUTTONS: usize = 5;
pub const SELECT_OPTIONS: usize = 25;

/// What a log card may include of a deleted or edited message: `Text` only from the channels a
/// message trigger lists one by one.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogContent {
    #[default]
    Metadata,
    Text,
}

#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ActionKind {
    Block {
        #[serde(default)]
        message: String,
        #[serde(default)]
        report: bool,
    },
    DeleteMessage,
    Timeout {
        seconds: u32,
    },
    Kick,
    Ban {
        #[serde(default)]
        purge_hours: u32,
        #[serde(default)]
        then_unban: bool,
    },
    Hold {
        #[serde(default)]
        reason: String,
    },
    Quarantine {
        #[serde(default)]
        reason: String,
    },
    StripRoles,
    AddRole {
        role: RoleRef,
        #[serde(default)]
        for_seconds: u32,
    },
    RemoveRole {
        role: RoleRef,
    },
    ToggleRole {
        role: RoleRef,
    },
    CounterAdd {
        name: String,
        amount: Amount,
        #[serde(default)]
        target: Target,
    },
    CounterSet {
        name: String,
        value: i64,
        #[serde(default)]
        target: Target,
    },
    Notify {
        text: String,
    },
    Reply {
        text: String,
        #[serde(default)]
        ping: bool,
    },
    SendMessage {
        #[serde(default)]
        channel: Place,
        #[serde(default)]
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        embed: Option<Embed>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        components: Components,
        #[serde(default)]
        ping: bool,
    },
    React {
        emojis: Vec<String>,
    },
    StartThread {
        name: String,
    },
    Pin,
    Log {
        channel: i64,
        #[serde(default)]
        content: LogContent,
    },
    Alert {
        channel: i64,
        #[serde(default)]
        text: String,
    },
    LockChannel {
        #[serde(default)]
        channel: Place,
        #[serde(default)]
        for_seconds: u32,
    },
    UnlockChannel {
        #[serde(default)]
        channel: Place,
    },
    Slowmode {
        #[serde(default)]
        channel: Place,
        seconds: u32,
        #[serde(default)]
        for_seconds: u32,
    },
    PauseJoins {
        minutes: u32,
    },
    RequireApproval {
        minutes: u32,
    },
    RenameChannel {
        channel: i64,
        text: String,
    },
    DeleteOlder {
        channel: i64,
        age_seconds: u32,
    },
    WebhookOut {
        hook: i64,
    },
    Report {
        #[serde(default)]
        reason: String,
        #[serde(default)]
        note: String,
    },
    PostPanel {
        channel: i64,
        #[serde(default)]
        text: String,
    },
    OpenTicket,
    CreateRoom,
    Repost,
    Sticky,
    PostGiveaway,
}

impl ActionKind {
    /// The action's name, as stored in `type`.
    pub fn name(&self) -> &'static str {
        match self {
            ActionKind::Block { .. } => "block",
            ActionKind::DeleteMessage => "delete_message",
            ActionKind::Timeout { .. } => "timeout",
            ActionKind::Kick => "kick",
            ActionKind::Ban { .. } => "ban",
            ActionKind::Hold { .. } => "hold",
            ActionKind::Quarantine { .. } => "quarantine",
            ActionKind::StripRoles => "strip_roles",
            ActionKind::AddRole { .. } => "add_role",
            ActionKind::RemoveRole { .. } => "remove_role",
            ActionKind::ToggleRole { .. } => "toggle_role",
            ActionKind::CounterAdd { .. } => "counter_add",
            ActionKind::CounterSet { .. } => "counter_set",
            ActionKind::Notify { .. } => "notify",
            ActionKind::Reply { .. } => "reply",
            ActionKind::SendMessage { .. } => "send_message",
            ActionKind::React { .. } => "react",
            ActionKind::StartThread { .. } => "start_thread",
            ActionKind::Pin => "pin",
            ActionKind::Log { .. } => "log",
            ActionKind::Alert { .. } => "alert",
            ActionKind::LockChannel { .. } => "lock_channel",
            ActionKind::UnlockChannel { .. } => "unlock_channel",
            ActionKind::Slowmode { .. } => "slowmode",
            ActionKind::PauseJoins { .. } => "pause_joins",
            ActionKind::RequireApproval { .. } => "require_approval",
            ActionKind::RenameChannel { .. } => "rename_channel",
            ActionKind::DeleteOlder { .. } => "delete_older",
            ActionKind::WebhookOut { .. } => "webhook_out",
            ActionKind::Report { .. } => "report",
            ActionKind::PostPanel { .. } => "post_panel",
            ActionKind::OpenTicket => "open_ticket",
            ActionKind::CreateRoom => "create_room",
            ActionKind::Repost => "repost",
            ActionKind::Sticky => "sticky",
            ActionKind::PostGiveaway => "post_giveaway",
        }
    }

    /// The role a role action gives or takes. `strip_roles` names none.
    pub fn role(&self) -> Option<&RoleRef> {
        match self {
            ActionKind::AddRole { role, .. }
            | ActionKind::RemoveRole { role }
            | ActionKind::ToggleRole { role } => Some(role),
            ActionKind::Block { .. }
            | ActionKind::DeleteMessage
            | ActionKind::Timeout { .. }
            | ActionKind::Kick
            | ActionKind::Ban { .. }
            | ActionKind::Hold { .. }
            | ActionKind::Quarantine { .. }
            | ActionKind::StripRoles
            | ActionKind::CounterAdd { .. }
            | ActionKind::CounterSet { .. }
            | ActionKind::Notify { .. }
            | ActionKind::Reply { .. }
            | ActionKind::SendMessage { .. }
            | ActionKind::React { .. }
            | ActionKind::StartThread { .. }
            | ActionKind::Pin
            | ActionKind::Log { .. }
            | ActionKind::Alert { .. }
            | ActionKind::LockChannel { .. }
            | ActionKind::UnlockChannel { .. }
            | ActionKind::Slowmode { .. }
            | ActionKind::PauseJoins { .. }
            | ActionKind::RequireApproval { .. }
            | ActionKind::RenameChannel { .. }
            | ActionKind::DeleteOlder { .. }
            | ActionKind::WebhookOut { .. }
            | ActionKind::Report { .. }
            | ActionKind::PostPanel { .. }
            | ActionKind::OpenTicket
            | ActionKind::CreateRoom
            | ActionKind::Repost
            | ActionKind::Sticky
            | ActionKind::PostGiveaway => None,
        }
    }
}

/// One step of an automation. `aid` is its stable id, kept across edits, so an idempotency key
/// means the same thing after the actions are reordered. `after` delays it, in seconds.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
pub struct Action {
    pub aid: String,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub after: u32,
    /// In a guard: run after the message is posted, as a reaction.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub after_post: bool,
    #[serde(flatten)]
    pub kind: ActionKind,
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PanelStyle {
    #[default]
    Buttons,
    Menu,
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct PanelRole {
    pub role: i64,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emoji: Option<String>,
    /// "May give permissions": the role may carry more than Mention everyone.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub may_give: bool,
}

/// The state a kit keeps on top of its automation.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
#[serde(tag = "kit", rename_all = "snake_case")]
pub enum Kit {
    RolePanel {
        mode: Mode,
        roles: Vec<PanelRole>,
        #[serde(default)]
        style: PanelStyle,
    },
    Tickets {
        category: i64,
        #[serde(default)]
        staff_roles: Vec<i64>,
        name: String,
        max_open_per_member: u32,
        #[serde(default)]
        intro: String,
        close_after_days: u32,
    },
    Starboard {
        emoji: String,
        threshold: u32,
        channel: i64,
        #[serde(default)]
        self_star: bool,
    },
    Sticky {
        channel: i64,
        text: String,
        every: u32,
        min_seconds: u32,
    },
    Rooms {
        hub_channel: i64,
        category: i64,
        name: String,
        #[serde(default)]
        limit: u32,
        delete_after_empty_seconds: u32,
        max_rooms: u32,
    },
    Giveaway {
        prize: String,
        winners: u32,
        ends_at: i64,
        #[serde(default)]
        requirements: Vec<Condition>,
        channel: i64,
    },
}
