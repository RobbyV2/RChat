//! Page cursors sealed by the server with ChaCha20-Poly1305 under a key from the instance
//! pepper. The client can neither read nor change one, and it opens only for the list and the
//! binding (who asks, and what orders the list) it was sealed for. The nonce comes from the
//! sealed content, so one position always gives the same cursor.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use ring::aead::{Aad, CHACHA20_POLY1305, LessSafeKey, NONCE_LEN, Nonce, UnboundKey};
use sha2::Sha256;

use crate::api::{ApiError, bad};

/// Most characters of a sealed cursor that are read.
const SEALED_MAX: usize = 1024;

fn mac(key: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(key).expect("hmac takes any key");
    for part in parts {
        mac.update(part);
    }
    mac.finalize().into_bytes().into()
}

fn framed(parts: &[&str]) -> Vec<u8> {
    let mut out = Vec::new();
    for part in parts {
        out.extend_from_slice(&(part.len() as u32).to_be_bytes());
        out.extend_from_slice(part.as_bytes());
    }
    out
}

fn unframed(mut bytes: &[u8]) -> Option<Vec<String>> {
    let mut parts = Vec::new();
    while !bytes.is_empty() {
        let (len, rest) = bytes.split_first_chunk::<4>()?;
        let len = u32::from_be_bytes(*len) as usize;
        let part = rest.get(..len)?;
        parts.push(String::from_utf8(part.to_vec()).ok()?);
        bytes = &rest[len..];
    }
    Some(parts)
}

fn cipher(pepper: &[u8], list: &str) -> LessSafeKey {
    let key = mac(pepper, &[b"rchat-cursor-key\0", list.as_bytes()]);
    LessSafeKey::new(UnboundKey::new(&CHACHA20_POLY1305, &key).expect("a 32-byte key"))
}

/// `parts` sealed for `list` and `binding`, as base64url without padding.
pub(crate) fn seal(pepper: &[u8], list: &str, binding: &[&str], parts: &[&str]) -> String {
    let aad = framed(binding);
    let mut data = framed(parts);
    let iv_key = mac(pepper, &[b"rchat-cursor-iv\0", list.as_bytes()]);
    let iv = mac(&iv_key, &[&(aad.len() as u32).to_be_bytes(), &aad, &data]);
    let mut nonce = [0u8; NONCE_LEN];
    nonce.copy_from_slice(&iv[..NONCE_LEN]);
    cipher(pepper, list)
        .seal_in_place_append_tag(
            Nonce::assume_unique_for_key(nonce),
            Aad::from(aad),
            &mut data,
        )
        .expect("a cursor fits the cipher");
    let mut out = nonce.to_vec();
    out.extend(data);
    URL_SAFE_NO_PAD.encode(out)
}

/// The `count` parts of a cursor `seal` made for `list` and `binding`. Anything else, also a
/// cursor of another list or binding, is `Invalid cursor`, like a malformed one.
pub(crate) fn open(
    pepper: &[u8],
    list: &str,
    binding: &[&str],
    raw: &str,
    count: usize,
) -> Result<Vec<String>, ApiError> {
    let invalid = || bad("Invalid cursor");
    let raw = raw.trim();
    if raw.len() > SEALED_MAX {
        return Err(invalid());
    }
    let bytes = URL_SAFE_NO_PAD.decode(raw).map_err(|_| invalid())?;
    let (nonce, sealed) = bytes.split_at_checked(NONCE_LEN).ok_or_else(invalid)?;
    let nonce = Nonce::try_assume_unique_for_key(nonce).map_err(|_| invalid())?;
    let mut sealed = sealed.to_vec();
    let plain = cipher(pepper, list)
        .open_in_place(nonce, Aad::from(framed(binding)), &mut sealed)
        .map_err(|_| invalid())?;
    match unframed(plain) {
        Some(parts) if parts.len() == count => Ok(parts),
        Some(_) | None => Err(invalid()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PEPPER: &[u8] = b"pepper";

    fn opened(list: &str, binding: &[&str], raw: &str) -> Option<Vec<String>> {
        open(PEPPER, list, binding, raw, 2).ok()
    }

    #[test]
    fn a_cursor_opens_for_its_list_and_binding_only() {
        let sealed = seal(PEPPER, "people", &["club", "u:bob"], &["300", "dan"]);
        assert_eq!(
            opened("people", &["club", "u:bob"], &sealed),
            Some(vec!["300".to_string(), "dan".to_string()])
        );
        assert_eq!(
            sealed,
            seal(PEPPER, "people", &["club", "u:bob"], &["300", "dan"]),
            "one position, one cursor"
        );
        assert_ne!(
            sealed,
            seal(PEPPER, "people", &["club", "u:bob"], &["300", "dao"])
        );
        for (list, binding) in [
            ("people", &["club", "u:carol"][..]),
            ("people", &["club", "u:bo", "b"][..]),
            ("people", &["clu", "bu:bob"][..]),
            ("bans", &["club", "u:bob"][..]),
        ] {
            assert_eq!(opened(list, binding, &sealed), None, "{list} {binding:?}");
        }
        assert_eq!(
            open(b"other", "people", &["club", "u:bob"], &sealed, 2).ok(),
            None
        );
        assert_eq!(
            open(PEPPER, "people", &["club", "u:bob"], &sealed, 3).ok(),
            None
        );
    }

    #[test]
    fn a_changed_or_malformed_cursor_is_invalid() {
        let sealed = seal(PEPPER, "people", &["club"], &["1", "ann"]);
        let bytes = URL_SAFE_NO_PAD.decode(&sealed).expect("base64url");
        for at in 0..bytes.len() {
            let mut changed = bytes.clone();
            changed[at] ^= 1;
            assert_eq!(
                opened("people", &["club"], &URL_SAFE_NO_PAD.encode(changed)),
                None
            );
        }
        for raw in [
            "",
            "zz",
            "%%%",
            &sealed[..sealed.len() - 2],
            &format!("{sealed}AA"),
            &"A".repeat(SEALED_MAX + 1),
        ] {
            match open(PEPPER, "people", &["club"], raw, 2) {
                Err(ApiError(status, msg, None)) => {
                    assert_eq!((status.as_u16(), msg.as_str()), (400, "Invalid cursor"))
                }
                other => panic!("{raw}: {:?}", other.ok()),
            }
        }
        assert_eq!(
            opened("people", &["club"], &format!(" {sealed} ")),
            Some(vec!["1".to_string(), "ann".to_string()])
        );
    }

    #[test]
    fn framing_round_trips_any_parts() {
        for parts in [
            vec![],
            vec![""],
            vec!["a", ""],
            vec!["\u{1f}", "x\u{0}y", "\u{e9}"],
        ] {
            assert_eq!(
                unframed(&framed(&parts)),
                Some(parts.iter().map(|p| p.to_string()).collect())
            );
        }
        assert_eq!(unframed(&[0, 0, 0, 2, b'a']), None);
        assert_eq!(unframed(&[0, 0, 1]), None);
        assert_eq!(unframed(&[0, 0, 0, 1, 0xff]), None);
    }
}
