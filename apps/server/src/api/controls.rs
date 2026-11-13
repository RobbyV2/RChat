use std::collections::HashMap;
use std::sync::LazyLock;

use sqlx::Row;

use crate::api::features::{Feature, Registration};
use crate::api::policy::{
    CALLS, Creator, DEFAULT_SERVERS, DmCreation, FRIEND_REQUESTS, INCOMING_WEBHOOKS,
    PUBLIC_READING, SERVER_CREATORS, SERVER_SEARCH, ServerCreation, ServerJoining,
};
use crate::api::reports::forms::{self, ReportForms};
use crate::api::{ProfanitySwitch, ProfanityTargets, PublicSettings, upload_expiry};
use crate::db::{ConfigStart, Db};
use crate::limits::Env;
use crate::state::AppState;
use crate::ws::WsEvent;

/// How a control's value is written in the env, in the `settings` table and by the admin page.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// On or off (also true/false, yes/no, 1/0), stored as `1` or `0`.
    Switch,
    /// One of the words.
    Choice(&'static [&'static str]),
    /// The profanity targets: `all`, `none` or a comma list of target names, stored as one row
    /// per target.
    Targets,
    /// A whole number from `min` to `max`.
    Number { min: i64, max: i64 },
    /// A comma list of up to 500 usernames and `server:role` entries.
    Names,
    /// The report forms, a JSON document. The env names a file that holds it, and the stored
    /// value is the document with the revision the instance counts.
    Forms,
    /// A comma list of up to 10 server names, or `none`, stored as the servers' keys.
    Servers,
}

/// Something the site admin page changes while the server runs: one or more rows of the
/// `settings` table, with one env name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Control {
    /// The name in `Settings` and in the `settings` table.
    pub key: &'static str,
    pub env: &'static str,
    pub kind: Kind,
    /// The stored value when neither the env nor the admin page set one.
    pub default: &'static str,
    /// Whether `GET /api/v1/settings` shows it.
    pub public: bool,
}

/// The env name that pins controls to the server config.
pub const PINNED_ENV: &str = "SETTINGS_PINNED";

const fn switch(key: &'static str, env: &'static str, on: bool) -> Control {
    Control {
        key,
        env,
        kind: Kind::Switch,
        default: match on {
            true => "1",
            false => "0",
        },
        public: true,
    }
}

static CONTROLS: LazyLock<Vec<Control>> = LazyLock::new(|| {
    let mut all = vec![
        switch("profanity_filter", "PROFANITY_FILTER", false),
        Control {
            key: "profanity_targets",
            env: "PROFANITY_TARGETS",
            kind: Kind::Targets,
            default: "all",
            public: true,
        },
        switch("asset_previews", "FEATURE_LINK_PREVIEWS", true),
        switch("asset_uploads", "FEATURE_FILE_UPLOADS", true),
        switch("p2p_attachments", "P2P_ATTACHMENTS", true),
        switch("guests_enabled", "GUESTS_ENABLED", true),
        switch("outgoing_webhooks", "OUTGOING_WEBHOOKS", false),
    ];
    all.extend(
        Feature::ALL
            .into_iter()
            .map(|f| switch(f.key(), f.env(), f.default_on())),
    );
    all.push(Control {
        key: Registration::KEY,
        env: Registration::ENV,
        kind: Kind::Choice(&["open", "sso", "closed"]),
        default: "open",
        public: true,
    });
    all.push(Control {
        key: upload_expiry::CAP_KEY,
        env: "UPLOAD_EXPIRY_MAX_DAYS",
        kind: Kind::Number {
            min: 0,
            max: upload_expiry::CAP_DAYS_MAX,
        },
        default: "0",
        public: true,
    });
    all.push(Control {
        key: ServerCreation::KEY,
        env: ServerCreation::ENV,
        kind: Kind::Choice(&ServerCreation::WORDS),
        default: "everyone",
        public: true,
    });
    all.push(Control {
        key: SERVER_CREATORS,
        env: "SERVER_CREATORS",
        kind: Kind::Names,
        default: "",
        public: false,
    });
    all.push(Control {
        key: ServerJoining::KEY,
        env: ServerJoining::ENV,
        kind: Kind::Choice(&ServerJoining::WORDS),
        default: "everyone",
        public: true,
    });
    all.push(switch(SERVER_SEARCH, "SERVER_SEARCH", true));
    all.push(Control {
        key: DmCreation::KEY,
        env: DmCreation::ENV,
        kind: Kind::Choice(&DmCreation::WORDS),
        default: "everyone",
        public: true,
    });
    all.push(switch(FRIEND_REQUESTS, "FEATURE_FRIEND_REQUESTS", true));
    all.push(switch(PUBLIC_READING, "PUBLIC_READING", true));
    all.push(Control {
        key: DEFAULT_SERVERS,
        env: "DEFAULT_SERVERS",
        kind: Kind::Servers,
        default: crate::db::BUILTIN_SERVER,
        public: false,
    });
    all.push(switch(CALLS, "FEATURE_CALLS", true));
    all.push(switch(INCOMING_WEBHOOKS, "FEATURE_INCOMING_WEBHOOKS", true));
    all.push(Control {
        key: forms::KEY,
        env: forms::ENV,
        kind: Kind::Forms,
        default: Box::leak(ReportForms::defaults().stored().into_boxed_str()),
        public: false,
    });
    all
});

/// Reads the `settings` rows of every control, the retired `profanity_display_names` that
/// `Settings::load` still warns about, and whether the built-in server is kept.
pub(crate) static ROWS_SQL: LazyLock<String> = LazyLock::new(|| {
    let keys: Vec<String> = Control::all()
        .iter()
        .flat_map(|c| c.keys())
        .chain(["profanity_display_names", crate::db::BUILTIN_STATE])
        .map(|key| format!("'{key}'"))
        .collect();
    format!(
        "SELECT key, value FROM settings WHERE key IN ({})",
        keys.join(", ")
    )
});

impl Control {
    /// Every control, in the order the admin page's config list shows them.
    pub fn all() -> &'static [Control] {
        &CONTROLS
    }

    pub fn find(key: &str) -> Option<&'static Control> {
        Control::all().iter().find(|c| c.key == key)
    }

    pub fn by_env(env: &str) -> Option<&'static Control> {
        Control::all().iter().find(|c| c.env == env)
    }

    /// The stored form of `raw`, a value written in the env (for the forms: the text of the
    /// file the env names). An error says what was expected.
    pub fn parse(&self, raw: &str) -> Result<String, String> {
        let word = raw.trim().to_ascii_lowercase();
        match self.kind {
            Kind::Switch => match word.as_str() {
                "on" | "true" | "yes" | "1" => Ok("1".to_string()),
                "off" | "false" | "no" | "0" => Ok("0".to_string()),
                _ => Err("expected on or off".to_string()),
            },
            Kind::Choice(words) => match words.iter().find(|w| **w == word) {
                Some(word) => Ok(word.to_string()),
                None => Err(format!("expected {}", any_of(words))),
            },
            Kind::Targets => parse_targets(&word).map(stored_targets).ok_or_else(|| {
                let names: Vec<&str> = ProfanitySwitch::ALL.into_iter().map(|t| t.name()).collect();
                format!("expected all, none or a list of {}", names.join(", "))
            }),
            Kind::Number { min, max } => word
                .parse::<i64>()
                .ok()
                .filter(|n| (min..=max).contains(n))
                .map(|n| n.to_string())
                .ok_or_else(|| format!("expected {min} to {max}")),
            Kind::Names => parse_names(raw).ok_or_else(|| {
                format!("expected up to {NAMES_MAX} usernames or server:role entries")
            }),
            Kind::Forms => ReportForms::parse(raw).map(|forms| {
                ReportForms {
                    rev: 1,
                    forms: forms.forms,
                }
                .stored()
            }),
            Kind::Servers => match word.as_str() {
                "none" => Ok(String::new()),
                _ => parse_servers(raw)
                    .ok_or_else(|| format!("expected none or up to {SERVERS_MAX} server names")),
            },
        }
    }

    /// A stored value as the env and the admin page write it.
    pub fn shown(&self, stored: &str) -> String {
        match (self.kind, stored) {
            (Kind::Switch, "1") => "on".to_string(),
            (Kind::Switch, _) => "off".to_string(),
            (Kind::Servers, "") => "none".to_string(),
            (
                Kind::Choice(_)
                | Kind::Targets
                | Kind::Number { min: _, max: _ }
                | Kind::Names
                | Kind::Servers,
                stored,
            ) => stored.to_string(),
            (Kind::Forms, stored) => match ReportForms::from_stored(stored) {
                Some(forms) => format!("rev {}, {} categories", forms.rev, forms.forms.len()),
                None => "unreadable".to_string(),
            },
        }
    }

    /// Whether the stored value `stored` already says what the env value `env` says.
    pub fn same(&self, stored: &str, env: &str) -> bool {
        match self.kind {
            Kind::Switch
            | Kind::Choice(_)
            | Kind::Targets
            | Kind::Number { min: _, max: _ }
            | Kind::Names
            | Kind::Servers => stored == env,
            Kind::Forms => match (
                ReportForms::from_stored(stored),
                ReportForms::from_stored(env),
            ) {
                (Some(stored), Some(env)) => stored.forms == env.forms,
                (_, _) => stored == env,
            },
        }
    }

    /// What to store when the env value `env` replaces the stored value `stored`: `env`, and
    /// for the forms the next revision after the stored one.
    pub fn applied(&self, stored: &str, env: &str) -> String {
        match self.kind {
            Kind::Switch
            | Kind::Choice(_)
            | Kind::Targets
            | Kind::Number { min: _, max: _ }
            | Kind::Names
            | Kind::Servers => env.to_string(),
            Kind::Forms => match (
                ReportForms::from_stored(stored),
                ReportForms::from_stored(env),
            ) {
                (Some(stored), Some(env)) => ReportForms {
                    rev: stored.rev + 1,
                    forms: env.forms,
                }
                .stored(),
                (_, _) => env.to_string(),
            },
        }
    }

    /// The `settings` rows that hold it.
    pub fn keys(&self) -> Vec<&'static str> {
        match self.kind {
            Kind::Switch
            | Kind::Choice(_)
            | Kind::Number { min: _, max: _ }
            | Kind::Names
            | Kind::Forms
            | Kind::Servers => {
                vec![self.key]
            }
            Kind::Targets => ProfanitySwitch::ALL.into_iter().map(|t| t.key()).collect(),
        }
    }

    /// The `settings` rows of the stored value `stored`.
    pub fn rows(&self, stored: &str) -> Vec<(&'static str, String)> {
        match self.kind {
            Kind::Switch
            | Kind::Choice(_)
            | Kind::Number { min: _, max: _ }
            | Kind::Names
            | Kind::Forms
            | Kind::Servers => {
                vec![(self.key, stored.to_string())]
            }
            Kind::Targets => {
                let targets = parse_targets(stored).unwrap_or(ProfanityTargets::ALL);
                ProfanitySwitch::ALL
                    .into_iter()
                    .map(|t| (t.key(), u8::from(targets.get(t)).to_string()))
                    .collect()
            }
        }
    }

    /// The stored value in `rows` (`settings` rows by key), `None` when no row holds it.
    pub fn read(&self, rows: &HashMap<String, String>) -> Option<String> {
        match self.kind {
            Kind::Switch
            | Kind::Choice(_)
            | Kind::Number { min: _, max: _ }
            | Kind::Names
            | Kind::Forms
            | Kind::Servers => rows.get(self.key).cloned(),
            Kind::Targets => ProfanitySwitch::ALL
                .into_iter()
                .any(|t| rows.contains_key(t.key()))
                .then(|| {
                    stored_targets(ProfanityTargets::from_fn(|t| {
                        rows.get(t.key()).is_none_or(|v| v == "1")
                    }))
                }),
        }
    }
}

/// The most entries a list of names holds.
pub const NAMES_MAX: usize = 500;

/// A comma list of usernames and `server:role` entries as it is stored: each entry as written,
/// trimmed, without empty or repeated entries. `None` for more than `NAMES_MAX` entries, an
/// entry longer than two names, a NUL, or a role entry without its server or its role.
fn parse_names(list: &str) -> Option<String> {
    let mut seen = Vec::new();
    let mut kept = Vec::new();
    for entry in list.split(',').map(str::trim).filter(|e| !e.is_empty()) {
        if entry.contains('\0') || entry.chars().count() > 2 * crate::api::NAME_MAX + 1 {
            return None;
        }
        if entry.starts_with(':') || entry.ends_with(':') {
            return None;
        }
        let who = Creator::parse(entry);
        if !seen.contains(&who) {
            seen.push(who);
            kept.push(entry);
        }
        if kept.len() > NAMES_MAX {
            return None;
        }
    }
    Some(kept.join(","))
}

/// The most servers the list of default servers holds.
pub const SERVERS_MAX: usize = 10;

/// A comma list of server names as it is stored: each server's key (its name in lowercase),
/// in the order written, without empty or repeated entries. `None` for more than
/// `SERVERS_MAX` entries, a name longer than a server name, or a NUL.
pub(crate) fn parse_servers(list: &str) -> Option<String> {
    let mut kept: Vec<String> = Vec::new();
    for entry in list.split(',').map(str::trim).filter(|e| !e.is_empty()) {
        if entry.contains('\0') || entry.chars().count() > crate::api::NAME_MAX {
            return None;
        }
        let key = entry.to_lowercase();
        if !kept.contains(&key) {
            kept.push(key);
        }
        if kept.len() > SERVERS_MAX {
            return None;
        }
    }
    Some(kept.join(","))
}

/// `a, b or c`.
fn any_of(words: &[&str]) -> String {
    match words {
        [] => String::new(),
        [only] => only.to_string(),
        [first @ .., last] => format!("{} or {last}", first.join(", ")),
    }
}

/// The targets a list names: `all`, `none`, target names, or `none` with the names that stay
/// on. The retired `display_names` is skipped. `None` for an unknown name or an empty list.
fn parse_targets(list: &str) -> Option<ProfanityTargets> {
    let names: Vec<&str> = list
        .split(',')
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .collect();
    let retired = names
        .iter()
        .any(|n| n.eq_ignore_ascii_case(crate::api::DEPRECATED_DISPLAY_NAMES));
    if retired {
        crate::api::warn_display_names();
    }
    let names: Vec<&str> = names
        .into_iter()
        .filter(|n| !n.eq_ignore_ascii_case(crate::api::DEPRECATED_DISPLAY_NAMES))
        .collect();
    let word = |w: &str| names.iter().any(|n| n.eq_ignore_ascii_case(w));
    let known = |n: &str| ProfanitySwitch::parse(n).is_some();
    if names
        .iter()
        .any(|n| !known(n) && !n.eq_ignore_ascii_case("all") && !n.eq_ignore_ascii_case("none"))
    {
        return None;
    }
    match (names.is_empty(), word("all")) {
        (true, _) => retired.then_some(ProfanityTargets::ALL),
        (false, true) => Some(ProfanityTargets::ALL),
        (false, false) => Some(ProfanityTargets::from_fn(|t| {
            names.iter().any(|n| ProfanitySwitch::parse(n) == Some(t))
        })),
    }
}

/// `all`, `none`, or the names of the targets that are on.
fn stored_targets(targets: ProfanityTargets) -> String {
    let on: Vec<&str> = ProfanitySwitch::ALL
        .into_iter()
        .filter(|t| targets.get(*t))
        .map(|t| t.name())
        .collect();
    match on.len() {
        0 => "none".to_string(),
        n if n == ProfanitySwitch::ALL.len() => "all".to_string(),
        _ => on.join(","),
    }
}

/// The controls the env sets and pins, checked at start: a switch is on or off (also
/// true/false, yes/no, 1/0), a choice is one of its words, and `SETTINGS_PINNED` lists env
/// names of controls that are set, or `all`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ControlSeeds {
    /// The controls the env sets (by key), with their stored values.
    pub set: Vec<(&'static str, String)>,
    /// Keys of the controls that follow the env at every start and are read-only in the page.
    pub pinned: Vec<&'static str>,
}

impl ControlSeeds {
    pub fn load(env: &dyn Fn(&str) -> Option<String>) -> anyhow::Result<ControlSeeds> {
        let e = Env(env);
        let mut set = Vec::new();
        for c in Control::all() {
            let Some(raw) = e.raw(c.env) else {
                continue;
            };
            let stored = match c.kind {
                Kind::Switch
                | Kind::Choice(_)
                | Kind::Targets
                | Kind::Number { min: _, max: _ }
                | Kind::Names
                | Kind::Servers => c
                    .parse(&raw)
                    .map_err(|expected| anyhow::anyhow!("{}: {expected}, got {raw}", c.env))?,
                Kind::Forms => {
                    let path = raw.trim();
                    let text = std::fs::read_to_string(path)
                        .map_err(|e| anyhow::anyhow!("{} ({path}): {e}", c.env))?;
                    c.parse(&text)
                        .map_err(|wrong| anyhow::anyhow!("{} ({path}): {wrong}", c.env))?
                }
            };
            set.push((c.key, stored));
        }
        let names: Vec<String> = e
            .raw(PINNED_ENV)
            .unwrap_or_default()
            .split(',')
            .map(|n| n.trim().to_ascii_uppercase())
            .filter(|n| !n.is_empty())
            .collect();
        let mut pinned = Vec::new();
        for name in names.iter().filter(|n| *n != "ALL") {
            let Some(c) = Control::by_env(name) else {
                anyhow::bail!("{PINNED_ENV} names {name}, which the admin page does not control");
            };
            if !set.iter().any(|(key, _)| *key == c.key) {
                anyhow::bail!("{PINNED_ENV} names {name}, but it is not set");
            }
            if !pinned.contains(&c.key) {
                pinned.push(c.key);
            }
        }
        if names.iter().any(|n| n == "ALL") {
            pinned = set.iter().map(|(key, _)| *key).collect();
        }
        Ok(ControlSeeds { set, pinned })
    }

    /// The stored form of the value the env gives `key`.
    pub fn value(&self, key: &str) -> Option<&str> {
        self.set
            .iter()
            .find(|(k, _)| *k == key)
            .map(|(_, v)| v.as_str())
    }

    pub fn pins(&self, key: &str) -> bool {
        self.pinned.contains(&key)
    }

    /// The seeds of an env given as pairs.
    #[cfg(test)]
    pub(crate) fn of(pairs: &[(&str, &str)]) -> anyhow::Result<ControlSeeds> {
        let set: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        ControlSeeds::load(&|name| set.get(name).cloned())
    }
}

/// The stored value `stored` of the number control `key`, or its default when it has no row.
/// `None` when no number can be read: `key` has no registry line, or the value is not a whole
/// number. A caller must never take that for a number of its own choosing.
pub(crate) fn number(key: &str, stored: Option<&str>) -> Option<i64> {
    let control = Control::find(key)?;
    let Kind::Number { min, max } = control.kind else {
        return None;
    };
    stored
        .unwrap_or(control.default)
        .trim()
        .parse::<i64>()
        .ok()
        .map(|n| n.clamp(min, max))
}

/// What a start that changed stored controls from the server config still owes: files re-timed
/// under a changed upload expiry cap, and the settings told to every client, once.
pub async fn config_applied(state: &AppState) {
    let ConfigStart {
        changes,
        forgotten: _,
    } = crate::db::take_config_start(&state.db);
    if changes.is_empty() {
        return;
    }
    if let Some(cap) = changes.iter().find(|c| c.key == upload_expiry::CAP_KEY)
        && let Err(e) = upload_expiry::retime_from_config(&state.db, &cap.to).await
    {
        tracing::warn!("files were not re-timed under the new upload expiry cap: {e}");
    }
    let settings = PublicSettings::load(&state.db).await;
    state.hub.broadcast(WsEvent::SettingsChanged { settings });
}

/// The `settings` rows that say what the server config set and pins: `env:<key>` for each
/// control the env set at its last start, and the keys of the pinned controls.
pub(crate) struct ConfigRecords {
    rows: HashMap<String, String>,
}

impl ConfigRecords {
    pub(crate) async fn load(db: &Db) -> sqlx::Result<ConfigRecords> {
        let mut rows = HashMap::new();
        for row in sqlx::query("SELECT key, value FROM settings WHERE key LIKE 'env:%'")
            .fetch_all(db)
            .await?
        {
            rows.insert(row.try_get::<String, _>(0)?, row.try_get::<String, _>(1)?);
        }
        Ok(ConfigRecords { rows })
    }

    /// The stored form of what the env said for `control` at the last start that set it.
    pub(crate) fn config(&self, control: &Control) -> Option<&str> {
        self.rows
            .get(&format!("env:{}", control.key))
            .map(String::as_str)
    }

    pub(crate) fn pins(&self, control: &Control) -> bool {
        self.rows
            .get(crate::db::PINNED)
            .is_some_and(|keys| keys.split(',').any(|key| key == control.key))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::{Control, ControlSeeds, Kind, PINNED_ENV};
    use crate::api::ProfanitySwitch;
    use crate::api::features::{Feature, Registration};

    const TARGETS: &str = "messages,links,usernames,server_names,channel_names,role_names,file_names,bios,channel_topics,category_names";

    fn control(key: &str) -> &'static Control {
        Control::find(key).unwrap_or_else(|| panic!("{key} is a control"))
    }

    #[test]
    fn every_control_has_its_key_env_kind_and_default() {
        let table: Vec<(&str, &str, &str)> = Control::all()
            .iter()
            .map(|c| (c.key, c.env, c.default))
            .collect();
        assert_eq!(
            table[..7],
            [
                ("profanity_filter", "PROFANITY_FILTER", "0"),
                ("profanity_targets", "PROFANITY_TARGETS", "all"),
                ("asset_previews", "FEATURE_LINK_PREVIEWS", "1"),
                ("asset_uploads", "FEATURE_FILE_UPLOADS", "1"),
                ("p2p_attachments", "P2P_ATTACHMENTS", "1"),
                ("guests_enabled", "GUESTS_ENABLED", "1"),
                ("outgoing_webhooks", "OUTGOING_WEBHOOKS", "0"),
            ]
        );
        for f in Feature::ALL {
            let c = control(f.key());
            assert_eq!((c.env, c.kind), (f.env(), Kind::Switch), "{f:?}");
            assert_eq!(c.default == "1", f.default_on(), "{f:?}");
        }
        assert_eq!(
            table[table.len() - 12..table.len() - 1],
            [
                ("upload_expiry_max_days", "UPLOAD_EXPIRY_MAX_DAYS", "0"),
                ("server_creation", "SERVER_CREATION", "everyone"),
                ("server_creators", "SERVER_CREATORS", ""),
                ("server_joining", "SERVER_JOINING", "everyone"),
                ("server_search", "SERVER_SEARCH", "1"),
                ("dm_creation", "DM_CREATION", "everyone"),
                ("friend_requests", "FEATURE_FRIEND_REQUESTS", "1"),
                ("public_reading", "PUBLIC_READING", "1"),
                ("default_servers", "DEFAULT_SERVERS", "rchat"),
                ("calls", "FEATURE_CALLS", "1"),
                ("incoming_webhooks", "FEATURE_INCOMING_WEBHOOKS", "1"),
            ]
        );
        assert_eq!(control("public_reading").kind, Kind::Switch);
        assert_eq!(control("default_servers").kind, Kind::Servers);
        assert!(!control("default_servers").public);
        assert_eq!(
            control("upload_expiry_max_days").kind,
            Kind::Number { min: 0, max: 365 }
        );
        assert_eq!(
            control("dm_creation").kind,
            Kind::Choice(&["everyone", "friends", "nobody"])
        );
        assert_eq!(control("friend_requests").kind, Kind::Switch);
        assert_eq!(
            table.last().map(|(key, env, _)| (*key, *env)),
            Some(("report_forms", "REPORT_FORMS_FILE"))
        );
        assert_eq!(
            control("server_joining").kind,
            Kind::Choice(&["everyone", "invites", "nobody"])
        );
        assert_eq!(control("server_search").kind, Kind::Switch);
        assert_eq!(
            control("server_creation").kind,
            Kind::Choice(&["everyone", "nobody", "some"])
        );
        assert_eq!(control("server_creators").kind, Kind::Names);
        let registration = control(Registration::KEY);
        assert_eq!(registration.env, Registration::ENV);
        assert_eq!(registration.kind, Kind::Choice(&["open", "sso", "closed"]));
        assert_eq!(registration.default, Registration::default().as_str());
        assert_eq!(control("profanity_targets").kind, Kind::Targets);
        let mut keys: Vec<&str> = Control::all().iter().map(|c| c.key).collect();
        let mut envs: Vec<&str> = Control::all().iter().map(|c| c.env).collect();
        let n = keys.len();
        keys.sort();
        keys.dedup();
        envs.sort();
        envs.dedup();
        assert_eq!(
            (keys.len(), envs.len()),
            (n, n),
            "keys and env names are unique"
        );
        for c in Control::all() {
            assert_eq!(Control::by_env(c.env), Some(c));
            let written = match c.kind {
                Kind::Forms => c.default.to_string(),
                Kind::Switch
                | Kind::Choice(_)
                | Kind::Targets
                | Kind::Number { min: _, max: _ }
                | Kind::Names
                | Kind::Servers => c.shown(c.default),
            };
            assert_eq!(
                c.parse(&written).as_deref(),
                Ok(c.default),
                "{}: the default is a value",
                c.key
            );
            assert!(c.env != PINNED_ENV && !c.key.starts_with("env:"));
        }
        assert_eq!(Control::find("password_pepper"), None);
        assert_eq!(Control::by_env("PASSWORD_PEPPER"), None);
    }

    #[test]
    fn env_values_parse_to_their_stored_form() {
        let p2p = control("p2p");
        for (raw, stored) in [
            ("on", "1"),
            (" TRUE ", "1"),
            ("yes", "1"),
            ("1", "1"),
            ("off", "0"),
            ("False", "0"),
            ("no", "0"),
            ("0", "0"),
        ] {
            assert_eq!(p2p.parse(raw).as_deref(), Ok(stored), "{raw}");
        }
        assert_eq!(
            (p2p.shown("1"), p2p.shown("0")),
            ("on".into(), "off".into())
        );
        let registration = control("registration");
        for (raw, stored) in [("open", "open"), (" SSO ", "sso"), ("Closed", "closed")] {
            assert_eq!(registration.parse(raw).as_deref(), Ok(stored), "{raw}");
        }
        assert_eq!(registration.shown("sso"), "sso");
        let targets = control("profanity_targets");
        for (raw, stored) in [
            ("all", "all"),
            ("messages,all", "all"),
            (TARGETS, "all"),
            ("none", "none"),
            (
                " Messages, server_names,display_names ",
                "messages,server_names",
            ),
            ("none,bios", "bios"),
            ("links,messages", "messages,links"),
        ] {
            assert_eq!(targets.parse(raw).as_deref(), Ok(stored), "{raw}");
        }
        assert_eq!(targets.shown("messages,links"), "messages,links");
        let cap = control("upload_expiry_max_days");
        for (raw, stored) in [("0", "0"), (" 30 ", "30"), ("365", "365"), ("007", "7")] {
            assert_eq!(cap.parse(raw).as_deref(), Ok(stored), "{raw}");
        }
        assert_eq!(cap.shown("30"), "30");
        for raw in ["-1", "366", "1.5", "week"] {
            let stopped = ControlSeeds::of(&[("UPLOAD_EXPIRY_MAX_DAYS", raw)])
                .expect_err(raw)
                .to_string();
            assert_eq!(
                stopped,
                format!("UPLOAD_EXPIRY_MAX_DAYS: expected 0 to 365, got {raw}")
            );
        }
        let set = ControlSeeds::of(&[("UPLOAD_EXPIRY_MAX_DAYS", " 30 ")]).expect("set");
        assert_eq!(set.value("upload_expiry_max_days"), Some("30"));
        let creation = control("server_creation");
        for (raw, stored) in [
            ("Everyone", "everyone"),
            (" nobody ", "nobody"),
            ("some", "some"),
        ] {
            assert_eq!(creation.parse(raw).as_deref(), Ok(stored), "{raw}");
        }
        let creators = control("server_creators");
        for (raw, stored) in [
            ("bob", "bob"),
            (" Bob , lobby:Staff ,bob,, lobby:Staff", "Bob,lobby:Staff"),
            ("Team:a:Staff, team:a:Staff", "Team:a:Staff,team:a:Staff"),
            ("a:b:c", "a:b:c"),
        ] {
            assert_eq!(creators.parse(raw).as_deref(), Ok(stored), "{raw}");
        }
        assert_eq!(creators.shown("bob,lobby:Staff"), "bob,lobby:Staff");
        assert_eq!(creators.parse(" , ").as_deref(), Ok(""), "an empty list");
        let many: Vec<String> = (0..501).map(|n| format!("user{n}")).collect();
        assert!(creators.parse(&many[..500].join(",")).is_ok());
        for bad in [
            many.join(","),
            ":Staff".to_string(),
            "lobby:".to_string(),
            "a\u{0}b".to_string(),
            "x".repeat(202),
        ] {
            assert_eq!(
                creators.parse(&bad).unwrap_err(),
                "expected up to 500 usernames or server:role entries",
                "{}",
                &bad[..bad.len().min(20)]
            );
        }
    }

    #[test]
    fn the_default_servers_are_a_short_list_of_server_keys() {
        let c = control("default_servers");
        assert_eq!(
            c.parse(" Lobby, rchat ,lobby,, Town Square ").as_deref(),
            Ok("lobby,rchat,town square")
        );
        assert_eq!(c.parse("none").as_deref(), Ok(""));
        assert_eq!(c.parse(" NONE ").as_deref(), Ok(""));
        assert_eq!(c.shown(""), "none");
        assert_eq!(c.shown("lobby,rchat"), "lobby,rchat");
        let ten: Vec<String> = (0..10).map(|n| format!("s{n}")).collect();
        assert_eq!(c.parse(&ten.join(",")), Ok(ten.join(",")));
        let expected = Err("expected none or up to 10 server names".to_string());
        assert_eq!(c.parse(&format!("{},s10", ten.join(","))), expected);
        assert_eq!(c.parse(&"a".repeat(101)), expected);
        assert_eq!(c.parse("a\0b"), expected);
        assert_eq!(
            c.rows("lobby,rchat"),
            [("default_servers", "lobby,rchat".to_string())]
        );
    }

    #[test]
    fn bad_env_values_name_what_they_expect() {
        for c in Control::all() {
            if matches!(c.kind, Kind::Names | Kind::Forms | Kind::Servers) {
                continue;
            }
            let err = c.parse("maybe").unwrap_err();
            let want = match c.kind {
                Kind::Switch => "expected on or off".to_string(),
                Kind::Choice(words) => match words {
                    ["open", "sso", "closed"] => "expected open, sso or closed".to_string(),
                    ["everyone", "nobody", "some"] => {
                        "expected everyone, nobody or some".to_string()
                    }
                    ["everyone", "invites", "nobody"] => {
                        "expected everyone, invites or nobody".to_string()
                    }
                    ["everyone", "friends", "nobody"] => {
                        "expected everyone, friends or nobody".to_string()
                    }
                    other => panic!("{other:?} has no expected text"),
                },
                Kind::Targets => format!(
                    "expected all, none or a list of {}",
                    TARGETS.replace(',', ", ")
                ),
                Kind::Number { min, max } => format!("expected {min} to {max}"),
                Kind::Names | Kind::Servers => unreachable!("a list of names takes any word"),
                Kind::Forms => unreachable!("the forms come from a file"),
            };
            assert_eq!(err, want, "{}", c.key);
            assert!(err.is_ascii());
            let loaded = ControlSeeds::of(&[(c.env, "maybe")])
                .unwrap_err()
                .to_string();
            assert_eq!(loaded, format!("{}: {want}, got maybe", c.env));
        }
        for typo in ["message", "messages,bogus", "none,bogus", ","] {
            assert!(control("profanity_targets").parse(typo).is_err(), "{typo}");
        }
        assert!(control("registration").parse("invite").is_err());
    }

    #[test]
    fn targets_are_stored_as_one_row_each() {
        let targets = control("profanity_targets");
        let keys: Vec<&str> = ProfanitySwitch::ALL.into_iter().map(|t| t.key()).collect();
        assert_eq!(targets.keys(), keys);
        assert_eq!(control("p2p").keys(), ["p2p"]);
        assert_eq!(control("p2p").rows("0"), [("p2p", "0".to_string())]);
        assert_eq!(
            control("registration").rows("sso"),
            [("registration", "sso".to_string())]
        );
        let some = targets.rows("messages,bios");
        assert_eq!(some.len(), 10);
        for (key, value) in &some {
            let on = matches!(*key, "profanity_messages" | "profanity_bios");
            assert_eq!(*value == "1", on, "{key}");
        }
        assert!(targets.rows("all").iter().all(|(_, v)| *v == "1"));
        assert!(targets.rows("none").iter().all(|(_, v)| *v == "0"));
        let table = |rows: &[(&str, String)]| -> HashMap<String, String> {
            rows.iter()
                .map(|(k, v)| (k.to_string(), v.clone()))
                .collect()
        };
        let row = |key: &'static str, value: &str| (key, value.to_string());
        assert_eq!(
            targets.read(&table(&some)).as_deref(),
            Some("messages,bios")
        );
        assert_eq!(
            targets.read(&table(&targets.rows("all"))).as_deref(),
            Some("all")
        );
        assert_eq!(
            targets.read(&table(&targets.rows("none"))).as_deref(),
            Some("none")
        );
        assert_eq!(targets.read(&table(&[row("p2p", "1")])), None);
        assert_eq!(
            targets
                .read(&table(&[
                    row("profanity_links", "0"),
                    row("profanity_display_names", "0")
                ]))
                .as_deref(),
            Some(
                "messages,usernames,server_names,channel_names,role_names,file_names,bios,channel_topics,category_names"
            ),
            "a target without a row is on, as Settings reads it"
        );
        assert_eq!(
            control("p2p").read(&table(&[row("p2p", "0")])).as_deref(),
            Some("0")
        );
        assert_eq!(control("p2p").read(&table(&[row("sfu", "0")])), None);
    }

    #[test]
    fn seeds_come_from_their_env_names() {
        let unset = ControlSeeds::of(&[]).expect("defaults");
        assert_eq!(unset, ControlSeeds::default());
        assert_eq!(unset.value("p2p"), None);
        let set = ControlSeeds::of(&[
            ("FEATURE_P2P", " Off "),
            ("E2EE", "on"),
            ("WIDGETS", "false"),
            ("FEATURE_ONBOARDING", "  "),
            ("AUTH_REGISTRATION", "Closed"),
            ("GUESTS_ENABLED", "no"),
            ("OUTGOING_WEBHOOKS", "yes"),
            ("PROFANITY_TARGETS", "messages, links"),
            ("FEATURE_FILE_UPLOADS", "off"),
            ("PASSWORD_PEPPER", "secret"),
        ])
        .expect("set");
        for (key, value) in [
            ("p2p", Some("0")),
            ("e2ee", Some("1")),
            ("widgets", Some("0")),
            ("onboarding", None),
            ("registration", Some("closed")),
            ("guests_enabled", Some("0")),
            ("outgoing_webhooks", Some("1")),
            ("profanity_targets", Some("messages,links")),
            ("asset_uploads", Some("0")),
            ("sfu", None),
        ] {
            assert_eq!(set.value(key), value, "{key}");
        }
        assert_eq!(set.set.len(), 8, "blank values count as unset");
        assert!(set.pinned.is_empty());
    }

    #[test]
    fn pins_name_controls_the_env_sets() {
        let env = [
            ("FEATURE_P2P", "off"),
            ("AUTH_REGISTRATION", "closed"),
            ("E2EE", "on"),
        ];
        let with = |pinned: &str| {
            let mut pairs = env.to_vec();
            pairs.push((PINNED_ENV, pinned));
            ControlSeeds::of(&pairs)
        };
        let some = with(" feature_p2p , AUTH_REGISTRATION,").expect("a list");
        assert_eq!(some.pinned, ["p2p", "registration"]);
        assert!(some.pins("p2p") && some.pins("registration") && !some.pins("e2ee"));
        let all = with("ALL").expect("all");
        assert_eq!(all.pinned, ["e2ee", "p2p", "registration"]);
        assert_eq!(with("  ").expect("blank").pinned, Vec::<&str>::new());
        assert_eq!(
            ControlSeeds::of(&[(PINNED_ENV, "all")])
                .expect("nothing set")
                .pinned,
            Vec::<&str>::new()
        );
        for (pinned, error) in [
            (
                "FEATURE_SFU",
                "SETTINGS_PINNED names FEATURE_SFU, but it is not set",
            ),
            (
                "FEATURE_P2P,UPLOAD_MAX_MIB",
                "SETTINGS_PINNED names UPLOAD_MAX_MIB, which the admin page does not control",
            ),
            (
                "PASSWORD_PEPPER",
                "SETTINGS_PINNED names PASSWORD_PEPPER, which the admin page does not control",
            ),
        ] {
            let err = with(pinned).unwrap_err().to_string();
            assert_eq!(err, error);
            assert!(err.is_ascii());
        }
    }

    #[test]
    fn every_control_is_documented_with_its_default() {
        let example = include_str!("../../../../.env.local.example");
        let lines: Vec<&str> = example.lines().collect();
        let documented = |name: &str, words: &[&str]| {
            let key = format!("# {name}=");
            let at = lines
                .iter()
                .position(|l| l.starts_with(&key))
                .unwrap_or_else(|| panic!("{name} is in .env.local.example"));
            let about: Vec<&str> = lines[..at]
                .iter()
                .rev()
                .take_while(|l| l.starts_with("# ") && !l.contains('='))
                .copied()
                .collect();
            for word in words {
                assert!(
                    about.iter().any(|l| l.contains(word)),
                    "{name}: the comment above it says {word}"
                );
            }
            lines[at][key.len()..].to_string()
        };
        for c in Control::all() {
            let words = match c.kind {
                Kind::Switch => "on or off".to_string(),
                Kind::Choice(words) => super::any_of(words),
                Kind::Targets => "all, none, or a list".to_string(),
                Kind::Number { min, max } => format!("{min} to {max}"),
                Kind::Names => "server:role".to_string(),
                Kind::Forms => "JSON".to_string(),
                Kind::Servers => "none".to_string(),
            };
            let value = documented(c.env, &[&words, "Admin page"]);
            if c.kind == Kind::Forms {
                assert!(value.ends_with(".json"), "{}={value} names a file", c.env);
                continue;
            }
            assert_eq!(
                c.parse(&value).as_deref(),
                Ok(c.default),
                "{}={value} is the default",
                c.env
            );
        }
        assert!(!example.contains("First start only"));
        documented(PINNED_ENV, &["all"]);
    }

    #[test]
    fn the_forms_come_from_the_file_the_env_names() {
        use crate::api::reports::forms::ReportForms;
        let forms = control("report_forms");
        assert_eq!((forms.env, forms.kind), ("REPORT_FORMS_FILE", Kind::Forms));
        assert!(!forms.public);
        assert_eq!(forms.default, ReportForms::defaults().stored());
        assert_eq!(forms.shown(forms.default), "rev 1, 5 categories");
        assert_eq!(forms.shown("{"), "unreadable");

        let dir = std::env::temp_dir();
        let file = dir.join(format!("rchat_forms_{}.json", std::process::id()));
        let path = file.to_str().expect("path");
        let mut doc = serde_json::to_value(ReportForms::defaults()).expect("json");
        doc["rev"] = serde_json::json!(9);
        doc["forms"][1]["label"] = serde_json::json!("Bug");
        std::fs::write(&file, serde_json::to_string_pretty(&doc).expect("json")).expect("write");
        let set = ControlSeeds::of(&[("REPORT_FORMS_FILE", &format!(" {path} "))]).expect("set");
        let value = set
            .value("report_forms")
            .expect("the file's content is the value");
        let read = ReportForms::from_stored(value).expect("forms");
        assert_eq!((read.rev, read.forms[1].label.as_str()), (1, "Bug"));
        let pinned = ControlSeeds::of(&[
            ("REPORT_FORMS_FILE", path),
            ("SETTINGS_PINNED", "REPORT_FORMS_FILE"),
        ])
        .expect("pinned");
        assert!(pinned.pins("report_forms"));

        let stored = ReportForms {
            rev: 4,
            forms: ReportForms::defaults().forms,
        }
        .stored();
        assert!(forms.same(&stored, forms.default), "the revision aside");
        assert!(!forms.same(&stored, value));
        let applied = ReportForms::from_stored(&forms.applied(&stored, value)).expect("forms");
        assert_eq!((applied.rev, applied.forms), (5, read.forms.clone()));
        let p2p = control("p2p");
        assert!(p2p.same("1", "1") && !p2p.same("1", "0"));
        assert_eq!(p2p.applied("1", "0"), "0");

        doc["forms"][1]["fields"][2]["max"] = serde_json::json!(2001);
        std::fs::write(&file, doc.to_string()).expect("write");
        for stopped in [
            ControlSeeds::of(&[("REPORT_FORMS_FILE", path)])
                .expect_err("a bad field")
                .to_string(),
            crate::config::AppConfig::from_map(&[("REPORT_FORMS_FILE", path)])
                .expect_err("a bad field stops the start")
                .to_string(),
        ] {
            assert_eq!(
                stopped,
                format!("REPORT_FORMS_FILE ({path}): bug.steps: max must be 1 to 2000")
            );
        }
        std::fs::remove_file(&file).expect("remove");
        let missing = ControlSeeds::of(&[("REPORT_FORMS_FILE", path)])
            .expect_err("no file")
            .to_string();
        assert!(
            missing.starts_with(&format!("REPORT_FORMS_FILE ({path}): ")),
            "{missing}"
        );
    }

    #[tokio::test]
    async fn a_start_that_applied_config_tells_clients_once() {
        use crate::api::Settings;
        use crate::api::features::Registration;
        use crate::config::AppConfig;
        use crate::instance::{Instance, InstanceConfig};
        use crate::state::AppState;
        use crate::ws::{Hub, WsEvent};
        let path = crate::db::temp_db_path("config_announce");
        let opts = |value: &str| {
            AppConfig::from_map(&[("AUTH_REGISTRATION", value)])
                .expect("config")
                .db_options()
        };
        let db = crate::db::open_with(path.to_str(), &opts("open"))
            .await
            .expect("first start");
        crate::db::close(&db).await;
        for (start, heard) in [("closed", true), ("closed", false)] {
            let db = crate::db::open_with(path.to_str(), &opts(start))
                .await
                .expect("start");
            Settings::forget(&db);
            let instance = Instance::load(&db, &InstanceConfig::default())
                .await
                .expect("instance");
            let state = AppState::new(db, Hub::new(), None, None, instance);
            let mut rx = state.hub.subscribe();
            super::config_applied(&state).await;
            match (rx.try_recv(), heard) {
                (Ok(WsEvent::SettingsChanged { settings }), true) => {
                    assert_eq!(settings.registration, Registration::Closed)
                }
                (Err(_), false) => {}
                (got, _) => panic!("heard {}, expected {heard}", got.is_ok()),
            }
            super::config_applied(&state).await;
            assert!(rx.try_recv().is_err(), "once");
            crate::db::close(&state.db).await;
        }
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }
}
