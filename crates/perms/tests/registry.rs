use rchat_perms::registry::{ALL_HOSTED, BITS, json, p2p_known};
use rchat_perms::rules::{HOSTED, P2P_V2, P2P_V4, P2P_V5, from_wire, p2p, to_wire};
use rchat_perms::{Mask, masks};

const FIXTURE: &str = "../../assets/perm_bits.json";

// `UPDATE_FIXTURES=1 cargo test -p rchat-perms` rewrites the fixture (then prettier it).
#[test]
fn bit_fixture_matches_the_registry() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(FIXTURE);
    let want: serde_json::Value = serde_json::from_str(&json()).expect("registry json");
    if std::env::var_os("UPDATE_FIXTURES").is_some() {
        let text = serde_json::to_string_pretty(&want).expect("json");
        std::fs::write(&path, text + "\n").expect("write fixture");
    }
    let got: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).expect("read fixture"))
            .expect("fixture json");
    assert_eq!(got, want, "run UPDATE_FIXTURES=1 cargo test -p rchat-perms");
}

#[test]
fn bits_are_distinct_single_bits_below_2_pow_53() {
    let mut seen: Mask = 0;
    let mut wire: u32 = 0;
    let mut names = Vec::new();
    for b in BITS {
        assert_eq!(b.value.count_ones(), 1, "{}", b.name);
        assert!(b.value < 1 << 53, "{}", b.name);
        assert_eq!(seen & b.value, 0, "{}", b.name);
        seen |= b.value;
        assert!(!names.contains(&b.name), "{}", b.name);
        names.push(b.name);
        if let Some(w) = b.p2p {
            assert_eq!(w.value.count_ones(), 1, "{}", b.name);
            assert!(w.value < 1 << 28, "{}", b.name);
            assert_eq!(wire & w.value, 0, "{}", b.name);
            wire |= w.value;
        }
    }
}

#[test]
fn masks_have_their_values() {
    assert_eq!(masks::BASE, 34628042752);
    assert_eq!(masks::CHANNEL, 36238655522);
    assert_eq!(masks::MOD_CHANNEL, 1610612770);
    assert_eq!(masks::SEND_GROUP, 32768000);
    assert_eq!(masks::MANAGER_PASS, 35701784576);
    assert_eq!(masks::TIMED_OUT_KEEP, 34360393792);
    assert_eq!(masks::ALL, 36238783487);
    assert_eq!(ALL_HOSTED, masks::BASE | masks::MGMT);
    assert_eq!(masks::BASE & masks::MGMT, 0);
    assert_eq!(masks::MGMT, 127999 | 1 << 29 | 1 << 30);
}

#[test]
fn rulesets_follow_the_rules_version() {
    assert_eq!(p2p(2), Some(&P2P_V2));
    assert_eq!(p2p(4), Some(&P2P_V4));
    assert_eq!(p2p(5), Some(&P2P_V5));
    assert_eq!(p2p(3), None);
    assert_eq!(p2p(6), None);
    assert_eq!((P2P_V2.text_only, P2P_V4.text_only), (false, true));
    assert_eq!(P2P_V2.known, P2P_V4.known);
    assert_eq!(HOSTED.known, masks::ALL);
    assert_eq!(p2p_known(2), 1023);
    assert_eq!(p2p_known(4), 1023);
}

#[test]
fn wire_bits_round_trip() {
    for rules in [2, 4, 5] {
        let known = p2p_known(rules);
        for n in 0..31 {
            let w = 1u32 << n;
            let m = from_wire(w, rules);
            match known & w {
                0 => {
                    assert_eq!(m, 0);
                    assert_eq!(to_wire(0, rules, w), w, "unknown wire bits are kept");
                }
                _ => {
                    assert_ne!(m, 0);
                    assert_eq!(to_wire(m, rules, 0), w);
                }
            }
        }
        assert_eq!(to_wire(from_wire(known, rules), rules, 0), known);
    }
    let send = from_wire(512, 4);
    assert_eq!(send, masks::SEND_GROUP);
    assert_eq!(from_wire(2, 4), 2 | 1 << 29);
    assert_eq!(from_wire(8, 4), 4096 | 8192);
    assert_eq!(from_wire(16, 4), 16384 | 32768);
    assert_eq!(from_wire(2, 5), 2);
    assert_eq!(from_wire(512, 5), masks::SEND);
    assert_eq!(from_wire(32, 4), 1 << 33);
    assert_eq!(from_wire(64, 4), 1 << 34);
    assert_eq!(from_wire(256, 4), masks::VIEW | masks::VOICE);
    assert_eq!(from_wire(256, 5), masks::VIEW);
    assert_eq!(from_wire(1 << 20, 4), 0);
    assert_eq!(from_wire(1 << 20, 5), 1 << 29);
}
