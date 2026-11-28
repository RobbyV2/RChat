use std::sync::LazyLock;
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use utoipa::{IntoParams, ToSchema};

use super::forms::{FieldKind, ReportForms, StoredAnswer};
use super::{ReportQuery, ReportRow, query};
use crate::api::access::{ReportMode, ReportScope, report_scope};
use crate::api::audit::{self, Action, Details, Entry};
use crate::api::policy::Policy;
use crate::api::{ApiError, ApiErrorBody, Authed, instance_audit};
use crate::db::{User, pool_key};
use crate::limits::bucket::{self, Keyed};
use crate::state::AppState;

/// The most reports one export holds.
pub const EXPORT_MAX: usize = 5000;
/// Exports per account and hour.
pub const EXPORTS_PER_HOUR: u32 = 10;
pub const TOO_MANY_EXPORTS: &str = "Too many exports. Try again later.";

static EXPORTS: LazyLock<Keyed> = LazyLock::new(|| {
    Keyed::new(
        bucket::Policy::Window {
            limit: EXPORTS_PER_HOUR,
            window: Duration::from_secs(3600),
        },
        100_000,
    )
});

/// The columns every CSV export starts with.
pub const COLUMNS: [&str; 12] = [
    "id", "created", "category", "reason", "status", "action", "target", "reporter", "assignee",
    "server", "channel", "excerpt",
];

/// The file format of an export.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum Format {
    /// Comma-separated values: one line per report, a column per field of the forms.
    #[default]
    Csv,
    /// A JSON list of the reports with their answers.
    Json,
}

impl Format {
    fn as_str(self) -> &'static str {
        match self {
            Format::Csv => "csv",
            Format::Json => "json",
        }
    }
}

/// The format of an export.
#[derive(Debug, Default, Deserialize, IntoParams)]
pub struct ExportQuery {
    /// `csv` (the default) or `json`.
    pub format: Option<Format>,
}

/// A report in an export: the report as the list shows it, with the reporter's note and the
/// answers to the form's fields.
#[derive(Clone, Debug, Serialize)]
pub struct ExportRow {
    #[serde(flatten)]
    pub report: ReportRow,
    pub note: Option<String>,
    pub answers: Vec<StoredAnswer>,
}

/// A cell of a CSV file. A text that a spreadsheet would read as a formula gets a `'` in
/// front, and a text with a comma, a quote or a line break is quoted.
pub(crate) fn cell(text: &str) -> String {
    let guarded = match text.starts_with(['=', '+', '-', '@', '\t', '\r']) {
        true => format!("'{text}"),
        false => text.to_string(),
    };
    match guarded.contains([',', '"', '\n', '\r']) {
        true => format!("\"{}\"", guarded.replace('"', "\"\"")),
        false => guarded,
    }
}

/// A unix time as `YYYY-MM-DDTHH:MM:SSZ`.
pub(crate) fn stamp(t: i64) -> String {
    let (days, secs) = (t.div_euclid(86400), t.rem_euclid(86400));
    format!(
        "{}T{:02}:{:02}:{:02}Z",
        query::date_of(days),
        secs / 3600,
        secs / 60 % 60,
        secs % 60
    )
}

/// An answer as the text of one cell.
fn said(answer: &StoredAnswer) -> String {
    let text = |value: &Value| match value {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    };
    match answer.kind {
        FieldKind::ShortText | FieldKind::LongText => text(&answer.value),
        FieldKind::SingleChoice | FieldKind::MultipleChoice => match &answer.shown {
            Some(labels) => labels.join("; "),
            None => match &answer.value {
                Value::Array(ids) => ids.iter().map(text).collect::<Vec<_>>().join("; "),
                one => text(one),
            },
        },
        FieldKind::Checkbox => match answer.value.as_bool() {
            Some(true) => "yes".to_string(),
            Some(false) | None => String::new(),
        },
        FieldKind::User => match answer.value.get("username") {
            Some(name) => text(name),
            None => "Deleted user".to_string(),
        },
        FieldKind::Server => text(&answer.value["server"]),
        FieldKind::Message => text(&answer.value["message_id"]),
    }
}

/// Who or what a report is about, as text.
fn target_of(row: &ReportRow) -> String {
    match (&row.target, &row.webhook, row.target_key.split_once(':')) {
        (Some(user), _, _) => user.username.clone(),
        (None, Some(webhook), _) => webhook.clone(),
        (None, None, Some(("d", _))) => "Deleted user".to_string(),
        (None, None, Some(("s", name))) => name.to_string(),
        (None, None, Some(("u", name))) => name.to_string(),
        (None, None, _) => String::new(),
    }
}

/// The reports as a CSV file: the fixed columns, then a column per field of the current
/// forms under the field's label, then a `field:<id>` column per answered field that no form
/// has any more.
pub(crate) fn csv(forms: &ReportForms, rows: &[ExportRow]) -> String {
    let mut fields: Vec<(String, String)> = Vec::new();
    for form in &forms.forms {
        for field in form.open_fields() {
            if !fields.iter().any(|(id, _)| *id == field.id) {
                fields.push((field.id.clone(), field.label.clone()));
            }
        }
    }
    for row in rows {
        for answer in &row.answers {
            if !fields.iter().any(|(id, _)| *id == answer.id) {
                fields.push((answer.id.clone(), format!("field:{}", answer.id)));
            }
        }
    }
    let mut out = String::new();
    let mut line = |cells: Vec<String>| {
        out.push_str(&cells.join(","));
        out.push_str("\r\n");
    };
    line(
        COLUMNS
            .iter()
            .map(|c| c.to_string())
            .chain(fields.iter().map(|(_, label)| cell(label)))
            .collect(),
    );
    for ExportRow {
        report,
        note: _,
        answers,
    } in rows
    {
        let name = |user: &Option<crate::api::UserRef>| user.as_ref().map(|u| u.username.clone());
        let mut cells = vec![
            report.id.to_string(),
            stamp(report.created_at),
            cell(&report.form_label),
            cell(report.reason_label.as_deref().unwrap_or(&report.reason)),
            report.status.as_str().to_string(),
            report
                .action
                .map(|a| a.as_str().to_string())
                .unwrap_or_default(),
            cell(&target_of(report)),
            cell(&name(&report.reporter).unwrap_or_else(|| "Deleted user".to_string())),
            cell(&name(&report.assignee).unwrap_or_default()),
            cell(
                report
                    .server_name
                    .as_deref()
                    .or(report.server.as_deref())
                    .unwrap_or_default(),
            ),
            cell(report.channel.as_deref().unwrap_or_default()),
            cell(&report.excerpt),
        ];
        for (id, _) in &fields {
            cells.push(match answers.iter().find(|a| a.id == *id) {
                Some(answer) => cell(&said(answer)),
                None => String::new(),
            });
        }
        line(cells);
    }
    out
}

/// The export of the reports `scope` shows under the filters of `q`, at most `EXPORT_MAX`,
/// for `user`. It counts against the account's exports of the hour and is logged with the
/// number of reports, naming nobody.
pub(crate) async fn export_in(
    state: &AppState,
    scope: &ReportScope,
    user: &User,
    q: &ReportQuery,
    format: Format,
) -> Result<Response, ApiError> {
    let key = format!("{}\n{}", pool_key(&state.db), user.username);
    if let Err(wait) = EXPORTS.try_take(&key, 1.0, tokio::time::Instant::now()) {
        let wait = wait.as_secs_f64().ceil().max(1.0) as u64;
        return Err(ApiError::rate(TOO_MANY_EXPORTS, Some(wait)));
    }
    let rows = query::export(&state.read(), scope, q, EXPORT_MAX).await?;
    let (body, kind, file) = match format {
        Format::Csv => {
            let forms = &Policy::cached(&state.db).await.report_forms;
            (csv(forms, &rows), "text/csv; charset=utf-8", "reports.csv")
        }
        Format::Json => (
            serde_json::to_string(&rows).map_err(ApiError::internal)?,
            "application/json",
            "reports.json",
        ),
    };
    let detail = json!({ "count": rows.len(), "format": format.as_str() });
    match &scope.server {
        Some(server) => {
            let details = Details::new()
                .set("count", rows.len() as i64)
                .set("format", format.as_str());
            let mut conn = state.db.acquire().await?;
            audit::record(
                &mut conn,
                Entry::new(server, &scope.actor(), Action::ReportExport).details(details),
            )
            .await?;
        }
        None => {
            instance_audit::record(&state.db, &user.username, "report.export", None, detail)
                .await?;
        }
    }
    Ok((
        [
            (header::CONTENT_TYPE, kind.to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{file}\""),
            ),
            (header::CACHE_CONTROL, "no-store".to_string()),
        ],
        body,
    )
        .into_response())
}

/// Export a server's reports
///
/// The reports sent to the moderators of the server as a file: `format=csv` (the default) or
/// `format=json`. The filters of the report list apply (`status`, `reason`, `form`, `from`,
/// `to`, `by` with `key`, `oldest`), and the file holds only what the list shows you: never a
/// report about yourself, nor one about a message in a channel you can't view. At most 5,000
/// reports per file, newest first; narrow the time range for more. CSV columns: `id`,
/// `created`, `category`, `reason`, `status`, `action`, `target`, `reporter`, `assignee`,
/// `server`, `channel`, `excerpt`, then one column per field of the current report forms
/// under the field's label, then a `field:<id>` column per answered field that no form has
/// any more. A cell that starts with `=`, `+`, `-` or `@` gets a `'` in front. JSON: the
/// reports of the list, each with its `note` and `answers`. Every export is logged as
/// `report.export` with the number of reports. Requires being a member with the Manage reports
/// permission. At most 10 exports per hour and account; strict rate-limit bucket.
#[utoipa::path(
    get,
    path = "/api/v1/servers/{name}/reports/export",
    tag = "Reports",
    params(("name" = String, Path, description = "Server name, case-insensitive"), ExportQuery, ReportQuery),
    responses(
        (status = 200, description = "The file, as an attachment: `text/csv` or, with `format=json`, `application/json` (a list of the reports as the report list gives them, each with its `note` and `answers`)", content_type = "text/csv", body = String),
        (status = 400, description = "`Unknown grouping` (`by=server`), `Invalid tz`, `Invalid day` (JSON), or a value of the wrong type (plain-text framework error)", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "`Missing permission`: a member without Manage reports. Or banned from the server", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or one you are not a member of (identical responses)", body = ApiErrorBody),
        (status = 429, description = "`Too many exports. Try again later.` with a `Retry-After` header (JSON): more than 10 exports this hour. Or too many requests in the strict bucket", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn export_reports(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Query(ExportQuery { format }): Query<ExportQuery>,
    Query(q): Query<ReportQuery>,
) -> Result<Response, ApiError> {
    let scope = report_scope(&state.read(), &user, Some(&name), ReportMode::Read).await?;
    export_in(&state, &scope, &user, &q, format.unwrap_or_default()).await
}
