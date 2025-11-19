use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct ServerMember {
    pub server_name: String,
    pub username: String,
    pub role: String,
    pub joined_at: String,
    pub last_seen: String,
    pub is_online: i64,
    #[serde(default)]
    pub position: i64,
    #[serde(default)]
    pub profile_type: Option<String>,
    #[serde(default)]
    pub avatar_color: Option<String>,
}

impl ServerMember {
    pub fn new(server_name: String, username: String, role: ServerRole) -> Self {
        let now = Utc::now().to_rfc3339();
        Self {
            server_name,
            username,
            role: role.as_str().to_string(),
            joined_at: now.clone(),
            last_seen: now,
            is_online: 0,
            position: 0,
            profile_type: None, // Default, will be populated by join if needed
            avatar_color: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ServerRole {
    Member,
    Admin,
}

impl ServerRole {
    pub fn as_str(&self) -> &str {
        match self {
            ServerRole::Member => "member",
            ServerRole::Admin => "admin",
        }
    }
}
