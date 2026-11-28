use super::{ApiError, Settings, UserRef, admin, auth, names, policy::Policy};
use crate::{
    db::{self, AvatarKind, NO_PASSWORD_HASH, User},
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
        .route("/v2/Groups", get(group_list).post(group_create))
        .route(
            "/v2/Groups/{id}",
            get(group_one)
                .put(group_put)
                .patch(group_edit)
                .delete(group_delete),
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
                    return if bucket.take(&ip, 1.0, tokio::time::Instant::now()) {
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
            "required": name == "userName" || (id == GROUP && name == "displayName"), "mutability": if matches!(name, "id"|"meta") {"readOnly"} else {"readWrite"}
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
fn date(v: i64) -> Result<String> {
    OffsetDateTime::from_unix_timestamp(v)
        .ok()
        .and_then(|v| v.format(&Rfc3339).ok())
        .ok_or_else(|| {
            ScimError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Invalid resource timestamp",
            )
        })
}
fn resource(row: AnyRow) -> Result<Value> {
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
    excluded_attributes: Option<String>,
    start_index: Option<i64>,
    count: Option<i64>,
}
/// List and filter provisioned users.
///
/// Returns a bounded page of live users, optionally matching an equality filter.
#[utoipa::path(get,path="/scim/v2/Users",operation_id="scim_list_users",params(("filter" = Option<String>, Query, description="Attribute equality filter"),("startIndex" = Option<i64>, Query, description="First item, starting at one"),("count" = Option<i64>, Query, description="Maximum number of items")),tag="scim",security(("scim"=[])),responses((status=401,description="A provisioning token is required"),(status=200,description="List and filter provisioned users.")))]
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
#[utoipa::path(post,path="/scim/v2/Users",operation_id="scim_create_user",tag="scim",security(("scim"=[])),request_body(content=Object,content_type="application/scim+json"),responses((status=401,description="A provisioning token is required"),(status=201,description="Create or revive a provisioned user.")))]
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
    let t = state.clock.unix();
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
            crate::sso::groups::spawn_reconcile(&state, vec![user.username.clone()]);
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
                .bind(state.clock.unix())
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

impl Paging {
    fn include_members(&self) -> bool {
        !self
            .excluded_attributes
            .as_deref()
            .unwrap_or("")
            .split(',')
            .any(|s| s.trim().eq_ignore_ascii_case("members"))
    }
}

async fn read_groups(
    conn: &mut sqlx::AnyConnection,
    id: Option<&str>,
    name: Option<&str>,
    count: i64,
    offset: i64,
    members: bool,
) -> Result<(i64, Vec<Value>)> {
    // One statement keeps the count, group page and member details on the same snapshot.
    // The count row survives even when the requested page is empty.
    let rows = sqlx::query(
        "WITH matching AS (
             SELECT * FROM scim_groups WHERE (CAST($1 AS TEXT) IS NULL OR id=$1)
               AND (CAST($2 AS TEXT) IS NULL OR lower(display_name)=lower($2))
         ), page AS (
             SELECT * FROM matching ORDER BY created_at,id LIMIT $3 OFFSET $4
         )
         SELECT totals.total,p.*,s.id AS member_id,u.display_name AS member_display
         FROM (SELECT COUNT(*) AS total FROM matching) totals
         LEFT JOIN page p ON TRUE
         LEFT JOIN scim_group_members m ON m.group_id=p.id AND $5=1
         LEFT JOIN scim_users s ON s.username=m.username AND s.deleted_at IS NULL
         LEFT JOIN users u ON u.username=s.username AND u.password_hash <> '!purging'
         ORDER BY p.created_at,p.id,s.id",
    )
    .bind(id)
    .bind(name)
    .bind(count)
    .bind(offset)
    .bind(i32::from(members))
    .fetch_all(conn)
    .await?;
    let total = rows[0].try_get("total")?;
    let mut groups = Vec::new();
    let mut rows = rows.into_iter().peekable();
    while let Some(row) = rows.next() {
        let Some(id) = row.try_get::<Option<String>, _>("id")? else {
            break;
        };
        let mut value = json!({"schemas":[GROUP],"id":id,"displayName":row.try_get::<String,_>("display_name")?,
            "externalId":row.try_get::<Option<String>,_>("external_id")?,
            "meta":{"resourceType":"Group","created":date(row.try_get("created_at")?)?,
            "lastModified":date(row.try_get("updated_at")?)?,"location":format!("/scim/v2/Groups/{id}")}});
        if members {
            let mut list = Vec::new();
            let mut member_row = row;
            loop {
                if let Some(display) = member_row.try_get::<Option<String>, _>("member_display")? {
                    list.push(json!({"value":member_row.try_get::<String,_>("member_id")?, "display":display}));
                }
                match rows.next_if(|next| next.get::<String, _>("id") == id) {
                    Some(next) => member_row = next,
                    None => break,
                }
            }
            value["members"] = Value::Array(list);
        }
        groups.push(value);
    }
    Ok((total, groups))
}

async fn group_get_in(conn: &mut sqlx::AnyConnection, id: &str, members: bool) -> Result<Value> {
    read_groups(conn, Some(id), None, 1, 0, members)
        .await?
        .1
        .pop()
        .ok_or_else(ScimError::missing)
}

/// Read a provisioned group.
///
/// Returns the group's current directory attributes and selected memberships.
#[utoipa::path(get,path="/scim/v2/Groups/{id}",params(("id"=String,Path,description="Group identifier"),("excludedAttributes"=Option<String>,Query,description="Attributes to omit")),tag="scim",security(("scim"=[])),responses((status=200,description="Provisioned group"),(status=401,description="A provisioning token is required")))]
async fn group_one(
    State(state): State<AppState>,
    Path(id): Path<String>,
    q: std::result::Result<Query<Paging>, QueryRejection>,
) -> Result<Response> {
    let members = q.map_err(|_| ScimError::invalid())?.include_members();
    Ok(ok(group_get_in(
        &mut *state.db.acquire().await?,
        &id,
        members,
    )
    .await?))
}

/// List provisioned groups.
///
/// Returns a bounded page of groups matching the display name filter.
#[utoipa::path(get,path="/scim/v2/Groups",params(("filter"=Option<String>,Query,description="Display name equality filter"),("startIndex"=Option<i64>,Query,description="First item, starting at one"),("count"=Option<i64>,Query,description="Maximum number of items"),("excludedAttributes"=Option<String>,Query,description="Attributes to omit")),tag="scim",security(("scim"=[])),responses((status=200,description="Group list"),(status=401,description="A provisioning token is required")))]
async fn group_list(
    State(state): State<AppState>,
    q: std::result::Result<Query<Paging>, QueryRejection>,
) -> Result<Response> {
    let q = q.map_err(|_| ScimError::invalid())?;
    let name = match q.filter.as_deref().map(parse_filter).transpose()? {
        Some(Filter::DisplayName(v)) => Some(v),
        None => None,
        _ => return Err(ScimError::bad("invalidFilter", "Unsupported group filter")),
    };
    let start = q.start_index.unwrap_or(1).max(1);
    let count = q.count.unwrap_or(LIST_DEFAULT).clamp(0, LIST_MAX);
    let (total, groups) = read_groups(
        &mut *state.db.acquire().await?,
        None,
        name.as_deref(),
        count,
        start - 1,
        q.include_members(),
    )
    .await?;
    Ok(ok(page(groups, total, start)))
}

enum GroupWrite {
    Create,
    Edit,
    Delete,
}
async fn member_names(
    conn: &mut sqlx::AnyConnection,
    id: &str,
) -> Result<std::collections::BTreeSet<String>> {
    Ok(
        sqlx::query_scalar("SELECT username FROM scim_group_members WHERE group_id=$1")
            .bind(id)
            .fetch_all(conn)
            .await?
            .into_iter()
            .collect(),
    )
}

// Remember both aliases across rename and deletion. Tokens issued before a directory
// change can still arrive afterwards. Only this provider owns the recorded names.
async fn record_group_aliases(
    conn: &mut sqlx::AnyConnection,
    id: &str,
    provider: Option<&str>,
    mut affected: Option<&mut std::collections::BTreeSet<String>>,
) -> sqlx::Result<()> {
    let Some(provider) = provider else {
        return Ok(());
    };
    sqlx::query("UPDATE scim_groups SET alias_source=$1 WHERE id=$2")
        .bind(provider)
        .bind(id)
        .execute(&mut *conn)
        .await?;
    let aliases: Vec<String> = sqlx::query_scalar(
        "SELECT display_name FROM scim_groups WHERE id=$1
         UNION SELECT external_id FROM scim_groups WHERE id=$1 AND external_id IS NOT NULL",
    )
    .bind(id)
    .fetch_all(&mut *conn)
    .await?;
    for alias in aliases {
        let key = accounts::oidc_key(&alias);
        sqlx::query(
            "INSERT INTO scim_owned_aliases(source,grp,alias_key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        )
        .bind(provider)
        .bind(&alias)
        .bind(key.as_str())
        .execute(&mut *conn)
        .await?;
        let Some(affected) = affected.as_deref_mut() else {
            continue;
        };
        affected.extend(
            sqlx::query_scalar::<_, String>(
                "SELECT username FROM sso_user_groups WHERE source=$1 AND grp=$2 AND (alias_key IS NULL OR alias_key=$3)",
            )
            .bind(provider)
            .bind(alias)
            .bind(key.as_str())
            .fetch_all(&mut *conn)
            .await?,
        );
    }
    Ok(())
}

/// Adopt live groups from a pre-ownership database on the first configured API
/// start. Later starts preserve that binding even when the provider changes.
pub(crate) async fn initialize_group_ownership(state: &AppState) -> anyhow::Result<()> {
    let provider = state
        .sso
        .config
        .scim
        .as_ref()
        .and_then(|s| s.provider.as_deref());
    if let Some(provider) = provider {
        let mut tx = auth::begin_account_write(&state.db).await?;
        db::lock_new_usernames(&mut tx).await?;
        loop {
            let groups: Vec<String> = sqlx::query_scalar(
                "SELECT id FROM scim_groups WHERE alias_source IS NULL ORDER BY id LIMIT 500",
            )
            .fetch_all(&mut *tx)
            .await?;
            if groups.is_empty() {
                break;
            }
            for id in groups {
                record_group_aliases(&mut tx, &id, Some(provider), None).await?;
            }
        }
        tx.commit().await?;
    }
    // A jobs process can still be committing a first grant based on its earlier
    // lookup. Reconcile every withdrawn claimant under the normal account lock.
    let mut after = String::new();
    let mut first_failure = None;
    loop {
        let users: Vec<String> = sqlx::query_scalar(
            "SELECT DISTINCT c.username FROM sso_user_groups c
             JOIN scim_owned_aliases a ON a.source=c.source AND a.grp=c.grp
                AND (c.alias_key IS NULL OR c.alias_key=a.alias_key)
             WHERE c.username>$1 AND NOT EXISTS (
                 SELECT 1 FROM scim_group_members m JOIN scim_groups g ON g.id=m.group_id
                 WHERE m.username=c.username AND (g.display_name=c.grp OR g.external_id=c.grp))
             ORDER BY c.username LIMIT 500",
        )
        .bind(&after)
        .fetch_all(&state.db)
        .await?;
        if users.is_empty() {
            return first_failure.map_or(Ok(()), Err);
        }
        for user in users {
            if let Err(error) = crate::sso::groups::reconcile(state, &user).await {
                tracing::warn!(username = %user, reason = %error.1, "SCIM startup reconciliation failed");
                if !crate::sso::groups::is_membership_limit(&error) {
                    first_failure.get_or_insert_with(|| {
                        anyhow::anyhow!("SCIM startup reconciliation failed for {user}: {error:?}")
                    });
                }
            }
            after = user;
        }
    }
}

async fn group_write(
    state: AppState,
    id: String,
    mode: GroupWrite,
    changes: Vec<GroupChange>,
) -> Result<Response> {
    let mut tx = auth::begin_account_write(&state.db).await?;
    db::lock_new_usernames(&mut tx).await?;
    let t = state.clock.unix();
    if matches!(mode, GroupWrite::Create) {
        let display = changes
            .iter()
            .find_map(|op| {
                if let GroupChange::Display(v) = op {
                    Some(v)
                } else {
                    None
                }
            })
            .ok_or_else(ScimError::invalid)?;
        sqlx::query(
            "INSERT INTO scim_groups(id,display_name,created_at,updated_at) VALUES($1,$2,$3,$3)",
        )
        .bind(&id)
        .bind(display)
        .bind(t)
        .execute(&mut *tx)
        .await?;
    } else if sqlx::query("UPDATE scim_groups SET updated_at=$1 WHERE id=$2")
        .bind(t)
        .bind(&id)
        .execute(&mut *tx)
        .await?
        .rows_affected()
        == 0
    {
        return Err(ScimError::missing());
    }
    let before = member_names(&mut tx, &id).await?;
    let provider = state
        .sso
        .config
        .scim
        .as_ref()
        .and_then(|s| s.provider.as_deref());
    let mut affected = before.clone();
    record_group_aliases(&mut tx, &id, provider, Some(&mut affected)).await?;
    for change in changes {
        if matches!(change, GroupChange::Replace(_)) {
            sqlx::query("DELETE FROM scim_group_members WHERE group_id=$1")
                .bind(&id)
                .execute(&mut *tx)
                .await?;
        }
        match change {
            GroupChange::Display(name) => {
                sqlx::query("UPDATE scim_groups SET display_name=$1 WHERE id=$2")
                    .bind(name)
                    .bind(&id)
                    .execute(&mut *tx)
                    .await?;
            }
            GroupChange::External(external) => {
                sqlx::query("UPDATE scim_groups SET external_id=$1 WHERE id=$2")
                    .bind(external)
                    .bind(&id)
                    .execute(&mut *tx)
                    .await?;
            }
            GroupChange::Remove(ids) => {
                for user in ids {
                    sqlx::query("DELETE FROM scim_group_members WHERE group_id=$1 AND username=(SELECT username FROM scim_users WHERE id=$2)").bind(&id).bind(user).execute(&mut *tx).await?;
                }
            }
            GroupChange::Replace(ids) | GroupChange::Add(ids) => {
                // Hold live account rows through commit so an overlapping purge
                // also removes memberships written by this transaction.
                let lock = if tx.backend_name() == "PostgreSQL" {
                    " FOR SHARE OF u"
                } else {
                    ""
                };
                let insert = format!("INSERT INTO scim_group_members(group_id,username)
                    SELECT $1, live.username FROM (
                        SELECT s.username FROM scim_users s JOIN users u ON u.username=s.username
                        WHERE s.id=$2 AND s.deleted_at IS NULL AND u.password_hash <> '!purging'{lock}
                    ) live WHERE true ON CONFLICT DO NOTHING");
                for user in ids {
                    sqlx::query(sqlx::AssertSqlSafe(insert.as_str()))
                        .bind(&id)
                        .bind(user)
                        .execute(&mut *tx)
                        .await?;
                }
            }
        }
    }
    record_group_aliases(&mut tx, &id, provider, Some(&mut affected)).await?;
    let (action, answer) = match mode {
        GroupWrite::Delete => {
            sqlx::query("DELETE FROM scim_group_members WHERE group_id=$1")
                .bind(&id)
                .execute(&mut *tx)
                .await?;
            sqlx::query("DELETE FROM scim_groups WHERE id=$1")
                .bind(&id)
                .execute(&mut *tx)
                .await?;
            (
                "scim.group_delete",
                (StatusCode::NO_CONTENT, [(header::CONTENT_TYPE, MEDIA)]).into_response(),
            )
        }
        GroupWrite::Edit => (
            "scim.group_update",
            ok(group_get_in(&mut tx, &id, true).await?),
        ),
        GroupWrite::Create => {
            let mut answer = response(StatusCode::CREATED, group_get_in(&mut tx, &id, true).await?);
            answer.headers_mut().insert(
                header::LOCATION,
                format!("/scim/v2/Groups/{id}")
                    .parse()
                    .expect("hex resource id"),
            );
            ("scim.group_create", answer)
        }
    };
    let after = member_names(&mut tx, &id).await?;
    tx.commit().await?;
    affected.extend(after.iter().cloned());
    crate::sso::groups::spawn_reconcile(&state, affected.into_iter().collect());
    audit::note(&state.db,"scim",action,None,json!({"group":id,"added":after.difference(&before).count(),"removed":before.difference(&after).count()})).await;
    Ok(answer)
}

/// Create a provisioned group.
///
/// Applies the directory change and schedules reconciliation of affected accounts.
#[utoipa::path(post,path="/scim/v2/Groups",tag="scim",security(("scim"=[])),request_body(content=Object,content_type="application/scim+json"),responses((status=401,description="A provisioning token is required"),(status=201,description="Create a provisioned group")))]
async fn group_create(State(state): State<AppState>, b: Body) -> Result<Response> {
    group_write(
        state,
        hex::encode(rand::random::<[u8; 16]>()),
        GroupWrite::Create,
        group_replacement(&body(b)?)?,
    )
    .await
}

/// Replace a provisioned group.
///
/// Applies the directory change and schedules reconciliation of affected accounts.
#[utoipa::path(put,path="/scim/v2/Groups/{id}",params(("id" = String, Path, description="Provisioning identifier")),tag="scim",security(("scim"=[])),request_body(content=Object,content_type="application/scim+json"),responses((status=401,description="A provisioning token is required"),(status=200,description="Replace a provisioned group")))]
async fn group_put(
    State(state): State<AppState>,
    Path(id): Path<String>,
    b: Body,
) -> Result<Response> {
    group_write(state, id, GroupWrite::Edit, group_replacement(&body(b)?)?).await
}

/// Update a provisioned group.
///
/// Applies the directory change and schedules reconciliation of affected accounts.
#[utoipa::path(patch,path="/scim/v2/Groups/{id}",params(("id" = String, Path, description="Provisioning identifier")),tag="scim",security(("scim"=[])),request_body(content=Object,content_type="application/scim+json"),responses((status=401,description="A provisioning token is required"),(status=200,description="Update a provisioned group")))]
async fn group_edit(
    State(state): State<AppState>,
    Path(id): Path<String>,
    b: Body,
) -> Result<Response> {
    group_write(state, id, GroupWrite::Edit, group_patch(&body(b)?)?).await
}

/// Delete a provisioned group.
///
/// Applies the directory change and schedules reconciliation of affected accounts.
#[utoipa::path(delete,path="/scim/v2/Groups/{id}",params(("id" = String, Path, description="Provisioning identifier")),tag="scim",security(("scim"=[])),responses((status=401,description="A provisioning token is required"),(status=204,description="Delete a provisioned group")))]
async fn group_delete(State(state): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    group_write(state, id, GroupWrite::Delete, vec![]).await
}

#[cfg(test)]
mod tests;
