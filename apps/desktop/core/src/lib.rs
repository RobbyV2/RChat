// Desktop shell logic with no Tauri types, so it builds and tests on any host.

pub mod badge;
pub mod close;
pub mod launch;
pub mod pixmap;
#[cfg(all(feature = "server", not(any(target_os = "android", target_os = "ios"))))]
pub mod server;
pub mod settings;
pub mod tray_menu;
