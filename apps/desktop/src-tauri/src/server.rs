// The app's own server: the supervisor from the core crate, its commands, and what the tray
// and the window need from it.
use crate::{MAIN, Shell, lock, plain, tray};
use rchat_desktop_core::server::assets::{Asset, Resolver};
use rchat_desktop_core::server::dirs::{self, MoveMode};
use rchat_desktop_core::server::form::Form;
use rchat_desktop_core::server::logs::{Logs, Page};
use rchat_desktop_core::server::{Status, Supervisor};
use rchat_desktop_core::settings::{ServerSettings, Settings};
use rchat_desktop_core::tray_menu::{self, Effect};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

pub struct Host {
    supervisor: Supervisor,
    logs: Arc<Logs>,
    // The data folder of a server set up with no folder named.
    built_in: PathBuf,
    // Held from reading the saved settings until the step that uses them is done and saved,
    // so no step runs on settings another one is about to replace.
    steps: Mutex<()>,
}

// The web app bundled into this binary. Tauri's own lookup answers every unknown path with the
// start page, so only paths that are bundled files are passed on to it.
fn bundled(app: &AppHandle) -> Option<Resolver> {
    let files: HashSet<String> = app
        .asset_resolver()
        .iter()
        .map(|(path, _)| path.into_owned())
        .collect();
    if files.is_empty() {
        return None;
    }
    let app = app.clone();
    Some(Arc::new(move |path: &str| {
        let found = files
            .contains(path)
            .then(|| app.asset_resolver().get(path.into()))??;
        Some(Asset {
            bytes: found.bytes,
            mime: found.mime_type,
            csp: found.csp_header,
        })
    }))
}

pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let logs = Logs::new();
    logs.install(cfg!(dev));
    let built_in = dirs::default_dir(&app.path().app_data_dir()?);
    let supervisor = Supervisor::new(built_in.clone(), bundled(app), logs.clone());
    let watcher = app.clone();
    supervisor.on_change(move || announce(&watcher));
    app.manage(Host {
        supervisor,
        logs,
        built_in,
        steps: Mutex::new(()),
    });
    Ok(())
}

fn saved(app: &AppHandle) -> ServerSettings {
    app.state::<Shell>().settings().server
}

pub fn status(app: &AppHandle) -> Status {
    app.state::<Host>().supervisor.status(&saved(app))
}

// Runs `work` on the saved settings, one step at a time.
fn step<T>(app: &AppHandle, work: impl FnOnce(&Supervisor, &ServerSettings) -> T) -> T {
    let host = app.state::<Host>();
    let _step = lock(&host.steps);
    work(&host.supervisor, &saved(app))
}

// False as well in a run that never brought the supervisor up.
pub fn running(app: &AppHandle) -> bool {
    app.try_state::<Host>()
        .is_some_and(|host| host.supervisor.running())
}

// The tray's server block, once a server is set up.
pub fn tray_block(app: &AppHandle) -> Option<tray_menu::Server> {
    let host = app.try_state::<Host>()?;
    let saved = saved(app);
    saved.set_up.then(|| host.supervisor.tray(&saved))
}

// Tells the page and the tray. The tray's menu belongs to the main thread.
pub fn announce(app: &AppHandle) {
    let _ = app.emit_to(MAIN, "server-status", status(app));
    let main = app.clone();
    let _ = app.run_on_main_thread(move || {
        let block = tray_block(&main);
        if let Err(e) = tray::update(&main, |s| s.server = block) {
            eprintln!("tray menu: {e}");
        }
    });
}

// These wait for the server, so they stay off the main thread.
pub fn start(app: &AppHandle) -> Status {
    step(app, Supervisor::start)
}

pub fn stop(app: &AppHandle) -> Status {
    step(app, Supervisor::stop)
}

pub fn restart(app: &AppHandle) -> Status {
    step(app, Supervisor::restart)
}

fn later(app: &AppHandle, work: fn(&AppHandle) -> Status) {
    let app = app.clone();
    std::thread::spawn(move || work(&app));
}

pub fn start_later(app: &AppHandle) {
    later(app, start);
}

// Waits for the server to end. Nothing to do when none runs.
pub fn stop_now(app: &AppHandle) {
    if running(app) {
        stop(app);
    }
}

// The tray's server picks. Starting and stopping wait for the server, off the main thread.
pub fn pick(app: &AppHandle, effect: Effect) {
    match effect {
        Effect::StartServer => later(app, start),
        Effect::StopServer => later(app, stop),
        Effect::RestartServer => later(app, restart),
        Effect::CopyAddress => {
            if let Some(url) = status(app).url {
                let _ = app.clipboard().write_text(url);
            }
        }
        Effect::Open | Effect::Page(_) | Effect::Mute(_) | Effect::CheckUpdates | Effect::Quit => {}
    }
}

// Runs `work` on its own thread: it may wait for the server to start or stop.
async fn off_main<T: Send + 'static>(
    app: AppHandle,
    work: impl FnOnce(&AppHandle) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (done, mut result) = tauri::async_runtime::channel(1);
    std::thread::spawn(move || {
        let _ = done.blocking_send(work(&app));
    });
    result
        .recv()
        .await
        .unwrap_or_else(|| Err("The server task stopped".into()))
}

#[tauri::command]
pub fn server_status(app: AppHandle) -> Status {
    status(&app)
}

// Checks and saves the form. A running server keeps what it started with until it restarts.
#[tauri::command]
pub fn server_save(app: AppHandle, settings: Form) -> Result<Status, String> {
    let built_in = app.state::<Host>().built_in.clone();
    app.state::<Shell>().change(|current| {
        current.server = settings.apply(&current.server, &built_in)?;
        Ok(())
    })?;
    announce(&app);
    Ok(status(&app))
}

#[tauri::command]
pub async fn server_start(app: AppHandle) -> Result<Status, String> {
    off_main(app, |app| Ok(start(app))).await
}

#[tauri::command]
pub async fn server_stop(app: AppHandle) -> Result<Status, String> {
    off_main(app, |app| Ok(stop(app))).await
}

#[tauri::command]
pub async fn server_restart(app: AppHandle) -> Result<Status, String> {
    off_main(app, |app| Ok(restart(app))).await
}

#[tauri::command]
pub fn server_logs(app: AppHandle, after: u64) -> Page {
    app.state::<Host>().logs.after(after)
}

#[tauri::command]
pub async fn server_backup(app: AppHandle) -> Result<String, String> {
    off_main(app, |app| step(app, Supervisor::backup)).await
}

#[tauri::command]
pub async fn server_restore(app: AppHandle, name: String) -> Result<Status, String> {
    off_main(app, move |app| {
        step(app, |supervisor, saved| supervisor.restore(saved, &name))
    })
    .await
}

#[tauri::command]
pub async fn server_test_address(app: AppHandle, url: String) -> Result<String, String> {
    off_main(app, move |app| {
        app.state::<Host>().supervisor.test_address(&url)
    })
    .await
}

#[tauri::command]
pub async fn server_move(app: AppHandle, folder: String, mode: MoveMode) -> Result<Status, String> {
    off_main(app, move |app| {
        let folder = folder.trim().to_string();
        step(app, |supervisor, saved| {
            supervisor.move_data(saved, &folder, mode)?;
            app.state::<Shell>().change(|current| {
                current.server.data_dir = folder;
                Ok(())
            })
        })?;
        announce(app);
        Ok(status(app))
    })
    .await
}

#[tauri::command]
pub async fn server_pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    let Some(picked) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|e| plain(e, "Could not use that folder"))?;
    Ok(Some(path.display().to_string()))
}

#[tauri::command]
pub fn server_open_folder(app: AppHandle, which: String) -> Result<(), String> {
    let data = PathBuf::from(status(&app).data_dir);
    let folder = match which.as_str() {
        "data" => data,
        "logs" => dirs::logs_dir(&data),
        "backups" => dirs::backups_dir(&data),
        _ => return Err("Unknown folder".into()),
    };
    std::fs::create_dir_all(&folder).map_err(|e| plain(e, "Could not open the folder"))?;
    app.opener()
        .open_path(folder.display().to_string(), None::<&str>)
        .map_err(|e| plain(e, "Could not open the folder"))
}

// Stops the server and forgets its setup; with `delete_data`, its data goes too.
#[tauri::command]
pub async fn server_remove(app: AppHandle, delete_data: bool) -> Result<Status, String> {
    off_main(app, move |app| {
        step(app, |supervisor, saved| {
            supervisor.remove(saved, delete_data)?;
            app.state::<Shell>().change(|current| {
                let Settings {
                    boot,
                    server,
                    resume_server,
                    ..
                } = current;
                *server = ServerSettings::default();
                boot.server = false;
                *resume_server = false;
                Ok(())
            })
        })?;
        announce(app);
        Ok(status(app))
    })
    .await
}
