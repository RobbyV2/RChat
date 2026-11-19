// The tray, rendered from the core menu model with Tauri's tray on every desktop OS. On Linux it
// is a StatusNotifierItem (tray-icon's ksni backend), so it needs no libayatana-appindicator.
use crate::{Shell, desktop, lock, show_main};
use rchat_desktop_core::badge;
use rchat_desktop_core::pixmap::{self, Icon, Os, Pixmap};
use rchat_desktop_core::tray_menu::{self, Action, Effect, Item, Redraw, Snapshot, TrayAction};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

const NAME: &str = "RChat";
const ID: &str = "main";
// Menu item ids, apart from other menus' (every menu event reaches every menu listener).
const PREFIX: &str = "tray-";
const APP_ICON: &[u8] = include_bytes!("../icons/128x128@2x.png");
// StatusNotifierItem hosts own this name on the session bus.
#[cfg(target_os = "linux")]
const HOST: &str = "org.kde.StatusNotifierWatcher";

// The rendered menu item for each model item, in the same order.
enum Handle {
    Separator,
    Text(MenuItem<Wry>),
    Check(CheckMenuItem<Wry>),
    Choice(Submenu<Wry>, Vec<CheckMenuItem<Wry>>),
}

pub struct Tray {
    icon: TrayIcon,
    handles: Vec<Handle>,
    shown: Vec<Item>,
    snapshot: Snapshot,
    // Without and with the unread dot, each with its template flag.
    icons: [(Image<'static>, bool); 2],
}

impl Tray {
    fn snapshot(&self) -> Snapshot {
        self.snapshot
    }
}

// What the page last reported. It is kept apart from the tray, which can come up after the page.
#[derive(Clone, Copy, Default)]
pub struct Reported {
    pub unread: u32,
    pub offline: Option<bool>,
}

fn icons() -> tauri::Result<[(Image<'static>, bool); 2]> {
    let source = Image::from_bytes(APP_ICON)?;
    let app_icon = Pixmap {
        width: source.width(),
        height: source.height(),
        rgba: source.rgba().to_vec(),
    };
    Ok(pixmap::tray_icons(Os::current(), &app_icon).map(|icon| {
        let Icon {
            pixmap:
                Pixmap {
                    width,
                    height,
                    rgba,
                },
            template,
        } = icon;
        (Image::new_owned(rgba, width, height), template)
    }))
}

fn item_id(action: Action) -> String {
    format!("{PREFIX}{}", action.id())
}

fn append(app: &AppHandle, menu: &Menu<Wry>, at: usize, item: &Item) -> tauri::Result<Handle> {
    match item {
        Item::Separator => {
            menu.append(&PredefinedMenuItem::separator(app)?)?;
            Ok(Handle::Separator)
        }
        Item::Note(text) => {
            let note = MenuItem::with_id(app, format!("{PREFIX}{at}"), text, false, None::<&str>)?;
            menu.append(&note)?;
            Ok(Handle::Text(note))
        }
        Item::Button {
            action,
            label,
            enabled,
        } => {
            let button = MenuItem::with_id(app, item_id(*action), label, *enabled, None::<&str>)?;
            menu.append(&button)?;
            Ok(Handle::Text(button))
        }
        Item::Check {
            action,
            label,
            checked,
        } => {
            let check =
                CheckMenuItem::with_id(app, item_id(*action), label, true, *checked, None::<&str>)?;
            menu.append(&check)?;
            Ok(Handle::Check(check))
        }
        Item::Choice {
            label,
            enabled,
            options,
        } => {
            let sub = Submenu::with_id(app, format!("{PREFIX}{at}"), label, *enabled)?;
            let picks = options
                .iter()
                .map(|o| {
                    let pick = CheckMenuItem::with_id(
                        app,
                        item_id(o.action),
                        o.label,
                        *enabled,
                        o.selected,
                        None::<&str>,
                    )?;
                    sub.append(&pick)?;
                    Ok(pick)
                })
                .collect::<tauri::Result<Vec<_>>>()?;
            menu.append(&sub)?;
            Ok(Handle::Choice(sub, picks))
        }
    }
}

fn build_menu(app: &AppHandle, items: &[Item]) -> tauri::Result<(Menu<Wry>, Vec<Handle>)> {
    let menu = Menu::new(app)?;
    let handles = items
        .iter()
        .enumerate()
        .map(|(at, item)| append(app, &menu, at, item))
        .collect::<tauri::Result<_>>()?;
    Ok((menu, handles))
}

fn refresh(handle: &Handle, item: &Item) -> tauri::Result<()> {
    match (handle, item) {
        (Handle::Text(note), Item::Note(text)) => note.set_text(text),
        (Handle::Text(button), Item::Button { enabled, .. }) => button.set_enabled(*enabled),
        (Handle::Check(check), Item::Check { checked, .. }) => check.set_checked(*checked),
        (
            Handle::Choice(sub, picks),
            Item::Choice {
                enabled, options, ..
            },
        ) => {
            sub.set_enabled(*enabled)?;
            picks.iter().zip(options).try_for_each(|(pick, o)| {
                pick.set_enabled(*enabled)?;
                pick.set_checked(o.selected)
            })
        }
        _ => Ok(()),
    }
}

pub fn start(app: &AppHandle, snapshot: Snapshot, unread: u32) -> tauri::Result<Tray> {
    let shown = tray_menu::menu(&snapshot);
    let (menu, handles) = build_menu(app, &shown)?;
    let icons = icons()?;
    let (image, template) = &icons[usize::from(unread > 0)];
    let builder = TrayIconBuilder::with_id(ID);
    // The item's name in the panel's settings; macOS would show a title next to the icon.
    #[cfg(target_os = "linux")]
    let builder = builder.title(NAME);
    let icon = builder
        .icon(image.clone())
        .icon_as_template(*template)
        .tooltip(badge::tooltip(NAME, unread))
        .menu(&menu)
        // A click opens the menu in the macOS menu bar, and the window on Windows and Linux.
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(|app, event| {
            let id = event.id().as_ref().strip_prefix(PREFIX);
            if let Some(action) = id.and_then(Action::from_id) {
                pick(app, action);
            }
        })
        .on_tray_icon_event(|tray, event| click(tray.app_handle(), event))
        .build(app)?;
    Ok(Tray {
        icon,
        handles,
        shown,
        snapshot,
        icons,
    })
}

// Applies a change to the tray's state and brings the menu up to date: in place when the same
// items stay, otherwise as a new menu. `force` rewrites every item, for after a click (a check
// item flips itself).
fn render(app: &AppHandle, force: bool, change: impl FnOnce(&mut Snapshot)) -> tauri::Result<()> {
    let shell = app.state::<Shell>();
    let mut guard = lock(&shell.tray);
    let Some(tray) = guard.as_mut() else {
        return Ok(());
    };
    change(&mut tray.snapshot);
    let next = tray_menu::menu(&tray.snapshot);
    let done = match tray_menu::redraw(&tray.shown, &next) {
        Redraw::Nothing if !force => Ok(()),
        Redraw::Nothing | Redraw::Items => tray
            .handles
            .iter()
            .zip(&next)
            .try_for_each(|(handle, item)| refresh(handle, item)),
        Redraw::Menu => build_menu(app, &next).and_then(|(menu, handles)| {
            tray.icon.set_menu(Some(menu))?;
            tray.handles = handles;
            Ok(())
        }),
    };
    tray.shown = next;
    done
}

pub fn update(app: &AppHandle, change: impl FnOnce(&mut Snapshot)) -> tauri::Result<()> {
    render(app, false, change)
}

// Runs `start` on the main thread each time a tray host comes up on the session bus, until it
// returns true. A panel that starts after the app gets the tray this way.
#[cfg(target_os = "linux")]
pub fn when_host_appears(
    app: &AppHandle,
    start: impl Fn(&AppHandle) -> bool + Send + Sync + 'static,
) {
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(e) = watch_host(&app, std::sync::Arc::new(start)) {
            eprintln!("tray host: {e}");
        }
    });
}

#[cfg(target_os = "linux")]
fn watch_host(
    app: &AppHandle,
    start: std::sync::Arc<dyn Fn(&AppHandle) -> bool + Send + Sync>,
) -> zbus::Result<()> {
    use zbus::blocking::Connection;
    use zbus::blocking::fdo::DBusProxy;
    let bus = Connection::session()?;
    let names = DBusProxy::new(&bus)?;
    let changes = names.receive_name_owner_changed_with_args(&[(0, HOST)])?;
    // A host that came up before the watch began sends no change.
    let before = names.name_has_owner(HOST.try_into()?)?;
    let ups = changes.map(|change| change.args().map(|args| args.new_owner().is_some()));
    for up in std::iter::once(Ok(before)).chain(ups) {
        if !up? {
            continue;
        }
        let (tx, rx) = std::sync::mpsc::channel();
        let (handle, start) = (app.clone(), start.clone());
        let asked = app.run_on_main_thread(move || {
            let _ = tx.send(start(&handle));
        });
        // The app is closing when the main thread can't be reached.
        if asked.is_err() || rx.recv().unwrap_or(true) {
            break;
        }
    }
    Ok(())
}

pub fn set_unread(app: &AppHandle, count: u32) -> tauri::Result<()> {
    let shell = app.state::<Shell>();
    let guard = lock(&shell.tray);
    let Some(tray) = guard.as_ref() else {
        return Ok(());
    };
    tray.icon.set_tooltip(Some(badge::tooltip(NAME, count)))?;
    let (image, template) = &tray.icons[usize::from(count > 0)];
    tray.icon
        .set_icon_with_as_template(Some(image.clone()), *template)
}

// Whether the menu bar draws the icon as a template (for `--tray-smoke`). Tauri has no getter, so
// this asks AppKit.
#[cfg(target_os = "macos")]
pub fn template(app: &AppHandle) -> tauri::Result<Option<bool>> {
    let shell = app.state::<Shell>();
    let guard = lock(&shell.tray);
    let Some(tray) = guard.as_ref() else {
        return Ok(None);
    };
    tray.icon.with_inner_tray_icon(|inner| {
        let main = objc2::MainThreadMarker::new()?;
        let image = inner.ns_status_item()?.button(main)?.image()?;
        Some(image.isTemplate())
    })
}

// The check items as the menu shows them now (for `--tray-smoke`).
pub fn checks(app: &AppHandle) -> tauri::Result<Vec<(Action, bool)>> {
    let shell = app.state::<Shell>();
    let guard = lock(&shell.tray);
    let Some(tray) = guard.as_ref() else {
        return Ok(Vec::new());
    };
    let mut found = Vec::new();
    for (handle, item) in tray.handles.iter().zip(&tray.shown) {
        match (handle, item) {
            (Handle::Check(check), Item::Check { action, .. }) => {
                found.push((*action, check.is_checked()?));
            }
            (Handle::Choice(_, picks), Item::Choice { options, .. }) => {
                for (pick, o) in picks.iter().zip(options) {
                    found.push((o.action, pick.is_checked()?));
                }
            }
            _ => {}
        }
    }
    Ok(found)
}

fn click(app: &AppHandle, event: TrayIconEvent) {
    if cfg!(target_os = "macos") {
        return;
    }
    match event {
        TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        }
        | TrayIconEvent::DoubleClick {
            button: MouseButton::Left,
            ..
        } => show_main(app),
        _ => {}
    }
}

fn pick(app: &AppHandle, action: Action) {
    let snapshot = lock(&app.state::<Shell>().tray)
        .as_ref()
        .map(Tray::snapshot);
    let Some(snapshot) = snapshot else { return };
    let effect = tray_menu::effect(action, &snapshot);
    if let Err(e) = render(app, true, |_| {}) {
        eprintln!("tray menu: {e}");
    }
    match effect {
        Some(Effect::Open) => show_main(app),
        Some(Effect::Page(action)) => {
            match action {
                TrayAction::Settings { .. } => show_main(app),
                TrayAction::Status { .. } => {}
            }
            let _ = app.emit_to(crate::MAIN, "tray-action", action);
        }
        Some(Effect::Mute(on)) => mute(app, on),
        Some(
            effect @ (Effect::StartServer
            | Effect::StopServer
            | Effect::RestartServer
            | Effect::CopyAddress),
        ) => crate::server::pick(app, effect),
        Some(Effect::CheckUpdates) => check_updates(app),
        Some(Effect::Quit) => desktop::request_quit(app),
        None => {}
    }
}

// The menu shows the change before the file is written, which can take a moment on a slow disk.
fn mute(app: &AppHandle, on: bool) {
    if let Err(e) = update(app, |s| s.muted = on) {
        eprintln!("tray menu: {e}");
    }
    let saved = app.state::<Shell>().change(|current| {
        current.mute_notifications = on;
        Ok(())
    });
    if let Err(e) = saved {
        eprintln!("{e}");
    }
    let _ = app.emit_to(crate::MAIN, "shell-settings", ());
}

// Works with no window open: the answers come in native dialogs.
fn check_updates(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let text = match desktop::check(&app).await {
            Ok(Some(found)) => return offer(&app, &found.version),
            Ok(None) => "You have the latest version.".to_string(),
            Err(e) => format!("{e}."),
        };
        app.dialog().message(text).show(|_| {});
    });
}

fn offer(app: &AppHandle, version: &str) {
    let install = app.clone();
    app.dialog()
        .message(format!(
            "Version {version} is available. Install and restart?"
        ))
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Install and restart".into(),
            "Later".into(),
        ))
        .show(move |yes| {
            if yes {
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = desktop::install(&install).await {
                        install.dialog().message(format!("{e}.")).show(|_| {});
                    }
                });
            }
        });
}
