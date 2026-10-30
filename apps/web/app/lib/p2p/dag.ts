import {
  authorizeTarget,
  effTsOf,
  isLate,
  LIMITS as EV,
  redacted,
  sortKeyOf,
  targetOf,
  type Wire,
} from './event'
import type { IDBPTransaction } from 'idb'
import type { EventRecord, P2pDatabase, P2pSchema, RoomRecord } from './db'

// The room DAG on disk: heads (events without known children), the children index, parents we
// still miss, and bounded walks over prev links. Inserting an event is one transaction, so the
// heads, counters and redactions never disagree with the events stored.

export const DAG = {
  // Heads kept per room; new events reference at most LIMITS.prev of them.
  heads: 50,
  missing: 500,
  // Events and bytes stored per room and in the whole database on this device.
  roomCap: 100_000,
  totalCap: 500_000,
  roomBytes: 200 * 1024 * 1024,
  totalBytes: 1024 * 1024 * 1024,
  // Steps of any walk over prev links.
  walk: 5000,
}

export type PingKind = 'mention' | 'reply' | 'reaction'

export type Inserted =
  | { status: 'new'; rec: EventRecord; ping: PingKind | null; unread: boolean }
  | { status: 'dup'; rec: EventRecord }
  | { status: 'invalid'; why: 'depth' | 'auth' }
  | { status: 'full'; why: FullWhy }

export type FullWhy = 'events' | 'bytes'

export interface InsertCtx {
  me: string
  peer: string
  roomCap?: number
  totalCap?: number
  roomBytes?: number
  totalBytes?: number
  // Our own new event: its display time doesn't follow parents shown in the future.
  own?: boolean
}

export const blankRoom = (id: string, peer: string, now: number): RoomRecord => ({
  id,
  kind: 'dm',
  peer,
  heads: [],
  missing: [],
  maxDepth: -1,
  count: 0,
  lastSeq: 0,
  readSeq: 0,
  unread: 0,
  pings: 0,
  lastTs: 0,
  full: false,
  created: now,
})

// Totals in the meta store.
export const TOTAL = 'events'
export const TOTAL_BYTES = 'bytes'

export const storedSize = (w: Wire) => utf8Length(JSON.stringify(w))

const utf8Length = (s: string) => new TextEncoder().encode(s).length

// Heads after `id` (at `depth`) joined: its parents stop being heads; it is one unless a child
// arrived before it.
export const nextHeads = (
  heads: RoomRecord['heads'],
  id: string,
  depth: number,
  prev: string[],
  hasChild: boolean
) => {
  const drop = new Set(prev)
  const out = heads.filter(h => !drop.has(h.id) && h.id !== id)
  if (!hasChild) out.push({ id, depth })
  out.sort((a, b) => b.depth - a.depth || (a.id < b.id ? -1 : 1))
  return out.slice(0, DAG.heads)
}

const childRange = (id: string) => IDBKeyRange.bound([id, ''], [id, '￿'])

export type InsertTx = IDBPTransaction<
  P2pSchema,
  ('rooms' | 'events' | 'children' | 'meta')[],
  'readwrite'
>

export const insertEvent = async (
  db: P2pDatabase,
  id: string,
  wire: Wire,
  receivedAt: number,
  ctx: InsertCtx
): Promise<Inserted> => {
  const tx = db.transaction(['rooms', 'events', 'children', 'meta'], 'readwrite')
  tx.done.catch(() => {})
  const res = await insertInto(tx, id, wire, receivedAt, ctx)
  if (res.status === 'invalid') tx.abort()
  else await tx.done
  return res
}

// The same inside a transaction the caller owns (a device import writes many in one). Refusals
// happen before anything is written.
export const insertInto = async (
  tx: InsertTx,
  id: string,
  wire: Wire,
  receivedAt: number,
  ctx: InsertCtx
): Promise<Inserted> => {
  const events = tx.objectStore('events')
  const refuse = (why: 'depth' | 'auth'): Inserted => ({ status: 'invalid', why })
  const ev = wire.ev
  const have = await events.get(id)
  if (have) return { status: 'dup', rec: have }
  const room =
    (await tx.objectStore('rooms').get(ev.room)) ?? blankRoom(ev.room, ctx.peer, receivedAt)
  const total = ((await tx.objectStore('meta').get(TOTAL)) as number | undefined) ?? 0
  const totalBytes = ((await tx.objectStore('meta').get(TOTAL_BYTES)) as number | undefined) ?? 0
  const roomBytes = room.bytes ?? 0
  const size = storedSize(wire)
  const why: FullWhy | null =
    room.count >= (ctx.roomCap ?? DAG.roomCap) || total >= (ctx.totalCap ?? DAG.totalCap)
      ? 'events'
      : roomBytes + size > (ctx.roomBytes ?? DAG.roomBytes) ||
          totalBytes + size > (ctx.totalBytes ?? DAG.totalBytes)
        ? 'bytes'
        : null
  if (why) {
    if (!room.full) await tx.objectStore('rooms').put({ ...room, full: true, fullWhy: why })
    return { status: 'full', why }
  }
  const parents: EventRecord[] = []
  for (const p of ev.prev) {
    const r = await events.get(p)
    if (r && r.room === ev.room) parents.push(r)
  }
  const deepest = Math.max(-1, ...parents.map(r => r.depth))
  // With parents we haven't seen, the depth can't be checked exactly. It must stay well below
  // the limit, or the events after it (ours too) would pass it and be refused everywhere.
  if (
    (ev.prev.length === 0 && ev.depth !== 0) ||
    (parents.length > 0 && ev.depth <= deepest) ||
    (parents.length === ev.prev.length && ev.prev.length > 0 && ev.depth !== deepest + 1) ||
    (parents.length < ev.prev.length && ev.depth >= EV.depth / 2)
  )
    return refuse('depth')
  const tid = targetOf(wire)
  const target = tid ? await events.get(tid) : undefined
  if (target && (target.room !== ev.room || !authorizeTarget(ev, target.wire)))
    return refuse('auth')
  const reply =
    ev.type === 'msg' && wire.c && 'body' in wire.c
      ? (wire.c as { reply?: string }).reply
      : undefined
  const effTs = effTsOf(
    ev.ts,
    receivedAt,
    parents.map(r => (ctx.own ? Math.min(r.effTs, receivedAt) : r.effTs))
  )
  const seq = room.lastSeq + 1
  let stored = wire
  let isRedacted = wire.c === null
  // A redaction that arrived first: the event is born redacted, and so are its edits. An edit of
  // a redacted message is stored without its text too.
  const pointing =
    ev.type === 'redact' ? [] : await events.index('room_target').getAll([ev.room, id])
  const gone = pointing.some(r => r.type === 'redact' && r.sender === ev.sender)
  if (gone) {
    isRedacted = true
    for (const r of pointing)
      if (r.type === 'edit' && !r.redacted)
        await events.put({ ...r, wire: redacted(r.wire), redacted: true })
  }
  if (ev.type === 'edit' && target?.redacted) {
    const marks = await events.index('room_target').getAll([ev.room, target.id])
    if (marks.some(r => r.type === 'redact' && r.sender === target.sender)) isRedacted = true
  }
  if (isRedacted) stored = redacted(wire)
  const rec: EventRecord = {
    id,
    room: ev.room,
    type: ev.type,
    sender: ev.sender,
    wire: stored,
    depth: ev.depth,
    effTs,
    sortKey: sortKeyOf(effTs, ev.depth, id),
    receivedAt,
    seq,
    redacted: isRedacted,
  }
  if (tid) rec.target = tid
  if (reply) rec.reply = reply
  await events.put(rec)
  if (ev.type === 'redact' && target && !target.redacted) {
    await events.put({ ...target, wire: redacted(target.wire), redacted: true })
    for (const r of await events.index('room_target').getAll([ev.room, target.id]))
      if (r.type === 'edit' && !r.redacted)
        await events.put({ ...r, wire: redacted(r.wire), redacted: true })
  }
  const children = tx.objectStore('children')
  for (const p of ev.prev) await children.put({ parent: p, child: id })
  const hasChild = (await children.count(childRange(id))) > 0
  const known = new Set(parents.map(r => r.id))
  const missing = room.missing.filter(m => m !== id)
  for (const p of ev.prev) if (!known.has(p) && !missing.includes(p)) missing.push(p)
  let ping: PingKind | null = null
  let unread = false
  const c = rec.wire.c
  if (ev.sender !== ctx.me) {
    if (ev.type === 'msg' && c) {
      unread = true
      const m = c as { mentions?: string[]; fwd?: unknown } | null
      if (m && !m.fwd && m.mentions?.includes(ctx.me)) ping = 'mention'
      else if (reply) {
        const r = await events.get(reply)
        if (r && r.room === ev.room && r.type === 'msg' && r.sender === ctx.me) ping = 'reply'
      }
    } else if (ev.type === 'react' && c && 'on' in c && c.on && target?.sender === ctx.me)
      ping = 'reaction'
  }
  const next: RoomRecord = {
    ...room,
    heads: nextHeads(room.heads, id, ev.depth, ev.prev, hasChild),
    missing: missing.slice(-DAG.missing),
    maxDepth: Math.max(room.maxDepth, ev.depth),
    count: room.count + 1,
    lastSeq: seq,
    unread: room.unread + (unread ? 1 : 0),
    pings: room.pings + (ping ? 1 : 0),
    lastTs: ev.type === 'msg' ? Math.max(room.lastTs, effTs) : room.lastTs,
    bytes: roomBytes + size,
  }
  await tx.objectStore('rooms').put(next)
  await tx.objectStore('meta').put(total + 1, TOTAL)
  await tx.objectStore('meta').put(totalBytes + size, TOTAL_BYTES)
  return { status: 'new', rec, ping, unread }
}

// An event signed by a since-revoked device is kept only when a stored event signed by a device
// of the same identity that is still good has it as an ancestor: walks the children forward.
export const vouched = async (
  db: P2pDatabase,
  room: string,
  id: string,
  sender: string,
  good: (dev: string) => boolean,
  limit = DAG.walk
) => {
  const tx = db.transaction(['events', 'children'])
  const events = tx.objectStore('events')
  const children = tx.objectStore('children')
  const seen = new Set([id])
  const queue = [id]
  let steps = 0
  let ok = false
  while (queue.length && steps < limit && !ok) {
    const at = queue.shift() as string
    for (const k of await children.getAllKeys(childRange(at))) {
      const child = k[1]
      if (seen.has(child)) continue
      seen.add(child)
      steps += 1
      const r = await events.get(child)
      if (!r || r.room !== room) continue
      if (r.sender === sender && good(r.wire.ev.dev)) {
        ok = true
        break
      }
      queue.push(child)
    }
  }
  await tx.done
  return ok
}

export const lateMark = (rec: Pick<EventRecord, 'effTs' | 'receivedAt'>) =>
  isLate(rec.effTs, rec.receivedAt)

// Which of `targets` are `from` or one of their ancestors, walking at most `limit` events.
export const ancestorsAmong = async (
  db: P2pDatabase,
  room: string,
  from: string[],
  targets: Set<string>,
  limit = DAG.walk
): Promise<Set<string>> => {
  const found = new Set<string>()
  if (!targets.size) return found
  const tx = db.transaction('events')
  const seen = new Set<string>()
  const queue = [...from]
  let steps = 0
  while (queue.length && steps < limit && found.size < targets.size) {
    const id = queue.shift() as string
    if (seen.has(id)) continue
    seen.add(id)
    steps += 1
    if (targets.has(id)) found.add(id)
    const r = await tx.store.get(id)
    if (r && r.room === room) for (const p of r.wire.ev.prev) if (!seen.has(p)) queue.push(p)
  }
  await tx.done
  return found
}

// What a peer is missing: a walk back from `from` that stops at what it has, newest first, at
// most `limit` events and `bytes` of JSON. Returned oldest first, so parents are stored before
// their children. `more` when the walk was cut short.
export const walkBack = async (
  db: P2pDatabase,
  room: string,
  from: string[],
  have: string[],
  limit: number,
  bytes: number
): Promise<{ events: EventRecord[]; more: boolean }> => {
  const tx = db.transaction('events')
  const stop = new Set(have)
  const seen = new Set<string>()
  const queue = from.filter(id => !stop.has(id))
  const out: EventRecord[] = []
  let size = 0
  let steps = 0
  let more = false
  while (queue.length) {
    if (out.length >= limit || steps >= DAG.walk) {
      more = true
      break
    }
    const id = queue.shift() as string
    if (seen.has(id)) continue
    seen.add(id)
    steps += 1
    const r = await tx.store.get(id)
    if (!r || r.room !== room) continue
    const n = JSON.stringify(r.wire).length
    if (out.length > 0 && size + n > bytes) {
      more = true
      break
    }
    size += n
    out.push(r)
    for (const p of r.wire.ev.prev) if (!stop.has(p) && !seen.has(p)) queue.push(p)
  }
  await tx.done
  out.sort((a, b) => a.depth - b.depth || (a.id < b.id ? -1 : 1))
  return { events: out, more }
}

// Stored events by id, in this room only.
export const getEvents = async (db: P2pDatabase, room: string, ids: string[]) => {
  const tx = db.transaction('events')
  const out: EventRecord[] = []
  for (const id of ids) {
    const r = await tx.store.get(id)
    if (r && r.room === room) out.push(r)
  }
  await tx.done
  return out
}
