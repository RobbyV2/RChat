use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};

pub const LETTER_TAG: &[u8] = b"rchat-letter2\0";

pub fn content_id(tag: &[u8], bytes: &[u8]) -> String {
    let mut hash = Sha256::new();
    hash.update(tag);
    hash.update(bytes);
    URL_SAFE_NO_PAD.encode(hash.finalize())
}

pub fn letter_id(core: &[u8]) -> String {
    content_id(LETTER_TAG, core)
}
