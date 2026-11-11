use std::path::PathBuf;

const SECRETS: [&str; 6] = [
    "PreviewRequest",
    "SealedKey",
    "ShareKey",
    "SealedFile",
    "DeliverResponse",
    "PutObjectsRequest",
];

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR")?).join("../../proto");
    let package = root.join("rchat/fed/v1");
    println!("cargo:rerun-if-changed={}", package.display());
    let mut files = std::fs::read_dir(&package)?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<Result<Vec<_>, _>>()?;
    files.retain(|path| path.extension().is_some_and(|ext| ext == "proto"));
    files.sort();
    prost_build::Config::new()
        .skip_debug(SECRETS.map(|name| format!(".rchat.fed.v1.{name}")))
        .compile_fds(protox::compile(&files, [&root])?)?;
    Ok(())
}
