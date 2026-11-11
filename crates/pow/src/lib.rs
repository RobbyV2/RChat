//! The `s256` proof-of-work puzzle ("rchat-pow1"), the sealed strings that carry challenges,
//! trust tokens and page passes, and the rules around them. `tests/vectors.json` is normative.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256};

#[cfg(feature = "policy")]
pub mod policy;
pub mod puzzle;
#[cfg(feature = "threads")]
mod solve;

pub use puzzle::{DOMAIN, puzzle_hash, solve_chunk, value, wins};
#[cfg(feature = "threads")]
pub use solve::{CHUNK, Progress, solve_parallel};

pub const SEED_DOMAIN: &[u8] = b"rchat-pow-seed1\0";
pub const MAC_DOMAIN: &[u8] = b"rchat-trust1\0";
/// Bytes of MAC kept in a sealed string.
pub const MAC_LEN: usize = 16;
/// Most sub-puzzles in one challenge.
pub const K_MAX: u32 = 64;
/// Most bytes of a sealed string.
pub const SEALED_MAX: usize = 4096;

/// The puzzle seed of a challenge: SHA-256 of the domain and the whole sealed string as sent.
pub fn seed_of(challenge: &str) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(SEED_DOMAIN);
    h.update(challenge.as_bytes());
    h.finalize().into()
}

/// floor(k * 2^64 / work), at least 1. `work` below `k` counts as `k`: every try wins.
pub fn target_for(k: u32, work: u64) -> u64 {
    let k = u128::from(k.clamp(1, K_MAX));
    let work = u128::from(work).max(k);
    let t = (k << 64) / work;
    t.clamp(1, u128::from(u64::MAX)) as u64
}

/// Expected tries of a whole challenge: k * 2^64 / target.
pub fn work_of(k: u32, target: u64) -> f64 {
    f64::from(k) * 18_446_744_073_709_551_616.0 / target as f64
}

/// A solution is one winning nonce per sub-puzzle, in order.
pub fn verify(seed: &[u8; 32], k: u32, target: u64, nonces: &[u64]) -> bool {
    nonces.len() == k as usize
        && k <= K_MAX
        && nonces
            .iter()
            .enumerate()
            .all(|(i, n)| wins(seed, i as u8, *n, target))
}

/// Solves on one thread, counting nonces up from 0: the smallest winners and the tries made.
pub fn solve(seed: &[u8; 32], k: u32, target: u64) -> (Vec<u64>, u64) {
    let mut tries = 0u64;
    let nonces = (0..k)
        .map(|i| {
            let n = (0u64..)
                .find(|n| wins(seed, i as u8, *n, target))
                .expect("a winner exists");
            tries += n + 1;
            n
        })
        .collect();
    (nonces, tries)
}

/// Nonces on the wire: lowercase hex of each nonce's 8 little-endian bytes, concatenated.
pub fn encode_nonces(nonces: &[u64]) -> String {
    nonces
        .iter()
        .flat_map(|n| n.to_le_bytes())
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub fn decode_nonces(hex: &str, k: u32) -> Option<Vec<u64>> {
    let bytes = hex.as_bytes();
    if k > K_MAX || bytes.len() != k as usize * 16 {
        return None;
    }
    let nibble = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        _ => None,
    };
    let raw: Option<Vec<u8>> = bytes
        .chunks(2)
        .map(|p| Some(nibble(p[0])? << 4 | nibble(p[1])?))
        .collect();
    Some(
        raw?.chunks(8)
            .map(|c| u64::from_le_bytes(c.try_into().expect("8 bytes")))
            .collect(),
    )
}

fn hmac_of(key: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    let mut m = <Hmac<Sha256> as KeyInit>::new_from_slice(key).expect("any key length");
    for part in parts {
        m.update(part);
    }
    m.finalize().into_bytes().into()
}

fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn mac(key: &[u8], kind: &str, kid: &str, body: &str) -> [u8; MAC_LEN] {
    let full = hmac_of(
        key,
        &[
            MAC_DOMAIN,
            kind.as_bytes(),
            b".",
            kid.as_bytes(),
            b".",
            body.as_bytes(),
        ],
    );
    let mut out = [0u8; MAC_LEN];
    out.copy_from_slice(&full[..MAC_LEN]);
    out
}

fn kid_ok(kid: &str) -> bool {
    (1..=8).contains(&kid.len()) && kid.bytes().all(|b| b.is_ascii_digit())
}

/// `<kind>.<kid>.<base64url payload>.<base64url 16-byte MAC>`. Kinds: `c1` a challenge, `t1` a
/// trust token, `g1` a page pass. `kid` is the key id, 1 to 8 digits, outside the payload and
/// under the MAC.
pub fn seal(key: &[u8], kind: &str, kid: &str, payload: &[u8]) -> String {
    assert!(kid_ok(kid), "kid is 1 to 8 digits");
    let body = URL_SAFE_NO_PAD.encode(payload);
    let tag = URL_SAFE_NO_PAD.encode(mac(key, kind, kid, &body));
    format!("{kind}.{kid}.{body}.{tag}")
}

/// The key id of a sealed string of `kind`, read before any MAC work.
pub fn kid_of<'a>(kind: &str, sealed: &'a str) -> Option<&'a str> {
    let mut parts = sealed.splitn(3, '.');
    match (parts.next(), parts.next()) {
        (Some(k), Some(kid)) if k == kind && kid_ok(kid) && sealed.len() <= SEALED_MAX => Some(kid),
        _ => None,
    }
}

/// The payload of a sealed string of `kind` whose MAC matches the key `key_of(kid)` gives,
/// compared in constant time. `None` for another kind, an unknown kid, a bad shape or tag.
pub fn open(key_of: impl Fn(&str) -> Option<Vec<u8>>, kind: &str, sealed: &str) -> Option<Vec<u8>> {
    let mut parts = sealed.split('.');
    let (Some(k), Some(kid), Some(body), Some(tag), None) = (
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
    ) else {
        return None;
    };
    if k != kind || !kid_ok(kid) || sealed.len() > SEALED_MAX {
        return None;
    }
    let key = key_of(kid)?;
    let tag = URL_SAFE_NO_PAD.decode(tag).ok()?;
    match same(&tag, &mac(&key, kind, kid, body)) {
        true => URL_SAFE_NO_PAD.decode(body).ok(),
        false => None,
    }
}

/// `<prefix>:` and the first 20 hex digits of HMAC-SHA256(key, "bind\0" || what || "\0" ||
/// value). `what` and its prefix: `acct` `a` (the session's stored key), `addr` `g` (the address
/// group), `user` `u` (`username_key` of a sign-in), `client` `c` (the `X-Trust-Client` id),
/// `ua` `b` (the user agent).
pub fn bind(key: &[u8], prefix: &str, what: &str, value: &str) -> String {
    let full = hmac_of(key, &[b"bind\0", what.as_bytes(), b"\0", value.as_bytes()]);
    format!("{prefix}:{}", hex(&full[..10]))
}

/// A client id from `X-Trust-Client`: 16 random bytes as 22 base64url characters.
pub fn client_id_ok(id: &str) -> bool {
    id.len() == 22
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        && URL_SAFE_NO_PAD.decode(id).is_ok_and(|b| b.len() == 16)
}

/// The key that per-requester caps, spent-set shares and waits use: the session, else the
/// address group with a valid client id, else the address group with a hash of the user agent.
pub fn requester(session_key: Option<&str>, group: &str, client: Option<&str>, ua: &str) -> String {
    match (session_key, client.filter(|c| client_id_ok(c))) {
        (Some(s), _) => format!("s:{s}"),
        (None, Some(c)) => format!("c:{group}|{c}"),
        (None, None) => format!("u:{group}|{}", hex(&Sha256::digest(ua.as_bytes())[..8])),
    }
}

/// The forward-auth challenge of a verifier: base64url(SHA-256(verifier)), as PKCE S256.
pub fn challenge_of(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

pub fn verifier_ok(verifier: &str, challenge: &str) -> bool {
    same(challenge_of(verifier).as_bytes(), challenge.as_bytes())
}

/// What the sign-in handlers key accounts by: lowercase, no trimming.
pub fn username_key(raw: &str) -> String {
    raw.to_lowercase()
}

/// Who a challenge or token is for, as the gate sees the request.
#[derive(Clone, Copy, Debug)]
pub enum Caller<'a> {
    /// The session's stored key (`h:` + hex).
    Session(&'a str),
    Guest {
        group: &'a str,
        client: Option<&'a str>,
    },
    /// `username` is the raw one of the body or the challenge request; `None` on routes
    /// without one.
    Signin {
        group: &'a str,
        username: Option<&'a str>,
        client: Option<&'a str>,
    },
    Page {
        ua: &'a str,
        group: Option<&'a str>,
    },
}

/// The exact `sub` of a caller. An invalid client id counts as none.
pub fn binding(key: &[u8], caller: Caller) -> String {
    let client = |c: Option<&str>| {
        c.filter(|c| client_id_ok(c))
            .map(|c| format!(",{}", bind(key, "c", "client", c)))
            .unwrap_or_default()
    };
    match caller {
        Caller::Session(stored) => bind(key, "a", "acct", stored),
        Caller::Guest { group, client: c } => {
            format!("{}{}", bind(key, "g", "addr", group), client(c))
        }
        Caller::Signin {
            group,
            username,
            client: c,
        } => format!(
            "{}{}{}",
            bind(key, "g", "addr", group),
            username
                .map(|u| format!(",{}", bind(key, "u", "user", &username_key(u))))
                .unwrap_or_default(),
            client(c)
        ),
        Caller::Page { ua, group } => format!(
            "{}{}",
            bind(key, "b", "ua", ua),
            group
                .map(|g| format!(",{}", bind(key, "g", "addr", g)))
                .unwrap_or_default()
        ),
    }
}

/// Seconds a challenge lives: 300, plus the time one slow thread at `slow_rate` tries per
/// second needs for its work.
pub fn life_secs(work: u64, slow_rate: u64) -> u64 {
    work.div_ceil(slow_rate.max(1)).saturating_add(300)
}

/// The redirect target of a page pass: the decoded `to` when it is a path on this origin, else
/// `/`. Refused: anything not starting with exactly one `/`, a backslash, a control character
/// (browsers strip tabs and newlines, so `/\t/evil.com` would become `//evil.com`), and
/// anything over 2048 bytes.
pub fn safe_target(to: &str) -> &str {
    let b = to.as_bytes();
    let ok = b.len() <= 2048
        && b.first() == Some(&b'/')
        && b.get(1) != Some(&b'/')
        && !to.chars().any(|c| c == '\\' || c.is_control());
    match ok {
        true => to,
        false => "/",
    }
}

/// The work of one challenge, from its class's base work and the suspicion score. Every `step`
/// points double the work, in quarter steps. `None` when the result would pass `max`: the
/// answer is a wait, not a harder puzzle.
pub fn work_for(base: u64, score: u32, step: u32, max: u64) -> Option<u64> {
    const ROOT: [f64; 4] = [1.0, 1.189_207_115, std::f64::consts::SQRT_2, 1.681_792_831];
    let quarters = (u64::from(score) * 4) / u64::from(step.max(1));
    let doubled = quarters / 4;
    if doubled >= 63 {
        return None;
    }
    let w = (base as f64) * ((1u64 << doubled) as f64) * ROOT[(quarters % 4) as usize];
    match w <= max as f64 {
        true => Some((w as u64).min(max)),
        false => None,
    }
}

/// `work_for` with the copy's load points added. Load raises the work only up to `max` and
/// never turns a challenge into a wait: `None` only when the score alone passes `max`.
pub fn work_with_load(base: u64, score: u32, load: u32, step: u32, max: u64) -> Option<u64> {
    work_for(base, score, step, max)?;
    Some(work_for(base, score.saturating_add(load), step, u64::MAX).map_or(max, |w| w.min(max)))
}

/// Who redeems a solution. Every redeemer spends from one spent set.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Redeemer {
    /// `POST /pow/token`
    Token,
    /// `POST /pow/pass`
    Pass,
    /// `trust::redeem`
    Redeem,
}

/// Which challenge classes (`cls`) a redeemer takes.
pub fn accepts(redeemer: Redeemer, cls: &str) -> bool {
    match redeemer {
        Redeemer::Token => cls == "general" || cls == "signin",
        Redeemer::Pass => cls == "page",
        Redeemer::Redeem => cls == "general",
    }
}

/// The spent set as the vectors define it: `r` values held until their challenge's `exp + 30`.
/// It is the reference for the rule, not the server's table: `spend` looks at every entry, and
/// it has no capacity and no shares per requester or network.
#[derive(Default, Debug)]
pub struct SpentSet {
    held: std::collections::HashMap<String, u128>,
}

impl SpentSet {
    /// False when `r` is already spent and still held.
    pub fn spend(&mut self, r: &str, exp: u64, now: u64) -> bool {
        self.held.retain(|_, until| *until > u128::from(now));
        match self.held.contains_key(r) {
            true => false,
            false => {
                self.held.insert(r.to_string(), u128::from(exp) + 30);
                true
            }
        }
    }
}

pub const BULK_PAGE_DEFAULT: i64 = 2000;
pub const BULK_PAGE_MAX: i64 = 5000;
pub const BULK_SCOPES_MAX: usize = 200;
const MIB: u64 = 1024 * 1024;
pub const BULK_PART_MAX: u64 = 8 * MIB;

/// What a bulk request asks for: parsed once, priced, and served from by the handler.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BulkAsk {
    Page { messages: i64 },
    MediaBatch,
    MediaRange { bytes: u64 },
    Changes { scopes: usize },
}

impl BulkAsk {
    /// From the raw `limit` query value: absent or unparsable is the default page, the rest is
    /// clamped to 1..=5000.
    pub fn page(limit: Option<&str>) -> BulkAsk {
        let n = limit
            .and_then(|l| l.trim().parse::<i64>().ok())
            .unwrap_or(BULK_PAGE_DEFAULT);
        BulkAsk::Page {
            messages: n.clamp(1, BULK_PAGE_MAX),
        }
    }

    /// From the raw `Range` header: one `bytes=a-b` or `bytes=-n` range gives its length; no
    /// range, an open range, several ranges or anything unparsable is the 8 MiB cap.
    pub fn range(header: Option<&str>) -> BulkAsk {
        let len = header
            .and_then(|h| h.trim().strip_prefix("bytes="))
            .filter(|spec| !spec.contains(','))
            .and_then(|spec| spec.split_once('-'))
            .and_then(|(a, b)| match (a.trim(), b.trim()) {
                ("", n) => n.parse::<u64>().ok(),
                (a, b) if !b.is_empty() => {
                    let (a, b) = (a.parse::<u64>().ok()?, b.parse::<u64>().ok()?);
                    b.checked_sub(a)?.checked_add(1)
                }
                _ => None,
            })
            .filter(|n| *n > 0)
            .unwrap_or(BULK_PART_MAX);
        BulkAsk::MediaRange {
            bytes: len.min(BULK_PART_MAX),
        }
    }

    pub fn changes(n: usize) -> BulkAsk {
        BulkAsk::Changes {
            scopes: n.clamp(1, BULK_SCOPES_MAX),
        }
    }

    /// 1 per 100 messages, 8 per media batch, 1 per MiB of a file, 1 per 20 scopes.
    pub fn cost(self) -> u32 {
        let units = match self {
            BulkAsk::Page { messages } => u64::try_from(messages).unwrap_or(0).div_ceil(100),
            BulkAsk::MediaBatch => 8,
            BulkAsk::MediaRange { bytes } => bytes.div_ceil(MIB),
            BulkAsk::Changes { scopes } => u64::try_from(scopes.div_ceil(20)).unwrap_or(u64::MAX),
        };
        u32::try_from(units).unwrap_or(u32::MAX)
    }
}
