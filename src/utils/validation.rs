use crate::services::profanity::contains_profanity;
use crate::utils::error::{AppError, AppResult};

fn is_printable_ascii(s: &str) -> bool {
    s.chars().all(|c| c.is_ascii() && !c.is_ascii_control())
}

pub fn validate_username(username: &str) -> AppResult<()> {
    if username.is_empty() {
        return Err(AppError::Validation("Username cannot be empty".to_string()));
    }

    if username.len() > 64 {
        return Err(AppError::Validation(
            "Username must be at most 64 characters long".to_string(),
        ));
    }

    if !is_printable_ascii(username) {
        return Err(AppError::Validation(
            "Username must contain only printable ASCII characters".to_string(),
        ));
    }

    if contains_profanity(username) {
        return Err(AppError::Validation(
            "Username contains inappropriate language".to_string(),
        ));
    }

    Ok(())
}

pub fn validate_server_name(name: &str) -> AppResult<()> {
    if name.is_empty() {
        return Err(AppError::Validation(
            "Server name cannot be empty".to_string(),
        ));
    }

    if name.len() > 64 {
        return Err(AppError::Validation(
            "Server name must be at most 64 characters long".to_string(),
        ));
    }

    if !is_printable_ascii(name) {
        return Err(AppError::Validation(
            "Server name must contain only printable ASCII characters".to_string(),
        ));
    }

    if contains_profanity(name) {
        return Err(AppError::Validation(
            "Server name contains inappropriate language".to_string(),
        ));
    }

    Ok(())
}

pub fn validate_channel_name(name: &str) -> AppResult<()> {
    if name.is_empty() {
        return Err(AppError::Validation(
            "Channel name cannot be empty".to_string(),
        ));
    }

    if name.len() > 64 {
        return Err(AppError::Validation(
            "Channel name must be at most 64 characters long".to_string(),
        ));
    }

    if !is_printable_ascii(name) {
        return Err(AppError::Validation(
            "Channel name must contain only printable ASCII characters".to_string(),
        ));
    }

    if contains_profanity(name) {
        return Err(AppError::Validation(
            "Channel name contains inappropriate language".to_string(),
        ));
    }

    Ok(())
}

pub fn validate_message_content(content: &str) -> AppResult<()> {
    if content.is_empty() {
        return Err(AppError::Validation(
            "Message content cannot be empty".to_string(),
        ));
    }

    if content.len() > 4000 {
        return Err(AppError::Validation(
            "Message content must be at most 4000 characters long".to_string(),
        ));
    }

    Ok(())
}
