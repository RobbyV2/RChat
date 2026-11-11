use std::collections::BTreeSet;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::SigningKey;
use rchat_fed::keys::{
    Jwk, KeySet, endorse, endorsed, endorsed_keys, endorsed_within, hello_proof, hello_proof_ok,
    key_set, self_check, thumbprint,
};
use rchat_fed::limits::hello::ENDORSEMENTS_MAX;
use rchat_fed::limits::keys::JWKS_MAX;
use rchat_fed::pb::KeyEndorsement;

const O: &str = "https://b.example";

fn key(n: u8) -> SigningKey {
    SigningKey::from_bytes(&[n; 32])
}

fn x(n: u8) -> String {
    URL_SAFE_NO_PAD.encode(key(n).verifying_key().to_bytes())
}

fn kid(n: u8) -> String {
    thumbprint(&key(n).verifying_key().to_bytes())
}

fn jwk(n: u8) -> Jwk {
    Jwk { kid: None, x: x(n) }
}

fn statement(by: u8, new: u8, signed_at: i64, at: i64, origin: &str) -> KeyEndorsement {
    KeyEndorsement {
        new_kid: kid(new),
        at,
        by_kid: kid(by),
        sig: endorse(&key(by), &kid(new), signed_at, origin).to_vec(),
    }
}

fn keys_of(jwks: &[Jwk]) -> KeySet {
    key_set(jwks).unwrap()
}

fn backwards_chain(len: u8) -> (KeySet, KeySet, Vec<KeyEndorsement>) {
    let jwks: Vec<Jwk> = (1..=len + 1).map(jwk).collect();
    let ends = (1..=len)
        .rev()
        .map(|n| statement(n, n + 1, 10, 10, O))
        .collect();
    (keys_of(&[jwk(1)]), keys_of(&jwks), ends)
}

fn set(ns: &[u8]) -> BTreeSet<String> {
    ns.iter().map(|n| kid(*n)).collect()
}

#[test]
fn jwks_labels_are_ignored_keys_count_under_their_own_thumbprint() {
    let keys = keys_of(&[
        Jwk {
            kid: Some(kid(2)),
            x: x(1),
        },
        jwk(2),
    ]);
    assert_eq!(keys.keys().cloned().collect::<BTreeSet<_>>(), set(&[1, 2]));
    let swapped = keys_of(&[Jwk {
        kid: Some(kid(1)),
        x: x(9),
    }]);
    assert!(!swapped.contains_key(&kid(1)));
    assert!(swapped.contains_key(&kid(9)));
}

#[test]
fn a_jwk_that_is_no_ed25519_key_is_left_out() {
    let keys = keys_of(&[
        Jwk {
            kid: None,
            x: URL_SAFE_NO_PAD.encode([1u8; 31]),
        },
        Jwk {
            kid: None,
            x: "not base64!".to_string(),
        },
        jwk(3),
    ]);
    assert_eq!(keys.keys().cloned().collect::<BTreeSet<_>>(), set(&[3]));
}

#[test]
fn a_rotation_statement_by_a_remembered_key_admits_the_new_key_chains_too() {
    let remembered = keys_of(&[jwk(1)]);
    let served = keys_of(&[jwk(1), jwk(2), jwk(3)]);
    let ends = [statement(2, 3, 20, 20, O), statement(1, 2, 10, 10, O)];
    assert_eq!(endorsed_keys(&remembered, &served, &ends, O), set(&[2, 3]));
}

#[test]
fn a_statement_by_an_unknown_key_a_forged_one_or_for_a_key_not_served_admits_nothing() {
    let remembered = keys_of(&[jwk(1)]);
    let served = keys_of(&[jwk(1), jwk(2)]);
    assert!(endorsed_keys(&remembered, &served, &[statement(5, 2, 10, 10, O)], O).is_empty());
    assert!(endorsed_keys(&remembered, &served, &[statement(1, 2, 11, 10, O)], O).is_empty());
    assert!(
        endorsed_keys(
            &remembered,
            &keys_of(&[jwk(1)]),
            &[statement(1, 2, 10, 10, O)],
            O
        )
        .is_empty()
    );
    let mut short = statement(1, 2, 10, 10, O);
    short.sig.truncate(63);
    assert!(endorsed_keys(&remembered, &served, &[short], O).is_empty());
}

#[test]
fn an_endorsement_names_its_origin_another_host_cant_replay_it() {
    let remembered = keys_of(&[jwk(1)]);
    let served = keys_of(&[jwk(1), jwk(2)]);
    let ends = [statement(1, 2, 10, 10, "https://b.example")];
    assert_eq!(
        endorsed_keys(&remembered, &served, &ends, "https://b.example").len(),
        1
    );
    assert!(endorsed_keys(&remembered, &served, &ends, "https://evil.example").is_empty());
}

#[test]
fn a_hello_answer_proves_the_key_and_signs_the_answer_itself() {
    let jti = [4u8; 16];
    let answer = [1u8, 2, 3];
    let proof = hello_proof(&key(1), &jti, "https://a.example", &answer);
    let keys = keys_of(&[jwk(1)]);
    let public = &keys[&kid(1)];
    assert!(hello_proof_ok(
        public,
        &jti,
        "https://a.example",
        &answer,
        &proof
    ));
    assert!(!hello_proof_ok(
        public,
        &[0; 16],
        "https://a.example",
        &answer,
        &proof
    ));
    assert!(!hello_proof_ok(
        public,
        &jti,
        "https://c.example",
        &answer,
        &proof
    ));
    assert!(!hello_proof_ok(
        public,
        &jti,
        "https://a.example",
        &[1, 2, 4],
        &proof
    ));
    assert!(!hello_proof_ok(
        public,
        &jti,
        "https://a.example",
        &answer,
        &proof[..63]
    ));
}

#[test]
fn the_start_up_check_warns_when_no_configured_key_was_used_before() {
    let list = |kids: &[&str]| kids.iter().map(|k| k.to_string()).collect::<Vec<_>>();
    assert_eq!(self_check(&[], &list(&["k1"])), Ok(()));
    assert_eq!(
        self_check(&list(&["k1", "k2"]), &list(&["k2", "k3"])),
        Ok(())
    );
    assert_eq!(
        self_check(&list(&["k1"]), &list(&["k9"])),
        Err(
            "None of this instance's signing keys is one it used before. Other instances will ask their operators to trust this instance again."
        )
    );
}

#[test]
fn every_endorsement_is_checked_once_however_a_hello_orders_them() {
    let chain = 40u8;
    let remembered = keys_of(&[jwk(1)]);
    let mut jwks: Vec<Jwk> = (1..=chain + 1).map(jwk).collect();
    jwks.push(jwk(200));
    let served = keys_of(&jwks);
    let mut ends: Vec<KeyEndorsement> = (1..=chain)
        .rev()
        .map(|n| statement(n, n + 1, 10, 10, O))
        .collect();
    ends.extend((0..500).map(|at| statement(1, 200, 999, at, O)));
    let got = endorsed_within(&remembered, &served, &ends, O, ends.len());
    assert_eq!(got.kids, set(&(2..=chain + 1).collect::<Vec<_>>()));
    assert_eq!(got.checks, ends.len());
}

#[test]
fn a_hello_at_the_limit_costs_one_check_for_each_endorsement() {
    let max = ENDORSEMENTS_MAX as u8;
    let (remembered, served, ends) = backwards_chain(max);
    let got = endorsed(&remembered, &served, &ends, O);
    assert_eq!(got.checks, ENDORSEMENTS_MAX);
    assert_eq!(got.kids, set(&(2..=max + 1).collect::<Vec<_>>()));
    assert_eq!(endorsed_keys(&remembered, &served, &ends, O), got.kids);
}

#[test]
fn more_endorsements_than_a_hello_may_carry_admit_nothing_and_check_no_signature() {
    let (remembered, served, ends) = backwards_chain(ENDORSEMENTS_MAX as u8 + 1);
    let got = endorsed(&remembered, &served, &ends, O);
    assert_eq!((got.kids.len(), got.checks), (0, 0));
    let (remembered, served, ends) = backwards_chain(ENDORSEMENTS_MAX as u8);
    assert_eq!(
        endorsed(&remembered, &served, &ends, O).kids.len(),
        ENDORSEMENTS_MAX
    );
}

#[test]
fn a_second_statement_for_a_key_already_admitted_is_not_checked() {
    let remembered = keys_of(&[jwk(1)]);
    let served = keys_of(&[jwk(1), jwk(2), jwk(3)]);
    let ends = [
        statement(1, 2, 10, 10, O),
        statement(1, 2, 11, 11, O),
        statement(2, 3, 12, 12, O),
        statement(1, 3, 13, 13, O),
        statement(3, 1, 14, 14, O),
    ];
    let got = endorsed(&remembered, &served, &ends, O);
    assert_eq!(got.kids, set(&[2, 3]));
    assert!(got.checks <= 3, "{}", got.checks);
}

#[test]
fn a_jwks_with_more_keys_than_the_limit_is_refused_whole() {
    let jwks = |n: usize| (1..=n as u8).map(jwk).collect::<Vec<_>>();
    assert_eq!(JWKS_MAX, 64);
    assert_eq!(
        key_set(&jwks(JWKS_MAX)).map(|keys| keys.len()),
        Some(JWKS_MAX)
    );
    assert_eq!(key_set(&jwks(JWKS_MAX + 1)), None);
    assert_eq!(key_set(&[]).map(|keys| keys.len()), Some(0));
}
