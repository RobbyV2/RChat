use serde::Serialize;
use utoipa::ToSchema;

use crate::api::access::not_found;
use crate::api::join_modes::random_text;
use crate::api::policy::TempChange;
use crate::api::{ApiError, instance_audit};
use crate::db::{Db, TempPassword};

/// How many characters a temporary password has: 20 of the 31 unambiguous symbols hold 99
/// bits.
pub const LENGTH: usize = 20;

/// A new temporary password from the system's random source, in groups of four characters
/// (`k7mq-x3ta-9fzc-w2hd-pn4e`). It is returned to whoever asked for it once and only its hash
/// is stored.
pub fn generate() -> String {
    let text = random_text(LENGTH);
    let groups: Vec<&str> = (0..LENGTH).step_by(4).map(|at| &text[at..at + 4]).collect();
    groups.join("-")
}

/// When a temporary password issued at `t` stops signing in, for a lifetime of `hours`; 0
/// hours is never.
pub fn expiry(hours: i64, t: i64) -> Option<i64> {
    (hours > 0).then(|| t + hours * 3600)
}

/// Marks the password of `username` as a temporary one issued at `t` by `issued_by` (`None`
/// for the command line), replacing an earlier mark.
pub(crate) async fn mark(
    conn: &mut sqlx::AnyConnection,
    username: &str,
    issued_by: Option<&str>,
    expires_at: Option<i64>,
    t: i64,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO temp_passwords(username, issued_at, expires_at, issued_by) VALUES($1, $2, $3, $4) ON CONFLICT(username) DO UPDATE SET issued_at = excluded.issued_at, expires_at = excluded.expires_at, issued_by = excluded.issued_by",
    )
    .bind(username)
    .bind(t)
    .bind(expires_at)
    .bind(issued_by)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Who issues a temporary password: an account, or the server's command line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Issuer<'a> {
    Account(&'a str),
    Cli,
}

impl Issuer<'_> {
    pub(crate) fn username(&self) -> Option<&str> {
        match self {
            Issuer::Account(name) => Some(name),
            Issuer::Cli => None,
        }
    }

    /// Notes `action` on the account `target` in the instance audit log.
    pub(crate) async fn record(
        &self,
        conn: &mut sqlx::AnyConnection,
        action: &str,
        target: &str,
        detail: serde_json::Value,
        t: i64,
    ) -> Result<(), ApiError> {
        match self {
            Issuer::Account(actor) => {
                instance_audit::record_in(conn, actor, action, Some(target), detail, t).await
            }
            Issuer::Cli => {
                Ok(instance_audit::record_cli(conn, action, Some(target), detail, t).await?)
            }
        }
    }
}

/// A temporary password as it is returned once to whoever issued it.
#[derive(Clone, Serialize)]
pub struct Issued {
    pub temp_password: String,
    /// When it stops signing in (unix seconds); null for never.
    pub expires_at: Option<i64>,
}

/// Printing one for a log or a failed assertion never shows the password.
impl std::fmt::Debug for Issued {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let Issued {
            temp_password: _,
            expires_at,
        } = self;
        f.debug_struct("Issued")
            .field("temp_password", &"<hidden>")
            .field("expires_at", expires_at)
            .finish()
    }
}

/// Replaces the password of the account `username` with a new temporary one that lasts
/// `hours`, and ends every session of the account. The caller tells the sockets
/// (`TokensRevoked`). Answers the uniform 404 for an account that does not exist or is being
/// deleted.
pub(crate) async fn reset(
    db: &Db,
    username: &str,
    by: Issuer<'_>,
    hours: i64,
    t: i64,
) -> Result<Issued, ApiError> {
    let temp_password = generate();
    let hash = crate::api::auth::hash_password(&temp_password).await?;
    let expires_at = expiry(hours, t);
    let mut tx = db.begin().await?;
    let changed = sqlx::query(
        "UPDATE users SET password_hash = $1, password_kind = 'text' WHERE username = $2 AND password_hash <> '!purging'",
    )
    .bind(&hash)
    .bind(username)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if changed != 1 {
        return Err(not_found());
    }
    mark(&mut tx, username, by.username(), expires_at, t).await?;
    crate::api::auth::end_sessions(&mut tx, username, None, t).await?;
    by.record(
        &mut tx,
        "user.temp_password",
        username,
        serde_json::json!({ "expires_at": expires_at }),
        t,
    )
    .await?;
    tx.commit().await?;
    Ok(Issued {
        temp_password,
        expires_at,
    })
}

/// Takes the temporary mark off `username`, whose password is its own from here on. Says
/// whether there was one.
pub(crate) async fn clear(conn: &mut sqlx::AnyConnection, username: &str) -> sqlx::Result<bool> {
    Ok(
        sqlx::query("DELETE FROM temp_passwords WHERE username = $1")
            .bind(username)
            .execute(&mut *conn)
            .await?
            .rows_affected()
            > 0,
    )
}

/// The temporary password an account signed in with, in `GET /api/v1/me`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, ToSchema)]
pub struct TempView {
    /// When the temporary password stops signing in (unix seconds); null for never.
    pub expires_at: Option<i64>,
    /// What applies to this session right now: `required` (it can only change the password,
    /// read the account and sign out; also once the temporary password has expired) or
    /// `encouraged`.
    pub change: TempChange,
}

impl TempView {
    pub(crate) fn of(temp: TempPassword, restricted: bool) -> TempView {
        TempView {
            expires_at: temp.expires_at,
            change: match restricted {
                true => TempChange::Required,
                false => TempChange::Encouraged,
            },
        }
    }
}

#[cfg(test)]
mod tests;
