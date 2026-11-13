pub mod forms;

use crate::api::{ApiError, bad};

/// The answer to a report request or a forms document the instance refuses for what it says.
/// Every such refusal is built here.
pub(crate) fn refused(msg: &str) -> ApiError {
    bad(msg)
}
