use axum::extract::FromRequestParts;
use axum::http::StatusCode;
use axum::http::request::Parts;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::Rng;
use serde::Deserialize;
use utoipa::ToSchema;

use crate::api::auth::{note_change_failure, session_key, throttle_change, verify_password};
use crate::api::{ApiError, bad, bearer_token, session_for_token, unauthorized};
use crate::db::{Db, User, now};
use crate::state::AppState;

pub const NONCE_TTL_SECS: i64 = 300;
pub const FRESH_SESSION_SECS: i64 = 900;
pub const RECOVER: &str = "recover";

const FRESH_SESSION_SKEW_SECS: i64 = 60;

const PHRASE_TAG: &[u8] = b"rchat-recovery1";

const ONE_WAY: &str = "Confirm with exactly one of password, words, phrase or fresh_session";

/// A signed-in request: the account, the request's bearer token and when that session was
/// created.
#[derive(Clone)]
pub struct Session {
    pub user: User,
    pub token: String,
    pub created_at: i64,
}

/// The `Session` of a request, with the lookup and errors of `Authed`.
pub struct AuthedSession(pub Session);

impl FromRequestParts<AppState> for AuthedSession {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<AuthedSession, ApiError> {
        let token = bearer_token(&parts.headers).ok_or_else(unauthorized)?;
        match session_for_token(state, token).await? {
            Some((user, created_at)) => Ok(AuthedSession(Session {
                user,
                token: token.to_string(),
                created_at,
            })),
            None => Err(unauthorized()),
        }
    }
}

/// How a signed-in user confirms a sensitive change. `Password` holds a text password or the
/// account's words joined by single spaces.
pub enum ReAuth {
    Password(String),
    Phrase { nonce: String, sig: String },
    FreshSession,
    FreshIdp { provider: String, code: String },
}

/// A backup phrase signature over a recovery challenge.
#[derive(Deserialize, ToSchema)]
pub struct PhraseProof {
    /// The nonce from `POST /api/auth/recovery/challenge` for this account.
    pub nonce: String,
    /// The Ed25519 signature by the account key of the backup phrase over the challenge, as
    /// base64url without padding (86 characters).
    pub sig: String,
}

/// A fresh sign-in with an identity provider.
#[derive(Deserialize, ToSchema)]
pub struct IdpCode {
    /// The provider's id.
    pub provider: String,
    /// The code the provider returned.
    pub code: String,
}

/// How you confirm a sensitive change. Give exactly one field.
#[derive(Deserialize, ToSchema)]
pub struct ReAuthBody {
    /// The account's text password.
    password: Option<String>,
    /// The account's 7 words, in order (case-insensitive).
    words: Option<Vec<String>>,
    /// A backup phrase signature over a fresh challenge. The change says which purpose and
    /// context it signs.
    phrase: Option<PhraseProof>,
    /// `true` to confirm with this session alone. Works only for setting a first backup phrase,
    /// from a session created less than 15 minutes ago.
    fresh_session: Option<bool>,
    /// A fresh sign-in with an identity provider. No provider is available yet, so this answers
    /// 400 `Unknown sign-in provider`.
    idp: Option<IdpCode>,
}

impl TryFrom<ReAuthBody> for ReAuth {
    type Error = ApiError;

    fn try_from(body: ReAuthBody) -> Result<ReAuth, ApiError> {
        let ReAuthBody {
            password,
            words,
            phrase,
            fresh_session,
            idp,
        } = body;
        match (password, words, phrase, fresh_session.unwrap_or(false), idp) {
            (Some(password), None, None, false, None) => Ok(ReAuth::Password(password)),
            (None, Some(words), None, false, None) => Ok(ReAuth::Password(
                words
                    .iter()
                    .map(|w| w.to_lowercase())
                    .collect::<Vec<_>>()
                    .join(" "),
            )),
            (None, None, Some(PhraseProof { nonce, sig }), false, None) => {
                Ok(ReAuth::Phrase { nonce, sig })
            }
            (None, None, None, true, None) => Ok(ReAuth::FreshSession),
            (None, None, None, false, Some(IdpCode { provider, code })) => {
                Ok(ReAuth::FreshIdp { provider, code })
            }
            _ => Err(bad(ONE_WAY)),
        }
    }
}

/// What a re-auth confirms. A phrase signature covers its name and its context.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Purpose {
    SetPhrase { key: String },
    RemovePhrase,
}

impl Purpose {
    pub fn as_str(&self) -> &'static str {
        match self {
            Purpose::SetPhrase { .. } => "set",
            Purpose::RemovePhrase => "remove",
        }
    }

    pub fn context(&self) -> &str {
        match self {
            Purpose::SetPhrase { key } => key,
            Purpose::RemovePhrase => "",
        }
    }

    pub fn fresh_session_ok(&self, user: &User) -> bool {
        match self {
            Purpose::SetPhrase { .. } => user.recovery_pub.is_none(),
            Purpose::RemovePhrase => false,
        }
    }
}

fn refused(msg: &str) -> ApiError {
    ApiError(StatusCode::UNAUTHORIZED, msg.to_string())
}

async fn counted(state: &AppState, pace: &str, msg: &str) -> Result<(), ApiError> {
    note_change_failure(&state.db, pace).await?;
    Err(refused(msg))
}

pub async fn check(
    state: &AppState,
    session: &Session,
    reauth: ReAuth,
    purpose: Purpose,
) -> Result<(), ApiError> {
    check_at(state, session, reauth, purpose, now()).await
}

pub(crate) async fn check_at(
    state: &AppState,
    session: &Session,
    reauth: ReAuth,
    purpose: Purpose,
    t: i64,
) -> Result<(), ApiError> {
    let Session {
        user,
        token,
        created_at,
    } = session;
    match reauth {
        ReAuth::Password(secret) => {
            let pace = session_key(token);
            throttle_change(&state.db, &pace, t).await?;
            let secret = match user.password_kind.as_str() {
                "words" => secret
                    .split_whitespace()
                    .map(str::to_lowercase)
                    .collect::<Vec<_>>()
                    .join(" "),
                _ => secret,
            };
            match verify_password(&secret, &user.password_hash).await {
                true => Ok(()),
                false => counted(state, &pace, "Wrong password").await,
            }
        }
        ReAuth::Phrase { nonce, sig } => {
            let pace = session_key(token);
            throttle_change(&state.db, &pace, t).await?;
            let fresh = take_nonce(&state.db, &user.username, &nonce, t).await?;
            let signed = user.recovery_pub.as_deref().is_some_and(|key| {
                phrase_sig_ok(
                    key,
                    purpose.as_str(),
                    &user.username,
                    &nonce,
                    purpose.context(),
                    &sig,
                )
            });
            match fresh && signed {
                true => Ok(()),
                false => counted(state, &pace, "Wrong backup phrase").await,
            }
        }
        ReAuth::FreshSession => {
            let fresh = -FRESH_SESSION_SKEW_SECS..FRESH_SESSION_SECS;
            match purpose.fresh_session_ok(user) && fresh.contains(&(t - created_at)) {
                true => Ok(()),
                false => Err(refused("Confirm with your password")),
            }
        }
        ReAuth::FreshIdp { .. } => Err(bad("Unknown sign-in provider")),
    }
}

/// What a backup phrase signs: `rchat-recovery1`, then the purpose, the lowercase username, the
/// nonce and the context, each after a zero byte.
pub fn phrase_message(purpose: &str, username: &str, nonce: &str, context: &str) -> Vec<u8> {
    [
        PHRASE_TAG,
        b"\0",
        purpose.as_bytes(),
        b"\0",
        username.to_lowercase().as_bytes(),
        b"\0",
        nonce.as_bytes(),
        b"\0",
        context.as_bytes(),
    ]
    .concat()
}

/// Whether `sig` (base64url) is a signature by the recovery key `key` (base64url Ed25519) over
/// `phrase_message`.
pub fn phrase_sig_ok(
    key: &str,
    purpose: &str,
    username: &str,
    nonce: &str,
    context: &str,
    sig: &str,
) -> bool {
    crate::identity::p2p_key(key).is_some_and(|key| {
        crate::identity::sig_ok(
            &key,
            &phrase_message(purpose, username, nonce, context),
            sig,
        )
    })
}

/// A new single-use challenge nonce for `username`, valid for `NONCE_TTL_SECS` from `t`.
pub async fn issue_nonce(db: &Db, username: &str, t: i64) -> Result<String, ApiError> {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let nonce = URL_SAFE_NO_PAD.encode(bytes);
    sqlx::query("INSERT INTO recovery_challenges(nonce, username, expires_at) VALUES($1, $2, $3)")
        .bind(&nonce)
        .bind(username.to_lowercase())
        .bind(t + NONCE_TTL_SECS)
        .execute(db)
        .await?;
    Ok(nonce)
}

/// Uses up `nonce`: true once, when it was issued for `username` and has not expired at `t`.
pub async fn take_nonce(db: &Db, username: &str, nonce: &str, t: i64) -> Result<bool, ApiError> {
    let issued = nonce.len() == 43
        && nonce
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !issued || username.contains('\0') {
        return Ok(false);
    }
    let taken = sqlx::query(
        "DELETE FROM recovery_challenges WHERE nonce = $1 AND username = $2 AND expires_at >= $3",
    )
    .bind(nonce)
    .bind(username.to_lowercase())
    .bind(t)
    .execute(db)
    .await?
    .rows_affected();
    Ok(taken == 1)
}

#[cfg(test)]
mod tests {
    use axum::Json;
    use axum::extract::{FromRequestParts, State};
    use axum::http::{Request, StatusCode, header};
    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use ed25519_dalek::{Signer, SigningKey};
    use serde_json::json;
    use sqlx::Row;

    use super::*;
    use crate::api::auth::{RegisterReq, hash_password, register, session_key};
    use crate::api::test_util::{done, temp_state};
    use crate::db::{get_user, secret_key};

    const KEY: &str = "IOGfm4VeaU9qsds79702OGowi43niF7E3YP1w8Qi4qM";
    const SECRET: &str = "3ce6f2b19c948b2c6f3cc5d0f429bab3812866054615593caf48839dec55ca2f";
    const RECOVER_SIG: &str =
        "cJyitejzn10C9qYWcUrbSYk5kY-uICu9vkDIcm939uiM9hjQMj2l8Xjteb0SSBZKUN6rmMSvvx8c74T6ZoApBA";
    const SET_SIG: &str =
        "dbdLi9psy37fHJAkwh-ERVnJcRa3WnjT7jKyc_ilbjBTYDfYvn6ojQmLoAm3HdxXx_1cHNZHLL9QPdpuF8N0BA";
    const NEW_KEY: &str = "2Rd0E35G1_IAGOrmcRFbBetgSdlSqRK04n1s5rgrekE";
    const T: i64 = 20_000 * 86400 + 3600;

    fn sign(purpose: &str, username: &str, nonce: &str, context: &str) -> String {
        let secret: [u8; 32] = hex::decode(SECRET)
            .expect("hex")
            .try_into()
            .expect("32 bytes");
        let message = phrase_message(purpose, username, nonce, context);
        URL_SAFE_NO_PAD.encode(SigningKey::from_bytes(&secret).sign(&message).to_bytes())
    }

    async fn add_user(state: &AppState, name: &str, kind: &str, secret: &str, key: Option<&str>) {
        let hash = hash_password(secret).await.expect("hash");
        sqlx::query("INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, created_at, recovery_pub, recovery_set_at) VALUES($1, $1, $2, $3, 'identicon', 1, $4, $5)")
            .bind(name)
            .bind(hash)
            .bind(kind)
            .bind(key)
            .bind(key.map(|_| 2i64))
            .execute(&state.db)
            .await
            .expect("insert user");
    }

    async fn session(state: &AppState, name: &str, token: &str, created_at: i64) -> Session {
        let user = get_user(&state.db, name)
            .await
            .expect("load user")
            .expect("user exists");
        Session {
            user,
            token: token.to_string(),
            created_at,
        }
    }

    fn denied(result: Result<(), ApiError>) -> (StatusCode, String) {
        let ApiError(code, msg) = result.expect_err("denied");
        (code, msg)
    }

    fn refusal(code: StatusCode, msg: &str) -> (StatusCode, String) {
        (code, msg.to_string())
    }

    async fn failures(state: &AppState, token: &str) -> i64 {
        sqlx::query("SELECT failures FROM change_attempts WHERE session = $1")
            .bind(session_key(token))
            .fetch_optional(&state.db)
            .await
            .expect("failures")
            .map(|r| r.try_get(0).expect("failures"))
            .unwrap_or(0)
    }

    #[test]
    fn the_signature_vector_verifies() {
        let nonce = "A".repeat(43);
        assert!(phrase_sig_ok(
            KEY,
            "recover",
            "alice",
            &nonce,
            "",
            RECOVER_SIG
        ));
        assert!(phrase_sig_ok(KEY, "set", "alice", &nonce, NEW_KEY, SET_SIG));
        assert!(!phrase_sig_ok(
            KEY,
            "remove",
            "alice",
            &nonce,
            "",
            RECOVER_SIG
        ));
        assert!(!phrase_sig_ok(
            KEY,
            "recover",
            "bob",
            &nonce,
            "",
            RECOVER_SIG
        ));
        assert!(!phrase_sig_ok(
            KEY,
            "recover",
            "alice",
            &nonce,
            "x",
            RECOVER_SIG
        ));
        assert!(!phrase_sig_ok(
            KEY,
            "recover",
            "alice",
            &nonce,
            "",
            "not-base64"
        ));
        assert!(!phrase_sig_ok(
            NEW_KEY,
            "recover",
            "alice",
            &nonce,
            "",
            RECOVER_SIG
        ));
        assert!(!phrase_sig_ok(
            "not-a-key",
            "recover",
            "alice",
            &nonce,
            "",
            RECOVER_SIG
        ));
        assert_eq!(sign(RECOVER, "alice", &nonce, ""), RECOVER_SIG);
        assert_eq!(sign("set", "alice", &nonce, NEW_KEY), SET_SIG);
        assert_eq!(
            phrase_message("set", "alice", "n", "k"),
            b"rchat-recovery1\0set\0alice\0n\0k".to_vec()
        );
    }

    #[tokio::test]
    async fn a_nonce_works_once_for_its_account_until_it_expires() {
        let (state, path) = temp_state("reauth_nonce").await;
        let db = &state.db;
        let nonce = issue_nonce(db, "alice", T).await.expect("issue");
        assert_eq!(nonce.len(), 43);
        assert!(!take_nonce(db, "bob", &nonce, T).await.expect("take"));
        assert!(
            take_nonce(db, "alice", &nonce, T + 300)
                .await
                .expect("take")
        );
        assert!(
            !take_nonce(db, "alice", &nonce, T + 300)
                .await
                .expect("take"),
            "single use"
        );
        let late = issue_nonce(db, "alice", T).await.expect("issue");
        assert_ne!(late, nonce);
        assert!(
            !take_nonce(db, "alice", &late, T + 301).await.expect("take"),
            "expired"
        );
        for odd in [
            format!("{}!", "A".repeat(42)),
            "A".repeat(44),
            "A".repeat(42),
        ] {
            sqlx::query(
                "INSERT INTO recovery_challenges(nonce, username, expires_at) VALUES($1, 'alice', $2)",
            )
            .bind(&odd)
            .bind(T + 300)
            .execute(db)
            .await
            .expect("plant");
            assert!(
                !take_nonce(db, "alice", &odd, T).await.expect("take"),
                "{odd}"
            );
        }
        let planted = "A".repeat(43);
        sqlx::query(
            "INSERT INTO recovery_challenges(nonce, username, expires_at) VALUES($1, $2, $3)",
        )
        .bind(&planted)
        .bind("ali\0ce")
        .bind(T + 300)
        .execute(db)
        .await
        .expect("plant");
        let kept = || async {
            sqlx::query(
                "SELECT COUNT(*) FROM recovery_challenges WHERE nonce = $1 AND username = $2",
            )
            .bind(&planted)
            .bind("ali\0ce")
            .fetch_one(db)
            .await
            .expect("count")
            .try_get::<i64, _>(0)
            .expect("count value")
        };
        assert_eq!(kept().await, 1);
        assert!(!take_nonce(db, "ali\0ce", &planted, T).await.expect("take"));
        assert_eq!(kept().await, 1);
        done(state, path).await;
    }

    #[tokio::test]
    async fn check_by_password() {
        let (state, path) = temp_state("reauth_password").await;
        add_user(&state, "alice", "text", "Hunter 2", None).await;
        let words = "apple river stone cloud maple tiger ocean";
        add_user(&state, "wendy", "words", words, None).await;
        let alice = session(&state, "alice", "tok-alice", T).await;
        let wendy = session(&state, "wendy", "tok-wendy", T).await;
        let remove = || Purpose::RemovePhrase;
        check_at(
            &state,
            &alice,
            ReAuth::Password("Hunter 2".into()),
            remove(),
            T,
        )
        .await
        .expect("text password");
        let typed = "Apple  RIVER\tstone cloud maple tiger ocean";
        check_at(&state, &wendy, ReAuth::Password(typed.into()), remove(), T)
            .await
            .expect("words");
        assert_eq!(failures(&state, "tok-alice").await, 0);
        assert_eq!(
            denied(
                check_at(
                    &state,
                    &alice,
                    ReAuth::Password("hunter 2".into()),
                    remove(),
                    T + 3
                )
                .await
            ),
            refusal(StatusCode::UNAUTHORIZED, "Wrong password")
        );
        assert_eq!(failures(&state, "tok-alice").await, 1);
        assert_eq!(
            denied(
                check_at(
                    &state,
                    &alice,
                    ReAuth::Password("Hunter 2".into()),
                    remove(),
                    T + 5
                )
                .await
            )
            .0,
            StatusCode::TOO_MANY_REQUESTS
        );
        assert_eq!(failures(&state, "tok-alice").await, 1);
        assert_eq!(failures(&state, "tok-wendy").await, 0);
        done(state, path).await;
    }

    #[tokio::test]
    async fn check_by_phrase() {
        let (state, path) = temp_state("reauth_phrase").await;
        add_user(&state, "alice", "text", "pw", Some(KEY)).await;
        add_user(&state, "bob", "text", "pw", None).await;
        let alice = session(&state, "alice", "tok-alice", T).await;
        let wrong = refusal(StatusCode::UNAUTHORIZED, "Wrong backup phrase");
        let nonce = issue_nonce(&state.db, "alice", T).await.expect("nonce");
        let proof = || ReAuth::Phrase {
            nonce: nonce.clone(),
            sig: sign("remove", "alice", &nonce, ""),
        };
        check_at(&state, &alice, proof(), Purpose::RemovePhrase, T)
            .await
            .expect("phrase");
        assert_eq!(
            denied(check_at(&state, &alice, proof(), Purpose::RemovePhrase, T + 3).await),
            wrong,
            "replayed"
        );
        assert_eq!(failures(&state, "tok-alice").await, 1);
        let set = || Purpose::SetPhrase {
            key: NEW_KEY.to_string(),
        };
        let nonce = issue_nonce(&state.db, "alice", T).await.expect("nonce");
        let no_context = ReAuth::Phrase {
            nonce: nonce.clone(),
            sig: sign("set", "alice", &nonce, ""),
        };
        assert_eq!(
            denied(check_at(&state, &alice, no_context, set(), T + 6).await),
            wrong
        );
        let right = ReAuth::Phrase {
            nonce: nonce.clone(),
            sig: sign("set", "alice", &nonce, NEW_KEY),
        };
        assert_eq!(
            denied(check_at(&state, &alice, right, set(), T + 9).await),
            wrong,
            "a failed try uses up its nonce"
        );
        let nonce = issue_nonce(&state.db, "alice", T).await.expect("nonce");
        let late = ReAuth::Phrase {
            nonce: nonce.clone(),
            sig: sign("set", "alice", &nonce, NEW_KEY),
        };
        assert_eq!(
            denied(check_at(&state, &alice, late, set(), T + 301).await),
            wrong,
            "expired"
        );
        let nonce = issue_nonce(&state.db, "alice", T + 304)
            .await
            .expect("nonce");
        let right = ReAuth::Phrase {
            nonce: nonce.clone(),
            sig: sign("set", "alice", &nonce, NEW_KEY),
        };
        check_at(&state, &alice, right, set(), T + 304)
            .await
            .expect("set");
        assert_eq!(failures(&state, "tok-alice").await, 4);
        let bob = session(&state, "bob", "tok-bob", T).await;
        let nonce = issue_nonce(&state.db, "bob", T).await.expect("nonce");
        let keyless = ReAuth::Phrase {
            nonce: nonce.clone(),
            sig: sign("remove", "bob", &nonce, ""),
        };
        assert_eq!(
            denied(check_at(&state, &bob, keyless, Purpose::RemovePhrase, T).await),
            wrong
        );
        assert_eq!(failures(&state, "tok-bob").await, 1);
        let nonce = issue_nonce(&state.db, "alice", T + 310)
            .await
            .expect("nonce");
        let paced = ReAuth::Phrase {
            nonce: nonce.clone(),
            sig: sign("remove", "alice", &nonce, ""),
        };
        assert_eq!(
            denied(check_at(&state, &alice, paced, Purpose::RemovePhrase, T + 305).await).0,
            StatusCode::TOO_MANY_REQUESTS
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn fresh_session_only_sets_a_first_phrase() {
        let (state, path) = temp_state("reauth_fresh").await;
        add_user(&state, "alice", "text", "pw", None).await;
        add_user(&state, "carol", "text", "pw", Some(KEY)).await;
        let set = || Purpose::SetPhrase {
            key: NEW_KEY.to_string(),
        };
        assert_eq!((set().as_str(), set().context()), ("set", NEW_KEY));
        assert_eq!(
            (
                Purpose::RemovePhrase.as_str(),
                Purpose::RemovePhrase.context()
            ),
            ("remove", "")
        );
        let alice = session(&state, "alice", "tok-alice", T).await;
        let carol = session(&state, "carol", "tok-carol", T).await;
        assert!(set().fresh_session_ok(&alice.user));
        assert!(!set().fresh_session_ok(&carol.user));
        assert!(!Purpose::RemovePhrase.fresh_session_ok(&alice.user));
        check_at(&state, &alice, ReAuth::FreshSession, set(), T + 899)
            .await
            .expect("fresh");
        let confirm = refusal(StatusCode::UNAUTHORIZED, "Confirm with your password");
        assert_eq!(
            denied(check_at(&state, &alice, ReAuth::FreshSession, set(), T + 900).await),
            confirm
        );
        check_at(&state, &alice, ReAuth::FreshSession, set(), T - 60)
            .await
            .expect("created up to a minute ahead");
        for early in [T - 61, T - 30 * 86400] {
            assert_eq!(
                denied(check_at(&state, &alice, ReAuth::FreshSession, set(), early).await),
                confirm,
                "created {} s ahead",
                T - early
            );
        }
        assert_eq!(
            denied(check_at(&state, &carol, ReAuth::FreshSession, set(), T + 1).await),
            confirm
        );
        assert_eq!(
            denied(
                check_at(
                    &state,
                    &alice,
                    ReAuth::FreshSession,
                    Purpose::RemovePhrase,
                    T + 1
                )
                .await
            ),
            confirm
        );
        assert_eq!(failures(&state, "tok-alice").await, 0);
        done(state, path).await;
    }

    fn body(value: serde_json::Value) -> Result<ReAuth, ApiError> {
        ReAuth::try_from(serde_json::from_value::<ReAuthBody>(value).expect("body"))
    }

    #[tokio::test]
    async fn reauth_body_needs_exactly_one_way() {
        let one = refusal(
            StatusCode::BAD_REQUEST,
            "Confirm with exactly one of password, words, phrase or fresh_session",
        );
        for value in [
            json!({}),
            json!({"password": "pw", "words": ["a"]}),
            json!({"password": "pw", "fresh_session": true}),
            json!({"phrase": {"nonce": "n", "sig": "s"}, "idp": {"provider": "p", "code": "c"}}),
            json!({"fresh_session": false}),
        ] {
            match body(value.clone()) {
                Err(ApiError(code, msg)) => assert_eq!((code, msg), one, "{value}"),
                Ok(_) => panic!("{value} was taken"),
            }
        }
        assert!(
            matches!(body(json!({"words": ["A", "b"]})), Ok(ReAuth::Password(p)) if p == "a b")
        );
        assert!(matches!(
            body(json!({"password": "Pw", "fresh_session": false})),
            Ok(ReAuth::Password(p)) if p == "Pw"
        ));
        assert!(matches!(
            body(json!({"phrase": {"nonce": "n", "sig": "s"}})),
            Ok(ReAuth::Phrase { nonce, sig }) if nonce == "n" && sig == "s"
        ));
        assert!(matches!(
            body(json!({"fresh_session": true, "password": null})),
            Ok(ReAuth::FreshSession)
        ));
        let idp = body(json!({"idp": {"provider": "okta", "code": "c0de"}})).expect("idp");
        assert!(
            matches!(&idp, ReAuth::FreshIdp { provider, code } if provider == "okta" && code == "c0de")
        );
        let (state, path) = temp_state("reauth_body").await;
        add_user(&state, "alice", "text", "pw", None).await;
        let alice = session(&state, "alice", "tok-alice", T).await;
        assert_eq!(
            denied(check_at(&state, &alice, idp, Purpose::RemovePhrase, T).await),
            refusal(StatusCode::BAD_REQUEST, "Unknown sign-in provider")
        );
        done(state, path).await;
    }

    async fn extract(state: &AppState, auth: Option<&str>) -> Result<AuthedSession, ApiError> {
        let mut req = Request::builder();
        if let Some(auth) = auth {
            req = req.header(header::AUTHORIZATION, auth);
        }
        let (mut parts, ()) = req.body(()).expect("request").into_parts();
        AuthedSession::from_request_parts(&mut parts, state).await
    }

    #[tokio::test]
    async fn authed_session_carries_the_token_age() {
        let (state, path) = temp_state("reauth_session").await;
        let req: RegisterReq = serde_json::from_value(
            json!({"username": "Alice", "password": "pw", "avatar_kind": "identicon"}),
        )
        .expect("register body");
        let Json(resp) = register(State(state.clone()), Json(req))
            .await
            .expect("register");
        let token = resp.token;
        sqlx::query("UPDATE tokens SET created_at = created_at + 12345 WHERE token = $1")
            .bind(secret_key(&token))
            .execute(&state.db)
            .await
            .expect("age the token");
        let stored: i64 = sqlx::query("SELECT created_at FROM tokens WHERE token = $1")
            .bind(secret_key(&token))
            .fetch_one(&state.db)
            .await
            .expect("token row")
            .try_get(0)
            .expect("created_at");
        let AuthedSession(session) = extract(&state, Some(&format!("Bearer {token}")))
            .await
            .expect("session");
        assert_eq!(session.created_at, stored);
        assert_ne!(session.created_at, session.user.created_at);
        assert_eq!(session.token, token);
        assert_eq!(session.user.username, "alice");
        assert_eq!(session.user.recovery_pub, None);
        for auth in [None, Some("Bearer nope"), Some(token.as_str())] {
            let ApiError(code, msg) = extract(&state, auth).await.err().expect("refused");
            assert_eq!(
                (code, msg.as_str()),
                (StatusCode::UNAUTHORIZED, "Unauthorized"),
                "{auth:?}"
            );
        }
        let url = format!("sqlite://{}?mode=rwc", path.display());
        let starved = sqlx::any::AnyPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(std::time::Duration::from_millis(200))
            .connect(&url)
            .await
            .expect("starved pool");
        let held = starved.acquire().await.expect("the only connection");
        let stalled = state.clone().with_reader(starved.clone());
        let ApiError(code, msg) = extract(&stalled, Some(&format!("Bearer {token}")))
            .await
            .err()
            .expect("lookup fails");
        assert_eq!(
            (code, msg.as_str()),
            (
                StatusCode::SERVICE_UNAVAILABLE,
                crate::api::AUTH_UNAVAILABLE
            )
        );
        drop(held);
        starved.close().await;
        done(state, path).await;
    }
}
