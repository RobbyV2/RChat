//! Validation: limits, the permissions each action needs, and the compiled matchers.

use crate::access::{Fired, Reach};
use crate::budget::{self, Kind};
use crate::grants::{
    self, ALL_PERMS, ASSIGN_ROLES, DELETE_MESSAGES, KICK, MANAGE_AUTOMATIONS, MANAGE_CHANNELS,
    MANAGE_WEBHOOKS, MENTION_EVERYONE, TIMEOUT_MEMBERS, self_service,
};
use crate::keywords::{self, KeywordSet};
use crate::links::{self, BadRule};
use crate::model::{
    Action, ActionKind, Amount, Arg, ArgKind, Automation, COMPONENT_ROWS, Component, Components,
    Condition, Embed, Kit, LogContent, Place, Press, ROW_BUTTONS, Ref, RoleRef, SELECT_OPTIONS,
    Scope, Target, Trigger,
};
use crate::panel::Mode;
use crate::regex::{self as patterns, Bad, PATTERN_BYTES, Patterns};
use crate::schedule;
use crate::template;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

/// The instance's limits, as its settings give them. The defaults are the documented ones.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Caps {
    pub automations_per_server: u32,
    pub runs_per_minute: u32,
    pub workers: u32,
    pub jobs_per_server: u32,
    pub keywords_max: usize,
    pub regex_max: usize,
    pub guards_per_server: usize,
    pub keywords_per_server: usize,
    pub regex_per_server: usize,
    pub regex_mib_per_server: usize,
    pub jobs_per_event: usize,
    pub guard_p99_us: u32,
    pub cards_per_minute: u32,
    pub schedule_min_minutes: u32,
    pub delay_max_days: u32,
    pub counters_per_server: u32,
    pub commands_per_server: u32,
    pub command_runs_per_minute: u32,
    pub presses_per_10s: u32,
    pub tickets_open_per_member: u32,
    pub tickets_open_per_server: u32,
    pub rooms_per_server: u32,
    pub message_max_chars: usize,
}

impl Default for Caps {
    fn default() -> Caps {
        Caps {
            automations_per_server: 100,
            runs_per_minute: 600,
            workers: 8,
            jobs_per_server: 10_000,
            keywords_max: 1000,
            regex_max: 10,
            guards_per_server: 25,
            keywords_per_server: 5000,
            regex_per_server: 50,
            regex_mib_per_server: 4,
            jobs_per_event: 20,
            guard_p99_us: 300,
            cards_per_minute: 60,
            schedule_min_minutes: 10,
            delay_max_days: 7,
            counters_per_server: 10,
            commands_per_server: 50,
            command_runs_per_minute: 20,
            presses_per_10s: 10,
            tickets_open_per_member: 3,
            tickets_open_per_server: 100,
            rooms_per_server: 50,
            message_max_chars: 4000,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    TooFew,
    TooMany,
    TooShort,
    TooLong,
    OutOfRange,
    BadId,
    Duplicate,
    Missing,
    NotAllowed,
    BadPattern,
    TooBig,
    BadTimeZone,
    UnknownChannel,
    UnknownRole,
    GivesPermissions,
    OwnerCantGrant,
}

impl Reason {
    pub const ALL: [Reason; 16] = [
        Reason::TooFew,
        Reason::TooMany,
        Reason::TooShort,
        Reason::TooLong,
        Reason::OutOfRange,
        Reason::BadId,
        Reason::Duplicate,
        Reason::Missing,
        Reason::NotAllowed,
        Reason::BadPattern,
        Reason::TooBig,
        Reason::BadTimeZone,
        Reason::UnknownChannel,
        Reason::UnknownRole,
        Reason::GivesPermissions,
        Reason::OwnerCantGrant,
    ];
}

impl fmt::Display for Reason {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str(match self {
            Reason::TooFew => "too few",
            Reason::TooMany => "too many",
            Reason::TooShort => "too short",
            Reason::TooLong => "too long",
            Reason::OutOfRange => "out of range",
            Reason::BadId => "not a valid id",
            Reason::Duplicate => "used twice",
            Reason::Missing => "missing",
            Reason::NotAllowed => "not allowed here",
            Reason::BadPattern => "not a valid pattern",
            Reason::TooBig => "too big when compiled",
            Reason::BadTimeZone => "not a time zone",
            Reason::UnknownChannel => "not a channel of this server",
            Reason::UnknownRole => "not a role of this server",
            Reason::GivesPermissions => "the role gives permissions",
            Reason::OwnerCantGrant => "the role is above what its owner can give",
        })
    }
}

/// One thing wrong with a config: where, as a dotted path into its JSON, and why.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct Problem {
    pub path: String,
    pub reason: Reason,
}

impl fmt::Display for Problem {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "{}: {}", self.path, self.reason)
    }
}

fn id_ok(id: &str, max: usize) -> bool {
    !id.is_empty()
        && id.len() <= max
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

#[derive(Default)]
pub(crate) struct Check {
    out: Vec<Problem>,
}

impl Check {
    pub(crate) fn add(&mut self, path: &str, reason: Reason) {
        self.out.push(Problem {
            path: path.to_string(),
            reason,
        });
    }

    pub(crate) fn count(&mut self, path: &str, n: usize, min: usize, max: usize) {
        if n < min {
            self.add(path, Reason::TooFew);
        }
        if n > max {
            self.add(path, Reason::TooMany);
        }
    }

    pub(crate) fn text(&mut self, path: &str, text: &str, min: usize, max: usize) {
        let n = text.chars().count();
        if n < min {
            self.add(path, Reason::TooShort);
        }
        if n > max {
            self.add(path, Reason::TooLong);
        }
    }

    pub(crate) fn range(&mut self, path: &str, n: u64, min: u64, max: u64) {
        if !(min..=max).contains(&n) {
            self.add(path, Reason::OutOfRange);
        }
    }

    /// The `id` of every item of the list at `path`: 1 to 16 of `a-z`, `0-9` and `_`, never
    /// twice.
    pub(crate) fn ids<'a>(&mut self, path: &str, ids: impl Iterator<Item = &'a str>) {
        self.named(path, "id", 16, ids);
    }

    fn named<'a>(
        &mut self,
        path: &str,
        field: &str,
        max: usize,
        ids: impl Iterator<Item = &'a str>,
    ) {
        let mut seen = BTreeSet::new();
        for (i, id) in ids.enumerate() {
            if !id_ok(id, max) {
                self.add(&format!("{path}.{i}.{field}"), Reason::BadId);
            } else if !seen.insert(id) {
                self.add(&format!("{path}.{i}.{field}"), Reason::Duplicate);
            }
        }
    }

    fn under(&mut self, prefix: &str, problems: Vec<Problem>) {
        for p in problems {
            self.add(&format!("{prefix}.{}", p.path), p.reason);
        }
    }

    pub(crate) fn done(self) -> Vec<Problem> {
        self.out
    }
}

/// The permissions an automation's owner must hold. The bits are the server's.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Needs(pub u32);

const NAMES: [(u32, &str); 16] = [
    (grants::MANAGE_CHANNELS, "Manage channels"),
    (grants::DELETE_MESSAGES, "Manage messages"),
    (grants::KICK, "Kick"),
    (grants::DELETE_SERVER, "Delete server"),
    (grants::MANAGE_ADMINS, "Manage admins"),
    (grants::MENTION_EVERYONE, "Mention everyone and roles"),
    (grants::VIEW_AUDIT_LOG, "View audit log"),
    (grants::TIMEOUT_MEMBERS, "Timeout members"),
    (grants::MANAGE_WEBHOOKS, "Manage webhooks"),
    (grants::MANAGE_REPORTS, "Manage reports"),
    (grants::MOVE_MEMBERS, "Move members"),
    (grants::MANAGE_AUTOMATIONS, "Manage automations"),
    (grants::MANAGE_SERVER, "Manage server settings"),
    (grants::MANAGE_INVITES, "Manage invites"),
    (grants::MANAGE_ROLES, "Manage roles"),
    (grants::ASSIGN_ROLES, "Assign roles"),
];

impl Needs {
    pub fn bits(self) -> u32 {
        self.0
    }

    pub fn with(self, other: Needs) -> Needs {
        Needs(self.0 | other.0)
    }

    pub fn met_by(self, owner_bits: u32) -> bool {
        self.0 & !owner_bits == 0
    }

    /// The needs the owner's bits don't cover.
    pub fn lacking(self, owner_bits: u32) -> Needs {
        Needs(self.0 & !owner_bits)
    }

    /// The permissions by the names the role editor shows.
    pub fn names(self) -> Vec<&'static str> {
        NAMES
            .iter()
            .filter(|(bit, _)| self.0 & bit != 0)
            .map(|(_, name)| *name)
            .collect()
    }
}

/// The bit for `@everyone` or `@here` in the template's own text, when the post may ping.
fn everyone(text: &str, ping: bool) -> u32 {
    let named = template::pings(text)
        .iter()
        .any(|name| name == "everyone" || name == "here");
    match ping && named {
        true => MENTION_EVERYONE,
        false => 0,
    }
}

/// The roles the buttons and menus of a message give: a press on them is a role change made
/// as the automation's owner.
fn component_roles(rows: &Components) -> Vec<i64> {
    rows.iter()
        .flatten()
        .flat_map(|c| match c {
            Component::Button {
                press: Press::Role { role },
                ..
            } => vec![*role],
            Component::Button { .. } => vec![],
            Component::Select { options, .. } => options.iter().filter_map(|o| o.role).collect(),
        })
        .collect()
}

/// The bits one action needs. Viewing and sending in a channel, granting a role, the channel
/// limits and the rights of the member whose act set a run off are the server's own checks on
/// top: see `Compiled::views`, `Compiled::sends`, `Compiled::roles` and `Compiled::reach`.
/// Mention everyone is needed for `@everyone` and `@here` in the action's own text; a ping of a
/// role that isn't mentionable needs it too, which only the server can tell, at the post.
pub fn needs_of(kind: &ActionKind) -> Needs {
    Needs(match kind {
        ActionKind::Block { .. } | ActionKind::DeleteMessage | ActionKind::Pin => DELETE_MESSAGES,
        ActionKind::Timeout { .. } => TIMEOUT_MEMBERS,
        ActionKind::Kick
        | ActionKind::Ban { .. }
        | ActionKind::PauseJoins { .. }
        | ActionKind::RequireApproval { .. } => KICK,
        ActionKind::Hold { .. } | ActionKind::Quarantine { .. } => KICK | ASSIGN_ROLES,
        ActionKind::StripRoles
        | ActionKind::AddRole { .. }
        | ActionKind::RemoveRole { .. }
        | ActionKind::ToggleRole { .. }
        | ActionKind::PostPanel { .. } => ASSIGN_ROLES,
        ActionKind::CounterAdd { .. } | ActionKind::CounterSet { .. } => MANAGE_AUTOMATIONS,
        ActionKind::LockChannel { .. }
        | ActionKind::UnlockChannel { .. }
        | ActionKind::Slowmode { .. }
        | ActionKind::RenameChannel { .. }
        | ActionKind::OpenTicket
        | ActionKind::CreateRoom => MANAGE_CHANNELS,
        ActionKind::DeleteOlder { .. } => MANAGE_CHANNELS | DELETE_MESSAGES,
        ActionKind::WebhookOut { .. } => MANAGE_WEBHOOKS,
        ActionKind::SendMessage {
            text,
            ping,
            components,
            ..
        } => {
            let roles = match component_roles(components).is_empty() {
                true => 0,
                false => ASSIGN_ROLES,
            };
            everyone(text, *ping) | roles
        }
        ActionKind::Reply { text, ping } => everyone(text, *ping),
        ActionKind::Notify { .. }
        | ActionKind::React { .. }
        | ActionKind::StartThread { .. }
        | ActionKind::Log { .. }
        | ActionKind::Alert { .. }
        | ActionKind::Report { .. }
        | ActionKind::Repost
        | ActionKind::Sticky
        | ActionKind::PostGiveaway => 0,
    })
}

/// What one action reaches, for the check against the member a run answers to
/// (`access::may_run`). A role action reaches what its role says when the run reads it: a role
/// given (`add_role`, a `toggle_role` resolved to add) what `access::grant_of` says, a role taken
/// (`remove_role`, each role of `strip_roles`, a `toggle_role` resolved to remove) what
/// `access::revoke_of` says.
pub fn reach_of(kind: &ActionKind) -> Reach {
    match kind {
        ActionKind::Timeout { .. }
        | ActionKind::Kick
        | ActionKind::Ban { .. }
        | ActionKind::Hold { .. }
        | ActionKind::Quarantine { .. } => Reach::Member,
        ActionKind::Block { .. } | ActionKind::DeleteMessage => Reach::Message,
        ActionKind::Pin => Reach::Pin,
        ActionKind::StripRoles | ActionKind::RemoveRole { .. } => Reach::Revoke,
        ActionKind::AddRole { .. } | ActionKind::ToggleRole { .. } => Reach::Grant,
        ActionKind::LockChannel { .. }
        | ActionKind::UnlockChannel { .. }
        | ActionKind::Slowmode { .. }
        | ActionKind::RenameChannel { .. }
        | ActionKind::DeleteOlder { .. }
        | ActionKind::PauseJoins { .. }
        | ActionKind::RequireApproval { .. } => Reach::Place,
        ActionKind::CounterAdd { .. }
        | ActionKind::CounterSet { .. }
        | ActionKind::Notify { .. }
        | ActionKind::Reply { .. }
        | ActionKind::SendMessage { .. }
        | ActionKind::React { .. }
        | ActionKind::StartThread { .. }
        | ActionKind::Log { .. }
        | ActionKind::Alert { .. }
        | ActionKind::WebhookOut { .. }
        | ActionKind::Report { .. }
        | ActionKind::PostPanel { .. }
        | ActionKind::OpenTicket
        | ActionKind::CreateRoom
        | ActionKind::Repost
        | ActionKind::Sticky
        | ActionKind::PostGiveaway => Reach::Own,
    }
}

/// The triggers, in the order of their bits in `automations.events`.
pub const EVENTS: [&str; 22] = [
    "message_sent",
    "message_edited",
    "message_deleted",
    "reaction_added",
    "reaction_removed",
    "member_joined",
    "member_admitted",
    "member_left",
    "profile_updated",
    "role_added",
    "role_removed",
    "voice_joined",
    "voice_left",
    "schedule",
    "command",
    "component",
    "counter_reached",
    "join_rate",
    "staff_action_rate",
    "audit_entry",
    "report_filed",
    "feed_item",
];

pub fn event_bit(trigger: &str) -> Option<u32> {
    EVENTS.iter().position(|e| *e == trigger).map(|i| 1 << i)
}

/// The conditions in the order they are numbered: each one, then its children.
pub fn flatten(conditions: &[Condition]) -> Vec<&Condition> {
    let mut out = Vec::new();
    for c in conditions {
        out.push(c);
        match c {
            Condition::Any { of } => out.extend(flatten(of)),
            Condition::Not { of } => out.extend(flatten(std::slice::from_ref(of))),
            _ => {}
        }
    }
    out
}

#[derive(Debug)]
enum Matcher {
    Keywords(KeywordSet),
    Patterns(Patterns),
    Links(links::Rules),
}

/// A valid automation: what its owner needs, and its matchers ready to run.
#[derive(Debug)]
pub struct Compiled {
    pub needs: Needs,
    pub action_needs: Vec<Needs>,
    pub guard: bool,
    /// The trigger's bit in `automations.events`.
    pub event: u32,
    /// Whose rights a run has besides its owner's.
    pub fired: Fired,
    /// What each action reaches: `access::may_run` checks it against the owner and, in a run
    /// that answers to a member, against that member's rights too.
    pub reach: Vec<Reach>,
    /// For each action, whether the member picks the role it gives them or takes off them
    /// (`Automation::picks`): the `picked` of `access::may_run`.
    pub picks: Vec<bool>,
    /// Where it reads and acts: `Here` for an event in a channel and for every action on the
    /// event's message or channel, and every channel its actions and kit name. The owner must be
    /// able to view each, at save (`Refs::views`) and at every run, so a channel event the owner
    /// can't view runs nothing.
    pub views: Vec<Place>,
    /// Where it posts or pins: the owner must be able to send there.
    pub sends: Vec<Place>,
    /// The roles it gives or takes: the owner must be able to grant them.
    pub roles: Vec<i64>,
    /// The roles members give themselves, not marked "May give permissions": the roles
    /// `check_refs` holds to the self-service rule at save. A run checks every role it gives,
    /// these and any other, with its bits as they are then (`access::grant_of`).
    pub self_served: Vec<i64>,
    kind: Kind,
    matchers: BTreeMap<usize, Matcher>,
    keyword_entries: usize,
    pattern_count: usize,
}

impl Compiled {
    /// The keyword set of the `keywords` or `name` condition numbered `condition` by `flatten`.
    /// A giveaway's requirements are numbered after the conditions, the same way.
    pub fn keywords(&self, condition: usize) -> Option<&KeywordSet> {
        match self.matchers.get(&condition) {
            Some(Matcher::Keywords(set)) => Some(set),
            _ => None,
        }
    }

    pub fn patterns(&self, condition: usize) -> Option<&Patterns> {
        match self.matchers.get(&condition) {
            Some(Matcher::Patterns(set)) => Some(set),
            _ => None,
        }
    }

    pub fn links(&self, condition: usize) -> Option<&links::Rules> {
        match self.matchers.get(&condition) {
            Some(Matcher::Links(rules)) => Some(rules),
            _ => None,
        }
    }

    /// How the automation is metered.
    pub fn kind(&self) -> Kind {
        self.kind
    }

    /// The entries of its `keywords` conditions, which count toward the server's budget.
    pub fn keyword_entries(&self) -> usize {
        self.keyword_entries
    }

    pub fn pattern_count(&self) -> usize {
        self.pattern_count
    }
}

const SCOPE_REFS: usize = 50;
const ROLES_MAX: usize = 20;
const ALLOW_MAX: usize = 100;
const TIMEOUT_MAX: u64 = 28 * 86_400;
const SLOWMODE_MAX: u64 = 21_600;

fn scope(check: &mut Check, path: &str, scope: &Scope) {
    check.count(path, scope.refs().len(), 0, SCOPE_REFS);
}

fn http(url: &str) -> bool {
    (url.starts_with("https://") || url.starts_with("http://")) && url.chars().count() <= 2048
}

/// A URL field is a web address as typed, never a template: a `{name}` placeholder is refused.
fn web_address(check: &mut Check, path: &str, url: &str) {
    match (http(url), template::templated(url)) {
        (false, _) => check.add(path, Reason::OutOfRange),
        (true, true) => check.add(path, Reason::NotAllowed),
        (true, false) => {}
    }
}

fn trigger(check: &mut Check, t: &Trigger, caps: &Caps) {
    if let Some(channels) = t.scope() {
        scope(check, "trigger.channels", channels);
    }
    match t {
        Trigger::ReactionAdded { emojis, .. } | Trigger::ReactionRemoved { emojis, .. } => {
            check.count("trigger.emojis", emojis.len(), 0, 20);
            for (i, e) in emojis.iter().enumerate() {
                check.text(&format!("trigger.emojis.{i}"), e, 1, 64);
            }
        }
        Trigger::RoleAdded { roles } | Trigger::RoleRemoved { roles } => {
            check.count("trigger.roles", roles.len(), 0, ROLES_MAX);
        }
        Trigger::Schedule { schedule } => check.under(
            "trigger.schedule",
            schedule::problems(schedule, caps.schedule_min_minutes),
        ),
        Trigger::Command {
            name,
            description,
            args,
            ..
        } => {
            let named = !name.is_empty()
                && name.len() <= 32
                && name
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
            if !named {
                check.add("trigger.name", Reason::BadId);
            }
            check.text("trigger.description", description, 0, 100);
            check.count("trigger.args", args.len(), 0, 5);
            check.named(
                "trigger.args",
                "name",
                32,
                args.iter().map(|a| a.name.as_str()),
            );
            for (i, a) in args.iter().enumerate() {
                arg(check, &format!("trigger.args.{i}"), a);
            }
        }
        Trigger::Component { panel } => check.text("trigger.panel", panel, 1, 32),
        Trigger::CounterReached { counter, every, .. } => {
            if !id_ok(counter, 32) {
                check.add("trigger.counter", Reason::BadId);
            }
            if *every == Some(0) {
                check.add("trigger.every", Reason::OutOfRange);
            }
        }
        Trigger::JoinRate { joins, seconds } => {
            check.range("trigger.joins", u64::from(*joins), 1, 499);
            check.range("trigger.seconds", u64::from(*seconds), 1, 3600);
        }
        Trigger::StaffActionRate {
            actions,
            count,
            minutes,
        } => {
            check.count("trigger.actions", actions.len(), 1, 20);
            check.range("trigger.count", u64::from(*count), 1, 1000);
            check.range("trigger.minutes", u64::from(*minutes), 1, 1440);
        }
        Trigger::AuditEntry { actions } => check.count("trigger.actions", actions.len(), 0, 100),
        Trigger::FeedItem { url } => {
            if !links::fetchable(url) {
                check.add("trigger.url", Reason::OutOfRange);
            }
        }
        Trigger::MessageSent { .. }
        | Trigger::MessageEdited { .. }
        | Trigger::MessageDeleted { .. }
        | Trigger::MemberJoined { .. }
        | Trigger::MemberAdmitted
        | Trigger::MemberLeft { .. }
        | Trigger::ProfileUpdated
        | Trigger::VoiceJoined { .. }
        | Trigger::VoiceLeft { .. }
        | Trigger::ReportFiled => {}
    }
}

fn arg(check: &mut Check, path: &str, a: &Arg) {
    match &a.kind {
        ArgKind::Text { max } => check.range(&format!("{path}.max"), u64::from(*max), 1, 1000),
        ArgKind::Number { min, max } => {
            if min > max {
                check.add(&format!("{path}.min"), Reason::OutOfRange);
            }
        }
        ArgKind::Choice { options } => {
            check.count(&format!("{path}.options"), options.len(), 1, SELECT_OPTIONS);
            for (j, o) in options.iter().enumerate() {
                check.text(&format!("{path}.options.{j}.label"), o.label.trim(), 1, 100);
            }
        }
        ArgKind::Member | ArgKind::Channel => {}
    }
}

fn pattern_reason(bad: Bad) -> Reason {
    match bad {
        Bad::Empty | Bad::Invalid => Reason::BadPattern,
        Bad::TooLong => Reason::TooLong,
        Bad::TooBig => Reason::TooBig,
    }
}

fn entries(check: &mut Check, path: &str, list: &[String]) {
    for (i, entry) in list.iter().enumerate() {
        if keywords::parse(entry).is_none() {
            check.add(&format!("{path}.{i}"), Reason::BadPattern);
        }
    }
}

struct Walk<'a> {
    caps: &'a Caps,
    next: usize,
    matchers: BTreeMap<usize, Matcher>,
    keyword_entries: usize,
    pattern_count: usize,
}

impl Walk<'_> {
    fn condition(&mut self, check: &mut Check, path: &str, c: &Condition, nested: bool) {
        let index = self.next;
        self.next += 1;
        let before = check.out.len();
        let field = |name: &str| format!("{path}.{name}");
        match c {
            Condition::Any { .. } | Condition::Not { .. } if nested => {
                check.add(path, Reason::NotAllowed);
            }
            Condition::Any { of } => {
                check.count(&field("of"), of.len(), 1, 10);
                for (j, child) in of.iter().enumerate() {
                    self.condition(check, &format!("{path}.of.{j}"), child, true);
                }
            }
            Condition::Not { of } => self.condition(check, &field("of"), of, true),
            Condition::Channel { scope: s } => scope(check, &field("scope"), s),
            Condition::HasRole { roles } | Condition::LacksRole { roles } => {
                check.count(&field("roles"), roles.len(), 1, ROLES_MAX);
            }
            Condition::HasPerm { perm } => {
                if perm.count_ones() != 1 || perm & ALL_PERMS == 0 {
                    check.add(&field("perm"), Reason::OutOfRange);
                }
            }
            Condition::Keywords {
                list,
                allow,
                profanity_preset,
            } => {
                let min = usize::from(!profanity_preset);
                check.count(&field("list"), list.len(), min, self.caps.keywords_max);
                entries(check, &field("list"), list);
                check.count(&field("allow"), allow.len(), 0, ALLOW_MAX);
                entries(check, &field("allow"), allow);
                if check.out.len() == before {
                    self.keyword_entries += list.len();
                    self.matchers
                        .insert(index, Matcher::Keywords(KeywordSet::new(list, allow)));
                }
            }
            Condition::Name { list } => {
                check.count(&field("list"), list.len(), 1, self.caps.keywords_max);
                entries(check, &field("list"), list);
                if check.out.len() == before {
                    self.matchers
                        .insert(index, Matcher::Keywords(KeywordSet::new(list, &[])));
                }
            }
            Condition::Regex { patterns: list } => {
                check.count(&field("patterns"), list.len(), 1, self.caps.regex_max);
                for (i, p) in list.iter().enumerate() {
                    if let Err(bad) = patterns::check(p) {
                        check.add(&format!("{path}.patterns.{i}"), pattern_reason(bad));
                    }
                }
                if check.out.len() == before {
                    match Patterns::new(list, PATTERN_BYTES * list.len().max(1)) {
                        Ok(set) => {
                            self.pattern_count += list.len();
                            self.matchers.insert(index, Matcher::Patterns(set));
                        }
                        Err((_, bad)) => check.add(&field("patterns"), pattern_reason(bad)),
                    }
                }
            }
            Condition::Links { mode, allow, deny } => {
                check.count(&field("allow"), allow.len(), 0, ALLOW_MAX);
                check.count(&field("deny"), deny.len(), 0, ALLOW_MAX);
                match links::Rules::new(*mode, allow, deny) {
                    Ok(rules) => {
                        self.matchers.insert(index, Matcher::Links(rules));
                    }
                    Err(BadRule::Allow(i)) => {
                        check.add(&format!("{path}.allow.{i}"), Reason::BadPattern)
                    }
                    Err(BadRule::Deny(i)) => {
                        check.add(&format!("{path}.deny.{i}"), Reason::BadPattern)
                    }
                }
            }
            Condition::Mentions { over, .. } => {
                check.range(&field("over"), u64::from(*over), 0, 50)
            }
            Condition::Caps { percent, .. } | Condition::Chance { percent } => {
                check.range(&field("percent"), u64::from(*percent), 1, 100);
            }
            Condition::Rate { count, seconds, .. } => {
                check.range(&field("count"), u64::from(*count), 1, 19);
                check.range(&field("seconds"), u64::from(*seconds), 1, 3600);
            }
            Condition::Duplicates { count, seconds } => {
                check.range(&field("count"), u64::from(*count), 1, 9);
                check.range(&field("seconds"), u64::from(*seconds), 1, 3600);
            }
            Condition::TimeWindow { days, from, to } => {
                check.count(&field("days"), days.len(), 1, 7);
                if !from.ok() {
                    check.add(&field("from"), Reason::OutOfRange);
                }
                if !to.ok() {
                    check.add(&field("to"), Reason::OutOfRange);
                }
            }
            Condition::Cooldown { seconds, .. } => {
                check.range(&field("seconds"), u64::from(*seconds), 1, 604_800);
            }
            Condition::Counter { name, .. } => {
                if !id_ok(name, 32) {
                    check.add(&field("name"), Reason::BadId);
                }
            }
            Condition::Reactions { emoji, at_least } => {
                check.text(&field("emoji"), emoji, 1, 64);
                check.range(&field("at_least"), u64::from(*at_least), 1, 10_000);
            }
            Condition::IsStaff
            | Condition::AccountAge { .. }
            | Condition::MemberTime { .. }
            | Condition::Pending
            | Condition::AuthorKind { .. }
            | Condition::HasAttachment { .. }
            | Condition::HasPoll
            | Condition::IsReply
            | Condition::InThread
            | Condition::Emoji { .. }
            | Condition::Lines { .. }
            | Condition::Length { .. } => {}
        }
    }
}

fn embed(check: &mut Check, path: &str, e: &Embed) {
    let text = |check: &mut Check, name: &str, value: &Option<String>, max: usize| {
        if let Some(v) = value {
            check.text(&format!("{path}.{name}"), v, 0, max);
        }
    };
    text(check, "title", &e.title, 256);
    text(check, "description", &e.description, 4096);
    if let Some(url) = &e.url {
        web_address(check, &format!("{path}.url"), url);
    }
    if e.color.is_some_and(|c| !(0..=0xff_ffff).contains(&c)) {
        check.add(&format!("{path}.color"), Reason::OutOfRange);
    }
    check.count(&format!("{path}.fields"), e.fields.len(), 0, 25);
    for (i, f) in e.fields.iter().enumerate() {
        check.text(&format!("{path}.fields.{i}.name"), f.name.trim(), 1, 256);
        check.text(&format!("{path}.fields.{i}.value"), f.value.trim(), 1, 1024);
    }
    if let Some(footer) = &e.footer {
        check.text(&format!("{path}.footer.text"), footer.text.trim(), 1, 2048);
    }
    let total: usize = [&e.title, &e.description]
        .into_iter()
        .flatten()
        .map(|s| s.chars().count())
        .chain(
            e.fields
                .iter()
                .map(|f| f.name.chars().count() + f.value.chars().count()),
        )
        .chain(e.footer.iter().map(|f| f.text.chars().count()))
        .sum();
    if total > 6000 {
        check.add(path, Reason::TooLong);
    }
}

fn components(check: &mut Check, path: &str, rows: &Components) {
    check.count(path, rows.len(), 0, COMPONENT_ROWS);
    let mut cids = BTreeSet::new();
    for (r, row) in rows.iter().enumerate() {
        let selects = row
            .iter()
            .filter(|c| matches!(c, Component::Select { .. }))
            .count();
        let fits = match selects {
            0 => (1..=ROW_BUTTONS).contains(&row.len()),
            _ => row.len() == 1,
        };
        if !fits {
            check.add(&format!("{path}.{r}"), Reason::OutOfRange);
        }
        for (i, c) in row.iter().enumerate() {
            let at = format!("{path}.{r}.{i}");
            if !id_ok(c.cid(), 32) {
                check.add(&format!("{at}.cid"), Reason::BadId);
            } else if !cids.insert(c.cid()) {
                check.add(&format!("{at}.cid"), Reason::Duplicate);
            }
            match c {
                Component::Button { label, press, .. } => {
                    check.text(&format!("{at}.label"), label.trim(), 1, 80);
                    if let Press::Link { url } = press {
                        web_address(check, &format!("{at}.url"), url);
                    }
                }
                Component::Select {
                    placeholder,
                    min,
                    max,
                    options,
                    ..
                } => {
                    check.text(&format!("{at}.placeholder"), placeholder, 0, 100);
                    check.count(&format!("{at}.options"), options.len(), 1, SELECT_OPTIONS);
                    if !options.is_empty() && (min > max || usize::from(*max) > options.len()) {
                        check.add(&format!("{at}.max"), Reason::OutOfRange);
                    }
                    let mut values = BTreeSet::new();
                    for (j, o) in options.iter().enumerate() {
                        check.text(&format!("{at}.options.{j}.label"), o.label.trim(), 1, 100);
                        check.text(
                            &format!("{at}.options.{j}.description"),
                            &o.description,
                            0,
                            100,
                        );
                        if !id_ok(&o.value, 32) {
                            check.add(&format!("{at}.options.{j}.value"), Reason::BadId);
                        } else if !values.insert(o.value.as_str()) {
                            check.add(&format!("{at}.options.{j}.value"), Reason::Duplicate);
                        }
                    }
                }
            }
        }
    }
}

/// What may run in the send or join path itself. `notify`, `alert`, `log` and `report` are
/// queued from there.
fn runs_in_guard(kind: &ActionKind) -> bool {
    matches!(
        kind,
        ActionKind::Block { .. }
            | ActionKind::Timeout { .. }
            | ActionKind::Kick
            | ActionKind::Ban { .. }
            | ActionKind::Notify { .. }
            | ActionKind::Alert { .. }
            | ActionKind::Log { .. }
            | ActionKind::Report { .. }
    )
}

/// What acts on the triggering message, so needs a trigger that carries one.
fn on_message(kind: &ActionKind) -> bool {
    matches!(
        kind,
        ActionKind::Block { .. }
            | ActionKind::DeleteMessage
            | ActionKind::Pin
            | ActionKind::React { .. }
            | ActionKind::Reply { .. }
            | ActionKind::StartThread { .. }
    )
}

/// What acts on the event's member or their roles, so needs a trigger that has one.
fn on_member(kind: &ActionKind) -> bool {
    match reach_of(kind) {
        Reach::Member | Reach::Revoke | Reach::Grant => true,
        Reach::Message
        | Reach::Pin
        | Reach::SelfRevoke
        | Reach::SelfGrant
        | Reach::Place
        | Reach::Own => false,
    }
}

/// The place of an action that may name the event's channel.
fn place_of(kind: &ActionKind) -> Option<Place> {
    match kind {
        ActionKind::SendMessage { channel, .. }
        | ActionKind::LockChannel { channel, .. }
        | ActionKind::UnlockChannel { channel }
        | ActionKind::Slowmode { channel, .. } => Some(*channel),
        _ => None,
    }
}

fn kit_action(kind: &ActionKind, kit: &Option<Kit>) -> bool {
    match kind {
        ActionKind::PostPanel { .. } => matches!(kit, Some(Kit::RolePanel { .. })),
        ActionKind::OpenTicket => matches!(kit, Some(Kit::Tickets { .. })),
        ActionKind::CreateRoom => matches!(kit, Some(Kit::Rooms { .. })),
        ActionKind::Repost => matches!(kit, Some(Kit::Starboard { .. })),
        ActionKind::Sticky => matches!(kit, Some(Kit::Sticky { .. })),
        ActionKind::PostGiveaway => matches!(kit, Some(Kit::Giveaway { .. })),
        _ => true,
    }
}

fn action(check: &mut Check, path: &str, action: &Action, a: &Automation, caps: &Caps) {
    let delay_max = u64::from(caps.delay_max_days) * 86_400;
    let field = |name: &str| format!("{path}.{name}");
    let message = caps.message_max_chars;
    check.range(&field("after"), u64::from(action.after), 0, delay_max);
    let guard = a.trigger.is_guard();
    let allowed = match &action.kind {
        ActionKind::Block { .. } => {
            matches!(a.trigger, Trigger::MessageSent { guard: true, .. }) && !action.after_post
        }
        kind => kit_action(kind, &a.kit) && (!guard || action.after_post || runs_in_guard(kind)),
    };
    if !allowed
        || (on_message(&action.kind) && !a.trigger.has_message())
        || (on_member(&action.kind) && !a.trigger.has_member())
    {
        check.add(path, Reason::NotAllowed);
    }
    if place_of(&action.kind) == Some(Place::Here) && !a.trigger.in_channel() {
        check.add(&field("channel"), Reason::NotAllowed);
    }
    if action.after_post && !guard {
        check.add(&field("after_post"), Reason::NotAllowed);
    }
    match &action.kind {
        ActionKind::Block { message, .. } => check.text(&field("message"), message, 0, 150),
        ActionKind::Timeout { seconds } => {
            check.range(&field("seconds"), u64::from(*seconds), 1, TIMEOUT_MAX);
        }
        ActionKind::Ban { purge_hours, .. } => {
            check.range(&field("purge_hours"), u64::from(*purge_hours), 0, 168);
        }
        ActionKind::Hold { reason } | ActionKind::Quarantine { reason } => {
            check.text(&field("reason"), reason, 0, 200);
        }
        ActionKind::AddRole { role, for_seconds } => {
            check.range(&field("for_seconds"), u64::from(*for_seconds), 0, delay_max);
            role_ref(check, &field("role"), role, &a.trigger);
        }
        ActionKind::RemoveRole { role } | ActionKind::ToggleRole { role } => {
            role_ref(check, &field("role"), role, &a.trigger);
        }
        ActionKind::CounterAdd {
            name,
            amount,
            target,
        } => {
            if !id_ok(name, 32) {
                check.add(&field("name"), Reason::BadId);
            }
            if matches!(amount, Amount::Random { min, max } if min > max) {
                check.add(&field("amount"), Reason::OutOfRange);
            }
            counter_target(check, &field("target"), target, &a.trigger);
        }
        ActionKind::CounterSet { name, target, .. } => {
            if !id_ok(name, 32) {
                check.add(&field("name"), Reason::BadId);
            }
            counter_target(check, &field("target"), target, &a.trigger);
        }
        ActionKind::Notify { text } | ActionKind::Reply { text, .. } => {
            check.text(&field("text"), text.trim(), 1, message);
        }
        ActionKind::SendMessage {
            text,
            embed: card,
            components: rows,
            ..
        } => {
            let empty = card.is_none() && rows.is_empty();
            check.text(&field("text"), text.trim(), usize::from(empty), message);
            if let Some(card) = card {
                embed(check, &field("embed"), card);
            }
            components(check, &field("components"), rows);
        }
        ActionKind::React { emojis } => {
            check.count(&field("emojis"), emojis.len(), 1, 3);
            for (i, e) in emojis.iter().enumerate() {
                check.text(&format!("{path}.emojis.{i}"), e, 1, 64);
            }
        }
        ActionKind::StartThread { name } => check.text(&field("name"), name.trim(), 1, 100),
        ActionKind::Alert { text, .. } => check.text(&field("text"), text, 0, message),
        ActionKind::LockChannel { for_seconds, .. } => {
            check.range(&field("for_seconds"), u64::from(*for_seconds), 0, delay_max);
        }
        ActionKind::Slowmode {
            seconds,
            for_seconds,
            ..
        } => {
            check.range(&field("seconds"), u64::from(*seconds), 0, SLOWMODE_MAX);
            check.range(&field("for_seconds"), u64::from(*for_seconds), 0, delay_max);
        }
        ActionKind::PauseJoins { minutes } | ActionKind::RequireApproval { minutes } => {
            check.range(&field("minutes"), u64::from(*minutes), 1, 1440);
        }
        ActionKind::RenameChannel { text, .. } => check.text(&field("text"), text.trim(), 1, 100),
        ActionKind::DeleteOlder { age_seconds, .. } => {
            check.range(
                &field("age_seconds"),
                u64::from(*age_seconds),
                3600,
                31_536_000,
            );
        }
        ActionKind::Report { reason, note } => {
            check.text(&field("reason"), reason, 0, 100);
            check.text(&field("note"), note, 0, 1000);
        }
        ActionKind::PostPanel { text, .. } => check.text(&field("text"), text, 0, message),
        ActionKind::Log { content, .. } => {
            if *content == LogContent::Text && !lists_channels(&a.trigger) {
                check.add(&field("content"), Reason::NotAllowed);
            }
        }
        ActionKind::DeleteMessage
        | ActionKind::Kick
        | ActionKind::StripRoles
        | ActionKind::Pin
        | ActionKind::UnlockChannel { .. }
        | ActionKind::WebhookOut { .. }
        | ActionKind::OpenTicket
        | ActionKind::CreateRoom
        | ActionKind::Repost
        | ActionKind::Sticky
        | ActionKind::PostGiveaway => {}
    }
}

/// Whether a scope names its channels one by one: no category, which would cover channels
/// added later, and never all channels or all but some.
fn listed(scope: &Scope) -> bool {
    match scope {
        Scope::Only(refs) => !refs.is_empty() && refs.iter().all(|r| matches!(r, Ref::Channel(_))),
        Scope::All | Scope::Except(_) => false,
    }
}

/// Whether a message trigger names its channels one by one, as a log that copies message text
/// needs.
fn lists_channels(trigger: &Trigger) -> bool {
    match trigger {
        Trigger::MessageSent { channels, .. }
        | Trigger::MessageEdited { channels }
        | Trigger::MessageDeleted { channels } => listed(channels),
        _ => false,
    }
}

/// A starboard reposts only from the channels its `reaction_added` trigger names one by one.
fn starboard(check: &mut Check, trigger: &Trigger) {
    match trigger {
        Trigger::ReactionAdded { channels, .. } if listed(channels) => {}
        Trigger::ReactionAdded { .. } => check.add("trigger.channels", Reason::NotAllowed),
        _ => check.add("trigger", Reason::NotAllowed),
    }
}

/// A counter's target is the member of the event or a `member` argument of the command.
fn counter_target(check: &mut Check, path: &str, target: &Target, trigger: &Trigger) {
    let Target::Arg(name) = target else {
        return;
    };
    let member = match trigger {
        Trigger::Command { args, .. } => args
            .iter()
            .any(|a| a.name == *name && matches!(a.kind, ArgKind::Member)),
        _ => false,
    };
    if !member {
        check.add(path, Reason::NotAllowed);
    }
}

/// A role taken from a command argument must name a required `choice` whose every option
/// carries a role, so the roles a command can give are the list fixed in its definition.
fn role_ref(check: &mut Check, path: &str, role: &RoleRef, trigger: &Trigger) {
    let RoleRef::Arg { arg } = role else {
        return;
    };
    let fixed = match trigger {
        Trigger::Command { args, .. } => args.iter().any(|a| {
            a.name == *arg
                && a.required
                && matches!(&a.kind, ArgKind::Choice { options } if options.iter().all(|o| o.role.is_some()))
        }),
        _ => false,
    };
    if !fixed {
        check.add(path, Reason::NotAllowed);
    }
}

fn kit(check: &mut Check, kit: &Kit, caps: &Caps) {
    match kit {
        Kit::RolePanel { mode, roles, .. } => {
            if matches!(mode, Mode::Limit { n: 0 }) {
                check.add("kit.mode.n", Reason::OutOfRange);
            }
            check.count("kit.roles", roles.len(), 1, SELECT_OPTIONS);
            let mut seen = BTreeSet::new();
            for (i, r) in roles.iter().enumerate() {
                if !seen.insert(r.role) {
                    check.add(&format!("kit.roles.{i}.role"), Reason::Duplicate);
                }
                check.text(&format!("kit.roles.{i}.label"), r.label.trim(), 1, 80);
            }
        }
        Kit::Tickets {
            staff_roles,
            name,
            max_open_per_member,
            intro,
            close_after_days,
            ..
        } => {
            check.count("kit.staff_roles", staff_roles.len(), 0, 10);
            check.text("kit.name", name.trim(), 1, 50);
            check.range(
                "kit.max_open_per_member",
                u64::from(*max_open_per_member),
                1,
                50,
            );
            check.text("kit.intro", intro, 0, caps.message_max_chars);
            check.range("kit.close_after_days", u64::from(*close_after_days), 0, 365);
        }
        Kit::Starboard {
            emoji, threshold, ..
        } => {
            check.text("kit.emoji", emoji, 1, 64);
            check.range("kit.threshold", u64::from(*threshold), 1, 1000);
        }
        Kit::Sticky {
            text,
            every,
            min_seconds,
            ..
        } => {
            check.text("kit.text", text.trim(), 1, caps.message_max_chars);
            check.range("kit.every", u64::from(*every), 1, 1000);
            check.range("kit.min_seconds", u64::from(*min_seconds), 30, 86_400);
        }
        Kit::Rooms {
            name,
            limit,
            delete_after_empty_seconds,
            max_rooms,
            ..
        } => {
            check.text("kit.name", name.trim(), 1, 50);
            check.range("kit.limit", u64::from(*limit), 0, 99);
            check.range(
                "kit.delete_after_empty_seconds",
                u64::from(*delete_after_empty_seconds),
                10,
                86_400,
            );
            check.range("kit.max_rooms", u64::from(*max_rooms), 1, 500);
        }
        Kit::Giveaway {
            prize,
            winners,
            requirements,
            ..
        } => {
            check.text("kit.prize", prize.trim(), 1, 200);
            check.range("kit.winners", u64::from(*winners), 1, 20);
            check.count("kit.requirements", flatten(requirements).len(), 0, 10);
        }
    }
}

fn tz_ok(name: &str) -> bool {
    #[cfg(feature = "tz")]
    return schedule::zone(name).is_some();
    #[cfg(not(feature = "tz"))]
    return schedule::zone_name_ok(name);
}

fn color(c: &str) -> bool {
    c.len() == 7 && c.starts_with('#') && c[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

fn roles_of(a: &Automation) -> Vec<i64> {
    let mut out = Vec::new();
    let mut add = |role: i64| {
        if !out.contains(&role) {
            out.push(role);
        }
    };
    if let Trigger::Command { args, .. } = &a.trigger {
        for arg in args {
            if let ArgKind::Choice { options } = &arg.kind {
                options.iter().filter_map(|o| o.role).for_each(&mut add);
            }
        }
    }
    for action in &a.actions {
        match &action.kind {
            ActionKind::AddRole { role, .. }
            | ActionKind::RemoveRole { role }
            | ActionKind::ToggleRole { role } => {
                if let RoleRef::Id(role) = role {
                    add(*role);
                }
            }
            ActionKind::SendMessage { components, .. } => {
                component_roles(components).into_iter().for_each(&mut add);
            }
            _ => {}
        }
    }
    if let Some(Kit::RolePanel { roles, .. }) = &a.kit {
        roles.iter().for_each(|r| add(r.role));
    }
    out
}

/// Whether a member's own act sets the automation off, so the roles it gives are self-service.
fn self_service_trigger(t: &Trigger) -> bool {
    t.fired() != Fired::Owner
}

fn self_served_of(a: &Automation) -> Vec<i64> {
    let mut out = Vec::new();
    let mut add = |role: i64| {
        if !out.contains(&role) {
            out.push(role);
        }
    };
    if let Trigger::Command { args, .. } = &a.trigger {
        for arg in args {
            if let ArgKind::Choice { options } = &arg.kind {
                options.iter().filter_map(|o| o.role).for_each(&mut add);
            }
        }
    }
    for action in &a.actions {
        match &action.kind {
            ActionKind::AddRole {
                role: RoleRef::Id(role),
                ..
            }
            | ActionKind::ToggleRole {
                role: RoleRef::Id(role),
            } if self_service_trigger(&a.trigger) => add(*role),
            ActionKind::SendMessage { components, .. } => {
                component_roles(components).into_iter().for_each(&mut add);
            }
            _ => {}
        }
    }
    if let Some(Kit::RolePanel { roles, .. }) = &a.kit {
        roles
            .iter()
            .filter(|r| !r.may_give)
            .for_each(|r| add(r.role));
    }
    out
}

fn sends_of(a: &Automation) -> Vec<Place> {
    let mut out = Vec::new();
    for action in &a.actions {
        let place = match (&action.kind, &a.kit) {
            (ActionKind::SendMessage { channel, .. }, _) => Some(*channel),
            (
                ActionKind::Reply { .. }
                | ActionKind::React { .. }
                | ActionKind::StartThread { .. }
                | ActionKind::Pin,
                _,
            ) => Some(Place::Here),
            (
                ActionKind::Log { channel, .. }
                | ActionKind::Alert { channel, .. }
                | ActionKind::PostPanel { channel, .. },
                _,
            )
            | (ActionKind::Sticky, Some(Kit::Sticky { channel, .. }))
            | (ActionKind::Repost, Some(Kit::Starboard { channel, .. }))
            | (ActionKind::PostGiveaway, Some(Kit::Giveaway { channel, .. })) => {
                Some(Place::Channel(*channel))
            }
            _ => None,
        };
        if let Some(place) = place.filter(|p| !out.contains(p)) {
            out.push(place);
        }
    }
    out
}

fn views_of(a: &Automation) -> Vec<Place> {
    let mut out = Vec::new();
    let mut add = |place: Place| {
        if !out.contains(&place) {
            out.push(place);
        }
    };
    if a.trigger.in_channel() && !matches!(a.trigger, Trigger::CounterReached { .. }) {
        add(Place::Here);
    }
    for action in &a.actions {
        match &action.kind {
            kind if on_message(kind) => add(Place::Here),
            ActionKind::Log { channel, .. }
            | ActionKind::Alert { channel, .. }
            | ActionKind::PostPanel { channel, .. }
            | ActionKind::RenameChannel { channel, .. }
            | ActionKind::DeleteOlder { channel, .. } => add(Place::Channel(*channel)),
            kind => {
                if let Some(place) = place_of(kind) {
                    add(place);
                }
            }
        }
    }
    match &a.kit {
        Some(
            Kit::Starboard { channel, .. }
            | Kit::Sticky { channel, .. }
            | Kit::Giveaway { channel, .. }
            | Kit::Rooms {
                hub_channel: channel,
                ..
            },
        ) => add(Place::Channel(*channel)),
        Some(Kit::RolePanel { .. } | Kit::Tickets { .. }) | None => {}
    }
    out
}

/// Checks an automation against the limits and compiles its matchers. References to channels
/// and roles are the server's to check: see `check_refs`.
pub fn validate(a: &Automation, caps: &Caps) -> Result<Compiled, Vec<Problem>> {
    let mut check = Check::default();
    check.text("name", a.name.trim(), 1, 50);
    if a.avatar.as_deref().is_some_and(|c| !color(c)) {
        check.add("avatar", Reason::OutOfRange);
    }
    if !tz_ok(&a.tz) {
        check.add("tz", Reason::BadTimeZone);
    }
    trigger(&mut check, &a.trigger, caps);
    check.count("conditions", flatten(&a.conditions).len(), 0, 10);
    let mut walk = Walk {
        caps,
        next: 0,
        matchers: BTreeMap::new(),
        keyword_entries: 0,
        pattern_count: 0,
    };
    for (i, c) in a.conditions.iter().enumerate() {
        walk.condition(&mut check, &format!("conditions.{i}"), c, false);
    }
    if let Some(Kit::Giveaway { requirements, .. }) = &a.kit {
        for (i, c) in requirements.iter().enumerate() {
            walk.condition(&mut check, &format!("kit.requirements.{i}"), c, false);
        }
    }
    check.count("actions", a.actions.len(), 1, 10);
    check.named(
        "actions",
        "aid",
        16,
        a.actions.iter().map(|x| x.aid.as_str()),
    );
    for (i, x) in a.actions.iter().enumerate() {
        action(&mut check, &format!("actions.{i}"), x, a, caps);
    }
    if let Some(k) = &a.kit {
        kit(&mut check, k, caps);
    }
    if let Some(Kit::Starboard { .. }) = &a.kit {
        starboard(&mut check, &a.trigger);
    }
    let problems = check.done();
    if !problems.is_empty() {
        return Err(problems);
    }
    let action_needs: Vec<Needs> = a.actions.iter().map(|x| needs_of(&x.kind)).collect();
    let names: Vec<&str> = a.actions.iter().map(|x| x.kind.name()).collect();
    Ok(Compiled {
        needs: action_needs.iter().fold(Needs(0), |all, n| all.with(*n)),
        action_needs,
        guard: a.trigger.is_guard(),
        event: event_bit(a.trigger.name()).unwrap_or(0),
        fired: a.trigger.fired(),
        reach: a.actions.iter().map(|x| reach_of(&x.kind)).collect(),
        picks: a.actions.iter().map(|x| a.picks(&x.kind)).collect(),
        views: views_of(a),
        sends: sends_of(a),
        roles: roles_of(a),
        self_served: self_served_of(a),
        kind: budget::kind_of(a.trigger.is_guard(), &names),
        matchers: walk.matchers,
        keyword_entries: walk.keyword_entries,
        pattern_count: walk.pattern_count,
    })
}

/// What a config may name: the server's channels and categories, its roles other than
/// @everyone with their current bits, and the bits and the viewable channels of the member
/// saving it.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct Refs {
    pub text_channels: BTreeSet<i64>,
    pub voice_channels: BTreeSet<i64>,
    pub categories: BTreeSet<i64>,
    pub roles: BTreeMap<i64, u32>,
    pub owner_bits: u32,
    /// The text and voice channels the member saving it can view. A channel they can't view is
    /// refused like one the server doesn't have.
    pub views: BTreeSet<i64>,
}

impl Refs {
    fn channel(&self, id: i64) -> bool {
        self.text_channels.contains(&id) || self.voice_channels.contains(&id)
    }

    fn sees(&self, id: i64) -> bool {
        self.views.contains(&id)
    }

    /// The channels of a scope. Those it runs in must be ones the saver can view; channels it
    /// leaves out and categories need only exist (a category's channels are checked at run time).
    fn scope(&self, check: &mut Check, path: &str, scope: &Scope) {
        let only = matches!(scope, Scope::Only(_));
        for (i, r) in scope.refs().iter().enumerate() {
            let known = match r {
                Ref::Channel(id) => self.channel(*id) && (!only || self.sees(*id)),
                Ref::Category(id) => self.categories.contains(id),
            };
            if !known {
                check.add(&format!("{path}.{i}"), Reason::UnknownChannel);
            }
        }
    }

    fn text(&self, check: &mut Check, path: &str, id: i64) {
        if !self.text_channels.contains(&id) || !self.sees(id) {
            check.add(path, Reason::UnknownChannel);
        }
    }

    fn place(&self, check: &mut Check, path: &str, place: Place) {
        if let Place::Channel(id) = place {
            self.text(check, path, id);
        }
    }

    fn known_roles(&self, check: &mut Check, path: &str, roles: &[i64]) {
        for (i, role) in roles.iter().enumerate() {
            if !self.roles.contains_key(role) {
                check.add(&format!("{path}.{i}"), Reason::UnknownRole);
            }
        }
    }

    /// A role the automation gives as its owner: the owner must be able to grant it.
    fn granted(&self, check: &mut Check, path: &str, role: i64) {
        match self.roles.get(&role) {
            None => check.add(path, Reason::UnknownRole),
            Some(bits) if bits & !self.owner_bits != 0 => check.add(path, Reason::OwnerCantGrant),
            Some(_) => {}
        }
    }

    /// A role members give themselves: it must pass the self-service rule.
    fn self_served(&self, check: &mut Check, path: &str, role: i64, may_give: bool) {
        match self.roles.get(&role) {
            None => check.add(path, Reason::UnknownRole),
            Some(&bits) => match self_service(bits, may_give, self.owner_bits) {
                Some(grants::Refusal::GivesPermissions) => {
                    check.add(path, Reason::GivesPermissions)
                }
                Some(grants::Refusal::OwnerCantGrant) => check.add(path, Reason::OwnerCantGrant),
                None => {}
            },
        }
    }

    fn condition(&self, check: &mut Check, path: &str, c: &Condition) {
        match c {
            Condition::Channel { scope } => self.scope(check, &format!("{path}.scope"), scope),
            Condition::HasRole { roles } | Condition::LacksRole { roles } => {
                self.known_roles(check, &format!("{path}.roles"), roles);
            }
            Condition::Any { of } => {
                for (j, child) in of.iter().enumerate() {
                    self.condition(check, &format!("{path}.of.{j}"), child);
                }
            }
            Condition::Not { of } => self.condition(check, &format!("{path}.of"), of),
            _ => {}
        }
    }
}

/// Every channel and role an automation names, against the server as it is now and the member
/// saving it. Every channel it reads or acts in must be one they can view (`Refs::views`). Roles
/// it gives as its owner must be within the owner's rights; roles members give themselves
/// (panels, buttons and menus, command choices, and roles given when a member's own act sets it
/// off, `Trigger::fired`) must also pass the self-service rule with their current bits.
pub fn check_refs(a: &Automation, refs: &Refs) -> Vec<Problem> {
    let mut check = Check::default();
    if let Some(channels) = a.trigger.scope() {
        refs.scope(&mut check, "trigger.channels", channels);
    }
    match &a.trigger {
        Trigger::RoleAdded { roles } | Trigger::RoleRemoved { roles } => {
            refs.known_roles(&mut check, "trigger.roles", roles);
        }
        Trigger::Command { args, .. } => {
            for (i, arg) in args.iter().enumerate() {
                if let ArgKind::Choice { options } = &arg.kind {
                    for (j, role) in options
                        .iter()
                        .enumerate()
                        .filter_map(|(j, o)| Some((j, o.role?)))
                    {
                        let path = format!("trigger.args.{i}.options.{j}.role");
                        refs.self_served(&mut check, &path, role, false);
                    }
                }
            }
        }
        _ => {}
    }
    for (i, c) in a.conditions.iter().enumerate() {
        refs.condition(&mut check, &format!("conditions.{i}"), c);
    }
    for (i, x) in a.actions.iter().enumerate() {
        let field = |name: &str| format!("actions.{i}.{name}");
        match &x.kind {
            ActionKind::AddRole {
                role: RoleRef::Id(role),
                ..
            }
            | ActionKind::ToggleRole {
                role: RoleRef::Id(role),
            } if self_service_trigger(&a.trigger) => {
                refs.self_served(&mut check, &field("role"), *role, false);
            }
            ActionKind::AddRole { role, .. }
            | ActionKind::RemoveRole { role }
            | ActionKind::ToggleRole { role } => {
                if let RoleRef::Id(role) = role {
                    refs.granted(&mut check, &field("role"), *role);
                }
            }
            ActionKind::SendMessage {
                channel,
                components: rows,
                ..
            } => {
                refs.place(&mut check, &field("channel"), *channel);
                for (r, row) in rows.iter().enumerate() {
                    for (n, c) in row.iter().enumerate() {
                        let at = format!("actions.{i}.components.{r}.{n}");
                        match c {
                            Component::Button {
                                press: Press::Jump { channel },
                                ..
                            } => refs.text(&mut check, &format!("{at}.channel"), *channel),
                            Component::Button {
                                press: Press::Role { role },
                                ..
                            } => refs.self_served(&mut check, &format!("{at}.role"), *role, false),
                            Component::Select { options, .. } => {
                                for (j, role) in options
                                    .iter()
                                    .enumerate()
                                    .filter_map(|(j, o)| Some((j, o.role?)))
                                {
                                    let path = format!("{at}.options.{j}.role");
                                    refs.self_served(&mut check, &path, role, false);
                                }
                            }
                            Component::Button { .. } => {}
                        }
                    }
                }
            }
            ActionKind::Log { channel, .. }
            | ActionKind::Alert { channel, .. }
            | ActionKind::RenameChannel { channel, .. }
            | ActionKind::DeleteOlder { channel, .. }
            | ActionKind::PostPanel { channel, .. } => {
                let known = match &x.kind {
                    ActionKind::RenameChannel { .. } => refs.channel(*channel),
                    _ => refs.text_channels.contains(channel),
                };
                if !known || !refs.sees(*channel) {
                    check.add(&field("channel"), Reason::UnknownChannel);
                }
            }
            ActionKind::LockChannel { channel, .. }
            | ActionKind::UnlockChannel { channel }
            | ActionKind::Slowmode { channel, .. } => {
                refs.place(&mut check, &field("channel"), *channel);
            }
            _ => {}
        }
    }
    match &a.kit {
        Some(Kit::RolePanel { roles, .. }) => {
            for (i, r) in roles.iter().enumerate() {
                let path = format!("kit.roles.{i}.role");
                refs.self_served(&mut check, &path, r.role, r.may_give);
            }
        }
        Some(Kit::Tickets {
            category,
            staff_roles,
            ..
        }) => {
            if !refs.categories.contains(category) {
                check.add("kit.category", Reason::UnknownChannel);
            }
            refs.known_roles(&mut check, "kit.staff_roles", staff_roles);
        }
        Some(Kit::Giveaway {
            channel,
            requirements,
            ..
        }) => {
            refs.text(&mut check, "kit.channel", *channel);
            for (i, c) in requirements.iter().enumerate() {
                refs.condition(&mut check, &format!("kit.requirements.{i}"), c);
            }
        }
        Some(Kit::Starboard { channel, .. }) | Some(Kit::Sticky { channel, .. }) => {
            refs.text(&mut check, "kit.channel", *channel)
        }
        Some(Kit::Rooms {
            hub_channel,
            category,
            ..
        }) => {
            if !refs.voice_channels.contains(hub_channel) || !refs.sees(*hub_channel) {
                check.add("kit.hub_channel", Reason::UnknownChannel);
            }
            if !refs.categories.contains(category) {
                check.add("kit.category", Reason::UnknownChannel);
            }
        }
        None => {}
    }
    check.done()
}

/// The content matchers of one guard condition, as the server-wide set takes them.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct Source {
    pub automation: i64,
    /// The condition's number, as `flatten` gives it.
    pub condition: usize,
    pub keywords: Vec<String>,
    pub allow: Vec<String>,
    pub patterns: Vec<String>,
}

/// A match of the server-wide set: which automation and condition, and which entry or pattern
/// of that condition.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct SourceHit {
    pub automation: i64,
    pub condition: usize,
    pub entry: usize,
}

#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct Hits {
    /// The first keyword hit of each condition that has one.
    pub keywords: Vec<SourceHit>,
    /// Every pattern that matches.
    pub patterns: Vec<SourceHit>,
}

/// A server's guards compiled together: one automaton over every keyword entry and one set over
/// every pattern, so a message is normalized and scanned once.
#[derive(Debug)]
pub struct GuardSet {
    sources: Vec<(i64, usize)>,
    keywords: KeywordSet,
    patterns: Patterns,
    pattern_sources: Vec<(usize, usize)>,
    guards: usize,
}

impl GuardSet {
    /// Compiles the sources within the server's budgets: guard automations (here, those the
    /// sources come from; `of` counts every guard), keyword entries, patterns and their compiled
    /// size.
    pub fn build(sources: Vec<Source>, caps: &Caps) -> Result<GuardSet, Vec<Problem>> {
        let guards = sources
            .iter()
            .map(|s| s.automation)
            .collect::<BTreeSet<i64>>()
            .len();
        GuardSet::compile(sources, guards, caps)
    }

    fn compile(sources: Vec<Source>, guards: usize, caps: &Caps) -> Result<GuardSet, Vec<Problem>> {
        let mut check = Check::default();
        check.count("guards", guards, 0, caps.guards_per_server);
        let entries: usize = sources.iter().map(|s| s.keywords.len()).sum();
        check.count("keywords", entries, 0, caps.keywords_per_server);
        let all: Vec<String> = sources.iter().flat_map(|s| s.patterns.clone()).collect();
        check.count("patterns", all.len(), 0, caps.regex_per_server);
        let pattern_sources: Vec<(usize, usize)> = sources
            .iter()
            .enumerate()
            .flat_map(|(s, source)| (0..source.patterns.len()).map(move |i| (s, i)))
            .collect();
        if !check.out.is_empty() {
            return Err(check.done());
        }
        let patterns = Patterns::new(&all, caps.regex_mib_per_server << 20).map_err(|e| {
            let (path, bad) = match e {
                (Some(i), bad) => (format!("patterns.{i}"), bad),
                (None, bad) => ("patterns".to_string(), bad),
            };
            vec![Problem {
                path,
                reason: pattern_reason(bad),
            }]
        })?;
        let groups: Vec<(&[String], &[String])> = sources
            .iter()
            .map(|s| (s.keywords.as_slice(), s.allow.as_slice()))
            .collect();
        Ok(GuardSet {
            sources: sources
                .iter()
                .map(|s| (s.automation, s.condition))
                .collect(),
            keywords: KeywordSet::grouped(&groups),
            patterns,
            pattern_sources,
            guards,
        })
    }

    /// The set of a server's automations: the `keywords` and `regex` conditions of its guards,
    /// within the cap on guard automations, which counts every guard, content conditions or not.
    pub fn of(automations: &[(i64, &Automation)], caps: &Caps) -> Result<GuardSet, Vec<Problem>> {
        let guards = automations
            .iter()
            .filter(|(_, a)| a.trigger.is_guard())
            .map(|(id, _)| *id)
            .collect::<BTreeSet<i64>>()
            .len();
        let mut sources = Vec::new();
        for (id, a) in automations.iter().filter(|(_, a)| a.trigger.is_guard()) {
            for (condition, c) in flatten(&a.conditions).into_iter().enumerate() {
                let source = match c {
                    Condition::Keywords { list, allow, .. } => Source {
                        keywords: list.clone(),
                        allow: allow.clone(),
                        ..Source::default()
                    },
                    Condition::Regex { patterns } => Source {
                        patterns: patterns.clone(),
                        ..Source::default()
                    },
                    _ => continue,
                };
                sources.push(Source {
                    automation: *id,
                    condition,
                    ..source
                });
            }
        }
        GuardSet::compile(sources, guards, caps)
    }

    /// The guard automations it was built from.
    pub fn guards(&self) -> usize {
        self.guards
    }

    pub fn keyword_entries(&self) -> usize {
        self.keywords.len()
    }

    pub fn patterns(&self) -> &[String] {
        self.patterns.patterns()
    }

    pub fn scan(&self, text: &str) -> Hits {
        self.scan_normalized(&keywords::normalize(text))
    }

    /// Scans text that `keywords::normalize` already normalized.
    pub fn scan_normalized(&self, t: &str) -> Hits {
        let hit = |source: usize, entry: usize| SourceHit {
            automation: self.sources[source].0,
            condition: self.sources[source].1,
            entry,
        };
        Hits {
            keywords: self
                .keywords
                .find_each(t)
                .into_iter()
                .enumerate()
                .filter_map(|(source, found)| Some(hit(source, found?.entry)))
                .collect(),
            patterns: self
                .patterns
                .matches(t)
                .into_iter()
                .map(|i| hit(self.pattern_sources[i].0, self.pattern_sources[i].1))
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::access::{Actor, Fired, Poster, Reach, actor, author, grant_of, may_run, revoke_of};
    use crate::budget::Kind;
    use crate::grants::*;
    use crate::model::{
        Action, ActionKind, Amount, Arg, ArgKind, ArgOption, Automation, Component, Condition, Kit,
        LinkMode, LogContent, Options, PanelRole, PanelStyle, Per, Place, Press, Ref, RoleRef,
        Scope, SelectOption, Target, Than, Trigger,
    };
    use crate::panel::Mode;
    use crate::schedule::{Repeat, Schedule};

    fn act(kind: ActionKind) -> Action {
        Action {
            aid: "a1".into(),
            after: 0,
            after_post: false,
            kind,
        }
    }

    fn auto(trigger: Trigger, conditions: Vec<Condition>, actions: Vec<ActionKind>) -> Automation {
        Automation {
            name: "Test".into(),
            enabled: true,
            avatar: None,
            tz: "UTC".into(),
            trigger,
            conditions,
            actions: actions
                .into_iter()
                .enumerate()
                .map(|(i, kind)| Action {
                    aid: format!("a{i}"),
                    ..act(kind)
                })
                .collect(),
            options: Options::default(),
            kit: None,
        }
    }

    fn sent() -> Trigger {
        Trigger::MessageSent {
            channels: Scope::All,
            edits: false,
            guard: false,
        }
    }

    fn guard() -> Trigger {
        Trigger::MessageSent {
            channels: Scope::All,
            edits: true,
            guard: true,
        }
    }

    fn notify() -> ActionKind {
        ActionKind::Notify { text: "Hi".into() }
    }

    /// One of every trigger, none a guard, in the order of `EVENTS`.
    fn triggers() -> Vec<Trigger> {
        vec![
            sent(),
            Trigger::MessageEdited {
                channels: Scope::All,
            },
            Trigger::MessageDeleted {
                channels: Scope::All,
            },
            Trigger::ReactionAdded {
                message: None,
                emojis: vec![],
                channels: Scope::All,
            },
            Trigger::ReactionRemoved {
                message: None,
                emojis: vec![],
                channels: Scope::All,
            },
            Trigger::MemberJoined { guard: false },
            Trigger::MemberAdmitted,
            Trigger::MemberLeft {
                kicked: None,
                banned: None,
            },
            Trigger::ProfileUpdated,
            Trigger::RoleAdded { roles: vec![] },
            Trigger::RoleRemoved { roles: vec![] },
            Trigger::VoiceJoined {
                channels: Scope::All,
            },
            Trigger::VoiceLeft {
                channels: Scope::All,
            },
            schedule(),
            Trigger::Command {
                name: "go".into(),
                description: String::new(),
                args: vec![],
                channels: Scope::All,
            },
            Trigger::Component {
                panel: "games".into(),
            },
            Trigger::CounterReached {
                counter: "strikes".into(),
                value: 3,
                every: None,
            },
            Trigger::JoinRate {
                joins: 10,
                seconds: 30,
            },
            Trigger::StaffActionRate {
                actions: vec!["ban".into()],
                count: 5,
                minutes: 2,
            },
            Trigger::AuditEntry { actions: vec![] },
            Trigger::ReportFiled,
            Trigger::FeedItem {
                url: "https://blog.example.com/feed.xml".into(),
            },
        ]
    }

    fn schedule() -> Trigger {
        Trigger::Schedule {
            schedule: Schedule {
                repeat: Repeat::Every { minutes: 60 },
                from: None,
                until: None,
            },
        }
    }

    fn caps() -> Caps {
        Caps::default()
    }

    fn paths(a: &Automation) -> Vec<String> {
        match validate(a, &caps()) {
            Ok(_) => vec![],
            Err(problems) => problems.into_iter().map(|p| p.path).collect(),
        }
    }

    fn strings(n: usize, f: impl Fn(usize) -> String) -> Vec<String> {
        (0..n).map(f).collect()
    }

    #[test]
    fn the_caps_default_to_the_documented_limits() {
        let c = caps();
        assert_eq!(c.automations_per_server, 100);
        assert_eq!(c.runs_per_minute, 600);
        assert_eq!(c.jobs_per_server, 10_000);
        assert_eq!(c.keywords_max, 1000);
        assert_eq!(c.regex_max, 10);
        assert_eq!(c.guards_per_server, 25);
        assert_eq!(c.keywords_per_server, 5000);
        assert_eq!(c.regex_per_server, 50);
        assert_eq!(c.regex_mib_per_server, 4);
        assert_eq!(c.jobs_per_event, 20);
        assert_eq!(c.guard_p99_us, 300);
        assert_eq!(c.cards_per_minute, 60);
        assert_eq!(c.schedule_min_minutes, 10);
        assert_eq!(c.delay_max_days, 7);
        assert_eq!(c.counters_per_server, 10);
        assert_eq!(c.commands_per_server, 50);
        assert_eq!(c.workers, 8);
        assert_eq!(c.command_runs_per_minute, 20);
        assert_eq!(c.presses_per_10s, 10);
        assert_eq!(c.tickets_open_per_member, 3);
        assert_eq!(c.tickets_open_per_server, 100);
        assert_eq!(c.rooms_per_server, 50);
        assert_eq!(c.message_max_chars, 4000);
    }

    #[test]
    fn every_action_has_its_needs() {
        let cases: Vec<(ActionKind, u32)> = vec![
            (
                ActionKind::Block {
                    message: "No".into(),
                    report: false,
                },
                DELETE_MESSAGES,
            ),
            (ActionKind::DeleteMessage, DELETE_MESSAGES),
            (ActionKind::Timeout { seconds: 600 }, TIMEOUT_MEMBERS),
            (ActionKind::Kick, KICK),
            (
                ActionKind::Ban {
                    purge_hours: 24,
                    then_unban: false,
                },
                KICK,
            ),
            (
                ActionKind::Hold {
                    reason: String::new(),
                },
                KICK | ASSIGN_ROLES,
            ),
            (
                ActionKind::Quarantine {
                    reason: String::new(),
                },
                KICK | ASSIGN_ROLES,
            ),
            (ActionKind::StripRoles, ASSIGN_ROLES),
            (
                ActionKind::AddRole {
                    role: 5.into(),
                    for_seconds: 0,
                },
                ASSIGN_ROLES,
            ),
            (ActionKind::RemoveRole { role: 5.into() }, ASSIGN_ROLES),
            (ActionKind::ToggleRole { role: 5.into() }, ASSIGN_ROLES),
            (
                ActionKind::CounterAdd {
                    name: "xp".into(),
                    amount: Amount::Fixed(1),
                    target: Target::Member,
                },
                MANAGE_AUTOMATIONS,
            ),
            (
                ActionKind::CounterSet {
                    name: "xp".into(),
                    value: 0,
                    target: Target::Member,
                },
                MANAGE_AUTOMATIONS,
            ),
            (notify(), 0),
            (
                ActionKind::Reply {
                    text: "Hi".into(),
                    ping: false,
                },
                0,
            ),
            (
                ActionKind::SendMessage {
                    channel: Place::Channel(3),
                    text: "Hi".into(),
                    embed: None,
                    components: vec![],
                    ping: false,
                },
                0,
            ),
            (
                ActionKind::React {
                    emojis: vec!["👍".into()],
                },
                0,
            ),
            (
                ActionKind::StartThread {
                    name: "Talk".into(),
                },
                0,
            ),
            (ActionKind::Pin, DELETE_MESSAGES),
            (
                ActionKind::Log {
                    channel: 3,
                    content: Default::default(),
                },
                0,
            ),
            (
                ActionKind::Alert {
                    channel: 3,
                    text: String::new(),
                },
                0,
            ),
            (
                ActionKind::LockChannel {
                    channel: Place::Here,
                    for_seconds: 0,
                },
                MANAGE_CHANNELS,
            ),
            (
                ActionKind::UnlockChannel {
                    channel: Place::Here,
                },
                MANAGE_CHANNELS,
            ),
            (
                ActionKind::Slowmode {
                    channel: Place::Here,
                    seconds: 10,
                    for_seconds: 0,
                },
                MANAGE_CHANNELS,
            ),
            (ActionKind::PauseJoins { minutes: 15 }, KICK),
            (ActionKind::RequireApproval { minutes: 60 }, KICK),
            (
                ActionKind::RenameChannel {
                    channel: 3,
                    text: "Members: {count}".into(),
                },
                MANAGE_CHANNELS,
            ),
            (
                ActionKind::DeleteOlder {
                    channel: 3,
                    age_seconds: 604_800,
                },
                MANAGE_CHANNELS | DELETE_MESSAGES,
            ),
            (ActionKind::WebhookOut { hook: 1 }, MANAGE_WEBHOOKS),
            (
                ActionKind::Report {
                    reason: String::new(),
                    note: String::new(),
                },
                0,
            ),
            (
                ActionKind::PostPanel {
                    channel: 3,
                    text: String::new(),
                },
                ASSIGN_ROLES,
            ),
            (ActionKind::OpenTicket, MANAGE_CHANNELS),
            (ActionKind::CreateRoom, MANAGE_CHANNELS),
            (ActionKind::Repost, 0),
            (ActionKind::Sticky, 0),
            (ActionKind::PostGiveaway, 0),
        ];
        assert_eq!(cases.len(), 36);
        for (kind, bits) in cases {
            assert_eq!(needs_of(&kind), Needs(bits), "{}", kind.name());
        }
    }

    #[test]
    fn an_automations_needs_are_the_union_and_name_what_is_lacking() {
        let a = auto(
            sent(),
            vec![],
            vec![
                ActionKind::Kick,
                ActionKind::Timeout { seconds: 60 },
                ActionKind::SendMessage {
                    channel: Place::Channel(3),
                    text: "@everyone look".into(),
                    embed: None,
                    components: vec![],
                    ping: true,
                },
            ],
        );
        let c = validate(&a, &caps()).expect("valid");
        assert_eq!(c.needs, Needs(KICK | TIMEOUT_MEMBERS | MENTION_EVERYONE));
        assert_eq!(
            c.action_needs,
            [Needs(KICK), Needs(TIMEOUT_MEMBERS), Needs(MENTION_EVERYONE)]
        );
        assert_eq!(c.sends, [Place::Channel(3)]);
        assert!(c.needs.met_by(ALL_PERMS));
        assert!(!c.needs.met_by(KICK));
        assert_eq!(
            c.needs.lacking(KICK),
            Needs(TIMEOUT_MEMBERS | MENTION_EVERYONE)
        );
        assert_eq!(
            c.needs.lacking(KICK).names(),
            ["Mention everyone and roles", "Timeout members"]
        );
        assert_eq!(c.kind(), Kind::Posting);
        assert_eq!(serde_json::to_string(&c.needs).expect("json"), "164");
    }

    #[test]
    fn every_action_that_posts_or_pins_names_where_the_owner_must_send() {
        let with_kit = |trigger: Trigger, kind: ActionKind, kit: Kit| {
            let mut a = auto(trigger, vec![], vec![kind]);
            a.kit = Some(kit);
            validate(&a, &caps()).expect("valid").sends
        };
        let star = Trigger::ReactionAdded {
            message: None,
            emojis: vec!["⭐".into()],
            channels: Scope::Only(vec![Ref::Channel(2)]),
        };
        let cases = [
            with_kit(
                sent(),
                ActionKind::Sticky,
                Kit::Sticky {
                    channel: 7,
                    text: "Read the rules".into(),
                    every: 5,
                    min_seconds: 30,
                },
            ),
            with_kit(
                star,
                ActionKind::Repost,
                Kit::Starboard {
                    emoji: "⭐".into(),
                    threshold: 3,
                    channel: 7,
                    self_star: false,
                },
            ),
            with_kit(
                Trigger::Component {
                    panel: "giveaway".into(),
                },
                ActionKind::PostGiveaway,
                Kit::Giveaway {
                    prize: "A mug".into(),
                    winners: 1,
                    ends_at: 0,
                    requirements: vec![],
                    channel: 7,
                },
            ),
        ];
        for sends in cases {
            assert_eq!(sends, [Place::Channel(7)]);
        }
        let sends = |kinds: Vec<ActionKind>| {
            validate(&auto(sent(), vec![], kinds), &caps())
                .expect("valid")
                .sends
        };
        assert_eq!(sends(vec![ActionKind::Pin]), [Place::Here]);
        assert_eq!(
            sends(vec![
                ActionKind::Pin,
                ActionKind::Reply {
                    text: "Hi".into(),
                    ping: false,
                },
                ActionKind::Log {
                    channel: 7,
                    content: Default::default(),
                },
                ActionKind::Alert {
                    channel: 7,
                    text: String::new(),
                },
                ActionKind::SendMessage {
                    channel: Place::Channel(8),
                    text: "Hi".into(),
                    embed: None,
                    components: vec![],
                    ping: false,
                },
            ]),
            [Place::Here, Place::Channel(7), Place::Channel(8)]
        );
        assert!(sends(vec![ActionKind::Kick, notify(), ActionKind::DeleteMessage]).is_empty());
        let c = validate(&panel(Mode::Toggle, vec![panel_role(5, false)]), &caps());
        assert_eq!(c.expect("valid").sends, [Place::Channel(3)]);
    }

    #[test]
    fn everyone_in_a_template_needs_the_bit_only_when_it_can_ping() {
        let send = |text: &str, ping: bool| {
            let a = auto(
                sent(),
                vec![],
                vec![ActionKind::SendMessage {
                    channel: Place::Here,
                    text: text.into(),
                    embed: None,
                    components: vec![],
                    ping,
                }],
            );
            validate(&a, &caps()).expect("valid").needs
        };
        assert_eq!(send("@everyone hi", true), Needs(MENTION_EVERYONE));
        assert_eq!(send("@here hi", true), Needs(MENTION_EVERYONE));
        assert_eq!(send("@everyone hi", false), Needs(0));
        assert_eq!(send("hi {member.mention}", true), Needs(0));
    }

    #[test]
    fn a_message_with_role_buttons_needs_what_a_role_panel_needs() {
        let send = |components: Vec<Vec<Component>>, text: &str| {
            let a = auto(
                sent(),
                vec![],
                vec![ActionKind::SendMessage {
                    channel: Place::Here,
                    text: text.into(),
                    embed: None,
                    components,
                    ping: true,
                }],
            );
            validate(&a, &caps()).expect("valid")
        };
        let run = Component::Button {
            cid: "run".into(),
            label: "Enter".into(),
            emoji: None,
            style: Default::default(),
            press: Press::Run,
        };
        let jump = Component::Button {
            cid: "jump".into(),
            label: "Rules".into(),
            emoji: None,
            style: Default::default(),
            press: Press::Jump { channel: 3 },
        };
        let plain = send(vec![vec![run.clone(), jump.clone()]], "Hi");
        assert_eq!(plain.needs, Needs(0));
        assert_eq!(plain.roles, [] as [i64; 0]);
        let buttons = send(vec![vec![button("mc"), run.clone()]], "Hi");
        assert_eq!(buttons.needs, Needs(ASSIGN_ROLES));
        assert_eq!(buttons.action_needs, [Needs(ASSIGN_ROLES)]);
        assert_eq!(buttons.roles, [5]);
        let menu = send(vec![vec![select("more", 2, 0, 2)]], "@everyone pick");
        assert_eq!(menu.needs, Needs(ASSIGN_ROLES | MENTION_EVERYONE));
        assert_eq!(menu.roles, [5]);
        let mut no_roles = select("more", 2, 0, 2);
        if let Component::Select { options, .. } = &mut no_roles {
            for o in options {
                o.role = None;
            }
        }
        assert_eq!(send(vec![vec![no_roles]], "Hi").needs, Needs(0));
    }

    #[test]
    fn a_feed_is_fetched_only_from_a_public_web_address() {
        let feed = |url: &str| {
            paths(&auto(
                Trigger::FeedItem { url: url.into() },
                vec![],
                vec![notify()],
            ))
        };
        assert_eq!(feed("https://blog.example.com/feed.xml"), [] as [&str; 0]);
        for bad in [
            "ftp://blog.example.com/feed",
            "http://localhost/feed",
            "http://127.0.0.1/feed",
            "http://[::1]/feed",
            "http://169.254.169.254/latest/meta-data",
            "http://intranet/feed",
            "http://user:pw@blog.example.com/feed",
        ] {
            assert_eq!(feed(bad), ["trigger.url"], "{bad}");
        }
    }

    #[test]
    fn a_guard_refuses_actions_that_cant_run_in_the_send_path() {
        let allowed = vec![
            ActionKind::Block {
                message: "Watch your language".into(),
                report: true,
            },
            ActionKind::Timeout { seconds: 600 },
            ActionKind::Kick,
            ActionKind::Ban {
                purge_hours: 24,
                then_unban: false,
            },
            notify(),
            ActionKind::Alert {
                channel: 3,
                text: String::new(),
            },
            ActionKind::Log {
                channel: 3,
                content: Default::default(),
            },
            ActionKind::Report {
                reason: String::new(),
                note: String::new(),
            },
        ];
        let a = auto(guard(), vec![], allowed);
        let c = validate(&a, &caps()).expect("valid");
        assert!(c.guard);
        assert_eq!(c.kind(), Kind::Guard);

        let mut bad = auto(
            guard(),
            vec![],
            vec![
                ActionKind::Block {
                    message: String::new(),
                    report: false,
                },
                ActionKind::React {
                    emojis: vec!["👍".into()],
                },
                ActionKind::AddRole {
                    role: 5.into(),
                    for_seconds: 0,
                },
            ],
        );
        assert_eq!(paths(&bad), ["actions.1", "actions.2"]);
        bad.actions[1].after_post = true;
        bad.actions[2].after_post = true;
        assert_eq!(paths(&bad), [] as [&str; 0]);
    }

    #[test]
    fn block_and_after_post_belong_to_guards() {
        let block = ActionKind::Block {
            message: String::new(),
            report: false,
        };
        assert_eq!(
            paths(&auto(sent(), vec![], vec![block.clone()])),
            ["actions.0"]
        );
        let join = auto(Trigger::MemberJoined { guard: true }, vec![], vec![block]);
        assert_eq!(paths(&join), ["actions.0"]);
        let kick = auto(
            Trigger::MemberJoined { guard: true },
            vec![],
            vec![ActionKind::Kick],
        );
        assert!(validate(&kick, &caps()).expect("valid").guard);
        let mut late = auto(sent(), vec![], vec![notify()]);
        late.actions[0].after_post = true;
        assert_eq!(paths(&late), ["actions.0.after_post"]);
        let profile = auto(Trigger::ProfileUpdated, vec![], vec![notify()]);
        assert!(!validate(&profile, &caps()).expect("valid").guard);
    }

    #[test]
    fn a_log_copies_message_text_only_from_channels_its_message_trigger_lists() {
        let log = |trigger: Trigger, content: LogContent| {
            let a = auto(
                trigger,
                vec![],
                vec![
                    notify(),
                    ActionKind::Log {
                        channel: 7,
                        content,
                    },
                ],
            );
            paths(&a)
        };
        let listed = |refs: Vec<Ref>| Scope::Only(refs);
        let refused = [
            Trigger::MessageDeleted {
                channels: Scope::All,
            },
            Trigger::MessageEdited {
                channels: Scope::Except(vec![Ref::Channel(8)]),
            },
            Trigger::MessageDeleted {
                channels: listed(vec![Ref::Category(9)]),
            },
            Trigger::MessageEdited {
                channels: listed(vec![Ref::Channel(8), Ref::Category(9)]),
            },
            Trigger::MessageDeleted {
                channels: listed(vec![]),
            },
            sent(),
            guard(),
            Trigger::MemberLeft {
                kicked: None,
                banned: None,
            },
            Trigger::ReactionAdded {
                message: None,
                emojis: vec![],
                channels: listed(vec![Ref::Channel(8)]),
            },
            Trigger::Command {
                name: "log".into(),
                description: String::new(),
                args: vec![],
                channels: listed(vec![Ref::Channel(8)]),
            },
        ];
        for trigger in refused {
            assert_eq!(
                log(trigger.clone(), LogContent::Text),
                ["actions.1.content"],
                "{trigger:?}"
            );
            assert_eq!(log(trigger, LogContent::Metadata), [] as [&str; 0]);
        }
        let allowed = [
            Trigger::MessageDeleted {
                channels: listed(vec![Ref::Channel(8)]),
            },
            Trigger::MessageEdited {
                channels: listed(vec![Ref::Channel(8), Ref::Channel(2)]),
            },
            Trigger::MessageSent {
                channels: listed(vec![Ref::Channel(8)]),
                edits: true,
                guard: false,
            },
            Trigger::MessageSent {
                channels: listed(vec![Ref::Channel(8)]),
                edits: true,
                guard: true,
            },
        ];
        for trigger in allowed {
            assert_eq!(
                log(trigger.clone(), LogContent::Text),
                [] as [&str; 0],
                "{trigger:?}"
            );
        }
    }

    #[test]
    fn names_actions_and_delays_have_limits() {
        let mut a = auto(sent(), vec![], vec![notify()]);
        a.name = "n".repeat(50);
        assert_eq!(paths(&a), [] as [&str; 0]);
        a.name = "n".repeat(51);
        assert_eq!(paths(&a), ["name"]);
        a.name = "  ".into();
        assert_eq!(paths(&a), ["name"]);
        let mut a = auto(sent(), vec![], vec![]);
        assert_eq!(paths(&a), ["actions"]);
        a = auto(sent(), vec![], vec![notify(); 10]);
        assert_eq!(paths(&a), [] as [&str; 0]);
        a = auto(sent(), vec![], vec![notify(); 11]);
        assert_eq!(paths(&a), ["actions"]);
        let mut a = auto(sent(), vec![], vec![notify(), notify()]);
        a.actions[1].aid = "a0".into();
        assert_eq!(paths(&a), ["actions.1.aid"]);
        a.actions[1].aid = "Bad Id".into();
        assert_eq!(paths(&a), ["actions.1.aid"]);
        a.actions[1].aid = "ok_2".into();
        a.actions[1].after = 604_800;
        assert_eq!(paths(&a), [] as [&str; 0]);
        a.actions[1].after = 604_801;
        assert_eq!(paths(&a), ["actions.1.after"]);
        a.actions[1].after = 0;
        a.avatar = Some("#12aBcf".into());
        assert_eq!(paths(&a), [] as [&str; 0]);
        a.avatar = Some("red".into());
        assert_eq!(paths(&a), ["avatar"]);
    }

    #[test]
    fn a_bad_time_zone_is_refused() {
        let mut a = auto(sent(), vec![], vec![notify()]);
        a.tz = "Europe/Berlin".into();
        assert_eq!(paths(&a), [] as [&str; 0]);
        a.tz = "Mars/Olympus".into();
        assert_eq!(paths(&a).is_empty(), !cfg!(feature = "tz"));
        a.tz = "not a zone".into();
        assert_eq!(paths(&a), ["tz"]);
        a.tz = String::new();
        assert_eq!(paths(&a), ["tz"]);
    }

    #[test]
    fn conditions_count_their_children_and_nest_one_level() {
        let pending = Condition::Pending;
        let ten = vec![pending.clone(); 10];
        assert_eq!(paths(&auto(sent(), ten, vec![notify()])), [] as [&str; 0]);
        let eleven = vec![pending.clone(); 11];
        assert_eq!(paths(&auto(sent(), eleven, vec![notify()])), ["conditions"]);
        let any = Condition::Any {
            of: vec![pending.clone(); 9],
        };
        assert_eq!(
            paths(&auto(sent(), vec![any.clone()], vec![notify()])),
            [] as [&str; 0]
        );
        let over = vec![any.clone(), pending.clone()];
        assert_eq!(paths(&auto(sent(), over, vec![notify()])), ["conditions"]);
        let nested = Condition::Not {
            of: Box::new(Condition::Any {
                of: vec![pending.clone()],
            }),
        };
        assert_eq!(
            paths(&auto(sent(), vec![nested], vec![notify()])),
            ["conditions.0.of"]
        );
        let empty = Condition::Any { of: vec![] };
        assert_eq!(
            paths(&auto(sent(), vec![empty], vec![notify()])),
            ["conditions.0.of"]
        );
        let not = Condition::Not {
            of: Box::new(Condition::IsStaff),
        };
        let flat = [not, any];
        assert_eq!(
            flatten(&flat)
                .iter()
                .map(|c| c.name())
                .collect::<Vec<&str>>(),
            [
                "not", "is_staff", "any", "pending", "pending", "pending", "pending", "pending",
                "pending", "pending", "pending", "pending"
            ]
        );
    }

    fn keywords(list: Vec<String>, allow: Vec<String>) -> Condition {
        Condition::Keywords {
            list,
            allow,
            profanity_preset: false,
        }
    }

    #[test]
    fn keyword_lists_have_their_limits() {
        let with = |c: Condition| paths(&auto(guard(), vec![c], vec![notify()]));
        assert_eq!(
            with(keywords(strings(1000, |i| format!("word{i}")), vec![])),
            [] as [&str; 0]
        );
        assert_eq!(
            with(keywords(strings(1001, |i| format!("word{i}")), vec![])),
            ["conditions.0.list"]
        );
        assert_eq!(
            with(keywords(vec!["ok".into(), "x".repeat(61)], vec![])),
            ["conditions.0.list.1"]
        );
        assert_eq!(
            with(keywords(vec!["a*b".into()], vec![])),
            ["conditions.0.list.0"]
        );
        assert_eq!(with(keywords(vec![], vec![])), ["conditions.0.list"]);
        assert_eq!(
            with(Condition::Keywords {
                list: vec![],
                allow: vec![],
                profanity_preset: true
            }),
            [] as [&str; 0]
        );
        assert_eq!(
            with(keywords(
                vec!["a".into()],
                strings(100, |i| format!("ok{i}"))
            )),
            [] as [&str; 0]
        );
        assert_eq!(
            with(keywords(
                vec!["a".into()],
                strings(101, |i| format!("ok{i}"))
            )),
            ["conditions.0.allow"]
        );
        assert_eq!(
            with(keywords(vec!["a".into()], vec!["*".into()])),
            ["conditions.0.allow.0"]
        );
        assert_eq!(
            with(Condition::Name { list: vec![] }),
            ["conditions.0.list"]
        );
        let small = Caps {
            keywords_max: 10,
            ..caps()
        };
        let a = auto(
            guard(),
            vec![keywords(strings(11, |i| format!("w{i}")), vec![])],
            vec![notify()],
        );
        assert_eq!(
            validate(&a, &small).expect_err("refused")[0].path,
            "conditions.0.list"
        );
    }

    #[test]
    fn regex_lists_have_their_limits() {
        let with = |patterns: Vec<String>| {
            paths(&auto(
                guard(),
                vec![Condition::Regex { patterns }],
                vec![notify()],
            ))
        };
        assert_eq!(with(strings(10, |i| format!("free{i}+"))), [] as [&str; 0]);
        assert_eq!(
            with(strings(11, |i| format!("free{i}+"))),
            ["conditions.0.patterns"]
        );
        assert_eq!(with(vec![]), ["conditions.0.patterns"]);
        assert_eq!(with(vec!["a".repeat(260)]), [] as [&str; 0]);
        assert_eq!(with(vec!["a".repeat(261)]), ["conditions.0.patterns.0"]);
        assert_eq!(with(vec!["(open".into()]), ["conditions.0.patterns.0"]);
        assert_eq!(
            with(vec!["ok".into(), r"((\pL{50}){50}){20}".into()]),
            ["conditions.0.patterns.1"]
        );
        let err = validate(
            &auto(
                guard(),
                vec![Condition::Regex {
                    patterns: vec![r"((\pL{50}){50}){20}".into()],
                }],
                vec![notify()],
            ),
            &caps(),
        )
        .expect_err("too big");
        assert_eq!(err[0].reason, Reason::TooBig);
    }

    #[test]
    fn the_matchers_are_compiled_per_condition() {
        let a = auto(
            guard(),
            vec![
                Condition::Not {
                    of: Box::new(Condition::IsStaff),
                },
                keywords(
                    vec!["free nitro".into(), "*scam*".into()],
                    vec!["scampi".into()],
                ),
                Condition::Regex {
                    patterns: vec![r"\bfree\b".into(), "N[Ii]TRO".into()],
                },
                Condition::Links {
                    mode: LinkMode::NotAllowed,
                    allow: vec!["*.example.com".into()],
                    deny: vec![],
                },
                Condition::Name {
                    list: vec!["admin*".into()],
                },
            ],
            vec![notify()],
        );
        let c = validate(&a, &caps()).expect("valid");
        assert!(c.keywords(0).is_none());
        assert!(c.keywords(1).is_none());
        let words = c.keywords(2).expect("keywords");
        assert_eq!(words.find("get FREE  nitro").map(|h| h.entry), Some(0));
        assert_eq!(words.find("fresh scampi"), None);
        let patterns = c.patterns(3).expect("patterns");
        assert_eq!(
            patterns.matches(&crate::keywords::normalize("Free NITRO")),
            [0, 1]
        );
        let links = c.links(4).expect("links");
        assert!(links.hit("see https://evil.test/x").is_some());
        assert!(links.hit("see https://docs.example.com/x").is_none());
        let names = c.keywords(5).expect("names");
        assert!(names.find("Administrator").is_some());
        assert_eq!(c.keyword_entries(), 2);
        assert_eq!(c.pattern_count(), 2);
    }

    #[test]
    fn link_rules_and_other_condition_limits() {
        let with = |c: Condition| paths(&auto(sent(), vec![c], vec![notify()]));
        let links = |allow: Vec<String>| Condition::Links {
            mode: LinkMode::NotAllowed,
            allow,
            deny: vec![],
        };
        assert_eq!(
            with(links(strings(100, |i| format!("a{i}.example")))),
            [] as [&str; 0]
        );
        assert_eq!(
            with(links(strings(101, |i| format!("a{i}.example")))),
            ["conditions.0.allow"]
        );
        assert_eq!(
            with(links(vec!["not a domain".into()])),
            ["conditions.0.allow.0"]
        );
        assert_eq!(
            with(Condition::HasRole { roles: vec![] }),
            ["conditions.0.roles"]
        );
        assert_eq!(
            with(Condition::HasRole {
                roles: (0..21).collect()
            }),
            ["conditions.0.roles"]
        );
        assert_eq!(with(Condition::HasPerm { perm: KICK }), [] as [&str; 0]);
        assert_eq!(
            with(Condition::HasPerm { perm: KICK | 1 }),
            ["conditions.0.perm"]
        );
        assert_eq!(
            with(Condition::HasPerm { perm: 65536 }),
            ["conditions.0.perm"]
        );
        assert_eq!(
            with(Condition::Caps {
                percent: 101,
                min_length: 10
            }),
            ["conditions.0.percent"]
        );
        assert_eq!(
            with(Condition::Chance { percent: 0 }),
            ["conditions.0.percent"]
        );
        let rate = |count, seconds| Condition::Rate {
            count,
            seconds,
            per: Per::Channel,
        };
        assert_eq!(with(rate(19, 3600)), [] as [&str; 0]);
        assert_eq!(with(rate(20, 5)), ["conditions.0.count"]);
        assert_eq!(with(rate(0, 5)), ["conditions.0.count"]);
        assert_eq!(with(rate(5, 3601)), ["conditions.0.seconds"]);
        let dup = |count, seconds| Condition::Duplicates { count, seconds };
        assert_eq!(with(dup(9, 30)), [] as [&str; 0]);
        assert_eq!(with(dup(10, 30)), ["conditions.0.count"]);
        assert_eq!(
            with(Condition::Mentions {
                over: 51,
                unique: false
            }),
            ["conditions.0.over"]
        );
        assert_eq!(
            with(Condition::Cooldown {
                seconds: 0,
                per: Per::Member
            }),
            ["conditions.0.seconds"]
        );
        assert_eq!(
            with(Condition::Counter {
                name: "Bad Name".into(),
                at_least: 1
            }),
            ["conditions.0.name"]
        );
        assert_eq!(
            with(Condition::AccountAge {
                minutes: Than::Under(1440)
            }),
            [] as [&str; 0]
        );
        assert_eq!(
            with(Condition::Channel {
                scope: Scope::Only((0..51).map(Ref::Channel).collect())
            }),
            ["conditions.0.scope"]
        );
    }

    #[test]
    fn triggers_have_their_limits() {
        let with = |t: Trigger| paths(&auto(t, vec![], vec![notify()]));
        let every = |minutes| Trigger::Schedule {
            schedule: Schedule {
                repeat: Repeat::Every { minutes },
                from: None,
                until: None,
            },
        };
        assert_eq!(with(every(10)), [] as [&str; 0]);
        assert_eq!(with(every(9)), ["trigger.schedule.minutes"]);
        let slow = Caps {
            schedule_min_minutes: 60,
            ..caps()
        };
        let a = auto(every(30), vec![], vec![notify()]);
        assert_eq!(
            validate(&a, &slow).expect_err("refused")[0].path,
            "trigger.schedule.minutes"
        );
        let command = |name: &str, args: Vec<Arg>| Trigger::Command {
            name: name.into(),
            description: "Thank someone".into(),
            args,
            channels: Scope::All,
        };
        let arg = |name: &str, kind: ArgKind| Arg {
            name: name.into(),
            required: true,
            kind,
        };
        assert_eq!(
            with(command(
                "thanks",
                vec![
                    arg("who", ArgKind::Member),
                    arg("note", ArgKind::Text { max: 200 }),
                    arg("where", ArgKind::Channel),
                    arg("n", ArgKind::Number { min: 1, max: 5 }),
                    arg(
                        "game",
                        ArgKind::Choice {
                            options: vec![ArgOption {
                                label: "Chess".into(),
                                role: Some(5)
                            }]
                        }
                    ),
                ]
            )),
            [] as [&str; 0]
        );
        assert_eq!(with(command("Thanks", vec![])), ["trigger.name"]);
        assert_eq!(with(command(&"a".repeat(33), vec![])), ["trigger.name"]);
        assert_eq!(
            with(command("x", vec![arg("who", ArgKind::Member); 6])),
            [
                "trigger.args",
                "trigger.args.1.name",
                "trigger.args.2.name",
                "trigger.args.3.name",
                "trigger.args.4.name",
                "trigger.args.5.name"
            ]
        );
        assert_eq!(
            with(command(
                "x",
                vec![arg("n", ArgKind::Number { min: 5, max: 1 })]
            )),
            ["trigger.args.0.min"]
        );
        assert_eq!(
            with(command(
                "x",
                vec![arg("c", ArgKind::Choice { options: vec![] })]
            )),
            ["trigger.args.0.options"]
        );
        assert_eq!(
            with(Trigger::JoinRate {
                joins: 10,
                seconds: 30
            }),
            [] as [&str; 0]
        );
        assert_eq!(
            with(Trigger::JoinRate {
                joins: 500,
                seconds: 30
            }),
            ["trigger.joins"]
        );
        assert_eq!(
            with(Trigger::CounterReached {
                counter: "xp".into(),
                value: 100,
                every: Some(0)
            }),
            ["trigger.every"]
        );
        assert_eq!(
            with(Trigger::FeedItem {
                url: "ftp://x".into()
            }),
            ["trigger.url"]
        );
        assert_eq!(
            with(Trigger::MessageSent {
                channels: Scope::Except((0..51).map(Ref::Category).collect()),
                edits: false,
                guard: false
            }),
            ["trigger.channels"]
        );
    }

    #[test]
    fn actions_have_their_limits() {
        let with = |k: ActionKind| paths(&auto(guard(), vec![], vec![k]));
        let block = |message: String| ActionKind::Block {
            message,
            report: false,
        };
        assert_eq!(with(block("m".repeat(150))), [] as [&str; 0]);
        assert_eq!(with(block("m".repeat(151))), ["actions.0.message"]);
        assert_eq!(
            with(ActionKind::Timeout { seconds: 2_419_200 }),
            [] as [&str; 0]
        );
        assert_eq!(
            with(ActionKind::Timeout { seconds: 2_419_201 }),
            ["actions.0.seconds"]
        );
        assert_eq!(
            with(ActionKind::Timeout { seconds: 0 }),
            ["actions.0.seconds"]
        );
        let ban = |purge_hours| ActionKind::Ban {
            purge_hours,
            then_unban: true,
        };
        assert_eq!(with(ban(168)), [] as [&str; 0]);
        assert_eq!(with(ban(169)), ["actions.0.purge_hours"]);
        assert_eq!(
            with(ActionKind::Notify {
                text: String::new()
            }),
            ["actions.0.text"]
        );
        assert_eq!(
            with(ActionKind::Notify {
                text: "t".repeat(4001)
            }),
            ["actions.0.text"]
        );
        let later = |k: ActionKind| {
            let mut a = auto(sent(), vec![], vec![k]);
            a.actions[0].after = 60;
            paths(&a)
        };
        assert_eq!(
            later(ActionKind::React {
                emojis: strings(3, |_| "👍".into())
            }),
            [] as [&str; 0]
        );
        assert_eq!(
            later(ActionKind::React {
                emojis: strings(4, |_| "👍".into())
            }),
            ["actions.0.emojis"]
        );
        assert_eq!(
            later(ActionKind::AddRole {
                role: 5.into(),
                for_seconds: 604_801
            }),
            ["actions.0.for_seconds"]
        );
        assert_eq!(
            later(ActionKind::CounterAdd {
                name: "xp".into(),
                amount: Amount::Random { min: 25, max: 15 },
                target: Target::Member
            }),
            ["actions.0.amount"]
        );
        assert_eq!(
            later(ActionKind::Slowmode {
                channel: Place::Here,
                seconds: 21_601,
                for_seconds: 0
            }),
            ["actions.0.seconds"]
        );
        assert_eq!(
            later(ActionKind::PauseJoins { minutes: 0 }),
            ["actions.0.minutes"]
        );
        assert_eq!(
            later(ActionKind::SendMessage {
                channel: Place::Here,
                text: String::new(),
                embed: None,
                components: vec![],
                ping: false
            }),
            ["actions.0.text"]
        );
        assert_eq!(
            later(ActionKind::StartThread {
                name: String::new()
            }),
            ["actions.0.name"]
        );
    }

    fn button(cid: &str) -> Component {
        Component::Button {
            cid: cid.into(),
            label: "Minecraft".into(),
            emoji: None,
            style: Default::default(),
            press: Press::Role { role: 5 },
        }
    }

    fn select(cid: &str, options: usize, min: u8, max: u8) -> Component {
        Component::Select {
            cid: cid.into(),
            placeholder: "Pick more".into(),
            min,
            max,
            options: (0..options)
                .map(|i| SelectOption {
                    value: format!("v{i}"),
                    label: format!("Option {i}"),
                    emoji: None,
                    description: String::new(),
                    role: Some(5),
                })
                .collect(),
        }
    }

    #[test]
    fn components_are_at_most_5_rows_of_5() {
        let with = |components: Vec<Vec<Component>>| {
            paths(&auto(
                sent(),
                vec![],
                vec![ActionKind::SendMessage {
                    channel: Place::Here,
                    text: String::new(),
                    embed: None,
                    components,
                    ping: false,
                }],
            ))
        };
        let row = |n: usize, at: usize| -> Vec<Component> {
            (0..n).map(|i| button(&format!("b{at}_{i}"))).collect()
        };
        let full: Vec<Vec<Component>> = (0..4)
            .map(|r| row(5, r))
            .chain([vec![select("s", 25, 0, 25)]])
            .collect();
        assert_eq!(with(full), [] as [&str; 0]);
        assert_eq!(
            with((0..6).map(|r| row(1, r)).collect()),
            ["actions.0.components"]
        );
        assert_eq!(with(vec![row(6, 0)]), ["actions.0.components.0"]);
        assert_eq!(with(vec![vec![]]), ["actions.0.components.0"]);
        assert_eq!(
            with(vec![vec![select("s", 2, 0, 1), button("b")]]),
            ["actions.0.components.0"]
        );
        assert_eq!(
            with(vec![vec![select("s", 26, 0, 1)]]),
            ["actions.0.components.0.0.options"]
        );
        assert_eq!(
            with(vec![vec![select("s", 0, 0, 1)]]),
            ["actions.0.components.0.0.options"]
        );
        assert_eq!(
            with(vec![vec![select("s", 3, 2, 1)]]),
            ["actions.0.components.0.0.max"]
        );
        assert_eq!(
            with(vec![vec![select("s", 3, 0, 4)]]),
            ["actions.0.components.0.0.max"]
        );
        assert_eq!(
            with(vec![vec![button("same")], vec![button("same")]]),
            ["actions.0.components.1.0.cid"]
        );
        assert_eq!(
            with(vec![vec![Component::Button {
                cid: "b".into(),
                label: String::new(),
                emoji: None,
                style: Default::default(),
                press: Press::Link {
                    url: "javascript:alert(1)".into()
                },
            }]]),
            [
                "actions.0.components.0.0.label",
                "actions.0.components.0.0.url"
            ]
        );
    }

    fn panel(mode: Mode, roles: Vec<PanelRole>) -> Automation {
        let mut a = auto(
            Trigger::Component {
                panel: "games".into(),
            },
            vec![],
            vec![ActionKind::PostPanel {
                channel: 3,
                text: "Pick the games you play.".into(),
            }],
        );
        a.kit = Some(Kit::RolePanel {
            mode,
            roles,
            style: PanelStyle::Buttons,
        });
        a
    }

    fn panel_role(role: i64, may_give: bool) -> PanelRole {
        PanelRole {
            role,
            label: format!("Role {role}"),
            emoji: None,
            may_give,
        }
    }

    fn refs() -> Refs {
        Refs {
            text_channels: [1, 2, 3].into(),
            voice_channels: [7].into(),
            categories: [9].into(),
            roles: [
                (5, 0),
                (6, MENTION_EVERYONE),
                (20, grants::MANAGE_ADMINS),
                (21, DELETE_SERVER),
                (22, MANAGE_AUTOMATIONS),
                (23, KICK),
            ]
            .into(),
            owner_bits: ALL_PERMS & !DELETE_SERVER,
            views: [1, 2, 3, 7].into(),
        }
    }

    #[test]
    fn panels_refuse_roles_that_give_permissions() {
        let ok = panel(
            Mode::Toggle,
            vec![panel_role(5, false), panel_role(6, false)],
        );
        assert!(validate(&ok, &caps()).is_ok());
        assert_eq!(check_refs(&ok, &refs()), []);
        let creator = Refs {
            owner_bits: ALL_PERMS,
            ..refs()
        };
        for role in [20, 21, 22, 23] {
            let a = panel(
                Mode::Toggle,
                vec![panel_role(5, false), panel_role(role, false)],
            );
            let out = check_refs(&a, &creator);
            assert_eq!(out.len(), 1, "{role}");
            assert_eq!(out[0].path, "kit.roles.1.role");
            assert_eq!(out[0].reason, Reason::GivesPermissions);
        }
        let marked = panel(Mode::Toggle, vec![panel_role(23, true)]);
        assert_eq!(check_refs(&marked, &refs()), []);
        let above = panel(Mode::Toggle, vec![panel_role(21, true)]);
        assert_eq!(
            check_refs(&above, &refs())[0].reason,
            Reason::OwnerCantGrant
        );
        let unknown = panel(Mode::Toggle, vec![panel_role(99, false)]);
        assert_eq!(check_refs(&unknown, &refs())[0].reason, Reason::UnknownRole);
    }

    #[test]
    fn kits_have_their_limits_and_their_actions() {
        let twice = panel(
            Mode::Toggle,
            vec![panel_role(5, false), panel_role(5, false)],
        );
        assert_eq!(paths(&twice), ["kit.roles.1.role"]);
        assert_eq!(paths(&panel(Mode::Toggle, vec![])), ["kit.roles"]);
        let many = panel(
            Mode::Toggle,
            (0..26).map(|r| panel_role(r, false)).collect(),
        );
        assert_eq!(paths(&many), ["kit.roles"]);
        assert_eq!(
            paths(&panel(Mode::Limit { n: 0 }, vec![panel_role(5, false)])),
            ["kit.mode.n"]
        );
        let mut no_kit = panel(Mode::Toggle, vec![panel_role(5, false)]);
        no_kit.kit = None;
        assert_eq!(paths(&no_kit), ["actions.0"]);
        let mut wrong = panel(Mode::Toggle, vec![panel_role(5, false)]);
        wrong.actions[0].kind = ActionKind::OpenTicket;
        assert_eq!(paths(&wrong), ["actions.0"]);
        let mut tickets = auto(
            Trigger::Component {
                panel: "tickets".into(),
            },
            vec![],
            vec![ActionKind::OpenTicket],
        );
        tickets.kit = Some(Kit::Tickets {
            category: 9,
            staff_roles: vec![20],
            name: "ticket-{count}".into(),
            max_open_per_member: 3,
            intro: "A moderator will be with you soon.".into(),
            close_after_days: 30,
        });
        assert_eq!(paths(&tickets), [] as [&str; 0]);
        assert_eq!(check_refs(&tickets, &refs()), []);
        if let Some(Kit::Tickets {
            max_open_per_member,
            ..
        }) = &mut tickets.kit
        {
            *max_open_per_member = 51;
        }
        assert_eq!(paths(&tickets), ["kit.max_open_per_member"]);
    }

    #[test]
    fn giveaway_requirements_are_conditions_with_their_limits() {
        let giveaway = |requirements: Vec<Condition>| {
            let mut a = auto(
                Trigger::Component {
                    panel: "giveaway".into(),
                },
                vec![Condition::Keywords {
                    list: vec!["free".into()],
                    allow: vec![],
                    profanity_preset: false,
                }],
                vec![ActionKind::PostGiveaway],
            );
            a.kit = Some(Kit::Giveaway {
                prize: "A game".into(),
                winners: 1,
                ends_at: 0,
                requirements,
                channel: 3,
            });
            a
        };
        let ok = giveaway(vec![
            Condition::HasRole { roles: vec![5] },
            Condition::Name {
                list: vec!["nitro".into()],
            },
        ]);
        let c = validate(&ok, &caps()).expect("valid");
        assert!(c.keywords(0).is_some());
        assert!(c.keywords(2).is_some());
        assert_eq!(check_refs(&ok, &refs()), []);
        let bad = giveaway(vec![
            Condition::Regex {
                patterns: vec!["(unclosed".into()],
            },
            Condition::Chance { percent: 0 },
            Condition::Name {
                list: strings(1001, |i| format!("w{i}")),
            },
            Condition::Not {
                of: Box::new(Condition::Any {
                    of: vec![Condition::IsStaff],
                }),
            },
            Condition::HasRole { roles: vec![] },
        ]);
        assert_eq!(
            paths(&bad),
            [
                "kit.requirements.0.patterns.0",
                "kit.requirements.1.percent",
                "kit.requirements.2.list",
                "kit.requirements.3.of",
                "kit.requirements.4.roles",
            ]
        );
        let unknown = giveaway(vec![Condition::Any {
            of: vec![
                Condition::HasRole { roles: vec![999] },
                Condition::Channel {
                    scope: Scope::Only(vec![Ref::Channel(50)]),
                },
            ],
        }]);
        let out: Vec<String> = check_refs(&unknown, &refs())
            .into_iter()
            .map(|p| p.path)
            .collect();
        assert_eq!(
            out,
            [
                "kit.requirements.0.of.0.roles.0",
                "kit.requirements.0.of.1.scope.0"
            ]
        );
    }

    #[test]
    fn a_counter_targets_the_member_or_a_member_argument() {
        let counter = |trigger: Trigger, target: &str| {
            auto(
                trigger,
                vec![],
                vec![
                    ActionKind::CounterAdd {
                        name: "rep".into(),
                        amount: Amount::Fixed(1),
                        target: Target::Arg(target.into()),
                    },
                    ActionKind::CounterSet {
                        name: "rep".into(),
                        value: 0,
                        target: Target::Arg(target.into()),
                    },
                ],
            )
        };
        let thanks = Trigger::Command {
            name: "thanks".into(),
            description: String::new(),
            args: vec![
                Arg {
                    name: "who".into(),
                    required: true,
                    kind: ArgKind::Member,
                },
                Arg {
                    name: "note".into(),
                    required: false,
                    kind: ArgKind::Text { max: 100 },
                },
            ],
            channels: Scope::All,
        };
        assert_eq!(paths(&counter(thanks.clone(), "who")), [] as [&str; 0]);
        for name in ["note", "nope"] {
            assert_eq!(
                paths(&counter(thanks.clone(), name)),
                ["actions.0.target", "actions.1.target"],
                "{name}"
            );
        }
        assert_eq!(
            paths(&counter(sent(), "nope")),
            ["actions.0.target", "actions.1.target"]
        );
    }

    #[test]
    fn every_reference_is_checked_against_the_server() {
        let a = auto(
            Trigger::MessageSent {
                channels: Scope::Only(vec![Ref::Channel(1), Ref::Category(9), Ref::Channel(50)]),
                edits: false,
                guard: false,
            },
            vec![
                Condition::HasRole { roles: vec![5, 77] },
                Condition::Any {
                    of: vec![Condition::Channel {
                        scope: Scope::Except(vec![Ref::Category(1)]),
                    }],
                },
            ],
            vec![
                ActionKind::AddRole {
                    role: 20.into(),
                    for_seconds: 0,
                },
                ActionKind::ToggleRole { role: 21.into() },
                ActionKind::Log {
                    channel: 7,
                    content: Default::default(),
                },
                ActionKind::SendMessage {
                    channel: Place::Channel(2),
                    text: "Hi".into(),
                    embed: None,
                    components: vec![vec![Component::Button {
                        cid: "j".into(),
                        label: "Go".into(),
                        emoji: None,
                        style: Default::default(),
                        press: Press::Jump { channel: 44 },
                    }]],
                    ping: false,
                },
            ],
        );
        assert!(validate(&a, &caps()).is_ok());
        let out: Vec<(String, Reason)> = check_refs(&a, &refs())
            .into_iter()
            .map(|p| (p.path, p.reason))
            .collect();
        assert_eq!(
            out,
            [
                ("trigger.channels.2".to_string(), Reason::UnknownChannel),
                ("conditions.0.roles.1".to_string(), Reason::UnknownRole),
                (
                    "conditions.1.of.0.scope.0".to_string(),
                    Reason::UnknownChannel
                ),
                ("actions.0.role".to_string(), Reason::GivesPermissions),
                ("actions.1.role".to_string(), Reason::OwnerCantGrant),
                ("actions.2.channel".to_string(), Reason::UnknownChannel),
                (
                    "actions.3.components.0.0.channel".to_string(),
                    Reason::UnknownChannel
                ),
            ]
        );
        let c = validate(&a, &caps()).expect("valid");
        assert_eq!(c.roles, [20, 21]);
    }

    #[test]
    fn roles_members_give_themselves_pass_the_self_service_rule() {
        let creator = Refs {
            owner_bits: ALL_PERMS,
            ..refs()
        };
        let add = |role: i64| ActionKind::AddRole {
            role: role.into(),
            for_seconds: 0,
        };
        let toggle = |role: i64| ActionKind::ToggleRole { role: role.into() };
        let remove = |role: i64| ActionKind::RemoveRole { role: role.into() };
        let (members, owners): (Vec<Trigger>, Vec<Trigger>) = triggers()
            .into_iter()
            .partition(|t| t.fired() != Fired::Owner);
        assert_eq!(members.len(), 14);
        for trigger in members {
            let name = trigger.name();
            let a = auto(
                trigger,
                vec![],
                vec![add(23), toggle(20), remove(22), add(6)],
            );
            let c = validate(&a, &caps()).expect(name);
            assert_eq!(c.self_served, [23, 20, 6], "{name}");
            let out: Vec<(String, Reason)> = check_refs(&a, &creator)
                .into_iter()
                .map(|p| (p.path, p.reason))
                .collect();
            assert_eq!(
                out,
                [
                    ("actions.0.role".to_string(), Reason::GivesPermissions),
                    ("actions.1.role".to_string(), Reason::GivesPermissions),
                ],
                "{name}"
            );
            let above = auto(a.trigger.clone(), vec![], vec![add(21)]);
            assert_eq!(
                check_refs(&above, &refs())[0].reason,
                Reason::OwnerCantGrant,
                "{name}"
            );
        }
        let keyword = auto(
            sent(),
            vec![keywords(vec!["make me a mod".into()], vec![])],
            vec![add(23)],
        );
        assert_eq!(
            check_refs(&keyword, &creator)[0].reason,
            Reason::GivesPermissions
        );
        assert_eq!(owners.len(), 8);
        for trigger in owners {
            let name = trigger.name();
            let a = auto(trigger, vec![], vec![add(23), toggle(20)]);
            match a.trigger.has_member() {
                true => assert_eq!(
                    validate(&a, &caps()).expect(name).self_served,
                    [] as [i64; 0],
                    "{name}"
                ),
                false => assert!(validate(&a, &caps()).is_err(), "{name}"),
            }
            assert_eq!(check_refs(&a, &creator), [], "{name}");
            let above = auto(a.trigger.clone(), vec![], vec![add(21)]);
            assert_eq!(
                check_refs(&above, &refs())[0].reason,
                Reason::OwnerCantGrant,
                "{name}"
            );
        }
    }

    #[test]
    fn every_trigger_says_whose_act_it_answers_to() {
        let all = triggers();
        assert_eq!(all.iter().map(Trigger::name).collect::<Vec<_>>(), EVENTS);
        let fired: Vec<(&str, Fired)> = all
            .iter()
            .map(|t| {
                let c = validate(&auto(t.clone(), vec![], vec![notify()]), &caps()).expect("ok");
                assert_eq!(c.fired, t.fired(), "{}", t.name());
                (t.name(), c.fired)
            })
            .collect();
        use Fired::{Member, Mover, Owner};
        assert_eq!(
            fired,
            [
                ("message_sent", Member),
                ("message_edited", Member),
                ("message_deleted", Member),
                ("reaction_added", Member),
                ("reaction_removed", Member),
                ("member_joined", Member),
                ("member_admitted", Owner),
                ("member_left", Member),
                ("profile_updated", Member),
                ("role_added", Owner),
                ("role_removed", Owner),
                ("voice_joined", Member),
                ("voice_left", Member),
                ("schedule", Owner),
                ("command", Member),
                ("component", Member),
                ("counter_reached", Mover),
                ("join_rate", Owner),
                ("staff_action_rate", Owner),
                ("audit_entry", Owner),
                ("report_filed", Member),
                ("feed_item", Owner),
            ]
        );
        assert_eq!(guard().fired(), Member);
        assert_eq!(Trigger::MemberJoined { guard: true }.fired(), Member);
        assert_eq!(
            serde_json::to_string(&[Owner, Member, Mover]).expect("json"),
            r#"["owner","member","mover"]"#
        );
    }

    #[test]
    fn a_member_picks_a_role_only_by_choosing_it() {
        let chosen = || ActionKind::ToggleRole {
            role: RoleRef::Arg { arg: "role".into() },
        };
        let fixed = || ActionKind::ToggleRole { role: 6.into() };
        let command = |args: Vec<Arg>| Trigger::Command {
            name: "role".into(),
            description: String::new(),
            args,
            channels: Scope::All,
        };
        let choice = || Arg {
            name: "role".into(),
            required: true,
            kind: ArgKind::Choice {
                options: vec![ArgOption {
                    label: "Ping me".into(),
                    role: Some(6),
                }],
            },
        };
        let text = || Arg {
            name: "t".into(),
            required: true,
            kind: ArgKind::Text { max: 100 },
        };
        let on_one = |message: Option<i64>| {
            [
                Trigger::ReactionAdded {
                    message,
                    emojis: vec![],
                    channels: Scope::All,
                },
                Trigger::ReactionRemoved {
                    message,
                    emojis: vec![],
                    channels: Scope::All,
                },
            ]
        };
        let component = || Trigger::Component {
            panel: "games".into(),
        };
        let keywords = || Condition::Keywords {
            list: vec!["spam".into()],
            allow: vec![],
            profanity_preset: false,
        };
        let chance = || Condition::Chance { percent: 50 };
        let has_role = || Condition::HasRole { roles: vec![7] };
        let picks = |trigger: Trigger, conditions: Vec<Condition>, actions: Vec<ActionKind>| {
            let a = auto(trigger, conditions, actions);
            let c = validate(&a, &caps()).expect("valid");
            let each: Vec<bool> = a.actions.iter().map(|x| a.picks(&x.kind)).collect();
            assert_eq!(c.picks, each);
            c.picks
        };
        assert_eq!(
            picks(command(vec![choice()]), vec![], vec![chosen()]),
            [true]
        );
        assert_eq!(
            picks(command(vec![choice()]), vec![chance()], vec![chosen()]),
            [false]
        );
        assert_eq!(
            picks(
                command(vec![text(), choice()]),
                vec![keywords()],
                vec![chosen()]
            ),
            [false]
        );
        assert_eq!(picks(command(vec![]), vec![], vec![fixed()]), [false]);
        assert_eq!(
            picks(command(vec![text()]), vec![keywords()], vec![fixed()]),
            [false]
        );
        assert_eq!(
            picks(command(vec![]), vec![chance()], vec![fixed()]),
            [false]
        );
        assert_eq!(
            picks(command(vec![text()]), vec![], vec![notify(), fixed()]),
            [false, false]
        );
        assert_eq!(
            picks(
                command(vec![]),
                vec![],
                vec![ActionKind::RemoveRole { role: 7.into() }]
            ),
            [false]
        );
        for t in on_one(Some(44)).into_iter().chain([component()]) {
            let name = t.name();
            assert_eq!(picks(t.clone(), vec![], vec![fixed()]), [true], "{name}");
            assert_eq!(
                picks(t.clone(), vec![], vec![notify(), fixed()]),
                [false, true],
                "{name}"
            );
            assert_eq!(
                picks(
                    t.clone(),
                    vec![],
                    vec![ActionKind::AddRole {
                        role: 6.into(),
                        for_seconds: 0
                    }]
                ),
                [true],
                "{name}"
            );
            assert_eq!(
                picks(
                    t.clone(),
                    vec![],
                    vec![ActionKind::RemoveRole { role: 6.into() }]
                ),
                [true],
                "{name}"
            );
            assert_eq!(
                picks(t.clone(), vec![], vec![ActionKind::StripRoles]),
                [false],
                "{name}"
            );
            for gate in [chance(), has_role()] {
                assert_eq!(
                    picks(t.clone(), vec![gate], vec![fixed()]),
                    [false],
                    "{name}"
                );
            }
        }
        let picking: Vec<&str> = triggers()
            .into_iter()
            .chain(on_one(Some(44)))
            .chain([guard(), Trigger::MemberJoined { guard: true }])
            .filter(|t| t.is_press())
            .map(|t| t.name())
            .collect();
        assert_eq!(picking, ["component", "reaction_added", "reaction_removed"]);
        assert!(on_one(None).iter().all(|t| !t.is_press()));
        for t in triggers() {
            let a = auto(t.clone(), vec![], vec![notify()]);
            assert!(!a.picks(&a.actions[0].kind), "{}", t.name());
        }
    }

    #[test]
    fn every_action_says_what_it_reaches() {
        let cases: Vec<(ActionKind, Reach)> = vec![
            (
                ActionKind::Block {
                    message: String::new(),
                    report: false,
                },
                Reach::Message,
            ),
            (ActionKind::DeleteMessage, Reach::Message),
            (ActionKind::Pin, Reach::Pin),
            (ActionKind::Timeout { seconds: 60 }, Reach::Member),
            (ActionKind::Kick, Reach::Member),
            (
                ActionKind::Ban {
                    purge_hours: 0,
                    then_unban: false,
                },
                Reach::Member,
            ),
            (
                ActionKind::Hold {
                    reason: String::new(),
                },
                Reach::Member,
            ),
            (
                ActionKind::Quarantine {
                    reason: String::new(),
                },
                Reach::Member,
            ),
            (ActionKind::StripRoles, Reach::Revoke),
            (ActionKind::RemoveRole { role: 5.into() }, Reach::Revoke),
            (
                ActionKind::AddRole {
                    role: 5.into(),
                    for_seconds: 0,
                },
                Reach::Grant,
            ),
            (ActionKind::ToggleRole { role: 5.into() }, Reach::Grant),
            (
                ActionKind::LockChannel {
                    channel: Place::Here,
                    for_seconds: 0,
                },
                Reach::Place,
            ),
            (
                ActionKind::UnlockChannel {
                    channel: Place::Here,
                },
                Reach::Place,
            ),
            (
                ActionKind::Slowmode {
                    channel: Place::Here,
                    seconds: 5,
                    for_seconds: 0,
                },
                Reach::Place,
            ),
            (
                ActionKind::RenameChannel {
                    channel: 2,
                    text: "x".into(),
                },
                Reach::Place,
            ),
            (
                ActionKind::DeleteOlder {
                    channel: 2,
                    age_seconds: 3600,
                },
                Reach::Place,
            ),
            (ActionKind::PauseJoins { minutes: 5 }, Reach::Place),
            (ActionKind::RequireApproval { minutes: 5 }, Reach::Place),
            (
                ActionKind::CounterAdd {
                    name: "rep".into(),
                    amount: Amount::Fixed(1),
                    target: Target::Arg("who".into()),
                },
                Reach::Own,
            ),
            (
                ActionKind::CounterSet {
                    name: "rep".into(),
                    value: 0,
                    target: Target::Member,
                },
                Reach::Own,
            ),
            (notify(), Reach::Own),
            (
                ActionKind::Reply {
                    text: "Hi".into(),
                    ping: false,
                },
                Reach::Own,
            ),
            (
                ActionKind::SendMessage {
                    channel: Place::Channel(2),
                    text: "Hi".into(),
                    embed: None,
                    components: vec![],
                    ping: false,
                },
                Reach::Own,
            ),
            (
                ActionKind::React {
                    emojis: vec!["👍".into()],
                },
                Reach::Own,
            ),
            (ActionKind::StartThread { name: "t".into() }, Reach::Own),
            (
                ActionKind::Log {
                    channel: 2,
                    content: LogContent::Metadata,
                },
                Reach::Own,
            ),
            (
                ActionKind::Alert {
                    channel: 2,
                    text: String::new(),
                },
                Reach::Own,
            ),
            (ActionKind::WebhookOut { hook: 1 }, Reach::Own),
            (
                ActionKind::Report {
                    reason: String::new(),
                    note: String::new(),
                },
                Reach::Own,
            ),
            (
                ActionKind::PostPanel {
                    channel: 2,
                    text: String::new(),
                },
                Reach::Own,
            ),
            (ActionKind::OpenTicket, Reach::Own),
            (ActionKind::CreateRoom, Reach::Own),
            (ActionKind::Repost, Reach::Own),
            (ActionKind::Sticky, Reach::Own),
            (ActionKind::PostGiveaway, Reach::Own),
        ];
        assert_eq!(cases.len(), 36);
        let names: BTreeSet<&str> = cases.iter().map(|(k, _)| k.name()).collect();
        assert_eq!(names.len(), 36);
        for (kind, reach) in &cases {
            assert_eq!(reach_of(kind), *reach, "{}", kind.name());
        }
        let a = auto(
            sent(),
            vec![],
            vec![
                ActionKind::Timeout { seconds: 60 },
                ActionKind::DeleteMessage,
                ActionKind::Pin,
                ActionKind::RemoveRole { role: 5.into() },
                ActionKind::ToggleRole { role: 5.into() },
                ActionKind::Slowmode {
                    channel: Place::Here,
                    seconds: 30,
                    for_seconds: 600,
                },
                notify(),
            ],
        );
        assert_eq!(
            validate(&a, &caps()).expect("valid").reach,
            [
                Reach::Member,
                Reach::Message,
                Reach::Pin,
                Reach::Revoke,
                Reach::Grant,
                Reach::Place,
                Reach::Own
            ]
        );
    }

    const CREATOR: u32 = ALL_PERMS & !DELETE_SERVER;

    fn compiled(body: serde_json::Value) -> Compiled {
        let a: Automation = serde_json::from_value(body).expect("body");
        validate(&a, &caps()).expect("valid")
    }

    /// A member who is in, with these bits.
    fn member(id: i64, bits: u32) -> Option<Actor> {
        Some(Actor {
            id,
            acting: bits,
            rank: bits,
        })
    }

    /// Whether the automation's one action runs as the creator's, for this actor and target.
    fn runs(c: &Compiled, actor: Option<Actor>, target: Option<(i64, u32)>) -> bool {
        assert_eq!(c.reach.len(), 1);
        let needs = c.action_needs[0].bits();
        may_run(c.reach[0], needs, CREATOR, actor, target, c.picks[0])
    }

    /// Whether the automation's one action, as `owner`'s, gives a role with these bits.
    fn gives(
        c: &Compiled,
        role_bits: u32,
        owner: u32,
        actor: Option<Actor>,
        target: Option<(i64, u32)>,
    ) -> bool {
        assert_eq!(c.reach, [Reach::Grant]);
        let reach = grant_of(role_bits, false, owner);
        may_run(
            reach,
            c.action_needs[0].bits(),
            owner,
            actor,
            target,
            c.picks[0],
        )
    }

    /// Whether the automation's one action, as `owner`'s, takes a role with these bits whose
    /// loss doesn't widen the member's access.
    fn takes(
        c: &Compiled,
        role_bits: u32,
        owner: u32,
        actor: Option<Actor>,
        target: Option<(i64, u32)>,
    ) -> bool {
        assert_eq!(c.reach.len(), 1);
        let reach = revoke_of(role_bits, owner, false);
        may_run(
            reach,
            c.action_needs[0].bits(),
            owner,
            actor,
            target,
            c.picks[0],
        )
    }

    #[test]
    fn a_post_a_member_sets_off_pings_everyone_only_with_their_own_bit() {
        let announce = compiled(serde_json::json!({
            "name": "A",
            "trigger": {"type": "command", "name": "announce", "description": "", "args": [{"name": "t", "required": true, "type": "text", "max": 100}], "channels": "all"},
            "actions": [{"aid": "a", "type": "send_message", "channel": {"channel": 7}, "text": "@everyone {args.t}", "ping": true}]
        }));
        let help = compiled(serde_json::json!({
            "name": "H",
            "trigger": {"type": "message_sent", "channels": "all"},
            "conditions": [{"type": "keywords", "list": ["help"]}],
            "actions": [{"aid": "a", "type": "reply", "text": "@here someone needs help", "ping": true}]
        }));
        for c in [&announce, &help] {
            assert_eq!(c.fired, Fired::Member);
            assert_eq!(c.reach, [Reach::Own]);
            assert_eq!(c.action_needs, [Needs(MENTION_EVERYONE)]);
            assert!(!runs(c, member(1, 0), None));
            assert!(!runs(c, member(1, KICK | DELETE_MESSAGES), None));
            assert!(runs(c, member(1, MENTION_EVERYONE), None));
        }
        let welcome = compiled(serde_json::json!({
            "name": "W",
            "trigger": {"type": "member_admitted"},
            "actions": [{"aid": "a", "type": "send_message", "channel": {"channel": 7}, "text": "@everyone welcome {member}", "ping": true}]
        }));
        assert_eq!(welcome.action_needs, [Needs(MENTION_EVERYONE)]);
        assert_eq!(actor(welcome.fired, Some(1), None), None);
        assert!(runs(&welcome, None, None));
        assert!(may_run(
            welcome.reach[0],
            MENTION_EVERYONE,
            MENTION_EVERYONE,
            None,
            None,
            welcome.picks[0]
        ));
        assert!(!may_run(
            welcome.reach[0],
            MENTION_EVERYONE,
            KICK,
            None,
            None,
            welcome.picks[0]
        ));
        let quiet = compiled(serde_json::json!({
            "name": "Q",
            "trigger": {"type": "message_sent", "channels": "all"},
            "actions": [{"aid": "a", "type": "reply", "text": "@here is not pinged, {member.mention} is", "ping": false}]
        }));
        assert_eq!(quiet.action_needs, [Needs(0)]);
        assert!(runs(&quiet, member(1, 0), None));
    }

    #[test]
    fn a_members_own_act_pins_and_takes_their_roles_only_within_their_rights() {
        let pin_reaction = compiled(serde_json::json!({
            "name": "P",
            "trigger": {"type": "reaction_added", "emojis": ["\u{1f4cc}"], "channels": {"only": [{"channel": 7}]}},
            "actions": [{"aid": "a", "type": "pin"}]
        }));
        assert_eq!(pin_reaction.reach, [Reach::Pin]);
        assert!(!runs(&pin_reaction, member(1, 0), Some((1, 0))));
        assert!(!runs(&pin_reaction, member(1, 0), Some((2, 0))));
        assert!(runs(
            &pin_reaction,
            member(1, DELETE_MESSAGES),
            Some((1, DELETE_MESSAGES))
        ));
        let pin_post = compiled(serde_json::json!({
            "name": "P",
            "trigger": {"type": "message_sent", "channels": {"only": [{"channel": 7}]}},
            "conditions": [{"type": "keywords", "list": ["*pin*"]}],
            "actions": [{"aid": "a", "type": "pin"}]
        }));
        assert!(!runs(&pin_post, member(1, 0), Some((1, 0))));
        let strip = compiled(serde_json::json!({
            "name": "S",
            "trigger": {"type": "message_sent", "channels": "all"},
            "conditions": [{"type": "keywords", "list": ["bad"]}],
            "actions": [{"aid": "a", "type": "strip_roles"}]
        }));
        let unreact = compiled(serde_json::json!({
            "name": "R",
            "trigger": {"type": "reaction_removed", "emojis": ["x"], "channels": "all"},
            "actions": [{"aid": "a", "type": "remove_role", "role": 6}]
        }));
        for c in [&strip, &unreact] {
            assert_eq!(c.reach, [Reach::Revoke]);
            assert_eq!(c.action_needs, [Needs(ASSIGN_ROLES)]);
            assert!(!runs(c, member(1, 0), Some((1, 0))));
            assert!(runs(c, member(1, ASSIGN_ROLES), Some((1, ASSIGN_ROLES))));
            let taken = |role_bits: u32, widens: bool| {
                may_run(
                    revoke_of(role_bits, CREATOR, widens),
                    c.action_needs[0].bits(),
                    CREATOR,
                    member(1, 0),
                    Some((1, 0)),
                    c.picks[0],
                )
            };
            assert!(taken(0, false));
            assert!(taken(MENTION_EVERYONE, false));
            assert!(!taken(0, true));
            assert!(!taken(KICK, false));
        }
    }

    #[test]
    fn a_role_for_another_member_needs_the_rights_of_the_member_who_acted() {
        let strike: Automation = serde_json::from_value(serde_json::json!({
            "name": "S",
            "trigger": {"type": "command", "name": "strike", "description": "", "args": [{"name": "who", "required": true, "type": "member"}], "channels": "all"},
            "actions": [{"aid": "a", "type": "counter_add", "name": "strikes", "amount": {"fixed": 1}, "target": {"arg": "who"}}]
        }))
        .expect("body");
        let mute: Automation = serde_json::from_value(serde_json::json!({
            "name": "M",
            "trigger": {"type": "counter_reached", "counter": "strikes", "value": 3},
            "actions": [{"aid": "a", "type": "add_role", "role": 5, "for_seconds": 0}]
        }))
        .expect("body");
        assert_eq!(check_refs(&strike, &refs()), []);
        assert_eq!(check_refs(&mute, &refs()), []);
        assert_eq!(
            validate(&strike, &caps()).expect("valid").reach,
            [Reach::Own]
        );
        let mute = validate(&mute, &caps()).expect("valid");
        assert_eq!(mute.fired, Fired::Mover);
        assert_eq!(mute.reach, [Reach::Grant]);
        assert_eq!(mute.self_served, [5]);
        let raiser = actor(mute.fired, None, Some(Some(1)));
        assert_eq!(raiser, Some(1));
        assert!(!gives(&mute, 0, CREATOR, member(1, 0), Some((2, 0))));
        assert!(gives(
            &mute,
            0,
            CREATOR,
            member(1, ASSIGN_ROLES),
            Some((2, 0))
        ));
        assert!(gives(&mute, 0, CREATOR, member(2, 0), Some((2, 0))));
        let timeout = compiled(serde_json::json!({
            "name": "T",
            "trigger": {"type": "counter_reached", "counter": "strikes", "value": 3},
            "actions": [{"aid": "a", "type": "timeout", "seconds": 86400}]
        }));
        assert!(!runs(&timeout, member(1, 0), Some((2, 0))));
        let report = compiled(serde_json::json!({
            "name": "R",
            "trigger": {"type": "report_filed"},
            "actions": [{"aid": "a", "type": "add_role", "role": 5, "for_seconds": 0}]
        }));
        assert_eq!(report.fired, Fired::Member);
        assert!(!gives(&report, 0, CREATOR, member(1, 0), Some((2, 0))));
        assert!(!gives(
            &mute,
            0,
            KICK | ASSIGN_ROLES,
            None,
            Some((2, CREATOR))
        ));
        assert!(gives(&mute, 0, CREATOR, None, Some((2, 0))));
        let pressed = compiled(serde_json::json!({
            "name": "G",
            "trigger": {"type": "command", "name": "role", "description": "", "args": [], "channels": "all"},
            "actions": [{"aid": "a", "type": "toggle_role", "role": 5}]
        }));
        assert!(gives(&pressed, 0, CREATOR, member(1, 0), Some((1, 0))));
    }

    #[test]
    fn a_role_change_on_the_member_skips_the_owners_rank_only_when_they_picked_it() {
        let owner = KICK | TIMEOUT_MEMBERS | DELETE_MESSAGES | ASSIGN_ROLES | MANAGE_AUTOMATIONS;
        let staff = member(3, CREATOR);
        let on_staff = Some((3, CREATOR));
        let below = member(1, 0);
        let on_below = Some((1, 0));
        let said = |action: serde_json::Value| {
            compiled(serde_json::json!({
                "name": "G",
                "trigger": {"type": "message_sent", "channels": "all"},
                "conditions": [{"type": "keywords", "list": ["spam"]}],
                "actions": [action]
            }))
        };
        let mute = said(
            serde_json::json!({"aid": "a", "type": "add_role", "role": 6, "for_seconds": 600}),
        );
        assert_eq!(mute.picks, [false]);
        assert!(!gives(&mute, 0, owner, staff, on_staff));
        assert!(gives(&mute, 0, owner, below, on_below));
        let unverify = said(serde_json::json!({"aid": "a", "type": "remove_role", "role": 7}));
        assert_eq!(revoke_of(0, owner, false), Reach::SelfRevoke);
        assert!(!takes(&unverify, 0, owner, staff, on_staff));
        assert!(takes(&unverify, 0, owner, below, on_below));
        let timeout = said(serde_json::json!({"aid": "a", "type": "timeout", "seconds": 600}));
        assert!(!may_run(
            timeout.reach[0],
            timeout.action_needs[0].bits(),
            owner,
            staff,
            on_staff,
            timeout.picks[0]
        ));
        let unpicked = [
            serde_json::json!({"type": "profile_updated"}),
            serde_json::json!({"type": "voice_joined", "channels": "all"}),
            serde_json::json!({"type": "member_joined"}),
            serde_json::json!({"type": "reaction_added", "emojis": ["x"], "channels": "all"}),
            serde_json::json!({"type": "counter_reached", "counter": "xp", "value": 100}),
        ];
        for trigger in unpicked {
            let c = compiled(serde_json::json!({
                "name": "M",
                "trigger": trigger,
                "actions": [{"aid": "a", "type": "add_role", "role": 6, "for_seconds": 0}]
            }));
            assert_eq!(c.picks, [false], "{trigger}");
            assert!(!gives(&c, 0, owner, staff, on_staff), "{trigger}");
            assert!(gives(&c, 0, owner, below, on_below), "{trigger}");
        }
        assert!(!gives(&mute, 0, owner, None, on_staff));
        let say = serde_json::json!({"type": "command", "name": "say", "description": "", "args": [{"name": "t", "required": true, "type": "text", "max": 100}], "channels": "all"});
        let gamble = serde_json::json!({"type": "command", "name": "gamble", "description": "", "args": [], "channels": "all"});
        let press = serde_json::json!({"type": "component", "panel": "roles"});
        let mute_role =
            serde_json::json!({"aid": "m", "type": "add_role", "role": 6, "for_seconds": 600});
        let post = serde_json::json!({"aid": "p", "type": "send_message", "channel": {"channel": 7}, "text": "{args.t}"});
        let say_choosing = serde_json::json!({"type": "command", "name": "say", "description": "", "args": [{"name": "t", "required": true, "type": "text", "max": 100}, {"name": "r", "required": true, "type": "choice", "options": [{"label": "Mute", "role": 6}]}], "channels": "all"});
        let unchosen = [
            (
                say_choosing,
                serde_json::json!([{"type": "keywords", "list": ["spam"]}]),
                serde_json::json!([{"aid": "m", "type": "add_role", "role": {"arg": "r"}, "for_seconds": 600}]),
            ),
            (
                say.clone(),
                serde_json::json!([{"type": "keywords", "list": ["spam"]}]),
                serde_json::json!([mute_role]),
            ),
            (
                gamble.clone(),
                serde_json::json!([{"type": "chance", "percent": 50}]),
                serde_json::json!([mute_role]),
            ),
            (
                say.clone(),
                serde_json::json!([]),
                serde_json::json!([post, mute_role]),
            ),
            (
                gamble.clone(),
                serde_json::json!([]),
                serde_json::json!([{"aid": "u", "type": "remove_role", "role": 7}]),
            ),
            (
                press.clone(),
                serde_json::json!([]),
                serde_json::json!([{"aid": "s", "type": "strip_roles"}]),
            ),
            (
                press.clone(),
                serde_json::json!([{"type": "chance", "percent": 50}]),
                serde_json::json!([mute_role]),
            ),
        ];
        for (trigger, conditions, actions) in unchosen {
            let c = compiled(serde_json::json!({
                "name": "C",
                "trigger": trigger,
                "conditions": conditions,
                "actions": actions
            }));
            let last = c.reach.len() - 1;
            assert!(!c.picks[last], "{actions}");
            let change = |actor: Option<Actor>, target: Option<(i64, u32)>| {
                let reach = match c.reach[last] {
                    Reach::Grant => grant_of(0, false, owner),
                    _ => revoke_of(0, owner, false),
                };
                may_run(
                    reach,
                    c.action_needs[last].bits(),
                    owner,
                    actor,
                    target,
                    c.picks[last],
                )
            };
            assert!(!change(staff, on_staff), "{actions}");
            assert!(change(below, on_below), "{actions}");
        }
        let picked = [
            (
                serde_json::json!({"type": "command", "name": "role", "description": "", "args": [{"name": "role", "required": true, "type": "choice", "options": [{"label": "Ping me", "role": 6}]}], "channels": "all"}),
                serde_json::json!({"arg": "role"}),
            ),
            (press, serde_json::json!(6)),
            (
                serde_json::json!({"type": "reaction_added", "message": 44, "emojis": ["x"]}),
                serde_json::json!(6),
            ),
            (
                serde_json::json!({"type": "reaction_removed", "message": 44, "emojis": ["x"]}),
                serde_json::json!(6),
            ),
        ];
        for (trigger, role) in picked {
            let c = compiled(serde_json::json!({
                "name": "P",
                "trigger": trigger,
                "actions": [{"aid": "a", "type": "toggle_role", "role": role}]
            }));
            assert_eq!(c.picks, [true], "{trigger}");
            assert!(gives(&c, 0, owner, staff, on_staff), "{trigger}");
            assert!(takes(&c, 0, owner, staff, on_staff), "{trigger}");
            assert!(gives(&c, 0, owner, below, on_below), "{trigger}");
            assert!(
                !gives(&c, 0, owner, member(4, ALL_PERMS), on_staff),
                "{trigger}"
            );
            assert!(!takes(&c, KICK, owner, staff, on_staff), "{trigger}");
        }
        for trigger in [
            serde_json::json!({"type": "component", "panel": "roles"}),
            serde_json::json!({"type": "reaction_removed", "message": 44, "emojis": ["x"]}),
        ] {
            let c = compiled(serde_json::json!({
                "name": "R",
                "trigger": trigger,
                "actions": [{"aid": "a", "type": "remove_role", "role": 6}]
            }));
            assert_eq!(c.picks, [true], "{trigger}");
            assert!(takes(&c, 0, owner, staff, on_staff), "{trigger}");
            assert!(takes(&c, 0, owner, below, on_below), "{trigger}");
            assert!(!takes(&c, KICK, owner, staff, on_staff), "{trigger}");
        }
    }

    #[test]
    fn a_role_given_in_a_run_that_answers_to_a_member_is_self_service_whatever_the_trigger() {
        let server = Refs {
            roles: [(5, MENTION_EVERYONE), (9, KICK | DELETE_MESSAGES), (6, 0)].into(),
            owner_bits: CREATOR,
            ..refs()
        };
        let pick: Automation = serde_json::from_value(serde_json::json!({
            "name": "Pick",
            "trigger": {"type": "command", "name": "role", "description": "", "args": [{"name": "role", "required": true, "type": "choice", "options": [{"label": "Ping me", "role": 5}]}], "channels": "all"},
            "actions": [{"aid": "a", "type": "toggle_role", "role": {"arg": "role"}}]
        }))
        .expect("body");
        let bundle: Automation = serde_json::from_value(serde_json::json!({
            "name": "Bundle",
            "trigger": {"type": "role_added", "roles": [5]},
            "actions": [{"aid": "a", "type": "add_role", "role": 9, "for_seconds": 0}]
        }))
        .expect("body");
        assert_eq!(check_refs(&pick, &server), []);
        assert_eq!(check_refs(&bundle, &server), []);
        let pick = validate(&pick, &caps()).expect("valid");
        let bundle = validate(&bundle, &caps()).expect("valid");
        assert_eq!(pick.self_served, [5]);
        assert_eq!((bundle.fired, bundle.picks[0]), (Fired::Owner, false));
        assert_eq!(bundle.self_served, [] as [i64; 0]);
        assert!(gives(
            &pick,
            MENTION_EVERYONE,
            CREATOR,
            member(1, 0),
            Some((1, 0))
        ));
        let helper = KICK | DELETE_MESSAGES;
        let picker = actor(bundle.fired, None, Some(Some(1))).and_then(|id| member(id, 0));
        assert_eq!(picker, member(1, 0));
        let holds_ping = Some((1, MENTION_EVERYONE));
        assert!(!gives(&bundle, helper, CREATOR, picker, holds_ping));
        assert!(!runs(&bundle, picker, holds_ping));
        assert!(gives(&bundle, 0, CREATOR, picker, holds_ping));
        let staff = member(1, ALL_PERMS);
        assert!(!gives(&bundle, helper, CREATOR, staff, Some((2, 0))));
        let by_hand = actor(bundle.fired, Some(1), None);
        assert_eq!(by_hand, None);
        assert!(gives(
            &bundle,
            helper,
            CREATOR,
            None,
            Some((2, MENTION_EVERYONE))
        ));
        assert!(runs(&bundle, None, Some((2, MENTION_EVERYONE))));
        let level = compiled(serde_json::json!({
            "name": "L",
            "trigger": {"type": "counter_reached", "counter": "xp", "value": 100},
            "actions": [{"aid": "a", "type": "add_role", "role": 6, "for_seconds": 0}]
        }));
        let mover = actor(level.fired, Some(1), None).and_then(|id| member(id, 0));
        assert!(gives(&level, 0, CREATOR, mover, Some((1, 0))));
        assert!(!gives(&level, helper, CREATOR, mover, Some((1, 0))));
    }

    #[test]
    fn a_guard_blocks_an_automations_post_that_a_members_command_made() {
        let say = compiled(serde_json::json!({
            "name": "Say",
            "trigger": {"type": "command", "name": "say", "description": "", "args": [{"name": "t", "required": true, "type": "text", "max": 100}], "channels": "all"},
            "actions": [{"aid": "a", "type": "send_message", "channel": {"channel": 7}, "text": "{args.t}"}]
        }));
        assert!(runs(&say, member(1, 0), None));
        let words = |action: &str, guard: bool| {
            compiled(serde_json::json!({
                "name": "Words",
                "trigger": {"type": "message_sent", "channels": "all", "guard": guard},
                "options": {"react_to_automations": true},
                "conditions": [{"type": "keywords", "list": ["badword"]}],
                "actions": [{"aid": "a", "type": action}]
            }))
        };
        for c in [words("block", true), words("delete_message", false)] {
            assert_eq!(c.reach, [Reach::Message]);
            let commanded = Some(Some(1));
            let answers = actor(c.fired, None, commanded).and_then(|id| member(id, 0));
            assert_eq!(answers, member(1, 0));
            let posted = |caused| author(Reach::Message, Poster::Automation, caused);
            assert_eq!(posted(commanded), Some(1));
            let wrote = |rank: u32| posted(commanded).map(|id| (id, rank));
            assert!(runs(&c, answers, wrote(0)));
            assert!(!runs(&c, answers, None));
            assert!(!runs(&c, member(1, ALL_PERMS), wrote(ALL_PERMS)));
            assert!(runs(
                &c,
                member(1, 0),
                author(Reach::Message, Poster::Member(1), None).map(|id| (id, 0))
            ));
            let scheduled = Some(None);
            assert_eq!(actor(c.fired, None, scheduled), None);
            assert_eq!(posted(scheduled), None);
            assert!(runs(&c, None, None));
        }
    }

    #[test]
    fn a_guard_punishes_no_member_for_an_automations_post() {
        let preset = |id: &str| {
            let p = crate::presets::gallery()
                .iter()
                .find(|p| p.id == id)
                .expect("preset");
            validate(&p.automations[0], &caps()).expect("valid")
        };
        let starboard = preset("starboard");
        let leave = preset("leave");
        for c in [&starboard, &leave] {
            assert_eq!(
                (c.fired, c.reach.as_slice()),
                (Fired::Member, &[Reach::Own][..])
            );
        }
        let guard = |trigger: serde_json::Value, action: serde_json::Value| {
            compiled(serde_json::json!({
                "name": "Words",
                "trigger": trigger,
                "options": {"react_to_automations": true},
                "conditions": [{"type": "keywords", "list": ["badword"]}],
                "actions": [action]
            }))
        };
        let reaction = serde_json::json!({"type": "message_sent", "channels": "all"});
        let in_send = serde_json::json!({"type": "message_sent", "channels": "all", "guard": true});
        let punishments = [
            serde_json::json!({"aid": "a", "type": "timeout", "seconds": 600}),
            serde_json::json!({"aid": "a", "type": "kick"}),
            serde_json::json!({"aid": "a", "type": "ban"}),
            serde_json::json!({"aid": "a", "type": "hold"}),
            serde_json::json!({"aid": "a", "type": "add_role", "role": 6, "for_seconds": 600}),
            serde_json::json!({"aid": "a", "type": "remove_role", "role": 7}),
            serde_json::json!({"aid": "a", "type": "strip_roles"}),
        ]
        .map(|action| guard(reaction.clone(), action));
        let takedowns = [
            guard(in_send, serde_json::json!({"aid": "a", "type": "block"})),
            guard(
                reaction,
                serde_json::json!({"aid": "a", "type": "delete_message"}),
            ),
        ];
        let moderator = KICK | TIMEOUT_MEMBERS | DELETE_MESSAGES | MENTION_EVERYONE;
        let starred = Some(Some(1));
        let banned = Some(Some(3));
        for (caused, bits) in [(starred, 0), (starred, moderator), (banned, moderator)] {
            for c in &punishments {
                let answers = actor(c.fired, None, caused).and_then(|id| member(id, bits));
                assert_eq!(answers.map(|a| a.id), caused.flatten());
                let reach = match c.reach[0] {
                    Reach::Grant => grant_of(0, false, CREATOR),
                    Reach::Revoke => revoke_of(0, CREATOR, false),
                    reach => reach,
                };
                let target = author(reach, Poster::Automation, caused).map(|id| (id, bits));
                assert_eq!(target, None, "{:?}", c.reach);
                assert!(
                    !may_run(
                        reach,
                        c.action_needs[0].bits(),
                        CREATOR,
                        answers,
                        target,
                        c.picks[0]
                    ),
                    "{:?}",
                    c.reach
                );
            }
            for c in &takedowns {
                let answers = actor(c.fired, None, caused).and_then(|id| member(id, bits));
                let wrote = author(Reach::Message, Poster::Automation, caused).map(|id| (id, bits));
                assert_eq!(wrote.map(|(id, _)| id), caused.flatten());
                assert!(runs(c, answers, wrote));
            }
        }
    }

    #[test]
    fn a_guard_blocks_a_webhooks_post_that_continues_a_members_chain() {
        let echoed = Some(Some(1));
        let filters = [
            "word_filter",
            "link_filter",
            "invite_filter",
            "spam_filter",
            "honeypot",
        ];
        for id in filters {
            let p = crate::presets::gallery()
                .iter()
                .find(|p| p.id == id)
                .expect("preset");
            let c = validate(&p.automations[0], &caps()).expect("valid");
            assert_eq!(
                (c.fired, c.reach[0]),
                (Fired::Member, Reach::Message),
                "{id}"
            );
            for (i, reach) in c.reach.iter().enumerate() {
                for (caused, bits) in [
                    (echoed, 0),
                    (echoed, DELETE_MESSAGES),
                    (Some(None), 0),
                    (None, 0),
                ] {
                    let answers = actor(c.fired, None, caused).and_then(|id| member(id, bits));
                    let target = author(*reach, Poster::Webhook, caused).map(|id| (id, bits));
                    let done = may_run(
                        *reach,
                        c.action_needs[i].bits(),
                        CREATOR,
                        answers,
                        target,
                        c.picks[i],
                    );
                    match reach {
                        Reach::Message => assert!(done, "{id} {caused:?} {bits}"),
                        Reach::Member => assert!(!done, "{id} {caused:?} {bits}"),
                        _ => {}
                    }
                }
            }
        }
        let words = |trigger: serde_json::Value, action: serde_json::Value| {
            compiled(serde_json::json!({
                "name": "Words",
                "trigger": trigger,
                "conditions": [{"type": "keywords", "list": ["badword"]}],
                "actions": [action]
            }))
        };
        let in_send = serde_json::json!({"type": "message_sent", "channels": "all", "guard": true});
        let reaction = serde_json::json!({"type": "message_sent", "channels": "all"});
        let takedowns = [
            words(in_send, serde_json::json!({"aid": "a", "type": "block"})),
            words(
                reaction.clone(),
                serde_json::json!({"aid": "a", "type": "delete_message"}),
            ),
        ];
        let answers = actor(Fired::Member, None, echoed).and_then(|id| member(id, 0));
        assert_eq!(answers, member(1, 0));
        let posted = |caused| author(Reach::Message, Poster::Webhook, caused);
        assert_eq!(
            posted(echoed),
            author(Reach::Message, Poster::Automation, echoed)
        );
        for c in &takedowns {
            assert_eq!(c.reach, [Reach::Message]);
            assert!(runs(c, answers, posted(echoed).map(|id| (id, 0))));
            assert!(!runs(
                c,
                member(1, ALL_PERMS),
                posted(echoed).map(|id| (id, ALL_PERMS))
            ));
            assert!(runs(c, None, posted(Some(None)).map(|id| (id, 0))));
            assert!(runs(c, None, posted(None).map(|id| (id, 0))));
        }
        let timeout = words(
            reaction,
            serde_json::json!({"aid": "a", "type": "timeout", "seconds": 600}),
        );
        assert_eq!(timeout.reach, [Reach::Member]);
        let target = author(Reach::Member, Poster::Webhook, echoed).map(|id| (id, 0));
        assert_eq!(target, None);
        assert!(!runs(&timeout, answers, target));
        assert!(!runs(&timeout, None, target));
    }

    #[test]
    fn member_and_role_actions_need_a_trigger_with_a_member() {
        let on_member = [
            ActionKind::Timeout { seconds: 600 },
            ActionKind::Kick,
            ActionKind::Ban {
                purge_hours: 0,
                then_unban: false,
            },
            ActionKind::Hold {
                reason: String::new(),
            },
            ActionKind::Quarantine {
                reason: String::new(),
            },
            ActionKind::StripRoles,
            ActionKind::AddRole {
                role: 6.into(),
                for_seconds: 0,
            },
            ActionKind::RemoveRole { role: 6.into() },
            ActionKind::ToggleRole { role: 6.into() },
        ];
        let mut without = vec![];
        for trigger in triggers() {
            let name = trigger.name();
            for kind in &on_member {
                let out = paths(&auto(trigger.clone(), vec![], vec![kind.clone()]));
                assert!(out.is_empty() || out == ["actions.0"], "{name}: {out:?}");
                assert_eq!(out.is_empty(), trigger.has_member(), "{name}: {kind:?}");
            }
            if !trigger.has_member() {
                without.push(name);
                let pause = ActionKind::PauseJoins { minutes: 10 };
                assert_eq!(
                    paths(&auto(trigger.clone(), vec![], vec![pause])),
                    [] as [&str; 0]
                );
            }
        }
        assert_eq!(without, ["schedule", "join_rate", "feed_item"]);
        let mut late = auto(
            schedule(),
            vec![],
            vec![ActionKind::PauseJoins { minutes: 10 }, on_member[0].clone()],
        );
        late.actions[1].after = 60;
        assert_eq!(paths(&late), ["actions.1"]);
    }

    #[test]
    fn a_follow_up_job_answers_to_the_member_whose_run_made_it() {
        let server = Refs {
            roles: [(5, MENTION_EVERYONE), (9, KICK | DELETE_MESSAGES)].into(),
            owner_bits: CREATOR,
            ..refs()
        };
        let pick = |action: serde_json::Value| -> Automation {
            serde_json::from_value(serde_json::json!({
                "name": "Looking for game",
                "trigger": {"type": "command", "name": "lfg", "description": "", "args": [{"name": "role", "required": true, "type": "choice", "options": [{"label": "Looking for game", "role": 5}]}], "channels": "all"},
                "actions": [action]
            }))
            .expect("body")
        };
        let timed = pick(
            serde_json::json!({"aid": "a", "type": "add_role", "role": {"arg": "role"}, "for_seconds": 3600}),
        );
        let delayed = pick(
            serde_json::json!({"aid": "a", "type": "add_role", "role": {"arg": "role"}, "after": 3600}),
        );
        let bundle: Automation = serde_json::from_value(serde_json::json!({
            "name": "Bundle",
            "trigger": {"type": "role_removed", "roles": [5]},
            "actions": [{"aid": "a", "type": "add_role", "role": 9, "for_seconds": 0}]
        }))
        .expect("body");
        for a in [&timed, &delayed, &bundle] {
            assert_eq!(check_refs(a, &server), [], "{}", a.name);
        }
        assert_eq!(delayed.actions[0].after, 3600);
        let [timed, delayed, bundle] =
            [timed, delayed, bundle].map(|a| validate(&a, &caps()).expect("valid"));
        let run = actor(timed.fired, Some(1), None);
        assert_eq!(run, Some(1));
        assert!(gives(
            &timed,
            MENTION_EVERYONE,
            CREATOR,
            member(1, 0),
            Some((1, 0))
        ));
        let undone = actor(bundle.fired, None, Some(run));
        assert_eq!(undone, Some(1));
        let helper = KICK | DELETE_MESSAGES;
        let picker = undone.and_then(|id| member(id, 0));
        assert!(!gives(
            &bundle,
            helper,
            CREATOR,
            picker,
            Some((1, MENTION_EVERYONE))
        ));
        assert!(gives(
            &bundle,
            helper,
            CREATOR,
            None,
            Some((1, MENTION_EVERYONE))
        ));
        let later = actor(delayed.fired, Some(1), None).and_then(|id| member(id, 0));
        assert!(gives(
            &delayed,
            MENTION_EVERYONE,
            CREATOR,
            later,
            Some((1, 0))
        ));
        assert!(!gives(
            &delayed,
            MENTION_EVERYONE | KICK,
            CREATOR,
            later,
            Some((1, 0))
        ));
    }

    #[test]
    fn url_fields_are_literal_and_refuse_placeholders() {
        let post = |embed: &str, button: &str| {
            let a: Automation = serde_json::from_value(serde_json::json!({
                "name": "U",
                "trigger": {"type": "command", "name": "go", "description": "", "args": [{"name": "x", "required": true, "type": "text", "max": 100}], "channels": "all"},
                "actions": [{
                    "aid": "a", "type": "send_message", "channel": {"channel": 7}, "text": "Here {args.x}",
                    "embed": {"title": "Docs for {args.x}", "url": embed},
                    "components": [[{"type": "button", "cid": "l", "label": "Open", "do": "link", "url": button}]]
                }]
            }))
            .expect("body");
            match validate(&a, &caps()) {
                Ok(_) => vec![],
                Err(problems) => problems.into_iter().map(|p| (p.path, p.reason)).collect(),
            }
        };
        let embed = "actions.0.embed.url".to_string();
        let button = "actions.0.components.0.0.url".to_string();
        assert_eq!(post("https://docs.example/a", "https://docs.example/b"), []);
        assert_eq!(
            post("https://{args.x}", "https://{args.x}/"),
            [
                (embed.clone(), Reason::NotAllowed),
                (button.clone(), Reason::NotAllowed)
            ]
        );
        for url in [
            "https://docs.example/{args.x}",
            "https://docs.example/?q={member}",
            "https://docs.example/{nope}",
            "https://{{{args.x}}}",
        ] {
            assert_eq!(
                post(url, "https://docs.example/b"),
                [(embed.clone(), Reason::NotAllowed)],
                "{url}"
            );
            assert_eq!(
                post("https://docs.example/a", url),
                [(button.clone(), Reason::NotAllowed)],
                "{url}"
            );
        }
        for url in [
            "https://docs.example/%7Bargs.x%7D",
            "https://docs.example/{{args.x}}",
            "https://docs.example/{}",
            "https://docs.example/{a b}",
        ] {
            assert_eq!(post(url, url), [], "{url}");
        }
        assert_eq!(
            post("ftp://{args.x}", "javascript:{args.x}"),
            [(embed, Reason::OutOfRange), (button, Reason::OutOfRange)]
        );
    }

    fn seen(views: &[i64]) -> Refs {
        Refs {
            text_channels: [7, 8].into(),
            voice_channels: [9].into(),
            categories: [10].into(),
            roles: [(5, 0)].into(),
            owner_bits: ALL_PERMS,
            views: views.iter().copied().collect(),
        }
    }

    fn only(ids: &[i64]) -> Scope {
        Scope::Only(ids.iter().copied().map(Ref::Channel).collect())
    }

    fn with_kit(trigger: Trigger, kind: ActionKind, kit: Kit) -> Automation {
        let mut a = auto(trigger, vec![], vec![kind]);
        a.kit = Some(kit);
        a
    }

    fn starboard(trigger: Trigger, channel: i64) -> Automation {
        with_kit(
            trigger,
            ActionKind::Repost,
            Kit::Starboard {
                emoji: "⭐".into(),
                threshold: 3,
                channel,
                self_star: false,
            },
        )
    }

    fn starred(channels: Scope) -> Trigger {
        Trigger::ReactionAdded {
            message: None,
            emojis: vec!["⭐".into()],
            channels,
        }
    }

    #[test]
    fn the_owner_must_view_every_channel_it_reads_or_acts_in() {
        let text = |channel: i64| ActionKind::Log {
            channel,
            content: LogContent::Text,
        };
        let send = |channel: Place, rows: Components| ActionKind::SendMessage {
            channel,
            text: "Hi".into(),
            embed: None,
            components: rows,
            ping: false,
        };
        let jump = Component::Button {
            cid: "j".into(),
            label: "Go".into(),
            emoji: None,
            style: Default::default(),
            press: Press::Jump { channel: 8 },
        };
        let mut panel8 = panel(Mode::Toggle, vec![panel_role(5, false)]);
        panel8.actions[0].kind = ActionKind::PostPanel {
            channel: 8,
            text: String::new(),
        };
        let giveaway = with_kit(
            Trigger::Component {
                panel: "giveaway".into(),
            },
            ActionKind::PostGiveaway,
            Kit::Giveaway {
                prize: "A mug".into(),
                winners: 1,
                ends_at: 0,
                requirements: vec![],
                channel: 8,
            },
        );
        let mut required = giveaway.clone();
        if let Some(Kit::Giveaway {
            channel,
            requirements,
            ..
        }) = &mut required.kit
        {
            *channel = 7;
            requirements.push(Condition::Channel { scope: only(&[8]) });
        }
        let cases: Vec<(Automation, &str)> = vec![
            (
                auto(
                    Trigger::MessageSent {
                        channels: only(&[8]),
                        edits: true,
                        guard: true,
                    },
                    vec![],
                    vec![ActionKind::Block {
                        message: String::new(),
                        report: false,
                    }],
                ),
                "trigger.channels.0",
            ),
            (
                auto(
                    Trigger::MessageSent {
                        channels: only(&[8]),
                        edits: false,
                        guard: false,
                    },
                    vec![],
                    vec![ActionKind::DeleteMessage],
                ),
                "trigger.channels.0",
            ),
            (
                auto(
                    schedule(),
                    vec![],
                    vec![ActionKind::LockChannel {
                        channel: Place::Channel(8),
                        for_seconds: 0,
                    }],
                ),
                "actions.0.channel",
            ),
            (
                auto(
                    schedule(),
                    vec![],
                    vec![ActionKind::DeleteOlder {
                        channel: 8,
                        age_seconds: 3600,
                    }],
                ),
                "actions.0.channel",
            ),
            (
                auto(
                    Trigger::MessageDeleted {
                        channels: only(&[8]),
                    },
                    vec![],
                    vec![text(7)],
                ),
                "trigger.channels.0",
            ),
            (
                auto(
                    Trigger::MessageEdited {
                        channels: only(&[8]),
                    },
                    vec![],
                    vec![text(7)],
                ),
                "trigger.channels.0",
            ),
            (
                auto(
                    sent(),
                    vec![Condition::Channel { scope: only(&[8]) }],
                    vec![notify()],
                ),
                "conditions.0.scope.0",
            ),
            (
                auto(
                    sent(),
                    vec![Condition::Any {
                        of: vec![Condition::Channel { scope: only(&[8]) }],
                    }],
                    vec![notify()],
                ),
                "conditions.0.of.0.scope.0",
            ),
            (
                auto(schedule(), vec![], vec![send(Place::Channel(8), vec![])]),
                "actions.0.channel",
            ),
            (
                auto(
                    schedule(),
                    vec![],
                    vec![send(Place::Channel(7), vec![vec![jump]])],
                ),
                "actions.0.components.0.0.channel",
            ),
            (
                auto(
                    schedule(),
                    vec![],
                    vec![ActionKind::Alert {
                        channel: 8,
                        text: String::new(),
                    }],
                ),
                "actions.0.channel",
            ),
            (
                auto(
                    schedule(),
                    vec![],
                    vec![ActionKind::UnlockChannel {
                        channel: Place::Channel(8),
                    }],
                ),
                "actions.0.channel",
            ),
            (
                auto(
                    schedule(),
                    vec![],
                    vec![ActionKind::Slowmode {
                        channel: Place::Channel(8),
                        seconds: 30,
                        for_seconds: 0,
                    }],
                ),
                "actions.0.channel",
            ),
            (
                auto(
                    schedule(),
                    vec![],
                    vec![ActionKind::RenameChannel {
                        channel: 8,
                        text: "x".into(),
                    }],
                ),
                "actions.0.channel",
            ),
            (panel8, "actions.0.channel"),
            (
                with_kit(
                    Trigger::MessageSent {
                        channels: only(&[7]),
                        edits: false,
                        guard: false,
                    },
                    ActionKind::Sticky,
                    Kit::Sticky {
                        channel: 8,
                        text: "Read the rules".into(),
                        every: 5,
                        min_seconds: 30,
                    },
                ),
                "kit.channel",
            ),
            (starboard(starred(only(&[7])), 8), "kit.channel"),
            (starboard(starred(only(&[8])), 7), "trigger.channels.0"),
            (giveaway, "kit.channel"),
            (required, "kit.requirements.0.scope.0"),
        ];
        for (a, path) in &cases {
            assert!(
                validate(a, &caps()).is_ok(),
                "{path}: {:?}",
                validate(a, &caps()).err()
            );
            let out: Vec<(String, Reason)> = check_refs(a, &seen(&[7]))
                .into_iter()
                .map(|p| (p.path, p.reason))
                .collect();
            assert_eq!(out, [(path.to_string(), Reason::UnknownChannel)], "{a:?}");
            assert_eq!(check_refs(a, &seen(&[7, 8])), [], "{path}");
        }
        let rooms = with_kit(
            Trigger::VoiceJoined {
                channels: only(&[9]),
            },
            ActionKind::CreateRoom,
            Kit::Rooms {
                hub_channel: 9,
                category: 10,
                name: "{member}'s room".into(),
                limit: 0,
                delete_after_empty_seconds: 60,
                max_rooms: 50,
            },
        );
        let out: Vec<String> = check_refs(&rooms, &seen(&[7, 8]))
            .into_iter()
            .map(|p| p.path)
            .collect();
        assert_eq!(out, ["trigger.channels.0", "kit.hub_channel"]);
        assert_eq!(check_refs(&rooms, &seen(&[9])), []);
        for scope in [
            Scope::Except(vec![Ref::Channel(8)]),
            Scope::Only(vec![Ref::Category(10)]),
            Scope::All,
        ] {
            let a = auto(
                Trigger::MessageSent {
                    channels: scope.clone(),
                    edits: false,
                    guard: false,
                },
                vec![Condition::Channel { scope }],
                vec![notify()],
            );
            assert_eq!(check_refs(&a, &seen(&[7])), []);
        }
        assert_eq!(
            check_refs(&cases[0].0, &Refs::default())[0].reason,
            Reason::UnknownChannel
        );
    }

    #[test]
    fn views_name_where_it_reads_and_acts() {
        let views = |a: &Automation| validate(a, &caps()).expect("valid").views;
        let on_message = auto(
            Trigger::MessageEdited {
                channels: only(&[7]),
            },
            vec![],
            vec![
                ActionKind::DeleteMessage,
                ActionKind::Pin,
                ActionKind::React {
                    emojis: vec!["👍".into()],
                },
                ActionKind::Reply {
                    text: "Hi".into(),
                    ping: false,
                },
                ActionKind::StartThread { name: "t".into() },
            ],
        );
        assert_eq!(views(&on_message), [Place::Here]);
        assert_eq!(views(&auto(schedule(), vec![], vec![notify()])), []);
        assert_eq!(
            views(&auto(
                Trigger::MemberAdmitted,
                vec![],
                vec![ActionKind::Kick]
            )),
            []
        );
        let channels = auto(
            schedule(),
            vec![],
            vec![
                ActionKind::LockChannel {
                    channel: Place::Channel(8),
                    for_seconds: 0,
                },
                ActionKind::SendMessage {
                    channel: Place::Channel(7),
                    text: "Hi".into(),
                    embed: None,
                    components: vec![],
                    ping: false,
                },
                ActionKind::Log {
                    channel: 7,
                    content: LogContent::Metadata,
                },
                ActionKind::Alert {
                    channel: 9,
                    text: String::new(),
                },
                ActionKind::RenameChannel {
                    channel: 8,
                    text: "x".into(),
                },
                ActionKind::DeleteOlder {
                    channel: 6,
                    age_seconds: 3600,
                },
                ActionKind::UnlockChannel {
                    channel: Place::Channel(5),
                },
                ActionKind::Slowmode {
                    channel: Place::Channel(4),
                    seconds: 5,
                    for_seconds: 0,
                },
            ],
        );
        assert_eq!(views(&channels), [8, 7, 9, 6, 5, 4].map(Place::Channel));
        let here = auto(
            Trigger::Command {
                name: "lock".into(),
                description: String::new(),
                args: vec![],
                channels: Scope::All,
            },
            vec![],
            vec![
                ActionKind::LockChannel {
                    channel: Place::Here,
                    for_seconds: 60,
                },
                ActionKind::SendMessage {
                    channel: Place::Channel(8),
                    text: "Locked".into(),
                    embed: None,
                    components: vec![],
                    ping: false,
                },
            ],
        );
        assert_eq!(views(&here), [Place::Here, Place::Channel(8)]);
        let level = |kind: ActionKind| {
            views(&auto(
                Trigger::CounterReached {
                    counter: "xp".into(),
                    value: 100,
                    every: None,
                },
                vec![],
                vec![kind],
            ))
        };
        assert_eq!(
            level(ActionKind::SendMessage {
                channel: Place::Here,
                text: "Level up".into(),
                embed: None,
                components: vec![],
                ping: false,
            }),
            [Place::Here]
        );
        assert_eq!(level(ActionKind::Timeout { seconds: 60 }), []);
        assert_eq!(
            views(&starboard(starred(only(&[7])), 8)),
            [Place::Here, Place::Channel(8)]
        );
        let sticky = with_kit(
            Trigger::MessageSent {
                channels: only(&[7]),
                edits: false,
                guard: false,
            },
            ActionKind::Sticky,
            Kit::Sticky {
                channel: 7,
                text: "Read the rules".into(),
                every: 5,
                min_seconds: 30,
            },
        );
        assert_eq!(views(&sticky), [Place::Here, Place::Channel(7)]);
        assert_eq!(
            views(&panel(Mode::Toggle, vec![panel_role(5, false)])),
            [Place::Here, Place::Channel(3)]
        );
    }

    #[test]
    fn actions_on_the_message_need_a_trigger_that_carries_one() {
        let on_message = [
            ActionKind::DeleteMessage,
            ActionKind::Pin,
            ActionKind::React {
                emojis: vec!["👍".into()],
            },
            ActionKind::Reply {
                text: "Hi".into(),
                ping: false,
            },
            ActionKind::StartThread { name: "t".into() },
        ];
        let mut carry = vec![];
        for trigger in triggers() {
            let name = trigger.name();
            let ok: Vec<bool> = on_message
                .iter()
                .map(|kind| {
                    let out = paths(&auto(trigger.clone(), vec![], vec![kind.clone()]));
                    assert!(out.is_empty() || out == ["actions.0"], "{name}: {out:?}");
                    out.is_empty()
                })
                .collect();
            assert!(ok.iter().all(|&o| o == ok[0]), "{name}");
            assert_eq!(ok[0], trigger.has_message(), "{name}");
            if ok[0] {
                carry.push(name);
            }
        }
        assert_eq!(
            carry,
            [
                "message_sent",
                "message_edited",
                "reaction_added",
                "reaction_removed"
            ]
        );
        let mut late = auto(guard(), vec![], vec![on_message[3].clone()]);
        late.actions[0].after_post = true;
        assert_eq!(paths(&late), [] as [&str; 0]);
        let mut joined = auto(
            Trigger::MemberJoined { guard: true },
            vec![],
            vec![on_message[3].clone()],
        );
        joined.actions[0].after_post = true;
        assert_eq!(paths(&joined), ["actions.0"]);
    }

    #[test]
    fn here_needs_a_trigger_in_a_channel() {
        let with = |channel: Place| {
            vec![
                ActionKind::SendMessage {
                    channel,
                    text: "Hi".into(),
                    embed: None,
                    components: vec![],
                    ping: false,
                },
                ActionKind::LockChannel {
                    channel,
                    for_seconds: 0,
                },
                ActionKind::UnlockChannel { channel },
                ActionKind::Slowmode {
                    channel,
                    seconds: 5,
                    for_seconds: 0,
                },
            ]
        };
        let mut here = vec![];
        for trigger in triggers() {
            let name = trigger.name();
            let a = auto(trigger.clone(), vec![], with(Place::Here));
            let out = paths(&a);
            match trigger.in_channel() {
                true => {
                    assert_eq!(out, [] as [&str; 0], "{name}");
                    here.push(name);
                }
                false => assert_eq!(
                    out,
                    [
                        "actions.0.channel",
                        "actions.1.channel",
                        "actions.2.channel",
                        "actions.3.channel"
                    ],
                    "{name}"
                ),
            }
            let named = auto(trigger, vec![], with(Place::Channel(7)));
            assert_eq!(paths(&named), [] as [&str; 0], "{name}");
        }
        assert_eq!(
            here,
            [
                "message_sent",
                "message_edited",
                "message_deleted",
                "reaction_added",
                "reaction_removed",
                "voice_joined",
                "voice_left",
                "command",
                "component",
                "counter_reached"
            ]
        );
    }

    #[test]
    fn a_starboard_reposts_only_from_channels_its_trigger_lists() {
        assert_eq!(paths(&starboard(starred(only(&[7])), 8)), [] as [&str; 0]);
        assert_eq!(
            paths(&starboard(starred(only(&[7, 9])), 8)),
            [] as [&str; 0]
        );
        for scope in [
            Scope::All,
            Scope::Except(vec![Ref::Channel(7)]),
            Scope::Only(vec![Ref::Category(10)]),
            Scope::Only(vec![Ref::Channel(7), Ref::Category(10)]),
            Scope::Only(vec![]),
        ] {
            assert_eq!(
                paths(&starboard(starred(scope.clone()), 8)),
                ["trigger.channels"],
                "{scope:?}"
            );
        }
        let posted = starboard(
            Trigger::MessageSent {
                channels: only(&[7]),
                edits: false,
                guard: false,
            },
            8,
        );
        assert_eq!(paths(&posted), ["trigger"]);
        let preset = crate::presets::gallery()
            .iter()
            .find(|p| p.id == "starboard")
            .expect("preset");
        assert_eq!(
            preset.automations[0].trigger.scope(),
            Some(&Scope::Only(vec![Ref::Channel(0)]))
        );
    }

    #[test]
    fn self_served_roles_are_compiled_for_the_check_at_every_grant() {
        let mut a = panel(
            Mode::Toggle,
            vec![
                panel_role(5, false),
                panel_role(23, true),
                panel_role(6, false),
            ],
        );
        a.actions.push(Action {
            aid: "b".into(),
            ..act(ActionKind::SendMessage {
                channel: Place::Here,
                text: "Pick".into(),
                embed: None,
                components: vec![vec![button("mc")], vec![select("more", 2, 0, 2)]],
                ping: false,
            })
        });
        let c = validate(&a, &caps()).expect("valid");
        assert_eq!(c.self_served, [5, 6]);
        assert_eq!(c.roles, [5, 23, 6]);
        let chosen = auto(
            Trigger::Command {
                name: "role".into(),
                description: String::new(),
                args: vec![Arg {
                    name: "role".into(),
                    required: true,
                    kind: ArgKind::Choice {
                        options: vec![
                            ArgOption {
                                label: "Chess".into(),
                                role: Some(6),
                            },
                            ArgOption {
                                label: "Go".into(),
                                role: Some(5),
                            },
                        ],
                    },
                }],
                channels: Scope::All,
            },
            vec![],
            vec![ActionKind::ToggleRole {
                role: RoleRef::Arg { arg: "role".into() },
            }],
        );
        assert_eq!(
            validate(&chosen, &caps()).expect("valid").self_served,
            [6, 5]
        );
    }

    #[test]
    fn a_command_names_roles_only_through_a_fixed_choice_list() {
        let a = auto(
            Trigger::Command {
                name: "role".into(),
                description: "Pick a game role".into(),
                args: vec![Arg {
                    name: "role".into(),
                    required: true,
                    kind: ArgKind::Choice {
                        options: vec![
                            ArgOption {
                                label: "Chess".into(),
                                role: Some(5),
                            },
                            ArgOption {
                                label: "Mod".into(),
                                role: Some(23),
                            },
                        ],
                    },
                }],
                channels: Scope::All,
            },
            vec![],
            vec![notify()],
        );
        let out = check_refs(&a, &refs());
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].path, "trigger.args.0.options.1.role");
        assert_eq!(out[0].reason, Reason::GivesPermissions);
        assert_eq!(validate(&a, &caps()).expect("valid").roles, [5, 23]);
        let toggle = |arg: &str| ActionKind::ToggleRole {
            role: RoleRef::Arg { arg: arg.into() },
        };
        let mut picked = a.clone();
        picked.actions[0].kind = toggle("role");
        assert_eq!(paths(&picked), [] as [&str; 0]);
        picked.actions[0].kind = toggle("other");
        assert_eq!(paths(&picked), ["actions.0.role"]);
        let free = auto(sent(), vec![], vec![toggle("role")]);
        assert_eq!(paths(&free), ["actions.0.role"]);
        let mut open = a.clone();
        open.actions[0].kind = toggle("role");
        if let Trigger::Command { args, .. } = &mut open.trigger
            && let ArgKind::Choice { options } = &mut args[0].kind
        {
            options[0].role = None;
        }
        assert_eq!(paths(&open), ["actions.0.role"]);
        assert_eq!(
            serde_json::to_string(&toggle("role")).expect("json"),
            r#"{"type":"toggle_role","role":{"arg":"role"}}"#
        );
        assert_eq!(
            serde_json::to_string(&ActionKind::RemoveRole { role: 5.into() }).expect("json"),
            r#"{"type":"remove_role","role":5}"#
        );
    }

    #[test]
    fn an_automation_has_a_stored_shape() {
        let json = r#"{
            "name": "Word filter",
            "trigger": {"type": "message_sent", "channels": {"except": [{"channel": 4}]}, "edits": true, "guard": true},
            "conditions": [
                {"type": "keywords", "list": ["free nitro"], "allow": []},
                {"type": "not", "of": {"type": "is_staff"}},
                {"type": "any", "of": [{"type": "rate", "count": 5, "seconds": 5, "per": "channel"}, {"type": "account_age", "minutes": {"under": 1440}}]}
            ],
            "actions": [
                {"aid": "a1", "type": "block", "message": "Watch your language", "report": true},
                {"aid": "a2", "type": "timeout", "seconds": 600},
                {"aid": "a3", "type": "counter_add", "name": "strikes", "amount": {"fixed": 1}, "after_post": true},
                {"aid": "a4", "type": "alert", "channel": 9, "after": 5}
            ]
        }"#;
        let a: Automation = serde_json::from_str(json).expect("automation");
        assert!(a.enabled);
        assert_eq!(a.tz, "UTC");
        assert!(a.trigger.is_guard());
        assert_eq!(a.trigger.name(), "message_sent");
        assert_eq!(a.actions[2].kind.name(), "counter_add");
        assert!(a.actions[2].after_post);
        assert_eq!(a.actions[3].after, 5);
        assert!(a.trigger.scope().expect("scope").covers(5, None));
        assert!(!a.trigger.scope().expect("scope").covers(4, None));
        let c = validate(&a, &caps()).expect("valid");
        assert_eq!(
            c.needs,
            Needs(DELETE_MESSAGES | TIMEOUT_MEMBERS | MANAGE_AUTOMATIONS)
        );
        assert_eq!(c.event, event_bit("message_sent").expect("bit"));
        let back: Automation =
            serde_json::from_str(&serde_json::to_string(&a).expect("json")).expect("round trip");
        assert_eq!(back, a);
        assert!(
            serde_json::from_str::<Automation>(
                r#"{"name":"x","trigger":{"type":"nope"},"actions":[]}"#
            )
            .is_err()
        );
    }

    #[test]
    fn scopes_cover_channels_and_categories() {
        let only = Scope::Only(vec![Ref::Channel(1), Ref::Category(9)]);
        assert!(only.covers(1, None));
        assert!(only.covers(5, Some(9)));
        assert!(!only.covers(5, Some(8)));
        let except = Scope::Except(vec![Ref::Category(9)]);
        assert!(!except.covers(5, Some(9)));
        assert!(except.covers(5, None));
        assert!(Scope::All.covers(5, None));
        assert_eq!(
            serde_json::to_string(&Scope::All).expect("json"),
            r#""all""#
        );
    }

    #[test]
    fn every_trigger_has_its_own_event_bit() {
        let mut seen = 0u32;
        for name in EVENTS {
            let bit = event_bit(name).expect("bit");
            assert_eq!(bit.count_ones(), 1);
            assert_eq!(seen & bit, 0);
            seen |= bit;
        }
        assert_eq!(EVENTS.len(), 22);
        assert_eq!(event_bit("message_sent"), Some(1));
        assert_eq!(event_bit("nope"), None);
    }

    #[test]
    fn content_conditions_are_known() {
        assert!(keywords(vec!["a".into()], vec![]).reads_content());
        assert!(
            Condition::Not {
                of: Box::new(Condition::Regex {
                    patterns: vec!["a".into()]
                })
            }
            .reads_content()
        );
        assert!(
            !Condition::Mentions {
                over: 5,
                unique: false
            }
            .reads_content()
        );
        assert!(!Condition::HasAttachment { at_least: 1 }.reads_content());
    }

    fn source(automation: i64, keywords: Vec<String>, patterns: Vec<String>) -> Source {
        Source {
            automation,
            condition: 0,
            keywords,
            allow: vec![],
            patterns,
        }
    }

    #[test]
    fn the_guard_set_maps_hits_back_to_their_automation_and_condition() {
        let set = GuardSet::build(
            vec![
                Source {
                    automation: 4,
                    condition: 1,
                    keywords: vec!["free nitro".into(), "*scam*".into()],
                    allow: vec!["scampi".into()],
                    patterns: vec![],
                },
                Source {
                    automation: 9,
                    condition: 0,
                    keywords: vec!["scampi".into()],
                    allow: vec![],
                    patterns: vec![r"\d{3}-\d{4}".into(), "nitro".into()],
                },
            ],
            &caps(),
        )
        .expect("set");
        assert_eq!(set.guards(), 2);
        assert_eq!(set.keyword_entries(), 3);
        assert_eq!(set.patterns(), [r"\d{3}-\d{4}", "nitro"]);
        let hits = set.scan("Fresh SCAMPI and frее  nitro, call 555-0199");
        assert_eq!(
            hits.keywords,
            [
                SourceHit {
                    automation: 4,
                    condition: 1,
                    entry: 0
                },
                SourceHit {
                    automation: 9,
                    condition: 0,
                    entry: 0
                }
            ]
        );
        assert_eq!(
            hits.patterns,
            [
                SourceHit {
                    automation: 9,
                    condition: 0,
                    entry: 0
                },
                SourceHit {
                    automation: 9,
                    condition: 0,
                    entry: 1
                }
            ]
        );
        assert_eq!(set.scan("nothing to see"), Hits::default());
        let empty = GuardSet::build(vec![], &caps()).expect("empty");
        assert_eq!(empty.scan("free nitro"), Hits::default());
    }

    #[test]
    fn the_guard_set_is_collected_from_guard_automations_only() {
        let word_filter = auto(
            guard(),
            vec![
                Condition::Not {
                    of: Box::new(Condition::IsStaff),
                },
                keywords(vec!["free nitro".into()], vec![]),
                Condition::Any {
                    of: vec![Condition::Regex {
                        patterns: vec!["nitro".into()],
                    }],
                },
                Condition::Name {
                    list: vec!["admin".into()],
                },
            ],
            vec![notify()],
        );
        let reaction = auto(
            sent(),
            vec![keywords(vec!["hello".into()], vec![])],
            vec![notify()],
        );
        let set = GuardSet::of(&[(7, &word_filter), (8, &reaction)], &caps()).expect("set");
        assert_eq!(set.guards(), 1);
        assert_eq!(set.keyword_entries(), 1);
        let hits = set.scan("free nitro hello admin");
        assert_eq!(
            hits.keywords,
            [SourceHit {
                automation: 7,
                condition: 2,
                entry: 0
            }]
        );
        assert_eq!(
            hits.patterns,
            [SourceHit {
                automation: 7,
                condition: 4,
                entry: 0
            }]
        );
    }

    #[test]
    fn the_guard_set_refuses_a_server_over_its_budgets() {
        let over = |sources: Vec<Source>, caps: &Caps| {
            GuardSet::build(sources, caps)
                .expect_err("refused")
                .into_iter()
                .map(|p| (p.path, p.reason))
                .collect::<Vec<(String, Reason)>>()
        };
        let guards = |n: i64| -> Vec<Source> {
            (0..n)
                .map(|i| source(i, vec![format!("w{i}")], vec![]))
                .collect()
        };
        assert!(GuardSet::build(guards(25), &caps()).is_ok());
        assert_eq!(
            over(guards(26), &caps()),
            [("guards".to_string(), Reason::TooMany)]
        );
        let words = |n: usize| -> Vec<Source> {
            (0..5)
                .map(|g| source(g, strings(n / 5, |i| format!("g{g}w{i}")), vec![]))
                .collect()
        };
        assert!(GuardSet::build(words(5000), &caps()).is_ok());
        let mut one_more = words(5000);
        one_more[0].keywords.push("extra".into());
        assert_eq!(
            over(one_more, &caps()),
            [("keywords".to_string(), Reason::TooMany)]
        );
        let patterns = |n: usize| -> Vec<Source> {
            (0..5)
                .map(|g| source(g, vec![], strings(n / 5, |i| format!("g{g}p{i}+"))))
                .collect()
        };
        assert!(GuardSet::build(patterns(50), &caps()).is_ok());
        let mut one_more = patterns(50);
        one_more[0].patterns.push("extra".into());
        assert_eq!(
            over(one_more, &caps()),
            [("patterns".to_string(), Reason::TooMany)]
        );
        let heavy: Vec<Source> = (0..8)
            .map(|g| source(g, vec![], strings(5, |i| format!(r"\pL{{10}}g{g}p{i}"))))
            .collect();
        assert_eq!(
            over(heavy.clone(), &caps()),
            [("patterns".to_string(), Reason::TooBig)]
        );
        let roomy = Caps {
            regex_mib_per_server: 64,
            ..caps()
        };
        assert!(GuardSet::build(heavy, &roomy).is_ok());
        assert_eq!(
            over(vec![source(1, vec![], vec!["(open".into()])], &caps()),
            [("patterns.0".to_string(), Reason::BadPattern)]
        );
    }

    #[test]
    fn the_guard_cap_counts_every_guard_automation() {
        let mentions = auto(
            guard(),
            vec![Condition::Mentions {
                over: 10,
                unique: false,
            }],
            vec![ActionKind::Block {
                message: String::new(),
                report: false,
            }],
        );
        let worded = auto(
            guard(),
            vec![keywords(vec!["free nitro".into()], vec![])],
            vec![ActionKind::Block {
                message: String::new(),
                report: false,
            }],
        );
        let joins = auto(
            Trigger::MemberJoined { guard: true },
            vec![],
            vec![ActionKind::Kick],
        );
        let reaction = auto(sent(), vec![], vec![notify()]);
        let server = |plain: i64, words: i64, joined: i64, others: i64| {
            let mut all: Vec<(i64, &Automation)> = vec![];
            let mut id = 0;
            for (n, a) in [
                (plain, &mentions),
                (words, &worded),
                (joined, &joins),
                (others, &reaction),
            ] {
                for _ in 0..n {
                    id += 1;
                    all.push((id, a));
                }
            }
            GuardSet::of(&all, &caps())
                .map(|set| set.guards())
                .map_err(|e| {
                    e.into_iter()
                        .map(|p| (p.path, p.reason))
                        .collect::<Vec<_>>()
                })
        };
        let over = Err(vec![("guards".to_string(), Reason::TooMany)]);
        assert_eq!(server(25, 0, 0, 10), Ok(25));
        assert_eq!(server(26, 0, 0, 0), over);
        assert_eq!(server(20, 6, 0, 0), over);
        assert_eq!(server(10, 10, 5, 50), Ok(25));
        assert_eq!(server(10, 10, 6, 0), over);
        assert_eq!(server(0, 26, 0, 0), over);
        assert_eq!(server(0, 0, 0, 100), Ok(0));
    }

    #[test]
    fn problems_read_as_plain_ascii() {
        let p = Problem {
            path: "actions.1.after".into(),
            reason: Reason::OutOfRange,
        };
        assert_eq!(p.to_string(), "actions.1.after: out of range");
        assert_eq!(
            serde_json::to_string(&p).expect("json"),
            r#"{"path":"actions.1.after","reason":"out_of_range"}"#
        );
        for reason in Reason::ALL {
            assert!(reason.to_string().is_ascii());
        }
    }
}
