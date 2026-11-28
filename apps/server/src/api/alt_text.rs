//! Descriptions of attached images, for people who can't see them.

use crate::api::auth::clean_multiline;
use crate::api::{ApiError, ProfanityTarget, Settings, bad};

/// Most characters (code points) a description holds.
pub const ALT_MAX: usize = 1000;

/// The refusal for a description on a message without an attachment.
pub const NOTHING_TO_DESCRIBE: &str = "Image description needs an attachment";

/// A description as it is stored: trimmed, control characters other than newlines dropped, runs
/// of 3 or more newlines cut to 2, at most `ALT_MAX` characters. In a server channel it is
/// checked by the profanity filter like the message (`messages` target). Blank is none.
pub fn clean_alt(
    settings: &Settings,
    text: Option<&str>,
    in_channel: bool,
) -> Result<Option<String>, ApiError> {
    let Some(text) = clean_multiline(text.unwrap_or(""), ALT_MAX, "Image description")? else {
        return Ok(None);
    };
    if in_channel {
        settings.check_profanity(ProfanityTarget::Messages, &text)?;
    }
    Ok(Some(text))
}

/// The description a new message stores: none without an attachment to describe.
pub fn alt_to_store(
    settings: &Settings,
    text: Option<&str>,
    attached: bool,
    in_channel: bool,
) -> Result<Option<String>, ApiError> {
    match (text, attached) {
        (None, _) => Ok(None),
        (Some(_), false) => Err(bad(NOTHING_TO_DESCRIBE)),
        (Some(t), true) => clean_alt(settings, Some(t), in_channel),
    }
}

#[cfg(test)]
mod tests;
