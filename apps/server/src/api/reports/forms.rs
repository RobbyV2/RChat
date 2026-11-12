use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

use super::refused;
use crate::api::policy::Policy;
use crate::api::{ApiError, Authed, NAME_MAX, Settings};
use crate::state::AppState;

/// The `settings` row that holds the forms, and the control's key.
pub const KEY: &str = "report_forms";
/// The env name of the file that sets the forms.
pub const ENV: &str = "REPORT_FORMS_FILE";

pub const FORMS_MAX: usize = 12;
pub const FIELDS_MAX: usize = 12;
pub const OPTIONS_MAX: usize = 20;
/// The most bytes the stored document takes.
pub const DOCUMENT_MAX: usize = 64 * 1024;
/// The most bytes the answers of one report take.
pub const ANSWERS_MAX: usize = 16 * 1024;
pub const ID_MAX: usize = 32;
pub const LABEL_MAX: usize = 80;
pub const LINE_MAX: usize = 200;
pub const HELP_MAX: usize = 200;
pub const SHORT_MAX: u32 = 200;
pub const LONG_MAX: u32 = 2000;

/// The most bytes a forms file may hold before it is read as JSON.
const FILE_MAX: usize = 1024 * 1024;

/// The reasons of an abuse report: wire name, then default label.
pub const REASONS: [(&str, &str); 8] = [
    ("spam", "Spam"),
    ("harassment", "Harassment"),
    ("hate", "Hate"),
    ("sexual", "Sexual content"),
    ("violence", "Violence or self-harm"),
    ("illegal", "Illegal content"),
    ("impersonation", "Impersonation"),
    ("other", "Other"),
];

/// The reason an unknown or removed reason becomes.
pub const OTHER: &str = "other";

/// The categories every document keeps, with their bases.
pub const BUILT_IN: [(&str, Base); 5] = [
    ("user", Base::User),
    ("bug", Base::None),
    ("server", Base::Server),
    ("general", Base::None),
    ("message", Base::Message),
];

/// What a report category is about, which fixes its first fields and where its reports go.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum Base {
    /// An account. Goes to a server's moderators when it names a server the account is in,
    /// else to the instance.
    User,
    /// A server. Goes to the instance.
    Server,
    /// A message, opened from that message only.
    Message,
    /// Nothing: a bug, feedback or a question. Goes to the instance.
    None,
}

impl Base {
    pub fn as_str(self) -> &'static str {
        match self {
            Base::User => "user",
            Base::Server => "server",
            Base::Message => "message",
            Base::None => "none",
        }
    }

    /// The fields a category of this base starts with, in order: id, kind, required. Only
    /// their label, their help and the options of `reason` can change.
    pub fn locked(self) -> &'static [(&'static str, FieldKind, bool)] {
        match self {
            Base::User => &[
                ("target", FieldKind::User, true),
                ("reason", FieldKind::SingleChoice, true),
                ("place", FieldKind::Server, false),
            ],
            Base::Server => &[
                ("target", FieldKind::Server, true),
                ("reason", FieldKind::SingleChoice, true),
            ],
            Base::Message => &[
                ("target", FieldKind::Message, true),
                ("reason", FieldKind::SingleChoice, true),
                ("context", FieldKind::Checkbox, false),
            ],
            Base::None => &[],
        }
    }

    /// Whether a report of this base can go out while the two report switches are as given.
    fn open(self, settings: &Settings) -> bool {
        match self {
            Base::User | Base::Message => settings.server_reports || settings.instance_reports,
            Base::Server | Base::None => settings.instance_reports,
        }
    }
}

/// How a field of a report form is asked and answered.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum FieldKind {
    /// One line of text, answered with a string.
    ShortText,
    /// Several lines of text, answered with a string.
    LongText,
    /// One of `options`, answered with the option's id.
    SingleChoice,
    /// Any of `options`, answered with a list of option ids.
    MultipleChoice,
    /// A statement to tick, answered with `true` or `false`.
    Checkbox,
    /// An account, answered with `{"username": ...}`.
    User,
    /// A server, answered with `{"server": ...}`.
    Server,
    /// A message, answered with `{"message_id": ...}`.
    Message,
}

impl FieldKind {
    pub fn as_str(self) -> &'static str {
        match self {
            FieldKind::ShortText => "short_text",
            FieldKind::LongText => "long_text",
            FieldKind::SingleChoice => "single_choice",
            FieldKind::MultipleChoice => "multiple_choice",
            FieldKind::Checkbox => "checkbox",
            FieldKind::User => "user",
            FieldKind::Server => "server",
            FieldKind::Message => "message",
        }
    }
}

/// One option of a choice field.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct Choice {
    /// 1 to 32 of a-z, 0-9 and `_`, unique in its field. This is what an answer carries.
    pub id: String,
    /// The text shown, up to 80 characters.
    pub label: String,
}

/// One field of a report form.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct Field {
    /// 1 to 32 of a-z, 0-9 and `_`, unique in its form.
    pub id: String,
    /// How it is asked and answered.
    pub kind: FieldKind,
    /// The text shown, up to 80 characters. For a `checkbox` it is the statement.
    pub label: String,
    /// A line under the label, up to 200 characters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub help: Option<String>,
    /// Whether a report needs an answer to it.
    #[serde(default)]
    pub required: bool,
    /// Text fields: the hint shown while empty, up to 200 characters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    /// `long_text`: the text the field starts with, up to 2,000 characters. An answer equal to
    /// it counts as no answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    /// `multiple_choice`: the fewest options an answer picks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<u32>,
    /// Text fields: the most characters (`short_text` 1 to 200, the default 200; `long_text` 1
    /// to 2,000, the default 2,000). `multiple_choice`: the most options an answer picks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<u32>,
    /// Choice fields: 2 to 20 options.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<Choice>,
    /// `single_choice` in a form of base `none`: its answer is the report's reason. At most one
    /// field per form.
    #[serde(default, skip_serializing_if = "is_false")]
    pub reason: bool,
}

fn is_false(on: &bool) -> bool {
    !*on
}

fn yes() -> bool {
    true
}

fn first_rev() -> i64 {
    1
}

/// One report category: a form.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct Form {
    /// 1 to 32 of a-z, 0-9 and `_`. `user`, `bug`, `server`, `general` and `message` always
    /// exist.
    pub id: String,
    /// Its name in the list and the form's title, up to 80 characters.
    pub label: String,
    /// The line under its name in the list, up to 200 characters.
    #[serde(default)]
    pub line: String,
    /// Whether people can send it. `GET /api/v1/report_forms` lists only forms that are on.
    #[serde(default = "yes")]
    pub enabled: bool,
    /// What it is about.
    pub base: Base,
    /// Its fields in order, 12 at most: the fields of its base first.
    #[serde(default)]
    pub fields: Vec<Field>,
}

impl Form {
    /// The single-choice field whose answer is the report's reason: the locked `reason` of an
    /// abuse base, or the field a `none` form marks.
    pub fn reason_field(&self) -> Option<&Field> {
        match self.base {
            Base::User | Base::Server | Base::Message => {
                self.fields.iter().find(|f| f.id == "reason")
            }
            Base::None => self.fields.iter().find(|f| f.reason),
        }
    }

    /// The fields a report answers in `answers`: all but the locked ones of its base, which the
    /// report's target, reason and context carry.
    pub fn open_fields(&self) -> &[Field] {
        self.fields
            .get(self.base.locked().len()..)
            .unwrap_or_default()
    }
}

/// The report forms of the instance.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ReportForms {
    /// Grows by one with every change of the forms.
    #[serde(default = "first_rev")]
    pub rev: i64,
    /// The categories in list order, 12 at most.
    pub forms: Vec<Form>,
}

impl Default for ReportForms {
    fn default() -> ReportForms {
        ReportForms::defaults()
    }
}

fn id_ok(id: &str) -> bool {
    (1..=ID_MAX).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// Whether `text` holds no control character. `lines` allows line breaks and tabs.
fn chars_ok(text: &str, lines: bool) -> bool {
    !text
        .chars()
        .any(|c| c.is_control() && !(lines && matches!(c, '\n' | '\t')))
}

/// Whether `text` is a line of up to `max` characters. `lines` allows line breaks and tabs.
fn text_ok(text: &str, max: usize, lines: bool) -> bool {
    text.chars().count() <= max && chars_ok(text, lines)
}

fn label_ok(label: &str) -> bool {
    !label.trim().is_empty() && text_ok(label, LABEL_MAX, false)
}

fn check_options(at: &str, options: &[Choice]) -> Result<(), String> {
    if !(2..=OPTIONS_MAX).contains(&options.len()) {
        return Err(format!("{at}: 2 to {OPTIONS_MAX} options"));
    }
    for (n, Choice { id, label }) in options.iter().enumerate() {
        let n = n + 1;
        if !id_ok(id) {
            return Err(format!(
                "{at}: option {n} needs an id of 1 to {ID_MAX} of a-z, 0-9 and _"
            ));
        }
        if options.iter().filter(|o| o.id == *id).count() > 1 {
            return Err(format!("{at}: option ids must be unique: {id}"));
        }
        if !label_ok(label) {
            return Err(format!(
                "{at}: option {id} needs a label of up to {LABEL_MAX} characters"
            ));
        }
    }
    Ok(())
}

fn check_field(form: &Form, n: usize, field: &Field) -> Result<(), String> {
    let Field {
        id,
        kind,
        label,
        help,
        required,
        placeholder,
        template,
        min,
        max,
        options,
        reason,
    } = field;
    if !id_ok(id) {
        return Err(format!(
            "{}: field {} needs an id of 1 to {ID_MAX} of a-z, 0-9 and _",
            form.id,
            n + 1
        ));
    }
    let at = format!("{}.{id}", form.id);
    if form.fields.iter().filter(|f| f.id == *id).count() > 1 {
        return Err(format!("{}: field ids must be unique: {id}", form.id));
    }
    if !label_ok(label) {
        return Err(format!("{at}: the label needs 1 to {LABEL_MAX} characters"));
    }
    if help
        .as_deref()
        .is_some_and(|h| !text_ok(h, HELP_MAX, false))
    {
        return Err(format!("{at}: the help takes up to {HELP_MAX} characters"));
    }
    let text = matches!(kind, FieldKind::ShortText | FieldKind::LongText);
    let choice = matches!(kind, FieldKind::SingleChoice | FieldKind::MultipleChoice);
    if placeholder.is_some() && !text {
        return Err(format!("{at}: only text fields take a placeholder"));
    }
    if placeholder
        .as_deref()
        .is_some_and(|p| !text_ok(p, SHORT_MAX as usize, false))
    {
        return Err(format!(
            "{at}: the placeholder takes up to {SHORT_MAX} characters"
        ));
    }
    if template.is_some() && *kind != FieldKind::LongText {
        return Err(format!("{at}: only long_text takes a template"));
    }
    if min.is_some() && *kind != FieldKind::MultipleChoice {
        return Err(format!("{at}: only multiple_choice takes min"));
    }
    if max.is_some() && !text && *kind != FieldKind::MultipleChoice {
        return Err(format!("{at}: this kind takes no max"));
    }
    if !options.is_empty() && !choice {
        return Err(format!("{at}: only choice fields take options"));
    }
    if choice {
        check_options(&at, options)?;
    }
    match kind {
        FieldKind::ShortText | FieldKind::LongText => {
            let most = match kind {
                FieldKind::ShortText => SHORT_MAX,
                _ => LONG_MAX,
            };
            let max = max.unwrap_or(most);
            if !(1..=most).contains(&max) {
                return Err(format!("{at}: max must be 1 to {most}"));
            }
            if template
                .as_deref()
                .is_some_and(|t| !text_ok(t, max as usize, true))
            {
                return Err(format!("{at}: the template takes up to {max} characters"));
            }
        }
        FieldKind::MultipleChoice => {
            let count = options.len() as u32;
            let (low, high) = (min.unwrap_or(0), max.unwrap_or(count));
            if high < 1 || high > count || low > high {
                return Err(format!("{at}: min and max must fit its {count} options"));
            }
        }
        FieldKind::SingleChoice
        | FieldKind::Checkbox
        | FieldKind::User
        | FieldKind::Server
        | FieldKind::Message => {}
    }
    let locked = form.base.locked();
    match locked.get(n) {
        Some((fixed, fixed_kind, fixed_required)) => {
            if id != fixed {
                return Err(format!("{}: field {} must be {fixed}", form.id, n + 1));
            }
            if kind != fixed_kind {
                return Err(format!("{at}: the kind must stay {}", fixed_kind.as_str()));
            }
            if required != fixed_required {
                return Err(format!("{at}: required must stay {fixed_required}"));
            }
            if *reason {
                return Err(format!("{at}: only a form of base none marks a reason"));
            }
            if *fixed == "reason" {
                if let Some(unknown) = options
                    .iter()
                    .find(|o| !REASONS.iter().any(|(wire, _)| *wire == o.id))
                {
                    return Err(format!("{at}: unknown reason {}", unknown.id));
                }
                if !options.iter().any(|o| o.id == OTHER) {
                    return Err(format!("{at}: the reason {OTHER} must stay"));
                }
            }
        }
        None => {
            if *reason && (form.base != Base::None || *kind != FieldKind::SingleChoice) {
                return Err(format!(
                    "{at}: only a single_choice of a form of base none marks a reason"
                ));
            }
        }
    }
    Ok(())
}

fn check_form(forms: &[Form], n: usize, form: &Form) -> Result<(), String> {
    let Form {
        id,
        label,
        line,
        enabled,
        base,
        fields,
    } = form;
    if !id_ok(id) {
        return Err(format!(
            "Category {} needs an id of 1 to {ID_MAX} of a-z, 0-9 and _",
            n + 1
        ));
    }
    if forms.iter().filter(|f| f.id == *id).count() > 1 {
        return Err(format!("Category ids must be unique: {id}"));
    }
    if !label_ok(label) {
        return Err(format!("{id}: the label needs 1 to {LABEL_MAX} characters"));
    }
    if !text_ok(line, LINE_MAX, false) {
        return Err(format!("{id}: the line takes up to {LINE_MAX} characters"));
    }
    match BUILT_IN.iter().find(|(built_in, _)| built_in == id) {
        Some((_, fixed)) if fixed != base => {
            return Err(format!("{id}: the base must stay {}", fixed.as_str()));
        }
        Some(_) => {}
        None if *base == Base::Message => {
            return Err(format!(
                "{id}: only the category message has the base message"
            ));
        }
        None => {}
    }
    if *base == Base::Message && !enabled {
        return Err("The category message can't be turned off".to_string());
    }
    if fields.len() > FIELDS_MAX {
        return Err(format!("{id}: at most {FIELDS_MAX} fields"));
    }
    if let Some((missing, _, _)) = base.locked().get(fields.len()) {
        return Err(format!("{id}: the field {missing} can't be removed"));
    }
    for (n, field) in fields.iter().enumerate() {
        check_field(form, n, field)?;
    }
    if fields.iter().filter(|f| f.reason).count() > 1 {
        return Err(format!("{id}: only one field can be the reason"));
    }
    Ok(())
}

impl ReportForms {
    /// The first thing wrong with the document, as plain ASCII.
    pub fn check(&self) -> Result<(), String> {
        let ReportForms { rev, forms } = self;
        if *rev < 0 {
            return Err("rev can't be negative".to_string());
        }
        if forms.len() > FORMS_MAX {
            return Err(format!("At most {FORMS_MAX} categories"));
        }
        if let Some((gone, _)) = BUILT_IN
            .iter()
            .find(|(id, _)| !forms.iter().any(|f| f.id == *id))
        {
            return Err(format!("The category {gone} can't be removed"));
        }
        for (n, form) in forms.iter().enumerate() {
            check_form(forms, n, form)?;
        }
        if self.stored().len() > DOCUMENT_MAX {
            return Err(format!(
                "The forms take more than {} KiB",
                DOCUMENT_MAX / 1024
            ));
        }
        Ok(())
    }

    /// Reads and checks a document: `{"forms": [...]}`, with an optional `rev`. The admin
    /// endpoint and the `REPORT_FORMS_FILE` loader share it.
    pub fn parse(raw: &str) -> Result<ReportForms, String> {
        if raw.len() > FILE_MAX {
            return Err(format!(
                "The forms take more than {} KiB",
                DOCUMENT_MAX / 1024
            ));
        }
        let forms: ReportForms =
            serde_json::from_str(raw).map_err(|e| format!("not a forms document: {e}"))?;
        forms.check()?;
        Ok(forms)
    }

    /// The document as the `settings` row holds it.
    pub fn stored(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    /// A stored row read back. `None` when it is not a document this build understands.
    pub fn from_stored(stored: &str) -> Option<ReportForms> {
        serde_json::from_str(stored).ok()
    }

    pub fn find(&self, id: &str) -> Option<&Form> {
        self.forms.iter().find(|f| f.id == id)
    }

    /// What `GET /api/v1/report_forms` answers: the categories that are on and whose reports
    /// can go out under the report switches of `settings`.
    pub fn open(&self, settings: &Settings) -> ReportForms {
        ReportForms {
            rev: self.rev,
            forms: self
                .forms
                .iter()
                .filter(|f| f.enabled && f.base.open(settings))
                .cloned()
                .collect(),
        }
    }

    /// The `ETag` of `open`: the revision, and which report switches are off.
    pub fn etag(&self, settings: &Settings) -> String {
        match (settings.server_reports, settings.instance_reports) {
            (true, true) => format!("\"{}\"", self.rev),
            (true, false) => format!("\"{}-server\"", self.rev),
            (false, true) => format!("\"{}-instance\"", self.rev),
            (false, false) => format!("\"{}-off\"", self.rev),
        }
    }

    /// The forms a new instance starts with, and what "Reset to default" restores.
    pub fn defaults() -> ReportForms {
        let field = |id: &str, kind: FieldKind, label: &str| Field {
            id: id.to_string(),
            kind,
            label: label.to_string(),
            help: None,
            required: false,
            placeholder: None,
            template: None,
            min: None,
            max: None,
            options: Vec::new(),
            reason: false,
        };
        let choices = |pairs: &[(&str, &str)]| -> Vec<Choice> {
            pairs
                .iter()
                .map(|(id, label)| Choice {
                    id: id.to_string(),
                    label: label.to_string(),
                })
                .collect()
        };
        let reason = || Field {
            required: true,
            options: choices(&REASONS),
            ..field("reason", FieldKind::SingleChoice, "What's wrong")
        };
        let form = |id: &str, base: Base, label: &str, line: &str, fields: Vec<Field>| Form {
            id: id.to_string(),
            label: label.to_string(),
            line: line.to_string(),
            enabled: true,
            base,
            fields,
        };
        let forms = vec![
            form(
                "user",
                Base::User,
                "Report a user",
                "Someone breaking the rules.",
                vec![
                    Field {
                        required: true,
                        ..field("target", FieldKind::User, "Who")
                    },
                    reason(),
                    field("place", FieldKind::Server, "Where it happened"),
                    field("evidence", FieldKind::Message, "A message that shows it"),
                    Field {
                        max: Some(1000),
                        template: Some("What happened:\n\nWhen:\n".to_string()),
                        ..field("details", FieldKind::LongText, "What happened")
                    },
                ],
            ),
            form(
                "bug",
                Base::None,
                "Report a bug",
                "Something in the app doesn't work.",
                vec![
                    Field {
                        reason: true,
                        options: choices(&[
                            ("broke", "Something broke"),
                            ("looks", "Looks wrong"),
                            ("slow", "Too slow"),
                            ("other", "Other"),
                        ]),
                        ..field("kind", FieldKind::SingleChoice, "What kind")
                    },
                    Field {
                        required: true,
                        max: Some(120),
                        ..field("summary", FieldKind::ShortText, "What went wrong")
                    },
                    Field {
                        template: Some("1. \n2. \n3. ".to_string()),
                        ..field("steps", FieldKind::LongText, "Steps to make it happen")
                    },
                    field("expected", FieldKind::LongText, "What you expected"),
                    field("device", FieldKind::ShortText, "App and device"),
                ],
            ),
            form(
                "server",
                Base::Server,
                "Report a server",
                "A server breaking the rules.",
                vec![
                    Field {
                        required: true,
                        ..field("target", FieldKind::Server, "Which server")
                    },
                    reason(),
                    Field {
                        max: Some(1000),
                        ..field("details", FieldKind::LongText, "What happened")
                    },
                ],
            ),
            form(
                "general",
                Base::None,
                "Something else",
                "Feedback, questions or anything else.",
                vec![
                    Field {
                        reason: true,
                        options: choices(&[
                            ("feedback", "Feedback"),
                            ("question", "Question"),
                            ("other", "Other"),
                        ]),
                        ..field("topic", FieldKind::SingleChoice, "Topic")
                    },
                    Field {
                        required: true,
                        ..field("details", FieldKind::LongText, "Tell us more")
                    },
                ],
            ),
            form(
                "message",
                Base::Message,
                "Report message",
                "",
                vec![
                    Field {
                        required: true,
                        ..field("target", FieldKind::Message, "Message")
                    },
                    reason(),
                    field(
                        "context",
                        FieldKind::Checkbox,
                        "Include up to 10 earlier messages",
                    ),
                    Field {
                        max: Some(1000),
                        ..field("details", FieldKind::LongText, "Note")
                    },
                ],
            ),
        ];
        ReportForms { rev: 1, forms }
    }
}

/// One answer of a report: a field of its form and what the reporter gave.
#[derive(Clone, Debug, PartialEq, Deserialize, ToSchema)]
pub struct Answer {
    /// The field's id.
    pub id: String,
    /// A string for text fields and a single choice, a list of option ids for a multiple
    /// choice, `true` or `false` for a checkbox, `{"username": ...}`, `{"server": ...}` or
    /// `{"message_id": ...}` for a reference.
    #[schema(value_type = Object)]
    pub value: Value,
}

/// An answer as a report keeps it, with the field's label and the labels of the chosen options
/// at report time, so later changes of the form never change what an old report says.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StoredAnswer {
    pub id: String,
    pub label: String,
    pub kind: FieldKind,
    pub value: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shown: Option<Vec<String>>,
}

/// An answer's stored value and, for choices, the labels of the chosen options.
type Kept = (Value, Option<Vec<String>>);

/// What the answer `value` to `field` is stored as, `None` when it is no answer (empty text, a
/// text still equal to its template, no option, an unticked box).
fn stored_answer(field: &Field, value: &Value) -> Result<Option<Kept>, ApiError> {
    let wrong = || refused("Answer of the wrong kind");
    let label_of = |id: &str| {
        field
            .options
            .iter()
            .find(|o| o.id == id)
            .map(|o| o.label.clone())
    };
    match field.kind {
        FieldKind::ShortText | FieldKind::LongText => {
            let given = value.as_str().ok_or_else(wrong)?;
            let (most, lines) = match field.kind {
                FieldKind::ShortText => (SHORT_MAX, false),
                _ => (LONG_MAX, true),
            };
            let text = match lines {
                true => given.replace("\r\n", "\n").replace('\r', "\n"),
                false => given.to_string(),
            };
            if !chars_ok(&text, lines) {
                return Err(refused("Answer has invalid characters"));
            }
            if text.chars().count() > field.max.unwrap_or(most) as usize {
                return Err(refused("Answer too long"));
            }
            let untouched = field
                .template
                .as_deref()
                .is_some_and(|t| t.trim() == text.trim());
            Ok(match text.trim().is_empty() || untouched {
                true => None,
                false => Some((Value::from(text), None)),
            })
        }
        FieldKind::SingleChoice => {
            let id = value.as_str().ok_or_else(wrong)?;
            if id.is_empty() {
                return Ok(None);
            }
            let is_reason = field.reason || field.id == "reason";
            match (label_of(id), is_reason.then(|| label_of(OTHER)).flatten()) {
                (Some(label), _) => Ok(Some((Value::from(id), Some(vec![label])))),
                (None, Some(other)) => Ok(Some((Value::from(OTHER), Some(vec![other])))),
                (None, None) => Err(refused("Unknown option")),
            }
        }
        FieldKind::MultipleChoice => {
            let ids: Vec<&str> = value
                .as_array()
                .ok_or_else(wrong)?
                .iter()
                .map(|v| v.as_str().ok_or_else(wrong))
                .collect::<Result<_, _>>()?;
            if ids.is_empty() {
                return Ok(None);
            }
            let mut labels = Vec::new();
            for (n, id) in ids.iter().enumerate() {
                if ids[..n].contains(id) {
                    return Err(refused("Option picked twice"));
                }
                labels.push(label_of(id).ok_or_else(|| refused("Unknown option"))?);
            }
            let (min, max) = (
                field.min.unwrap_or(0) as usize,
                field.max.map_or(field.options.len(), |m| m as usize),
            );
            if ids.len() < min {
                return Err(refused("Too few options picked"));
            }
            if ids.len() > max {
                return Err(refused("Too many options picked"));
            }
            Ok(Some((Value::from(ids), Some(labels))))
        }
        FieldKind::Checkbox => Ok(match value.as_bool().ok_or_else(wrong)? {
            true => Some((Value::from(true), None)),
            false => None,
        }),
        FieldKind::User | FieldKind::Server => {
            let key = match field.kind {
                FieldKind::User => "username",
                _ => "server",
            };
            match value {
                Value::Null => Ok(None),
                _ => {
                    let name = value.get(key).and_then(Value::as_str).ok_or_else(wrong)?;
                    if name.is_empty() || name.chars().count() > NAME_MAX {
                        return Err(wrong());
                    }
                    Ok(Some((serde_json::json!({ key: name }), None)))
                }
            }
        }
        FieldKind::Message => match value {
            Value::Null => Ok(None),
            _ => {
                let id = value
                    .get("message_id")
                    .and_then(Value::as_i64)
                    .filter(|id| *id > 0)
                    .ok_or_else(wrong)?;
                Ok(Some((serde_json::json!({ "message_id": id }), None)))
            }
        },
    }
}

/// Checks the answers of a report against the category `form` of `forms` and gives them as the
/// report keeps them, in form order, without the empty ones. `answers` covers the fields after
/// the locked ones of the form's base (`Form::open_fields`): the report's own target, reason
/// and context carry those. Whether the caller may see what a reference answer names is not
/// checked here. Every refusal is a 400.
pub fn validate_answers(
    forms: &ReportForms,
    form: &str,
    answers: &[Answer],
) -> Result<Vec<StoredAnswer>, ApiError> {
    let form = forms
        .find(form)
        .filter(|f| f.enabled)
        .ok_or_else(|| refused("Unknown form"))?;
    let size: usize = answers
        .iter()
        .map(|a| a.id.len() + a.value.to_string().len())
        .sum();
    if size > ANSWERS_MAX {
        return Err(refused("Answers too long"));
    }
    let fields = form.open_fields();
    for (n, answer) in answers.iter().enumerate() {
        if !fields.iter().any(|f| f.id == answer.id) {
            return Err(refused("Unknown field"));
        }
        if answers[..n].iter().any(|a| a.id == answer.id) {
            return Err(refused("Field answered twice"));
        }
    }
    let mut kept = Vec::new();
    for field in fields {
        let given = match answers.iter().find(|a| a.id == field.id) {
            Some(answer) => stored_answer(field, &answer.value)?,
            None => None,
        };
        match (given, field.required) {
            (Some((value, shown)), _) => kept.push(StoredAnswer {
                id: field.id.clone(),
                label: field.label.clone(),
                kind: field.kind,
                value,
                shown,
            }),
            (None, true) => {
                return Err(refused(&format!("Missing required field: {}", field.id)));
            }
            (None, false) => {}
        }
    }
    Ok(kept)
}

/// Get the report forms
///
/// The report categories people can send, in list order. Each is a form: a `base` that says
/// what the report is about (`user`, `server`, `message` or `none`) and its fields. The fields
/// of the base come first (`target`, `reason`, then `place` for `user` and `context` for
/// `message`). Categories that are turned off, or whose reports can't go out while the report
/// switches of `GET /api/v1/settings` are off, are left out. The category `message` is opened
/// from a message and is not for a list of categories. The `ETag` changes whenever the answer
/// does: send it back as `If-None-Match` to get 304 without a body. Needs an account: guests
/// get 401. General rate-limit bucket.
#[utoipa::path(get, path = "/api/v1/report_forms", tag = "Reports", params(("If-None-Match" = Option<String>, Header, description = "The `ETag` of the copy you hold")), responses((status = 200, description = "The forms, with their `ETag`", body = ReportForms, headers(("ETag" = String, description = "Changes when the forms or the report switches change"))), (status = 304, description = "Your copy is current"), (status = 401, description = "Missing or invalid token, or a guest", body = crate::api::ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)))]
pub(crate) async fn get_forms(
    State(state): State<AppState>,
    Authed(_user): Authed,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let settings = Settings::cached(&state.db).await;
    let policy = Policy::cached(&state.db).await;
    let etag = policy.report_forms.etag(&settings);
    let fresh = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.split(',')
                .any(|t| t.trim().trim_start_matches("W/") == etag)
        });
    let cached = [
        (header::ETAG, etag),
        (header::CACHE_CONTROL, "private, no-cache".to_string()),
    ];
    Ok(match fresh {
        true => (StatusCode::NOT_MODIFIED, cached).into_response(),
        false => (cached, axum::Json(policy.report_forms.open(&settings))).into_response(),
    })
}

#[cfg(test)]
mod tests {
    use axum::extract::State;
    use axum::http::{HeaderMap, StatusCode, header};
    use serde_json::{Value, json};

    use super::{
        ANSWERS_MAX, Answer, BUILT_IN, Base, DOCUMENT_MAX, FIELDS_MAX, FORMS_MAX, Field, FieldKind,
        Form, OPTIONS_MAX, REASONS, ReportForms, StoredAnswer, get_forms, validate_answers,
    };
    use crate::api::test_util::{done, mem_user, temp_state};
    use crate::api::{ApiError, Authed, Settings};

    fn defaults() -> Value {
        serde_json::to_value(ReportForms::defaults()).expect("json")
    }

    /// The first error of the defaults after `change`.
    fn wrong(change: impl FnOnce(&mut Value)) -> String {
        let mut doc = defaults();
        change(&mut doc);
        ReportForms::parse(&doc.to_string()).expect_err("refused")
    }

    fn text(id: &str) -> Value {
        json!({"id": id, "kind": "short_text", "label": "More"})
    }

    fn extra(id: &str) -> Value {
        json!({"id": id, "label": "Appeal a ban", "base": "none", "fields": [text("why")]})
    }

    fn push(doc: &mut Value, at: &str, value: Value) {
        doc.pointer_mut(at)
            .and_then(Value::as_array_mut)
            .unwrap_or_else(|| panic!("{at} is a list"))
            .push(value);
    }

    #[test]
    fn the_defaults_parse_and_pass_every_limit() {
        let forms = ReportForms::defaults();
        assert_eq!(forms.check(), Ok(()));
        assert_eq!(ReportForms::parse(&forms.stored()), Ok(forms.clone()));
        assert_eq!(
            ReportForms::from_stored(&forms.stored()),
            Some(forms.clone())
        );
        assert!(forms.stored().is_ascii());
        assert!(forms.stored().len() < DOCUMENT_MAX / 8);
        let ids: Vec<(&str, Base)> = forms
            .forms
            .iter()
            .map(|f| (f.id.as_str(), f.base))
            .collect();
        assert_eq!(ids, BUILT_IN);
        let labels: Vec<(&str, &str)> = forms
            .forms
            .iter()
            .map(|f| (f.label.as_str(), f.line.as_str()))
            .collect();
        assert_eq!(
            labels,
            [
                ("Report a user", "Someone breaking the rules."),
                ("Report a bug", "Something in the app doesn't work."),
                ("Report a server", "A server breaking the rules."),
                ("Something else", "Feedback, questions or anything else."),
                ("Report message", ""),
            ]
        );
        let fields = |id: &str| -> Vec<(String, FieldKind, bool)> {
            forms
                .find(id)
                .expect(id)
                .fields
                .iter()
                .map(|f| (f.id.clone(), f.kind, f.required))
                .collect()
        };
        let of = |list: &[(&str, FieldKind, bool)]| -> Vec<(String, FieldKind, bool)> {
            list.iter()
                .map(|(id, k, r)| (id.to_string(), *k, *r))
                .collect()
        };
        assert_eq!(
            fields("user"),
            of(&[
                ("target", FieldKind::User, true),
                ("reason", FieldKind::SingleChoice, true),
                ("place", FieldKind::Server, false),
                ("evidence", FieldKind::Message, false),
                ("details", FieldKind::LongText, false),
            ])
        );
        assert_eq!(
            fields("bug"),
            of(&[
                ("kind", FieldKind::SingleChoice, false),
                ("summary", FieldKind::ShortText, true),
                ("steps", FieldKind::LongText, false),
                ("expected", FieldKind::LongText, false),
                ("device", FieldKind::ShortText, false),
            ])
        );
        assert_eq!(
            fields("server"),
            of(&[
                ("target", FieldKind::Server, true),
                ("reason", FieldKind::SingleChoice, true),
                ("details", FieldKind::LongText, false),
            ])
        );
        assert_eq!(
            fields("general"),
            of(&[
                ("topic", FieldKind::SingleChoice, false),
                ("details", FieldKind::LongText, true),
            ])
        );
        assert_eq!(
            fields("message"),
            of(&[
                ("target", FieldKind::Message, true),
                ("reason", FieldKind::SingleChoice, true),
                ("context", FieldKind::Checkbox, false),
                ("details", FieldKind::LongText, false),
            ])
        );
        for form in &forms.forms {
            let reason = form.reason_field().expect("a reason field");
            match form.base {
                Base::User | Base::Server | Base::Message => {
                    let options: Vec<(&str, &str)> = reason
                        .options
                        .iter()
                        .map(|o| (o.id.as_str(), o.label.as_str()))
                        .collect();
                    assert_eq!(options, REASONS, "{}", form.id);
                    assert_eq!(
                        form.open_fields().len(),
                        form.fields.len() - form.base.locked().len()
                    );
                }
                Base::None => {
                    assert!(reason.reason && reason.options.iter().any(|o| o.id == "other"));
                    assert_eq!(form.open_fields().len(), form.fields.len());
                }
            }
        }
        let user = forms.find("user").expect("user");
        assert_eq!(
            user.fields[4].template.as_deref(),
            Some("What happened:\n\nWhen:\n")
        );
        assert_eq!(user.fields[4].max, Some(1000));
        let bug = forms.find("bug").expect("bug");
        assert_eq!(bug.fields[1].max, Some(120));
        assert_eq!(bug.fields[2].template.as_deref(), Some("1. \n2. \n3. "));
        assert!(
            forms
                .find("general")
                .expect("general")
                .fields
                .iter()
                .all(|f| f.template.is_none()),
            "templates only for the first two"
        );
    }

    #[test]
    fn a_document_reads_without_the_optional_parts() {
        let mut doc = defaults();
        doc.as_object_mut().expect("doc").remove("rev");
        doc["forms"][1]
            .as_object_mut()
            .expect("bug")
            .remove("enabled");
        doc["forms"][1].as_object_mut().expect("bug").remove("line");
        doc["later"] = json!({"scope": "server"});
        let forms = ReportForms::parse(&doc.to_string()).expect("parses");
        assert_eq!(forms.rev, 1);
        assert!(forms.forms[1].enabled && forms.forms[1].line.is_empty());
        push(&mut doc, "/forms", extra("appeal"));
        doc["forms"][0]["enabled"] = json!(false);
        doc["forms"][0]["fields"][1]["options"] =
            json!([{"id": "spam", "label": "Ads"}, {"id": "other", "label": "Something else"}]);
        let forms = ReportForms::parse(&doc.to_string()).expect("an edited document");
        assert_eq!(forms.forms.len(), 6);
        assert!(!forms.forms[0].enabled);
    }

    #[test]
    fn each_limit_is_refused_with_its_message() {
        let many = |n: usize| -> Vec<Value> {
            (0..n)
                .map(|i| json!({"id": format!("o{i}"), "label": "Option"}))
                .collect()
        };
        let cases: Vec<(&str, Change, &str)> = vec![
            (
                "13 categories",
                Box::new(|d| (0..8).for_each(|i| push(d, "/forms", extra(&format!("more{i}"))))),
                "At most 12 categories",
            ),
            (
                "13 fields",
                Box::new(|d| {
                    (0..8).for_each(|i| push(d, "/forms/1/fields", text(&format!("more{i}"))))
                }),
                "bug: at most 12 fields",
            ),
            (
                "21 options",
                Box::new(move |d| d["forms"][1]["fields"][0]["options"] = json!(many(21))),
                "bug.kind: 2 to 20 options",
            ),
            (
                "1 option",
                Box::new(|d| {
                    d["forms"][1]["fields"][0]["options"] = json!([{"id": "a", "label": "A"}])
                }),
                "bug.kind: 2 to 20 options",
            ),
            (
                "a bad category id",
                Box::new(|d| push(d, "/forms", extra("Appeal a ban"))),
                "Category 6 needs an id of 1 to 32 of a-z, 0-9 and _",
            ),
            (
                "a long category id",
                Box::new(|d| push(d, "/forms", extra(&"a".repeat(33)))),
                "Category 6 needs an id of 1 to 32 of a-z, 0-9 and _",
            ),
            (
                "a bad field id",
                Box::new(|d| push(d, "/forms/1/fields", text("Why?"))),
                "bug: field 6 needs an id of 1 to 32 of a-z, 0-9 and _",
            ),
            (
                "a bad option id",
                Box::new(|d| d["forms"][1]["fields"][0]["options"][1]["id"] = json!("B 1")),
                "bug.kind: option 2 needs an id of 1 to 32 of a-z, 0-9 and _",
            ),
            (
                "a duplicate category id",
                Box::new(|d| push(d, "/forms", extra("bug"))),
                "Category ids must be unique: bug",
            ),
            (
                "a duplicate field id",
                Box::new(|d| push(d, "/forms/1/fields", text("steps"))),
                "bug: field ids must be unique: steps",
            ),
            (
                "a duplicate of a locked field",
                Box::new(|d| push(d, "/forms/0/fields", text("target"))),
                "user: field ids must be unique: target",
            ),
            (
                "a duplicate option id",
                Box::new(|d| d["forms"][1]["fields"][0]["options"][1]["id"] = json!("broke")),
                "bug.kind: option ids must be unique: broke",
            ),
            (
                "a locked field removed",
                Box::new(|d| {
                    d["forms"][0]["fields"]
                        .as_array_mut()
                        .expect("fields")
                        .remove(2);
                }),
                "user: field 3 must be place",
            ),
            (
                "every field removed",
                Box::new(|d| d["forms"][2]["fields"] = json!([])),
                "server: the field target can't be removed",
            ),
            (
                "locked fields out of order",
                Box::new(|d| {
                    d["forms"][0]["fields"]
                        .as_array_mut()
                        .expect("fields")
                        .swap(0, 1)
                }),
                "user: field 1 must be target",
            ),
            (
                "a locked field retyped",
                Box::new(|d| d["forms"][0]["fields"][0]["kind"] = json!("short_text")),
                "user.target: the kind must stay user",
            ),
            (
                "a locked field made optional",
                Box::new(|d| d["forms"][0]["fields"][0]["required"] = json!(false)),
                "user.target: required must stay true",
            ),
            (
                "a locked field made required",
                Box::new(|d| d["forms"][4]["fields"][2]["required"] = json!(true)),
                "message.context: required must stay false",
            ),
            (
                "a built-in category deleted",
                Box::new(|d| {
                    d["forms"].as_array_mut().expect("forms").remove(1);
                }),
                "The category bug can't be removed",
            ),
            (
                "a built-in category on another base",
                Box::new(|d| {
                    d["forms"][3]["base"] = json!("server");
                }),
                "general: the base must stay none",
            ),
            (
                "a second message category",
                Box::new(|d| {
                    let mut copy = d["forms"][4].clone();
                    copy["id"] = json!("message2");
                    push(d, "/forms", copy);
                }),
                "message2: only the category message has the base message",
            ),
            (
                "the message category turned off",
                Box::new(|d| d["forms"][4]["enabled"] = json!(false)),
                "The category message can't be turned off",
            ),
            (
                "an unknown reason",
                Box::new(|d| d["forms"][0]["fields"][1]["options"][0]["id"] = json!("rude")),
                "user.reason: unknown reason rude",
            ),
            (
                "the reason other removed",
                Box::new(|d| {
                    d["forms"][0]["fields"][1]["options"]
                        .as_array_mut()
                        .expect("options")
                        .pop();
                }),
                "user.reason: the reason other must stay",
            ),
            (
                "two reason fields",
                Box::new(|d| {
                    let mut second = d["forms"][1]["fields"][0].clone();
                    second["id"] = json!("kind2");
                    push(d, "/forms/1/fields", second);
                }),
                "bug: only one field can be the reason",
            ),
            (
                "a reason mark on an abuse form",
                Box::new(|d| {
                    push(
                        d,
                        "/forms/2/fields",
                        json!({"id": "why", "kind": "single_choice", "label": "Why", "reason": true, "options": [{"id": "a", "label": "A"}, {"id": "b", "label": "B"}]}),
                    );
                }),
                "server.why: only a single_choice of a form of base none marks a reason",
            ),
            (
                "an empty label",
                Box::new(|d| d["forms"][1]["label"] = json!("  ")),
                "bug: the label needs 1 to 80 characters",
            ),
            (
                "a long label",
                Box::new(|d| d["forms"][1]["fields"][1]["label"] = json!("a".repeat(81))),
                "bug.summary: the label needs 1 to 80 characters",
            ),
            (
                "a long line",
                Box::new(|d| d["forms"][1]["line"] = json!("a".repeat(201))),
                "bug: the line takes up to 200 characters",
            ),
            (
                "a long help",
                Box::new(|d| d["forms"][1]["fields"][1]["help"] = json!("a".repeat(201))),
                "bug.summary: the help takes up to 200 characters",
            ),
            (
                "a long option label",
                Box::new(|d| {
                    d["forms"][1]["fields"][0]["options"][0]["label"] = json!("a".repeat(81))
                }),
                "bug.kind: option broke needs a label of up to 80 characters",
            ),
            (
                "a short text over 200",
                Box::new(|d| d["forms"][1]["fields"][1]["max"] = json!(201)),
                "bug.summary: max must be 1 to 200",
            ),
            (
                "a long text over 2,000",
                Box::new(|d| d["forms"][1]["fields"][2]["max"] = json!(2001)),
                "bug.steps: max must be 1 to 2000",
            ),
            (
                "a max of 0",
                Box::new(|d| d["forms"][1]["fields"][2]["max"] = json!(0)),
                "bug.steps: max must be 1 to 2000",
            ),
            (
                "a template over its max",
                Box::new(|d| d["forms"][1]["fields"][2]["max"] = json!(5)),
                "bug.steps: the template takes up to 5 characters",
            ),
            (
                "a template over 2,000",
                Box::new(|d| d["forms"][1]["fields"][2]["template"] = json!("a".repeat(2001))),
                "bug.steps: the template takes up to 2000 characters",
            ),
            (
                "a template on a short text",
                Box::new(|d| d["forms"][1]["fields"][1]["template"] = json!("x")),
                "bug.summary: only long_text takes a template",
            ),
            (
                "options on a text",
                Box::new(move |d| {
                    d["forms"][1]["fields"][1]["options"] =
                        json!([{"id": "a", "label": "A"}, {"id": "b", "label": "B"}])
                }),
                "bug.summary: only choice fields take options",
            ),
            (
                "a placeholder on a choice",
                Box::new(|d| d["forms"][1]["fields"][0]["placeholder"] = json!("x")),
                "bug.kind: only text fields take a placeholder",
            ),
            (
                "min on a text",
                Box::new(|d| d["forms"][1]["fields"][1]["min"] = json!(1)),
                "bug.summary: only multiple_choice takes min",
            ),
            (
                "max on a checkbox",
                Box::new(|d| d["forms"][4]["fields"][2]["max"] = json!(1)),
                "message.context: this kind takes no max",
            ),
            (
                "a multiple choice that wants more than it has",
                Box::new(|d| {
                    push(
                        d,
                        "/forms/1/fields",
                        json!({"id": "where", "kind": "multiple_choice", "label": "Where", "min": 3, "options": [{"id": "a", "label": "A"}, {"id": "b", "label": "B"}]}),
                    );
                }),
                "bug.where: min and max must fit its 2 options",
            ),
            (
                "a control character in a label",
                Box::new(|d| d["forms"][1]["label"] = json!("Bug\nreport")),
                "bug: the label needs 1 to 80 characters",
            ),
            (
                "a negative rev",
                Box::new(|d| d["rev"] = json!(-1)),
                "rev can't be negative",
            ),
        ];
        for (what, change, message) in cases {
            let got = wrong(change);
            assert_eq!(got, message, "{what}");
            assert!(got.is_ascii(), "{what}");
        }
        let long = || json!({"id": "x", "kind": "long_text", "label": "More", "template": "a".repeat(2000)});
        let big = wrong(|d| {
            for i in 0..7 {
                let mut form = extra(&format!("more{i}"));
                form["fields"] = json!(
                    (0..12)
                        .map(|n| {
                            let mut field = long();
                            field["id"] = json!(format!("f{n}"));
                            field
                        })
                        .collect::<Vec<_>>()
                );
                push(d, "/forms", form);
            }
        });
        assert_eq!(big, "The forms take more than 64 KiB");
        assert_eq!(
            ReportForms::parse(&" ".repeat(1024 * 1024 + 1)).expect_err("a huge file"),
            "The forms take more than 64 KiB"
        );
        assert!(
            ReportForms::parse("{\"forms\": 3}")
                .expect_err("not a list")
                .starts_with("not a forms document: ")
        );
        assert_eq!(
            (FORMS_MAX, FIELDS_MAX, OPTIONS_MAX, DOCUMENT_MAX),
            (12, 12, 20, 65536)
        );

        let mut full = defaults();
        (0..7).for_each(|i| push(&mut full, "/forms", extra(&format!("more{i}"))));
        (0..7).for_each(|i| push(&mut full, "/forms/1/fields", text(&format!("more{i}"))));
        full["forms"][1]["fields"][0]["options"] = json!(many(20));
        full["forms"][1]["fields"][0]["options"][0]["id"] = json!("a".repeat(32));
        assert!(
            ReportForms::parse(&full.to_string()).is_ok(),
            "exactly at the limits"
        );
    }

    type Change = Box<dyn FnOnce(&mut Value)>;

    fn answers(list: Value) -> Vec<Answer> {
        list.as_array()
            .expect("list")
            .iter()
            .map(|a| Answer {
                id: a["id"].as_str().expect("id").to_string(),
                value: a["value"].clone(),
            })
            .collect()
    }

    fn refusal(forms: &ReportForms, form: &str, list: Value) -> String {
        match validate_answers(forms, form, &answers(list)) {
            Err(ApiError(StatusCode::BAD_REQUEST, message, _)) => message,
            Err(ApiError(status, message, _)) => panic!("{status} {message}"),
            Ok(kept) => panic!("accepted: {kept:?}"),
        }
    }

    /// The defaults plus a form with one field of each kind.
    fn with_every_kind() -> ReportForms {
        let mut doc = defaults();
        let options = json!([{"id": "a", "label": "Apple"}, {"id": "b", "label": "Banana"}, {"id": "c", "label": "Cherry"}]);
        push(
            &mut doc,
            "/forms",
            json!({"id": "all", "label": "Everything", "base": "none", "fields": [
                {"id": "short", "kind": "short_text", "label": "Short", "max": 5},
                {"id": "long", "kind": "long_text", "label": "Long", "template": "When:\n", "max": 20},
                {"id": "one", "kind": "single_choice", "label": "One", "options": options},
                {"id": "many", "kind": "multiple_choice", "label": "Many", "min": 2, "max": 2, "options": options},
                {"id": "sure", "kind": "checkbox", "label": "I am sure", "required": true},
                {"id": "who", "kind": "user", "label": "Who"},
                {"id": "where", "kind": "server", "label": "Where"},
                {"id": "what", "kind": "message", "label": "What"},
            ]}),
        );
        ReportForms::parse(&doc.to_string()).expect("forms")
    }

    #[test]
    fn answers_follow_the_form() {
        let forms = with_every_kind();
        let kept = validate_answers(
            &forms,
            "all",
            &answers(json!([
                {"id": "what", "value": {"message_id": 7, "extra": 1}},
                {"id": "where", "value": {"server": "lobby"}},
                {"id": "who", "value": {"username": "bob"}},
                {"id": "sure", "value": true},
                {"id": "many", "value": ["c", "a"]},
                {"id": "one", "value": "b"},
                {"id": "long", "value": "When:\nnow"},
                {"id": "short", "value": "hello"},
            ])),
        )
        .expect("every kind");
        let stored =
            |id: &str, label: &str, kind: FieldKind, value: Value, shown: Option<&[&str]>| {
                StoredAnswer {
                    id: id.to_string(),
                    label: label.to_string(),
                    kind,
                    value,
                    shown: shown.map(|s| s.iter().map(|l| l.to_string()).collect()),
                }
            };
        assert_eq!(
            kept,
            [
                stored("short", "Short", FieldKind::ShortText, json!("hello"), None),
                stored(
                    "long",
                    "Long",
                    FieldKind::LongText,
                    json!("When:\nnow"),
                    None
                ),
                stored(
                    "one",
                    "One",
                    FieldKind::SingleChoice,
                    json!("b"),
                    Some(&["Banana"])
                ),
                stored(
                    "many",
                    "Many",
                    FieldKind::MultipleChoice,
                    json!(["c", "a"]),
                    Some(&["Cherry", "Apple"])
                ),
                stored("sure", "I am sure", FieldKind::Checkbox, json!(true), None),
                stored(
                    "who",
                    "Who",
                    FieldKind::User,
                    json!({"username": "bob"}),
                    None
                ),
                stored(
                    "where",
                    "Where",
                    FieldKind::Server,
                    json!({"server": "lobby"}),
                    None
                ),
                stored(
                    "what",
                    "What",
                    FieldKind::Message,
                    json!({"message_id": 7}),
                    None
                ),
            ],
            "in form order, with the labels at report time"
        );
        assert_eq!(
            serde_json::to_value(&kept[..3]).expect("json"),
            json!([
                {"id": "short", "label": "Short", "kind": "short_text", "value": "hello"},
                {"id": "long", "label": "Long", "kind": "long_text", "value": "When:\nnow"},
                {"id": "one", "label": "One", "kind": "single_choice", "value": "b", "shown": ["Banana"]},
            ])
        );

        let only = validate_answers(
            &forms,
            "all",
            &answers(json!([
                {"id": "sure", "value": true},
                {"id": "short", "value": "  "},
                {"id": "long", "value": " When: "},
                {"id": "one", "value": ""},
                {"id": "many", "value": []},
                {"id": "who", "value": null},
                {"id": "where", "value": null},
                {"id": "what", "value": null},
            ])),
        )
        .expect("empty optional answers");
        assert_eq!(
            only.len(),
            1,
            "empty answers and an untouched template are left out"
        );
        let breaks = validate_answers(
            &forms,
            "all",
            &answers(json!([
                {"id": "sure", "value": true},
                {"id": "long", "value": "When:\r\nnow\rlater\tthen"},
            ])),
        )
        .expect("other line breaks");
        assert_eq!(
            breaks[0].value,
            json!("When:\nnow\nlater\tthen"),
            "CR LF and CR are kept as LF, and counted after"
        );
        let untouched = validate_answers(
            &forms,
            "all",
            &answers(json!([
                {"id": "sure", "value": true},
                {"id": "long", "value": "When:\r\n"},
            ])),
        )
        .expect("the template with CR LF");
        assert_eq!(untouched.len(), 1, "still the untouched template");

        let sure = json!({"id": "sure", "value": true});
        for (list, message) in [
            (json!([]), "Missing required field: sure"),
            (
                json!([{"id": "sure", "value": false}]),
                "Missing required field: sure",
            ),
            (json!([sure, {"id": "nope", "value": "x"}]), "Unknown field"),
            (json!([sure, sure]), "Field answered twice"),
            (
                json!([sure, {"id": "short", "value": "sixsix"}]),
                "Answer too long",
            ),
            (
                json!([sure, {"id": "short", "value": "a\nb"}]),
                "Answer has invalid characters",
            ),
            (
                json!([sure, {"id": "short", "value": "a\u{7}b"}]),
                "Answer has invalid characters",
            ),
            (
                json!([sure, {"id": "long", "value": "a\u{0}b"}]),
                "Answer has invalid characters",
            ),
            (
                json!([sure, {"id": "long", "value": "a".repeat(21)}]),
                "Answer too long",
            ),
            (
                json!([sure, {"id": "short", "value": 5}]),
                "Answer of the wrong kind",
            ),
            (json!([sure, {"id": "one", "value": "z"}]), "Unknown option"),
            (
                json!([sure, {"id": "one", "value": ["a"]}]),
                "Answer of the wrong kind",
            ),
            (
                json!([sure, {"id": "many", "value": ["a"]}]),
                "Too few options picked",
            ),
            (
                json!([sure, {"id": "many", "value": ["a", "b", "c"]}]),
                "Too many options picked",
            ),
            (
                json!([sure, {"id": "many", "value": ["a", "a"]}]),
                "Option picked twice",
            ),
            (
                json!([sure, {"id": "many", "value": ["a", "z"]}]),
                "Unknown option",
            ),
            (
                json!([sure, {"id": "many", "value": "a"}]),
                "Answer of the wrong kind",
            ),
            (
                json!([{"id": "sure", "value": "yes"}]),
                "Answer of the wrong kind",
            ),
            (
                json!([sure, {"id": "who", "value": "bob"}]),
                "Answer of the wrong kind",
            ),
            (
                json!([sure, {"id": "who", "value": {"username": ""}}]),
                "Answer of the wrong kind",
            ),
            (
                json!([sure, {"id": "who", "value": {"username": "a".repeat(101)}}]),
                "Answer of the wrong kind",
            ),
            (
                json!([sure, {"id": "where", "value": {"username": "bob"}}]),
                "Answer of the wrong kind",
            ),
            (
                json!([sure, {"id": "what", "value": {"message_id": 0}}]),
                "Answer of the wrong kind",
            ),
            (
                json!([sure, {"id": "what", "value": {"message_id": "7"}}]),
                "Answer of the wrong kind",
            ),
        ] {
            assert_eq!(refusal(&forms, "all", list.clone()), message, "{list}");
        }
        assert_eq!(refusal(&forms, "nope", json!([])), "Unknown form");
        let big = "a".repeat(ANSWERS_MAX);
        assert_eq!(
            refusal(&forms, "all", json!([sure, {"id": "long", "value": big}])),
            "Answers too long"
        );
    }

    #[test]
    fn the_answers_of_the_default_forms() {
        let forms = ReportForms::defaults();
        let bug = validate_answers(
            &forms,
            "bug",
            &answers(json!([
                {"id": "kind", "value": "exploded"},
                {"id": "summary", "value": "The page is blank"},
                {"id": "steps", "value": "1. \n2. \n3. "},
            ])),
        )
        .expect("a bug");
        assert_eq!(bug.len(), 2);
        assert_eq!(
            (bug[0].value.clone(), bug[0].shown.clone()),
            (json!("other"), Some(vec!["Other".to_string()])),
            "an unknown option of the reason field becomes other"
        );
        assert_eq!(
            refusal(&forms, "bug", json!([])),
            "Missing required field: summary"
        );
        assert_eq!(
            refusal(
                &forms,
                "bug",
                json!([{"id": "summary", "value": "a".repeat(121)}])
            ),
            "Answer too long"
        );
        let user = validate_answers(
            &forms,
            "user",
            &answers(json!([
                {"id": "evidence", "value": {"message_id": 12}},
                {"id": "details", "value": "What happened:\nspam\n\nWhen:\ntoday"},
            ])),
        )
        .expect("a user report");
        assert_eq!(user.len(), 2);
        for locked in ["target", "reason", "place"] {
            assert_eq!(
                refusal(&forms, "user", json!([{"id": locked, "value": "x"}])),
                "Unknown field",
                "{locked} comes with the report itself"
            );
        }
        assert_eq!(
            validate_answers(&forms, "user", &[]).expect("no answers"),
            []
        );
        assert_eq!(
            validate_answers(&forms, "message", &[]).expect("no answers"),
            []
        );
        assert_eq!(
            refusal(&forms, "general", json!([])),
            "Missing required field: details"
        );

        let mut off = forms.clone();
        off.forms[1].enabled = false;
        assert_eq!(
            refusal(&off, "bug", json!([{"id": "summary", "value": "x"}])),
            "Unknown form",
            "a category that is turned off takes no reports"
        );
    }

    fn if_none_match(etag: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::IF_NONE_MATCH, etag.parse().expect("header"));
        headers
    }

    async fn read(
        state: &crate::state::AppState,
        headers: HeaderMap,
    ) -> (StatusCode, Option<String>, Value) {
        let res = get_forms(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            headers,
        )
        .await
        .expect("forms");
        let etag = res
            .headers()
            .get(header::ETAG)
            .map(|v| v.to_str().expect("etag").to_string());
        let status = res.status();
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .expect("body");
        let body = match body.is_empty() {
            true => Value::Null,
            false => serde_json::from_slice(&body).expect("json"),
        };
        (status, etag, body)
    }

    async fn switch(state: &crate::state::AppState, key: &str, on: bool) {
        sqlx::query("UPDATE settings SET value = $1 WHERE key = $2")
            .bind(match on {
                true => "1",
                false => "0",
            })
            .bind(key)
            .execute(&state.db)
            .await
            .expect("switch");
        Settings::forget(&state.db);
    }

    #[tokio::test]
    async fn the_public_read_follows_the_switches_and_answers_304() {
        let (state, path) = temp_state("report_forms_read").await;
        let stored: String =
            sqlx::query_scalar("SELECT value FROM settings WHERE key = 'report_forms'")
                .fetch_one(&state.db)
                .await
                .expect("a fresh database holds the default forms");
        assert_eq!(stored, ReportForms::defaults().stored());

        let ids = |body: &Value| -> Vec<String> {
            body["forms"]
                .as_array()
                .expect("forms")
                .iter()
                .map(|f| f["id"].as_str().expect("id").to_string())
                .collect()
        };
        let (status, etag, body) = read(&state, HeaderMap::new()).await;
        assert_eq!((status, etag.as_deref()), (StatusCode::OK, Some("\"1\"")));
        assert_eq!(body, defaults());
        assert_eq!(ids(&body), ["user", "bug", "server", "general", "message"]);
        for held in ["\"1\"", "W/\"1\"", "\"0\", \"1\""] {
            let (status, etag, body) = read(&state, if_none_match(held)).await;
            assert_eq!(
                (status, etag.as_deref(), body),
                (StatusCode::NOT_MODIFIED, Some("\"1\""), Value::Null),
                "{held}"
            );
        }
        let (status, _, body) = read(&state, if_none_match("\"0\"")).await;
        assert_eq!((status, ids(&body).len()), (StatusCode::OK, 5));

        switch(&state, "instance_reports", false).await;
        let (status, etag, body) = read(&state, if_none_match("\"1\"")).await;
        assert_eq!(
            (status, etag.as_deref()),
            (StatusCode::OK, Some("\"1-server\""))
        );
        assert_eq!(
            ids(&body),
            ["user", "message"],
            "a category whose only route is off is gone"
        );
        switch(&state, "server_reports", false).await;
        let (_, etag, body) = read(&state, HeaderMap::new()).await;
        assert_eq!((etag.as_deref(), ids(&body).len()), (Some("\"1-off\""), 0));
        switch(&state, "instance_reports", true).await;
        let (_, etag, body) = read(&state, HeaderMap::new()).await;
        assert_eq!(
            (etag.as_deref(), ids(&body).len()),
            (Some("\"1-instance\""), 5)
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn guests_and_unauthenticated_callers_get_401() {
        use crate::config::{AppConfig, Roles};
        use crate::server::client_ip::ProxyTrust;
        use crate::server::route_builder::{api_router, resolve_versions};
        let (state, path) = temp_state("report_forms_401").await;
        let req: crate::api::auth::RegisterReq = serde_json::from_value(
            json!({"username": "alice", "password": "a", "avatar_kind": "identicon"}),
        )
        .expect("register req");
        let token = crate::api::auth::register(State(state.clone()), axum::Json(req))
            .await
            .expect("register")
            .0
            .token;
        let config = AppConfig {
            roles: Roles {
                web: false,
                ..Roles::ALL
            },
            proxy_trust: ProxyTrust::Any,
            ..AppConfig::defaults()
        };
        let app = resolve_versions(api_router(&config, state.clone()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let url = format!(
            "http://{}/api/v1/report_forms",
            listener.local_addr().expect("addr")
        );
        let server = tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await;
        });
        let client = reqwest::Client::new();
        let get = || client.get(&url).header("x-forwarded-for", "10.0.0.1");
        for (who, req) in [
            ("nobody", get()),
            ("a guest", get().header("x-guest-grant", "a".repeat(64))),
            ("a bad token", get().bearer_auth("nope")),
        ] {
            let res = req.send().await.expect("send");
            assert_eq!(res.status(), StatusCode::UNAUTHORIZED, "{who}");
            assert_eq!(
                serde_json::from_str::<Value>(&res.text().await.expect("body")).expect("json"),
                json!({"error": "Unauthorized"}),
                "{who}"
            );
        }
        let res = get().bearer_auth(&token).send().await.expect("send");
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers()[header::ETAG], "\"1\"");
        assert_eq!(res.headers()[header::CACHE_CONTROL], "private, no-cache");
        assert_eq!(
            serde_json::from_str::<Value>(&res.text().await.expect("body")).expect("json"),
            defaults()
        );
        let res = get()
            .bearer_auth(&token)
            .header(header::IF_NONE_MATCH, "\"1\"")
            .send()
            .await
            .expect("send");
        assert_eq!(res.status(), StatusCode::NOT_MODIFIED);
        assert!(res.bytes().await.expect("body").is_empty());
        server.abort();
        done(state, path).await;
    }

    #[test]
    fn fields_serialize_without_what_they_do_not_use() {
        let field: Field = serde_json::from_value(text("why")).expect("field");
        assert_eq!(
            serde_json::to_value(&field).expect("json"),
            json!({"id": "why", "kind": "short_text", "label": "More", "required": false})
        );
        let form: Form = serde_json::from_value(extra("appeal")).expect("form");
        assert_eq!(
            serde_json::to_value(&form).expect("json")["enabled"],
            json!(true)
        );
    }
}
