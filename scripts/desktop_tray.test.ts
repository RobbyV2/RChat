import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (path: string) => readFileSync(join(import.meta.dir, '..', path), 'utf8')

describe('desktop tray', () => {
  // The Linux tray is a StatusNotifierItem (tray-icon's ksni backend), so nothing installs or
  // depends on libayatana-appindicator.
  test('no build or package asks for libayatana-appindicator', () => {
    for (const file of [
      '.github/workflows/checks.yml',
      '.github/workflows/ci.yml',
      '.github/workflows/desktop.yml',
      'apps/desktop/src-tauri/tauri.conf.json',
      'apps/desktop/src-tauri/tauri.linux.conf.json',
      'packaging/aur/rchat-bin/PKGBUILD',
      'packaging/aur/rchat-weekly-bin/PKGBUILD',
      'jfiles/src/desktop.just',
      'README.md',
    ])
      expect(read(file)).not.toContain('appindicator')
    expect(read('apps/desktop/src-tauri/Cargo.toml')).toContain(
      `[target.'cfg(target_os = "linux")'.dependencies]\ntray-icon = { version = "0.25", default-features = false, features = ["ksni"] }`
    )
  })

  // The ksni feature reaches Tauri's tray only while both ask for the same tray-icon: a second
  // copy would leave Tauri's on libappindicator.
  test('Tauri and the shell share one tray-icon', () => {
    const lock = read('Cargo.lock')
    expect(lock.split('\nname = "tray-icon"\n').length - 1).toBe(1)
    expect(lock).toMatch(/\nname = "tray-icon"\nversion = "0\.25\.\d+"\n/)
  })

  // The Tauri CLI reads the shell's manifest. With Tauri's `tray-icon` feature listed there, it
  // needs an appindicator package to bundle on Linux and makes the .deb depend on it.
  test('the Tauri CLI does not see the tray feature', () => {
    const shell = read('apps/desktop/src-tauri/Cargo.toml')
    expect(shell).toContain('\ntauri = { workspace = true }\n')
    expect(shell).not.toMatch(/features = \[[^\]]*"tray-icon"/)
    expect(read('Cargo.toml')).toContain(
      '[workspace.dependencies]\ntauri = { version = "2.12", features = ["tray-icon", "image-png"] }\n'
    )
  })

  // macOS draws an icon that is set without the template flag in plain black.
  test('every icon change carries the template flag', () => {
    const tray = read('apps/desktop/src-tauri/src/tray.rs')
    expect(tray).toContain('.icon_as_template(*template)')
    expect(tray).toContain('.set_icon_with_as_template(Some(image.clone()), *template)')
    expect(tray).not.toMatch(/\.set_icon\(/)
  })
})
