use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Who may see an account's profile, least open first: `friends` (only an account's own
/// choice), `shared` (people who share a server, a direct conversation the account wrote in or
/// a friendship with it), `public_servers` (also everyone, for an account in a server anyone
/// can read) and `everyone`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum Level {
    Friends,
    Shared,
    PublicServers,
    Everyone,
}

impl Level {
    pub const KEY: &str = "profile_visibility";
    pub const ENV: &str = "PROFILE_VISIBILITY";
    /// The levels an instance may choose.
    pub const WORDS: [&str; 3] = ["everyone", "public_servers", "shared"];

    pub fn as_str(self) -> &'static str {
        match self {
            Level::Friends => "friends",
            Level::Shared => "shared",
            Level::PublicServers => "public_servers",
            Level::Everyone => "everyone",
        }
    }

    /// The instance level `value` names.
    pub fn parse(value: &str) -> Option<Level> {
        match value {
            "everyone" => Some(Level::Everyone),
            "public_servers" => Some(Level::PublicServers),
            "shared" => Some(Level::Shared),
            _ => None,
        }
    }
}
