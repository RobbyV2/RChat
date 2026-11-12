use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::Rng;

use crate::util::{ct_eq, hex, hmac_sha256, is_space};

pub const RECOVERY_ALPHABET: &str = "23456789abcdefghjkmnpqrstuvwxyz";
pub const RECOVERY_COUNT: usize = 10;
pub const RECOVERY_LEN: usize = 10;
pub const RECOVERY_LOW: usize = 2;

pub const USER_CODE_ALPHABET: &str = "BCDFGHJKLMNPQRSTVWXZ";
pub const USER_CODE_LEN: usize = 8;

const SECRET_BYTES: usize = 32;
const SECRET_CHARS: usize = 43;

// Rejection sampling: a byte at or past the last full multiple of the alphabet is thrown away, so
// every character is equally likely.
fn pick(alphabet: &str, n: usize, mut fill: impl FnMut(&mut [u8])) -> String {
    let letters = alphabet.as_bytes();
    if letters.is_empty() {
        return String::new();
    }
    let limit = 256 - (256 % letters.len().clamp(1, 256));
    let mut out = String::with_capacity(n);
    let mut buf = vec![0u8; n * 2];
    for _ in 0..4096 {
        if out.len() >= n {
            break;
        }
        fill(&mut buf);
        for b in &buf {
            let b = usize::from(*b);
            if b < limit && out.len() < n {
                out.push(char::from(letters[b % letters.len()]));
            }
        }
    }
    out
}

fn os_random(buf: &mut [u8]) {
    rand::rng().fill_bytes(buf);
}

fn split(code: &str, at: usize) -> String {
    match (code.get(..at), code.get(at..)) {
        (Some(a), Some(b)) => format!("{a}-{b}"),
        (_, _) => code.to_string(),
    }
}

pub fn recovery_code_from(fill: impl FnMut(&mut [u8])) -> String {
    split(&pick(RECOVERY_ALPHABET, RECOVERY_LEN, fill), 5)
}

pub fn new_recovery_code() -> String {
    recovery_code_from(os_random)
}

pub fn new_recovery_codes() -> Vec<String> {
    let mut codes: Vec<String> = Vec::with_capacity(RECOVERY_COUNT);
    while codes.len() < RECOVERY_COUNT {
        let code = new_recovery_code();
        if !codes.contains(&code) {
            codes.push(code);
        }
    }
    codes
}

pub fn recovery_bits() -> f64 {
    RECOVERY_LEN as f64 * (RECOVERY_ALPHABET.len() as f64).log2()
}

pub fn clean_recovery(input: &str) -> Option<String> {
    let code: String = input
        .to_lowercase()
        .chars()
        .filter(|c| !is_space(*c) && *c != '-')
        .collect();
    let ok =
        code.chars().count() == RECOVERY_LEN && code.chars().all(|c| RECOVERY_ALPHABET.contains(c));
    ok.then_some(code)
}

pub fn recovery_key(pepper: &[u8], uid: i64, clean: &str) -> String {
    let mac = hmac_sha256(
        pepper,
        &[
            b"rchat-recovery-code1\0",
            uid.to_string().as_bytes(),
            b"\0",
            clean.as_bytes(),
        ],
    );
    format!("r1:{}", hex(&mac))
}

pub fn recovery_key_matches(stored: &str, pepper: &[u8], uid: i64, clean: &str) -> bool {
    ct_eq(
        stored.as_bytes(),
        recovery_key(pepper, uid, clean).as_bytes(),
    )
}

pub fn user_code_from(fill: impl FnMut(&mut [u8])) -> String {
    split(&pick(USER_CODE_ALPHABET, USER_CODE_LEN, fill), 4)
}

pub fn new_user_code() -> String {
    user_code_from(os_random)
}

pub fn clean_user_code(input: &str) -> Option<String> {
    let code: String = input
        .to_uppercase()
        .chars()
        .filter(char::is_ascii_uppercase)
        .collect();
    let ok = code.len() == USER_CODE_LEN && code.chars().all(|c| USER_CODE_ALPHABET.contains(c));
    ok.then_some(code)
}

pub fn user_code_key(pepper: &[u8], clean: &str) -> String {
    let mac = hmac_sha256(pepper, &[b"rchat-user-code1\0", clean.as_bytes()]);
    format!("u1:{}", hex(&mac))
}

pub fn user_code_bits() -> f64 {
    USER_CODE_LEN as f64 * (USER_CODE_ALPHABET.len() as f64).log2()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SecretKind {
    Access,
    Refresh,
    Personal,
    Proxy,
    Device,
    Pending,
    Trusted,
    ClientSecret,
}

impl SecretKind {
    pub const ALL: [SecretKind; 8] = [
        SecretKind::Access,
        SecretKind::Refresh,
        SecretKind::Personal,
        SecretKind::Proxy,
        SecretKind::Device,
        SecretKind::Pending,
        SecretKind::Trusted,
        SecretKind::ClientSecret,
    ];

    pub fn prefix(self) -> &'static str {
        match self {
            SecretKind::Access => "rca_",
            SecretKind::Refresh => "rcr_",
            SecretKind::Personal => "rcp_",
            SecretKind::Proxy => "rcx_",
            SecretKind::Device => "rcd_",
            SecretKind::Pending => "rcs_",
            SecretKind::Trusted => "rct_",
            SecretKind::ClientSecret => "rck_",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TokenKind {
    Session,
    Secret(SecretKind),
}

pub fn new_secret(kind: SecretKind) -> String {
    let mut bytes = [0u8; SECRET_BYTES];
    rand::rng().fill_bytes(&mut bytes);
    format!("{}{}", kind.prefix(), URL_SAFE_NO_PAD.encode(bytes))
}

pub fn secret_kind_of(token: &str) -> Option<TokenKind> {
    let hex_token = token.len() == 64
        && token
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    if hex_token {
        return Some(TokenKind::Session);
    }
    SecretKind::ALL.into_iter().find_map(|kind| {
        let rest = token.strip_prefix(kind.prefix())?;
        let ok = rest.len() == SECRET_CHARS
            && rest
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
        ok.then_some(TokenKind::Secret(kind))
    })
}
