use argon2::Argon2;
use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::Row;
use utoipa::ToSchema;

use crate::api::{
    ApiError, Authed, DmSummary, Member, ServerSummary, UserRef, check_profanity, user_ref,
    valid_color,
};
use crate::db::{AvatarKind, Db, User, get_user, now};
use crate::state::AppState;
use crate::ws::WsEvent;

#[derive(Serialize, ToSchema)]
pub struct Me {
    pub username: String,
    pub display_name: String,
    pub avatar_kind: AvatarKind,
    pub avatar_color: Option<String>,
    pub is_site_admin: bool,
    pub servers: Vec<ServerSummary>,
    pub dms: Vec<DmSummary>,
}

#[derive(Serialize, ToSchema)]
pub struct AuthResp {
    pub token: String,
    pub user: Me,
}

#[derive(Serialize, ToSchema)]
pub struct WordsResp {
    pub words: Vec<String>,
}

#[derive(Deserialize, ToSchema)]
pub struct RegisterReq {
    username: String,
    password: Option<String>,
    words: Option<Vec<String>>,
    avatar_kind: AvatarKind,
    avatar_color: Option<String>,
}

#[derive(Deserialize, ToSchema)]
pub struct LoginReq {
    username: String,
    password: Option<String>,
    words: Option<Vec<String>>,
}

fn word_set(username: &str) -> Vec<String> {
    let seed: [u8; 32] = Sha256::digest(username.to_lowercase().as_bytes()).into();
    let mut rng = ChaCha8Rng::from_seed(seed);
    rand::seq::index::sample(&mut rng, memorable_wordlist::WORDS.len(), 20)
        .into_iter()
        .map(|i| memorable_wordlist::WORDS[i].to_string())
        .collect()
}

pub(crate) fn hash_password(secret: &str) -> Result<String, ApiError> {
    let salt = SaltString::generate(&mut OsRng);
    match Argon2::default().hash_password(secret.as_bytes(), &salt) {
        Ok(hash) => Ok(hash.to_string()),
        Err(e) => Err(anyhow::anyhow!(e).into()),
    }
}

pub(crate) fn verify_password(secret: &str, hash: &str) -> bool {
    match PasswordHash::new(hash) {
        Ok(parsed) => Argon2::default()
            .verify_password(secret.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

pub(crate) fn new_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn bad(msg: &str) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, msg.to_string())
}

fn check_avatar(
    avatar_kind: AvatarKind,
    avatar_color: Option<String>,
) -> Result<Option<String>, ApiError> {
    match (avatar_kind, avatar_color) {
        (AvatarKind::Identicon, _) => Ok(None),
        (AvatarKind::Color, Some(color)) if valid_color(&color) => Ok(Some(color.to_lowercase())),
        (AvatarKind::Color, _) => Err(bad("Invalid avatar color")),
    }
}

fn secret_from(
    username: &str,
    password: Option<String>,
    words: Option<Vec<String>>,
    validate_words: bool,
) -> Result<(String, &'static str), ApiError> {
    match (password, words) {
        (Some(password), None) => Ok((password, "text")),
        (None, Some(words)) => {
            let words: Vec<String> = words.into_iter().map(|w| w.to_lowercase()).collect();
            if validate_words {
                let set = word_set(username);
                if words.len() != 7 || words.iter().any(|w| !set.contains(w)) {
                    return Err(bad("Pick 7 words from your word set"));
                }
            }
            Ok((words.join(" "), "words"))
        }
        (_, _) => Err(bad("Provide exactly one of password or words")),
    }
}

pub(crate) async fn me_payload(db: &Db, user: &User) -> Result<Me, ApiError> {
    let rows = sqlx::query(
        "SELECT s.name, s.display_name, s.creator, m.is_admin FROM members m JOIN servers s ON s.name = m.server WHERE m.username = $1 ORDER BY m.joined_at",
    )
    .bind(&user.username)
    .fetch_all(db)
    .await?;
    let mut servers = Vec::with_capacity(rows.len());
    for r in &rows {
        servers.push(ServerSummary {
            name: r.try_get(0)?,
            display_name: r.try_get(1)?,
            creator: r.try_get(2)?,
            is_admin: r.try_get::<i64, _>(3)? != 0,
        });
    }
    let rows = sqlx::query(
        "SELECT id, user_a, user_b FROM dms WHERE user_a = $1 OR user_b = $2 ORDER BY id",
    )
    .bind(&user.username)
    .bind(&user.username)
    .fetch_all(db)
    .await?;
    let mut dms = Vec::with_capacity(rows.len());
    for r in &rows {
        let (id, a, b): (i64, String, String) = (r.try_get(0)?, r.try_get(1)?, r.try_get(2)?);
        let is_self = a == b;
        let other = match a == user.username {
            true => b,
            false => a,
        };
        dms.push(DmSummary {
            id,
            other: user_ref(db, &other).await,
            is_self,
        });
    }
    Ok(Me {
        username: user.username.clone(),
        display_name: user.display_name.clone(),
        avatar_kind: user.avatar_kind,
        avatar_color: user.avatar_color.clone(),
        is_site_admin: user.is_site_admin,
        servers,
        dms,
    })
}

#[utoipa::path(get, path = "/api/auth/words/{username}", params(("username" = String, Path)), responses((status = 200, body = WordsResp)))]
pub(crate) async fn words(Path(username): Path<String>) -> Json<WordsResp> {
    Json(WordsResp {
        words: word_set(&username),
    })
}

#[utoipa::path(post, path = "/api/auth/register", request_body = RegisterReq, responses((status = 200, body = AuthResp)))]
pub(crate) async fn register(
    State(state): State<AppState>,
    Json(req): Json<RegisterReq>,
) -> Result<Json<AuthResp>, ApiError> {
    let RegisterReq {
        username,
        password,
        words,
        avatar_kind,
        avatar_color,
    } = req;
    if username.trim().is_empty() {
        return Err(bad("Username required"));
    }
    let key = username.to_lowercase();
    let (secret, password_kind) = secret_from(&username, password, words, true)?;
    let avatar_color = check_avatar(avatar_kind, avatar_color)?;
    let mut tx = state.db.begin().await?;
    check_profanity(&mut *tx, &username).await?;
    let banned = sqlx::query("SELECT 1 FROM banned_usernames WHERE username = $1")
        .bind(&key)
        .fetch_optional(&mut *tx)
        .await?
        .is_some();
    if banned {
        return Err(bad("Username is banned"));
    }
    if get_user(&mut *tx, &key).await?.is_some() {
        return Err(bad("Username is taken"));
    }
    let user_count: i64 = sqlx::query("SELECT COUNT(*) FROM users")
        .fetch_one(&mut *tx)
        .await?
        .try_get(0)?;
    let t = now();
    sqlx::query(
        "INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, avatar_color, is_site_admin, created_at) VALUES($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(&key)
    .bind(&username)
    .bind(hash_password(&secret)?)
    .bind(password_kind)
    .bind(avatar_kind.as_str())
    .bind(&avatar_color)
    .bind(i64::from(user_count == 0))
    .bind(t)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO members(server, username, is_admin, joined_at) VALUES('rchat', $1, 0, $2)",
    )
    .bind(&key)
    .bind(t)
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO dms(user_a, user_b) VALUES($1, $2)")
        .bind(&key)
        .bind(&key)
        .execute(&mut *tx)
        .await?;
    let token = new_token();
    sqlx::query("INSERT INTO tokens(token, username, created_at) VALUES($1, $2, $3)")
        .bind(&token)
        .bind(&key)
        .bind(t)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let user = match get_user(&state.db, &key).await? {
        Some(user) => user,
        None => return Err(anyhow::anyhow!("user missing after insert").into()),
    };
    let me = me_payload(&state.db, &user).await?;
    state.hub.broadcast(WsEvent::MemberJoined {
        server: "rchat".to_string(),
        member: Member {
            user: UserRef::from_user(&user),
            is_admin: false,
            is_creator: false,
            online: false,
            perms: 0,
            role_ids: Vec::new(),
        },
    });
    state.hub.broadcast(WsEvent::UserRegistered {
        user: UserRef::from_user(&user),
    });
    Ok(Json(AuthResp { token, user: me }))
}

#[utoipa::path(post, path = "/api/auth/login", request_body = LoginReq, responses((status = 200, body = AuthResp)))]
pub(crate) async fn login(
    State(state): State<AppState>,
    Json(req): Json<LoginReq>,
) -> Result<Json<AuthResp>, ApiError> {
    let LoginReq {
        username,
        password,
        words,
    } = req;
    let key = username.to_lowercase();
    let db = &state.db;
    let t = now();
    let day = (t / 86400).to_string();
    let row = sqlx::query("SELECT day, count, last_at FROM login_attempts WHERE username = $1")
        .bind(&key)
        .fetch_optional(db)
        .await?;
    let prev: Option<(String, i64, i64)> = match &row {
        Some(r) => Some((r.try_get(0)?, r.try_get(1)?, r.try_get(2)?)),
        None => None,
    };
    let count = match &prev {
        Some((d, c, _)) if *d == day => c + 1,
        _ => 1,
    };
    sqlx::query(
        "INSERT INTO login_attempts(username, day, count, last_at) VALUES($1, $2, $3, $4) ON CONFLICT(username) DO UPDATE SET day = excluded.day, count = excluded.count, last_at = excluded.last_at",
    )
    .bind(&key)
    .bind(&day)
    .bind(count)
    .bind(t)
    .execute(db)
    .await?;
    if count > 1000 {
        return Err(ApiError(
            StatusCode::LOCKED,
            "Account locked for the day".to_string(),
        ));
    }
    match &prev {
        Some((d, _, last)) if *d == day && t - last < 3 => {
            return Err(ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                "Wait 3 seconds between attempts".to_string(),
            ));
        }
        _ => {}
    }
    let (secret, _) = secret_from(&username, password, words, false)?;
    let user = match get_user(db, &key).await? {
        Some(user) if verify_password(&secret, &user.password_hash) => user,
        _ => {
            return Err(ApiError(
                StatusCode::UNAUTHORIZED,
                "Invalid credentials".to_string(),
            ));
        }
    };
    let token = new_token();
    sqlx::query("INSERT INTO tokens(token, username, created_at) VALUES($1, $2, $3)")
        .bind(&token)
        .bind(&user.username)
        .bind(t)
        .execute(db)
        .await?;
    let me = me_payload(db, &user).await?;
    Ok(Json(AuthResp { token, user: me }))
}

#[utoipa::path(get, path = "/api/me", responses((status = 200, body = Me)), security(("bearer" = [])))]
pub(crate) async fn me(
    State(state): State<AppState>,
    Authed(user): Authed,
) -> Result<Json<Me>, ApiError> {
    Ok(Json(me_payload(&state.db, &user).await?))
}

#[derive(Deserialize, ToSchema)]
pub struct MePatch {
    avatar_kind: AvatarKind,
    avatar_color: Option<String>,
}

#[utoipa::path(patch, path = "/api/me", request_body = MePatch, responses((status = 200, body = UserRef)), security(("bearer" = [])))]
pub(crate) async fn patch_me(
    State(state): State<AppState>,
    Authed(user): Authed,
    Json(req): Json<MePatch>,
) -> Result<Json<UserRef>, ApiError> {
    let MePatch {
        avatar_kind,
        avatar_color,
    } = req;
    let avatar_color = check_avatar(avatar_kind, avatar_color)?;
    sqlx::query("UPDATE users SET avatar_kind = $1, avatar_color = $2 WHERE username = $3")
        .bind(avatar_kind.as_str())
        .bind(&avatar_color)
        .bind(&user.username)
        .execute(&state.db)
        .await?;
    let user_ref = UserRef {
        username: user.username,
        display_name: user.display_name,
        avatar_kind,
        avatar_color,
    };
    state.hub.broadcast(WsEvent::UserUpdated {
        user: user_ref.clone(),
    });
    Ok(Json(user_ref))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::test_util::{done, temp_state};
    use crate::state::AppState;

    #[test]
    fn word_set_deterministic() {
        let a = word_set("Alice");
        assert_eq!(a, word_set("alice"));
        assert_eq!(a.len(), 20);
        let distinct: std::collections::HashSet<&String> = a.iter().collect();
        assert_eq!(distinct.len(), 20);
        assert_ne!(a, word_set("bob"));
    }

    async fn register_text(state: &AppState, name: &str) -> Result<Json<AuthResp>, ApiError> {
        register(
            State(state.clone()),
            Json(RegisterReq {
                username: name.to_string(),
                password: Some("a".to_string()),
                words: None,
                avatar_kind: AvatarKind::Identicon,
                avatar_color: None,
            }),
        )
        .await
    }

    #[tokio::test]
    async fn word_register_login_roundtrip() {
        let (state, path) = temp_state("word_auth").await;
        let words = word_set("Wendy");
        let picked = words[..7].to_vec();
        let resp = register(
            State(state.clone()),
            Json(RegisterReq {
                username: "Wendy".to_string(),
                password: None,
                words: Some(picked.clone()),
                avatar_kind: AvatarKind::Identicon,
                avatar_color: None,
            }),
        )
        .await
        .expect("register")
        .0;
        assert_eq!(resp.user.username, "wendy");
        assert!(!resp.token.is_empty());
        let bad_words = register(
            State(state.clone()),
            Json(RegisterReq {
                username: "mallory".to_string(),
                password: None,
                words: Some(vec!["definitelynotintheset".to_string(); 7]),
                avatar_kind: AvatarKind::Identicon,
                avatar_color: None,
            }),
        )
        .await;
        assert!(matches!(
            bad_words,
            Err(ApiError(StatusCode::BAD_REQUEST, _))
        ));
        let shouted: Vec<String> = picked.iter().map(|w| w.to_uppercase()).collect();
        let ok = login(
            State(state.clone()),
            Json(LoginReq {
                username: "WENDY".to_string(),
                password: None,
                words: Some(shouted),
            }),
        )
        .await
        .expect("login")
        .0;
        assert!(!ok.token.is_empty());
        done(state, path).await;
    }

    #[tokio::test]
    async fn login_throttle() {
        let (state, path) = temp_state("throttle").await;
        let _ = register_text(&state, "tom").await.expect("register");
        let attempt = |password: &str| {
            let state = state.clone();
            let password = password.to_string();
            async move {
                login(
                    State(state),
                    Json(LoginReq {
                        username: "tom".to_string(),
                        password: Some(password),
                        words: None,
                    }),
                )
                .await
            }
        };
        let _ = attempt("a").await.expect("first login");
        let fast = attempt("a").await;
        assert!(matches!(
            fast,
            Err(ApiError(StatusCode::TOO_MANY_REQUESTS, _))
        ));
        sqlx::query(
            "UPDATE login_attempts SET count = 1000, last_at = last_at - 10 WHERE username = 'tom'",
        )
        .execute(&state.db)
        .await
        .expect("prime attempts");
        let locked = attempt("a").await;
        assert!(matches!(locked, Err(ApiError(StatusCode::LOCKED, _))));
        done(state, path).await;
    }
}
