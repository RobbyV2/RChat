//! A server's about: a short description and how its icon is drawn.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::api::auth::clean_multiline;
use crate::api::{ApiError, ProfanityTarget, check_profanity};
use crate::db::Db;

/// Most characters (code points) a server description holds.
pub const ABOUT_MAX: usize = 300;

/// How a server's icon is drawn, on the server's `banner_color` when it has one.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum IconKind {
    /// The first letter of the server's name.
    #[default]
    Letter,
    /// A pattern made from the server's key.
    Identicon,
}

impl IconKind {
    pub fn as_str(self) -> &'static str {
        match self {
            IconKind::Letter => "letter",
            IconKind::Identicon => "identicon",
        }
    }

    /// The stored column: `NULL` and anything unknown read as a letter.
    pub fn stored(value: Option<&str>) -> Self {
        match value {
            Some("identicon") => IconKind::Identicon,
            _ => IconKind::Letter,
        }
    }
}

/// A description as it is stored: trimmed, control characters other than newlines dropped,
/// runs of 3 or more newlines cut to 2, at most `ABOUT_MAX` characters, checked by the
/// profanity filter (`server_names` target). Blank clears it.
pub async fn clean_description(db: &Db, text: Option<&str>) -> Result<Option<String>, ApiError> {
    let Some(text) = clean_multiline(text.unwrap_or(""), ABOUT_MAX, "Description")? else {
        return Ok(None);
    };
    check_profanity(db, ProfanityTarget::ServerNames, &text).await?;
    Ok(Some(text))
}

#[cfg(test)]
mod tests;
