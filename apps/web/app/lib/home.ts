import type { View } from './view'

// Home's local state per account: the places visited last ("Jump back in") and the tips and
// notices the user dismissed. Stored as `{v: 1, recents, tips}`; anything unreadable gives the
// defaults.

export type Recent =
  | {
      kind: 'channel'
      server: string
      channelId: number
      // names seen on the last visit, shown until the server's details are loaded
      channel: string | null
      serverName: string | null
      at: number
    }
  | { kind: 'dm'; dmId: number; at: number }
  // A P2P conversation (`ch` null) or P2P server channel; names come from P2P when shown.
  | { kind: 'p2p'; room: string; ch: string | null; at: number }

export interface HomePrefs {
  v: 1
  recents: Recent[]
  tips: string[]
}

export const RECENTS_MAX = 12
export const RECENTS_SHOWN = 6
export const PINNED_SHOWN = 10
export const INBOX_SHOWN = 5
const NAME_MAX = 100
const TIPS_MAX = 50

export const EMPTY_HOME: HomePrefs = { v: 1, recents: [], tips: [] }

export const homeKey = (username: string) => `rchat_home:${username}`

const isId = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) > 0

const nameOf = (x: unknown) => (typeof x === 'string' && x ? x.slice(0, NAME_MAX) : null)

export const recentKey = (r: Recent | View) =>
  r.kind === 'channel'
    ? `c${r.channelId}`
    : r.kind === 'dm'
      ? `d${r.dmId}`
      : `p${r.ch === null ? r.room : `${r.room}/${r.ch}`}`

const P2P_ID_MAX = 200

const p2pId = (x: unknown) =>
  typeof x === 'string' && x && x.length <= P2P_ID_MAX && !x.includes('/') ? x : null

const recentOf = (x: unknown): Recent | null => {
  if (typeof x !== 'object' || x === null) return null
  const o = x as Record<string, unknown>
  const at = typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : 0
  if (o.kind === 'dm' && isId(o.dmId)) return { kind: 'dm', dmId: o.dmId, at }
  if (o.kind === 'p2p' && p2pId(o.room) && (o.ch === null || p2pId(o.ch)))
    return { kind: 'p2p', room: o.room as string, ch: o.ch === null ? null : (o.ch as string), at }
  if (o.kind === 'channel' && isId(o.channelId) && typeof o.server === 'string' && o.server)
    return {
      kind: 'channel',
      server: o.server,
      channelId: o.channelId,
      channel: nameOf(o.channel),
      serverName: nameOf(o.serverName),
      at,
    }
  return null
}

export const parseHome = (raw: string | null): HomePrefs => {
  try {
    const data = raw ? (JSON.parse(raw) as unknown) : null
    if (typeof data !== 'object' || data === null) return EMPTY_HOME
    const { v, recents, tips } = data as Record<string, unknown>
    if (v !== 1) return EMPTY_HOME
    const seen = new Set<string>()
    const list: Recent[] = []
    for (const x of Array.isArray(recents) ? recents : []) {
      const r = recentOf(x)
      if (!r || seen.has(recentKey(r))) continue
      seen.add(recentKey(r))
      list.push(r)
      if (list.length >= RECENTS_MAX) break
    }
    const dismissed = Array.isArray(tips)
      ? [...new Set(tips.filter((t): t is string => typeof t === 'string' && t.length <= 40))]
      : []
    return { v: 1, recents: list, tips: dismissed.slice(0, TIPS_MAX) }
  } catch {
    return EMPTY_HOME
  }
}

export const homeValue = (prefs: HomePrefs) => JSON.stringify(prefs)

// Puts a visit first. Names stay from earlier visits when this one has none yet.
export const pushRecent = (
  prefs: HomePrefs,
  view: View,
  names: { channel: string | null; serverName: string | null },
  at: number
): HomePrefs => {
  const key = recentKey(view)
  const before = prefs.recents.find(r => recentKey(r) === key)
  const entry: Recent =
    view.kind === 'dm'
      ? { kind: 'dm', dmId: view.dmId, at }
      : {
          kind: 'channel',
          server: view.server,
          channelId: view.channelId,
          channel:
            nameOf(names.channel) ?? (before?.kind === 'channel' ? before.channel : null) ?? null,
          serverName:
            nameOf(names.serverName) ??
            (before?.kind === 'channel' ? before.serverName : null) ??
            null,
          at,
        }
  const rest = prefs.recents.filter(r => recentKey(r) !== key)
  return { ...prefs, recents: [entry, ...rest].slice(0, RECENTS_MAX) }
}

// Puts a P2P visit first.
export const pushP2pRecent = (
  prefs: HomePrefs,
  room: string,
  ch: string | null,
  at: number
): HomePrefs => {
  const entry: Recent = { kind: 'p2p', room, ch, at }
  const key = recentKey(entry)
  const rest = prefs.recents.filter(r => recentKey(r) !== key)
  return { ...prefs, recents: [entry, ...rest].slice(0, RECENTS_MAX) }
}

export const dropRecent = (prefs: HomePrefs, key: string): HomePrefs =>
  prefs.recents.some(r => recentKey(r) === key)
    ? { ...prefs, recents: prefs.recents.filter(r => recentKey(r) !== key) }
    : prefs

export const dismissTip = (prefs: HomePrefs, id: string): HomePrefs =>
  prefs.tips.includes(id) ? prefs : { ...prefs, tips: [...prefs.tips, id].slice(-TIPS_MAX) }

export interface Tip {
  id: string
  text: string
}

export const TIPS: Tip[] = [
  { id: 'pin_dm', text: 'Right-click or long-press a DM and choose Pin DM to keep it here.' },
  { id: 'mark_read', text: 'Right-click or long-press a server to mark it as read or mute it.' },
  { id: 'inbox', text: 'The bell at the top opens your mentions, replies and reactions.' },
  { id: 'folders', text: 'Drag one server onto another to make a folder.' },
  { id: 'friends', text: 'Add friends to see when they are online.' },
]

export const TIPS_SHOWN = 2

export const shownTips = (prefs: HomePrefs, max = TIPS_SHOWN) =>
  TIPS.filter(t => !prefs.tips.includes(t.id)).slice(0, max)

// Notices outside Home that stay closed once closed, kept with the tips.
export const P2P_SERVER_INTRO = 'p2p_server_intro'
export const P2P_DM_INTRO = 'p2p_dm_intro'
// The composer's line that the instance filters some words.
export const SITE_FILTER_NOTE = 'site_filter_note'

// Where older versions kept them, as '1'. Still read, never written.
export const legacyIntroKeys = (username: string): [string, string][] => [
  [P2P_SERVER_INTRO, `rchat_p2p_server_intro:${username}`],
  [P2P_DM_INTRO, `rchat_p2p_intro:${username}`],
]

// Shown only once Home's prefs belong to the signed-in P2P account, until that account closes it.
export const noticeOpen = (
  owner: string | null,
  account: string | null,
  prefs: HomePrefs,
  id: string
) => owner !== null && owner === account && !prefs.tips.includes(id)

export const greeting = (hour: number) =>
  hour >= 5 && hour < 12
    ? 'Good morning'
    : hour >= 12 && hour < 18
      ? 'Good afternoon'
      : 'Good evening'

// Where the user can still go: their servers and DMs, and the channels of loaded servers.
export interface RecentPlaces {
  servers: Set<string>
  serversMore: boolean
  dmIds: Set<number>
  // channel ids of servers whose details are loaded
  channels: Record<string, number[]>
  // keys of P2P places still open: conversations with contacts, channels of joined servers
  p2p?: ReadonlySet<string>
}

// Whether a recent place is still open to the user: a DM they have, or a channel of a server they
// joined that still lists it (once the server's details are loaded).
export const recentShown = (r: Recent, at: RecentPlaces) => {
  if (r.kind === 'dm') return at.dmIds.has(r.dmId)
  if (r.kind === 'p2p') return at.p2p?.has(recentKey(r)) ?? false
  if (!at.servers.has(r.server) && !(at.serversMore && !!r.channel)) return false
  const loaded = at.channels[r.server]
  return !loaded || loaded.includes(r.channelId)
}

// A new account: nothing visited yet, no DMs with others and no server beyond the default one.
export const isNewAccount = (recents: number, otherDms: number, servers: number) =>
  recents === 0 && otherDms === 0 && servers <= 1

export interface UnreadRow {
  name: string
  pings: number
  channels: number
}

// Unread channels per server, from the read positions; `shown` drops muted ones.
export const unreadChannels = (
  reads: Record<string, { lastRead: number; latest: number; server?: string }>,
  shown: (scope: string) => boolean
): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const [scope, r] of Object.entries(reads))
    if (scope[0] === 'c' && r.server && r.latest > r.lastRead && shown(scope))
      out[r.server] = (out[r.server] ?? 0) + 1
  return out
}

// Servers with something unread, the ones that ping you first, otherwise in the given order.
export const unreadRows = (rows: UnreadRow[]): UnreadRow[] =>
  rows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.pings > 0 || r.channels > 0)
    .sort((a, b) => b.r.pings - a.r.pings || a.i - b.i)
    .map(({ r }) => r)
