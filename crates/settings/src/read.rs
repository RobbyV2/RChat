use crate::{Kind, Number, OptNumber, Setting, Switch};

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
}
