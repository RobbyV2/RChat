use rchat_settings::items as st;
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
    GuestChat,
    GuestVoice,
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
    ServerProfiles,
    Docs,
    ScheduledMessages,
    InteractiveDocs,
    MemberLists,
    ProfilePictures,
    AnimatedProfilePictures,
    Gifs,
}

impl Feature {
    pub const ALL: [Feature; 26] = [
        Feature::ServerReports,
        Feature::InstanceReports,
        Feature::Widgets,
        Feature::WidgetChat,
        Feature::GuestChat,
        Feature::GuestVoice,
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
        Feature::ServerProfiles,
        Feature::Docs,
        Feature::ScheduledMessages,
        Feature::InteractiveDocs,
        Feature::MemberLists,
        Feature::ProfilePictures,
        Feature::AnimatedProfilePictures,
        Feature::Gifs,
    ];

    /// Its registry item: the env name, the key and the value when nothing sets it.
    pub fn item(self) -> &'static rchat_settings::Switch {
        match self {
            Feature::ServerReports => &st::FEATURE_SERVER_REPORTS,
            Feature::InstanceReports => &st::FEATURE_INSTANCE_REPORTS,
            Feature::Widgets => &st::WIDGETS,
            Feature::WidgetChat => &st::FEATURE_WIDGET_CHAT,
            Feature::GuestChat => &st::GUEST_CHAT_ENABLED,
            Feature::GuestVoice => &st::GUEST_VOICE_ENABLED,
            Feature::WidgetReadLinks => &st::FEATURE_WIDGET_READ_LINKS,
            Feature::WidgetBridge => &st::WIDGET_BRIDGE,
            Feature::E2ee => &st::E2EE,
            Feature::E2eeCompliance => &st::E2EE_COMPLIANCE,
            Feature::BackupPhrase => &st::FEATURE_BACKUP_PHRASE,
            Feature::P2pBackup => &st::FEATURE_P2P_BACKUP,
            Feature::DisplayNames => &st::FEATURE_DISPLAY_NAMES,
            Feature::Onboarding => &st::FEATURE_ONBOARDING,
            Feature::PasswordLogin => &st::AUTH_PASSWORD_LOGIN,
            Feature::Sfu => &st::FEATURE_SFU,
            Feature::P2p => &st::FEATURE_P2P,
            Feature::ClientOtherInstances => &st::FEATURE_CLIENT_OTHER_INSTANCES,
            Feature::ServerProfiles => &st::FEATURE_SERVER_PROFILES,
            Feature::Docs => &st::FEATURE_DOCS,
            Feature::ScheduledMessages => &st::FEATURE_SCHEDULED_MESSAGES,
            Feature::InteractiveDocs => &st::FEATURE_INTERACTIVE_DOCS,
            Feature::MemberLists => &st::FEATURE_MEMBER_LISTS,
            Feature::ProfilePictures => &st::FEATURE_PROFILE_PICTURES,
            Feature::AnimatedProfilePictures => &st::FEATURE_ANIMATED_PROFILE_PICTURES,
            Feature::Gifs => &st::FEATURE_GIFS,
        }
    }

    /// The `Settings` field and the key in the `settings` table.
    pub fn key(self) -> &'static str {
        self.item().key()
    }

    /// Its env name.
    pub fn env(self) -> &'static str {
        self.item().env()
    }

    /// Its value when the env leaves it unset.
    pub fn default_on(self) -> bool {
        self.item().default()
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
                ("guest_chat_enabled", "GUEST_CHAT_ENABLED", false),
                ("guest_voice_enabled", "GUEST_VOICE_ENABLED", false),
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
                ("server_profiles", "FEATURE_SERVER_PROFILES", true),
                ("docs", "FEATURE_DOCS", true),
                ("scheduled_messages", "FEATURE_SCHEDULED_MESSAGES", true),
                ("interactive_docs", "FEATURE_INTERACTIVE_DOCS", true),
                ("member_lists", "FEATURE_MEMBER_LISTS", true),
                ("profile_pictures", "FEATURE_PROFILE_PICTURES", true),
                (
                    "animated_profile_pictures",
                    "FEATURE_ANIMATED_PROFILE_PICTURES",
                    true
                ),
                ("gifs", "FEATURE_GIFS", false),
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
