// What a received file may be shown as, decided from its first bytes only, never from the type a
// peer or sender declared. Anything outside this list (SVG, HTML, PDF, ...) is download only.

export type PreviewKind = 'image' | 'video' | 'audio'

export interface Sniffed {
  mime: string
  kind: PreviewKind
}

export const SNIFF_BYTES = 64
export const PREVIEW_MAX = 10 * 1024 * 1024
export const NEUTRAL_TYPE = 'application/octet-stream'

const MP4_BRANDS = new Set([
  'isom',
  'iso2',
  'iso3',
  'iso4',
  'iso5',
  'iso6',
  'mp41',
  'mp42',
  'avc1',
  'M4V ',
  'dash',
  'mmp4',
])

const ascii = (b: Uint8Array, at: number, len: number) =>
  at + len <= b.length ? String.fromCharCode(...b.subarray(at, at + len)) : ''

const starts = (b: Uint8Array, sig: number[], at = 0) =>
  b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v)

const ebmlDocType = (b: Uint8Array) => {
  for (let i = 4; i + 6 <= b.length; i += 1) {
    if (b[i] === 0x42 && b[i + 1] === 0x82) {
      const len = b[i + 2] & 0x7f
      return ascii(b, i + 3, Math.min(len, 8))
    }
  }
  return ''
}

// `audioHint` only picks between the two passive players for a WebM, whose container is the same.
export const sniff = (head: Uint8Array, audioHint = false): Sniffed | null => {
  const b = head
  if (starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return { mime: 'image/png', kind: 'image' }
  if (starts(b, [0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', kind: 'image' }
  if (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')
    return { mime: 'image/gif', kind: 'image' }
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP')
    return { mime: 'image/webp', kind: 'image' }
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WAVE')
    return { mime: 'audio/wav', kind: 'audio' }
  if (ascii(b, 4, 4) === 'ftyp') {
    const brand = ascii(b, 8, 4)
    if (brand === 'avif' || brand === 'avis') return { mime: 'image/avif', kind: 'image' }
    if (MP4_BRANDS.has(brand)) return { mime: 'video/mp4', kind: 'video' }
    return null
  }
  if (starts(b, [0x1a, 0x45, 0xdf, 0xa3]) && ebmlDocType(b) === 'webm')
    return audioHint ? { mime: 'audio/webm', kind: 'audio' } : { mime: 'video/webm', kind: 'video' }
  if (ascii(b, 0, 4) === 'OggS') return { mime: 'audio/ogg', kind: 'audio' }
  if (ascii(b, 0, 3) === 'ID3') return { mime: 'audio/mpeg', kind: 'audio' }
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06) !== 0)
    return { mime: 'audio/mpeg', kind: 'audio' }
  return null
}

const u16be = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1]
const u16le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8)
const u24le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16)
const u32be = (b: Uint8Array, at: number) =>
  ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3]

// Start-of-frame markers of every JPEG coding (not DHT C4, JPG C8 or DAC CC).
const JPEG_SOF = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
])

const jpegSize = (b: Uint8Array) => {
  let at = 2
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return null
    const marker = b[at + 1]
    if (marker === 0xff) {
      at += 1
      continue
    }
    // Markers without a length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2
      continue
    }
    // Image data or the end before any frame header: no size to trust.
    if (marker === 0xda || marker === 0xd9) return null
    const len = u16be(b, at + 2)
    if (len < 2) return null
    if (JPEG_SOF.has(marker)) {
      if (at + 9 > b.length) return null
      return { w: u16be(b, at + 7), h: u16be(b, at + 5) }
    }
    at += 2 + len
  }
  return null
}

const webpSize = (b: Uint8Array) => {
  const chunk = ascii(b, 12, 4)
  if (chunk === 'VP8X' && b.length >= 30) return { w: u24le(b, 24) + 1, h: u24le(b, 27) + 1 }
  if (chunk === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)
    return { w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8 ' && b.length >= 30 && starts(b, [0x9d, 0x01, 0x2a], 23))
    return { w: u16le(b, 26) & 0x3fff, h: u16le(b, 28) & 0x3fff }
  return null
}

// Pixel size an image says it has, read from its header without decoding it (PNG, JPEG, GIF,
// WebP); null when the header is missing, cut short or not one of those. AVIF is always null:
// its size boxes can sit anywhere in the file, so a small one up front can hide the real size.
export const imageSize = (b: Uint8Array): { w: number; h: number } | null => {
  if (starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return b.length >= 24 && ascii(b, 12, 4) === 'IHDR'
      ? { w: u32be(b, 16), h: u32be(b, 20) }
      : null
  if (starts(b, [0xff, 0xd8])) return jpegSize(b)
  if (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')
    return b.length >= 10 ? { w: u16le(b, 6), h: u16le(b, 8) } : null
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return webpSize(b)
  return null
}

// Largest image shown inline, in pixels (about 160 MB once decoded), and most GIF frames.
export const IMAGE_PIXELS = 40_000_000
export const GIF_FRAMES = 1000
// Bytes read to find an image's size, and the largest GIF walked frame by frame.
export const IMAGE_HEAD = 256 * 1024
export const GIF_MAX = 32 * 1024 * 1024

// A GIF's frames: how many, and the largest extent any of them (or the screen) reaches, since the
// browser grows the canvas to fit a frame. Walks the block structure without decoding; stops at
// the trailer or where the file is cut. Null when the structure is broken.
export const gifFrames = (b: Uint8Array): { frames: number; w: number; h: number } | null => {
  if (b.length < 13 || (ascii(b, 0, 6) !== 'GIF87a' && ascii(b, 0, 6) !== 'GIF89a')) return null
  let w = u16le(b, 6)
  let h = u16le(b, 8)
  let at = 13
  if (b[10] & 0x80) at += 3 * (1 << ((b[10] & 7) + 1))
  let frames = 0
  const blocks = () => {
    while (at < b.length) {
      const n = b[at]
      at += 1 + n
      if (n === 0) return true
    }
    return false
  }
  while (at < b.length) {
    const tag = b[at]
    if (tag === 0x3b) break
    if (tag === 0x21) {
      at += 2
      if (!blocks()) break
      continue
    }
    if (tag !== 0x2c) return null
    if (at + 10 > b.length) break
    frames += 1
    if (frames > GIF_FRAMES) return { frames, w, h }
    w = Math.max(w, u16le(b, at + 1) + u16le(b, at + 5))
    h = Math.max(h, u16le(b, at + 3) + u16le(b, at + 7))
    const flags = b[at + 9]
    at += 10
    if (flags & 0x80) at += 3 * (1 << ((flags & 7) + 1))
    at += 1
    if (!blocks()) break
  }
  return { frames, w, h }
}

// Whether an image may be decoded inline, from its header (and, for a GIF, all of its frame
// descriptors): a known size of at most IMAGE_PIXELS, and at most GIF_FRAMES frames.
export const inlineImageOk = (b: Uint8Array) => {
  const size = imageSize(b)
  if (!size || size.w < 1 || size.h < 1 || size.w * size.h > IMAGE_PIXELS) return false
  if (ascii(b, 0, 3) !== 'GIF') return true
  const g = gifFrames(b)
  return !!g && g.frames <= GIF_FRAMES && g.w * g.h <= IMAGE_PIXELS
}

// The Blob type for received bytes: a recognized passive type or a neutral one.
export const safeType = (head: Uint8Array, audioHint = false) =>
  sniff(head, audioHint)?.mime ?? NEUTRAL_TYPE

const BIDI = new Set([
  0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
])

const unsafeChar = (c: string) => {
  const code = c.codePointAt(0) ?? 0
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || BIDI.has(code) || '/\\:*?"<>|'.includes(c)
}

// A file name that is safe to hand to the browser's save dialog, like a Content-Disposition
// filename: no paths, control or direction characters, no leading dots, at most 120 characters.
export const downloadName = (name: string) => {
  const clean = [...name]
    .map(c => (unsafeChar(c) ? '_' : c))
    .join('')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
    .trim()
  const short = [...clean].length > 120 ? [...clean].slice(-120).join('') : clean
  return short || 'download'
}

const KINDS: Record<string, PreviewKind> = {
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'image/avif': 'image',
  'video/mp4': 'video',
  'video/webm': 'video',
  'audio/webm': 'audio',
  'audio/ogg': 'audio',
  'audio/mpeg': 'audio',
  'audio/wav': 'audio',
}

// The player for a type `sniff` produced; null for anything else.
export const kindOf = (type: string): PreviewKind | null =>
  Object.hasOwn(KINDS, type) ? KINDS[type] : null

// What a file name suggests, only to decide whether a preview is worth fetching; the bytes still
// decide what is shown.
export const guessKind = (filename: string): PreviewKind | null => {
  const ext = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase() ?? ''
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'].includes(ext)) return 'image'
  if (['mp4', 'm4v', 'webm'].includes(ext)) return 'video'
  if (['mp3', 'ogg', 'oga', 'opus', 'wav', 'weba'].includes(ext)) return 'audio'
  return null
}

// For a WebM, whether to use the audio player: an audio name or declared type.
export const audioHint = (filename: string, declared: string | null) =>
  /\.weba$/i.test(filename) || (declared ?? '').toLowerCase().startsWith('audio/')
