use std::collections::{BTreeSet, HashMap};
use std::future::Future;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signer as _, SigningKey};
use prost::Message;
use sha2::{Digest, Sha256};

use crate::connect::Code;
use crate::guard::Fetch;
pub use crate::keys::KeySet;
use crate::keys::verified;
use crate::limits::call::{HEAD_MAX, JTI_BYTES, JTI_KEEP, LIFE_MAX, SKEW};
use crate::pb::CallHead;

pub const CALL_TAG: &[u8] = b"rchat-fed-call1\0";
pub const SCHEME: &str = "RChat-Fed ";
pub const HELLO_METHOD: &str = "/rchat.fed.v1.InstanceService/Hello";

#[derive(Clone, Debug)]
pub struct Signer {
    pub key: SigningKey,
    pub kid: String,
    pub origin: String,
    pub instance_id: String,
    pub hello_rev: u64,
}

#[derive(Clone, Copy, Debug)]
pub struct Call<'a> {
    pub aud: &'a str,
    pub method: &'a str,
    pub body: &'a [u8],
    pub now: i64,
    pub jti: [u8; JTI_BYTES],
    pub stamp: &'a [u8],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Signed {
    pub authorization: String,
    pub head: Vec<u8>,
    pub sig: [u8; 64],
}

pub fn sign_call(signer: &Signer, call: &Call) -> Signed {
    let Signer {
        key,
        kid,
        origin,
        instance_id,
        hello_rev,
    } = signer;
    let Call {
        aud,
        method,
        body,
        now,
        jti,
        stamp,
    } = call;
    let head = CallHead {
        iss: origin.clone(),
        aud: aud.to_string(),
        method: method.to_string(),
        iat: *now,
        exp: now + LIFE_MAX,
        jti: jti.to_vec(),
        body_sha256: Sha256::digest(body).to_vec(),
        body_len: body.len() as u64,
        kid: kid.clone(),
        instance_id: instance_id.clone(),
        hello_rev: *hello_rev,
        stamp: stamp.to_vec(),
    }
    .encode_to_vec();
    let sig = key.sign(&[CALL_TAG, &head].concat()).to_bytes();
    Signed {
        authorization: format!(
            "{SCHEME}{}.{}",
            URL_SAFE_NO_PAD.encode(&head),
            URL_SAFE_NO_PAD.encode(sig)
        ),
        head,
        sig,
    }
}

/// The ports callers may use: any, or only these.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum Ports {
    #[default]
    Any,
    Only(BTreeSet<u16>),
}

/// A caller's origin that `bare_origin` and the callee's ports accepted. Only `Origin::accept`
/// makes one, and every key, kid and replay lookup of a call takes one.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Origin(String);

impl Origin {
    pub fn accept(raw: &str, ports: &Ports) -> Result<Origin, CallError> {
        let Some(authority) = raw.strip_prefix("https://").filter(|_| bare_origin(raw)) else {
            return Err(CallError::Iss);
        };
        let port = match authority.rsplit_once(':') {
            Some((_, port)) => port.parse::<u16>().map_err(|_| CallError::Iss)?,
            None => 443,
        };
        match ports {
            Ports::Only(allowed) if !allowed.contains(&port) => Err(CallError::Port),
            Ports::Any | Ports::Only(_) => Ok(Origin(raw.to_string())),
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

pub trait CheckContext {
    fn aud(&self) -> &str;
    fn now(&self) -> i64;
    fn serves(&self, path: &str) -> bool;
    fn network(&self) -> &str;
    fn ports(&self) -> &Ports;
    fn cached_keys(&self, iss: &Origin) -> Option<KeySet>;
    /// Must refuse private, loopback and other special-use addresses at connect time, follow no
    /// redirect, and cap the time and size of the answer.
    fn fetch_keys(&mut self, iss: &Origin) -> impl Future<Output = Option<KeySet>> + Send;
    fn may_fetch(&mut self, network: &str, iss: &Origin, hello: bool, stamped: bool) -> Fetch;
    fn stamp_ok(&self, head: &CallHead) -> bool;
    fn stamp_once(&mut self, jti: &str, now: i64) -> bool;
    fn call_kids(&self, iss: &Origin) -> Option<BTreeSet<String>>;
    fn hello_call_kids(&self) -> Option<BTreeSet<String>>;
    fn seen(&mut self, iss: &Origin, jti: &str, exp: i64) -> bool;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CallError {
    Header,
    Iss,
    Port,
    Aud,
    Unimplemented,
    Method,
    Time,
    Body,
    Jti,
    Busy,
    StampNeeded,
    Keys,
    Kid,
    Forged,
    Replay,
    HelloNeeded,
    NotCallKey,
}

pub fn answer_of(error: CallError) -> (Code, u16) {
    let code = match error {
        CallError::Header | CallError::Iss | CallError::Aud => Code::NotFound,
        CallError::Port => Code::PermissionDenied,
        CallError::Unimplemented => Code::Unimplemented,
        CallError::Busy | CallError::Keys | CallError::StampNeeded => Code::Unavailable,
        CallError::HelloNeeded => Code::FailedPrecondition,
        CallError::Method
        | CallError::Time
        | CallError::Body
        | CallError::Jti
        | CallError::Kid
        | CallError::Forged
        | CallError::Replay
        | CallError::NotCallKey => Code::Unauthenticated,
    };
    (code, code.http())
}

pub fn valid_host(host: &str) -> bool {
    let label = |label: &str| {
        (1..=63).contains(&label.len())
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    };
    let numeric = |label: &str| label.bytes().all(|b| b.is_ascii_digit());
    host.len() <= 253 && host.split('.').all(label) && !host.rsplit('.').next().is_some_and(numeric)
}

fn canonical_port(port: &str) -> bool {
    !port.starts_with('0')
        && port.bytes().all(|b| b.is_ascii_digit())
        && port.parse::<u16>().is_ok_and(|port| port != 443)
}

/// `https://host`, or `https://host:port` off the default port: another port is another instance.
pub fn bare_origin(origin: &str) -> bool {
    let Some(authority) = origin.strip_prefix("https://") else {
        return false;
    };
    match authority.rsplit_once(':') {
        Some((host, port)) => valid_host(host) && canonical_port(port),
        None => valid_host(authority),
    }
}

fn in_window(iat: i64, exp: i64, now: i64) -> bool {
    let (iat, exp, now) = (i128::from(iat), i128::from(exp), i128::from(now));
    let skew = i128::from(SKEW);
    exp > iat && exp - iat <= i128::from(LIFE_MAX) && (iat - now).abs() <= skew && now <= exp + skew
}

fn parts(authorization: Option<&str>) -> Option<(Vec<u8>, Vec<u8>)> {
    let rest = authorization?.strip_prefix(SCHEME)?;
    if rest.len() > (HEAD_MAX * 4).div_ceil(3) + 100 {
        return None;
    }
    let (head, sig) = rest.split_once('.')?;
    let head = URL_SAFE_NO_PAD.decode(head).ok()?;
    let sig = URL_SAFE_NO_PAD.decode(sig).ok()?;
    (head.len() <= HEAD_MAX && sig.len() == 64).then_some((head, sig))
}

pub async fn check_call<C: CheckContext>(
    authorization: Option<&str>,
    path: &str,
    body: &[u8],
    c: &mut C,
) -> Result<CallHead, CallError> {
    let (head_bytes, sig) = parts(authorization).ok_or(CallError::Header)?;
    let head = CallHead::decode(head_bytes.as_slice()).map_err(|_| CallError::Header)?;
    let iss = Origin::accept(&head.iss, c.ports())?;
    if head.aud != c.aud() {
        return Err(CallError::Aud);
    }
    if !c.serves(path) {
        return Err(CallError::Unimplemented);
    }
    if head.method != path {
        return Err(CallError::Method);
    }
    if !in_window(head.iat, head.exp, c.now()) {
        return Err(CallError::Time);
    }
    if head.body_len != body.len() as u64 || head.body_sha256 != Sha256::digest(body).as_slice() {
        return Err(CallError::Body);
    }
    if head.jti.len() != JTI_BYTES {
        return Err(CallError::Jti);
    }
    let hello = path == HELLO_METHOD;
    let jti = URL_SAFE_NO_PAD.encode(&head.jti);
    let mut keys = c.cached_keys(&iss);
    if keys.is_none() && !hello {
        return Err(CallError::Kid);
    }
    if hello && keys.as_ref().is_none_or(|set| !set.contains_key(&head.kid)) {
        let now = c.now();
        let stamped = !head.stamp.is_empty() && c.stamp_ok(&head) && c.stamp_once(&jti, now);
        let network = c.network().to_string();
        let fetched = match c.may_fetch(&network, &iss, hello, stamped) {
            Fetch::Ok => c.fetch_keys(&iss).await.ok_or(CallError::Keys),
            Fetch::Busy => Err(CallError::Busy),
            Fetch::StampNeeded => Err(CallError::StampNeeded),
        };
        keys = match (fetched, keys) {
            (Ok(fresh), _) => Some(fresh),
            (Err(_), Some(cached)) => Some(cached),
            (Err(error), None) => return Err(error),
        };
    }
    let key = keys
        .as_ref()
        .and_then(|set| set.get(&head.kid))
        .ok_or(CallError::Kid)?;
    if !verified(key, &[CALL_TAG, &head_bytes].concat(), &sig) {
        return Err(CallError::Forged);
    }
    if !c.seen(&iss, &jti, head.exp) {
        return Err(CallError::Replay);
    }
    let call_kids = match hello {
        true => c.hello_call_kids(),
        false => c.call_kids(&iss),
    };
    match call_kids {
        None => Err(CallError::HelloNeeded),
        Some(kids) if !kids.contains(&head.kid) => Err(CallError::NotCallKey),
        Some(_) => Ok(head),
    }
}

#[derive(Clone, Debug, Default)]
pub struct MemorySeen {
    rows: HashMap<(String, String), i64>,
}

impl MemorySeen {
    pub fn add(&mut self, iss: &str, jti: &str, exp: i64) -> bool {
        let key = (iss.to_string(), jti.to_string());
        if self.rows.contains_key(&key) {
            return false;
        }
        self.rows.insert(key, exp);
        true
    }

    pub fn sweep(&mut self, db_now: i64) {
        self.rows.retain(|_, exp| *exp + JTI_KEEP >= db_now);
    }

    pub fn len(&self) -> usize {
        self.rows.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }
}
