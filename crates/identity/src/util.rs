use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;

pub(crate) fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.ct_eq(b).into()
}

pub(crate) fn hmac_sha256(key: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    let mut out = [0u8; 32];
    if let Ok(mut mac) = <Hmac<Sha256> as KeyInit>::new_from_slice(key) {
        for part in parts {
            mac.update(part);
        }
        out.copy_from_slice(&mac.finalize().into_bytes());
    }
    out
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(char::from(DIGITS[usize::from(b >> 4)]));
        out.push(char::from(DIGITS[usize::from(b & 15)]));
    }
    out
}

pub(crate) fn push_percent(out: &mut String, byte: u8) {
    const DIGITS: &[u8; 16] = b"0123456789ABCDEF";
    out.push('%');
    out.push(char::from(DIGITS[usize::from(byte >> 4)]));
    out.push(char::from(DIGITS[usize::from(byte & 15)]));
}

// The whitespace a JavaScript regular expression's \s matches, so typed codes clean the same in
// the client and here.
pub(crate) fn is_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

// JavaScript's encodeURIComponent.
pub(crate) fn encode_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for b in text.bytes() {
        match b {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(char::from(b)),
            _ => push_percent(&mut out, b),
        }
    }
    out
}

// Route patterns: `{}` is one segment, `{#}` digits, `{a|b}` one of the names, a last `**` any
// rest, and a pattern ending in `/` is a plain prefix.
pub(crate) fn path_matches(pattern: &str, path: &str) -> bool {
    if pattern.ends_with('/') {
        return path.starts_with(pattern);
    }
    let mut have = path.split('/');
    for want in pattern.split('/') {
        if want == "**" {
            return true;
        }
        let Some(seg) = have.next() else {
            return false;
        };
        let ok = match want.strip_prefix('{').and_then(|w| w.strip_suffix('}')) {
            Some("") => !seg.is_empty(),
            Some("#") => !seg.is_empty() && seg.bytes().all(|b| b.is_ascii_digit()),
            Some(names) => names.split('|').any(|name| name == seg),
            None => want == seg,
        };
        if !ok {
            return false;
        }
    }
    have.next().is_none()
}

#[cfg(test)]
mod tests {
    use super::path_matches;

    #[test]
    fn patterns() {
        assert!(path_matches("/me", "/me"));
        assert!(!path_matches("/me", "/me/"));
        assert!(!path_matches("/me", "me"));
        assert!(path_matches("/auth/", "/auth/login"));
        assert!(path_matches("/auth/", "/auth/"));
        assert!(!path_matches("/auth/", "/auth"));
        assert!(path_matches("/apps/**", "/apps"));
        assert!(path_matches("/apps/**", "/apps/a/b"));
        assert!(path_matches("/apps/**", "/apps/"));
        assert!(!path_matches("/apps/**", "/appsx"));
        assert!(path_matches("/a/{}/b", "/a/x/b"));
        assert!(!path_matches("/a/{}/b", "/a//b"));
        assert!(!path_matches("/a/{}/b", "/a/x/y/b"));
        assert!(path_matches("/m/{#}", "/m/12"));
        assert!(!path_matches("/m/{#}", "/m/1a"));
        assert!(!path_matches("/m/{#}", "/m/"));
        assert!(path_matches("/x/{a|b}", "/x/b"));
        assert!(!path_matches("/x/{a|b}", "/x/ab"));
        assert!(!path_matches("/x/{a|b}", "/x/"));
        assert!(!path_matches("/x/{a|b}", "/x"));
        assert!(!path_matches("/x", ""));
    }
}
