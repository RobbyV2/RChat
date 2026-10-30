use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn init_panic_hook() {
    console_error_panic_hook::set_once();
    let _ = console_log::init_with_level(log::Level::Debug);
}

#[wasm_bindgen]
pub fn greet(name: &str) -> String {
    format!("Hello, {name}! (from Rust WASM)")
}

#[wasm_bindgen]
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

#[wasm_bindgen]
pub fn mask_profanity(text: &str) -> String {
    rchat_profanity::mask(text)
}

#[wasm_bindgen]
pub fn is_profane(text: &str) -> bool {
    rchat_profanity::is_profane(text, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = "../../apps/web/app/lib/__tests__/fixtures/profanity.json";

    fn fixture() -> serde_json::Value {
        rchat_profanity::SAMPLES
            .lines()
            .map(|text| {
                serde_json::json!({
                    "text": text,
                    "masked": mask_profanity(text),
                    "profane": is_profane(text),
                })
            })
            .collect()
    }

    // `UPDATE_FIXTURES=1 cargo test -p rust-next-wasm` rewrites the bun fixture (then prettier it).
    #[test]
    fn bun_fixture_matches_the_matcher() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(FIXTURE);
        let want = fixture();
        if std::env::var_os("UPDATE_FIXTURES").is_some() {
            let text = serde_json::to_string_pretty(&want).expect("json");
            std::fs::write(&path, text + "\n").expect("write fixture");
        }
        let got: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("read fixture"))
                .expect("fixture json");
        assert_eq!(
            got, want,
            "run UPDATE_FIXTURES=1 cargo test -p rust-next-wasm"
        );
    }
}
