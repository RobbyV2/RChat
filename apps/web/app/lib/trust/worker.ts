import { jsChunk } from './solve_js'

// The solver worker. In: `{boot: true, wasm}` once, then `{id, seed, target, sub, start, count}`
// per chunk. Out: `{ready, wasm}` or `{ready: false, error}`, then `{id, hit}` per chunk (the
// winning nonce plus one, or 0). With a module it solves in wasm, without one in JavaScript.

interface Boot {
  boot: true
  wasm: Uint8Array | null
}

interface Job {
  id: number
  seed: Uint8Array
  target: bigint
  sub: number
  start: bigint
  count: number
}

interface Wasm {
  memory: WebAssembly.Memory
  seed_ptr: () => number
  pow_chunk: (sub: number, start: bigint, count: number, target: bigint) => bigint
}

const post = (m: unknown) =>
  (self as unknown as { postMessage: (m: unknown) => void }).postMessage(m)

let wasm: Wasm | null = null

const boot = async ({ wasm: bytes }: Boot) => {
  if (!bytes) return false
  const { instance } = await WebAssembly.instantiate(Uint8Array.from(bytes))
  wasm = instance.exports as unknown as Wasm
  return true
}

const chunk = ({ seed, target, sub, start, count }: Job): bigint => {
  if (!wasm) return jsChunk(seed, sub, start, count, target)
  new Uint8Array(wasm.memory.buffer, wasm.seed_ptr(), 32).set(seed)
  // A wasm i64 comes back signed: a winner from 2^63 up would read as negative.
  return BigInt.asUintN(64, wasm.pow_chunk(sub, start, count, target))
}

self.onmessage = (e: MessageEvent<Boot | Job>) => {
  const m = e.data
  if ('boot' in m) {
    boot(m).then(
      ran => post({ ready: true, wasm: ran }),
      (err: unknown) =>
        post({ ready: false, error: err instanceof Error ? err.message : String(err) })
    )
    return
  }
  try {
    post({ id: m.id, hit: chunk(m) })
  } catch (err) {
    post({ id: m.id, error: err instanceof Error ? err.message : String(err) })
  }
}
