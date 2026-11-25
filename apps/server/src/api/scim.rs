use super::{ApiError, Settings, UserRef, admin, auth, names, policy::Policy};
use crate::{
    db::{self, AvatarKind, NO_PASSWORD_HASH, User, now},
    limits::http,
    server::client_ip::ClientIp,
    sso::{accounts, audit, config::ScimDelete, scim::*},
    state::AppState,
    ws::WsEvent,
};
use axum::{
    Json, Router,
    extract::{
        DefaultBodyLimit, Path, Query, Request, State,
        rejection::{JsonRejection, QueryRejection},
    },
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Row, any::AnyRow};
use subtle::ConstantTimeEq;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

type Result<T> = std::result::Result<T, ScimError>;
type Body = std::result::Result<Json<Value>, JsonRejection>;
const USER: &str = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP: &str = "urn:ietf:params:scim:schemas:core:2.0:Group";
const FROM: &str = " FROM scim_users s JOIN users u ON u.username=s.username WHERE s.deleted_at IS NULL AND u.password_hash <> '!purging'";
const FIELDS: &str =
    "s.id,s.external_id,s.created_at,s.updated_at,u.username,u.display_name,u.suspended_at";
impl From<sqlx::Error> for ScimError {
    fn from(e: sqlx::Error) -> Self {
        if e.as_database_error()
            .is_some_and(|e| e.is_unique_violation())
        {
            Self::conflict()
        } else {
            Self::from(ApiError::from(e))
        }
    }
}
impl From<ApiError> for ScimError {
    fn from(e: ApiError) -> Self {
        match e.0 {
            StatusCode::BAD_REQUEST if e.1 == "Username is taken" => Self::conflict(),
            StatusCode::BAD_REQUEST => Self::invalid(),
            StatusCode::NOT_FOUND => Self::missing(),
            StatusCode::SERVICE_UNAVAILABLE => Self::new(e.0, super::SERVER_BUSY),
            status => Self::new(status, "Provisioning failed"),
        }
    }
}
fn body(b: Body) -> Result<Value> {
    let Json(v) = b.map_err(|e| ScimError::new(e.status(), "Invalid SCIM request body"))?;
    if !v.is_object() {
        return Err(ScimError::invalid());
    }
    Ok(v)
}
pub fn routes(state: AppState, key: ClientIp, enabled: bool) -> Router {
    let token = state
        .sso
        .config
        .scim
        .as_ref()
        .filter(|_| enabled)
        .map(|s| s.token_sha256);
    let bucket = http::bucket(30, 2);
    let api = Router::new()
        .route("/v2/ServiceProviderConfig", get(config))
        .route("/v2/ResourceTypes", get(types))
        .route("/v2/Schemas", get(schemas))
        .route("/v2/Users", get(list).post(create))
        .route(
            "/v2/Users/{id}",
            get(one).put(put).patch(patch).delete(delete),
        )
        .fallback(|| async { ScimError::missing() })
        .layer(DefaultBodyLimit::max(BODY_MAX))
        .layer(middleware::from_fn(move |req: Request, next: Next| {
            let key = key.clone();
            let bucket = bucket.clone();
            async move {
                let Some(token) = token else {
                    return ScimError::missing().into_response();
                };
                let valid = req
                    .headers()
                    .get(header::AUTHORIZATION)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.split_once(' '))
                    .is_some_and(|(scheme, t)| {
                        scheme.eq_ignore_ascii_case("bearer")
                            && bool::from(token.ct_eq(&Sha256::digest(t)[..]))
                    });
                if !valid {
                    let ip = key
                        .extract(&req)
                        .unwrap_or(std::net::Ipv4Addr::UNSPECIFIED.into());
                    return if bucket.take(&ip, 1.0, std::time::Instant::now()) {
                        ScimError::new(StatusCode::UNAUTHORIZED, "Unauthorized")
                    } else {
                        ScimError::new(StatusCode::TOO_MANY_REQUESTS, "Too many requests")
                    }
                    .into_response();
                }
                if matches!(
                    *req.method(),
                    axum::http::Method::PATCH | axum::http::Method::POST | axum::http::Method::PUT
                ) && !req
                    .headers()
                    .get(header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|s| s.split(';').next())
                    .is_some_and(|s| {
                        s.trim().eq_ignore_ascii_case(MEDIA)
                            || s.trim().eq_ignore_ascii_case("application/json")
                    })
                {
                    return ScimError::new(
                        StatusCode::UNSUPPORTED_MEDIA_TYPE,
                        "Expected a JSON body",
                    )
                    .into_response();
                }
                next.run(req).await
            }
        }))
        .with_state(state);
    Router::new().nest("/scim", api)
}
fn ok(value: Value) -> Response {
    response(StatusCode::OK, value)
}
fn page(rows: Vec<Value>, total: i64, start: i64) -> Value {
    json!({"schemas":["urn:ietf:params:scim:api:messages:2.0:ListResponse"],"totalResults":total,"startIndex":start,"itemsPerPage":rows.len(),"Resources":rows})
}
/// Read provisioning capabilities.
///
/// Advertises the supported provisioning operations and authentication scheme.
#[utoipa::path(get,path="/scim/v2/ServiceProviderConfig",tag="scim",security(("scim"=[])),responses((status=401,description="A provisioning token is required"),(status=200,description="Read provisioning capabilities.")))]
async fn config() -> Response {
    ok(
        json!({"schemas":["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],"patch":{"supported":true},"bulk":{"supported":false,"maxOperations":0,"maxPayloadSize":0},"filter":{"supported":true,"maxResults":LIST_MAX},"changePassword":{"supported":false},"sort":{"supported":false},"etag":{"supported":false},"authenticationSchemes":[{"type":"oauthbearertoken","name":"Bearer token","description":"SCIM_TOKEN"}]}),
    )
}
/// List provisioning resource types.
///
/// Returns the User and Group resource descriptors.
#[utoipa::path(get,path="/scim/v2/ResourceTypes",tag="scim",security(("scim"=[])),responses((status=401,description="A provisioning token is required"),(status=200,description="List provisioning resource types.")))]
async fn types() -> Response {
    let resources = [("User", USER), ("Group", GROUP)]
        .into_iter()
        .map(|(name, schema)| {
            json!({
                "schemas": ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
                "id": name, "name": name, "endpoint": format!("/{name}s"), "schema": schema,
            })
        })
        .collect();
    ok(page(resources, 2, 1))
}
/// List provisioning schemas.
///
/// Returns attribute definitions for the provisioned resources.
#[utoipa::path(get,path="/scim/v2/Schemas",tag="scim",security(("scim"=[])),responses((status=401,description="A provisioning token is required"),(status=200,description="List provisioning schemas.")))]
async fn schemas() -> Response {
    let schema = |name: &str, id: &str, attrs: &[(&str, &str)]| {
        let attributes = attrs.iter().map(|&(name, kind)| json!({
            "name": name, "type": kind, "multiValued": name == "members",
            "required": name == "userName", "mutability": if matches!(name, "id"|"meta") {"readOnly"} else {"readWrite"}
        })).collect::<Vec<_>>();
        json!({
            "schemas": ["urn:ietf:params:scim:schemas:core:2.0:Schema"],
            "id": id, "name": name, "attributes": attributes,
        })
    };
    ok(page(
        vec![
            schema(
                "User",
                USER,
                &[
                    ("id", "string"),
                    ("externalId", "string"),
                    ("userName", "string"),
                    ("displayName", "string"),
                    ("active", "boolean"),
                    ("meta", "complex"),
                ],
            ),
            schema(
                "Group",
                GROUP,
                &[
                    ("id", "string"),
                    ("externalId", "string"),
                    ("displayName", "string"),
                    ("members", "complex"),
                    ("meta", "complex"),
                ],
            ),
        ],
        2,
        1,
    ))
}
fn resource(row: AnyRow) -> Result<Value> {
    let date = |v: i64| {
        OffsetDateTime::from_unix_timestamp(v)
            .ok()
            .and_then(|v| v.format(&Rfc3339).ok())
            .ok_or_else(|| {
                ScimError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Invalid resource timestamp",
                )
            })
    };
    let id: String = row.try_get("id")?;
    Ok(json!({
        "schemas": [USER], "id": id,
        "externalId": row.try_get::<Option<String>,_>("external_id")?,
        "userName": row.try_get::<String,_>("username")?,
        "displayName": row.try_get::<String,_>("display_name")?,
        "active": row.try_get::<Option<i64>,_>("suspended_at")?.is_none(),
        "meta": {
            "resourceType": "User", "created": date(row.try_get("created_at")?)?,
            "lastModified": date(row.try_get("updated_at")?)?, "location": format!("/scim/v2/Users/{id}"),
        },
    }))
}
async fn get_in(conn: &mut sqlx::AnyConnection, id: &str) -> Result<Value> {
    let sql = format!("SELECT {FIELDS}{FROM} AND s.id=$1");
    resource(
        sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(id)
            .fetch_optional(conn)
            .await?
            .ok_or_else(ScimError::missing)?,
    )
}
/// Read a provisioned user.
///
/// Reads the live resource at the given provisioning identifier.
#[utoipa::path(get,path="/scim/v2/Users/{id}",params(("id" = String, Path, description="Provisioning identifier")),tag="scim",security(("scim"=[])),responses((status=401,description="A provisioning token is required"),(status=200,description="Read a provisioned user.")))]
async fn one(State(state): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    Ok(ok(get_in(&mut *state.db.acquire().await?, &id).await?))
}
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Paging {
    filter: Option<String>,
    start_index: Option<i64>,
    count: Option<i64>,
}
/// List and filter provisioned users.
///
/// Returns a bounded page of live users, optionally matching an equality filter.
#[utoipa::path(get,path="/scim/v2/Users",params(("filter" = Option<String>, Query, description="Attribute equality filter"),("startIndex" = Option<i64>, Query, description="First item, starting at one"),("count" = Option<i64>, Query, description="Maximum number of items")),tag="scim",security(("scim"=[])),responses((status=401,description="A provisioning token is required"),(status=200,description="List and filter provisioned users.")))]
async fn list(
    State(state): State<AppState>,
    q: std::result::Result<Query<Paging>, QueryRejection>,
) -> Result<Response> {
    let Query(q) = q.map_err(|_| ScimError::invalid())?;
    let start = q.start_index.unwrap_or(1).max(1);
    let count = q.count.unwrap_or(LIST_DEFAULT).clamp(0, LIST_MAX);
    let (condition, needle) = match q.filter.as_deref().map(parse_filter).transpose()? {
        None => (" AND CAST($1 AS TEXT)=''", String::new()),
        Some(Filter::UserName(v)) => (" AND s.user_name_key=$1", accounts::user_name_key(&v)),
        Some(Filter::DisplayName(v)) => (" AND lower(u.display_name)=lower($1)", v),
    };
    // Anchor the page to its count so an empty page still returns its total.
    let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
        "WITH matches AS NOT MATERIALIZED (SELECT {FIELDS}{FROM}{condition}),
              totals AS (SELECT COUNT(*) AS total FROM matches),
              items AS (SELECT * FROM matches ORDER BY created_at,id LIMIT $2 OFFSET $3)
         SELECT totals.total,items.* FROM totals LEFT JOIN items ON TRUE
         ORDER BY items.created_at,items.id"
    )))
    .bind(needle)
    .bind(count)
    .bind(start - 1)
    .fetch_all(&state.db)
    .await?;
    let total = rows[0].try_get("total")?;
    let mut resources = Vec::new();
    for row in rows {
        if row.try_get::<Option<String>, _>("id")?.is_some() {
            resources.push(resource(row)?);
        }
    }
    Ok(ok(page(resources, total, start)))
}
/// Create or revive a provisioned user.
///
/// Accepts account attributes and returns the resource location.
#[utoipa::path(post,path="/scim/v2/Users",tag="scim",security(("scim"=[])),request_body(content=Object,content_type="application/scim+json"),responses((status=401,description="A provisioning token is required"),(status=201,description="Create or revive a provisioned user.")))]
async fn create(State(state): State<AppState>, b: Body) -> Result<Response> {
    write(state, WriteTarget::Create, replacement(&body(b)?)?).await
}
/// Replace provisioning attributes.
///
/// Replaces account attributes while keeping the local username.
#[utoipa::path(put,path="/scim/v2/Users/{id}",params(("id" = String, Path, description="Provisioning identifier")),tag="scim",security(("scim"=[])),request_body(content=Object,content_type="application/scim+json"),responses((status=401,description="A provisioning token is required"),(status=200,description="Replace provisioning attributes.")))]
async fn put(State(state): State<AppState>, Path(id): Path<String>, b: Body) -> Result<Response> {
    write(state, WriteTarget::Replace(id), replacement(&body(b)?)?).await
}
/// Update provisioning attributes.
///
/// Applies add, remove, and replace operations to managed attributes.
#[utoipa::path(patch,path="/scim/v2/Users/{id}",params(("id" = String, Path, description="Provisioning identifier")),tag="scim",security(("scim"=[])),request_body(content=Object,content_type="application/scim+json"),responses((status=401,description="A provisioning token is required"),(status=200,description="Update provisioning attributes.")))]
async fn patch(State(state): State<AppState>, Path(id): Path<String>, b: Body) -> Result<Response> {
    write(state, WriteTarget::Patch(id), user_patch(&body(b)?)?).await
}
// Hold the user row through commit so a purge cannot remove the provisioning binding
// and recycle its username between the lookup and the mutation.
async fn lock_user(tx: &mut sqlx::AnyConnection, id: &str) -> Result<User> {
    let row=sqlx::query("UPDATE users SET suspended_at=suspended_at WHERE username=(SELECT username FROM scim_users WHERE id=$1) AND password_hash <> '!purging' RETURNING *").bind(id).fetch_optional(tx).await?.ok_or_else(ScimError::missing)?;
    Ok(User::from_row(&row)?)
}
enum WriteTarget {
    Create,
    Replace(String),
    Patch(String),
}
async fn write(state: AppState, target: WriteTarget, p: UserPatch) -> Result<Response> {
    let create = matches!(target, WriteTarget::Create);
    let replace = matches!(target, WriteTarget::Replace(_));
    let name = p
        .user_name
        .as_deref()
        .map(|raw| accounts::clean_username(raw).ok_or_else(ScimError::invalid))
        .transpose()?;
    let claim = p.user_name.as_deref().map(accounts::user_name_key);
    let shown = match p.display.as_ref() {
        Some(Some(raw)) => accounts::display_from_claim(&state.db, raw).await?,
        _ => None,
    };
    let settings = Settings::cached(&state.db).await;
    let defaults = &Policy::cached(&state.db).await.default_servers;
    let mut tx = auth::begin_account_write(&state.db).await?;
    if create {
        auth::lock_account_creation(&mut tx, defaults).await?
    } else {
        db::lock_new_usernames(&mut tx).await?
    }
    let t = now();
    let mut joined = None;
    let id = match target {
        WriteTarget::Replace(id) | WriteTarget::Patch(id) => {
            get_in(&mut tx, &id).await?;
            id
        }
        WriteTarget::Create => {
            let key = claim.as_deref().ok_or_else(ScimError::invalid)?;
            let row = sqlx::query(
                "SELECT id,deleted_at,external_id FROM scim_users WHERE user_name_key=$1",
            )
            .bind(key)
            .fetch_optional(&mut *tx)
            .await?;
            if let Some(row) = row {
                let previous: Option<String> = row.try_get("external_id")?;
                if row.try_get::<Option<i64>, _>("deleted_at")?.is_none()
                    || p.external_id
                        .as_ref()
                        .and_then(Option::as_ref)
                        .is_some_and(|v| Some(v) != previous.as_ref())
                {
                    return Err(ScimError::conflict());
                }
                row.try_get("id")?
            } else {
                let name = name.as_deref().ok_or_else(ScimError::invalid)?;
                let username = auth::check_new_username(&mut tx, &settings, name).await?;
                let display = shown.as_deref().unwrap_or(name);
                let display = if names::refusal(&mut tx, &username, display).await?.is_none() {
                    display
                } else {
                    name
                };
                joined = Some(
                    auth::add_account(
                        &mut tx,
                        &state.limits,
                        defaults,
                        auth::NewAccount {
                            username: &username,
                            display_name: display,
                            password_hash: NO_PASSWORD_HASH,
                            password_kind: "text",
                            avatar_kind: AvatarKind::Identicon,
                            avatar_color: None,
                            first_is_admin: true,
                        },
                        t,
                    )
                    .await?,
                );
                let id = hex::encode(rand::random::<[u8; 16]>());
                sqlx::query("INSERT INTO scim_users(id,username,user_name_key,created_at,updated_at) VALUES($1,$2,$3,$4,$4)").bind(&id).bind(username).bind(key).bind(t).execute(&mut *tx).await?;
                id
            }
        }
    };
    let mut user = lock_user(&mut tx, &id).await?;
    let mut renamed = false;
    if joined.is_none() && p.display.is_some() {
        let display = shown.as_deref().unwrap_or(&user.username);
        if display != user.display_name {
            let taken = if display.to_lowercase() == user.username {
                names::three_looks(&user.username, display)
                    || names::capitals_pass_for_another(&mut *tx, display, &user.username).await?
            } else {
                names::passes_for_another(&mut *tx, display, &user.username).await?
            };
            if taken {
                return Err(ScimError::conflict());
            }
            auth::update_display_name(&mut tx, &user.username, display).await?;
            user.display_name = display.to_owned();
            renamed = true;
        }
    }
    let changed = match p.active {
        Some(active) => accounts::set_active_in(&mut tx, &user.username, active).await?,
        None => false,
    };
    let row =
        sqlx::query("SELECT user_name_key,external_id,deleted_at FROM scim_users WHERE id=$1")
            .bind(&id)
            .fetch_one(&mut *tx)
            .await?;
    let old_key: String = row.try_get("user_name_key")?;
    let old_external: Option<String> = row.try_get("external_id")?;
    let deleted: Option<i64> = row.try_get("deleted_at")?;
    let key = if replace && p.user_name.as_deref() == Some(&user.username) {
        &old_key
    } else {
        claim.as_ref().unwrap_or(&old_key)
    };
    let external = match p.external_id {
        Some(None) if create => &old_external,
        Some(ref value) => value,
        None => &old_external,
    };
    if deleted.is_some() || changed || renamed || *key != old_key || *external != old_external {
        sqlx::query("UPDATE scim_users SET updated_at=$1,deleted_at=NULL,user_name_key=$2,external_id=$3 WHERE id=$4")
            .bind(t).bind(key).bind(external).bind(&id).execute(&mut *tx).await?;
    }
    let value = get_in(&mut tx, &id).await?;
    tx.commit().await?;
    if changed {
        let action = if p.active == Some(false) {
            user.suspended_at = Some(t);
            state.hub.broadcast(WsEvent::TokensRevoked {
                username: user.username.clone(),
            });
            "scim.user_suspend"
        } else {
            "scim.user_unsuspend"
        };
        audit::note(&state.db, "scim", action, Some(&user.username), json!({})).await;
    }
    if let Some(joined) = joined {
        auth::announce_account(&state, &user, joined).await
    } else if renamed {
        state.hub.broadcast(WsEvent::UserUpdated {
            user: UserRef::from_user(&user),
            scope: super::access::user_scope(&state.db, &user.username).await,
        });
    }
    audit::note(
        &state.db,
        "scim",
        if create {
            "scim.user_create"
        } else {
            "scim.user_update"
        },
        Some(&user.username),
        json!({}),
    )
    .await;
    if create {
        let mut res = response(StatusCode::CREATED, value);
        res.headers_mut().insert(
            header::LOCATION,
            format!("/scim/v2/Users/{id}")
                .parse()
                .expect("hex resource id"),
        );
        Ok(res)
    } else {
        Ok(ok(value))
    }
}
/// Deprovision a user.
///
/// Applies the configured deprovisioning policy.
#[utoipa::path(delete,path="/scim/v2/Users/{id}",params(("id" = String, Path, description="Provisioning identifier")),tag="scim",security(("scim"=[])),responses((status=401,description="A provisioning token is required"),(status=204,description="Deprovision a user.")))]
async fn delete(State(state): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    let mut tx = auth::begin_account_write(&state.db).await?;
    db::lock_new_usernames(&mut tx).await?;
    let user = lock_user(&mut tx, &id).await?;
    get_in(&mut tx, &id).await?;
    match state
        .sso
        .config
        .scim
        .as_ref()
        .ok_or_else(ScimError::missing)?
        .delete
    {
        ScimDelete::Delete => {
            let hidden =
                admin::hide_user_in(&mut tx, &user.username, admin::PurgeKind::User).await?;
            tx.commit().await?;
            hidden.finish(&state).await;
        }
        ScimDelete::Deactivate => {
            let changed = accounts::set_active_in(&mut tx, &user.username, false).await?;
            sqlx::query("UPDATE scim_users SET deleted_at=$2, updated_at=$2 WHERE id=$1")
                .bind(id)
                .bind(now())
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            if changed {
                state.hub.broadcast(WsEvent::TokensRevoked {
                    username: user.username.clone(),
                });
            }
        }
    }
    audit::note(
        &state.db,
        "scim",
        "scim.user_delete",
        Some(&user.username),
        json!({}),
    )
    .await;
    Ok((StatusCode::NO_CONTENT, [(header::CONTENT_TYPE, MEDIA)]).into_response())
}

#[cfg(test)]
mod tests;
