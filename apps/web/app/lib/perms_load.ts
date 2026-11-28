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

// The built module `name` under `from`: its WebAssembly build, or its JavaScript build.
export const builtModule =
  <M>(from: string, name: string) =>
  async (): Promise<M> => {
    const path = `${from}/${name}`
    if (!probeWasm())
      return (await import(
        /* webpackIgnore: true */ /* turbopackIgnore: true */ `${path}_js.js`
      )) as M
    const wasm = (await import(
      /* webpackIgnore: true */ /* turbopackIgnore: true */ `${path}.js`
    )) as M & { default: (init: { module_or_path: string }) => Promise<unknown> }
    await wasm.default({ module_or_path: `${path}_bg.wasm` })
    return wasm
  }

export const moduleAt = (from: string) => builtModule<PermsModule>(from, 'rust_next_wasm')

export const loadPermissionRules = (from = rulesBase()) => ready(moduleAt(from))
