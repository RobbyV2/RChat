use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::limits::Env;

/// A site-wide feature switch: a `Settings` field of the same name, seeded at first start from
/// its env name and changed after that in the site admin panel.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Feature {
    ServerReports,
    InstanceReports,
    Widgets,
    WidgetChat,
    WidgetReadLinks,
    WidgetBridge,
    E2ee,
    E2eeCompliance,
    BackupPhrase,
    P2pBackup,
    DisplayNames,
    Onboarding,
    PasswordLogin,
    Sfu,
    P2p,
}

impl Feature {
    pub const ALL: [Feature; 15] = [
        Feature::ServerReports,
        Feature::InstanceReports,
        Feature::Widgets,
        Feature::WidgetChat,
        Feature::WidgetReadLinks,
        Feature::WidgetBridge,
        Feature::E2ee,
        Feature::E2eeCompliance,
        Feature::BackupPhrase,
        Feature::P2pBackup,
        Feature::DisplayNames,
        Feature::Onboarding,
        Feature::PasswordLogin,
        Feature::Sfu,
        Feature::P2p,
    ];

    /// The `Settings` field and the key in the `settings` table.
    pub fn key(self) -> &'static str {
        match self {
            Feature::ServerReports => "server_reports",
            Feature::InstanceReports => "instance_reports",
            Feature::Widgets => "widgets",
            Feature::WidgetChat => "widget_chat",
            Feature::WidgetReadLinks => "widget_read_links",
            Feature::WidgetBridge => "widget_bridge",
            Feature::E2ee => "e2ee",
            Feature::E2eeCompliance => "e2ee_compliance",
            Feature::BackupPhrase => "backup_phrase",
            Feature::P2pBackup => "p2p_backup",
            Feature::DisplayNames => "display_names",
            Feature::Onboarding => "onboarding",
            Feature::PasswordLogin => "password_login",
            Feature::Sfu => "sfu",
            Feature::P2p => "p2p",
        }
    }

    /// The env name that seeds it at first start.
    pub fn env(self) -> &'static str {
        match self {
            Feature::ServerReports => "FEATURE_SERVER_REPORTS",
            Feature::InstanceReports => "FEATURE_INSTANCE_REPORTS",
            Feature::Widgets => "WIDGETS",
            Feature::WidgetChat => "FEATURE_WIDGET_CHAT",
            Feature::WidgetReadLinks => "FEATURE_WIDGET_READ_LINKS",
            Feature::WidgetBridge => "WIDGET_BRIDGE",
            Feature::E2ee => "E2EE",
            Feature::E2eeCompliance => "E2EE_COMPLIANCE",
            Feature::BackupPhrase => "FEATURE_BACKUP_PHRASE",
            Feature::P2pBackup => "FEATURE_P2P_BACKUP",
            Feature::DisplayNames => "FEATURE_DISPLAY_NAMES",
            Feature::Onboarding => "FEATURE_ONBOARDING",
            Feature::PasswordLogin => "AUTH_PASSWORD_LOGIN",
            Feature::Sfu => "FEATURE_SFU",
            Feature::P2p => "FEATURE_P2P",
        }
    }

    /// Its value when the env leaves it unset.
    pub fn default_on(self) -> bool {
        match self {
            Feature::WidgetBridge | Feature::E2ee | Feature::E2eeCompliance | Feature::Sfu => false,
            Feature::ServerReports
            | Feature::InstanceReports
            | Feature::Widgets
            | Feature::WidgetChat
            | Feature::WidgetReadLinks
            | Feature::BackupPhrase
            | Feature::P2pBackup
            | Feature::DisplayNames
            | Feature::Onboarding
            | Feature::PasswordLogin
            | Feature::P2p => true,
        }
    }
}

/// Who may create an account with a password: anyone (`open`), nobody because accounts come
/// from single sign-on (`sso`), or nobody (`closed`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum Registration {
    #[default]
    Open,
    Sso,
    Closed,
}

impl Registration {
    pub const KEY: &str = "registration";
    pub const ENV: &str = "AUTH_REGISTRATION";

    pub fn as_str(self) -> &'static str {
        match self {
            Registration::Open => "open",
            Registration::Sso => "sso",
            Registration::Closed => "closed",
        }
    }

    pub fn parse(value: &str) -> Option<Registration> {
        match value.trim().to_ascii_lowercase().as_str() {
            "open" => Some(Registration::Open),
            "sso" => Some(Registration::Sso),
            "closed" => Some(Registration::Closed),
            _ => None,
        }
    }
}

/// The env values that seed the feature switches at first start, checked at start: a switch is
/// on or off (also true/false, yes/no, 1/0), `AUTH_REGISTRATION` open, sso or closed.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FeatureSeeds {
    /// The switches the env sets.
    pub switches: Vec<(Feature, bool)>,
    pub registration: Option<Registration>,
}

impl FeatureSeeds {
    pub fn load(env: &dyn Fn(&str) -> Option<String>) -> anyhow::Result<FeatureSeeds> {
        let e = Env(env);
        let mut switches = Vec::new();
        for f in Feature::ALL {
            if e.raw(f.env()).is_some() {
                switches.push((f, e.switch(f.env(), f.default_on())?));
            }
        }
        let registration = match e.raw(Registration::ENV) {
            Some(raw) => Some(Registration::parse(&raw).ok_or_else(|| {
                anyhow::anyhow!(
                    "{}: expected open, sso or closed, got {raw}",
                    Registration::ENV
                )
            })?),
            None => None,
        };
        Ok(FeatureSeeds {
            switches,
            registration,
        })
    }

    /// The first-start value of `feature`.
    pub fn on(&self, feature: Feature) -> bool {
        self.switches
            .iter()
            .find(|(f, _)| *f == feature)
            .map_or(feature.default_on(), |(_, on)| *on)
    }

    pub fn registration(&self) -> Registration {
        self.registration.unwrap_or_default()
    }

    /// Every switch with its first-start value.
    pub fn pairs(&self) -> Vec<(&'static str, bool)> {
        Feature::ALL
            .into_iter()
            .map(|f| (f.key(), self.on(f)))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::{Feature, FeatureSeeds, Registration};

    fn seeds(pairs: &[(&str, &str)]) -> anyhow::Result<FeatureSeeds> {
        let set: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        FeatureSeeds::load(&|name| set.get(name).cloned())
    }

    #[test]
    fn every_switch_has_its_key_seed_and_default() {
        let table: Vec<(&str, &str, bool)> = Feature::ALL
            .into_iter()
            .map(|f| (f.key(), f.env(), f.default_on()))
            .collect();
        assert_eq!(
            table,
            [
                ("server_reports", "FEATURE_SERVER_REPORTS", true),
                ("instance_reports", "FEATURE_INSTANCE_REPORTS", true),
                ("widgets", "WIDGETS", true),
                ("widget_chat", "FEATURE_WIDGET_CHAT", true),
                ("widget_read_links", "FEATURE_WIDGET_READ_LINKS", true),
                ("widget_bridge", "WIDGET_BRIDGE", false),
                ("e2ee", "E2EE", false),
                ("e2ee_compliance", "E2EE_COMPLIANCE", false),
                ("backup_phrase", "FEATURE_BACKUP_PHRASE", true),
                ("p2p_backup", "FEATURE_P2P_BACKUP", true),
                ("display_names", "FEATURE_DISPLAY_NAMES", true),
                ("onboarding", "FEATURE_ONBOARDING", true),
                ("password_login", "AUTH_PASSWORD_LOGIN", true),
                ("sfu", "FEATURE_SFU", false),
                ("p2p", "FEATURE_P2P", true),
            ]
        );
        assert_eq!(
            (Registration::KEY, Registration::ENV),
            ("registration", "AUTH_REGISTRATION")
        );
        for (r, word) in [
            (Registration::Open, "open"),
            (Registration::Sso, "sso"),
            (Registration::Closed, "closed"),
        ] {
            assert_eq!(r.as_str(), word);
            assert_eq!(Registration::parse(word), Some(r));
            assert_eq!(
                serde_json::to_value(r).expect("json"),
                serde_json::json!(word)
            );
        }
        assert_eq!(Registration::parse(" SSO "), Some(Registration::Sso));
        assert_eq!(Registration::parse("invite"), None);
        assert_eq!(Registration::default(), Registration::Open);
    }

    #[test]
    fn seeds_come_from_their_env_names() {
        let unset = seeds(&[]).expect("defaults");
        assert_eq!(unset, FeatureSeeds::default());
        for f in Feature::ALL {
            assert_eq!(unset.on(f), f.default_on(), "{f:?}");
        }
        assert_eq!(unset.registration(), Registration::Open);
        let set = seeds(&[
            ("FEATURE_P2P", " Off "),
            ("E2EE", "on"),
            ("E2EE_COMPLIANCE", "yes"),
            ("WIDGETS", "false"),
            ("WIDGET_BRIDGE", "1"),
            ("AUTH_PASSWORD_LOGIN", "no"),
            ("FEATURE_SFU", "TRUE"),
            ("FEATURE_ONBOARDING", "  "),
            ("AUTH_REGISTRATION", "Closed"),
        ])
        .expect("set");
        for (f, on) in [
            (Feature::P2p, false),
            (Feature::E2ee, true),
            (Feature::E2eeCompliance, true),
            (Feature::Widgets, false),
            (Feature::WidgetBridge, true),
            (Feature::PasswordLogin, false),
            (Feature::Sfu, true),
            (Feature::Onboarding, true),
            (Feature::ServerReports, true),
        ] {
            assert_eq!(set.on(f), on, "{f:?}");
        }
        assert_eq!(set.registration(), Registration::Closed);
        let pairs = set.pairs();
        assert_eq!(pairs.len(), Feature::ALL.len());
        assert!(pairs.contains(&("p2p", false)) && pairs.contains(&("e2ee", true)));
        assert!(pairs.contains(&("display_names", true)));
    }

    #[test]
    fn bad_seed_values_name_the_variable() {
        for f in Feature::ALL {
            let err = seeds(&[(f.env(), "maybe")]).unwrap_err().to_string();
            assert_eq!(err, format!("{}: expected on or off, got maybe", f.env()));
        }
        let err = seeds(&[("AUTH_REGISTRATION", "invite")])
            .unwrap_err()
            .to_string();
        assert_eq!(
            err,
            "AUTH_REGISTRATION: expected open, sso or closed, got invite"
        );
        assert!(err.is_ascii());
    }

    #[test]
    fn every_seed_is_documented_with_its_default() {
        let example = include_str!("../../../../.env.local.example");
        let lines: Vec<&str> = example.lines().collect();
        let documented = |name: &str, words: &str| {
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
            assert!(
                about.iter().any(|l| l.contains(words)),
                "{name}: the comment above it says {words}"
            );
            assert!(
                about.iter().any(|l| l.contains("First start only")),
                "{name}: the comment above it says First start only"
            );
            lines[at][key.len()..].to_string()
        };
        for f in Feature::ALL {
            let value = documented(f.env(), "on or off");
            let shown = seeds(&[(f.env(), &value)]).expect("loads");
            assert_eq!(shown.on(f), f.default_on(), "{}={value}", f.env());
        }
        let value = documented(Registration::ENV, "open, sso or closed");
        assert_eq!(Registration::parse(&value), Some(Registration::Open));
    }
}
