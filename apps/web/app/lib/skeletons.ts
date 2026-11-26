// The shapes of loading placeholders, drawn from a key: the same key always gives the same
// shapes, so a placeholder never changes between renders, or between the server and the client.
// Widths are percents of the row (`%`) or pixels (`px`). Pure.

// FNV-1a of the key.
const hash = (key: string) => {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

// Numbers in [0, 1) from the key (mulberry32).
export const seeded = (key: string) => {
  let a = hash(key)
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Rand = () => number

// A whole number from `lo` to `hi`, both included.
const pick = (r: Rand, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1))

// `total` split into `parts` of at least `min` each.
const split = (r: Rand, total: number, parts: number, min: number) => {
  const out = Array.from({ length: parts }, () => min)
  for (let left = total - parts * min; left > 0; left -= 1) out[pick(r, 0, parts - 1)] += 1
  return out
}

export interface MessageShape {
  // px
  name: number
  time: number
  // %, the last line shorter than the others
  lines: number[]
  // px, an attachment or embed card under the text
  media: { w: number; h: number } | null
}

// 6 to 9 message groups: 1 to 4 lines each, and about one in four with a card under them.
export const messageShapes = (key: string, media = true): MessageShape[] => {
  const r = seeded(`messages:${key}`)
  return Array.from({ length: pick(r, 6, 9) }, () => {
    const count = pick(r, 1, 4)
    const lines = Array.from({ length: count }, (_, i) =>
      count === 1 ? pick(r, 35, 92) : i === count - 1 ? pick(r, 35, 60) : pick(r, 62, 92)
    )
    const card = r()
    const tall = card < 0.12
    const w = tall ? pick(r, 160, 200) : pick(r, 240, 290)
    const h = tall ? pick(r, 200, 250) : pick(r, 96, 120)
    return {
      name: pick(r, 64, 140),
      time: pick(r, 36, 56),
      lines,
      media: media && card < 0.28 ? { w, h } : null,
    }
  })
}

export interface MemberShape {
  // %
  name: number
  // px, a role or status pill after the name
  pill: number | null
}

// 2 or 3 sections holding 8 to 12 members between them.
export const memberShapes = (key: string): MemberShape[][] => {
  const r = seeded(`members:${key}`)
  const sections = pick(r, 2, 3)
  return split(r, pick(r, 8, 12), sections, 2).map(n =>
    Array.from({ length: n }, () => ({
      name: pick(r, 45, 80),
      pill: r() < 0.2 ? pick(r, 30, 44) : null,
    }))
  )
}

export interface ChannelGroupShape {
  // Uncategorized channels come first, without a header.
  header: boolean
  // %
  rows: number[]
}

// 2 or 3 categories, and maybe a few channels above them: 6 to 10 channels in all.
export const channelShapes = (key: string): ChannelGroupShape[] => {
  const r = seeded(`channels:${key}`)
  const total = pick(r, 6, 10)
  const loose = pick(r, 0, 2)
  const width = () => pick(r, 40, 78)
  const groups = split(r, total - loose, pick(r, 2, 3), 1).map(n => ({
    header: true,
    rows: Array.from({ length: n }, width),
  }))
  return loose ? [{ header: false, rows: Array.from({ length: loose }, width) }, ...groups] : groups
}

export interface DmShape {
  // %
  name: number
  preview: number | null
}

// 6 to 8 conversations, or `count` of them.
export const dmShapes = (key: string, count?: number): DmShape[] => {
  const r = seeded(`dms:${key}`)
  return Array.from({ length: count ?? pick(r, 6, 8) }, () => ({
    name: pick(r, 45, 75),
    preview: r() < 0.6 ? pick(r, 30, 55) : null,
  }))
}

// 5 to 7 rail tiles (2 or 3 when `few`), some round.
export const railShapes = (key: string, few = false): { round: boolean }[] => {
  const r = seeded(`rail:${key}`)
  return Array.from({ length: few ? pick(r, 2, 3) : pick(r, 5, 7) }, () => ({ round: r() < 0.3 }))
}

// `count` rows of a title and a line under it (%).
export const rowShapes = (key: string, count: number): { title: number; line: number }[] => {
  const r = seeded(`rows:${key}`)
  return Array.from({ length: count }, () => ({ title: pick(r, 30, 55), line: pick(r, 45, 80) }))
}
