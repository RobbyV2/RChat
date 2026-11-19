use rand::Rng;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::db::NO_PERMANENT_HASH;

/// How people join a server: `name` (anyone who knows its name), `invite` (only with an invite
/// link, or a password the managers made), `password` (its name and its password) or `closed`
/// (nobody new).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum JoinMode {
    #[default]
    Name,
    Invite,
    Password,
    Closed,
}

impl JoinMode {
    pub fn as_str(self) -> &'static str {
        match self {
            JoinMode::Name => "name",
            JoinMode::Invite => "invite",
            JoinMode::Password => "password",
            JoinMode::Closed => "closed",
        }
    }

    pub fn parse(stored: &str) -> Option<JoinMode> {
        match stored {
            "name" => Some(JoinMode::Name),
            "invite" => Some(JoinMode::Invite),
            "password" => Some(JoinMode::Password),
            "closed" => Some(JoinMode::Closed),
            _ => None,
        }
    }

    /// Whether the server's key is its lowercase name, so that people can find it by name.
    pub fn by_name(self) -> bool {
        match self {
            JoinMode::Name | JoinMode::Password => true,
            JoinMode::Invite | JoinMode::Closed => false,
        }
    }

    /// The `password_hash` a server of this mode keeps, given the hash of its permanent
    /// password (for `password`).
    pub fn hash(self, permanent: Option<String>) -> Option<String> {
        match self {
            JoinMode::Name => None,
            JoinMode::Password => permanent,
            JoinMode::Invite | JoinMode::Closed => Some(NO_PERMANENT_HASH.to_string()),
        }
    }
}

/// The join mode of a server from its stored `join_mode` and its `password_hash`. The hash
/// decides between a server without a password, one with a permanent password and one without
/// (`!none`): copies that don't know join modes change only the hash. Among servers without a
/// permanent password the stored mode tells an invite server from a closed one; where it doesn't
/// (servers from before join modes), `None`: an invite server while it has a live extra
/// password, a closed one otherwise.
pub fn join_mode_of(stored: Option<&str>, hash: Option<&str>) -> Option<JoinMode> {
    match (hash, stored.and_then(JoinMode::parse)) {
        (None, _) => Some(JoinMode::Name),
        (Some(NO_PERMANENT_HASH), Some(mode @ (JoinMode::Invite | JoinMode::Closed))) => Some(mode),
        (Some(NO_PERMANENT_HASH), Some(JoinMode::Name | JoinMode::Password) | None) => None,
        (Some(_), _) => Some(JoinMode::Password),
    }
}

/// The mode of a server without a permanent password whose stored mode doesn't say.
pub fn legacy_mode(live_extra: bool) -> JoinMode {
    match live_extra {
        true => JoinMode::Invite,
        false => JoinMode::Closed,
    }
}

/// Whether a server keeps its key when it is renamed: the built-in server, and servers whose
/// key isn't their name (invite and closed servers whose stored mode says so). Every other
/// server takes its new lowercase name as its key.
pub fn keeps_key(builtin: bool, stored: Option<JoinMode>, mode: JoinMode) -> bool {
    builtin || (stored.is_some_and(|s| !s.by_name()) && !mode.by_name())
}

/// Letters and digits that can't be mistaken for each other (no `0`, `o`, `1`, `l`, `i`).
pub const ALPHABET: &[u8; 31] = b"23456789abcdefghjkmnpqrstuvwxyz";

/// Length of the random key of an invite or closed server.
pub const KEY_LEN: usize = 10;

/// `len` characters from `ALPHABET`, each equally likely.
pub fn random_text(len: usize) -> String {
    let mut out = String::with_capacity(len);
    let mut rng = rand::rng();
    while out.len() < len {
        let mut byte = [0u8; 1];
        rng.fill_bytes(&mut byte);
        if byte[0] < 248 {
            out.push(ALPHABET[(byte[0] % 31) as usize] as char);
        }
    }
    out
}

/// The channels a new server starts with: `text` (a text channel `general`) or `text_voice`
/// (also a voice channel `Voice`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum StartChannels {
    #[default]
    Text,
    TextVoice,
}

#[cfg(test)]
mod tests;
