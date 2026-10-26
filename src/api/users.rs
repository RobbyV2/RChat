use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use utoipa::{IntoParams, ToSchema};

use crate::api::servers::server_lite;
use crate::api::{ApiError, MaybeAuthed, Role, UserRef, require_guest_ok, require_server_view};
use crate::db::{Db, User, get_user};
use crate::state::AppState;

#[derive(Deserialize, IntoParams)]
pub struct ProfileQuery {
    server: Option<String>,
}

#[derive(Serialize, ToSchema)]
pub struct ProfileMember {
    pub is_admin: bool,
    pub is_creator: bool,
    pub perms: i64,
    pub role_ids: Vec<i64>,
    pub roles: Vec<Role>,
    pub joined_at: i64,
    pub online: bool,
}

#[derive(Serialize, ToSchema)]
pub struct Profile {
    pub user: UserRef,
    pub banner_color: Option<String>,
    pub created_at: i64,
    pub member: Option<ProfileMember>,
}

async fn member_roles(db: &Db, server: &str, username: &str) -> Result<Vec<Role>, ApiError> {
    let rows = sqlx::query(
        "SELECT r.id, r.name, r.color, r.perms FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.server = $1 AND ur.username = $2 ORDER BY r.id",
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
        });
    }
    Ok(roles)
}

async fn profile_member(
    state: &AppState,
    headers: &HeaderMap,
    viewer: Option<&User>,
    server: &str,
    username: &str,
) -> Result<Option<ProfileMember>, ApiError> {
    let lite = match server_lite(&state.db, server).await? {
        Some(lite) => lite,
        None => return Ok(None),
    };
    match require_server_view(&state.db, headers, &lite, viewer).await {
        Ok(()) => {}
        Err(ApiError(StatusCode::INTERNAL_SERVER_ERROR, e)) => {
            return Err(ApiError(StatusCode::INTERNAL_SERVER_ERROR, e));
        }
        Err(_) => return Ok(None),
    }
    let row = sqlx::query(
        "SELECT is_admin, perms, joined_at FROM members WHERE server = $1 AND username = $2",
    )
    .bind(&lite.name)
    .bind(username)
    .fetch_optional(&state.db)
    .await?;
    match row {
        Some(r) => {
            let roles = member_roles(&state.db, &lite.name, username).await?;
            Ok(Some(ProfileMember {
                is_admin: r.try_get::<i64, _>(0)? != 0,
                is_creator: lite.creator.as_deref() == Some(username),
                perms: r.try_get(1)?,
                role_ids: roles.iter().map(|role| role.id).collect(),
                roles,
                joined_at: r.try_get(2)?,
                online: state.hub.is_online(&lite.name, username),
            }))
        }
        None => Ok(None),
    }
}

#[utoipa::path(get, path = "/api/users/{username}/profile", params(("username" = String, Path), ProfileQuery), responses((status = 200, description = "A user's mini profile: public info, banner color (null means the default derived from the avatar) and account creation time. With `server`, `member` holds their membership in it (admin, creator, permissions, role ids, join time, presence); it is null when the server does not exist, the viewer may not view it (same rules as the member list, guests included) or the user is not a member", body = Profile), (status = 404, description = "User not found")), security((), ("bearer" = [])))]
pub(crate) async fn profile(
    State(state): State<AppState>,
    MaybeAuthed(viewer): MaybeAuthed,
    headers: HeaderMap,
    Path(username): Path<String>,
    Query(q): Query<ProfileQuery>,
) -> Result<Json<Profile>, ApiError> {
    require_guest_ok(&state.db, viewer.as_ref()).await?;
    let user = get_user(&state.db, &username)
        .await?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "User not found".to_string()))?;
    let ProfileQuery { server } = q;
    let member = match server {
        Some(server) => {
            profile_member(
                &state,
                &headers,
                viewer.as_ref(),
                &server.to_lowercase(),
                &user.username,
            )
            .await?
        }
        None => None,
    };
    Ok(Json(Profile {
        user: UserRef::from_user(&user),
        banner_color: user.banner_color.clone(),
        created_at: user.created_at,
        member,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::auth::{MePatch, patch_me};
    use crate::api::test_util::{add_member, done, mem_user, temp_state};
    use crate::api::{Authed, MaybeAuthed};

    async fn insert_user(db: &Db, name: &str, created_at: i64) {
        sqlx::query("INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, avatar_color, created_at) VALUES($1, $1, '', 'text', 'identicon', NULL, $2)")
            .bind(name)
            .bind(created_at)
            .execute(db)
            .await
            .expect("insert user");
    }

    async fn view(
        state: &AppState,
        viewer: Option<&str>,
        grant: Option<&str>,
        username: &str,
        server: Option<&str>,
    ) -> Result<Profile, ApiError> {
        let mut headers = HeaderMap::new();
        if let Some(grant) = grant {
            headers.insert("x-guest-grant", grant.parse().expect("grant header"));
        }
        profile(
            State(state.clone()),
            MaybeAuthed(viewer.map(|name| mem_user(name, false))),
            headers,
            Path(username.to_string()),
            Query(ProfileQuery {
                server: server.map(str::to_string),
            }),
        )
        .await
        .map(|p| p.0)
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

    #[tokio::test]
    async fn profile_member_visibility_and_fields() {
        let (state, path) = temp_state("profile_visibility").await;
        let db = &state.db;
        for (name, created) in [("alice", 11), ("bob", 22), ("carol", 33)] {
            insert_user(db, name, created).await;
        }
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
            "INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at) VALUES('g1', 'vault', 0, 4000000000)",
        )
        .execute(db)
        .await
        .expect("grant");

        let plain = view(&state, Some("carol"), None, "Bob", None)
            .await
            .expect("plain profile");
        assert_eq!(plain.user.username, "bob");
        assert_eq!(plain.created_at, 22);
        assert_eq!(plain.banner_color, None);
        assert!(plain.member.is_none());

        let bob = view(&state, Some("alice"), None, "bob", Some("Vault"))
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
        let alice = view(&state, Some("bob"), None, "alice", Some("vault"))
            .await
            .expect("creator view")
            .member
            .expect("alice is a member");
        assert!(alice.is_admin && alice.is_creator);
        assert_eq!((alice.role_ids, alice.joined_at), (vec![], 100));
        assert!(alice.roles.is_empty());

        let cases = [
            (Some("carol"), None, "bob", Some("vault"), false),
            (None, None, "bob", Some("vault"), false),
            (None, Some("bad"), "bob", Some("vault"), false),
            (None, Some("g1"), "bob", Some("vault"), true),
            (Some("bob"), None, "carol", Some("vault"), false),
            (None, None, "bob", Some("rchat"), true),
            (None, None, "alice", Some("rchat"), false),
            (Some("bob"), None, "bob", Some("nowhere"), false),
        ];
        for (viewer, grant, target, server, member) in cases {
            let got = view(&state, viewer, grant, target, server)
                .await
                .expect("profile ok")
                .member
                .is_some();
            assert_eq!(got, member, "{viewer:?} {grant:?} {target} {server:?}");
        }
        let site = profile(
            State(state.clone()),
            MaybeAuthed(Some(mem_user("root", true))),
            HeaderMap::new(),
            Path("bob".to_string()),
            Query(ProfileQuery {
                server: Some("vault".to_string()),
            }),
        )
        .await
        .expect("site admin view")
        .0;
        assert!(site.member.is_some());

        assert!(matches!(
            view(&state, None, None, "nobody", Some("vault")).await,
            Err(ApiError(StatusCode::NOT_FOUND, _))
        ));
        sqlx::query("UPDATE settings SET value = '0' WHERE key = 'guests_enabled'")
            .execute(db)
            .await
            .expect("disable guests");
        crate::api::Settings::forget(db);
        assert!(matches!(
            view(&state, None, None, "bob", None).await,
            Err(ApiError(StatusCode::UNAUTHORIZED, _))
        ));
        assert!(view(&state, Some("carol"), None, "bob", None).await.is_ok());
        done(state, path).await;
    }

    #[tokio::test]
    async fn banner_color_validation() {
        let (state, path) = temp_state("profile_banner").await;
        insert_user(&state.db, "bob", 0).await;
        let stored = |state: AppState| async move {
            view(&state, None, None, "bob", None)
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
                matches!(res, Err(ApiError(StatusCode::BAD_REQUEST, _))),
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
