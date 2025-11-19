use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Server {
    pub name: String,
    pub creator_username: String,
    pub created_at: String,
    pub is_active: i64,
    pub member_count: i64,
    pub channel_count: i64,
}

impl Server {
    pub fn new(name: String, creator_username: String) -> Self {
        Self {
            name,
            creator_username,
            created_at: Utc::now().to_rfc3339(),
            is_active: 1,
            member_count: 0,
            channel_count: 0,
        }
    }
}
