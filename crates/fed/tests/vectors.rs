use std::collections::BTreeSet;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::SigningKey;
use prost::Message;
use rchat_fed::call::{Call, CheckContext, KeySet, MemorySeen, Signer, check_call, sign_call};
use rchat_fed::guard::Fetch;
use rchat_fed::ids::letter_id;
use rchat_fed::keys::{endorse, endorsement_ok, hello_proof, hello_proof_ok, thumbprint};
use rchat_fed::pb::{
    CallHead, DeliverRequest, Delivery, FeatureLevel, FeaturePolicy, Hello, HelloAnswer,
    HelloRequest, HelloResponse, KeyEndorsement, LetterCore, LetterEntry, LetterKind, LetterObject,
    Policy, ServiceBudget, Via, letter_entry::Who,
};
use serde_json::Value;

const DELIVER: &str = "/rchat.fed.v1.LettersService/Deliver";
const A: &str = "https://a.example";
const B: &str = "https://b.example";
const INSTANCE: &str = "00112233445566778899aabbccddeeff";

fn file() -> Value {
    serde_json::from_str(include_str!("vectors/fed.json")).unwrap()
}

fn text(v: &Value, path: &[&str]) -> String {
    path.iter()
        .fold(v, |at, key| &at[*key])
        .as_str()
        .unwrap()
        .to_string()
}

fn bytes(v: &Value, path: &[&str]) -> Vec<u8> {
    hex::decode(text(v, path)).unwrap()
}

fn key() -> SigningKey {
    SigningKey::from_bytes(&[7; 32])
}

fn kid() -> String {
    thumbprint(&key().verifying_key().to_bytes())
}

fn signer() -> Signer {
    Signer {
        key: key(),
        kid: kid(),
        origin: A.to_string(),
        instance_id: INSTANCE.to_string(),
        hello_rev: 1,
    }
}

fn core() -> Vec<u8> {
    LetterCore {
        v: 1,
        kind: LetterKind::Message as i32,
        author: "alice@a.example".to_string(),
        uid: "u1".to_string(),
        to: vec![LetterEntry {
            who: Some(Who::Acct("bob@b.example".to_string())),
        }],
        subject: "Q3 plan".to_string(),
        body: "Hello".to_string(),
        ts: 1_800_000_000_000,
        salt: vec![1; 16],
        ..LetterCore::default()
    }
    .encode_to_vec()
}

fn body() -> Vec<u8> {
    let core = core();
    let id = letter_id(&core);
    DeliverRequest {
        objects: vec![LetterObject {
            id: id.clone(),
            core,
            ..LetterObject::default()
        }],
        rcpt: vec![Delivery {
            to: "bob".to_string(),
            via: Via::To as i32,
            object: id,
            ..Delivery::default()
        }],
        ..DeliverRequest::default()
    }
    .encode_to_vec()
}

#[test]
fn the_key_vector_gives_its_public_key_and_thumbprint() {
    let v = file();
    assert_eq!(bytes(&v, &["key", "seed"]), [7u8; 32]);
    assert_eq!(
        URL_SAFE_NO_PAD.encode(key().verifying_key().to_bytes()),
        text(&v, &["key", "public"])
    );
    assert_eq!(kid(), text(&v, &["key", "kid"]));
}

#[test]
fn the_letter_core_and_its_id_are_the_models() {
    let v = file();
    assert_eq!(core(), bytes(&v, &["letter", "core"]));
    assert_eq!(
        letter_id(&bytes(&v, &["letter", "core"])),
        text(&v, &["letter", "id"])
    );
}

#[test]
fn the_signed_call_is_the_models_head_signature_and_authorization() {
    let v = file();
    assert_eq!(body(), bytes(&v, &["call", "body"]));
    let call = sign_call(
        &signer(),
        &Call {
            aud: B,
            method: DELIVER,
            body: &body(),
            now: v["call"]["now"].as_i64().unwrap(),
            jti: [0x11; 16],
            stamp: &[],
        },
    );
    assert_eq!(call.head, bytes(&v, &["call", "head"]));
    assert_eq!(call.sig.to_vec(), bytes(&v, &["call", "sig"]));
    assert_eq!(call.authorization, text(&v, &["call", "authorization"]));
}

struct Callee {
    keys: KeySet,
    now: i64,
    seen: MemorySeen,
}

impl CheckContext for Callee {
    fn aud(&self) -> &str {
        B
    }
    fn now(&self) -> i64 {
        self.now
    }
    fn serves(&self, path: &str) -> bool {
        path == DELIVER
    }
    fn network(&self) -> &str {
        "n"
    }
    fn cached_keys(&self, _iss: &str) -> Option<KeySet> {
        Some(self.keys.clone())
    }
    async fn fetch_keys(&mut self, _iss: &str) -> Option<KeySet> {
        Some(self.keys.clone())
    }
    fn may_fetch(&mut self, _network: &str, _iss: &str, _hello: bool, _stamped: bool) -> Fetch {
        Fetch::Ok
    }
    fn stamp_ok(&self, _head: &CallHead) -> bool {
        false
    }
    fn stamp_once(&mut self, _jti: &str, _now: i64) -> bool {
        false
    }
    fn call_kids(&self, _iss: &str) -> Option<BTreeSet<String>> {
        Some(self.keys.keys().cloned().collect())
    }
    fn hello_call_kids(&self) -> Option<BTreeSet<String>> {
        None
    }
    fn seen(&mut self, iss: &str, jti: &str, exp: i64) -> bool {
        self.seen.add(iss, jti, exp)
    }
}

#[tokio::test]
async fn the_vector_call_checks_and_carries_its_objects_as_the_bytes_sent() {
    let v = file();
    let mut callee = Callee {
        keys: KeySet::from([(kid(), key().verifying_key())]),
        now: v["call"]["now"].as_i64().unwrap(),
        seen: MemorySeen::default(),
    };
    let body = bytes(&v, &["call", "body"]);
    let head = check_call(
        Some(&text(&v, &["call", "authorization"])),
        DELIVER,
        &body,
        &mut callee,
    )
    .await
    .unwrap();
    assert_eq!(head.iss, A);
    assert_eq!(head.instance_id, INSTANCE);
    let request = DeliverRequest::decode(body.as_slice()).unwrap();
    assert_eq!(request.objects[0].core, bytes(&v, &["letter", "core"]));
    assert_eq!(
        letter_id(&request.objects[0].core),
        text(&v, &["letter", "id"])
    );
    assert_eq!(request.objects[0].id, request.rcpt[0].object);
}

#[test]
fn the_hello_request_with_its_rotation_statement_is_the_models() {
    let v = file();
    let key2 = SigningKey::from_bytes(&[8; 32]);
    let kid2 = thumbprint(&key2.verifying_key().to_bytes());
    assert_eq!(kid2, text(&v, &["hello", "rotated_kid"]));
    let at = 1_799_990_000;
    let level = |name: &str| FeatureLevel {
        name: name.to_string(),
        level: 1,
        min: 1,
    };
    let request = HelloRequest {
        caller: Some(Hello {
            software: "rchat".to_string(),
            version: "0.9.0".to_string(),
            instance_id: INSTANCE.to_string(),
            origin: A.to_string(),
            name: "Alpha".to_string(),
            majors: vec![1],
            features: vec![level("core"), level("letters")],
            rev: 1,
            call_kids: vec![kid2.clone()],
            endorsements: vec![KeyEndorsement {
                new_kid: kid2.clone(),
                at,
                by_kid: kid(),
                sig: endorse(&key(), &kid2, at, A).to_vec(),
            }],
            budgets: vec![ServiceBudget {
                service: "letters".to_string(),
                calls_per_minute: 600,
            }],
            ..Hello::default()
        }),
    };
    assert_eq!(request.encode_to_vec(), bytes(&v, &["hello", "request"]));

    let read = HelloRequest::decode(bytes(&v, &["hello", "request"]).as_slice()).unwrap();
    let caller = read.caller.unwrap();
    let KeyEndorsement {
        new_kid,
        at,
        by_kid,
        sig,
    } = &caller.endorsements[0];
    assert_eq!(*by_kid, kid());
    assert_eq!(*new_kid, kid2);
    let public = key().verifying_key();
    assert!(endorsement_ok(&public, new_kid, *at, A, sig));
    assert!(!endorsement_ok(&public, new_kid, *at, B, sig));
}

#[test]
fn the_hello_answer_is_the_models_and_its_proof_covers_the_answer_bytes() {
    let v = file();
    let jti = bytes(&v, &["hello", "proof_jti"]);
    let answer = HelloAnswer {
        callee: None,
        policy: vec![FeaturePolicy {
            name: "letters".to_string(),
            policy: Policy::Accepted as i32,
        }],
        now: 1_800_000_000,
    }
    .encode_to_vec();
    let response = HelloResponse {
        proof: hello_proof(&key(), &jti, B, &answer).to_vec(),
        proof_kid: kid(),
        answer,
    };
    assert_eq!(response.encode_to_vec(), bytes(&v, &["hello", "response"]));

    let read = HelloResponse::decode(bytes(&v, &["hello", "response"]).as_slice()).unwrap();
    let public = key().verifying_key();
    assert_eq!(read.proof_kid, kid());
    assert!(hello_proof_ok(&public, &jti, B, &read.answer, &read.proof));
    let mut longer = read.answer.clone();
    longer.push(0);
    assert!(!hello_proof_ok(&public, &jti, B, &longer, &read.proof));
    let decoded = HelloAnswer::decode(read.answer.as_slice()).unwrap();
    assert_eq!(decoded.now, 1_800_000_000);
    assert_eq!(decoded.policy[0].policy, Policy::Accepted as i32);
}

#[test]
fn signed_objects_pass_through_a_decode_as_the_bytes_that_arrived() {
    let v = file();
    let newer_core = [
        bytes(&v, &["letter", "core"]),
        vec![0xc2, 0x02, 0x05, b'l', b'a', b't', b'e', b'r'],
    ]
    .concat();
    let request = DeliverRequest {
        objects: vec![LetterObject {
            id: letter_id(&newer_core),
            core: newer_core.clone(),
            seal: vec![9, 9, 9],
            ..LetterObject::default()
        }],
        ..DeliverRequest::default()
    };
    let arrived = DeliverRequest::decode(request.encode_to_vec().as_slice()).unwrap();
    assert_eq!(arrived.objects[0].core, newer_core);
    assert_eq!(arrived.objects[0].seal, [9, 9, 9]);
    assert_eq!(letter_id(&arrived.objects[0].core), arrived.objects[0].id);
    let reread = LetterCore::decode(arrived.objects[0].core.as_slice()).unwrap();
    assert_ne!(reread.encode_to_vec(), newer_core);
    let served = DeliverRequest {
        objects: arrived.objects.clone(),
        ..DeliverRequest::default()
    };
    let again = DeliverRequest::decode(served.encode_to_vec().as_slice()).unwrap();
    assert_eq!(again.objects[0].core, newer_core);
}
