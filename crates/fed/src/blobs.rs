use sha2::{Digest, Sha256};

use crate::limits::BLOB_MAX;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlobError {
    Size,
    Hash,
    Type,
}

pub fn sniff(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Some("image/png");
    }
    if b.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg");
    }
    if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if b.starts_with(b"RIFF") && b.get(8..12) == Some(b"WEBP") {
        return Some("image/webp");
    }
    None
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn accept_blob(requested: &str, data: &[u8]) -> Result<&'static str, BlobError> {
    if data.is_empty() || data.len() > BLOB_MAX {
        return Err(BlobError::Size);
    }
    if hex(&Sha256::digest(data)) != requested.to_ascii_lowercase() {
        return Err(BlobError::Hash);
    }
    sniff(data).ok_or(BlobError::Type)
}

pub const SERVE_HEADERS: [(&str, &str); 4] = [
    ("X-Content-Type-Options", "nosniff"),
    ("Content-Disposition", "inline; filename=\"image\""),
    ("Content-Security-Policy", "default-src 'none'; sandbox"),
    ("Cache-Control", "private, max-age=86400"),
];
