import type { LogEvent } from '../../audit_format'
import { serverWire, type EventRecord } from '../db'
import type { ServerCtx } from './context'

// The moderation log of a server: its admitted ACL events that moderate or change the server,
// newest first, a page at a time. Every member reads it.

export const LOG_PAGE = 50

// What the log lists: invites, removals and bans, roles and who holds them, channels and their
// rules, categories, settings, invite codes and moves to a new copy. A member's own joining,
// leaving, profile and devices are left out.
const LOGGED = new Set([
  'add',
  'uninvite',
  'kick',
  'ban',
  'unban',
  'role_create',
  'role_move',
  'role_bits',
  'role_del',
  'role_meta',
  'assign',
  'revoke',
  'channel',
  'chperm',
  'category',
  'chcat',
  'settings',
  'code',
  'code_revoke',
  'upgrade',
  'migrate',
])

export interface LogPage {
  events: LogEvent[]
  // Where the next page starts (pass it as `before`), or null at the oldest.
  next: number | null
  // The last name of every role the room made, deleted ones included.
  roleNames: Record<string, string>
}

const contentOf = (r: EventRecord) => {
  const c = serverWire(r).c
  return c && typeof c === 'object' ? c : {}
}

// The room's role events in admission order: where each role stood after each of them, and
// each role's last name.
async function roleHistory(cx: ServerCtx, room: string) {
  const of = (type: string) =>
    cx.db.getAllFromIndex(
      'events',
      'room_type_sort',
      IDBKeyRange.bound([room, type, ''], [room, type, '￿'])
    )
  const recs = (await Promise.all(['role_create', 'role_move', 'role_del', 'role_meta'].map(of)))
    .flat()
    .filter((r): r is EventRecord & { aseq: number } => r.aseq !== undefined)
    .sort((x, y) => x.aseq - y.aseq)
  const pos = new Map<string, number>()
  const names: Record<string, string> = {}
  const orders = new Map<string, { before: string[]; after: string[] }>()
  const order = () =>
    [...pos].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? 1 : -1)).map(([id]) => id)
  for (const r of recs) {
    const c = contentOf(r)
    const role = typeof c.role === 'string' ? c.role : null
    const at = typeof c.pos === 'number' ? c.pos : null
    if (r.type === 'role_create') {
      if (at !== null) pos.set(r.id, at)
      if (typeof c.name === 'string') names[r.id] = c.name
    } else if (r.type === 'role_meta') {
      if (role && typeof c.name === 'string') names[role] = c.name
    } else if (r.type === 'role_del') {
      if (role) pos.delete(role)
    } else if (role && at !== null && pos.has(role)) {
      const before = order()
      pos.set(role, at)
      orders.set(r.id, { before, after: order() })
    }
  }
  return { names, orders }
}

// A page of the log: the events admitted before admission number `before` (null: the newest).
export async function moderationLog(
  cx: ServerCtx,
  room: string,
  before: number | null,
  limit = LOG_PAGE
): Promise<LogPage> {
  const range = IDBKeyRange.bound(
    [room, -Infinity],
    [room, before ?? Infinity],
    false,
    before !== null
  )
  const events: LogEvent[] = []
  let next: number | null = null
  let cursor = await cx.db.transaction('events').store.index('room_aseq').openCursor(range, 'prev')
  while (cursor) {
    const r = cursor.value
    if (LOGGED.has(r.type) && r.aseq !== undefined) {
      if (events.length === limit) {
        next = events[events.length - 1].aseq
        break
      }
      events.push({ id: r.id, t: r.type, a: r.sender, at: r.effTs, c: contentOf(r), aseq: r.aseq })
    }
    cursor = await cursor.continue()
  }
  const { names, orders } = await roleHistory(cx, room)
  const counts = events.length
    ? await cx.host.counted(
        room,
        events.map(e => e.id)
      )
    : []
  return {
    events: events.map((e, i) => {
      const order = orders.get(e.id)
      return { ...e, ...(order ? { order } : {}), ...(counts[i] === false ? { undone: true } : {}) }
    }),
    next,
    roleNames: names,
  }
}
