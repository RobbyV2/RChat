//! Encryption at rest: root keys, wrapped data keys, derived subkeys and the sealed record format.

use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chacha20poly1305::aead::{Aead, KeyInit as _, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use zeroize::Zeroizing;

pub mod body;
pub mod cli;
pub mod copies;
pub mod frames;
pub mod grams;
pub mod media;
pub mod ring;
pub mod secrets;

#[cfg(test)]
mod tests;

pub const KEY_LEN: usize = 32;
pub const NONCE_LEN: usize = 24;
pub const TAG_LEN: usize = 16;
pub const MAGIC: u8 = 0x52;
/// A record sealed with XChaCha20-Poly1305 under an instance data key.
pub const SERVER_RECORD: u8 = 0x01;
/// A record sealed with AES-256-GCM under a device key.
pub const DEVICE_RECORD: u8 = 0x02;
pub const DEVICE_NONCE_LEN: usize = 12;
pub const HEADER_LEN: usize = 6;
/// Bytes a sealed record adds to its plaintext.
pub const OVERHEAD: usize = HEADER_LEN + NONCE_LEN + TAG_LEN;
pub const SUBKEY_CACHE: usize = 4096;

pub type Key = Zeroizing<[u8; KEY_LEN]>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Purpose {
    Content,
    Media,
    Secrets,
    Search,
    Bus,
}

impl Purpose {
    pub const ALL: [Purpose; 5] = [
        Purpose::Content,
        Purpose::Media,
        Purpose::Secrets,
        Purpose::Search,
        Purpose::Bus,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Purpose::Content => "content",
            Purpose::Media => "media",
            Purpose::Secrets => "secrets",
            Purpose::Search => "search",
            Purpose::Bus => "bus",
        }
    }

    pub fn parse(name: &str) -> Option<Purpose> {
        Purpose::ALL.into_iter().find(|p| p.name() == name)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CryptError {
    /// The bytes are not a sealed record of a known version.
    Format,
    /// The key, the associated data or the bytes do not match.
    Open,
}

impl std::fmt::Display for CryptError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            CryptError::Format => "not a sealed record",
            CryptError::Open => "the sealed record cannot be opened",
        })
    }
}

impl std::error::Error for CryptError {}

pub fn random_key() -> Key {
    Zeroizing::new(rand::random::<[u8; KEY_LEN]>())
}

/// A root key: it wraps data keys and seals nothing else.
#[derive(Clone)]
pub struct Kek {
    pub id: String,
    key: Key,
}

impl std::fmt::Debug for Kek {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Kek")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

impl Kek {
    pub fn new(id: &str, key: Key) -> Kek {
        Kek {
            id: id.to_owned(),
            key,
        }
    }

    pub fn generate(id: &str) -> Kek {
        Kek::new(id, random_key())
    }

    /// The first 8 hex digits of `HMAC(key, "rchat-kek-fp")`.
    pub fn fingerprint(&self) -> String {
        let mut mac =
            <Hmac<Sha256> as KeyInit>::new_from_slice(&self.key[..]).expect("hmac takes any key");
        mac.update(b"rchat-kek-fp");
        hex::encode(&mac.finalize().into_bytes()[..4])
    }

    pub fn encoded(&self) -> Zeroizing<String> {
        Zeroizing::new(format!(
            "{}:{}",
            self.id,
            URL_SAFE_NO_PAD.encode(&self.key[..])
        ))
    }

    /// The wrapped form of `dek`, bound to its purpose, generation and this key's id.
    pub fn wrap(&self, purpose: Purpose, generation: i64, dek: &Key) -> String {
        let nonce = rand::random::<[u8; NONCE_LEN]>();
        let sealed = encrypt(
            &self.key,
            &nonce,
            &dek_aad(purpose, generation, &self.id),
            &dek[..],
        );
        let mut out = nonce.to_vec();
        out.extend_from_slice(&sealed);
        URL_SAFE_NO_PAD.encode(out)
    }

    pub fn unwrap(
        &self,
        purpose: Purpose,
        generation: i64,
        wrapped: &str,
    ) -> Result<Key, CryptError> {
        let bytes = URL_SAFE_NO_PAD
            .decode(wrapped)
            .map_err(|_| CryptError::Format)?;
        if bytes.len() != NONCE_LEN + KEY_LEN + TAG_LEN {
            return Err(CryptError::Format);
        }
        let (nonce, sealed) = bytes.split_at(NONCE_LEN);
        let plain = Zeroizing::new(decrypt(
            &self.key,
            nonce,
            &dek_aad(purpose, generation, &self.id),
            sealed,
        )?);
        let mut key = Zeroizing::new([0u8; KEY_LEN]);
        key.copy_from_slice(&plain);
        Ok(key)
    }
}

/// Key ids the instance names itself, which no configured key may take.
pub const RESERVED_IDS: [&str; 1] = [ring::DATABASE_KEK];

/// A key id is 1 to 32 letters, digits, `_` or `-`, and none of `RESERVED_IDS`.
pub fn check_key_id(id: &str) -> Result<(), String> {
    let named = !id.is_empty()
        && id.len() <= 32
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if !named {
        return Err("a key id is 1 to 32 letters, digits, '_' or '-'".to_owned());
    }
    match RESERVED_IDS.contains(&id) {
        true => Err(format!("the key id {id} is kept for this site's own use")),
        false => Ok(()),
    }
}

/// The 32 bytes of a base64url key.
pub(crate) fn decode_key(id: &str, value: &str) -> Result<Key, String> {
    let bytes = Zeroizing::new(
        URL_SAFE_NO_PAD
            .decode(value.trim().trim_end_matches('='))
            .map_err(|_| format!("the key {id} is not base64url"))?,
    );
    if bytes.len() != KEY_LEN {
        return Err(format!("the key {id} is not 32 bytes"));
    }
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    key.copy_from_slice(&bytes);
    Ok(key)
}

/// The keys of `k1:<base64url 32 bytes>[,k2:...]`. The first wraps; every listed key unwraps.
pub fn parse_keys(text: &str) -> Result<Vec<Kek>, String> {
    let mut keys: Vec<Kek> = Vec::new();
    for part in text.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        let Some((id, value)) = part.split_once(':') else {
            return Err("each key is written id:key".to_owned());
        };
        let id = id.trim();
        check_key_id(id)?;
        if keys.iter().any(|k| k.id == id) {
            return Err(format!("the key id {id} is listed twice"));
        }
        keys.push(Kek::new(id, decode_key(id, value)?));
    }
    match keys.is_empty() {
        true => Err("no key is listed".to_owned()),
        false => Ok(keys),
    }
}

fn joined(label: &[u8], parts: &[&[u8]]) -> Vec<u8> {
    let mut out = label.to_vec();
    for part in parts {
        out.push(0);
        out.extend_from_slice(part);
    }
    out
}

/// `"rchat-dek1\0" purpose "\0" gen "\0" kek_id`.
pub fn dek_aad(purpose: Purpose, generation: i64, kek_id: &str) -> Vec<u8> {
    joined(
        b"rchat-dek1",
        &[
            purpose.name().as_bytes(),
            generation.to_string().as_bytes(),
            kek_id.as_bytes(),
        ],
    )
}

/// `"rchat-row1\0" table "\0" column "\0" binding "\0" key_id`.
pub fn row_aad(table: &str, column: &str, binding: &str, key_id: u32) -> Vec<u8> {
    joined(
        b"rchat-row1",
        &[
            table.as_bytes(),
            column.as_bytes(),
            binding.as_bytes(),
            key_id.to_string().as_bytes(),
        ],
    )
}

/// `"rchat-bus1\0" stream "\0" binding "\0" key_id`: the associated data of a bus frame.
pub fn bus_aad(stream: &str, binding: &str, key_id: u32) -> Vec<u8> {
    joined(
        b"rchat-bus1",
        &[
            stream.as_bytes(),
            binding.as_bytes(),
            key_id.to_string().as_bytes(),
        ],
    )
}

/// `"rchat-dev1\0" store "\0" key "\0" room`: the associated data of a device record.
pub fn device_aad(store: &str, key: &str, room: &str) -> Vec<u8> {
    joined(
        b"rchat-dev1",
        &[store.as_bytes(), key.as_bytes(), room.as_bytes()],
    )
}

fn encrypt(key: &Key, nonce: &[u8], aad: &[u8], plain: &[u8]) -> Vec<u8> {
    XChaCha20Poly1305::new(chacha20poly1305::Key::from_slice(&key[..]))
        .encrypt(XNonce::from_slice(nonce), Payload { msg: plain, aad })
        .expect("the record fits the cipher")
}

fn decrypt(key: &Key, nonce: &[u8], aad: &[u8], sealed: &[u8]) -> Result<Vec<u8>, CryptError> {
    XChaCha20Poly1305::new(chacha20poly1305::Key::from_slice(&key[..]))
        .decrypt(XNonce::from_slice(nonce), Payload { msg: sealed, aad })
        .map_err(|_| CryptError::Open)
}

/// The version and key id a record names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    pub version: u8,
    pub key_id: u32,
}

impl Header {
    pub fn nonce_len(self) -> usize {
        match self.version {
            DEVICE_RECORD => DEVICE_NONCE_LEN,
            _ => NONCE_LEN,
        }
    }
}

pub fn header(record: &[u8]) -> Result<Header, CryptError> {
    let [MAGIC, version, a, b, c, d, ..] = *record else {
        return Err(CryptError::Format);
    };
    let head = Header {
        version,
        key_id: u32::from_be_bytes([a, b, c, d]),
    };
    let known = matches!(version, SERVER_RECORD | DEVICE_RECORD);
    match known && record.len() >= HEADER_LEN + head.nonce_len() + TAG_LEN {
        true => Ok(head),
        false => Err(CryptError::Format),
    }
}

fn seal_with(key_id: u32, key: &Key, nonce: &[u8; NONCE_LEN], aad: &[u8], plain: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(plain.len() + OVERHEAD);
    out.extend_from_slice(&[MAGIC, SERVER_RECORD]);
    out.extend_from_slice(&key_id.to_be_bytes());
    out.extend_from_slice(nonce);
    out.extend_from_slice(&encrypt(key, nonce, aad, plain));
    out
}

/// `0x52 0x01 | key_id u32 BE | nonce(24) | ciphertext | tag(16)` under a fresh random nonce.
pub fn seal(key_id: u32, key: &Key, aad: &[u8], plain: &[u8]) -> Vec<u8> {
    seal_with(key_id, key, &rand::random(), aad, plain)
}

pub fn open(key: &Key, aad: &[u8], record: &[u8]) -> Result<Vec<u8>, CryptError> {
    let head = header(record)?;
    if head.version != SERVER_RECORD {
        return Err(CryptError::Format);
    }
    let (nonce, sealed) = record[HEADER_LEN..].split_at(NONCE_LEN);
    decrypt(key, nonce, aad, sealed)
}

/// `HKDF-SHA256(DEK, salt "rchat-scope1", info scope)`. Scopes are `c:<channel_id>`,
/// `d:<dm_id>` and `i`.
pub fn subkey(dek: &Key, scope: &str) -> Key {
    let mut out = Zeroizing::new([0u8; KEY_LEN]);
    hkdf::Hkdf::<Sha256>::new(Some(b"rchat-scope1"), &dek[..])
        .expand(scope.as_bytes(), &mut out[..])
        .expect("32 bytes is a valid HKDF length");
    out
}

struct Cached {
    keys: HashMap<(u32, String), (u64, Box<Key>)>,
    order: BTreeMap<u64, (u32, String)>,
    next: u64,
}

/// Derived subkeys, least recently used first out. Each sits in its own allocation, wiped when it
/// leaves.
pub struct Subkeys {
    capacity: usize,
    cached: Mutex<Cached>,
}

impl Default for Subkeys {
    fn default() -> Subkeys {
        Subkeys::with_capacity(SUBKEY_CACHE)
    }
}

impl Subkeys {
    pub fn with_capacity(capacity: usize) -> Subkeys {
        let capacity = capacity.max(1);
        Subkeys {
            capacity,
            cached: Mutex::new(Cached {
                keys: HashMap::with_capacity(capacity),
                order: BTreeMap::new(),
                next: 0,
            }),
        }
    }

    pub fn get(&self, key_id: u32, dek: &Key, scope: &str) -> Key {
        let at = (key_id, scope.to_owned());
        let mut cached = self.cached.lock().unwrap_or_else(|e| e.into_inner());
        let Cached { keys, order, next } = &mut *cached;
        let used = *next;
        *next += 1;
        if let Some((last, found)) = keys.get_mut(&at) {
            if let Some(spot) = order.remove(last) {
                order.insert(used, spot);
            }
            *last = used;
            return Key::clone(found);
        }
        let derived = subkey(dek, scope);
        while keys.len() >= self.capacity {
            let Some((_, oldest)) = order.pop_first() else {
                break;
            };
            keys.remove(&oldest);
        }
        keys.insert(at.clone(), (used, Box::new(derived.clone())));
        order.insert(used, at);
        derived
    }

    pub fn len(&self) -> usize {
        self.cached
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .keys
            .len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Wipes every subkey of one data key, or all of them.
    pub fn forget(&self, key_id: Option<u32>) {
        let mut cached = self.cached.lock().unwrap_or_else(|e| e.into_inner());
        let Cached {
            keys,
            order,
            next: _,
        } = &mut *cached;
        keys.retain(|(id, _), _| key_id.is_some_and(|gone| gone != *id));
        order.retain(|_, at| keys.contains_key(at));
    }
}
