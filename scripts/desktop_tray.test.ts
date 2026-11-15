import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')

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

  describe('smoke run', () => {
    const job = read('.github/workflows/desktop.yml')
    const step = (name: string) => job.split(`- name: ${name}\n`)[1].split(/\n {6}(?:- |# )/)[0]

    test('runs on every OS after the build, before the bundles are collected', () => {
      const at = (name: string) => job.indexOf(`- name: ${name}\n`)
      expect(at('Build')).toBeGreaterThan(0)
      for (const name of ['Tray smoke', 'Tray smoke (Linux)']) {
        expect(at(name)).toBeGreaterThan(at('Build'))
        expect(at(name)).toBeLessThan(at('Collect'))
      }
      const others = step('Tray smoke')
      expect(others).toContain("if: matrix.os != 'linux'")
      expect(others).toContain('"$app" --tray-smoke | tee "$RUNNER_TEMP/tray-smoke.log"')
      expect(others).toContain("grep -q '^TRAY SMOKE PASS'")
      expect(others).toContain('RChat.app/Contents/MacOS/rchat')
      expect(others).toContain('target/release/rchat.exe')
      const linux = step('Tray smoke (Linux)')
      expect(linux).toContain("if: matrix.os == 'linux'")
      expect(linux).toContain('sudo apt-get install -y xvfb dbus python3-dbus python3-gi rpm')
      expect(linux).toContain('apps/desktop/scripts/tray-smoke.sh target/release/rchat')
      expect(linux).toContain(
        'if dpkg-deb -f target/release/bundle/deb/*.deb Depends | grep -i indicator; then exit 1; fi'
      )
      expect(linux).toContain('BUNDLES: ${{ inputs.linux-bundles }}')
      expect(linux).toContain(
        [
          'if [[ "$BUNDLES" == *rpm* ]]; then',
          '  rpm -qp --requires target/release/bundle/rpm/*.rpm > "$RUNNER_TEMP/rpm-requires.txt"',
          '  [ -s "$RUNNER_TEMP/rpm-requires.txt" ]',
          '  if grep -i indicator "$RUNNER_TEMP/rpm-requires.txt"; then exit 1; fi',
          'fi',
        ].join('\n          ')
      )
    })

    test('runs in test builds and in releases', () => {
      for (const caller of ['ci.yml', 'release.yml'])
        expect(read(`.github/workflows/${caller}`)).toContain(
          'uses: ./.github/workflows/desktop.yml'
        )
    })

    test('the app, the scripts and the menu agree', () => {
      const smoke = read('apps/desktop/src-tauri/src/tray_smoke.rs')
      expect(smoke).toContain('pub const FLAG: &str = "--tray-smoke";')
      for (const line of [
        'TRAY SMOKE PASS',
        'TRAY SMOKE FAIL',
        'TRAY SMOKE CLICK left',
        'TRAY SMOKE MENU',
      ])
        expect(smoke).toContain(line)
      expect(smoke).toContain('seconds("RCHAT_TRAY_SMOKE_HOLD")')
      const script = read('apps/desktop/scripts/tray-smoke.sh')
      expect(script).toContain('export RCHAT_TRAY_SMOKE_HOLD=30')
      expect(script).toContain('"$APP" --tray-smoke > "$WORK/app.log"')
      expect(script).toContain('xvfb-run -a dbus-run-session -- "$inner"')
      const model = read('apps/desktop/core/src/tray_menu.rs')
      for (const label of ['Open RChat', 'Mute notifications', 'Appear offline', 'Quit RChat'])
        expect(model).toContain(`"${label}"`)
      expect(model).toContain('Action::Mute => "mute"')
      expect(model).toContain('Action::Quit => "quit"')
      expect(read('apps/desktop/src-tauri/src/tray.rs')).toContain('const PREFIX: &str = "tray-";')
      expect(script).toContain("'^TRAY SMOKE MENU tray-mute$'")
      expect(script).toContain("'^TRAY SMOKE MENU tray-quit$'")
      expect(script).toContain("'^tooltip .*| RChat (3)$'")
      expect(read('apps/desktop/core/src/badge.rs')).toContain('format!("{name} ({count})")')
      expect(smoke).toContain('tray::set_unread(app, 3)')
      const watcher = read('apps/desktop/scripts/sni_watcher.py')
      expect(watcher).toContain('MUTE = "Mute notifications"')
      expect(watcher).toContain('QUIT = "Quit RChat"')
    })

    // The app draws a menu change a moment after the click, so the watcher reads the menu until
    // the change shows.
    test('the watcher polls for menu changes', () => {
      const watcher = read('apps/desktop/scripts/sni_watcher.py')
      expect(watcher).toContain('POLL_MS = 250')
      expect(watcher).toContain('POLLS = 40')
      expect(watcher).toContain(
        'GLib.timeout_add(POLL_MS, self.when_mute_is, 0, name, path, unmuted)'
      )
      expect(watcher).not.toMatch(/timeout_add\(\d/)
    })

    test('a tray host that comes up after the app gets the tray', () => {
      const smoke = read('apps/desktop/src-tauri/src/tray_smoke.rs')
      expect(smoke).toContain('seconds("RCHAT_TRAY_SMOKE_WAIT")')
      expect(smoke).toContain('println!("TRAY SMOKE WAIT {e}")')
      expect(smoke).toContain('tray::when_host_appears(app, move |app| {')
      expect(read('apps/desktop/src-tauri/src/lib.rs')).toContain(
        'tray::when_host_appears(app, start_tray);'
      )
      const script = read('apps/desktop/scripts/tray-smoke.sh')
      expect(script).toContain(
        'RCHAT_TRAY_SMOKE_WAIT=30 "$APP" --tray-smoke > "$WORK/late-app.log"'
      )
      expect(script.indexOf('RCHAT_TRAY_SMOKE_WAIT=30')).toBeLessThan(
        script.indexOf('watch "$WORK/late-watcher.log"')
      )
      for (const line of [
        "'^TRAY SMOKE WAIT'",
        '"$late" = 0',
        '\'^registered \' "$work/late-watcher.log"',
      ])
        expect(script).toContain(line)
    })

    test('macOS checks the template flag after the unread dot', () => {
      const smoke = read('apps/desktop/src-tauri/src/tray_smoke.rs')
      const dot = smoke.indexOf('tray::set_unread(app, 3)')
      const flag = smoke.indexOf('tray::template(app)')
      expect(dot).toBeGreaterThan(0)
      expect(flag).toBeGreaterThan(dot)
      expect(smoke.slice(dot, flag)).toContain('#[cfg(target_os = "macos")]')
    })

    test('the scripts parse', () => {
      const bash = spawnSync('bash', ['-n', join(root, 'apps/desktop/scripts/tray-smoke.sh')])
      expect(bash.status).toBe(0)
      const python = spawnSync('python3', [
        '-I',
        '-c',
        'import ast, sys; ast.parse(open(sys.argv[1]).read())',
        join(root, 'apps/desktop/scripts/sni_watcher.py'),
      ])
      expect(python.status).toBe(0)
    })
  })
})
