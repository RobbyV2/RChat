use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct DirectMessage {
    pub id: String,
    pub username1: String,
    pub username2: String,
    pub created_at: String,
    pub last_message_at: Option<String>,
    pub message_count: i64,
    pub is_active: i64,
}

impl DirectMessage {
    pub fn new(mut username1: String, mut username2: String) -> Self {
        if username1 > username2 {
            std::mem::swap(&mut username1, &mut username2);
        }

        Self {
            id: Uuid::new_v4().to_string(),
            username1,
            username2,
            created_at: Utc::now().to_rfc3339(),
            last_message_at: None,
            message_count: 0,
            is_active: 1,
        }
    }
}
