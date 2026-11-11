use axum::extract::{Query, State};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::Row;

use crate::api::{ApiError, Authed, Paged, cursor_int, decode_cursor, encode_cursor};
use crate::db::{Db, now};
use crate::state::AppState;

const PAGE: i64 = 50;

/// Notes an instance-level action by `actor` (a username) on `target` in the instance audit
/// log, which only the hidden admin panel lists. Actions on an account are named `user.*` with
/// the username as `target`; other targets (a provider, a server, a report) use other prefixes.
pub async fn record(
    db: &Db,
    actor: &str,
    action: &str,
    target: Option<&str>,
    detail: Value,
) -> Result<(), ApiError> {
    let mut conn = db.acquire().await?;
    record_in(&mut conn, actor, action, target, detail, now()).await
}

/// `record` inside a transaction or on a held connection, at `t`.
pub(crate) async fn record_in(
    conn: &mut sqlx::AnyConnection,
    actor: &str,
    action: &str,
    target: Option<&str>,
    detail: Value,
    t: i64,
) -> Result<(), ApiError> {
    Ok(insert(conn, Some(actor), action, target, detail, t).await?)
}

/// Notes a change the server config made at a start. Such an entry has no actor, like one
/// whose actor's account was deleted since; `by: "config"` in its detail tells the two apart,
/// and only this function writes that mark.
pub(crate) async fn record_config(
    conn: &mut sqlx::AnyConnection,
    action: &str,
    target: Option<&str>,
    detail: Value,
    t: i64,
) -> sqlx::Result<()> {
    insert(conn, None, action, target, detail, t).await
}

/// The detail key that marks an entry the server config made.
const BY: &str = "by";

async fn insert(
    conn: &mut sqlx::AnyConnection,
    actor: Option<&str>,
    action: &str,
    target: Option<&str>,
    detail: Value,
    t: i64,
) -> sqlx::Result<()> {
    let mut fields = match detail {
        Value::Object(fields) => fields,
        _ => serde_json::Map::new(),
    };
    match actor {
        Some(_) => fields.remove(BY),
        None => fields.insert(BY.to_string(), Value::from("config")),
    };
    let detail = Value::Object(fields);
    sqlx::query(
        "INSERT INTO instance_audit(at, actor, action, target, detail) VALUES($1, $2, $3, $4, $5)",
    )
    .bind(t)
    .bind(actor)
    .bind(action)
    .bind(target)
    .bind(detail.to_string())
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Drops a deleted account's name from the log (as actor, and as the target of `user.*`
/// actions), so a new account with the same username never inherits its history.
pub(crate) async fn forget_user(
    conn: &mut sqlx::AnyConnection,
    username: &str,
) -> sqlx::Result<()> {
    sqlx::query("UPDATE instance_audit SET actor = NULL WHERE actor = $1")
        .bind(username)
        .execute(&mut *conn)
        .await?;
    sqlx::query(
        "UPDATE instance_audit SET target = NULL WHERE target = $1 AND action LIKE 'user.%'",
    )
    .bind(username)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

#[derive(Serialize)]
pub struct Entry {
    pub id: i64,
    pub at: i64,
    pub actor: Option<String>,
    pub action: String,
    pub target: Option<String>,
    pub detail: Value,
}

#[derive(Deserialize)]
pub struct AuditQuery {
    cursor: Option<String>,
}

pub(crate) async fn list(
    State(state): State<AppState>,
    Authed(user): Authed,
    Query(query): Query<AuditQuery>,
) -> Result<Paged<Entry>, ApiError> {
    crate::api::admin::require_site_admin(&user)?;
    let AuditQuery { cursor } = query;
    let before = match cursor.as_deref().filter(|c| !c.trim().is_empty()) {
        Some(raw) => cursor_int(&decode_cursor(raw, 1)?.remove(0))?,
        None => i64::MAX,
    };
    let rows = sqlx::query(
        "SELECT id, at, actor, action, target, detail FROM instance_audit WHERE id < $1 ORDER BY id DESC LIMIT $2",
    )
    .bind(before)
    .bind(PAGE + 1)
    .fetch_all(&state.read())
    .await?;
    let more = rows.len() as i64 > PAGE;
    let mut entries = Vec::with_capacity(rows.len());
    for r in rows.iter().take(PAGE as usize) {
        let detail: String = r.try_get(5)?;
        entries.push(Entry {
            id: r.try_get(0)?,
            at: r.try_get(1)?,
            actor: r.try_get(2)?,
            action: r.try_get(3)?,
            target: r.try_get(4)?,
            detail: serde_json::from_str(&detail).unwrap_or(Value::Null),
        });
    }
    let next = match (more, entries.last()) {
        (true, Some(e)) => Some(encode_cursor(&[&e.id.to_string()])),
        _ => None,
    };
    Ok(Paged(entries, next))
}
