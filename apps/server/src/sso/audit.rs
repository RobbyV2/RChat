use crate::{api::instance_audit, db::Db};
use serde_json::Value;

/// Record an operational event without interrupting a completed account change.
pub async fn note(db: &Db, actor: &str, action: &str, target: Option<&str>, detail: Value) {
    if instance_audit::record(db, actor, action, target, detail)
        .await
        .is_err()
    {
        tracing::warn!(action, "Could not record SSO audit event");
    }
}
