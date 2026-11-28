//! The shared report rules for the client. Documents and answers cross as JSON text.

use rchat_reports::caps::{self, Caps, Class, Sent};
use rchat_reports::context;
use rchat_reports::forms::{self, Answer, Refused, ReportForms};
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn reports_default_forms() -> String {
    ReportForms::defaults().stored()
}

/// `{"ok": [answers as kept]}`, or `{"refused": {"part", "msg"}}`.
#[wasm_bindgen]
pub fn reports_validate(forms: &str, form: &str, answers: &str, name_max: u32) -> String {
    let refused = |part: &str, msg: &str| json!({"refused": {"part": part, "msg": msg}});
    let answers: Result<Vec<Answer>, _> = serde_json::from_str(answers);
    let out = match (ReportForms::from_stored(forms), answers) {
        (None, _) => refused("form", "Unknown form"),
        (_, Err(_)) => refused("answers", "Answer of the wrong kind"),
        (Some(forms), Ok(answers)) => {
            match forms::validate_answers(&forms, form, &answers, name_max as usize) {
                Ok(kept) => json!({ "ok": kept }),
                Err(Refused { part, msg }) => refused(part.as_str(), &msg),
            }
        }
    };
    out.to_string()
}

/// `sent` is a JSON list of `{"target": key or null, "at": seconds}`; `target` is the new
/// report's target key, none for a report without one.
#[wasm_bindgen]
pub fn reports_allowed(
    sent: &str,
    target: Option<String>,
    same_target_secs: f64,
    targets_per_day: f64,
    per_week: f64,
    feedback_per_week: f64,
    t: f64,
) -> bool {
    let Ok(Value::Array(list)) = serde_json::from_str::<Value>(sent) else {
        return false;
    };
    let sent: Vec<Sent> = list
        .iter()
        .map(|s| Sent {
            target_key: s.get("target").and_then(Value::as_str),
            at: s.get("at").and_then(Value::as_f64).unwrap_or(0.0) as i64,
        })
        .collect();
    let class = match &target {
        Some(target_key) => Class::Abuse { target_key },
        None => Class::Feedback,
    };
    let caps = Caps {
        same_target_secs: same_target_secs as i64,
        targets_per_day: targets_per_day as i64,
        per_week: per_week as i64,
        feedback_per_week: feedback_per_week as i64,
    };
    caps::allowed(&sent, class, caps, t as i64)
}

/// Of the messages held (their order keys, in any order), the ones a report about the message
/// with key `reported` takes along, oldest first.
#[wasm_bindgen]
pub fn reports_context(held: &[f64], reported: f64, count: u8) -> Vec<f64> {
    let held: Vec<i64> = held.iter().map(|x| *x as i64).collect();
    context::pick(&held, reported as i64, count)
        .into_iter()
        .map(|x| x as f64)
        .collect()
}
