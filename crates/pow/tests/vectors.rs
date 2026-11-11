use rchat_pow::*;
use serde_json::{Value, json};

const KEY: &[u8] = b"0123456789abcdef0123456789abcdef";
const KID: &str = "1";
const CHALLENGE_PAYLOAD: &str = r#"{"v":1,"alg":"s256","cls":"general","sub":"g:5e3c1d2a9f0b7c41a2b3","k":4,"w":4096,"iat":1767225600,"exp":1767225901,"r":"AAECAwQFBgcICQoLDA0ODw"}"#;
const TOKEN_PAYLOAD: &str = r#"{"v":1,"id":"EBESExQVFhcYGRobHB0eHw","sub":"g:5e3c1d2a9f0b7c41a2b3","cls":"general","lvl":4096,"iat":1767225610,"exp":1767229210,"bud":1000}"#;

fn key_of(kid: &str) -> Option<Vec<u8>> {
    (kid == KID).then(|| KEY.to_vec())
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn vectors() -> Value {
    let challenge = seal(KEY, "c1", KID, CHALLENGE_PAYLOAD.as_bytes());
    let seed = seed_of(&challenge);
    let target = target_for(4, 4096);
    let (nonces, tries) = solve(&seed, 4, target);
    let token = seal(KEY, "t1", KID, TOKEN_PAYLOAD.as_bytes());
    json!({
        "key_hex": hex(KEY),
        "kid": KID,
        "challenge_payload": CHALLENGE_PAYLOAD,
        "challenge": challenge,
        "seed_hex": hex(&seed),
        "hash_sub0_nonce0_hex": hex(&puzzle_hash(&seed, 0, 0)),
        "k": 4,
        "work": 4096,
        "target": target.to_string(),
        "nonces": nonces.iter().map(|n| n.to_string()).collect::<Vec<_>>(),
        "nonces_wire": encode_nonces(&nonces),
        "tries": tries,
        "token_payload": TOKEN_PAYLOAD,
        "token": token,
        "targets": [
            [16, 1u64 << 20, target_for(16, 1 << 20).to_string()],
            [16, 1u64 << 24, target_for(16, 1 << 24).to_string()],
            [1, 1, target_for(1, 1).to_string()],
            [16, 3, target_for(16, 3).to_string()],
            [64, u64::MAX, target_for(64, u64::MAX).to_string()],
        ],
        "work_for": [
            [1u64 << 20, 0, 8, work_for(1 << 20, 0, 8, 1 << 30)],
            [1u64 << 20, 2, 8, work_for(1 << 20, 2, 8, 1 << 30)],
            [1u64 << 20, 8, 8, work_for(1 << 20, 8, 8, 1 << 30)],
            [1u64 << 20, 30, 8, work_for(1 << 20, 30, 8, 1 << 30)],
            [1u64 << 20, 80, 8, work_for(1 << 20, 80, 8, 1 << 30)],
        ],
        "work_with_load": [
            [1u64 << 22, 24, 4, 8, 1u64 << 25, work_with_load(1 << 22, 24, 4, 8, 1 << 25)],
            [1u64 << 22, 16, 4, 8, 1u64 << 25, work_with_load(1 << 22, 16, 4, 8, 1 << 25)],
            [1u64 << 22, 32, 4, 8, 1u64 << 25, work_with_load(1 << 22, 32, 4, 8, 1 << 25)],
        ],
        "bind": [
            ["a", "acct", "h:00ff", bind(KEY, "a", "acct", "h:00ff")],
            ["g", "addr", "203.0.113.9", bind(KEY, "g", "addr", "203.0.113.9")],
            ["g", "addr", "2001:db8:1:2::", bind(KEY, "g", "addr", "2001:db8:1:2::")],
            ["u", "user", "alice", bind(KEY, "u", "user", "alice")],
            ["b", "ua", "Mozilla/5.0", bind(KEY, "b", "ua", "Mozilla/5.0")],
        ],
        "binding": [
            ["session", binding(KEY, Caller::Session("h:00ff"))],
            ["guest", binding(KEY, Caller::Guest { group: "203.0.113.9", client: Some("AAECAwQFBgcICQoLDA0ODw") })],
            ["guest without client id", binding(KEY, Caller::Guest { group: "203.0.113.9", client: None })],
            ["signin alice", binding(KEY, Caller::Signin { group: "203.0.113.9", username: Some("Alice"), client: Some("AAECAwQFBgcICQoLDA0ODw") })],
            ["signin without username", binding(KEY, Caller::Signin { group: "203.0.113.9", username: None, client: Some("AAECAwQFBgcICQoLDA0ODw") })],
            ["page bound to address", binding(KEY, Caller::Page { ua: "Mozilla/5.0", group: Some("203.0.113.9") })],
        ],
        "requester": [
            ["client id", requester(None, "203.0.113.9", Some("AAECAwQFBgcICQoLDA0ODw"), "Mozilla/5.0")],
            ["no client id", requester(None, "203.0.113.9", None, "Mozilla/5.0")],
        ],
        "forward_verifier": ["dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", challenge_of("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")],
        "redeemers": [
            ["token", ["general", "signin"]],
            ["pass", ["page"]],
            ["redeem", ["general"]],
        ],
        "bulk_page": [[null, BulkAsk::page(None).cost()], ["100", BulkAsk::page(Some("100")).cost()], ["150", BulkAsk::page(Some("150")).cost()], ["5000", BulkAsk::page(Some("5000")).cost()], ["99999", BulkAsk::page(Some("99999")).cost()], ["0", BulkAsk::page(Some("0")).cost()]],
        "bulk_media_batch": BulkAsk::MediaBatch.cost(),
        "bulk_range_bytes": [[1u64, BulkAsk::range(Some("bytes=0-0")).cost()], [1048576u64, BulkAsk::range(Some("bytes=0-1048575")).cost()], [1048577u64, BulkAsk::range(Some("bytes=0-1048576")).cost()], [8388608u64, BulkAsk::range(Some("bytes=0-8388607")).cost()], [104857600u64, BulkAsk::range(Some("bytes=0-104857599")).cost()]],
        "bulk_range_none": BulkAsk::range(None).cost(),
        "bulk_changes": [[0, BulkAsk::changes(0).cost()], [1, BulkAsk::changes(1).cost()], [20, BulkAsk::changes(20).cost()], [21, BulkAsk::changes(21).cost()], [200, BulkAsk::changes(200).cost()], [500, BulkAsk::changes(500).cost()]],
        "life_secs": [
            [1u64 << 20, 500_000, life_secs(1 << 20, 500_000)],
            [1u64 << 25, 500_000, life_secs(1 << 25, 500_000)],
            [1u64 << 30, 500_000, life_secs(1 << 30, 500_000)],
        ],
    })
}

#[test]
fn vectors_match_the_file() {
    let stored: Value = serde_json::from_str(include_str!("vectors.json")).unwrap();
    assert_eq!(stored, vectors());
}

#[test]
fn a_solution_verifies_and_tampering_fails() {
    let challenge = seal(KEY, "c1", KID, CHALLENGE_PAYLOAD.as_bytes());
    let seed = seed_of(&challenge);
    let target = target_for(4, 4096);
    let (nonces, _) = solve(&seed, 4, target);
    assert!(verify(&seed, 4, target, &nonces));
    let wire = encode_nonces(&nonces);
    assert_eq!(decode_nonces(&wire, 4).unwrap(), nonces);
    let mut swapped = nonces.clone();
    swapped.swap(0, 1);
    assert!(swapped == nonces || !verify(&seed, 4, target, &swapped));
    assert!(!verify(&seed, 4, target, &nonces[..3]));
    assert!(!verify(&seed_of("c1.1.other"), 4, target, &nonces));
    assert!(decode_nonces(&wire.to_uppercase(), 4).is_none() || wire == wire.to_uppercase());
    assert!(decode_nonces(&wire[1..], 4).is_none());
    assert!(decode_nonces("", 0).is_some_and(|n| n.is_empty()));
    assert!(decode_nonces(&"0".repeat(16 * 65), 65).is_none());
}

#[test]
fn signed_strings_open_only_with_their_key_kind_and_kid() {
    let sealed = seal(KEY, "t1", KID, TOKEN_PAYLOAD.as_bytes());
    assert!(sealed.starts_with("t1.1."));
    assert_eq!(kid_of("t1", &sealed), Some(KID));
    assert_eq!(
        open(key_of, "t1", &sealed).unwrap(),
        TOKEN_PAYLOAD.as_bytes()
    );
    assert!(open(key_of, "c1", &sealed).is_none());
    assert!(kid_of("c1", &sealed).is_none());
    assert!(open(|_| Some(b"another key".to_vec()), "t1", &sealed).is_none());
    assert!(open(|_| None, "t1", &sealed).is_none());
    let moved = sealed.replacen("t1.1.", "t1.2.", 1);
    assert!(
        open(|_| Some(KEY.to_vec()), "t1", &moved).is_none(),
        "the kid is under the MAC"
    );
    let (head, tag) = sealed.rsplit_once('.').unwrap();
    let mut bad = tag.to_string();
    let last = bad.pop().unwrap();
    bad.push(if last == 'A' { 'B' } else { 'A' });
    assert!(open(key_of, "t1", &format!("{head}.{bad}")).is_none());
    assert!(open(key_of, "t1", &format!("{sealed}.x")).is_none());
    assert!(open(key_of, "t1", "t1.1..").is_none());
    for kid in ["", "x", "123456789", "-1"] {
        assert!(
            kid_of("t1", &format!("t1.{kid}.e30.AAAA")).is_none(),
            "{kid:?}"
        );
    }
    let body_swapped = sealed.replacen("eyJ2Ijox", "eyJ2Ijoy", 1);
    assert!(open(key_of, "t1", &body_swapped).is_none());
    let oversize = seal(KEY, "t1", KID, &[b'x'; SEALED_MAX]);
    assert!(oversize.len() > SEALED_MAX && open(key_of, "t1", &oversize).is_none());
}

#[test]
fn bindings_are_short_distinct_and_keyed() {
    let a = bind(KEY, "g", "addr", "203.0.113.9");
    assert_eq!(a.len(), 22);
    assert!(a.starts_with("g:"));
    assert_ne!(a, bind(KEY, "g", "addr", "203.0.113.10"));
    assert_ne!(a, bind(b"other key", "g", "addr", "203.0.113.9"));
    assert_ne!(bind(KEY, "u", "user", "x"), bind(KEY, "u", "addr", "x"));
}

#[test]
fn targets_scale_with_work() {
    assert_eq!(target_for(1, 1), u64::MAX);
    assert_eq!(target_for(16, 3), u64::MAX);
    assert_eq!(target_for(16, 1 << 20), 1 << 48);
    assert_eq!(target_for(0, 1 << 20), target_for(1, 1 << 20));
    assert_eq!(target_for(100, 1 << 20), target_for(64, 1 << 20));
    let w = work_of(16, target_for(16, 1 << 24));
    assert!((w - (1u64 << 24) as f64).abs() < 1.0);
}

#[test]
fn work_doubles_every_step_and_caps() {
    assert_eq!(work_for(1000, 0, 8, 1 << 30), Some(1000));
    assert_eq!(work_for(1000, 8, 8, 1 << 30), Some(2000));
    assert_eq!(work_for(1000, 16, 8, 1 << 30), Some(4000));
    assert_eq!(work_for(1000, 4, 8, 1 << 30), Some(1414));
    assert_eq!(work_for(1 << 20, 80, 8, 1 << 29), None);
    assert_eq!(work_for(1, 63 * 8, 8, u64::MAX), None);
    let mut last = 0;
    for score in 0..200 {
        match work_for(1000, score, 8, u64::MAX) {
            Some(w) => {
                assert!(w >= last);
                last = w;
            }
            None => break,
        }
    }
}

#[test]
fn load_never_turns_a_challenge_into_a_wait() {
    let max = 1u64 << 25;
    assert_eq!(
        work_with_load(1 << 22, 16, 4, 8, max),
        work_for(1 << 22, 20, 8, max)
    );
    assert_eq!(
        work_with_load(1 << 22, 24, 4, 8, max),
        Some(max),
        "the cap, not a wait"
    );
    assert_eq!(work_with_load(1 << 22, 24, 0, 8, max), Some(max));
    assert_eq!(
        work_with_load(1 << 22, 32, 0, 8, max),
        None,
        "the score alone waits"
    );
    assert_eq!(work_with_load(1 << 22, 32, 8, 8, max), None);
}

#[test]
fn every_challenge_fits_its_life_on_a_slow_device() {
    for w in [1u64 << 10, 1 << 20, 1 << 25, 1 << 30] {
        let life = life_secs(w, 500_000);
        assert!(
            life >= 300 && life as f64 >= w as f64 / 500_000.0 + 300.0,
            "{w}"
        );
    }
    assert_eq!(life_secs(1 << 30, 500_000), 300 + 2148);
}

#[test]
fn redirect_targets_stay_on_this_origin() {
    for ok in [
        "/",
        "/s/lobby/",
        "/s/lobby/?x=1#y",
        "/%09/evil.com",
        "/a//b",
    ] {
        assert_eq!(safe_target(ok), ok, "{ok:?}");
    }
    let long = format!("/{}", "a".repeat(2048));
    for bad in [
        "",
        "//evil.com",
        "/\t/evil.com",
        "/\n/evil.com",
        "/\r/evil.com",
        "\\\\evil.com",
        "/\\evil.com",
        "https://evil.com",
        "evil.com",
        "/\u{0}x",
        "/\u{7f}x",
        "/\u{85}x",
        long.as_str(),
    ] {
        assert_eq!(safe_target(bad), "/", "{bad:?}");
    }
}

#[test]
fn solve_time_spread_shrinks_with_more_sub_puzzles() {
    let spread = |k: u32| {
        let target = target_for(k, 1 << 14);
        let runs: Vec<f64> = (0..200)
            .map(|r| solve(&seed_of(&format!("c1.1.spread.{r}")), k, target).1 as f64)
            .collect();
        let mean = runs.iter().sum::<f64>() / runs.len() as f64;
        let var = runs.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / runs.len() as f64;
        (mean, var.sqrt() / mean)
    };
    let (m1, cv1) = spread(1);
    let (m16, cv16) = spread(16);
    eprintln!("k=1 mean {m1:.0} cv {cv1:.2}; k=16 mean {m16:.0} cv {cv16:.2}");
    assert!(cv1 > 0.7 && cv16 < 0.4);
    assert!((m16 / f64::from(1 << 14) - 1.0).abs() < 0.15);
}

const CLIENT: &str = "AAECAwQFBgcICQoLDA0ODw";

#[test]
fn client_ids_are_16_base64url_bytes() {
    assert!(client_id_ok(CLIENT));
    for bad in [
        "",
        "AAECAwQFBgcICQoLDA0OD",
        "AAECAwQFBgcICQoLDA0ODwA",
        "AAECAwQFBgcICQoLDA0OD+",
        "AAECAwQFBgcICQoLDA0OD/",
        "AAECAwQFBgcICQoLDA0OD=",
    ] {
        assert!(!client_id_ok(bad), "{bad:?}");
    }
}

#[test]
fn requesters_with_one_user_agent_differ_by_client_id() {
    let ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X)";
    let a = requester(None, "203.0.113.9", Some(CLIENT), ua);
    let b = requester(None, "203.0.113.9", Some("_wECAwQFBgcICQoLDA0ODw"), ua);
    assert_ne!(a, b, "same group and user agent, different client ids");
    assert_eq!(
        requester(None, "203.0.113.9", None, ua),
        requester(None, "203.0.113.9", Some("bad"), ua)
    );
    assert!(requester(None, "203.0.113.9", None, ua).starts_with("u:"));
    assert_ne!(
        requester(None, "203.0.113.9", None, ua),
        requester(None, "203.0.113.9", None, "curl/8")
    );
    assert_eq!(
        requester(Some("h:00ff"), "203.0.113.9", Some(CLIENT), ua),
        "s:h:00ff"
    );
}

#[test]
fn sign_in_bindings_are_exact() {
    let group_only = binding(
        KEY,
        Caller::Signin {
            group: "203.0.113.9",
            username: None,
            client: Some(CLIENT),
        },
    );
    let alice = binding(
        KEY,
        Caller::Signin {
            group: "203.0.113.9",
            username: Some("alice"),
            client: Some(CLIENT),
        },
    );
    assert_ne!(
        group_only, alice,
        "a group-only token can't pay for a body naming a username"
    );
    assert_eq!(
        alice,
        binding(
            KEY,
            Caller::Signin {
                group: "203.0.113.9",
                username: Some("ALICE"),
                client: Some(CLIENT)
            }
        )
    );
    assert_ne!(
        alice,
        binding(
            KEY,
            Caller::Signin {
                group: "203.0.113.9",
                username: Some("alice "),
                client: Some(CLIENT)
            }
        ),
        "the handlers don't trim either"
    );
    assert_ne!(
        alice,
        binding(
            KEY,
            Caller::Signin {
                group: "203.0.113.9",
                username: Some("alice"),
                client: None
            }
        ),
        "the client id travels with the token"
    );
    assert_ne!(
        alice,
        binding(
            KEY,
            Caller::Signin {
                group: "203.0.113.10",
                username: Some("alice"),
                client: Some(CLIENT)
            }
        )
    );
    let guest = binding(
        KEY,
        Caller::Guest {
            group: "203.0.113.9",
            client: Some(CLIENT),
        },
    );
    assert!(guest.starts_with("g:") && guest.contains(",c:"));
    assert_eq!(
        binding(
            KEY,
            Caller::Guest {
                group: "203.0.113.9",
                client: Some("bad")
            }
        ),
        binding(
            KEY,
            Caller::Guest {
                group: "203.0.113.9",
                client: None
            }
        )
    );
    assert!(binding(KEY, Caller::Session("h:00ff")).starts_with("a:"));
    assert!(
        binding(
            KEY,
            Caller::Page {
                ua: "Mozilla/5.0",
                group: Some("203.0.113.9")
            }
        )
        .contains(",g:")
    );
}

#[test]
fn forward_auth_codes_need_their_verifier() {
    let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    let challenge = challenge_of(verifier);
    assert_eq!(
        challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        "RFC 7636 appendix B"
    );
    assert!(verifier_ok(verifier, &challenge));
    assert!(!verifier_ok("another verifier", &challenge));
    assert!(!verifier_ok(verifier, ""));
    assert!(!verifier_ok(verifier, &challenge[1..]));
}

/// What `/pow/token`, `/pow/pass` and `trust::redeem` all check before they act: the MAC and
/// kid, the redeemer's classes, the expiry, the binding, the work, then the shared spent set.
fn redeem_as(
    sealed: &str,
    nonces: &str,
    redeemer: Redeemer,
    binding_now: &str,
    now: u64,
    spent: &mut SpentSet,
) -> Result<(String, u64, String, u64), &'static str> {
    let payload = open(key_of, "c1", sealed).ok_or("seal")?;
    let v: Value = serde_json::from_slice(&payload).map_err(|_| "json")?;
    let cls = v["cls"].as_str().ok_or("cls")?.to_string();
    let (k, w, exp) = (
        v["k"].as_u64().ok_or("k")? as u32,
        v["w"].as_u64().ok_or("w")?,
        v["exp"].as_u64().ok_or("exp")?,
    );
    let r = v["r"].as_str().ok_or("r")?.to_string();
    if !accepts(redeemer, &cls) {
        return Err("class");
    }
    if now > exp + 30 {
        return Err("expired");
    }
    if v["sub"].as_str() != Some(binding_now) {
        return Err("binding");
    }
    let nonces = decode_nonces(nonces, k).ok_or("nonces")?;
    if !verify(&seed_of(sealed), k, target_for(k, w), &nonces) {
        return Err("work");
    }
    if !spent.spend(&r, exp, now) {
        return Err("spent");
    }
    Ok((cls, w, r, exp))
}

fn challenge_for(cls: &str, sub: &str, r: &str) -> (String, String) {
    let payload = format!(
        r#"{{"v":1,"alg":"s256","cls":"{cls}","sub":"{sub}","k":4,"w":4096,"iat":1767225600,"exp":1767225901,"r":"{r}"}}"#
    );
    let sealed = seal(KEY, "c1", KID, payload.as_bytes());
    let (nonces, _) = solve(&seed_of(&sealed), 4, target_for(4, 4096));
    (sealed, encode_nonces(&nonces))
}

#[test]
fn a_solution_is_spent_once_across_every_redeemer() {
    let acct = binding(KEY, Caller::Session("h:00ff"));
    let now = 1767225700;
    let mut spent = SpentSet::default();
    let (c, n) = challenge_for("general", &acct, "AAAAAAAAAAAAAAAAAAAAAA");
    let solved = redeem_as(&c, &n, Redeemer::Redeem, &acct, now, &mut spent).unwrap();
    assert_eq!(
        (solved.0.as_str(), solved.1, solved.3),
        ("general", 4096, 1767225901)
    );
    assert_eq!(
        redeem_as(&c, &n, Redeemer::Token, &acct, now, &mut spent),
        Err("spent"),
        "redeem, then /pow/token"
    );
    let (c, n) = challenge_for("general", &acct, "AQAAAAAAAAAAAAAAAAAAAA");
    assert!(redeem_as(&c, &n, Redeemer::Token, &acct, now, &mut spent).is_ok());
    assert_eq!(
        redeem_as(&c, &n, Redeemer::Redeem, &acct, now, &mut spent),
        Err("spent"),
        "/pow/token, then redeem"
    );
    let (c, n) = challenge_for("general", &acct, "AgAAAAAAAAAAAAAAAAAAAA");
    assert_eq!(
        redeem_as(&c, &n, Redeemer::Redeem, &acct, now, &mut spent).map(|_| ()),
        Ok(())
    );
    assert_eq!(
        redeem_as(&c, &n, Redeemer::Redeem, &acct, now, &mut spent),
        Err("spent"),
        "redeem twice"
    );
}

#[test]
fn each_redeemer_takes_only_its_classes() {
    let acct = binding(KEY, Caller::Session("h:00ff"));
    let now = 1767225700;
    let mut spent = SpentSet::default();
    for (cls, redeemer, ok) in [
        ("signin", Redeemer::Redeem, false),
        ("page", Redeemer::Redeem, false),
        ("page", Redeemer::Token, false),
        ("general", Redeemer::Pass, false),
        ("signin", Redeemer::Pass, false),
        ("signin", Redeemer::Token, true),
        ("page", Redeemer::Pass, true),
    ] {
        let r = format!("{:0<22}", format!("{cls}{redeemer:?}"));
        let (c, n) = challenge_for(cls, &acct, &r);
        assert_eq!(
            redeem_as(&c, &n, redeemer, &acct, now, &mut spent).is_ok(),
            ok,
            "{cls} {redeemer:?}"
        );
    }
    let (c, n) = challenge_for("general", &acct, "AwAAAAAAAAAAAAAAAAAAAA");
    let other = binding(KEY, Caller::Session("h:0100"));
    assert_eq!(
        redeem_as(&c, &n, Redeemer::Redeem, &other, now, &mut spent),
        Err("binding")
    );
    assert_eq!(
        redeem_as(&c, &n, Redeemer::Redeem, &acct, 1767225901 + 31, &mut spent),
        Err("expired")
    );
    assert!(
        redeem_as(&c, &n, Redeemer::Redeem, &acct, now, &mut spent).is_ok(),
        "refusals spend nothing"
    );
}

#[test]
fn spent_entries_last_past_their_challenge() {
    let mut spent = SpentSet::default();
    assert!(spent.spend("r", 100, 50));
    assert!(!spent.spend("r", 100, 129));
    assert!(
        spent.spend("r", 100, 131),
        "forgotten only once the challenge itself is dead"
    );
}

#[test]
fn bulk_costs_come_from_what_the_request_asks() {
    for (limit, units) in [
        (None, 20),
        (Some("100"), 1),
        (Some("101"), 2),
        (Some("150"), 2),
        (Some("1"), 1),
        (Some("0"), 1),
        (Some("-5"), 1),
        (Some("5000"), 50),
        (Some("99999"), 50),
        (Some("abc"), 20),
        (Some("150.7"), 20),
    ] {
        assert_eq!(BulkAsk::page(limit).cost(), units, "{limit:?}");
    }
    assert_eq!(
        BulkAsk::page(Some("99999")),
        BulkAsk::Page { messages: 5000 },
        "the handler serves what was priced"
    );
    assert_eq!(BulkAsk::MediaBatch.cost(), 8);
    for (range, units) in [
        (None, 8),
        (Some("bytes=0-1048575"), 1),
        (Some("bytes=0-1048576"), 2),
        (Some("bytes=-500"), 1),
        (Some("bytes=0-"), 8),
        (Some("bytes=0-99999999"), 8),
        (Some("bytes=0-1,5-6"), 8),
        (Some("bytes=5-1"), 8),
        (Some("bytes=-0"), 8),
        (Some("items=0-1"), 8),
        (Some("nonsense"), 8),
    ] {
        assert_eq!(BulkAsk::range(range).cost(), units, "{range:?}");
    }
    assert_eq!(
        BulkAsk::range(Some("bytes=0-99999999")),
        BulkAsk::MediaRange {
            bytes: BULK_PART_MAX
        }
    );
    for (n, units) in [(0, 1), (1, 1), (20, 1), (21, 2), (200, 10), (500, 10)] {
        assert_eq!(BulkAsk::changes(n).cost(), units, "{n}");
    }
}
