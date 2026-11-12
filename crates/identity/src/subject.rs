use std::collections::BTreeMap;
use std::fmt;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;

use crate::util::{ct_eq, hmac_sha256};

const AVATAR_KEY_LEN: usize = 22;

#[derive(Clone, Default)]
pub struct PairwiseKeys(BTreeMap<u32, Vec<u8>>);

impl PairwiseKeys {
    pub fn new(keys: BTreeMap<u32, Vec<u8>>) -> PairwiseKeys {
        PairwiseKeys(keys)
    }

    pub fn versions(&self) -> Vec<u32> {
        self.0.keys().copied().collect()
    }

    fn get(&self, version: u32) -> Option<&[u8]> {
        self.0.get(&version).map(Vec::as_slice)
    }
}

impl fmt::Debug for PairwiseKeys {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PairwiseKeys")
            .field("versions", &self.versions())
            .finish()
    }
}

fn keyed(keys: &PairwiseKeys, version: u32, tag: &[u8], group: &str, uid: i64) -> Option<String> {
    let key = keys.get(version)?;
    let mac = hmac_sha256(
        key,
        &[tag, group.as_bytes(), b"\0", uid.to_string().as_bytes()],
    );
    Some(URL_SAFE_NO_PAD.encode(mac))
}

pub fn subject_of(keys: &PairwiseKeys, version: u32, group: &str, uid: i64) -> Option<String> {
    keyed(keys, version, b"rchat-sub1\0", group, uid)
}

pub fn avatar_key(keys: &PairwiseKeys, version: u32, group: &str, uid: i64) -> Option<String> {
    let mut key = keyed(keys, version, b"rchat-avatar1\0", group, uid)?;
    key.truncate(AVATAR_KEY_LEN);
    Some(key)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KeyCheck {
    Ok { add: Vec<u32>, current: u32 },
    Conflict { version: u32 },
}

pub fn reconcile_keys(stored: &PairwiseKeys, env: &PairwiseKeys) -> KeyCheck {
    let conflict = env
        .0
        .iter()
        .find(|(v, key)| stored.get(**v).is_some_and(|have| !ct_eq(have, key)));
    if let Some((version, _)) = conflict {
        return KeyCheck::Conflict { version: *version };
    }
    let add: Vec<u32> = env
        .0
        .keys()
        .filter(|v| stored.get(**v).is_none())
        .copied()
        .collect();
    let current = stored.0.keys().chain(env.0.keys()).max().copied();
    KeyCheck::Ok {
        add,
        current: current.unwrap_or(1),
    }
}
