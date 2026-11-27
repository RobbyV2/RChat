use std::collections::HashMap;

use serde_json::Value;
use sqlx::Row;
use sqlx::any::AnyRow;

use super::export::ExportRow;
use super::forms::{FieldKind, StoredAnswer};
use super::snapshot::Snapshot;
use super::text::{Text, detail_of};
use super::{
    GroupBy, ModAction, ReportDetail, ReportEvent, ReportGroup, ReportKind, ReportQuery, ReportRow,
    Status, invalid,
};
use crate::api::access::{ReportMode, ReportScope, not_found, report_scope};
use crate::api::{
    ApiError, LIST_PAGE, OFFSET_MAX, Paged, UserRef, cursor_int, decode_cursor, encode_cursor,
    user_from, user_refs,
};
use crate::crypt::copies::Opener;
use crate::db::{Db, User};

/// The longest excerpt of a report in a list, in characters.
const EXCERPT_MAX: usize = 200;
const DAY: i64 = 86400;
/// The widest shift of `tz`, in minutes.
const TZ_MAX: i64 = 840;

enum Bind {
    Int(i64),
    Text(String),
}

/// A `WHERE` clause over `reports r` and its values, in placeholder order.
pub(super) struct Clause {
    sql: String,
    binds: Vec<Bind>,
}

impl Clause {
    pub(super) fn int(&mut self, value: i64) -> String {
        self.binds.push(Bind::Int(value));
        format!("${}", self.binds.len())
    }

    pub(super) fn text(&mut self, value: &str) -> String {
        self.binds.push(Bind::Text(value.to_string()));
        format!("${}", self.binds.len())
    }

    pub(super) fn and(&mut self, condition: String) {
        self.sql.push_str(" AND ");
        self.sql.push_str(&condition);
    }

    pub(super) fn sql(&self) -> &str {
        &self.sql
    }

    /// Runs `sql`, which holds this clause, on `conn`.
    pub(super) async fn run(
        self,
        conn: &mut sqlx::AnyConnection,
        sql: String,
    ) -> sqlx::Result<Vec<AnyRow>> {
        let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
        for bind in self.binds {
            query = match bind {
                Bind::Int(v) => query.bind(v),
                Bind::Text(v) => query.bind(v),
            };
        }
        query.fetch_all(&mut *conn).await
    }

    async fn fetch(self, db: &Db, sql: String) -> sqlx::Result<Vec<AnyRow>> {
        let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
        for bind in self.binds {
            query = match bind {
                Bind::Int(v) => query.bind(v),
                Bind::Text(v) => query.bind(v),
            };
        }
        query.fetch_all(db).await
    }
}

/// The reports `scope` shows: its kind and server, never a report about the viewer, and
/// nothing from a channel the viewer can't see (the audit log's rule: a channel closed to them,
/// or a private channel that no longer exists).
pub(super) fn visible(scope: &ReportScope) -> Clause {
    let mut clause = Clause {
        sql: String::new(),
        binds: Vec::new(),
    };
    let kind = clause.text(scope.kind().as_str());
    clause.sql.push_str(&format!("r.kind = {kind}"));
    if let Some(server) = &scope.server {
        let server = clause.text(server);
        clause.and(format!("r.server = {server}"));
    }
    let viewer = clause.text(&scope.viewer);
    clause.and(format!(
        "(r.target_user IS NULL OR r.target_user <> {viewer})"
    ));
    if !scope.all_channels {
        let closed = match scope.closed.is_empty() {
            true => String::new(),
            false => {
                let ids: Vec<String> = scope.closed.iter().map(|id| clause.int(*id)).collect();
                format!("r.channel_id IN ({}) OR ", ids.join(", "))
            }
        };
        clause.and(format!(
            "(r.channel_id IS NULL OR NOT ({closed}(r.channel_private <> 0 AND NOT EXISTS(SELECT 1 FROM channels gone WHERE gone.id = r.channel_id AND gone.server = r.server))))"
        ));
    }
    clause
}

/// Days since 1970-01-01 as a date, `YYYY-MM-DD`.
pub(crate) fn date_of(days: i64) -> String {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = match mp < 10 {
        true => mp + 3,
        false => mp - 9,
    };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

/// The days since 1970-01-01 of a date written `YYYY-MM-DD`.
pub(crate) fn day_of(date: &str) -> Option<i64> {
    let mut parts = date.split('-');
    let (year, month, day): (i64, i64, i64) = (
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    );
    if parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let y = year - i64::from(month <= 2);
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    (date_of(days) == date).then_some(days)
}

/// The seconds `tz` minutes shift a time by.
fn shift(tz: Option<i64>) -> Result<i64, ApiError> {
    match tz.unwrap_or(0) {
        tz if (-TZ_MAX..=TZ_MAX).contains(&tz) => Ok(tz * 60),
        _ => Err(invalid("tz", "Invalid tz")),
    }
}

/// The SQL of the key a grouping gives a report.
fn key_sql(by: GroupBy, clause: &mut Clause, tz: Option<i64>) -> Result<String, ApiError> {
    Ok(match by {
        GroupBy::Server => "COALESCE(r.server, '')".to_string(),
        GroupBy::Member => "r.target_key".to_string(),
        GroupBy::Reporter => "COALESCE(r.reporter, '')".to_string(),
        GroupBy::Assignee => "COALESCE(r.assignee, '')".to_string(),
        GroupBy::Role => "COALESCE(CAST(r.role_id AS TEXT), '')".to_string(),
        GroupBy::Channel => "COALESCE(CAST(r.channel_id AS TEXT), '')".to_string(),
        GroupBy::Reason => "r.reason".to_string(),
        GroupBy::Status => "r.status".to_string(),
        GroupBy::Form => "r.form".to_string(),
        GroupBy::Day => {
            let shift = clause.int(shift(tz)?);
            format!("CAST((r.created_at + {shift}) / {DAY} AS TEXT)")
        }
    })
}

/// Adds the filters of `q` to `clause`.
fn filter(clause: &mut Clause, scope: &ReportScope, q: &ReportQuery) -> Result<(), ApiError> {
    let ReportQuery {
        status,
        reason,
        form,
        from,
        to,
        by,
        key,
        tz,
        oldest: _,
        cursor: _,
        limit: _,
    } = q;
    if let Some(by) = by {
        grouping_ok(scope, *by)?;
    }
    shift(*tz)?;
    if let Some(status) = status {
        let status = clause.text(status.as_str());
        clause.and(format!("r.status = {status}"));
    }
    if let Some(reason) = reason.as_deref().filter(|r| !r.is_empty()) {
        let reason = clause.text(reason);
        clause.and(format!("r.reason = {reason}"));
    }
    if let Some(form) = form.as_deref().filter(|f| !f.is_empty()) {
        let form = clause.text(form);
        clause.and(format!("r.form = {form}"));
    }
    if let Some(from) = from {
        let from = clause.int(*from);
        clause.and(format!("r.created_at >= {from}"));
    }
    if let Some(to) = to {
        let to = clause.int(*to);
        clause.and(format!("r.created_at <= {to}"));
    }
    if let (Some(by), Some(key)) = (by, key) {
        let expr = key_sql(*by, clause, *tz)?;
        let key = match by {
            GroupBy::Day => day_of(key)
                .ok_or_else(|| invalid("key", "Invalid day"))?
                .to_string(),
            GroupBy::Server
            | GroupBy::Member
            | GroupBy::Reporter
            | GroupBy::Assignee
            | GroupBy::Role
            | GroupBy::Channel
            | GroupBy::Reason
            | GroupBy::Status
            | GroupBy::Form => key.clone(),
        };
        let key = clause.text(&key);
        clause.and(format!("{expr} = {key}"));
    }
    Ok(())
}

/// Grouping by server is for the reports to the instance only.
fn grouping_ok(scope: &ReportScope, by: GroupBy) -> Result<(), ApiError> {
    match (by, &scope.server) {
        (GroupBy::Server, Some(_)) => Err(invalid("by", "Unknown grouping")),
        (_, _) => Ok(()),
    }
}

const COLUMNS: &str = "r.id, r.kind, r.status, r.action, r.reason, r.reason_label, r.form, r.form_label, r.target_kind, r.target_key, r.target_user, r.server, r.server_name, r.channel_id, c.name, r.role_name, r.reporter, r.assignee, r.snapshot, r.answers, r.escalated_to, r.created_at, r.updated_at, r.note, r.sealed";
/// Where `COLUMNS` has `r.sealed`.
const SEALED: usize = 24;
const FROM: &str = "FROM reports r LEFT JOIN channels c ON c.id = r.channel_id";

/// A report as its row holds it.
struct Raw {
    row: ReportRow,
    target_user: Option<String>,
    reporter: Option<String>,
    assignee: Option<String>,
    note: Option<String>,
    snapshot: Snapshot,
    answers: Vec<StoredAnswer>,
}

fn excerpt(target_kind: &str, snapshot: &Snapshot, answers: &[StoredAnswer]) -> String {
    let said = |kind: FieldKind| {
        answers
            .iter()
            .find(|a| a.kind == kind)
            .and_then(|a| a.value.as_str())
            .map(str::to_string)
    };
    let text = match target_kind {
        "message" => snapshot.message.as_ref().map(|m| m.content.clone()),
        "server" => snapshot.server.as_ref().map(|s| s.display_name.clone()),
        "user" => snapshot.user.as_ref().and_then(|u| u.username.clone()),
        _ => said(FieldKind::LongText).or_else(|| said(FieldKind::ShortText)),
    };
    text.unwrap_or_default().chars().take(EXCERPT_MAX).collect()
}

fn raw(r: &AnyRow, opener: &Opener) -> Result<Raw, ApiError> {
    let wrong =
        |what: &str, value: &str| ApiError::internal(format!("a report has the {what} {value}"));
    let id: i64 = r.try_get(0)?;
    let kind: String = r.try_get(1)?;
    let status: String = r.try_get(2)?;
    let action: Option<String> = r.try_get(3)?;
    let target_kind: String = r.try_get(8)?;
    let plain = Text {
        snapshot: r.try_get(18)?,
        answers: r.try_get(19)?,
        note: r.try_get(23)?,
    };
    let record: Option<Vec<u8>> = r.try_get(SEALED)?;
    let Text {
        snapshot,
        answers,
        note,
    } = Text::of(opener, id, record.as_deref(), plain);
    let snapshot: Snapshot = serde_json::from_str(&snapshot).unwrap_or_default();
    let answers: Vec<StoredAnswer> = serde_json::from_str(&answers).unwrap_or_default();
    Ok(Raw {
        row: ReportRow {
            id,
            kind: ReportKind::parse(&kind).ok_or_else(|| wrong("kind", &kind))?,
            status: Status::parse(&status).ok_or_else(|| wrong("status", &status))?,
            action: match action {
                Some(action) => {
                    Some(ModAction::parse(&action).ok_or_else(|| wrong("action", &action))?)
                }
                None => None,
            },
            reason: r.try_get(4)?,
            reason_label: r.try_get(5)?,
            form: r.try_get(6)?,
            form_label: r.try_get(7)?,
            excerpt: excerpt(&target_kind, &snapshot, &answers),
            target_kind,
            target_key: r.try_get(9)?,
            target: None,
            webhook: snapshot.message.as_ref().and_then(|m| m.webhook.clone()),
            server: r.try_get(11)?,
            server_name: r.try_get(12)?,
            channel_id: r.try_get(13)?,
            channel: r
                .try_get::<Option<String>, _>(14)?
                .or_else(|| snapshot.channel.clone()),
            role: r.try_get(15)?,
            reporter: None,
            assignee: None,
            escalated: r.try_get::<Option<i64>, _>(20)?.is_some(),
            created_at: r.try_get(21)?,
            updated_at: r.try_get(22)?,
        },
        target_user: r.try_get(10)?,
        reporter: r.try_get(16)?,
        assignee: r.try_get(17)?,
        note,
        snapshot,
        answers,
    })
}

/// Fills in the people of `raws`.
async fn named(db: &Db, raws: Vec<Raw>) -> Vec<Raw> {
    let mut names = Vec::new();
    for raw in &raws {
        names.extend(raw.target_user.clone());
        names.extend(raw.reporter.clone());
        names.extend(raw.assignee.clone());
    }
    let refs = user_refs(db, &names).await;
    let of = |name: &Option<String>| name.as_deref().map(|n| user_from(&refs, n));
    raws.into_iter()
        .map(|raw| Raw {
            row: ReportRow {
                target: of(&raw.target_user),
                reporter: of(&raw.reporter),
                assignee: of(&raw.assignee),
                ..raw.row
            },
            ..raw
        })
        .collect()
}

fn page_size(limit: Option<i64>) -> i64 {
    limit.unwrap_or(LIST_PAGE).clamp(1, LIST_PAGE)
}

async fn rows(db: &Db, clause: Clause, order: &str, limit: i64) -> Result<Vec<Raw>, ApiError> {
    let sql = format!(
        "SELECT {COLUMNS} {FROM} WHERE {} ORDER BY {order} LIMIT {limit}",
        clause.sql
    );
    let found = clause.fetch(db, sql).await?;
    let opener = Opener::of_rows(db, &found, SEALED).await?;
    let raws = found
        .iter()
        .map(|r| raw(r, &opener))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(named(db, raws).await)
}

/// The reports of `scope` that pass the filters of `q`, newest first (oldest first with
/// `q.oldest`), a page at a time.
pub(crate) async fn list(
    db: &Db,
    scope: &ReportScope,
    q: &ReportQuery,
) -> Result<Paged<ReportRow>, ApiError> {
    let mut clause = visible(scope);
    filter(&mut clause, scope, q)?;
    let oldest = q.oldest.unwrap_or(false);
    if let Some(cursor) = q.cursor.as_deref().filter(|c| !c.trim().is_empty()) {
        let parts = decode_cursor(cursor, 2)?;
        let (at, id) = (
            clause.int(cursor_int(&parts[0])?),
            clause.int(cursor_int(&parts[1])?),
        );
        let after = match oldest {
            true => ">",
            false => "<",
        };
        clause.and(format!("(r.created_at, r.id) {after} ({at}, {id})"));
    }
    let limit = page_size(q.limit);
    let order = match oldest {
        true => "r.created_at, r.id",
        false => "r.created_at DESC, r.id DESC",
    };
    let mut found = rows(db, clause, order, limit + 1).await?;
    let more = found.len() as i64 > limit;
    found.truncate(limit as usize);
    let next = match (more, found.last()) {
        (true, Some(last)) => Some(encode_cursor(&[
            &last.row.created_at.to_string(),
            &last.row.id.to_string(),
        ])),
        (_, _) => None,
    };
    Ok(Paged(found.into_iter().map(|raw| raw.row).collect(), next))
}

/// The newest report of the group `key`, for what only a snapshot knows of it.
async fn newest(
    db: &Db,
    scope: &ReportScope,
    by: GroupBy,
    key: &str,
    tz: Option<i64>,
) -> Result<Option<Raw>, ApiError> {
    let mut clause = visible(scope);
    let expr = key_sql(by, &mut clause, tz)?;
    let key = clause.text(key);
    clause.and(format!("{expr} = {key}"));
    Ok(rows(db, clause, "r.id DESC", 1).await?.pop())
}

/// The groups `q.by` sorts the reports of `scope` into, those with the most open reports
/// first, a page at a time.
pub(crate) async fn groups(
    db: &Db,
    scope: &ReportScope,
    q: &ReportQuery,
) -> Result<Paged<ReportGroup>, ApiError> {
    let by = q.by.ok_or_else(|| invalid("by", "Unknown grouping"))?;
    grouping_ok(scope, by)?;
    let mut clause = visible(scope);
    let ungrouped = ReportQuery {
        by: None,
        key: None,
        ..q.clone()
    };
    filter(&mut clause, scope, &ungrouped)?;
    let expr = key_sql(by, &mut clause, q.tz)?;
    let offset = match q.cursor.as_deref().filter(|c| !c.trim().is_empty()) {
        Some(cursor) => cursor_int(&decode_cursor(cursor, 1)?[0])?.clamp(0, OFFSET_MAX),
        None => 0,
    };
    let limit = page_size(q.limit);
    let label = match by {
        GroupBy::Server => "MAX(r.server_name)",
        GroupBy::Role => "MAX(r.role_name)",
        GroupBy::Channel => "MAX(c.name)",
        GroupBy::Reason => "MAX(r.reason_label)",
        GroupBy::Form => "MAX(r.form_label)",
        GroupBy::Member
        | GroupBy::Reporter
        | GroupBy::Assignee
        | GroupBy::Status
        | GroupBy::Day => "NULL",
    };
    let sql = format!(
        "SELECT {expr}, COUNT(*), SUM(CASE WHEN r.status = 'open' THEN 1 ELSE 0 END), {label} {FROM} WHERE {} GROUP BY 1 ORDER BY 3 DESC, 2 DESC, 1 LIMIT {} OFFSET {offset}",
        clause.sql,
        limit + 1
    );
    let found = clause.fetch(db, sql).await?;
    let more = found.len() as i64 > limit;
    let mut out = Vec::with_capacity(found.len());
    for r in found.iter().take(limit as usize) {
        out.push(ReportGroup {
            key: r.try_get(0)?,
            count: r.try_get(1)?,
            open: r.try_get(2)?,
            label: r.try_get(3)?,
            user: None,
        });
    }
    let people: Vec<String> = match by {
        GroupBy::Member => out
            .iter()
            .filter_map(|g| g.key.strip_prefix("u:"))
            .filter(|name| !name.starts_with('@'))
            .map(str::to_string)
            .collect(),
        GroupBy::Reporter | GroupBy::Assignee => out
            .iter()
            .filter(|g| !g.key.is_empty())
            .map(|g| g.key.clone())
            .collect(),
        GroupBy::Server
        | GroupBy::Role
        | GroupBy::Channel
        | GroupBy::Reason
        | GroupBy::Status
        | GroupBy::Form
        | GroupBy::Day => Vec::new(),
    };
    let refs: HashMap<String, UserRef> = match people.is_empty() {
        true => HashMap::new(),
        false => user_refs(db, &people).await,
    };
    for group in &mut out {
        let empty = group.key.is_empty();
        match by {
            GroupBy::Member => match group.key.split_once(':') {
                Some(("u", name)) if name.starts_with('@') => {
                    group.label = newest(db, scope, by, &group.key, q.tz)
                        .await?
                        .and_then(|raw| raw.row.webhook);
                }
                Some(("u", name)) => group.user = Some(user_from(&refs, name)),
                Some(("d", _)) => group.label = Some("Deleted user".to_string()),
                Some(("s", _)) => {
                    group.label = newest(db, scope, by, &group.key, q.tz)
                        .await?
                        .and_then(|raw| raw.row.server_name);
                }
                Some((_, _)) | None => {}
            },
            GroupBy::Reporter => match empty {
                true => group.label = Some("Deleted user".to_string()),
                false => group.user = Some(user_from(&refs, &group.key)),
            },
            GroupBy::Assignee => match empty {
                true => group.label = Some("Unassigned".to_string()),
                false => group.user = Some(user_from(&refs, &group.key)),
            },
            GroupBy::Role if empty => group.label = Some("No role".to_string()),
            GroupBy::Channel if empty => group.label = Some("No channel".to_string()),
            GroupBy::Server if empty => group.label = Some("No server".to_string()),
            GroupBy::Channel if group.label.is_none() => {
                group.label = newest(db, scope, by, &group.key, q.tz)
                    .await?
                    .and_then(|raw| raw.row.channel);
            }
            GroupBy::Day => {
                group.key = date_of(group.key.parse().unwrap_or_default());
            }
            GroupBy::Role
            | GroupBy::Channel
            | GroupBy::Server
            | GroupBy::Reason
            | GroupBy::Status
            | GroupBy::Form => {}
        }
    }
    let next = more.then(|| encode_cursor(&[&(offset + limit).to_string()]));
    Ok(Paged(out, next))
}

/// How many open reports `scope` shows.
pub(crate) async fn open_count(db: &Db, scope: &ReportScope) -> Result<i64, ApiError> {
    let mut clause = visible(scope);
    clause.and("r.status = 'open'".to_string());
    let sql = format!("SELECT COUNT(*) FROM reports r WHERE {}", clause.sql);
    Ok(clause
        .fetch(db, sql)
        .await?
        .first()
        .map(|r| r.try_get(0))
        .transpose()?
        .unwrap_or(0))
}

/// The scope a report belongs to, by its row: `None` when there is no such report.
async fn scope_of(
    db: &Db,
    user: &User,
    id: i64,
    mode: ReportMode,
) -> Result<Option<ReportScope>, ApiError> {
    let Some(row) = sqlx::query("SELECT kind, server FROM reports WHERE id = $1")
        .bind(id)
        .fetch_optional(db)
        .await?
    else {
        return Ok(None);
    };
    let (kind, server): (String, Option<String>) = (row.try_get(0)?, row.try_get(1)?);
    match (ReportKind::parse(&kind), server) {
        (Some(ReportKind::Server), Some(server)) => {
            report_scope(db, user, Some(&server), mode).await.map(Some)
        }
        (Some(ReportKind::Instance), _) => report_scope(db, user, None, mode).await.map(Some),
        (Some(ReportKind::Server), None) | (None, _) => Ok(None),
    }
}

/// The report `id` as `scope` shows it.
async fn one(db: &Db, scope: &ReportScope, id: i64) -> Result<Option<Raw>, ApiError> {
    let mut clause = visible(scope);
    let id = clause.int(id);
    clause.and(format!("r.id = {id}"));
    Ok(rows(db, clause, "r.id", 1).await?.pop())
}

/// The scope of report `id` for `user` to act in, and the report. A report `user` can't read
/// is `not_found()`, whatever the reason. One they can read but not handle is refused as the
/// scope refuses it.
pub(crate) async fn held(
    db: &Db,
    user: &User,
    id: i64,
) -> Result<(ReportScope, ReportRow), ApiError> {
    let read = reading(db, user, id).await?;
    one(db, &read, id).await?.ok_or_else(not_found)?;
    let scope = scope_of(db, user, id, ReportMode::Write)
        .await?
        .ok_or_else(not_found)?;
    let raw = one(db, &scope, id).await?.ok_or_else(not_found)?;
    Ok((scope, raw.row))
}

/// The report `id` as `scope` lists it.
pub(crate) async fn row(db: &Db, scope: &ReportScope, id: i64) -> Result<ReportRow, ApiError> {
    Ok(one(db, scope, id).await?.ok_or_else(not_found)?.row)
}

/// Whether those who handle the reports of `scope` may name the account `username`: a member
/// of the server (for the instance, any account), or someone who sent a report there that the
/// viewer can see.
pub(crate) async fn reporter_known(
    db: &Db,
    scope: &ReportScope,
    username: &str,
) -> Result<bool, ApiError> {
    if scope.has_member(db, username).await? {
        return Ok(true);
    }
    let mut clause = visible(scope);
    let name = clause.text(username);
    clause.and(format!("r.reporter = {name}"));
    let sql = format!("SELECT 1 FROM reports r WHERE {} LIMIT 1", clause.sql);
    Ok(!clause.fetch(db, sql).await?.is_empty())
}

/// A page of the history of report `id`: the lines before the line `before` (without one, the
/// newest), oldest first, and the cursor for the lines before them.
async fn events(db: &Db, id: i64, before: Option<i64>) -> Result<Paged<ReportEvent>, ApiError> {
    let mut found = sqlx::query("SELECT id, kind, actor, detail, created_at, detail_sealed FROM report_events WHERE report_id = $1 AND id < $2 ORDER BY id DESC LIMIT $3")
        .bind(id)
        .bind(before.unwrap_or(i64::MAX))
        .bind(LIST_PAGE + 1)
        .fetch_all(db)
        .await?;
    let more = found.len() as i64 > LIST_PAGE;
    found.truncate(LIST_PAGE as usize);
    found.reverse();
    let next = match (more, found.first()) {
        (true, Some(first)) => Some(encode_cursor(&[&first.try_get::<i64, _>(0)?.to_string()])),
        (_, _) => None,
    };
    let mut actors = Vec::new();
    for r in &found {
        actors.extend(r.try_get::<Option<String>, _>(2)?);
    }
    let refs = user_refs(db, &actors).await;
    let opener = Opener::of_rows(db, &found, 5).await?;
    let mut events = Vec::with_capacity(found.len());
    for r in &found {
        let kind: String = r.try_get(1)?;
        let detail = detail_of(
            &opener,
            r.try_get(0)?,
            r.try_get::<Option<Vec<u8>>, _>(5)?.as_deref(),
            r.try_get(3)?,
        );
        let actor: Option<String> = r.try_get(2)?;
        events.push(ReportEvent {
            actor: match kind.as_str() {
                "created" => None,
                _ => actor.as_deref().map(|a| user_from(&refs, a)),
            },
            kind,
            detail: serde_json::from_str(&detail)
                .unwrap_or_else(|_| Value::Object(serde_json::Map::new())),
            created_at: r.try_get(4)?,
        });
    }
    Ok(Paged(events, next))
}

/// The report `id` in `scope`, in full.
pub(crate) async fn detail_in(
    db: &Db,
    scope: &ReportScope,
    id: i64,
) -> Result<ReportDetail, ApiError> {
    let Raw {
        row,
        target_user: _,
        reporter: _,
        assignee: _,
        note,
        snapshot,
        answers,
    } = one(db, scope, id).await?.ok_or_else(not_found)?;
    let Paged(events, events_cursor) = events(db, id, None).await?;
    let related = match row.target_kind.as_str() {
        "none" => Vec::new(),
        _ => {
            let mut clause = visible(scope);
            let (key, this) = (clause.text(&row.target_key), clause.int(id));
            clause.and(format!("r.target_key = {key} AND r.id <> {this}"));
            rows(db, clause, "r.created_at DESC, r.id DESC", LIST_PAGE)
                .await?
                .into_iter()
                .map(|raw| raw.row)
                .collect()
        }
    };
    Ok(ReportDetail {
        report: row,
        note,
        answers,
        snapshot,
        franked: false,
        events,
        events_cursor,
        related,
    })
}

/// The scope `user` reads report `id` in. Every miss is `not_found()`: no such report, or a
/// report `user` doesn't handle.
async fn reading(db: &Db, user: &User, id: i64) -> Result<ReportScope, ApiError> {
    match scope_of(db, user, id, ReportMode::Read).await {
        Ok(Some(scope)) => Ok(scope),
        Ok(None) => Err(not_found()),
        Err(e) if e.failed() => Err(e),
        Err(_) => Err(not_found()),
    }
}

/// The report `id` for `user`, in full. Every miss is `not_found()`: no such report, a report
/// `user` doesn't handle, one about them, one from a channel they can't see.
pub(crate) async fn detail(db: &Db, user: &User, id: i64) -> Result<ReportDetail, ApiError> {
    let scope = reading(db, user, id).await?;
    detail_in(db, &scope, id).await
}

/// A page of the history of report `id` for `user`: the lines before `cursor` (without one,
/// the newest), oldest first. Every miss is `not_found()`, as for `detail`.
pub(crate) async fn history(
    db: &Db,
    user: &User,
    id: i64,
    cursor: Option<&str>,
) -> Result<Paged<ReportEvent>, ApiError> {
    let scope = reading(db, user, id).await?;
    one(db, &scope, id).await?.ok_or_else(not_found)?;
    let before = match cursor.filter(|c| !c.trim().is_empty()) {
        Some(cursor) => Some(cursor_int(&decode_cursor(cursor, 1)?[0])?),
        None => None,
    };
    events(db, id, before).await
}

/// The reports of `scope` that pass the filters of `q`, at most `max`, as an export holds
/// them: newest first (oldest first with `q.oldest`), read a page at a time.
pub(crate) async fn export(
    db: &Db,
    scope: &ReportScope,
    q: &ReportQuery,
    max: usize,
) -> Result<Vec<ExportRow>, ApiError> {
    const PAGE: usize = 500;
    let oldest = q.oldest.unwrap_or(false);
    let (after, order) = match oldest {
        true => (">", "r.created_at, r.id"),
        false => ("<", "r.created_at DESC, r.id DESC"),
    };
    let mut out: Vec<ExportRow> = Vec::new();
    let mut last: Option<(i64, i64)> = None;
    loop {
        let mut clause = visible(scope);
        filter(&mut clause, scope, q)?;
        if let Some((at, id)) = last {
            let (at, id) = (clause.int(at), clause.int(id));
            clause.and(format!("(r.created_at, r.id) {after} ({at}, {id})"));
        }
        let take = PAGE.min(max - out.len());
        let found = rows(db, clause, order, take as i64).await?;
        let read = found.len();
        last = found.last().map(|raw| (raw.row.created_at, raw.row.id));
        out.extend(found.into_iter().map(|raw| ExportRow {
            report: raw.row,
            note: raw.note,
            answers: raw.answers,
        }));
        if read < take || out.len() >= max {
            return Ok(out);
        }
    }
}
