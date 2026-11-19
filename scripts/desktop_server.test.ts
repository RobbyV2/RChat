import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')

describe("the desktop app's own server", () => {
  test('its tests run on every desktop OS before the build', () => {
    const job = read('.github/workflows/desktop.yml')
    const step = job.split('- name: Core tests\n')[1].split(/\n {6}(?:- |# )/)[0]
    expect(step).toContain('run: cargo test -p rchat-desktop-core')
    expect(step).not.toContain('if:')
    expect(job.indexOf('- name: Core tests\n')).toBeLessThan(job.indexOf('- name: Build\n'))
    for (const runner of ['ubuntu-22.04', 'windows-latest', 'macos-latest']) {
      expect(job).toContain(`runner: ${runner}`)
    }
  })

  const commands = [
    'server_status',
    'server_save',
    'server_start',
    'server_stop',
    'server_restart',
    'server_logs',
    'server_backup',
    'server_restore',
    'server_test_address',
    'server_move',
    'server_pick_folder',
    'server_open_folder',
    'server_remove',
  ]

  test('its commands are allowed in the desktop window only', () => {
    const build = read('apps/desktop/src-tauri/build.rs')
    const shell = read('apps/desktop/src-tauri/src/lib.rs')
    const glue = read('apps/desktop/src-tauri/src/server.rs')
    const desktop = JSON.parse(read('apps/desktop/src-tauri/capabilities/desktop.json'))
    const mobile = JSON.parse(read('apps/desktop/src-tauri/capabilities/mobile.json'))
    for (const command of commands) {
      const permission = `allow-${command.replaceAll('_', '-')}`
      expect(build).toContain(`"${command}",`)
      expect(shell).toContain(
        `#[cfg(all(desktop, feature = "server"))]\n            server::${command},`
      )
      expect(glue).toMatch(new RegExp(`#\\[tauri::command\\]\\npub (async )?fn ${command}\\(`))
      expect(desktop.permissions).toContain(permission)
      expect(mobile.permissions).not.toContain(permission)
    }
    const declared = [...glue.matchAll(/#\[tauri::command\]\npub (?:async )?fn (\w+)\(/g)]
    expect(declared.map(m => m[1]).sort()).toEqual([...commands].sort())
    expect(mobile.permissions.filter((p: string) => p.includes('server'))).toEqual([])
  })

  test('the page never reads the stored database address or extra settings', () => {
    const shell = read('apps/desktop/src-tauri/src/lib.rs')
    expect(shell).toContain('settings::for_page(&shell.settings())')
    expect(shell).not.toMatch(/fn desktop_settings\([^)]*\) -> Settings/)
    const glue = read('apps/desktop/src-tauri/src/server.rs')
    const returned = [
      ...glue.matchAll(/#\[tauri::command\]\npub (?:async )?fn \w+\([^)]*\) -> ([^{]+) \{/g),
    ]
    expect(returned.length).toBe(commands.length)
    for (const [, type] of returned) expect(type).not.toMatch(/Settings/)
  })

  test('the smoke run starts it and the page checks it', () => {
    const ci = read('.github/workflows/ci.yml')
    const job = ci.split('  desktop-smoke:\n')[1].split(/\n {2}\w[\w-]*:\n/)[0]
    expect(job).toContain("RCHAT_SMOKE_SERVER: '3471'")
    expect(job).toContain("SERVER_PORT: '3470'")
    expect(read('apps/desktop/scripts/smoke.sh')).toContain(
      'printf "var SMOKE_SERVER = %d;\\n" "${RCHAT_SMOKE_SERVER:-0}"'
    )
    const page = read('apps/desktop/scripts/smoke.js')
    expect(page).toContain('`http://127.0.0.1:${SMOKE_SERVER}`')
    expect(page).toContain('await ownServer()')
    expect(read('apps/desktop/src-tauri/src/smoke.rs')).toContain('"RCHAT_SMOKE_SERVER"')
  })

  test('phones build without it', () => {
    const core = read('apps/desktop/core/Cargo.toml')
    const computers = core.split(
      `[target.'cfg(not(any(target_os = "android", target_os = "ios")))'.dependencies]\n`
    )[1]
    expect(computers).toContain('rust-next = { path = "../../server", optional = true }')
    expect(core.split('[target.')[0]).not.toContain('rust-next = ')
    expect(read('apps/desktop/core/src/lib.rs')).toContain(
      '#[cfg(all(feature = "server", not(any(target_os = "android", target_os = "ios"))))]\npub mod server;'
    )
    const shell = read('apps/desktop/src-tauri/Cargo.toml')
    expect(shell).toContain('rchat-desktop-core = { path = "../core", default-features = false }')
    expect(shell).toContain('default = ["server"]')
    expect(shell).toContain('server = ["rchat-desktop-core/server"]')
    expect(read('apps/desktop/src-tauri/src/lib.rs')).toContain(
      '#[cfg(all(desktop, feature = "server"))]\nmod server;'
    )
  })
})
