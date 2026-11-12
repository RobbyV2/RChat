// What this page can do, found out by trying, never from the user agent. A feature that needs
// a missing capability and has no equal way without it is shown turned off with `UNAVAILABLE`
// and one line that says why.
export interface Capabilities {
  // WebAssembly compiles and runs here. It is missing in some lockdown modes and under a
  // content security policy without 'wasm-unsafe-eval'.
  wasm: boolean
}

export const UNAVAILABLE = 'Not available on this device'

export const unavailable = (reason: string) => `${UNAVAILABLE}. ${reason}`

// The smallest module: the magic number and version 1.
const TINY_MODULE = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])

interface WasmRealm {
  WebAssembly?: { Module?: unknown; Instance?: unknown }
}

type Build = new (from: unknown) => object

// Compiles and instantiates a tiny module in `realm`.
export const probeWasm = (realm: WasmRealm = globalThis as WasmRealm): boolean => {
  try {
    const { Module, Instance } = realm.WebAssembly ?? {}
    if (typeof Module !== 'function' || typeof Instance !== 'function') return false
    const made = new (Instance as Build)(new (Module as Build)(TINY_MODULE))
    return made instanceof Instance
  } catch {
    return false
  }
}

export const probe = (realm?: WasmRealm): Capabilities => ({ wasm: probeWasm(realm) })
