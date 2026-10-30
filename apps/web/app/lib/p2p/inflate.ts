// A small raw DEFLATE (RFC 1951) decoder and a stored-block encoder, for browsers without
// CompressionStream('deflate-raw'). Output is capped so a crafted input can't expand without
// bound.

export class InflateError extends Error {}

const LEN_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
]
const LEN_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
]
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
]
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
]
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

interface Huffman {
  counts: Uint16Array
  symbols: Uint16Array
}

const build = (lengths: ArrayLike<number>, n: number): Huffman => {
  const counts = new Uint16Array(16)
  for (let i = 0; i < n; i += 1) counts[lengths[i]] += 1
  counts[0] = 0
  let left = 1
  for (let len = 1; len < 16; len += 1) {
    left = (left << 1) - counts[len]
    if (left < 0) throw new InflateError('over-subscribed code')
  }
  const offs = new Uint16Array(16)
  for (let len = 1; len < 15; len += 1) offs[len + 1] = offs[len] + counts[len]
  const symbols = new Uint16Array(n)
  for (let i = 0; i < n; i += 1) if (lengths[i] !== 0) symbols[offs[lengths[i]]++] = i
  return { counts, symbols }
}

const FIXED_LIT = (() => {
  const l = new Uint8Array(288)
  l.fill(8, 0, 144)
  l.fill(9, 144, 256)
  l.fill(7, 256, 280)
  l.fill(8, 280, 288)
  return build(l, 288)
})()
const FIXED_DIST = build(new Uint8Array(30).fill(5), 30)

export const inflateRaw = (input: Uint8Array, maxOut: number): Uint8Array => {
  let pos = 0
  let bitBuf = 0
  let bitCnt = 0
  let out = new Uint8Array(Math.min(maxOut, Math.max(1024, input.length * 4)))
  let outLen = 0

  const bits = (need: number) => {
    while (bitCnt < need) {
      if (pos >= input.length) throw new InflateError('unexpected end')
      bitBuf |= input[pos++] << bitCnt
      bitCnt += 8
    }
    const v = bitBuf & ((1 << need) - 1)
    bitBuf >>>= need
    bitCnt -= need
    return v
  }

  const ensure = (extra: number) => {
    if (outLen + extra > maxOut) throw new InflateError('output too large')
    if (outLen + extra <= out.length) return
    const next = new Uint8Array(Math.min(maxOut, Math.max(out.length * 2, outLen + extra)))
    next.set(out.subarray(0, outLen))
    out = next
  }

  const decode = (h: Huffman) => {
    let code = 0
    let first = 0
    let index = 0
    for (let len = 1; len < 16; len += 1) {
      code |= bits(1)
      const count = h.counts[len]
      if (code - count < first) return h.symbols[index + (code - first)]
      index += count
      first += count
      first <<= 1
      code <<= 1
    }
    throw new InflateError('bad code')
  }

  const codes = (lit: Huffman, dist: Huffman) => {
    for (;;) {
      const sym = decode(lit)
      if (sym < 256) {
        ensure(1)
        out[outLen++] = sym
      } else if (sym === 256) return
      else {
        const li = sym - 257
        if (li >= 29) throw new InflateError('bad length')
        const len = LEN_BASE[li] + bits(LEN_EXTRA[li])
        const di = decode(dist)
        if (di >= 30) throw new InflateError('bad distance')
        const d = DIST_BASE[di] + bits(DIST_EXTRA[di])
        if (d > outLen) throw new InflateError('distance too far')
        ensure(len)
        for (let i = 0; i < len; i += 1) {
          out[outLen] = out[outLen - d]
          outLen += 1
        }
      }
    }
  }

  let last = 0
  while (!last) {
    last = bits(1)
    const type = bits(2)
    if (type === 0) {
      bitBuf = 0
      bitCnt = 0
      if (pos + 4 > input.length) throw new InflateError('unexpected end')
      const len = input[pos] | (input[pos + 1] << 8)
      const nlen = input[pos + 2] | (input[pos + 3] << 8)
      pos += 4
      if (len !== (~nlen & 0xffff)) throw new InflateError('bad stored length')
      if (pos + len > input.length) throw new InflateError('unexpected end')
      ensure(len)
      out.set(input.subarray(pos, pos + len), outLen)
      outLen += len
      pos += len
    } else if (type === 1) codes(FIXED_LIT, FIXED_DIST)
    else if (type === 2) {
      const nlen = bits(5) + 257
      const ndist = bits(5) + 1
      const ncode = bits(4) + 4
      if (nlen > 286 || ndist > 30) throw new InflateError('bad counts')
      const cl = new Uint8Array(19)
      for (let i = 0; i < ncode; i += 1) cl[CL_ORDER[i]] = bits(3)
      const clh = build(cl, 19)
      const lengths = new Uint8Array(nlen + ndist)
      let i = 0
      while (i < nlen + ndist) {
        const sym = decode(clh)
        if (sym < 16) lengths[i++] = sym
        else {
          let rep: number
          let val = 0
          if (sym === 16) {
            if (i === 0) throw new InflateError('repeat with no length')
            val = lengths[i - 1]
            rep = 3 + bits(2)
          } else if (sym === 17) rep = 3 + bits(3)
          else rep = 11 + bits(7)
          if (i + rep > nlen + ndist) throw new InflateError('too many lengths')
          lengths.fill(val, i, i + rep)
          i += rep
        }
      }
      if (lengths[256] === 0) throw new InflateError('no end code')
      codes(build(lengths.subarray(0, nlen), nlen), build(lengths.subarray(nlen), ndist))
    } else throw new InflateError('bad block type')
  }
  if (pos !== input.length) throw new InflateError('trailing data')
  return out.slice(0, outLen)
}

// Valid raw DEFLATE made of stored blocks: no compression, but any inflater reads it.
export const storeRaw = (data: Uint8Array): Uint8Array => {
  const blocks = Math.max(1, Math.ceil(data.length / 0xffff))
  const out = new Uint8Array(data.length + blocks * 5)
  let o = 0
  for (let b = 0; b < blocks; b += 1) {
    const chunk = data.subarray(b * 0xffff, (b + 1) * 0xffff)
    out[o++] = b === blocks - 1 ? 1 : 0
    out[o++] = chunk.length & 0xff
    out[o++] = chunk.length >>> 8
    out[o++] = ~chunk.length & 0xff
    out[o++] = (~chunk.length >>> 8) & 0xff
    out.set(chunk, o)
    o += chunk.length
  }
  return out
}
