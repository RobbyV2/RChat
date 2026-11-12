use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Declared {
    Scope(&'static str),
    Device,
    Never,
}

pub const EVENTS: [(&str, Declared); 30] = [
    ("message_created", Declared::Scope("messages.read")),
    ("message_updated", Declared::Scope("messages.read")),
    ("message_deleted", Declared::Scope("messages.read")),
    ("reaction_added", Declared::Scope("messages.read")),
    ("typing", Declared::Scope("servers.read")),
    ("presence", Declared::Scope("servers.read")),
    ("member_joined", Declared::Scope("servers.read")),
    ("server_updated", Declared::Scope("servers.read")),
    ("role_updated", Declared::Scope("servers.read")),
    ("dm_message_created", Declared::Scope("dms.read")),
    ("ping", Declared::Scope("messages.read")),
    ("inbox_item", Declared::Scope("messages.read")),
    ("friend_request", Declared::Scope("friends")),
    ("voice_state", Declared::Scope("calls")),
    ("call_offer", Declared::Scope("calls")),
    ("me_updated", Declared::Scope("account")),
    ("settings_changed", Declared::Scope("realtime")),
    ("e2ee_handshake", Declared::Device),
    ("e2ee_welcome", Declared::Device),
    ("e2ee_keypackages_low", Declared::Device),
    ("e2ee_commit_request", Declared::Never),
    ("security_notice", Declared::Never),
    ("sessions_changed", Declared::Never),
    ("two_factor_changed", Declared::Never),
    ("protections_changed", Declared::Never),
    ("grants_changed", Declared::Never),
    ("tokens_revoked", Declared::Never),
    ("site_admin_changed", Declared::Never),
    ("user_registered", Declared::Never),
    ("server_created", Declared::Never),
];

pub fn declared(event: &str) -> Option<Declared> {
    EVENTS
        .iter()
        .find(|(name, _)| *name == event)
        .map(|(_, need)| *need)
}

pub fn event_allowed(
    event: &str,
    grant: &BTreeSet<String>,
    picked: Option<&BTreeSet<String>>,
    server: Option<&str>,
    is_application_device: bool,
) -> bool {
    match declared(event) {
        None | Some(Declared::Never) => false,
        Some(Declared::Device) => is_application_device && grant.contains("encrypted.read"),
        Some(Declared::Scope(scope)) => {
            let in_picks = match (server, picked) {
                (Some(server), Some(picked)) => picked.contains(server),
                (_, _) => true,
            };
            grant.contains("realtime") && grant.contains(scope) && in_picks
        }
    }
}
