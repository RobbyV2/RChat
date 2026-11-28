use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};

use super::*;
use crate::api::Settings;
use crate::api::auth::hash_password;
use crate::api::error::ReasonKind;
use crate::api::reauth::issue_nonce;
use crate::api::test_util::{
    PHRASE_KEY, done, mem_user, pg_done, pg_state, phrase_sign, temp_state,
};
use crate::db::{NewUser, get_user};
use crate::limits::Limits;
use crate::p2p_chain::tests::{
    AT, Vera, head_of, id, id_of, make_creation, make_recovery, make_reset, pair, vera,
};

const T0: i64 = 1_762_400_000;

type Refused = (StatusCode, String);

fn refusal(code: StatusCode, msg: &str) -> Refused {
    (code, msg.to_string())
}

fn invalid_record() -> Refused {
    refusal(StatusCode::BAD_REQUEST, BAD_RECORD)
}

fn lacks() -> Refused {
    refusal(
        StatusCode::CONFLICT,
        "The stored record holds records this one lacks",
    )
}

fn none() -> Refused {
    refusal(StatusCode::NOT_FOUND, "Not found")
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
    let hash = hash_password("pw").await.expect("hash");
    NewUser::plain(name)
        .hash(&hash)
        .at(1)
        .add_recoverable(&state.db, key, key.map(|_| 2))
        .await;
}

async fn session(state: &AppState, name: &str) -> Session {
    Session {
        user: get_user(&state.db, name)
            .await
            .expect("load")
            .expect("user"),
        token: format!("tok-{name}"),
        created_at: T0,
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

fn plain(res: Result<Json<IdentityRecord>, ApiError>) -> Result<IdentityRecord, Refused> {
    match res {
        Ok(Json(record)) => Ok(record),
        Err(ApiError(code, msg, _)) => Err((code, msg)),
    }
}

async fn put_body(
    state: &AppState,
    who: &str,
    ik: &str,
    body: Value,
    t: i64,
) -> Result<IdentityRecord, Refused> {
    let session = session(state, who).await;
    plain(put_at(state, session, ik, Body::from(body.to_string()), t).await)
}

async fn put(
    state: &AppState,
    who: &str,
    ik: &str,
    cr: &Value,
    chain: &[&Value],
    t: i64,
) -> Result<IdentityRecord, Refused> {
    put_body(state, who, ik, json!({"cr": cr, "chain": chain}), t).await
}

async fn put_with(
    state: &AppState,
    who: &str,
    ik: &str,
    cr: &Value,
    chain: &[&Value],
    reauth: Value,
    t: i64,
) -> Result<IdentityRecord, Refused> {
    let body = json!({"cr": cr, "chain": chain, "reauth": reauth});
    put_body(state, who, ik, body, t).await
}

async fn get(state: &AppState, who: &str, ik: &str) -> Result<IdentityRecord, Refused> {
    let user = Authed(mem_user(who, false));
    plain(get_identity(State(state.clone()), user, Path(ik.to_string())).await)
}

async fn listed(state: &AppState, who: &str) -> Result<Vec<String>, Refused> {
    match list_identities(State(state.clone()), Authed(mem_user(who, false))).await {
        Ok(Json(list)) => Ok(list.into_iter().map(|r| r.ik).collect()),
        Err(ApiError(code, msg, _)) => Err((code, msg)),
    }
}

async fn delete(
    state: &AppState,
    who: &str,
    ik: &str,
    reauth: Value,
    t: i64,
) -> Result<(), Refused> {
    let req: IdentityDelete = serde_json::from_value(json!({ "reauth": reauth })).expect("body");
    let session = session(state, who).await;
    match delete_at(state, session, ik, req, t).await {
        Ok(_) => Ok(()),
        Err(ApiError(code, msg, _)) => Err((code, msg)),
    }
}

fn pw() -> Value {
    json!({"password": "pw"})
}

fn held(record: &IdentityRecord) -> (&Value, Vec<&Value>) {
    (&record.cr, record.chain.iter().collect())
}

async fn rows(state: &AppState, who: &str) -> i64 {
    sqlx::query("SELECT COUNT(*) FROM p2p_identities WHERE username = $1")
        .bind(who)
        .fetch_one(&state.db)
        .await
        .expect("count")
        .try_get(0)
        .expect("n")
}

#[tokio::test]
async fn identity_record() {
    each_db("p2p_identity_record", |state| async move {
        add_user(&state, "alice", None).await;
        let Vera {
            ik,
            rk,
            cr,
            r1,
            reset2,
            ..
        } = vera();
        assert_eq!(listed(&state, "alice").await, Ok(vec![]));
        assert_eq!(get(&state, "alice", &ik).await, Err(none()));
        assert_eq!(
            delete(&state, "alice", &ik, pw(), T0).await,
            Err(none()),
            "nothing stored"
        );

        let first = put(&state, "alice", &ik, &cr, &[], T0 + 10)
            .await
            .expect("the creation record");
        let expect = IdentityRecord {
            ik: ik.clone(),
            cr: cr.clone(),
            chain: vec![],
            updated_at: T0 + 10,
        };
        assert_eq!(first, expect);
        assert_eq!(get(&state, "alice", &ik).await, Ok(expect));

        let after = put(&state, "alice", &ik, &cr, &[&reset2, &r1], T0 + 20)
            .await
            .expect("after the recovery");
        assert_eq!(held(&after), (&cr, vec![&r1, &reset2]), "in order of n");
        assert_eq!(after.updated_at, T0 + 20);
        assert_eq!(get(&state, "alice", &ik).await.as_ref(), Ok(&after));
        assert_eq!(listed(&state, "alice").await, Ok(vec![ik.clone()]));
        let after = put(&state, "alice", &ik, &cr, &[&r1, &reset2, &r1], T0 + 21)
            .await
            .expect("the same again");
        assert_eq!(held(&after), (&cr, vec![&r1, &reset2]), "each record once");

        let forged = make_recovery(
            &ik,
            &pair("thief rk"),
            &head_of(&reset2),
            &id("pk3"),
            &[],
            AT,
        );
        let old_key = make_recovery(&ik, &rk, &head_of(&reset2), &id("pk3"), &[], AT);
        for bad in [&forged, &old_key] {
            assert_eq!(
                put(&state, "alice", &ik, &cr, &[&r1, &reset2, bad], T0 + 22).await,
                Err(invalid_record())
            );
        }
        assert_eq!(get(&state, "alice", &ik).await.as_ref(), Ok(&after));

        delete(&state, "alice", &ik, pw(), T0 + 30)
            .await
            .expect("both off");
        assert_eq!(get(&state, "alice", &ik).await, Err(none()));
        assert_eq!(listed(&state, "alice").await, Ok(vec![]));
        assert_eq!(rows(&state, "alice").await, 0);
    })
    .await;
}

// A stolen session: it can't delete the record, drop a record of it or put another creation
// record in its place (mutant ct-record-truncate: a PUT without re-auth replaces the record).
#[tokio::test]
async fn identity_record_delete() {
    each_db("p2p_identity_delete", |state| async move {
        add_user(&state, "alice", None).await;
        let Vera {
            ik,
            rk,
            cr,
            r1,
            reset2,
            ..
        } = vera();
        let full = put(&state, "alice", &ik, &cr, &[&r1, &reset2], T0)
            .await
            .expect("put");
        let other_cr = make_creation(&pair("ik"), &pair("thief rk"), &id("pkz"), AT);
        let sibling = make_recovery(&ik, &rk, &head_of(&cr), &id("pkb"), &[], AT + 1);
        let mut t = T0 + 10;
        for (cr2, chain, why) in [
            (&cr, vec![&r1], "drops the last record"),
            (&cr, vec![], "drops every record"),
            (&cr, vec![&sibling], "another line"),
            (&other_cr, vec![], "another creation record"),
        ] {
            assert_eq!(
                put(&state, "alice", &ik, cr2, &chain, t).await,
                Err(lacks()),
                "{why}"
            );
            for (reauth, msg) in [
                (json!({"fresh_session": true}), "Confirm with your password"),
                (json!({"password": "guess"}), "Wrong password"),
            ] {
                t += 3;
                assert_eq!(
                    put_with(&state, "alice", &ik, cr2, &chain, reauth, t).await,
                    Err(refusal(StatusCode::UNAUTHORIZED, msg)),
                    "{why}"
                );
            }
            t += 3;
        }
        for (reauth, msg) in [
            (json!({"fresh_session": true}), "Confirm with your password"),
            (json!({"password": "guess"}), "Wrong password"),
        ] {
            assert_eq!(
                delete(&state, "alice", &ik, reauth, t).await,
                Err(refusal(StatusCode::UNAUTHORIZED, msg))
            );
            t += 3;
        }
        assert_eq!(get(&state, "alice", &ik).await.as_ref(), Ok(&full));

        let cut = put_with(&state, "alice", &ik, &cr, &[&r1], pw(), t)
            .await
            .expect("with re-auth a record is dropped");
        assert_eq!(held(&cut), (&cr, vec![&r1]));
        t += 3;
        let swapped = put_with(&state, "alice", &ik, &other_cr, &[], pw(), t)
            .await
            .expect("with re-auth another creation record");
        assert_eq!(held(&swapped), (&other_cr, vec![]));
        assert_eq!(get(&state, "alice", &ik).await.as_ref(), Ok(&swapped));
        t += 3;
        assert_eq!(
            put_with(
                &state,
                "alice",
                &ik,
                &cr,
                &[],
                json!({"password": "pw", "fresh_session": true}),
                t
            )
            .await
            .map_err(|(code, _)| code),
            Err(StatusCode::BAD_REQUEST),
            "two ways to confirm"
        );
        t += 3;
        delete(&state, "alice", &ik, pw(), t)
            .await
            .expect("with re-auth");
        assert_eq!(rows(&state, "alice").await, 0);
    })
    .await;
}

#[tokio::test]
async fn an_append_needs_no_reauth() {
    let (state, path) = temp_state("p2p_identity_append").await;
    add_user(&state, "alice", None).await;
    let Vera {
        ik,
        rk,
        cr,
        r1,
        reset2,
        ..
    } = vera();
    let sibling = make_recovery(&ik, &rk, &head_of(&cr), &id("pkb"), &[], AT + 1);
    put(&state, "alice", &ik, &cr, &[], T0).await.expect("cr");
    put(&state, "alice", &ik, &cr, &[&r1], T0 + 1)
        .await
        .expect("a record");
    let both = put(&state, "alice", &ik, &cr, &[&r1, &sibling], T0 + 2)
        .await
        .expect("a sibling");
    assert_eq!(both.chain.len(), 2);
    let all = put(&state, "alice", &ik, &cr, &[&reset2, &sibling, &r1], T0 + 3)
        .await
        .expect("the reset");
    assert_eq!(all.chain.len(), 3);
    assert_eq!(all.chain[2], reset2);
    assert_eq!(
        put(&state, "alice", &ik, &cr, &[&r1, &reset2], T0 + 4).await,
        Err(lacks()),
        "the dead sibling stays"
    );
    assert_eq!(get(&state, "alice", &ik).await, Ok(all));
    done(state, path).await;
}

#[tokio::test]
async fn crafted_records_are_refused() {
    let (state, path) = temp_state("p2p_identity_crafted").await;
    add_user(&state, "alice", None).await;
    let Vera {
        ik,
        rk,
        cr,
        r1,
        reset2,
        ..
    } = vera();
    let without = |record: &Value, field: &str| {
        let mut record = record.clone();
        record.as_object_mut().expect("record").remove(field);
        record
    };
    let noted = |record: &Value| {
        let mut record = record.clone();
        record["note"] = json!(1);
        record
    };
    let pk_is_ik = make_creation(&pair("ik"), &rk, &ik, AT);
    let other = make_creation(&pair("other ik"), &pair("other rk"), &id("other pk"), AT);
    let mut swapped = cr.clone();
    (swapped["sig_ik"], swapped["sig_rk"]) = (cr["sig_rk"].clone(), cr["sig_ik"].clone());
    for (bad, why) in [
        (without(&cr, "sig_rk"), "no sig_rk"),
        (without(&cr, "sig_ik"), "no sig_ik"),
        (pk_is_ik, "pk = ik"),
        (noted(&cr), "an unknown field"),
        (other.clone(), "another identity's"),
        (swapped, "swapped signatures"),
        (json!("cr"), "a string"),
        (json!(null), "null"),
    ] {
        assert_eq!(
            put(&state, "alice", &ik, &bad, &[], T0).await,
            Err(invalid_record()),
            "{why}"
        );
    }
    let after_reset = make_recovery(&ik, &rk, &head_of(&reset2), &id("pk3"), &[], AT);
    let wrong_prev = make_recovery(&ik, &rk, &head_of(&other), &id("pk1"), &[], AT);
    let rk2 = pair("rk2");
    let self_next = without(&reset2, "sig_next");
    let mut chain = vec![];
    let mut prev = head_of(&cr);
    for n in 1..=9 {
        let r = make_recovery(&ik, &rk, &prev, &id(&format!("pk{n}")), &[], AT);
        prev = head_of(&r);
        chain.push(r);
    }
    let nine: Vec<&Value> = chain.iter().collect();
    let thief_reset = make_reset(
        &ik,
        &pair("thief rk"),
        &rk2,
        &head_of(&cr),
        &id("pkz"),
        &[],
        AT,
    );
    for (bad, why) in [
        (
            vec![&r1, &reset2, &after_reset],
            "the old key after a reset",
        ),
        (vec![&wrong_prev], "prev"),
        (vec![&noted(&r1)], "an unknown field"),
        (vec![&reset2], "a record without its parent"),
        (vec![&r1, &self_next], "a reset without sig_next"),
        (vec![&thief_reset], "a reset by another key"),
        (nine.clone(), "a ninth record"),
        (vec![&json!(1)], "a number"),
    ] {
        assert_eq!(
            put(&state, "alice", &ik, &cr, &bad, T0).await,
            Err(invalid_record()),
            "{why}"
        );
    }
    put(&state, "alice", &ik, &cr, &nine[..8], T0)
        .await
        .expect("eight records");
    for (body, why) in [
        (json!({"cr": cr}), "no chain"),
        (json!({"chain": []}), "no cr"),
        (json!([]), "an array"),
        (json!({"cr": cr, "chain": {}}), "chain not a list"),
        (
            json!({"cr": cr, "chain": [], "reauth": "pw"}),
            "reauth not an object",
        ),
    ] {
        assert_eq!(
            put_body(&state, "alice", &ik, body, T0).await,
            Err(invalid_record()),
            "{why}"
        );
    }
    let session = session(&state, "alice").await;
    assert_eq!(
        plain(put_at(&state, session, &ik, Body::from("{"), T0).await),
        Err(invalid_record())
    );
    for bad_ik in ["short", &format!("{ik}="), &id("ik").to_lowercase()] {
        let bad = refusal(StatusCode::BAD_REQUEST, BAD_IK);
        assert_eq!(
            put(&state, "alice", bad_ik, &cr, &[], T0).await,
            Err(bad.clone())
        );
        assert_eq!(get(&state, "alice", bad_ik).await, Err(bad.clone()));
        assert_eq!(delete(&state, "alice", bad_ik, pw(), T0).await, Err(bad));
    }
    assert_eq!(
        put(&state, "alice", &id("other ik"), &cr, &[], T0).await,
        Err(invalid_record()),
        "the path names another identity"
    );
    assert_eq!(rows(&state, "alice").await, 1);
    done(state, path).await;
}

#[tokio::test]
async fn a_body_over_16_kib_is_refused() {
    let (state, path) = temp_state("p2p_identity_size").await;
    add_user(&state, "alice", None).await;
    let Vera { ik, cr, r1, .. } = vera();
    let too_large = refusal(StatusCode::PAYLOAD_TOO_LARGE, "Identity record too large");
    let text = json!({"cr": cr, "chain": [r1]}).to_string();
    let padded = |len: usize| format!("{text}{}", " ".repeat(len - text.len()));
    let session_of = || session(&state, "alice");
    let big = Body::from(padded(RECORD_BYTES + 1));
    assert_eq!(
        plain(put_at(&state, session_of().await, &ik, big, T0).await),
        Err(too_large.clone())
    );
    let junk: Vec<Value> = (0..60)
        .map(|i| {
            let mut copy = r1.clone();
            copy["at"] = json!(i);
            copy
        })
        .collect();
    let many: Vec<&Value> = junk.iter().collect();
    assert_eq!(
        put(&state, "alice", &ik, &cr, &many, T0).await,
        Err(too_large),
        "refused before a signature is checked"
    );
    assert_eq!(rows(&state, "alice").await, 0);
    let most = Body::from(padded(RECORD_BYTES));
    plain(put_at(&state, session_of().await, &ik, most, T0).await).expect("16 KiB");
    done(state, path).await;
}

#[test]
fn refusals_carry_their_reason() {
    let reason = |ApiError(_, _, reason): ApiError| {
        let reason = reason.expect("a reason");
        (reason.kind, reason.control.or(reason.field))
    };
    let named = |kind: ReasonKind, name: &str| (kind, Some(name.to_string()));
    assert_eq!(
        reason(too_large()),
        named(ReasonKind::Limit, "p2p_identity_record_bytes")
    );
    assert_eq!(
        reason(too_many()),
        named(ReasonKind::Limit, "p2p_identity_records")
    );
    assert_eq!(reason(not_an_append()), (ReasonKind::Conflict, None));
    assert_eq!(
        reason(invalid("chain")),
        named(ReasonKind::Invalid, "chain")
    );
    assert_eq!(
        reason(check_ik("x").expect_err("bad ik")),
        named(ReasonKind::Invalid, "ik")
    );
}

#[tokio::test]
async fn a_record_is_only_its_owners() {
    let (state, path) = temp_state("p2p_identity_owner").await;
    add_user(&state, "alice", None).await;
    add_user(&state, "bob", None).await;
    let Vera { ik, cr, r1, .. } = vera();
    put(&state, "alice", &ik, &cr, &[&r1], T0)
        .await
        .expect("put");
    assert_eq!(get(&state, "bob", &ik).await, Err(none()));
    assert_eq!(listed(&state, "bob").await, Ok(vec![]));
    assert_eq!(delete(&state, "bob", &ik, pw(), T0).await, Err(none()));
    assert_eq!(
        get(&state, "bob", &id("pk0")).await,
        Err(none()),
        "a missing one answers the same"
    );
    let bobs = put(&state, "bob", &ik, &cr, &[], T0 + 5)
        .await
        .expect("bob's own copy is a first PUT");
    assert_eq!(bobs.chain.len(), 0);
    assert_eq!(
        get(&state, "alice", &ik).await.map(|r| r.chain.len()),
        Ok(1)
    );
    delete(&state, "bob", &ik, pw(), T0 + 6)
        .await
        .expect("bob's");
    assert_eq!(rows(&state, "alice").await, 1);
    done(state, path).await;
}

#[tokio::test]
async fn confirming_takes_the_password_or_a_phrase_signed_for_that_ik() {
    let (state, path) = temp_state("p2p_identity_reauth").await;
    add_user(&state, "alice", Some(PHRASE_KEY)).await;
    let Vera { ik, cr, r1, .. } = vera();
    let other = id("other ik");
    put(&state, "alice", &ik, &cr, &[&r1], T0)
        .await
        .expect("put");
    let mut t = T0 + 100;
    let wrong = refusal(StatusCode::UNAUTHORIZED, "Wrong backup phrase");
    for (kind, context) in [
        ("p2p-data", other.as_str()),
        ("remove", ik.as_str()),
        ("p2p-data", ""),
    ] {
        for delete_it in [true, false] {
            let nonce = issue_nonce(&state.db, "alice", t).await.expect("nonce");
            let sig = phrase_sign(kind, "alice", &nonce, context);
            let proof = json!({"phrase": {"nonce": nonce, "sig": sig}});
            let res = match delete_it {
                true => delete(&state, "alice", &ik, proof, t).await,
                false => put_with(&state, "alice", &ik, &cr, &[], proof, t)
                    .await
                    .map(|_| ()),
            };
            assert_eq!(res, Err(wrong.clone()), "{kind} {context}");
            t += 3;
        }
    }
    assert_eq!(
        get(&state, "alice", &ik).await.map(|r| r.chain.len()),
        Ok(1)
    );
    let proof = |nonce: String| {
        let sig = phrase_sign("p2p-data", "alice", &nonce, &ik);
        json!({"phrase": {"nonce": nonce, "sig": sig}})
    };
    let nonce = issue_nonce(&state.db, "alice", t).await.expect("nonce");
    put_with(&state, "alice", &ik, &cr, &[], proof(nonce.clone()), t)
        .await
        .expect("a phrase signed for this ik replaces");
    t += 3;
    assert_eq!(
        delete(&state, "alice", &ik, proof(nonce), t).await,
        Err(wrong),
        "a nonce works once"
    );
    t += 3;
    let nonce = issue_nonce(&state.db, "alice", t).await.expect("nonce");
    delete(&state, "alice", &ik, proof(nonce), t)
        .await
        .expect("a phrase signed for this ik deletes");
    assert_eq!(rows(&state, "alice").await, 0);
    done(state, path).await;
}

#[tokio::test]
async fn deleting_the_account_removes_its_records() {
    let (state, path) = temp_state("p2p_identity_purge").await;
    add_user(&state, "alice", None).await;
    add_user(&state, "bob", None).await;
    let Vera { ik, cr, r1, .. } = vera();
    for who in ["alice", "bob"] {
        put(&state, who, &ik, &cr, &[&r1], T0).await.expect("put");
    }
    let gone = session(&state, "alice").await;
    sqlx::query("UPDATE users SET password_hash = $1 WHERE username = 'alice'")
        .bind(crate::db::PURGING_HASH)
        .execute(&state.db)
        .await
        .expect("purging");
    let body = Body::from(json!({"cr": cr, "chain": [r1]}).to_string());
    assert_eq!(
        plain(put_at(&state, gone, &ik, body, T0 + 1).await),
        Err(none()),
        "an account being deleted stores nothing"
    );
    crate::api::admin::finish_purge(&state, crate::api::admin::PurgeKind::User, "alice")
        .await
        .expect("purge");
    assert_eq!(
        (rows(&state, "alice").await, rows(&state, "bob").await),
        (0, 1)
    );
    add_user(&state, "alice", None).await;
    assert_eq!(listed(&state, "alice").await, Ok(vec![]));
    assert_eq!(get(&state, "alice", &ik).await, Err(none()));
    done(state, path).await;
}

#[tokio::test]
async fn a_put_is_a_rare_request_and_a_wrong_password_costs_none() {
    let (state, path) = temp_state("p2p_identity_rare").await;
    let limits = Limits {
        rare_requests_per_hour: 2,
        rare_requests_per_day: 0,
        ..(*state.limits).clone()
    };
    let state = state.with_limits(Arc::new(limits));
    add_user(&state, "alice", None).await;
    add_user(&state, "bob", None).await;
    let Vera { ik, cr, r1, .. } = vera();
    let send = |who: &'static str, body: Value| {
        let state = state.clone();
        let ik = ik.clone();
        async move {
            let session = AuthedSession(session(&state, who).await);
            let body = Body::from(body.to_string());
            plain(put_identity(State(state), session, Path(ik), body).await)
        }
    };
    let record = json!({"cr": cr, "chain": [r1]});
    send("alice", record.clone()).await.expect("first");
    let wrong = json!({"cr": cr, "chain": [r1], "reauth": {"password": "nope"}});
    assert_eq!(
        send("alice", wrong).await,
        Err(refusal(StatusCode::UNAUTHORIZED, "Wrong password"))
    );
    send("alice", record.clone()).await.expect("second");
    let too_often = refusal(StatusCode::TOO_MANY_REQUESTS, crate::api::rare::TOO_OFTEN);
    assert_eq!(send("alice", record.clone()).await, Err(too_often.clone()));
    assert_eq!(
        send("alice", json!({})).await,
        Err(too_often),
        "refused before the body is read"
    );
    send("bob", record.clone())
        .await
        .expect("an account of its own");
    crate::api::rare::tests::pass(&state, Duration::from_secs(3600));
    send("alice", record).await.expect("the next hour");
    done(state, path).await;
}

#[tokio::test]
async fn an_account_keeps_records_of_at_most_8_identities() {
    let (state, path) = temp_state("p2p_identity_many").await;
    add_user(&state, "alice", None).await;
    let made = |n: usize| {
        let ik = pair(&format!("ik {n}"));
        (id_of(&ik), make_creation(&ik, &pair("rk"), &id("pk0"), AT))
    };
    for n in 0..RECORD_IDENTITIES {
        let (ik, cr) = made(n);
        put(&state, "alice", &ik, &cr, &[], T0 + n as i64)
            .await
            .expect("put");
    }
    let (ninth, cr9) = made(8);
    assert_eq!(
        put(&state, "alice", &ninth, &cr9, &[], T0 + 9).await,
        Err(refusal(
            StatusCode::CONFLICT,
            "Too many P2P identity records"
        ))
    );
    let (first, cr1) = made(0);
    put(&state, "alice", &first, &cr1, &[], T0 + 10)
        .await
        .expect("one it holds");
    let listed = listed(&state, "alice").await.expect("list");
    assert_eq!(listed.len(), RECORD_IDENTITIES);
    assert_eq!(listed[0], first, "newest first");
    delete(&state, "alice", &first, pw(), T0 + 11)
        .await
        .expect("delete");
    put(&state, "alice", &ninth, &cr9, &[], T0 + 12)
        .await
        .expect("room again");
    done(state, path).await;
}

#[tokio::test]
async fn the_switches() {
    let (state, path) = temp_state("p2p_identity_switches").await;
    add_user(&state, "alice", None).await;
    let Vera { ik, cr, r1, .. } = vera();
    put(&state, "alice", &ik, &cr, &[], T0).await.expect("put");
    let no_backups = state.clone().with_limits(Arc::new(Limits {
        p2p_backup_max_mib: 0,
        ..Limits::default()
    }));
    put(&no_backups, "alice", &ik, &cr, &[&r1], T0 + 1)
        .await
        .expect("the badge route is on");
    for switch in ["p2p_backup", "p2p"] {
        set_switch(&state, switch, false).await;
        assert_eq!(
            get(&state, "alice", &ik).await.map(|r| r.chain.len()),
            Ok(1),
            "{switch}"
        );
        assert_eq!(listed(&state, "alice").await, Ok(vec![ik.clone()]));
        put(&state, "alice", &ik, &cr, &[&r1], T0 + 2)
            .await
            .expect("backups are kept");
    }
    assert_eq!(listed(&no_backups, "alice").await, Err(none()));
    assert_eq!(get(&no_backups, "alice", &ik).await, Err(none()));
    assert_eq!(get(&no_backups, "alice", "short").await, Err(none()));
    assert_eq!(
        put(&no_backups, "alice", &ik, &cr, &[&r1], T0 + 3).await,
        Err(none())
    );
    assert_eq!(
        delete(&no_backups, "alice", &ik, pw(), T0 + 4).await,
        Err(none())
    );
    let ApiError(code, _, reason) = on(&no_backups, &mem_user("alice", false))
        .await
        .expect_err("off");
    assert_eq!(
        (code, reason.map(|r| (r.kind, r.control))),
        (
            StatusCode::NOT_FOUND,
            Some((ReasonKind::OffSite, Some("p2p".to_string())))
        )
    );
    assert_eq!(rows(&state, "alice").await, 1);
    set_switch(&state, "p2p", true).await;
    delete(&no_backups, "alice", &ik, pw(), T0 + 5)
        .await
        .expect("on again");
    done(state, path).await;
}

// Two devices append at once: both succeed, or the loser is told and sends again with what it
// lacked. Nothing stored is ever lost.
#[tokio::test]
async fn two_appends_at_once() {
    each_db("p2p_identity_race", |state| async move {
        add_user(&state, "alice", None).await;
        let Vera { ik, rk, cr, r1, .. } = vera();
        put(&state, "alice", &ik, &cr, &[&r1], T0)
            .await
            .expect("put");
        let head = head_of(&r1);
        for round in 0..4u64 {
            let a = make_recovery(&ik, &rk, &head, &id(&format!("pka{round}")), &[], AT);
            let b = make_recovery(&ik, &rk, &head, &id(&format!("pkb{round}")), &[], AT);
            let before = get(&state, "alice", &ik).await.expect("stored").chain;
            let with = |new: &Value| {
                let mut chain = before.clone();
                chain.push(new.clone());
                json!({"cr": cr, "chain": chain})
            };
            let t = T0 + 10 + round as i64;
            let (first, second) = tokio::join!(
                put_body(&state, "alice", &ik, with(&a), t),
                put_body(&state, "alice", &ik, with(&b), t)
            );
            let after = get(&state, "alice", &ik).await.expect("stored").chain;
            assert!(before.iter().all(|r| after.contains(r)), "round {round}");
            let stored = |r: &Value| after.contains(r);
            match (first, second) {
                (Ok(_), Err(e)) => assert_eq!((e, stored(&a), stored(&b)), (lacks(), true, false)),
                (Err(e), Ok(_)) => assert_eq!((e, stored(&a), stored(&b)), (lacks(), false, true)),
                (first, second) => panic!("round {round}: {first:?} {second:?}"),
            }
            let mut merged = after.clone();
            merged.extend([a.clone(), b.clone()]);
            let all = put_body(
                &state,
                "alice",
                &ik,
                json!({"cr": cr, "chain": merged}),
                t + 1,
            )
            .await
            .expect("the loser sends again");
            assert_eq!(all.chain.len(), before.len() + 2, "round {round}");
        }
        let same = json!({"cr": cr, "chain": [r1]});
        let again = || put_body(&state, "alice", &ik, same.clone(), T0 + 50);
        let (first, second) = tokio::join!(again(), again());
        assert_eq!(
            (first.is_ok(), second.is_ok()),
            (false, false),
            "a shorter record"
        );
        let whole = get(&state, "alice", &ik).await.expect("stored");
        let same = json!({"cr": cr, "chain": whole.chain});
        let again = || put_body(&state, "alice", &ik, same.clone(), T0 + 51);
        let (first, second) = tokio::join!(again(), again());
        assert!(first.is_ok() && second.is_ok(), "the same record twice");
    })
    .await;
}

#[tokio::test]
async fn the_identity_routes_work_over_http() {
    use crate::config::{AppConfig, Roles};
    use utoipa::OpenApi;
    let (state, path) = temp_state("p2p_identity_http").await;
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
    let base = format!("http://{addr}/api/v1");
    let client = reqwest::Client::new();
    let read = |res: reqwest::Response| async move {
        serde_json::from_slice::<Value>(&res.bytes().await.expect("body")).expect("json")
    };
    let mut tokens = vec![];
    for name in ["Alice", "Bob"] {
        let registered = read(
            client
                .post(format!("{base}/auth/register"))
                .header("content-type", "application/json")
                .body(
                    json!({"username": name, "password": "pw", "avatar_kind": "identicon"})
                        .to_string(),
                )
                .send()
                .await
                .expect("register"),
        )
        .await;
        tokens.push(registered["token"].as_str().expect("token").to_string());
    }
    let (alice, bob) = (&tokens[0], &tokens[1]);
    let Vera { ik, cr, r1, .. } = vera();
    let url = format!("{base}/me/p2p_identity/{ik}");
    let send = |req: reqwest::RequestBuilder, token: &str, body: Value| {
        req.bearer_auth(token)
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
    };
    let record = json!({"cr": cr, "chain": [r1]});

    let res = client.get(&url).send().await.expect("get");
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    let res = client
        .put(&url)
        .body(record.to_string())
        .send()
        .await
        .expect("put");
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

    let res = send(client.put(&url), alice, record.clone())
        .await
        .expect("put");
    assert_eq!(res.status(), StatusCode::OK);
    let stored = read(res).await;
    assert_eq!(
        (&stored["ik"], &stored["cr"], &stored["chain"]),
        (&json!(ik), &cr, &json!([r1]))
    );
    let res = client
        .get(&url)
        .bearer_auth(alice)
        .send()
        .await
        .expect("get");
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(read(res).await, stored);
    let res = client
        .get(format!("{base}/me/p2p_identity"))
        .bearer_auth(alice)
        .send()
        .await
        .expect("list");
    assert_eq!(read(res).await, json!([stored]));

    for (method, token) in [("get", bob), ("delete", bob)] {
        let req = match method {
            "get" => client.get(&url),
            _ => client.delete(&url),
        };
        let res = send(req, token, json!({"reauth": {"password": "pw"}}))
            .await
            .expect("bob");
        assert_eq!(res.status(), StatusCode::NOT_FOUND, "{method}");
        assert_eq!(read(res).await, json!({"error": "Not found"}), "{method}");
    }
    let res = client
        .get(format!("{base}/me/p2p_identity"))
        .bearer_auth(bob)
        .send()
        .await
        .expect("list");
    assert_eq!(read(res).await, json!([]));

    let res = send(client.put(&url), alice, json!({"cr": cr, "chain": []}))
        .await
        .expect("put");
    assert_eq!(res.status(), StatusCode::CONFLICT);
    assert_eq!(
        read(res).await,
        json!({"error": "The stored record holds records this one lacks", "reason": {"kind": "conflict"}})
    );
    let mut forged = r1.clone();
    forged["at"] = json!(5);
    let res = send(
        client.put(&url),
        alice,
        json!({"cr": cr, "chain": [r1, forged]}),
    )
    .await
    .expect("put");
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        read(res).await,
        json!({"error": "That isn't a valid P2P identity record", "reason": {"kind": "invalid", "field": "chain"}})
    );
    let res = client
        .put(&url)
        .bearer_auth(alice)
        .body(vec![b' '; RECORD_BYTES + 1])
        .send()
        .await
        .expect("put");
    assert_eq!(res.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(
        read(res).await,
        json!({"error": "Identity record too large", "reason": {"kind": "limit", "control": "p2p_identity_record_bytes"}})
    );
    let res = client
        .put(format!("{base}/me/p2p_identity/nokey"))
        .bearer_auth(alice)
        .body(record.to_string())
        .send()
        .await
        .expect("put");
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        read(res).await,
        json!({"error": "ik must be a base64url Ed25519 public key", "reason": {"kind": "invalid", "field": "ik"}})
    );

    let res = send(
        client.delete(&url),
        alice,
        json!({"reauth": {"fresh_session": true}}),
    )
    .await
    .expect("delete");
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(read(res).await["error"], "Confirm with your password");
    crate::api::test_util::skip(std::time::Duration::from_secs(3)).await;
    let res = send(
        client.delete(&url),
        alice,
        json!({"reauth": {"password": "pw"}}),
    )
    .await
    .expect("delete");
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(read(res).await, json!({"ok": true}));
    let res = client
        .get(&url)
        .bearer_auth(alice)
        .send()
        .await
        .expect("get");
    assert_eq!(res.status(), StatusCode::NOT_FOUND);

    let docs = crate::api::openapi::ApiDoc::openapi();
    let docs = serde_json::to_value(&docs).expect("docs");
    for (path, methods) in [
        ("/api/v1/me/p2p_identity", vec!["get"]),
        ("/api/v1/me/p2p_identity/{ik}", vec!["get", "put", "delete"]),
    ] {
        for method in methods {
            assert!(
                docs["paths"][path][method].is_object(),
                "{method} {path} is documented"
            );
        }
    }
    server.abort();
    done(state, path).await;
}
