import type { PackedRec } from './acl_room'
import {
  attsOf,
  authorizeTarget,
  effTsOf,
  isLate,
  LIMITS as EV,
  redacted,
  sortKeyOf,
  targetOf,
  type Wire,
  type WireV2,
} from './event'
import type { IDBPTransaction } from 'idb'
import {
  withFiles,
  type EventRecord,
  type P2pDatabase,
  type P2pSchema,
  type RoomRecord,
} from './db'

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
  // P2P servers have a budget of their own, so a server can never crowd out DMs. It bounds their
  // content; ACL events are always stored (spec 4.2).
  serverCap: 400_000,
  serverBytes: 768 * 1024 * 1024,
  // Steps of any walk over prev links.
  walk: 5000,
}

export type PingKind = 'mention' | 'reply' | 'reaction'

export type Inserted =
  // `freed`: files of a message this insert redacted (they may be deleted here now).
  | { status: 'new'; rec: EventRecord; ping: PingKind | null; unread: boolean; freed: string[] }
  | { status: 'dup'; rec: EventRecord }
  | { status: 'invalid'; why: 'depth' | 'auth' }
  | { status: 'full'; why: FullWhy }
  // P2P servers: not stored for now (pending, held, or past a local limit): no strike.
  | { status: 'quota' }
  // P2P servers: refused by the rules (spec 2.1 Reject): never stored or relayed, no strike.
  | { status: 'rejected'; why: string }

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
  // Fields to store with the record (an import keeps what the exporting device decided).
  mark?: Pick<EventRecord, 'chan'>
}

// Server rooms count against their own totals.
export const SERVER_TOTAL = 'sevents'
export const SERVER_TOTAL_BYTES = 'sbytes'

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

// The stored form of a redacted event: no content, and no files to serve.
export const stripped = (r: EventRecord): EventRecord => {
  return { ...withFiles(r, []), wire: redacted(r.wire), redacted: true }
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
  const rid = ev.room
  const have = await events.get(id)
  if (have) return { status: 'dup', rec: have }
  const room = (await tx.objectStore('rooms').get(rid)) ?? blankRoom(rid, ctx.peer, receivedAt)
  if (room.kind === 'server') return { status: 'invalid', why: 'auth' }
  const mayRedact = sameSender
  const meta = tx.objectStore('meta')
  const total = ((await meta.get(TOTAL)) as number | undefined) ?? 0
  const totalBytes = ((await meta.get(TOTAL_BYTES)) as number | undefined) ?? 0
  const roomBytes = room.bytes ?? 0
  const size = storedSize(wire)
  const totalCap = ctx.totalCap ?? DAG.totalCap
  const totalMax = ctx.totalBytes ?? DAG.totalBytes
  const roomCap = ctx.roomCap ?? DAG.roomCap
  const roomMax = ctx.roomBytes ?? DAG.roomBytes
  const why: FullWhy | null =
    room.count >= roomCap || total >= totalCap
      ? 'events'
      : roomBytes + size > roomMax || totalBytes + size > totalMax
        ? 'bytes'
        : null
  if (why) {
    if (!room.full) await tx.objectStore('rooms').put({ ...room, full: true, fullWhy: why })
    return { status: 'full', why }
  }
  const parents: EventRecord[] = []
  for (const p of ev.prev) {
    const r = await events.get(p)
    if (r && r.room === rid) parents.push(r)
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
  if (target && (target.room !== rid || !authorizeTarget(ev, target.wire))) return refuse('auth')
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
  const pointing = ev.type === 'redact' ? [] : await events.index('room_target').getAll([rid, id])
  const gone = pointing.some(r => r.type === 'redact' && mayRedact(r, ev))
  if (gone) {
    isRedacted = true
    for (const r of pointing) if (r.type === 'edit' && !r.redacted) await events.put(stripped(r))
  }
  if (ev.type === 'edit' && target?.redacted) {
    const marks = await events.index('room_target').getAll([rid, target.id])
    if (marks.some(r => r.type === 'redact' && mayRedact(r, target))) isRedacted = true
  }
  if (isRedacted) stored = redacted(wire)
  const rec: EventRecord = {
    ...ctx.mark,
    id,
    room: rid,
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
  const atts = isRedacted || ev.type !== 'msg' ? [] : attsOf(stored.c)
  if (atts.length) Object.assign(rec, withFiles(rec, atts))
  await events.put(rec)
  let freed: string[] = []
  // A redaction takes effect when it is allowed now, not just by what its sender cited.
  if (ev.type === 'redact' && target && !target.redacted && mayRedact(rec, target)) {
    freed = target.atts ?? []
    await events.put(stripped(target))
    for (const r of await events.index('room_target').getAll([rid, target.id]))
      if (r.type === 'edit' && !r.redacted) await events.put(stripped(r))
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
        if (r && r.room === rid && r.type === 'msg' && r.sender === ctx.me) ping = 'reply'
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
    lastTs: ev.type === 'msg' || ev.type === 'call' ? Math.max(room.lastTs, effTs) : room.lastTs,
    bytes: roomBytes + size,
  }
  await tx.objectStore('rooms').put(next)
  await meta.put(total + 1, TOTAL)
  await meta.put(totalBytes + size, TOTAL_BYTES)
  return { status: 'new', rec, ping, unread, freed }
}

const sameSender = (r: EventRecord, t: Pick<EventRecord, 'sender'>) => r.sender === t.sender

// ----- P2P servers (spec 1.3, 4.2): two layers in one store -----

// A device's chain in a server as this device stored it (meta store): its highest seq and its
// last ACL and content events. Read and written in the transaction that stores an event of it.
export interface DevChain {
  seq: number
  aprev?: string
  cprev?: string
}

export const chainKey = (room: string, dev: string) => `chain2\n${room}\n${dev}`

export interface ServerInsert {
  me: string
  // An admitted ACL event: its admission order and record (absent: content, or a server of
  // unknown rules, whose events are stored unchecked).
  aseq?: number
  acl?: PackedRec
  // Our own event: the device chain must still be where it was read when the event was built.
  chain?: DevChain | null
  // Content caps (per room and for every server together); ACL events always fit, and so do the
  // events of a server of unknown rules up to `unknownCap`.
  roomCap?: number
  roomBytes?: number
  serverCap?: number
  serverBytes?: number
  unknown?: boolean
}

// Limits of a server whose rules this build doesn't know (stored unchecked, spec 1.2).
export const UNKNOWN = { events: 20_000, bytes: 32 * 1024 * 1024 }

export type ServerInserted = Inserted | { status: 'stale' }

const CONTENT_TARGETED: readonly string[] = ['edit', 'redact', 'react', 'pin']

export const insertServer = async (
  db: P2pDatabase,
  room: string,
  id: string,
  wire: WireV2,
  receivedAt: number,
  ctx: ServerInsert
): Promise<ServerInserted> => {
  const tx = db.transaction(['rooms', 'events', 'children', 'meta'], 'readwrite')
  tx.done.catch(() => {})
  const events = tx.objectStore('events')
  const have = await events.get(id)
  if (have) {
    await tx.done
    return { status: 'dup', rec: have }
  }
  const r = await tx.objectStore('rooms').get(room)
  if (!r || r.kind !== 'server') {
    tx.abort()
    return { status: 'invalid', why: 'auth' }
  }
  const ev = wire.ev
  const meta = tx.objectStore('meta')
  const ck = chainKey(room, ev.dev)
  const chain = ((await meta.get(ck)) as DevChain | undefined) ?? null
  if (ctx.chain !== undefined && (chain?.seq ?? -1) !== (ctx.chain?.seq ?? -1)) {
    tx.abort()
    return { status: 'stale' }
  }
  const acl = ev.L === 'a'
  const total = ((await meta.get(SERVER_TOTAL)) as number | undefined) ?? 0
  const totalBytes = ((await meta.get(SERVER_TOTAL_BYTES)) as number | undefined) ?? 0
  const size = storedSize(wire as unknown as Wire)
  const roomBytes = r.bytes ?? 0
  const full: FullWhy | null = ctx.unknown
    ? r.count >= UNKNOWN.events || total >= (ctx.serverCap ?? DAG.serverCap)
      ? 'events'
      : roomBytes + size > UNKNOWN.bytes || totalBytes + size > (ctx.serverBytes ?? DAG.serverBytes)
        ? 'bytes'
        : null
    : acl
      ? null
      : r.count >= (ctx.roomCap ?? DAG.roomCap) || total >= (ctx.serverCap ?? DAG.serverCap)
        ? 'events'
        : roomBytes + size > (ctx.roomBytes ?? DAG.roomBytes) ||
            totalBytes + size > (ctx.serverBytes ?? DAG.serverBytes)
          ? 'bytes'
          : null
  if (full) {
    if (!r.full) await tx.objectStore('rooms').put({ ...r, full: true, fullWhy: full })
    await tx.done
    return { status: 'full', why: full }
  }
  const c = wire.c as Record<string, unknown> | null
  const prev = acl ? [] : (ev.prev ?? [])
  const parents: EventRecord[] = []
  for (const p of prev) {
    const x = await events.get(p)
    if (x && x.room === room) parents.push(x)
  }
  const effTs = effTsOf(
    ev.ts,
    receivedAt,
    parents.map(x => (ev.a === ctx.me ? Math.min(x.effTs, receivedAt) : x.effTs))
  )
  const seq = r.lastSeq + 1
  // Display order among equal times follows the content parents, and for ACL events (join and
  // leave lines) their admission order.
  const depth = acl ? (ctx.aseq ?? 0) : 1 + Math.max(-1, ...parents.map(x => x.depth))
  const tid =
    !acl && c && CONTENT_TARGETED.includes(ev.t) && typeof c.target === 'string' ? c.target : null
  const target = tid ? await events.get(tid) : undefined
  const stored = wire
  const isRedacted = c === null
  const rec: EventRecord = {
    id,
    room,
    type: ev.t,
    sender: ev.a,
    wire: stored as unknown as Wire,
    depth,
    effTs,
    sortKey: sortKeyOf(effTs, depth, id),
    receivedAt,
    seq,
    redacted: isRedacted,
    layer: ev.L,
    dev: ev.dev,
    dseq: ev.seq,
  }
  if (acl && ctx.aseq !== undefined) rec.aseq = ctx.aseq
  if (acl && ctx.acl) rec.acl = ctx.acl
  if (!acl && typeof c?.ch === 'string') rec.chan = c.ch
  if (tid && target?.room !== undefined && target.room !== room) {
    tx.abort()
    return { status: 'invalid', why: 'auth' }
  }
  if (tid) rec.target = tid
  const reply = !acl && ev.t === 'msg' && typeof c?.reply === 'string' ? c.reply : undefined
  if (reply) rec.reply = reply
  const atts = isRedacted || ev.t !== 'msg' ? [] : attsOf(stored.c as never)
  if (atts.length) Object.assign(rec, withFiles(rec, atts))
  await events.put(rec)
  const next: DevChain = { seq: Math.max(chain?.seq ?? -1, ev.seq) }
  const keep = (x: string | undefined, mine: boolean) => (mine ? id : x)
  const later = ev.seq >= (chain?.seq ?? -1)
  const ap = keep(chain?.aprev, acl && later)
  const cp = keep(chain?.cprev, !acl && later)
  if (ap !== undefined) next.aprev = ap
  if (cp !== undefined) next.cprev = cp
  await meta.put(next, ck)
  const missing = r.missing.filter(m => m !== id)
  const known = new Set(parents.map(x => x.id))
  for (const p of prev) if (!known.has(p) && !missing.includes(p)) missing.push(p)
  let heads = r.heads
  if (!acl) {
    const children = tx.objectStore('children')
    for (const p of prev) await children.put({ parent: p, child: id })
    heads = nextHeads(r.heads, id, depth, prev, (await children.count(childRange(id))) > 0)
  }
  await tx.objectStore('rooms').put({
    ...r,
    heads,
    missing: missing.slice(-DAG.missing),
    count: r.count + 1,
    lastSeq: seq,
    lastTs: !acl && ev.t === 'msg' ? Math.max(r.lastTs, effTs) : r.lastTs,
    bytes: roomBytes + size,
  })
  await meta.put(total + 1, SERVER_TOTAL)
  await meta.put(totalBytes + size, SERVER_TOTAL_BYTES)
  await tx.done
  return { status: 'new', rec, ping: null, unread: false, freed: [] }
}

// Strips a content event a redaction by its own author hides (spec 4.3: self-redactions purge at
// once), with that author's edits of it; returns the files it carried. The caller checks that the
// redaction counts (visible, positioned after its target).
export const stripServer = async (db: P2pDatabase, room: string, id: string, author: string) => {
  const tx = db.transaction('events', 'readwrite')
  const events = tx.store
  const t = await events.get(id)
  let freed: string[] = []
  if (t && t.room === room && t.layer === 'c' && !t.redacted && t.sender === author) {
    freed = t.atts ?? []
    await events.put(stripped(t))
    for (const x of await events.index('room_target').getAll([room, id]))
      if (x.type === 'edit' && x.layer === 'c' && !x.redacted && x.sender === author)
        await events.put(stripped(x))
  }
  await tx.done
  return freed
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

// Parents of a stored event: `prev`, and for a server event its ACL parents too.
export const parentsOf = (r: EventRecord): string[] => {
  const ev = r.wire.ev as { prev?: string[]; ap?: string[] }
  return [...(ev.prev ?? []), ...(ev.ap ?? [])]
}

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
    if (r && r.room === room) for (const p of parentsOf(r)) if (!seen.has(p)) queue.push(p)
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
