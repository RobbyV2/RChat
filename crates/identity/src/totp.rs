use std::fmt;

use hmac::{Hmac, KeyInit, Mac};
use rand::Rng;
use sha1::Sha1;
use sha2::{Sha256, Sha512};

use crate::util::{ct_eq, encode_component, is_space};

pub const DIGITS: u32 = 6;
pub const PERIOD: i64 = 30;
pub const SECRET_BYTES: usize = 20;
pub const WINDOW: i64 = 1;
pub const CLOCK_HINT_STEPS: i64 = 10;
const MAX_DIGITS: u32 = 9;

const B32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

#[derive(Clone)]
pub struct Secret(Vec<u8>);

impl Secret {
    pub fn new(bytes: Vec<u8>) -> Secret {
        Secret(bytes)
    }

    pub fn generate() -> Secret {
        let mut bytes = vec![0u8; SECRET_BYTES];
        rand::rng().fill_bytes(&mut bytes);
        Secret(bytes)
    }

    pub fn from_base32(text: &str) -> Option<Secret> {
        base32_decode(text).map(Secret)
    }

    pub fn bytes(&self) -> &[u8] {
        &self.0
    }

    pub fn base32(&self) -> String {
        base32_encode(&self.0)
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(..)")
    }
}

pub fn base32_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(5) * 8);
    let mut bits = 0u32;
    let mut value = 0u32;
    for b in bytes {
        value = ((value << 8) | u32::from(*b)) & 0xffff;
        bits += 8;
        while bits >= 5 {
            out.push(char::from(B32[((value >> (bits - 5)) & 31) as usize]));
            bits -= 5;
        }
    }
    if bits > 0 {
        out.push(char::from(B32[((value << (5 - bits)) & 31) as usize]));
    }
    out
}

pub fn base32_decode(text: &str) -> Option<Vec<u8>> {
    let upper = text.to_uppercase();
    let clean: String = upper
        .chars()
        .filter(|c| !is_space(*c) && *c != '-')
        .collect();
    let clean = clean.trim_end_matches('=');
    let mut out = Vec::with_capacity(clean.len() * 5 / 8);
    let mut bits = 0u32;
    let mut value = 0u32;
    for ch in clean.chars() {
        let i = B32.iter().position(|b| char::from(*b) == ch)?;
        value = ((value << 5) | i as u32) & 0xfff;
        bits += 5;
        if bits >= 8 {
            out.push(((value >> (bits - 8)) & 255) as u8);
            bits -= 8;
        }
    }
    Some(out)
}

pub fn grouped_key(secret: &[u8]) -> String {
    let text = base32_encode(secret);
    let groups: Vec<&str> = text
        .as_bytes()
        .chunks(4)
        .filter_map(|c| std::str::from_utf8(c).ok())
        .collect();
    groups.join(" ")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Algo {
    Sha1,
    Sha256,
    Sha512,
}

fn mac_with<M: Mac + KeyInit>(secret: &[u8], msg: &[u8]) -> Vec<u8> {
    <M as KeyInit>::new_from_slice(secret)
        .map(|mut mac| {
            mac.update(msg);
            mac.finalize().into_bytes().to_vec()
        })
        .unwrap_or_default()
}

fn mac_of(algo: Algo, secret: &[u8], msg: &[u8]) -> Vec<u8> {
    match algo {
        Algo::Sha1 => mac_with::<Hmac<Sha1>>(secret, msg),
        Algo::Sha256 => mac_with::<Hmac<Sha256>>(secret, msg),
        Algo::Sha512 => mac_with::<Hmac<Sha512>>(secret, msg),
    }
}

pub fn hotp(secret: &[u8], counter: u64, digits: u32, algo: Algo) -> String {
    let digits = digits.clamp(1, MAX_DIGITS);
    let mac = mac_of(algo, secret, &counter.to_be_bytes());
    let at = |i: usize| u32::from(mac.get(i).copied().unwrap_or(0));
    let off = mac.last().map_or(0, |b| usize::from(b & 0x0f));
    let bin = ((at(off) & 0x7f) << 24) | (at(off + 1) << 16) | (at(off + 2) << 8) | at(off + 3);
    format!(
        "{:0width$}",
        bin % 10u32.pow(digits),
        width = digits as usize
    )
}

pub fn step_at(unix_secs: i64) -> i64 {
    unix_secs.div_euclid(PERIOD)
}

pub fn totp(secret: &[u8], unix_secs: i64, digits: u32, algo: Algo) -> Option<String> {
    let step = u64::try_from(step_at(unix_secs)).ok()?;
    Some(hotp(secret, step, digits, algo))
}

pub fn clean_code(input: &str) -> Option<String> {
    let code: String = input.chars().filter(|c| !is_space(*c)).collect();
    let ok = code.len() == DIGITS as usize && code.bytes().all(|b| b.is_ascii_digit());
    ok.then_some(code)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Ok { step: i64 },
    Wrong,
    Used,
    Clock,
    Malformed,
}

fn matches_step(secret: &[u8], step: Option<i64>, code: &str) -> bool {
    match step.map(u64::try_from) {
        Some(Ok(counter)) => ct_eq(
            hotp(secret, counter, DIGITS, Algo::Sha1).as_bytes(),
            code.as_bytes(),
        ),
        Some(Err(_)) | None => false,
    }
}

pub fn verify(
    secret: &[u8],
    input: &str,
    unix_secs: i64,
    last_step: i64,
    enrolling: bool,
) -> Verdict {
    let Some(code) = clean_code(input) else {
        return Verdict::Malformed;
    };
    let now = step_at(unix_secs);
    let mut accepted = None;
    let mut used = false;
    for d in -WINDOW..=WINDOW {
        let step = now.checked_add(d);
        let hit = matches_step(secret, step, &code);
        match (hit, step) {
            (true, Some(s)) if s <= last_step => used = true,
            (true, Some(s)) => accepted = accepted.or(Some(s)),
            (_, _) => {}
        }
    }
    if let Some(step) = accepted {
        return Verdict::Ok { step };
    }
    if used {
        return Verdict::Used;
    }
    if enrolling {
        for d in (WINDOW + 1)..=CLOCK_HINT_STEPS {
            let before = matches_step(secret, now.checked_sub(d), &code);
            let after = matches_step(secret, now.checked_add(d), &code);
            if before | after {
                return Verdict::Clock;
            }
        }
    }
    Verdict::Wrong
}

pub fn otpauth_uri(issuer: &str, account: &str, secret: &[u8]) -> String {
    let issuer = encode_component(issuer);
    format!(
        "otpauth://totp/{issuer}:{}?secret={}&issuer={issuer}&algorithm=SHA1&digits={DIGITS}&period={PERIOD}",
        encode_component(account),
        base32_encode(secret),
    )
}

pub fn issuer_label(name: &str, host: &str) -> String {
    match name.to_lowercase() == host.to_lowercase() {
        true => host.to_string(),
        false => format!("{name} ({host})"),
    }
}
