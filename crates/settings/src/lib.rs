//! The instance's settings and limits: each one's env name, kind, range and default exist only
//! in its item (`items`), and a value is read from the environment only by handing `Env` an item.

use std::marker::PhantomData;

pub mod admin;
pub mod env;
pub mod items;
mod read;

pub use items::ALL;
pub use read::{Env, Invalid};

/// How a setting's value is written.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// On or off (also true/false, yes/no, 1/0).
    Switch,
    /// One of the words.
    Choice(&'static [&'static str]),
    /// A whole number from `min` to `max`.
    Number { min: i64, max: i64 },
    /// Text of `min` to `max` characters, on one line unless `lines`.
    Text { min: usize, max: usize, lines: bool },
    /// The profanity targets: `all`, `none` or a comma list of target names.
    Targets,
    /// A comma list of usernames and `server:role` entries.
    Names,
    /// The report forms: the env names a JSON file that holds them.
    Forms,
    /// A comma list of server names, or `none`.
    Servers,
    /// A JSON list of `{label, url}` links.
    Links,
    /// The instances the app suggests, JSON `{mode, list: [{url, label}]}`.
    Suggestions,
    /// A JSON object of names to numbers.
    Numbers,
    /// Env names of settings, comma separated, or `all`.
    Pins,
    /// A value of its own form (an address, a list, a path, JSON), checked where it is read.
    Value,
    /// A value never shown or logged. Where it is read as a secret, `NAME_FILE` may name a file
    /// that holds it.
    Secret,
}

/// A setting's value when nothing sets it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Preset {
    On,
    Off,
    Number(i64),
    Text(&'static str),
    /// The process picks the value; the text is its rule.
    Picked(&'static str),
    /// Unset unless the operator sets it.
    Unset,
}

/// Where a setting can be set.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    /// The environment, read at start.
    Start,
    /// The environment, and the site admin page while the server runs.
    Live,
    /// The environment; the instance sends it to the devices that use P2P.
    P2p,
    /// The environment, read at start once per sign-in provider: `ID` in the name stands for the
    /// provider id in capitals.
    Provider,
    /// Read by the web build, the build commands, the container or the separate PeerJS server,
    /// not by the server process.
    Build,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Setting {
    pub env: &'static str,
    /// The key in the `settings` table and in the admin API, for a `Live` setting.
    pub key: Option<&'static str>,
    pub kind: Kind,
    pub default: Preset,
    pub scope: Scope,
    /// Whether `GET /api/v1/settings` shows it.
    pub public: bool,
}

impl Setting {
    const fn new(kind: Kind, default: Preset) -> Setting {
        Setting {
            env: "",
            key: None,
            kind,
            default,
            scope: Scope::Start,
            public: false,
        }
    }

    const fn live(mut self, key: &'static str) -> Setting {
        self.key = Some(key);
        self.scope = Scope::Live;
        self.public = true;
        self
    }

    /// The name a refusal gives for this setting: its key, or its env name in lower case.
    pub fn control(&self) -> String {
        match self.key {
            Some(key) => key.to_string(),
            None => self.env.to_ascii_lowercase(),
        }
    }

    /// The smallest and largest value, for a number.
    pub const fn range(&self) -> Option<(i64, i64)> {
        match self.kind {
            Kind::Number { min, max } => Some((min, max)),
            _ => None,
        }
    }
}

/// A whole number that has a default.
pub struct Number<T> {
    pub setting: Setting,
    default: i64,
    of: PhantomData<fn() -> T>,
}

/// A whole number the process picks when nothing sets it.
pub struct OptNumber<T> {
    pub setting: Setting,
    of: PhantomData<fn() -> T>,
}

/// An on/off setting.
pub struct Switch {
    pub setting: Setting,
    on: bool,
}

/// One of a list of words.
pub struct Choice {
    pub setting: Setting,
    words: &'static [&'static str],
    default: &'static str,
}

/// Text of a bounded length.
pub struct Text {
    pub setting: Setting,
    max: usize,
    default: &'static str,
}

/// A list or document the admin page edits, which its reader checks.
pub struct Form {
    pub setting: Setting,
}

/// A setting with a form of its own that only the environment sets.
pub struct Item {
    pub setting: Setting,
}

/// A value of its own form, read as given and checked where it is read.
pub struct Value {
    pub setting: Setting,
}

/// A value never shown or logged.
pub struct Secret {
    pub setting: Setting,
}

pub const fn number<T>(default: i64, min: i64, max: i64) -> Number<T> {
    Number {
        setting: Setting::new(Kind::Number { min, max }, Preset::Number(default)),
        default,
        of: PhantomData,
    }
}

pub const fn picked<T>(min: i64, max: i64, rule: &'static str) -> OptNumber<T> {
    OptNumber {
        setting: Setting::new(Kind::Number { min, max }, Preset::Picked(rule)),
        of: PhantomData,
    }
}

pub const fn switch(on: bool) -> Switch {
    let default = match on {
        true => Preset::On,
        false => Preset::Off,
    };
    Switch {
        setting: Setting::new(Kind::Switch, default),
        on,
    }
}

pub const fn choice(words: &'static [&'static str], default: &'static str) -> Choice {
    Choice {
        setting: Setting::new(Kind::Choice(words), Preset::Text(default)),
        words,
        default,
    }
}

pub const fn text(min: usize, max: usize, lines: bool, default: &'static str) -> Text {
    Text {
        setting: Setting::new(Kind::Text { min, max, lines }, Preset::Text(default)),
        max,
        default,
    }
}

pub const fn targets(default: &'static str) -> Form {
    form(Kind::Targets, Preset::Text(default))
}

pub const fn names() -> Form {
    form(Kind::Names, Preset::Text(""))
}

pub const fn servers(default: &'static str) -> Form {
    form(Kind::Servers, Preset::Text(default))
}

pub const fn links() -> Form {
    form(Kind::Links, Preset::Text("[]"))
}

pub const fn suggestions(default: &'static str) -> Form {
    form(Kind::Suggestions, Preset::Text(default))
}

/// The report forms; `rule` says what they are when nothing sets them.
pub const fn forms(rule: &'static str) -> Form {
    form(Kind::Forms, Preset::Picked(rule))
}

const fn form(kind: Kind, default: Preset) -> Form {
    Form {
        setting: Setting::new(kind, default),
    }
}

/// The P2P limits: a JSON object of names to numbers, sent to the devices that use P2P.
pub const fn p2p_numbers() -> Item {
    let mut item = item(Kind::Numbers, Preset::Text("{}"));
    item.setting.scope = Scope::P2p;
    item
}

/// The names of the settings that follow the environment at every start.
pub const fn pins() -> Item {
    item(Kind::Pins, Preset::Text(""))
}

/// A value of its own form, unset by default.
pub const fn value() -> Value {
    Value {
        setting: Setting::new(Kind::Value, Preset::Unset),
    }
}

/// A value of its own form with a value when nothing sets it.
pub const fn value_or(default: &'static str) -> Value {
    Value {
        setting: Setting::new(Kind::Value, Preset::Text(default)),
    }
}

/// A value of its own form the process picks when nothing sets it; `rule` says how.
pub const fn value_picked(rule: &'static str) -> Value {
    Value {
        setting: Setting::new(Kind::Value, Preset::Picked(rule)),
    }
}

pub const fn secret() -> Secret {
    Secret {
        setting: Setting::new(Kind::Secret, Preset::Unset),
    }
}

const fn item(kind: Kind, default: Preset) -> Item {
    Item {
        setting: Setting::new(kind, default),
    }
}

macro_rules! handle {
    ($($name:ident$(<$t:ident>)?),*) => {$(
        impl$(<$t>)? $name$(<$t>)? {
            const fn named(mut self, env: &'static str) -> Self {
                self.setting.env = env;
                self
            }

            pub const fn env(&self) -> &'static str {
                self.setting.env
            }
        }
    )*};
}
handle!(
    Number<T>,
    OptNumber<T>,
    Switch,
    Choice,
    Text,
    Form,
    Item,
    Value,
    Secret
);

macro_rules! scoped {
    ($($name:ident$(<$t:ident>)?),*) => {$(
        impl$(<$t>)? $name$(<$t>)? {
            /// Read once per sign-in provider.
            pub const fn provider(mut self) -> Self {
                self.setting.scope = Scope::Provider;
                self
            }

            /// Read outside the server process.
            pub const fn build(mut self) -> Self {
                self.setting.scope = Scope::Build;
                self
            }
        }
    )*};
}
scoped!(Number<T>, Switch, Choice, Value, Secret);

/// A setting's item: its handle, or the setting itself.
pub trait Handle {
    fn setting(&'static self) -> &'static Setting;
}

impl Handle for Setting {
    fn setting(&'static self) -> &'static Setting {
        self
    }
}

macro_rules! handles {
    ($($name:ident$(<$t:ident>)?),*) => {$(
        impl$(<$t>)? Handle for $name$(<$t>)? {
            fn setting(&'static self) -> &'static Setting {
                &self.setting
            }
        }
    )*};
}
handles!(
    Number<T>,
    OptNumber<T>,
    Switch,
    Choice,
    Text,
    Form,
    Item,
    Value,
    Secret
);

macro_rules! live {
    ($($name:ident$(<$t:ident>)?),*) => {$(
        impl$(<$t>)? $name$(<$t>)? {
            /// Also set from the site admin page, under `key`.
            pub const fn live(mut self, key: &'static str) -> Self {
                self.setting = self.setting.live(key);
                self
            }

            /// Left out of `GET /api/v1/settings`.
            pub const fn private(mut self) -> Self {
                self.setting.public = false;
                self
            }

            /// The key of a setting the admin page changes.
            pub const fn key(&self) -> &'static str {
                match self.setting.key {
                    Some(key) => key,
                    None => panic!("not a live setting"),
                }
            }
        }
    )*};
}
live!(Number<T>, Switch, Choice, Text, Form);

impl<T> Number<T> {
    pub const fn default(&self) -> i64 {
        self.default
    }

    pub const fn min(&self) -> i64 {
        match self.setting.kind {
            Kind::Number { min, max: _ } => min,
            _ => unreachable!(),
        }
    }

    pub const fn max(&self) -> i64 {
        match self.setting.kind {
            Kind::Number { min: _, max } => max,
            _ => unreachable!(),
        }
    }
}

impl<T> OptNumber<T> {
    pub const fn max(&self) -> i64 {
        match self.setting.kind {
            Kind::Number { min: _, max } => max,
            _ => unreachable!(),
        }
    }
}

impl Switch {
    pub const fn default(&self) -> bool {
        self.on
    }
}

impl Choice {
    pub const fn words(&self) -> &'static [&'static str] {
        self.words
    }

    pub const fn default(&self) -> &'static str {
        self.default
    }
}

impl Text {
    pub const fn max(&self) -> usize {
        self.max
    }

    pub const fn default(&self) -> &'static str {
        self.default
    }
}

/// The setting whose env name is `env`. A per-provider name (`OIDC_ID_ISSUER`) is found only
/// by that name.
pub fn by_env(env: &str) -> Option<&'static Setting> {
    ALL.iter().copied().find(|s| s.env == env)
}

/// The env name of a per-provider setting for the provider `id`.
pub fn provider_env(setting: &Setting, id: &str) -> String {
    debug_assert_eq!(setting.scope, Scope::Provider);
    setting
        .env
        .replacen("_ID_", &format!("_{}_", id.to_ascii_uppercase()), 1)
}

/// The registry as data, the source of the generated files.
pub fn json() -> String {
    use serde_json::{Value, json};
    let settings: Vec<Value> = ALL
        .iter()
        .map(|s| {
            let Setting {
                env,
                key,
                kind,
                default,
                scope,
                public,
            } = **s;
            let mut row = json!({ "env": env });
            if let Some(key) = key {
                row["key"] = json!(key);
            }
            row["kind"] = json!(match kind {
                Kind::Switch => "switch",
                Kind::Choice(_) => "choice",
                Kind::Number { min: _, max: _ } => "number",
                Kind::Text {
                    min: _,
                    max: _,
                    lines: _,
                } => "text",
                Kind::Targets => "targets",
                Kind::Names => "names",
                Kind::Forms => "forms",
                Kind::Servers => "servers",
                Kind::Links => "links",
                Kind::Suggestions => "suggestions",
                Kind::Numbers => "numbers",
                Kind::Pins => "pins",
                Kind::Value => "value",
                Kind::Secret => "secret",
            });
            match kind {
                Kind::Choice(words) => row["words"] = json!(words),
                Kind::Number { min, max } => {
                    row["min"] = json!(min);
                    row["max"] = json!(max);
                }
                Kind::Text { min, max, lines } => {
                    row["min"] = json!(min);
                    row["max"] = json!(max);
                    row["lines"] = json!(lines);
                }
                Kind::Switch
                | Kind::Targets
                | Kind::Names
                | Kind::Forms
                | Kind::Servers
                | Kind::Links
                | Kind::Suggestions
                | Kind::Numbers
                | Kind::Pins
                | Kind::Value
                | Kind::Secret => {}
            }
            match default {
                Preset::On => row["default"] = json!("on"),
                Preset::Off => row["default"] = json!("off"),
                Preset::Number(n) => row["default"] = json!(n),
                Preset::Text(text) => row["default"] = json!(text),
                Preset::Picked(rule) => row["picked"] = json!(rule),
                Preset::Unset => {}
            }
            row["scope"] = json!(match scope {
                Scope::Start => "start",
                Scope::Live => "live",
                Scope::P2p => "p2p",
                Scope::Provider => "provider",
                Scope::Build => "build",
            });
            if scope == Scope::Live {
                row["public"] = json!(public);
            }
            row
        })
        .collect();
    let file: Vec<Value> = env::BLOCKS
        .iter()
        .map(|block| {
            let lines: Vec<Value> = block
                .iter()
                .map(|line| match line {
                    env::Line::Note(text) => json!({ "note": text }),
                    env::Line::Set(setting, value) | env::Line::Shown(setting, value) => {
                        json!({
                            "env": setting.env,
                            "name": env_name(setting),
                            "value": value,
                            "set": matches!(line, env::Line::Set(_, _)),
                        })
                    }
                })
                .collect();
            Value::Array(lines)
        })
        .collect();
    json!({ "v": 1, "settings": settings, "file": file }).to_string()
}

/// `.env.local.example`, written from `env::BLOCKS`.
pub fn env_example() -> String {
    let mut out = String::new();
    for (at, block) in env::BLOCKS.iter().enumerate() {
        if at > 0 {
            out.push('\n');
        }
        for line in *block {
            let (prefix, setting, value) = match line {
                env::Line::Note(text) => {
                    out.push_str(text);
                    out.push('\n');
                    continue;
                }
                env::Line::Set(setting, value) => ("", setting, value),
                env::Line::Shown(setting, value) => ("# ", setting, value),
            };
            out.push_str(&format!("{prefix}{}={value}\n", env_name(setting)));
        }
    }
    out
}

/// The comment lines above `setting`'s line in the env file, `# ` taken off.
pub fn doc(setting: &Setting) -> Vec<&'static str> {
    for block in env::BLOCKS {
        let mut about = Vec::new();
        for line in *block {
            match line {
                env::Line::Note(text) => about.push(text.strip_prefix("# ").unwrap_or(text)),
                env::Line::Set(s, _) | env::Line::Shown(s, _) if *s == setting => return about,
                env::Line::Set(_, _) | env::Line::Shown(_, _) => about.clear(),
            }
        }
    }
    Vec::new()
}

/// The value `setting`'s line in the env file shows.
pub fn shown(setting: &Setting) -> Option<&'static str> {
    env::BLOCKS
        .iter()
        .flat_map(|block| block.iter())
        .find_map(|line| match line {
            env::Line::Set(s, value) | env::Line::Shown(s, value) if *s == setting => Some(*value),
            env::Line::Set(_, _) | env::Line::Shown(_, _) | env::Line::Note(_) => None,
        })
}

/// The name `setting`'s line in the env file shows: a per-provider setting with the example id.
fn env_name(setting: &Setting) -> String {
    match setting.scope {
        Scope::Provider => provider_env(setting, env::PROVIDER_EXAMPLE),
        Scope::Start | Scope::Live | Scope::P2p | Scope::Build => setting.env.to_string(),
    }
}
