// A hidden start for CI, `rchat --tray-smoke`: builds the tray from the model, changes it once (the
// unread dot, two check items), prints `TRAY SMOKE PASS ...` and exits 0, or prints what failed
// and exits 1. With RCHAT_TRAY_SMOKE_HOLD=<seconds> it stays up that long, so a tray host can
// click it; clicks and menu picks are printed too. On Linux, RCHAT_TRAY_SMOKE_WAIT=<seconds> gives
// a tray host that long to come up when there is none at the start.
use crate::{Shell, lock, tray};
use rchat_desktop_core::pixmap::Os;
use rchat_desktop_core::settings::Settings;
use rchat_desktop_core::tray_menu::{Action, Snapshot};
use std::time::Duration;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
use tauri::{AppHandle, Context, Manager, RunEvent};

pub const FLAG: &str = "--tray-smoke";

fn start(app: &AppHandle) -> Result<(), String> {
    let snapshot = Snapshot {
        webview: true,
        offline: None,
        muted: false,
        server: None,
    };
    let built = tray::start(app, snapshot, 0).map_err(|e| format!("no tray: {e}"))?;
    *lock(&app.state::<Shell>().tray) = Some(built);
    Ok(())
}

fn check(app: &AppHandle) -> Result<String, String> {
    tray::set_unread(app, 3).map_err(|e| format!("unread dot: {e}"))?;
    #[cfg(target_os = "macos")]
    if tray::template(app).map_err(|e| format!("template icon: {e}"))? != Some(true) {
        return Err("the icon with the unread dot is not a template".into());
    }
    tray::update(app, |s| {
        s.muted = true;
        s.offline = Some(true);
    })
    .map_err(|e| format!("menu update: {e}"))?;
    let checks = tray::checks(app).map_err(|e| format!("check items: {e}"))?;
    let want = [
        (Action::Online, false),
        (Action::Offline, true),
        (Action::Mute, true),
    ];
    if checks != want {
        return Err(format!("check items: {checks:?}"));
    }
    #[cfg(target_os = "linux")]
    if std::fs::read_to_string("/proc/self/maps").is_ok_and(|maps| maps.contains("appindicator")) {
        return Err("libappindicator was loaded".into());
    }
    Ok(format!(
        "{:?}: tray built, unread dot, Mute and Appear offline checked",
        Os::current()
    ))
}

fn seconds(name: &str) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}

// Prints the verdict and ends the run: after `hold` seconds on a pass, at once on a failure.
fn finish(app: &AppHandle, verdict: Result<String, String>, hold: u64) {
    match verdict {
        Ok(line) => {
            println!("TRAY SMOKE PASS {line}");
            let app = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(hold));
                app.exit(0);
            });
        }
        Err(e) => {
            println!("TRAY SMOKE FAIL {e}");
            app.exit(1);
        }
    }
}

// The run goes on when a tray host comes up, and fails when none does in `wait` seconds.
#[cfg(target_os = "linux")]
fn wait_for_host(app: &AppHandle, wait: u64, hold: u64) {
    tray::when_host_appears(app, move |app| {
        finish(app, start(app).and_then(|()| check(app)), hold);
        true
    });
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(wait));
        if lock(&app.state::<Shell>().tray).is_none() {
            println!("TRAY SMOKE FAIL no tray host came up");
            app.exit(1);
        }
    });
}

pub fn run(context: Context) {
    let dir = std::env::temp_dir().join(format!("rchat-tray-smoke-{}", std::process::id()));
    let hold = seconds("RCHAT_TRAY_SMOKE_HOLD");
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .on_menu_event(|_, event| println!("TRAY SMOKE MENU {}", event.id().as_ref()))
        .on_tray_icon_event(|_, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                println!("TRAY SMOKE CLICK left");
            }
        })
        .setup({
            let dir = dir.clone();
            move |app| {
                app.manage(Shell::new(dir, Settings::default()));
                let handle = app.handle().clone();
                let started = start(&handle);
                #[cfg(target_os = "linux")]
                if let (Err(e), wait @ 1..) = (&started, seconds("RCHAT_TRAY_SMOKE_WAIT")) {
                    println!("TRAY SMOKE WAIT {e}");
                    wait_for_host(&handle, wait, hold);
                    return Ok(());
                }
                finish(&handle, started.and_then(|()| check(&handle)), hold);
                Ok(())
            }
        })
        .build(context)
        .expect("failed to build the app");
    app.run(move |_, event| {
        if let RunEvent::Exit = event {
            let _ = std::fs::remove_dir_all(&dir);
        }
    });
}
