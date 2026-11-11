use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// A site-wide feature switch: a `Settings` field of the same name and a control
/// (`controls::Control`) with its env name.
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
    ClientOtherInstances,
}

impl Feature {
    pub const ALL: [Feature; 16] = [
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
        Feature::ClientOtherInstances,
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
            Feature::ClientOtherInstances => "client_other_instances",
        }
    }

    /// Its env name.
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
            Feature::ClientOtherInstances => "FEATURE_CLIENT_OTHER_INSTANCES",
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
            | Feature::P2p
            | Feature::ClientOtherInstances => true,
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

#[cfg(test)]
mod tests {
    use super::{Feature, Registration};

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
                (
                    "client_other_instances",
                    "FEATURE_CLIENT_OTHER_INSTANCES",
                    true
                ),
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
}
