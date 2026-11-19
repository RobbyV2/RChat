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
  })
})
