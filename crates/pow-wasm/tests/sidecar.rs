use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

const SIDECAR: &str = "apps/web/public/pow/rchat_pow.wasm.src-sha256";

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        match path.is_dir() {
            true => walk(&path, out),
            false => out.push(path),
        }
    }
}

const BUILD: &str = "crates/pow-wasm/build.sh";

/// What decides the module's bytes, by path from the repository root: the puzzle, this crate's
/// manifest, the build script (the toolchain and every profile key), then this crate's sources
/// in path order.
fn sources() -> Vec<String> {
    let root = root();
    let mut src = Vec::new();
    walk(&root.join("crates/pow-wasm/src"), &mut src);
    let mut src: Vec<String> = src
        .iter()
        .map(|p| {
            let rel = p.strip_prefix(&root).unwrap();
            rel.to_string_lossy().replace('\\', "/")
        })
        .collect();
    src.sort();
    [
        "crates/pow/src/puzzle.rs",
        "crates/pow-wasm/Cargo.toml",
        BUILD,
    ]
    .map(String::from)
    .into_iter()
    .chain(src)
    .collect()
}

/// The `profile.release` keys the build script sets, as dotted paths below `profile.release`.
fn pinned() -> Vec<String> {
    fs::read_to_string(root().join(BUILD))
        .unwrap()
        .lines()
        .filter_map(|l| l.trim().strip_prefix("--config 'profile.release."))
        .filter_map(|l| l.split_once('=').map(|(key, _)| key.to_string()))
        .collect()
}

/// SHA-256 of the files' bytes one after another, with every CRLF as LF.
fn digest(files: &[Vec<u8>]) -> String {
    let mut h = Sha256::new();
    for bytes in files {
        let mut rest = bytes.as_slice();
        while let Some(at) = rest.windows(2).position(|w| w == b"\r\n") {
            h.update(&rest[..at]);
            rest = &rest[at + 1..];
        }
        h.update(rest);
    }
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn the_committed_wasm_was_built_from_these_sources() {
    let files: Vec<Vec<u8>> = sources()
        .iter()
        .map(|p| fs::read(root().join(p)).unwrap())
        .collect();
    let now = digest(&files);
    let path = root().join(SIDECAR);
    if std::env::var_os("POW_WASM_WRITE").is_some() {
        fs::write(&path, format!("{now}\n")).unwrap();
    }
    let stored = fs::read_to_string(&path).unwrap_or_default();
    assert_eq!(
        stored.trim(),
        now,
        "crates/pow/src/puzzle.rs or crates/pow-wasm changed: run `just src pow-wasm`"
    );
}

#[test]
fn only_the_puzzle_this_crate_and_its_build_are_hashed() {
    assert_eq!(
        sources(),
        [
            "crates/pow/src/puzzle.rs",
            "crates/pow-wasm/Cargo.toml",
            "crates/pow-wasm/build.sh",
            "crates/pow-wasm/src/lib.rs",
        ]
    );
}

#[test]
fn the_build_names_its_toolchain_and_every_profile_key() {
    let script = fs::read_to_string(root().join(BUILD)).unwrap();
    assert!(script.contains(
        "cargo +1.99.1 build -p rchat-pow-wasm --release --target wasm32-unknown-unknown"
    ));
    let pinned = pinned();
    for key in [
        "opt-level",
        "lto",
        "codegen-units",
        "panic",
        "strip",
        "debug",
        "debug-assertions",
        "overflow-checks",
        "incremental",
    ] {
        assert!(
            pinned.iter().any(|p| p == key),
            "{key} is not set in {BUILD}"
        );
    }
}

#[test]
fn the_workspace_release_profile_sets_nothing_the_build_does_not() {
    let manifest = fs::read_to_string(root().join("Cargo.toml")).unwrap();
    let pinned = pinned();
    let mut table = String::new();
    for line in manifest.lines().map(str::trim) {
        if let Some(name) = line.strip_prefix('[') {
            table = name.trim_end_matches(']').to_string();
            continue;
        }
        let Some(below) = table.strip_prefix("profile.release") else {
            continue;
        };
        let Some((key, _)) = line.split_once('=') else {
            continue;
        };
        let path = format!("{}.{}", below, key.trim());
        let path = path.trim_start_matches('.');
        assert!(
            pinned.iter().any(|p| p == path),
            "the workspace sets profile.release.{path}: set it in {BUILD} too and run `just src pow-wasm`"
        );
    }
}

#[test]
fn ci_rebuilds_with_the_same_toolchain() {
    let script = fs::read_to_string(root().join(BUILD)).unwrap();
    let toolchain = script
        .split("cargo +")
        .nth(1)
        .and_then(|rest| rest.split(' ').next())
        .unwrap();
    let checks = fs::read_to_string(root().join(".github/workflows/checks.yml")).unwrap();
    let install = format!(
        "rustup toolchain install {toolchain} --profile minimal --target wasm32-unknown-unknown"
    );
    assert!(checks.contains(&install), "{install}");
    assert!(checks.contains("sh crates/pow-wasm/build.sh"));
    assert!(checks.contains("git diff --exit-code apps/web/public/pow"));
}

#[test]
fn a_crlf_checkout_hashes_the_same() {
    let lf = [
        b"fn a() {}\n\nfn b() {}\n".to_vec(),
        b"[package]\n".to_vec(),
    ];
    let crlf = [
        b"fn a() {}\r\n\r\nfn b() {}\r\n".to_vec(),
        b"[package]\r\n".to_vec(),
    ];
    assert_eq!(digest(&lf), digest(&crlf));
    assert_eq!(
        digest(&[b"abc".to_vec()]),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert_eq!(
        digest(&[b"a".to_vec(), b"bc".to_vec()]),
        digest(&[b"abc".to_vec()])
    );
    assert_ne!(
        digest(&lf),
        digest(&[
            b"fn a() {}\n\nfn c() {}\n".to_vec(),
            b"[package]\n".to_vec()
        ])
    );
    assert_ne!(
        digest(&[b"a\rb".to_vec()]),
        digest(&[b"a\nb".to_vec()]),
        "a lone CR stays"
    );
}
