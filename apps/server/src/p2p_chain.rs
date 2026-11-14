//! The key chain of a P2P identity made with a recovery key, as the client's `p2p/chain.ts` reads
//! it: the creation record (`n = 0`, signed by the identity key and the recovery key) and the
//! chain records after it, each signed by the recovery key in force. Both are closed formats, and
//! a record's identity is the SHA-256 of its canonical JSON without its signatures.

use std::collections::HashMap;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::VerifyingKey;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value, json};
use sha2::{Digest, Sha256};
use unicode_normalization::is_nfc;
use utoipa::ToSchema;

use crate::identity::{binding2_proof_ok, p2p_key, sig_ok};

/// Most records that follow a creation record on one line.
pub const CHAIN_MAX: u64 = 8;
/// Most device keys a chain record keeps.
pub const KEEP_MAX: usize = 8;
/// Most records of a `{cr, chain}` that travels in a request: the creation record and the chain.
pub const KEYS_RECORDS: usize = CHAIN_MAX as usize + 1;
/// Most bytes of the canonical JSON of a `{cr, chain}` that travels in a request.
pub const KEYS_BYTES: usize = 7 * 1024;

const CREATE_TAG: &[u8] = b"rchat-p2p-create1\0";
const CHAIN_TAG: &[u8] = b"rchat-p2p-chain1\0";
const MAX_SAFE: i64 = (1 << 53) - 1;

/// A record of a key chain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct Head {
    /// Its number: 0 for the creation record.
    pub n: u64,
    /// Its identity: the SHA-256 of its canonical JSON without its signatures, base64url without
    /// padding (43 characters).
    pub d: String,
}

/// Why a chain was refused: its creation record, or the chain record at this place.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChainError {
    Creation,
    Record(usize),
}

fn safe_int(n: &Number) -> Option<i64> {
    if let Some(u) = n.as_u64() {
        return i64::try_from(u).ok().filter(|i| *i <= MAX_SAFE);
    }
    if let Some(i) = n.as_i64() {
        return (i >= -MAX_SAFE).then_some(i);
    }
    let f = n.as_f64()?;
    let whole =
        f.fract() == 0.0 && f.abs() <= MAX_SAFE as f64 && !(f == 0.0 && f.is_sign_negative());
    whole.then_some(f as i64)
}

fn write_text(s: &str, out: &mut String) -> Option<()> {
    if !is_nfc(s) {
        return None;
    }
    out.push_str(&serde_json::to_string(s).ok()?);
    Some(())
}

fn write(value: &Value, out: &mut String) -> Option<()> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(n) => out.push_str(&safe_int(n)?.to_string()),
        Value::String(s) => write_text(s, out)?,
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(item, out)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (i, key) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_text(key, out)?;
                out.push(':');
                write(&map[key], out)?;
            }
            out.push('}');
        }
    }
    Some(())
}

/// The canonical JSON of `value`, as the client's `p2p/canonical.ts` writes it: keys sorted by
/// UTF-16 code units, no whitespace, whole numbers only. `None` for a number that is not a safe
/// whole number, for -0 and for a string that is not NFC.
pub fn canonical(value: &Value) -> Option<String> {
    let mut out = String::new();
    write(value, &mut out)?;
    Some(out)
}

fn digest(body: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(body.as_bytes()))
}

fn bytes<const N: usize>(text: &str) -> Option<[u8; N]> {
    let b: [u8; N] = URL_SAFE_NO_PAD.decode(text).ok()?.try_into().ok()?;
    (URL_SAFE_NO_PAD.encode(b) == text).then_some(b)
}

/// A key of a chain: a P2P key whose point has only this encoding.
pub fn key(id: &str) -> Option<VerifyingKey> {
    let key = p2p_key(id)?;
    (key.to_edwards().compress().to_bytes() == key.to_bytes()).then_some(key)
}

fn closed(map: &Map<String, Value>, required: &[&str], optional: &[&str]) -> bool {
    required.iter().all(|k| map.contains_key(*k))
        && map
            .keys()
            .all(|k| required.contains(&k.as_str()) || optional.contains(&k.as_str()))
}

fn int(value: &Value) -> Option<u64> {
    match value {
        Value::Number(n) => safe_int(n).and_then(|i| u64::try_from(i).ok()),
        Value::Null | Value::Bool(_) | Value::String(_) | Value::Array(_) | Value::Object(_) => {
            None
        }
    }
}

fn key_id(value: &Value) -> Option<&str> {
    value.as_str().filter(|id| key(id).is_some())
}

fn sig(value: &Value) -> Option<&str> {
    value.as_str().filter(|s| bytes::<64>(s).is_some())
}

fn signed(by: &str, tag: &[u8], body: &str, sig: &str) -> bool {
    key(by).is_some_and(|key| sig_ok(&key, &[tag, body.as_bytes()].concat(), sig))
}

struct Creation {
    ik: String,
    rk: String,
    pk: String,
    d: String,
}

fn creation(value: &Value) -> Option<Creation> {
    let map = value.as_object()?;
    if !closed(
        map,
        &["v", "ik", "n", "rk", "pk", "at", "sig_ik", "sig_rk"],
        &[],
    ) {
        return None;
    }
    let (ik, rk, pk) = (
        key_id(&map["ik"])?,
        key_id(&map["rk"])?,
        key_id(&map["pk"])?,
    );
    let (at, sig_ik, sig_rk) = (int(&map["at"])?, sig(&map["sig_ik"])?, sig(&map["sig_rk"])?);
    if int(&map["v"])? != 1 || int(&map["n"])? != 0 || pk == ik {
        return None;
    }
    let body = canonical(&json!({"v": 1, "ik": ik, "n": 0, "rk": rk, "pk": pk, "at": at}))?;
    match signed(ik, CREATE_TAG, &body, sig_ik) && signed(rk, CREATE_TAG, &body, sig_rk) {
        true => Some(Creation {
            ik: ik.to_string(),
            rk: rk.to_string(),
            pk: pk.to_string(),
            d: digest(&body),
        }),
        false => None,
    }
}

struct Record {
    ik: String,
    n: u64,
    prev: String,
    pk: String,
    /// The key a reset names, or empty for a removal.
    rk: Option<String>,
    sig: String,
    sig_next: Option<String>,
    body: String,
    d: String,
}

fn record(value: &Value) -> Option<Record> {
    let map = value.as_object()?;
    if !closed(
        map,
        &["v", "ik", "n", "prev", "pk", "keep", "at", "sig"],
        &["rk", "sig_next"],
    ) {
        return None;
    }
    let (ik, pk) = (key_id(&map["ik"])?, key_id(&map["pk"])?);
    let n = int(&map["n"])?;
    let prev = map["prev"].as_str().filter(|d| bytes::<32>(d).is_some())?;
    let keep = map["keep"].as_array()?;
    let rk = match map.get("rk") {
        None => None,
        Some(Value::String(rk)) if rk.is_empty() => Some(""),
        Some(rk) => Some(key_id(rk)?),
    };
    let (at, sig) = (int(&map["at"])?, sig(&map["sig"])?);
    let reset = rk.is_some_and(|rk| !rk.is_empty());
    let sig_next = match (reset, map.get("sig_next")) {
        (true, Some(next)) => Some(self::sig(next)?),
        (false, None) => None,
        (true, None) | (false, Some(_)) => return None,
    };
    if int(&map["v"])? != 1 || !(1..=CHAIN_MAX).contains(&n) || pk == ik || keep.len() > KEEP_MAX {
        return None;
    }
    if !keep.iter().all(|k| key_id(k).is_some()) {
        return None;
    }
    let mut body =
        json!({"v": 1, "ik": ik, "n": n, "prev": prev, "pk": pk, "keep": keep, "at": at});
    if let Some(rk) = rk {
        body["rk"] = json!(rk);
    }
    let body = canonical(&body)?;
    Some(Record {
        ik: ik.to_string(),
        n,
        prev: prev.to_string(),
        pk: pk.to_string(),
        rk: rk.map(str::to_string),
        sig: sig.to_string(),
        sig_next: sig_next.map(str::to_string),
        d: digest(&body),
        body,
    })
}

struct Node {
    d: String,
    n: u64,
    par: Option<usize>,
    /// The place of its record in the chain as given; none for the creation record.
    at: Option<usize>,
    /// The recovery key in force after it.
    key: String,
    /// The primary after it.
    prim: String,
    /// A reset or a removal.
    change: bool,
    alive: bool,
}

/// A creation record that verifies, with the chain records read against it.
pub struct Chain {
    ik: String,
    nodes: Vec<Node>,
    by_d: HashMap<String, usize>,
    verifies: Vec<bool>,
    digests: Vec<Option<String>>,
    frozen: bool,
}

/// Reads `chain` against the creation record `cr`: a record counts when its `prev` counts, its
/// `n` follows and the key in force after `prev` signed it (a reset also by its next key). `Err`
/// only for a creation record that doesn't verify.
pub fn read(cr: &Value, chain: &[Value]) -> Result<Chain, ChainError> {
    let Creation { ik, rk, pk, d } = creation(cr).ok_or(ChainError::Creation)?;
    let recs: Vec<Option<Record>> = chain
        .iter()
        .map(|r| record(r).filter(|r| r.ik == ik))
        .collect();
    let mut nodes = vec![Node {
        d: d.clone(),
        n: 0,
        par: None,
        at: None,
        key: rk,
        prim: pk,
        change: false,
        alive: true,
    }];
    let mut by_d = HashMap::from([(d, 0)]);
    let mut verifies = vec![false; recs.len()];
    let mut order: Vec<(usize, &Record)> = recs
        .iter()
        .enumerate()
        .filter_map(|(i, r)| r.as_ref().map(|r| (i, r)))
        .collect();
    order.sort_by_key(|(_, r)| r.n);
    for (i, r) in order {
        let Some(&p) = by_d.get(&r.prev) else {
            continue;
        };
        let by = &nodes[p].key;
        let next = match (&r.rk, &r.sig_next) {
            (Some(rk), Some(sig_next)) => signed(rk, CHAIN_TAG, &r.body, sig_next),
            (_, _) => true,
        };
        if nodes[p].n + 1 != r.n || !signed(by, CHAIN_TAG, &r.body, &r.sig) || !next {
            continue;
        }
        verifies[i] = true;
        if by_d.contains_key(&r.d) {
            continue;
        }
        let key = match r.rk.as_deref() {
            None => by.clone(),
            Some("") => r.pk.clone(),
            Some(rk) => rk.to_string(),
        };
        by_d.insert(r.d.clone(), nodes.len());
        nodes.push(Node {
            d: r.d.clone(),
            n: r.n,
            par: Some(p),
            at: Some(i),
            key,
            prim: r.pk.clone(),
            change: r.rk.is_some(),
            alive: true,
        });
    }
    let up = |x: usize, y: usize| {
        let mut z = Some(y);
        while let Some(at) = z {
            if at == x {
                return true;
            }
            z = nodes[at].par;
        }
        false
    };
    let signer = |x: usize| nodes[x].par.map(|p| nodes[p].key.as_str());
    let mut killed = vec![false; nodes.len()];
    let mut frozen = false;
    for m in (0..nodes.len()).filter(|m| nodes[*m].change) {
        for x in 1..nodes.len() {
            if x == m || signer(x) != signer(m) || up(x, m) || up(m, x) {
                continue;
            }
            killed[x] = true;
            frozen |= nodes[x].change;
        }
    }
    for x in 1..nodes.len() {
        let par = nodes[x].par.is_none_or(|p| nodes[p].alive);
        nodes[x].alive = par && !killed[x];
    }
    Ok(Chain {
        ik,
        nodes,
        by_d,
        verifies,
        digests: recs.into_iter().map(|r| r.map(|r| r.d)).collect(),
        frozen,
    })
}

/// The chain of the identity `ik`, when its creation record and every record of `chain` verify.
pub fn verify(ik: &str, cr: &Value, chain: &[Value]) -> Result<Chain, ChainError> {
    let read = read(cr, chain)?;
    if read.ik != ik {
        return Err(ChainError::Creation);
    }
    match read.verifies.iter().position(|ok| !ok) {
        Some(i) => Err(ChainError::Record(i)),
        None => Ok(read),
    }
}

/// Whether `{cr, chain}` is within the bounds of a request: at most `KEYS_RECORDS` records and
/// `KEYS_BYTES` of canonical JSON. No signature is checked.
pub fn keys_fit(cr: &Value, chain: &[Value]) -> bool {
    chain.len() < KEYS_RECORDS
        && canonical(&json!({"cr": cr, "chain": chain})).is_some_and(|c| c.len() <= KEYS_BYTES)
}

/// Why a badge request with a chain was refused: it is over the bounds of a request, its chain
/// doesn't verify, its chain holds rival resets, or no head's primary signed the proof.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BindingError {
    Size,
    Chain(ChainError),
    Frozen,
    Proof,
}

/// The head a badge proof was signed for: a head of the chain of `ik` whose primary signed the
/// binding of `sub` to `ik` at that head and `ts`. The bounds are checked before any signature.
pub fn binding_head(
    sub: &str,
    ik: &str,
    ts: i64,
    proof: &str,
    cr: &Value,
    chain: &[Value],
) -> Result<Head, BindingError> {
    if !keys_fit(cr, chain) {
        return Err(BindingError::Size);
    }
    let read = verify(ik, cr, chain).map_err(BindingError::Chain)?;
    if read.frozen() {
        return Err(BindingError::Frozen);
    }
    let ts = u64::try_from(ts).map_err(|_| BindingError::Proof)?;
    let signed = |h: &Head| {
        read.primary(h)
            .is_some_and(|key| binding2_proof_ok(&key, sub, ik, h, ts, proof))
    };
    read.heads()
        .into_iter()
        .find(signed)
        .ok_or(BindingError::Proof)
}

impl Chain {
    fn node(&self, h: &Head) -> Option<&Node> {
        self.by_d
            .get(&h.d)
            .map(|i| &self.nodes[*i])
            .filter(|x| x.n == h.n)
    }

    /// The identity key.
    pub fn ik(&self) -> &str {
        &self.ik
    }

    /// The deepest records that count, by identity.
    pub fn heads(&self) -> Vec<Head> {
        let live = || self.nodes.iter().filter(|x| x.alive);
        let top = live().map(|x| x.n).max().unwrap_or(0);
        let mut heads: Vec<Head> = live()
            .filter(|x| x.n == top)
            .map(|x| Head {
                n: x.n,
                d: x.d.clone(),
            })
            .collect();
        heads.sort_by(|a, b| a.d.cmp(&b.d));
        heads
    }

    /// The primary after the record `h`.
    pub fn primary_id(&self, h: &Head) -> Option<&str> {
        self.node(h).map(|x| x.prim.as_str())
    }

    /// The primary key after the record `h`.
    pub fn primary(&self, h: &Head) -> Option<VerifyingKey> {
        self.primary_id(h).and_then(key)
    }

    /// The recovery key in force after the record `h`.
    pub fn in_force(&self, h: &Head) -> Option<&str> {
        self.node(h).map(|x| x.key.as_str())
    }

    /// Whether two resets or removals signed by one key stand beside each other: only a leaked
    /// phrase makes them.
    pub fn frozen(&self) -> bool {
        self.frozen
    }

    /// The places in the chain as given of the records that don't verify.
    pub fn refused(&self) -> Vec<usize> {
        (0..self.verifies.len())
            .filter(|i| !self.verifies[*i])
            .collect()
    }

    /// The places in the chain as given of the records that verify and that a reset or a removal
    /// killed.
    pub fn dead(&self) -> Vec<usize> {
        let dead = |i: &usize| {
            let node = self.digests[*i].as_ref().and_then(|d| self.by_d.get(d));
            self.verifies[*i] && node.is_some_and(|x| !self.nodes[*x].alive)
        };
        (0..self.verifies.len()).filter(dead).collect()
    }

    /// The places in the chain as given of its records, one per identity, in order of `n` and
    /// then of identity.
    pub fn records(&self) -> Vec<usize> {
        let mut held: Vec<&Node> = self.nodes.iter().filter(|x| x.at.is_some()).collect();
        held.sort_by(|a, b| a.n.cmp(&b.n).then_with(|| a.d.cmp(&b.d)));
        held.into_iter().filter_map(|x| x.at).collect()
    }

    /// Whether this chain has the creation record of `stored` and every record of it.
    pub fn extends(&self, stored: &Chain) -> bool {
        self.nodes[0].d == stored.nodes[0].d
            && stored.nodes.iter().all(|x| self.by_d.contains_key(&x.d))
    }
}

#[cfg(test)]
pub(crate) mod tests;
