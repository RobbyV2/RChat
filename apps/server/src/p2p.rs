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

// Relay hosts a hoster or caller declares for one file or call, so the other side can ask its
// user before connecting through a relay it doesn't know. Only the host goes here, never a
// port, a username or a credential.
pub const RELAY_HOSTS_MAX: usize = 4;
const RELAY_HOST_MAX: usize = 253;

// A DNS name in ASCII (IDN names in punycode), an IPv4 address or a bracketed IPv6 address,
// lowercased. A name whose last label is all digits must be a dotted-quad IPv4 address, as in
// the client's check.
pub fn relay_host(host: &str) -> Option<String> {
    let host = host.to_ascii_lowercase();
    if host.is_empty() || host.len() > RELAY_HOST_MAX {
        return None;
    }
    if let Some(inner) = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
        return inner.parse::<std::net::Ipv6Addr>().is_ok().then_some(host);
    }
    let label = |l: &str| {
        !l.is_empty()
            && l.len() <= 63
            && !l.starts_with('-')
            && !l.ends_with('-')
            && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    };
    if !host.split('.').all(label) {
        return None;
    }
    let numeric = host
        .rsplit('.')
        .next()
        .is_some_and(|l| l.bytes().all(|b| b.is_ascii_digit()));
    let quad = host.split('.').count() == 4 && host.parse::<std::net::Ipv4Addr>().is_ok();
    (!numeric || quad).then_some(host)
}

// Up to RELAY_HOSTS_MAX distinct valid hosts; anything else is refused.
pub fn relay_hosts(hosts: Vec<String>) -> Result<Vec<String>, String> {
    if hosts.len() > RELAY_HOSTS_MAX {
        return Err("Too many relays".to_string());
    }
    let mut out: Vec<String> = Vec::new();
    for host in hosts {
        let host = relay_host(&host).ok_or_else(|| "Invalid relay host".to_string())?;
        if !out.contains(&host) {
            out.push(host);
        }
    }
    Ok(out)
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

    // The same cases as the client's cleanHost (relays.test.ts).
    const HOSTS: &str = "../web/app/lib/__tests__/fixtures/relay_hosts.json";

    #[test]
    fn relay_hosts_are_plain_hosts_only() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(HOSTS);
        let doc: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).expect("fixture")).expect("json");
        let good = doc["good"].as_array().expect("good");
        let bad = doc["bad"].as_array().expect("bad");
        assert!(good.len() > 10 && bad.len() > 20);
        for case in good {
            let (raw, clean) = (case[0].as_str().expect("raw"), case[1].as_str());
            assert_eq!(relay_host(raw).as_deref(), clean, "{raw}");
        }
        for raw in bad {
            let raw = raw.as_str().expect("bad host");
            assert!(relay_host(raw).is_none(), "{raw}");
        }
        assert_eq!(
            relay_hosts(vec!["a.example".into(), "A.example".into()]).unwrap(),
            vec!["a.example".to_string()]
        );
        assert!(
            relay_hosts(vec![
                "a".into(),
                "b".into(),
                "c".into(),
                "d".into(),
                "e".into()
            ])
            .is_err()
        );
        assert!(relay_hosts(vec!["ok.example".into(), "bad host".into()]).is_err());
        assert!(relay_hosts(Vec::new()).unwrap().is_empty());
    }

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
