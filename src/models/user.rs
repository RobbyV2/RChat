use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct User {
    pub username: String,
    pub password_hash: String,
    pub password_type: String,
    pub word_sequence: Option<String>,
    pub profile_type: String,
    pub avatar_color: Option<String>,
    pub created_at: String,
    pub last_login: Option<String>,
    pub login_attempts: i64,
    pub account_locked: i64,
    pub lock_until: Option<String>,
    pub is_admin: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PasswordType {
    Text,
    WordSequence,
}

impl PasswordType {
    pub fn as_str(&self) -> &str {
        match self {
            PasswordType::Text => "text",
            PasswordType::WordSequence => "word_sequence",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "text" => Some(PasswordType::Text),
            "word_sequence" => Some(PasswordType::WordSequence),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProfileType {
    Identicon(String),
    Person(String),
}

impl ProfileType {
    pub fn as_str(&self) -> &str {
        match self {
            ProfileType::Identicon(_) => "identicon",
            ProfileType::Person(_) => "person",
        }
    }

    pub fn from_str_with_data(type_str: &str, data: Option<String>) -> Option<Self> {
        match type_str {
            "identicon" => Some(ProfileType::Identicon(data.unwrap_or_default())),
            "person" => Some(ProfileType::Person(data.unwrap_or_default())),
            _ => None,
        }
    }

    pub fn data(&self) -> &str {
        match self {
            ProfileType::Identicon(data) => data,
            ProfileType::Person(data) => data,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateUserRequest {
    pub username: String,
    pub password: Option<String>,
    pub word_sequence: Option<Vec<String>>,
    pub profile_type: ProfileType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserResponse {
    pub username: String,
    pub profile_type: String,
    pub avatar_color: Option<String>,
    pub created_at: String,
    pub is_admin: bool,
}

impl From<User> for UserResponse {
    fn from(user: User) -> Self {
        Self {
            username: user.username,
            profile_type: user.profile_type,
            avatar_color: user.avatar_color,
            created_at: user.created_at,
            is_admin: user.is_admin == 1,
        }
    }
}

impl User {
    pub fn new(
        username: String,
        password_hash: String,
        password_type: PasswordType,
        word_sequence: Option<Vec<String>>,
        profile_type: ProfileType,
        is_admin: bool,
    ) -> Self {
        let now = Utc::now().to_rfc3339();
        let word_seq_json = word_sequence.map(|ws| serde_json::to_string(&ws).unwrap());

        Self {
            username,
            password_hash,
            password_type: password_type.as_str().to_string(),
            word_sequence: word_seq_json,
            profile_type: profile_type.as_str().to_string(),
            avatar_color: match &profile_type {
                ProfileType::Person(color) => Some(color.clone()),
                ProfileType::Identicon(_) => None,
            },
            created_at: now,
            last_login: None,
            login_attempts: 0,
            account_locked: 0,
            lock_until: None,
            is_admin: if is_admin { 1 } else { 0 },
        }
    }

    pub fn is_locked(&self) -> bool {
        if self.account_locked == 0 {
            return false;
        }

        if let Some(lock_until) = &self.lock_until
            && let Ok(lock_time) = DateTime::parse_from_rfc3339(lock_until)
        {
            return Utc::now() < lock_time;
        }

        false
    }
}
