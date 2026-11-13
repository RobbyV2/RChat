use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use rchat_app_docs::{Document, Error, merge};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use yrs::Update;
use yrs::updates::decoder::Decode;

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/vectors")
}

fn vectors() -> Value {
    serde_json::from_slice(&std::fs::read(dir().join("docs.json")).unwrap()).unwrap()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn sha(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn bin(v: &Value) -> Vec<u8> {
    STANDARD.decode(v.as_str().unwrap()).unwrap()
}

fn bins(v: &Value) -> Vec<Vec<u8>> {
    v.as_array().unwrap().iter().map(bin).collect()
}

fn text(v: &Value) -> &str {
    v.as_str().unwrap()
}

fn count(v: &Value) -> usize {
    v.as_u64().unwrap() as usize
}

// The bytes are the client library's when their length and hash are.
fn same(bytes: &[u8], want: &Value) {
    assert_eq!(
        (bytes.len(), sha(bytes)),
        (count(&want["len"]), text(&want["sha256"]).to_string())
    );
}

// Two updates hold the same when the library reads the same blocks and deletions out of both.
// Outside text the two libraries order the keys of an object and the clients of the deletions
// differently, so the bytes can differ where the content does not.
fn alike(ours: &[u8], theirs: &[u8]) {
    assert_eq!(ours.len(), theirs.len());
    assert!(Update::decode_v1(ours).unwrap() == Update::decode_v1(theirs).unwrap());
}

fn log(file: &str) -> Vec<Vec<u8>> {
    let raw = std::fs::read(dir().join(file)).unwrap();
    let mut updates = Vec::new();
    let mut at = 0;
    while at + 4 <= raw.len() {
        let n = u32::from_le_bytes(raw[at..at + 4].try_into().unwrap()) as usize;
        updates.push(raw[at + 4..at + 4 + n].to_vec());
        at += 4 + n;
    }
    assert_eq!(at, raw.len());
    updates
}

#[test]
fn the_vectors_are_the_client_library_s() {
    let v = vectors();
    assert_eq!(text(&v["yjs"]), "13.6.33");
    assert_eq!(v["logs"].as_array().unwrap().len(), 2);
    assert_eq!(v["shapes"].as_array().unwrap().len(), 5);
    assert_eq!(v["merges"].as_array().unwrap().len(), 7);
    assert_eq!(v["pending"]["updates"].as_array().unwrap().len(), 6);
    assert_eq!(v["versions"]["saved"].as_array().unwrap().len(), 50);
}

#[test]
fn the_model_s_update_logs_end_in_the_client_library_s_bytes() {
    for l in vectors()["logs"].as_array().unwrap() {
        let file = text(&l["file"]);
        let raw = std::fs::read(dir().join(file)).unwrap();
        assert_eq!(sha(&raw), text(&l["file_sha256"]), "{file}");
        let updates = log(file);
        assert_eq!(updates.len(), count(&l["updates"]), "{file}");

        let half = count(&l["half"]["updates"]);
        let mut doc = Document::new();
        for u in &updates[..half] {
            doc.apply(u).unwrap();
        }
        assert_eq!(
            hex(&doc.state_vector().unwrap()),
            text(&l["half"]["state_vector"])
        );
        for u in &updates[half..] {
            doc.apply(u).unwrap();
        }

        let state = doc.compact().unwrap();
        let since = doc
            .state_since(&unhex(text(&l["half"]["state_vector"])))
            .unwrap();
        assert_eq!(state.len(), count(&l["state"]["len"]), "{file}");
        assert_eq!(since.len(), count(&l["half"]["since"]["len"]), "{file}");
        match l["bytes"].as_bool().unwrap() {
            true => {
                same(&state, &l["state"]);
                same(&since, &l["half"]["since"]);
            }
            false => {
                let stem = file.trim_end_matches(".bin");
                let theirs = std::fs::read(dir().join(format!("{stem}.state.bin"))).unwrap();
                same(&theirs, &l["state"]);
                alike(&state, &theirs);
                let theirs = std::fs::read(dir().join(format!("{stem}.since.bin"))).unwrap();
                same(&theirs, &l["half"]["since"]);
                alike(&since, &theirs);
            }
        }
        assert_eq!(doc.size().unwrap(), state.len());
        assert_eq!(hex(&doc.state_vector().unwrap()), text(&l["state_vector"]));
        let words = doc.plain_text(text(&l["text"]["root"])).unwrap();
        assert_eq!(words.chars().count(), count(&l["text"]["chars"]));
        assert_eq!(sha(words.as_bytes()), text(&l["text"]["sha256"]));

        let reopened = Document::load([&state]).unwrap();
        alike(&reopened.compact().unwrap(), &state);
        assert_eq!(reopened.plain_text("t").unwrap(), words);
        assert_eq!(
            reopened.state_vector().unwrap(),
            doc.state_vector().unwrap()
        );

        let mut behind = Document::load(&updates[..half]).unwrap();
        behind.apply(&since).unwrap();
        alike(&behind.compact().unwrap(), &state);
        assert_eq!(behind.plain_text("t").unwrap(), words);
    }
}

#[test]
fn each_document_shape_keeps_the_client_library_s_bytes() {
    for s in vectors()["shapes"].as_array().unwrap() {
        let name = text(&s["name"]);
        let updates = bins(&s["updates"]);
        let want = bin(&s["state"]);
        let mut doc = Document::new();
        for u in &updates {
            doc.apply(u).unwrap();
        }
        let state = doc.compact().unwrap();
        match s["bytes"].as_bool().unwrap() {
            true => assert_eq!(state, want, "{name}"),
            false => alike(&state, &want),
        }
        assert_eq!(doc.size().unwrap(), want.len(), "{name}");
        assert_eq!(
            hex(&doc.state_vector().unwrap()),
            text(&s["state_vector"]),
            "{name}"
        );
        for (root, words) in s["text"].as_object().unwrap() {
            assert_eq!(doc.plain_text(root).unwrap(), text(words), "{name} {root}");
        }
        let reopened = Document::load([&want]).unwrap();
        alike(&reopened.compact().unwrap(), &want);
        assert_eq!(
            reopened.state_vector().unwrap(),
            doc.state_vector().unwrap(),
            "{name}"
        );
        assert_eq!(
            doc.state_since(&doc.state_vector().unwrap()).unwrap(),
            bin(&s["since_own"]),
            "{name}"
        );
    }
}

#[test]
fn plain_text_is_the_text_without_marks_or_embeds() {
    let v = vectors();
    let s = &v["shapes"][0];
    assert_eq!(text(&s["name"]), "text");
    let doc = Document::load(bins(&s["updates"])).unwrap();
    let words = doc.plain_text("body").unwrap();
    assert_eq!(words, text(&s["text"]["body"]));
    assert!(words.starts_with("Jexl, world\nline two"));
    assert!(words.contains("\u{e9}\u{e8} \u{4e16}\u{754c} \u{1f600} e\u{301} end"));
    assert!(!words.contains("assets/a.png"));
    assert_eq!(doc.plain_text("missing").unwrap(), "");

    let sheet = Document::load(bins(&v["shapes"][1]["updates"])).unwrap();
    assert_eq!(sheet.plain_text("cells").unwrap(), "");
    assert_eq!(sheet.plain_text("rows").unwrap(), "");
    alike(&sheet.compact().unwrap(), &bin(&v["shapes"][1]["state"]));
}

#[test]
fn an_empty_document_is_two_bytes() {
    let doc = Document::new();
    assert_eq!(doc.compact().unwrap(), [0, 0]);
    assert_eq!(doc.state_vector().unwrap(), [0]);
    assert_eq!(doc.size().unwrap(), 2);
    assert_eq!(doc.plain_text("body").unwrap(), "");
    assert_eq!(doc.state_since(&[0]).unwrap(), [0, 0]);
    assert_eq!(
        Document::load(Vec::<Vec<u8>>::new())
            .unwrap()
            .compact()
            .unwrap(),
        [0, 0]
    );
    assert_eq!(Document::default().compact().unwrap(), [0, 0]);
}

#[test]
fn merging_two_updates_leaves_the_same_document() {
    let v = vectors();
    let merges = v["merges"].as_array().unwrap();
    let base = bins(&merges[0]["base"]);
    let whole = bin(&merges[0]["state"]);
    assert_eq!(Document::load(&base).unwrap().compact().unwrap(), whole);
    for (i, m) in merges.iter().enumerate() {
        let (a, b) = (bin(&m["a"]), bin(&m["b"]));
        let ours = merge(&a, &b).unwrap();
        let theirs = bin(&m["merged"]);

        let apart = Document::load([&a, &b]).unwrap();
        let ours_alone = Document::load([&ours]).unwrap();
        let theirs_alone = Document::load([&theirs]).unwrap();
        assert_eq!(
            ours_alone.compact().unwrap(),
            apart.compact().unwrap(),
            "merge {i}"
        );
        assert_eq!(
            theirs_alone.compact().unwrap(),
            apart.compact().unwrap(),
            "merge {i}"
        );

        let mut doc = Document::load(&base).unwrap();
        doc.apply(&ours).unwrap();
        assert_eq!(doc.compact().unwrap(), whole, "merge {i}");
    }
}

#[test]
fn copies_that_parted_offline_meet_in_the_same_bytes() {
    let v = vectors();
    let o = &v["offline"];
    let mut a = Document::load([bin(&o["a"])]).unwrap();
    let mut b = Document::load([bin(&o["b"])]).unwrap();
    assert_eq!(hex(&a.state_vector().unwrap()), text(&o["a_vector"]));
    assert_eq!(hex(&b.state_vector().unwrap()), text(&o["b_vector"]));
    let for_b = a.state_since(&b.state_vector().unwrap()).unwrap();
    let for_a = b.state_since(&a.state_vector().unwrap()).unwrap();
    assert_eq!(for_b, bin(&o["for_b"]));
    alike(&for_a, &bin(&o["for_a"]));
    a.apply(&for_a).unwrap();
    b.apply(&for_b).unwrap();
    alike(&a.compact().unwrap(), &bin(&o["merged"]));
    alike(&b.compact().unwrap(), &bin(&o["merged"]));
    assert_eq!(a.compact().unwrap(), b.compact().unwrap());
    assert_eq!(hex(&a.state_vector().unwrap()), text(&o["merged_vector"]));
    assert_eq!(a.state_vector().unwrap(), b.state_vector().unwrap());
    assert_eq!(a.plain_text("body").unwrap(), b.plain_text("body").unwrap());
    assert_eq!(
        sha(a.plain_text("body").unwrap().as_bytes()),
        text(&o["text_sha256"])
    );
}

#[test]
fn an_update_that_arrives_before_what_it_builds_on_waits_for_it() {
    let v = vectors();
    let p = &v["pending"];
    let updates = bins(&p["updates"]);
    let order: Vec<usize> = p["order"].as_array().unwrap().iter().map(count).collect();
    let steps = p["steps"].as_array().unwrap();
    let mut doc = Document::new();
    for (step, i) in order.iter().enumerate() {
        doc.apply(&updates[*i]).unwrap();
        assert_eq!(
            doc.plain_text("body").unwrap(),
            text(&steps[step]["text"]),
            "step {step}"
        );
        assert_eq!(
            hex(&doc.state_vector().unwrap()),
            text(&steps[step]["state_vector"]),
            "step {step}"
        );
    }
    assert_eq!(doc.compact().unwrap(), bin(&p["state"]));
    assert_eq!(
        doc.compact().unwrap(),
        Document::load(&updates).unwrap().compact().unwrap()
    );
}

#[test]
fn applying_an_update_twice_changes_nothing() {
    let v = vectors();
    let updates = bins(&v["shapes"][0]["updates"]);
    let mut doc = Document::load(&updates).unwrap();
    let before = doc.compact().unwrap();
    for u in &updates {
        doc.apply(u).unwrap();
    }
    doc.apply(&before).unwrap();
    assert_eq!(doc.compact().unwrap(), before);
}

struct Version {
    bytes: Vec<u8>,
}

fn rebuild(versions: &[Version], upto: usize) -> Document {
    Document::load(versions[..=upto].iter().map(|v| &v.bytes)).unwrap()
}

// Model test I17: versions are a base and the update since the version before; a dropped
// version folds into its neighbour and every other one still rebuilds exactly.
#[test]
fn saved_versions_as_a_base_and_deltas_rebuild_exactly() {
    let v = vectors();
    let saved = v["versions"]["saved"].as_array().unwrap();
    let mut live = Document::new();
    live.apply(&bin(&v["versions"]["start"])).unwrap();
    let mut versions: Vec<Version> = Vec::new();
    let mut last: Option<Vec<u8>> = None;
    let mut log = 0;
    for s in saved {
        for edit in bins(&s["edits"]) {
            log += edit.len();
            live.apply(&edit).unwrap();
        }
        let bytes = match &last {
            Some(vector) => live.state_since(vector).unwrap(),
            None => live.compact().unwrap(),
        };
        same(&bytes, &s["delta"]);
        same(&live.compact().unwrap(), &s["state"]);
        last = Some(live.state_vector().unwrap());
        versions.push(Version { bytes });
    }
    assert_eq!(log, count(&v["versions"]["log_bytes"]));

    let stored: usize = versions.iter().map(|x| x.bytes.len()).sum();
    assert_eq!(stored, count(&v["versions"]["stored"]));
    let state = live.size().unwrap();
    assert!(stored < 3 * state);
    assert!(50 * state > 10 * stored);

    for at in [0, 9, 36, 49] {
        let doc = rebuild(&versions, at);
        let words = doc.plain_text("body").unwrap();
        assert_eq!(sha(words.as_bytes()), text(&saved[at]["text_sha256"]));
        assert_eq!(words.chars().count(), count(&saved[at]["chars"]));
        same(&doc.compact().unwrap(), &saved[at]["state"]);
    }

    let mid = merge(&versions[20].bytes, &versions[21].bytes).unwrap();
    versions[21].bytes = mid;
    versions.remove(20);
    let base = Document::load([&versions[0].bytes, &versions[1].bytes])
        .unwrap()
        .compact()
        .unwrap();
    same(&base, &v["versions"]["folded_base"]);
    versions[1].bytes = base;
    versions.remove(0);
    assert_eq!(versions.len(), 48);

    let kept: Vec<&Value> = saved
        .iter()
        .enumerate()
        .filter(|(i, _)| *i != 0 && *i != 20)
        .map(|(_, s)| s)
        .collect();
    for (at, s) in kept.iter().enumerate() {
        let doc = rebuild(&versions, at);
        assert_eq!(
            sha(doc.plain_text("body").unwrap().as_bytes()),
            text(&s["text_sha256"]),
            "version {at}"
        );
        same(&doc.compact().unwrap(), &s["state"]);
    }
    assert_eq!(
        rebuild(&versions, 47).compact().unwrap(),
        live.compact().unwrap()
    );
}

#[test]
fn what_is_not_an_update_is_refused_and_leaves_the_document_alone() {
    let v = vectors();
    let updates = bins(&v["shapes"][0]["updates"]);
    let mut doc = Document::load(&updates).unwrap();
    let before = doc.compact().unwrap();
    let whole = before.clone();
    let mut bad: Vec<Vec<u8>> = vec![
        Vec::new(),
        vec![0],
        vec![1],
        vec![255; 64],
        b"not an update".to_vec(),
        vec![1, 1, 1, 0, 4, 1, 4, 98, 111, 100, 121],
    ];
    for cut in 1..whole.len() {
        bad.push(whole[..cut].to_vec());
    }
    for b in &bad {
        if let Err(e) = doc.apply(b) {
            assert_eq!(e, Error::Update);
        }
        assert_eq!(doc.compact().unwrap(), before);
    }
    assert_eq!(doc.apply(&[]), Err(Error::Update));
    assert_eq!(doc.apply(b"not an update"), Err(Error::Update));
    assert_eq!(merge(&[], &updates[0]), Err(Error::Update));
    assert_eq!(merge(&updates[0], &[7, 7, 7]), Err(Error::Update));
    assert!(Document::load([&updates[0][..], &[][..]]).is_err());
    assert_eq!(doc.state_since(&[]), Err(Error::StateVector));
    assert_eq!(doc.state_since(&[5, 1]), Err(Error::StateVector));
    assert_eq!(Error::Update.to_string(), "not a document update");
    assert_eq!(Error::StateVector.to_string(), "not a state vector");
    assert_eq!(
        Error::Broken.to_string(),
        "the document must be loaded again"
    );
}

// Found by bending updates: the library takes the second update apart and then refuses it part
// way, so what the document holds is no longer known.
#[test]
fn a_document_the_library_gave_up_on_says_so_until_it_is_loaded_again() {
    let held = [1, 1, 238, 7, 4, 8, 0, 238, 7, 3, 1, 119, 2, 111, 49, 0];
    let bad = [
        1, 1, 238, 7, 3, 3, 1, 2, 115, 49, 7, 33, 98, 106, 101, 99, 116, 115, 0, 0,
    ];
    let mut doc = Document::load([&held]).unwrap();
    let before = doc.compact().unwrap();
    assert_eq!(doc.apply(&bad), Err(Error::Broken));
    assert_eq!(doc.compact(), Err(Error::Broken));
    assert_eq!(doc.state_vector(), Err(Error::Broken));
    assert_eq!(doc.state_since(&[0]), Err(Error::Broken));
    assert_eq!(doc.size(), Err(Error::Broken));
    assert_eq!(doc.plain_text("body"), Err(Error::Broken));
    assert_eq!(doc.apply(&held), Err(Error::Broken));
    assert_eq!(doc.apply(&[0, 0]), Err(Error::Broken));
    assert_eq!(
        Document::load([&held[..], &bad[..]]).err(),
        Some(Error::Broken)
    );

    let again = Document::load([&before]).unwrap();
    assert_eq!(again.compact().unwrap(), before);
    assert!(Document::load([&bad]).unwrap().compact().is_ok());
}

// The library reserves room for what an update declares before reading it: a few bytes that
// declare four thousand million clients or blocks once took half a second each to refuse.
#[test]
fn an_update_that_declares_more_than_it_holds_is_refused_at_once() {
    let huge = [0xff, 0xff, 0xff, 0xff, 0x0f];
    let mut bombs: Vec<Vec<u8>> = vec![
        huge.to_vec(),
        [&huge[..], &[1, 1, 0, 0, 1, 0]].concat(),
        [&[1][..], &huge, &[1, 0, 0, 1, 0]].concat(),
        [&[2, 1, 1, 0, 0, 1][..], &huge, &[2, 0]].concat(),
        [&[0][..], &huge].concat(),
        [&[0, 1, 1][..], &huge].concat(),
        [&[1, 1, 1, 0, 8, 1, 1, b'm'][..], &huge].concat(),
        [&[1, 1, 1, 0, 4, 1, 1, b't'][..], &huge].concat(),
        vec![0x80; 12],
        vec![40, 1, 1, 0],
        vec![1, 40, 1, 0],
    ];
    let mut seed = 0x9e37_79b9_7f4a_7c15u64;
    for _ in 0..400 {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        bombs.push(
            seed.to_le_bytes()
                .iter()
                .map(|b| b | 0x80)
                .chain([0x0f, 1, 0])
                .collect(),
        );
        bombs.push([&seed.to_le_bytes()[..5], &[1, 1, 0]].concat());
    }
    let started = std::time::Instant::now();
    let mut doc = Document::new();
    for bomb in &bombs {
        assert_eq!(doc.apply(bomb), Err(Error::Update), "{bomb:?}");
        assert_eq!(merge(bomb, &[0, 0]), Err(Error::Update), "{bomb:?}");
    }
    for bomb in [&bombs[0], &bombs[1], &bombs[8], &bombs[9]] {
        assert_eq!(doc.state_since(bomb), Err(Error::StateVector), "{bomb:?}");
    }
    for bomb in &bombs {
        if let Ok(update) = doc.state_since(bomb) {
            assert_eq!(update, [0, 0]);
        }
    }
    assert_eq!(doc.compact().unwrap(), [0, 0]);
    assert!(started.elapsed() < std::time::Duration::from_secs(20));
    assert_eq!(doc.apply(&[1, 1, 1, 0, 0, 1, 0]), Ok(()));
}

// Updates bent at random, onto a document that already holds content. The CRDT library panics on
// some of them; none may leave the crate, and a document that took one must still encode.
// APP_DOCS_BENT sets how many are tried.
#[test]
fn bytes_bent_at_random_never_stop_the_process() {
    let v = vectors();
    let mut pool: Vec<Vec<u8>> = Vec::new();
    for s in v["shapes"].as_array().unwrap() {
        pool.extend(bins(&s["updates"]));
        pool.push(bin(&s["state"]));
    }
    pool.extend(bins(&v["pending"]["updates"]));
    pool.extend(
        v["merges"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| bin(&m["merged"])),
    );
    pool.retain(|bytes| bytes.len() > 2);
    let rounds = std::env::var("APP_DOCS_BENT")
        .ok()
        .and_then(|n| n.parse().ok())
        .unwrap_or(3_000);
    let mut seed = 0x2545_f491_4f6c_dd1du64;
    let mut next = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    let (mut taken, mut refused, mut broken) = (0, 0, 0);
    for round in 0..rounds {
        let mut bytes = match next() % 8 {
            0 => (0..next() % 48).map(|_| next() as u8).collect(),
            _ => pool[round % pool.len()].clone(),
        };
        let at = (next() % bytes.len().max(1) as u64) as usize;
        match next() % 4 {
            0 => {
                for _ in 0..1 + next() % 4 {
                    let at = (next() % bytes.len().max(1) as u64) as usize;
                    if let Some(byte) = bytes.get_mut(at) {
                        *byte = next() as u8;
                    }
                }
            }
            1 => bytes.truncate(at),
            2 => bytes.insert(at, next() as u8),
            _ => {
                let end = (at + (next() % 6) as usize).min(bytes.len());
                bytes.drain(at..end);
            }
        }
        let mut doc = Document::load([&pool[(round + 1) % pool.len()]]).unwrap();
        let result = doc.apply(&bytes);
        let whole = doc.compact();
        match result {
            Ok(()) => taken += 1,
            Err(Error::Broken) => broken += 1,
            Err(_) => refused += 1,
        }
        assert_eq!(whole.is_err(), result == Err(Error::Broken), "{bytes:?}");
        assert_eq!(doc.state_vector().is_err(), whole.is_err());
        assert_eq!(doc.size().is_err(), whole.is_err());
        assert_eq!(doc.plain_text("body").is_err(), whole.is_err());
        let _ = doc.state_since(&bytes);
        if let Ok(merged) = merge(&bytes, &pool[round % pool.len()]) {
            match Document::load([&merged]) {
                Ok(doc) => assert!(doc.compact().is_ok()),
                Err(e) => assert_eq!(e, Error::Broken),
            }
        }
        if let Ok(whole) = whole {
            let again = Document::load([&whole]).unwrap();
            assert_eq!(again.state_vector().unwrap(), doc.state_vector().unwrap());
        }
    }
    println!(
        "{rounds} bent updates: {taken} taken, {refused} refused, {broken} broke the document"
    );
    assert!(taken > rounds / 20 && refused > rounds / 2);
}
