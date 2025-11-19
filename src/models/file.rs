use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct File {
    pub id: String,
    pub original_name: String,
    pub file_name: String,
    pub content_type: String,
    pub size: i64,
    pub file_hash: String,
    pub upload_time: String,
    pub expires_at: String,
    pub download_count: i64,
    pub uploader_username: String,
    pub is_deleted: i64,
}

impl File {
    pub fn new(
        original_name: String,
        file_name: String,
        content_type: String,
        size: i64,
        file_hash: String,
        uploader_username: String,
    ) -> Self {
        let now = Utc::now();
        let expires = now + Duration::hours(24);

        Self {
            id: Uuid::new_v4().to_string(),
            original_name,
            file_name,
            content_type,
            size,
            file_hash,
            upload_time: now.to_rfc3339(),
            expires_at: expires.to_rfc3339(),
            download_count: 0,
            uploader_username,
            is_deleted: 0,
        }
    }
}
