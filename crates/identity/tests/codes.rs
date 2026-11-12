use hmac::{Hmac, KeyInit, Mac};
use rchat_identity::codes::{
    RECOVERY_ALPHABET, RECOVERY_COUNT, RECOVERY_LEN, RECOVERY_LOW, SecretKind, TokenKind,
    USER_CODE_ALPHABET, USER_CODE_LEN, clean_recovery, clean_user_code, new_recovery_code,
    new_recovery_codes, new_secret, new_user_code, recovery_bits, recovery_code_from, recovery_key,
    recovery_key_matches, secret_kind_of, user_code_bits, user_code_from, user_code_key,
};
use sha2::Sha256;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn recovery_codes_shape_entropy_cleaning() {
    for _ in 0..200 {
        let c = new_recovery_code();
        assert_eq!(c.len(), 11);
        assert_eq!(c.as_bytes()[5], b'-');
        assert!(
            c.chars()
                .filter(|ch| *ch != '-')
                .all(|ch| RECOVERY_ALPHABET.contains(ch))
        );
        assert_eq!(
            clean_recovery(&c.to_uppercase().replace('-', " ")),
            Some(c.replace('-', ""))
        );
    }
    assert!(recovery_bits() > 49.0);
    assert_eq!(clean_recovery("abcde-fgh1k"), None);
    assert_eq!(clean_recovery("abcde-fghj"), None);
    assert!(!RECOVERY_ALPHABET.contains(['0', '1', 'i', 'l', 'o']));
    assert_eq!((RECOVERY_COUNT, RECOVERY_LEN, RECOVERY_LOW), (10, 10, 2));
}

#[test]
fn a_set_of_recovery_codes_is_ten_different_ones() {
    let set = new_recovery_codes();
    assert_eq!(set.len(), RECOVERY_COUNT);
    let mut unique = set.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(unique.len(), RECOVERY_COUNT);
}

#[test]
fn recovery_code_keys_are_per_account_and_per_pepper() {
    let p = [7u8; 32];
    let a = recovery_key(&p, 1, "abcdefghjk");
    assert!(a.starts_with("r1:") && a.len() == 67);
    assert_ne!(recovery_key(&p, 2, "abcdefghjk"), a);
    assert_ne!(recovery_key(&[8u8; 32], 1, "abcdefghjk"), a);
    let mut mac = Hmac::<Sha256>::new_from_slice(&p).unwrap();
    mac.update(b"rchat-recovery-code1\x001\x00abcdefghjk");
    assert_eq!(a, format!("r1:{}", hex(&mac.finalize().into_bytes())));
    assert!(recovery_key_matches(&a, &p, 1, "abcdefghjk"));
    assert!(!recovery_key_matches(&a, &p, 1, "abcdefghjj"));
    assert!(!recovery_key_matches(&a, &p, 2, "abcdefghjk"));
    assert!(!recovery_key_matches("", &p, 1, "abcdefghjk"));
}

#[test]
fn device_user_codes_follow_rfc_8628_6_1() {
    for _ in 0..200 {
        let c = new_user_code();
        assert_eq!(c.len(), 9);
        assert_eq!(c.as_bytes()[4], b'-');
        assert!(
            c.chars()
                .filter(|ch| *ch != '-')
                .all(|ch| USER_CODE_ALPHABET.contains(ch))
        );
    }
    assert_eq!(clean_user_code("wdjb mjht").as_deref(), Some("WDJBMJHT"));
    assert_eq!(clean_user_code("WDJB-MJHA"), None);
    assert_eq!(clean_user_code("WDJB-MJH"), None);
    assert!((user_code_bits() - 34.57).abs() < 0.05);
    assert_eq!(USER_CODE_ALPHABET.len(), 20);
    assert_eq!(USER_CODE_LEN, 8);
    let key = user_code_key(&[0u8; 32], "WDJBMJHT");
    assert!(key.starts_with("u1:") && key.len() == 67);
    assert!(key[3..].bytes().all(|b| b.is_ascii_hexdigit()));
}

#[test]
fn a_fixed_random_source_gives_a_fixed_code_no_modulo_bias_path() {
    let seq = |buf: &mut [u8]| {
        for (i, b) in buf.iter_mut().enumerate() {
            *b = ((i * 37) % 256) as u8;
        }
    };
    assert_eq!(recovery_code_from(seq), recovery_code_from(seq));
    assert_eq!(recovery_code_from(seq), "28emt-z75bh");
    assert_eq!(user_code_from(seq), user_code_from(seq));
    assert_eq!(user_code_from(seq), "BWSP-LHDF");
    let high = |buf: &mut [u8]| buf.fill(255);
    let mut calls = 0;
    let mixed = |buf: &mut [u8]| {
        calls += 1;
        match calls {
            1 => high(buf),
            _ => buf.fill(0),
        }
    };
    assert_eq!(recovery_code_from(mixed), "22222-22222");
}

#[test]
fn prefixed_secrets_route_to_one_table() {
    assert_eq!(secret_kind_of(&"a".repeat(64)), Some(TokenKind::Session));
    for k in SecretKind::ALL {
        let s = new_secret(k);
        assert_eq!(s.len(), 4 + 43);
        assert_eq!(secret_kind_of(&s), Some(TokenKind::Secret(k)));
    }
    assert_eq!(
        SecretKind::ALL.map(SecretKind::prefix),
        [
            "rca_", "rcr_", "rcp_", "rcx_", "rcd_", "rcs_", "rct_", "rck_"
        ]
    );
    assert_eq!(secret_kind_of("rca_short"), None);
    assert_eq!(secret_kind_of(&"A".repeat(64)), None);
    assert_eq!(secret_kind_of(&format!("rca_{}", "é".repeat(43))), None);
    assert_ne!(
        new_secret(SecretKind::Access),
        new_secret(SecretKind::Access)
    );
}
