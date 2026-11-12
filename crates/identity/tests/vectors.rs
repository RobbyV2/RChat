use serde_json::Value;

use rchat_identity::codes::{clean_recovery, clean_user_code, recovery_key, user_code_key};
use rchat_identity::forward::{
    Preset, ProxyApplication, Separator, header_value, list_value, safe_return, stripped_by,
};
use rchat_identity::pkce::challenge_of;
use rchat_identity::redirect::{ClientType, check_redirect, redirect_matches};
use rchat_identity::scopes::scope_token_ok;
use rchat_identity::signin::{Proof, Sso, SsoMode, acr_for, amr_of, enough};
use rchat_identity::subject::{PairwiseKeys, subject_of};
use rchat_identity::totp::{Algo, DIGITS, Verdict, base32_encode, hotp, otpauth_uri, totp, verify};

fn vectors() -> Value {
    serde_json::from_str(include_str!("vectors.json")).expect("vectors.json parses")
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len() / 2)
        .map(|i| u8::from_str_radix(&text[2 * i..2 * i + 2], 16).expect("hex"))
        .collect()
}

fn text(v: &Value) -> &str {
    v.as_str().expect("a string")
}

fn rows<'a>(v: &'a Value, key: &str) -> &'a Vec<Value> {
    v[key]
        .as_array()
        .unwrap_or_else(|| panic!("{key} is a list"))
}

fn strings(v: &Value) -> Vec<&str> {
    v.as_array().expect("a list").iter().map(text).collect()
}

const RFC_KEY: &[u8] = b"12345678901234567890";

#[test]
fn hotp_and_totp() {
    let v = vectors();
    assert_eq!(rows(&v, "hotp").len(), 10);
    for row in rows(&v, "hotp") {
        let counter = row["counter"].as_u64().unwrap();
        assert_eq!(
            hotp(RFC_KEY, counter, DIGITS, Algo::Sha1),
            text(&row["code"])
        );
    }
    assert_eq!(rows(&v, "totp8").len(), 6);
    for row in rows(&v, "totp8") {
        let t = row["t"].as_i64().unwrap();
        assert_eq!(
            totp(RFC_KEY, t, 8, Algo::Sha1).as_deref(),
            Some(text(&row["code"]))
        );
    }
}

#[test]
fn verify_cases() {
    let v = vectors();
    assert_eq!(rows(&v, "verify").len(), 4);
    for row in rows(&v, "verify") {
        let got = verify(
            RFC_KEY,
            text(&row["code"]),
            row["t"].as_i64().unwrap(),
            row["last"].as_i64().unwrap(),
            false,
        );
        let want = match (
            row["got"]["ok"].as_bool().unwrap(),
            row["got"]["reason"].as_str(),
        ) {
            (true, _) => Verdict::Ok {
                step: row["got"]["step"].as_i64().unwrap(),
            },
            (false, Some("used")) => Verdict::Used,
            (false, Some("wrong")) => Verdict::Wrong,
            (false, other) => panic!("unknown reason {other:?}"),
        };
        assert_eq!(got, want);
    }
}

#[test]
fn base32_and_otpauth() {
    let v = vectors();
    let secret = unhex(text(&v["base32"]["secret_hex"]));
    assert_eq!(base32_encode(&secret), text(&v["base32"]["text"]));
    assert_eq!(
        otpauth_uri("Chat (chat.example.com)", "alice", RFC_KEY),
        text(&v["otpauth"])
    );
}

#[test]
fn pkce() {
    let v = vectors();
    assert_eq!(
        challenge_of(text(&v["pkce"]["verifier"])),
        text(&v["pkce"]["challenge"])
    );
}

#[test]
fn code_keys() {
    let v = vectors();
    let r = &v["recovery_key"];
    assert_eq!(clean_recovery("abcde-fghjk").as_deref(), r["code"].as_str());
    assert_eq!(
        recovery_key(
            &unhex(text(&r["pepper_hex"])),
            r["uid"].as_i64().unwrap(),
            text(&r["code"])
        ),
        text(&r["key"])
    );
    let u = &v["user_code_key"];
    assert_eq!(clean_user_code("wdjb-mjht").as_deref(), u["code"].as_str());
    assert_eq!(
        user_code_key(&unhex(text(&u["pepper_hex"])), text(&u["code"])),
        text(&u["key"])
    );
}

#[test]
fn subjects() {
    let v = vectors();
    assert_eq!(rows(&v, "subject").len(), 2);
    for row in rows(&v, "subject") {
        let version = row["version"].as_u64().unwrap() as u32;
        let keys = PairwiseKeys::new([(version, unhex(text(&row["key_hex"])))].into());
        assert_eq!(
            subject_of(
                &keys,
                version,
                text(&row["group"]),
                row["uid"].as_i64().unwrap()
            )
            .as_deref(),
            row["sub"].as_str()
        );
    }
}

#[test]
fn redirects() {
    let v = vectors();
    assert_eq!(rows(&v, "redirects").len(), 3);
    for row in rows(&v, "redirects") {
        let registered = strings(&row["registered"]);
        assert_eq!(
            redirect_matches(&registered, text(&row["asked"])),
            row["got"].as_bool().unwrap()
        );
    }
    assert_eq!(rows(&v, "redirect_checks").len(), 5);
    for row in rows(&v, "redirect_checks") {
        let got = match check_redirect(text(&row["uri"]), ClientType::Public) {
            Ok(kind) => kind.name(),
            Err(e) => e.text(),
        };
        assert_eq!(got, text(&row["public"]));
    }
}

#[test]
fn header_and_list_values() {
    let v = vectors();
    assert_eq!(rows(&v, "header_value").len(), 4);
    for row in rows(&v, "header_value") {
        assert_eq!(header_value(text(&row["in"])), text(&row["out"]));
    }
    let list = &v["list_value"];
    let items = strings(&list["in"]);
    assert_eq!(list_value(&items, Separator::Comma), text(&list["comma"]));
    assert_eq!(list_value(&items, Separator::Pipe), text(&list["pipe"]));
}

#[test]
fn safe_returns() {
    let v = vectors();
    let application = ProxyApplication {
        id: "p".to_string(),
        hosts: vec!["wiki.example.com".to_string()],
        cookie_domain: None,
        preset: Preset::Rchat,
        paused: false,
        needs_two_factor: false,
    };
    assert_eq!(rows(&v, "safe_return").len(), 3);
    for row in rows(&v, "safe_return") {
        assert_eq!(
            safe_return(&application, row["rd"].as_str()),
            text(&row["out"])
        );
    }
}

fn proofs(v: &Value) -> Vec<Proof> {
    strings(v)
        .into_iter()
        .map(|p| match p {
            "pwd" => Proof::Pwd,
            "totp" => Proof::Totp,
            "recovery_code" => Proof::RecoveryCode,
            "phrase" => Proof::Phrase,
            "device" => Proof::Device,
            "sso" => Proof::Sso,
            other => panic!("unknown proof {other}"),
        })
        .collect()
}

fn sso(mode: &Value, amr: &Value) -> Sso {
    Sso {
        mode: match text(mode) {
            "rchat" => SsoMode::Rchat,
            "amr" => SsoMode::Amr,
            "provider" => SsoMode::Provider,
            other => panic!("unknown mode {other}"),
        },
        amr: strings(amr).into_iter().map(str::to_string).collect(),
    }
}

#[test]
fn amr_and_enough() {
    let v = vectors();
    assert_eq!(rows(&v, "amr").len(), 7);
    for row in rows(&v, "amr") {
        let p = proofs(&row["proofs"]);
        assert_eq!(amr_of(&p, None), strings(&row["amr"]));
        assert_eq!(
            enough(true, &p, None),
            row["enough_with_codes"].as_bool().unwrap()
        );
    }
    assert_eq!(rows(&v, "sso").len(), 4);
    for row in rows(&v, "sso") {
        let s = sso(&row["mode"], &row["amr"]);
        assert_eq!(
            enough(true, &[Proof::Sso], Some(&s)),
            row["alone_with_codes"].as_bool().unwrap()
        );
        assert_eq!(amr_of(&[Proof::Sso], Some(&s)), strings(&row["amr_out"]));
    }
}

#[test]
fn acr() {
    let v = vectors();
    assert_eq!(rows(&v, "acr").len(), 4);
    for row in rows(&v, "acr") {
        let s = row.get("sso").map(|s| sso(&s["mode"], &s["amr"]));
        assert_eq!(
            acr_for(&proofs(&row["proofs"]), s.as_ref()),
            text(&row["acr"])
        );
    }
}

#[test]
fn stripped_headers_and_scope_tokens() {
    let v = vectors();
    assert_eq!(rows(&v, "strip").len(), 8);
    for row in rows(&v, "strip") {
        assert_eq!(
            stripped_by(text(&row["header"])),
            row["stripped"].as_bool().unwrap()
        );
    }
    assert_eq!(rows(&v, "scope_tokens").len(), 3);
    for row in rows(&v, "scope_tokens") {
        assert_eq!(
            scope_token_ok(text(&row["token"])),
            row["ok"].as_bool().unwrap()
        );
    }
}

// `public_address` is replayed against the server's `net_guard::blocked`, and the certificate and
// chat list bytes against `crates/e2ee`: this crate has neither an address check nor those layouts.
const ELSEWHERE: [&str; 3] = ["public_address", "cert_bytes", "chat_list_bytes"];
const REPLAYED: [&str; 19] = [
    "hotp",
    "totp8",
    "verify",
    "base32",
    "otpauth",
    "pkce",
    "recovery_key",
    "user_code_key",
    "subject",
    "header_value",
    "list_value",
    "redirects",
    "redirect_checks",
    "safe_return",
    "amr",
    "sso",
    "acr",
    "strip",
    "scope_tokens",
];

#[test]
fn every_vector_is_replayed_here_or_named_as_replayed_elsewhere() {
    let v = vectors();
    let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
    let mut known: Vec<&str> = REPLAYED.iter().chain(&ELSEWHERE).copied().collect();
    keys.sort();
    known.sort();
    assert_eq!(keys, known);
}
