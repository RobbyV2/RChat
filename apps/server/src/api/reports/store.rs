use serde_json::{Value, json};
use sqlx::{AnyConnection, Row};

use super::forms::StoredAnswer;
use super::limits::{Caps, Class, allowed};
use super::query::visible;
use super::snapshot::Snapshot;
use super::{Audience, ModAction, MutedReporter, Placed, ReportKind, Status};
use crate::api::access::ReportScope;
use crate::api::audit::{
    self, Action, ChannelRef, Details, Entry, Target, TargetKind, like_escape,
};
use crate::api::{
    ApiError, LIST_PAGE, Paged, decode_cursor, encode_cursor, instance_audit, user_from, user_refs,
};
use crate::db::{Db, PURGE_BATCH, delete_batched};

/// How many reports `forget_user` reads at a time.
const FORGET_BATCH: i64 = 200;

/// A report about to be stored.
pub(super) struct NewReport<'a> {
    pub kind: ReportKind,
    pub placed: &'a Placed,
    pub reporter: &'a str,
    pub form: &'a str,
    pub form_label: &'a str,
    pub form_rev: i64,
    pub reason: &'a str,
    pub reason_label: Option<&'a str>,
    pub note: Option<&'a str>,
    pub answers: &'a [StoredAnswer],
}

/// Whether the reports of `reporter` to `kind` (for `server`, in that server) are muted.
async fn muted(
    conn: &mut AnyConnection,
    kind: ReportKind,
    server: Option<&str>,
    reporter: &str,
) -> sqlx::Result<bool> {
    let row = match (kind, server) {
        (ReportKind::Server, Some(server)) => {
            sqlx::query("SELECT 1 FROM report_mutes WHERE server = $1 AND username = $2")
                .bind(server)
                .bind(reporter)
                .fetch_optional(&mut *conn)
                .await?
        }
        (ReportKind::Server, None) => None,
        (ReportKind::Instance, _) => {
            sqlx::query("SELECT 1 FROM instance_report_mutes WHERE username = $1")
                .bind(reporter)
                .fetch_optional(&mut *conn)
                .await?
        }
    };
    Ok(row.is_some())
}

/// Stores `report` at `t` and answers its id, or `None` when the reporter is muted or past a
/// cap of `caps`. One transaction: it writes the reporter's pace row first, so the reports an
/// account sends at once, also through other copies of the server, are counted one after the
/// other.
pub(super) async fn insert(
    db: &Db,
    report: NewReport<'_>,
    class: Class<'_>,
    caps: Caps,
    t: i64,
) -> Result<Option<i64>, ApiError> {
    let NewReport {
        kind,
        placed,
        reporter,
        form,
        form_label,
        form_rev,
        reason,
        reason_label,
        note,
        answers,
    } = report;
    let server = placed.server.as_ref().map(|(name, _)| name.as_str());
    let mut tx = db.begin().await?;
    sqlx::query("INSERT INTO report_pace(reporter, kind, last_at) VALUES($1, $2, $3) ON CONFLICT(reporter, kind) DO UPDATE SET last_at = excluded.last_at")
        .bind(reporter)
        .bind(kind.as_str())
        .bind(t)
        .execute(&mut *tx)
        .await?;
    if muted(&mut tx, kind, server, reporter).await?
        || !allowed(&mut tx, reporter, kind, class, caps, t).await?
    {
        return Ok(None);
    }
    let snapshot = serde_json::to_string(&placed.snapshot).map_err(ApiError::internal)?;
    let answers = serde_json::to_string(answers).map_err(ApiError::internal)?;
    let id: i64 = sqlx::query("INSERT INTO reports(kind, server, server_name, target_kind, target_key, target_user, message_id, channel_id, channel_private, dm_id, role_id, role_name, reporter, form, form_label, form_rev, reason, reason_label, note, answers, snapshot, created_at, updated_at) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $22) RETURNING id")
        .bind(kind.as_str())
        .bind(server)
        .bind(placed.server.as_ref().map(|(_, shown)| shown.as_str()))
        .bind(placed.target_kind)
        .bind(&placed.target_key)
        .bind(placed.target_user.as_deref())
        .bind(placed.message_id)
        .bind(placed.channel_id)
        .bind(i64::from(placed.channel_private))
        .bind(placed.dm_id)
        .bind(placed.role.as_ref().map(|(id, _)| *id))
        .bind(placed.role.as_ref().map(|(_, name)| name.as_str()))
        .bind(reporter)
        .bind(form)
        .bind(form_label)
        .bind(form_rev)
        .bind(reason)
        .bind(reason_label)
        .bind(note)
        .bind(answers)
        .bind(snapshot)
        .bind(t)
        .fetch_one(&mut *tx)
        .await?
        .try_get(0)?;
    event(&mut tx, id, None, "created", json!({}), t).await?;
    tx.commit().await?;
    Ok(Some(id))
}

/// Adds a line to the history of report `id`.
pub(super) async fn event(
    conn: &mut AnyConnection,
    id: i64,
    actor: Option<&str>,
    kind: &str,
    detail: Value,
    t: i64,
) -> sqlx::Result<()> {
    sqlx::query("INSERT INTO report_events(report_id, actor, kind, detail, created_at) VALUES($1, $2, $3, $4, $5)")
        .bind(id)
        .bind(actor)
        .bind(kind)
        .bind(detail.to_string())
        .bind(t)
        .execute(&mut *conn)
        .await
        .map(|_| ())
}

/// A change to one report.
pub(super) struct Change {
    pub id: i64,
    /// The new status and, for `resolved`, what was done.
    pub status: Option<(Status, Option<ModAction>)>,
    /// The new assignee, or nobody.
    pub assignee: Option<Option<String>>,
}

/// What a change to reports is logged as.
#[derive(Clone, Copy)]
pub(super) enum Noted {
    Status,
    Assign,
    Note,
    Escalate,
    Resolve,
}

impl Noted {
    fn action(self) -> Action {
        match self {
            Noted::Status | Noted::Resolve => Action::ReportStatus,
            Noted::Assign => Action::ReportAssign,
            Noted::Note => Action::ReportNote,
            Noted::Escalate => Action::ReportEscalate,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Noted::Resolve => "report.resolve",
            Noted::Status | Noted::Assign | Noted::Note | Noted::Escalate => self.action().as_str(),
        }
    }
}

/// The channel of the reported message as report `id` keeps it: the channel's name now, or the
/// one it had when the report was sent, and whether it was private then.
async fn channel_of(conn: &mut AnyConnection, id: i64) -> Result<Option<ChannelRef>, ApiError> {
    let Some(row) = sqlx::query("SELECT r.channel_id, r.channel_private, c.name, r.snapshot FROM reports r LEFT JOIN channels c ON c.id = r.channel_id WHERE r.id = $1")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await?
    else {
        return Ok(None);
    };
    let Some(channel) = row.try_get::<Option<i64>, _>(0)? else {
        return Ok(None);
    };
    let name = match row.try_get::<Option<String>, _>(2)? {
        Some(name) => name,
        None => serde_json::from_str::<Snapshot>(&row.try_get::<String, _>(3)?)
            .ok()
            .and_then(|snapshot| snapshot.channel)
            .unwrap_or_default(),
    };
    Ok(Some(ChannelRef {
        id: channel,
        name,
        private: row.try_get::<i64, _>(1)? != 0,
    }))
}

/// What a logged change is about: one report, or several with the channels they come from
/// (each channel's id and whether it was private).
enum About<'a> {
    One(i64),
    Many(&'a [(i64, bool)]),
}

/// Logs a change to reports by `actor`: in the server's audit log for a server's reports, in
/// the instance audit log for the reports to the instance. The entry never names the reporter
/// or the one reported. In the server's log it carries the channels of the reported messages,
/// so it is hidden from who can't view one of them.
async fn log(
    conn: &mut AnyConnection,
    scope: &ReportScope,
    actor: &str,
    noted: Noted,
    about: About<'_>,
    details: &[(&str, Value)],
    t: i64,
) -> Result<(), ApiError> {
    let id = match about {
        About::One(id) => Some(id),
        About::Many(_) => None,
    };
    match &scope.server {
        Some(server) => {
            let details = details
                .iter()
                .fold(Details::new(), |d, (key, value)| d.set(key, value.clone()));
            let details = match about {
                About::One(id) => match channel_of(conn, id).await? {
                    Some(channel) => details.channel(&channel),
                    None => details,
                },
                About::Many(channels) => channels.iter().fold(details, |d, (id, private)| {
                    d.mention(&ChannelRef {
                        id: *id,
                        name: String::new(),
                        private: *private,
                    })
                }),
            };
            let target = Target {
                kind: TargetKind::Report,
                id,
                name: None,
            };
            let entry = Entry::new(server, &scope.actor(), noted.action())
                .target(target)
                .details(details);
            Ok(audit::record(conn, entry).await?)
        }
        None => {
            let detail: serde_json::Map<String, Value> = details
                .iter()
                .map(|(key, value)| (key.to_string(), value.clone()))
                .collect();
            let target = id.map(|id| format!("report:{id}"));
            instance_audit::record_in(
                conn,
                actor,
                noted.name(),
                target.as_deref(),
                Value::Object(detail),
                t,
            )
            .await
        }
    }
}

fn status_detail(status: Status, action: Option<ModAction>) -> Vec<(&'static str, Value)> {
    let mut detail = vec![("status", Value::from(status.as_str()))];
    if let Some(action) = action {
        detail.push(("action", Value::from(action.as_str())));
    }
    detail
}

fn object(detail: &[(&str, Value)]) -> Value {
    Value::Object(
        detail
            .iter()
            .map(|(key, value)| (key.to_string(), value.clone()))
            .collect(),
    )
}

/// Applies `change` by `actor` at `t` on `conn`, with its history lines and audit entries.
pub(super) async fn change(
    conn: &mut AnyConnection,
    scope: &ReportScope,
    actor: &str,
    change: Change,
    t: i64,
) -> Result<(), ApiError> {
    let Change {
        id,
        status,
        assignee,
    } = change;
    if let Some((status, action)) = status {
        let closed = match status {
            Status::Resolved | Status::Dismissed => Some(t),
            Status::Open | Status::InReview => None,
        };
        sqlx::query("UPDATE reports SET status = $1, action = $2, resolved_at = $3, updated_at = $4 WHERE id = $5")
            .bind(status.as_str())
            .bind(action.map(ModAction::as_str))
            .bind(closed)
            .bind(t)
            .bind(id)
            .execute(&mut *conn)
            .await?;
        let detail = status_detail(status, action);
        event(&mut *conn, id, Some(actor), "status", object(&detail), t).await?;
        log(
            &mut *conn,
            scope,
            actor,
            Noted::Status,
            About::One(id),
            &detail,
            t,
        )
        .await?;
    }
    if let Some(assignee) = assignee {
        sqlx::query("UPDATE reports SET assignee = $1, updated_at = $2 WHERE id = $3")
            .bind(assignee.as_deref())
            .bind(t)
            .bind(id)
            .execute(&mut *conn)
            .await?;
        event(
            &mut *conn,
            id,
            Some(actor),
            "assign",
            json!({ "assignee": assignee }),
            t,
        )
        .await?;
        let detail = [("assigned", Value::from(assignee.is_some()))];
        log(
            &mut *conn,
            scope,
            actor,
            Noted::Assign,
            About::One(id),
            &detail,
            t,
        )
        .await?;
    }
    Ok(())
}

/// Adds the note `text` by `actor` to the history of report `id`.
pub(super) async fn note(
    db: &Db,
    scope: &ReportScope,
    actor: &str,
    id: i64,
    text: &str,
    t: i64,
) -> Result<(), ApiError> {
    let mut tx = db.begin().await?;
    sqlx::query("UPDATE reports SET updated_at = $1 WHERE id = $2")
        .bind(t)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    event(&mut tx, id, Some(actor), "note", json!({ "text": text }), t).await?;
    log(&mut tx, scope, actor, Noted::Note, About::One(id), &[], t).await?;
    tx.commit().await?;
    Ok(())
}

/// Passes the server report `id` on to the instance as a copy that keeps the target, the
/// content, the reason, the reporter and their note and answers. `false` when it was passed
/// on before: there is never a second copy.
pub(super) async fn escalate(
    db: &Db,
    scope: &ReportScope,
    actor: &str,
    id: i64,
    note: Option<&str>,
    t: i64,
) -> Result<bool, ApiError> {
    let mut tx = db.begin().await?;
    let claimed = sqlx::query("UPDATE reports SET escalated_to = -1, updated_at = $1 WHERE id = $2 AND escalated_to IS NULL")
        .bind(t)
        .bind(id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if claimed == 0 {
        return Ok(false);
    }
    let copy: i64 = sqlx::query("INSERT INTO reports(kind, server, server_name, target_kind, target_key, target_user, message_id, channel_id, channel_private, dm_id, role_id, role_name, reporter, form, form_label, form_rev, reason, reason_label, note, answers, snapshot, franking, escalated_from, created_at, updated_at) SELECT 'instance', server, server_name, target_kind, target_key, target_user, message_id, channel_id, channel_private, dm_id, role_id, role_name, reporter, form, form_label, form_rev, reason, reason_label, note, answers, snapshot, franking, id, $1, $1 FROM reports WHERE id = $2 RETURNING id")
        .bind(t)
        .bind(id)
        .fetch_one(&mut *tx)
        .await?
        .try_get(0)?;
    sqlx::query("UPDATE reports SET escalated_to = $1 WHERE id = $2")
        .bind(copy)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let said = |key: &str, other: i64| {
        let mut detail = serde_json::Map::new();
        if let Some(note) = note {
            detail.insert("note".to_string(), Value::from(note));
        }
        detail.insert(key.to_string(), Value::from(other));
        Value::Object(detail)
    };
    event(&mut tx, id, Some(actor), "escalate", said("to", copy), t).await?;
    event(&mut tx, copy, None, "created", json!({}), t).await?;
    event(&mut tx, copy, Some(actor), "escalate", said("from", id), t).await?;
    log(
        &mut tx,
        scope,
        actor,
        Noted::Escalate,
        About::One(id),
        &[],
        t,
    )
    .await?;
    tx.commit().await?;
    Ok(true)
}

/// Who must not learn that report `id` changed.
pub(super) async fn audience(db: &Db, id: i64) -> Result<Audience, ApiError> {
    let row =
        sqlx::query("SELECT target_user, channel_id, channel_private FROM reports WHERE id = $1")
            .bind(id)
            .fetch_optional(db)
            .await?;
    Ok(match &row {
        Some(row) => audience_of(row, 0)?,
        None => Audience {
            about: None,
            channel: None,
        },
    })
}

/// The audience in the columns `target_user`, `channel_id` and `channel_private` from `at` on.
fn audience_of(row: &sqlx::any::AnyRow, at: usize) -> sqlx::Result<Audience> {
    let channel: Option<i64> = row.try_get(at + 1)?;
    let private = row.try_get::<i64, _>(at + 2)? != 0;
    Ok(Audience {
        about: row.try_get(at)?,
        channel: channel.map(|id| (id, private)),
    })
}

/// Closes every report of `scope` about `target` that is open or in review and that the
/// viewer can see, in one statement, and answers who must not learn of each. Logged once.
pub(super) async fn resolve_all(
    db: &Db,
    scope: &ReportScope,
    actor: &str,
    target: &str,
    to: (Status, Option<ModAction>),
    t: i64,
) -> Result<Vec<Audience>, ApiError> {
    let (status, action) = to;
    let mut clause = visible(scope);
    let key = clause.text(target);
    clause.and(format!(
        "r.target_key = {key} AND r.status IN ('open', 'in_review')"
    ));
    let (to_status, to_action, at) = (
        clause.text(status.as_str()),
        match action {
            Some(action) => clause.text(action.as_str()),
            None => "NULL".to_string(),
        },
        clause.int(t),
    );
    let sql = format!(
        "UPDATE reports SET status = {to_status}, action = {to_action}, resolved_at = {at}, updated_at = {at} WHERE id IN (SELECT r.id FROM reports r WHERE {}) RETURNING id, target_user, channel_id, channel_private",
        clause.sql()
    );
    let mut tx = db.begin().await?;
    let closed = clause.run(&mut tx, sql).await?;
    let detail = status_detail(status, action);
    let mut audiences = Vec::with_capacity(closed.len());
    for row in &closed {
        let id: i64 = row.try_get(0)?;
        event(&mut tx, id, Some(actor), "status", object(&detail), t).await?;
        audiences.push(audience_of(row, 1)?);
    }
    let count = closed.len() as i64;
    if count > 0 {
        let mut detail = detail;
        detail.insert(0, ("count", Value::from(count)));
        let mut channels: Vec<(i64, bool)> = Vec::new();
        for channel in audiences.iter().filter_map(|a| a.channel) {
            if !channels.contains(&channel) {
                channels.push(channel);
            }
        }
        let about = About::Many(&channels);
        log(&mut tx, scope, actor, Noted::Resolve, about, &detail, t).await?;
    }
    tx.commit().await?;
    Ok(audiences)
}

/// The accounts whose reports are muted in `scope`, by username, a page at a time.
pub(crate) async fn mutes(
    db: &Db,
    scope: &ReportScope,
    cursor: Option<&str>,
) -> Result<Paged<MutedReporter>, ApiError> {
    let after = match cursor.filter(|c| !c.trim().is_empty()) {
        Some(cursor) => decode_cursor(cursor, 1)?.remove(0),
        None => String::new(),
    };
    let rows = match &scope.server {
        Some(server) => {
            sqlx::query("SELECT username, created_at FROM report_mutes WHERE server = $1 AND username > $2 ORDER BY username LIMIT $3")
                .bind(server)
                .bind(&after)
                .bind(LIST_PAGE + 1)
                .fetch_all(db)
                .await?
        }
        None => {
            sqlx::query("SELECT username, created_at FROM instance_report_mutes WHERE username > $1 ORDER BY username LIMIT $2")
                .bind(&after)
                .bind(LIST_PAGE + 1)
                .fetch_all(db)
                .await?
        }
    };
    let mut found: Vec<(String, i64)> = Vec::with_capacity(rows.len());
    for row in &rows {
        found.push((row.try_get(0)?, row.try_get(1)?));
    }
    let more = found.len() as i64 > LIST_PAGE;
    found.truncate(LIST_PAGE as usize);
    let next = match (more, found.last()) {
        (true, Some((last, _))) => Some(encode_cursor(&[last])),
        (_, _) => None,
    };
    let names: Vec<String> = found.iter().map(|(name, _)| name.clone()).collect();
    let refs = user_refs(db, &names).await;
    Ok(Paged(
        found
            .into_iter()
            .map(|(name, created_at)| MutedReporter {
                user: user_from(&refs, &name),
                created_at,
            })
            .collect(),
        next,
    ))
}

/// Mutes (`on`) or unmutes the reports of `target` in `scope`. A change is logged; asking
/// for what already holds changes nothing.
pub(crate) async fn mute(
    db: &Db,
    scope: &ReportScope,
    actor: &str,
    target: &str,
    on: bool,
    t: i64,
) -> Result<(), ApiError> {
    let mut tx = db.begin().await?;
    let changed = match (&scope.server, on) {
        (Some(server), true) => {
            sqlx::query("INSERT INTO report_mutes(server, username, muted_by, created_at) VALUES($1, $2, $3, $4) ON CONFLICT(server, username) DO NOTHING")
                .bind(server)
                .bind(target)
                .bind(actor)
                .bind(t)
                .execute(&mut *tx)
                .await?
        }
        (Some(server), false) => {
            sqlx::query("DELETE FROM report_mutes WHERE server = $1 AND username = $2")
                .bind(server)
                .bind(target)
                .execute(&mut *tx)
                .await?
        }
        (None, true) => {
            sqlx::query("INSERT INTO instance_report_mutes(username, created_at) VALUES($1, $2) ON CONFLICT(username) DO NOTHING")
                .bind(target)
                .bind(t)
                .execute(&mut *tx)
                .await?
        }
        (None, false) => {
            sqlx::query("DELETE FROM instance_report_mutes WHERE username = $1")
                .bind(target)
                .execute(&mut *tx)
                .await?
        }
    }
    .rows_affected()
        > 0;
    if changed {
        match &scope.server {
            Some(server) => {
                let action = match on {
                    true => Action::ReportMute,
                    false => Action::ReportUnmute,
                };
                let entry = Entry::new(server, &scope.actor(), action).target(Target::user(target));
                audit::record(&mut tx, entry).await?;
            }
            None => {
                let action = match on {
                    true => "user.report_mute",
                    false => "user.report_unmute",
                };
                instance_audit::record_in(&mut tx, actor, action, Some(target), json!({}), t)
                    .await?;
            }
        }
    }
    tx.commit().await?;
    Ok(())
}

/// Who `ban_owner` bans for the server `server`: its creator, or with `given` that account
/// when it is the creator or one of the server's admins. `None` when there is nobody to ban.
pub(super) async fn server_owner(
    db: &Db,
    server: &str,
    given: Option<&str>,
) -> Result<Option<String>, ApiError> {
    let creator: Option<String> = sqlx::query("SELECT creator FROM servers WHERE name = $1")
        .bind(server)
        .fetch_optional(db)
        .await?
        .map(|r| r.try_get(0))
        .transpose()?
        .flatten();
    let Some(given) = given.map(str::to_lowercase) else {
        return Ok(creator);
    };
    if creator.as_deref() == Some(given.as_str()) {
        return Ok(Some(given));
    }
    let admin =
        sqlx::query("SELECT 1 FROM members WHERE server = $1 AND username = $2 AND is_admin <> 0")
            .bind(server)
            .bind(&given)
            .fetch_optional(db)
            .await?
            .is_some();
    Ok(admin.then_some(given))
}

/// How long the pace row of an account that stopped reporting is kept.
const PACE_KEEP: i64 = 7 * 86400;

/// Deletes the reports to the moderators of a server that is being purged, in batches. Reports
/// to the instance stay: they keep `server_name`, and the foreign key empties their `server`
/// when the server row goes.
pub(crate) async fn purge_server(db: &Db, server: &str) -> sqlx::Result<u64> {
    let mut total = 0;
    loop {
        let mut tx = db.begin().await?;
        crate::db::no_statement_limit(&mut tx).await?;
        let n = sqlx::query("DELETE FROM reports WHERE id IN (SELECT id FROM reports WHERE kind = 'server' AND server = $1 LIMIT $2)")
            .bind(server)
            .bind(PURGE_BATCH)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        tx.commit().await?;
        total += n;
        if n < PURGE_BATCH as u64 {
            return Ok(total);
        }
        tokio::task::yield_now().await;
    }
}

/// Takes the account `username` out of stored JSON: every object that names it as `username`
/// becomes `{"deleted": true}`, and a `creator` that is the account becomes `null`. Says whether
/// anything changed.
fn forget_in(value: &mut Value, username: &str) -> bool {
    match value {
        Value::Object(map) => {
            if map.get("username").and_then(Value::as_str) == Some(username) {
                *value = json!({ "deleted": true });
                return true;
            }
            let mut changed = false;
            if map.get("creator").and_then(Value::as_str) == Some(username) {
                map.insert("creator".to_string(), Value::Null);
                changed = true;
            }
            for inner in map.values_mut() {
                changed |= forget_in(inner, username);
            }
            changed
        }
        Value::Array(items) => items
            .iter_mut()
            .fold(false, |changed, inner| forget_in(inner, username) | changed),
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => false,
    }
}

/// Drops a deleted account's name from the reports (as reporter, assignee, the one reported, an
/// author in a snapshot, a person an answer names, the actor of an event, the one an event
/// assigned, the one who muted a reporter), so a new account with the same username never inherits the history. What was
/// written stays.
pub(crate) async fn forget_user(conn: &mut AnyConnection, username: &str) -> sqlx::Result<()> {
    let named = like_escape(&Value::from(username).to_string());
    let mut after = 0i64;
    loop {
        let rows = sqlx::query("SELECT id, snapshot, answers FROM reports WHERE id > $2 AND (snapshot LIKE $1 ESCAPE '\\' OR answers LIKE $1 ESCAPE '\\') ORDER BY id LIMIT $3")
            .bind(&named)
            .bind(after)
            .bind(FORGET_BATCH)
            .fetch_all(&mut *conn)
            .await?;
        for row in &rows {
            let (id, snapshot, answers): (i64, String, String) =
                (row.try_get(0)?, row.try_get(1)?, row.try_get(2)?);
            after = id;
            for (column, text) in [("snapshot", snapshot), ("answers", answers)] {
                let Ok(mut stored) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                if forget_in(&mut stored, username) {
                    sqlx::query(sqlx::AssertSqlSafe(format!(
                        "UPDATE reports SET {column} = $1 WHERE id = $2"
                    )))
                    .bind(stored.to_string())
                    .bind(id)
                    .execute(&mut *conn)
                    .await?;
                }
            }
        }
        if (rows.len() as i64) < FORGET_BATCH {
            break;
        }
    }
    sqlx::query("UPDATE report_events SET detail = '{\"assignee\":null}' WHERE kind = 'assign' AND detail = $1")
        .bind(json!({ "assignee": username }).to_string())
        .execute(&mut *conn)
        .await?;
    for sql in [
        "UPDATE reports SET reporter = NULL WHERE reporter = $1",
        "UPDATE reports SET assignee = NULL WHERE assignee = $1",
        "UPDATE reports SET target_user = NULL, target_key = 'd:' || CAST(id AS TEXT) WHERE target_user = $1",
        "UPDATE report_events SET actor = NULL WHERE actor = $1",
        "UPDATE report_mutes SET muted_by = NULL WHERE muted_by = $1",
        "DELETE FROM report_mutes WHERE username = $1",
        "DELETE FROM instance_report_mutes WHERE username = $1",
        "DELETE FROM report_pace WHERE reporter = $1",
    ] {
        sqlx::query(sql).bind(username).execute(&mut *conn).await?;
    }
    Ok(())
}

/// Deletes closed reports that were resolved more than `retention_days` days before `t` (0
/// keeps them forever), and the pace rows of accounts that sent no report for a week. Returns
/// how many reports it deleted.
pub(crate) async fn sweep(db: &Db, retention_days: u32, t: i64) -> sqlx::Result<u64> {
    delete_batched(
        db,
        "DELETE FROM report_pace WHERE (reporter, kind) IN (SELECT reporter, kind FROM report_pace WHERE last_at < $1 LIMIT $2)",
        t - PACE_KEEP,
    )
    .await?;
    if retention_days == 0 {
        return Ok(0);
    }
    delete_batched(
        db,
        "DELETE FROM reports WHERE id IN (SELECT id FROM reports WHERE resolved_at IS NOT NULL AND resolved_at < $1 LIMIT $2)",
        t - i64::from(retention_days) * 86400,
    )
    .await
}

#[cfg(test)]
mod tests {
    use sqlx::Row;

    use super::{forget_user, purge_server, sweep};
    use crate::db::{Db, close, open_started};
    use crate::limits::Limits;

    /// Runs `body` on a fresh SQLite file and, when `TEST_POSTGRES_URL` is set, on a fresh
    /// Postgres database.
    async fn on_each_database<F, Fut>(tag: &str, body: F)
    where
        F: Fn(Db) -> Fut,
        Fut: std::future::Future<Output = ()>,
    {
        let path = crate::db::temp_db_path(tag);
        let db = open_started(path.to_str()).await.expect("open");
        body(db.clone()).await;
        close(&db).await;
        if let Some(pg) = crate::api::test_util::pg_temp(tag).await {
            let db = open_started(Some(&pg.url)).await.expect("open");
            body(db.clone()).await;
            close(&db).await;
            drop(pg);
        }
    }

    async fn run(db: &Db, sql: &str) {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .execute(db)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
    }

    async fn count(db: &Db, sql: &str) -> i64 {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .fetch_one(db)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"))
            .try_get(0)
            .expect("count")
    }

    /// A report with the columns a test sets, and its id.
    async fn report(db: &Db, columns: &str, values: &str) -> i64 {
        let sql = format!(
            "INSERT INTO reports(form, form_label, reason, created_at, updated_at, {columns}) VALUES('user', 'Report a user', 'spam', 10, 10, {values}) RETURNING id"
        );
        sqlx::query(sqlx::AssertSqlSafe(sql.clone()))
            .fetch_one(db)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"))
            .try_get(0)
            .expect("id")
    }

    #[tokio::test]
    async fn server_purge_keeps_instance_reports() {
        on_each_database("reports_purge", |db| async move {
            run(&db, "INSERT INTO servers(name, display_name, creator, created_at) VALUES('s', 'S', NULL, 1)").await;
            run(&db, "INSERT INTO servers(name, display_name, creator, created_at) VALUES('t', 'T', NULL, 1)").await;
            let to_mods = report(
                &db,
                "kind, server, server_name, target_kind, target_key, snapshot",
                "'server', 's', 'S', 'user', 'u:carol', '{}'",
            )
            .await;
            let to_instance = report(
                &db,
                "kind, server, server_name, target_kind, target_key, snapshot",
                "'instance', 's', 'S', 'user', 'u:carol', '{}'",
            )
            .await;
            let elsewhere = report(
                &db,
                "kind, server, server_name, target_kind, target_key, snapshot",
                "'server', 't', 'T', 'user', 'u:carol', '{}'",
            )
            .await;
            run(&db, &format!("INSERT INTO report_events(report_id, actor, kind, created_at) VALUES({to_mods}, 'dave', 'note', 11)")).await;
            run(&db, "INSERT INTO report_mutes(server, username, muted_by, created_at) VALUES('s', 'bob', 'dave', 12)").await;

            assert_eq!(purge_server(&db, "s").await.expect("purge"), 1);
            run(&db, "DELETE FROM servers WHERE name = 's'").await;
            assert_eq!(
                count(&db, &format!("SELECT COUNT(*) FROM reports WHERE id = {to_mods}")).await,
                0,
                "the report to the server's moderators is gone"
            );
            assert_eq!(count(&db, "SELECT COUNT(*) FROM report_events").await, 0);
            assert_eq!(count(&db, "SELECT COUNT(*) FROM report_mutes").await, 0);
            assert_eq!(
                count(&db, &format!("SELECT COUNT(*) FROM reports WHERE id = {to_instance} AND server IS NULL AND server_name = 'S'")).await,
                1,
                "the report to the instance stays, with the name the server had"
            );
            assert_eq!(
                count(&db, &format!("SELECT COUNT(*) FROM reports WHERE id = {elsewhere} AND server = 't'")).await,
                1
            );
            assert_eq!(purge_server(&db, "s").await.expect("again"), 0);
        })
        .await;
    }

    #[tokio::test]
    async fn purge_deletes_in_batches() {
        on_each_database("reports_purge_batches", |db| async move {
            run(&db, "INSERT INTO servers(name, display_name, creator, created_at) VALUES('s', 'S', NULL, 1)").await;
            let n = crate::db::PURGE_BATCH + 20;
            for _ in 0..n {
                report(
                    &db,
                    "kind, server, target_kind, target_key, snapshot",
                    "'server', 's', 'user', 'u:carol', '{}'",
                )
                .await;
            }
            assert_eq!(purge_server(&db, "s").await.expect("purge"), n as u64);
            assert_eq!(count(&db, "SELECT COUNT(*) FROM reports").await, 0);
        })
        .await;
    }

    #[tokio::test]
    async fn forgetting_an_account_leaves_no_name() {
        on_each_database("reports_forget", |db| async move {
            run(&db, "INSERT INTO servers(name, display_name, creator, created_at) VALUES('s', 'S', NULL, 1)").await;
            let snapshot = serde_json::json!({
                "message": {"id": 5, "author": {"username": "carol", "display_name": "Carol"}, "content": "buy my coins", "kind": "text"},
                "context": [
                    {"id": 3, "author": {"username": "bob", "display_name": "Bob"}, "content": "hello there"},
                    {"id": 4, "author": {"username": "erin", "display_name": "Erin"}, "content": "hi"},
                ],
                "user": {"username": "carol", "display_name": "Carol"},
                "server": {"name": "s", "display_name": "S", "creator": "carol", "member_count": 3},
                "channel": "general",
            });
            let answers = serde_json::json!([
                {"id": "witness", "label": "Who saw it", "kind": "user", "value": {"username": "bob", "display_name": "Bob"}},
                {"id": "details", "label": "What happened", "kind": "long_text", "value": "they kept posting ads"},
            ]);
            let id: i64 = sqlx::query("INSERT INTO reports(kind, server, server_name, target_kind, target_key, target_user, reporter, assignee, form, form_label, reason, note, answers, snapshot, created_at, updated_at) VALUES('server', 's', 'S', 'message', 'u:carol', 'carol', 'bob', 'bob', 'message', 'Report message', 'spam', 'so many ads', $1, $2, 10, 10) RETURNING id")
                .bind(answers.to_string())
                .bind(snapshot.to_string())
                .fetch_one(&db)
                .await
                .expect("report")
                .try_get(0)
                .expect("id");
            let other = report(
                &db,
                "kind, target_kind, target_key, target_user, reporter, snapshot",
                "'instance', 'user', 'u:erin', 'erin', 'erin', '{\"user\": {\"username\": \"erin\"}}'",
            )
            .await;
            run(&db, &format!("INSERT INTO report_events(report_id, actor, kind, detail, created_at) VALUES({id}, 'dave', 'note', '{{\"text\": \"looking\"}}', 11)")).await;
            run(&db, &format!("INSERT INTO report_events(report_id, actor, kind, created_at) VALUES({id}, 'bob', 'assign', 12)")).await;
            run(&db, "INSERT INTO report_mutes(server, username, muted_by, created_at) VALUES('s', 'bob', 'dave', 12)").await;
            run(&db, "INSERT INTO report_mutes(server, username, muted_by, created_at) VALUES('s', 'erin', 'carol', 12)").await;
            run(&db, "INSERT INTO instance_report_mutes(username, created_at) VALUES('bob', 12)").await;
            run(&db, "INSERT INTO instance_report_mutes(username, created_at) VALUES('erin', 12)").await;
            run(&db, "INSERT INTO report_pace(reporter, kind, last_at) VALUES('bob', 'server', 12)").await;
            run(&db, "INSERT INTO report_pace(reporter, kind, last_at) VALUES('erin', 'server', 12)").await;

            let mut conn = db.acquire().await.expect("conn");
            forget_user(&mut conn, "bob").await.expect("forget bob");
            forget_user(&mut conn, "carol").await.expect("forget carol");
            drop(conn);

            let mut text = String::new();
            for (table, columns) in [
                ("reports", "COALESCE(server, '') || '|' || COALESCE(target_key, '') || '|' || COALESCE(target_user, '') || '|' || COALESCE(reporter, '') || '|' || COALESCE(assignee, '') || '|' || COALESCE(note, '') || '|' || answers || '|' || snapshot"),
                ("report_events", "COALESCE(actor, '') || '|' || detail"),
                ("report_mutes", "username || '|' || COALESCE(muted_by, '')"),
                ("instance_report_mutes", "username"),
                ("report_pace", "reporter"),
            ] {
                let rows = sqlx::query(sqlx::AssertSqlSafe(format!("SELECT {columns} FROM {table}")))
                    .fetch_all(&db)
                    .await
                    .expect(table);
                for row in &rows {
                    text.push_str(&row.try_get::<String, _>(0).expect("text"));
                    text.push('\n');
                }
            }
            let lower = text.to_lowercase();
            assert!(!lower.contains("bob") && !lower.contains("carol"), "{text}");
            for kept in ["buy my coins", "hello there", "so many ads", "they kept posting ads", "looking", "erin", "dave"] {
                assert!(text.contains(kept), "{kept} stays: {text}");
            }

            let row = sqlx::query("SELECT target_key, target_user, reporter, assignee, snapshot, answers FROM reports WHERE id = $1")
                .bind(id)
                .fetch_one(&db)
                .await
                .expect("row");
            let key: String = row.try_get(0).expect("key");
            assert_eq!(key, format!("d:{id}"));
            for column in 1..4 {
                assert_eq!(row.try_get::<Option<String>, _>(column).expect("name"), None);
            }
            let snapshot: serde_json::Value =
                serde_json::from_str(&row.try_get::<String, _>(4).expect("snapshot")).expect("json");
            assert_eq!(
                snapshot,
                serde_json::json!({
                    "message": {"id": 5, "author": {"deleted": true}, "content": "buy my coins", "kind": "text"},
                    "context": [
                        {"id": 3, "author": {"deleted": true}, "content": "hello there"},
                        {"id": 4, "author": {"username": "erin", "display_name": "Erin"}, "content": "hi"},
                    ],
                    "user": {"deleted": true},
                    "server": {"name": "s", "display_name": "S", "creator": null, "member_count": 3},
                    "channel": "general",
                })
            );
            let answers: serde_json::Value =
                serde_json::from_str(&row.try_get::<String, _>(5).expect("answers")).expect("json");
            assert_eq!(answers[0]["value"], serde_json::json!({"deleted": true}));
            assert_eq!(answers[1]["value"], "they kept posting ads");

            assert_eq!(
                count(&db, &format!("SELECT COUNT(*) FROM reports WHERE id = {other} AND target_key = 'u:erin' AND target_user = 'erin' AND reporter = 'erin'")).await,
                1,
                "another account's report is untouched"
            );
            assert_eq!(count(&db, "SELECT COUNT(*) FROM report_events WHERE actor = 'dave'").await, 1);
            assert_eq!(count(&db, "SELECT COUNT(*) FROM report_events WHERE actor IS NULL").await, 1);
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM report_mutes WHERE username = 'erin' AND muted_by IS NULL").await,
                1,
                "the mute a deleted moderator set stays"
            );
            assert_eq!(count(&db, "SELECT COUNT(*) FROM report_mutes").await, 1);
            assert_eq!(count(&db, "SELECT COUNT(*) FROM instance_report_mutes").await, 1);
            assert_eq!(count(&db, "SELECT COUNT(*) FROM report_pace").await, 1);
        })
        .await;
    }

    #[tokio::test]
    async fn forgetting_an_account_reads_names_literally() {
        on_each_database("reports_forget_like", |db| async move {
            let kept = report(
                &db,
                "kind, target_kind, target_key, target_user, snapshot",
                "'instance', 'user', 'u:axb', 'axb', '{\"user\": {\"username\": \"axb\"}}'",
            )
            .await;
            let gone = report(
                &db,
                "kind, target_kind, target_key, target_user, snapshot",
                "'instance', 'user', 'u:a_b', 'a_b', '{\"user\": {\"username\": \"a_b\"}, \"note\": \"a_b said hi\"}'",
            )
            .await;
            let mut conn = db.acquire().await.expect("conn");
            forget_user(&mut conn, "a_b").await.expect("forget");
            drop(conn);
            assert_eq!(
                count(&db, &format!("SELECT COUNT(*) FROM reports WHERE id = {kept} AND target_user = 'axb' AND snapshot LIKE '%axb%'")).await,
                1
            );
            let snapshot: String = sqlx::query("SELECT snapshot FROM reports WHERE id = $1")
                .bind(gone)
                .fetch_one(&db)
                .await
                .expect("row")
                .try_get(0)
                .expect("snapshot");
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&snapshot).expect("json"),
                serde_json::json!({"user": {"deleted": true}, "note": "a_b said hi"}),
                "only the account's own objects change, never what people wrote"
            );

            for name in ["o\"neil", "back\\slash", "tab\tbed"] {
                let snapshot = serde_json::json!({
                    "user": {"username": name, "display_name": "Secret Display"},
                    "message": {"author": {"username": name}, "content": "kept"},
                });
                let answers = serde_json::json!([
                    {"id": "who", "label": "Who", "kind": "user", "value": {"username": name}},
                ]);
                let id: i64 = sqlx::query("INSERT INTO reports(kind, target_kind, target_key, target_user, form, form_label, reason, answers, snapshot, created_at, updated_at) VALUES('instance', 'user', $1, $2, 'user', 'Report a user', 'spam', $3, $4, 10, 10) RETURNING id")
                    .bind(format!("u:{name}"))
                    .bind(name)
                    .bind(answers.to_string())
                    .bind(snapshot.to_string())
                    .fetch_one(&db)
                    .await
                    .expect("report")
                    .try_get(0)
                    .expect("id");
                let mut conn = db.acquire().await.expect("conn");
                forget_user(&mut conn, name).await.expect("forget");
                drop(conn);
                let row = sqlx::query("SELECT target_user, snapshot, answers FROM reports WHERE id = $1")
                    .bind(id)
                    .fetch_one(&db)
                    .await
                    .expect("row");
                assert_eq!(row.try_get::<Option<String>, _>(0).expect("target"), None);
                let json = |n: usize| -> serde_json::Value {
                    serde_json::from_str(&row.try_get::<String, _>(n).expect("text")).expect("json")
                };
                assert_eq!(
                    json(1),
                    serde_json::json!({"user": {"deleted": true}, "message": {"author": {"deleted": true}, "content": "kept"}}),
                    "{name} as JSON writes it"
                );
                assert_eq!(json(2)[0]["value"], serde_json::json!({"deleted": true}), "{name}");
            }
        })
        .await;
    }

    #[tokio::test]
    async fn forgetting_reads_the_reports_in_batches() {
        on_each_database("reports_forget_batches", |db| async move {
            let n = super::FORGET_BATCH * 2 + 7;
            for i in 0..n {
                let name = match i % 2 {
                    0 => "content",
                    _ => "erin",
                };
                let snapshot = serde_json::json!({
                    "user": {"username": name, "display_name": name},
                    "message": {"content": "hi", "author": {"username": "erin"}},
                });
                sqlx::query("INSERT INTO reports(kind, target_kind, target_key, target_user, form, form_label, reason, snapshot, created_at, updated_at) VALUES('instance', 'user', $1, $2, 'user', 'Report a user', 'spam', $3, 10, 10)")
                    .bind(format!("u:{name}"))
                    .bind(name)
                    .bind(snapshot.to_string())
                    .execute(&db)
                    .await
                    .expect("report");
            }
            let mut conn = db.acquire().await.expect("conn");
            forget_user(&mut conn, "content").await.expect("forget");
            drop(conn);
            let gone = (n + 1) / 2;
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM reports WHERE snapshot LIKE '%\"user\":{\"deleted\":true}%' AND target_user IS NULL").await,
                gone,
                "every report about the account, past the first batch too"
            );
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM reports WHERE snapshot LIKE '%\"username\":\"content\"%'").await,
                0
            );
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM reports WHERE target_user = 'erin' AND snapshot LIKE '%\"user\":{\"display_name\":\"erin\",\"username\":\"erin\"}%' AND snapshot LIKE '%\"content\":\"hi\"%'").await,
                n - gone,
                "what people wrote and other accounts stay"
            );
        })
        .await;
    }

    #[tokio::test]
    async fn retention_sweeps_closed_reports_only() {
        on_each_database("reports_sweep", |db| async move {
            let day = 86400;
            let t = crate::db::now();
            let insert = |status: &'static str, created: i64, resolved: Option<i64>| {
                let db = db.clone();
                async move {
                    let resolved = resolved.map_or("NULL".to_string(), |at| at.to_string());
                    let sql = format!(
                        "INSERT INTO reports(kind, target_kind, target_key, form, form_label, reason, snapshot, status, created_at, updated_at, resolved_at) VALUES('instance', 'none', '-', 'bug', 'Report a bug', 'other', '{{}}', '{status}', {created}, {created}, {resolved}) RETURNING id"
                    );
                    let id: i64 = sqlx::query(sqlx::AssertSqlSafe(sql))
                        .fetch_one(&db)
                        .await
                        .expect("report")
                        .try_get(0)
                        .expect("id");
                    id
                }
            };
            let old = insert("dismissed", t - 500 * day, Some(t - 181 * day)).await;
            let recent = insert("resolved", t - 500 * day, Some(t - 179 * day)).await;
            let open = insert("open", t - 400 * day, None).await;
            run(&db, &format!("INSERT INTO report_events(report_id, kind, created_at) VALUES({old}, 'status', 5)")).await;
            run(&db, &format!("INSERT INTO report_pace(reporter, kind, last_at) VALUES('bob', 'server', {})", t - 8 * day)).await;
            run(&db, &format!("INSERT INTO report_pace(reporter, kind, last_at) VALUES('bob', 'instance', {})", t - 6 * day)).await;

            assert_eq!(sweep(&db, 0, t).await.expect("keep forever"), 0);
            assert_eq!(count(&db, "SELECT COUNT(*) FROM reports").await, 3, "0 keeps closed reports");
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM report_pace").await,
                1,
                "pace rows age out after a week either way"
            );
            assert_eq!(count(&db, "SELECT COUNT(*) FROM report_pace WHERE kind = 'instance'").await, 1);

            let limits = Limits::default();
            assert_eq!(limits.report_retention_days, 180);
            let swept = crate::db::sweep_stale(&db, &limits).await.expect("sweep");
            assert_eq!(swept.reports, 1);
            let left: Vec<i64> = sqlx::query("SELECT id FROM reports ORDER BY id")
                .fetch_all(&db)
                .await
                .expect("left")
                .iter()
                .map(|r| r.try_get(0).expect("id"))
                .collect();
            assert_eq!(left, [recent, open], "{old} was closed 181 days ago");
            assert_eq!(count(&db, "SELECT COUNT(*) FROM report_events").await, 0);
            assert_eq!(sweep(&db, 180, t).await.expect("again"), 0);
        })
        .await;
    }
}
