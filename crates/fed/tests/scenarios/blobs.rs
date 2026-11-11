use rchat_fed::blobs::{BlobError, SERVE_HEADERS, accept_blob, sniff};
use rchat_fed::limits::BLOB_MAX;
use sha2::{Digest, Sha256};

const PNG: [u8; 11] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];

fn hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[test]
fn stored_only_when_the_bytes_hash_to_what_was_asked_for() {
    assert_eq!(accept_blob(&hex(&PNG), &PNG), Ok("image/png"));
    assert_eq!(
        accept_blob(&hex(&PNG).to_uppercase(), &PNG),
        Ok("image/png")
    );
    let other = [0xff, 0xd8, 0xff, 9, 9];
    assert_eq!(accept_blob(&hex(&PNG), &other), Err(BlobError::Hash));
}

#[test]
fn typed_from_the_bytes_svg_and_html_are_refused_whatever_the_declared_type() {
    let svg = br#"<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>"#;
    assert_eq!(accept_blob(&hex(svg), svg), Err(BlobError::Type));
    let html = b"<html><script></script></html>";
    assert_eq!(accept_blob(&hex(html), html), Err(BlobError::Type));
}

#[test]
fn the_four_raster_types_are_told_from_their_first_bytes() {
    assert_eq!(sniff(&PNG), Some("image/png"));
    assert_eq!(sniff(&[0xff, 0xd8, 0xff, 0xe0]), Some("image/jpeg"));
    assert_eq!(sniff(b"GIF87a..."), Some("image/gif"));
    assert_eq!(sniff(b"GIF89a..."), Some("image/gif"));
    assert_eq!(sniff(b"GIF88a..."), None);
    assert_eq!(sniff(b"RIFF\x10\0\0\0WEBPVP8 "), Some("image/webp"));
    assert_eq!(sniff(b"RIFF\x10\0\0\0WAVEfmt "), None);
    assert_eq!(sniff(b"RIFF"), None);
    assert_eq!(sniff(&[0x89, 0x50]), None);
    assert_eq!(sniff(&[]), None);
}

#[test]
fn size_limit() {
    let mut big = vec![0u8; BLOB_MAX + 1];
    big[..PNG.len()].copy_from_slice(&PNG);
    assert_eq!(accept_blob(&hex(&big), &big), Err(BlobError::Size));
    assert_eq!(
        accept_blob(&hex(&big[..BLOB_MAX]), &big[..BLOB_MAX]),
        Ok("image/png")
    );
    assert_eq!(accept_blob(&hex(&[]), &[]), Err(BlobError::Size));
}

#[test]
fn served_like_media() {
    let header = |name: &str| {
        SERVE_HEADERS
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, value)| *value)
    };
    assert_eq!(header("X-Content-Type-Options"), Some("nosniff"));
    assert_eq!(
        header("Content-Security-Policy"),
        Some("default-src 'none'; sandbox")
    );
    assert_eq!(
        header("Content-Disposition"),
        Some("inline; filename=\"image\"")
    );
    assert_eq!(header("Cache-Control"), Some("private, max-age=86400"));
    assert_eq!(SERVE_HEADERS.len(), 4);
}
