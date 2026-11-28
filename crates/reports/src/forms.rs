use serde::{Deserialize, Serialize};
use serde_json::Value;

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
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(utoipa::ToSchema))]
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
    fn open(self, on: Switches) -> bool {
        match self {
            Base::User | Base::Message => on.server_reports || on.instance_reports,
            Base::Server | Base::None => on.instance_reports,
        }
    }
}

/// How a field of a report form is asked and answered.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(utoipa::ToSchema))]
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
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(utoipa::ToSchema))]
pub struct Choice {
    /// 1 to 32 of a-z, 0-9 and `_`, unique in its field. This is what an answer carries.
    pub id: String,
    /// The text shown, up to 80 characters.
    pub label: String,
}

/// One field of a report form.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(utoipa::ToSchema))]
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
    /// field per form, and it offers the option `other`: an answer it doesn't offer counts as
    /// `other`.
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
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(utoipa::ToSchema))]
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
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(utoipa::ToSchema))]
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
            if *reason && !options.iter().any(|o| o.id == OTHER) {
                return Err(format!("{at}: the reason {OTHER} must stay"));
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
    /// can go out under the report switches `on`.
    pub fn open(&self, on: Switches) -> ReportForms {
        ReportForms {
            rev: self.rev,
            forms: self
                .forms
                .iter()
                .filter(|f| f.enabled && f.base.open(on))
                .cloned()
                .collect(),
        }
    }

    /// The `ETag` of `open`: the revision, and which report switches are off.
    pub fn etag(&self, on: Switches) -> String {
        match (on.server_reports, on.instance_reports) {
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
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[cfg_attr(feature = "schema", derive(utoipa::ToSchema))]
pub struct Answer {
    /// The field's id.
    pub id: String,
    /// A string for text fields and a single choice, a list of option ids for a multiple
    /// choice, `true` or `false` for a checkbox, `{"username": ...}`, `{"server": ...}` or
    /// `{"message_id": ...}` for a reference.
    pub value: Value,
}

/// An answer as a report keeps it, with the field's label and the labels of the chosen options
/// at report time, so later changes of the form never change what an old report says.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(utoipa::ToSchema))]
pub struct StoredAnswer {
    /// The field's id.
    pub id: String,
    /// The field's label when the report was sent.
    pub label: String,
    /// The field's kind.
    pub kind: FieldKind,
    /// The answer: a string for text fields and a single choice, a list of option ids for a
    /// multiple choice, `true` for a checkbox, and for a reference the names it had:
    /// `{"username", "display_name"}`, `{"server", "display_name"}` or
    /// `{"message_id", "author"}`. `{"deleted": true}` stands for an account deleted since.
    pub value: Value,
    /// For choices: the labels of the chosen options when the report was sent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shown: Option<Vec<String>>,
}

/// An answer's stored value and, for choices, the labels of the chosen options.
type Kept = (Value, Option<Vec<String>>);

/// What the answer `value` to `field` is stored as, `None` when it is no answer (empty text, a
/// text still equal to its template, no option, an unticked box). A reference names an account
/// or a server of up to `name_max` characters.
fn stored_answer(field: &Field, value: &Value, name_max: usize) -> Result<Option<Kept>, Refused> {
    let refused = Refused::answers;
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
            match (
                label_of(id),
                field.reason.then(|| label_of(OTHER)).flatten(),
            ) {
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
                    if name.is_empty() || name.chars().count() > name_max {
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
/// and context carry those. A reference names an account or a server of up to `name_max`
/// characters; whether the caller may see what it names is not checked here.
pub fn validate_answers(
    forms: &ReportForms,
    form: &str,
    answers: &[Answer],
    name_max: usize,
) -> Result<Vec<StoredAnswer>, Refused> {
    let refused = Refused::answers;
    let form = forms.find(form).filter(|f| f.enabled).ok_or(Refused {
        part: Part::Form,
        msg: "Unknown form".to_string(),
    })?;
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
            Some(answer) => stored_answer(field, &answer.value, name_max)?,
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

/// The two report switches of the instance: reports to a server's moderators, and reports to
/// the instance.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Switches {
    pub server_reports: bool,
    pub instance_reports: bool,
}

/// The part of a report a refusal is about.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Part {
    /// The category: unknown, or turned off.
    Form,
    /// The answers to its fields.
    Answers,
}

impl Part {
    pub fn as_str(self) -> &'static str {
        match self {
            Part::Form => "form",
            Part::Answers => "answers",
        }
    }
}

/// Why the answers of a report were refused, as plain ASCII.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refused {
    pub part: Part,
    pub msg: String,
}

impl Refused {
    fn answers(msg: &str) -> Refused {
        Refused {
            part: Part::Answers,
            msg: msg.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{Answer, BUILT_IN, Part, Refused, ReportForms, Switches, validate_answers};

    fn answer(id: &str, value: serde_json::Value) -> Answer {
        Answer {
            id: id.to_string(),
            value,
        }
    }

    #[test]
    fn the_defaults_hold_every_built_in_category() {
        let forms = ReportForms::defaults();
        assert_eq!(forms.check(), Ok(()));
        for (id, base) in BUILT_IN {
            assert_eq!(forms.find(id).map(|f| f.base), Some(base));
        }
        assert_eq!(ReportForms::from_stored(&forms.stored()), Some(forms));
    }

    #[test]
    fn the_switches_decide_what_is_open() {
        let forms = ReportForms::defaults();
        let ids = |on: Switches| -> Vec<String> {
            forms.open(on).forms.into_iter().map(|f| f.id).collect()
        };
        let both = Switches {
            server_reports: true,
            instance_reports: true,
        };
        let server = Switches {
            instance_reports: false,
            ..both
        };
        assert_eq!(ids(both).len(), 5);
        assert_eq!(ids(server), vec!["user", "message"]);
        assert_eq!(forms.etag(server), "\"1-server\"");
    }

    #[test]
    fn refusals_say_what_is_wrong() {
        let forms = ReportForms::defaults();
        let refused = |form: &str, answers: &[Answer]| validate_answers(&forms, form, answers, 4);
        assert_eq!(
            refused("nope", &[]),
            Err(Refused {
                part: Part::Form,
                msg: "Unknown form".to_string()
            })
        );
        assert_eq!(
            refused("user", &[answer("details", json!(5))]),
            Err(Refused {
                part: Part::Answers,
                msg: "Answer of the wrong kind".to_string()
            })
        );
        assert_eq!(
            refused("user", &[answer("evidence", json!({"message_id": 3}))]).map(|k| k.len()),
            Ok(1)
        );
        let server = |name: &str| {
            refused(
                "bug",
                &[answer("summary", json!("x")), answer("kind", json!(name))],
            )
        };
        assert_eq!(
            server("looks").map(|k| k[0].value.clone()),
            Ok(json!("looks"))
        );
        assert_eq!(
            server("gone").map(|k| k[0].value.clone()),
            Ok(json!("other"))
        );
    }
}
