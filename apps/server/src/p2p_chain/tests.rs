use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signer, SigningKey};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::*;

pub(crate) const AT: u64 = 1_762_400_000_000;

/// The fixed test key the client's vector generator calls `name`.
pub(crate) fn pair(name: &str) -> SigningKey {
    SigningKey::from_bytes(&Sha256::digest(format!("rchat-p2p-chain-vector {name}")).into())
}

pub(crate) fn id_of(key: &SigningKey) -> String {
    URL_SAFE_NO_PAD.encode(key.verifying_key().to_bytes())
}

pub(crate) fn id(name: &str) -> String {
    id_of(&pair(name))
}

pub(crate) fn sign(key: &SigningKey, tag: &[u8], body: &Value) -> String {
    let body = canonical(body).expect("canonical");
    URL_SAFE_NO_PAD.encode(key.sign(&[tag, body.as_bytes()].concat()).to_bytes())
}

fn with(mut body: Value, fields: &[(&str, String)]) -> Value {
    for (name, value) in fields {
        body[*name] = json!(value);
    }
    body
}

/// The identity of a record: the digest of its fields without its signatures.
pub(crate) fn head_of(record: &Value) -> Head {
    let mut body = record.clone();
    let map = body.as_object_mut().expect("a record");
    for sig in ["sig_ik", "sig_rk", "sig", "sig_next"] {
        map.remove(sig);
    }
    Head {
        n: record["n"].as_u64().expect("n"),
        d: digest(&canonical(&body).expect("canonical")),
    }
}

pub(crate) fn make_creation(ik: &SigningKey, rk: &SigningKey, pk: &str, at: u64) -> Value {
    let body = json!({"v": 1, "ik": id_of(ik), "n": 0, "rk": id_of(rk), "pk": pk, "at": at});
    let sigs = [
        ("sig_ik", sign(ik, CREATE_TAG, &body)),
        ("sig_rk", sign(rk, CREATE_TAG, &body)),
    ];
    with(body, &sigs)
}

fn chain_body(ik: &str, prev: &Head, pk: &str, keep: &[String], at: u64) -> Value {
    let mut keep = keep.to_vec();
    keep.sort();
    json!({"v": 1, "ik": ik, "n": prev.n + 1, "prev": prev.d, "pk": pk, "keep": keep, "at": at})
}

pub(crate) fn make_recovery(
    ik: &str,
    rk: &SigningKey,
    prev: &Head,
    pk: &str,
    keep: &[String],
    at: u64,
) -> Value {
    let body = chain_body(ik, prev, pk, keep, at);
    let sig = sign(rk, CHAIN_TAG, &body);
    with(body, &[("sig", sig)])
}

pub(crate) fn make_reset(
    ik: &str,
    rk: &SigningKey,
    next: &SigningKey,
    prev: &Head,
    pk: &str,
    keep: &[String],
    at: u64,
) -> Value {
    let body = with(chain_body(ik, prev, pk, keep, at), &[("rk", id_of(next))]);
    let sigs = [
        ("sig", sign(rk, CHAIN_TAG, &body)),
        ("sig_next", sign(next, CHAIN_TAG, &body)),
    ];
    with(body, &sigs)
}

pub(crate) fn make_removal(
    ik: &str,
    rk: &SigningKey,
    prev: &Head,
    pk: &str,
    keep: &[String],
    at: u64,
) -> Value {
    let body = with(chain_body(ik, prev, pk, keep, at), &[("rk", String::new())]);
    let sig = sign(rk, CHAIN_TAG, &body);
    with(body, &[("sig", sig)])
}

/// The identity the vectors use: its creation record, a recovery after it and a reset after
/// that.
pub(crate) struct Vera {
    pub ik: String,
    pub rk: SigningKey,
    pub rk2: SigningKey,
    pub cr: Value,
    pub r1: Value,
    pub reset2: Value,
}

pub(crate) fn vera() -> Vera {
    let (ik, rk, rk2) = (pair("ik"), pair("rk"), pair("rk2"));
    let cr = make_creation(&ik, &rk, &id("pk0"), AT);
    let ik = id_of(&ik);
    let r1 = make_recovery(&ik, &rk, &head_of(&cr), &id("pk1"), &[id("d2")], AT + 1);
    let reset2 = make_reset(
        &ik,
        &rk,
        &rk2,
        &head_of(&r1),
        &id("pk2"),
        &[id("d2")],
        AT + 2,
    );
    Vera {
        ik,
        rk,
        rk2,
        cr,
        r1,
        reset2,
    }
}

#[derive(Deserialize)]
struct Expect {
    cr: bool,
    heads: Vec<Head>,
    primary: Vec<String>,
    in_force: Vec<String>,
    frozen: bool,
    refused: Vec<usize>,
    dead: Vec<usize>,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    cr: Value,
    chain: Vec<Value>,
    expect: Expect,
}

#[derive(Deserialize)]
struct BindExpect {
    ok: bool,
    head: Option<Head>,
}

#[derive(Deserialize)]
struct BindCase {
    name: String,
    sub: String,
    ik: String,
    ts: i64,
    proof: String,
    cr: Value,
    chain: Vec<Value>,
    expect: BindExpect,
}

#[derive(Deserialize)]
struct Vectors {
    cases: Vec<Case>,
    bind2: Vec<BindCase>,
}

const VECTORS: &str = include_str!("../../../../assets/p2p_chain_vectors.json");

// assets/p2p_chain_vectors.json is written by the client's p2p/chain.ts
// (apps/web/scripts/p2p_chain_vectors.ts): both readings of a chain agree on every case.
#[test]
fn every_chain_vector_reads_as_the_client_reads_it() {
    let Vectors { cases, bind2: _ } = serde_json::from_str(VECTORS).expect("vectors");
    assert!(cases.len() >= 35, "{}", cases.len());
    // review n-k-server r1 m1: the instance's verify_strict and the client give one answer
    let case = |name: &str| cases.iter().find(|c| c.name == name).expect(name);
    let torsion = case("a signature whose R has a small-order part is refused");
    assert_eq!(
        (&torsion.expect.refused, &torsion.expect.dead),
        (&vec![1], &vec![])
    );
    let key = case("a key with a torsion part: what holds without the cofactor counts");
    assert_eq!((&key.expect.refused, key.expect.heads.len()), (&vec![2], 1));
    let creation = case(
        "a creation record whose recovery key signature has an R with a small-order part is refused",
    );
    assert!(!creation.expect.cr);
    for Case {
        name,
        cr,
        chain,
        expect,
    } in cases
    {
        let ik = cr["ik"].as_str().expect("ik");
        let Ok(read) = read(&cr, &chain) else {
            assert!(!expect.cr, "{name}");
            assert_eq!(
                verify(ik, &cr, &chain).err(),
                Some(ChainError::Creation),
                "{name}"
            );
            continue;
        };
        assert!(expect.cr, "{name}");
        let heads = read.heads();
        let primary: Vec<&str> = heads.iter().filter_map(|h| read.primary_id(h)).collect();
        let in_force: Vec<&str> = heads.iter().filter_map(|h| read.in_force(h)).collect();
        assert_eq!(heads, expect.heads, "{name}");
        assert_eq!(primary, expect.primary, "{name}");
        assert_eq!(in_force, expect.in_force, "{name}");
        assert_eq!(read.frozen(), expect.frozen, "{name}");
        assert_eq!(read.refused(), expect.refused, "{name}");
        assert_eq!(read.dead(), expect.dead, "{name}");
        assert!(heads.iter().all(|h| read.primary(h).is_some()), "{name}");
        assert_eq!(
            verify(ik, &cr, &chain).err(),
            expect.refused.first().map(|i| ChainError::Record(*i)),
            "{name}"
        );
    }
}

/// The proof of a badge request: `key` signs the binding of `sub` to `ik` at `head` and `ts`.
pub(crate) fn bind_proof(key: &SigningKey, sub: &str, ik: &str, head: &Head, ts: u64) -> String {
    let msg = crate::identity::binding2_message(sub, ik, head, ts).expect("message");
    URL_SAFE_NO_PAD.encode(key.sign(&msg).to_bytes())
}

// The badge requests of the same file: the instance finds the head the client's `bindingHead2`
// finds, and refuses what it refuses.
#[test]
fn every_badge_vector_reads_as_the_client_reads_it() {
    let Vectors { cases: _, bind2 } = serde_json::from_str(VECTORS).expect("vectors");
    assert!(bind2.len() >= 17, "{}", bind2.len());
    let size = |name: &str| {
        let case = bind2.iter().find(|c| c.name == name).expect(name);
        canonical(&json!({"cr": case.cr, "chain": case.chain}))
            .expect("canonical")
            .len()
    };
    let largest =
        "the largest valid chain: 8 resets that keep 8 devices each, every at at its largest";
    assert_eq!(size(largest), 6913);
    assert_eq!(size("a request over 7 KiB is refused"), KEYS_BYTES + 1);
    let mut refused = vec![];
    let mut found = vec![];
    for BindCase {
        name,
        sub,
        ik,
        ts,
        proof,
        cr,
        chain,
        expect,
    } in bind2
    {
        let got = binding_head(&sub, &ik, ts, &proof, &cr, &chain);
        assert_eq!(got.is_ok(), expect.ok, "{name}: {got:?}");
        assert_eq!(got.as_ref().ok(), expect.head.as_ref(), "{name}");
        match got {
            Ok(head) => found.push((name, head)),
            Err(e) => refused.push((name, e)),
        }
    }
    assert!(found.iter().any(|(n, h)| n == largest && h.n == CHAIN_MAX));
    let why = |name: &str| refused.iter().find(|(n, _)| n == name).map(|(_, e)| *e);
    assert_eq!(
        why("a chain of 9 records is refused"),
        Some(BindingError::Size)
    );
    assert_eq!(
        why("a request over 7 KiB is refused"),
        Some(BindingError::Size)
    );
    assert_eq!(why("rival resets are refused"), Some(BindingError::Frozen));
    assert_eq!(
        why("a proof whose R has a small-order part is refused"),
        Some(BindingError::Proof)
    );
    assert_eq!(
        why("a chain record that does not attach is refused"),
        Some(BindingError::Chain(ChainError::Record(0)))
    );
    assert_eq!(
        why("an older primary while the chain holds a later record is refused"),
        Some(BindingError::Proof)
    );
}

#[test]
fn a_badge_request_is_bounded_before_any_signature_is_checked() {
    let Vera { ik, rk, cr, r1, .. } = vera();
    assert_eq!(KEYS_BYTES, 7 * 1024);
    let sub = "vera@chat.example.org";
    let h0 = head_of(&cr);
    let siblings: Vec<Value> = (0..9)
        .map(|i| make_recovery(&ik, &rk, &h0, &id(&format!("s{i}")), &[], AT))
        .collect();
    let head = head_of(&siblings[0]);
    let proof = bind_proof(&pair("s0"), sub, &ik, &head, 7);
    assert!(keys_fit(&cr, &siblings[..8]) && !keys_fit(&cr, &siblings));
    assert_eq!(
        binding_head(sub, &ik, 7, &proof, &cr, &siblings[..8]),
        Ok(head.clone())
    );
    assert_eq!(
        binding_head(sub, &ik, 7, &proof, &cr, &siblings),
        Err(BindingError::Size)
    );
    // The bound comes first: a request that is too long and holds nothing valid answers the same.
    let junk = vec![json!({"n": 1}); 9];
    for cr in [json!(null), json!({"v": 1}), cr.clone()] {
        assert_eq!(
            binding_head(sub, &ik, 7, "x", &cr, &junk),
            Err(BindingError::Size)
        );
    }
    let fat = json!({"pad": "x".repeat(KEYS_BYTES)});
    assert_eq!(
        binding_head(sub, &ik, 7, &proof, &cr, &[fat]),
        Err(BindingError::Size)
    );
    let float = json!({"at": 0.5});
    assert_eq!(
        binding_head(sub, &ik, 7, &proof, &cr, &[float]),
        Err(BindingError::Size),
        "no canonical form"
    );
    assert_eq!(
        binding_head(sub, &ik, 7, &proof, &json!({"v": 1}), &[]),
        Err(BindingError::Chain(ChainError::Creation))
    );

    // The canonical size is the client's: KEYS_BYTES fits and one byte more doesn't.
    let size = |chain: &[Value]| {
        canonical(&json!({"cr": cr, "chain": chain}))
            .expect("canonical")
            .len()
    };
    let pad = |len: usize| json!({ "p": "x".repeat(len) });
    let base = size(&[pad(0)]);
    assert!(keys_fit(&cr, &[pad(KEYS_BYTES - base)]));
    assert!(!keys_fit(&cr, &[pad(KEYS_BYTES - base + 1)]));

    // The proof: a head's primary, this account, this identity, this head and this time.
    let h1 = head_of(&r1);
    let chain = [r1.clone()];
    let by = |key: &str, sub: &str, head: &Head, ts: u64| {
        let proof = bind_proof(&pair(key), sub, &ik, head, ts);
        binding_head("vera@chat.example.org", &ik, 7, &proof, &cr, &chain)
    };
    assert_eq!(by("pk1", sub, &h1, 7), Ok(h1.clone()));
    for (key, signed_sub, head, ts, why) in [
        ("pk0", sub, &h0, 7, "an older primary"),
        ("pk1", sub, &h0, 7, "an older head"),
        ("pk1", "mallory@chat.example.org", &h1, 7, "another account"),
        ("pk1", sub, &h1, 8, "another time"),
        ("rk", sub, &h1, 7, "the recovery key"),
        ("ik", sub, &h1, 7, "the identity key"),
    ] {
        assert_eq!(
            by(key, signed_sub, head, ts),
            Err(BindingError::Proof),
            "{why}"
        );
    }
    let v1 = {
        let msg = crate::identity::binding_message(sub, 7);
        URL_SAFE_NO_PAD.encode(pair("pk1").sign(&msg).to_bytes())
    };
    assert_eq!(
        binding_head(sub, &ik, 7, &v1, &cr, &chain),
        Err(BindingError::Proof),
        "a bind1 proof"
    );
    assert_eq!(
        binding_head(sub, &ik, -7, &proof, &cr, &chain),
        Err(BindingError::Proof)
    );
    assert_eq!(
        binding_head(sub, &id("other ik"), 7, &proof, &cr, &chain),
        Err(BindingError::Chain(ChainError::Creation)),
        "another identity's chain"
    );
}

#[test]
fn the_test_keys_are_the_generators() {
    let Vectors { cases, bind2: _ } = serde_json::from_str(VECTORS).expect("vectors");
    let Vera {
        ik, cr, r1, reset2, ..
    } = vera();
    assert_eq!(cases[2].name, "a recovery and a reset");
    assert_eq!(ik, cases[2].cr["ik"]);
    assert_eq!((&cr, &vec![r1, reset2]), (&cases[2].cr, &cases[2].chain));
}

#[test]
fn r8_chain() {
    let Vera {
        ik,
        rk,
        rk2,
        cr,
        r1,
        reset2,
    } = vera();
    let chain = verify(&ik, &cr, &[r1.clone(), reset2.clone()]).expect("verifies");
    let head = head_of(&reset2);
    assert_eq!(chain.heads(), vec![head.clone()]);
    assert_eq!(chain.ik(), ik);
    assert_eq!(chain.primary_id(&head), Some(id("pk2").as_str()));
    assert_eq!(chain.in_force(&head), Some(id_of(&rk2).as_str()));
    assert_eq!(chain.in_force(&head_of(&r1)), Some(id_of(&rk).as_str()));
    assert!(!chain.frozen());
    let stale = Head {
        n: 1,
        d: head.d.clone(),
    };
    assert_eq!(chain.primary_id(&stale), None);

    let mut no_sig_rk = cr.clone();
    no_sig_rk.as_object_mut().expect("cr").remove("sig_rk");
    let ik_key = pair("ik");
    let pk_is_ik = make_creation(&ik_key, &rk, &ik, AT);
    let mut extra = cr.clone();
    extra["note"] = json!(1);
    for (bad, why) in [
        (&no_sig_rk, "no sig_rk"),
        (&pk_is_ik, "pk = ik"),
        (&extra, "extra"),
    ] {
        assert_eq!(
            verify(&ik, bad, &[]).err(),
            Some(ChainError::Creation),
            "{why}"
        );
    }
    assert_eq!(
        verify(&id("other ik"), &cr, &[]).err(),
        Some(ChainError::Creation)
    );

    let after_reset = make_recovery(&ik, &rk, &head, &id("pk3"), &[], AT + 3);
    let other = make_creation(&pair("other ik"), &pair("other rk"), &id("other pk"), AT);
    let wrong_prev = make_recovery(&ik, &rk, &head_of(&other), &id("pk1"), &[], AT + 1);
    let mut unknown = r1.clone();
    unknown["note"] = json!(1);
    for (bad, at, why) in [
        (
            vec![r1.clone(), reset2.clone(), after_reset],
            2,
            "the old key after a reset",
        ),
        (vec![wrong_prev], 0, "prev"),
        (vec![unknown], 0, "an unknown field"),
        (vec![reset2.clone()], 0, "no parent"),
    ] {
        assert_eq!(
            verify(&ik, &cr, &bad).err(),
            Some(ChainError::Record(at)),
            "{why}"
        );
    }
    let next = make_recovery(&ik, &rk2, &head, &id("pk3"), &[], AT + 3);
    verify(&ik, &cr, &[next, reset2, r1]).expect("the next key signs after a reset, any order");
}

#[test]
fn after_a_removal_the_primary_plays_recovery() {
    let Vera { ik, rk, cr, .. } = vera();
    let removal = make_removal(&ik, &rk, &head_of(&cr), &id("pkx"), &[id("d2")], AT + 1);
    let head = head_of(&removal);
    let by_primary = make_recovery(&ik, &pair("pkx"), &head, &id("pk2"), &[], AT + 2);
    let by_old = make_recovery(&ik, &rk, &head, &id("pk2"), &[], AT + 2);
    let chain = verify(&ik, &cr, &[removal.clone(), by_primary.clone()]).expect("verifies");
    assert_eq!(chain.in_force(&head), Some(id("pkx").as_str()));
    assert_eq!(chain.heads(), vec![head_of(&by_primary)]);
    assert_eq!(
        verify(&ik, &cr, &[removal.clone(), by_old]).err(),
        Some(ChainError::Record(1))
    );
    let rival = make_reset(
        &ik,
        &rk,
        &pair("thief rk"),
        &head_of(&cr),
        &id("pkz"),
        &[],
        AT + 1,
    );
    let frozen = verify(&ik, &cr, &[removal, rival]).expect("both are signed");
    assert!(frozen.frozen());
    assert_eq!(frozen.heads(), vec![head_of(&cr)]);
    assert_eq!(frozen.dead(), vec![0, 1]);
    assert_eq!(frozen.refused(), Vec::<usize>::new());
}

#[test]
fn a_ninth_record_is_refused() {
    let Vera { ik, rk, cr, .. } = vera();
    let mut chain = vec![];
    let mut prev = head_of(&cr);
    for n in 1..=9 {
        let r = make_recovery(&ik, &rk, &prev, &id(&format!("pk{n}")), &[], AT);
        prev = head_of(&r);
        chain.push(r);
    }
    assert_eq!(verify(&ik, &cr, &chain).err(), Some(ChainError::Record(8)));
    let read = verify(&ik, &cr, &chain[..8]).expect("eight");
    assert_eq!(read.heads()[0].n, CHAIN_MAX);
    let keep: Vec<String> = (0..9).map(|i| id(&format!("dev {i}"))).collect();
    let nine_kept = make_recovery(&ik, &rk, &head_of(&cr), &id("pk1"), &keep, AT);
    assert_eq!(
        verify(&ik, &cr, &[nine_kept]).err(),
        Some(ChainError::Record(0))
    );
}

// Numbers as the client's JSON.parse reads them: 1.0 and 1e0 are 1, -0 is refused.
#[test]
fn numbers_read_as_the_client_reads_them() {
    let Vera { ik, cr, r1, .. } = vera();
    let text = serde_json::to_string(&r1).expect("text");
    let at = format!("\"at\":{}", AT + 1);
    assert!(text.contains(&at));
    let parsed = |text: String| serde_json::from_str::<Value>(&text).expect("json");
    for same in [
        text.replace(&at, &format!("\"at\":{}.0", AT + 1)),
        text.replace(&at, "\"at\":1762400000.001e3"),
        text.replace("\"n\":1,", "\"n\":1.0,")
            .replace("\"v\":1", "\"v\":1e0"),
    ] {
        assert_ne!(same, text);
        let chain = verify(&ik, &cr, &[parsed(same)]).expect("the same record");
        assert_eq!(chain.heads(), vec![head_of(&r1)]);
    }
    let rk = pair("rk");
    let zero = make_recovery(&ik, &rk, &head_of(&cr), &id("pk1"), &[], 0);
    verify(&ik, &cr, std::slice::from_ref(&zero)).expect("at 0");
    let zero = serde_json::to_string(&zero).expect("text");
    for bad in [
        zero.replace("\"at\":0", "\"at\":-0"),
        zero.replace("\"at\":0", "\"at\":-0.0"),
        zero.replace("\"at\":0", "\"at\":0.5"),
        zero.replace("\"at\":0", "\"at\":\"0\""),
        zero.replace("\"at\":0", "\"at\":9007199254740992"),
        zero.replace("\"at\":0", "\"at\":-1"),
        zero.replace("\"at\":0", "\"at\":null"),
    ] {
        assert_ne!(bad, zero);
        assert_eq!(
            verify(&ik, &cr, &[parsed(bad.clone())]).err(),
            Some(ChainError::Record(0)),
            "{bad}"
        );
    }
}

#[test]
fn keys_and_signatures_have_one_encoding() {
    let Vera { ik, rk, cr, r1, .. } = vera();
    // y = p + 3 names the point with y = 3 a second time.
    let mut twice = [0xffu8; 32];
    (twice[0], twice[31]) = (0xf0, 0x7f);
    let twice = URL_SAFE_NO_PAD.encode(twice);
    let mut once = [0u8; 32];
    once[0] = 3;
    let once = URL_SAFE_NO_PAD.encode(once);
    assert!(crate::identity::p2p_key(&once).is_some() && key(&once).is_some());
    assert!(key(&twice).is_none());
    for weak in [[0u8; 32], {
        let mut one = [0u8; 32];
        one[0] = 1;
        one
    }] {
        assert!(key(&URL_SAFE_NO_PAD.encode(weak)).is_none());
    }
    let head = head_of(&cr);
    let kept = make_recovery(
        &ik,
        &rk,
        &head,
        &id("pk1"),
        std::slice::from_ref(&twice),
        AT,
    );
    let primary = make_recovery(&ik, &rk, &head, &twice, &[], AT);
    let mut padded = r1.clone();
    padded["sig"] = json!(format!("{}==", r1["sig"].as_str().expect("sig")));
    let mut loose = r1.clone();
    let sig = r1["sig"].as_str().expect("sig");
    let last = match sig.ends_with('A') {
        true => "B",
        false => "A",
    };
    loose["sig"] = json!(format!("{}{last}", &sig[..sig.len() - 1]));
    let mut short = r1.clone();
    short["prev"] = json!("AAAA");
    for (bad, why) in [
        (kept, "keep"),
        (primary, "pk"),
        (padded, "padding"),
        (loose, "sig"),
        (short, "prev"),
    ] {
        assert_eq!(
            verify(&ik, &cr, &[bad]).err(),
            Some(ChainError::Record(0)),
            "{why}"
        );
    }
}

#[test]
fn a_chain_extends_one_it_holds_every_record_of() {
    let Vera {
        ik,
        rk,
        cr,
        r1,
        reset2,
        ..
    } = vera();
    let head = head_of(&cr);
    let sibling = make_recovery(&ik, &rk, &head, &id("pkb"), &[id("db")], AT + 1);
    let chain = |recs: &[&Value]| {
        let recs: Vec<Value> = recs.iter().map(|r| (*r).clone()).collect();
        verify(&ik, &cr, &recs).expect("verifies")
    };
    let (none, one, two) = (chain(&[]), chain(&[&r1]), chain(&[&r1, &reset2]));
    let (beside, both) = (chain(&[&sibling]), chain(&[&sibling, &r1]));
    for (new, stored, extends, why) in [
        (&none, &none, true, "the same"),
        (&one, &none, true, "a first record"),
        (&two, &one, true, "one more"),
        (&both, &one, true, "a sibling"),
        (&both, &beside, true, "a sibling"),
        (&none, &one, false, "dropped"),
        (&one, &two, false, "dropped the last"),
        (&beside, &one, false, "another line"),
        (&one, &both, false, "dropped a sibling"),
    ] {
        assert_eq!(new.extends(stored), extends, "{why}");
    }
    let other_rk = make_creation(&pair("ik"), &pair("thief rk"), &id("pk0"), AT);
    let later = make_creation(&pair("ik"), &rk, &id("pk0"), AT + 1);
    for cr2 in [other_rk, later] {
        let other = verify(&ik, &cr2, &[]).expect("verifies");
        assert!(!other.extends(&none) && !none.extends(&other));
    }
    let twice = [r1.clone(), reset2.clone(), r1.clone()];
    let read = verify(&ik, &cr, &twice).expect("a record twice");
    assert_eq!(read.records(), vec![0, 1]);
    assert_eq!(chain(&[&reset2, &sibling, &r1]).records().len(), 3);
    assert_eq!(chain(&[&reset2, &r1]).records(), vec![1, 0]);
}

// The expected text is what the client's `canonical` gives for the same value.
#[test]
fn canonical_json_is_the_clients() {
    let value: Value = serde_json::from_str(
        r#"{"b":[1,2.0,-3,"x\"y\n\u0001\u007f\u00e9\u2028"],"a":{"\ud83d\ude00":null,"\uffff":true,"z":false,"A":1e3},"":0}"#,
    )
    .expect("json");
    assert_eq!(
        canonical(&value).as_deref(),
        Some(
            "{\"\":0,\"a\":{\"A\":1000,\"z\":false,\"\u{1f600}\":null,\"\u{ffff}\":true},\"b\":[1,2,-3,\"x\\\"y\\n\\u0001\u{7f}\u{e9}\u{2028}\"]}"
        )
    );
    let whole: Value =
        serde_json::from_str("[-9007199254740991, 9007199254740991, 0.0, 1e2]").expect("json");
    assert_eq!(
        canonical(&whole).as_deref(),
        Some("[-9007199254740991,9007199254740991,0,100]")
    );
    for bad in [
        "1.5",
        "-0",
        "9007199254740992",
        "-9007199254740992",
        r#""e\u0301""#,
        r#"{"e\u0301":1}"#,
        "[[1.5]]",
    ] {
        let value: Value = serde_json::from_str(bad).expect("json");
        assert_eq!(canonical(&value), None, "{bad}");
    }
}
