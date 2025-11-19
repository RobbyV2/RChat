use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct LoginAttempt {
    pub id: String,
    pub username: String,
    pub ip_address: String,
    pub success: i64,
    pub timestamp: String,
    pub attempted_username: Option<String>,
    pub failure_reason: Option<String>,
}

impl LoginAttempt {
    pub fn new(
        username: String,
        ip_address: String,
        success: bool,
        attempted_username: Option<String>,
        failure_reason: Option<String>,
    ) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            username,
            ip_address,
            success: if success { 1 } else { 0 },
            timestamp: Utc::now().to_rfc3339(),
            attempted_username,
            failure_reason,
        }
    }
}
