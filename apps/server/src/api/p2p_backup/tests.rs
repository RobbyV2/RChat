use std::collections::BTreeMap;
use std::future::Future;
use std::sync::Arc;

use axum::body::{Body, to_bytes};
use axum::http::StatusCode;
use axum::response::Response;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Value, json};
use sqlx::Row;

use super::*;
use crate::api::auth::hash_password;
use crate::api::reauth::issue_nonce;
use crate::api::test_util::{
    PHRASE_KEY, done, mem_user, pg_done, pg_state, phrase_sign, temp_state,
};
use crate::db::{NewUser, User, get_user};
use crate::limits::Limits;

const DAY: i64 = 86400;
const HOUR: i64 = 3600;
const MIB: usize = 1 << 20;
/// A UTC midnight.
const T0: i64 = 20_000 * DAY;

type Refused = (StatusCode, String);

fn ik(n: u8) -> String {
    let key = ed25519_dalek::SigningKey::from_bytes(&[n; 32]).verifying_key();
    URL_SAFE_NO_PAD.encode(key.to_bytes())
}

fn refused(code: StatusCode, msg: &str) -> Refused {
    (code, msg.to_string())
}

fn sized(limits: Limits) -> impl Fn(AppState) -> AppState {
    move |state: AppState| state.with_limits(Arc::new(limits.clone()))
}

/// Runs `test` on a SQLite database and, with `TEST_POSTGRES_URL`, on a Postgres one.
async fn each_db<F, Fut>(tag: &str, test: F)
where
    F: Fn(AppState) -> Fut,
    Fut: Future<Output = ()>,
{
    let (state, path) = temp_state(tag).await;
    test(state.clone()).await;
    done(state, path).await;
    if let Some((state, pg)) = pg_state(tag).await {
        test(state.clone()).await;
        pg_done(state, pg).await;
    }
}

async fn add_user(state: &AppState, name: &str, key: Option<&str>) {
    add_user_at(state, name, key, 1).await;
}

async fn add_user_at(state: &AppState, name: &str, key: Option<&str>, at: i64) {
    let hash = hash_password("pw").await.expect("hash");
    NewUser::plain(name)
        .hash(&hash)
        .at(at)
        .add_recoverable(&state.db, key, key.map(|_| 2))
        .await;
}

async fn user(state: &AppState, name: &str) -> User {
    get_user(&state.db, name)
        .await
        .expect("load")
        .expect("user")
}

async fn session(state: &AppState, name: &str, created_at: i64) -> Session {
    Session {
        user: user(state, name).await,
        token: format!("tok-{name}"),
        created_at,
    }
}

async fn set_switch(state: &AppState, key: &str, on: bool) {
    sqlx::query("INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(key)
        .bind(if on { "1" } else { "0" })
        .execute(&state.db)
        .await
        .expect("switch");
    Settings::forget(&state.db);
}

async fn put(
    state: &AppState,
    who: &str,
    ik: &str,
    version: i64,
    data: &[u8],
    t: i64,
) -> Result<BackupEntry, Refused> {
    let declared = Some(data.len() as u64);
    let body = Body::from(data.to_vec());
    let who = user(state, who).await;
    match put_at(state, &who, ik, version, declared, body, t).await {
        Ok(Json(entry)) => Ok(entry),
        Err(e) => Err(refusal(e)),
    }
}

fn refusal(e: PutError) -> Refused {
    match e {
        PutError::Stale(latest) => {
            let ApiError(code, msg, _) = stale(latest);
            (code, msg)
        }
        PutError::Other(ApiError(code, msg, _)) => (code, msg),
    }
}

async fn stored(res: Response) -> (Option<i64>, Vec<u8>) {
    let version = res
        .headers()
        .get(VERSION_HEADER)
        .map(|v| v.to_str().expect("ascii").parse().expect("number"));
    let body = to_bytes(res.into_body(), usize::MAX).await.expect("body");
    (version, body.to_vec())
}

async fn latest_of(
    state: &AppState,
    who: &str,
    ik: &str,
) -> Result<(Option<i64>, Vec<u8>), Refused> {
    let user = Authed(mem_user(who, false));
    match get_backup(State(state.clone()), user, Path(ik.to_string())).await {
        Ok(res) => Ok(stored(res).await),
        Err(ApiError(code, msg, _)) => Err((code, msg)),
    }
}

async fn version_of(
    state: &AppState,
    who: &str,
    ik: &str,
    version: i64,
    t: i64,
) -> Result<Vec<u8>, Refused> {
    match get_version_at(state, who, ik, version, t).await {
        Ok(res) => {
            let (number, data) = stored(res).await;
            assert_eq!(number, Some(version));
            Ok(data)
        }
        Err(ApiError(code, msg, _)) => Err((code, msg)),
    }
}

/// The kept version numbers at `t`, newest first.
async fn numbers(state: &AppState, who: &str, ik: &str, t: i64) -> Result<Vec<i64>, Refused> {
    match list_versions_at(state, who, ik, t).await {
        Ok(Json(list)) => Ok(list.iter().map(|v| v.version).collect()),
        Err(ApiError(code, msg, _)) => Err((code, msg)),
    }
}

async fn listed(state: &AppState, who: &str) -> Result<Vec<BackupEntry>, Refused> {
    match list_backups(State(state.clone()), Authed(mem_user(who, false))).await {
        Ok(Json(list)) => Ok(list),
        Err(ApiError(code, msg, _)) => Err((code, msg)),
    }
}

async fn delete(
    state: &AppState,
    who: &str,
    ik: &str,
    version: Option<i64>,
    reauth: Value,
    t: i64,
) -> Result<(), Refused> {
    let req: BackupDelete = serde_json::from_value(json!({ "reauth": reauth })).expect("body");
    let session = session(state, who, T0).await;
    match delete_at(state, session, ik, version, req, t).await {
        Ok(_) => Ok(()),
        Err(ApiError(code, msg, _)) => Err((code, msg)),
    }
}

/// Marks `who`'s account as being deleted and deletes it, as `DELETE /api/v1/me` does.
async fn purge(state: &AppState, who: &str) {
    sqlx::query("UPDATE users SET password_hash = $1 WHERE username = $2")
        .bind(crate::db::PURGING_HASH)
        .bind(who)
        .execute(&state.db)
        .await
        .expect("purging");
    crate::api::admin::finish_purge(state, crate::api::admin::PurgeKind::User, who)
        .await
        .expect("purge");
}

/// A body that sends what the returned sender sends, until it is dropped.
fn held_body() -> (tokio::sync::mpsc::Sender<Vec<u8>>, Body) {
    let (send, receive) = tokio::sync::mpsc::channel::<Vec<u8>>(1);
    let stream = futures_util::stream::unfold(receive, |mut receive| async move {
        receive
            .recv()
            .await
            .map(|b| (Ok::<_, std::io::Error>(axum::body::Bytes::from(b)), receive))
    });
    (send, Body::from_stream(stream))
}

/// Waits until uploads of `who` holding at least `kib` KiB are reading their bodies.
async fn reading(state: &AppState, who: &str, kib: u64) {
    for _ in 0..1200 {
        if crate::api::media::share_held(&state.db, who) >= kib {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("the upload never started reading its body");
}

async fn stored_bytes(state: &AppState, who: &str) -> i64 {
    sqlx::query(
        "SELECT CAST(COALESCE(SUM(size), 0) AS BIGINT) FROM p2p_backups WHERE username = $1",
    )
    .bind(who)
    .fetch_one(&state.db)
    .await
    .expect("sum")
    .try_get(0)
    .expect("sum value")
}

async fn rows(state: &AppState, table: &str, who: &str) -> i64 {
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT COUNT(*) FROM {table} WHERE username = $1"
    )))
    .bind(who)
    .fetch_one(&state.db)
    .await
    .expect("count")
    .try_get(0)
    .expect("count value")
}

#[tokio::test]
async fn backup_overwrite() {
    each_db("backup_overwrite", |state| async move {
        add_user(&state, "alice", None).await;
        let v = ik(1);
        let blobs: [&[u8]; 3] = [b"full", b"full2", b"empty"];
        for (n, blob) in (1..).zip(blobs) {
            put(&state, "alice", &v, n, blob, T0 + n)
                .await
                .expect("put");
        }
        assert_eq!(
            numbers(&state, "alice", &v, T0 + 9).await,
            Ok(vec![3, 2, 1])
        );
        for (n, blob) in (1..).zip(blobs) {
            assert_eq!(
                version_of(&state, "alice", &v, n, T0 + 9).await,
                Ok(blob.to_vec())
            );
        }
        assert_eq!(
            latest_of(&state, "alice", &v).await,
            Ok((Some(3), b"empty".to_vec()))
        );
        assert_eq!(
            delete(
                &state,
                "alice",
                &v,
                None,
                json!({"fresh_session": true}),
                T0 + 9
            )
            .await,
            Err(refused(
                StatusCode::UNAUTHORIZED,
                "Confirm with your password"
            ))
        );
        assert_eq!(
            numbers(&state, "alice", &v, T0 + 9).await,
            Ok(vec![3, 2, 1]),
            "a purge needs re-auth"
        );

        let w = ik(2);
        for (n, at) in [(1, T0), (2, T0 + DAY + 5), (3, T0 + 2 * DAY)] {
            put(
                &state,
                "alice",
                &w,
                n,
                format!("full-d{}", n - 1).as_bytes(),
                at,
            )
            .await
            .expect("a good day");
        }
        for i in 0..50 {
            put(&state, "alice", &w, 4 + i, b"empty", T0 + 2 * DAY + 1 + i)
                .await
                .expect("an emptied dump");
        }
        assert_eq!(
            numbers(&state, "alice", &w, T0 + 2 * DAY + 60).await,
            Ok(vec![53, 52, 51, 3, 2, 1]),
            "every day's first version is kept"
        );
        let firsts = |day: i64| {
            let state = state.clone();
            let w = w.clone();
            async move {
                let kept = numbers(&state, "alice", &w, T0 + day * DAY)
                    .await
                    .expect("list");
                kept.into_iter().filter(|n| *n <= 3).collect::<Vec<i64>>()
            }
        };
        assert_eq!(
            [firsts(29).await, firsts(32).await, firsts(33).await],
            [vec![3, 2, 1], vec![3, 2], vec![]],
            "only time removes a day's first version"
        );
        assert_eq!(
            numbers(&state, "alice", &w, T0 + 33 * DAY).await,
            Ok(vec![53, 52, 51])
        );
        assert_eq!(
            version_of(&state, "alice", &w, 1, T0 + 33 * DAY).await,
            Err(refused(StatusCode::NOT_FOUND, "Not found"))
        );

        let x = ik(3);
        put(&state, "alice", &x, 1, b"full-a", T0).await.expect("a");
        put(&state, "alice", &x, 2, b"full-b", T0 + DAY)
            .await
            .expect("b");
        for i in 0..3 {
            put(&state, "alice", &x, 3 + i, b"empty", T0 + 40 * DAY + i)
                .await
                .expect("an emptied dump");
        }
        assert_eq!(
            numbers(&state, "alice", &x, T0 + 40 * DAY + 9).await,
            Ok(vec![5, 4, 3, 2]),
            "the newest version older than 30 days stays"
        );
        assert_eq!(
            version_of(&state, "alice", &x, 2, T0 + 40 * DAY + 9).await,
            Ok(b"full-b".to_vec())
        );

        let y = ik(4);
        for h in 0..60 * 24 {
            put(
                &state,
                "alice",
                &y,
                h + 1,
                format!("g{h}").as_bytes(),
                T0 + h * HOUR,
            )
            .await
            .expect("an hourly upload");
            let held = sqlx::query(
                "SELECT COUNT(*) FROM p2p_backups WHERE username = 'alice' AND ik = $1",
            )
            .bind(&y)
            .fetch_one(&state.db)
            .await
            .expect("count")
            .try_get::<i64, _>(0)
            .expect("count value");
            assert!(held <= 35, "{held} versions after hour {h}");
        }
        let end = T0 + 60 * 24 * HOUR;
        let kept = numbers(&state, "alice", &y, end).await.expect("list");
        assert!(kept.len() <= 35, "{}", kept.len());
        assert_eq!(
            latest_of(&state, "alice", &y).await,
            Ok((Some(1440), b"g1439".to_vec()))
        );
        delete(&state, "alice", &y, None, json!({"password": "pw"}), end)
            .await
            .expect("a purge with re-auth");
        assert_eq!(
            numbers(&state, "alice", &y, end).await,
            Err(refused(StatusCode::NOT_FOUND, "Not found"))
        );
    })
    .await;
}

#[tokio::test]
async fn backup_size() {
    let small = Limits {
        p2p_backup_max_mib: 1,
        p2p_backup_total_mib: 4,
        ..Limits::default()
    };
    each_db("backup_size", |state| {
        let state = sized(small.clone())(state);
        async move {
            for name in ["alice", "bob"] {
                add_user(&state, name, None).await;
            }
            let (v, w) = (ik(1), ik(2));
            let sixty = vec![6u8; MIB * 60 / 64];
            let big = vec![9u8; MIB * 65 / 64];
            let too_large = refused(StatusCode::PAYLOAD_TOO_LARGE, "Backup too large");
            let full = refused(StatusCode::PAYLOAD_TOO_LARGE, "Backup storage full");
            assert_eq!(put(&state, "alice", &v, 1, &big, T0).await, Err(too_large.clone()));
            assert_eq!(latest_of(&state, "alice", &v).await.map(|_| ()), Err(refused(StatusCode::NOT_FOUND, "Not found")));
            put(&state, "alice", &v, 1, &sixty, T0).await.expect("a");
            put(&state, "alice", &w, 1, &sixty, T0 + 1).await.expect("b, another identity");
            put(&state, "alice", &v, 2, &sixty, T0 + DAY).await.expect("c");
            put(&state, "alice", &v, 3, &sixty, T0 + 2 * DAY).await.expect("d");
            assert_eq!(put(&state, "alice", &v, 4, &sixty, T0 + 3 * DAY).await, Err(full.clone()));
            let chunked = put_at(&state, &user(&state, "alice").await, &v, 4, None, Body::from(big.clone()), T0 + 3 * DAY).await;
            assert!(matches!(chunked, Err(PutError::Other(ApiError(StatusCode::PAYLOAD_TOO_LARGE, ref m, _))) if m == "Backup too large"));
            assert_eq!(numbers(&state, "alice", &v, T0 + 3 * DAY).await, Ok(vec![3, 2, 1]), "nothing evicted");
            assert_eq!(numbers(&state, "alice", &w, T0 + 3 * DAY).await, Ok(vec![1]));
            for n in 1..=3 {
                assert_eq!(version_of(&state, "alice", &v, n, T0 + 3 * DAY).await, Ok(sixty.clone()));
            }
            for n in 1..=4 {
                put(&state, "bob", &v, n, &sixty, T0 + n).await.expect("another account's total");
            }
            assert_eq!(put(&state, "alice", &w, 2, b"x", T0 + 3 * DAY).await.map(|e| e.version), Ok(2), "a small one still fits");
            assert_eq!(put(&state, "alice", &v, 3, &sixty, T0 + 3 * DAY).await, Err(refused(StatusCode::CONFLICT, "Backup version must be 4")));
        }
    })
    .await;
    let no_total = Limits {
        p2p_backup_max_mib: 1,
        p2p_backup_total_mib: 0,
        ..Limits::default()
    };
    each_db("backup_no_total", |state| {
        let state = sized(no_total.clone())(state);
        async move {
            add_user(&state, "alice", None).await;
            let v = ik(1);
            for n in 0..10 {
                put(
                    &state,
                    "alice",
                    &v,
                    n + 1,
                    &vec![6u8; MIB * 60 / 64],
                    T0 + n * DAY,
                )
                .await
                .expect("no total");
            }
            put(&state, "alice", &v, 11, &vec![1u8; MIB], T0 + 10 * DAY)
                .await
                .expect("exactly the cap");
            assert_eq!(
                put(&state, "alice", &v, 3, b"x", T0 + 11 * DAY).await,
                Err(refused(StatusCode::CONFLICT, "Backup version must be 12"))
            );
        }
    })
    .await;
}

#[tokio::test]
async fn backup_delete() {
    each_db("backup_delete", |state| async move {
        add_user(&state, "alice", None).await;
        let v = ik(1);
        for n in 0..3 {
            put(
                &state,
                "alice",
                &v,
                n + 1,
                format!("blob{n}").as_bytes(),
                T0 + n * 1000,
            )
            .await
            .expect("put");
        }
        assert_eq!(
            latest_of(&state, "alice", &v).await,
            Ok((Some(3), b"blob2".to_vec()))
        );
        let t = T0 + 5000;
        assert_eq!(
            delete(
                &state,
                "alice",
                &v,
                Some(3),
                json!({"fresh_session": true}),
                t
            )
            .await,
            Err(refused(
                StatusCode::UNAUTHORIZED,
                "Confirm with your password"
            ))
        );
        assert_eq!(
            delete(&state, "alice", &v, Some(3), json!({"password": "nope"}), t).await,
            Err(refused(StatusCode::UNAUTHORIZED, "Wrong password"))
        );
        assert_eq!(numbers(&state, "alice", &v, t).await, Ok(vec![3, 2, 1]));
        delete(
            &state,
            "alice",
            &v,
            Some(3),
            json!({"password": "pw"}),
            t + 3,
        )
        .await
        .expect("deleted with re-auth");
        assert_eq!(numbers(&state, "alice", &v, t + 3).await, Ok(vec![2, 1]));
        assert_eq!(
            version_of(&state, "alice", &v, 3, t + 3).await,
            Err(refused(StatusCode::NOT_FOUND, "Not found"))
        );
        assert_eq!(
            delete(
                &state,
                "alice",
                &v,
                Some(3),
                json!({"password": "pw"}),
                t + 6
            )
            .await,
            Err(refused(StatusCode::NOT_FOUND, "Not found"))
        );
        assert_eq!(
            put(&state, "alice", &v, 3, b"late", t + 7).await,
            Err(refused(StatusCode::CONFLICT, "Backup version must be 4"))
        );
        let alice = user(&state, "alice").await;
        let late = put_at(&state, &alice, &v, 3, Some(4), Body::from("late"), t + 7)
            .await
            .expect_err("refused")
            .into_response();
        assert_eq!(
            (late.status(), late.headers().get(VERSION_HEADER)),
            (StatusCode::CONFLICT, Some(&HeaderValue::from(3))),
            "a 409 gives the latest number while version 3 is gone"
        );
        put(&state, "alice", &v, 4, b"next", t + 8)
            .await
            .expect("version 4");
        assert_eq!(
            latest_of(&state, "alice", &v).await,
            Ok((Some(4), b"next".to_vec()))
        );
        assert_eq!(
            delete(
                &state,
                "alice",
                &v,
                None,
                json!({"fresh_session": true}),
                t + 9
            )
            .await,
            Err(refused(
                StatusCode::UNAUTHORIZED,
                "Confirm with your password"
            ))
        );
        delete(&state, "alice", &v, None, json!({"password": "pw"}), t + 12)
            .await
            .expect("the whole backup");
        assert_eq!(
            (
                rows(&state, "p2p_backups", "alice").await,
                rows(&state, "p2p_backup_seq", "alice").await
            ),
            (0, 1)
        );
        assert_eq!(
            latest_of(&state, "alice", &v).await,
            Err(refused(StatusCode::NOT_FOUND, "Not found"))
        );
        assert_eq!(
            delete(&state, "alice", &v, None, json!({"password": "pw"}), t + 15).await,
            Err(refused(StatusCode::NOT_FOUND, "Not found"))
        );
        assert_eq!(
            put(&state, "alice", &v, 1, b"again", t + 16).await,
            Err(refused(StatusCode::CONFLICT, "Backup version must be 5")),
            "numbers are never reused, also after the whole backup is deleted"
        );
        let again = put_at(&state, &alice, &v, 1, Some(5), Body::from("again"), t + 16)
            .await
            .expect_err("refused")
            .into_response();
        assert_eq!(
            (again.status(), again.headers().get(VERSION_HEADER)),
            (StatusCode::CONFLICT, Some(&HeaderValue::from(4)))
        );
        put(&state, "alice", &v, 5, b"again", t + 16)
            .await
            .expect("the next number");
        delete(
            &state,
            "alice",
            &v,
            Some(5),
            json!({"password": "pw"}),
            t + 18,
        )
        .await
        .expect("its only version");
        assert_eq!(
            latest_of(&state, "alice", &v).await,
            Err(refused(StatusCode::NOT_FOUND, "Not found")),
            "the last version takes the backup with it"
        );
        assert_eq!(
            put(&state, "alice", &v, 5, b"reused", t + 19).await,
            Err(refused(StatusCode::CONFLICT, "Backup version must be 6"))
        );
    })
    .await;
}

#[tokio::test]
async fn a_backup_is_only_its_owners() {
    each_db("p2p_backup_owner", |state| async move {
        for name in ["alice", "bob"] {
            add_user(&state, name, None).await;
        }
        let (v, w) = (ik(1), ik(2));
        let data: Vec<u8> = (0..=255u8).cycle().take(4096).collect();
        let entry = put(&state, "alice", &v, 1, &data, T0).await.expect("put");
        assert_eq!(
            entry,
            BackupEntry {
                ik: v.clone(),
                version: 1,
                size: 4096,
                updated_at: T0
            }
        );
        assert_eq!(
            latest_of(&state, "alice", &v).await,
            Ok((Some(1), data.clone()))
        );
        let none = refused(StatusCode::NOT_FOUND, "Not found");
        assert_eq!(latest_of(&state, "bob", &v).await, Err(none.clone()));
        assert_eq!(numbers(&state, "bob", &v, T0).await, Err(none.clone()));
        assert_eq!(
            version_of(&state, "bob", &v, 1, T0).await,
            Err(none.clone())
        );
        assert_eq!(
            delete(&state, "bob", &v, Some(1), json!({"password": "pw"}), T0).await,
            Err(none.clone())
        );
        assert_eq!(
            delete(&state, "bob", &v, None, json!({"password": "pw"}), T0 + 3).await,
            Err(none.clone())
        );
        assert_eq!(listed(&state, "bob").await, Ok(vec![]));
        put(&state, "bob", &v, 1, b"bob's own", T0 + 1)
            .await
            .expect("bob's own backup of that key");
        assert_eq!(
            latest_of(&state, "alice", &v).await,
            Ok((Some(1), data.clone()))
        );
        put(&state, "bob", &v, 2, b"bob's next", T0 + 2)
            .await
            .expect("bob's own numbering");
        delete(
            &state,
            "bob",
            &v,
            Some(1),
            json!({"password": "pw"}),
            T0 + 3,
        )
        .await
        .expect("bob deletes his version 1");
        delete(&state, "bob", &v, None, json!({"password": "pw"}), T0 + 6)
            .await
            .expect("bob deletes his backup");
        assert_eq!(listed(&state, "bob").await, Ok(vec![]));
        assert_eq!(
            latest_of(&state, "alice", &v).await,
            Ok((Some(1), data.clone())),
            "bob's deletes never touch alice's backup"
        );
        assert_eq!(numbers(&state, "alice", &v, T0 + 6).await, Ok(vec![1]));

        put(&state, "alice", &w, 1, b"w1", T0 + 10)
            .await
            .expect("w1");
        put(&state, "alice", &w, 2, b"w2", T0 + 20)
            .await
            .expect("w2");
        assert_eq!(numbers(&state, "alice", &v, T0 + 30).await, Ok(vec![1]));
        assert_eq!(numbers(&state, "alice", &w, T0 + 30).await, Ok(vec![2, 1]));
        assert_eq!(
            listed(&state, "alice").await,
            Ok(vec![
                BackupEntry {
                    ik: w.clone(),
                    version: 2,
                    size: 2,
                    updated_at: T0 + 20
                },
                BackupEntry {
                    ik: v.clone(),
                    version: 1,
                    size: 4096,
                    updated_at: T0
                },
            ])
        );

        let weak = URL_SAFE_NO_PAD.encode([0u8; 32]);
        let padded = format!("{v}=");
        let upper = v.to_uppercase();
        let bad_ik = refused(
            StatusCode::BAD_REQUEST,
            "ik must be a base64url Ed25519 public key",
        );
        for odd in [
            "not-a-key",
            "",
            weak.as_str(),
            padded.as_str(),
            upper.as_str(),
            &v[..42],
        ] {
            assert_eq!(
                put(&state, "alice", odd, 1, b"x", T0).await,
                Err(bad_ik.clone()),
                "{odd}"
            );
            assert_eq!(
                latest_of(&state, "alice", odd).await,
                Err(bad_ik.clone()),
                "{odd}"
            );
            assert_eq!(
                numbers(&state, "alice", odd, T0).await,
                Err(bad_ik.clone()),
                "{odd}"
            );
            assert_eq!(
                version_of(&state, "alice", odd, 1, T0).await,
                Err(bad_ik.clone()),
                "{odd}"
            );
            assert_eq!(
                delete(&state, "alice", odd, None, json!({"password": "pw"}), T0).await,
                Err(bad_ik.clone()),
                "{odd}"
            );
        }
    })
    .await;
}

#[tokio::test]
async fn deleting_needs_the_password_or_a_phrase_signed_for_that_ik() {
    let (state, path) = temp_state("p2p_backup_reauth").await;
    add_user(&state, "alice", Some(PHRASE_KEY)).await;
    let (v, w) = (ik(1), ik(2));
    put(&state, "alice", &v, 1, b"v", T0).await.expect("put");
    let purpose = Purpose::P2pData { ik: v.clone() };
    assert_eq!(
        (
            purpose.as_str(),
            purpose.context(),
            purpose.fresh_session_ok(&mem_user("alice", false))
        ),
        ("p2p-data", v.as_str(), false)
    );
    let mut t = T0 + 100;
    let wrong = refused(StatusCode::UNAUTHORIZED, "Wrong backup phrase");
    for (kind, context) in [
        ("p2p-data", w.as_str()),
        ("remove", v.as_str()),
        ("p2p-data", ""),
    ] {
        let nonce = issue_nonce(&state.db, "alice", t).await.expect("nonce");
        let proof =
            json!({"phrase": {"nonce": nonce, "sig": phrase_sign(kind, "alice", &nonce, context)}});
        assert_eq!(
            delete(&state, "alice", &v, None, proof, t).await,
            Err(wrong.clone()),
            "{kind} {context}"
        );
        t += 3;
    }
    let fresh = Session {
        created_at: t,
        ..session(&state, "alice", t).await
    };
    let req: BackupDelete =
        serde_json::from_value(json!({"reauth": {"fresh_session": true}})).expect("body");
    assert!(matches!(
        delete_at(&state, fresh, &v, None, req, t).await,
        Err(ApiError(StatusCode::UNAUTHORIZED, ref m, _)) if m == "Confirm with your password"
    ));
    assert_eq!(numbers(&state, "alice", &v, t).await, Ok(vec![1]));
    let nonce = issue_nonce(&state.db, "alice", t).await.expect("nonce");
    let proof =
        json!({"phrase": {"nonce": nonce, "sig": phrase_sign("p2p-data", "alice", &nonce, &v)}});
    delete(&state, "alice", &v, Some(1), proof, t)
        .await
        .expect("a phrase signed for this ik");
    assert_eq!(rows(&state, "p2p_backups", "alice").await, 0);
    done(state, path).await;
}

#[tokio::test]
async fn deleting_the_account_removes_its_backups() {
    let (state, path) = temp_state("p2p_backup_purge").await;
    for name in ["alice", "bob"] {
        add_user(&state, name, None).await;
    }
    for (n, key) in [ik(1), ik(2)].iter().enumerate() {
        put(&state, "alice", key, 1, b"one", T0 + n as i64)
            .await
            .expect("one");
        put(&state, "alice", key, 2, b"two", T0 + 10 + n as i64)
            .await
            .expect("two");
    }
    put(&state, "bob", &ik(1), 1, b"bob", T0)
        .await
        .expect("bob");
    purge(&state, "alice").await;
    for table in ["p2p_backups", "p2p_backup_seq"] {
        assert_eq!(
            (
                rows(&state, table, "alice").await,
                rows(&state, table, "bob").await
            ),
            (0, 1),
            "{table}"
        );
    }
    add_user(&state, "alice", None).await;
    assert_eq!(listed(&state, "alice").await, Ok(vec![]));
    assert_eq!(
        latest_of(&state, "alice", &ik(1)).await,
        Err(refused(StatusCode::NOT_FOUND, "Not found"))
    );
    assert_eq!(
        put(&state, "alice", &ik(1), 1, b"new", T0 + 100)
            .await
            .map(|e| e.version),
        Ok(1)
    );
    done(state, path).await;
}

#[tokio::test]
async fn an_upload_in_flight_when_the_account_is_deleted_stores_nothing() {
    each_db("p2p_backup_purge_race", |state| async move {
        let v = ik(1);
        let none = refused(StatusCode::NOT_FOUND, "Not found");
        for (round, registered_meanwhile) in [(1, false), (2, true)] {
            add_user_at(&state, "alice", None, round * 10).await;
            let old = user(&state, "alice").await;
            let (send, body) = held_body();
            let upload = {
                let (state, v) = (state.clone(), v.clone());
                tokio::spawn(async move {
                    put_at(&state, &old, &v, 1, None, body, T0)
                        .await
                        .map(|Json(e)| e.version)
                        .map_err(refusal)
                })
            };
            reading(&state, "alice", 1).await;
            purge(&state, "alice").await;
            if registered_meanwhile {
                add_user_at(&state, "alice", None, round * 10 + 5).await;
            }
            send.send(b"sealed by the old account".to_vec())
                .await
                .expect("send");
            drop(send);
            assert_eq!(
                upload.await.expect("join"),
                Err(none.clone()),
                "round {round}"
            );
            if !registered_meanwhile {
                add_user_at(&state, "alice", None, round * 10 + 5).await;
            }
            for table in ["p2p_backups", "p2p_backup_seq"] {
                assert_eq!(rows(&state, table, "alice").await, 0, "{table} {round}");
            }
            assert_eq!(listed(&state, "alice").await, Ok(vec![]), "round {round}");
            assert_eq!(
                latest_of(&state, "alice", &v).await,
                Err(none.clone()),
                "round {round}"
            );
            purge(&state, "alice").await;
        }
    })
    .await;
}

#[tokio::test]
async fn an_account_backs_up_at_most_8_identities() {
    each_db("p2p_backup_identities", |state| async move {
        for name in ["alice", "bob"] {
            add_user(&state, name, None).await;
        }
        let many = refused(StatusCode::CONFLICT, "Too many P2P backups");
        for n in 1..=7u8 {
            put(&state, "alice", &ik(n), 1, b"one", T0 + i64::from(n))
                .await
                .expect("an identity");
        }
        let (eight, nine) = (ik(8), ik(9));
        let alice = user(&state, "alice").await;
        let ((send8, body8), (send9, body9)) = (held_body(), held_body());
        let both_read = async {
            reading(&state, "alice", 2).await;
            for (send, data) in [(send8, b"8"), (send9, b"9")] {
                send.send(data.to_vec()).await.expect("send");
            }
        };
        let (eighth, ninth, ()) = tokio::join!(
            put_at(&state, &alice, &eight, 1, Some(1), body8, T0 + 10),
            put_at(&state, &alice, &nine, 1, Some(1), body9, T0 + 10),
            both_read
        );
        let [eighth, ninth] =
            [eighth, ninth].map(|res| res.map(|Json(entry)| entry).map_err(refusal));
        assert!(
            matches!((&eighth, &ninth), (Ok(_), Err(e)) | (Err(e), Ok(_)) if *e == many),
            "{eighth:?} {ninth:?}"
        );
        let (kept, out) = match eighth.is_ok() {
            true => (eight, nine),
            false => (nine, eight),
        };
        assert_eq!(
            listed(&state, "alice").await.map(|l| l.len()),
            Ok(BACKUP_IDENTITIES)
        );
        let unread = Body::from_stream(futures_util::stream::once(async {
            Err::<axum::body::Bytes, _>(std::io::Error::other("never read"))
        }));
        assert!(
            matches!(
                put_at(&state, &alice, &out, 1, None, unread, T0 + 11).await,
                Err(PutError::Other(ApiError(StatusCode::CONFLICT, ref m, _))) if m == "Too many P2P backups"
            ),
            "refused before reading the body"
        );
        put(&state, "alice", &kept, 2, b"again", T0 + 12)
            .await
            .expect("a kept identity's next version");
        put(&state, "bob", &out, 1, b"bob", T0 + 12)
            .await
            .expect("another account");
        delete(
            &state,
            "alice",
            &ik(1),
            None,
            json!({"password": "pw"}),
            T0 + 13,
        )
        .await
        .expect("one backup deleted");
        put(&state, "alice", &out, 1, b"now", T0 + 14)
            .await
            .expect("room for one more");
        assert_eq!(
            put(&state, "alice", &ik(1), 2, b"back", T0 + 15).await,
            Err(many),
            "the deleted backup's next number, refused by the cap"
        );
    })
    .await;
}

#[tokio::test]
async fn two_identities_at_once_never_pass_the_total() {
    let small = Limits {
        p2p_backup_max_mib: 1,
        p2p_backup_total_mib: 4,
        ..Limits::default()
    };
    each_db("p2p_backup_total_race", |state| {
        let state = sized(small.clone())(state);
        async move {
            add_user(&state, "alice", None).await;
            let (v, w) = (ik(1), ik(2));
            let sixty = vec![6u8; MIB * 60 / 64];
            for n in 1..=3 {
                put(&state, "alice", &v, n, &sixty, T0 + (n - 1) * DAY)
                    .await
                    .expect("stored");
            }
            let t = T0 + 3 * DAY;
            let alice = user(&state, "alice").await;
            let ((send_v, body_v), (send_w, body_w)) = (held_body(), held_body());
            let size = Some(sixty.len() as u64);
            let both_read = async {
                reading(&state, "alice", 2 * 960).await;
                for send in [send_v, send_w] {
                    send.send(sixty.clone()).await.expect("send");
                }
            };
            let (a, b, ()) = tokio::join!(
                put_at(&state, &alice, &v, 4, size, body_v, t),
                put_at(&state, &alice, &w, 1, size, body_w, t),
                both_read
            );
            let [a, b] = [a, b].map(|res| res.map(|Json(entry)| entry).map_err(refusal));
            let full = refused(StatusCode::PAYLOAD_TOO_LARGE, "Backup storage full");
            assert!(
                matches!((&a, &b), (Ok(_), Err(e)) | (Err(e), Ok(_)) if *e == full),
                "{a:?} {b:?}"
            );
            assert_eq!(
                stored_bytes(&state, "alice").await,
                (4 * sixty.len()) as i64
            );
        }
    })
    .await;
}

#[tokio::test]
async fn downloads_hold_room_until_their_body_is_read() {
    let (state, path) = temp_state("p2p_backup_downloads").await;
    for name in ["alice", "bob"] {
        add_user(&state, name, None).await;
    }
    let v = ik(1);
    let data = vec![7u8; 300 * 1024];
    for n in 1..=2 {
        put(&state, "alice", &v, n, &data, T0 + n)
            .await
            .expect("stored");
    }
    put(&state, "bob", &v, 1, b"bob", T0).await.expect("bob's");
    let held = || crate::api::media::share_held(&state.db, "alice");
    assert_eq!(held(), 0);
    let get = |who: &'static str, version: Option<i64>| {
        let (state, v) = (state.clone(), v.clone());
        async move {
            match version {
                None => {
                    get_backup(State(state.clone()), Authed(mem_user(who, false)), Path(v)).await
                }
                Some(n) => get_version_at(&state, who, &v, n, T0 + 5).await,
            }
            .map_err(|ApiError(code, msg, _)| (code, msg))
        }
    };
    let mut open = Vec::new();
    for version in [None, Some(1), Some(2)] {
        open.push(get("alice", version).await.expect("a download"));
    }
    assert_eq!(held(), 3 * 300, "each download holds room for its version");
    let busy = refused(
        StatusCode::TOO_MANY_REQUESTS,
        "Too many backup transfers at once, try again in a moment",
    );
    for version in [None, Some(1)] {
        assert_eq!(
            get("alice", version).await.map(|_| ()),
            Err(busy.clone()),
            "a fourth download of one account"
        );
    }
    assert!(
        matches!(
            put(&state, "alice", &v, 3, b"x", T0 + 6).await,
            Err((StatusCode::TOO_MANY_REQUESTS, _))
        ),
        "uploads and downloads share the account's places"
    );
    let bob = get("bob", None).await.expect("another account");
    assert_eq!(stored(bob).await, (Some(1), b"bob".to_vec()));
    let first = open.remove(0);
    assert_eq!(held(), 3 * 300, "held until the body is read");
    assert_eq!(stored(first).await, (Some(2), data.clone()));
    assert_eq!(held(), 2 * 300);
    let again = get("alice", Some(1)).await.expect("a place is free again");
    assert_eq!(stored(again).await, (Some(1), data.clone()));
    drop(open);
    released(&state, "alice").await;
    done(state, path).await;
}

/// Waits until `who` holds no room in the upload buffer.
async fn released(state: &AppState, who: &str) {
    for _ in 0..1200 {
        if crate::api::media::share_held(&state.db, who) == 0 {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("the room was never given back");
}

#[tokio::test]
async fn a_download_nobody_takes_gives_its_room_back() {
    use crate::api::media::{MEDIA_CHUNK, with_waits};
    use futures_util::StreamExt;
    use std::time::Duration;
    let (state, path) = temp_state("p2p_backup_stalled").await;
    add_user(&state, "alice", None).await;
    let v = ik(1);
    let data: Vec<u8> = (0..=255u8).cycle().take(6 * MEDIA_CHUNK).collect();
    put(&state, "alice", &v, 1, &data, T0)
        .await
        .expect("stored");
    let kib = (data.len() / 1024) as u64;
    let held = || crate::api::media::share_held(&state.db, "alice");
    let latest = || {
        get_backup(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            Path(v.clone()),
        )
    };
    let cut_short = |got: &[u8]| got.len() < data.len() && got == &data[..got.len()];

    let quick = Duration::from_secs(2);
    let long = Duration::from_secs(600);
    let untaken = with_waits(quick, long, latest()).await.expect("a download");
    assert_eq!(held(), kib, "held while it is sent");
    released(&state, "alice").await;
    let (version, got) = stored(untaken).await;
    assert_eq!(version, Some(1));
    assert!(cut_short(&got), "{} of {} bytes", got.len(), data.len());

    let taken = with_waits(quick, long, latest()).await.expect("a download");
    assert_eq!(
        stored(taken).await,
        (Some(1), data.clone()),
        "a download that is read arrives whole"
    );
    assert_eq!(held(), 0);

    let slow = with_waits(
        long,
        Duration::from_secs(1),
        get_version_at(&state, "alice", &v, 1, T0 + 1),
    )
    .await
    .expect("a download");
    let mut body = slow.into_body().into_data_stream();
    let mut got = Vec::new();
    while let Some(piece) = body.next().await {
        got.extend_from_slice(&piece.expect("a piece"));
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    assert!(cut_short(&got), "{} of {} bytes", got.len(), data.len());
    assert_eq!(
        held(),
        0,
        "a download longer than the body wait gives its room back"
    );
    done(state, path).await;
}

#[tokio::test]
async fn reading_versions_takes_the_writer_only_to_remove_aged_ones() {
    let (state, path) = temp_state("p2p_backup_reads").await;
    add_user(&state, "alice", None).await;
    let v = ik(1);
    for n in 1..=4 {
        put(
            &state,
            "alice",
            &v,
            n,
            format!("v{n}").as_bytes(),
            T0 + (n - 1) * DAY,
        )
        .await
        .expect("stored");
    }
    let writer = state.db.acquire().await.expect("the only writer");
    let t = T0 + 3 * DAY + 10;
    let wait = std::time::Duration::from_secs(60);
    assert_eq!(
        tokio::time::timeout(wait, numbers(&state, "alice", &v, t)).await,
        Ok(Ok(vec![4, 3, 2, 1]))
    );
    assert_eq!(
        tokio::time::timeout(wait, version_of(&state, "alice", &v, 1, t)).await,
        Ok(Ok(b"v1".to_vec()))
    );
    drop(writer);
    assert_eq!(
        numbers(&state, "alice", &v, T0 + 40 * DAY).await,
        Ok(vec![4, 3, 2])
    );
    assert_eq!(
        rows(&state, "p2p_backups", "alice").await,
        3,
        "the aged one is deleted"
    );
    done(state, path).await;
}

#[tokio::test]
async fn the_switches() {
    let (state, path) = temp_state("p2p_backup_switches").await;
    add_user(&state, "alice", None).await;
    let v = ik(1);
    put(&state, "alice", &v, 1, b"one", T0).await.expect("put");
    put(&state, "alice", &v, 2, b"two", T0 + 1)
        .await
        .expect("put");
    let none = refused(StatusCode::NOT_FOUND, "Not found");
    let off = sized(Limits {
        p2p_backup_max_mib: 0,
        ..Limits::default()
    })(state.clone());
    assert_eq!(listed(&off, "alice").await, Err(none.clone()));
    assert_eq!(latest_of(&off, "alice", &v).await, Err(none.clone()));
    assert_eq!(numbers(&off, "alice", &v, T0 + 2).await, Err(none.clone()));
    assert_eq!(
        version_of(&off, "alice", &v, 1, T0 + 2).await,
        Err(none.clone())
    );
    assert_eq!(
        put(&off, "alice", &v, 3, b"x", T0 + 2).await,
        Err(none.clone())
    );
    assert_eq!(
        delete(
            &off,
            "alice",
            &v,
            Some(1),
            json!({"password": "pw"}),
            T0 + 2
        )
        .await,
        Err(none.clone())
    );
    assert_eq!(
        delete(&off, "alice", &v, None, json!({"password": "pw"}), T0 + 5).await,
        Err(none.clone())
    );
    let mut t = T0 + 10;
    for switch in ["p2p_backup", "p2p"] {
        set_switch(&state, switch, false).await;
        assert_eq!(
            put(&state, "alice", &v, 3, b"x", t).await,
            Err(none.clone()),
            "{switch}"
        );
        assert_eq!(
            listed(&state, "alice").await.map(|l| l.len()),
            Ok(1),
            "{switch}"
        );
        assert_eq!(
            latest_of(&state, "alice", &v).await,
            Ok((Some(2), b"two".to_vec())),
            "{switch}"
        );
        assert_eq!(
            numbers(&state, "alice", &v, t).await,
            Ok(vec![2, 1]),
            "{switch}"
        );
        assert_eq!(
            version_of(&state, "alice", &v, 1, t).await,
            Ok(b"one".to_vec()),
            "{switch}"
        );
        set_switch(&state, switch, true).await;
        t += 10;
    }
    set_switch(&state, "p2p_backup", false).await;
    set_switch(&state, "p2p", false).await;
    delete(&state, "alice", &v, Some(1), json!({"password": "pw"}), t)
        .await
        .expect("delete a version while off");
    delete(&state, "alice", &v, None, json!({"password": "pw"}), t + 3)
        .await
        .expect("delete the backup while off");
    assert_eq!(rows(&state, "p2p_backups", "alice").await, 0);
    let info = |state: AppState| async move {
        let res = crate::api::instance::instance(
            State(state),
            crate::api::instance::Peer(None),
            HeaderMap::new(),
        )
        .await;
        let body = to_bytes(res.into_body(), usize::MAX).await.expect("body");
        let info: Value = serde_json::from_slice(&body).expect("json");
        (
            info["features"]["p2p_backup"].clone(),
            info["limits"]["p2p_backup_bytes"].clone(),
            info["limits"]["p2p_backup_total_bytes"].clone(),
        )
    };
    assert_eq!(
        info(state.clone()).await,
        (json!(true), json!(64 * MIB), json!(256 * MIB)),
        "the live switches leave the capability on"
    );
    assert_eq!(info(off).await, (json!(false), json!(0), json!(256 * MIB)));
    let no_total = sized(Limits {
        p2p_backup_max_mib: 8,
        p2p_backup_total_mib: 0,
        ..Limits::default()
    })(state.clone());
    assert_eq!(
        info(no_total).await,
        (json!(true), json!(8 * MIB), json!(0))
    );
    done(state, path).await;
}

#[tokio::test]
async fn two_uploads_of_one_version_at_once() {
    each_db("p2p_backup_race", |state| async move {
        add_user(&state, "alice", None).await;
        let v = ik(1);
        for n in 1..=3 {
            let (one, two) = (format!("a{n}"), format!("b{n}"));
            let (a, b) = tokio::join!(
                put(&state, "alice", &v, n, one.as_bytes(), T0 + n),
                put(&state, "alice", &v, n, two.as_bytes(), T0 + n)
            );
            let conflict = Err(refused(
                StatusCode::CONFLICT,
                &format!("Backup version must be {}", n + 1),
            ));
            let won = match (&a, &b) {
                (Ok(_), _) if b == conflict => format!("a{n}"),
                (_, Ok(_)) if a == conflict => format!("b{n}"),
                _ => panic!("{a:?} {b:?}"),
            };
            assert_eq!(
                latest_of(&state, "alice", &v).await,
                Ok((Some(n), won.into_bytes()))
            );
        }
    })
    .await;
}

#[tokio::test]
async fn aged_versions_are_swept() {
    let (state, path) = temp_state("p2p_backup_sweep").await;
    add_user(&state, "alice", None).await;
    let (v, w) = (ik(1), ik(2));
    for (n, at) in [
        (1, T0),
        (2, T0 + DAY),
        (3, T0 + 2 * DAY),
        (4, T0 + 2 * DAY + 1),
        (5, T0 + 2 * DAY + 2),
        (6, T0 + 2 * DAY + 3),
    ] {
        put(&state, "alice", &v, n, b"v", at).await.expect("v");
    }
    for n in 1..=3 {
        put(&state, "alice", &w, n, b"w", T0 + n).await.expect("w");
    }
    let held = |ik: String| {
        let state = state.clone();
        async move {
            sqlx::query("SELECT version FROM p2p_backups WHERE username = 'alice' AND ik = $1 ORDER BY version")
                .bind(ik)
                .fetch_all(&state.db)
                .await
                .expect("versions")
                .iter()
                .map(|r| r.try_get::<i64, _>(0).expect("version"))
                .collect::<Vec<_>>()
        }
    };
    assert_eq!(held(v.clone()).await, [1, 2, 3, 4, 5, 6]);
    let swept = crate::db::sweep_stale_at(&state.db, &state.limits, T0 + 31 * DAY)
        .await
        .expect("sweep");
    assert_eq!(
        swept.p2p_backups, 0,
        "the first day is the newest older one"
    );
    let swept = crate::db::sweep_stale_at(&state.db, &state.limits, T0 + 32 * DAY)
        .await
        .expect("sweep");
    assert_eq!(swept.p2p_backups, 1);
    assert_eq!(held(v.clone()).await, [2, 3, 4, 5, 6]);
    let swept = crate::db::sweep_stale_at(&state.db, &state.limits, T0 + 40 * DAY)
        .await
        .expect("sweep");
    assert_eq!(swept.p2p_backups, 2);
    assert_eq!(
        held(v.clone()).await,
        [4, 5, 6],
        "only time removes versions"
    );
    assert_eq!(held(w.clone()).await, [1, 2, 3], "the last 3 always stay");
    let again = crate::db::sweep_stale_at(&state.db, &state.limits, T0 + 400 * DAY)
        .await
        .expect("sweep");
    assert_eq!(again.p2p_backups, 0);
    done(state, path).await;
}

fn stored_at(version: i64, size: i64, at: i64) -> Stored {
    Stored { version, size, at }
}

#[test]
fn kept_versions_follow_the_reference() {
    let v: Vec<Stored> = (1..=6)
        .zip([0, DAY, 2 * DAY, 2 * DAY + 1, 2 * DAY + 2, 2 * DAY + 3])
        .map(|(n, at)| stored_at(n, 1, T0 + at))
        .collect();
    let numbers = |t: i64| kept(&v, t).iter().map(|s| s.version).collect::<Vec<_>>();
    assert_eq!(numbers(T0 + 2 * DAY + 3), [1, 2, 3, 4, 5, 6]);
    assert_eq!(numbers(T0 + 30 * DAY), [1, 2, 3, 4, 5, 6]);
    assert_eq!(
        numbers(T0 + 31 * DAY),
        [1, 2, 3, 4, 5, 6],
        "the first day is the newest older one"
    );
    assert_eq!(numbers(T0 + 32 * DAY), [2, 3, 4, 5, 6]);
    assert_eq!(numbers(T0 + 33 * DAY), [4, 5, 6]);
    assert_eq!(kept(&[], T0), []);
    let today: Vec<Stored> = (1..=10).map(|n| stored_at(n, 1, T0 + n)).collect();
    assert_eq!(
        kept(&today, T0 + 20)
            .iter()
            .map(|s| s.version)
            .collect::<Vec<_>>(),
        [1, 8, 9, 10],
        "a day keeps its first version and the last 3"
    );
}

/// Hourly honest uploads for 60 days under the default limits:
/// (MiB per version, refused uploads, first refused day, most
/// hours since the newest stored version, versions kept at the end, MiB kept).
#[test]
fn honest_hourly_uploads_stall_on_the_expected_days() {
    let limits = Limits::default();
    let total = limits.p2p_backup_total_bytes();
    let mut got = Vec::new();
    for mib in [2i64, 5, 7, 8, 10, 20, 40, 64] {
        let mut account: BTreeMap<String, Vec<Stored>> = BTreeMap::new();
        let (mut refused, mut first, mut stale, mut last_ok, mut latest) = (0, -1, 0, 0, 0);
        for h in 0..60 * 24 {
            let at = h * HOUR;
            let new = stored_at(latest + 1, mib << 20, at);
            match admit(&account, "V", new, at, total) {
                Some(next) => {
                    account = next;
                    last_ok = at;
                    latest += 1;
                }
                None => {
                    refused += 1;
                    if first < 0 {
                        first = at / DAY;
                    }
                }
            }
            stale = stale.max((at - last_ok) / HOUR);
        }
        let end = kept(&account["V"], 60 * 24 * HOUR);
        let kept_mib: i64 = end.iter().map(|s| s.size >> 20).sum();
        got.push((mib, refused, first, stale, end.len(), kept_mib));
    }
    assert_eq!(
        got,
        [
            (2, 0, -1, 0, 34, 68),
            (5, 0, -1, 0, 34, 170),
            (7, 0, -1, 0, 34, 238),
            (8, 657, 29, 69, 31, 248),
            (10, 843, 22, 237, 25, 250),
            (20, 1194, 9, 549, 12, 240),
            (40, 1356, 3, 693, 6, 240),
            (64, 1410, 1, 741, 4, 256),
        ]
    );
}

#[tokio::test]
async fn the_backup_routes_work_over_http() {
    use crate::config::{AppConfig, Roles};
    let (state, path) = temp_state("p2p_backup_http").await;
    let state = sized(Limits {
        p2p_backup_max_mib: 1,
        ..Limits::default()
    })(state);
    let config = AppConfig {
        roles: Roles {
            web: false,
            ..Roles::ALL
        },
        ..AppConfig::defaults()
    };
    let app = crate::server::build_router(None, None, &config, state.clone())
        .layer(crate::server::cors_layer());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    let server = tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await;
    });
    let base = format!("http://{addr}/api");
    let client = reqwest::Client::new();
    let read = |res: reqwest::Response| async move {
        serde_json::from_slice::<Value>(&res.bytes().await.expect("body")).expect("json")
    };
    let registered = read(
        client
            .post(format!("{base}/auth/register"))
            .header("content-type", "application/json")
            .body(
                json!({"username": "Alice", "password": "pw", "avatar_kind": "identicon"})
                    .to_string(),
            )
            .send()
            .await
            .expect("register"),
    )
    .await;
    let token = registered["token"].as_str().expect("token").to_string();
    let v = ik(1);
    let data: Vec<u8> = (0..=255u8).cycle().take(5000).collect();
    let res = client
        .put(format!("{base}/v1/me/p2p_backup/{v}?version=1"))
        .bearer_auth(&token)
        .header("content-type", "application/octet-stream")
        .body(data.clone())
        .send()
        .await
        .expect("put");
    assert_eq!(res.status(), StatusCode::OK);
    let entry = read(res).await;
    assert_eq!(
        (&entry["ik"], &entry["version"], &entry["size"]),
        (&json!(v), &json!(1), &json!(5000))
    );
    let res = client
        .get(format!("{base}/me/p2p_backup/{v}"))
        .bearer_auth(&token)
        .header("Origin", "https://other.example.org")
        .send()
        .await
        .expect("get");
    assert_eq!(res.status(), StatusCode::OK);
    for (name, value) in [
        ("content-type", "application/octet-stream"),
        ("cache-control", "no-store"),
        ("content-length", "5000"),
        ("x-backup-version", "1"),
        ("access-control-allow-origin", "https://other.example.org"),
    ] {
        assert_eq!(res.headers()[name], value, "{name}");
    }
    let exposed = res.headers()["access-control-expose-headers"]
        .to_str()
        .expect("ascii")
        .to_string();
    assert!(
        exposed.split(',').any(|h| h.trim() == "x-backup-version"),
        "another app reads the version: {exposed}"
    );
    assert_eq!(res.bytes().await.expect("bytes").to_vec(), data);
    for url in [
        format!("{base}/v1/me/p2p_backup"),
        format!("{base}/me/p2p_backup/{v}/versions"),
    ] {
        let res = client
            .get(&url)
            .bearer_auth(&token)
            .send()
            .await
            .expect("list");
        assert_eq!(res.status(), StatusCode::OK, "{url}");
        assert_eq!(read(res).await[0]["version"], 1, "{url}");
    }
    let res = client
        .get(format!("{base}/v1/me/p2p_backup/{v}/versions/1"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("version");
    assert_eq!(res.headers()["x-backup-version"], "1");
    assert_eq!(res.bytes().await.expect("bytes").to_vec(), data);
    for (version, body, status, error, latest) in [
        (
            "2",
            vec![0u8; MIB + 1],
            StatusCode::PAYLOAD_TOO_LARGE,
            json!({"error": "Backup too large", "reason": {"kind": "limit", "control": "p2p_backup_max_mib"}}),
            None,
        ),
        (
            "7",
            vec![0u8; 10],
            StatusCode::CONFLICT,
            json!({"error": "Backup version must be 2", "reason": {"kind": "conflict"}}),
            Some("1"),
        ),
    ] {
        let res = client
            .put(format!("{base}/v1/me/p2p_backup/{v}?version={version}"))
            .bearer_auth(&token)
            .header("Origin", "https://other.example.org")
            .body(body)
            .send()
            .await
            .expect("refused put");
        assert_eq!(res.status(), status);
        assert_eq!(
            res.headers()
                .get("x-backup-version")
                .map(|v| v.to_str().expect("ascii")),
            latest,
            "{version}"
        );
        assert_eq!(read(res).await, error);
    }
    let res = client
        .put(format!("{base}/v1/me/p2p_backup/{v}"))
        .bearer_auth(&token)
        .body(vec![1u8])
        .send()
        .await
        .expect("no version");
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    let res = client
        .get(format!("{base}/v1/me/p2p_backup/{v}"))
        .send()
        .await
        .expect("no token");
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    let res = client
        .delete(format!("{base}/v1/me/p2p_backup/{v}/versions/1"))
        .bearer_auth(&token)
        .header("content-type", "application/json")
        .body(json!({"reauth": {"password": "pw"}}).to_string())
        .send()
        .await
        .expect("delete");
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(read(res).await, json!({"ok": true}));
    let res = client
        .get(format!("{base}/v1/me/p2p_backup/{v}"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("gone");
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    let res = client
        .get(format!("{base}/instance"))
        .send()
        .await
        .expect("instance");
    let info = read(res).await;
    assert_eq!(
        (
            &info["features"]["p2p_backup"],
            &info["limits"]["p2p_backup_bytes"],
            &info["limits"]["p2p_backup_total_bytes"]
        ),
        (&json!(true), &json!(MIB), &json!(256 * MIB))
    );
    let mut limited = 0;
    for _ in 0..40 {
        let res = client
            .put(format!("{base}/v1/me/p2p_backup/{v}?version=1"))
            .body(vec![1u8])
            .send()
            .await
            .expect("put");
        if res.status() == StatusCode::TOO_MANY_REQUESTS {
            limited += 1;
        }
    }
    assert!(limited >= 1, "PUT is in the strict bucket");
    for _ in 0..3 {
        let res = client
            .get(format!("{base}/v1/me/p2p_backup"))
            .bearer_auth(&token)
            .send()
            .await
            .expect("list");
        assert_eq!(
            res.status(),
            StatusCode::OK,
            "GET is not in the strict bucket"
        );
    }
    server.abort();
    done(state, path).await;
}

#[test]
fn backup_refusals_carry_their_reason() {
    use crate::api::error::ReasonKind;
    let reason = |ApiError(_, _, reason): ApiError| reason.map(|r| (r.kind, r.control));
    let limit = |control: &str| Some((ReasonKind::Limit, Some(control.to_string())));
    assert_eq!(reason(too_large()), limit("p2p_backup_max_mib"));
    assert_eq!(reason(full()), limit("p2p_backup_total_mib"));
    assert_eq!(reason(too_many()), limit("p2p_backup_identities"));
    assert_eq!(reason(stale(3)), Some((ReasonKind::Conflict, None)));
    let busy = ApiError::rate("busy", Some(2));
    let ApiError(code, msg, kept) = sending(busy);
    assert_eq!(
        (code, msg.as_str(), kept.map(|r| (r.kind, r.retry_after))),
        (
            StatusCode::TOO_MANY_REQUESTS,
            "Too many backup transfers at once, try again in a moment",
            Some((ReasonKind::Rate, Some(2)))
        )
    );
}
