use std::collections::HashMap;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use sqlx::any::AnyRow;
use utoipa::{IntoParams, ToSchema};

use crate::api::access::{
    Proof, TIMED_OUT, ThreadHome, not_found, resolve_channel, resolve_dm, resolve_message,
};
use crate::api::features::Feature;
use crate::api::messages::{SendReq, SendTo, check_reply, send_to};
use crate::api::{
    ApiError, ApiErrorBody, Authed, Message, OkResp, ProfanityTarget, Settings, UserRef, allowed,
    check_len, check_profanity, cursor_int, decode_cursor, encode_cursor, ok, user_from, user_refs,
    yes,
};
use crate::db::{Db, User, get_user, is_sqlite};
use crate::state::AppState;
use crate::ws::WsEvent;

/// The soonest a message can be scheduled, in seconds from now.
pub const SCHEDULE_MIN_SECS: i64 = 60;
/// The latest a message can be scheduled, in seconds from now.
pub const SCHEDULE_MAX_SECS: i64 = 365 * 86400;
/// How long past its time slow mode or the message rate may hold a message back.
pub const DEFER_MAX_SECS: i64 = 3600;
/// The waits before the retries after the server failed to send a message.
pub const RETRY_BACKOFF_SECS: [i64; 5] = [30, 60, 120, 240, 480];
/// How long a copy holds a message it is sending before another copy may take it over.
pub const LEASE_SECS: i64 = 60;
/// How long the rows of sent messages are kept.
pub const SENT_KEEP: i64 = 7 * 86400;
/// How long the rows of messages that failed are kept.
pub const FAILED_KEEP: i64 = 30 * 86400;
/// Rows of each status one run picks.
const PICK: i64 = 100;
/// The largest page of the list.
const PAGE_MAX: i64 = 50;

pub const TURNED_OFF: &str = "Scheduled messages are turned off on this site";
pub const BEING_SENT: &str = "It is being sent";
pub const ALREADY_SENT: &str = "It was already sent";
pub const WAITING_SLOW: &str = "Waiting for slow mode";
pub const SLOW_FAILED: &str = "Slow mode kept it from sending";
pub const SERVER_FAILED: &str = "Something went wrong. Try again.";
pub const GONE: &str = "You can't send there anymore";
const TOO_SOON: &str = "Pick a time at least 1 minute ahead";
const TOO_LATE: &str = "Pick a time within a year";
const ONE_PLACE: &str = "Give one of channel_id, dm_id and thread_root_id";

/// Where a scheduled message is: `waiting` for its time (also while slow mode holds it, with
/// `error` saying so), `sending` right now, or `failed` with `error` saying why.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ScheduledStatus {
    Waiting,
    Sending,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stored {
    Waiting,
    Sending,
    Sent,
    Failed,
}

impl Stored {
    fn parse(s: &str) -> Option<Stored> {
        match s {
            "waiting" => Some(Stored::Waiting),
            "sending" => Some(Stored::Sending),
            "sent" => Some(Stored::Sent),
            "failed" => Some(Stored::Failed),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Stored::Waiting => "waiting",
            Stored::Sending => "sending",
            Stored::Sent => "sent",
            Stored::Failed => "failed",
        }
    }

    fn shown(self) -> Option<ScheduledStatus> {
        match self {
            Stored::Waiting => Some(ScheduledStatus::Waiting),
            Stored::Sending => Some(ScheduledStatus::Sending),
            Stored::Failed => Some(ScheduledStatus::Failed),
            Stored::Sent => None,
        }
    }
}

/// Names of the place of a scheduled message that you can open now.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct ScheduledPlace {
    /// Lowercase name of the server; `null` for a DM.
    pub server: Option<String>,
    /// The server's name as shown; `null` for a DM.
    pub server_name: Option<String>,
    /// The channel's name (for a thread, its root's channel); `null` for a DM.
    pub channel_name: Option<String>,
    /// The other person of a DM; `null` in a server.
    pub dm_user: Option<UserRef>,
}

/// A message this site sends for you later.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct ScheduledMessage {
    /// Its id.
    pub id: i64,
    /// Where it goes: `c<channel_id>`, `t<root_id>` for a thread reply or `d<dm_id>`.
    #[schema(example = "c12")]
    pub scope: String,
    /// The channel; for a thread reply in a channel, the root's channel. `null` in a DM.
    pub channel_id: Option<i64>,
    /// The DM conversation; for a thread reply in a DM, the root's. `null` in a channel.
    pub dm_id: Option<i64>,
    /// For a thread reply, the thread's root message.
    pub thread_root_id: Option<i64>,
    /// The message it replies to.
    pub reply_to: Option<i64>,
    /// With `reply_to`: whether the reply pings the quoted message's author.
    pub mention_reply: bool,
    /// Its text.
    pub content: String,
    /// When it is sent (unix seconds), as you picked it.
    pub at: i64,
    /// When the server looks at it next (unix seconds): `at`, or later while slow mode holds it
    /// or after a server failure.
    pub next_at: i64,
    /// Where it is.
    pub status: ScheduledStatus,
    /// Why it failed, or `Waiting for slow mode` while slow mode holds it.
    pub error: Option<String>,
    /// Names of its place you can open now; `null` when you can't open it, and in events.
    pub place: Option<ScheduledPlace>,
    /// When it was scheduled.
    pub created_at: i64,
    /// When it last changed.
    pub updated_at: i64,
}

/// A message to schedule. Give exactly one of `channel_id`, `dm_id` and `thread_root_id`.
#[derive(Deserialize, ToSchema)]
pub struct ScheduleReq {
    /// A channel to send it in.
    #[serde(default)]
    pub(crate) channel_id: Option<i64>,
    /// A DM conversation to send it in.
    #[serde(default)]
    pub(crate) dm_id: Option<i64>,
    /// The root message of a thread to reply in.
    #[serde(default)]
    pub(crate) thread_root_id: Option<i64>,
    /// A message of the same place to reply to, as `SendReq.reply_to`.
    #[serde(default)]
    pub(crate) reply_to: Option<i64>,
    /// With `reply_to`: ping the quoted message's author. Defaults to `true`.
    #[serde(default = "yes")]
    #[schema(default = true)]
    pub(crate) mention_reply: bool,
    /// Its text: not blank, at most `limits.message_chars` characters.
    #[schema(example = "Standup in 5 minutes")]
    pub(crate) content: String,
    /// When to send it (unix seconds): at least 60 seconds and at most 365 days from now.
    pub(crate) at: i64,
}

/// Changes to a scheduled message. Fields left out stay.
#[derive(Deserialize, ToSchema)]
pub struct ScheduledPatch {
    /// New text: not blank, at most `limits.message_chars` characters.
    #[serde(default)]
    pub(crate) content: Option<String>,
    /// A new time (unix seconds), as for scheduling. A failed message waits again.
    #[serde(default)]
    pub(crate) at: Option<i64>,
    /// `true` makes it a plain message instead of a reply.
    #[serde(default)]
    pub(crate) remove_reply: bool,
}

/// A page of your scheduled messages, soonest first.
#[derive(Serialize, Deserialize, ToSchema)]
pub struct ScheduledPage {
    /// The messages of this page.
    pub items: Vec<ScheduledMessage>,
    /// `after` for the next page; `null` on the last one.
    pub next: Option<String>,
    /// How many wait to be sent (also the ones being sent), with `scope` only there.
    pub waiting: i64,
    /// How many failed, with `scope` only there.
    pub failed: i64,
}

/// What the list shows.
#[derive(Deserialize, IntoParams)]
pub struct ScheduledQuery {
    /// Only the messages of one place: `c<channel_id>`, `t<root_id>` or `d<dm_id>`.
    scope: Option<String>,
    /// Only `waiting` ones (with those being sent) or only `failed` ones.
    status: Option<String>,
    /// `next` of the page before.
    after: Option<String>,
    /// Page size, 1 to 50 (default 50).
    #[param(example = 50)]
    limit: Option<i64>,
}

/// A copy's hold on one scheduled message while it sends it. Only claiming makes one, and
/// `finish_in` gives it up with the message that sent it.
pub struct Claim {
    id: i64,
    token: String,
}

/// Marks the claimed row sent as `message_id`, in the transaction that stores that message. A
/// claim another copy took over fails here, so its message is never stored.
pub(crate) async fn finish_in(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    claim: Option<&Claim>,
    message_id: i64,
    t: i64,
) -> Result<(), ApiError> {
    let Some(Claim { id, token }) = claim else {
        return Ok(());
    };
    let n = sqlx::query("UPDATE scheduled_messages SET status = 'sent', sent_message_id = $1, finished_at = $2, updated_at = $2, claim = NULL, error = NULL WHERE id = $3 AND status = 'sending' AND claim = $4")
        .bind(message_id)
        .bind(t)
        .bind(id)
        .bind(token)
        .execute(&mut **tx)
        .await?
        .rows_affected();
    match n {
        0 => Err(being_sent()),
        _ => Ok(()),
    }
}

fn being_sent() -> ApiError {
    ApiError::conflict(StatusCode::CONFLICT, BEING_SENT)
}

fn already_sent() -> ApiError {
    ApiError::conflict(StatusCode::CONFLICT, ALREADY_SENT)
}

/// A place the access gate let the caller schedule into. Only `gate` makes one.
struct Spot {
    to: SendTo,
    server: Option<String>,
    channel_id: Option<i64>,
    dm_id: Option<i64>,
    thread_root_id: Option<i64>,
}

/// Resolves `to` for `user` through the gate of sending, without slow mode, which applies when
/// the message is sent.
async fn gate(db: &Db, user: &User, to: SendTo) -> Result<Spot, ApiError> {
    match to {
        SendTo::Channel(id) => {
            let channel = resolve_channel(db, id, Some(user), &Proof::none()).await?;
            channel.schedule_gate(db).await?;
            Ok(Spot {
                to,
                server: Some(channel.server().name().to_string()),
                channel_id: Some(id),
                dm_id: None,
                thread_root_id: None,
            })
        }
        SendTo::Thread(id) => {
            let root = resolve_message(db, id, Some(user), &Proof::none()).await?;
            match root.thread_home()? {
                ThreadHome::Channel(channel) => {
                    channel.schedule_gate(db).await?;
                    root.thread_start_gate(db, id).await?;
                    Ok(Spot {
                        to,
                        server: Some(channel.server().name().to_string()),
                        channel_id: Some(channel.id()),
                        dm_id: None,
                        thread_root_id: Some(id),
                    })
                }
                ThreadHome::Dm { id: dm, users: _ } => {
                    let users = resolve_dm(db, dm, user).await?;
                    crate::api::blocks::check_dm_write(db, &user.username, &users).await?;
                    Ok(Spot {
                        to,
                        server: None,
                        channel_id: None,
                        dm_id: Some(dm),
                        thread_root_id: Some(id),
                    })
                }
            }
        }
        SendTo::Dm(id) => {
            let users = resolve_dm(db, id, user).await?;
            crate::api::blocks::check_dm_write(db, &user.username, &users).await?;
            Ok(Spot {
                to,
                server: None,
                channel_id: None,
                dm_id: Some(id),
                thread_root_id: None,
            })
        }
    }
}

struct Entry {
    id: i64,
    username: String,
    channel_id: Option<i64>,
    dm_id: Option<i64>,
    thread_root_id: Option<i64>,
    reply_to: Option<i64>,
    mention_reply: bool,
    content: String,
    due_at: i64,
    next_at: i64,
    status: Stored,
    error: Option<String>,
    attempts: i64,
    created_at: i64,
    updated_at: i64,
}

const ROW_COLS: &str = "id, username, channel_id, dm_id, thread_root_id, reply_to, mention_reply, content, due_at, next_at, status, error, attempts, created_at, updated_at";

/// A stored row; `None` for one whose status this build doesn't know, which is never listed
/// or sent.
fn row_from(r: &AnyRow) -> sqlx::Result<Option<Entry>> {
    let Some(status) = Stored::parse(&r.try_get::<String, _>(10)?) else {
        return Ok(None);
    };
    Ok(Some(Entry {
        id: r.try_get(0)?,
        username: r.try_get(1)?,
        channel_id: r.try_get(2)?,
        dm_id: r.try_get(3)?,
        thread_root_id: r.try_get(4)?,
        reply_to: r.try_get(5)?,
        mention_reply: r.try_get::<i64, _>(6)? != 0,
        content: r.try_get(7)?,
        due_at: r.try_get(8)?,
        next_at: r.try_get(9)?,
        status,
        error: r.try_get(11)?,
        attempts: r.try_get(12)?,
        created_at: r.try_get(13)?,
        updated_at: r.try_get(14)?,
    }))
}

impl Entry {
    fn to(&self) -> Option<SendTo> {
        match (self.thread_root_id, self.channel_id, self.dm_id) {
            (Some(root), _, _) => Some(SendTo::Thread(root)),
            (None, Some(id), _) => Some(SendTo::Channel(id)),
            (None, None, Some(id)) => Some(SendTo::Dm(id)),
            (None, None, None) => None,
        }
    }

    fn scope(&self) -> String {
        match self.to() {
            Some(SendTo::Thread(id)) => format!("t{id}"),
            Some(SendTo::Channel(id)) => format!("c{id}"),
            Some(SendTo::Dm(id)) => format!("d{id}"),
            None => String::new(),
        }
    }

    fn shown(&self, place: Option<ScheduledPlace>) -> Option<ScheduledMessage> {
        Some(ScheduledMessage {
            id: self.id,
            scope: self.scope(),
            channel_id: self.channel_id,
            dm_id: self.dm_id,
            thread_root_id: self.thread_root_id,
            reply_to: self.reply_to,
            mention_reply: self.mention_reply,
            content: self.content.clone(),
            at: self.due_at,
            next_at: self.next_at,
            status: self.status.shown()?,
            error: self.error.clone(),
            place,
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}

async fn load(db: &Db, id: i64) -> sqlx::Result<Option<Entry>> {
    let sql = format!("SELECT {ROW_COLS} FROM scheduled_messages WHERE id = $1");
    match sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_optional(db)
        .await?
    {
        Some(r) => row_from(&r),
        None => Ok(None),
    }
}

/// The caller's own row `id`; any other gives the uniform 404.
async fn own_row(db: &Db, user: &User, id: i64) -> Result<Entry, ApiError> {
    load(db, id)
        .await?
        .filter(|r| r.username == user.username)
        .ok_or_else(not_found)
}

fn updated(state: &AppState, row: &Entry) {
    if let Some(scheduled) = row.shown(None) {
        state.hub.broadcast(WsEvent::ScheduledUpdated {
            username: row.username.clone(),
            scheduled: Box::new(scheduled),
        });
    }
}

fn removed(state: &AppState, username: &str, id: i64, sent_message_id: Option<i64>) {
    state.hub.broadcast(WsEvent::ScheduledRemoved {
        username: username.to_string(),
        id,
        sent_message_id,
    });
}

async fn announce(state: &AppState, id: i64) -> sqlx::Result<()> {
    if let Some(row) = load(&state.db, id).await? {
        updated(state, &row);
    }
    Ok(())
}

fn check_at(at: i64, t: i64) -> Result<(), ApiError> {
    if at < t + SCHEDULE_MIN_SECS {
        return Err(ApiError::invalid(TOO_SOON, "at"));
    }
    if at > t + SCHEDULE_MAX_SECS {
        return Err(ApiError::invalid(TOO_LATE, "at"));
    }
    Ok(())
}

fn check_content(state: &AppState, content: &str) -> Result<(), ApiError> {
    if content.trim().is_empty() {
        return Err(ApiError::invalid("Message is empty", "content"));
    }
    check_len(content, state.limits.message_max_chars, "Message")
}

fn cap_text(most: i64) -> String {
    format!("You can have at most {most} scheduled messages waiting")
}

/// Refuses one waiting message more past `SCHEDULED_PER_ACCOUNT` (0 for no limit), counted
/// after `lock_account`.
async fn room_for(
    conn: &mut sqlx::AnyConnection,
    state: &AppState,
    username: &str,
) -> Result<(), ApiError> {
    let most = state.limits.scheduled_per_account;
    if most == 0 {
        return Ok(());
    }
    crate::api::servers::lock_account(conn, username).await?;
    let waiting: i64 = sqlx::query("SELECT COUNT(*) FROM scheduled_messages WHERE username = $1 AND status IN ('waiting', 'sending')")
        .bind(username)
        .fetch_one(&mut *conn)
        .await?
        .try_get(0)?;
    match waiting < most {
        true => Ok(()),
        false => Err(ApiError::limit(
            StatusCode::BAD_REQUEST,
            cap_text(most),
            "scheduled_per_account",
        )),
    }
}

async fn write_tx(db: &Db) -> sqlx::Result<sqlx::Transaction<'_, sqlx::Any>> {
    match is_sqlite(db) {
        true => db.begin_with("BEGIN IMMEDIATE").await,
        false => db.begin().await,
    }
}

/// Names of each place of `rows` that `user` can open now, resolved through the gate once per
/// place.
async fn places(
    db: &Db,
    user: &User,
    rows: &[Entry],
) -> Result<HashMap<String, ScheduledPlace>, ApiError> {
    let mut out = HashMap::new();
    let mut seen = std::collections::HashSet::new();
    let mut dms: Vec<(String, String)> = Vec::new();
    for row in rows {
        let scope = row.scope();
        if !seen.insert(scope.clone()) {
            continue;
        }
        let dm = match row.to() {
            Some(SendTo::Channel(id)) => {
                if let Some(channel) =
                    allowed(resolve_channel(db, id, Some(user), &Proof::none()).await)?
                {
                    out.insert(scope, channel_place(&channel));
                }
                None
            }
            Some(SendTo::Thread(id)) => {
                let root = allowed(resolve_message(db, id, Some(user), &Proof::none()).await)?;
                match root.as_ref().map(|r| r.thread_home()) {
                    Some(Ok(ThreadHome::Channel(channel))) => {
                        out.insert(scope, channel_place(channel));
                        None
                    }
                    Some(Ok(ThreadHome::Dm { id: dm, users: _ })) => Some(dm),
                    Some(Err(_)) | None => None,
                }
            }
            Some(SendTo::Dm(id)) => Some(id),
            None => None,
        };
        if let Some(dm) = dm
            && let Some(users) = allowed(resolve_dm(db, dm, user).await)?
        {
            dms.push((row.scope(), other(&users, user)));
        }
    }
    let names: Vec<String> = dms.iter().map(|(_, name)| name.clone()).collect();
    let refs = user_refs(db, &names).await;
    for (scope, name) in dms {
        out.insert(
            scope,
            ScheduledPlace {
                server: None,
                server_name: None,
                channel_name: None,
                dm_user: Some(user_from(&refs, &name)),
            },
        );
    }
    Ok(out)
}

fn channel_place(channel: &crate::api::access::ResolvedChannel) -> ScheduledPlace {
    ScheduledPlace {
        server: Some(channel.server().name().to_string()),
        server_name: Some(channel.server().lite().display_name.clone()),
        channel_name: Some(channel.name().to_string()),
        dm_user: None,
    }
}

fn other(users: &[String], user: &User) -> String {
    users
        .iter()
        .find(|u| **u != user.username)
        .unwrap_or(&user.username)
        .clone()
}

async fn answer(db: &Db, user: &User, row: Entry) -> Result<ScheduledMessage, ApiError> {
    let mut named = places(db, user, std::slice::from_ref(&row)).await?;
    let place = named.remove(&row.scope());
    row.shown(place).ok_or_else(already_sent)
}

fn scope_sql(scope: &str) -> Result<(&'static str, i64), ApiError> {
    let invalid = || ApiError::invalid("Invalid scope", "scope");
    let (kind, id) = scope.split_at_checked(1).ok_or_else(invalid)?;
    let id: i64 = id.parse().map_err(|_| invalid())?;
    let cond = match kind {
        "c" => "channel_id = $2 AND thread_root_id IS NULL",
        "t" => "thread_root_id = $2",
        "d" => "dm_id = $2 AND thread_root_id IS NULL",
        _ => return Err(invalid()),
    };
    Ok((cond, id))
}

/// List your scheduled messages
///
/// Your messages waiting to be sent, being sent and failed, soonest first, 50 at a time, with
/// how many wait and how many failed. `place` names each place you can still open, through the
/// same access checks as reading it; it is `null` for the rest. Sent messages are not listed.
/// Requires a bearer token. General rate-limit bucket.
#[utoipa::path(get, path = "/api/v1/me/scheduled", tag = "Scheduled messages", params(ScheduledQuery), responses((status = 200, description = "A page of your scheduled messages", body = ScheduledPage), (status = 400, description = "`Invalid scope`, `Invalid status` or `Invalid cursor`", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn list(
    State(state): State<AppState>,
    Authed(user): Authed,
    Query(q): Query<ScheduledQuery>,
) -> Result<Json<ScheduledPage>, ApiError> {
    let ScheduledQuery {
        scope,
        status,
        after,
        limit,
    } = q;
    let db = &state.db;
    let (place, id) = match scope.as_deref() {
        Some(scope) => scope_sql(scope)?,
        None => ("$2 = 0", 0),
    };
    let statuses = match status.as_deref() {
        None => "status IN ('waiting', 'sending', 'failed')",
        Some("waiting") => "status IN ('waiting', 'sending')",
        Some("failed") => "status = 'failed'",
        Some(_) => return Err(ApiError::invalid("Invalid status", "status")),
    };
    let (from_at, from_id) = match after.as_deref() {
        Some(raw) => {
            let parts = decode_cursor(raw, 2)?;
            (cursor_int(&parts[0])?, cursor_int(&parts[1])?)
        }
        None => (i64::MIN, i64::MIN),
    };
    let limit = limit.unwrap_or(PAGE_MAX).clamp(1, PAGE_MAX);
    let sql = format!(
        "SELECT {ROW_COLS} FROM scheduled_messages WHERE username = $1 AND {place} AND {statuses} AND (due_at > $3 OR (due_at = $3 AND id > $4)) ORDER BY due_at, id LIMIT $5"
    );
    let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(&user.username)
        .bind(id)
        .bind(from_at)
        .bind(from_id)
        .bind(limit + 1)
        .fetch_all(db)
        .await?;
    let mut rows: Vec<Entry> = rows
        .iter()
        .map(row_from)
        .collect::<sqlx::Result<Vec<_>>>()?
        .into_iter()
        .flatten()
        .collect();
    let more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);
    let next = match (more, rows.last()) {
        (true, Some(last)) => Some(encode_cursor(&[
            &last.due_at.to_string(),
            &last.id.to_string(),
        ])),
        (_, _) => None,
    };
    let sql = format!(
        "SELECT COUNT(CASE WHEN status IN ('waiting', 'sending') THEN 1 END), COUNT(CASE WHEN status = 'failed' THEN 1 END) FROM scheduled_messages WHERE username = $1 AND {place} AND status IN ('waiting', 'sending', 'failed')"
    );
    let counts = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(&user.username)
        .bind(id)
        .fetch_one(db)
        .await?;
    let named = places(db, &user, &rows).await?;
    let items = rows
        .iter()
        .filter_map(|r| r.shown(named.get(&r.scope()).cloned()))
        .collect();
    Ok(Json(ScheduledPage {
        items,
        next,
        waiting: counts.try_get(0)?,
        failed: counts.try_get(1)?,
    }))
}

/// Schedule a message
///
/// Stores a text message this site sends for you at `at`, in a channel, a thread or a DM. The
/// place is checked as for sending (membership, the channel's Send messages permission and, for
/// the first reply of a thread, Start threads; timeouts; a DM's participants and blocks), but
/// slow mode only applies when it is sent. In channels and threads the profanity filter checks
/// the text when it is on. At its time everything is checked again as you: a message that may
/// not be sent then fails with a reason, and one held by slow mode or the message rate waits up
/// to an hour past its time. Requires a bearer token. Emits `scheduled_updated` to your own
/// connections. General rate-limit bucket.
#[utoipa::path(post, path = "/api/v1/me/scheduled", tag = "Scheduled messages", request_body = ScheduleReq, responses((status = 200, description = "The scheduled message", body = ScheduledMessage), (status = 400, description = "With reason `invalid`: `Give one of channel_id, dm_id and thread_root_id` (field `place`), `Pick a time at least 1 minute ahead` or `Pick a time within a year` (field `at`), `Message is empty` (field `content`). Text over `limits.message_chars` characters, a `reply_to` you cannot reply to (`Cannot reply to that message`), text blocked by the profanity filter, a voice channel. `You can have at most 100 scheduled messages waiting` with the configured number (`SCHEDULED_PER_ACCOUNT`, reason `limit`, control `scheduled_per_account`). Malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 403, description = "`Scheduled messages are turned off on this site` (reason `off_site`, control `scheduled_messages`). Not a member of the channel's server, no permission to send in the channel or to start a thread there, timed out, or a block between the DM participants", body = ApiErrorBody), (status = 404, description = "`Not found`: no such channel, thread root or DM, or one you cannot open; identical responses", body = ApiErrorBody), (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String), (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn create(
    State(state): State<AppState>,
    Authed(user): Authed,
    Json(req): Json<ScheduleReq>,
) -> Result<Json<ScheduledMessage>, ApiError> {
    create_at(&state, &user, req, state.clock.unix())
        .await
        .map(Json)
}

pub(crate) async fn create_at(
    state: &AppState,
    user: &User,
    req: ScheduleReq,
    t: i64,
) -> Result<ScheduledMessage, ApiError> {
    let ScheduleReq {
        channel_id,
        dm_id,
        thread_root_id,
        reply_to,
        mention_reply,
        content,
        at,
    } = req;
    let db = &state.db;
    if !Settings::cached(db).await.on(Feature::ScheduledMessages) {
        return Err(ApiError::off_site(
            StatusCode::FORBIDDEN,
            TURNED_OFF,
            Feature::ScheduledMessages.key(),
        ));
    }
    check_at(at, t)?;
    check_content(state, &content)?;
    let to = match (channel_id, dm_id, thread_root_id) {
        (Some(id), None, None) => SendTo::Channel(id),
        (None, Some(id), None) => SendTo::Dm(id),
        (None, None, Some(id)) => SendTo::Thread(id),
        (_, _, _) => return Err(ApiError::invalid(ONE_PLACE, "place")),
    };
    let spot = gate(db, user, to).await?;
    check_reply(db, user, spot.to, reply_to).await?;
    if spot.channel_id.is_some() {
        check_profanity(db, ProfanityTarget::Messages, &content).await?;
    }
    let id = insert(state, user, &spot, reply_to, mention_reply, &content, at, t).await?;
    let row = load(db, id).await?.ok_or_else(not_found)?;
    updated(state, &row);
    answer(db, user, row).await
}

#[allow(clippy::too_many_arguments)]
async fn insert(
    state: &AppState,
    user: &User,
    spot: &Spot,
    reply_to: Option<i64>,
    mention_reply: bool,
    content: &str,
    at: i64,
    t: i64,
) -> Result<i64, ApiError> {
    let Spot {
        to: _,
        server,
        channel_id,
        dm_id,
        thread_root_id,
    } = spot;
    let mut tx = write_tx(&state.db).await?;
    room_for(&mut tx, state, &user.username).await?;
    let id: i64 = sqlx::query("INSERT INTO scheduled_messages(username, server, channel_id, dm_id, thread_root_id, reply_to, mention_reply, content, due_at, next_at, created_at, updated_at) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10, $10) RETURNING id")
        .bind(&user.username)
        .bind(server.as_deref())
        .bind(*channel_id)
        .bind(*dm_id)
        .bind(*thread_root_id)
        .bind(reply_to)
        .bind(i64::from(mention_reply))
        .bind(content)
        .bind(at)
        .bind(t)
        .fetch_one(&mut *tx)
        .await?
        .try_get(0)?;
    tx.commit().await?;
    Ok(id)
}

/// Refuses a row that is not waiting or failed.
fn changeable(row: &Entry) -> Result<(), ApiError> {
    match row.status {
        Stored::Waiting | Stored::Failed => Ok(()),
        Stored::Sending => Err(being_sent()),
        Stored::Sent => Err(already_sent()),
    }
}

/// Edit a scheduled message
///
/// Changes the text or the time of one of your messages that waits or failed, or makes it a
/// plain message instead of a reply. A new time makes a failed message wait again, and then it
/// counts against `SCHEDULED_PER_ACCOUNT`. In channels and threads the profanity filter checks
/// new text when it is on. Works while the `scheduled_messages` switch is off. Requires a bearer
/// token. Emits `scheduled_updated` to your own connections. General rate-limit bucket.
#[utoipa::path(patch, path = "/api/v1/me/scheduled/{id}", operation_id = "update_scheduled", tag = "Scheduled messages", params(("id" = i64, Path, description = "Scheduled message id")), request_body = ScheduledPatch, responses((status = 200, description = "The scheduled message", body = ScheduledMessage), (status = 400, description = "With reason `invalid`: a time out of range (field `at`) or `Message is empty` (field `content`). Text over `limits.message_chars` characters or blocked by the profanity filter. `You can have at most 100 scheduled messages waiting` (reason `limit`, control `scheduled_per_account`) for a failed message given a new time. A non-numeric id, malformed JSON or a missing `Content-Type` give plain-text 400/415 framework errors", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 404, description = "`Not found`: no scheduled message of yours with that id", body = ApiErrorBody), (status = 409, description = "`It is being sent` or `It was already sent` (reason `conflict`)", body = ApiErrorBody), (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String), (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn patch(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(id): Path<i64>,
    Json(req): Json<ScheduledPatch>,
) -> Result<Json<ScheduledMessage>, ApiError> {
    patch_at(&state, &user, id, req, state.clock.unix())
        .await
        .map(Json)
}

pub(crate) async fn patch_at(
    state: &AppState,
    user: &User,
    id: i64,
    req: ScheduledPatch,
    t: i64,
) -> Result<ScheduledMessage, ApiError> {
    let ScheduledPatch {
        content,
        at,
        remove_reply,
    } = req;
    let db = &state.db;
    let row = own_row(db, user, id).await?;
    changeable(&row)?;
    if let Some(content) = &content {
        check_content(state, content)?;
        if row.channel_id.is_some() {
            check_profanity(db, ProfanityTarget::Messages, content).await?;
        }
    }
    if let Some(at) = at {
        check_at(at, t)?;
    }
    let mut sql = String::from("UPDATE scheduled_messages SET updated_at = $1");
    let mut n = 1;
    if content.is_some() {
        n += 1;
        sql.push_str(&format!(", content = ${n}"));
    }
    if remove_reply {
        sql.push_str(", reply_to = NULL");
    }
    if at.is_some() {
        n += 1;
        sql.push_str(&format!(
            ", due_at = ${n}, next_at = ${n}, status = 'waiting', error = NULL, attempts = 0, finished_at = NULL"
        ));
    }
    sql.push_str(&format!(
        " WHERE id = ${} AND username = ${} AND status IN ('waiting', 'failed')",
        n + 1,
        n + 2
    ));
    let mut tx = write_tx(db).await?;
    if at.is_some() && row.status == Stored::Failed {
        room_for(&mut tx, state, &user.username).await?;
    }
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(t);
    if let Some(content) = &content {
        query = query.bind(content.clone());
    }
    if let Some(at) = at {
        query = query.bind(at);
    }
    let changed = query
        .bind(id)
        .bind(&user.username)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    tx.commit().await?;
    let row = own_row(db, user, id).await?;
    if changed == 0 {
        changeable(&row)?;
    }
    updated(state, &row);
    answer(db, user, row).await
}

/// The reason a refused send gives its row.
fn failure_of(e: &ApiError) -> String {
    let ApiError(status, text, _) = e;
    if *status == StatusCode::NOT_FOUND {
        return GONE.to_string();
    }
    if status.is_server_error() {
        return SERVER_FAILED.to_string();
    }
    failure_text(text).to_string()
}

/// The send path's refusal as a scheduled message's reason.
fn failure_text(text: &str) -> &str {
    match text {
        "Not a member" => "You're not in this server anymore",
        "No permission to send in this channel" => "You can't send messages in that channel",
        "Cannot reply to that message" => "The message it replies to is gone",
        TIMED_OUT => "You're timed out in that server",
        other => other,
    }
}

/// Send a scheduled message now
///
/// Sends one of your messages that waits or failed right away (Retry for a failed one), through
/// the same checks as sending it yourself, slow mode included. Refused, it stays as it was (a
/// failed one takes the new reason) and the refusal is the answer. Works while the
/// `scheduled_messages` switch is off. Requires a bearer token. Emits the `message` events of
/// sending and `scheduled_removed` to your own connections. General rate-limit bucket.
#[utoipa::path(post, path = "/api/v1/me/scheduled/{id}/send", tag = "Scheduled messages", params(("id" = i64, Path, description = "Scheduled message id")), responses((status = 200, description = "The posted message", body = Message), (status = 400, description = "A refusal of the send path, such as `Cannot reply to that message` or the profanity filter. A non-numeric id gives a plain-text 400", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 403, description = "A refusal of the send path: not a member, no permission to send, timed out, banned or blocked", body = ApiErrorBody), (status = 404, description = "`Not found`: no scheduled message of yours with that id, or a place you cannot open; identical responses", body = ApiErrorBody), (status = 409, description = "`It is being sent` or `It was already sent` (reason `conflict`)", body = ApiErrorBody), (status = 429, description = "Slow mode (`Slow mode: wait Ns`), `Sending too fast, try again in a moment` (reason `rate`), or too many requests in the general bucket", body = ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn send_now(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(id): Path<i64>,
) -> Result<Json<Message>, ApiError> {
    send_now_at(&state, &user, id, state.clock.unix())
        .await
        .map(Json)
}

pub(crate) async fn send_now_at(
    state: &AppState,
    user: &User,
    id: i64,
    t: i64,
) -> Result<Message, ApiError> {
    let db = &state.db;
    let row = own_row(db, user, id).await?;
    changeable(&row)?;
    let to = row.to().ok_or_else(not_found)?;
    let token = crate::identity::random_id();
    let n = sqlx::query("UPDATE scheduled_messages SET status = 'sending', claim = $1, next_at = $2, attempts = attempts + 1, updated_at = $3 WHERE id = $4 AND username = $5 AND status = $6 AND next_at = $7 AND attempts = $8")
        .bind(&token)
        .bind(t + LEASE_SECS)
        .bind(t)
        .bind(id)
        .bind(&user.username)
        .bind(row.status.as_str())
        .bind(row.next_at)
        .bind(row.attempts)
        .execute(db)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(being_sent());
    }
    let claim = Claim { id, token };
    let req = SendReq {
        mention_reply: row.mention_reply,
        ..SendReq::text(row.content.clone(), row.reply_to)
    };
    match send_to(state, user, to, req, Some(&claim)).await {
        Ok(message) => {
            removed(state, &user.username, id, Some(message.id));
            Ok(message)
        }
        Err(e) => {
            let (error, at) = match row.status {
                Stored::Failed => (Some(failure_of(&e)), t),
                Stored::Waiting | Stored::Sending | Stored::Sent => {
                    (row.error.clone(), row.updated_at)
                }
            };
            let n = sqlx::query("UPDATE scheduled_messages SET status = $1, next_at = $2, attempts = $3, error = $4, claim = NULL, updated_at = $5 WHERE id = $6 AND claim = $7")
                .bind(row.status.as_str())
                .bind(row.next_at)
                .bind(row.attempts)
                .bind(&error)
                .bind(at)
                .bind(id)
                .bind(&claim.token)
                .execute(db)
                .await?
                .rows_affected();
            if n > 0 && error != row.error {
                announce(state, id).await?;
            }
            Err(e)
        }
    }
}

/// Delete a scheduled message
///
/// Deletes one of your messages that waits or failed, so it is never sent. Works while the
/// `scheduled_messages` switch is off. Requires a bearer token. Emits `scheduled_removed` to
/// your own connections. General rate-limit bucket.
#[utoipa::path(delete, path = "/api/v1/me/scheduled/{id}", operation_id = "delete_scheduled", tag = "Scheduled messages", params(("id" = i64, Path, description = "Scheduled message id")), responses((status = 200, description = "Deleted; body `{\"ok\": true}`", body = OkResp), (status = 400, description = "Non-numeric id (plain-text framework error)", content_type = "text/plain", body = String), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 404, description = "`Not found`: no scheduled message of yours with that id", body = ApiErrorBody), (status = 409, description = "`It is being sent` or `It was already sent` (reason `conflict`)", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn delete(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(id): Path<i64>,
) -> Result<Json<OkResp>, ApiError> {
    let db = &state.db;
    let row = own_row(db, &user, id).await?;
    changeable(&row)?;
    let n = sqlx::query("DELETE FROM scheduled_messages WHERE id = $1 AND username = $2 AND status IN ('waiting', 'failed')")
        .bind(id)
        .bind(&user.username)
        .execute(db)
        .await?
        .rows_affected();
    if n == 0 {
        changeable(&own_row(db, &user, id).await?)?;
    }
    removed(&state, &user.username, id, None);
    Ok(ok())
}

/// A row this copy claimed to send.
struct Claimed {
    claim: Claim,
    username: String,
    to: Option<SendTo>,
    reply_to: Option<i64>,
    mention_reply: bool,
    content: String,
    due_at: i64,
    attempts: i64,
}

/// Claims due row `id` from `from` (a waiting row, or a sending one whose copy's lease lapsed):
/// only one copy wins it.
async fn claim_due(db: &Db, id: i64, from: Stored, t: i64) -> sqlx::Result<Option<Claimed>> {
    let token = crate::identity::random_id();
    let row = sqlx::query("UPDATE scheduled_messages SET status = 'sending', claim = $1, next_at = $2, attempts = attempts + 1, updated_at = $3 WHERE id = $4 AND status = $5 AND next_at <= $3 RETURNING username, channel_id, dm_id, thread_root_id, reply_to, mention_reply, content, due_at, attempts")
        .bind(&token)
        .bind(t + LEASE_SECS)
        .bind(t)
        .bind(id)
        .bind(from.as_str())
        .fetch_optional(db)
        .await?;
    let Some(r) = row else {
        return Ok(None);
    };
    let to = match (
        r.try_get::<Option<i64>, _>(3)?,
        r.try_get::<Option<i64>, _>(1)?,
        r.try_get::<Option<i64>, _>(2)?,
    ) {
        (Some(root), _, _) => Some(SendTo::Thread(root)),
        (None, Some(id), _) => Some(SendTo::Channel(id)),
        (None, None, Some(id)) => Some(SendTo::Dm(id)),
        (None, None, None) => None,
    };
    Ok(Some(Claimed {
        claim: Claim { id, token },
        username: r.try_get(0)?,
        to,
        reply_to: r.try_get(4)?,
        mention_reply: r.try_get::<i64, _>(5)? != 0,
        content: r.try_get(6)?,
        due_at: r.try_get(7)?,
        attempts: r.try_get(8)?,
    }))
}

/// What becomes of a claimed row after its send.
#[derive(Debug, PartialEq, Eq)]
enum Settle {
    Sent(i64),
    Defer(i64),
    Retry(i64),
    Fail(String),
}

fn settle_of(outcome: &Result<Message, ApiError>, due_at: i64, attempts: i64, t: i64) -> Settle {
    match outcome {
        Ok(message) => Settle::Sent(message.id),
        Err(ApiError(StatusCode::TOO_MANY_REQUESTS, _, reason)) => {
            let wait = reason.as_ref().and_then(|r| r.retry_after).unwrap_or(1) as i64;
            match t + wait <= due_at + DEFER_MAX_SECS {
                true => Settle::Defer(t + wait),
                false => Settle::Fail(SLOW_FAILED.to_string()),
            }
        }
        Err(e) if e.failed() => {
            let tried = usize::try_from(attempts - 1).ok();
            match tried.and_then(|i| RETRY_BACKOFF_SECS.get(i)) {
                Some(wait) => Settle::Retry(t + wait),
                None => Settle::Fail(SERVER_FAILED.to_string()),
            }
        }
        Err(e) => Settle::Fail(failure_of(e)),
    }
}

/// Settles a claimed row by `settle`; nothing happens to a row another copy took over.
async fn settle(
    state: &AppState,
    claim: &Claim,
    username: &str,
    settle: Settle,
    t: i64,
) -> sqlx::Result<()> {
    let db = &state.db;
    let (sql, next, error) = match settle {
        Settle::Sent(message_id) => {
            removed(state, username, claim.id, Some(message_id));
            return Ok(());
        }
        Settle::Defer(next) => (
            "UPDATE scheduled_messages SET status = 'waiting', next_at = $1, attempts = 0, error = $2, claim = NULL, updated_at = $3 WHERE id = $4 AND claim = $5 AND status = 'sending'",
            next,
            WAITING_SLOW.to_string(),
        ),
        Settle::Retry(next) => {
            sqlx::query("UPDATE scheduled_messages SET status = 'waiting', next_at = $1, claim = NULL, updated_at = $2 WHERE id = $3 AND claim = $4 AND status = 'sending'")
                .bind(next)
                .bind(t)
                .bind(claim.id)
                .bind(&claim.token)
                .execute(db)
                .await?;
            return Ok(());
        }
        Settle::Fail(error) => (
            "UPDATE scheduled_messages SET status = 'failed', next_at = $1, error = $2, claim = NULL, updated_at = $3, finished_at = $3 WHERE id = $4 AND claim = $5 AND status = 'sending'",
            t,
            error,
        ),
    };
    let n = sqlx::query(sql)
        .bind(next)
        .bind(&error)
        .bind(t)
        .bind(claim.id)
        .bind(&claim.token)
        .execute(db)
        .await?
        .rows_affected();
    if n > 0 {
        announce(state, claim.id).await?;
    }
    Ok(())
}

/// Sends one claimed row as its author, through the same path as their own sends, and settles
/// it.
async fn run_one(state: &AppState, claimed: Claimed, t: i64) -> sqlx::Result<bool> {
    let Claimed {
        claim,
        username,
        to,
        reply_to,
        mention_reply,
        content,
        due_at,
        attempts,
    } = claimed;
    let Some(user) = get_user(&state.db, &username).await? else {
        sqlx::query("DELETE FROM scheduled_messages WHERE id = $1 AND claim = $2")
            .bind(claim.id)
            .bind(&claim.token)
            .execute(&state.db)
            .await?;
        return Ok(false);
    };
    let user = User {
        temp: crate::db::temp_password(&state.db, &username).await?,
        ..user
    };
    let outcome = match (to, user.suspended_at) {
        (Some(_), None) if crate::api::restricted(&state.db, &user).await => {
            Err(crate::api::change_first())
        }
        (Some(to), None) => {
            let req = SendReq {
                mention_reply,
                ..SendReq::text(content, reply_to)
            };
            send_to(state, &user, to, req, Some(&claim)).await
        }
        (_, _) => Err(not_found()),
    };
    let result = settle_of(&outcome, due_at, attempts, t);
    let sent = matches!(result, Settle::Sent(_));
    settle(state, &claim, &username, result, t).await?;
    Ok(sent)
}

/// Sends the scheduled messages that are due, one after another, and takes over the ones a
/// stopped copy held past their lease. Answers how many it sent.
pub async fn run_due(state: &AppState) -> sqlx::Result<u64> {
    run_due_at(state, state.clock.unix()).await
}

pub(crate) async fn run_due_at(state: &AppState, t: i64) -> sqlx::Result<u64> {
    let mut sent = 0;
    for from in [Stored::Waiting, Stored::Sending] {
        let ids: Vec<i64> = sqlx::query("SELECT id FROM scheduled_messages WHERE status = $1 AND next_at <= $2 ORDER BY next_at LIMIT $3")
            .bind(from.as_str())
            .bind(t)
            .bind(PICK)
            .fetch_all(&state.db)
            .await?
            .iter()
            .map(|r| r.try_get(0))
            .collect::<sqlx::Result<_>>()?;
        for id in ids {
            let done = match claim_due(&state.db, id, from, t).await {
                Ok(Some(claimed)) => run_one(state, claimed, t).await,
                Ok(None) => Ok(false),
                Err(e) => Err(e),
            };
            match done {
                Ok(true) => sent += 1,
                Ok(false) => {}
                Err(e) => tracing::warn!("sending scheduled message {id} failed: {e}"),
            }
            tokio::task::yield_now().await;
        }
    }
    Ok(sent)
}

#[cfg(test)]
mod tests;
