use std::sync::LazyLock;
use std::time::Duration;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use utoipa::{IntoParams, ToSchema};

use crate::api::blocks::{is_blocked, prefix_pattern};
use crate::api::budget::Budget;
use crate::api::pings::{Ping, PingKind};
use crate::api::{
    ApiError, ApiErrorBody, Authed, OkResp, Paged, UserRef, bad, cursor_int, decode_cursor,
    encode_cursor, ok,
};
use crate::db::{AvatarKind, Db, User, get_user, now};
use crate::state::AppState;
use crate::ws::WsEvent;

/// Most friends one account can have.
pub const FRIENDS_MAX: i64 = 1000;
/// Most pending friend requests one account can have sent.
pub const OUTGOING_MAX: i64 = 100;
/// Most pending friend requests one account can receive; past it new ones are refused.
pub const INCOMING_MAX: i64 = 1000;
/// Friend requests one account may send per window.
pub const REQUESTS_PER_WINDOW: u32 = 20;
const REQUEST_WINDOW: Duration = Duration::from_secs(600);
const PAGE: i64 = 50;
/// Unseen friend pings kept per user, like other pings; older ones are dropped.
const PINGS_KEPT: i64 = crate::api::pings::PINGS_MAX;
/// Seen friend pings are removed after this many seconds.
const SEEN_KEPT: i64 = 30 * 24 * 3600;
/// The `ping` scope of friend requests and accepted requests.
pub const FRIENDS_SCOPE: &str = "friends";

/// The one answer for a request to a user who does not exist, does not take requests from you,
/// has too many pending requests, or blocked you.
pub const REFUSED: &str = "Could not send a friend request to that user.";
const YOU_BLOCKED: &str = "You blocked this user. Unblock them to add them as a friend.";
const SLOW_DOWN: &str = "Too many friend requests. Try again later.";

static REQUEST_PACE: LazyLock<Budget> =
    LazyLock::new(|| Budget::new(REQUESTS_PER_WINDOW, REQUEST_WINDOW, 100_000));
/// Request pings one sender may cause one recipient per hour; past it the request is still
/// stored, but the recipient is not pinged again.
const PAIR_PINGS: u32 = 3;
static PAIR_PACE: LazyLock<Budget> =
    LazyLock::new(|| Budget::new(PAIR_PINGS, Duration::from_secs(3600), 100_000));

/// Who may open a DM with you or write in one.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum DmPolicy {
    /// Anyone who has not been blocked.
    #[default]
    Everyone,
    /// Only your friends.
    Friends,
}

impl DmPolicy {
    fn as_str(self) -> &'static str {
        match self {
            DmPolicy::Everyone => "everyone",
            DmPolicy::Friends => "friends",
        }
    }

    fn parse(s: &str) -> DmPolicy {
        match s {
            "friends" => DmPolicy::Friends,
            _ => DmPolicy::Everyone,
        }
    }
}

/// Who may send you a friend request.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum RequestPolicy {
    /// Anyone who has not been blocked.
    #[default]
    Everyone,
    /// People who are a member of a server you are a member of.
    Servers,
    /// Nobody.
    Nobody,
}

impl RequestPolicy {
    fn as_str(self) -> &'static str {
        match self {
            RequestPolicy::Everyone => "everyone",
            RequestPolicy::Servers => "servers",
            RequestPolicy::Nobody => "nobody",
        }
    }

    fn parse(s: &str) -> RequestPolicy {
        match s {
            "servers" => RequestPolicy::Servers,
            "nobody" => RequestPolicy::Nobody,
            _ => RequestPolicy::Everyone,
        }
    }
}

/// Your privacy settings.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct Privacy {
    /// Who can DM you.
    pub dms: DmPolicy,
    /// Who can send you friend requests.
    pub friend_requests: RequestPolicy,
}

/// Privacy settings to change; missing fields stay as they are.
#[derive(Deserialize, ToSchema)]
pub struct PrivacyPatch {
    /// Who can DM you.
    dms: Option<DmPolicy>,
    /// Who can send you friend requests.
    friend_requests: Option<RequestPolicy>,
}

/// One of your friends.
#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct Friend {
    /// The friend.
    pub user: UserRef,
    /// When you became friends, Unix seconds.
    pub since: i64,
    /// Whether they have the site open (never for users who appear offline).
    pub online: bool,
}

/// A pending friend request.
#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct FriendRequest {
    /// The other user: the sender of an incoming request, the recipient of an outgoing one.
    pub user: UserRef,
    /// When the request was sent, Unix seconds.
    pub created_at: i64,
    /// `true` when the request was sent to you.
    pub incoming: bool,
}

/// How you and another user are connected.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum Relation {
    /// Not friends and no pending request.
    None,
    /// Friends.
    Friend,
    /// They sent you a request.
    Incoming,
    /// You sent them a request.
    Outgoing,
}

/// Your relation to a user.
#[derive(Serialize, Deserialize, ToSchema)]
pub struct Friendship {
    /// The relation.
    pub status: Relation,
}

/// What sending a friend request did.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum RequestStatus {
    /// The request is pending (also when it was pending already).
    Sent,
    /// They had sent you a request, so you are friends now.
    Accepted,
    /// You were friends already.
    Friends,
}

/// The answer to a friend request.
#[derive(Serialize, Deserialize, ToSchema)]
pub struct RequestOutcome {
    /// What happened.
    pub status: RequestStatus,
    /// The user the request went to.
    pub user: UserRef,
}

/// The user to send a friend request to.
#[derive(Deserialize, ToSchema)]
pub struct FriendReq {
    /// Username, case-insensitive; a leading `@` is ignored.
    #[schema(example = "bob")]
    username: String,
}

/// Counts for the friends badge.
#[derive(Serialize, Deserialize, ToSchema)]
pub struct FriendSummary {
    /// Pending requests sent to you.
    pub incoming: i64,
    /// Pending requests you sent.
    pub outgoing: i64,
    /// Unseen friend pings (requests and accepted requests).
    pub pings: i64,
    /// Highest unseen friend ping id; 0 when there is none.
    pub pings_until: i64,
}

/// Which friend pings were seen.
#[derive(Deserialize, ToSchema)]
pub struct SeenReq {
    /// Highest friend ping id the client showed; all unseen ones when missing.
    pings_until: Option<i64>,
}

/// Paging, search and filter for the friends list.
#[derive(Deserialize, IntoParams)]
pub struct FriendListQuery {
    /// Opaque cursor from the `X-Next-Cursor` header of the previous page. Empty means the first
    /// page.
    cursor: Option<String>,
    /// Page size, 1 to 50 (clamped), default 50.
    limit: Option<i64>,
    /// Only friends whose username or display name starts with this text, case-insensitive.
    #[param(example = "bo")]
    q: Option<String>,
    /// `true` lists only friends who are online.
    online: Option<bool>,
}

/// Paging for the friend request lists.
#[derive(Deserialize, IntoParams)]
pub struct RequestListQuery {
    /// `true` (default) for requests sent to you, `false` for requests you sent.
    incoming: Option<bool>,
    /// Opaque cursor from the `X-Next-Cursor` header of the previous page.
    cursor: Option<String>,
    /// Page size, 1 to 50 (clamped), default 50.
    limit: Option<i64>,
}

fn refused() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, REFUSED.to_string())
}

fn target_name(raw: &str) -> String {
    let t = raw.trim();
    t.strip_prefix('@').unwrap_or(t).trim().to_lowercase()
}

/// `user`'s privacy settings (the defaults when never set).
pub(crate) async fn privacy_of(db: &Db, user: &str) -> Result<Privacy, ApiError> {
    let row = sqlx::query("SELECT dms, friend_requests FROM privacy WHERE username = $1")
        .bind(user)
        .fetch_optional(db)
        .await?;
    Ok(match row {
        Some(r) => Privacy {
            dms: DmPolicy::parse(&r.try_get::<String, _>(0)?),
            friend_requests: RequestPolicy::parse(&r.try_get::<String, _>(1)?),
        },
        None => Privacy::default(),
    })
}

pub(crate) async fn are_friends(db: &Db, a: &str, b: &str) -> Result<bool, ApiError> {
    Ok(
        sqlx::query("SELECT 1 FROM friends WHERE username = $1 AND friend = $2")
            .bind(a)
            .bind(b)
            .fetch_optional(db)
            .await?
            .is_some(),
    )
}

async fn requested(db: &Db, sender: &str, recipient: &str) -> Result<bool, ApiError> {
    Ok(
        sqlx::query("SELECT 1 FROM friend_requests WHERE sender = $1 AND recipient = $2")
            .bind(sender)
            .bind(recipient)
            .fetch_optional(db)
            .await?
            .is_some(),
    )
}

/// Whether `user` takes DMs only from friends and `other` is not one. Part of
/// `blocks::check_dm`, the one DM guard, which asks it both ways.
pub(crate) async fn dm_refused(db: &Db, user: &str, other: &str) -> Result<bool, ApiError> {
    if privacy_of(db, user).await?.dms != DmPolicy::Friends {
        return Ok(false);
    }
    Ok(!are_friends(db, user, other).await?)
}

async fn count(db: &Db, sql: &'static str, user: &str) -> Result<i64, ApiError> {
    Ok(sqlx::query(sql)
        .bind(user)
        .fetch_one(db)
        .await?
        .try_get(0)?)
}

async fn appears_offline(db: &Db, user: &str) -> Result<bool, ApiError> {
    Ok(
        sqlx::query("SELECT appear_offline FROM users WHERE username = $1")
            .bind(user)
            .fetch_optional(db)
            .await?
            .map(|r| r.try_get::<i64, _>(0))
            .transpose()?
            .is_none_or(|v| v != 0),
    )
}

/// Whether friends see `user` online: the site-wide presence (connected anywhere, inside the
/// offline grace, not appearing offline), and not appearing offline in the database either.
async fn shown_online(state: &AppState, user: &str) -> Result<bool, ApiError> {
    Ok(state.hub.shown_anywhere(user) && !appears_offline(&state.db, user).await?)
}

async fn friend_of(state: &AppState, user: &User, since: i64) -> Result<Friend, ApiError> {
    Ok(Friend {
        user: UserRef::from_user(user),
        since,
        online: shown_online(state, &user.username).await?,
    })
}

/// Sends `friend_presence` for `user` to each of their friends connected to this instance.
/// Called for every `user_shown` the hub's replica emits (on every instance), so it follows the
/// site-wide presence: the offline grace, appear offline at once, the newest setting winning.
pub async fn tell_friends(state: &AppState, user: &str, online: bool) {
    let run = async {
        let rows = sqlx::query(
            "SELECT f.friend FROM friends f WHERE f.username = $1 AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.blocker = f.username AND b.blocked = f.friend) OR (b.blocker = f.friend AND b.blocked = f.username)) LIMIT $2",
        )
        .bind(user)
        .bind(FRIENDS_MAX)
        .fetch_all(&state.db)
        .await?;
        for r in &rows {
            let friend: String = r.try_get(0)?;
            if !state.hub.listens_here(&friend) {
                continue;
            }
            state.hub.deliver_local(WsEvent::FriendPresence {
                username: friend,
                friend: user.to_string(),
                online,
            });
        }
        Ok::<(), ApiError>(())
    };
    if let Err(ApiError(_, e)) = run.await {
        tracing::warn!("friend presence of {user} not sent: {e}");
    }
}

/// Unseen friend pings of `user`: count and highest id.
async fn unseen(db: &Db, user: &str) -> Result<(i64, i64), ApiError> {
    let r = sqlx::query(
        "SELECT COUNT(*), COALESCE(MAX(id), 0) FROM friend_pings WHERE username = $1 AND seen = 0",
    )
    .bind(user)
    .fetch_one(db)
    .await?;
    Ok((r.try_get(0)?, r.try_get(1)?))
}

/// Sends `user` a `ping_count` for the `friends` scope.
async fn announce_count(state: &AppState, user: &str) -> Result<(), ApiError> {
    let (pings, pings_until) = unseen(&state.db, user).await?;
    state.hub.broadcast(WsEvent::PingCount {
        username: user.to_string(),
        scope: FRIENDS_SCOPE.to_string(),
        pings,
        pings_until,
        thread_pings: Vec::new(),
    });
    Ok(())
}

/// Stores a friend ping for `recipient` and sends it as a `ping` event.
async fn ping(
    state: &AppState,
    recipient: &str,
    actor: &User,
    kind: PingKind,
) -> Result<(), ApiError> {
    if is_blocked(&state.db, recipient, &actor.username).await? {
        return Ok(());
    }
    let t = now();
    let id: i64 = sqlx::query(
        "INSERT INTO friend_pings(username, kind, actor, created_at) VALUES($1, $2, $3, $4) RETURNING id",
    )
    .bind(recipient)
    .bind(kind.as_str())
    .bind(&actor.username)
    .bind(t)
    .fetch_one(&state.db)
    .await?
    .try_get(0)?;
    sqlx::query(
        "DELETE FROM friend_pings WHERE username = $1 AND seen = 0 AND id <= (SELECT id FROM friend_pings WHERE username = $1 AND seen = 0 ORDER BY id DESC LIMIT 1 OFFSET $2)",
    )
    .bind(recipient)
    .bind(PINGS_KEPT)
    .execute(&state.db)
    .await?;
    state.hub.broadcast(WsEvent::Ping {
        username: recipient.to_string(),
        ping: Ping {
            id,
            kind,
            scope: FRIENDS_SCOPE.to_string(),
            server: None,
            message_id: 0,
            thread_root_id: None,
            actor: UserRef::from_user(actor),
            emoji: None,
            excerpt: String::new(),
            created_at: t,
        },
    });
    Ok(())
}

/// Removes the unseen friend pings `actor` caused for `recipient` (of `kind`, or all kinds) and
/// sends `recipient` the new count when any were removed.
async fn drop_pings(
    state: &AppState,
    recipient: &str,
    actor: &str,
    kind: Option<PingKind>,
) -> Result<(), ApiError> {
    let gone = sqlx::query(
        "DELETE FROM friend_pings WHERE username = $1 AND actor = $2 AND seen = 0 AND ($3 = '' OR kind = $3)",
    )
    .bind(recipient)
    .bind(actor)
    .bind(kind.map_or("", PingKind::as_str))
    .execute(&state.db)
    .await?
    .rows_affected();
    if gone > 0 {
        announce_count(state, recipient).await?;
    }
    Ok(())
}

/// Tells both users that the request between them is gone.
fn request_gone(state: &AppState, a: &str, b: &str) {
    for (username, other) in [(a, b), (b, a)] {
        state.hub.broadcast(WsEvent::FriendRequestRemoved {
            username: username.to_string(),
            other: other.to_string(),
        });
    }
}

/// Locks the `users` rows in name order on Postgres, so that requests, accepts and blocks
/// between the same users run one after the other. SQLite runs one writer at a time anyway.
pub(crate) async fn lock_users(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    db: &Db,
    users: &[&str],
) -> Result<(), ApiError> {
    if crate::db::is_sqlite(db) {
        return Ok(());
    }
    let mut sorted = users.to_vec();
    sorted.sort();
    sorted.dedup();
    for user in sorted {
        sqlx::query("SELECT username FROM users WHERE username = $1 FOR NO KEY UPDATE")
            .bind(user)
            .fetch_optional(&mut **tx)
            .await?;
    }
    Ok(())
}

async fn either_blocked(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    a: &str,
    b: &str,
) -> Result<bool, ApiError> {
    Ok(sqlx::query(
        "SELECT 1 FROM blocks WHERE (blocker = $1 AND blocked = $2) OR (blocker = $2 AND blocked = $1) LIMIT 1",
    )
    .bind(a)
    .bind(b)
    .fetch_optional(&mut **tx)
    .await?
    .is_some())
}

/// Makes `me` and `other` friends, taking `other`'s pending request to `me`. Fails when there is
/// no such request or either side is at the friends cap.
async fn befriend(state: &AppState, me: &User, other: &User) -> Result<Friend, ApiError> {
    let t = now();
    let mut tx = state.db.begin().await?;
    lock_users(&mut tx, &state.db, &[&me.username, &other.username]).await?;
    let taken = sqlx::query("DELETE FROM friend_requests WHERE sender = $1 AND recipient = $2")
        .bind(&other.username)
        .bind(&me.username)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if taken == 0 || either_blocked(&mut tx, &me.username, &other.username).await? {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "No friend request from this user".to_string(),
        ));
    }
    for (user, msg) in [
        (&me.username, "You can have at most 1000 friends"),
        (&other.username, "That user has too many friends"),
    ] {
        let n: i64 = sqlx::query("SELECT COUNT(*) FROM friends WHERE username = $1")
            .bind(user)
            .fetch_one(&mut *tx)
            .await?
            .try_get(0)?;
        if n >= FRIENDS_MAX {
            return Err(bad(msg));
        }
    }
    sqlx::query("DELETE FROM friend_requests WHERE sender = $1 AND recipient = $2")
        .bind(&me.username)
        .bind(&other.username)
        .execute(&mut *tx)
        .await?;
    for (a, b) in [
        (&me.username, &other.username),
        (&other.username, &me.username),
    ] {
        sqlx::query(
            "INSERT INTO friends(username, friend, created_at) VALUES($1, $2, $3) ON CONFLICT(username, friend) DO NOTHING",
        )
        .bind(a)
        .bind(b)
        .bind(t)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    request_gone(state, &me.username, &other.username);
    let theirs = friend_of(state, me, t).await?;
    let mine = friend_of(state, other, t).await?;
    state.hub.broadcast(WsEvent::FriendAdded {
        username: other.username.clone(),
        friend: theirs,
    });
    state.hub.broadcast(WsEvent::FriendAdded {
        username: me.username.clone(),
        friend: mine.clone(),
    });
    drop_pings(
        state,
        &me.username,
        &other.username,
        Some(PingKind::FriendRequest),
    )
    .await?;
    ping(state, &other.username, me, PingKind::FriendAccept).await?;
    Ok(mine)
}

/// What `end_rows` removed.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Ended {
    unfriended: bool,
    unrequested: bool,
}

/// Removes the friendship and pending requests both ways between `a` and `b` inside a block's
/// transaction, which holds both users' locks (`lock_users`). `end_events` announces it after
/// the commit.
pub(crate) async fn end_rows(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    a: &str,
    b: &str,
) -> Result<Ended, ApiError> {
    let unfriended = sqlx::query(
        "DELETE FROM friends WHERE (username = $1 AND friend = $2) OR (username = $2 AND friend = $1)",
    )
    .bind(a)
    .bind(b)
    .execute(&mut **tx)
    .await?
    .rows_affected();
    let unrequested = sqlx::query(
        "DELETE FROM friend_requests WHERE (sender = $1 AND recipient = $2) OR (sender = $2 AND recipient = $1)",
    )
    .bind(a)
    .bind(b)
    .execute(&mut **tx)
    .await?
    .rows_affected();
    Ok(Ended {
        unfriended: unfriended > 0,
        unrequested: unrequested > 0,
    })
}

/// The events for what `end_rows` removed, and the removal of unseen friend pings both ways.
pub(crate) async fn end_events(
    state: &AppState,
    a: &str,
    b: &str,
    ended: Ended,
) -> Result<(), ApiError> {
    let Ended {
        unfriended,
        unrequested,
    } = ended;
    if unfriended {
        unfriend_events(state, a, b);
    }
    if unrequested {
        request_gone(state, a, b);
    }
    drop_pings(state, a, b, None).await?;
    drop_pings(state, b, a, None).await
}

/// The users who must hear that a purged account is gone.
pub(crate) struct Gone {
    friends: Vec<String>,
    requests: Vec<String>,
    pinged: Vec<String>,
}

/// `user`'s friends, request partners both ways and the users holding unseen friend pings from
/// them, read inside the purge transaction before their rows go.
pub(crate) async fn gone_of(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    user: &str,
) -> sqlx::Result<Gone> {
    let mut names = async |sql: &'static str, cap: i64| -> sqlx::Result<Vec<String>> {
        sqlx::query(sql)
            .bind(user)
            .bind(cap)
            .fetch_all(&mut **tx)
            .await?
            .iter()
            .map(|r| r.try_get(0))
            .collect()
    };
    let friends = names(
        "SELECT friend FROM friends WHERE username = $1 LIMIT $2",
        FRIENDS_MAX,
    )
    .await?;
    let mut requests = names(
        "SELECT recipient FROM friend_requests WHERE sender = $1 LIMIT $2",
        OUTGOING_MAX,
    )
    .await?;
    requests.extend(
        names(
            "SELECT sender FROM friend_requests WHERE recipient = $1 LIMIT $2",
            INCOMING_MAX,
        )
        .await?,
    );
    let pinged = names(
        "SELECT DISTINCT username FROM friend_pings WHERE actor = $1 AND seen = 0 LIMIT $2",
        FRIENDS_MAX + INCOMING_MAX,
    )
    .await?;
    Ok(Gone {
        friends,
        requests,
        pinged,
    })
}

/// After a purge commits: `friend_removed`, `friend_request_removed` and the new friend ping
/// counts for everyone in `gone`.
pub(crate) async fn announce_gone(state: &AppState, user: &str, gone: Gone) {
    let Gone {
        friends,
        requests,
        pinged,
    } = gone;
    for friend in friends {
        state.hub.broadcast(WsEvent::FriendRemoved {
            username: friend,
            friend: user.to_string(),
        });
    }
    for other in requests {
        state.hub.broadcast(WsEvent::FriendRequestRemoved {
            username: other,
            other: user.to_string(),
        });
    }
    for username in pinged {
        if let Err(ApiError(_, e)) = announce_count(state, &username).await {
            tracing::warn!("friend ping count of {username} not sent: {e}");
        }
    }
}

fn unfriend_events(state: &AppState, a: &str, b: &str) {
    for (username, friend) in [(a, b), (b, a)] {
        state.hub.broadcast(WsEvent::FriendRemoved {
            username: username.to_string(),
            friend: friend.to_string(),
        });
    }
}

/// Send a friend request
///
/// Sends `username` a friend request from the signed-in user, after a check of their mini
/// profile (`GET /api/users/{username}/profile`) on the client. When they had already sent you a
/// request, this accepts it (`status` `accepted`); when you are friends already it changes
/// nothing (`friends`); sending a pending request again changes nothing (`sent`). A new request
/// emits `friend_request_added` to both users and a `ping` of kind `friend_request` (scope
/// `friends`) to the recipient. A user who does not exist, does not take requests from you (their
/// "Who can send you friend requests" setting), has 1000 pending requests, or blocked you, all
/// give the same `404`. At most 100 pending sent requests and 20 requests per 10 minutes.
/// Requires a bearer token. General rate-limit bucket.
#[utoipa::path(post, path = "/api/friends/requests", tag = "Friends", request_body = FriendReq, responses((status = 200, description = "Sent, accepted (they had asked you) or already friends", body = RequestOutcome), (status = 400, description = "`You cannot add yourself as a friend`, `You have too many pending friend requests`, `You can have at most 1000 friends` or `That user has too many friends`. Malformed JSON or a missing `Content-Type` give plain-text 400/415 framework errors", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 403, description = "You blocked this user", body = ApiErrorBody), (status = 404, description = "`Could not send a friend request to that user.`: no such user, or they do not take requests from you", body = ApiErrorBody), (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String), (status = 429, description = "`Too many friend requests. Try again later.` (JSON), or too many requests in the general bucket (plain text)", body = ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn send_request(
    State(state): State<AppState>,
    Authed(user): Authed,
    Json(req): Json<FriendReq>,
) -> Result<Json<RequestOutcome>, ApiError> {
    let FriendReq { username } = req;
    let target = target_name(&username);
    let pace = format!("{}\n{}", crate::db::pool_key(&state.db), user.username);
    if !REQUEST_PACE.take(&pace) {
        return Err(ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            SLOW_DOWN.to_string(),
        ));
    }
    if target == user.username {
        return Err(bad("You cannot add yourself as a friend"));
    }
    let Some(other) = get_user(&state.db, &target).await? else {
        return Err(refused());
    };
    if is_blocked(&state.db, &user.username, &other.username).await? {
        return Err(ApiError(StatusCode::FORBIDDEN, YOU_BLOCKED.to_string()));
    }
    let outcome = |status| {
        Ok(Json(RequestOutcome {
            status,
            user: UserRef::from_user(&other),
        }))
    };
    if are_friends(&state.db, &user.username, &other.username).await? {
        return outcome(RequestStatus::Friends);
    }
    let t = now();
    let mut tx = state.db.begin().await?;
    lock_users(&mut tx, &state.db, &[&user.username, &other.username]).await?;
    let added = sqlx::query(
        "INSERT INTO friend_requests(sender, recipient, created_at) SELECT $1, $2, $3 WHERE (SELECT COUNT(*) FROM friend_requests WHERE sender = $1) < $4 AND (SELECT COUNT(*) FROM friend_requests WHERE recipient = $2) < $5 AND NOT EXISTS(SELECT 1 FROM friend_requests WHERE sender = $2 AND recipient = $1) AND NOT EXISTS(SELECT 1 FROM friends WHERE username = $1 AND friend = $2) AND NOT EXISTS(SELECT 1 FROM blocks WHERE (blocker = $1 AND blocked = $2) OR (blocker = $2 AND blocked = $1)) AND (COALESCE((SELECT friend_requests FROM privacy WHERE username = $2), 'everyone') = 'everyone' OR (COALESCE((SELECT friend_requests FROM privacy WHERE username = $2), 'everyone') = 'servers' AND EXISTS(SELECT 1 FROM members x JOIN members y ON y.server = x.server WHERE x.username = $1 AND y.username = $2))) ON CONFLICT(sender, recipient) DO NOTHING",
    )
    .bind(&user.username)
    .bind(&other.username)
    .bind(t)
    .bind(OUTGOING_MAX)
    .bind(INCOMING_MAX)
    .execute(&mut *tx)
    .await?
    .rows_affected()
        > 0;
    tx.commit().await?;
    if !added {
        if requested(&state.db, &other.username, &user.username).await? {
            return match befriend(&state, &user, &other).await {
                Ok(_) => outcome(RequestStatus::Accepted),
                Err(ApiError(StatusCode::NOT_FOUND, _)) => Err(refused()),
                Err(e) => Err(e),
            };
        }
        if are_friends(&state.db, &user.username, &other.username).await? {
            return outcome(RequestStatus::Friends);
        }
        if requested(&state.db, &user.username, &other.username).await? {
            return outcome(RequestStatus::Sent);
        }
        if count(
            &state.db,
            "SELECT COUNT(*) FROM friend_requests WHERE sender = $1",
            &user.username,
        )
        .await?
            >= OUTGOING_MAX
        {
            return Err(bad("You have too many pending friend requests"));
        }
        return Err(refused());
    }
    for (to, about, incoming) in [(&user, &other, false), (&other, &user, true)] {
        state.hub.broadcast(WsEvent::FriendRequestAdded {
            username: to.username.clone(),
            request: FriendRequest {
                user: UserRef::from_user(about),
                created_at: t,
                incoming,
            },
        });
    }
    let pair = format!(
        "{}\n{}\n{}",
        crate::db::pool_key(&state.db),
        user.username,
        other.username
    );
    if PAIR_PACE.take(&pair) {
        ping(&state, &other.username, &user, PingKind::FriendRequest).await?;
    }
    outcome(RequestStatus::Sent)
}

/// Accept a friend request
///
/// Accepts the pending friend request `username` sent to the signed-in user. Emits
/// `friend_request_removed` and `friend_added` to both users and a `ping` of kind
/// `friend_accept` (scope `friends`) to `username`. Requires a bearer token. General rate-limit
/// bucket.
#[utoipa::path(post, path = "/api/friends/requests/{username}/accept", tag = "Friends", params(("username" = String, Path, description = "The sender, case-insensitive")), responses((status = 200, description = "The new friend", body = Friend), (status = 400, description = "`You can have at most 1000 friends` or `That user has too many friends`", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 404, description = "No friend request from this user", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn accept_request(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(username): Path<String>,
) -> Result<Json<Friend>, ApiError> {
    let missing = || {
        ApiError(
            StatusCode::NOT_FOUND,
            "No friend request from this user".to_string(),
        )
    };
    let Some(other) = get_user(&state.db, &target_name(&username)).await? else {
        return Err(missing());
    };
    Ok(Json(befriend(&state, &user, &other).await?))
}

async fn drop_request(
    state: &AppState,
    sender: &str,
    recipient: &str,
) -> Result<Json<OkResp>, ApiError> {
    let gone = sqlx::query("DELETE FROM friend_requests WHERE sender = $1 AND recipient = $2")
        .bind(sender)
        .bind(recipient)
        .execute(&state.db)
        .await?
        .rows_affected();
    if gone > 0 {
        request_gone(state, sender, recipient);
        drop_pings(state, recipient, sender, Some(PingKind::FriendRequest)).await?;
    }
    Ok(ok())
}

/// Deny a friend request
///
/// Removes the pending friend request `username` sent to the signed-in user. Emits
/// `friend_request_removed` to both users when there was one; denying again changes nothing.
/// Requires a bearer token. General rate-limit bucket.
#[utoipa::path(post, path = "/api/friends/requests/{username}/deny", tag = "Friends", params(("username" = String, Path, description = "The sender, case-insensitive")), responses((status = 200, description = "No request from them is pending; body `{\"ok\": true}`", body = OkResp), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn deny_request(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(username): Path<String>,
) -> Result<Json<OkResp>, ApiError> {
    drop_request(&state, &target_name(&username), &user.username).await
}

/// Cancel a friend request
///
/// Takes back the signed-in user's pending friend request to `username`. Emits
/// `friend_request_removed` to both users when there was one, and removes the recipient's unseen
/// ping for it. Requires a bearer token. General rate-limit bucket.
#[utoipa::path(delete, path = "/api/friends/requests/{username}", tag = "Friends", params(("username" = String, Path, description = "The recipient, case-insensitive")), responses((status = 200, description = "No request to them is pending; body `{\"ok\": true}`", body = OkResp), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn cancel_request(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(username): Path<String>,
) -> Result<Json<OkResp>, ApiError> {
    drop_request(&state, &user.username, &target_name(&username)).await
}

/// Remove a friend
///
/// Ends the signed-in user's friendship with `username`. Emits `friend_removed` to both users
/// when they were friends; removing again changes nothing. Requires a bearer token. General
/// rate-limit bucket.
#[utoipa::path(delete, path = "/api/users/{username}/friendship", tag = "Friends", params(("username" = String, Path, description = "Username, case-insensitive")), responses((status = 200, description = "Not friends anymore; body `{\"ok\": true}`", body = OkResp), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn remove_friend(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(username): Path<String>,
) -> Result<Json<OkResp>, ApiError> {
    let other = target_name(&username);
    let gone = sqlx::query(
        "DELETE FROM friends WHERE (username = $1 AND friend = $2) OR (username = $2 AND friend = $1)",
    )
    .bind(&user.username)
    .bind(&other)
    .execute(&state.db)
    .await?
    .rows_affected();
    if gone > 0 {
        unfriend_events(&state, &user.username, &other);
        for (to, from) in [
            (other.as_str(), user.username.as_str()),
            (user.username.as_str(), other.as_str()),
        ] {
            drop_pings(&state, to, from, Some(PingKind::FriendAccept)).await?;
        }
    }
    Ok(ok())
}

/// Get your relation to a user
///
/// Whether the signed-in user and `username` are friends or have a pending request between
/// them. Unknown users give `none`. Requires a bearer token. General rate-limit bucket.
#[utoipa::path(get, path = "/api/users/{username}/friendship", tag = "Friends", params(("username" = String, Path, description = "Username, case-insensitive")), responses((status = 200, description = "The relation", body = Friendship), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn friendship(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(username): Path<String>,
) -> Result<Json<Friendship>, ApiError> {
    let db = state.read();
    let other = target_name(&username);
    let status = if are_friends(&db, &user.username, &other).await? {
        Relation::Friend
    } else if requested(&db, &other, &user.username).await? {
        Relation::Incoming
    } else if requested(&db, &user.username, &other).await? {
        Relation::Outgoing
    } else {
        Relation::None
    };
    Ok(Json(Friendship { status }))
}

fn user_at(r: &sqlx::any::AnyRow) -> Result<UserRef, ApiError> {
    Ok(UserRef {
        username: r.try_get(0)?,
        display_name: r.try_get(1)?,
        avatar_kind: AvatarKind::parse(&r.try_get::<String, _>(2)?)?,
        avatar_color: r.try_get(3)?,
    })
}

pub(crate) async fn friend_page(
    state: &AppState,
    viewer: &str,
    q: &str,
    online_only: bool,
    cursor: Option<&str>,
    limit: i64,
) -> Result<(Vec<Friend>, Option<String>), ApiError> {
    let db = state.read();
    let base = "SELECT f.friend, u.display_name, u.avatar_kind, u.avatar_color, f.created_at, u.appear_offline, lower(u.display_name) FROM friends f JOIN users u ON u.username = f.friend WHERE f.username = $1 AND u.password_hash <> '!purging' AND (lower(u.username) LIKE $2 ESCAPE '\\' OR lower(u.display_name) LIKE $2 ESCAPE '\\')";
    let order = "ORDER BY lower(u.display_name), f.friend";
    let pattern = prefix_pattern(&q.trim().to_lowercase());
    let take = match online_only {
        true => FRIENDS_MAX + 1,
        false => limit + 1,
    };
    let rows = match cursor {
        Some(raw) => {
            let parts = decode_cursor(raw, 2)?;
            let sql =
                format!("{base} AND (lower(u.display_name), f.friend) > ($3, $4) {order} LIMIT $5");
            sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(viewer)
                .bind(&pattern)
                .bind(&parts[0])
                .bind(&parts[1])
                .bind(take)
                .fetch_all(&db)
                .await?
        }
        None => {
            let sql = format!("{base} {order} LIMIT $3");
            sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(viewer)
                .bind(&pattern)
                .bind(take)
                .fetch_all(&db)
                .await?
        }
    };
    let mut out = Vec::with_capacity(rows.len().min(limit as usize + 1));
    let mut keys = Vec::with_capacity(out.capacity());
    for r in &rows {
        let user = user_at(r)?;
        let online = r.try_get::<i64, _>(5)? == 0 && state.hub.shown_anywhere(&user.username);
        if online_only && !online {
            continue;
        }
        keys.push(r.try_get::<String, _>(6)?);
        out.push(Friend {
            user,
            since: r.try_get(4)?,
            online,
        });
        if out.len() as i64 > limit {
            break;
        }
    }
    let more = out.len() as i64 > limit;
    out.truncate(limit as usize);
    let next = match (more, out.last()) {
        (true, Some(last)) => Some(encode_cursor(&[&keys[out.len() - 1], &last.user.username])),
        _ => None,
    };
    Ok((out, next))
}

/// List friends
///
/// Returns the signed-in user's friends sorted by display name, a page at a time (default and
/// max 50), optionally only those whose username or display name starts with `q`, and only
/// those online with `online=true`. Each friend carries their online state; `friend_presence`
/// events keep it current. Requires a bearer token. General rate-limit bucket.
#[utoipa::path(get, path = "/api/friends", tag = "Friends", params(FriendListQuery), responses((status = 200, description = "A page of friends, by display name", body = Vec<Friend>, headers(("x-next-cursor" = String, description = "Cursor for the next page; absent on the last page"))), (status = 400, description = "Invalid cursor (JSON), or a non-integer `limit` (plain-text framework error)", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn list_friends(
    State(state): State<AppState>,
    Authed(user): Authed,
    Query(q): Query<FriendListQuery>,
) -> Result<Paged<Friend>, ApiError> {
    let FriendListQuery {
        cursor,
        limit,
        q,
        online,
    } = q;
    let cursor = cursor.as_deref().filter(|c| !c.trim().is_empty());
    let limit = limit.unwrap_or(PAGE).clamp(1, PAGE);
    let (items, next) = friend_page(
        &state,
        &user.username,
        q.as_deref().unwrap_or(""),
        online.unwrap_or(false),
        cursor,
        limit,
    )
    .await?;
    Ok(Paged(items, next))
}

/// List friend requests
///
/// Returns the signed-in user's pending friend requests, newest first, a page at a time
/// (default and max 50): those sent to them (`incoming=true`, the default) or those they sent
/// (`incoming=false`). Requires a bearer token. General rate-limit bucket.
#[utoipa::path(get, path = "/api/friends/requests", tag = "Friends", params(RequestListQuery), responses((status = 200, description = "A page of pending requests, newest first", body = Vec<FriendRequest>, headers(("x-next-cursor" = String, description = "Cursor for the next page; absent on the last page"))), (status = 400, description = "Invalid cursor (JSON), or a non-integer `limit` (plain-text framework error)", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn list_requests(
    State(state): State<AppState>,
    Authed(user): Authed,
    Query(q): Query<RequestListQuery>,
) -> Result<Paged<FriendRequest>, ApiError> {
    let RequestListQuery {
        incoming,
        cursor,
        limit,
    } = q;
    let incoming = incoming.unwrap_or(true);
    let limit = limit.unwrap_or(PAGE).clamp(1, PAGE);
    let (me, other) = match incoming {
        true => ("r.recipient", "r.sender"),
        false => ("r.sender", "r.recipient"),
    };
    let base = format!(
        "SELECT {other}, u.display_name, u.avatar_kind, u.avatar_color, r.created_at FROM friend_requests r JOIN users u ON u.username = {other} WHERE {me} = $1 AND u.password_hash <> '!purging'"
    );
    let order = format!("ORDER BY r.created_at DESC, {other} DESC");
    let db = state.read();
    let rows = match cursor.as_deref().filter(|c| !c.trim().is_empty()) {
        Some(raw) => {
            let parts = decode_cursor(raw, 2)?;
            let sql = format!("{base} AND (r.created_at, {other}) < ($2, $3) {order} LIMIT $4");
            sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(&user.username)
                .bind(cursor_int(&parts[0])?)
                .bind(&parts[1])
                .bind(limit + 1)
                .fetch_all(&db)
                .await?
        }
        None => {
            let sql = format!("{base} {order} LIMIT $2");
            sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(&user.username)
                .bind(limit + 1)
                .fetch_all(&db)
                .await?
        }
    };
    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        out.push(FriendRequest {
            user: user_at(r)?,
            created_at: r.try_get(4)?,
            incoming,
        });
    }
    let more = out.len() as i64 > limit;
    out.truncate(limit as usize);
    let next = match (more, out.last()) {
        (true, Some(last)) => Some(encode_cursor(&[
            &last.created_at.to_string(),
            &last.user.username,
        ])),
        _ => None,
    };
    Ok(Paged(out, next))
}

/// Friend counts
///
/// Pending request counts both ways and the unseen friend pings (requests and accepted
/// requests) of the signed-in user, for the friends badge. Requires a bearer token. General
/// rate-limit bucket.
#[utoipa::path(get, path = "/api/friends/summary", tag = "Friends", responses((status = 200, description = "Counts", body = FriendSummary), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn summary(
    State(state): State<AppState>,
    Authed(user): Authed,
) -> Result<Json<FriendSummary>, ApiError> {
    let db = state.read();
    let incoming = count(
        &db,
        "SELECT COUNT(*) FROM friend_requests r JOIN users u ON u.username = r.sender WHERE r.recipient = $1 AND u.password_hash <> '!purging'",
        &user.username,
    )
    .await?;
    let outgoing = count(
        &db,
        "SELECT COUNT(*) FROM friend_requests r JOIN users u ON u.username = r.recipient WHERE r.sender = $1 AND u.password_hash <> '!purging'",
        &user.username,
    )
    .await?;
    let (pings, pings_until) = unseen(&db, &user.username).await?;
    Ok(Json(FriendSummary {
        incoming,
        outgoing,
        pings,
        pings_until,
    }))
}

/// Mark friend pings seen
///
/// Marks the signed-in user's unseen friend pings (ids up to `pings_until`, or all) seen and
/// sends their connections a `ping_count` for the `friends` scope when any changed. Requires a
/// bearer token. General rate-limit bucket.
#[utoipa::path(post, path = "/api/friends/seen", tag = "Friends", request_body = SeenReq, responses((status = 200, description = "Seen; body `{\"ok\": true}`", body = OkResp), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn mark_seen(
    State(state): State<AppState>,
    Authed(user): Authed,
    Json(req): Json<SeenReq>,
) -> Result<Json<OkResp>, ApiError> {
    let SeenReq { pings_until } = req;
    let t = now();
    let changed = sqlx::query(
        "UPDATE friend_pings SET seen = 1 WHERE username = $1 AND seen = 0 AND id <= $2",
    )
    .bind(&user.username)
    .bind(pings_until.unwrap_or(i64::MAX))
    .execute(&state.db)
    .await?
    .rows_affected();
    sqlx::query("DELETE FROM friend_pings WHERE username = $1 AND seen = 1 AND created_at < $2")
        .bind(&user.username)
        .bind(t - SEEN_KEPT)
        .execute(&state.db)
        .await?;
    if changed > 0 {
        announce_count(&state, &user.username).await?;
    }
    Ok(ok())
}

/// Get privacy settings
///
/// Who can DM the signed-in user and who can send them friend requests. Requires a bearer token.
/// General rate-limit bucket.
#[utoipa::path(get, path = "/api/me/privacy", tag = "Friends", responses((status = 200, description = "The settings", body = Privacy), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn get_privacy(
    State(state): State<AppState>,
    Authed(user): Authed,
) -> Result<Json<Privacy>, ApiError> {
    Ok(Json(privacy_of(&state.read(), &user.username).await?))
}

/// Change privacy settings
///
/// `dms`: `everyone` or `friends`. With `friends`, only friends can open a DM with you or write,
/// react, pin, call or type in one (others get `403` `This user is not accepting messages from
/// you.`, the same as a block), and it works both ways: you can only do those with friends too
/// (`403` `You only accept DMs from friends. Change this in Settings > Privacy.`). `friend_requests`: `everyone`, `servers` (people who share a
/// server with you) or `nobody`. Emits `privacy_changed` to your connections. Requires a bearer
/// token. General rate-limit bucket.
#[utoipa::path(patch, path = "/api/me/privacy", tag = "Friends", request_body = PrivacyPatch, responses((status = 200, description = "The stored settings", body = Privacy), (status = 400, description = "Malformed JSON or a missing `Content-Type` (plain-text framework errors)", content_type = "text/plain", body = String), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 422, description = "An unknown value (plain-text framework error)", content_type = "text/plain", body = String), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security(("bearer" = [])))]
pub(crate) async fn patch_privacy(
    State(state): State<AppState>,
    Authed(user): Authed,
    Json(patch): Json<PrivacyPatch>,
) -> Result<Json<Privacy>, ApiError> {
    let PrivacyPatch {
        dms,
        friend_requests,
    } = patch;
    let cur = privacy_of(&state.db, &user.username).await?;
    let next = Privacy {
        dms: dms.unwrap_or(cur.dms),
        friend_requests: friend_requests.unwrap_or(cur.friend_requests),
    };
    if next == cur {
        return Ok(Json(cur));
    }
    sqlx::query(
        "INSERT INTO privacy(username, dms, friend_requests) VALUES($1, $2, $3) ON CONFLICT(username) DO UPDATE SET dms = excluded.dms, friend_requests = excluded.friend_requests",
    )
    .bind(&user.username)
    .bind(next.dms.as_str())
    .bind(next.friend_requests.as_str())
    .execute(&state.db)
    .await?;
    state.hub.broadcast(WsEvent::PrivacyChanged {
        username: user.username.clone(),
        privacy: next,
    });
    Ok(Json(next))
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use axum::extract::{Path, Query, State};
    use serde_json::json;

    use super::*;
    use crate::api::blocks::{BlockReq, NOT_ACCEPTING, YOU_FRIENDS_ONLY, block_user, check_dm};
    use crate::api::dms::open_dm;
    use crate::api::messages::send_dm_message;
    use crate::api::test_util::{add_member, done, mem_user, temp_state};
    use crate::fanout::Topic;

    async fn add_user(db: &Db, name: &str, display: &str) {
        sqlx::query("INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, created_at) VALUES($1, $2, '', 'text', 'identicon', 1)")
            .bind(name)
            .bind(display)
            .execute(db)
            .await
            .expect("user");
    }

    fn me(name: &str) -> Authed {
        Authed(mem_user(name, false))
    }

    async fn send(state: &AppState, by: &str, name: &str) -> Result<RequestStatus, ApiError> {
        send_request(
            State(state.clone()),
            me(by),
            Json(FriendReq {
                username: name.to_string(),
            }),
        )
        .await
        .map(|Json(o)| o.status)
    }

    async fn relation(state: &AppState, by: &str, name: &str) -> Relation {
        friendship(State(state.clone()), me(by), Path(name.to_string()))
            .await
            .expect("relation")
            .0
            .status
    }

    async fn friends(state: &AppState, by: &str) -> Vec<String> {
        let Paged(items, _) = list_friends(
            State(state.clone()),
            me(by),
            Query(FriendListQuery {
                cursor: None,
                limit: None,
                q: None,
                online: None,
            }),
        )
        .await
        .expect("friends");
        items.into_iter().map(|f| f.user.username).collect()
    }

    async fn requests(state: &AppState, by: &str, incoming: bool) -> Vec<String> {
        let Paged(items, _) = list_requests(
            State(state.clone()),
            me(by),
            Query(RequestListQuery {
                incoming: Some(incoming),
                cursor: None,
                limit: None,
            }),
        )
        .await
        .expect("requests");
        items.into_iter().map(|r| r.user.username).collect()
    }

    async fn sum(state: &AppState, by: &str) -> (i64, i64, i64) {
        let Json(s) = summary(State(state.clone()), me(by))
            .await
            .expect("summary");
        (s.incoming, s.outgoing, s.pings)
    }

    fn code(res: Result<impl Sized, ApiError>) -> Option<(StatusCode, String)> {
        res.err().map(|ApiError(code, text)| (code, text))
    }

    fn drain(rx: &mut tokio::sync::broadcast::Receiver<WsEvent>) -> Vec<String> {
        std::iter::from_fn(|| rx.try_recv().ok())
            .filter_map(|ev| match ev {
                WsEvent::FriendRequestAdded { username, request } => Some(format!(
                    "request {username} {} {}",
                    request.user.username,
                    match request.incoming {
                        true => "in",
                        false => "out",
                    }
                )),
                WsEvent::FriendRequestRemoved { username, other } => {
                    Some(format!("unrequest {username} {other}"))
                }
                WsEvent::FriendAdded { username, friend } => {
                    Some(format!("friend {username} {}", friend.user.username))
                }
                WsEvent::FriendRemoved { username, friend } => {
                    Some(format!("unfriend {username} {friend}"))
                }
                WsEvent::FriendPresence {
                    username,
                    friend,
                    online,
                } => Some(format!("presence {username} {friend} {online}")),
                WsEvent::Ping { username, ping } => Some(format!(
                    "ping {username} {} {} {}",
                    ping.kind.as_str(),
                    ping.scope,
                    ping.actor.username
                )),
                WsEvent::PingCount {
                    username,
                    scope,
                    pings,
                    ..
                } => Some(format!("count {username} {scope} {pings}")),
                WsEvent::PrivacyChanged { username, privacy } => Some(format!(
                    "privacy {username} {} {}",
                    privacy.dms.as_str(),
                    privacy.friend_requests.as_str()
                )),
                _ => None,
            })
            .collect()
    }

    async fn set_privacy(state: &AppState, by: &str, body: serde_json::Value) -> Privacy {
        patch_privacy(
            State(state.clone()),
            me(by),
            Json(serde_json::from_value(body).expect("patch")),
        )
        .await
        .expect("privacy")
        .0
    }

    #[tokio::test]
    async fn requests_accept_deny_cancel_and_remove() {
        let (state, path) = temp_state("friends_flow").await;
        for (name, display) in [
            ("alice", "Alice"),
            ("bob", "Bob"),
            ("carol", "Carol"),
            ("dave", "Dave"),
        ] {
            add_user(&state.db, name, display).await;
        }
        let mut rx = state.hub.subscribe();
        assert_eq!(
            send(&state, "alice", "@Bob ").await.ok(),
            Some(RequestStatus::Sent)
        );
        assert_eq!(
            drain(&mut rx),
            [
                "request alice bob out",
                "request bob alice in",
                "ping bob friend_request friends alice"
            ]
        );
        assert_eq!(
            send(&state, "alice", "bob").await.ok(),
            Some(RequestStatus::Sent)
        );
        assert!(drain(&mut rx).is_empty(), "a repeat sends nothing");
        assert_eq!(relation(&state, "alice", "bob").await, Relation::Outgoing);
        assert_eq!(relation(&state, "bob", "ALICE").await, Relation::Incoming);
        assert_eq!(relation(&state, "bob", "carol").await, Relation::None);
        assert_eq!(requests(&state, "bob", true).await, ["alice"]);
        assert_eq!(requests(&state, "alice", false).await, ["bob"]);
        assert!(requests(&state, "alice", true).await.is_empty());
        assert_eq!(sum(&state, "bob").await, (1, 0, 1));
        assert_eq!(sum(&state, "alice").await, (0, 1, 0));

        let Json(friend) = accept_request(State(state.clone()), me("bob"), Path("alice".into()))
            .await
            .expect("accept");
        assert_eq!(
            (friend.user.username.as_str(), friend.online),
            ("alice", false)
        );
        assert_eq!(
            drain(&mut rx),
            [
                "unrequest bob alice",
                "unrequest alice bob",
                "friend alice bob",
                "friend bob alice",
                "count bob friends 0",
                "ping alice friend_accept friends bob"
            ]
        );
        assert_eq!(friends(&state, "alice").await, ["bob"]);
        assert_eq!(friends(&state, "bob").await, ["alice"]);
        assert_eq!(relation(&state, "bob", "alice").await, Relation::Friend);
        assert_eq!(sum(&state, "bob").await, (0, 0, 0));
        assert_eq!(sum(&state, "alice").await, (0, 0, 1));
        assert_eq!(
            send(&state, "bob", "alice").await.ok(),
            Some(RequestStatus::Friends)
        );
        assert_eq!(
            code(accept_request(State(state.clone()), me("bob"), Path("carol".into())).await),
            Some((
                StatusCode::NOT_FOUND,
                "No friend request from this user".to_string()
            ))
        );
        let _ = mark_seen(
            State(state.clone()),
            me("alice"),
            Json(SeenReq { pings_until: None }),
        )
        .await
        .expect("seen");
        assert_eq!(sum(&state, "alice").await, (0, 0, 0));
        assert_eq!(drain(&mut rx), ["count alice friends 0"]);

        send(&state, "carol", "alice").await.expect("carol asks");
        drain(&mut rx);
        let _ = deny_request(State(state.clone()), me("alice"), Path("Carol".into()))
            .await
            .expect("deny");
        assert_eq!(
            drain(&mut rx),
            [
                "unrequest carol alice",
                "unrequest alice carol",
                "count alice friends 0"
            ]
        );
        let _ = deny_request(State(state.clone()), me("alice"), Path("carol".into()))
            .await
            .expect("deny again");
        assert!(drain(&mut rx).is_empty());
        assert_eq!(relation(&state, "carol", "alice").await, Relation::None);

        send(&state, "alice", "dave").await.expect("to dave");
        drain(&mut rx);
        let _ = cancel_request(State(state.clone()), me("alice"), Path("dave".into()))
            .await
            .expect("cancel");
        assert_eq!(
            drain(&mut rx),
            [
                "unrequest alice dave",
                "unrequest dave alice",
                "count dave friends 0"
            ]
        );
        assert_eq!(sum(&state, "dave").await, (0, 0, 0));

        send(&state, "dave", "carol").await.expect("dave asks");
        assert_eq!(
            send(&state, "carol", "dave").await.ok(),
            Some(RequestStatus::Accepted),
            "asking back accepts"
        );
        assert_eq!(friends(&state, "carol").await, ["dave"]);
        drain(&mut rx);

        let _ = remove_friend(State(state.clone()), me("bob"), Path("alice".into()))
            .await
            .expect("remove");
        assert_eq!(drain(&mut rx), ["unfriend bob alice", "unfriend alice bob"]);
        let _ = remove_friend(State(state.clone()), me("bob"), Path("alice".into()))
            .await
            .expect("again");
        assert!(drain(&mut rx).is_empty());
        assert!(friends(&state, "alice").await.is_empty());
        done(state, path).await;
    }

    #[tokio::test]
    async fn list_pages_searches_and_shows_online() {
        let (state, path) = temp_state("friends_list").await;
        add_user(&state.db, "alice", "Alice").await;
        for i in 0..55 {
            let name = format!("u{i:02}");
            add_user(&state.db, &name, &format!("Pal {i:02}")).await;
            for (a, b) in [("alice", name.as_str()), (name.as_str(), "alice")] {
                sqlx::query("INSERT INTO friends(username, friend, created_at) VALUES($1, $2, 1)")
                    .bind(a)
                    .bind(b)
                    .execute(&state.db)
                    .await
                    .expect("friend");
            }
        }
        add_user(&state.db, "zed", "Aaron_%").await;
        sqlx::query("INSERT INTO friends(username, friend, created_at) VALUES('alice', 'zed', 1)")
            .execute(&state.db)
            .await
            .expect("zed");
        let page = |q: Option<&str>, online: Option<bool>, cursor: Option<String>| {
            let state = state.clone();
            let q = q.map(str::to_string);
            async move {
                let Paged(items, next) = list_friends(
                    State(state),
                    me("alice"),
                    Query(FriendListQuery {
                        cursor,
                        limit: None,
                        q,
                        online,
                    }),
                )
                .await
                .expect("page");
                (
                    items
                        .into_iter()
                        .map(|f| (f.user.username, f.online))
                        .collect::<Vec<_>>(),
                    next,
                )
            }
        };
        let (first, next) = page(None, None, None).await;
        assert_eq!(first.len(), 50);
        assert_eq!(first[0].0, "zed", "sorted by display name");
        assert_eq!(first[1].0, "u00");
        let (rest, end) = page(None, None, next).await;
        assert_eq!(rest.len(), 6);
        assert_eq!(rest.last().map(|r| r.0.as_str()), Some("u54"));
        assert!(end.is_none());
        let all: HashSet<String> = first
            .iter()
            .chain(rest.iter())
            .map(|r| r.0.clone())
            .collect();
        assert_eq!(all.len(), 56);
        assert_eq!(page(Some("pal 5"), None, None).await.0.len(), 5);
        assert_eq!(page(Some("U1"), None, None).await.0.len(), 10);
        assert_eq!(page(Some("aaron_%"), None, None).await.0.len(), 1);
        assert!(page(Some("%"), None, None).await.0.is_empty());

        let _a = state
            .hub
            .open(1, &HashSet::from([Topic::User("u07".into())]));
        let _b = state
            .hub
            .open(2, &HashSet::from([Topic::User("u31".into())]));
        let _c = state
            .hub
            .open(3, &HashSet::from([Topic::User("u40".into())]));
        for (i, name) in ["u07", "u31", "u40"].into_iter().enumerate() {
            state.hub.set_online(name, i as u64 + 1, &[] as &[&str]);
        }
        sqlx::query("UPDATE users SET appear_offline = 1 WHERE username = 'u40'")
            .execute(&state.db)
            .await
            .expect("hidden");
        let (online, end) = page(None, Some(true), None).await;
        assert_eq!(
            online,
            [("u07".to_string(), true), ("u31".to_string(), true)]
        );
        assert!(end.is_none());
        let (shown, _) = page(Some("pal 07"), None, None).await;
        assert_eq!(shown, [("u07".to_string(), true)]);
        assert!(!page(Some("pal 40"), None, None).await.0[0].1);
        done(state, path).await;
    }

    #[tokio::test]
    async fn refusals_are_uniform_and_requests_are_capped() {
        let (state, path) = temp_state("friends_refuse").await;
        for name in ["alice", "bob", "carol", "dave", "erin", "fay"] {
            add_user(&state.db, name, name).await;
        }
        let refused = Some((StatusCode::NOT_FOUND, REFUSED.to_string()));
        assert_eq!(code(send(&state, "alice", "nobody").await), refused);
        assert_eq!(
            code(send(&state, "alice", "@alice").await),
            Some((
                StatusCode::BAD_REQUEST,
                "You cannot add yourself as a friend".to_string()
            ))
        );
        let mut rx = state.hub.subscribe();
        assert_eq!(
            set_privacy(&state, "bob", json!({ "friend_requests": "nobody" })).await,
            Privacy {
                dms: DmPolicy::Everyone,
                friend_requests: RequestPolicy::Nobody
            }
        );
        assert_eq!(drain(&mut rx), ["privacy bob everyone nobody"]);
        set_privacy(&state, "bob", json!({ "friend_requests": "nobody" })).await;
        assert!(drain(&mut rx).is_empty(), "no change, no event");
        assert_eq!(code(send(&state, "alice", "bob").await), refused);
        set_privacy(&state, "carol", json!({ "friend_requests": "servers" })).await;
        assert_eq!(code(send(&state, "alice", "carol").await), refused);
        add_member(&state.db, "rchat", "alice", 0, 0, 1).await;
        add_member(&state.db, "rchat", "carol", 0, 0, 1).await;
        assert_eq!(
            send(&state, "alice", "carol").await.ok(),
            Some(RequestStatus::Sent)
        );
        let _ = block_user(
            State(state.clone()),
            me("dave"),
            Json(serde_json::from_value::<BlockReq>(json!({ "username": "alice" })).expect("req")),
        )
        .await
        .expect("dave blocks alice");
        assert_eq!(code(send(&state, "alice", "dave").await), refused);
        assert_eq!(
            code(send(&state, "dave", "alice").await),
            Some((StatusCode::FORBIDDEN, YOU_BLOCKED.to_string()))
        );
        assert_eq!(relation(&state, "dave", "alice").await, Relation::None);
        assert!(drain(&mut rx).iter().all(|e| !e.contains("dave")));

        sqlx::query("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 99) INSERT INTO friend_requests(sender, recipient, created_at) SELECT 'alice', 'x' || i, 0 FROM n")
            .execute(&state.db)
            .await
            .expect("fill");
        assert_eq!(
            code(send(&state, "alice", "erin").await),
            Some((
                StatusCode::BAD_REQUEST,
                "You have too many pending friend requests".to_string()
            ))
        );
        sqlx::query("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000) INSERT INTO friend_requests(sender, recipient, created_at) SELECT 'y' || i, 'fay', 0 FROM n")
            .execute(&state.db)
            .await
            .expect("fill fay");
        assert_eq!(code(send(&state, "erin", "fay").await), refused);

        let mut last = None;
        for _ in 0..REQUESTS_PER_WINDOW {
            last = code(send(&state, "erin", "nobody").await);
        }
        assert_eq!(
            last,
            Some((StatusCode::TOO_MANY_REQUESTS, SLOW_DOWN.to_string())),
            "failed requests count toward the pace"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn blocking_ends_friendship_and_requests() {
        let (state, path) = temp_state("friends_block").await;
        for name in ["alice", "bob", "carol"] {
            add_user(&state.db, name, name).await;
        }
        send(&state, "alice", "bob").await.expect("ask");
        let _ = accept_request(State(state.clone()), me("bob"), Path("alice".into()))
            .await
            .expect("accept");
        send(&state, "carol", "alice").await.expect("carol asks");
        send(&state, "alice", "carol").await.ok();
        let _ = remove_friend(State(state.clone()), me("alice"), Path("carol".into()))
            .await
            .expect("unfriend carol");
        send(&state, "carol", "alice")
            .await
            .expect("carol asks again");
        let mut rx = state.hub.subscribe();
        let block = |by: &str, name: &str| {
            block_user(
                State(state.clone()),
                me(by),
                Json(serde_json::from_value::<BlockReq>(json!({ "username": name })).expect("req")),
            )
        };
        let _ = block("bob", "alice").await.expect("block");
        let evs = drain(&mut rx);
        assert!(evs.contains(&"unfriend bob alice".to_string()), "{evs:?}");
        assert!(evs.contains(&"unfriend alice bob".to_string()), "{evs:?}");
        assert!(
            evs.contains(&"count alice friends 1".to_string()),
            "bob's accept ping is gone, carol's request stays: {evs:?}"
        );
        assert!(friends(&state, "alice").await.is_empty());
        assert_eq!(
            code(send(&state, "alice", "bob").await),
            Some((StatusCode::NOT_FOUND, REFUSED.to_string()))
        );
        let _ = block("alice", "carol").await.expect("block carol");
        let evs = drain(&mut rx);
        assert!(
            evs.contains(&"unrequest alice carol".to_string()),
            "{evs:?}"
        );
        assert!(
            evs.contains(&"count alice friends 0".to_string()),
            "{evs:?}"
        );
        assert!(requests(&state, "alice", true).await.is_empty());
        assert_eq!(sum(&state, "alice").await, (0, 0, 0));
        done(state, path).await;
    }

    #[tokio::test]
    async fn friends_only_dms_go_through_the_dm_guard() {
        let (state, path) = temp_state("friends_dms").await;
        for name in ["alice", "bob", "carol"] {
            add_user(&state.db, name, name).await;
        }
        let open = |by: &str, name: &str| {
            open_dm(
                State(state.clone()),
                me(by),
                Json(serde_json::from_value(json!({ "username": name })).expect("req")),
            )
        };
        let say = |by: &str, id: i64| {
            send_dm_message(
                State(state.clone()),
                Path(id),
                me(by),
                Json(serde_json::from_value(json!({ "content": "hi" })).expect("req")),
            )
        };
        let old = open("alice", "bob").await.expect("dm").0;
        set_privacy(&state, "bob", json!({ "dms": "friends" })).await;
        let refused = Some((StatusCode::FORBIDDEN, NOT_ACCEPTING.to_string()));
        assert_eq!(code(say("alice", old.id).await), refused);
        assert_eq!(code(open("carol", "bob").await), refused);
        let none: i64 =
            sqlx::query("SELECT COUNT(*) FROM dms WHERE user_a = 'bob' AND user_b = 'carol'")
                .fetch_one(&state.db)
                .await
                .expect("n")
                .try_get(0)
                .expect("n");
        assert_eq!(none, 0, "no DM row is created");
        let own = Some((StatusCode::FORBIDDEN, YOU_FRIENDS_ONLY.to_string()));
        assert_eq!(
            code(say("bob", old.id).await),
            own,
            "friends only works both ways, and bob is told it is his setting"
        );
        assert_eq!(code(open("bob", "carol").await), own);
        assert_eq!(
            code(check_dm(&state.db, "bob", "alice").await),
            own,
            "calls"
        );
        assert_eq!(
            code(check_dm(&state.db, "alice", "bob").await),
            refused,
            "answers"
        );
        set_privacy(&state, "alice", json!({ "dms": "friends" })).await;
        assert_eq!(
            code(say("bob", old.id).await),
            refused,
            "their setting is named first, with the uniform text"
        );
        set_privacy(&state, "alice", json!({ "dms": "everyone" })).await;
        assert!(
            open("alice", "bob").await.is_ok(),
            "an existing DM still opens"
        );
        send(&state, "alice", "bob").await.expect("ask");
        let _ = accept_request(State(state.clone()), me("bob"), Path("alice".into()))
            .await
            .expect("accept");
        let _ = say("alice", old.id).await.expect("friends can write");
        let _ = say("bob", old.id).await.expect("both ways");
        let _ = remove_friend(State(state.clone()), me("alice"), Path("bob".into()))
            .await
            .expect("remove");
        assert_eq!(code(say("alice", old.id).await), refused);
        set_privacy(&state, "bob", json!({ "dms": "everyone" })).await;
        let _ = say("alice", old.id).await.expect("everyone again");
        let _ = open("carol", "bob").await.expect("carol opens");
        done(state, path).await;
    }

    async fn online_friends(state: &AppState, by: &str) -> Vec<String> {
        let Paged(items, _) = list_friends(
            State(state.clone()),
            me(by),
            Query(FriendListQuery {
                cursor: None,
                limit: None,
                q: None,
                online: Some(true),
            }),
        )
        .await
        .expect("friends");
        items.into_iter().map(|f| f.user.username).collect()
    }

    async fn heard(rx: &mut tokio::sync::broadcast::Receiver<WsEvent>) -> Vec<String> {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        drain(rx)
    }

    #[tokio::test]
    async fn presence_reaches_friends_only() {
        let (state, path) = temp_state("friends_presence").await;
        crate::ws::spawn_aftermath(&state);
        for name in ["alice", "bob", "carol"] {
            add_user(&state.db, name, name).await;
        }
        send(&state, "alice", "bob").await.expect("ask");
        let _ = accept_request(State(state.clone()), me("bob"), Path("alice".into()))
            .await
            .expect("accept");
        let mut rx = state.hub.subscribe();
        let _alice = state
            .hub
            .open(8, &HashSet::from([Topic::User("alice".into())]));
        let _carol = state
            .hub
            .open(7, &HashSet::from([Topic::User("carol".into())]));
        let _bob = state
            .hub
            .open(9, &HashSet::from([Topic::User("bob".into())]));
        state.hub.set_online("bob", 9, &[] as &[&str]);
        assert_eq!(heard(&mut rx).await, ["presence alice bob true"]);
        assert_eq!(online_friends(&state, "alice").await, ["bob"]);
        let mode = |hidden: bool, seq: i64| WsEvent::PresenceMode {
            username: "bob".into(),
            appear_offline: hidden,
            seq,
        };
        state.hub.broadcast(mode(true, 1));
        assert_eq!(
            heard(&mut rx).await,
            ["presence alice bob false"],
            "appear offline hides at once"
        );
        assert!(online_friends(&state, "alice").await.is_empty());
        state.hub.broadcast(mode(false, 0));
        assert!(heard(&mut rx).await.is_empty(), "an older setting loses");
        state.hub.broadcast(mode(false, 2));
        assert_eq!(heard(&mut rx).await, ["presence alice bob true"]);
        let _ = state.hub.drop_conn("bob", 9).await;
        state.hub.close(9);
        assert!(heard(&mut rx).await.is_empty(), "online through the grace");
        assert_eq!(online_friends(&state, "alice").await, ["bob"]);
        state.hub.expire_presence();
        assert_eq!(heard(&mut rx).await, ["presence alice bob false"]);
        assert!(online_friends(&state, "alice").await.is_empty());
        state.hub.set_online("carol", 7, &[] as &[&str]);
        assert!(
            heard(&mut rx).await.is_empty(),
            "carol has no friends to tell"
        );
        done(state, path).await;
    }

    async fn block(state: &AppState, by: &str, name: &str) {
        let _ = block_user(
            State(state.clone()),
            me(by),
            Json(serde_json::from_value::<BlockReq>(json!({ "username": name })).expect("req")),
        )
        .await
        .expect("block");
    }

    async fn rows(state: &AppState, a: &str, b: &str) -> (i64, i64) {
        let n = |sql: &'static str| {
            let db = state.db.clone();
            async move {
                sqlx::query(sql)
                    .bind(a)
                    .bind(b)
                    .fetch_one(&db)
                    .await
                    .expect("n")
                    .try_get::<i64, _>(0)
                    .expect("n")
            }
        };
        (
            n("SELECT COUNT(*) FROM friends WHERE (username = $1 AND friend = $2) OR (username = $2 AND friend = $1)").await,
            n("SELECT COUNT(*) FROM friend_requests WHERE (sender = $1 AND recipient = $2) OR (sender = $2 AND recipient = $1)").await,
        )
    }

    #[tokio::test]
    async fn a_block_row_refuses_requests_accepts_and_presence() {
        let (state, path) = temp_state("friends_block_row").await;
        for name in ["alice", "bob", "carol", "dave"] {
            add_user(&state.db, name, name).await;
        }
        send(&state, "alice", "bob").await.expect("ask");
        send(&state, "carol", "dave").await.expect("ask");
        for (a, b) in [("alice", "carol"), ("carol", "alice")] {
            sqlx::query("INSERT INTO friends(username, friend, created_at) VALUES($1, $2, 1)")
                .bind(a)
                .bind(b)
                .execute(&state.db)
                .await
                .expect("friend");
        }
        for (blocker, blocked) in [("bob", "alice"), ("carol", "dave"), ("alice", "carol")] {
            sqlx::query("INSERT INTO blocks(blocker, blocked, created_at) VALUES($1, $2, 1)")
                .bind(blocker)
                .bind(blocked)
                .execute(&state.db)
                .await
                .expect("block row, as if the block won a race with end_all");
        }
        let missing = Some((
            StatusCode::NOT_FOUND,
            "No friend request from this user".to_string(),
        ));
        assert_eq!(
            code(accept_request(State(state.clone()), me("bob"), Path("alice".into())).await),
            missing,
            "the blocker cannot accept"
        );
        assert_eq!(
            code(send(&state, "dave", "carol").await),
            Some((StatusCode::NOT_FOUND, REFUSED.to_string())),
            "asking back does not accept a blocker's request"
        );
        assert_eq!(rows(&state, "alice", "bob").await.0, 0);
        assert_eq!(rows(&state, "carol", "dave").await.0, 0);

        let mut rx = state.hub.subscribe();
        let _inbox = state
            .hub
            .open(7, &HashSet::from([Topic::User("carol".into())]));
        let _alice = state
            .hub
            .open(6, &HashSet::from([Topic::User("alice".into())]));
        tell_friends(&state, "carol", true).await;
        assert!(drain(&mut rx).is_empty(), "no presence across a block");

        block(&state, "alice", "carol").await;
        assert_eq!(
            drain(&mut rx),
            ["unfriend alice carol", "unfriend carol alice"],
            "blocking again repairs a friendship left by a lost race"
        );
        assert_eq!(rows(&state, "alice", "carol").await, (0, 0));
        block(&state, "bob", "alice").await;
        assert_eq!(rows(&state, "alice", "bob").await, (0, 0));
        done(state, path).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn blocks_racing_requests_and_accepts_leave_nothing_behind() {
        let (state, path) = temp_state("friends_race").await;
        const PAIRS: usize = 120;
        for i in 0..PAIRS {
            for side in ["a", "b", "c", "d"] {
                add_user(&state.db, &format!("{side}{i}"), side).await;
            }
            send(&state, &format!("d{i}"), &format!("c{i}"))
                .await
                .expect("d asks c");
        }
        let mut tasks = Vec::new();
        for i in 0..PAIRS {
            let (a, b, c, d) = (
                format!("a{i}"),
                format!("b{i}"),
                format!("c{i}"),
                format!("d{i}"),
            );
            let (first, second) = (0, (i * 50 % 3000) as u64);
            let wait = |n: u64| tokio::time::sleep(Duration::from_micros(n));
            let st = state.clone();
            let (x, y) = (a.clone(), b.clone());
            tasks.push(tokio::spawn(async move {
                wait(first).await;
                let _ = send(&st, &x, &y).await;
            }));
            let st = state.clone();
            tasks.push(tokio::spawn(async move {
                wait(second).await;
                block(&st, &b, &a).await
            }));
            let st = state.clone();
            let (x, y) = (c.clone(), d.clone());
            tasks.push(tokio::spawn(async move {
                wait(second).await;
                let _ = accept_request(State(st), me(&x), Path(y)).await;
            }));
            let st = state.clone();
            tasks.push(tokio::spawn(async move {
                wait(first).await;
                block(&st, &d, &c).await
            }));
        }
        for t in tasks {
            t.await.expect("task");
        }
        for i in 0..PAIRS {
            for (x, y) in [("a", "b"), ("c", "d")] {
                let (x, y) = (format!("{x}{i}"), format!("{y}{i}"));
                assert_eq!(
                    rows(&state, &x, &y).await,
                    (0, 0),
                    "{y} blocked {x}: no friendship or request may survive"
                );
            }
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn crossing_requests_become_a_friendship_and_pings_are_paced() {
        let (state, path) = temp_state("friends_cross").await;
        for name in ["alice", "bob", "carol"] {
            add_user(&state.db, name, name).await;
        }
        let (x, y) = tokio::join!(send(&state, "alice", "bob"), send(&state, "bob", "alice"));
        let mut got = [x.expect("alice"), y.expect("bob")];
        got.sort_by_key(|s| *s as u8);
        assert_eq!(got, [RequestStatus::Sent, RequestStatus::Accepted]);
        assert_eq!(rows(&state, "alice", "bob").await, (2, 0));

        let mut rx = state.hub.subscribe();
        for _ in 0..5 {
            send(&state, "carol", "alice").await.expect("ask");
            let _ = cancel_request(State(state.clone()), me("carol"), Path("alice".into()))
                .await
                .expect("cancel");
        }
        let pings = drain(&mut rx)
            .into_iter()
            .filter(|e| e.starts_with("ping alice"))
            .count();
        assert_eq!(pings, PAIR_PINGS as usize, "re-requests stop pinging");

        let _ = remove_friend(State(state.clone()), me("bob"), Path("alice".into()))
            .await
            .expect("remove");
        assert_eq!(
            unseen(&state.db, "bob").await.expect("bob").0
                + unseen(&state.db, "alice").await.expect("alice").0,
            0,
            "the accept ping goes whoever removes"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn the_sweep_ages_out_friend_pings() {
        let (state, path) = temp_state("friends_sweep").await;
        let t = now();
        for (id, created_at, seen) in [(1, t, 0), (2, t, 1), (3, t - crate::db::PING_KEEP - 1, 0)] {
            sqlx::query("INSERT INTO friend_pings(id, username, kind, actor, created_at, seen) VALUES($1, 'alice', 'friend_request', 'bob', $2, $3)")
                .bind(id)
                .bind(created_at)
                .bind(seen)
                .execute(&state.db)
                .await
                .expect("ping");
        }
        crate::db::sweep_stale(&state.db).await.expect("sweep");
        let left: Vec<i64> = sqlx::query("SELECT id FROM friend_pings ORDER BY id")
            .fetch_all(&state.db)
            .await
            .expect("left")
            .iter()
            .map(|r| r.try_get(0).expect("id"))
            .collect();
        assert_eq!(left, [1], "seen and old friend pings go");
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_purged_account_leaves_friend_lists_live() {
        let (state, path) = temp_state("friends_purge").await;
        for name in ["alice", "bob", "carol", "dave"] {
            add_user(&state.db, name, name).await;
        }
        send(&state, "alice", "bob").await.expect("ask");
        let _ = accept_request(State(state.clone()), me("bob"), Path("alice".into()))
            .await
            .expect("accept");
        send(&state, "bob", "carol").await.expect("ask carol");
        send(&state, "dave", "bob").await.expect("dave asks");
        sqlx::query("UPDATE users SET password_hash = $1 WHERE username = 'bob'")
            .bind(crate::db::PURGING_HASH)
            .execute(&state.db)
            .await
            .expect("purging");
        let mut rx = state.hub.subscribe();
        crate::api::admin::finish_purge(&state, crate::api::admin::PurgeKind::User, "bob")
            .await
            .expect("purge");
        let evs = drain(&mut rx);
        for want in [
            "unfriend alice bob",
            "unrequest carol bob",
            "unrequest dave bob",
            "count alice friends 0",
            "count carol friends 0",
        ] {
            assert!(evs.contains(&want.to_string()), "{want}: {evs:?}");
        }
        done(state, path).await;
    }
}
