use sqlx::{AnyConnection, Row};

use super::ReportKind;
use crate::api::ApiError;
use crate::limits::Limits;

pub(crate) use rchat_reports::caps::{Caps, Class};
use rchat_reports::caps::{DAY, WEEK};

/// The caps of `limits`.
pub(crate) fn caps_of(limits: &Limits) -> Caps {
    Caps {
        same_target_secs: i64::from(limits.report_same_target_hours) * 3600,
        targets_per_day: i64::from(limits.report_targets_per_day),
        per_week: i64::from(limits.report_max_per_week),
        feedback_per_week: i64::from(limits.report_feedback_per_week),
    }
}

/// Whether `reporter` may send one more report of `kind` at `t`. Only their own reports of that
/// kind count, never the copies an escalation makes. Run it inside the transaction that inserts
/// the report, after the pace row of the reporter is written, so reports sent at once are
/// counted one after the other. `rchat_reports::caps::allowed` is the same rule over a list.
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

#[cfg(test)]
mod tests {
    use rchat_reports::caps::cases;

    use super::{ReportKind, allowed};
    use crate::api::test_util::{done, temp_state};

    const CASES: &str = include_str!("../../../../../assets/report_cap_cases.json");

    async fn insert(
        db: &crate::db::Db,
        reporter: &str,
        kind: &str,
        key: Option<&str>,
        at: i64,
    ) -> i64 {
        let (target_kind, target_key) = match key {
            Some(key) => ("user", key),
            None => ("none", "-"),
        };
        sqlx::query("INSERT INTO reports(kind, target_kind, target_key, reporter, form, form_label, reason, snapshot, created_at, updated_at) VALUES($1, $2, $3, $4, 'user', 'Report a user', 'spam', '{}', $5, $5) RETURNING id")
            .bind(kind)
            .bind(target_kind)
            .bind(target_key)
            .bind(reporter)
            .bind(at)
            .fetch_one(db)
            .await
            .map(|r| sqlx::Row::get(&r, 0))
            .expect("insert report")
    }

    #[tokio::test]
    async fn the_cases_hold_in_the_database() {
        let (state, path) = temp_state("report_cap_cases").await;
        for (n, case) in cases(CASES).expect("cases").iter().enumerate() {
            let reporter = format!("r{n}");
            for sent in case.sent() {
                let id = insert(&state.db, &reporter, "server", sent.target_key, sent.at).await;
                insert(&state.db, "someone", "server", sent.target_key, sent.at).await;
                insert(&state.db, &reporter, "instance", sent.target_key, sent.at).await;
                sqlx::query("INSERT INTO reports(kind, target_kind, target_key, reporter, form, form_label, reason, snapshot, escalated_from, created_at, updated_at) SELECT kind, target_kind, target_key, reporter, form, form_label, reason, snapshot, id, created_at, updated_at FROM reports WHERE id = $1")
                    .bind(id)
                    .execute(&state.db)
                    .await
                    .expect("escalated copy");
            }
            let mut tx = state.db.begin().await.expect("begin");
            let got = allowed(
                &mut tx,
                &reporter,
                ReportKind::Server,
                case.class(),
                case.caps,
                case.t,
            )
            .await
            .expect("allowed");
            tx.rollback().await.expect("rollback");
            assert_eq!(got, case.allowed, "{}", case.name);
        }
        done(state, path).await;
    }
}
