use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use rchat_pow::*;
use serde_json::Value;
use sha2::Sha256;

const KEY: &[u8] = b"0123456789abcdef0123456789abcdef";

fn key_of(kid: &str) -> Option<Vec<u8>> {
    (kid == "1").then(|| KEY.to_vec())
}

fn vectors() -> Value {
    serde_json::from_str(include_str!("vectors.json")).unwrap()
}

/// A sealed string made by hand, so its kid can be one `seal` refuses to write.
fn sealed_by_hand(kind: &str, kid: &str, payload: &[u8]) -> String {
    let body = URL_SAFE_NO_PAD.encode(payload);
    let mut m = <Hmac<Sha256> as KeyInit>::new_from_slice(KEY).unwrap();
    m.update(MAC_DOMAIN);
    m.update(format!("{kind}.{kid}.{body}").as_bytes());
    let tag = URL_SAFE_NO_PAD.encode(&m.finalize().into_bytes()[..MAC_LEN]);
    format!("{kind}.{kid}.{body}.{tag}")
}

#[test]
fn a_try_wins_only_below_the_target() {
    let v = vectors();
    let seed = seed_of(v["challenge"].as_str().unwrap());
    let hash = puzzle_hash(&seed, 0, 0);
    let hex: String = hash.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(hex, v["hash_sub0_nonce0_hex"].as_str().unwrap());
    let at = value(&hash);
    assert!(!wins(&seed, 0, 0, at), "a value equal to the target loses");
    assert!(wins(&seed, 0, 0, at + 1));
    assert!(!wins(&seed, 0, 0, 0));
    assert_eq!(solve_chunk(&seed, 0, at, 0, 1), None);
    assert_eq!(solve_chunk(&seed, 0, at + 1, 0, 1), Some(0));
}

#[test]
fn a_sealed_string_over_4096_bytes_is_refused_whatever_its_tag() {
    let any = |_: &str| Some(KEY.to_vec());
    let at_limit = seal(KEY, "t1", "1", &[b'x'; 3051]);
    assert_eq!(at_limit.len(), SEALED_MAX);
    assert_eq!(open(any, "t1", &at_limit), Some(vec![b'x'; 3051]));
    assert_eq!(kid_of("t1", &at_limit), Some("1"));
    let over = seal(KEY, "t1", "1", &[b'x'; 3052]);
    assert_eq!(over.len(), SEALED_MAX + 2);
    assert_eq!(
        open(any, "t1", &over),
        None,
        "its tag is right, its size is not"
    );
    assert_eq!(kid_of("t1", &over), None);
    let long_kid = seal(KEY, "t1", "12345678", &[b'x'; 3046]);
    assert_eq!(long_kid.len(), SEALED_MAX + 1);
    assert_eq!(open(any, "t1", &long_kid), None);
}

#[test]
fn a_kid_that_is_not_1_to_8_digits_is_refused_before_any_key_is_asked() {
    let any = |_: &str| Some(KEY.to_vec());
    let good = sealed_by_hand("t1", "1", b"{}");
    assert_eq!(good, seal(KEY, "t1", "1", b"{}"));
    assert_eq!(open(any, "t1", &good), Some(b"{}".to_vec()));
    for kid in ["0x1", "", "123456789", "-1", "1 ", "\u{661}", "1e1"] {
        let forged = sealed_by_hand("t1", kid, b"{}");
        assert_eq!(open(any, "t1", &forged), None, "{kid:?}");
        assert_eq!(kid_of("t1", &forged), None, "{kid:?}");
    }
    let asked = std::cell::Cell::new(false);
    let watching = |_: &str| {
        asked.set(true);
        Some(KEY.to_vec())
    };
    assert_eq!(
        open(watching, "t1", &sealed_by_hand("t1", "0x1", b"{}")),
        None
    );
    assert!(!asked.get());
    assert_eq!(open(key_of, "t1", &sealed_by_hand("t1", "2", b"{}")), None);
}

#[test]
fn a_client_id_with_stray_trailing_bits_is_refused() {
    assert!(client_id_ok("AAECAwQFBgcICQoLDA0ODw"));
    for id in [
        "AAECAwQFBgcICQoLDA0ODx",
        "AAECAwQFBgcICQoLDA0ODz",
        "AAECAwQFBgcICQoLDA0OD_",
    ] {
        assert!(!client_id_ok(id), "{id}");
    }
    for last in ["A", "Q", "g", "w"] {
        assert!(client_id_ok(&format!("AAECAwQFBgcICQoLDA0OD{last}")));
    }
}

#[test]
fn a_solution_has_at_most_64_sub_puzzles() {
    let seed = seed_of("c1.1.edges");
    assert!(verify(&seed, 64, u64::MAX, &[0; 64]));
    assert!(!verify(&seed, 65, u64::MAX, &[0; 65]));
    assert!(!verify(&seed, 64, u64::MAX, &[0; 65]));
    assert_eq!(decode_nonces(&"0".repeat(16 * 64), 64), Some(vec![0; 64]));
    assert_eq!(decode_nonces(&"0".repeat(16 * 65), 65), None);
    assert_eq!(decode_nonces("", u32::MAX), None);
}

#[test]
fn a_range_up_to_the_last_byte_is_priced_at_the_cap() {
    let max = u64::MAX;
    for (header, bytes) in [
        (format!("bytes=0-{max}"), BULK_PART_MAX),
        (format!("bytes=1-{max}"), BULK_PART_MAX),
        (format!("bytes={max}-{max}"), 1),
        (format!("bytes={}-{max}", max - 9), 10),
        (format!("bytes=-{max}"), BULK_PART_MAX),
        ("bytes=0-18446744073709551616".to_string(), BULK_PART_MAX),
        (
            "bytes=18446744073709551616-18446744073709551617".to_string(),
            BULK_PART_MAX,
        ),
    ] {
        assert_eq!(
            BulkAsk::range(Some(&header)),
            BulkAsk::MediaRange { bytes },
            "{header}"
        );
    }
}

#[test]
fn prices_and_lives_never_overflow() {
    assert_eq!(BulkAsk::Page { messages: i64::MAX }.cost(), u32::MAX);
    assert_eq!(BulkAsk::Page { messages: i64::MIN }.cost(), 0);
    assert_eq!(BulkAsk::Page { messages: 5000 }.cost(), 50);
    assert_eq!(BulkAsk::MediaRange { bytes: u64::MAX }.cost(), u32::MAX);
    assert_eq!(BulkAsk::Changes { scopes: usize::MAX }.cost(), u32::MAX);
    assert_eq!(life_secs(u64::MAX, 1), u64::MAX);
    assert_eq!(life_secs(u64::MAX, 0), u64::MAX);
    assert_eq!(life_secs(u64::MAX, u64::MAX), 301);
    assert_eq!(work_with_load(1, u32::MAX, u32::MAX, 1, u64::MAX), None);
    assert_eq!(
        work_with_load(1024, 8, u32::MAX, 8, 4096),
        Some(4096),
        "any load ends at the cap"
    );
    let mut spent = SpentSet::default();
    assert!(spent.spend("r", u64::MAX, 0));
    assert!(
        !spent.spend("r", u64::MAX, u64::MAX),
        "held past the last second"
    );
    assert!(spent.spend("s", u64::MAX - 40, u64::MAX - 10));
    assert!(
        spent.spend("s", 0, u64::MAX),
        "forgotten 30 seconds after its challenge"
    );
}

#[test]
fn the_half_step_of_work_uses_the_exact_root() {
    assert_eq!(work_for(1 << 20, 4, 8, u64::MAX), Some(1_482_910));
    assert_eq!(work_for(1_051_151, 4, 8, u64::MAX), Some(1_486_552));
}
