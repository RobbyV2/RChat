import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loaded, ready, unload, type PermsModule } from '../../perms'

export const WASM = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'public',
  'wasm'
)

export const built = (file: string) => {
  const path = join(WASM, file)
  if (!existsSync(path)) throw new Error(`${file} is missing: run bun run build:wasm`)
  return path
}

export const wasmBuild = async (): Promise<PermsModule> => {
  const bytes = readFileSync(built('rust_next_wasm_bg.wasm'))
  const mod = (await import(built('rust_next_wasm.js'))) as PermsModule & {
    initSync: (init: { module: Uint8Array }) => unknown
  }
  mod.initSync({ module: bytes })
  return mod
}

export const jsBuild = async (): Promise<PermsModule> =>
  (await import(built('rust_next_wasm_js.js'))) as PermsModule

// Loads the permission rules for a test file, through WebAssembly unless `build` says otherwise.
export const loadPerms = async (build: () => Promise<PermsModule> = wasmBuild) => {
  unload()
  await ready(build)
}

// For scripts that run outside the test runner: loads the rules unless they are in already.
export const ensurePerms = async () => {
  if (!loaded()) await ready(wasmBuild)
}
