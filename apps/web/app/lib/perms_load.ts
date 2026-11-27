// Loads the shared permission rules (`perms.ts`) in a page or a worker: the WebAssembly build,
// or the JavaScript build of the same module where WebAssembly cannot run.
import { getBasePath } from './basePath'
import { probeWasm } from './capabilities'
import { ready, type PermsModule } from './perms'

// Where the built module is served. The page knows; it tells its workers.
let base: string | null = null
export const rulesBase = () => base ?? `${getBasePath()}/wasm`
export const setRulesBase = (to: string | null) => {
  base = to
}

export const moduleAt = (from: string) => async (): Promise<PermsModule> => {
  const path = `${from}/rust_next_wasm`
  if (!probeWasm())
    return (await import(
      /* webpackIgnore: true */ /* turbopackIgnore: true */ `${path}_js.js`
    )) as PermsModule
  const wasm = (await import(
    /* webpackIgnore: true */ /* turbopackIgnore: true */ `${path}.js`
  )) as PermsModule & { default: (init: { module_or_path: string }) => Promise<unknown> }
  await wasm.default({ module_or_path: `${path}_bg.wasm` })
  return wasm
}

export const loadPermissionRules = (from = rulesBase()) => ready(moduleAt(from))
