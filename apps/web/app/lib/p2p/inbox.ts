import { DM_PLACE, type InboxEntry, type InboxPlace, type InboxView } from '../inbox'
import type { InboxFilter } from '../types'
import type { RoomRecord } from './db'
import type { Membership } from './state'
import { LOCAL } from './limits'

// P2P pings for the inbox. The P2P core keeps only counters per conversation and
// channel, so the tab that runs P2P also notes each ping as it arrives in a bounded list in the
// database's meta store. A ping is read once it is marked here (`seen`) or once its conversation
// or channel was read past it (`seq` at or below the read position): the counters stay the truth
// for badges, marking one ping takes one off them and never moves a read position.

export type P2pPingKind = 'mention' | 'reply' | 'reaction' | 'everyone'

export interface PingRec {
  // The event that pinged: a message, or a reaction.
  id: string
  room: string
  // The server channel; null in a direct message.
  ch: string | null
  kind: P2pPingKind
  actor: string
  // When it arrived here (ms) and its arrival number in the room.
  at: number
  seq: number
  emoji: string | null
  // A reaction: the message it is on.
  target: string | null
  seen: boolean
  // On a thread reply (or a reaction to one): the thread's root. Reading the channel leaves it;
  // reading the thread marks it.
  thread?: string | null
}

export const PING_LOG = 'inbox'
export const PINGS_KEPT = LOCAL.inbox.pingsKept
export const PING_KEEP_MS = LOCAL.inbox.pingKeepMs
export const P2P_INBOX = 'p2p'
export const P2P_DM_LABEL = 'P2P direct message'

const KINDS: readonly P2pPingKind[] = ['mention', 'reply', 'reaction', 'everyone']

const text = (x: unknown, max = 200) =>
  typeof x === 'string' && x.length > 0 && x.length <= max ? x : null
const num = (x: unknown) => (Number.isSafeInteger(x) && (x as number) >= 0 ? (x as number) : null)

const recOf = (x: unknown): PingRec | null => {
  if (typeof x !== 'object' || x === null) return null
  const o = x as Record<string, unknown>
  const id = text(o.id)
  const room = text(o.room)
  const actor = text(o.actor)
  const at = num(o.at ?? o.ts)
  const seq = num(o.seq)
  if (!id || !room || !actor || at === null || seq === null) return null
  if (!KINDS.includes(o.kind as P2pPingKind)) return null
  return {
    id,
    room,
    ch: o.ch === null ? null : text(o.ch),
    kind: o.kind as P2pPingKind,
    actor,
    at,
    seq,
    emoji: o.emoji === null ? null : text(o.emoji, 64),
    target: o.target === null ? null : text(o.target),
    seen: o.seen === true,
    thread: typeof o.thread === 'string' ? text(o.thread) : null,
  }
}

// The stored list (`{v: 1, list}`); anything unreadable is left out.
export const parseLog = (x: unknown): PingRec[] => {
  if (typeof x !== 'object' || x === null) return []
  const { v, list } = x as Record<string, unknown>
  if (v !== 1 || !Array.isArray(list)) return []
  const seen = new Set<string>()
  const out: PingRec[] = []
  for (const item of list) {
    const r = recOf(item)
    if (!r || seen.has(r.id)) continue
    seen.add(r.id)
    out.push(r)
  }
  return out
}

export const logValue = (list: PingRec[]) => ({ v: 1, list })

// Newest arrival first; ties by id, so the order is stable.
export const newerFirst = (a: PingRec, b: PingRec) =>
  b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)

// The list with new pings added: one per event, nothing older than PING_KEEP_MS, at most
// PINGS_KEPT (the newest).
export const addPings = (list: PingRec[], add: PingRec[], now: number): PingRec[] => {
  const ids = new Set(list.map(p => p.id))
  const all = [...list]
  for (const p of add)
    if (!ids.has(p.id)) {
      ids.add(p.id)
      all.push(p)
    }
  return all
    .filter(p => now - p.at <= PING_KEEP_MS)
    .sort(newerFirst)
    .slice(0, PINGS_KEPT)
}

export const markSeen = (list: PingRec[], ids: ReadonlySet<string>): PingRec[] =>
  list.map(p => (ids.has(p.id) && !p.seen ? { ...p, seen: true } : p))

// The counter a ping sits in: its conversation, or `{room}/{channel}`.
export const counterKey = (p: Pick<PingRec, 'room' | 'ch'>) =>
  p.ch === null ? p.room : `${p.room}/${p.ch}`

// Read positions by counter, from the stored rooms.
export const readSeqs = (rooms: readonly RoomRecord[]) => {
  const out = new Map<string, number>()
  for (const r of rooms) {
    if (r.kind !== 'server') out.set(r.id, r.readSeq)
    else for (const [ch, c] of Object.entries(r.chans ?? {})) out.set(`${r.id}/${ch}`, c.readSeq)
  }
  return out
}

export const pingUnread = (p: PingRec, readSeq: ReadonlyMap<string, number>) =>
  !p.seen && (!!p.thread || p.seq > (readSeq.get(counterKey(p)) ?? 0))

// What the inbox needs to know of P2P right now.
export interface PingWorld {
  readSeq: ReadonlyMap<string, number>
  // Conversations and the contact each is with.
  dms: ReadonlyMap<string, string>
  contacts: ReadonlySet<string>
  blocked: ReadonlySet<string>
  servers: Readonly<
    Record<
      string,
      { name: string; me: Membership | null; channels: readonly { id: string; name: string }[] }
    >
  >
}

// Pings of places still open to the user: a conversation with a contact who isn't blocked, or a
// channel of a server they are still in. Pings by blocked contacts never show.
export const pingVisible = (p: PingRec, w: PingWorld) => {
  if (w.blocked.has(p.actor)) return false
  if (p.ch === null) {
    const peer = w.dms.get(p.room)
    return peer !== undefined && w.contacts.has(peer) && !w.blocked.has(peer)
  }
  const v = w.servers[p.room]
  return !!v && v.me === 'join' && v.channels.some(c => c.id === p.ch)
}

const FILTER_KINDS: Record<InboxFilter, readonly P2pPingKind[]> = {
  mentions: ['mention', 'everyone'],
  replies: ['reply'],
  reactions: ['reaction'],
  friends: [],
}

// Whether a view lists a ping. P2P DMs are direct messages; a server place (the instance's) has
// no P2P pings.
export const pingInView = (p: PingRec, view: InboxView) =>
  (view.kind === null || FILTER_KINDS[view.kind].includes(p.kind)) &&
  (view.place === null || (view.place === DM_PLACE && p.ch === null))

const cursorOf = (p: PingRec) => `${p.at}:${p.id}`

const parseCursor = (c: string) => {
  const i = c.indexOf(':')
  const at = Number(c.slice(0, i))
  return i > 0 && Number.isSafeInteger(at) ? { at, id: c.slice(i + 1) } : null
}

// `b` comes after `a` in the list (arrived before it, or at the same time with a lower id).
const after = (a: Pick<PingRec, 'at' | 'id'>, b: Pick<PingRec, 'at' | 'id'>) =>
  b.at < a.at || (b.at === a.at && b.id < a.id)

// A page of a list sorted with `newerFirst`, after `cursor`.
export const pagePings = (sorted: PingRec[], cursor: string | null, size: number) => {
  const at = cursor === null ? null : parseCursor(cursor)
  const rest = at ? sorted.filter(p => after(at, p)) : cursor === null ? sorted : []
  const page = rest.slice(0, size)
  const last = page[page.length - 1]
  return { page, next: rest.length > size && last ? cursorOf(last) : null }
}

// "Mark all as read" goes down from the newest ping shown: pings that arrived after it stay
// unread, whatever time their message carries.
export const markAllTargets = (
  list: PingRec[],
  view: InboxView,
  shown: PingRec[],
  readSeq: ReadonlyMap<string, number>
): PingRec[] => {
  if (!shown.length) return []
  const top = [...shown].sort(newerFirst)[0]
  return list.filter(
    p => pingUnread(p, readSeq) && pingInView(p, view) && (p.id === top.id || after(top, p))
  )
}

// How many of the pings sit in each counter (a thread's count in its channel's).
export const byCounter = (list: readonly PingRec[]): Map<string, number> => {
  const out = new Map<string, number>()
  for (const p of list) out.set(counterKey(p), (out.get(counterKey(p)) ?? 0) + 1)
  return out
}

// The same per thread too (`{room}/{channel}#{root}`), for taking marked pings off the counters.
export const byThreadCounter = (list: readonly PingRec[]): Map<string, number> => {
  const out = new Map<string, number>()
  for (const p of list) {
    const k = p.thread ? `${counterKey(p)}#${p.thread}` : counterKey(p)
    out.set(k, (out.get(k) ?? 0) + 1)
  }
  return out
}

export const pingPlace = (p: PingRec, w: PingWorld): InboxPlace => {
  if (p.ch === null) return { kind: 'other', label: P2P_DM_LABEL }
  const v = w.servers[p.room]
  return {
    kind: 'channel',
    server: p.room,
    serverName: v?.name ?? 'P2P server',
    channel: v?.channels.find(c => c.id === p.ch)?.name ?? '',
    thread: !!p.thread,
  }
}

export interface PingText {
  content: string | null
  media: string | null
  mediaSpoiler: boolean
}

export const pingEntry = (
  p: PingRec,
  w: PingWorld,
  actorName: string,
  shown: PingText
): InboxEntry => ({
  key: `${P2P_INBOX}:${p.id}`,
  adapter: P2P_INBOX,
  id: p.seq,
  created_at: Math.floor(p.at / 1000),
  unread: pingUnread(p, w.readSeq),
  kind: p.kind,
  actor: {
    username: p.actor,
    display_name: actorName,
    avatar_kind: 'identicon',
    avatar_color: null,
  },
  emoji: p.emoji,
  role: null,
  where: pingPlace(p, w),
  content: shown.content,
  media: shown.media,
  mediaSpoiler: shown.mediaSpoiler,
  order: p.at,
  raw: p,
})
