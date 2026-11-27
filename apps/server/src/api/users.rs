use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, header};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use utoipa::{IntoParams, ToSchema};

use crate::api::access::perms::Perm;
use crate::api::access::subjects::{CANDIDATES_MAX, candidates};
use crate::api::access::{Caller, Proof, ServerAccess, UserView, not_found, view_user};
use crate::api::lookup::{self, LookupClass};
use crate::api::servers::lookup_text;
use crate::api::{ApiError, ApiErrorBody, MaybeAuthed, Role, UserRef, require_guest_ok};
use crate::db::{Db, User};
use crate::state::AppState;

/// Optional profile context.
#[derive(Deserialize, IntoParams)]
pub struct ProfileQuery {
    /// Server name, case-insensitive. When given, the response's `member` describes the user's
    /// membership in that server (if visible). Omit for no membership info.
    server: Option<String>,
}

/// A user's membership in the server asked for with `server`.
#[derive(Serialize, ToSchema)]
pub struct ProfileMember {
    /// Whether the user is a server admin.
    pub is_admin: bool,
    /// Whether the user created the server.
    pub is_creator: bool,
    /// Admin permission bits granted to the user as a server admin; 0 for non-admins. Role
    /// permissions are in `roles`.
    pub perms: i64,
    /// Ids of the roles assigned to the user, ascending.
    pub role_ids: Vec<i64>,
    /// The roles assigned to the user, by id ascending.
    pub roles: Vec<Role>,
    /// When the user joined the server, Unix seconds.
    pub joined_at: i64,
    /// Whether the user currently shows as online in the server (false while they appear
    /// offline).
    pub online: bool,
    /// The user's running timeout in the server. Only for viewers with the Timeout members
    /// permission (kept while they are timed out themselves); absent otherwise and when none is
    /// running.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout: Option<crate::api::timeouts::MemberTimeout>,
    /// The name and avatar the user set for the server; absent when they use the account's,
    /// and while server profiles are off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<crate::api::profiles::MemberLook>,
    /// Until when (unix seconds) a moderator locked the user's server profile;
    /// 9223372036854775807 for a lock that stays until it is lifted. Only for viewers with the
    /// Reset server profiles permission; absent otherwise and when it is not locked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_locked_until: Option<i64>,
}

/// A user's mini profile.
#[derive(Serialize, ToSchema)]
pub struct Profile {
    /// The user's public identity and avatar.
    pub user: UserRef,
    /// Lowercase `#rrggbb` banner color; null means the default derived from the avatar.
    pub banner_color: Option<String>,
    /// Profile description, at most 190 characters, may contain newlines; null when unset.
    pub bio: Option<String>,
    /// When the account was created, Unix seconds.
    pub created_at: i64,
    /// Membership in the server given by `server`; null when `server` was omitted, the server
    /// does not exist, the viewer may not view it, or the user is not a member.
    pub member: Option<ProfileMember>,
    /// The description the user set for the server given by `server`; absent when they have
    /// none there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_bio: Option<String>,
    /// The `#rrggbb` banner color the user set for that server; absent like `server_bio`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_banner: Option<String>,
}

/// The part of a card that an account shows only to people it has a relationship with.
#[derive(Serialize, ToSchema)]
pub struct ProfileFacts {
    /// Profile description, at most 190 characters, may contain newlines; null when unset.
    pub bio: Option<String>,
    /// Lowercase `#rrggbb` banner color; null means the default derived from the avatar.
    pub banner_color: Option<String>,
    /// When the account was created, Unix seconds.
    pub created_at: i64,
    /// The description the account set for the server named with `server`; absent when it has
    /// none there or is not shown as a member of it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_bio: Option<String>,
    /// The `#rrggbb` banner color the account set for that server; absent like `server_bio`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_banner: Option<String>,
}

/// A user's membership in the server asked for with `server`.
#[derive(Serialize, ToSchema)]
pub struct MemberFacts {
    /// Whether the user is a server admin.
    pub is_admin: bool,
    /// Whether the user created the server.
    pub is_creator: bool,
    /// Admin permission bits granted to the user as a server admin; 0 for non-admins. Role
    /// permissions are in `roles`.
    pub perms: i64,
    /// Ids of the roles assigned to the user, ascending.
    pub role_ids: Vec<i64>,
    /// The roles assigned to the user, by id ascending.
    pub roles: Vec<Role>,
    /// When the user joined the server, Unix seconds.
    pub joined_at: i64,
    /// Whether the user currently shows as online in the server (false while they appear
    /// offline).
    pub online: bool,
    /// The user's running timeout in the server. Only for viewers with the Timeout members
    /// permission (kept while they are timed out themselves); absent otherwise and when none is
    /// running.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout: Option<crate::api::timeouts::MemberTimeout>,
    /// The name and avatar the user set for the server; absent when they use the account's,
    /// and while server profiles are off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<crate::api::profiles::MemberLook>,
    /// Until when (unix seconds) a moderator locked the user's server profile;
    /// 9223372036854775807 for a lock that stays until it is lifted. Only for viewers with the
    /// Reset server profiles permission; absent otherwise and when it is not locked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_locked_until: Option<i64>,
}

impl From<MemberFacts> for ProfileMember {
    fn from(facts: MemberFacts) -> ProfileMember {
        let MemberFacts {
            is_admin,
            is_creator,
            perms,
            role_ids,
            roles,
            joined_at,
            online,
            timeout,
            profile,
            profile_locked_until,
        } = facts;
        ProfileMember {
            is_admin,
            is_creator,
            perms,
            role_ids,
            roles,
            joined_at,
            online,
            timeout,
            profile,
            profile_locked_until,
        }
    }
}

/// An account's card: its name, and the parts the caller may see.
#[derive(Serialize, ToSchema)]
pub struct UserCard {
    /// The user's public identity and avatar.
    pub user: UserRef,
    /// The profile; null when the account does not show it to the caller.
    pub profile: Option<ProfileFacts>,
    /// Membership in the server given by `server`; null when `server` was omitted, the caller
    /// may not view it, or the user is not a member.
    pub member: Option<MemberFacts>,
}

/// A card as it is sent: the client may keep it, and asks again before each use.
pub struct Card(pub UserCard);

impl IntoResponse for Card {
    fn into_response(self) -> Response {
        let Card(card) = self;
        ([(header::CACHE_CONTROL, "private, no-cache")], Json(card)).into_response()
    }
}

/// Accounts as mention suggestions and the user search list them: only what a row of names
/// shows, kept by the client for 15 seconds.
pub struct Names(pub Vec<UserRef>);

impl IntoResponse for Names {
    fn into_response(self) -> Response {
        let Names(names) = self;
        (
            [(header::CACHE_CONTROL, "private, max-age=15")],
            Json(names),
        )
            .into_response()
    }
}

async fn member_roles(db: &Db, server: &str, username: &str) -> Result<Vec<Role>, ApiError> {
    let sql = format!(
        "SELECT {} FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.server = $1 AND ur.username = $2 ORDER BY r.position DESC, r.id",
        crate::api::servers::ROLE_COLUMNS
    );
    let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(server)
        .bind(username)
        .fetch_all(db)
        .await?;
    rows.iter().map(crate::api::servers::role_of).collect()
}

/// The membership of `username` in the server `access` opens, as its viewer may see it.
async fn member_facts(
    state: &AppState,
    access: &ServerAccess,
    username: &str,
) -> Result<Option<MemberFacts>, ApiError> {
    let db = &state.read();
    let lite = access.lite();
    let row = sqlx::query(
        "SELECT is_admin, perms, joined_at FROM members WHERE server = $1 AND username = $2",
    )
    .bind(&lite.name)
    .bind(username)
    .fetch_optional(db)
    .await?;
    match row {
        Some(r) => {
            let roles = member_roles(db, &lite.name, username).await?;
            let timeout = match access.can_view(db, Perm::TimeoutMembers).await {
                true => {
                    crate::api::timeouts::running_timeouts(db, &lite.name, &[username.to_string()])
                        .await?
                        .remove(username)
                }
                false => None,
            };
            let profile_locked_until = match access.can_view(db, Perm::ManageProfiles).await {
                true => crate::api::profiles::locked_until(db, &lite.name, username).await?,
                false => None,
            };
            Ok(Some(MemberFacts {
                is_admin: r.try_get::<i64, _>(0)? != 0,
                is_creator: lite.creator.as_deref() == Some(username),
                perms: r.try_get(1)?,
                role_ids: roles.iter().map(|role| role.id).collect(),
                roles,
                joined_at: r.try_get(2)?,
                online: state.hub.is_online(&lite.name, username),
                timeout,
                profile: crate::api::profiles::look_of(db, &lite.name, username).await?,
                profile_locked_until,
            }))
        }
        None => Ok(None),
    }
}

/// The card of `username` for `viewer`: the profile when the lookup rule
/// (`access::subjects`) finds a relationship that shows it, the membership when the viewer
/// named a server it can open where the account is a member, and the uniform 404 when neither.
async fn card_of(
    state: &AppState,
    headers: &HeaderMap,
    viewer: Option<&User>,
    username: &str,
    server: Option<&str>,
) -> Result<UserCard, ApiError> {
    let proof = Proof::headers(headers, &state.limits);
    let caller = Caller {
        user: viewer,
        proof: &proof,
        server,
        badge: headers
            .get("x-subject-binding")
            .and_then(|v| v.to_str().ok()),
    };
    let UserView { user, seen, member } = view_user(state, &caller, username).await?;
    let (member, in_server) = match member {
        Some(access) => (
            member_facts(state, &access, &user.username).await?,
            Some(access.name().to_string()),
        ),
        None => (None, None),
    };
    let (server_bio, server_banner) = match (&seen, &member, &in_server) {
        (Some(_), Some(_), Some(server)) => {
            crate::api::profiles::bio_and_banner(&state.read(), server, &user.username).await?
        }
        (_, _, _) => (None, None),
    };
    let profile = match seen {
        Some(_) => Some(ProfileFacts {
            bio: crate::crypt::copies::bio_of(&state.db, &user).await?,
            banner_color: user.banner_color.clone(),
            created_at: user.created_at,
            server_bio,
            server_banner,
        }),
        None => None,
    };
    match profile.is_some() || member.is_some() {
        true => Ok(UserCard {
            user: UserRef::from_user(&user),
            profile,
            member,
        }),
        false => Err(not_found()),
    }
}

/// Get an account's card
///
/// Returns what the caller may see of an account. `profile` (description, banner color and account
/// creation time) is set when the caller proves a relationship with the account: it is the caller's
/// own, they are friends, the account sent the caller a friend request, the account wrote in a
/// direct conversation with the caller, both are members of one server, the account is a member of
/// the server named with `server` and the caller may view that server (a member, anyone for a
/// server anyone can read (`public_read` in `PATCH /api/v1/servers/{name}`, `public_reading` in
/// `GET /api/v1/settings`), a guest with a valid `X-Guest-Grant`), or the caller sends a P2P
/// binding of the account in `X-Subject-Binding`. A guest that names no server is also shown
/// members of the servers its grants open. Through a server whose `members_visible` is off,
/// only its own members see its members' profiles. The instance's `profile_visibility` in `GET
/// /api/v1/settings` widens this to members of servers anyone can read (`public_servers`) or to
/// every account (`everyone`). An account's own choice (`profile` in `PATCH
/// /api/v1/me/privacy`) may narrow it to friends or widen it to everyone, as far as the
/// instance's `profile_choices` lets it.
///
/// `member` is the account's membership in `server`, set when the caller may view that server
/// and its member list (see `GET /api/v1/servers/{name}/members`) and the account is a member,
/// whoever may see the profile. An account with neither part
/// answers the same 404 as a name with no account, after the same checks. Works without a
/// token for guests when guest access is on.
///
/// Each call takes one of the caller's `profile` lookups (`LOOKUP_PROFILE_PER_MINUTE`, 120 a
/// minute by default), counted per account, or per client address without one. A caller that
/// used up its misses for the hour (`LOOKUP_MISSES_PER_HOUR`, 200 by default) gets the same 429
/// for every name until the hour ends. The 404s of this endpoint, of `POST /api/v1/blocks` and
/// of `GET /api/v1/users/{username}/profile` where this endpoint answers 404 too are misses, and
/// so are blocks of accounts whose card the caller may not see and bans of people outside the
/// server. General rate-limit bucket.
#[utoipa::path(get, path = "/api/v1/users/{username}/card", tag = "Users", params(("username" = String, Path, description = "Username, case-insensitive"), ProfileQuery, ("X-Guest-Grant" = Option<String>, Header, description = "Guest grants from `POST /api/v1/servers/{name}/guest_access`, comma-separated, up to 100. Only read for guests"), ("X-Subject-Binding" = Option<String>, Header, description = "A P2P binding of the account: the `token` of `POST /api/v1/identity/p2p_binding` as the account showed it in its P2P badge. It shows that account's profile until the binding expires")), responses((status = 200, description = "The account's name with the parts the caller may see: `profile` (null when the account does not show it to the caller) and `member` (null when `server` was omitted, the caller may not view it or its member list, or the account is not a member). Never both null", body = UserCard, headers(("cache-control" = String, description = "`private, no-cache`"))), (status = 401, description = "No valid token and guest access is disabled (`Guest access is disabled`)", body = ApiErrorBody), (status = 404, description = "`Not found`: no such account, or one the caller may see nothing of (identical responses)", body = ApiErrorBody), (status = 429, description = "`Too many lookups. Try again later.` with a `Retry-After` header (JSON): the caller used up its `profile` lookups, or its misses for the hour. Or too many requests in the general bucket", body = ApiErrorBody)), security((), ("bearer" = [])))]
pub(crate) async fn card(
    State(state): State<AppState>,
    MaybeAuthed(viewer): MaybeAuthed,
    headers: HeaderMap,
    Path(username): Path<String>,
    Query(q): Query<ProfileQuery>,
) -> Result<Card, ApiError> {
    require_guest_ok(&state.db, viewer.as_ref()).await?;
    let held = lookup::unmissed(&state, viewer.as_ref())?;
    lookup::take(&state, LookupClass::Profile, viewer.as_ref())?;
    let ProfileQuery { server } = q;
    let card = card_of(
        &state,
        &headers,
        viewer.as_ref(),
        &username,
        server.as_deref(),
    )
    .await;
    Ok(Card(lookup::counted(held, card)?))
}

/// Get a user's profile
///
/// The older form of `GET /api/v1/users/{username}/card`, with the same rule: it answers only
/// when the caller may see the account's profile (see there), with identity, banner color,
/// description and account creation time, plus the membership in `server` when asked. An
/// account whose profile the caller may not see answers the same 404 as a name with no
/// account, also when the caller could see its membership. Works without a token for guests
/// when guest access is on. It takes the same `profile` lookups as the card, and counts a miss
/// only when the card would answer 404. General rate-limit bucket.
#[utoipa::path(get, path = "/api/v1/users/{username}/profile", tag = "Users", params(("username" = String, Path, description = "Username, case-insensitive"), ProfileQuery, ("X-Guest-Grant" = Option<String>, Header, description = "Guest grants from `POST /api/v1/servers/{name}/guest_access`, comma-separated, up to 100. Only read for guests"), ("X-Subject-Binding" = Option<String>, Header, description = "A P2P binding of the account, as for `GET /api/v1/users/{username}/card`")), responses((status = 200, description = "A user's mini profile: public info, banner color (null means the default derived from the avatar) and account creation time. With `server`, `member` holds their membership in it (admin, creator, permissions, role ids, join time, presence); it is null when the server does not exist, the viewer may not view it (same rules as the member list, guests included) or the user is not a member", body = Profile), (status = 401, description = "No valid token and guest access is disabled (`Guest access is disabled`)", body = ApiErrorBody), (status = 404, description = "`Not found`: no such account, or one whose profile the caller may not see (identical responses)", body = ApiErrorBody), (status = 429, description = "`Too many lookups. Try again later.` with a `Retry-After` header (JSON): the caller used up its `profile` lookups, or its misses for the hour. Or too many requests in the general bucket", body = ApiErrorBody)), security((), ("bearer" = [])))]
pub(crate) async fn profile(
    State(state): State<AppState>,
    MaybeAuthed(viewer): MaybeAuthed,
    headers: HeaderMap,
    Path(username): Path<String>,
    Query(q): Query<ProfileQuery>,
) -> Result<Json<Profile>, ApiError> {
    require_guest_ok(&state.db, viewer.as_ref()).await?;
    let held = lookup::unmissed(&state, viewer.as_ref())?;
    lookup::take(&state, LookupClass::Profile, viewer.as_ref())?;
    let ProfileQuery { server } = q;
    let card = card_of(
        &state,
        &headers,
        viewer.as_ref(),
        &username,
        server.as_deref(),
    )
    .await;
    let UserCard {
        user,
        profile,
        member,
    } = lookup::counted(held, card)?;
    let ProfileFacts {
        bio,
        banner_color,
        created_at,
        server_bio,
        server_banner,
    } = profile.ok_or_else(not_found)?;
    Ok(Json(Profile {
        user,
        banner_color,
        bio,
        created_at,
        member: member.map(ProfileMember::from),
        server_bio,
        server_banner,
    }))
}

/// Query for the user search.
#[derive(Deserialize, IntoParams)]
pub struct UserSearchQuery {
    /// The start of a username or display name, 2 to 32 characters after trimming,
    /// case-insensitive.
    #[param(example = "al")]
    q: Option<String>,
    /// A server the caller names: its members come first, and it shows them as when a card is
    /// opened from it. A server that keeps its members from the caller (`members_visible` off,
    /// for someone who is not a member) adds none of them and puts none first.
    server: Option<String>,
    /// Most accounts, 1 to 10 (clamped), default 8. Must be an integer.
    limit: Option<i64>,
}

/// The default number of accounts the user search answers.
pub const SEARCH_DEFAULT: i64 = 8;

/// Search accounts
///
/// Accounts whose username or display name starts with `q` (case-insensitive) that the caller
/// may find by name, at most `limit`: the same rule as `GET /api/v1/users/{username}/card`,
/// so an account the caller may not see is left out, never answered with 404. Members of
/// `server` come first, then friends and people whose friend request is pending, people in a
/// direct conversation with the caller, members of the caller's other servers, and then
/// everyone else (accounts in a server anyone can read, or that show themselves to everyone);
/// by username within each. A `server` the caller can't open answers the uniform server 404.
/// Works without a token for guests when guest access is on. Each call takes one of the
/// caller's `search` lookups (`LOOKUP_SEARCH_PER_MINUTE`, 30 a minute by default, shared with
/// `GET /api/v1/server_search`), counted per account, or per client address without one.
/// General rate-limit bucket.
#[utoipa::path(
    get,
    path = "/api/v1/users/search",
    operation_id = "search_users",
    tag = "Users",
    params(UserSearchQuery, ("X-Guest-Grant" = Option<String>, Header, description = "Guest grants from `POST /api/v1/servers/{name}/guest_access`, comma-separated, up to 100. Only read for guests"), ("X-Subject-Binding" = Option<String>, Header, description = "A P2P binding of an account, as for `GET /api/v1/users/{username}/card`")),
    responses(
        (status = 200, description = "The accounts found, best first", body = Vec<UserRef>, headers(("cache-control" = String, description = "`private, max-age=15`"))),
        (status = 400, description = "`Search text needs at least 2 characters`, `Search text must be at most 32 characters` or `Search text cannot contain NUL characters` (reason `invalid`, field `q`), or `Server name cannot contain NUL characters` (reason `invalid`, field `server`) (JSON); a non-integer `limit` (plain-text framework error)", body = ApiErrorBody),
        (status = 401, description = "No valid token and guest access is disabled (`Guest access is disabled`)", body = ApiErrorBody),
        (status = 403, description = "`You are banned from this server` for a `server` you took part in before", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: `server` does not exist, or the caller may not open it (identical responses)", body = ApiErrorBody),
        (status = 429, description = "`Too many lookups. Try again later.` with a `Retry-After` header (JSON): the caller used up its `search` lookups. Or too many requests in the general bucket", body = ApiErrorBody)
    ),
    security((), ("bearer" = []))
)]
pub(crate) async fn search(
    State(state): State<AppState>,
    MaybeAuthed(viewer): MaybeAuthed,
    headers: HeaderMap,
    Query(query): Query<UserSearchQuery>,
) -> Result<Names, ApiError> {
    require_guest_ok(&state.db, viewer.as_ref()).await?;
    let UserSearchQuery { q, server, limit } = query;
    let q = lookup_text(q.as_deref(), 2)?;
    if server.as_deref().is_some_and(|s| s.contains('\0')) {
        return Err(ApiError::invalid(
            "Server name cannot contain NUL characters",
            "server",
        ));
    }
    lookup::take(&state, LookupClass::Search, viewer.as_ref())?;
    let proof = Proof::headers(&headers, &state.limits);
    let caller = Caller {
        user: viewer.as_ref(),
        proof: &proof,
        server: server.as_deref(),
        badge: headers
            .get("x-subject-binding")
            .and_then(|v| v.to_str().ok()),
    };
    let limit = limit
        .unwrap_or(SEARCH_DEFAULT)
        .clamp(1, CANDIDATES_MAX as i64) as usize;
    Ok(Names(candidates(&state, &caller, &q, limit).await?))
}

#[cfg(test)]
mod tests {
    use axum::http::{StatusCode, header};
    use axum::response::IntoResponse;
    use serde_json::json;

    use super::*;
    use crate::api::access::NOT_FOUND;
    use crate::api::auth::{MePatch, patch_me};
    use crate::api::test_util::{add_member, done, mem_user, temp_state, test_grant};
    use crate::api::{Authed, MaybeAuthed, Reason, ReasonKind};
    use crate::db::get_user;

    async fn insert_user(db: &Db, name: &str, created_at: i64) {
        crate::db::NewUser::plain(name).at(created_at).add(db).await;
    }

    async fn exec(db: &Db, sql: &str) {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .execute(db)
            .await
            .expect(sql);
    }

    /// Who asks, and what they send along.
    #[derive(Clone, Copy, Debug, Default)]
    struct Ask<'a> {
        viewer: Option<&'a str>,
        admin: bool,
        grant: Option<&'a str>,
        badge: Option<&'a str>,
        server: Option<&'a str>,
    }

    fn by(viewer: &str) -> Ask<'_> {
        Ask {
            viewer: Some(viewer),
            ..Ask::default()
        }
    }

    fn in_server<'a>(ask: Ask<'a>, server: &'a str) -> Ask<'a> {
        Ask {
            server: Some(server),
            ..ask
        }
    }

    fn headers_of(ask: Ask<'_>) -> HeaderMap {
        let mut headers = HeaderMap::new();
        if let Some(grant) = ask.grant {
            headers.insert(
                "x-guest-grant",
                test_grant(grant).parse().expect("grant header"),
            );
        }
        if let Some(badge) = ask.badge {
            headers.insert("x-subject-binding", badge.parse().expect("badge header"));
        }
        headers
    }

    async fn card_for(
        state: &AppState,
        ask: Ask<'_>,
        username: &str,
    ) -> Result<UserCard, ApiError> {
        card(
            State(state.clone()),
            MaybeAuthed(ask.viewer.map(|name| mem_user(name, ask.admin))),
            headers_of(ask),
            Path(username.to_string()),
            Query(ProfileQuery {
                server: ask.server.map(str::to_string),
            }),
        )
        .await
        .map(|Card(card)| card)
    }

    async fn view(state: &AppState, ask: Ask<'_>, username: &str) -> Result<Profile, ApiError> {
        profile(
            State(state.clone()),
            MaybeAuthed(ask.viewer.map(|name| mem_user(name, ask.admin))),
            headers_of(ask),
            Path(username.to_string()),
            Query(ProfileQuery {
                server: ask.server.map(str::to_string),
            }),
        )
        .await
        .map(|p| p.0)
    }

    fn refusal<T>(res: Result<T, ApiError>) -> Option<(StatusCode, String, Option<Reason>)> {
        res.err()
            .map(|ApiError(code, text, reason)| (code, text, reason.map(|r| *r)))
    }

    /// A 400 whose reason says the request value `field` is wrong.
    fn invalid(text: &str, field: &str) -> (StatusCode, String, Option<Reason>) {
        let reason = Reason {
            kind: ReasonKind::Invalid,
            control: None,
            retry_after: None,
            field: Some(field.to_string()),
            until: None,
            channel: None,
        };
        (StatusCode::BAD_REQUEST, text.to_string(), Some(reason))
    }

    /// The uniform 404, without a reason.
    fn hidden() -> Option<(StatusCode, String, Option<Reason>)> {
        Some((StatusCode::NOT_FOUND, NOT_FOUND.to_string(), None))
    }

    /// What a card shows: (the profile part, the membership part), or `None` for the 404.
    async fn parts(state: &AppState, ask: Ask<'_>, username: &str) -> Option<(bool, bool)> {
        match card_for(state, ask, username).await {
            Ok(card) => {
                assert!(card.profile.is_some() || card.member.is_some());
                Some((card.profile.is_some(), card.member.is_some()))
            }
            Err(ApiError(code, text, reason)) => {
                assert_eq!(
                    (code, text.as_str(), reason),
                    (StatusCode::NOT_FOUND, NOT_FOUND, None),
                    "{ask:?} {username}"
                );
                None
            }
        }
    }

    async fn patch_banner(state: &AppState, body: &str) -> Result<Option<String>, ApiError> {
        let user = get_user(&state.db, "bob")
            .await
            .expect("load bob")
            .expect("bob exists");
        let req: MePatch = serde_json::from_str(body).expect("patch body");
        patch_me(State(state.clone()), Authed(user), Json(req))
            .await
            .map(|r| r.0.banner_color)
    }

    fn badge_for(state: &AppState, name: &str) -> String {
        let iat = crate::db::now();
        state
            .instance
            .keys
            .sign(&crate::identity::BindingClaims {
                iss: "http://localhost".to_string(),
                sub: format!("{name}@localhost"),
                aud: crate::identity::BINDING_AUD.to_string(),
                ik: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo".to_string(),
                iat,
                exp: iat + crate::identity::BINDING_TTL_SECS,
                head: None,
            })
            .expect("sign")
    }

    /// alice created the password server vault, where bob is a member with the role mods. bob
    /// is also in the public server rchat. carol and dave are in no server, root is the site
    /// admin, and the grant `g1` opens vault.
    async fn world(state: &AppState) -> i64 {
        let db = &state.db;
        for (name, created) in [("alice", 11), ("bob", 22), ("carol", 33), ("dave", 44)] {
            insert_user(db, name, created).await;
        }
        exec(
            db,
            "UPDATE users SET bio = 'about bob', banner_color = '#102030' WHERE username = 'bob'",
        )
        .await;
        sqlx::query("INSERT INTO servers(name, display_name, creator, password_hash, created_at) VALUES('vault', 'Vault', 'alice', 'hash', 0)")
            .execute(db)
            .await
            .expect("insert server");
        add_member(db, "vault", "alice", 1, 0, 100).await;
        add_member(db, "vault", "bob", 0, 0, 200).await;
        add_member(db, "rchat", "bob", 0, 0, 300).await;
        let role: i64 = sqlx::query("INSERT INTO roles(server, name, color, perms) VALUES('vault', 'mods', '#ff0000', 4) RETURNING id")
            .fetch_one(db)
            .await
            .expect("role")
            .try_get(0)
            .expect("role id");
        sqlx::query("INSERT INTO user_roles(server, username, role_id) VALUES('vault', 'bob', $1)")
            .bind(role)
            .execute(db)
            .await
            .expect("assign");
        sqlx::query(
            "INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at) VALUES($1, 'vault', 0, 4000000000)",
        )
        .bind(crate::db::secret_key(&test_grant("g1")))
        .execute(db)
        .await
        .expect("grant");
        role
    }

    #[tokio::test]
    async fn profile_member_visibility_and_fields() {
        let (state, path) = temp_state("profile_visibility").await;
        let db = &state.db;
        let role = world(&state).await;

        assert_eq!(
            refusal(view(&state, by("carol"), "Bob").await),
            hidden(),
            "carol shares nothing with bob"
        );
        let own = view(&state, by("bob"), "Bob").await.expect("own profile");
        assert_eq!(own.user.username, "bob");
        assert_eq!(own.created_at, 22);
        assert_eq!(own.banner_color.as_deref(), Some("#102030"));
        assert_eq!(own.bio.as_deref(), Some("about bob"));
        assert!(own.member.is_none());

        let bob = view(&state, in_server(by("alice"), "Vault"), "bob")
            .await
            .expect("member view")
            .member
            .expect("bob is a member");
        assert!(!bob.is_admin && !bob.is_creator && !bob.online);
        assert_eq!(
            (bob.perms, bob.role_ids, bob.joined_at),
            (0, vec![role], 200)
        );
        let named: Vec<(i64, String, String)> = bob
            .roles
            .into_iter()
            .map(|r| (r.id, r.name, r.color))
            .collect();
        assert_eq!(
            named,
            vec![(role, "mods".to_string(), "#ff0000".to_string())]
        );
        let alice = view(&state, in_server(by("bob"), "vault"), "alice")
            .await
            .expect("creator view")
            .member
            .expect("alice is a member");
        assert!(alice.is_admin && alice.is_creator);
        assert_eq!((alice.role_ids, alice.joined_at), (vec![], 100));
        assert!(alice.roles.is_empty());

        let guest = Ask::default();
        let granted = Ask {
            grant: Some("g1"),
            ..guest
        };
        let root = Ask {
            admin: true,
            ..by("root")
        };
        let cases = [
            (
                "a server carol can't open",
                in_server(by("carol"), "vault"),
                "bob",
                None,
            ),
            (
                "a public server, named",
                in_server(by("carol"), "rchat"),
                "bob",
                Some((true, true)),
            ),
            ("no grant", in_server(guest, "vault"), "bob", None),
            (
                "an unknown grant",
                in_server(
                    Ask {
                        grant: Some("bad"),
                        ..guest
                    },
                    "vault",
                ),
                "bob",
                None,
            ),
            (
                "a grant",
                in_server(granted, "vault"),
                "bob",
                Some((true, true)),
            ),
            (
                "a grant, no server named",
                granted,
                "bob",
                Some((true, false)),
            ),
            (
                "a grant, someone outside",
                in_server(granted, "vault"),
                "carol",
                None,
            ),
            (
                "not a member there",
                in_server(by("bob"), "vault"),
                "carol",
                None,
            ),
            (
                "a guest, a public server",
                in_server(guest, "rchat"),
                "bob",
                Some((true, true)),
            ),
            ("a guest, nothing named", guest, "bob", None),
            (
                "a guest, not a member there",
                in_server(guest, "rchat"),
                "alice",
                None,
            ),
            (
                "yourself, no such server",
                in_server(by("bob"), "nowhere"),
                "bob",
                Some((true, false)),
            ),
            ("a common server", by("alice"), "bob", Some((true, false))),
            ("the site admin", root, "bob", None),
            (
                "the site admin, the server named",
                in_server(root, "vault"),
                "bob",
                Some((true, true)),
            ),
            ("no account", in_server(guest, "vault"), "nobody", None),
            ("no account, signed in", by("alice"), "nobody", None),
        ];
        for (what, ask, target, want) in cases {
            assert_eq!(parts(&state, ask, target).await, want, "{what}");
            let old = view(&state, ask, target).await;
            match want {
                Some((true, member)) => {
                    assert_eq!(old.expect(what).member.is_some(), member, "{what}")
                }
                Some((false, _)) | None => assert_eq!(refusal(old), hidden(), "{what}"),
            }
        }

        exec(db, "INSERT INTO friends(username, friend, created_at) VALUES('carol', 'bob', 1), ('bob', 'carol', 1)").await;
        assert_eq!(parts(&state, by("carol"), "bob").await, Some((true, false)));
        exec(db, "DELETE FROM friends").await;
        assert_eq!(parts(&state, by("carol"), "bob").await, None);
        add_member(db, "vault", "carol", 0, 0, 400).await;
        assert_eq!(
            parts(&state, by("carol"), "bob").await,
            Some((true, false)),
            "a common server, at the next request"
        );
        let badge = badge_for(&state, "bob");
        let shows = Ask {
            badge: Some(&badge),
            ..by("dave")
        };
        assert_eq!(parts(&state, by("dave"), "bob").await, None);
        assert_eq!(parts(&state, shows, "bob").await, Some((true, false)));
        assert_eq!(
            parts(&state, shows, "alice").await,
            None,
            "bob's badge only"
        );
        assert_eq!(
            parts(
                &state,
                Ask {
                    viewer: None,
                    ..shows
                },
                "bob"
            )
            .await,
            Some((true, false)),
            "a badge needs no token"
        );

        sqlx::query("UPDATE settings SET value = '0' WHERE key = 'guests_enabled'")
            .execute(db)
            .await
            .expect("disable guests");
        crate::api::Settings::forget(db);
        let off = Some((
            StatusCode::UNAUTHORIZED,
            "Guest access is disabled".to_string(),
            None,
        ));
        for target in ["bob", "nobody"] {
            for ask in [
                guest,
                in_server(granted, "vault"),
                in_server(guest, "rchat"),
            ] {
                assert_eq!(refusal(view(&state, ask, target).await), off, "{target}");
                assert_eq!(
                    refusal(card_for(&state, ask, target).await),
                    off,
                    "{target}"
                );
            }
        }
        assert!(view(&state, by("alice"), "bob").await.is_ok());
        assert!(card_for(&state, by("alice"), "bob").await.is_ok());
        done(state, path).await;
    }

    #[tokio::test]
    async fn server_bios_follow_profile_visibility() {
        let (state, path) = temp_state("card_server_bio").await;
        let state = state.with_limits(std::sync::Arc::new(crate::limits::Limits {
            lookup_profile_per_minute: 10_000,
            lookup_misses_per_hour: 0,
            ..crate::limits::Limits::default()
        }));
        let db = &state.db;
        world(&state).await;
        exec(db, "INSERT INTO servers(name, display_name, creator, public_read, created_at) VALUES('open', 'Open', 'bob', 1, 0)").await;
        add_member(db, "open", "bob", 1, 0, 400).await;
        exec(db, "INSERT INTO member_profiles(server, username, name, bio, banner_color, updated_at) VALUES('open', 'bob', 'Robert', 'bob in open', '#222222', 1)").await;
        exec(
            db,
            "INSERT INTO privacy(username, profile) VALUES('bob', 'friends')",
        )
        .await;
        let look = Some(crate::api::profiles::MemberLook {
            name: Some("Robert".to_string()),
            avatar_kind: None,
            avatar_color: None,
        });
        let reader = card_for(&state, in_server(by("carol"), "open"), "bob")
            .await
            .unwrap_or_else(|e| panic!("a reader: {}", e.1));
        assert!(
            reader.profile.is_none(),
            "bob shows his profile to friends only"
        );
        assert_eq!(reader.member.expect("membership").profile, look);
        exec(db, "DELETE FROM privacy WHERE username = 'bob'").await;
        let shown = card_for(&state, in_server(by("carol"), "open"), "bob")
            .await
            .unwrap_or_else(|e| panic!("a reader: {}", e.1));
        let facts = shown.profile.expect("profile");
        assert_eq!(
            (facts.server_bio.as_deref(), facts.server_banner.as_deref()),
            (Some("bob in open"), Some("#222222"))
        );
        assert_eq!(facts.bio.as_deref(), Some("about bob"));
        assert_eq!(shown.member.expect("membership").profile, look);
        let other = card_for(&state, in_server(by("alice"), "vault"), "bob")
            .await
            .unwrap_or_else(|e| panic!("another server: {}", e.1));
        assert_eq!(other.profile.expect("profile").server_bio, None);
        assert_eq!(other.member.expect("membership").profile, None);
        let plain = card_for(&state, by("alice"), "bob")
            .await
            .unwrap_or_else(|e| panic!("without a server: {}", e.1));
        let facts = plain.profile.expect("profile");
        assert_eq!((facts.server_bio, facts.server_banner), (None, None));
        exec(
            db,
            "UPDATE servers SET members_visible = 0 WHERE name = 'open'",
        )
        .await;
        assert!(
            card_for(&state, in_server(by("carol"), "open"), "bob")
                .await
                .ok()
                .and_then(|card| card.profile)
                .is_none_or(|facts| facts.server_bio.is_none()),
            "a server that keeps its members shows no server description outside it"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn profile_locks_show_to_those_who_can_lift_them() {
        let (state, path) = temp_state("card_profile_lock").await;
        let state = state.with_limits(std::sync::Arc::new(crate::limits::Limits {
            lookup_profile_per_minute: 10_000,
            lookup_misses_per_hour: 0,
            ..crate::limits::Limits::default()
        }));
        let db = &state.db;
        world(&state).await;
        add_member(db, "vault", "carol", 0, 0, 500).await;
        let until = crate::db::now() + 600;
        exec(db, &format!("INSERT INTO member_profiles(server, username, locked_until, updated_at) VALUES('vault', 'bob', {until}, 1)")).await;
        let lock = |viewer: &'static str| {
            let state = state.clone();
            async move {
                card_for(&state, in_server(by(viewer), "vault"), "bob")
                    .await
                    .unwrap_or_else(|e| panic!("{viewer}: {}", e.1))
                    .member
                    .expect("membership")
                    .profile_locked_until
            }
        };
        assert_eq!(lock("alice").await, Some(until));
        assert_eq!(lock("carol").await, None);
        assert_eq!(lock("bob").await, None);
        exec(
            db,
            "UPDATE member_profiles SET locked_until = 5 WHERE username = 'bob'",
        )
        .await;
        assert_eq!(lock("alice").await, None, "a lock that ended");
        done(state, path).await;
    }

    #[tokio::test]
    async fn cards_follow_the_profile_choices() {
        use crate::api::access::subjects::{
            ALL_CHOICES, Level, OWN_CHOICES, SITE_LEVELS, wanted_level,
        };
        let (state, path) = temp_state("card_choices").await;
        let state = state.with_limits(std::sync::Arc::new(crate::limits::Limits {
            lookup_profile_per_minute: 10_000,
            lookup_misses_per_hour: 0,
            ..crate::limits::Limits::default()
        }));
        let db = &state.db;
        world(&state).await;
        let guest = Ask::default();
        for (site, instance) in SITE_LEVELS {
            for (allowed, choices) in ALL_CHOICES {
                for (key, value) in [("profile_visibility", site), ("profile_choices", allowed)] {
                    sqlx::query("UPDATE settings SET value = $1 WHERE key = $2")
                        .bind(value)
                        .bind(key)
                        .execute(db)
                        .await
                        .expect("setting");
                }
                crate::api::Settings::forget(db);
                for choice in OWN_CHOICES {
                    sqlx::query("INSERT INTO privacy(username, profile) VALUES('bob', $1) ON CONFLICT(username) DO UPDATE SET profile = excluded.profile")
                        .bind(choice)
                        .execute(db)
                        .await
                        .expect("choice");
                    let level = wanted_level(instance, choices, choice);
                    let what = format!("{site}, {allowed}, {choice:?}");
                    let shown = |yes: bool| yes.then_some((true, false));
                    for (who, ask) in [("carol", by("carol")), ("a guest", guest)] {
                        assert_eq!(
                            parts(&state, ask, "bob").await,
                            shown(level >= Level::PublicServers),
                            "{who} shares nothing with bob (bob is in rchat): {what}"
                        );
                        assert_eq!(
                            view(&state, ask, "bob").await.is_ok(),
                            level >= Level::PublicServers,
                            "{who}, /profile: {what}"
                        );
                    }
                    assert_eq!(
                        parts(&state, by("alice"), "bob").await,
                        shown(level >= Level::Shared),
                        "alice shares vault: {what}"
                    );
                    assert_eq!(
                        parts(&state, in_server(by("alice"), "vault"), "bob").await,
                        Some((level >= Level::Shared, true)),
                        "the membership shows whatever the choice: {what}"
                    );
                    assert_eq!(
                        parts(&state, by("bob"), "bob").await,
                        Some((true, false)),
                        "bob sees his own: {what}"
                    );
                }
            }
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn cards_through_a_server_that_keeps_its_members() {
        let (state, path) = temp_state("card_member_privacy").await;
        let db = &state.db;
        world(&state).await;
        let grant = Ask {
            grant: Some("g1"),
            ..Ask::default()
        };
        let cases = [
            (
                "carol, rchat named",
                in_server(by("carol"), "rchat"),
                "rchat",
            ),
            (
                "a guest, rchat named",
                in_server(Ask::default(), "rchat"),
                "rchat",
            ),
            ("a guest's grant", grant, "vault"),
            (
                "a guest's grant, vault named",
                in_server(grant, "vault"),
                "vault",
            ),
        ];
        let root = Ask {
            viewer: Some("root"),
            admin: true,
            ..Ask::default()
        };
        for visible in [true, false] {
            exec(
                db,
                &format!(
                    "UPDATE servers SET members_visible = {}",
                    i64::from(visible)
                ),
            )
            .await;
            for through in ["vault", "rchat"] {
                assert_eq!(
                    parts(&state, in_server(root, through), "bob").await,
                    Some((visible, true)),
                    "the site admin, {through} named: {visible}"
                );
            }
        }
        for (what, ask, through) in cases {
            for visible in [true, false] {
                sqlx::query("UPDATE servers SET members_visible = $1 WHERE name = $2")
                    .bind(i64::from(visible))
                    .bind(through)
                    .execute(db)
                    .await
                    .expect("option");
                let member = ask.server.is_some();
                let want = visible.then_some((true, member));
                assert_eq!(parts(&state, ask, "bob").await, want, "{what}: {visible}");
                assert_eq!(
                    view(&state, ask, "bob").await.is_ok(),
                    visible,
                    "{what}, /profile: {visible}"
                );
            }
        }
        exec(db, "UPDATE servers SET members_visible = 0").await;
        assert_eq!(
            parts(&state, in_server(by("alice"), "vault"), "bob").await,
            Some((true, true)),
            "members still see each other"
        );
        exec(
            db,
            "INSERT INTO privacy(username, profile) VALUES('bob', 'everyone')",
        )
        .await;
        assert_eq!(
            parts(&state, by("carol"), "bob").await,
            Some((true, false)),
            "bob's own everyone still applies"
        );
        done(state, path).await;
    }

    /// What `GET /users/search` answers: the usernames, or the refusal.
    type SearchRefusal = Box<(StatusCode, String, Option<Reason>)>;

    async fn searched(
        state: &AppState,
        ask: Ask<'_>,
        q: &str,
        limit: Option<i64>,
    ) -> Result<Vec<String>, SearchRefusal> {
        let res = search(
            State(state.clone()),
            MaybeAuthed(ask.viewer.map(|name| mem_user(name, ask.admin))),
            headers_of(ask),
            Query(UserSearchQuery {
                q: Some(q.to_string()),
                server: ask.server.map(str::to_string),
                limit,
            }),
        )
        .await
        .map_err(|ApiError(code, text, reason)| Box::new((code, text, reason.map(|r| *r))))?;
        let res = res.into_response();
        assert_eq!(res.headers()[header::CACHE_CONTROL], "private, max-age=15");
        let body = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .expect("body");
        let rows: Vec<UserRef> = serde_json::from_slice(&body).expect("json");
        Ok(rows.into_iter().map(|u| u.username).collect())
    }

    async fn set_site(db: &Db, site: &str, choices: &str) {
        for (key, value) in [("profile_visibility", site), ("profile_choices", choices)] {
            sqlx::query("UPDATE settings SET value = $1 WHERE key = $2")
                .bind(value)
                .bind(key)
                .execute(db)
                .await
                .expect("setting");
        }
        crate::api::Settings::forget(db);
    }

    async fn choose(db: &Db, name: &str, choice: Option<&str>) {
        sqlx::query("INSERT INTO privacy(username, profile) VALUES($1, $2) ON CONFLICT(username) DO UPDATE SET profile = excluded.profile")
            .bind(name)
            .bind(choice)
            .execute(db)
            .await
            .expect("choice");
    }

    /// alice is in club with pa_mate and zz_y (shown as "Pa Mate"), a friend of pa_friend and in
    /// a DM pa_dm wrote in. pa_ctx is in the public server town, pa_pub in the public server
    /// plaza, pa_local in the password server hush, and pa_loner, pa_z1, pa_z2 and zz_x ("Pa
    /// Hidden") in nothing.
    async fn search_world(state: &AppState) {
        let db = &state.db;
        for (name, display) in [
            ("alice", "alice"),
            ("pa_ctx", "pa_ctx"),
            ("pa_friend", "pa_friend"),
            ("pa_dm", "pa_dm"),
            ("pa_mate", "pa_mate"),
            ("pa_pub", "pa_pub"),
            ("pa_local", "pa_local"),
            ("pa_loner", "pa_loner"),
            ("zz_x", "Pa Hidden"),
            ("zz_y", "Pa Mate"),
            ("pa_z1", "pa_z1"),
            ("pa_z2", "pa_z2"),
        ] {
            crate::db::NewUser::plain(name)
                .shown(display)
                .at(1)
                .add(db)
                .await;
        }
        for (name, password) in [
            ("club", Some("hash")),
            ("town", None),
            ("plaza", None),
            ("hush", Some("hash")),
        ] {
            sqlx::query("INSERT INTO servers(name, display_name, password_hash, created_at) VALUES($1, $1, $2, 0)")
                .bind(name)
                .bind(password)
                .execute(db)
                .await
                .expect("server");
        }
        for (server, name) in [
            ("club", "alice"),
            ("club", "pa_mate"),
            ("club", "zz_y"),
            ("town", "pa_ctx"),
            ("plaza", "pa_pub"),
            ("hush", "pa_local"),
        ] {
            add_member(db, server, name, 0, 0, 1).await;
        }
        exec(db, "INSERT INTO friends(username, friend, created_at) VALUES('alice', 'pa_friend', 1), ('pa_friend', 'alice', 1)").await;
        let dm: i64 =
            sqlx::query("INSERT INTO dms(user_a, user_b) VALUES('alice', 'pa_dm') RETURNING id")
                .fetch_one(db)
                .await
                .expect("dm")
                .try_get(0)
                .expect("id");
        sqlx::query(
            "INSERT INTO messages(dm_id, author, content, created_at) VALUES($1, 'pa_dm', 'hi', 1)",
        )
        .bind(dm)
        .execute(db)
        .await
        .expect("message");
    }

    fn fast(state: AppState) -> AppState {
        state.with_limits(std::sync::Arc::new(crate::limits::Limits {
            lookup_search_per_minute: 1_000,
            ..crate::limits::Limits::default()
        }))
    }

    #[tokio::test]
    async fn the_user_search_finds_who_the_caller_may_see_in_order() {
        let (state, path) = temp_state("user_search").await;
        let state = fast(state);
        let db = &state.db;
        search_world(&state).await;
        let alice = in_server(by("alice"), "town");
        let names = |list: &[&str]| list.iter().map(|n| n.to_string()).collect::<Vec<_>>();
        let first = names(&["pa_ctx", "pa_friend", "pa_dm", "pa_mate", "zz_y"]);
        assert_eq!(
            searched(&state, alice, "pa", None).await,
            Ok(first.clone()),
            "the named server, friends, DMs, then shared servers"
        );
        assert_eq!(
            searched(&state, alice, "PA ", Some(10)).await,
            Ok(first.clone())
        );
        set_site(db, "public_servers", "any").await;
        let mut public = first.clone();
        public.push("pa_pub".to_string());
        assert_eq!(searched(&state, alice, "pa", None).await, Ok(public));
        set_site(db, "everyone", "any").await;
        let mut everyone = first.clone();
        everyone.extend(names(&["pa_local", "pa_loner", "pa_pub", "pa_z1", "pa_z2"]));
        assert_eq!(
            searched(&state, alice, "pa", Some(10)).await,
            Ok(everyone.clone()),
            "zz_x is the eleventh"
        );
        assert_eq!(
            searched(&state, alice, "pa", None).await,
            Ok(everyone[..8].to_vec()),
            "eight by default"
        );
        assert_eq!(
            searched(&state, alice, "pa", Some(50)).await,
            Ok(everyone.clone()),
            "at most ten"
        );
        assert_eq!(
            searched(&state, alice, "pa", Some(0)).await,
            Ok(vec!["pa_ctx".to_string()]),
            "at least one"
        );
        set_site(db, "shared", "any").await;
        assert_eq!(
            searched(&state, by("alice"), "pa", None).await,
            Ok(names(&["pa_friend", "pa_dm", "pa_mate", "zz_y"])),
            "without the server named"
        );
        assert_eq!(
            searched(&state, by("alice"), "pa h", None).await,
            Ok(Vec::new()),
            "zz_x is hidden by its display name too"
        );
        assert_eq!(
            searched(&state, by("alice"), "pa m", None).await,
            Ok(names(&["zz_y"]))
        );
        choose(db, "pa_loner", Some("everyone")).await;
        assert!(
            searched(&state, by("alice"), "pa_lo", None)
                .await
                .expect("search")
                .contains(&"pa_loner".to_string()),
            "an account's own everyone"
        );
        set_site(db, "shared", "narrower").await;
        assert_eq!(
            searched(&state, by("alice"), "pa_lo", None).await,
            Ok(Vec::new()),
            "only narrower choices apply"
        );
        set_site(db, "shared", "any").await;
        choose(db, "pa_loner", None).await;
        choose(db, "pa_mate", Some("friends")).await;
        assert_eq!(
            searched(&state, by("alice"), "pa_m", None).await,
            Ok(Vec::new()),
            "a friends-only account is not found by a fellow member"
        );
        choose(db, "pa_mate", None).await;
        exec(
            db,
            "UPDATE servers SET members_visible = 0 WHERE name = 'town'",
        )
        .await;
        assert_eq!(
            searched(&state, alice, "pa_c", None).await,
            Ok(Vec::new()),
            "town keeps its members to itself"
        );
        exec(db, "UPDATE servers SET members_visible = 1").await;
        let guest = Ask::default();
        assert_eq!(
            searched(&state, guest, "pa", None).await,
            Ok(Vec::new()),
            "a guest names no server"
        );
        assert_eq!(
            searched(&state, in_server(guest, "plaza"), "pa", None).await,
            Ok(names(&["pa_pub"])),
            "a guest finds a public server's members with it named"
        );
        let refused = |res: Result<Vec<String>, SearchRefusal>| *res.expect_err("refused");
        let short = invalid("Search text needs at least 2 characters", "q");
        for q in ["p", " p ", "", "  "] {
            assert_eq!(
                refused(searched(&state, alice, q, None).await),
                short,
                "{q:?}"
            );
        }
        assert_eq!(
            refused(searched(&state, alice, &"p".repeat(33), None).await),
            invalid("Search text must be at most 32 characters", "q")
        );
        for q in ["p\0a", "\0pa"] {
            assert_eq!(
                refused(searched(&state, alice, q, None).await),
                invalid("Search text cannot contain NUL characters", "q"),
                "{q:?}"
            );
        }
        assert_eq!(
            refused(searched(&state, in_server(alice, "pl\0aza"), "pa", None).await),
            invalid("Server name cannot contain NUL characters", "server")
        );
        let nowhere =
            refused(searched(&state, in_server(by("alice"), "nowhere"), "pa", None).await);
        assert_eq!(nowhere.0, StatusCode::NOT_FOUND);
        assert_eq!(
            refused(searched(&state, in_server(by("alice"), "hush"), "pa", None).await),
            nowhere,
            "a server the caller can't open is the uniform 404"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn the_user_search_follows_every_choice() {
        use crate::api::access::subjects::{
            ALL_CHOICES, Level, OWN_CHOICES, SITE_LEVELS, wanted_level,
        };
        let (state, path) = temp_state("user_search_choices").await;
        let state = fast(state);
        let db = &state.db;
        search_world(&state).await;
        for (site, instance) in SITE_LEVELS {
            for (allowed, choices) in ALL_CHOICES {
                set_site(db, site, allowed).await;
                for choice in OWN_CHOICES {
                    for name in ["pa_mate", "pa_loner", "pa_pub"] {
                        choose(db, name, choice).await;
                    }
                    let level = wanted_level(instance, choices, choice);
                    let found = searched(&state, by("alice"), "pa", Some(10))
                        .await
                        .expect("search");
                    let what = format!("{site}, {allowed}, {choice:?}");
                    for (name, want) in [
                        ("pa_mate", level >= Level::Shared),
                        ("pa_pub", level >= Level::PublicServers),
                        ("pa_loner", level == Level::Everyone),
                    ] {
                        assert_eq!(found.contains(&name.to_string()), want, "{name}: {what}");
                    }
                    assert!(found.contains(&"pa_friend".to_string()), "{what}");
                }
            }
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn the_user_search_keeps_a_servers_members_to_itself() {
        let (state, path) = temp_state("user_search_kept").await;
        let state = fast(state);
        let db = &state.db;
        search_world(&state).await;
        set_site(db, "everyone", "any").await;
        add_member(db, "town", "pa_z2", 0, 0, 1).await;
        let (alice, there) = (by("alice"), in_server(by("alice"), "town"));
        let (guest, guest_there) = (Ask::default(), in_server(Ask::default(), "town"));
        let plain = searched(&state, alice, "pa", Some(10))
            .await
            .expect("search");
        let blind = searched(&state, guest, "pa", Some(10))
            .await
            .expect("search");
        for (ask, without) in [(there, &plain), (guest_there, &blind)] {
            let named = searched(&state, ask, "pa", Some(10)).await.expect("search");
            assert_eq!(
                named[..2],
                ["pa_ctx".to_string(), "pa_z2".to_string()],
                "town shows its members: they come first"
            );
            assert_ne!(&named, without);
        }
        exec(
            db,
            "UPDATE servers SET members_visible = 0 WHERE name = 'town'",
        )
        .await;
        add_member(db, "town", "pa_friend", 0, 0, 1).await;
        for (ask, without) in [(there, &plain), (guest_there, &blind)] {
            assert_eq!(
                &searched(&state, ask, "pa", Some(10)).await.expect("search"),
                without,
                "town keeps its members: naming it tells someone outside it nothing"
            );
        }
        add_member(db, "town", "alice", 0, 0, 1).await;
        let inside = searched(&state, there, "pa", Some(10))
            .await
            .expect("search");
        assert_eq!(
            inside[..3],
            [
                "pa_ctx".to_string(),
                "pa_friend".to_string(),
                "pa_z2".to_string()
            ],
            "its members still find each other first"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn an_accounts_own_everyone_reaches_whoever_can_use_the_app() {
        let (state, path) = temp_state("own_everyone").await;
        let state = fast(state);
        let db = &state.db;
        search_world(&state).await;
        let guest = Ask::default();
        let callers = [
            ("a stranger", by("pa_z1")),
            ("a guest", guest),
            ("a guest naming a server", in_server(guest, "plaza")),
        ];
        let found = vec!["pa_loner".to_string()];
        for (who, ask) in callers {
            assert_eq!(parts(&state, ask, "pa_loner").await, None, "{who}");
            assert_eq!(
                searched(&state, ask, "pa_lo", None).await,
                Ok(Vec::new()),
                "{who}"
            );
        }
        choose(db, "pa_loner", Some("everyone")).await;
        for (who, ask) in callers {
            assert_eq!(
                parts(&state, ask, "pa_loner").await,
                Some((true, false)),
                "{who} sees the card"
            );
            assert!(view(&state, ask, "pa_loner").await.is_ok(), "{who}");
            assert_eq!(
                searched(&state, ask, "pa_lo", None).await,
                Ok(found.clone()),
                "{who} finds the account by name"
            );
        }
        for choices in ["narrower", "site"] {
            set_site(db, "shared", choices).await;
            for (who, ask) in callers {
                assert_eq!(
                    parts(&state, ask, "pa_loner").await,
                    None,
                    "{who}, {choices}"
                );
                assert_eq!(
                    searched(&state, ask, "pa_lo", None).await,
                    Ok(Vec::new()),
                    "{who}, {choices}"
                );
            }
        }
        set_site(db, "shared", "any").await;
        exec(
            db,
            "UPDATE settings SET value = '0' WHERE key = 'guests_enabled'",
        )
        .await;
        crate::api::Settings::forget(db);
        let off = (
            StatusCode::UNAUTHORIZED,
            "Guest access is disabled".to_string(),
            None,
        );
        for (who, ask) in &callers[1..] {
            assert_eq!(
                refusal(card_for(&state, *ask, "pa_loner").await),
                Some(off.clone()),
                "{who}"
            );
            assert_eq!(
                searched(&state, *ask, "pa_lo", None).await,
                Err(Box::new(off.clone())),
                "{who}"
            );
        }
        let (_, stranger) = callers[0];
        assert_eq!(
            parts(&state, stranger, "pa_loner").await,
            Some((true, false)),
            "an account still sees it with guest access off"
        );
        assert_eq!(searched(&state, stranger, "pa_lo", None).await, Ok(found));
        done(state, path).await;
    }

    #[tokio::test]
    async fn the_user_search_is_quick_for_someone_in_many_servers() {
        let (state, path) = temp_state("user_search_heavy").await;
        let state = fast(state);
        let db = &state.db;
        for name in ["alice", "zed"] {
            insert_user(db, name, 1).await;
        }
        exec(db, "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200) INSERT INTO servers(name, display_name, creator, password_hash, created_at) SELECT 'h' || i, 'H', NULL, 'hash', 0 FROM n").await;
        for i in 1..=200 {
            insert_user(db, &format!("m{i}"), 1).await;
        }
        exec(db, "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200) INSERT INTO members(server, username, is_admin, perms, joined_at) SELECT 'h' || i, 'alice', 0, 0, 1 FROM n").await;
        exec(db, "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200) INSERT INTO members(server, username, is_admin, perms, joined_at) SELECT 'h' || i, 'm' || i, 0, 0, 1 FROM n").await;
        let mut best = std::time::Duration::MAX;
        for _ in 0..3 {
            let start = std::time::Instant::now();
            for n in 0..20 {
                let found = searched(&state, by("alice"), &format!("m{}", n % 9 + 1), None)
                    .await
                    .expect("search");
                assert!(!found.is_empty());
            }
            best = best.min(start.elapsed() / 20);
        }
        println!("user search for an account in 200 servers: {best:?} a search");
        assert!(
            best < std::time::Duration::from_millis(250),
            "{best:?} a search"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn card_parts() {
        let (state, path) = temp_state("card_parts").await;
        let db = &state.db;
        let role = world(&state).await;
        let alice = by("alice");
        let both = card_for(&state, in_server(alice, "vault"), "bob")
            .await
            .expect("both");
        assert_eq!(
            serde_json::to_value(&both).expect("json"),
            json!({
                "user": {
                    "username": "bob",
                    "display_name": "bob",
                    "avatar_kind": "identicon",
                    "avatar_color": null,
                },
                "profile": {"bio": "about bob", "banner_color": "#102030", "created_at": 22},
                "member": {
                    "is_admin": false,
                    "is_creator": false,
                    "perms": 0,
                    "role_ids": [role],
                    "roles": [{"id": role, "name": "mods", "color": "#ff0000", "perms": 4, "mentionable": false, "position": 0, "display_position": null, "hoist": false, "icon": null, "color_names": true}],
                    "joined_at": 200,
                    "online": false,
                },
            })
        );
        let profile_only = card_for(&state, alice, "bob").await.expect("profile only");
        assert!(profile_only.profile.is_some() && profile_only.member.is_none());
        assert_eq!(
            serde_json::to_value(&profile_only).expect("json")["member"],
            json!(null)
        );

        exec(
            db,
            "INSERT INTO privacy(username, profile) VALUES('bob', 'friends')",
        )
        .await;
        let member_only = card_for(&state, in_server(alice, "vault"), "bob")
            .await
            .expect("member only");
        let wire = serde_json::to_value(&member_only).expect("json");
        assert_eq!(wire["profile"], json!(null));
        assert_eq!(wire["member"]["joined_at"], json!(200));
        assert_eq!(wire["user"]["username"], json!("bob"));
        assert!(!wire.to_string().contains("about bob"));
        assert!(!wire.to_string().contains("#102030"));
        assert_eq!(
            refusal(card_for(&state, alice, "bob").await),
            hidden(),
            "neither part without the server"
        );
        assert_eq!(
            refusal(card_for(&state, in_server(alice, "rchat"), "bob").await),
            None,
            "membership in a public server shows too"
        );
        let unknown = refusal(card_for(&state, in_server(alice, "vault"), "ghost").await);
        assert_eq!(unknown, hidden());
        assert_eq!(
            refusal(card_for(&state, in_server(by("carol"), "vault"), "bob").await),
            unknown,
            "hidden and missing accounts answer the same"
        );
        assert_eq!(
            card_for(&state, in_server(by("bob"), "vault"), "bob")
                .await
                .expect("own card")
                .profile
                .map(|facts| (facts.bio, facts.banner_color, facts.created_at)),
            Some((
                Some("about bob".to_string()),
                Some("#102030".to_string()),
                22
            ))
        );
        let sent = Card(both).into_response();
        assert_eq!(sent.status(), StatusCode::OK);
        assert_eq!(sent.headers()[header::CACHE_CONTROL], "private, no-cache");
        assert!(crate::api::CORS_REQUEST_HEADERS.contains(&"x-subject-binding"));
        done(state, path).await;
    }

    #[tokio::test]
    async fn old_profile_shape_follows_the_rule() {
        let (state, path) = temp_state("old_profile").await;
        let db = &state.db;
        world(&state).await;
        let alice = by("alice");
        let seen = view(&state, in_server(alice, "vault"), "bob")
            .await
            .expect("a common server");
        let wire = serde_json::to_value(&seen).expect("json");
        assert_eq!(wire["user"]["username"], json!("bob"));
        assert_eq!(wire["bio"], json!("about bob"));
        assert_eq!(wire["banner_color"], json!("#102030"));
        assert_eq!(wire["created_at"], json!(22));
        assert_eq!(wire["member"]["joined_at"], json!(200));
        assert!(wire.get("profile").is_none(), "the old shape is flat");
        assert_eq!(
            serde_json::to_value(view(&state, alice, "bob").await.expect("no server"))
                .expect("json")["member"],
            json!(null)
        );
        for (ask, target) in [
            (by("carol"), "bob"),
            (by("carol"), "ghost"),
            (Ask::default(), "bob"),
            (Ask::default(), "ghost"),
        ] {
            assert_eq!(
                refusal(view(&state, ask, target).await),
                hidden(),
                "{target}"
            );
        }
        exec(
            db,
            "INSERT INTO privacy(username, profile) VALUES('bob', 'friends')",
        )
        .await;
        assert_eq!(
            refusal(view(&state, in_server(alice, "vault"), "bob").await),
            hidden(),
            "membership alone does not open the old shape"
        );
        assert!(view(&state, by("bob"), "bob").await.is_ok(), "yourself");
        done(state, path).await;
    }

    #[tokio::test]
    async fn banner_color_validation() {
        let (state, path) = temp_state("profile_banner").await;
        insert_user(&state.db, "bob", 0).await;
        let stored = |state: AppState| async move {
            view(&state, by("bob"), "bob")
                .await
                .expect("profile")
                .banner_color
        };
        assert_eq!(
            patch_banner(&state, r##"{"banner_color":"#ABCDEF"}"##)
                .await
                .expect("set"),
            Some("#abcdef".to_string())
        );
        assert_eq!(stored(state.clone()).await.as_deref(), Some("#abcdef"));
        for bad in [
            r#""red""#,
            r##""#abc""##,
            r##""#abcdeg""##,
            r#""""#,
            r##""#1234567""##,
        ] {
            let res = patch_banner(&state, &format!(r#"{{"banner_color":{bad}}}"#)).await;
            assert!(
                matches!(res, Err(ApiError(StatusCode::BAD_REQUEST, _, _))),
                "{bad}"
            );
        }
        assert_eq!(stored(state.clone()).await.as_deref(), Some("#abcdef"));
        let untouched = patch_banner(&state, r#"{"appear_offline":false}"#)
            .await
            .expect("other field");
        assert_eq!(untouched.as_deref(), Some("#abcdef"));
        assert_eq!(
            patch_banner(&state, r#"{"banner_color":null}"#)
                .await
                .expect("clear"),
            None
        );
        assert_eq!(stored(state.clone()).await, None);
        done(state, path).await;
    }
}
