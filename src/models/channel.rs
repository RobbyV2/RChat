use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Channel {
    pub id: String,
    pub server_name: String,
    pub name: String,
    pub created_at: String,
    pub is_active: i64,
    pub message_count: i64,
    pub position: i64,
}

impl Channel {
    pub fn new(server_name: String, name: String, position: i64) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            server_name,
            name,
            created_at: Utc::now().to_rfc3339(),
            is_active: 1,
            message_count: 0,
            position,
        }
    }
}
