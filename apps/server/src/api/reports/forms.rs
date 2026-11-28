use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};

use super::invalid;
use crate::api::policy::Policy;
use crate::api::{ApiError, Authed, NAME_MAX, Settings};
use crate::state::AppState;
use rchat_reports::forms::Refused;
pub use rchat_reports::forms::{
    ANSWERS_MAX, Answer, BUILT_IN, Base, Choice, DOCUMENT_MAX, FIELDS_MAX, FORMS_MAX, Field,
    FieldKind, Form, HELP_MAX, ID_MAX, LABEL_MAX, LINE_MAX, LONG_MAX, OPTIONS_MAX, OTHER, REASONS,
    ReportForms, SHORT_MAX, StoredAnswer, Switches,
};

/// The `settings` row that holds the forms, and the control's key.
pub const KEY: &str = rchat_settings::items::REPORT_FORMS_FILE.key();
/// The env name of the file that sets the forms.
pub const ENV: &str = rchat_settings::items::REPORT_FORMS_FILE.env();

/// The report switches of `settings`.
pub fn switches(settings: &Settings) -> Switches {
    Switches {
        server_reports: settings.server_reports,
        instance_reports: settings.instance_reports,
    }
}

/// Checks the answers of a report against the category `form` of `forms` and gives them as the
/// report keeps them (`rchat_reports::forms::validate_answers`). Every refusal is a 400.
pub fn validate_answers(
    forms: &ReportForms,
    form: &str,
    answers: &[Answer],
) -> Result<Vec<StoredAnswer>, ApiError> {
    rchat_reports::forms::validate_answers(forms, form, answers, NAME_MAX)
        .map_err(|Refused { part, msg }| invalid(part.as_str(), &msg))
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
#[utoipa::path(get, path = "/api/v1/report_forms", tag = "Reports", params(("If-None-Match" = Option<String>, Header, description = "The `ETag` of the copy you hold")), responses((status = 200, description = "The forms, with their `ETag`", body = ReportForms, headers(("ETag" = String, description = "Changes when the forms or the report switches change"))), (status = 304, description = "Your copy is current"), (status = 401, description = "Missing or invalid token, or a guest", body = crate::api::ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", body = crate::api::ApiErrorBody)))]
pub(crate) async fn get_forms(
    State(state): State<AppState>,
    Authed(_user): Authed,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let settings = Settings::cached(&state.db).await;
    let policy = Policy::cached(&state.db).await;
    let on = switches(&settings);
    let etag = policy.report_forms.etag(on);
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
        false => (cached, axum::Json(policy.report_forms.open(on))).into_response(),
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
                "the reason other of a marked field removed",
                Box::new(|d| {
                    d["forms"][1]["fields"][0]["options"]
                        .as_array_mut()
                        .expect("options")
                        .pop();
                }),
                "bug.kind: the reason other must stay",
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
        full["forms"][1]["fields"][0]["options"][19]["id"] = json!("other");
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
        let mut doc = defaults();
        let options = json!([{"id": "a", "label": "Apple"}, {"id": "other", "label": "Other"}]);
        push(
            &mut doc,
            "/forms",
            json!({"id": "appeal", "label": "Appeal", "base": "none", "fields": [
                {"id": "reason", "kind": "single_choice", "label": "Reason", "options": options},
                {"id": "pick", "kind": "single_choice", "label": "Pick", "options": options},
            ]}),
        );
        let unmarked = ReportForms::parse(&doc.to_string()).expect("forms");
        assert!(
            unmarked
                .find("appeal")
                .is_some_and(|f| f.reason_field().is_none())
        );
        for id in ["reason", "pick"] {
            assert_eq!(
                refusal(&unmarked, "appeal", json!([{"id": id, "value": "zzz"}])),
                "Unknown option",
                "{id} is not the form's reason field"
            );
        }
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
