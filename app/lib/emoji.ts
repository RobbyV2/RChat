export type CategoryId =
  | 'recent'
  | 'people'
  | 'nature'
  | 'food'
  | 'activities'
  | 'travel'
  | 'objects'
  | 'symbols'
  | 'flags'

export const CATEGORIES: { id: CategoryId; label: string }[] = [
  { id: 'recent', label: 'Frequently used' },
  { id: 'people', label: 'Smileys & People' },
  { id: 'nature', label: 'Nature' },
  { id: 'food', label: 'Food' },
  { id: 'activities', label: 'Activities' },
  { id: 'travel', label: 'Travel' },
  { id: 'objects', label: 'Objects' },
  { id: 'symbols', label: 'Symbols' },
  { id: 'flags', label: 'Flags' },
]

const GROUPS: Record<number, CategoryId> = {
  0: 'people',
  1: 'people',
  3: 'nature',
  4: 'food',
  5: 'travel',
  6: 'activities',
  7: 'objects',
  8: 'symbols',
  9: 'flags',
}

export interface Emoji {
  emoji: string
  name: string
  category: CategoryId
  keywords: string[]
  shortcodes: string[]
  skins: string[] | null
  version: number
}

export interface RawSkin {
  emoji: string
  tone?: number | number[]
  version: number
}

export interface RawEmoji {
  emoji: string
  label: string
  hexcode: string
  group?: number
  order?: number
  tags?: string[]
  version: number
  skins?: RawSkin[]
}

export type ShortcodeMap = Record<string, string | string[]>

export const TONES = 5

const unique = <T>(list: T[]) => [...new Set(list)]

const singleTone = (t: RawSkin['tone']) =>
  typeof t === 'number'
    ? t
    : Array.isArray(t) && t.length > 0 && t.every(x => x === t[0])
      ? t[0]
      : 0

const skinList = (skins: RawSkin[] | undefined, maxVersion: number): string[] | null => {
  if (!skins?.length) return null
  const out: string[] = []
  for (const s of skins) {
    const tone = singleTone(s.tone)
    if (tone < 1 || tone > TONES) continue
    if (s.version > maxVersion) return null
    out[tone - 1] = s.emoji
  }
  return out.length === TONES && out.every(Boolean) ? out : null
}

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')

const primaryFirst = (codes: string[]) => {
  const i = codes.findIndex(c => /^[a-z]/.test(c))
  return i <= 0 ? codes : [codes[i], ...codes.slice(0, i), ...codes.slice(i + 1)]
}

export function fromEmojibase(
  data: RawEmoji[],
  maps: ShortcodeMap[],
  maxVersion = Infinity
): Emoji[] {
  return data
    .filter(r => r.group !== undefined && GROUPS[r.group] !== undefined && r.version <= maxVersion)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map(r => {
      const codes = unique(maps.flatMap(m => [m[r.hexcode] ?? []].flat()))
      return {
        emoji: r.emoji,
        name: r.label,
        category: GROUPS[r.group as number],
        keywords: r.tags ?? [],
        shortcodes: codes.length ? primaryFirst(codes) : [slug(r.label)],
        skins: skinList(r.skins, maxVersion),
        version: r.version,
      }
    })
}

export const withTone = (e: Emoji, tone: number) =>
  tone >= 1 && tone <= TONES && e.skins ? e.skins[tone - 1] : e.emoji

export const shortcodeOf = (e: Emoji) => e.shortcodes[0]

export const sections = (list: Emoji[]) => {
  const out = new Map<CategoryId, Emoji[]>()
  for (const e of list) {
    const bucket = out.get(e.category)
    if (bucket) bucket.push(e)
    else out.set(e.category, [e])
  }
  return out
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')

interface Fields {
  codes: string[]
  name: string
  words: string[]
  keywords: string[]
}

const fieldCache = new WeakMap<Emoji, Fields>()

const fields = (e: Emoji): Fields => {
  const hit = fieldCache.get(e)
  if (hit) return hit
  const name = norm(e.name)
  const codes = e.shortcodes.map(norm)
  const made = {
    codes,
    name,
    words: unique([...name.split(/[\s:,.'’()-]+/), ...codes.flatMap(c => c.split('_'))]).filter(
      Boolean
    ),
    keywords: e.keywords.map(norm),
  }
  fieldCache.set(e, made)
  return made
}

const tokenScore = (f: Fields, t: string) => {
  if (f.codes.includes(t)) return 0
  if (f.codes.some(c => c.startsWith(t))) return 1
  if (f.words.some(w => w.startsWith(t))) return 1.5
  if (f.keywords.includes(t)) return 2
  if (f.keywords.some(k => k.startsWith(t))) return 2.5
  if (f.codes.some(c => c.includes(t)) || f.name.includes(t)) return 4
  return null
}

const queryOf = (raw: string) => norm(raw.trim()).replace(/^:+|:+$/g, '')

export type Boost = (e: Emoji) => number

const byScore = (boost: Boost | undefined) => {
  return <T extends { e: Emoji; score: number; i: number }>(a: T, b: T) =>
    a.score - b.score || (boost ? boost(b.e) - boost(a.e) : 0) || a.i - b.i
}

export function searchEmoji(list: Emoji[], raw: string, boost?: Boost): Emoji[] {
  const q = queryOf(raw)
  if (!q) return []
  const tokens = q.split(/[\s_]+/).filter(Boolean)
  const whole = tokens.join('_')
  const hits: { e: Emoji; score: number; i: number }[] = []
  list.forEach((e, i) => {
    if (e.emoji === raw.trim() || e.skins?.includes(raw.trim())) {
      hits.push({ e, score: -2, i })
      return
    }
    const f = fields(e)
    let score = 0
    for (const t of tokens) {
      const s = tokenScore(f, t)
      if (s === null) return
      score += s
    }
    if (f.codes.includes(whole)) score = -1
    else if (f.name === tokens.join(' ')) score = Math.min(score, 0)
    hits.push({ e, score, i })
  })
  return hits.sort(byScore(boost)).map(h => h.e)
}

export interface CodeMatch {
  emoji: Emoji
  code: string
}

const codeRank = (code: string, q: string) =>
  code === q ? 0 : code.startsWith(q) ? 1 : code.includes(`_${q}`) ? 2 : code.includes(q) ? 3 : null

export function matchShortcodes(
  list: Emoji[],
  raw: string,
  limit = 10,
  boost?: Boost
): CodeMatch[] {
  const q = queryOf(raw)
  if (!q) return []
  const hits: { e: Emoji; code: string; score: number; i: number }[] = []
  list.forEach((e, i) => {
    let best: { code: string; score: number } | null = null
    for (const code of e.shortcodes) {
      const score = codeRank(norm(code), q)
      if (score !== null && (best === null || score < best.score)) best = { code, score }
    }
    if (best) hits.push({ e, i, ...best })
  })
  return hits
    .sort(byScore(boost))
    .slice(0, limit)
    .map(h => ({ emoji: h.e, code: h.code }))
}

const indexCache = new WeakMap<Emoji[], Map<string, Emoji>>()

export function findShortcode(list: Emoji[], code: string): Emoji | null {
  let index = indexCache.get(list)
  if (!index) {
    index = new Map()
    for (const e of list) for (const c of e.shortcodes) if (!index.has(c)) index.set(c, e)
    indexCache.set(list, index)
  }
  return index.get(code.toLowerCase()) ?? null
}

export interface EmojiUse {
  n: number
  at: number
  last: string
}

export interface EmojiPrefs {
  v: 1
  tone: number
  used: Record<string, EmojiUse>
}

export const EMPTY_PREFS: EmojiPrefs = { v: 1, tone: 0, used: {} }

export const emojiKey = (username: string) => `rchat_emoji:${username}`

export const HALF_LIFE_MS = 7 * 86_400_000
export const MAX_USED = 60
export const DEFAULT_TOP = ['👍', '😂', '❤️']

const isUse = (x: unknown): x is EmojiUse => {
  if (typeof x !== 'object' || x === null) return false
  const { n, at, last } = x as Record<string, unknown>
  return (
    typeof n === 'number' &&
    Number.isFinite(n) &&
    n > 0 &&
    typeof at === 'number' &&
    Number.isFinite(at) &&
    typeof last === 'string' &&
    last.length > 0 &&
    last.length <= 32
  )
}

export function parseEmojiPrefs(raw: string | null): EmojiPrefs {
  let data: unknown
  try {
    data = raw ? JSON.parse(raw) : null
  } catch {
    return EMPTY_PREFS
  }
  if (typeof data !== 'object' || data === null) return EMPTY_PREFS
  const { v, tone, used } = data as Record<string, unknown>
  if (v !== 1) return EMPTY_PREFS
  const entries =
    typeof used === 'object' && used !== null && !Array.isArray(used)
      ? Object.entries(used).filter(([k, u]) => k.length > 0 && k.length <= 32 && isUse(u))
      : []
  return {
    v: 1,
    tone:
      Number.isInteger(tone) && (tone as number) >= 0 && (tone as number) <= TONES
        ? (tone as number)
        : 0,
    used: Object.fromEntries(entries) as Record<string, EmojiUse>,
  }
}

export const frecency = (u: EmojiUse, now: number) =>
  u.n * Math.pow(0.5, Math.max(0, now - u.at) / HALF_LIFE_MS)

const ranked = (prefs: EmojiPrefs, now: number) =>
  Object.entries(prefs.used).sort(
    ([, a], [, b]) => frecency(b, now) - frecency(a, now) || b.at - a.at
  )

export function noteUse(prefs: EmojiPrefs, base: string, picked: string, now: number): EmojiPrefs {
  const cur = prefs.used[base]
  const used = { ...prefs.used, [base]: { n: (cur?.n ?? 0) + 1, at: now, last: picked } }
  const next = { ...prefs, used }
  if (Object.keys(used).length <= MAX_USED) return next
  const rest = ranked(next, now).filter(([k]) => k !== base)
  return {
    ...prefs,
    used: Object.fromEntries([...rest.slice(0, MAX_USED - 1), [base, used[base]]]),
  }
}

export const setTone = (prefs: EmojiPrefs, tone: number): EmojiPrefs =>
  tone === prefs.tone || !Number.isInteger(tone) || tone < 0 || tone > TONES
    ? prefs
    : { ...prefs, tone }

export const frequent = (prefs: EmojiPrefs, n: number, now: number) =>
  ranked(prefs, now)
    .slice(0, n)
    .map(([base]) => base)

export const boostFor =
  (prefs: EmojiPrefs, now: number): Boost =>
  e => {
    const u = prefs.used[e.emoji]
    return u ? frecency(u, now) : 0
  }

export function topEmojis(n: number, prefs: EmojiPrefs = EMPTY_PREFS, now = Date.now()) {
  const top = ranked(prefs, now).slice(0, n)
  const out = top.map(([, u]) => u.last)
  for (const d of DEFAULT_TOP) {
    if (out.length >= n) break
    if (!prefs.used[d]) out.push(d)
  }
  return out
}

export type GridKey = 'left' | 'right' | 'up' | 'down'

export interface GridPos {
  s: number
  i: number
}

export function gridMove(sizes: number[], cols: number, at: GridPos, key: GridKey): GridPos {
  const prev = (s: number) => {
    for (let k = s - 1; k >= 0; k--) if (sizes[k] > 0) return k
    return -1
  }
  const next = (s: number) => {
    for (let k = s + 1; k < sizes.length; k++) if (sizes[k] > 0) return k
    return -1
  }
  const len = sizes[at.s] ?? 0
  const col = at.i % cols
  const row = Math.floor(at.i / cols)
  const lastRow = Math.floor((len - 1) / cols)
  switch (key) {
    case 'left': {
      if (at.i > 0) return { s: at.s, i: at.i - 1 }
      const p = prev(at.s)
      return p < 0 ? at : { s: p, i: sizes[p] - 1 }
    }
    case 'right': {
      if (at.i < len - 1) return { s: at.s, i: at.i + 1 }
      const n = next(at.s)
      return n < 0 ? at : { s: n, i: 0 }
    }
    case 'up': {
      if (row > 0) return { s: at.s, i: at.i - cols }
      const p = prev(at.s)
      if (p < 0) return at
      const start = Math.floor((sizes[p] - 1) / cols) * cols
      return { s: p, i: Math.min(start + col, sizes[p] - 1) }
    }
    case 'down': {
      if (at.i + cols < len) return { s: at.s, i: at.i + cols }
      if (row < lastRow) return { s: at.s, i: len - 1 }
      const n = next(at.s)
      return n < 0 ? at : { s: n, i: Math.min(col, sizes[n] - 1) }
    }
  }
}

let loading: Promise<Emoji[]> | null = null
let loaded: Emoji[] | null = null

export const emojiData = () => loaded

export function loadEmojiData(): Promise<Emoji[]> {
  loading ??= import('./emoji_data').then(
    m => (loaded = m.buildEmoji()),
    e => {
      loading = null
      throw e
    }
  )
  return loading
}

export const sectionHeight = (count: number, cols: number, cell: number, chrome: number) =>
  chrome + Math.ceil(count / Math.max(1, cols)) * cell
