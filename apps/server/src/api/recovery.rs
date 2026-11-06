use axum::Json;
use axum::extract::State;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::api::reauth::{NONCE_TTL_SECS, issue_nonce};
use crate::api::{ApiError, ApiErrorBody, NAME_MAX, bad, check_len};
use crate::db::now;
use crate::state::AppState;

/// The account a recovery challenge is for.
#[derive(Deserialize, ToSchema)]
pub struct ChallengeReq {
    /// 1 to 100 characters, case-insensitive. It does not have to exist.
    #[schema(example = "alice")]
    username: String,
}

/// A single-use challenge to sign with a backup phrase.
#[derive(Serialize, ToSchema)]
pub struct Challenge {
    /// 32 random bytes as base64url without padding (43 characters).
    nonce: String,
    /// The lowercase username. Signatures cover this form.
    #[schema(example = "alice")]
    username: String,
    /// When the nonce stops working, 300 seconds after it was issued.
    expires_at: i64,
}

/// Get a recovery challenge
///
/// Issues a nonce to sign with a backup phrase. It works once, for this username only, for 300
/// seconds. The answer looks the same whether or not the account exists or has a backup phrase.
/// Sign these bytes with the account key of the phrase (Ed25519): `rchat-recovery1`, a zero
/// byte, the purpose, a zero byte, the returned `username`, a zero byte, the nonce, a zero byte
/// and the context. Send the signature as base64url without padding. No authentication. Strict
/// and general rate-limit buckets.
#[utoipa::path(post, path = "/api/auth/recovery/challenge", tag = "Auth", request_body = ChallengeReq, responses((status = 200, description = "A new nonce for this username, valid once until `expires_at`", body = Challenge), (status = 400, description = "Blank, too long (over 100 characters) or NUL-containing username. Malformed JSON or a missing `Content-Type` give a plain-text 400/415 instead", body = ApiErrorBody), (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String), (status = 429, description = "Too many requests in the strict or general bucket", content_type = "text/plain", body = String)), security(()))]
pub(crate) async fn challenge(
    State(state): State<AppState>,
    Json(req): Json<ChallengeReq>,
) -> Result<Json<Challenge>, ApiError> {
    challenge_at(&state, req, now()).await
}

async fn challenge_at(
    state: &AppState,
    req: ChallengeReq,
    t: i64,
) -> Result<Json<Challenge>, ApiError> {
    let ChallengeReq { username } = req;
    if username.trim().is_empty() || username.contains('\0') {
        return Err(bad("Username required"));
    }
    check_len(&username, NAME_MAX, "Username")?;
    let username = username.to_lowercase();
    let nonce = issue_nonce(&state.db, &username, t).await?;
    Ok(Json(Challenge {
        nonce,
        username,
        expires_at: t + NONCE_TTL_SECS,
    }))
}

#[cfg(test)]
mod tests {
    use axum::Json;
    use axum::http::StatusCode;
    use sqlx::Row;

    use super::*;
    use crate::api::auth::session_key;
    use crate::api::reauth::{NONCE_TTL_SECS, Purpose, ReAuth, Session, check_at, take_nonce};
    use crate::api::test_util::{done, pg_done, pg_state, temp_state};
    use crate::db::get_user;

    const T: i64 = 20_000 * 86400 + 3600;

    fn req(username: &str) -> ChallengeReq {
        ChallengeReq {
            username: username.to_string(),
        }
    }

    async fn rows(state: &AppState) -> i64 {
        sqlx::query("SELECT COUNT(*) FROM recovery_challenges")
            .fetch_one(&state.db)
            .await
            .expect("count")
            .try_get(0)
            .expect("count value")
    }

    #[tokio::test]
    async fn challenges_look_the_same_for_any_account() {
        let (state, path) = temp_state("recovery_challenge").await;
        for (name, key) in [
            ("alice", Some("IOGfm4VeaU9qsds79702OGowi43niF7E3YP1w8Qi4qM")),
            ("bob", None),
        ] {
            sqlx::query("INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, created_at, recovery_pub) VALUES($1, $1, 'x', 'text', 'identicon', 1, $2)")
                .bind(name)
                .bind(key)
                .execute(&state.db)
                .await
                .expect("user");
        }
        let mut nonces = Vec::new();
        for name in ["alice", "Bob", "nobody"] {
            let Json(challenge) = challenge_at(&state, req(name), T).await.expect(name);
            let shape = serde_json::to_value(&challenge).expect("json");
            let mut keys: Vec<&String> = shape.as_object().expect("object").keys().collect();
            keys.sort();
            assert_eq!(keys, ["expires_at", "nonce", "username"], "{name}");
            let Challenge {
                nonce,
                username,
                expires_at,
            } = challenge;
            assert_eq!(nonce.len(), 43, "{name}");
            assert!(
                nonce
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
                "{nonce}"
            );
            assert_eq!(expires_at, T + 300);
            assert_eq!(expires_at, T + NONCE_TTL_SECS);
            assert_eq!(username, name.to_lowercase());
            nonces.push((username, nonce));
        }
        assert_eq!(rows(&state).await, 3, "a row for every name");
        for (username, nonce) in &nonces {
            assert!(
                take_nonce(&state.db, username, nonce, T)
                    .await
                    .expect("take"),
                "{username}"
            );
        }
        let longest = "a".repeat(100);
        let Json(longest) = challenge_at(&state, req(&longest), T)
            .await
            .expect("100 characters");
        assert_eq!(longest.username.len(), 100);
        for name in ["a".repeat(101), String::new(), "  ".to_string()] {
            let ApiError(code, _) = challenge_at(&state, req(&name), T)
                .await
                .err()
                .expect("refused");
            assert_eq!(code, StatusCode::BAD_REQUEST, "{name:?}");
        }
        assert_eq!(rows(&state).await, 1);
        done(state, path).await;
    }

    async fn nul_bytes_are_refused(state: &AppState) {
        sqlx::query("INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, created_at, recovery_pub) VALUES('alice', 'alice', 'x', 'text', 'identicon', 1, 'IOGfm4VeaU9qsds79702OGowi43niF7E3YP1w8Qi4qM')")
            .execute(&state.db)
            .await
            .expect("user");
        let ApiError(code, msg) = challenge_at(state, req("ali\0ce"), T)
            .await
            .err()
            .expect("refused");
        assert_eq!(
            (code, msg.as_str()),
            (StatusCode::BAD_REQUEST, "Username required")
        );
        assert_eq!(rows(state).await, 0);
        let Json(Challenge { nonce, .. }) = challenge_at(state, req("alice"), T)
            .await
            .expect("challenge");
        let nul = format!("{}\0", "A".repeat(42));
        assert!(
            !take_nonce(&state.db, "ali\0ce", &nonce, T)
                .await
                .expect("take")
        );
        assert!(!take_nonce(&state.db, "alice", &nul, T).await.expect("take"));
        let user = get_user(&state.db, "alice")
            .await
            .expect("load")
            .expect("alice");
        let session = Session {
            user,
            token: "tok-alice".to_string(),
            created_at: T,
        };
        let proof = ReAuth::Phrase {
            nonce: nul,
            sig: "A".repeat(86),
        };
        let ApiError(code, msg) = check_at(state, &session, proof, Purpose::RemovePhrase, T)
            .await
            .expect_err("refused");
        assert_eq!(
            (code, msg.as_str()),
            (StatusCode::UNAUTHORIZED, "Wrong backup phrase")
        );
        let failures: i64 = sqlx::query("SELECT failures FROM change_attempts WHERE session = $1")
            .bind(session_key("tok-alice"))
            .fetch_one(&state.db)
            .await
            .expect("counted")
            .try_get(0)
            .expect("failures");
        assert_eq!(failures, 1);
        assert!(
            take_nonce(&state.db, "alice", &nonce, T)
                .await
                .expect("take")
        );
    }

    #[tokio::test]
    async fn a_nul_byte_is_refused_on_both_databases() {
        let (state, path) = temp_state("recovery_nul").await;
        nul_bytes_are_refused(&state).await;
        done(state, path).await;
        if let Some((state, pg)) = pg_state("recovery_nul").await {
            nul_bytes_are_refused(&state).await;
            pg_done(state, pg).await;
        }
    }
}
