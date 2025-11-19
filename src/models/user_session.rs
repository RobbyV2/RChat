use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct UserSession {
    pub id: String,
    pub username: Option<String>,
    pub server_preferences: Option<String>,
    pub last_activity: String,
    pub created_at: String,
    pub expires_at: String,
}

impl UserSession {
    pub fn new(username: Option<String>) -> Self {
        let now = Utc::now();
        let expires = now + Duration::days(30);

        Self {
            id: Uuid::new_v4().to_string(),
            username,
            server_preferences: None,
            last_activity: now.to_rfc3339(),
            created_at: now.to_rfc3339(),
            expires_at: expires.to_rfc3339(),
        }
    }
}
