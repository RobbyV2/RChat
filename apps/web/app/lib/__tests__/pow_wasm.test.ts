import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The committed solver module (crates/pow-wasm, rebuilt by `just src pow-wasm`) against the
// vectors of crates/pow.

const ROOT = fileURLToPath(new URL('../../../../..', import.meta.url))
const bytes = readFileSync(join(ROOT, 'apps/web/public/pow/rchat_pow.wasm'))
const v = JSON.parse(readFileSync(join(ROOT, 'crates/pow/tests/vectors.json'), 'utf8')) as {
  challenge: string
  seed_hex: string
  k: number
  target: string
  nonces: string[]
}

interface Exports {
  memory: WebAssembly.Memory
  seed_ptr: () => number
  pow_chunk: (sub: number, start: bigint, count: number, target: bigint) => bigint
}

const seedOf = (challenge: string) =>
  createHash('sha256').update('rchat-pow-seed1\0').update(challenge).digest()

const load = async () => {
  const module = new WebAssembly.Module(bytes)
  const instance = await WebAssembly.instantiate(module)
  const exports = instance.exports as unknown as Exports
  new Uint8Array(exports.memory.buffer, exports.seed_ptr(), 32).set(seedOf(v.challenge))
  return { module, exports }
}

describe('the committed pow wasm', () => {
  test('has no imports and exactly the exports memory, seed_ptr and pow_chunk', async () => {
    const { module } = await load()
    expect(WebAssembly.Module.imports(module)).toEqual([])
    expect(
      WebAssembly.Module.exports(module)
        .map(e => `${e.kind} ${e.name}`)
        .sort()
    ).toEqual(['function pow_chunk', 'function seed_ptr', 'memory memory'])
  })

  test('stays under 16 KiB', () => {
    expect(bytes.length).toBeGreaterThan(0)
    expect(bytes.length).toBeLessThan(16 * 1024)
  })

  test('pow_chunk finds the smallest winners of the vectors', async () => {
    const { exports } = await load()
    expect(seedOf(v.challenge).toString('hex')).toBe(v.seed_hex)
    const target = BigInt(v.target)
    const found: string[] = []
    for (let sub = 0; sub < v.k; sub += 1) {
      let start = BigInt(0)
      for (;;) {
        const hit = exports.pow_chunk(sub, start, 1024, target)
        if (hit !== BigInt(0)) {
          found.push(String(hit - BigInt(1)))
          break
        }
        start += BigInt(1024)
      }
    }
    expect(found).toEqual(v.nonces)
  })

  test('pow_chunk answers 0 without a winner and takes a full 64-bit start', async () => {
    const { exports } = await load()
    const target = BigInt(v.target)
    const first = BigInt(v.nonces[0])
    expect(exports.pow_chunk(0, BigInt(0), Number(first), target)).toBe(BigInt(0))
    expect(exports.pow_chunk(0, first, 1, target)).toBe(first + BigInt(1))
    expect(exports.pow_chunk(0, first, 0, target)).toBe(BigInt(0))
    const high = BigInt(1) << BigInt(56)
    expect(exports.pow_chunk(0, high, 16, BigInt(0))).toBe(BigInt(0))
    const all = (BigInt(1) << BigInt(64)) - BigInt(1)
    expect(exports.pow_chunk(0, high, 16, all)).toBe(high + BigInt(1))
  })

  test('a winner from 2^63 up comes back as a signed number: asUintN(64) is the answer', async () => {
    const { exports } = await load()
    const all = (BigInt(1) << BigInt(64)) - BigInt(1)
    const start = (BigInt(1) << BigInt(63)) + BigInt(5)
    const raw = exports.pow_chunk(0, start, 1, all)
    expect(raw < BigInt(0)).toBe(true)
    expect(BigInt.asUintN(64, raw)).toBe(start + BigInt(1))
    const last = all - BigInt(1)
    expect(BigInt.asUintN(64, exports.pow_chunk(0, last, 1, all))).toBe(all)
    expect(exports.pow_chunk(0, all, 1, all)).toBe(BigInt(0))
  })
})
