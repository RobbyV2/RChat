//! Server onboarding: the config, its validation, and what a joiner still has to do. Times are
//! unix seconds.

use crate::grants::{self, DELETE_SERVER, KICK, MANAGE_ADMINS, self_service};
use crate::validate::{Check, Problem, Reason};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// `members.gate`.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(try_from = "u8", into = "u8")]
pub enum Gate {
    #[default]
    In,
    Pending,
    Held,
    RulesLock,
}

impl From<Gate> for u8 {
    fn from(g: Gate) -> u8 {
        match g {
            Gate::In => 0,
            Gate::Pending => 1,
            Gate::Held => 2,
            Gate::RulesLock => 3,
        }
    }
}

impl TryFrom<u8> for Gate {
    type Error = String;

    fn try_from(v: u8) -> Result<Gate, String> {
        match v {
            0 => Ok(Gate::In),
            1 => Ok(Gate::Pending),
            2 => Ok(Gate::Held),
            3 => Ok(Gate::RulesLock),
            other => Err(format!("unknown gate {other}")),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PendingView {
    #[default]
    ReadOnly,
    WaitingRoom,
}

#[derive(Clone, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Onboarding {
    pub enabled: bool,
    pub pending_view: PendingView,
    pub waiting_room: Vec<i64>,
    pub waiting_talk: bool,
    pub requirements: Requirements,
    pub rules: Rules,
    pub questions: Vec<Question>,
    pub application: Vec<Prompt>,
    pub default_channels: Vec<i64>,
    pub land_channel: Option<i64>,
    pub welcome: Welcome,
    pub may_give: Vec<i64>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Requirements {
    pub account_age_minutes: u32,
    pub member_minutes: u32,
    pub backup_phrase: bool,
    pub sso: bool,
    pub pow_work: u64,
    pub approval: bool,
}

#[derive(Clone, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Rules {
    pub version: u32,
    pub intro: String,
    pub items: Vec<Rule>,
}

#[derive(Clone, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Rule {
    pub id: String,
    pub text: String,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Pick {
    #[default]
    Single,
    Multiple,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum When {
    #[default]
    Before,
    After,
}

#[derive(Clone, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Question {
    pub id: String,
    pub title: String,
    pub help: String,
    pub kind: Pick,
    pub required: bool,
    pub when: When,
    pub options: Vec<Choice>,
}

#[derive(Clone, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Choice {
    pub id: String,
    pub label: String,
    pub emoji: Option<String>,
    pub description: String,
    pub roles: Vec<i64>,
    pub channels: Vec<i64>,
}

#[derive(Clone, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Prompt {
    pub id: String,
    pub text: String,
    pub required: bool,
    pub max: u16,
}

#[derive(Clone, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Welcome {
    pub description: String,
    pub message: String,
    pub recommended: Vec<Recommended>,
    pub todos: Vec<Todo>,
}

#[derive(Clone, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Recommended {
    pub channel: i64,
    pub emoji: Option<String>,
    pub text: String,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoKind {
    ReadChannel,
    PostIn,
    PickRoles,
    #[default]
    Custom,
}

#[derive(Clone, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Todo {
    pub id: String,
    pub kind: TodoKind,
    pub channel: Option<i64>,
    pub text: String,
}

/// What a config may name: the server's text channels, its roles other than @everyone with
/// their current bits, and the bits of the member saving it.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct Server {
    pub text_channels: BTreeSet<i64>,
    pub roles: BTreeMap<i64, u32>,
    pub owner_bits: u32,
}

fn unique(ids: &[i64]) -> Vec<i64> {
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        if !out.contains(id) {
            out.push(*id);
        }
    }
    out
}

fn trimmed(s: &str) -> String {
    s.trim().to_string()
}

/// The config as it is stored: text trimmed, id lists without repeats.
pub fn normalized(c: &Onboarding) -> Onboarding {
    let emoji = |e: &Option<String>| e.as_deref().map(trimmed).filter(|e| !e.is_empty());
    Onboarding {
        enabled: c.enabled,
        pending_view: c.pending_view,
        waiting_room: unique(&c.waiting_room),
        waiting_talk: c.waiting_talk,
        requirements: c.requirements,
        rules: Rules {
            version: c.rules.version,
            intro: trimmed(&c.rules.intro),
            items: c
                .rules
                .items
                .iter()
                .map(|r| Rule {
                    id: r.id.clone(),
                    text: trimmed(&r.text),
                })
                .collect(),
        },
        questions: c
            .questions
            .iter()
            .map(|q| Question {
                id: q.id.clone(),
                title: trimmed(&q.title),
                help: trimmed(&q.help),
                kind: q.kind,
                required: q.required,
                when: q.when,
                options: q
                    .options
                    .iter()
                    .map(|o| Choice {
                        id: o.id.clone(),
                        label: trimmed(&o.label),
                        emoji: emoji(&o.emoji),
                        description: trimmed(&o.description),
                        roles: unique(&o.roles),
                        channels: unique(&o.channels),
                    })
                    .collect(),
            })
            .collect(),
        application: c
            .application
            .iter()
            .map(|p| Prompt {
                id: p.id.clone(),
                text: trimmed(&p.text),
                required: p.required,
                max: p.max,
            })
            .collect(),
        default_channels: unique(&c.default_channels),
        land_channel: c.land_channel,
        welcome: Welcome {
            description: trimmed(&c.welcome.description),
            message: trimmed(&c.welcome.message),
            recommended: c
                .welcome
                .recommended
                .iter()
                .map(|r| Recommended {
                    channel: r.channel,
                    emoji: emoji(&r.emoji),
                    text: trimmed(&r.text),
                })
                .collect(),
            todos: c
                .welcome
                .todos
                .iter()
                .map(|t| Todo {
                    id: t.id.clone(),
                    kind: t.kind,
                    channel: t.channel,
                    text: trimmed(&t.text),
                })
                .collect(),
        },
        may_give: unique(&c.may_give),
    }
}

pub const EMOJI_MAX: usize = 32;

fn channels(check: &mut Check, path: &str, ids: &[i64], server: &Server) {
    for (i, id) in ids.iter().enumerate() {
        if !server.text_channels.contains(id) {
            check.add(&format!("{path}.{i}"), Reason::UnknownChannel);
        }
    }
}

fn emoji(check: &mut Check, path: &str, emoji: &Option<String>) {
    if let Some(e) = emoji {
        check.text(path, e, 1, EMOJI_MAX);
    }
}

/// Every problem of a config, measured on its `normalized` form. Roles a choice gives must
/// exist and pass the self-service rule with their current bits.
pub fn validate(config: &Onboarding, server: &Server) -> Vec<Problem> {
    let c = normalized(config);
    let mut check = Check::default();
    let waiting = match c.pending_view {
        PendingView::WaitingRoom => 1,
        PendingView::ReadOnly => 0,
    };
    check.count("waiting_room", c.waiting_room.len(), waiting, 5);
    channels(&mut check, "waiting_room", &c.waiting_room, server);
    let r = &c.requirements;
    check.range(
        "requirements.account_age_minutes",
        u64::from(r.account_age_minutes),
        0,
        525_600,
    );
    check.range(
        "requirements.member_minutes",
        u64::from(r.member_minutes),
        0,
        10_080,
    );
    check.text("rules.intro", &c.rules.intro, 0, 1000);
    check.count("rules.items", c.rules.items.len(), 0, 20);
    check.ids("rules.items", c.rules.items.iter().map(|r| r.id.as_str()));
    for (i, rule) in c.rules.items.iter().enumerate() {
        check.text(&format!("rules.items.{i}.text"), &rule.text, 1, 300);
    }
    check.count("questions", c.questions.len(), 0, 15);
    check.ids("questions", c.questions.iter().map(|q| q.id.as_str()));
    for (i, q) in c.questions.iter().enumerate() {
        let at = format!("questions.{i}");
        check.text(&format!("{at}.title"), &q.title, 1, 100);
        check.text(&format!("{at}.help"), &q.help, 0, 200);
        check.count(&format!("{at}.options"), q.options.len(), 1, 25);
        check.ids(
            &format!("{at}.options"),
            q.options.iter().map(|o| o.id.as_str()),
        );
        for (j, o) in q.options.iter().enumerate() {
            let at = format!("{at}.options.{j}");
            check.text(&format!("{at}.label"), &o.label, 1, 50);
            emoji(&mut check, &format!("{at}.emoji"), &o.emoji);
            check.text(&format!("{at}.description"), &o.description, 0, 100);
            check.count(
                &format!("{at}.roles"),
                config.questions[i].options[j].roles.len(),
                0,
                5,
            );
            check.count(
                &format!("{at}.channels"),
                config.questions[i].options[j].channels.len(),
                0,
                10,
            );
            channels(&mut check, &format!("{at}.channels"), &o.channels, server);
            for (k, role) in o.roles.iter().enumerate() {
                let reason = match server.roles.get(role) {
                    None => Some(Reason::UnknownRole),
                    Some(&bits) => grantable(&c, *role, bits, server.owner_bits).map(|g| match g {
                        grants::Refusal::GivesPermissions => Reason::GivesPermissions,
                        grants::Refusal::OwnerCantGrant => Reason::OwnerCantGrant,
                    }),
                };
                if let Some(reason) = reason {
                    check.add(&format!("{at}.roles.{k}"), reason);
                }
            }
        }
    }
    check.count("application", c.application.len(), 0, 5);
    if !c.application.is_empty() && !r.approval {
        check.add("application", Reason::NotAllowed);
    }
    check.ids("application", c.application.iter().map(|p| p.id.as_str()));
    for (i, p) in c.application.iter().enumerate() {
        check.text(&format!("application.{i}.text"), &p.text, 1, 200);
        check.range(&format!("application.{i}.max"), u64::from(p.max), 1, 1000);
    }
    check.count("default_channels", c.default_channels.len(), 0, 50);
    channels(&mut check, "default_channels", &c.default_channels, server);
    if c.land_channel
        .is_some_and(|id| !server.text_channels.contains(&id))
    {
        check.add("land_channel", Reason::UnknownChannel);
    }
    let w = &c.welcome;
    check.text("welcome.description", &w.description, 0, 300);
    check.text("welcome.message", &w.message, 0, 2000);
    check.count("welcome.recommended", w.recommended.len(), 0, 5);
    for (i, rec) in w.recommended.iter().enumerate() {
        let at = format!("welcome.recommended.{i}");
        if !server.text_channels.contains(&rec.channel) {
            check.add(&format!("{at}.channel"), Reason::UnknownChannel);
        }
        emoji(&mut check, &format!("{at}.emoji"), &rec.emoji);
        check.text(&format!("{at}.text"), &rec.text, 0, 100);
    }
    check.count("welcome.todos", w.todos.len(), 0, 5);
    check.ids("welcome.todos", w.todos.iter().map(|t| t.id.as_str()));
    for (i, todo) in w.todos.iter().enumerate() {
        let at = format!("welcome.todos.{i}");
        check.text(&format!("{at}.text"), &todo.text, 0, 100);
        let needs_channel = matches!(todo.kind, TodoKind::ReadChannel | TodoKind::PostIn);
        match todo.channel {
            None if needs_channel => check.add(&format!("{at}.channel"), Reason::Missing),
            Some(id) if !server.text_channels.contains(&id) => {
                check.add(&format!("{at}.channel"), Reason::UnknownChannel)
            }
            _ => {}
        }
    }
    for (i, role) in c.may_give.iter().enumerate() {
        if !server.roles.contains_key(role) {
            check.add(&format!("may_give.{i}"), Reason::UnknownRole);
        }
    }
    check.done()
}

/// Whether onboarding may give `role` now, with the role's current bits.
pub fn grantable(
    c: &Onboarding,
    role: i64,
    role_bits: u32,
    owner_bits: u32,
) -> Option<grants::Refusal> {
    self_service(role_bits, c.may_give.contains(&role), owner_bits)
}

/// Whether the normalized rule list changed, which bumps `rules.version`.
pub fn rules_changed(before: &Rules, after: &Rules) -> bool {
    let list = |r: &Rules| -> Vec<(String, String)> {
        r.items
            .iter()
            .map(|i| (i.id.clone(), trimmed(&i.text)))
            .collect()
    };
    list(before) != list(after)
}

/// The work a server asks for, inside the instance's range. 0 stays off.
pub fn clamp_pow(work: u64, general: u64, max: u64) -> u64 {
    match work {
        0 => 0,
        work => work.max(general).min(max),
    }
}

/// Whether a re-prompt may put this member under a rules lock: never staff.
pub fn may_lock(is_admin: bool, rank_bits: u32) -> bool {
    !is_admin && rank_bits & (MANAGE_ADMINS | KICK | DELETE_SERVER) == 0
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HoldKind {
    Moderator,
    Automation,
    ApprovalWindow,
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct Hold {
    pub kind: HoldKind,
    pub by: Option<String>,
    pub at: i64,
}

fn no_cap() -> u64 {
    u64::MAX
}

/// What is known about a member when their state is computed.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct Facts {
    pub now: i64,
    pub gate: Gate,
    pub account_created_at: i64,
    pub joined_at: i64,
    pub has_phrase: bool,
    pub has_sso: bool,
    pub pow_at: Option<i64>,
    /// Whether the instance's proof of work is on.
    pub pow_enabled: bool,
    /// Whether the instance exempts this caller.
    pub pow_exempt: bool,
    /// The instance's `pow_work_max`.
    #[serde(default = "no_cap")]
    pub pow_work_max: u64,
    pub rules_version: Option<u32>,
    pub answered: Vec<String>,
    pub application_filled: Vec<String>,
    pub approved: bool,
    /// The approval-window latch.
    pub approval_required: bool,
    pub managed: bool,
    pub grandfathered: bool,
    pub hold: Option<Hold>,
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Missing {
    Held {
        hold: HoldKind,
        by: Option<String>,
        at: i64,
    },
    AccountAge {
        ready_at: i64,
    },
    MemberTime {
        ready_at: i64,
    },
    BackupPhrase,
    Sso,
    Pow {
        work: u64,
    },
    Rules {
        version: u32,
    },
    Questions {
        ids: Vec<String>,
    },
    Application {
        ids: Vec<String>,
    },
    Approval,
}

fn rules_behind(c: &Onboarding, f: &Facts) -> bool {
    !c.rules.items.is_empty() && f.rules_version.is_none_or(|v| v < c.rules.version)
}

/// What the member still has to do, in the order it is shown. Empty means admitted.
pub fn missing(c: &Onboarding, f: &Facts) -> Vec<Missing> {
    let rules = || Missing::Rules {
        version: c.rules.version,
    };
    match f.gate {
        Gate::Held => {
            return vec![match &f.hold {
                Some(h) => Missing::Held {
                    hold: h.kind,
                    by: h.by.clone(),
                    at: h.at,
                },
                None => Missing::Held {
                    hold: HoldKind::Moderator,
                    by: None,
                    at: 0,
                },
            }];
        }
        Gate::RulesLock => {
            return match rules_behind(c, f) {
                true => vec![rules()],
                false => vec![],
            };
        }
        Gate::In | Gate::Pending => {}
    }
    if !c.enabled || f.managed || f.grandfathered {
        return vec![];
    }
    let r = &c.requirements;
    let mut out = Vec::new();
    let age = f.account_created_at + i64::from(r.account_age_minutes) * 60;
    if r.account_age_minutes > 0 && f.now < age {
        out.push(Missing::AccountAge { ready_at: age });
    }
    let member = f.joined_at + i64::from(r.member_minutes) * 60;
    if r.member_minutes > 0 && f.now < member {
        out.push(Missing::MemberTime { ready_at: member });
    }
    if r.backup_phrase && !f.has_phrase {
        out.push(Missing::BackupPhrase);
    }
    if r.sso && !f.has_sso {
        out.push(Missing::Sso);
    }
    if r.pow_work > 0 && f.pow_enabled && !f.pow_exempt && f.pow_at.is_none() {
        out.push(Missing::Pow {
            work: r.pow_work.min(f.pow_work_max),
        });
    }
    if rules_behind(c, f) {
        out.push(rules());
    }
    let questions: Vec<String> = c
        .questions
        .iter()
        .filter(|q| q.required && q.when == When::Before && !f.answered.contains(&q.id))
        .map(|q| q.id.clone())
        .collect();
    if !questions.is_empty() {
        out.push(Missing::Questions { ids: questions });
    }
    if r.approval || f.approval_required {
        let application: Vec<String> = c
            .application
            .iter()
            .filter(|p| p.required && !f.application_filled.contains(&p.id))
            .map(|p| p.id.clone())
            .collect();
        if !application.is_empty() {
            out.push(Missing::Application { ids: application });
        }
        if !f.approved {
            out.push(Missing::Approval);
        }
    }
    out
}

/// What "Check now", the sweep or any recompute may do: admit a pending member and release a
/// rules lock. It never touches a hold.
pub fn recompute(c: &Onboarding, f: &Facts) -> Gate {
    match f.gate {
        Gate::Held => Gate::Held,
        Gate::In => Gate::In,
        gate => match missing(c, f).is_empty() {
            true => Gate::In,
            false => gate,
        },
    }
}

/// A moderator's Let in: it clears a hold and satisfies approval. With `anyway` it overrides
/// every other requirement too.
pub fn let_in(c: &Onboarding, f: &Facts, anyway: bool) -> Gate {
    if anyway {
        return Gate::In;
    }
    let after = Facts {
        gate: match f.gate {
            Gate::Held => Gate::Pending,
            gate => gate,
        },
        hold: None,
        approved: true,
        ..f.clone()
    };
    match (missing(c, &after).is_empty(), after.gate) {
        (true, _) => Gate::In,
        (false, Gate::RulesLock) => Gate::RulesLock,
        (false, _) => Gate::Pending,
    }
}

/// The approval-window latch: joining while the window is open sets `approval_required` for
/// good.
pub fn latched(joined_at: i64, window_until: Option<i64>) -> bool {
    window_until.is_some_and(|until| joined_at < until)
}

/// The gate as the access gate reads it: with `server_onboarding` off, pending and rules locks
/// read as in and holds still apply. The stored value never changes with the switch.
pub fn effective_gate(stored: Gate, switch_on: bool) -> Gate {
    match (switch_on, stored) {
        (true, gate) => gate,
        (false, Gate::Held) => Gate::Held,
        (false, _) => Gate::In,
    }
}

/// The earliest time a sweep could admit, when only timers are left.
pub fn sweep_at(missing: &[Missing]) -> Option<i64> {
    missing
        .iter()
        .map(|m| match m {
            Missing::AccountAge { ready_at } | Missing::MemberTime { ready_at } => Some(*ready_at),
            _ => None,
        })
        .collect::<Option<Vec<i64>>>()?
        .into_iter()
        .max()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grants::{DELETE_SERVER, KICK, MANAGE_ADMINS, MENTION_EVERYONE};

    fn cfg(requirements: Requirements) -> Onboarding {
        Onboarding {
            enabled: true,
            requirements,
            ..Onboarding::default()
        }
    }

    fn facts() -> Facts {
        Facts {
            now: 1_000_000,
            gate: Gate::Pending,
            account_created_at: 0,
            joined_at: 1_000_000,
            has_phrase: false,
            has_sso: false,
            pow_at: None,
            pow_enabled: true,
            pow_exempt: false,
            pow_work_max: u64::MAX,
            rules_version: None,
            answered: vec![],
            application_filled: vec![],
            approved: false,
            approval_required: false,
            managed: false,
            grandfathered: false,
            hold: None,
        }
    }

    fn rules() -> Rules {
        Rules {
            version: 3,
            intro: String::new(),
            items: vec![Rule {
                id: "a".into(),
                text: "Be kind".into(),
            }],
        }
    }

    fn question(id: &str, required: bool, when: When) -> Question {
        Question {
            id: id.into(),
            title: "What brings you here?".into(),
            help: String::new(),
            kind: Pick::Single,
            required,
            when,
            options: vec![Choice {
                id: "c1".into(),
                label: "Gaming".into(),
                emoji: None,
                description: String::new(),
                roles: vec![],
                channels: vec![],
            }],
        }
    }

    fn prompt(id: &str, required: bool) -> Prompt {
        Prompt {
            id: id.into(),
            text: "Tell us about you".into(),
            required,
            max: 500,
        }
    }

    fn everything() -> Onboarding {
        Onboarding {
            rules: rules(),
            application: vec![prompt("a1", true)],
            ..cfg(Requirements {
                backup_phrase: true,
                sso: true,
                pow_work: 1 << 20,
                approval: true,
                ..Requirements::default()
            })
        }
    }

    fn moderator_hold() -> Hold {
        Hold {
            kind: HoldKind::Moderator,
            by: Some("carol".into()),
            at: 5,
        }
    }

    #[test]
    fn nothing_configured_or_switched_off_admits() {
        assert_eq!(missing(&cfg(Requirements::default()), &facts()), []);
        let off = Onboarding {
            enabled: false,
            ..cfg(Requirements {
                backup_phrase: true,
                ..Requirements::default()
            })
        };
        assert_eq!(missing(&off, &facts()), []);
    }

    #[test]
    fn time_requirements_carry_ready_times_and_resolve_by_themselves() {
        let c = cfg(Requirements {
            account_age_minutes: 60 * 24,
            member_minutes: 10,
            ..Requirements::default()
        });
        let f = Facts {
            account_created_at: 1_000_000 - 3600,
            ..facts()
        };
        let out = missing(&c, &f);
        assert_eq!(
            out,
            [
                Missing::AccountAge {
                    ready_at: 1_000_000 - 3600 + 86_400
                },
                Missing::MemberTime {
                    ready_at: 1_000_600
                },
            ]
        );
        assert_eq!(sweep_at(&out), Some(1_000_000 - 3600 + 86_400));
        let later = Facts {
            now: 1_000_000 - 3600 + 86_400,
            ..f
        };
        assert_eq!(missing(&c, &later), []);
    }

    #[test]
    fn each_check_alone() {
        let phrase = cfg(Requirements {
            backup_phrase: true,
            ..Requirements::default()
        });
        assert_eq!(missing(&phrase, &facts()), [Missing::BackupPhrase]);
        let sso = cfg(Requirements {
            sso: true,
            ..Requirements::default()
        });
        assert_eq!(missing(&sso, &facts()), [Missing::Sso]);
        assert_eq!(
            missing(
                &sso,
                &Facts {
                    has_sso: true,
                    ..facts()
                }
            ),
            []
        );
        let pow = cfg(Requirements {
            pow_work: 1 << 20,
            ..Requirements::default()
        });
        assert_eq!(missing(&pow, &facts()), [Missing::Pow { work: 1 << 20 }]);
        assert_eq!(
            missing(
                &pow,
                &Facts {
                    pow_at: Some(5),
                    ..facts()
                }
            ),
            []
        );
    }

    #[test]
    fn pow_is_waived_while_it_is_off_and_passes_for_exempt_callers() {
        let pow = cfg(Requirements {
            pow_work: 1 << 20,
            ..Requirements::default()
        });
        assert_eq!(
            missing(
                &pow,
                &Facts {
                    pow_enabled: false,
                    ..facts()
                }
            ),
            []
        );
        assert_eq!(
            missing(
                &pow,
                &Facts {
                    pow_exempt: true,
                    ..facts()
                }
            ),
            []
        );
    }

    #[test]
    fn pow_work_is_clamped_to_the_instances_maximum_at_every_check() {
        let pow = cfg(Requirements {
            pow_work: 1 << 20,
            ..Requirements::default()
        });
        let lowered = Facts {
            pow_work_max: 1 << 16,
            ..facts()
        };
        assert_eq!(missing(&pow, &lowered), [Missing::Pow { work: 1 << 16 }]);
        assert_eq!(clamp_pow(1 << 20, 1 << 10, 1 << 16), 1 << 16);
        assert_eq!(clamp_pow(5, 1 << 10, 1 << 16), 1 << 10);
        assert_eq!(clamp_pow(0, 1 << 10, 1 << 16), 0);
        assert_eq!(clamp_pow(1 << 12, 1 << 10, 1 << 16), 1 << 12);
        assert_eq!(clamp_pow(1 << 12, 1 << 14, 1 << 13), 1 << 13);
    }

    #[test]
    fn rules_need_the_current_version() {
        let c = Onboarding {
            rules: rules(),
            ..cfg(Requirements::default())
        };
        let behind = Facts {
            rules_version: Some(2),
            ..facts()
        };
        assert_eq!(missing(&c, &behind), [Missing::Rules { version: 3 }]);
        assert_eq!(missing(&c, &facts()), [Missing::Rules { version: 3 }]);
        let current = Facts {
            rules_version: Some(3),
            ..facts()
        };
        assert_eq!(missing(&c, &current), []);
    }

    #[test]
    fn only_required_before_questions_hold_admission() {
        let c = Onboarding {
            questions: vec![
                question("q1", true, When::Before),
                question("q2", true, When::After),
                question("q3", false, When::Before),
            ],
            ..cfg(Requirements::default())
        };
        assert_eq!(
            missing(&c, &facts()),
            [Missing::Questions {
                ids: vec!["q1".into()]
            }]
        );
        let answered = Facts {
            answered: vec!["q1".into()],
            ..facts()
        };
        assert_eq!(missing(&c, &answered), []);
    }

    #[test]
    fn approval_with_its_application() {
        let c = Onboarding {
            application: vec![prompt("a1", true), prompt("a2", false)],
            ..cfg(Requirements {
                approval: true,
                ..Requirements::default()
            })
        };
        let out = missing(&c, &facts());
        assert_eq!(
            out,
            [
                Missing::Application {
                    ids: vec!["a1".into()]
                },
                Missing::Approval
            ]
        );
        assert_eq!(sweep_at(&out), None);
        assert_eq!(sweep_at(&[]), None);
        let done = Facts {
            application_filled: vec!["a1".into()],
            approved: true,
            ..facts()
        };
        assert_eq!(missing(&c, &done), []);
    }

    #[test]
    fn managed_memberships_and_grandfathered_members_skip_everything() {
        let managed = Facts {
            managed: true,
            ..facts()
        };
        assert_eq!(missing(&everything(), &managed), []);
        let grandfathered = Facts {
            grandfathered: true,
            ..facts()
        };
        assert_eq!(missing(&everything(), &grandfathered), []);
    }

    #[test]
    fn everything_at_once_comes_in_the_order_it_is_shown() {
        let c = Onboarding {
            questions: vec![question("q1", true, When::Before)],
            ..everything()
        };
        let c = Onboarding {
            requirements: Requirements {
                account_age_minutes: 10,
                member_minutes: 5,
                ..c.requirements
            },
            ..c
        };
        let f = Facts {
            account_created_at: 1_000_000,
            ..facts()
        };
        let kinds: Vec<String> = missing(&c, &f)
            .iter()
            .map(|m| {
                serde_json::to_value(m).expect("json")["kind"]
                    .as_str()
                    .expect("kind")
                    .to_string()
            })
            .collect();
        assert_eq!(
            kinds,
            [
                "account_age",
                "member_time",
                "backup_phrase",
                "sso",
                "pow",
                "rules",
                "questions",
                "application",
                "approval"
            ]
        );
    }

    #[test]
    fn a_held_member_who_meets_every_requirement_is_not_let_back_in() {
        let f = Facts {
            gate: Gate::Held,
            hold: Some(moderator_hold()),
            grandfathered: true,
            ..facts()
        };
        assert_eq!(
            missing(&everything(), &f),
            [Missing::Held {
                hold: HoldKind::Moderator,
                by: Some("carol".into()),
                at: 5
            }]
        );
        assert_eq!(recompute(&everything(), &f), Gate::Held);
        let plain = Facts {
            gate: Gate::Held,
            hold: Some(moderator_hold()),
            ..facts()
        };
        assert_eq!(recompute(&cfg(Requirements::default()), &plain), Gate::Held);
        let unrecorded = Facts {
            gate: Gate::Held,
            ..facts()
        };
        assert_eq!(
            missing(&cfg(Requirements::default()), &unrecorded),
            [Missing::Held {
                hold: HoldKind::Moderator,
                by: None,
                at: 0
            }]
        );
    }

    #[test]
    fn a_hold_works_on_a_server_with_onboarding_off() {
        let off = Onboarding::default();
        assert!(!off.enabled);
        let f = Facts {
            gate: Gate::Held,
            hold: Some(Hold {
                kind: HoldKind::Automation,
                by: None,
                at: 1,
            }),
            ..facts()
        };
        assert_eq!(
            missing(&off, &f),
            [Missing::Held {
                hold: HoldKind::Automation,
                by: None,
                at: 1
            }]
        );
        assert_eq!(recompute(&off, &f), Gate::Held);
    }

    #[test]
    fn let_in_clears_the_hold_and_satisfies_approval() {
        let c = cfg(Requirements {
            approval: true,
            backup_phrase: true,
            ..Requirements::default()
        });
        let held = Facts {
            gate: Gate::Held,
            hold: Some(moderator_hold()),
            ..facts()
        };
        assert_eq!(let_in(&c, &held, false), Gate::Pending);
        let with_phrase = Facts {
            has_phrase: true,
            ..held.clone()
        };
        assert_eq!(let_in(&c, &with_phrase, false), Gate::In);
        assert_eq!(let_in(&c, &held, true), Gate::In);
        let locked = Facts {
            gate: Gate::RulesLock,
            rules_version: Some(2),
            ..facts()
        };
        assert_eq!(let_in(&everything(), &locked, false), Gate::RulesLock);
    }

    #[test]
    fn the_approval_window_latch_outlives_the_window() {
        assert!(latched(100, Some(200)));
        assert!(!latched(300, Some(200)));
        assert!(!latched(100, None));
        let f = Facts {
            approval_required: true,
            now: 10_000_000,
            ..facts()
        };
        let plain = cfg(Requirements::default());
        assert_eq!(missing(&plain, &f), [Missing::Approval]);
        assert_eq!(recompute(&plain, &f), Gate::Pending);
    }

    #[test]
    fn the_switch_off_reads_pending_and_rules_locks_as_in_and_keeps_holds() {
        assert_eq!(effective_gate(Gate::Pending, false), Gate::In);
        assert_eq!(effective_gate(Gate::RulesLock, false), Gate::In);
        assert_eq!(effective_gate(Gate::Held, false), Gate::Held);
        assert_eq!(effective_gate(Gate::Pending, true), Gate::Pending);
        assert_eq!(effective_gate(Gate::In, true), Gate::In);
    }

    #[test]
    fn a_rules_lock_asks_only_for_the_rules() {
        let locked = Facts {
            gate: Gate::RulesLock,
            grandfathered: true,
            rules_version: Some(2),
            ..facts()
        };
        assert_eq!(
            missing(&everything(), &locked),
            [Missing::Rules { version: 3 }]
        );
        let agreed = Facts {
            rules_version: Some(3),
            ..locked
        };
        assert_eq!(missing(&everything(), &agreed), []);
        assert_eq!(recompute(&everything(), &agreed), Gate::In);
    }

    #[test]
    fn recompute_never_moves_a_member_who_is_in() {
        let f = Facts {
            gate: Gate::In,
            ..facts()
        };
        assert_eq!(recompute(&everything(), &f), Gate::In);
        assert_eq!(recompute(&everything(), &facts()), Gate::Pending);
    }

    #[test]
    fn staff_are_never_put_under_a_rules_lock() {
        assert!(may_lock(false, 0));
        assert!(may_lock(false, MENTION_EVERYONE));
        assert!(!may_lock(true, 0));
        for bit in [MANAGE_ADMINS, KICK, DELETE_SERVER] {
            assert!(!may_lock(false, bit));
        }
    }

    #[test]
    fn gates_and_missing_have_the_stored_shapes() {
        assert_eq!(serde_json::to_string(&Gate::RulesLock).expect("json"), "3");
        assert_eq!(serde_json::from_str::<Gate>("2").expect("gate"), Gate::Held);
        assert!(serde_json::from_str::<Gate>("4").is_err());
        assert_eq!(
            serde_json::to_string(&Missing::Held {
                hold: HoldKind::ApprovalWindow,
                by: None,
                at: 9
            })
            .expect("json"),
            r#"{"kind":"held","hold":"approval_window","by":null,"at":9}"#
        );
        let empty: Onboarding = serde_json::from_str("{}").expect("config");
        assert_eq!(empty, Onboarding::default());
        assert_eq!(empty.pending_view, PendingView::ReadOnly);
    }

    fn server() -> Server {
        Server {
            text_channels: (1..=60).collect(),
            roles: [
                (10, 0),
                (11, MENTION_EVERYONE),
                (12, KICK),
                (13, MANAGE_ADMINS),
            ]
            .into_iter()
            .collect(),
            owner_bits: 4095 & !DELETE_SERVER,
        }
    }

    fn full() -> Onboarding {
        let mut q = question("q1", true, When::Before);
        q.options[0].roles = vec![10, 11];
        q.options[0].channels = vec![2, 3];
        Onboarding {
            enabled: true,
            pending_view: PendingView::WaitingRoom,
            waiting_room: vec![1],
            waiting_talk: true,
            requirements: Requirements {
                account_age_minutes: 525_600,
                member_minutes: 10_080,
                backup_phrase: true,
                sso: true,
                pow_work: 1 << 20,
                approval: true,
            },
            rules: rules(),
            questions: vec![q],
            application: vec![prompt("a1", true)],
            default_channels: vec![2, 3],
            land_channel: Some(2),
            welcome: Welcome {
                description: "A place for pixel art.".into(),
                message: "Hello".into(),
                recommended: vec![Recommended {
                    channel: 2,
                    emoji: None,
                    text: "Read the rules first".into(),
                }],
                todos: vec![
                    Todo {
                        id: "t1".into(),
                        kind: TodoKind::ReadChannel,
                        channel: Some(2),
                        text: "Read the rules".into(),
                    },
                    Todo {
                        id: "t2".into(),
                        kind: TodoKind::Custom,
                        channel: None,
                        text: "Say hi".into(),
                    },
                ],
            },
            may_give: vec![],
        }
    }

    fn problems(c: &Onboarding) -> Vec<String> {
        validate(c, &server()).into_iter().map(|p| p.path).collect()
    }

    #[test]
    fn a_full_config_at_every_limit_is_valid() {
        let mut c = full();
        assert_eq!(validate(&c, &server()), []);
        c.waiting_room = (1..=5).collect();
        c.rules.intro = "i".repeat(1000);
        c.rules.items = (0..20)
            .map(|i| Rule {
                id: format!("r{i}"),
                text: "t".repeat(300),
            })
            .collect();
        c.rules.items[0].id = "a_1234567890abcd".into();
        c.questions = (0..15)
            .map(|i| Question {
                title: "t".repeat(100),
                help: "h".repeat(200),
                options: (0..25)
                    .map(|j| Choice {
                        id: format!("c{j}"),
                        label: "l".repeat(50),
                        emoji: Some("🎮".into()),
                        description: "d".repeat(100),
                        roles: vec![10; 1],
                        channels: (1..=10).collect(),
                    })
                    .collect(),
                ..question(&format!("q{i}"), false, When::After)
            })
            .collect();
        c.questions[0].options[0].roles = vec![10, 11];
        c.application = (0..5)
            .map(|i| Prompt {
                text: "p".repeat(200),
                max: 1000,
                ..prompt(&format!("a{i}"), true)
            })
            .collect();
        c.default_channels = (1..=50).collect();
        c.welcome.description = "d".repeat(300);
        c.welcome.message = "m".repeat(2000);
        c.welcome.recommended = (1..=5)
            .map(|channel| Recommended {
                channel,
                emoji: Some("📜".into()),
                text: "t".repeat(100),
            })
            .collect();
        c.welcome.todos = (0..5)
            .map(|i| Todo {
                id: format!("t{i}"),
                kind: TodoKind::PickRoles,
                channel: None,
                text: "t".repeat(100),
            })
            .collect();
        assert_eq!(validate(&c, &server()), []);
    }

    #[test]
    fn every_limit_edge_is_refused_one_past() {
        let over = |edit: &dyn Fn(&mut Onboarding), path: &str| {
            let mut c = full();
            edit(&mut c);
            assert_eq!(problems(&c), [path], "{path}");
        };
        over(&|c| c.waiting_room = vec![], "waiting_room");
        over(&|c| c.waiting_room = (1..=6).collect(), "waiting_room");
        over(
            &|c| c.requirements.account_age_minutes = 525_601,
            "requirements.account_age_minutes",
        );
        over(
            &|c| c.requirements.member_minutes = 10_081,
            "requirements.member_minutes",
        );
        over(&|c| c.rules.intro = "i".repeat(1001), "rules.intro");
        over(
            &|c| {
                c.rules.items = (0..21)
                    .map(|i| Rule {
                        id: format!("r{i}"),
                        text: "t".into(),
                    })
                    .collect()
            },
            "rules.items",
        );
        over(
            &|c| c.rules.items[0].text = String::new(),
            "rules.items.0.text",
        );
        over(
            &|c| c.rules.items[0].text = "t".repeat(301),
            "rules.items.0.text",
        );
        over(&|c| c.rules.items[0].id = String::new(), "rules.items.0.id");
        over(
            &|c| c.rules.items[0].id = "a".repeat(17),
            "rules.items.0.id",
        );
        over(&|c| c.rules.items[0].id = "A".into(), "rules.items.0.id");
        over(
            &|c| {
                let twin = c.rules.items[0].clone();
                c.rules.items.push(twin)
            },
            "rules.items.1.id",
        );
        over(
            &|c| {
                c.questions = (0..16)
                    .map(|i| question(&format!("q{i}"), false, When::After))
                    .collect()
            },
            "questions",
        );
        over(
            &|c| c.questions[0].title = String::new(),
            "questions.0.title",
        );
        over(
            &|c| c.questions[0].title = "t".repeat(101),
            "questions.0.title",
        );
        over(
            &|c| c.questions[0].help = "h".repeat(201),
            "questions.0.help",
        );
        over(&|c| c.questions[0].options = vec![], "questions.0.options");
        over(
            &|c| {
                let o = c.questions[0].options[0].clone();
                c.questions[0].options = (0..26)
                    .map(|i| Choice {
                        id: format!("c{i}"),
                        ..o.clone()
                    })
                    .collect()
            },
            "questions.0.options",
        );
        over(
            &|c| c.questions[0].options[0].label = String::new(),
            "questions.0.options.0.label",
        );
        over(
            &|c| c.questions[0].options[0].label = "l".repeat(51),
            "questions.0.options.0.label",
        );
        over(
            &|c| c.questions[0].options[0].description = "d".repeat(101),
            "questions.0.options.0.description",
        );
        over(
            &|c| c.questions[0].options[0].roles = vec![10; 6],
            "questions.0.options.0.roles",
        );
        over(
            &|c| c.questions[0].options[0].channels = (1..=11).collect(),
            "questions.0.options.0.channels",
        );
        over(
            &|c| {
                let twin = c.questions[0].clone();
                c.questions.push(twin)
            },
            "questions.1.id",
        );
        over(
            &|c| c.application = (0..6).map(|i| prompt(&format!("a{i}"), false)).collect(),
            "application",
        );
        over(
            &|c| c.application[0].text = String::new(),
            "application.0.text",
        );
        over(
            &|c| c.application[0].text = "p".repeat(201),
            "application.0.text",
        );
        over(&|c| c.application[0].max = 0, "application.0.max");
        over(&|c| c.application[0].max = 1001, "application.0.max");
        over(&|c| c.requirements.approval = false, "application");
        over(
            &|c| c.default_channels = (1..=51).collect(),
            "default_channels",
        );
        over(
            &|c| c.welcome.description = "d".repeat(301),
            "welcome.description",
        );
        over(&|c| c.welcome.message = "m".repeat(2001), "welcome.message");
        over(
            &|c| {
                let r = c.welcome.recommended[0].clone();
                c.welcome.recommended = vec![r; 6]
            },
            "welcome.recommended",
        );
        over(
            &|c| c.welcome.recommended[0].text = "t".repeat(101),
            "welcome.recommended.0.text",
        );
        over(
            &|c| {
                c.welcome.todos = (0..6)
                    .map(|i| Todo {
                        id: format!("t{i}"),
                        kind: TodoKind::Custom,
                        channel: None,
                        text: "t".into(),
                    })
                    .collect()
            },
            "welcome.todos",
        );
        over(
            &|c| c.welcome.todos[1].text = "t".repeat(101),
            "welcome.todos.1.text",
        );
        over(
            &|c| c.welcome.todos[0].channel = None,
            "welcome.todos.0.channel",
        );
    }

    #[test]
    fn every_bad_reference_is_named() {
        let bad = |edit: &dyn Fn(&mut Onboarding), path: &str| {
            let mut c = full();
            edit(&mut c);
            assert_eq!(problems(&c), [path], "{path}");
        };
        bad(&|c| c.waiting_room = vec![99], "waiting_room.0");
        bad(&|c| c.default_channels = vec![2, 99], "default_channels.1");
        bad(&|c| c.land_channel = Some(99), "land_channel");
        bad(
            &|c| c.questions[0].options[0].channels = vec![99],
            "questions.0.options.0.channels.0",
        );
        bad(
            &|c| c.questions[0].options[0].roles = vec![99],
            "questions.0.options.0.roles.0",
        );
        bad(
            &|c| c.welcome.recommended[0].channel = 99,
            "welcome.recommended.0.channel",
        );
        bad(
            &|c| c.welcome.todos[0].channel = Some(99),
            "welcome.todos.0.channel",
        );
        bad(&|c| c.may_give = vec![99], "may_give.0");
    }

    #[test]
    fn a_choice_gives_only_roles_within_mention_everyone_unless_marked() {
        let mut c = full();
        c.questions[0].options[0].roles = vec![12];
        let out = validate(&c, &server());
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].path, "questions.0.options.0.roles.0");
        assert_eq!(out[0].reason, Reason::GivesPermissions);
        c.may_give = vec![12];
        assert_eq!(validate(&c, &server()), []);
        let mut weak = server();
        weak.owner_bits = MANAGE_ADMINS;
        let out = validate(&c, &weak);
        assert_eq!(out[0].reason, Reason::OwnerCantGrant);
        assert_eq!(grantable(&c, 12, KICK, 4095), None);
        assert_eq!(
            grantable(&full(), 12, KICK, 4095),
            Some(crate::grants::Refusal::GivesPermissions)
        );
    }

    #[test]
    fn text_is_trimmed_before_it_is_measured() {
        let mut c = full();
        c.rules.items[0].text = format!("  {}  ", "t".repeat(300));
        c.questions[0].title = "   ".into();
        assert_eq!(problems(&c), ["questions.0.title"]);
        let n = normalized(&c);
        assert_eq!(n.rules.items[0].text, "t".repeat(300));
    }

    #[test]
    fn the_rules_version_moves_only_when_the_normalized_list_changes() {
        let a = rules();
        let mut b = rules();
        b.items[0].text = "  Be kind ".into();
        b.intro = "New intro".into();
        assert!(!rules_changed(&a, &b));
        b.items[0].text = "Be kinder".into();
        assert!(rules_changed(&a, &b));
        let mut c = rules();
        c.items.push(Rule {
            id: "b".into(),
            text: "No spam".into(),
        });
        assert!(rules_changed(&a, &c));
    }
}
