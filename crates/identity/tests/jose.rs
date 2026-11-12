#![cfg(feature = "jose")]

use std::sync::OnceLock;

use aws_lc_rs::encoding::{AsDer, Pkcs8V1Der};
use aws_lc_rs::rsa::{KeyPair, KeyPairComponents, KeySize, PublicKeyComponents};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use proptest::prelude::*;
use serde_json::{Value, json};

use rchat_identity::jose::{
    ASSERTION_SECS, Alg, BACKCHANNEL_EVENT, ID_TOKEN_SECS, IdToken, JoseError, Jwk, JwkSet,
    LOGOUT_TOKEN_SECS, LogoutToken, Profile, ProxyAssertion, ServerClaim, SigningKey, TYP_JWT,
    TYP_LOGOUT, TYP_PROXY, at_hash, id_token, id_token_claims, logout_claims, logout_sids,
    logout_token, proxy_assertion, proxy_assertion_claims, sign_compact, verify_compact,
    verify_with,
};
use rchat_identity::scopes::FORBIDDEN_CLAIMS;

fn rfc() -> Value {
    serde_json::from_str(include_str!("jose_rfc.json")).expect("jose_rfc.json parses")
}

fn text(v: &Value) -> &str {
    v.as_str().expect("a string")
}

fn b64(text: &str) -> Vec<u8> {
    URL_SAFE_NO_PAD.decode(text).expect("base64url")
}

fn rs256() -> &'static SigningKey {
    static KEY: OnceLock<SigningKey> = OnceLock::new();
    KEY.get_or_init(|| SigningKey::generate(Alg::Rs256).expect("an RSA key"))
}

fn es256() -> &'static SigningKey {
    static KEY: OnceLock<SigningKey> = OnceLock::new();
    KEY.get_or_init(|| SigningKey::generate(Alg::Es256).expect("a P-256 key"))
}

fn keys() -> JwkSet {
    JwkSet::of(&[rs256(), es256()])
}

fn parts(token: &str) -> (Value, Value, Vec<u8>) {
    let seg: Vec<&str> = token.split('.').collect();
    assert_eq!(seg.len(), 3);
    (
        serde_json::from_slice(&b64(seg[0])).unwrap(),
        serde_json::from_slice(&b64(seg[1])).unwrap(),
        b64(seg[2]),
    )
}

fn claim_names(claims: &Value) -> Vec<&str> {
    let mut names: Vec<&str> = claims
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    names.sort();
    names
}

#[test]
fn rfc_7638_3_1_thumbprint() {
    let v = rfc();
    let t = &v["rfc7638_3_1"];
    let jwk = Jwk::rsa(&b64(text(&t["n"])), &b64(text(&t["e"])));
    assert_eq!(jwk.n.as_deref(), t["n"].as_str());
    assert_eq!(jwk.thumbprint().as_deref(), t["thumbprint"].as_str());
    let with_extras = Jwk {
        kid: Some("2011-04-29".to_string()),
        alg: Some("RS256".to_string()),
        ..jwk
    };
    assert_eq!(
        with_extras.thumbprint().as_deref(),
        t["thumbprint"].as_str()
    );
    assert_eq!(Jwk::default().thumbprint(), None);
}

fn rfc_rsa_key(v: &Value) -> SigningKey {
    let jwk = &v["rfc7515_a2"]["jwk"];
    let part = |name: &str| b64(text(&jwk[name]));
    let components = KeyPairComponents {
        public_key: PublicKeyComponents {
            n: part("n"),
            e: part("e"),
        },
        d: part("d"),
        p: part("p"),
        q: part("q"),
        dP: part("dp"),
        dQ: part("dq"),
        qInv: part("qi"),
    };
    let pair = KeyPair::from_components(&components).expect("the RFC's key");
    let der: Pkcs8V1Der = pair.as_der().expect("PKCS#8");
    SigningKey::from_pkcs8(der.as_ref()).expect("a PKCS#8 RSA key")
}

#[test]
fn rfc_7515_a_2_rs256_signature_is_reproduced_and_verified() {
    let v = rfc();
    let a2 = &v["rfc7515_a2"];
    let key = rfc_rsa_key(&v);
    assert_eq!(key.alg(), Alg::Rs256);
    assert_eq!(key.public_jwk().n.as_deref(), a2["jwk"]["n"].as_str());
    assert_eq!(key.public_jwk().e.as_deref(), a2["jwk"]["e"].as_str());
    let signature = key.sign(text(&a2["signing_input"]).as_bytes()).unwrap();
    assert_eq!(URL_SAFE_NO_PAD.encode(signature), text(&a2["signature"]));
    let verified = verify_with(key.public_jwk(), text(&a2["compact"])).unwrap();
    assert_eq!(verified.alg, Alg::Rs256);
    assert_eq!((verified.kid, verified.typ), (None, None));
    let payload: Value = serde_json::from_slice(&verified.payload).unwrap();
    assert_eq!(
        payload,
        json!({"iss": "joe", "exp": 1300819380, "http://example.com/is_root": true})
    );
}

#[test]
fn rfc_7515_a_3_es256_signature_is_verified() {
    let v = rfc();
    let a3 = &v["rfc7515_a3"];
    let jwk = Jwk::p256(&b64(text(&a3["jwk"]["x"])), &b64(text(&a3["jwk"]["y"])));
    let compact = text(&a3["compact"]);
    let verified = verify_with(&jwk, compact).unwrap();
    assert_eq!(verified.alg, Alg::Es256);
    let payload: Value = serde_json::from_slice(&verified.payload).unwrap();
    assert_eq!(payload["iss"], "joe");
    let mut wrong = jwk.clone();
    wrong.x = jwk.y.clone();
    assert_eq!(verify_with(&wrong, compact), Err(JoseError::Signature));
    let other = compact.replace("eyJpc3MiOiJqb2Ui", "eyJpc3MiOiJqb2Vi");
    assert_ne!(other, compact);
    assert_eq!(verify_with(&jwk, &other), Err(JoseError::Signature));
}

#[test]
fn at_hash_is_the_left_half_of_sha_256_for_both_algorithms() {
    let access_token = "jHkWEdUXMU1BwAsC4vtUsZwnNvTIxEl0z9K3vx5KF0Y";
    for alg in [Alg::Rs256, Alg::Es256] {
        assert_eq!(at_hash(alg, access_token), "77QmUPtjPfzWtF2AnpK9RQ");
    }
}

#[test]
fn generated_keys_are_rsa_2048_and_p_256_with_their_thumbprint_as_kid() {
    let rsa = rs256().public_jwk();
    assert_eq!(rsa.kty, "RSA");
    assert_eq!(b64(rsa.n.as_deref().unwrap()).len(), 256);
    assert_eq!(rsa.e.as_deref(), Some("AQAB"));
    assert_eq!(
        (rsa.alg.as_deref(), rsa.key_use.as_deref()),
        (Some("RS256"), Some("sig"))
    );
    assert_eq!(rsa.kid.as_deref(), Some(rs256().kid()));
    assert_eq!(rsa.thumbprint().as_deref(), Some(rs256().kid()));
    assert_eq!(rs256().kid().len(), 43);
    let ec = es256().public_jwk();
    assert_eq!((ec.kty.as_str(), ec.crv.as_deref()), ("EC", Some("P-256")));
    assert_eq!(b64(ec.x.as_deref().unwrap()).len(), 32);
    assert_eq!(b64(ec.y.as_deref().unwrap()).len(), 32);
    assert_eq!(
        (ec.alg.as_deref(), ec.key_use.as_deref()),
        (Some("ES256"), Some("sig"))
    );
    assert_eq!(ec.thumbprint().as_deref(), Some(es256().kid()));
    assert_ne!(
        SigningKey::generate(Alg::Es256).unwrap().kid(),
        es256().kid()
    );
    assert_eq!((rs256().alg(), es256().alg()), (Alg::Rs256, Alg::Es256));
    assert_eq!([Alg::Rs256, Alg::Es256].map(Alg::name), ["RS256", "ES256"]);
    assert_eq!(Alg::parse("ES256"), Some(Alg::Es256));
    assert_eq!(Alg::parse("EdDSA"), None);
    assert_eq!(Alg::parse("none"), None);
}

#[test]
fn an_rsa_keys_modulus_and_exponent_are_read_from_its_public_key() {
    for size in [KeySize::Rsa2048, KeySize::Rsa3072] {
        let pair = KeyPair::generate(size).unwrap();
        let der: Pkcs8V1Der = pair.as_der().unwrap();
        let key = SigningKey::from_pkcs8(der.as_ref()).unwrap();
        let n = b64(key.public_jwk().n.as_deref().unwrap());
        assert_eq!(n.len(), pair.public_modulus_len());
        assert!(n[0] >= 0x80);
        assert_eq!(key.public_jwk().e.as_deref(), Some("AQAB"));
        let token = sign_compact(&key, TYP_JWT, b"{}").unwrap();
        assert!(verify_with(key.public_jwk(), &token).is_ok());
    }
}

#[test]
fn the_published_keys_hold_no_private_part() {
    let set = serde_json::to_value(keys()).unwrap();
    let published = set["keys"].as_array().unwrap();
    assert_eq!(published.len(), 2);
    assert_eq!(
        claim_names(&published[0]),
        ["alg", "e", "kid", "kty", "n", "use"]
    );
    assert_eq!(
        claim_names(&published[1]),
        ["alg", "crv", "kid", "kty", "use", "x", "y"]
    );
    let with_private = json!({"kty": "EC", "crv": "P-256", "x": "a", "y": "b", "d": "secret"});
    let parsed: Jwk = serde_json::from_value(with_private).unwrap();
    assert!(!serde_json::to_string(&parsed).unwrap().contains("secret"));
}

#[test]
fn keys_round_trip_through_pkcs8_and_pem_and_are_never_printed() {
    for key in [rs256(), es256()] {
        let der = key.to_pkcs8().unwrap();
        let again = SigningKey::from_pkcs8(der.bytes()).unwrap();
        assert_eq!(again.kid(), key.kid());
        assert_eq!(again.alg(), key.alg());
        let body = base64::engine::general_purpose::STANDARD.encode(der.bytes());
        let lines: Vec<&str> = body
            .as_bytes()
            .chunks(64)
            .map(|c| std::str::from_utf8(c).unwrap())
            .collect();
        let pem = format!(
            "-----BEGIN PRIVATE KEY-----\r\n{}\n-----END PRIVATE KEY-----\n",
            lines.join("\n")
        );
        assert_eq!(SigningKey::from_pkcs8_pem(&pem).unwrap().kid(), key.kid());
        assert_eq!(format!("{der:?}"), "Pkcs8(..)");
        let shown = format!("{key:?}");
        assert_eq!(
            shown,
            format!(
                "SigningKey {{ alg: {:?}, kid: {:?} }}",
                key.alg(),
                key.kid()
            )
        );
    }
    for junk in [
        "",
        "-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----",
        "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----",
        "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----",
        "AAAA",
        "-----BEGIN PRIVATE KEY-----\n!!!!\n-----END PRIVATE KEY-----",
    ] {
        assert_eq!(SigningKey::from_pkcs8_pem(junk).err(), Some(JoseError::Key));
    }
    assert_eq!(SigningKey::from_pkcs8(b"").err(), Some(JoseError::Key));
    assert_eq!(
        SigningKey::from_pkcs8(&[0x30, 0x03, 1, 2, 3]).err(),
        Some(JoseError::Key)
    );
}

#[test]
fn compact_jws_has_alg_kid_and_typ_and_verifies_by_kid() {
    for key in [rs256(), es256()] {
        let token = sign_compact(key, TYP_JWT, br#"{"a":1}"#).unwrap();
        let (header, payload, signature) = parts(&token);
        assert_eq!(
            header,
            json!({"alg": key.alg().name(), "kid": key.kid(), "typ": "JWT"})
        );
        assert_eq!(payload, json!({"a": 1}));
        assert_eq!(
            signature.len(),
            match key.alg() {
                Alg::Rs256 => 256,
                Alg::Es256 => 64,
            }
        );
        assert!(!token.contains('='));
        let verified = verify_compact(&keys(), &token, TYP_JWT).unwrap();
        assert_eq!(verified.alg, key.alg());
        assert_eq!(verified.kid.as_deref(), Some(key.kid()));
        assert_eq!(verified.typ.as_deref(), Some("JWT"));
        assert_eq!(verified.payload, br#"{"a":1}"#);
    }
}

fn reheader(token: &str, header: Value) -> String {
    let rest = token.split_once('.').unwrap().1;
    format!(
        "{}.{rest}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).unwrap())
    )
}

#[test]
fn tokens_that_are_not_ours_are_refused() {
    let token = sign_compact(rs256(), TYP_JWT, b"{}").unwrap();
    let other = SigningKey::generate(Alg::Es256).unwrap();
    let foreign = sign_compact(&other, TYP_JWT, b"{}").unwrap();
    assert_eq!(
        verify_compact(&keys(), &foreign, TYP_JWT),
        Err(JoseError::UnknownKey)
    );
    let no_kid = reheader(&token, json!({"alg": "RS256"}));
    assert_eq!(
        verify_compact(&keys(), &no_kid, TYP_JWT),
        Err(JoseError::UnknownKey)
    );
    assert_eq!(
        verify_with(rs256().public_jwk(), &no_kid),
        Err(JoseError::Signature)
    );
    for alg in ["ES256", "none", "HS256", "RS512", ""] {
        let confused = reheader(&token, json!({"alg": alg, "kid": rs256().kid()}));
        assert_eq!(
            verify_compact(&keys(), &confused, TYP_JWT),
            Err(JoseError::Alg),
            "{alg}"
        );
    }
    let critical = reheader(
        &token,
        json!({"alg": "RS256", "kid": rs256().kid(), "crit": ["exp"]}),
    );
    assert_eq!(
        verify_compact(&keys(), &critical, TYP_JWT),
        Err(JoseError::Token)
    );
    let twice = JwkSet {
        keys: vec![rs256().public_jwk().clone(), rs256().public_jwk().clone()],
    };
    assert_eq!(
        verify_compact(&twice, &token, TYP_JWT),
        Err(JoseError::UnknownKey)
    );
    let wrong_key = Jwk {
        kid: Some(rs256().kid().to_string()),
        ..SigningKey::generate(Alg::Rs256)
            .unwrap()
            .public_jwk()
            .clone()
    };
    assert_eq!(
        verify_compact(
            &JwkSet {
                keys: vec![wrong_key]
            },
            &token,
            TYP_JWT
        ),
        Err(JoseError::Signature)
    );
    let enc_key = Jwk {
        key_use: Some("enc".to_string()),
        ..rs256().public_jwk().clone()
    };
    assert_eq!(verify_with(&enc_key, &token), Err(JoseError::Alg));
    for junk in [
        "",
        "a.b",
        "a.b.c.d",
        "....",
        "e30.e30.",
        "!!!.e30.AAAA",
        &format!("{token}="),
        &format!(" {token}"),
        &"a".repeat(100_000),
    ] {
        assert_eq!(
            verify_compact(&keys(), junk, TYP_JWT),
            Err(JoseError::Token),
            "{junk:.20}"
        );
    }
    assert_eq!(JoseError::Signature.text(), "The signature does not match");
    assert_eq!(JoseError::Key.to_string(), "Not a usable signing key");
}

fn sample() -> IdToken {
    IdToken {
        iss: "https://chat.example.com".to_string(),
        sub: "zhxtler1AtgHOm5T1JNjrT93ZDfctqLfNT1wmoesA-I".to_string(),
        aud: "application_pixel".to_string(),
        iat: 1_700_000_000,
        auth_time: 1_699_999_000,
        nonce: Some("n-0S6_WzA2Mj".to_string()),
        sid: "sid1".to_string(),
        amr: vec!["mfa".to_string(), "otp".to_string(), "pwd".to_string()],
        acr: "urn:rchat:acr:2fa".to_string(),
        profile: Some(Profile {
            preferred_username: "alice".to_string(),
            name: "Alice".to_string(),
            picture: "https://chat.example.com/api/v1/avatars/k.png?v=3".to_string(),
            updated_at: 1_690_000_000,
            rchat_instance: "chat.example.com".to_string(),
        }),
        groups: Some(vec!["lobby".to_string(), "lobby:Staff".to_string()]),
        rchat_servers: Some(vec![ServerClaim {
            server: "lobby".to_string(),
            name: "Lobby".to_string(),
            roles: vec!["Staff".to_string()],
        }]),
    }
}

#[test]
fn id_token_claims_every_one_and_never_a_forbidden_one() {
    let access_token = "rca_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    for key in [rs256(), es256()] {
        let token = id_token(key, &sample(), Some(access_token)).unwrap();
        let (header, claims, _) = parts(&token);
        assert_eq!(header["typ"], "JWT");
        assert_eq!(header["alg"], key.alg().name());
        assert_eq!(
            claims,
            json!({
                "iss": "https://chat.example.com",
                "sub": "zhxtler1AtgHOm5T1JNjrT93ZDfctqLfNT1wmoesA-I",
                "aud": "application_pixel",
                "azp": "application_pixel",
                "exp": 1_700_000_300,
                "iat": 1_700_000_000,
                "auth_time": 1_699_999_000,
                "nonce": "n-0S6_WzA2Mj",
                "sid": "sid1",
                "amr": ["mfa", "otp", "pwd"],
                "acr": "urn:rchat:acr:2fa",
                "at_hash": at_hash(key.alg(), access_token),
                "preferred_username": "alice",
                "name": "Alice",
                "picture": "https://chat.example.com/api/v1/avatars/k.png?v=3",
                "updated_at": 1_690_000_000,
                "rchat_instance": "chat.example.com",
                "groups": ["lobby", "lobby:Staff"],
                "rchat_servers": [{"server": "lobby", "name": "Lobby", "roles": ["Staff"]}],
            })
        );
        for forbidden in FORBIDDEN_CLAIMS {
            assert!(!claim_names(&claims).contains(&forbidden));
        }
        assert!(!token.contains(access_token));
        assert!(verify_compact(&keys(), &token, TYP_JWT).is_ok());
    }
    assert_eq!(ID_TOKEN_SECS, 300);
}

#[test]
fn an_id_token_carries_only_what_was_granted() {
    let bare = IdToken {
        nonce: None,
        profile: None,
        groups: None,
        rchat_servers: None,
        ..sample()
    };
    let claims = id_token_claims(Alg::Es256, &bare, None);
    assert_eq!(
        claim_names(&claims),
        [
            "acr",
            "amr",
            "aud",
            "auth_time",
            "azp",
            "exp",
            "iat",
            "iss",
            "sid",
            "sub"
        ]
    );
    let late = IdToken {
        iat: i64::MAX,
        ..bare
    };
    assert_eq!(id_token_claims(Alg::Es256, &late, None)["exp"], i64::MAX);
}

#[test]
fn logout_tokens_follow_back_channel_logout_and_never_carry_a_nonce() {
    let t = LogoutToken {
        iss: "https://chat.example.com".to_string(),
        aud: "a1".to_string(),
        sub: "sub".to_string(),
        sid: Some("sid1".to_string()),
        iat: 100,
        jti: "j".to_string(),
    };
    let want = json!({
        "iss": "https://chat.example.com",
        "aud": "a1",
        "iat": 100,
        "exp": 220,
        "jti": "j",
        "sub": "sub",
        "sid": "sid1",
        "events": {BACKCHANNEL_EVENT: {}},
    });
    assert_eq!(logout_claims(&t), want);
    assert!(logout_claims(&t).get("nonce").is_none());
    let token = logout_token(es256(), &t).unwrap();
    let (header, claims, _) = parts(&token);
    assert_eq!(header["typ"], "logout+jwt");
    assert_eq!(claims, want);
    let sub_only = LogoutToken { sid: None, ..t };
    assert_eq!(
        claim_names(&logout_claims(&sub_only)),
        ["aud", "events", "exp", "iat", "iss", "jti", "sub"]
    );
    assert_eq!(
        BACKCHANNEL_EVENT,
        "http://schemas.openid.net/event/backchannel-logout"
    );
    assert_eq!((LOGOUT_TOKEN_SECS, TYP_LOGOUT), (120, "logout+jwt"));
}

#[test]
fn applications_that_require_a_sid_never_get_a_sub_only_token() {
    let s = |v: &str| Some(v.to_string());
    assert_eq!(logout_sids(&["s1", "s2"], true), [s("s1"), s("s2")]);
    assert_eq!(logout_sids(&["s1"], false), [s("s1"), None]);
    assert_eq!(logout_sids(&[] as &[&str], true), []);
    assert_eq!(logout_sids(&[] as &[&str], false), [None]);
}

#[test]
fn proxy_assertions_last_a_minute_and_name_their_application() {
    let a = ProxyAssertion {
        iss: "https://chat.example.com".to_string(),
        aud: "application_wiki".to_string(),
        sub: "S".to_string(),
        preferred_username: "zoë".to_string(),
        name: "Zoë (ops)".to_string(),
        groups: vec!["lobby".to_string()],
        iat: 1000,
        sid: "sid9".to_string(),
    };
    let want = json!({
        "iss": "https://chat.example.com",
        "aud": "application_wiki",
        "sub": "S",
        "preferred_username": "zoë",
        "name": "Zoë (ops)",
        "groups": ["lobby"],
        "iat": 1000,
        "exp": 1060,
        "sid": "sid9",
    });
    assert_eq!(proxy_assertion_claims(&a), want);
    let token = proxy_assertion(rs256(), &a).unwrap();
    let (header, claims, _) = parts(&token);
    assert_eq!(header["typ"], "rchat-proxy+jwt");
    assert_eq!(claims, want);
    assert!(token.is_ascii());
    assert_eq!((ASSERTION_SECS, TYP_PROXY), (60, "rchat-proxy+jwt"));
    for forbidden in FORBIDDEN_CLAIMS {
        assert!(!claim_names(&claims).contains(&forbidden));
    }
}

#[test]
fn a_token_verifies_only_as_the_type_it_was_signed_as() {
    let assertion = ProxyAssertion {
        iss: "https://chat.example.com".to_string(),
        aud: "application_wiki".to_string(),
        sub: "S".to_string(),
        preferred_username: "zoe".to_string(),
        name: "Zoe".to_string(),
        groups: vec![],
        iat: 1000,
        sid: "sid9".to_string(),
    };
    let logout = LogoutToken {
        iss: "https://chat.example.com".to_string(),
        aud: "a1".to_string(),
        sub: "sub".to_string(),
        sid: None,
        iat: 100,
        jti: "j".to_string(),
    };
    for key in [rs256(), es256()] {
        let id = id_token(key, &sample(), Some("at")).unwrap();
        let proxy = proxy_assertion(key, &assertion).unwrap();
        let out = logout_token(key, &logout).unwrap();
        for (token, typ) in [(&id, TYP_JWT), (&proxy, TYP_PROXY), (&out, TYP_LOGOUT)] {
            let verified = verify_compact(&keys(), token, typ).unwrap();
            assert_eq!(verified.typ.as_deref(), Some(typ));
            for other in [TYP_JWT, TYP_PROXY, TYP_LOGOUT, "jwt", "", "application/jwt"] {
                if other != typ {
                    assert_eq!(
                        verify_compact(&keys(), token, other),
                        Err(JoseError::Type),
                        "{typ} as {other}"
                    );
                }
            }
        }
        let empty = sign_compact(key, "", b"{}").unwrap();
        assert_eq!(
            verify_compact(&keys(), &empty, TYP_JWT),
            Err(JoseError::Type)
        );
        let header = json!({"alg": key.alg().name(), "kid": key.kid()});
        let input = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).unwrap()),
            URL_SAFE_NO_PAD.encode(b"{}")
        );
        let signature = URL_SAFE_NO_PAD.encode(key.sign(input.as_bytes()).unwrap());
        let untyped = format!("{input}.{signature}");
        assert!(verify_with(key.public_jwk(), &untyped).is_ok());
        assert_eq!(
            verify_compact(&keys(), &untyped, TYP_JWT),
            Err(JoseError::Type)
        );
    }
    assert_eq!(
        JoseError::Type.text(),
        "The token is not of the expected type"
    );
}

proptest! {
    #![proptest_config(ProptestConfig {
        failure_persistence: None,
        ..ProptestConfig::default()
    })]

    #[test]
    fn arbitrary_text_is_never_a_token_or_a_key(input in prop_oneof![any::<String>(), "[A-Za-z0-9_-]{0,40}\\.[A-Za-z0-9_-]{0,40}\\.[A-Za-z0-9_-]{0,90}", "-----BEGIN PRIVATE KEY-----\n[A-Za-z0-9+/=\n]{0,200}-----END PRIVATE KEY-----"]) {
        prop_assert!(verify_compact(&keys(), &input, TYP_JWT).is_err());
        prop_assert!(verify_with(es256().public_jwk(), &input).is_err());
        prop_assert!(SigningKey::from_pkcs8_pem(&input).is_err());
        prop_assert!(SigningKey::from_pkcs8(input.as_bytes()).is_err());
    }

    #[test]
    fn a_changed_token_never_verifies(at in 0usize..400, to in "[A-Za-z0-9_-]", payload in "[ -~]{0,40}") {
        let token = sign_compact(es256(), TYP_JWT, payload.as_bytes()).unwrap();
        prop_assert_eq!(verify_compact(&keys(), &token, TYP_JWT).map(|v| v.payload), Ok(payload.into_bytes()));
        let at = at % token.len();
        let mut changed = token.clone();
        changed.replace_range(at..at + 1, &to);
        if changed != token {
            prop_assert!(verify_compact(&keys(), &changed, TYP_JWT).is_err());
        }
    }

    #[test]
    fn any_jwk_text_parses_or_is_refused_without_panicking(kty in "[A-Za-z]{0,4}", crv in "[A-Za-z0-9-]{0,6}", a in any::<String>(), b in any::<String>()) {
        let jwk = Jwk { kty, crv: Some(crv), x: Some(a.clone()), y: Some(b.clone()), n: Some(a), e: Some(b), ..Jwk::default() };
        let _ = jwk.thumbprint();
        let token = sign_compact(es256(), TYP_JWT, b"{}").unwrap();
        prop_assert!(verify_with(&jwk, &token).is_err());
    }
}
