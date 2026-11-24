use crate::api::ApiError;
use crate::db::now;
use crate::state::AppState;
use crate::ws::WsEvent;

pub async fn suspend(state: &AppState, username: &str) -> Result<bool, ApiError> {
    let mut tx = state.db.begin().await?;
    let changed = sqlx::query(
        "UPDATE users SET suspended_at = $1 WHERE username = $2 AND suspended_at IS NULL AND password_hash <> '!purging'",
    )
    .bind(now())
    .bind(username)
    .execute(&mut *tx)
    .await?
    .rows_affected() != 0;
    if changed {
        sqlx::query("DELETE FROM tokens WHERE username = $1")
            .bind(username)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    if changed {
        state.hub.broadcast(WsEvent::TokensRevoked {
            username: username.to_owned(),
        });
    }
    Ok(changed)
}

pub async fn unsuspend(state: &AppState, username: &str) -> Result<bool, ApiError> {
    let changed = sqlx::query(
        "UPDATE users SET suspended_at = NULL WHERE username = $1 AND suspended_at IS NOT NULL AND password_hash <> '!purging'",
    ).bind(username)
    .execute(&state.db)
    .await?
    .rows_affected();
    Ok(changed != 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{auth, test_util::each_db, user_for_token};
    use axum::{Json, extract::State, http::StatusCode};
    use serde_json::json;
    async fn account(state: &AppState, name: &str) -> String {
        auth::register(
            State(state.clone()),
            Json(
                serde_json::from_value(
                    json!({"username":name,"password":"test","avatar_kind":"identicon"}),
                )
                .unwrap(),
            ),
        )
        .await
        .unwrap()
        .0
        .token
    }
    async fn login(
        state: &AppState,
        password: &str,
        at: i64,
    ) -> Result<Json<auth::AuthResp>, ApiError> {
        auth::login_at(
            state,
            serde_json::from_value(json!({"username":"alice","password":password})).unwrap(),
            at,
        )
        .await
    }
    #[tokio::test]
    async fn suspension_ends_sessions_and_refuses_sign_in() {
        for (state, db) in each_db("suspend_sessions").await {
            let first = account(&state, "alice").await;
            let other = account(&state, "bob").await;
            let t = now();
            let second = login(&state, "test", t).await.unwrap().0.token;
            let mut events = state.hub.subscribe();
            let (first_change, concurrent_change) =
                tokio::join!(suspend(&state, "alice"), suspend(&state, "alice"));
            assert_ne!(first_change.unwrap(), concurrent_change.unwrap());
            assert!(!suspend(&state, "alice").await.unwrap());
            assert!(
                matches!(events.try_recv(),Ok(WsEvent::TokensRevoked{username}) if username=="alice")
            );
            assert!(events.try_recv().is_err());
            for token in [&first, &second] {
                assert!(user_for_token(&state, token).await.unwrap().is_none());
            }
            assert!(user_for_token(&state, &other).await.unwrap().is_some());
            assert!(
                matches!(login(&state,"test",t+4).await,Err(ApiError(StatusCode::UNAUTHORIZED,s,_)) if s=="Invalid credentials")
            );
            assert!(unsuspend(&state, "alice").await.unwrap());
            assert!(!unsuspend(&state, "alice").await.unwrap());
            assert!(login(&state, "test", t + 8).await.is_ok());
            assert!(user_for_token(&state, &first).await.unwrap().is_none());
            db.done(state).await;
        }
    }
    #[tokio::test]
    async fn passwordless_accounts_never_verify() {
        for (state, db) in each_db("passwordless_signin").await {
            account(&state, "alice").await;
            sqlx::query("UPDATE users SET password_hash = $1 WHERE username = 'alice'")
                .bind(crate::db::NO_PASSWORD_HASH)
                .execute(&state.db)
                .await
                .unwrap();
            let t = now();
            for (i, secret) in ["!sso", "", "test"].iter().enumerate() {
                assert!(
                    matches!(login(&state,secret,t+i as i64*4).await,Err(ApiError(StatusCode::UNAUTHORIZED,s,_)) if s=="Invalid credentials")
                );
            }
            db.done(state).await;
        }
    }
}
