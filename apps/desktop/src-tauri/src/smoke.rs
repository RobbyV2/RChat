// Test builds only (`--features smoke`): runs the script named by RCHAT_SMOKE in every page and
// ends the app when the script navigates to `smoke://pass` or `smoke://fail/<reason>`. With
// RCHAT_SMOKE_SERVER=<port>, the app's own server runs on that port from an empty folder.
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

// Sets up the app's own server for this run only (nothing is saved) and starts it before the
// page loads.
#[cfg(feature = "server")]
pub fn own_server(app: &AppHandle) {
    use rchat_desktop_core::settings::ServerSettings;
    use tauri::Manager;
    let port = std::env::var("RCHAT_SMOKE_SERVER").ok();
    let Some(port) = port.and_then(|port| port.parse().ok()) else {
        return;
    };
    let dir = std::env::temp_dir().join(format!("rchat-smoke-server-{}", std::process::id()));
    crate::lock(&app.state::<crate::Shell>().settings).server = ServerSettings {
        set_up: true,
        port,
        data_dir: dir.display().to_string(),
        ..ServerSettings::default()
    };
    let status = crate::server::start(app);
    println!(
        "SMOKE SERVER {:?} {}",
        status.state,
        status.error.unwrap_or_default()
    );
}
