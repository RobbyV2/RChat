use std::collections::BTreeSet;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::SigningKey;
use prost::Message;
use rchat_fed::call::{
    Call, CallError, CheckContext, HELLO_METHOD, KeySet, MemorySeen, SCHEME, Signer, check_call,
    sign_call,
};
use rchat_fed::guard::{Fetch, KeyFetchGuard};
use rchat_fed::keys::thumbprint;
use rchat_fed::pb::CallHead;
use rchat_fed::stamp::{StampSeen, stamp_for, stamp_ok, target};

const WORK: u64 = 64;
const K: usize = 4;
const NOW: i64 = 1_800_000_000;

#[test]
fn targets_match_the_rchat_pow1_vectors() {
    assert_eq!(target(16, 1 << 20), 1 << 48);
    assert_eq!(target(16, 1 << 24), 17_592_186_044_416);
    assert_eq!(target(1, 1), u64::MAX);
    assert_eq!(target(16, 0), u64::MAX);
    assert_eq!(target(1, u64::MAX), 1);
}

#[test]
fn a_stamp_is_bound_to_the_callee_the_callers_name_the_jti_and_the_time() {
    let jti = [3u8; 16];
    let stamp = stamp_for("https://b.example", "https://a.example", &jti, NOW, WORK, K);
    let head = || CallHead {
        aud: "https://b.example".to_string(),
        iss: "https://a.example".to_string(),
        jti: jti.to_vec(),
        iat: NOW,
        stamp: stamp.clone(),
        ..CallHead::default()
    };
    assert!(stamp_ok(&head(), WORK, K));
    assert!(!stamp_ok(
        &CallHead {
            aud: "https://c.example".to_string(),
            ..head()
        },
        WORK,
        K
    ));
    assert!(!stamp_ok(
        &CallHead {
            iss: "https://h2.attacker.net".to_string(),
            ..head()
        },
        WORK,
        K
    ));
    assert!(!stamp_ok(
        &CallHead {
            jti: vec![4; 16],
            ..head()
        },
        WORK,
        K
    ));
    assert!(!stamp_ok(
        &CallHead {
            iat: NOW + 1,
            ..head()
        },
        WORK,
        K
    ));
    assert!(!stamp_ok(
        &CallHead {
            stamp: stamp[..stamp.len() - 8].to_vec(),
            ..head()
        },
        WORK,
        K
    ));
    assert!(!stamp_ok(&head(), 1 << 40, K));
}

#[test]
fn a_stamped_jti_buys_one_fetch_for_90_seconds() {
    let mut seen = StampSeen::default();
    assert!(seen.once("j", NOW));
    assert!(!seen.once("j", NOW + 89));
    assert!(seen.once("other", NOW + 89));
    assert!(seen.once("j", NOW + 90));
}

struct Victim {
    guard: KeyFetchGuard,
    stamps: StampSeen,
    seen: MemorySeen,
    fetches: usize,
}

impl CheckContext for Victim {
    fn aud(&self) -> &str {
        "https://victim.example"
    }
    fn now(&self) -> i64 {
        NOW
    }
    fn serves(&self, path: &str) -> bool {
        path == HELLO_METHOD
    }
    fn network(&self) -> &str {
        "attacker-net"
    }
    fn cached_keys(&self, _iss: &str) -> Option<KeySet> {
        None
    }
    async fn fetch_keys(&mut self, _iss: &str) -> Option<KeySet> {
        self.fetches += 1;
        None
    }
    fn may_fetch(&mut self, network: &str, iss: &str, hello: bool, stamped: bool) -> Fetch {
        self.guard
            .may_fetch(network, iss, hello, stamped, false, NOW)
    }
    fn stamp_ok(&self, head: &CallHead) -> bool {
        stamp_ok(head, WORK, K)
    }
    fn stamp_once(&mut self, jti: &str, now: i64) -> bool {
        self.stamps.once(jti, now)
    }
    fn call_kids(&self, _iss: &str) -> Option<BTreeSet<String>> {
        None
    }
    fn hello_call_kids(&self) -> Option<BTreeSet<String>> {
        None
    }
    fn seen(&mut self, iss: &str, jti: &str, exp: i64) -> bool {
        self.seen.add(iss, jti, exp)
    }
}

#[tokio::test]
async fn one_stamp_many_hellos_and_many_iss_names_buys_at_most_one_key_fetch() {
    let key = SigningKey::from_bytes(&[5; 32]);
    let kid = thumbprint(&key.verifying_key().to_bytes());
    let mut victim = Victim {
        guard: KeyFetchGuard::default(),
        stamps: StampSeen::default(),
        seen: MemorySeen::default(),
        fetches: 0,
    };
    for n in 0..12 {
        for i in 0..5 {
            victim.guard.may_fetch(
                &format!("n{n}"),
                &format!("https://w{n}-{i}.x.net"),
                true,
                false,
                false,
                NOW,
            );
        }
    }
    let jti = [7u8; 16];
    let stamp = stamp_for(
        "https://victim.example",
        "https://h0.attacker.net",
        &jti,
        NOW,
        WORK,
        K,
    );
    let mut results = Vec::new();
    for i in 0..700 {
        let signer = Signer {
            key: key.clone(),
            kid: kid.clone(),
            origin: format!("https://h{}.attacker.net", if i % 2 == 0 { 0 } else { i }),
            instance_id: "x".to_string(),
            hello_rev: 1,
        };
        let call = sign_call(
            &signer,
            &Call {
                aud: "https://victim.example",
                method: HELLO_METHOD,
                body: &[],
                now: NOW,
                jti,
                stamp: &[],
            },
        );
        let mut head = CallHead::decode(call.head.as_slice()).unwrap();
        head.stamp = stamp.clone();
        let auth = format!(
            "{SCHEME}{}.{}",
            URL_SAFE_NO_PAD.encode(head.encode_to_vec()),
            URL_SAFE_NO_PAD.encode(call.sig)
        );
        if let Err(error) = check_call(Some(&auth), HELLO_METHOD, &[], &mut victim).await {
            results.push(error);
        }
    }
    assert_eq!(victim.fetches, 1);
    assert_eq!(results.len(), 700);
    assert_eq!(results.iter().filter(|r| **r == CallError::Keys).count(), 1);
    assert!(results.iter().all(|r| matches!(
        r,
        CallError::StampNeeded | CallError::Busy | CallError::Keys
    )));
    assert!(
        results
            .iter()
            .filter(|r| **r == CallError::StampNeeded)
            .count()
            > 300
    );
    assert_eq!(
        victim
            .guard
            .may_fetch("honest", "https://new.honest.org", true, true, false, NOW),
        Fetch::Ok
    );
}

#[test]
fn a_signed_head_carries_the_stamp_it_was_given() {
    let key = SigningKey::from_bytes(&[5; 32]);
    let signer = Signer {
        kid: thumbprint(&key.verifying_key().to_bytes()),
        key,
        origin: "https://a.example".to_string(),
        instance_id: "x".to_string(),
        hello_rev: 1,
    };
    let jti = [9u8; 16];
    let stamp = stamp_for("https://b.example", "https://a.example", &jti, NOW, WORK, K);
    let call = sign_call(
        &signer,
        &Call {
            aud: "https://b.example",
            method: HELLO_METHOD,
            body: &[],
            now: NOW,
            jti,
            stamp: &stamp,
        },
    );
    let head = CallHead::decode(call.head.as_slice()).unwrap();
    assert!(stamp_ok(&head, WORK, K));
}
