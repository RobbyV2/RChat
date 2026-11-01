import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (path: string) => readFileSync(join(import.meta.dir, '..', path), 'utf8')
const count = (text: string, part: string) => text.split(part).length - 1

const bindgen = /name = "wasm-bindgen"\nversion = "([^"]+)"/.exec(read('Cargo.lock'))?.[1]
const builds = [
  'Dockerfile',
  '.github/workflows/checks.yml',
  '.github/workflows/desktop.yml',
  '.github/workflows/mobile.yml',
]

describe('wasm builds', () => {
  test('every build that installs wasm-pack installs the wasm-bindgen Cargo.lock pins', () => {
    expect(bindgen).toBeDefined()
    for (const file of builds) {
      const text = read(file)
      const packs = count(text, 'cargo install wasm-pack ')
      expect(packs > 0).toBe(true)
      expect(count(text, `cargo install wasm-bindgen-cli --version ${bindgen} --locked`)).toBe(
        packs
      )
      if (file.endsWith('.yml'))
        expect(count(text, `key: wasm-bindgen-\${{ runner.os }}-${bindgen}`)).toBe(packs)
    }
  })

  // package.json's build:wasm is what Tauri's beforeBuildCommand runs for the desktop and mobile apps.
  test('wasm-pack never downloads tools in the image, checks or app builds', () => {
    for (const file of ['Dockerfile', '.github/workflows/checks.yml', 'package.json']) {
      const lines = read(file)
        .split('\n')
        .filter(l => l.includes('wasm-pack build'))
      expect(lines.length > 0).toBe(true)
      for (const line of lines) expect(line).toContain('--mode no-install')
    }
  })

  test('no build runs wasm-opt, and local setups install the pinned wasm-bindgen', () => {
    expect(read('crates/wasm/Cargo.toml')).toContain(
      '[package.metadata.wasm-pack.profile.release]\nwasm-opt = false\n'
    )
    for (const file of ['README.md', 'jfiles/src/justfile'])
      expect(read(file)).toContain(`cargo install wasm-bindgen-cli --version ${bindgen} --locked`)
  })
})
