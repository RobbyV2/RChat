use std::collections::{BTreeMap, BTreeSet};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use sha2::{Digest, Sha256};

use crate::limits::hello::ENDORSEMENTS_MAX;
use crate::limits::keys::JWKS_MAX;
use crate::pb::KeyEndorsement;

pub const ROTATE_TAG: &[u8] = b"rchat-fed-rotate1\0";
pub const HELLO_TAG: &[u8] = b"rchat-fed-hello1\0";
pub const SELF_CHECK_NOTICE: &str = "None of this instance's signing keys is one it used before. Other instances will ask their operators to trust this instance again.";

pub type KeySet = BTreeMap<String, VerifyingKey>;

pub fn thumbprint(raw: &[u8; 32]) -> String {
    let x = URL_SAFE_NO_PAD.encode(raw);
    let canonical = format!(r#"{{"crv":"Ed25519","kty":"OKP","x":"{x}"}}"#);
    URL_SAFE_NO_PAD.encode(Sha256::digest(canonical.as_bytes()))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Jwk {
    pub kid: Option<String>,
    pub x: String,
}

pub fn key_set(jwks: &[Jwk]) -> Option<KeySet> {
    if jwks.len() > JWKS_MAX {
        return None;
    }
    let keys = jwks.iter().filter_map(|Jwk { kid: _, x }| {
        let raw: [u8; 32] = URL_SAFE_NO_PAD.decode(x).ok()?.try_into().ok()?;
        let key = VerifyingKey::from_bytes(&raw).ok()?;
        Some((thumbprint(&raw), key))
    });
    Some(keys.collect())
}

pub fn verified(key: &VerifyingKey, message: &[u8], sig: &[u8]) -> bool {
    <[u8; 64]>::try_from(sig).is_ok_and(|sig| {
        key.verify_strict(message, &Signature::from_bytes(&sig))
            .is_ok()
    })
}

pub fn endorsement_bytes(new_kid: &str, at: i64, origin: &str) -> Vec<u8> {
    [
        ROTATE_TAG,
        &at.to_be_bytes(),
        origin.as_bytes(),
        &[0],
        new_kid.as_bytes(),
    ]
    .concat()
}

pub fn endorse(old: &SigningKey, new_kid: &str, at: i64, origin: &str) -> [u8; 64] {
    old.sign(&endorsement_bytes(new_kid, at, origin)).to_bytes()
}

pub fn endorsement_ok(
    old: &VerifyingKey,
    new_kid: &str,
    at: i64,
    origin: &str,
    sig: &[u8],
) -> bool {
    verified(old, &endorsement_bytes(new_kid, at, origin), sig)
}

pub fn hello_proof_bytes(jti: &[u8], callee_origin: &str, answer: &[u8]) -> Vec<u8> {
    [HELLO_TAG, jti, callee_origin.as_bytes(), &[0], answer].concat()
}

pub fn hello_proof(key: &SigningKey, jti: &[u8], callee_origin: &str, answer: &[u8]) -> [u8; 64] {
    key.sign(&hello_proof_bytes(jti, callee_origin, answer))
        .to_bytes()
}

pub fn hello_proof_ok(
    key: &VerifyingKey,
    jti: &[u8],
    callee_origin: &str,
    answer: &[u8],
    sig: &[u8],
) -> bool {
    verified(key, &hello_proof_bytes(jti, callee_origin, answer), sig)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Endorsed {
    pub kids: BTreeSet<String>,
    pub checks: usize,
}

pub fn endorsed_within(
    call_keys: &KeySet,
    served: &KeySet,
    ends: &[KeyEndorsement],
    origin: &str,
    max: usize,
) -> Endorsed {
    let mut found = Endorsed {
        kids: BTreeSet::new(),
        checks: 0,
    };
    if ends.len() > max {
        return found;
    }
    let mut waiting: BTreeMap<&str, Vec<&KeyEndorsement>> = BTreeMap::new();
    for end in ends {
        waiting.entry(end.by_kid.as_str()).or_default().push(end);
    }
    let mut trusted = call_keys.clone();
    let mut signers: Vec<String> = call_keys.keys().cloned().collect();
    while let Some(kid) = signers.pop() {
        let (Some(by), Some(statements)) =
            (trusted.get(&kid).copied(), waiting.remove(kid.as_str()))
        else {
            continue;
        };
        for KeyEndorsement {
            new_kid,
            at,
            by_kid: _,
            sig,
        } in statements
        {
            let Some(new) = served.get(new_kid) else {
                continue;
            };
            if trusted.contains_key(new_kid) {
                continue;
            }
            found.checks += 1;
            if !endorsement_ok(&by, new_kid, *at, origin, sig) {
                continue;
            }
            trusted.insert(new_kid.clone(), *new);
            found.kids.insert(new_kid.clone());
            signers.push(new_kid.clone());
        }
    }
    found
}

pub fn endorsed(
    call_keys: &KeySet,
    served: &KeySet,
    ends: &[KeyEndorsement],
    origin: &str,
) -> Endorsed {
    endorsed_within(call_keys, served, ends, origin, ENDORSEMENTS_MAX)
}

pub fn endorsed_keys(
    call_keys: &KeySet,
    served: &KeySet,
    ends: &[KeyEndorsement],
    origin: &str,
) -> BTreeSet<String> {
    endorsed(call_keys, served, ends, origin).kids
}

pub fn self_check(past_call_kids: &[String], configured: &[String]) -> Result<(), &'static str> {
    match past_call_kids.is_empty() || configured.iter().any(|kid| past_call_kids.contains(kid)) {
        true => Ok(()),
        false => Err(SELF_CHECK_NOTICE),
    }
}
