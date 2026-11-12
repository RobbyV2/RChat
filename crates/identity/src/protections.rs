use std::collections::{BTreeMap, BTreeSet};

use crate::signin::{SsoMode, trusted_mode};
use crate::util::path_matches;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Key {
    NewPassword,
    Totp,
    BackupPhrase,
    Passkey,
    PasswordRules,
}

impl Key {
    pub const ALL: [Key; 5] = [
        Key::NewPassword,
        Key::Totp,
        Key::BackupPhrase,
        Key::Passkey,
        Key::PasswordRules,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Key::NewPassword => "new_password",
            Key::Totp => "totp",
            Key::BackupPhrase => "backup_phrase",
            Key::Passkey => "passkey",
            Key::PasswordRules => "password_rules",
        }
    }

    pub fn parse(name: &str) -> Option<Key> {
        Key::ALL.into_iter().find(|k| k.name() == name)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    Off,
    Admins,
    Everyone,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Instance,
    Profile,
    Server,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Requirement {
    pub key: Key,
    pub label: &'static str,
    pub step: &'static str,
    pub self_setup: bool,
    pub order: u8,
    pub built: bool,
    pub control: &'static str,
    pub grace_control: Option<&'static str>,
    pub feature: Option<&'static str>,
    pub levels: &'static [Level],
}

const ACCOUNT_LEVELS: &[Level] = &[Level::Instance, Level::Profile];

pub const REQUIREMENTS: [Requirement; 5] = [
    Requirement {
        key: Key::NewPassword,
        label: "A password of your own",
        step: "Choose your own password",
        self_setup: true,
        order: 0,
        built: true,
        control: "password_change",
        grace_control: None,
        feature: None,
        levels: ACCOUNT_LEVELS,
    },
    Requirement {
        key: Key::Totp,
        label: "Authenticator codes",
        step: "Set up an authenticator app",
        self_setup: true,
        order: 1,
        built: true,
        control: "protection_totp",
        grace_control: Some("protection_totp_grace_hours"),
        feature: Some("two_factor"),
        levels: &[Level::Instance, Level::Profile, Level::Server],
    },
    Requirement {
        key: Key::BackupPhrase,
        label: "A saved backup phrase",
        step: "Save a backup phrase",
        self_setup: true,
        order: 2,
        built: true,
        control: "protection_backup_phrase",
        grace_control: Some("protection_backup_phrase_grace_hours"),
        feature: Some("backup_phrase"),
        levels: ACCOUNT_LEVELS,
    },
    Requirement {
        key: Key::Passkey,
        label: "A passkey",
        step: "Add a passkey",
        self_setup: true,
        order: 3,
        built: false,
        control: "protection_passkey",
        grace_control: Some("protection_passkey_grace_hours"),
        feature: Some("passkeys"),
        levels: ACCOUNT_LEVELS,
    },
    Requirement {
        key: Key::PasswordRules,
        label: "A password that meets the rules here",
        step: "Choose a stronger password",
        self_setup: true,
        order: 4,
        built: false,
        control: "protection_password_rules",
        grace_control: Some("protection_password_rules_grace_hours"),
        feature: None,
        levels: ACCOUNT_LEVELS,
    },
];

pub fn requirement(key: Key) -> &'static Requirement {
    match key {
        Key::NewPassword => &REQUIREMENTS[0],
        Key::Totp => &REQUIREMENTS[1],
        Key::BackupPhrase => &REQUIREMENTS[2],
        Key::Passkey => &REQUIREMENTS[3],
        Key::PasswordRules => &REQUIREMENTS[4],
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PasswordChange {
    Required,
    Encouraged,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Controls {
    pub two_factor: bool,
    pub backup_phrase: bool,
    pub protection_totp: Scope,
    pub protection_totp_grace_hours: i64,
    pub protection_backup_phrase: Scope,
    pub protection_backup_phrase_grace_hours: i64,
    pub password_change: PasswordChange,
}

impl Default for Controls {
    fn default() -> Controls {
        Controls {
            two_factor: true,
            backup_phrase: true,
            protection_totp: Scope::Off,
            protection_totp_grace_hours: 72,
            protection_backup_phrase: Scope::Off,
            protection_backup_phrase_grace_hours: 72,
            password_change: PasswordChange::Required,
        }
    }
}

pub const NO_ADMIN_LEFT: &str = "This would leave no site admin who can sign in and meet the required protections. Set them up on an admin account first.";
pub const MAX_GRACE_HOURS: i64 = 720;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ControlsRefusal {
    pub field: &'static str,
    pub text: &'static str,
}

const TURN_OFF_FIRST: &str = "Turn off the requirement first";

pub fn check_controls(
    c: &Controls,
    before: Option<(&Controls, &[AdminFacts])>,
) -> Option<ControlsRefusal> {
    let refuse = |field, text| Some(ControlsRefusal { field, text });
    if let Some((prev, admins)) = before {
        let had = admins.iter().any(|f| usable_admin(prev, f, &[]));
        let has = admins.iter().any(|f| usable_admin(c, f, &[]));
        if had && !has {
            let changed = [
                ("protection_totp", prev.protection_totp != c.protection_totp),
                ("two_factor", prev.two_factor != c.two_factor),
                (
                    "protection_backup_phrase",
                    prev.protection_backup_phrase != c.protection_backup_phrase,
                ),
                ("backup_phrase", prev.backup_phrase != c.backup_phrase),
            ];
            let field = changed
                .iter()
                .find(|(_, changed)| *changed)
                .map_or("protection_totp", |(key, _)| *key);
            return refuse(field, NO_ADMIN_LEFT);
        }
    }
    let turned_off = |was: fn(&Controls) -> bool| before.is_some_and(|(prev, _)| was(prev));
    if c.protection_totp != Scope::Off && !c.two_factor {
        return match turned_off(|p| p.two_factor) {
            true => refuse("two_factor", TURN_OFF_FIRST),
            false => refuse("protection_totp", "Turn on authenticator codes first"),
        };
    }
    if c.protection_backup_phrase != Scope::Off && !c.backup_phrase {
        return match turned_off(|p| p.backup_phrase) {
            true => refuse("backup_phrase", TURN_OFF_FIRST),
            false => refuse("protection_backup_phrase", "Turn on backup phrases first"),
        };
    }
    let grace = [
        ("protection_totp_grace_hours", c.protection_totp_grace_hours),
        (
            "protection_backup_phrase_grace_hours",
            c.protection_backup_phrase_grace_hours,
        ),
    ];
    grace
        .iter()
        .find(|(_, h)| !(0..=MAX_GRACE_HOURS).contains(h))
        .and_then(|(field, _)| refuse(*field, "Grace must be 0 to 720 hours"))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Temp {
    pub expires_at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Account {
    pub uid: i64,
    pub is_site_admin: bool,
    pub totp_on: bool,
    pub phrase_set: bool,
    pub temp: Option<Temp>,
    pub passwordless: bool,
    pub sso: Option<SsoMode>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Via {
    Password,
    Phrase,
    Sso,
    Device,
    Forward,
    Register,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Session {
    pub via: Via,
    pub amr: Vec<String>,
}

fn scoped(scope: Scope, a: &Account) -> bool {
    match scope {
        Scope::Everyone => true,
        Scope::Admins => a.is_site_admin,
        Scope::Off => false,
    }
}

pub fn instance_requires(c: &Controls, key: Key, a: &Account) -> bool {
    match key {
        Key::NewPassword => a.temp.is_some(),
        Key::Totp => c.two_factor && scoped(c.protection_totp, a),
        Key::BackupPhrase => c.backup_phrase && scoped(c.protection_backup_phrase, a),
        Key::Passkey | Key::PasswordRules => false,
    }
}

pub fn required(c: &Controls, a: &Account, profile: &[Key]) -> Vec<Key> {
    REQUIREMENTS
        .iter()
        .filter(|r| r.built)
        .filter(|r| {
            instance_requires(c, r.key, a)
                || (profile.contains(&r.key)
                    && match r.key {
                        Key::NewPassword => a.temp.is_some(),
                        Key::Totp => c.two_factor,
                        Key::BackupPhrase => c.backup_phrase,
                        Key::Passkey | Key::PasswordRules => false,
                    })
        })
        .map(|r| r.key)
        .collect()
}

pub fn sso_covers(mode: Option<SsoMode>, amr: &[String]) -> bool {
    mode.is_some_and(|m| trusted_mode(m, amr))
}

pub fn met_by_session(key: Key, a: &Account, s: &Session) -> bool {
    match (key, s.via) {
        (Key::NewPassword, _) => a.temp.is_none(),
        (Key::Totp, Via::Sso | Via::Forward) => {
            s.amr.iter().any(|v| v == "otp") || sso_covers(a.sso, &s.amr)
        }
        (Key::Totp, Via::Password | Via::Phrase | Via::Device | Via::Register) => a.totp_on,
        (Key::BackupPhrase, _) => a.phrase_set,
        (Key::Passkey | Key::PasswordRules, _) => true,
    }
}

pub fn met_by_account(key: Key, a: &Account) -> bool {
    match key {
        Key::NewPassword => a.temp.is_none(),
        Key::Totp => a.totp_on || (a.passwordless && a.sso == Some(SsoMode::Provider)),
        Key::BackupPhrase => a.phrase_set,
        Key::Passkey | Key::PasswordRules => true,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GraceRow {
    pub required_since: i64,
    pub grace_until: Option<i64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Met,
    Grace { deadline: Option<i64> },
    Overdue,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeyState {
    pub key: Key,
    pub state: State,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    PasswordChange,
    Setup,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Evaluation {
    pub states: Vec<KeyState>,
    pub insert: Vec<Key>,
    pub remove: Vec<Key>,
    pub restricted: bool,
    pub next: Option<Key>,
    pub reason: Option<Reason>,
}

fn grace_hours(c: &Controls, key: Key) -> i64 {
    match key {
        Key::Totp => c.protection_totp_grace_hours,
        Key::BackupPhrase => c.protection_backup_phrase_grace_hours,
        Key::NewPassword | Key::Passkey | Key::PasswordRules => 0,
    }
}

pub fn evaluate(
    c: &Controls,
    a: &Account,
    s: &Session,
    now: i64,
    rows: &BTreeMap<Key, GraceRow>,
    profile: &[Key],
) -> Evaluation {
    let mut states = Vec::new();
    let mut insert = Vec::new();
    for key in required(c, a, profile) {
        let state = match (met_by_session(key, a, s), key) {
            (true, _) => State::Met,
            (false, Key::NewPassword) => {
                let strict = c.password_change == PasswordChange::Required
                    || profile.contains(&Key::NewPassword);
                let expires = a.temp.and_then(|t| t.expires_at);
                match strict || expires.is_some_and(|at| now >= at) {
                    true => State::Overdue,
                    false => State::Grace { deadline: expires },
                }
            }
            (false, Key::Totp | Key::BackupPhrase | Key::Passkey | Key::PasswordRules) => {
                let row = rows.get(&key).copied().unwrap_or_else(|| {
                    insert.push(key);
                    GraceRow {
                        required_since: now,
                        grace_until: None,
                    }
                });
                let after = grace_hours(c, key).saturating_mul(3600);
                let deadline = row
                    .grace_until
                    .unwrap_or_else(|| row.required_since.saturating_add(after));
                match now >= deadline {
                    true => State::Overdue,
                    false => State::Grace {
                        deadline: Some(deadline),
                    },
                }
            }
        };
        states.push(KeyState { key, state });
    }
    let unmet = |x: &&KeyState| x.state != State::Met;
    let keep: BTreeSet<Key> = states.iter().filter(unmet).map(|x| x.key).collect();
    let remove = rows.keys().filter(|k| !keep.contains(k)).copied().collect();
    let overdue: Vec<Key> = states
        .iter()
        .filter(|x| x.state == State::Overdue)
        .map(|x| x.key)
        .collect();
    let reason = match (overdue.is_empty(), overdue.contains(&Key::NewPassword)) {
        (true, _) => None,
        (false, true) => Some(Reason::PasswordChange),
        (false, false) => Some(Reason::Setup),
    };
    Evaluation {
        next: states.iter().find(unmet).map(|x| x.key),
        states,
        insert,
        remove,
        restricted: !overdue.is_empty(),
        reason,
    }
}

pub fn restriction_text(reason: Reason) -> &'static str {
    match reason {
        Reason::PasswordChange => "Change your password first",
        Reason::Setup => "Finish setting up your account first",
    }
}

const ALWAYS: [(&str, &str); 18] = [
    ("GET", "/me"),
    ("GET", "/me/policy"),
    ("GET", "/me/protections"),
    ("POST", "/auth/logout"),
    ("GET", "/auth/words/{}"),
    ("GET", "/settings"),
    ("GET", "/instance"),
    ("GET", "/brand"),
    ("POST", "/me/password"),
    ("GET", "/me/two_factor"),
    ("POST", "/me/two_factor/totp"),
    ("PUT", "/me/two_factor/totp"),
    ("GET", "/me/recovery"),
    ("PUT", "/me/recovery"),
    ("POST", "/auth/recovery/challenge"),
    ("GET", "/me/sessions"),
    ("DELETE", "/me/sessions/{}"),
    ("POST", "/me/sessions/sign_out_others"),
];

const FIX: [(&str, &str); 3] = [
    ("GET", "/admin/config"),
    ("GET", "/admin/protections"),
    ("PATCH", "/admin/settings"),
];

pub const PROTECTION_KEYS: [&str; 4] = [
    "protection_totp",
    "protection_totp_grace_hours",
    "protection_backup_phrase",
    "protection_backup_phrase_grace_hours",
];

pub fn only_protection_keys<S: AsRef<str>>(keys: &[S]) -> bool {
    keys.iter().all(|k| PROTECTION_KEYS.contains(&k.as_ref()))
}

pub fn allowed_while_restricted(
    method: &str,
    path: &str,
    is_site_admin: bool,
    no_usable_admin: bool,
) -> bool {
    let listed = |routes: &[(&str, &str)]| {
        routes
            .iter()
            .any(|(m, pattern)| *m == method && path_matches(pattern, path))
    };
    listed(&ALWAYS) || (is_site_admin && no_usable_admin && listed(&FIX))
}

pub const MENTION_EVERYONE: u32 = 32;
pub const ALL_PERMS: u32 = 1023;
pub const MOD_PERMS: u32 = ALL_PERMS & !MENTION_EVERYONE;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServerRule {
    pub mod_totp: bool,
    pub totp_roles: BTreeSet<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Member {
    pub is_admin: bool,
    pub perms: u32,
    pub roles: BTreeMap<i64, u32>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServerPerms {
    pub perms: u32,
    pub inactive_roles: Vec<i64>,
    pub masked: u32,
}

pub fn server_perms(m: &Member, rule: &ServerRule, totp_met: bool) -> ServerPerms {
    let inactive = |id: &i64| !totp_met && rule.totp_roles.contains(id);
    let inactive_roles: Vec<i64> = m.roles.keys().filter(|id| inactive(id)).copied().collect();
    let role_bits = m
        .roles
        .iter()
        .filter(|(id, _)| !inactive(id))
        .fold(0, |bits, (_, role)| bits | role);
    let before = match (m.is_admin, m.perms) {
        (true, 0) => ALL_PERMS,
        (true, perms) => perms & ALL_PERMS,
        (false, _) => role_bits & ALL_PERMS,
    };
    let perms = match rule.mod_totp && !totp_met {
        true => before & !MOD_PERMS,
        false => before,
    };
    ServerPerms {
        perms,
        inactive_roles,
        masked: before & !perms,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MaskReason {
    pub kind: &'static str,
    pub control: &'static str,
}

pub fn mask_reason(by_role: bool) -> MaskReason {
    MaskReason {
        kind: "off_server",
        control: match by_role {
            true => "role.requires_totp",
            false => "mod_totp",
        },
    }
}

pub fn may_change_server_rule(
    on: bool,
    actor_totp_met: bool,
    actor_may_edit: bool,
    is_creator: bool,
) -> bool {
    (actor_may_edit || is_creator) && (!on || actor_totp_met)
}

pub fn reason_text(_key: Key) -> &'static str {
    "This instance requires it."
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdminFacts {
    pub account: Account,
    pub can_sign_in: bool,
}

pub fn usable_admin(c: &Controls, f: &AdminFacts, profile: &[Key]) -> bool {
    f.account.is_site_admin
        && f.can_sign_in
        && required(c, &f.account, profile)
            .into_iter()
            .all(|k| met_by_account(k, &f.account))
}

pub fn unenforceable(c: &Controls, key: Key) -> Option<&'static str> {
    match (key, c.two_factor, c.backup_phrase) {
        (Key::Totp, false, _) => Some("Can't be required: authenticator codes are off"),
        (Key::BackupPhrase, _, false) => Some("Can't be required: backup phrases are off"),
        (_, _, _) => None,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cleared {
    pub account: Account,
    pub rows: BTreeMap<Key, GraceRow>,
    pub cleared: Vec<Key>,
    pub audit: &'static str,
}

pub fn clear_protections(a: &Account, now: i64, all: bool) -> Cleared {
    let cleared = match all {
        true => vec![Key::Totp, Key::BackupPhrase],
        false => vec![Key::Totp],
    };
    let row = GraceRow {
        required_since: now,
        grace_until: None,
    };
    Cleared {
        account: Account {
            totp_on: false,
            phrase_set: !all && a.phrase_set,
            ..a.clone()
        },
        rows: cleared.iter().map(|k| (*k, row)).collect(),
        cleared,
        audit: "user.clear_protections",
    }
}
