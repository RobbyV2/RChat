// Moves local config between devices and accounts: an export document, its string form
// (`rc1.` + base64url of deflate-raw JSON) and share links (`/config/{id}/`).
//
// Document: `{ v: 1, theme?, streamer?, appearOffline?, layout?, notify?, emoji?, calls?,
// typing?, profanity?, spoilers?, relays?, p2p? }`. All
// sections are optional and decoded separately. Unknown sections and fields are dropped, so older
// readers skip new sections. `v` changes only for an incompatible change. Only listed store
// fields are copied, so tokens, grants, drafts, passwords and relay credentials never get in.
// P2P state gets in only as the passphrase-encrypted `p2p` section, which the string and the
// file carry and share links never do.
import { fromBase64Url, isRecord, toBase64Url } from './bytes'
import type { Theme } from './types'
import {
  collapsedCount,
  collapsedOf,
  type Collapsed,
  cleanFolderName,
  parseLayout,
  type Folder,
  type RailEntry,
  type SelfPin,
} from './nav_layout'
import { notifyValue, parseNotify, type NotifyPrefs } from './notify'
import {
  MAX_USED,
  TONES,
  frecency,
  looksLikeEmoji,
  parseEmojiPrefs,
  type EmojiPrefs,
} from './emoji'
import { ROUTE_LABEL, isRoute, type CallRoute } from './call_choice'
import {
  cleanRelaysSection,
  exportRelays,
  relaysText,
  type RelayPrefs,
  type RelaysSection,
} from './relays'
import { shareOrigin } from './instances'
import { isShowSpoilers, type ShowSpoilers } from './spoilers'
import { cleanP2pSection, type P2pSection } from './p2p/section'

const CONFIG_VERSION = 1
export const PREFIX = 'rc1.'
// Share links hold at most this many bytes. String and file exports have no limit.
export const LINK_MAX = 16 * 1024
// Sanity caps for pasted strings and what they inflate to.
export const TEXT_MAX = 2 * 1024 * 1024
export const JSON_MAX = 4 * 1024 * 1024
// The same for `.rchat` files, which may hold P2P history. Larger strings than this don't fit
// in a browser's memory reliably.
export const FILE_MAX = 256 * 1024 * 1024
export const FILE_JSON_MAX = 320 * 1024 * 1024
export const FILE_EXT = '.rchat'

// The first line of a `.rchat` file (the config text) and what follows it (the P2P files, when
// there are any), read in pieces that are each searched once. Null when the line runs past
// `max`.
export const splitFile = async (
  file: Blob,
  max = FILE_MAX
): Promise<{ text: string; rest: Blob } | null> => {
  const reader = file.stream().getReader()
  const parts: Uint8Array[] = []
  let size = 0
  let end = -1
  try {
    while (end < 0) {
      const { done, value } = await reader.read()
      if (done) break
      const nl = value.indexOf(0x0a)
      if (nl >= 0) {
        parts.push(value.subarray(0, nl))
        end = size + nl
      } else parts.push(value)
      size += nl >= 0 ? nl : value.length
      if (size > max) return null
    }
  } finally {
    void reader.cancel().catch(() => {})
  }
  const text = new TextDecoder().decode(await new Blob(parts as BlobPart[]).arrayBuffer())
  return { text, rest: end < 0 ? new Blob([]) : file.slice(end + 1) }
}
const SERVERS_MAX = 1000
const DMS_MAX = 1000
const NAME_MAX = 64
const FOLDER_ID_MAX = 32

export interface ConfigLayout {
  servers: RailEntry[]
  dmOrder: number[]
  dmPinned: number[]
  selfPin: SelfPin
  collapsed?: Collapsed
}

export interface ConfigDoc {
  v: 1
  theme?: Theme
  streamer?: boolean
  appearOffline?: boolean
  layout?: ConfigLayout
  notify?: NotifyPrefs
  emoji?: EmojiPrefs
  calls?: CallRoute
  typing?: boolean
  profanity?: boolean
  spoilers?: ShowSpoilers
  relays?: RelaysSection
  p2p?: P2pSection
}

export type SectionKey =
  | 'theme'
  | 'streamer'
  | 'appearOffline'
  | 'layout'
  | 'notify'
  | 'emoji'
  | 'calls'
  | 'typing'
  | 'profanity'
  | 'spoilers'
  | 'relays'

export interface Section {
  key: SectionKey
  label: string
  // Needs a signed-in account (not a guest) to export or apply.
  account: boolean
  // Applies on a logged-out device right away (the rest waits for a login).
  device: boolean
  // May be put in a share link. New sections that carry anything private set this to false.
  link: boolean
}

export const SECTIONS: Section[] = [
  { key: 'theme', label: 'Theme', account: false, device: true, link: true },
  { key: 'streamer', label: 'Streamer mode', account: false, device: true, link: true },
  { key: 'appearOffline', label: 'Appear offline', account: true, device: false, link: true },
  {
    key: 'layout',
    label: 'Servers, folders, DMs and categories',
    account: false,
    device: false,
    link: true,
  },
  { key: 'notify', label: 'Notification settings', account: false, device: false, link: true },
  { key: 'emoji', label: 'Frequent emoji and skin tone', account: true, device: false, link: true },
  { key: 'calls', label: 'Call connection', account: true, device: false, link: true },
  { key: 'typing', label: 'Typing indicators', account: false, device: false, link: true },
  { key: 'profanity', label: 'Filter profanity', account: false, device: false, link: true },
  { key: 'spoilers', label: 'Show spoilers', account: false, device: false, link: true },
  // Relay URLs and allowed hosts only. Links are stored on the server, so relays stay out.
  { key: 'relays', label: 'Relays', account: true, device: false, link: false },
]

export const sectionOf = (key: SectionKey) => SECTIONS.find(s => s.key === key) as Section

// What the store holds right now; `null` for sections this session doesn't have.
export interface ConfigSource {
  theme: Theme
  streamer: boolean
  appearOffline: boolean | null
  layout: {
    servers: RailEntry[]
    dmOrder: number[]
    dmPinned: number[]
    selfPin: SelfPin
    collapsed?: Collapsed
  } | null
  notify: NotifyPrefs | null
  emoji: EmojiPrefs | null
  calls: CallRoute | null
  typing: boolean | null
  profanity: boolean | null
  spoilers: ShowSpoilers | null
  relays: RelayPrefs | null
}

const copyEntry = (e: RailEntry): RailEntry =>
  typeof e === 'string' ? e : { id: e.id, name: e.name, servers: [...e.servers], open: e.open }

const pickLayout = (l: NonNullable<ConfigSource['layout']>): ConfigLayout => ({
  servers: l.servers.map(copyEntry),
  dmOrder: [...l.dmOrder],
  dmPinned: [...l.dmPinned],
  selfPin: l.selfPin,
  ...(l.collapsed && collapsedCount(l.collapsed) ? { collapsed: collapsedOf(l.collapsed) } : {}),
})

const pickNotify = (p: NotifyPrefs): NotifyPrefs => JSON.parse(notifyValue(p)) as NotifyPrefs

const pickEmoji = (p: EmojiPrefs): EmojiPrefs => ({
  v: 1,
  tone: p.tone,
  used: Object.fromEntries(
    Object.entries(p.used).map(([k, u]) => [k, { n: u.n, at: u.at, last: u.last }])
  ),
})

export const buildConfig = (src: ConfigSource, include: ReadonlySet<SectionKey>): ConfigDoc => {
  const doc: ConfigDoc = { v: CONFIG_VERSION }
  const on = (k: SectionKey) => include.has(k)
  if (on('theme')) doc.theme = src.theme
  if (on('streamer')) doc.streamer = src.streamer
  if (on('appearOffline') && src.appearOffline !== null) doc.appearOffline = src.appearOffline
  if (on('layout') && src.layout) doc.layout = pickLayout(src.layout)
  if (on('notify') && src.notify) doc.notify = pickNotify(src.notify)
  if (on('emoji') && src.emoji) doc.emoji = pickEmoji(src.emoji)
  if (on('calls') && src.calls) doc.calls = src.calls
  if (on('typing') && src.typing !== null) doc.typing = src.typing
  if (on('profanity') && src.profanity !== null) doc.profanity = src.profanity
  if (on('spoilers') && src.spoilers !== null) doc.spoilers = src.spoilers
  if (on('relays') && src.relays) doc.relays = exportRelays(src.relays)
  return doc
}

// Sections a share link may carry: never `p2p`, which isn't one of SECTIONS.
export const linkDoc = (doc: ConfigDoc): ConfigDoc => {
  const out: ConfigDoc = { v: doc.v }
  for (const s of SECTIONS)
    if (s.link && doc[s.key] !== undefined) Object.assign(out, { [s.key]: doc[s.key] })
  return out
}

export const presentSections = (doc: ConfigDoc): SectionKey[] =>
  SECTIONS.filter(s => doc[s.key] !== undefined).map(s => s.key)

const validName = (n: string) => n.length > 0 && n.length <= NAME_MAX

const cleanLayout = (x: unknown): ConfigLayout | undefined => {
  if (!isRecord(x)) return undefined
  const { servers, dmOrder, dmPinned, selfPin, collapsed } = x
  const parsed = parseLayout(
    JSON.stringify({ v: 2, servers, dmOrder, dmPinned, selfPin, collapsed })
  )
  let budget = SERVERS_MAX
  const entries: RailEntry[] = []
  for (const e of parsed.servers) {
    if (budget <= 0) break
    if (typeof e === 'string') {
      if (!validName(e)) continue
      entries.push(e)
      budget -= 1
      continue
    }
    const names = e.servers.filter(validName).slice(0, budget)
    budget -= names.length
    const folder: Folder = {
      id: e.id,
      name: e.name === null ? null : cleanFolderName(e.name),
      servers: names,
      open: e.open,
    }
    if (names.length >= 2 && e.id.length <= FOLDER_ID_MAX) entries.push(folder)
    else entries.push(...names)
  }
  return {
    servers: entries,
    dmOrder: parsed.dmOrder.slice(0, DMS_MAX),
    dmPinned: parsed.dmPinned.slice(0, DMS_MAX),
    selfPin: parsed.selfPin,
    ...(collapsedCount(parsed.collapsed)
      ? {
          collapsed: Object.fromEntries(
            Object.entries(parsed.collapsed).filter(([name]) => validName(name))
          ),
        }
      : {}),
  }
}

const cleanNotify = (x: unknown, now: number): NotifyPrefs | undefined =>
  isRecord(x) ? parseNotify(JSON.stringify({ ...x, v: 1 }), now) : undefined

const cleanEmoji = (x: unknown, now: number): EmojiPrefs | undefined => {
  if (!isRecord(x)) return undefined
  const parsed = parseEmojiPrefs(JSON.stringify({ ...x, v: 1 }))
  const kept = Object.entries(parsed.used)
    .filter(([k, u]) => looksLikeEmoji(k) && looksLikeEmoji(u.last))
    .map(([k, u]) => [k, { n: Math.min(u.n, 1e6), at: Math.min(u.at, now), last: u.last }] as const)
    .sort(([, a], [, b]) => frecency(b, now) - frecency(a, now) || b.at - a.at)
    .slice(0, MAX_USED)
  return {
    v: 1,
    tone: Math.min(Math.max(parsed.tone, 0), TONES),
    used: Object.fromEntries(kept),
  }
}

export type Decoded = { ok: true; doc: ConfigDoc } | { ok: false; error: string }

export const DAMAGED = 'This config string is damaged or incomplete'
export const NEWER = 'This config is from a newer version. Update and try again'
export const NOT_CONFIG = 'Not a config string'

// Validates and clamps every field; unknown sections and fields are dropped.
export const sanitizeConfig = (data: unknown, now = Date.now()): Decoded => {
  if (!isRecord(data)) return { ok: false, error: DAMAGED }
  const {
    v,
    theme,
    streamer,
    appearOffline,
    layout,
    notify,
    emoji,
    calls,
    typing,
    profanity,
    spoilers,
    relays,
    p2p,
  } = data
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) return { ok: false, error: DAMAGED }
  if (v > CONFIG_VERSION) return { ok: false, error: NEWER }
  const doc: ConfigDoc = { v: 1 }
  if (theme === 'dark' || theme === 'light') doc.theme = theme
  if (typeof streamer === 'boolean') doc.streamer = streamer
  if (typeof appearOffline === 'boolean') doc.appearOffline = appearOffline
  const l = cleanLayout(layout)
  if (l) doc.layout = l
  const n = cleanNotify(notify, now)
  if (n) doc.notify = n
  const e = cleanEmoji(emoji, now)
  if (e) doc.emoji = e
  if (isRoute(calls)) doc.calls = calls
  if (typeof typing === 'boolean') doc.typing = typing
  if (typeof profanity === 'boolean') doc.profanity = profanity
  if (isShowSpoilers(spoilers)) doc.spoilers = spoilers
  const r = cleanRelaysSection(relays)
  if (r) doc.relays = r
  const p = cleanP2pSection(p2p)
  if (p) doc.p2p = p
  return { ok: true, doc }
}

const readBase64Url = (text: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) return null
  try {
    return fromBase64Url(text)
  } catch {
    return null
  }
}

const pipe = (bytes: Uint8Array, stream: CompressionStream | DecompressionStream) =>
  new Blob([bytes as BlobPart]).stream().pipeThrough(stream)

// Inflates at most `max` bytes, so a tiny string can't expand into a huge one.
const inflate = async (bytes: Uint8Array, max: number): Promise<Uint8Array | null> => {
  const reader = pipe(bytes, new DecompressionStream('deflate-raw')).getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > max) {
        void reader.cancel().catch(() => {})
        return null
      }
      chunks.push(value)
    }
  } catch {
    return null
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

export const encodeConfig = async (doc: ConfigDoc): Promise<string> => {
  const json = new TextEncoder().encode(JSON.stringify(doc))
  const packed = new Uint8Array(
    await new Response(pipe(json, new CompressionStream('deflate-raw'))).arrayBuffer()
  )
  return PREFIX + toBase64Url(packed)
}

export interface DecodeLimits {
  text: number
  json: number
}

export const FILE_LIMITS: DecodeLimits = { text: FILE_MAX, json: FILE_JSON_MAX }

export const decodeConfig = async (
  text: string,
  now = Date.now(),
  limits: DecodeLimits = { text: TEXT_MAX, json: JSON_MAX }
): Promise<Decoded> => {
  const trimmed = text.replace(/\s+/g, '')
  if (!trimmed.startsWith(PREFIX)) return { ok: false, error: NOT_CONFIG }
  if (trimmed.length > limits.text) return { ok: false, error: DAMAGED }
  const bytes = readBase64Url(trimmed.slice(PREFIX.length))
  if (!bytes) return { ok: false, error: DAMAGED }
  const raw = await inflate(bytes, limits.json)
  if (!raw) return { ok: false, error: DAMAGED }
  let data: unknown
  try {
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))
  } catch {
    return { ok: false, error: DAMAGED }
  }
  return sanitizeConfig(data, now)
}

// A config from a share link: only the sections a link may carry, whatever the blob holds.
export const decodeLink = async (blob: string, now = Date.now()): Promise<Decoded> => {
  const decoded = await decodeConfig(blob, now)
  return decoded.ok ? { ok: true, doc: linkDoc(decoded.doc) } : decoded
}

// Link ids are 12 base62 characters.
const LINK_ID = /^[A-Za-z0-9]{12}$/

export const configPath = (id: string) => `/config/${id}/`

export const configUrl = (id: string, origin = shareOrigin()) => `${origin}${configPath(id)}`

export const parseConfigPath = (pathname: string): string | null => {
  const m = pathname.match(/^\/config\/([^/]+)\/?$/)
  return m && LINK_ID.test(m[1]) ? m[1] : null
}

// A pasted share link of this site, or null.
export const parseConfigLink = (text: string, origin: string): string | null => {
  let url: URL
  try {
    url = new URL(text.trim())
  } catch {
    return null
  }
  return url.origin === origin ? parseConfigPath(url.pathname) : null
}

export const EXPIRY_CHOICES: { label: string; seconds: number }[] = [
  { label: '10 minutes', seconds: 600 },
  { label: '1 hour', seconds: 3600 },
  { label: '1 day', seconds: 86400 },
  { label: '7 days', seconds: 7 * 86400 },
  { label: '30 days', seconds: 30 * 86400 },
]

// Preview of an import: one row per section in the document.
export interface Change {
  key: SectionKey
  label: string
  // Null when this session has no value for the section (logged out, or a guest).
  now: string | null
  next: string
  same: boolean
}

const onOff = (b: boolean) => (b ? 'On' : 'Off')

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const layoutText = (l: ConfigLayout) => {
  const folders = l.servers.filter(e => typeof e !== 'string').length
  const servers = l.servers.reduce((n, e) => n + (typeof e === 'string' ? 1 : e.servers.length), 0)
  return [
    servers ? plural(servers, 'server') : 'Default order',
    ...(folders ? [plural(folders, 'folder')] : []),
    plural(l.dmPinned.length, 'pinned DM'),
    ...(l.collapsed && collapsedCount(l.collapsed)
      ? [plural(collapsedCount(l.collapsed), 'collapsed category', 'collapsed categories')]
      : []),
  ].join(', ')
}

const ruleCount = (p: NotifyPrefs) =>
  Object.keys(p.servers).length + Object.keys(p.channels).length + Object.keys(p.dms).length

const notifyText = (p: NotifyPrefs) =>
  `${plural(ruleCount(p), 'custom setting')}${p.desktop ? ', desktop alerts on' : ''}`

const emojiText = (p: EmojiPrefs) =>
  `${plural(Object.keys(p.used).length, 'frequent emoji', 'frequent emoji')}, ${
    p.tone ? `skin tone ${p.tone}` : 'default skin tone'
  }`

const canon = (x: unknown): string =>
  JSON.stringify(x, (_, v: unknown) =>
    isRecord(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v
  )

export const describeChanges = (doc: ConfigDoc, src: ConfigSource): Change[] => {
  const mine = buildConfig(src, new Set(SECTIONS.map(s => s.key)))
  const text = (key: SectionKey, d: ConfigDoc): string => {
    switch (key) {
      case 'theme':
        return d.theme === undefined ? 'Not set' : d.theme === 'light' ? 'Light' : 'Dark'
      case 'streamer':
        return d.streamer === undefined ? 'Not set' : onOff(d.streamer)
      case 'appearOffline':
        return d.appearOffline === undefined ? 'Needs an account' : onOff(d.appearOffline)
      case 'layout':
        return d.layout ? layoutText(d.layout) : 'Not set'
      case 'notify':
        return d.notify ? notifyText(d.notify) : 'Not set'
      case 'emoji':
        return d.emoji ? emojiText(d.emoji) : 'Needs an account'
      case 'calls':
        return d.calls ? ROUTE_LABEL[d.calls] : 'Needs an account'
      case 'typing':
        return d.typing === undefined ? 'Not set' : onOff(d.typing)
      case 'profanity':
        return d.profanity === undefined ? 'Not set' : onOff(d.profanity)
      case 'spoilers':
        return d.spoilers === undefined
          ? 'Not set'
          : d.spoilers === 'always'
            ? 'Always'
            : 'On click'
      case 'relays':
        return d.relays ? relaysText(d.relays) : 'Needs an account'
    }
  }
  return presentSections(doc).map(key => ({
    key,
    label: sectionOf(key).label,
    now: mine[key] === undefined ? null : text(key, mine),
    next: text(key, doc),
    same: canon(doc[key]) === canon(mine[key]),
  }))
}

// A config opened from a link before login. The sections to apply wait in sessionStorage for at
// most 30 minutes. The next login applies them once.
const STASH = 'rchat_config_stash'
export const STASH_MS = 30 * 60 * 1000

interface SessionLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const session = (): SessionLike | null => {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

export const stashConfig = (
  doc: ConfigDoc,
  keys: SectionKey[],
  store = session(),
  now = Date.now()
) => store?.setItem(STASH, JSON.stringify({ at: now, doc, keys }))

export const takeStashedConfig = (
  store = session(),
  now = Date.now()
): { doc: ConfigDoc; keys: SectionKey[] } | null => {
  const raw = store?.getItem(STASH) ?? null
  if (raw === null) return null
  store?.removeItem(STASH)
  try {
    const saved = JSON.parse(raw) as { at?: unknown; doc?: unknown; keys?: unknown }
    if (typeof saved.at !== 'number' || saved.at > now || now - saved.at >= STASH_MS) return null
    const decoded = sanitizeConfig(saved.doc, now)
    if (!decoded.ok || !Array.isArray(saved.keys)) return null
    const known = new Set<unknown>(SECTIONS.map(s => s.key))
    const keys = saved.keys.filter((k): k is SectionKey => known.has(k))
    return { doc: decoded.doc, keys }
  } catch {
    return null
  }
}

export const hasStashedConfig = (store = session()) => (store?.getItem(STASH) ?? null) !== null
