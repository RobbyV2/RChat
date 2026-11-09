import { create } from 'zustand'
import type { LucideIcon } from 'lucide-react'
import { fuzzy } from './fuzzy'

// The command palette registers its opener here; Home and the mobile headers offer it once it did.
interface PaletteState {
  open: (() => void) | null
}

export const usePalette = create<PaletteState>(() => ({ open: null }))

export const registerPalette = (open: (() => void) | null) => usePalette.setState({ open })

export const paletteShortcut = (mac: boolean) => (mac ? '⌘K' : 'Ctrl+K')

export const isMac = () =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '')

// Ctrl/Cmd+K, the palette toggle. No text box uses it for anything else.
export const paletteKey = (
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>
) => (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k'

// What the text typed so far asks for. A leading prefix narrows the list.
export type PaletteMode = 'all' | 'channels' | 'people' | 'commands' | 'api' | 'help'

export const PREFIXES: { prefix: string; mode: PaletteMode; label: string }[] = [
  { prefix: '#', mode: 'channels', label: 'Channels' },
  { prefix: '@', mode: 'people', label: 'People' },
  { prefix: '>', mode: 'commands', label: 'Commands' },
  { prefix: '/', mode: 'api', label: 'API' },
  { prefix: '?', mode: 'help', label: 'Help' },
]

// Guests have no API console (its document needs an account), so no `/` chip or help row.
export const prefixesFor = (guest: boolean) =>
  guest ? PREFIXES.filter(p => p.mode !== 'api') : PREFIXES

export const parseQuery = (text: string): { mode: PaletteMode; q: string } => {
  const t = text.trimStart()
  const hit = PREFIXES.find(p => t.startsWith(p.prefix))
  return hit ? { mode: hit.mode, q: t.slice(1).trim() } : { mode: 'all', q: t.trim() }
}

// A command's argument: free text (checked by `check`) or a pick from `choices`.
export interface ArgChoice {
  value: string
  label: string
  subtitle?: string
}

export interface ArgSpec {
  placeholder: string
  // An error text, or null when the text can be used.
  check?: (text: string) => string | null
  choices?: ArgChoice[]
}

export type PaletteGroup =
  | 'selection'
  | 'recent'
  | 'navigation'
  | 'people'
  | 'commands'
  | 'friends'
  | 'settings'
  | 'messages'
  | 'api'
  | 'help'

export const GROUP_LABELS: Record<PaletteGroup, string> = {
  selection: 'Selected messages',
  recent: 'Recent',
  navigation: 'Go to',
  people: 'People',
  commands: 'Commands',
  friends: 'Friends',
  settings: 'Settings',
  messages: 'Messages',
  api: 'API',
  help: 'Help',
}

// One row of the palette. `id` is stable across openings (it keys the usage counts).
export interface PaletteItem {
  id: string
  // The registered action that made this row.
  action?: string
  title: string
  subtitle?: string
  group: PaletteGroup
  icon?: LucideIcon
  keywords?: string[]
  // Other names matched as strongly as the title.
  aliases?: string[]
  danger?: boolean
  // The title (or the subtitle) is a name: blurred in streamer mode.
  name?: boolean
  subtitleName?: boolean
  // Your own text (a server you created, your notes): never masked for you.
  own?: boolean
  hint?: string
  // Running it changes what the palette shows instead of closing it.
  keepOpen?: boolean
  arg?: ArgSpec
  // `arg` is the text or choice value when the item has an `arg`.
  run: (arg?: string) => void | Promise<void>
}

// Whether `item` shows text the personal filter masks (its title or subtitle name).
export const hasMasked = (item: PaletteItem | undefined, mask: (text: string) => string) =>
  !!item &&
  !item.own &&
  ((!!item.name && mask(item.title) !== item.title) ||
    (!!item.subtitleName && !!item.subtitle && mask(item.subtitle) !== item.subtitle))

export interface PaletteCommand extends PaletteItem {
  // Also offered when the text starts with this after `/` (for example `/poll`).
  slash?: string
  // Reads the whole typed text as this command with its argument ("add friends alice bob"),
  // or null when the text is something else.
  parse?: (text: string) => string | null
}

// Usage counts per item id, for ranking by frecency.
export interface Usage {
  n: number
  at: number
}

export type UsageMap = Record<string, Usage>

const DAY = 86_400_000

export const frecency = (u: Usage | undefined, now: number) =>
  u ? Math.log2(1 + u.n) * 6 + 14 * Math.pow(0.5, Math.max(0, now - u.at) / (3 * DAY)) : 0

export interface Ranked<T> {
  item: T
  score: number
  hits: number[]
}

// Items matching `q`, best first: the fuzzy score of the title (or, a bit less, of a keyword or
// the subtitle) plus how often and how lately the item was used. An empty query sorts by usage
// and keeps the given order otherwise.
export const rank = <
  T extends Pick<PaletteItem, 'id' | 'title' | 'keywords' | 'subtitle' | 'aliases'>,
>(
  items: readonly T[],
  q: string,
  usage: UsageMap,
  now: number
): Ranked<T>[] => {
  const out: (Ranked<T> & { i: number })[] = []
  items.forEach((item, i) => {
    const used = frecency(Object.hasOwn(usage, item.id) ? usage[item.id] : undefined, now)
    if (!q) {
      out.push({ item, score: used, hits: [], i })
      return
    }
    const title = fuzzy(q, item.title)
    let best = title ? title.score : -Infinity
    for (const a of item.aliases ?? []) {
      const hit = fuzzy(q, a)
      if (hit) best = Math.max(best, hit.score)
    }
    for (const k of [...(item.keywords ?? []), ...(item.subtitle ? [item.subtitle] : [])]) {
      const hit = fuzzy(q, k)
      if (hit) best = Math.max(best, hit.score * 0.7)
    }
    if (best === -Infinity) return
    out.push({ item, score: best + used, hits: title?.hits ?? [], i })
  })
  out.sort((a, b) => b.score - a.score || a.i - b.i)
  return out.map(({ item, score, hits }) => ({ item, score, hits }))
}

// Local state per account (`rchat_palette:{username|guest}`): usage counts and the index mode.
export type IndexMode = 'off' | 'loaded' | 'full'

export interface PalettePrefs {
  v: 1
  used: UsageMap
  index: IndexMode
}

export const USED_MAX = 300

export const EMPTY_PALETTE: PalettePrefs = { v: 1, used: {}, index: 'off' }

export const palettePrefsKey = (username: string | null) => `rchat_palette:${username ?? 'guest'}`

const isMode = (x: unknown): x is IndexMode => x === 'off' || x === 'loaded' || x === 'full'

const capUsage = (used: UsageMap): UsageMap => {
  const entries = Object.entries(used)
  if (entries.length <= USED_MAX) return used
  entries.sort((a, b) => b[1].at - a[1].at)
  return Object.fromEntries(entries.slice(0, USED_MAX))
}

export const parsePalette = (raw: string | null): PalettePrefs => {
  try {
    const data = raw ? (JSON.parse(raw) as unknown) : null
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return EMPTY_PALETTE
    const { v, used, index } = data as Record<string, unknown>
    if (v !== 1) return EMPTY_PALETTE
    const out: UsageMap = {}
    if (typeof used === 'object' && used !== null && !Array.isArray(used)) {
      for (const [id, u] of Object.entries(used)) {
        if (typeof id !== 'string' || !id || id.length > 200) continue
        const { n, at } = (u ?? {}) as Record<string, unknown>
        if (!Number.isSafeInteger(n) || (n as number) < 1) continue
        if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) continue
        out[id] = { n: Math.min(n as number, 1_000_000), at }
      }
    }
    return { v: 1, used: capUsage(out), index: isMode(index) ? index : 'off' }
  } catch {
    return EMPTY_PALETTE
  }
}

export const paletteValue = (prefs: PalettePrefs) => JSON.stringify(prefs)

export const noteUse = (prefs: PalettePrefs, id: string, now: number): PalettePrefs => {
  const before = Object.hasOwn(prefs.used, id) ? prefs.used[id] : undefined
  return {
    ...prefs,
    used: capUsage({ ...prefs.used, [id]: { n: (before?.n ?? 0) + 1, at: now } }),
  }
}
