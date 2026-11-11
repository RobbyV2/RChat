use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::SigningKey;
use prost::Message;
use rchat_fed::call::{
    Call, CallError, CheckContext, HELLO_METHOD, KeySet, MemorySeen, SCHEME, Signer, answer_of,
    bare_origin, check_call, sign_call, valid_host,
};
use rchat_fed::connect::Code;
use rchat_fed::guard::{Fetch, KeyFetchGuard};
use rchat_fed::keys::thumbprint;
use rchat_fed::limits;
use rchat_fed::pb::CallHead;

const METHOD: &str = "/rchat.fed.v1.LettersService/Deliver";
const FORWARD: &str = "/rchat.fed.v1.ReportsService/Forward";
const NOW: i64 = 1_800_000_000;
const BODY: [u8; 4] = [1, 2, 3, 4];
const B: &str = "https://b.example";

fn key(n: u8) -> SigningKey {
    SigningKey::from_bytes(&[n; 32])
}

fn kid(n: u8) -> String {
    thumbprint(&key(n).verifying_key().to_bytes())
}

fn keys(ns: &[u8]) -> KeySet {
    ns.iter()
        .map(|n| (kid(*n), key(*n).verifying_key()))
        .collect()
}

fn a() -> Signer {
    Signer {
        key: key(7),
        kid: kid(7),
        origin: "https://a.example".to_string(),
        instance_id: "ia".to_string(),
        hello_rev: 3,
    }
}

fn signed(s: &Signer, method: &str, now: i64) -> String {
    sign_call(
        s,
        &Call {
            aud: B,
            method,
            body: &BODY,
            now,
            jti: [0x11; 16],
            stamp: &[],
        },
    )
    .authorization
}

pub struct Ctx {
    pub aud: String,
    pub now: i64,
    pub network: String,
    pub cached: Option<KeySet>,
    pub served: BTreeMap<String, KeySet>,
    pub may: Option<Fetch>,
    pub guard: KeyFetchGuard,
    pub call_kids: Option<BTreeSet<String>>,
    pub hello_call_kids: Option<BTreeSet<String>>,
    pub seen: Arc<Mutex<MemorySeen>>,
    pub fetched: Vec<String>,
}

impl Ctx {
    pub fn new() -> Ctx {
        Ctx {
            aud: B.to_string(),
            now: NOW,
            network: "198.51.100.0/24".to_string(),
            cached: Some(keys(&[7])),
            served: BTreeMap::from([("https://a.example".to_string(), keys(&[7]))]),
            may: None,
            guard: KeyFetchGuard::default(),
            call_kids: Some(BTreeSet::from([kid(7)])),
            hello_call_kids: None,
            seen: Arc::new(Mutex::new(MemorySeen::default())),
            fetched: Vec::new(),
        }
    }
}

impl CheckContext for Ctx {
    fn aud(&self) -> &str {
        &self.aud
    }
    fn now(&self) -> i64 {
        self.now
    }
    fn serves(&self, path: &str) -> bool {
        [METHOD, HELLO_METHOD, FORWARD].contains(&path)
    }
    fn network(&self) -> &str {
        &self.network
    }
    fn cached_keys(&self, iss: &str) -> Option<KeySet> {
        (iss == "https://a.example")
            .then(|| self.cached.clone())
            .flatten()
    }
    async fn fetch_keys(&mut self, iss: &str) -> Option<KeySet> {
        self.fetched.push(iss.to_string());
        self.served.get(iss).cloned()
    }
    fn may_fetch(&mut self, network: &str, iss: &str, hello: bool, stamped: bool) -> Fetch {
        match self.may {
            Some(fixed) => fixed,
            None => self
                .guard
                .may_fetch(network, iss, hello, stamped, false, NOW),
        }
    }
    fn stamp_ok(&self, head: &CallHead) -> bool {
        !head.stamp.is_empty()
    }
    fn stamp_once(&mut self, _jti: &str, _now: i64) -> bool {
        true
    }
    fn call_kids(&self, _iss: &str) -> Option<BTreeSet<String>> {
        self.call_kids.clone()
    }
    fn hello_call_kids(&self) -> Option<BTreeSet<String>> {
        self.hello_call_kids.clone()
    }
    fn seen(&mut self, iss: &str, jti: &str, exp: i64) -> bool {
        self.seen.lock().unwrap().add(iss, jti, exp)
    }
}

async fn check(auth: &str, path: &str, body: &[u8], c: &mut Ctx) -> Result<CallHead, CallError> {
    check_call(Some(auth), path, body, c).await
}

#[tokio::test]
async fn a_signed_call_checks() {
    let head = check(&signed(&a(), METHOD, NOW), METHOD, &BODY, &mut Ctx::new())
        .await
        .unwrap();
    assert_eq!(head.iss, "https://a.example");
    assert_eq!(head.hello_rev, 3);
}

#[tokio::test]
async fn replay_of_the_same_call_is_refused_on_any_copy_sharing_the_table() {
    let auth = signed(&a(), METHOD, NOW);
    let mut one = Ctx::new();
    let mut two = Ctx::new();
    two.seen = one.seen.clone();
    assert!(check(&auth, METHOD, &BODY, &mut one).await.is_ok());
    assert_eq!(
        check(&auth, METHOD, &BODY, &mut two).await,
        Err(CallError::Replay)
    );
}

#[tokio::test]
async fn the_signature_binds_the_method_audience_and_body() {
    let auth = signed(&a(), METHOD, NOW);
    assert_eq!(
        check(&auth, FORWARD, &BODY, &mut Ctx::new()).await,
        Err(CallError::Method)
    );
    let mut other = Ctx::new();
    other.aud = "https://c.example".to_string();
    assert_eq!(
        check(&auth, METHOD, &BODY, &mut other).await,
        Err(CallError::Aud)
    );
    assert_eq!(
        check(&auth, METHOD, &[1, 2, 3, 5], &mut Ctx::new()).await,
        Err(CallError::Body)
    );
    assert_eq!(
        check(&auth, "/rchat.fed.v1.Nope/X", &BODY, &mut Ctx::new()).await,
        Err(CallError::Unimplemented)
    );
}

#[tokio::test]
async fn the_time_window_is_symmetric_30_s_either_way() {
    for d in [-30, 30] {
        assert!(
            check(
                &signed(&a(), METHOD, NOW + d),
                METHOD,
                &BODY,
                &mut Ctx::new()
            )
            .await
            .is_ok()
        );
    }
    for d in [-31, 31, -90] {
        assert_eq!(
            check(
                &signed(&a(), METHOD, NOW + d),
                METHOD,
                &BODY,
                &mut Ctx::new()
            )
            .await,
            Err(CallError::Time)
        );
    }
    let call = sign_call(
        &a(),
        &Call {
            aud: B,
            method: METHOD,
            body: &BODY,
            now: NOW,
            jti: [0x11; 16],
            stamp: &[],
        },
    );
    let mut head = CallHead::decode(call.head.as_slice()).unwrap();
    head.exp = NOW + 3600;
    let long = format!(
        "{SCHEME}{}.{}",
        URL_SAFE_NO_PAD.encode(head.encode_to_vec()),
        URL_SAFE_NO_PAD.encode([0u8; 64])
    );
    assert_eq!(
        check(&long, METHOD, &BODY, &mut Ctx::new()).await,
        Err(CallError::Time)
    );
    head.exp = i64::MAX;
    head.iat = i64::MIN;
    let wild = format!(
        "{SCHEME}{}.{}",
        URL_SAFE_NO_PAD.encode(head.encode_to_vec()),
        URL_SAFE_NO_PAD.encode([0u8; 64])
    );
    assert_eq!(
        check(&wild, METHOD, &BODY, &mut Ctx::new()).await,
        Err(CallError::Time)
    );
}

#[tokio::test]
async fn a_caller_31_s_fast_that_signs_with_the_skew_it_measured_is_accepted() {
    let caller_clock = NOW + 31;
    let skew = NOW - caller_clock;
    assert_eq!(
        check(
            &signed(&a(), METHOD, caller_clock),
            METHOD,
            &BODY,
            &mut Ctx::new()
        )
        .await,
        Err(CallError::Time)
    );
    assert!(
        check(
            &signed(&a(), METHOD, caller_clock + skew),
            METHOD,
            &BODY,
            &mut Ctx::new()
        )
        .await
        .is_ok()
    );
}

#[tokio::test]
async fn a_forged_call_is_refused_with_401_and_never_reaches_the_replay_table() {
    let forger = Signer { key: key(9), ..a() };
    let mut c = Ctx::new();
    assert_eq!(
        check(&signed(&forger, METHOD, NOW), METHOD, &BODY, &mut c).await,
        Err(CallError::Forged)
    );
    assert_eq!(answer_of(CallError::Forged), (Code::Unauthenticated, 401));
    assert_eq!(c.seen.lock().unwrap().len(), 0);
}

#[tokio::test]
async fn cheap_checks_run_before_any_key_lookup() {
    let victim = Signer {
        origin: "https://victim.example".to_string(),
        ..a()
    };
    let mut c = Ctx::new();
    c.cached = None;
    assert_eq!(
        check(
            &signed(&victim, HELLO_METHOD, NOW - 500),
            HELLO_METHOD,
            &BODY,
            &mut c
        )
        .await,
        Err(CallError::Time)
    );
    assert!(c.fetched.is_empty());
}

#[tokio::test]
async fn uncached_keys_only_a_hello_fetches_within_the_guard() {
    let hello = signed(&a(), HELLO_METHOD, NOW);
    let mut c = Ctx::new();
    c.cached = None;
    c.hello_call_kids = Some(BTreeSet::from([kid(7)]));
    assert!(check(&hello, HELLO_METHOD, &BODY, &mut c).await.is_ok());
    assert_eq!(c.fetched, ["https://a.example"]);

    for (may, error) in [
        (Fetch::Busy, CallError::Busy),
        (Fetch::StampNeeded, CallError::StampNeeded),
    ] {
        let mut c = Ctx::new();
        c.cached = None;
        c.may = Some(may);
        assert_eq!(check(&hello, HELLO_METHOD, &BODY, &mut c).await, Err(error));
        assert!(c.fetched.is_empty());
    }

    let stranger = Signer {
        origin: "https://c.example".to_string(),
        ..a()
    };
    let mut c = Ctx::new();
    c.cached = None;
    assert_eq!(
        check(
            &signed(&stranger, HELLO_METHOD, NOW),
            HELLO_METHOD,
            &BODY,
            &mut c
        )
        .await,
        Err(CallError::Keys)
    );
    assert_eq!(answer_of(CallError::Busy).1, 503);
    assert_eq!(answer_of(CallError::StampNeeded).1, 503);
    assert_eq!(answer_of(CallError::Keys).1, 503);
}

#[tokio::test]
async fn an_ordinary_call_from_a_host_whose_keys_arent_cached_gets_401_with_no_fetch() {
    let mut c = Ctx::new();
    c.cached = None;
    assert_eq!(
        check(&signed(&a(), METHOD, NOW), METHOD, &BODY, &mut c).await,
        Err(CallError::Kid)
    );
    assert!(c.fetched.is_empty());
}

#[tokio::test]
async fn an_unknown_kid_is_refused_without_a_refetch_but_a_hello_may_refetch() {
    let rotated = Signer {
        key: key(8),
        kid: kid(8),
        ..a()
    };
    let both = BTreeSet::from([kid(7), kid(8)]);
    let mut c = Ctx::new();
    c.served = BTreeMap::from([("https://a.example".to_string(), keys(&[7, 8]))]);
    c.call_kids = Some(both.clone());
    c.hello_call_kids = Some(both);
    assert_eq!(
        check(&signed(&rotated, METHOD, NOW), METHOD, &BODY, &mut c).await,
        Err(CallError::Kid)
    );
    assert!(c.fetched.is_empty());
    assert!(
        check(
            &signed(&rotated, HELLO_METHOD, NOW),
            HELLO_METHOD,
            &BODY,
            &mut c
        )
        .await
        .is_ok()
    );
    assert_eq!(c.fetched, ["https://a.example"]);
}

#[tokio::test]
async fn only_call_keys_sign_calls_and_other_calls_need_a_hello_first() {
    let auth = signed(&a(), METHOD, NOW);
    let mut c = Ctx::new();
    c.call_kids = Some(BTreeSet::from(["retired-only".to_string()]));
    assert_eq!(
        check(&auth, METHOD, &BODY, &mut c).await,
        Err(CallError::NotCallKey)
    );
    let mut c = Ctx::new();
    c.call_kids = None;
    assert_eq!(
        check(&auth, METHOD, &BODY, &mut c).await,
        Err(CallError::HelloNeeded)
    );
    assert_eq!(
        answer_of(CallError::HelloNeeded),
        (Code::FailedPrecondition, 400)
    );
}

#[test]
fn only_what_isnt_addressed_to_this_protocol_gets_404_and_calls_not_accepted_get_401() {
    for e in [CallError::Header, CallError::Iss, CallError::Aud] {
        assert_eq!(answer_of(e), (Code::NotFound, 404));
    }
    for e in [
        CallError::Method,
        CallError::Time,
        CallError::Body,
        CallError::Jti,
        CallError::Kid,
        CallError::Forged,
        CallError::Replay,
        CallError::NotCallKey,
    ] {
        assert_eq!(answer_of(e), (Code::Unauthenticated, 401));
    }
    assert_eq!(
        answer_of(CallError::Unimplemented),
        (Code::Unimplemented, 501)
    );
}

#[tokio::test]
async fn malformed_headers() {
    let long = format!("{SCHEME}{}.x", "A".repeat(4000));
    let padded = format!(
        "{SCHEME}{}=.{}",
        URL_SAFE_NO_PAD.encode([1u8]),
        URL_SAFE_NO_PAD.encode([0u8; 64])
    );
    let short_sig = format!("{SCHEME}.{}", URL_SAFE_NO_PAD.encode([0u8; 63]));
    let not_a_head = format!(
        "{SCHEME}{}.{}",
        URL_SAFE_NO_PAD.encode([0x0a, 0x05, 0x01]),
        URL_SAFE_NO_PAD.encode([0u8; 64])
    );
    for header in [
        "Bearer x",
        &format!("{SCHEME}abc"),
        &format!("{SCHEME}a.b.c"),
        &format!("{SCHEME}!!.??"),
        &long,
        &padded,
        &short_sig,
        &not_a_head,
    ] {
        assert_eq!(
            check(header, METHOD, &BODY, &mut Ctx::new()).await,
            Err(CallError::Header),
            "{header}"
        );
    }
    assert_eq!(
        check_call(None, METHOD, &BODY, &mut Ctx::new()).await,
        Err(CallError::Header)
    );
    let empty_head = format!("{SCHEME}.{}", URL_SAFE_NO_PAD.encode([0u8; 64]));
    assert_eq!(
        check(&empty_head, METHOD, &BODY, &mut Ctx::new()).await,
        Err(CallError::Iss)
    );
}

#[tokio::test]
async fn a_head_over_its_limit_is_refused_before_it_is_decoded() {
    let mut head = CallHead {
        iss: "https://a.example".to_string(),
        aud: B.to_string(),
        instance_id: "i".repeat(limits::call::HEAD_MAX),
        ..CallHead::default()
    };
    let over = format!(
        "{SCHEME}{}.{}",
        URL_SAFE_NO_PAD.encode(head.encode_to_vec()),
        URL_SAFE_NO_PAD.encode([0u8; 64])
    );
    assert_eq!(
        check(&over, METHOD, &BODY, &mut Ctx::new()).await,
        Err(CallError::Header)
    );
    head.instance_id = "i".repeat(1900);
    assert!(head.encode_to_vec().len() <= limits::call::HEAD_MAX);
    let under = format!(
        "{SCHEME}{}.{}",
        URL_SAFE_NO_PAD.encode(head.encode_to_vec()),
        URL_SAFE_NO_PAD.encode([0u8; 64])
    );
    assert_eq!(
        check(&under, METHOD, &BODY, &mut Ctx::new()).await,
        Err(CallError::Method)
    );
}

#[tokio::test]
async fn iss_must_be_a_bare_https_origin() {
    for origin in [
        "http://a.example",
        "https://a.example:8443",
        "https://a.example/x",
        "https://A.example",
        "https://",
        "https://a..example",
        "https://.a.example",
        "https://a.example.",
        "https://-a.example",
        "https://a-.example",
        "https://127.0.0.1",
        "https://10.1.2.3",
        "https://a.example.7",
    ] {
        let s = Signer {
            origin: origin.to_string(),
            ..a()
        };
        let mut c = Ctx::new();
        assert_eq!(
            check(&signed(&s, HELLO_METHOD, NOW), HELLO_METHOD, &BODY, &mut c).await,
            Err(CallError::Iss),
            "{origin}"
        );
        assert!(c.fetched.is_empty(), "{origin}");
    }
}

#[test]
fn a_host_is_a_canonical_dns_name_and_never_an_address() {
    for host in [
        "a.example",
        "xn--caf-dma.example",
        "a-b.c-d.example",
        "1a.2b.example",
        "localhost",
        "m1.evil.ts.net",
    ] {
        assert!(valid_host(host), "{host}");
        assert!(bare_origin(&format!("https://{host}")), "{host}");
    }
    let long_label = format!("{}.example", "a".repeat(64));
    let long_host = format!("{}.example", vec!["a".repeat(60); 5].join("."));
    for host in [
        "",
        ".",
        "a..example",
        ".a.example",
        "m1.evil.ts.net.",
        "-a.example",
        "a-.example",
        "A.example",
        "a_b.example",
        "a.example:443",
        "127.0.0.1",
        "1.2.3.4.5",
        "a.example.0",
        "[::1]",
        long_label.as_str(),
        long_host.as_str(),
    ] {
        assert!(!valid_host(host), "{host}");
    }
    assert!(valid_host(&format!("{}.example", "a".repeat(63))));
    assert!(!bare_origin("http://a.example"));
    assert!(!bare_origin("https://a.example/"));
}

#[tokio::test]
async fn a_jti_that_isnt_16_bytes_is_refused() {
    let call = sign_call(
        &a(),
        &Call {
            aud: B,
            method: METHOD,
            body: &BODY,
            now: NOW,
            jti: [0x11; 16],
            stamp: &[],
        },
    );
    let mut head = CallHead::decode(call.head.as_slice()).unwrap();
    head.jti = vec![0x11; 15];
    let auth = format!(
        "{SCHEME}{}.{}",
        URL_SAFE_NO_PAD.encode(head.encode_to_vec()),
        URL_SAFE_NO_PAD.encode(call.sig)
    );
    assert_eq!(
        check(&auth, METHOD, &BODY, &mut Ctx::new()).await,
        Err(CallError::Jti)
    );
}

#[test]
fn replay_rows_are_kept_past_exp_by_the_database_clock() {
    let mut seen = MemorySeen::default();
    assert!(seen.add("https://a.example", "j", NOW + 60));
    seen.sweep(NOW + 60 + limits::call::JTI_KEEP);
    assert_eq!(seen.len(), 1);
    seen.sweep(NOW + 61 + limits::call::JTI_KEEP);
    assert_eq!(seen.len(), 0);
}
