use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, header};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use utoipa::{IntoParams, ToSchema};

use crate::api::access::perms::Perm;
use crate::api::access::{Caller, Proof, ServerAccess, UserView, not_found, view_user};
use crate::api::lookup::{self, LookupClass};
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

async fn member_roles(db: &Db, server: &str, username: &str) -> Result<Vec<Role>, ApiError> {
    let rows = sqlx::query(
        "SELECT r.id, r.name, r.color, r.perms, r.mentionable FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.server = $1 AND ur.username = $2 ORDER BY r.id",
    )
    .bind(server)
    .bind(username)
    .fetch_all(db)
    .await?;
    let mut roles = Vec::with_capacity(rows.len());
    for r in &rows {
        roles.push(Role {
            id: r.try_get(0)?,
            name: r.try_get(1)?,
            color: r.try_get(2)?,
            perms: r.try_get(3)?,
            mentionable: r.try_get::<i64, _>(4)? != 0,
        });
    }
    Ok(roles)
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
            Ok(Some(MemberFacts {
                is_admin: r.try_get::<i64, _>(0)? != 0,
                is_creator: lite.creator.as_deref() == Some(username),
                perms: r.try_get(1)?,
                role_ids: roles.iter().map(|role| role.id).collect(),
                roles,
                joined_at: r.try_get(2)?,
                online: state.hub.is_online(&lite.name, username),
                timeout,
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
    let member = match member {
        Some(access) => member_facts(state, &access, &user.username).await?,
        None => None,
    };
    let profile = seen.map(|_| ProfileFacts {
        bio: user.bio.clone(),
        banner_color: user.banner_color.clone(),
        created_at: user.created_at,
    });
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
/// members of the servers its grants open. The instance's `profile_visibility` in `GET
/// /api/v1/settings` widens this to members of servers anyone can read (`public_servers`) or to
/// every account (`everyone`). An account's own choice (`profile` in `PATCH
/// /api/v1/me/privacy`) may narrow it to friends or widen it to everyone, as far as the
/// instance's `profile_choices` lets it.
///
/// `member` is the account's membership in `server`, set when the caller may view that server
/// and the account is a member, whoever may see the profile. An account with neither part
/// answers the same 404 as a name with no account, after the same checks. Works without a
/// token for guests when guest access is on.
///
/// Each call takes one of the caller's `profile` lookups (`LOOKUP_PROFILE_PER_MINUTE`, 120 a
/// minute by default), counted per account, or per client address without one. A caller that
/// got more 404s for names in an hour than `LOOKUP_MISSES_PER_HOUR` (200 by default) gets the
/// same 429 for every name until the hour ends. The 404s of this endpoint, `POST /api/v1/blocks`
/// and the moderation actions by name count, and those of
/// `GET /api/v1/users/{username}/profile` where this endpoint answers 404 too. General
/// rate-limit bucket.
#[utoipa::path(get, path = "/api/v1/users/{username}/card", tag = "Users", params(("username" = String, Path, description = "Username, case-insensitive"), ProfileQuery, ("X-Guest-Grant" = Option<String>, Header, description = "Guest grants from `POST /api/v1/servers/{name}/guest_access`, comma-separated, up to 100. Only read for guests"), ("X-Subject-Binding" = Option<String>, Header, description = "A P2P binding of the account: the `token` of `POST /api/v1/identity/p2p_binding` as the account showed it in its P2P badge. It shows that account's profile until the binding expires")), responses((status = 200, description = "The account's name with the parts the caller may see: `profile` (null when the account does not show it to the caller) and `member` (null when `server` was omitted, the caller may not view it, or the account is not a member). Never both null", body = UserCard, headers(("cache-control" = String, description = "`private, no-cache`"))), (status = 401, description = "No valid token and guest access is disabled (`Guest access is disabled`)", body = ApiErrorBody), (status = 404, description = "`Not found`: no such account, or one the caller may see nothing of (identical responses)", body = ApiErrorBody), (status = 429, description = "`Too many lookups. Try again later.` with a `Retry-After` header (JSON): the caller used up its `profile` lookups, or its misses for the hour. Or too many requests in the general bucket (plain text)", body = ApiErrorBody)), security((), ("bearer" = [])))]
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
#[utoipa::path(get, path = "/api/v1/users/{username}/profile", tag = "Users", params(("username" = String, Path, description = "Username, case-insensitive"), ProfileQuery, ("X-Guest-Grant" = Option<String>, Header, description = "Guest grants from `POST /api/v1/servers/{name}/guest_access`, comma-separated, up to 100. Only read for guests"), ("X-Subject-Binding" = Option<String>, Header, description = "A P2P binding of the account, as for `GET /api/v1/users/{username}/card`")), responses((status = 200, description = "A user's mini profile: public info, banner color (null means the default derived from the avatar) and account creation time. With `server`, `member` holds their membership in it (admin, creator, permissions, role ids, join time, presence); it is null when the server does not exist, the viewer may not view it (same rules as the member list, guests included) or the user is not a member", body = Profile), (status = 401, description = "No valid token and guest access is disabled (`Guest access is disabled`)", body = ApiErrorBody), (status = 404, description = "`Not found`: no such account, or one whose profile the caller may not see (identical responses)", body = ApiErrorBody), (status = 429, description = "`Too many lookups. Try again later.` with a `Retry-After` header (JSON): the caller used up its `profile` lookups, or its misses for the hour. Or too many requests in the general bucket (plain text)", body = ApiErrorBody)), security((), ("bearer" = [])))]
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
    } = profile.ok_or_else(not_found)?;
    Ok(Json(Profile {
        user,
        banner_color,
        bio,
        created_at,
        member: member.map(ProfileMember::from),
    }))
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
    use crate::api::{Authed, MaybeAuthed, Reason};
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
            .map(|ApiError(code, text, reason)| (code, text, reason))
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
                    "roles": [{"id": role, "name": "mods", "color": "#ff0000", "perms": 4, "mentionable": false}],
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
