import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { jsChunk, seedOf, sha256, wire } from '../trust/solve_js'

// The JavaScript solver against the vectors of crates/pow, the same ones the crate and the
// committed wasm reproduce. It runs with WebAssembly and with Worker taken away: it needs neither.

const ROOT = fileURLToPath(new URL('../../../../..', import.meta.url))
const v = JSON.parse(readFileSync(join(ROOT, 'crates/pow/tests/vectors.json'), 'utf8')) as {
  challenge: string
  seed_hex: string
  hash_sub0_nonce0_hex: string
  k: number
  target: string
  nonces: string[]
  nonces_wire: string
  tries: number
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')
const big = (n: number | string) => BigInt(n)
const ALL = (big(1) << big(64)) - big(1)

// The puzzle as the reference solvers write it, with the platform's SHA-256.
const reference = (seed: Uint8Array, sub: number, nonce: bigint, target: bigint) => {
  const input = Buffer.alloc(51)
  input.write('rchat-pow1', 0, 'ascii')
  Buffer.from(seed).copy(input, 10)
  input[42] = sub
  input.writeBigUInt64LE(nonce, 43)
  return createHash('sha256').update(input).digest().readBigUInt64BE(0) < target
}

const without = async (names: ('WebAssembly' | 'Worker')[], run: () => void | Promise<void>) => {
  const scope = globalThis as Record<string, unknown>
  const kept = names.map(name => [name, scope[name]] as const)
  for (const name of names) delete scope[name]
  try {
    for (const name of names) expect(typeof scope[name]).toBe('undefined')
    await run()
  } finally {
    for (const [name, value] of kept) scope[name] = value
  }
}

const realms: [string, ('WebAssembly' | 'Worker')[]][] = [
  ['with WebAssembly and Worker', []],
  ['without WebAssembly', ['WebAssembly']],
  ['without Worker', ['Worker']],
  ['without either', ['WebAssembly', 'Worker']],
]

describe('sha256', () => {
  test('matches the standard vectors', () => {
    const text = (s: string) => hex(sha256(new TextEncoder().encode(s)))
    expect(text('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(text('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(text('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'
    )
  })

  test('matches the platform at every length around the block edges', () => {
    for (const length of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000]) {
      const data = Uint8Array.from({ length }, (_, i) => (i * 131 + length) & 255)
      expect(hex(sha256(data))).toBe(createHash('sha256').update(data).digest('hex'))
    }
  })
})

for (const [realm, missing] of realms)
  describe(`the JavaScript solver ${realm}`, () => {
    test('derives the seed of the vectors', () =>
      without(missing, () => {
        expect(hex(seedOf(v.challenge))).toBe(v.seed_hex)
      }))

    test('hashes a try as the vectors do', () =>
      without(missing, () => {
        const seed = seedOf(v.challenge)
        const value = BigInt(`0x${v.hash_sub0_nonce0_hex.slice(0, 16)}`)
        expect(jsChunk(seed, 0, big(0), 1, value + big(1))).toBe(big(1))
        expect(jsChunk(seed, 0, big(0), 1, value)).toBe(big(0))
      }))

    test('finds the smallest winners of the vectors and writes them as the wire wants', () =>
      without(missing, () => {
        const seed = seedOf(v.challenge)
        const target = big(v.target)
        const found: bigint[] = []
        let tries = 0
        for (let sub = 0; sub < v.k; sub += 1) {
          let start = big(0)
          for (;;) {
            const hit = jsChunk(seed, sub, start, 1024, target)
            if (hit !== big(0)) {
              found.push(hit - big(1))
              tries += Number(hit - start)
              break
            }
            start += big(1024)
            tries += 1024
          }
        }
        expect(found.map(String)).toEqual(v.nonces)
        expect(wire(found)).toBe(v.nonces_wire)
        expect(tries).toBe(v.tries)
      }))
  })

describe('jsChunk', () => {
  const seed = seedOf(v.challenge)

  test('answers 0 without a winner, and for no tries', () => {
    const first = big(v.nonces[0])
    expect(jsChunk(seed, 0, big(0), Number(first), big(v.target))).toBe(big(0))
    expect(jsChunk(seed, 0, first, 1, big(v.target))).toBe(first + big(1))
    expect(jsChunk(seed, 0, first, 0, big(v.target))).toBe(big(0))
    expect(jsChunk(seed, 0, big(0), 64, big(0))).toBe(big(0))
    expect(jsChunk(seed, 3, big(9), 64, ALL)).toBe(big(10))
  })

  test('agrees with the platform hash on every try, across the 32-bit carry and high starts', () => {
    const target = big(1) << big(60)
    for (const [sub, start] of [
      [0, big(0)],
      [1, (big(1) << big(32)) - big(40)],
      [15, big(1) << big(56)],
      [63, big(7) * (big(1) << big(56)) + (big(1) << big(40)) - big(5)],
      [2, ALL - big(100)],
    ] as [number, bigint][]) {
      let want = big(0)
      for (let i = 0; i < 100 && want === big(0); i += 1)
        if (reference(seed, sub, start + big(i), target)) want = start + big(i) + big(1)
      expect(want === big(0)).toBe(false)
      expect(jsChunk(seed, sub, start, 100, target)).toBe(want)
      expect(jsChunk(seed, sub, start, Number(want - start) - 1, target)).toBe(big(0))
    }
  })

  test('compares the whole 64-bit value with the target', () => {
    const value = BigInt(`0x${v.hash_sub0_nonce0_hex.slice(0, 16)}`)
    const high = (value >> big(32)) << big(32)
    expect(jsChunk(seed, 0, big(0), 1, high)).toBe(big(0))
    expect(jsChunk(seed, 0, big(0), 1, high + (big(1) << big(32)))).toBe(big(1))
    expect(jsChunk(seed, 0, big(0), 1, value + big(1))).toBe(big(1))
  })
})

describe('wire', () => {
  test('is 16 hex digits per nonce, little endian', () => {
    expect(wire([])).toBe('')
    expect(wire([big(0)])).toBe('0000000000000000')
    expect(wire([big(1), big(2403)])).toBe('01000000000000006309000000000000')
    expect(wire([ALL, big(1) << big(56)])).toBe('ffffffffffffffff0000000000000001')
  })
})
