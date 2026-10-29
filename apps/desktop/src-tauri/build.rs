fn main() {
    let commands = &[
        "desktop_settings",
        "set_desktop_settings",
        "notify",
        "notify_permission",
        "notify_request",
        "set_badge",
        "copy_text",
        "save_begin",
        "save_chunk",
        "save_end",
        "open_text",
        "open_external",
        "take_deep_links",
        "share_text",
        "autostart",
        "set_autostart",
        "update_check",
        "update_install",
    ];
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(commands)),
    )
    .expect("failed to run the Tauri build script");
}
