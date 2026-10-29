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
