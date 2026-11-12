use rchat_identity::pkce::{challenge_of, challenge_shape, verifier_ok, verifier_shape};

const VERIFIER: &str = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE: &str = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

#[test]
fn rfc_7636_appendix_b() {
    assert_eq!(challenge_of(VERIFIER), CHALLENGE);
    assert!(verifier_ok(VERIFIER, CHALLENGE));
    assert!(!verifier_ok("short", &challenge_of("short")));
}

#[test]
fn a_wrong_or_misshapen_pair_is_refused() {
    let other = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cN";
    assert!(!verifier_ok(VERIFIER, other));
    assert!(!verifier_ok(VERIFIER, ""));
    assert!(!verifier_ok(VERIFIER, &CHALLENGE[..42]));
    assert!(!verifier_ok(&format!("{VERIFIER}="), CHALLENGE));
    assert!(!verifier_ok("", ""));
}

#[test]
fn shapes() {
    assert!(verifier_shape(&"a".repeat(43)));
    assert!(verifier_shape(&"a".repeat(128)));
    assert!(!verifier_shape(&"a".repeat(42)));
    assert!(!verifier_shape(&"a".repeat(129)));
    assert!(verifier_shape(&format!("{}._~-", "a".repeat(39))));
    assert!(!verifier_shape(&format!("{}+", "a".repeat(43))));
    assert!(!verifier_shape(&"é".repeat(43)));
    assert!(challenge_shape(CHALLENGE));
    assert!(!challenge_shape(&CHALLENGE[..42]));
    assert!(!challenge_shape(&format!("{CHALLENGE}A")));
    assert!(!challenge_shape(&CHALLENGE.replace('-', ".")));
}
