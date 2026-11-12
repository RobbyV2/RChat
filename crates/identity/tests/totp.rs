use rchat_identity::totp::{
    Algo, DIGITS, Secret, Verdict, base32_decode, base32_encode, clean_code, grouped_key, hotp,
    issuer_label, otpauth_uri, step_at, totp, verify,
};

const RFC_KEY: &[u8] = b"12345678901234567890";

fn code(counter: i64) -> String {
    hotp(RFC_KEY, counter as u64, DIGITS, Algo::Sha1)
}

#[test]
fn rfc_4226_appendix_d() {
    let want = [
        "755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871",
        "520489",
    ];
    for (i, c) in want.iter().enumerate() {
        assert_eq!(hotp(RFC_KEY, i as u64, DIGITS, Algo::Sha1), *c);
    }
}

#[test]
fn rfc_6238_appendix_b_sha1_8_digits() {
    let rows: [(i64, &str); 6] = [
        (59, "94287082"),
        (1111111109, "07081804"),
        (1111111111, "14050471"),
        (1234567890, "89005924"),
        (2000000000, "69279037"),
        (20000000000, "65353130"),
    ];
    for (t, c) in rows {
        assert_eq!(totp(RFC_KEY, t, 8, Algo::Sha1).as_deref(), Some(c));
    }
}

#[test]
fn sha256_and_sha512_rows_use_their_own_keys() {
    assert_eq!(
        totp(b"12345678901234567890123456789012", 59, 8, Algo::Sha256).as_deref(),
        Some("46119246")
    );
    assert_eq!(
        totp(
            b"1234567890123456789012345678901234567890123456789012345678901234",
            59,
            8,
            Algo::Sha512
        )
        .as_deref(),
        Some("90693936")
    );
}

#[test]
fn base32_round_trip_and_the_rfc_4648_vectors() {
    assert_eq!(base32_encode(b"foobar"), "MZXW6YTBOI");
    assert_eq!(base32_encode(b"f"), "MY");
    assert_eq!(
        base32_decode("mzxw 6ytb-oi======").as_deref(),
        Some(&b"foobar"[..])
    );
    assert_eq!(base32_decode("MZXW1"), None);
    let k: Vec<u8> = (0..20u32).map(|i| (i * 13) as u8).collect();
    assert_eq!(base32_decode(&base32_encode(&k)), Some(k.clone()));
    assert_eq!(base32_encode(&k).len(), 32);
}

#[test]
fn grouped_for_the_screen() {
    assert_eq!(
        grouped_key(RFC_KEY),
        "GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ"
    );
    assert_eq!(grouped_key(b""), "");
}

const T: i64 = 1_700_000_015;

#[test]
fn accepts_the_current_and_adjacent_steps_in_order() {
    let now = step_at(T);
    assert_eq!(
        verify(RFC_KEY, &code(now), T, -1, false),
        Verdict::Ok { step: now }
    );
    assert_eq!(
        verify(RFC_KEY, &code(now - 1), T, -1, false),
        Verdict::Ok { step: now - 1 }
    );
    assert_eq!(
        verify(RFC_KEY, &code(now + 1), T, -1, false),
        Verdict::Ok { step: now + 1 }
    );
    assert_eq!(
        verify(RFC_KEY, &code(now + 2), T, -1, false),
        Verdict::Wrong
    );
}

#[test]
fn a_code_is_never_accepted_twice_and_older_steps_die_with_it() {
    let now = step_at(T);
    assert_eq!(verify(RFC_KEY, &code(now), T, now, false), Verdict::Used);
    assert_eq!(
        verify(RFC_KEY, &code(now - 1), T, now, false),
        Verdict::Used
    );
    assert_eq!(
        verify(RFC_KEY, &code(now + 1), T, now, false),
        Verdict::Ok { step: now + 1 }
    );
}

#[test]
fn grouped_input_is_fine_junk_is_malformed_not_a_wrong_code() {
    let c = code(step_at(T));
    let grouped = format!("{} {}", &c[..3], &c[3..]);
    assert!(matches!(
        verify(RFC_KEY, &grouped, T, -1, false),
        Verdict::Ok { .. }
    ));
    assert_eq!(verify(RFC_KEY, "12345", T, -1, false), Verdict::Malformed);
    assert_eq!(verify(RFC_KEY, "12a456", T, -1, false), Verdict::Malformed);
    assert_eq!(clean_code(" 123 456 ").as_deref(), Some("123456"));
    assert_eq!(clean_code("１２３４５６"), None);
}

#[test]
fn the_clock_hint_only_while_enrolling() {
    let far = code(step_at(T) + 5);
    assert_eq!(verify(RFC_KEY, &far, T, -1, true), Verdict::Clock);
    assert_eq!(verify(RFC_KEY, &far, T, -1, false), Verdict::Wrong);
}

#[test]
fn times_before_1970_and_at_the_ends_never_match_or_panic() {
    assert_eq!(step_at(-1), -1);
    assert_eq!(totp(RFC_KEY, -1, 6, Algo::Sha1), None);
    assert_eq!(verify(RFC_KEY, "000000", -100, -1, true), Verdict::Wrong);
    for t in [i64::MIN, i64::MAX] {
        for last in [i64::MIN, -1, i64::MAX] {
            let v = verify(RFC_KEY, "000000", t, last, true);
            assert!(matches!(v, Verdict::Wrong | Verdict::Used | Verdict::Clock));
        }
    }
    assert_eq!(hotp(RFC_KEY, 0, 0, Algo::Sha1).len(), 1);
    assert_eq!(hotp(RFC_KEY, 0, u32::MAX, Algo::Sha1).len(), 9);
    assert_eq!(hotp(b"", u64::MAX, DIGITS, Algo::Sha1).len(), 6);
}

#[test]
fn otpauth_uri_and_issuer_label() {
    assert_eq!(
        otpauth_uri("Chat (chat.example.com)", "alice", RFC_KEY),
        "otpauth://totp/Chat%20(chat.example.com):alice?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Chat%20(chat.example.com)&algorithm=SHA1&digits=6&period=30"
    );
    assert_eq!(
        otpauth_uri("a&b/c", "zoë:x", b"f"),
        "otpauth://totp/a%26b%2Fc:zo%C3%AB%3Ax?secret=MY&issuer=a%26b%2Fc&algorithm=SHA1&digits=6&period=30"
    );
    assert_eq!(
        issuer_label("Chat", "chat.example.com"),
        "Chat (chat.example.com)"
    );
    assert_eq!(
        issuer_label("chat.example.com", "Chat.Example.com"),
        "Chat.Example.com"
    );
}

#[test]
fn a_secret_is_20_random_bytes_and_never_printed() {
    let a = Secret::generate();
    let b = Secret::generate();
    assert_eq!(a.bytes().len(), 20);
    assert_ne!(a.bytes(), b.bytes());
    let s = Secret::new(RFC_KEY.to_vec());
    let shown = format!("{s:?}");
    assert_eq!(shown, "Secret(..)");
    assert!(!shown.contains("GEZD"));
    assert_eq!(s.base32(), "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    assert_eq!(
        Secret::from_base32("gezd gnbv gy3t qojq gezd gnbv gy3t qojq")
            .unwrap()
            .bytes(),
        RFC_KEY
    );
    assert!(Secret::from_base32("GEZ1").is_none());
}
