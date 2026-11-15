use sqlx::{AnyConnection, Row};

use super::ReportKind;
use crate::api::ApiError;
use crate::limits::Limits;

const DAY: i64 = 86400;
const WEEK: i64 = 7 * DAY;

/// The caps on one account's reports of one kind. 0 means no cap.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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

impl Caps {
    pub fn of(limits: &Limits) -> Caps {
        Caps {
            same_target_secs: i64::from(limits.report_same_target_hours) * 3600,
            targets_per_day: i64::from(limits.report_targets_per_day),
            per_week: i64::from(limits.report_max_per_week),
            feedback_per_week: i64::from(limits.report_feedback_per_week),
        }
    }
}

/// What a new report counts against: the caps on reports about someone or something, or the
/// cap on reports without a target.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Class<'a> {
    Abuse { target_key: &'a str },
    Feedback,
}

/// Whether `reporter` may send one more report of `kind` at `t`. Only their own reports of that
/// kind count, never the copies an escalation makes. Run it inside the transaction that inserts
/// the report, after the pace row of the reporter is written, so reports sent at once are
/// counted one after the other.
pub(crate) async fn allowed(
    conn: &mut AnyConnection,
    reporter: &str,
    kind: ReportKind,
    class: Class<'_>,
    caps: Caps,
    t: i64,
) -> Result<bool, ApiError> {
    const MINE: &str = "reporter = $1 AND kind = $2 AND escalated_from IS NULL";
    let Caps {
        same_target_secs,
        targets_per_day,
        per_week,
        feedback_per_week,
    } = caps;
    let count = |sql: String| sqlx::query(sqlx::AssertSqlSafe(sql));
    match class {
        Class::Feedback => {
            if feedback_per_week == 0 {
                return Ok(true);
            }
            let sent: i64 = count(format!(
                "SELECT COUNT(*) FROM reports WHERE {MINE} AND target_kind = 'none' AND created_at > $3"
            ))
            .bind(reporter)
            .bind(kind.as_str())
            .bind(t - WEEK)
            .fetch_one(&mut *conn)
            .await?
            .try_get(0)?;
            Ok(sent < feedback_per_week)
        }
        Class::Abuse { target_key } => {
            if same_target_secs > 0 {
                let again = count(format!(
                    "SELECT 1 FROM reports WHERE {MINE} AND target_key = $3 AND created_at > $4 LIMIT 1"
                ))
                .bind(reporter)
                .bind(kind.as_str())
                .bind(target_key)
                .bind(t - same_target_secs)
                .fetch_optional(&mut *conn)
                .await?
                .is_some();
                if again {
                    return Ok(false);
                }
            }
            if targets_per_day > 0 {
                let row = count(format!(
                    "SELECT COUNT(DISTINCT target_key), COALESCE(SUM(CASE WHEN target_key = $3 THEN 1 ELSE 0 END), 0) FROM reports WHERE {MINE} AND target_kind <> 'none' AND created_at > $4"
                ))
                .bind(reporter)
                .bind(kind.as_str())
                .bind(target_key)
                .bind(t - DAY)
                .fetch_one(&mut *conn)
                .await?;
                let (targets, this): (i64, i64) = (row.try_get(0)?, row.try_get(1)?);
                if this == 0 && targets >= targets_per_day {
                    return Ok(false);
                }
            }
            if per_week > 0 {
                let sent: i64 = count(format!(
                    "SELECT COUNT(*) FROM reports WHERE {MINE} AND target_kind <> 'none' AND created_at > $3"
                ))
                .bind(reporter)
                .bind(kind.as_str())
                .bind(t - WEEK)
                .fetch_one(&mut *conn)
                .await?
                .try_get(0)?;
                if sent >= per_week {
                    return Ok(false);
                }
            }
            Ok(true)
        }
    }
}
