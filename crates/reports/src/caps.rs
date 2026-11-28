use serde::Deserialize;

pub const DAY: i64 = 86400;
pub const WEEK: i64 = 7 * DAY;

/// The caps on one account's reports of one kind. 0 means no cap.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
pub struct Caps {
    /// Seconds before the same target can be reported again.
    pub same_target_secs: i64,
    /// Different targets per 24 hours.
    pub targets_per_day: i64,
    /// Reports about someone or something per 7 days.
    pub per_week: i64,
    /// Reports without a target (bugs, feedback) per 7 days, counted apart from the others.
    pub feedback_per_week: i64,
}

/// What a new report counts against: the caps on reports about someone or something, or the
/// cap on reports without a target.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Class<'a> {
    Abuse { target_key: &'a str },
    Feedback,
}

/// One report the same account sent earlier, of the same kind: what it was about (`None` for a
/// report without a target) and when it was sent. Copies an escalation makes are not sent ones.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Sent<'a> {
    pub target_key: Option<&'a str>,
    pub at: i64,
}

/// Whether one more report of `class` may go out at `t`, after the reports in `sent`.
pub fn allowed(sent: &[Sent], class: Class, caps: Caps, t: i64) -> bool {
    let Caps {
        same_target_secs,
        targets_per_day,
        per_week,
        feedback_per_week,
    } = caps;
    let since = |secs: i64| sent.iter().filter(move |s| s.at > t - secs);
    match class {
        Class::Feedback => {
            feedback_per_week == 0
                || (since(WEEK).filter(|s| s.target_key.is_none()).count() as i64)
                    < feedback_per_week
        }
        Class::Abuse { target_key } => {
            let about = |secs: i64| since(secs).filter_map(|s| s.target_key);
            if same_target_secs > 0 && about(same_target_secs).any(|k| k == target_key) {
                return false;
            }
            if targets_per_day > 0 {
                let mut targets: Vec<&str> = about(DAY).collect();
                let this = targets.contains(&target_key);
                targets.sort_unstable();
                targets.dedup();
                if !this && targets.len() as i64 >= targets_per_day {
                    return false;
                }
            }
            per_week == 0 || (about(WEEK).count() as i64) < per_week
        }
    }
}

/// One case of `assets/report_cap_cases.json`: the caps, the reports sent before, the new
/// report and whether it may go out. Times are seconds before `t`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Case {
    pub name: String,
    pub caps: Caps,
    pub t: i64,
    pub sent: Vec<CaseSent>,
    /// The new report's target, or none for a report without one.
    pub target: Option<String>,
    pub allowed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct CaseSent {
    pub target: Option<String>,
    pub ago: i64,
}

impl Case {
    pub fn sent(&self) -> Vec<Sent<'_>> {
        self.sent
            .iter()
            .map(|s| Sent {
                target_key: s.target.as_deref(),
                at: self.t - s.ago,
            })
            .collect()
    }

    pub fn class(&self) -> Class<'_> {
        match &self.target {
            Some(target_key) => Class::Abuse { target_key },
            None => Class::Feedback,
        }
    }
}

/// The cases, as `assets/report_cap_cases.json` holds them.
pub fn cases(json: &str) -> Result<Vec<Case>, String> {
    serde_json::from_str(json).map_err(|e| format!("not a case list: {e}"))
}

#[cfg(test)]
mod tests {
    use super::{allowed, cases};

    const CASES: &str = include_str!("../../../assets/report_cap_cases.json");

    #[test]
    fn the_cases_hold() {
        let all = cases(CASES).expect("cases");
        assert!(all.len() >= 10);
        for case in &all {
            assert_eq!(
                allowed(&case.sent(), case.class(), case.caps, case.t),
                case.allowed,
                "{}",
                case.name
            );
        }
    }
}
