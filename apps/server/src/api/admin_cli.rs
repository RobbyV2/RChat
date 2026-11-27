use crate::api::auth::{NewAccount, add_account, hash_password, shaped_display_name, username_key};
use crate::api::policy::Policy;
use crate::api::temp_passwords::{self, Issued, Issuer};
use crate::api::{ApiError, ProfanityTarget, Settings, check_profanity, instance_audit};
use std::sync::Arc;

use crate::config::AppConfig;
use crate::crypt::ring::Ring;
use crate::db::{AvatarKind, Db, DbOptions, get_user, now};
use crate::limits::Limits;
use crate::state::AppState;
use crate::ws::WsEvent;

/// What `server user` does to accounts from the command line, against the instance's database.
#[derive(Clone, Debug, PartialEq, Eq, clap::Subcommand)]
pub enum UserCommand {
    /// Create an account with a temporary password. The first account administers the site.
    Create {
        /// The username.
        name: String,
        /// The name shown for the account; the username when left out.
        #[arg(long)]
        display_name: Option<String>,
    },
    /// Give an account a new temporary password and end its sessions.
    ResetPassword {
        /// The username.
        name: String,
    },
}

/// Runs `command` against the database of `config` and answers what to print. The schema is
/// brought up to date; the settings and what the server config recorded about them stay as
/// they are.
pub async fn run(config: &AppConfig, command: UserCommand) -> anyhow::Result<String> {
    crate::api::auth::configure(&config.limits);
    let ring = Ring::load(&config.encryption, config.database_url.as_deref())?;
    let opts = DbOptions {
        controls: None,
        ring: Some(Arc::new(ring)),
        ..config.db_options()
    };
    let db = crate::db::open_with(config.database_url.as_deref(), &opts).await?;
    let out = act(&db, &config.limits, command).await;
    crate::db::close(&db).await;
    out.map_err(|ApiError(_, error, _)| anyhow::anyhow!("{error}"))
}

async fn act(db: &Db, limits: &Limits, command: UserCommand) -> Result<String, ApiError> {
    let hours = Settings::load(db).await.temp_password_hours;
    match command {
        UserCommand::Create { name, display_name } => {
            let Created {
                username,
                first,
                issued,
            } = create_user(db, limits, &name, display_name.as_deref()).await?;
            let role = match first {
                true => "\nIt is the first account, so it administers this site.",
                false => "",
            };
            Ok(format!(
                "Created the account {username}.{role}\n{}",
                printed(&issued, hours)
            ))
        }
        UserCommand::ResetPassword { name } => {
            let issued = reset_password(db, &name).await?;
            Ok(format!(
                "Reset the password of {}. Its sessions are signed out.\n{}",
                name.to_lowercase(),
                printed(&issued, hours)
            ))
        }
    }
}

/// An account the command line made.
#[derive(Clone, Debug)]
pub struct Created {
    pub username: String,
    /// Whether it is the first account of the instance, which administers the site.
    pub first: bool,
    pub issued: Issued,
}

/// Makes the account `name` with a temporary password, in every sign-up mode. The first account
/// of an instance administers the site, as with sign-up; every later one is an ordinary account.
/// It joins the default servers. A running server shows it to its members when they next load.
pub async fn create_user(
    db: &Db,
    limits: &Limits,
    name: &str,
    display_name: Option<&str>,
) -> Result<Created, ApiError> {
    let key = username_key(name)?;
    let display_name = match display_name.map(str::trim) {
        Some(shown) if !shown.is_empty() => shaped_display_name(db, shown).await?,
        Some(_) | None => name.to_string(),
    };
    check_profanity(db, ProfanityTarget::Usernames, name).await?;
    let temp_password = temp_passwords::generate();
    let password_hash = hash_password(&temp_password).await?;
    let defaults = Policy::load(db).await.default_servers.clone();
    let hours = Settings::load(db).await.temp_password_hours;
    let t = now();
    let expires_at = temp_passwords::expiry(hours, t);
    let mut tx = db.begin().await?;
    add_account(
        &mut tx,
        limits,
        &defaults,
        NewAccount {
            username: &key,
            display_name: &display_name,
            password_hash: &password_hash,
            password_kind: "text",
            avatar_kind: AvatarKind::Identicon,
            avatar_color: None,
            first_is_admin: true,
        },
        t,
    )
    .await?;
    temp_passwords::mark(&mut tx, &key, None, expires_at, t).await?;
    instance_audit::record_cli(
        &mut tx,
        "user.create",
        Some(&key),
        serde_json::json!({ "display_name": display_name, "servers": [] }),
        t,
    )
    .await?;
    tx.commit().await?;
    let first = get_user(db, &key)
        .await?
        .is_some_and(|user| user.is_site_admin);
    Ok(Created {
        username: key,
        first,
        issued: Issued {
            temp_password,
            expires_at,
        },
    })
}

/// Replaces the password of the account `name` with a new temporary one and ends its sessions,
/// for any account. A running server closes the account's open connections within about a
/// minute (`announce_resets`).
pub async fn reset_password(db: &Db, name: &str) -> Result<Issued, ApiError> {
    let hours = Settings::load(db).await.temp_password_hours;
    temp_passwords::reset(db, &name.to_lowercase(), Issuer::Cli, hours, now()).await
}

/// How far back `announce_resets` looks, in seconds.
const RESET_WINDOW: i64 = 300;
/// The most accounts one pass of `announce_resets` tells.
const RESET_BATCH: i64 = 500;

/// Tells the connections of the accounts whose password the command line reset in the last
/// few minutes that their sessions ended (`TokensRevoked`), so a server that was running during
/// the reset closes their sockets. Returns how many accounts it told.
pub async fn announce_resets(state: &AppState) -> sqlx::Result<usize> {
    use sqlx::Row;
    let rows = sqlx::query(
        "SELECT username FROM temp_passwords WHERE issued_by IS NULL AND issued_at >= $1 ORDER BY issued_at DESC LIMIT $2",
    )
    .bind(now() - RESET_WINDOW)
    .bind(RESET_BATCH)
    .fetch_all(&state.db)
    .await?;
    for row in &rows {
        state.hub.broadcast(WsEvent::TokensRevoked {
            username: row.try_get(0)?,
        });
    }
    Ok(rows.len())
}

/// What the command line prints for a new or reset temporary password.
pub fn printed(issued: &Issued, hours: i64) -> String {
    let Issued {
        temp_password,
        expires_at,
    } = issued;
    let lasts = match expires_at {
        Some(_) => format!(
            "It signs in for {hours} {}.",
            match hours {
                1 => "hour",
                _ => "hours",
            }
        ),
        None => "It does not expire.".to_string(),
    };
    format!(
        "Temporary password: {temp_password}\n{lasts} It is shown only now. The account chooses its own password after signing in."
    )
}

#[cfg(test)]
mod tests;
