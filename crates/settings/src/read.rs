use crate::{Choice, Kind, Number, OptNumber, Scope, Secret, Setting, Switch, Value, provider_env};

/// A value the environment sets that its setting does not take: the name, what it takes and
/// what was given.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Invalid(String);

impl std::fmt::Display for Invalid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Invalid {}

/// The values the operator set. A value is read by its item, so a name the registry does not
/// list cannot be read. Blank values count as unset.
pub struct Env<'a>(&'a dyn Fn(&str) -> Option<String>);

impl<'a> Env<'a> {
    /// `lookup` gives the value of an env name, if set.
    pub fn new(lookup: &'a dyn Fn(&str) -> Option<String>) -> Env<'a> {
        Env(lookup)
    }

    /// The trimmed value of `setting`, `None` when unset or blank.
    pub fn raw(&self, setting: &Setting) -> Option<String> {
        (self.0)(setting.env)
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    }

    fn ranged<T: TryFrom<i64>>(&self, setting: &Setting) -> Result<Option<T>, Invalid> {
        let Kind::Number { min, max } = setting.kind else {
            unreachable!("a number item has a range");
        };
        let Some(raw) = self.raw(setting) else {
            return Ok(None);
        };
        raw.parse::<i64>()
            .ok()
            .filter(|v| (min..=max).contains(v))
            .and_then(|v| T::try_from(v).ok())
            .map(Some)
            .ok_or_else(|| {
                Invalid(format!(
                    "{}: expected {min} to {max}, got {raw}",
                    setting.env
                ))
            })
    }

    /// The number the environment sets, or the item's default.
    pub fn get<T: TryFrom<i64>>(&self, item: &Number<T>) -> Result<T, Invalid> {
        match self.ranged(&item.setting)? {
            Some(value) => Ok(value),
            None => T::try_from(item.default()).map_err(|_| {
                Invalid(format!(
                    "{}: the default {} does not fit",
                    item.setting.env,
                    item.default()
                ))
            }),
        }
    }

    /// The number the environment sets, `None` when the process is to pick.
    pub fn opt<T: TryFrom<i64>>(&self, item: &OptNumber<T>) -> Result<Option<T>, Invalid> {
        self.ranged(&item.setting)
    }

    pub fn switch(&self, item: &Switch) -> Result<bool, Invalid> {
        let Some(raw) = self.raw(&item.setting) else {
            return Ok(item.default());
        };
        match raw.to_ascii_lowercase().as_str() {
            "on" | "true" | "yes" | "1" => Ok(true),
            "off" | "false" | "no" | "0" => Ok(false),
            _ => Err(Invalid(format!(
                "{}: expected on or off, got {raw}",
                item.setting.env
            ))),
        }
    }

    /// The value of `item` as given, untrimmed, `None` when unset.
    pub fn value(&self, item: &Value) -> Option<String> {
        (self.0)(item.setting.env)
    }

    /// The value as given of a setting that is not one of its own handles' kind, such as a
    /// secret read without a file.
    pub fn given(&self, setting: &Setting) -> Option<String> {
        (self.0)(setting.env)
    }

    /// The trimmed value of the per-provider `setting` for the provider `id`.
    pub fn provider(&self, setting: &Setting, id: &str) -> Option<String> {
        debug_assert_eq!(setting.scope, Scope::Provider);
        (self.0)(&provider_env(setting, id))
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    }

    /// The secret `name`, from the variable or the file `NAME_FILE` names. An unreadable file
    /// is an error naming `NAME_FILE`.
    fn secret_named(&self, name: &str) -> Result<Option<String>, Invalid> {
        if let Some(value) = (self.0)(name).filter(|s| !s.trim().is_empty()) {
            return Ok(Some(value.trim().to_owned()));
        }
        let key = format!("{name}_FILE");
        let Some(path) = (self.0)(&key).filter(|s| !s.trim().is_empty()) else {
            return Ok(None);
        };
        let contents = std::fs::read_to_string(path.trim())
            .map_err(|error| Invalid(format!("{key} cannot be read: {error}")))?;
        let value = contents.trim();
        Ok((!value.is_empty()).then(|| value.to_owned()))
    }

    /// The secret `item`: the variable, or the contents of the file `NAME_FILE` names.
    pub fn secret(&self, item: &Secret) -> Result<Option<String>, Invalid> {
        self.secret_named(item.setting.env)
    }

    /// `secret` for a secret the start cannot do without knowing: a `NAME_FILE` that names an
    /// empty file is an error, never an unset secret.
    pub fn required_secret(&self, item: &Secret) -> Result<Option<String>, Invalid> {
        let name = item.setting.env;
        let key = format!("{name}_FILE");
        match self.secret_named(name)? {
            Some(value) => Ok(Some(value)),
            None if (self.0)(&key).is_some_and(|v| !v.trim().is_empty()) => {
                Err(Invalid(format!("{key} names an empty file")))
            }
            None => Ok(None),
        }
    }

    /// The per-provider secret `item` of the provider `id`, with its `NAME_FILE`.
    pub fn provider_secret(&self, item: &Secret, id: &str) -> Result<Option<String>, Invalid> {
        self.secret_named(&provider_env(&item.setting, id))
    }

    /// The word the environment sets, lowercased, or the item's default.
    pub fn choice(&self, item: &Choice) -> Result<&'static str, Invalid> {
        let Some(raw) = self.raw(&item.setting) else {
            return Ok(item.default());
        };
        let word = raw.to_ascii_lowercase();
        match item.words().iter().find(|w| **w == word) {
            Some(word) => Ok(word),
            None => Err(Invalid(format!(
                "{}: expected {}, got {raw}",
                item.setting.env,
                any_of(item.words())
            ))),
        }
    }
}

/// `a`, `a or b`, `a, b or c`.
fn any_of(words: &[&str]) -> String {
    match words {
        [] => String::new(),
        [one] => one.to_string(),
        [rest @ .., last] => format!("{} or {last}", rest.join(", ")),
    }
}
