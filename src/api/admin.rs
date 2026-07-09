use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::api::messages::{MsgScope, message_scope};
use crate::api::{ApiError, Authed, ServerSummaryLite, Settings, UserRef};
use crate::db::{AvatarKind, User, get_user};
use crate::state::AppState;
use crate::ws::WsEvent;

#[derive(Serialize)]
pub struct Overview {
    pub server_count: i64,
    pub user_count: i64,
}

#[derive(Deserialize)]
pub struct AdminQuery {
    offset: Option<i64>,
    limit: Option<i64>,
    q: Option<String>,
}

impl AdminQuery {
    fn page(&self) -> (i64, i64, String) {
        let AdminQuery { offset, limit, q } = self;
        (
            offset.unwrap_or(0).max(0),
            limit.unwrap_or(50).clamp(1, 50),
            q.as_deref().unwrap_or("").trim().to_lowercase(),
        )
    }
}

pub fn fuzzy_match(q: &str, name: &str) -> bool {
    let (q, name) = (q.to_lowercase(), name.to_lowercase());
    let mut rest = name.as_str();
    name.contains(&q)
        || q.chars().all(|c| match rest.find(c) {
            Some(i) => {
                rest = &rest[i + c.len_utf8()..];
                true
            }
            None => false,
        })
}

pub(crate) fn is_fuzzy(q: &str) -> bool {
    !q.is_empty() && q.chars().count() <= 8
}

pub(crate) fn like_pattern(q: &str, fuzzy: bool) -> String {
    let mut p = String::from("%");
    for c in q.chars() {
        if matches!(c, '%' | '_' | '\\') {
            p.push('\\');
        }
        p.push(c);
        if fuzzy {
            p.push('%');
        }
    }
    if !fuzzy {
        p.push('%');
    }
    p
}

#[derive(Deserialize)]
pub struct BanReq {
    username: String,
}

#[derive(Serialize)]
pub struct OkResp {
    pub ok: bool,
}

#[derive(Deserialize)]
pub struct SettingsPatch {
    profanity_filter: Option<bool>,
    asset_previews: Option<bool>,
    asset_uploads: Option<bool>,
    guests_enabled: Option<bool>,
}

fn require_site_admin(user: &User) -> Result<(), ApiError> {
    match user.is_site_admin {
        true => Ok(()),
        false => Err(ApiError(StatusCode::NOT_FOUND, "Not found".to_string())),
    }
}

#[utoipa::path(get, path = "/api/settings", responses((status = 200, body = Settings)))]
pub(crate) async fn get_settings(State(state): State<AppState>) -> Json<Settings> {
    Json(Settings::load(&state.db).await)
}

pub(crate) async fn patch_settings(
    State(state): State<AppState>,
    Authed(user): Authed,
    Json(req): Json<SettingsPatch>,
) -> Result<Json<Settings>, ApiError> {
    require_site_admin(&user)?;
    let SettingsPatch {
        profanity_filter,
        asset_previews,
        asset_uploads,
        guests_enabled,
    } = req;
    let pairs = [
        ("profanity_filter", profanity_filter),
        ("asset_previews", asset_previews),
        ("asset_uploads", asset_uploads),
        ("guests_enabled", guests_enabled),
    ];
    for (key, value) in pairs {
        if let Some(on) = value {
            sqlx::query(
                "INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            )
            .bind(key)
            .bind(match on {
                true => "1",
                false => "0",
            })
            .execute(&state.db)
            .await?;
        }
    }
    let settings = Settings::load(&state.db).await;
    state.hub.broadcast(WsEvent::SettingsChanged { settings });
    Ok(Json(settings))
}

pub(crate) async fn overview(
    State(state): State<AppState>,
    Authed(user): Authed,
) -> Result<Json<Overview>, ApiError> {
    require_site_admin(&user)?;
    let server_count: i64 = sqlx::query("SELECT COUNT(*) FROM servers")
        .fetch_one(&state.db)
        .await?
        .try_get(0)?;
    let user_count: i64 = sqlx::query("SELECT COUNT(*) FROM users")
        .fetch_one(&state.db)
        .await?
        .try_get(0)?;
    Ok(Json(Overview {
        server_count,
        user_count,
    }))
}

pub(crate) async fn list_users(
    State(state): State<AppState>,
    Authed(user): Authed,
    Query(query): Query<AdminQuery>,
) -> Result<Json<Vec<UserRef>>, ApiError> {
    require_site_admin(&user)?;
    let (offset, limit, q) = query.page();
    let fuzzy = is_fuzzy(&q);
    let rows = sqlx::query(
        "SELECT username, display_name, avatar_kind, avatar_color FROM users WHERE lower(username) LIKE $1 ESCAPE '\\' OR lower(display_name) LIKE $1 ESCAPE '\\' ORDER BY username LIMIT $2 OFFSET $3",
    )
    .bind(like_pattern(&q, fuzzy))
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;
    let mut users = Vec::with_capacity(rows.len());
    for r in &rows {
        let username: String = r.try_get(0)?;
        let display_name: String = r.try_get(1)?;
        if fuzzy && !(fuzzy_match(&q, &username) || fuzzy_match(&q, &display_name)) {
            continue;
        }
        users.push(UserRef {
            username,
            display_name,
            avatar_kind: AvatarKind::parse(&r.try_get::<String, _>(2)?)?,
            avatar_color: r.try_get(3)?,
        });
    }
    Ok(Json(users))
}

pub(crate) async fn list_servers(
    State(state): State<AppState>,
    Authed(user): Authed,
    Query(query): Query<AdminQuery>,
) -> Result<Json<Vec<ServerSummaryLite>>, ApiError> {
    require_site_admin(&user)?;
    let (offset, limit, q) = query.page();
    let fuzzy = is_fuzzy(&q);
    let rows = sqlx::query(
        "SELECT name, display_name, creator, password_hash FROM servers WHERE lower(name) LIKE $1 ESCAPE '\\' OR lower(display_name) LIKE $1 ESCAPE '\\' ORDER BY name LIMIT $2 OFFSET $3",
    )
    .bind(like_pattern(&q, fuzzy))
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;
    let mut servers = Vec::with_capacity(rows.len());
    for r in &rows {
        let name: String = r.try_get(0)?;
        let display_name: String = r.try_get(1)?;
        if fuzzy && !(fuzzy_match(&q, &name) || fuzzy_match(&q, &display_name)) {
            continue;
        }
        servers.push(ServerSummaryLite {
            name,
            display_name,
            creator: r.try_get(2)?,
            has_password: r.try_get::<Option<String>, _>(3)?.is_some(),
        });
    }
    Ok(Json(servers))
}

pub(crate) async fn delete_server(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
) -> Result<Json<OkResp>, ApiError> {
    require_site_admin(&user)?;
    let name = name.to_lowercase();
    if name == "rchat" {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "The rchat server cannot be deleted".to_string(),
        ));
    }
    let deleted = sqlx::query("DELETE FROM servers WHERE name = $1")
        .bind(&name)
        .execute(&state.db)
        .await?
        .rows_affected();
    match deleted {
        0 => Err(ApiError(
            StatusCode::NOT_FOUND,
            "Server not found".to_string(),
        )),
        _ => {
            state.hub.broadcast(WsEvent::ServerDeleted { name });
            Ok(Json(OkResp { ok: true }))
        }
    }
}

pub(crate) async fn ban_user(
    State(state): State<AppState>,
    Authed(user): Authed,
    Json(req): Json<BanReq>,
) -> Result<Json<OkResp>, ApiError> {
    require_site_admin(&user)?;
    let BanReq { username } = req;
    let key = username.to_lowercase();
    if key == user.username {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Cannot ban yourself".to_string(),
        ));
    }
    let mut tx = state.db.begin().await?;
    match get_user(&mut *tx, &key).await? {
        Some(_) => {}
        None => {
            return Err(ApiError(
                StatusCode::NOT_FOUND,
                "User not found".to_string(),
            ));
        }
    }
    let servers = member_servers(&mut tx, &key).await?;
    sqlx::query("DELETE FROM messages WHERE author = $1")
        .bind(&key)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM dms WHERE user_a = $1 OR user_b = $2")
        .bind(&key)
        .bind(&key)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM members WHERE username = $1")
        .bind(&key)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM user_roles WHERE username = $1")
        .bind(&key)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM channel_perms WHERE subject = $1")
        .bind(format!("u:{key}"))
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM interactions WHERE username = $1")
        .bind(&key)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM tokens WHERE username = $1")
        .bind(&key)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM users WHERE username = $1")
        .bind(&key)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO banned_usernames(username) VALUES($1) ON CONFLICT(username) DO NOTHING",
    )
    .bind(&key)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    remove_user_events(&state, key, servers);
    Ok(Json(OkResp { ok: true }))
}

async fn member_servers(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    username: &str,
) -> Result<Vec<String>, ApiError> {
    let rows = sqlx::query("SELECT server FROM members WHERE username = $1")
        .bind(username)
        .fetch_all(&mut **tx)
        .await?;
    let mut servers = Vec::with_capacity(rows.len());
    for r in &rows {
        servers.push(r.try_get(0)?);
    }
    Ok(servers)
}

fn remove_user_events(state: &AppState, username: String, servers: Vec<String>) {
    state.hub.broadcast(WsEvent::Banned {
        username: username.clone(),
    });
    for server in servers {
        state.hub.broadcast(WsEvent::MemberLeft {
            server,
            username: username.clone(),
        });
    }
}

pub(crate) async fn delete_user(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(username): Path<String>,
) -> Result<Json<OkResp>, ApiError> {
    require_site_admin(&user)?;
    let key = username.to_lowercase();
    if key == user.username {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Cannot delete yourself".to_string(),
        ));
    }
    let mut tx = state.db.begin().await?;
    match get_user(&mut *tx, &key).await? {
        Some(_) => {}
        None => {
            return Err(ApiError(
                StatusCode::NOT_FOUND,
                "User not found".to_string(),
            ));
        }
    }
    let servers = member_servers(&mut tx, &key).await?;
    sqlx::query("DELETE FROM messages WHERE author = $1")
        .bind(&key)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM dms WHERE user_a = $1 OR user_b = $2")
        .bind(&key)
        .bind(&key)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM members WHERE username = $1")
        .bind(&key)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM user_roles WHERE username = $1")
        .bind(&key)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM channel_perms WHERE subject = $1")
        .bind(format!("u:{key}"))
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM interactions WHERE username = $1")
        .bind(&key)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM tokens WHERE username = $1")
        .bind(&key)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM users WHERE username = $1")
        .bind(&key)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    remove_user_events(&state, key, servers);
    Ok(Json(OkResp { ok: true }))
}

pub(crate) async fn user_servers(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(username): Path<String>,
) -> Result<Json<Vec<ServerSummaryLite>>, ApiError> {
    require_site_admin(&user)?;
    let rows = sqlx::query(
        "SELECT name, display_name, creator, password_hash FROM servers WHERE creator = $1 ORDER BY name",
    )
    .bind(username.to_lowercase())
    .fetch_all(&state.db)
    .await?;
    let mut servers = Vec::with_capacity(rows.len());
    for r in &rows {
        servers.push(ServerSummaryLite {
            name: r.try_get(0)?,
            display_name: r.try_get(1)?,
            creator: r.try_get(2)?,
            has_password: r.try_get::<Option<String>, _>(3)?.is_some(),
        });
    }
    Ok(Json(servers))
}

pub(crate) async fn delete_message(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(id): Path<i64>,
) -> Result<Json<OkResp>, ApiError> {
    require_site_admin(&user)?;
    let scope = message_scope(&state.db, id).await?;
    sqlx::query("DELETE FROM messages WHERE id = $1")
        .bind(id)
        .execute(&state.db)
        .await?;
    let MsgScope {
        channel_id,
        dm_id,
        thread_root_id,
        author: _,
        media_id: _,
        media_filename: _,
        media_kind: _,
        server,
        dm_users,
    } = scope;
    state.hub.broadcast(WsEvent::MessageDeleted {
        server,
        channel_id,
        dm_id,
        dm_users,
        id,
        thread_root_id,
    });
    Ok(Json(OkResp { ok: true }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::auth::{AuthResp, RegisterReq, register};
    use crate::api::test_util::{done, temp_state};
    use crate::db::{Db, now};
    use serde_json::json;

    async fn reg(state: &AppState, name: &str) -> Result<Json<AuthResp>, ApiError> {
        let req: RegisterReq = serde_json::from_value(json!({
            "username": name,
            "password": "a",
            "avatar_kind": "identicon"
        }))
        .expect("register req");
        register(State(state.clone()), Json(req)).await
    }

    async fn count(db: &Db, sql: &str) -> i64 {
        sqlx::query(sql)
            .fetch_one(db)
            .await
            .expect("count query")
            .try_get(0)
            .expect("count value")
    }

    #[tokio::test]
    async fn ban_cascade() {
        let (state, path) = temp_state("ban").await;
        let _ = reg(&state, "alice").await.expect("register alice");
        let _ = reg(&state, "bob").await.expect("register bob");
        let db = &state.db;
        sqlx::query(
            "INSERT INTO servers(name, display_name, creator, created_at) VALUES('bobs', 'Bobs', 'bob', $1)",
        )
        .bind(now())
        .execute(db)
        .await
        .expect("insert server");
        let cid: i64 = sqlx::query("SELECT id FROM channels WHERE server = 'rchat'")
            .fetch_one(db)
            .await
            .expect("general channel")
            .try_get(0)
            .expect("channel id");
        sqlx::query("INSERT INTO messages(channel_id, author, content, created_at) VALUES($1, 'bob', 'hi', $2)")
            .bind(cid)
            .bind(now())
            .execute(db)
            .await
            .expect("bob message");
        let dm: i64 =
            sqlx::query("INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id")
                .fetch_one(db)
                .await
                .expect("open dm")
                .try_get(0)
                .expect("dm id");
        sqlx::query("INSERT INTO messages(dm_id, author, content, created_at) VALUES($1, 'alice', 'yo', $2)")
            .bind(dm)
            .bind(now())
            .execute(db)
            .await
            .expect("dm message");
        let alice = get_user(db, "alice")
            .await
            .expect("query alice")
            .expect("alice");
        let _ = ban_user(
            State(state.clone()),
            Authed(alice),
            Json(BanReq {
                username: "Bob".to_string(),
            }),
        )
        .await
        .expect("ban");
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM users WHERE username = 'bob'").await,
            0
        );
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM tokens WHERE username = 'bob'").await,
            0
        );
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM members WHERE username = 'bob'").await,
            0
        );
        assert_eq!(
            count(
                db,
                "SELECT COUNT(*) FROM dms WHERE user_a = 'bob' OR user_b = 'bob'"
            )
            .await,
            0
        );
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM messages WHERE author = 'bob'").await,
            0
        );
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM messages WHERE dm_id IS NOT NULL").await,
            0
        );
        assert_eq!(
            count(
                db,
                "SELECT COUNT(*) FROM banned_usernames WHERE username = 'bob'"
            )
            .await,
            1
        );
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM servers WHERE name = 'bobs'").await,
            1
        );
        let again = reg(&state, "bob").await;
        match again {
            Err(ApiError(StatusCode::BAD_REQUEST, msg)) => assert_eq!(msg, "Username is banned"),
            _ => panic!("expected banned re-register rejection"),
        }
        done(state, path).await;
    }
}
