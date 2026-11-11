// The proof-of-work puzzle in plain JavaScript, for devices without WebAssembly. It is the same
// puzzle as crates/pow and the committed wasm, checked against the same vectors, and it needs
// nothing but typed arrays and BigInt: it runs in a worker and on the main thread.
//
// A try is SHA-256("rchat-pow1" || seed || sub || nonce as 8 bytes little endian): 51 bytes, one
// block. It wins when the first 8 bytes of the hash, read big endian, are below the target.

export interface Puzzle {
  challenge: string
  k: number
  // Decimal: it passes 2^53.
  target: string
}

export interface Progress {
  solved: number
  tries: number
}

export interface Solved {
  // The wire form of the nonces.
  nonces: string
  tries: number
  elapsedMs: number
  threads: number
}

// Tries between two looks at cancel and two progress calls, as in the wasm solver.
export const CHUNK = 65_536

const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const INIT = new Int32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
])

const DOMAIN = [0x72, 0x63, 0x68, 0x61, 0x74, 0x2d, 0x70, 0x6f, 0x77, 0x31]
const SEED_DOMAIN = 'rchat-pow-seed1\0'
const TRY_BITS = 51 * 8

// One compression: `w[0..16]` is the block, `h` the state it updates.
const compress = (w: Int32Array, h: Int32Array) => {
  for (let i = 16; i < 64; i += 1) {
    const x = w[i - 15]
    const y = w[i - 2]
    const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)
    const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10)
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0
  }
  let a = h[0]
  let b = h[1]
  let c = h[2]
  let d = h[3]
  let e = h[4]
  let f = h[5]
  let g = h[6]
  let k = h[7]
  for (let i = 0; i < 64; i += 1) {
    const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
    const t1 = (k + s1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0
    const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
    const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) | 0
    k = g
    g = f
    f = e
    e = (d + t1) | 0
    d = c
    c = b
    b = a
    a = (t1 + t2) | 0
  }
  h[0] = (h[0] + a) | 0
  h[1] = (h[1] + b) | 0
  h[2] = (h[2] + c) | 0
  h[3] = (h[3] + d) | 0
  h[4] = (h[4] + e) | 0
  h[5] = (h[5] + f) | 0
  h[6] = (h[6] + g) | 0
  h[7] = (h[7] + k) | 0
}

const word = (bytes: Uint8Array, at: number) =>
  (bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]

export const sha256 = (data: Uint8Array): Uint8Array => {
  const padded = new Uint8Array((((data.length + 8) >> 6) + 1) << 6)
  padded.set(data)
  padded[data.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor(data.length / 0x20000000))
  view.setUint32(padded.length - 4, (data.length << 3) >>> 0)
  const h = new Int32Array(INIT)
  const w = new Int32Array(64)
  for (let at = 0; at < padded.length; at += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = word(padded, at + i * 4)
    compress(w, h)
  }
  const out = new Uint8Array(32)
  const result = new DataView(out.buffer)
  for (let i = 0; i < 8; i += 1) result.setInt32(i * 4, h[i])
  return out
}

// The puzzle seed of a challenge: SHA-256 of the domain and the whole sealed string as sent.
export const seedOf = (challenge: string): Uint8Array => {
  const text = new Uint8Array(SEED_DOMAIN.length + challenge.length)
  for (let i = 0; i < SEED_DOMAIN.length; i += 1) text[i] = SEED_DOMAIN.charCodeAt(i)
  for (let i = 0; i < challenge.length; i += 1)
    text[SEED_DOMAIN.length + i] = challenge.charCodeAt(i) & 255
  return sha256(text)
}

const MASK = BigInt(0xffffffff)
const WORD = BigInt(32)
const LAST = (BigInt(1) << BigInt(64)) - BigInt(1)

// Tries `count` nonces of sub-puzzle `sub` from `start`: the winning nonce plus one, or 0. The
// same contract as the wasm module's `pow_chunk`.
export const jsChunk = (
  seed: Uint8Array,
  sub: number,
  start: bigint,
  count: number,
  target: bigint
): bigint => {
  const block = new Uint8Array(64)
  block.set(DOMAIN)
  block.set(seed.subarray(0, 32), 10)
  block[42] = sub
  const fixed = new Int32Array(11)
  for (let i = 0; i < 11; i += 1) fixed[i] = word(block, i * 4)
  const w = new Int32Array(64)
  const h = new Int32Array(8)
  const targetHigh = Number(target >> WORD)
  const targetLow = Number(target & MASK)
  const room = LAST - start
  const tries = room < BigInt(count) ? Number(room) : count
  let low = Number(start & MASK)
  let high = Number(start >> WORD)
  for (let n = 0; n < tries; n += 1) {
    for (let i = 0; i < 10; i += 1) w[i] = fixed[i]
    w[10] = fixed[10] | (low & 255)
    w[11] =
      (((low >>> 8) & 255) << 24) |
      (((low >>> 16) & 255) << 16) |
      ((low >>> 24) << 8) |
      (high & 255)
    w[12] =
      (((high >>> 8) & 255) << 24) | (((high >>> 16) & 255) << 16) | ((high >>> 24) << 8) | 0x80
    w[13] = 0
    w[14] = 0
    w[15] = TRY_BITS
    h.set(INIT)
    compress(w, h)
    const top = h[0] >>> 0
    if (top < targetHigh || (top === targetHigh && h[1] >>> 0 < targetLow))
      return ((BigInt(high) << WORD) | BigInt(low)) + BigInt(1)
    low = (low + 1) >>> 0
    if (low === 0) high = (high + 1) >>> 0
  }
  return BigInt(0)
}

// Nonces on the wire: lowercase hex of each nonce's 8 little-endian bytes, one after another.
export const wire = (nonces: readonly bigint[]): string => {
  let out = ''
  for (const nonce of nonces)
    for (let i = 0; i < 8; i += 1)
      out += Number((nonce >> BigInt(i * 8)) & BigInt(255))
        .toString(16)
        .padStart(2, '0')
  return out
}
