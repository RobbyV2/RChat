use std::collections::BTreeMap;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use rchat_identity::subject::{KeyCheck, PairwiseKeys, avatar_key, reconcile_keys, subject_of};
use sha2::Sha256;

fn keys() -> PairwiseKeys {
    PairwiseKeys::new(BTreeMap::from([(1, vec![1u8; 32]), (2, vec![2u8; 32])]))
}

fn one(version: u32, key: &[u8]) -> PairwiseKeys {
    PairwiseKeys::new(BTreeMap::from([(version, key.to_vec())]))
}

fn mac(key: &[u8], msg: &[u8]) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).unwrap();
    mac.update(msg);
    URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

#[test]
fn stable_per_application_and_its_key_version_never_the_uid() {
    let k = keys();
    let a = subject_of(&k, 1, "app1", 42).unwrap();
    assert_eq!(a.len(), 43);
    assert_eq!(subject_of(&k, 1, "app1", 42).unwrap(), a);
    assert_ne!(subject_of(&k, 1, "app2", 42).unwrap(), a);
    assert_ne!(subject_of(&k, 1, "app1", 43).unwrap(), a);
    assert_ne!(subject_of(&k, 2, "app1", 42).unwrap(), a);
    assert_eq!(a, mac(&[1u8; 32], b"rchat-sub1\x00app1\x0042"));
    assert_eq!(subject_of(&k, 3, "app1", 42), None);
}

#[test]
fn keys_are_added_never_swapped() {
    let none = PairwiseKeys::default();
    assert_eq!(
        reconcile_keys(&none, &none),
        KeyCheck::Ok {
            add: vec![],
            current: 1
        }
    );
    assert_eq!(
        reconcile_keys(&one(1, b"a"), &one(2, b"b")),
        KeyCheck::Ok {
            add: vec![2],
            current: 2
        }
    );
    assert_eq!(
        reconcile_keys(&one(1, b"a"), &one(1, b"a")),
        KeyCheck::Ok {
            add: vec![],
            current: 1
        }
    );
    assert_eq!(
        reconcile_keys(&one(1, b"a"), &one(1, b"b")),
        KeyCheck::Conflict { version: 1 }
    );
    assert_eq!(
        reconcile_keys(&none, &one(1, b"a")),
        KeyCheck::Ok {
            add: vec![1],
            current: 1
        }
    );
    assert_eq!(
        reconcile_keys(&one(5, b"e"), &one(2, b"b")),
        KeyCheck::Ok {
            add: vec![2],
            current: 5
        }
    );
}

#[test]
fn the_avatar_key_is_per_application_and_22_characters() {
    let k = keys();
    let a = avatar_key(&k, 1, "app1", 42).unwrap();
    assert_eq!(a.len(), 22);
    assert_eq!(a, &mac(&[1u8; 32], b"rchat-avatar1\x00app1\x0042")[..22]);
    assert_ne!(avatar_key(&k, 1, "app2", 42).unwrap(), a);
    assert_ne!(a, &subject_of(&k, 1, "app1", 42).unwrap()[..22]);
    assert_eq!(avatar_key(&k, 9, "app1", 42), None);
}

#[test]
fn keys_are_never_printed() {
    let shown = format!("{:?}", keys());
    assert_eq!(shown, "PairwiseKeys { versions: [1, 2] }");
    assert_eq!(keys().versions(), vec![1, 2]);
}
