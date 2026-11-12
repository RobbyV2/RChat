// Writes `src/fold_table.rs` from `tools/confusables.txt`:
// `cargo run -p rchat-automation --example gen_fold`. With `--check` it only compares.

use rchat_automation::fold;
use std::path::Path;
use std::process::ExitCode;
use std::{env, fs};

fn main() -> ExitCode {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let source =
        fs::read_to_string(root.join("tools/confusables.txt")).expect("tools/confusables.txt");
    let text = fold::render(&fold::derive(&source), fold::version(&source));
    let target = root.join("src/fold_table.rs");
    if env::args().any(|a| a == "--check") {
        return match fs::read_to_string(&target).is_ok_and(|have| have == text) {
            true => ExitCode::SUCCESS,
            false => {
                eprintln!("src/fold_table.rs is stale: run the gen_fold example");
                ExitCode::FAILURE
            }
        };
    }
    fs::write(&target, text).expect("src/fold_table.rs");
    ExitCode::SUCCESS
}
