use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Message {
    pub id: String,
    pub channel_id: Option<String>,
    pub dm_id: Option<String>,
    pub sender_username: String,
    pub content: String,
    pub filtered_content: Option<String>,
    pub content_type: String,
    pub created_at: String,
    pub edited_at: Option<String>,
    pub is_deleted: i64,
    pub filter_status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct MessageWithSender {
    #[sqlx(flatten)]
    #[serde(flatten)]
    pub message: Message,
    pub sender_profile_type: String,
    pub sender_avatar_color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContentType {
    Text,
    Markdown,
    FileAttachment,
}

impl ContentType {
    pub fn as_str(&self) -> &str {
        match self {
            ContentType::Text => "text",
            ContentType::Markdown => "markdown",
            ContentType::FileAttachment => "file_attachment",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FilterStatus {
    Clean,
    Filtered,
    Warning,
}

impl FilterStatus {
    pub fn as_str(&self) -> &str {
        match self {
            FilterStatus::Clean => "clean",
            FilterStatus::Filtered => "filtered",
            FilterStatus::Warning => "warning",
        }
    }
}

impl Message {
    pub fn new(
        channel_id: Option<String>,
        dm_id: Option<String>,
        sender_username: String,
        content: String,
        content_type: ContentType,
        filter_status: FilterStatus,
        filtered_content: Option<String>,
    ) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            channel_id,
            dm_id,
            sender_username,
            content,
            filtered_content,
            content_type: content_type.as_str().to_string(),
            created_at: Utc::now().to_rfc3339(),
            edited_at: None,
            is_deleted: 0,
            filter_status: filter_status.as_str().to_string(),
        }
    }
}
