// Short-lived tokens for P2P downloads. The server gives one to a user who can read a message
// with a P2P attachment, together with the hoster's peer id. The hoster's app checks it before
// it sends any bytes. Each hoster gets a key derived from the instance secret, its username and
// its current peer id, so any replica can sign and the hoster can check without asking the
// server. A new peer id gives a new key.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

// How long a token stays valid, in seconds: enough to connect through a relay.
pub const TOKEN_TTL: i64 = 120;
const PEER_ID_MAX: usize = 64;

fn mac(key: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(key).expect("hmac takes any key");
    for part in parts {
        mac.update(part);
    }
    mac.finalize().into_bytes().into()
}

// A PeerJS id as this app makes them: letters, digits, `-` and `_`.
pub fn valid_peer_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= PEER_ID_MAX
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn host_key(secret: &str, hoster: &str, peer_id: &str) -> [u8; 32] {
    mac(
        secret.as_bytes(),
        &[
            b"rchat-p2p-host\0",
            hoster.as_bytes(),
            b"\0",
            peer_id.as_bytes(),
        ],
    )
}

// What a token allows: `requester`, connecting from `requester_peer`, may fetch the file `p2p_id`
// of message `message_id` from `hoster` at `hoster_peer`, until `exp` (unix seconds).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Grant {
    pub v: u8,
    #[serde(rename = "m")]
    pub message_id: i64,
    #[serde(rename = "f")]
    pub p2p_id: String,
    #[serde(rename = "r")]
    pub requester: String,
    #[serde(rename = "h")]
    pub hoster: String,
    #[serde(rename = "hp")]
    pub hoster_peer: String,
    #[serde(rename = "rp")]
    pub requester_peer: String,
    pub exp: i64,
}

// `payload.signature`, both base64url: the payload is the grant as JSON, the signature is
// HMAC-SHA256 over the payload text with the hoster's key.
pub fn issue(secret: &str, grant: &Grant) -> String {
    let key = host_key(secret, &grant.hoster, &grant.hoster_peer);
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(grant).expect("grant serializes"));
    let sig = mac(&key, &[payload.as_bytes()]);
    format!("{payload}.{}", URL_SAFE_NO_PAD.encode(sig))
}

// The hoster's check (app/lib/p2p.ts does the same): a good signature, version 1, not expired.
pub fn verify(key: &[u8; 32], token: &str, now: i64) -> Option<Grant> {
    let (payload, sig) = token.split_once('.')?;
    let sig = URL_SAFE_NO_PAD.decode(sig).ok()?;
    let mut check = <Hmac<Sha256> as KeyInit>::new_from_slice(key).ok()?;
    check.update(payload.as_bytes());
    check.verify_slice(&sig).ok()?;
    let grant: Grant = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).ok()?).ok()?;
    (grant.v == 1 && grant.exp > now).then_some(grant)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grant() -> Grant {
        Grant {
            v: 1,
            message_id: 7,
            p2p_id: "f".repeat(32),
            requester: "bob".to_string(),
            hoster: "alice".to_string(),
            hoster_peer: "peer-a".to_string(),
            requester_peer: "peer-b".to_string(),
            exp: 1_000,
        }
    }

    #[test]
    fn tokens_are_checked_with_the_hosters_key_until_they_expire() {
        let token = issue("secret", &grant());
        let key = host_key("secret", "alice", "peer-a");
        assert_eq!(verify(&key, &token, 999), Some(grant()));
        assert_eq!(verify(&key, &token, 1_000), None, "expired");
        for other in [
            host_key("other", "alice", "peer-a"),
            host_key("secret", "mallory", "peer-a"),
            host_key("secret", "alice", "peer-x"),
        ] {
            assert_eq!(verify(&other, &token, 0), None, "another key");
        }
        let (payload, sig) = token.split_once('.').expect("two parts");
        let mut forged = grant();
        forged.requester = "mallory".to_string();
        let forged_payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&forged).expect("json"));
        assert_eq!(verify(&key, &format!("{forged_payload}.{sig}"), 0), None);
        assert_eq!(verify(&key, payload, 0), None);
        assert_eq!(verify(&key, "", 0), None);
        let mut old = grant();
        old.v = 2;
        assert_eq!(verify(&key, &issue("secret", &old), 0), None);
        assert_ne!(
            host_key("secret", "alice", "peer-a"),
            host_key("secret", "alice\0peer", "-a"),
            "fields are kept apart"
        );
    }

    // The same vector is checked by the app in apps/web/app/lib/__tests__/p2p_serve.test.ts.
    #[test]
    fn tokens_match_the_vector_the_app_checks() {
        let grant = Grant {
            exp: 4_102_444_800,
            ..grant()
        };
        assert_eq!(
            hex::encode(host_key("secret", "alice", "peer-a")),
            "41c3150761935a54207ccffc105ef1bf167f5fbabe7a3a57e54d0a2aaeeb9d04"
        );
        assert_eq!(issue("secret", &grant), VECTOR);
    }

    const VECTOR: &str = "eyJ2IjoxLCJtIjo3LCJmIjoiZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmYiLCJyIjoiYm9iIiwiaCI6ImFsaWNlIiwiaHAiOiJwZWVyLWEiLCJycCI6InBlZXItYiIsImV4cCI6NDEwMjQ0NDgwMH0.L7mKruWXwN9UL2xjXyqzUCW88A_LJAfvWoJzRpWiLfo";

    #[test]
    fn peer_ids_are_short_plain_names() {
        assert!(valid_peer_id(&"a".repeat(32)));
        assert!(valid_peer_id("peer-a_1"));
        for bad in ["", "a b", "a\0b", "ä", &"a".repeat(65)] {
            assert!(!valid_peer_id(bad), "{bad:?}");
        }
    }
}
