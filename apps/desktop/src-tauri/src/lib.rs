mod files;
mod links;
#[cfg(all(desktop, feature = "server"))]
mod server;
// A build without the app's own server: none runs, and the tray has no server block.
#[cfg(all(desktop, not(feature = "server")))]
mod server {
    use rchat_desktop_core::tray_menu::{Effect, Server};
    use tauri::AppHandle;

    pub fn running(_: &AppHandle) -> bool {
        false
    }

    pub fn tray_block(_: &AppHandle) -> Option<Server> {
        None
    }

    pub fn start_later(_: &AppHandle) {}

    pub fn stop_now(_: &AppHandle) {}

    pub fn pick(_: &AppHandle, _: Effect) {}
}
#[cfg(feature = "smoke")]
mod smoke;
#[cfg(desktop)]
mod tray;
#[cfg(desktop)]
mod tray_smoke;

use rchat_desktop_core::settings::{self, Settings};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use tauri::ipc::{InvokeBody, Request};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::{DialogExt, FilePath};
use tauri_plugin_notification::{NotificationExt, PermissionState};
use tauri_plugin_opener::OpenerExt;
use url::Url;

const MAIN: &str = "main";

struct Shell {
    dir: PathBuf,
    settings: Mutex<Settings>,
    links: Mutex<links::PendingLinks>,
    saves: files::Saves,
    #[cfg(desktop)]
    tray: Mutex<Option<tray::Tray>>,
    #[cfg(desktop)]
    reported: Mutex<tray::Reported>,
    #[cfg(desktop)]
    update: Mutex<Option<tauri_plugin_updater::Update>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Shell {
    fn new(dir: PathBuf, settings: Settings) -> Self {
        Shell {
            dir,
            settings: Mutex::new(settings),
            links: Mutex::default(),
            saves: files::Saves::default(),
            #[cfg(desktop)]
            tray: Mutex::new(None),
            #[cfg(desktop)]
            reported: Mutex::default(),
            #[cfg(desktop)]
            update: Mutex::new(None),
        }
    }

    fn settings(&self) -> Settings {
        lock(&self.settings).clone()
    }

    // Every change to the settings: made and written under one lock, so two writers can't undo
    // each other. A refused change saves nothing.
    fn change<T>(
        &self,
        change: impl FnOnce(&mut Settings) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut current = lock(&self.settings);
        let changed = change(&mut current)?;
        settings::save(&self.dir, &current).map_err(|e| plain(e, "Could not save settings"))?;
        Ok(changed)
    }
}

fn os() -> &'static str {
    if cfg!(target_os = "android") {
        "android"
    } else if cfg!(target_os = "ios") {
        "ios"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    }
}

// Runs before the page's own scripts, so the page can pick its window chrome (or none, on phones)
// before it renders.
fn init_script(version: &str) -> String {
    let info = serde_json::json!({ "os": os(), "version": version });
    format!("Object.defineProperty(window,'__RCHAT_DESKTOP__',{{value:Object.freeze({info})}});")
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN)
}

fn show_main(app: &AppHandle) {
    if let Some(w) = main_window(app) {
        #[cfg(desktop)]
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn open_outside(app: &AppHandle, url: &Url) {
    if links::is_external(url) {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
}

// Queues links for the page and wakes it up; the page takes them with `take_deep_links`, so a
// link that arrives before the page listens is not lost.
fn push_links(app: &AppHandle, urls: impl IntoIterator<Item = String>) {
    let found: Vec<String> = urls
        .into_iter()
        .filter_map(|u| links::deep_link(&u))
        .collect();
    if found.is_empty() {
        return;
    }
    let shell = app.state::<Shell>();
    let batch = lock(&shell.links).push(found);
    show_main(app);
    let _ = app.emit_to(MAIN, "deep-link", batch);
}

fn plain(e: impl std::fmt::Display, text: &str) -> String {
    eprintln!("{text}: {e}");
    text.to_string()
}

// The page gets the server's database address and extra settings blank, each with a flag that
// says whether one is set.
#[tauri::command]
fn desktop_settings(shell: State<'_, Shell>) -> serde_json::Value {
    settings::for_page(&shell.settings())
}

#[tauri::command]
fn set_desktop_settings(shell: State<'_, Shell>, settings: Settings) -> Result<(), String> {
    shell.change(|current| {
        *current = settings::from_page(current, settings);
        Ok(())
    })
}

// Commands that reach a mobile plugin run off the main thread there, as the plugins' own do.
// While notifications are muted, nothing is shown, whichever page path asked.
#[cfg_attr(desktop, tauri::command)]
#[cfg_attr(mobile, tauri::command(async))]
fn notify(
    app: AppHandle,
    shell: State<'_, Shell>,
    title: String,
    body: String,
) -> Result<(), String> {
    if shell.settings().mute_notifications {
        return Ok(());
    }
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| plain(e, "Could not show the notification"))
}

fn permission_name(state: PermissionState) -> &'static str {
    match state {
        PermissionState::Granted => "granted",
        PermissionState::Denied => "denied",
        PermissionState::Prompt | PermissionState::PromptWithRationale => "default",
    }
}

#[cfg_attr(desktop, tauri::command)]
#[cfg_attr(mobile, tauri::command(async))]
fn notify_permission(app: AppHandle) -> Result<&'static str, String> {
    app.notification()
        .permission_state()
        .map(permission_name)
        .map_err(|e| plain(e, "Could not check notifications"))
}

#[cfg_attr(desktop, tauri::command)]
#[cfg_attr(mobile, tauri::command(async))]
fn notify_request(app: AppHandle) -> Result<&'static str, String> {
    app.notification()
        .request_permission()
        .map(permission_name)
        .map_err(|e| plain(e, "Could not ask for notifications"))
}

// Phones show the count in the page title only; the systems keep their own app badges.
#[tauri::command]
fn set_badge(app: AppHandle, count: u32) {
    #[cfg(desktop)]
    desktop::show_badge(&app, count);
    #[cfg(mobile)]
    let _ = (app, count);
}

#[cfg_attr(desktop, tauri::command)]
#[cfg_attr(mobile, tauri::command(async))]
fn copy_text(app: AppHandle, text: String) -> Result<(), String> {
    app.clipboard()
        .write_text(text)
        .map_err(|e| plain(e, "Could not copy"))
}

#[tauri::command]
async fn save_begin(
    app: AppHandle,
    shell: State<'_, Shell>,
    name: String,
) -> Result<Option<u32>, String> {
    let name = files::file_name(&name);
    #[cfg(feature = "smoke")]
    let preset = smoke::save_path(&name);
    #[cfg(not(feature = "smoke"))]
    let preset = None;
    let picked = preset.or_else(|| app.dialog().file().set_file_name(name).blocking_save_file());
    let Some(picked) = picked else {
        return Ok(None);
    };
    let id = start_save(&app, &shell, picked).map_err(|e| plain(e, "Could not save the file"))?;
    Ok(Some(id))
}

// On computers the bytes go to a temp file that replaces the chosen one at the end.
#[cfg(desktop)]
fn start_save(_app: &AppHandle, shell: &Shell, picked: FilePath) -> Result<u32, String> {
    let path = picked.into_path().map_err(|e| e.to_string())?;
    shell.saves.start(path).map_err(|e| e.to_string())
}

// Phones hand out a document (an Android content URI or an iOS file URL) that only the system
// can open, so the bytes go straight into it.
#[cfg(mobile)]
fn start_save(app: &AppHandle, shell: &Shell, picked: FilePath) -> Result<u32, String> {
    use tauri_plugin_fs::{FsExt, OpenOptions};
    let mut opts = OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    let file = app.fs().open(picked, opts).map_err(|e| e.to_string())?;
    Ok(shell.saves.start_direct(file))
}

#[cfg(desktop)]
fn read_picked(
    _app: &AppHandle,
    picked: FilePath,
    max_bytes: u64,
) -> Result<Option<String>, String> {
    let path = picked.into_path().map_err(|e| e.to_string())?;
    Ok(files::read_text(&path, max_bytes))
}

#[cfg(mobile)]
fn read_picked(
    app: &AppHandle,
    picked: FilePath,
    max_bytes: u64,
) -> Result<Option<String>, String> {
    use tauri_plugin_fs::{FsExt, OpenOptions};
    let mut opts = OpenOptions::new();
    opts.read(true);
    let file = app.fs().open(picked, opts).map_err(|e| e.to_string())?;
    Ok(files::read_limited(file, max_bytes))
}

// Async so writing a large piece does not hold up the main thread.
#[tauri::command]
async fn save_chunk(shell: State<'_, Shell>, request: Request<'_>) -> Result<(), String> {
    let id = request
        .headers()
        .get("x-save")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u32>().ok())
        .ok_or("Unknown save")?;
    match request.body() {
        InvokeBody::Raw(bytes) => shell
            .saves
            .write(id, bytes)
            .map_err(|e| plain(e, "Could not save the file")),
        InvokeBody::Json(_) => Err("Expected raw bytes".into()),
    }
}

#[tauri::command]
async fn save_end(shell: State<'_, Shell>, id: u32, ok: bool) -> Result<(), String> {
    if ok {
        shell
            .saves
            .finish(id)
            .map_err(|e| plain(e, "Could not save the file"))
    } else {
        shell.saves.abort(id);
        Ok(())
    }
}

#[tauri::command]
async fn open_text(
    app: AppHandle,
    accept: String,
    max_bytes: u64,
) -> Result<Option<String>, String> {
    let exts = files::extensions(&accept);
    let ext_refs: Vec<&str> = exts.iter().map(String::as_str).collect();
    let dialog = app.dialog().file();
    let dialog = if ext_refs.is_empty() {
        dialog
    } else {
        dialog.add_filter("Text", &ext_refs)
    };
    let Some(picked) = dialog.blocking_pick_file() else {
        return Ok(None);
    };
    read_picked(&app, picked, max_bytes).map_err(|e| plain(e, "Could not open the file"))
}

#[cfg_attr(desktop, tauri::command)]
#[cfg_attr(mobile, tauri::command(async))]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    let url = Url::parse(&url).map_err(|_| "Not a link")?;
    if !links::is_external(&url) {
        return Err("Not a web link".into());
    }
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|e| plain(e, "Could not open the link"))
}

#[tauri::command]
fn take_deep_links(shell: State<'_, Shell>, batch: Option<u64>) -> Vec<String> {
    lock(&shell.links).take(batch)
}

// The system share sheet; true when shared, false when the user closed it. Phones only.
#[tauri::command]
async fn share_text(app: AppHandle, title: Option<String>, text: String) -> Result<bool, String> {
    #[cfg(mobile)]
    {
        use tauri_plugin_rchat_share::ShareExt;
        app.share()
            .text(title.as_deref(), &text)
            .map_err(|e| plain(e, "Could not share"))
    }
    #[cfg(desktop)]
    {
        let _ = (app, title, text);
        Err("Sharing is not available here".into())
    }
}

#[cfg(desktop)]
mod desktop {
    use super::*;
    use rchat_desktop_core::close::{self, Close, Quit};
    use rchat_desktop_core::launch::{self, Launch, Plan};
    use rchat_desktop_core::tray_menu::Snapshot;
    use serde::Serialize;
    use tauri_plugin_autostart::ManagerExt;
    use tauri_plugin_dialog::MessageDialogButtons;
    use tauri_plugin_updater::UpdaterExt;

    const UPDATER_PLACEHOLDER: &str = "RCHAT_UPDATER_PUBKEY_PLACEHOLDER";

    const QUIT_QUESTION: &str =
        "Quit and stop your server? People connected to it are disconnected.";

    fn has_tray(app: &AppHandle) -> bool {
        lock(&app.state::<Shell>().tray).is_some()
    }

    // What this start does. A start after "Install and restart" takes its one-time flags, which
    // are cleared here so the next start is an ordinary one.
    pub fn plan(app: &AppHandle, tray: bool) -> Plan {
        let shell = app.state::<Shell>();
        let loaded = shell.settings();
        let plan = launch::plan(Launch::from_args(std::env::args()), &loaded, tray);
        if loaded.resume_server || loaded.resume_window {
            let cleared = shell.change(|current| {
                current.resume_server = false;
                current.resume_window = false;
                Ok(())
            });
            if let Err(e) = cleared {
                eprintln!("{e}");
            }
        }
        plan
    }

    fn ask_to_quit(app: &AppHandle) {
        let quit = app.clone();
        app.dialog()
            .message(QUIT_QUESTION)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Quit".into(),
                "Cancel".into(),
            ))
            .show(move |yes| {
                if yes {
                    quit.exit(0);
                }
            });
    }

    // Quitting stops the server for everyone connected to it, so it asks first while one runs.
    pub fn request_quit(app: &AppHandle) {
        let settings = app.state::<Shell>().settings();
        match close::on_quit(&settings, server::running(app)) {
            Quit::Now => app.exit(0),
            Quit::Ask => ask_to_quit(app),
        }
    }

    // An exit nobody confirmed (the last window went away, or the system's own Quit) waits for
    // the answer while the server runs. `code` is set when the app itself decided to exit.
    pub fn on_exit_requested(app: &AppHandle, code: Option<i32>, api: &tauri::ExitRequestApi) {
        let settings = app.state::<Shell>().settings();
        if code.is_none() && close::on_quit(&settings, server::running(app)) == Quit::Ask {
            api.prevent_exit();
            ask_to_quit(app);
        }
    }

    // Puts up the tray; true when there is one.
    fn start_tray(app: &AppHandle) -> bool {
        let shell = app.state::<Shell>();
        let tray::Reported { unread, offline } = *lock(&shell.reported);
        let snapshot = Snapshot {
            webview: true,
            offline,
            muted: shell.settings().mute_notifications,
            server: server::tray_block(app),
        };
        match tray::start(app, snapshot, unread) {
            Ok(tray) => {
                *lock(&shell.tray) = Some(tray);
                true
            }
            Err(e) => {
                eprintln!("tray unavailable: {e}");
                false
            }
        }
    }

    // True when the tray is up. Linux has none without a StatusNotifierItem host; there the
    // tray comes up when a host appears later in the session.
    pub fn tray_now_or_later(app: &AppHandle) -> bool {
        if start_tray(app) {
            return true;
        }
        #[cfg(target_os = "linux")]
        tray::when_host_appears(app, start_tray);
        false
    }

    // Closing the main window hides it while the tray can bring it back, or quits.
    pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event
            && window.label() == MAIN
        {
            let app = window.app_handle();
            let settings = app.state::<Shell>().settings();
            match close::on_close(&settings, has_tray(app), server::running(app)) {
                Close::Hide => {
                    api.prevent_close();
                    let _ = window.hide();
                }
                Close::Quit(Quit::Ask) => {
                    api.prevent_close();
                    ask_to_quit(app);
                }
                Close::Quit(Quit::Now) => {}
            }
        }
    }

    pub fn show_badge(app: &AppHandle, count: u32) {
        lock(&app.state::<Shell>().reported).unread = count;
        if let Err(e) = tray::set_unread(app, count) {
            eprintln!("tray icon: {e}");
        }
        let Some(w) = main_window(app) else { return };
        #[cfg(windows)]
        {
            use rchat_desktop_core::badge;
            let dot = (count > 0).then(|| tauri::image::Image::new_owned(badge::dot(16), 16, 16));
            let _ = w.set_overlay_icon(dot);
        }
        #[cfg(not(windows))]
        let _ = w.set_badge_count((count > 0).then_some(i64::from(count)));
    }

    // The page reports whether its accounts appear offline, for the tray's Status.
    #[tauri::command]
    pub fn set_tray_state(app: AppHandle, offline: bool) {
        lock(&app.state::<Shell>().reported).offline = Some(offline);
        if let Err(e) = tray::update(&app, |s| s.offline = Some(offline)) {
            eprintln!("tray menu: {e}");
        }
    }

    #[derive(Serialize)]
    pub struct Found {
        pub version: String,
        pub notes: Option<String>,
    }

    #[tauri::command]
    pub fn autostart(app: AppHandle) -> bool {
        app.autolaunch().is_enabled().unwrap_or(false)
    }

    #[tauri::command]
    pub fn set_autostart(app: AppHandle, on: bool) -> Result<(), String> {
        let launch = app.autolaunch();
        let done = if on {
            launch.enable()
        } else {
            launch.disable()
        };
        done.map_err(|e| plain(e, "Could not change start on login"))
    }

    fn configured(app: &AppHandle) -> bool {
        app.config()
            .plugins
            .0
            .get("updater")
            .and_then(|u| u.get("pubkey"))
            .and_then(|k| k.as_str())
            .is_some_and(|k| !k.is_empty() && k != UPDATER_PLACEHOLDER)
    }

    pub async fn check(app: &AppHandle) -> Result<Option<Found>, String> {
        if !configured(app) {
            return Err("Updates are not set up for this build".into());
        }
        let channel = app.state::<Shell>().settings().channel;
        let endpoint =
            Url::parse(channel.endpoint()).map_err(|e| plain(e, "Bad update address"))?;
        let found = app
            .updater_builder()
            .endpoints(vec![endpoint])
            .and_then(|b| b.build())
            .map_err(|e| plain(e, "Could not check for updates"))?
            .check()
            .await
            .map_err(|e| plain(e, "Could not check for updates"))?;
        let info = found.as_ref().map(|u| Found {
            version: u.version.clone(),
            notes: u.body.clone(),
        });
        *lock(&app.state::<Shell>().update) = found;
        Ok(info)
    }

    #[tauri::command]
    pub async fn update_check(app: AppHandle) -> Result<Option<Found>, String> {
        check(&app).await
    }

    #[tauri::command]
    pub async fn update_install(app: AppHandle) -> Result<(), String> {
        install(&app).await
    }

    // Stops the server for the install and notes what the next start brings back: the server,
    // and the window when it is open now.
    fn before_install(app: &AppHandle) -> Result<bool, String> {
        let ran = server::running(app);
        let shown = main_window(app).is_some_and(|w| w.is_visible().unwrap_or(false));
        app.state::<Shell>().change(|current| {
            current.resume_server = ran;
            current.resume_window = shown;
            Ok(())
        })?;
        server::stop_now(app);
        Ok(ran)
    }

    // An install that failed leaves the app as it was.
    fn after_failed_install(app: &AppHandle, ran: bool) {
        let cleared = app.state::<Shell>().change(|current| {
            current.resume_server = false;
            current.resume_window = false;
            Ok(())
        });
        if let Err(e) = cleared {
            eprintln!("{e}");
        }
        if ran {
            server::start_later(app);
        }
    }

    pub async fn install(app: &AppHandle) -> Result<(), String> {
        let pending = lock(&app.state::<Shell>().update).take();
        let Some(update) = pending else {
            return Err("No update to install".into());
        };
        let failed = |e| plain(e, "Could not install the update");
        // The server keeps running through the download.
        let bytes = update.download(|_, _| {}, || {}).await.map_err(failed)?;
        let prepare = app.clone();
        let ran = tauri::async_runtime::spawn_blocking(move || before_install(&prepare))
            .await
            .map_err(|e| plain(e, "Could not install the update"))??;
        if let Err(e) = update.install(bytes) {
            after_failed_install(app, ran);
            return Err(failed(e));
        }
        app.restart()
    }

    // Opt-in check at startup; the page hears about a found update through the `update` event.
    pub fn check_later(app: &AppHandle) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Ok(Some(found)) = check(&app).await {
                let _ = app.emit_to(MAIN, "update", found.version);
            }
        });
    }
}

fn create_main(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == MAIN)
        .cloned()
        .ok_or_else(|| tauri::Error::WindowNotFound)?;
    let dev = if cfg!(dev) {
        app.config().build.dev_url.clone()
    } else {
        None
    };
    let nav_app = app.clone();
    let new_app = app.clone();
    let builder = WebviewWindowBuilder::from_config(app, &config)?
        .initialization_script(init_script(&app.package_info().version.to_string()));
    #[cfg(feature = "smoke")]
    let builder = match smoke::script() {
        Some(js) => builder.initialization_script(js),
        None => builder,
    };
    builder
        .on_navigation(move |url| {
            #[cfg(feature = "smoke")]
            if smoke::verdict(&nav_app, url) {
                return false;
            }
            let inside = links::is_app_url(url, dev.as_ref());
            if !inside {
                open_outside(&nav_app, url);
            }
            inside
        })
        .on_page_load(|webview, payload| {
            if let PageLoadEvent::Started = payload.event() {
                webview.state::<Shell>().saves.clear();
            }
        })
        .on_new_window(move |url, _| {
            open_outside(&new_app, &url);
            NewWindowResponse::Deny
        })
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    #[cfg(desktop)]
    if std::env::args().any(|a| a == tray_smoke::FLAG) {
        return tray_smoke::run(context);
    }
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = {
        use tauri_plugin_window_state::StateFlags;
        let flags = StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED;
        builder
            .plugin(tauri_plugin_single_instance::init(|app, _, _| {
                show_main(app)
            }))
            .plugin(
                tauri_plugin_window_state::Builder::new()
                    .with_state_flags(flags)
                    .build(),
            )
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                Some(vec!["--hidden"]),
            ))
    };
    #[cfg(mobile)]
    let builder = builder
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_rchat_share::init());
    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            desktop_settings,
            set_desktop_settings,
            notify,
            notify_permission,
            notify_request,
            set_badge,
            copy_text,
            save_begin,
            save_chunk,
            save_end,
            open_text,
            open_external,
            take_deep_links,
            share_text,
            #[cfg(desktop)]
            desktop::autostart,
            #[cfg(desktop)]
            desktop::set_autostart,
            #[cfg(desktop)]
            desktop::update_check,
            #[cfg(desktop)]
            desktop::update_install,
            #[cfg(desktop)]
            desktop::set_tray_state,
            #[cfg(all(desktop, feature = "server"))]
            server::server_status,
            #[cfg(all(desktop, feature = "server"))]
            server::server_save,
            #[cfg(all(desktop, feature = "server"))]
            server::server_start,
            #[cfg(all(desktop, feature = "server"))]
            server::server_stop,
            #[cfg(all(desktop, feature = "server"))]
            server::server_restart,
            #[cfg(all(desktop, feature = "server"))]
            server::server_logs,
            #[cfg(all(desktop, feature = "server"))]
            server::server_backup,
            #[cfg(all(desktop, feature = "server"))]
            server::server_restore,
            #[cfg(all(desktop, feature = "server"))]
            server::server_test_address,
            #[cfg(all(desktop, feature = "server"))]
            server::server_move,
            #[cfg(all(desktop, feature = "server"))]
            server::server_pick_folder,
            #[cfg(all(desktop, feature = "server"))]
            server::server_open_folder,
            #[cfg(all(desktop, feature = "server"))]
            server::server_remove,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let dir = app.path().app_config_dir()?;
            let loaded = settings::load(&dir);
            #[cfg(desktop)]
            let auto_update = loaded.auto_update;
            app.manage(Shell::new(dir, loaded));
            #[cfg(all(desktop, feature = "server"))]
            server::init(&handle)?;
            #[cfg(all(desktop, feature = "server", feature = "smoke"))]
            smoke::own_server(&handle);
            #[cfg(any(windows, target_os = "linux"))]
            if cfg!(dev) || std::env::var_os("APPIMAGE").is_some() {
                let _ = app.deep_link().register_all();
            }
            #[cfg(desktop)]
            let (show, with_server) = {
                let tray = desktop::tray_now_or_later(&handle);
                let plan = desktop::plan(&handle, tray);
                // A start without a window still gets a hidden one while there is a tray to
                // open it from.
                (plan.show || !(plan.webview || tray), plan.server)
            };
            #[cfg(mobile)]
            let show = true;
            let window = create_main(&handle)?;
            if show {
                window.show()?;
            }
            #[cfg(desktop)]
            if with_server {
                server::start_later(&handle);
            }
            let link_app = handle.clone();
            app.deep_link().on_open_url(move |event| {
                push_links(&link_app, event.urls().iter().map(Url::to_string));
            });
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                push_links(&handle, urls.iter().map(Url::to_string));
            }
            #[cfg(desktop)]
            if auto_update {
                desktop::check_later(&handle);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(desktop)]
            desktop::on_window_event(window, event);
            #[cfg(mobile)]
            let _ = (window, event);
        })
        .build(context)
        .expect("failed to build the app")
        .run(|app, event| {
            #[cfg(desktop)]
            match &event {
                tauri::RunEvent::ExitRequested { code, api, .. } => {
                    desktop::on_exit_requested(app, *code, api);
                }
                // The server ends with the app: open requests get their time to finish.
                tauri::RunEvent::Exit => server::stop_now(app),
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { .. } => show_main(app),
                _ => {}
            }
            let _ = (app, event);
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn init_script_names_the_os() {
        let script = init_script("1.2.3");
        assert!(script.starts_with("Object.defineProperty(window,'__RCHAT_DESKTOP__'"));
        assert!(script.contains(&format!("\"os\":\"{}\"", os())));
        assert!(script.contains("\"version\":\"1.2.3\""));
    }
}
