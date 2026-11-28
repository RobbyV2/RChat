// ThumbHash placeholders of images: the decoder of the reference implementation
// (github.com/evanw/thumbhash, MIT), turning a hash into a small PNG to show, blurred and scaled
// up, while the image loads. The hashes are made by the shared picture crate (`rchat-avatar`).

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

// The hash a placeholder's text names; null when it is not base64url of at most 64 characters.
export const hashBytes = (text: unknown): Uint8Array | null => {
  if (typeof text !== 'string' || text === '' || text.length > 64) return null
  const out: number[] = []
  let bits = 0
  let held = 0
  for (const c of text) {
    const v = B64URL.indexOf(c)
    if (v < 0) return null
    bits = ((bits << 6) | v) & 0xffffff
    held += 6
    if (held >= 8) {
      held -= 8
      out.push((bits >> held) & 255)
    }
  }
  return out.length >= 5 ? new Uint8Array(out) : null
}

export const aspectRatio = (hash: Uint8Array) => {
  const header = hash[3]
  const hasAlpha = hash[2] & 0x80
  const isLandscape = hash[4] & 0x80
  const lx = isLandscape ? (hasAlpha ? 5 : 7) : header & 7
  const ly = isLandscape ? header & 7 : hasAlpha ? 5 : 7
  return lx / ly
}

export const hashToRgba = (hash: Uint8Array): { w: number; h: number; rgba: Uint8Array } => {
  const { PI, min, max, cos, round } = Math
  const header24 = hash[0] | (hash[1] << 8) | (hash[2] << 16)
  const header16 = hash[3] | (hash[4] << 8)
  const lDc = (header24 & 63) / 63
  const pDc = ((header24 >> 6) & 63) / 31.5 - 1
  const qDc = ((header24 >> 12) & 63) / 31.5 - 1
  const lScale = ((header24 >> 18) & 31) / 31
  const hasAlpha = header24 >> 23
  const pScale = ((header16 >> 3) & 63) / 63
  const qScale = ((header16 >> 9) & 63) / 63
  const isLandscape = header16 >> 15
  const lx = max(3, isLandscape ? (hasAlpha ? 5 : 7) : header16 & 7)
  const ly = max(3, isLandscape ? header16 & 7 : hasAlpha ? 5 : 7)
  const aDc = hasAlpha ? (hash[5] & 15) / 15 : 1
  const aScale = (hash[5] >> 4) / 15
  const acStart = hasAlpha ? 6 : 5
  let acIndex = 0
  const channel = (nx: number, ny: number, scale: number) => {
    const ac: number[] = []
    for (let cy = 0; cy < ny; cy++)
      for (let cx = cy ? 0 : 1; cx * ny < nx * (ny - cy); cx++) {
        const byte = hash[acStart + (acIndex >> 1)] ?? 0
        ac.push((((byte >> ((acIndex & 1) << 2)) & 15) / 7.5 - 1) * scale)
        acIndex++
      }
    return ac
  }
  const lAc = channel(lx, ly, lScale)
  const pAc = channel(3, 3, pScale * 1.25)
  const qAc = channel(3, 3, qScale * 1.25)
  const aAc = hasAlpha ? channel(5, 5, aScale) : []
  const ratio = aspectRatio(hash)
  const w = round(ratio > 1 ? 32 : 32 * ratio)
  const h = round(ratio > 1 ? 32 / ratio : 32)
  const rgba = new Uint8Array(w * h * 4)
  const fx: number[] = []
  const fy: number[] = []
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      let l = lDc
      let p = pDc
      let q = qDc
      let a = aDc
      for (let cx = 0, n = max(lx, hasAlpha ? 5 : 3); cx < n; cx++)
        fx[cx] = cos((PI / w) * (x + 0.5) * cx)
      for (let cy = 0, n = max(ly, hasAlpha ? 5 : 3); cy < n; cy++)
        fy[cy] = cos((PI / h) * (y + 0.5) * cy)
      for (let cy = 0, j = 0; cy < ly; cy++)
        for (let cx = cy ? 0 : 1, fy2 = fy[cy] * 2; cx * ly < lx * (ly - cy); cx++, j++)
          l += lAc[j] * fx[cx] * fy2
      for (let cy = 0, j = 0; cy < 3; cy++)
        for (let cx = cy ? 0 : 1, fy2 = fy[cy] * 2; cx < 3 - cy; cx++, j++) {
          const f = fx[cx] * fy2
          p += pAc[j] * f
          q += qAc[j] * f
        }
      if (hasAlpha)
        for (let cy = 0, j = 0; cy < 5; cy++)
          for (let cx = cy ? 0 : 1, fy2 = fy[cy] * 2; cx < 5 - cy; cx++, j++)
            a += aAc[j] * fx[cx] * fy2
      const b = l - (2 / 3) * p
      const r = (3 * l - b + q) / 2
      const g = r - q
      rgba[i] = max(0, 255 * min(1, r))
      rgba[i + 1] = max(0, 255 * min(1, g))
      rgba[i + 2] = max(0, 255 * min(1, b))
      rgba[i + 3] = max(0, 255 * min(1, a))
    }
  }
  return { w, h, rgba }
}

const CRC = [
  0, 498536548, 997073096, 651767980, 1994146192, 1802195444, 1303535960, 1342533948, -306674912,
  -267414716, -690576408, -882789492, -1687895376, -2032938284, -1609899400, -1111625188,
]

// An uncompressed PNG of `rgba`, as a data URL.
export const rgbaToDataUrl = (w: number, h: number, rgba: Uint8Array) => {
  const row = w * 4 + 1
  const idat = 6 + h * (5 + row)
  const bytes = [
    137,
    80,
    78,
    71,
    13,
    10,
    26,
    10,
    0,
    0,
    0,
    13,
    73,
    72,
    68,
    82,
    0,
    0,
    w >> 8,
    w & 255,
    0,
    0,
    h >> 8,
    h & 255,
    8,
    6,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    idat >>> 24,
    (idat >> 16) & 255,
    (idat >> 8) & 255,
    idat & 255,
    73,
    68,
    65,
    84,
    120,
    1,
  ]
  let a = 1
  let b = 0
  for (let y = 0, i = 0, end = row - 1; y < h; y++, end += row - 1) {
    bytes.push(y + 1 < h ? 0 : 1, row & 255, row >> 8, ~row & 255, (row >> 8) ^ 255, 0)
    for (b = (b + a) % 65521; i < end; i++) {
      const u = rgba[i] & 255
      bytes.push(u)
      a = (a + u) % 65521
      b = (b + a) % 65521
    }
  }
  bytes.push(
    b >> 8,
    b & 255,
    a >> 8,
    a & 255,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    73,
    69,
    78,
    68,
    174,
    66,
    96,
    130
  )
  for (const [start, stop] of [
    [12, 29],
    [37, 41 + idat],
  ]) {
    let c = ~0
    for (let i = start; i < stop; i++) {
      c ^= bytes[i]
      c = (c >>> 4) ^ CRC[c & 15]
      c = (c >>> 4) ^ CRC[c & 15]
    }
    c = ~c
    bytes[stop] = c >>> 24
    bytes[stop + 1] = (c >> 16) & 255
    bytes[stop + 2] = (c >> 8) & 255
    bytes[stop + 3] = c & 255
  }
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte & 255)
  return `data:image/png;base64,${btoa(text)}`
}

const KEPT = 256
const made = new Map<string, string | null>()

// The picture of the placeholder `text`, kept for the last 256 asked; null for a malformed one.
export const placeholderUrl = (text: unknown): string | null => {
  if (typeof text !== 'string') return null
  const known = made.get(text)
  if (known !== undefined) return known
  const hash = hashBytes(text)
  let url: string | null = null
  if (hash)
    try {
      const { w, h, rgba } = hashToRgba(hash)
      url = w > 0 && h > 0 ? rgbaToDataUrl(w, h, rgba) : null
    } catch {
      url = null
    }
  made.set(text, url)
  if (made.size > KEPT) made.delete(made.keys().next().value as string)
  return url
}
