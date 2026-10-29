// Test builds only (`--features smoke`): runs the script named by RCHAT_SMOKE in every page and
// ends the app when the script navigates to `smoke://pass` or `smoke://fail/<reason>`.
use std::path::PathBuf;
use tauri::AppHandle;
use tauri_plugin_dialog::FilePath;
use url::Url;

pub fn script() -> Option<String> {
    let path = std::env::var_os("RCHAT_SMOKE")?;
    std::fs::read_to_string(path).ok()
}

// With RCHAT_SMOKE_SAVE set, saves go into that folder under their suggested name instead of
// asking through a dialog.
pub fn save_path(name: &str) -> Option<FilePath> {
    let dir = PathBuf::from(std::env::var_os("RCHAT_SMOKE_SAVE")?);
    Some(FilePath::Path(dir.join(name)))
}

pub fn verdict(app: &AppHandle, url: &Url) -> bool {
    if url.scheme() != "smoke" {
        return false;
    }
    let passed = url.host_str() == Some("pass");
    println!(
        "SMOKE {} {}",
        if passed { "PASS" } else { "FAIL" },
        url.path()
    );
    app.exit(if passed { 0 } else { 1 });
    true
}
