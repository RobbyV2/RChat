use rchat_pow_wasm::{pow_chunk, seed_ptr};
use serde_json::Value;

#[test]
fn pow_chunk_reproduces_the_vectors() {
    let v: Value = serde_json::from_str(include_str!("../../pow/tests/vectors.json")).unwrap();
    let seed = rchat_pow::seed_of(v["challenge"].as_str().unwrap());
    unsafe { std::ptr::copy_nonoverlapping(seed.as_ptr(), seed_ptr(), 32) };
    let target: u64 = v["target"].as_str().unwrap().parse().unwrap();
    let found: Vec<String> = (0..v["k"].as_u64().unwrap() as u32)
        .map(|sub| {
            let hit = (0u64..)
                .step_by(1024)
                .map(|start| pow_chunk(sub, start, 1024, target))
                .find(|hit| *hit != 0)
                .unwrap();
            (hit - 1).to_string()
        })
        .collect();
    let want: Vec<&str> = v["nonces"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n.as_str().unwrap())
        .collect();
    assert_eq!(found, want);

    let first: u64 = want[0].parse().unwrap();
    assert_eq!(
        pow_chunk(0, 0, first as u32, target),
        0,
        "no winner before the first"
    );
    assert_eq!(pow_chunk(0, first, 1, target), first + 1);
    assert_eq!(pow_chunk(0, first, 0, target), 0, "no tries");
    assert_eq!(
        pow_chunk(0, 1 << 56, 16, 0),
        0,
        "nothing is below a target of 0"
    );
    assert_eq!(pow_chunk(0, 1 << 56, 16, u64::MAX), (1 << 56) + 1);
}
