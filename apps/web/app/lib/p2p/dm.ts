import { sha256 } from '@noble/hashes/sha2.js'
import { b64u, concat, utf8 } from './canonical'
import { blankRoom, DAG, insertEvent, type FullWhy, type Inserted, type PingKind } from './dag'
import type { EventRecord, OutboxRecord, P2pDatabase, P2pStore, RoomRecord } from './db'
import {
  buildEvent,
  LIMITS as EV,
  isLate,
  sizeOf,
  validate,
  type Invalid,
  type Wire,
  type Content,
  type EditContent,
  type EvType,
  type Fwd,
  type MsgContent,
  type PinContent,
  type ReactContent,
} from './event'
import { fmtSize } from '../bytes'
import { maskCode } from '../mentions'
import { keyBytes } from './keys'
import type { P2pNode } from './node'
import { realClock, type Clock } from './session'
import { isQuotaError, Sync, type SyncLimits } from './sync'

// P2P direct messages: one room per pair of identities, its events in IndexedDB on both sides,
// synced whenever both are online. This module builds the conversation view (edits, reactions,
// pins and redactions applied), counts unread messages and pings, and sends new events.

export const DM_TAG = 'rchat-p2p-dm1\0'

// Deterministic, so there is no create event: both sides compute the same id.
export const dmRoomId = (a: string, b: string) => {
  const [lo, hi] = a < b ? [a, b] : [b, a]
  const ka = keyBytes(lo)
  const kb = keyBytes(hi)
  if (!ka || !kb) throw new Error('bad identity key')
  return b64u(sha256(concat(utf8(DM_TAG), ka, kb)))
}

export const PINS_MAX = 100
export const PAGE = 100

export interface P2pReaction {
  key: string
  count: number
  me: boolean
  first: number
  by: string[]
}

export interface P2pMessage {
  id: string
  sender: string
  // Display time (effTs) and the sender's own clock.
  ts: number
  sentTs: number
  sortKey: string
  seq: number
  body: string
  reply: { id: string; sender: string | null; body: string | null } | null
  mentions: string[]
  fwd: Fwd | null
  edited: number | null
  reactions: P2pReaction[]
  pinned: number | null
  // Shown more than a minute before it arrived.
  late: boolean
  // Ours: waiting in the outbox, or delivered to the other side.
  pending: boolean
  // Ours, and it can't be delivered as it is: Retry or Delete.
  failed: boolean
}

const newer = (a: EventRecord, b: EventRecord) =>
  a.effTs !== b.effTs ? a.effTs > b.effTs : a.id > b.id

const pick = (list: EventRecord[], ok: (r: EventRecord) => boolean): EventRecord | null => {
  let best: EventRecord | null = null
  for (const r of list) if (ok(r) && (!best || newer(r, best))) best = r
  return best
}

export const isRedactedBy = (msg: EventRecord, related: EventRecord[]) =>
  related.some(r => r.type === 'redact' && r.sender === msg.sender)

// Reactions: the latest event per (sender, key) wins; chips go in order of each key's first
// `on`.
export const reactionsOf = (related: EventRecord[], me: string): P2pReaction[] => {
  const latest = new Map<string, EventRecord>()
  const first = new Map<string, number>()
  for (const r of related) {
    if (r.type !== 'react' || !r.wire.c) continue
    const c = r.wire.c as ReactContent
    const k = `${r.sender}\n${c.key}`
    const cur = latest.get(k)
    if (!cur || newer(r, cur)) latest.set(k, r)
    if (c.on) first.set(c.key, Math.min(first.get(c.key) ?? Infinity, r.effTs))
  }
  const by = new Map<string, string[]>()
  for (const r of latest.values()) {
    const c = r.wire.c as ReactContent
    if (!c.on) continue
    by.set(c.key, [...(by.get(c.key) ?? []), r.sender])
  }
  return [...by.entries()]
    .map(([key, who]) => ({
      key,
      count: who.length,
      me: who.includes(me),
      first: first.get(key) ?? 0,
      by: who,
    }))
    .sort((a, b) => a.first - b.first || (a.key < b.key ? -1 : 1))
}

// The latest pin event for a message, either member's.
export const pinOf = (related: EventRecord[]): number | null => {
  const p = pick(related, r => r.type === 'pin' && r.wire.c !== null)
  return p && (p.wire.c as PinContent).on ? p.effTs : null
}

// The latest edit by the message's own sender wins.
export const editOf = (msg: EventRecord, related: EventRecord[]) =>
  pick(related, r => r.type === 'edit' && r.sender === msg.sender && r.wire.c !== null)

export const deriveMessage = (
  msg: EventRecord,
  related: EventRecord[],
  replyTo: EventRecord | null | undefined,
  replyRelated: EventRecord[],
  me: string,
  outbox: Map<string, OutboxRecord>,
  peer: string
): P2pMessage | null => {
  const c = msg.wire.c as MsgContent | null
  if (!c || msg.redacted || isRedactedBy(msg, related)) return null
  const edit = c.fwd ? null : editOf(msg, related)
  const o = outbox.get(msg.id)
  let reply: P2pMessage['reply'] = null
  if (c.reply) {
    const rc = replyTo?.wire.c as MsgContent | null | undefined
    const gone = !replyTo || !rc || replyTo.redacted || isRedactedBy(replyTo, replyRelated)
    const redit = replyTo && !gone ? editOf(replyTo, replyRelated) : null
    reply = {
      id: c.reply,
      sender: replyTo?.sender ?? null,
      body: gone ? null : redit ? (redit.wire.c as EditContent).body : (rc as MsgContent).body,
    }
  }
  return {
    id: msg.id,
    sender: msg.sender,
    ts: msg.effTs,
    sentTs: msg.wire.ev.ts,
    sortKey: msg.sortKey,
    seq: msg.seq,
    body: edit ? (edit.wire.c as EditContent).body : c.body,
    reply,
    mentions: c.fwd ? [] : (c.mentions ?? []),
    fwd: c.fwd ?? null,
    edited: edit ? edit.effTs : null,
    reactions: reactionsOf(related, me),
    pinned: pinOf(related),
    late: msg.sender !== me && isLate(msg.effTs, msg.receivedAt),
    pending: msg.sender === me && o !== undefined && !o.deliveredTo.includes(peer),
    failed: msg.sender === me && o !== undefined && !o.deliveredTo.includes(peer) && !!o.failed,
  }
}

const related = async (db: P2pDatabase, room: string, id: string) =>
  db.getAllFromIndex('events', 'room_target', [room, id])

const outboxMap = async (db: P2pDatabase, room: string) =>
  new Map((await db.getAllFromIndex('outbox', 'room', room)).map(o => [o.id, o]))

export const viewOf = async (
  db: P2pDatabase,
  room: string,
  recs: EventRecord[],
  me: string,
  peer: string
) => {
  const box = await outboxMap(db, room)
  const out: P2pMessage[] = []
  for (const r of recs) {
    const rel = await related(db, room, r.id)
    const reply = (r.wire.c as MsgContent | null)?.reply
    const target = reply ? await db.get('events', reply) : undefined
    const replyRel = target ? await related(db, room, target.id) : []
    const m = deriveMessage(r, rel, target?.room === room ? target : null, replyRel, me, box, peer)
    if (m) out.push(m)
  }
  return out
}

const sortRange = (room: string, type: EvType, below?: string, above?: string) =>
  IDBKeyRange.bound([room, type, above ?? ''], [room, type, below ?? '￿'], !!above, !!below)

// The newest `limit` messages before `before` (a sort key), oldest first. `more` when older ones
// are stored.
export const loadMessages = async (
  db: P2pDatabase,
  room: string,
  me: string,
  peer: string,
  opts: { before?: string; after?: string; limit?: number } = {}
) => {
  const limit = opts.limit ?? PAGE
  const recs: EventRecord[] = []
  let cursor = await db
    .transaction('events')
    .store.index('room_type_sort')
    .openCursor(sortRange(room, 'msg', opts.before, opts.after), 'prev')
  while (cursor && recs.length < limit + 1) {
    recs.push(cursor.value)
    cursor = await cursor.continue()
  }
  const more = recs.length > limit
  const page = recs.slice(0, limit).reverse()
  return { messages: await viewOf(db, room, page, me, peer), more }
}

// Live pins, newest first, at most PINS_MAX. Walks pin events newest first, so the first one
// seen for a message is its latest, and stops after PINS_MAX live pins or DAG.walk events.
export const loadPins = async (db: P2pDatabase, room: string, me: string, peer: string) => {
  const seen = new Set<string>()
  const on: EventRecord[] = []
  let steps = 0
  let cursor = await db
    .transaction('events')
    .store.index('room_type_sort')
    .openCursor(sortRange(room, 'pin'), 'prev')
  while (cursor && on.length < PINS_MAX && steps < DAG.walk) {
    const p = cursor.value
    steps += 1
    if (p.target && p.wire.c && !seen.has(p.target)) {
      seen.add(p.target)
      if ((p.wire.c as PinContent).on) on.push(p)
    }
    cursor = await cursor.continue()
  }
  const recs: EventRecord[] = []
  for (const p of on) {
    const r = await db.get('events', p.target as string)
    if (r && r.room === room && r.type === 'msg') recs.push(r)
  }
  return viewOf(db, room, recs, me, peer)
}

// A message by id with its surroundings, for jumping to it.
export const loadAround = async (
  db: P2pDatabase,
  room: string,
  me: string,
  peer: string,
  id: string
) => {
  const r = await db.get('events', id)
  if (!r || r.room !== room) return null
  const older = await loadMessages(db, room, me, peer, { before: r.sortKey, limit: PAGE / 2 })
  const newerPage = await loadMessages(db, room, me, peer, {
    after: r.sortKey,
    limit: PAGE * 10,
  })
  const self = await viewOf(db, room, [r], me, peer)
  return { messages: [...older.messages, ...self, ...newerPage.messages], more: older.more }
}

// ----- Sending -----

export class DmError extends Error {}

export const FULL_TEXT = (n: number) =>
  `This conversation reached the limit of ${n.toLocaleString()} stored events on this device.`
export const FULL_BYTES_TEXT = (bytes: number) =>
  `This conversation reached the storage limit of ${fmtSize(bytes)} on this device.`
export const STORAGE_FULL_TEXT = "Storage on this device is full. New messages can't be saved."
export const PEER_FULL_TEXT = 'Their storage is full. Messages wait until there is space.'
export const TOO_LONG_TEXT = 'This message is too long to send.'
export const CANT_SEND_TEXT = "This message can't be sent. Delete it instead."

const INVALID_TEXT: Partial<Record<Invalid, string>> = {
  size: TOO_LONG_TEXT,
  content: TOO_LONG_TEXT,
}

// Whether a message body can't be sent: too many characters, or too many bytes once encoded.
export const bodyTooLong = (body: string) =>
  Array.from(body).length > EV.body || sizeOf({ body }) > EV.content

// Forwarded author names longer than events allow are cut, not refused.
export const clipName = (name: string) => Array.from(name).slice(0, EV.name).join('')
export const MOVED_TEXT =
  'Your P2P identity moved to another device. This browser can no longer send.'

export interface Arrival {
  room: string
  peer: string
  rec: EventRecord
  ping: PingKind | null
  unread: boolean
}

export interface DmDeps {
  node: P2pNode
  store: P2pStore
  clock?: Clock
  limits?: Partial<SyncLimits>
  roomCap?: number
  totalCap?: number
  roomBytes?: number
  totalBytes?: number
  pace?: () => Promise<void>
}

export class Dms {
  readonly sync: Sync
  private clock: Clock
  private changeFns = new Set<(room: string) => void>()
  private arriveFns = new Set<(a: Arrival) => void>()
  private typers = new Map<string, { until: number; timer: unknown }>()
  // The browser refused to store more (quota exceeded). Pulls pause for a minute after that.
  storageFull = false
  private quotaAt = 0

  constructor(private deps: DmDeps) {
    this.clock = deps.clock ?? realClock
    const { node } = deps
    this.sync = new Sync({
      store: deps.store,
      clock: this.clock,
      me: () => node.ik,
      devices: ik => node.devicesOf(ik),
      contact: ik => node.contact(ik),
      roomOf: ik => dmRoomId(node.ik, ik),
      onStored: (room, from, added) => this.stored(room, from, added),
      onDelivered: room => this.changed(room),
      onTyping: (room, ik, on) => this.typed(room, ik, on),
      onState: room => this.changed(room),
      limits: deps.limits,
      roomCap: deps.roomCap,
      totalCap: deps.totalCap,
      roomBytes: deps.roomBytes,
      totalBytes: deps.totalBytes,
      onQuota: full => this.quota(full),
      quotaFull: () => this.storageFull && this.clock.now() - this.quotaAt < 60_000,
      pace: deps.pace,
    })
    node.use({ attach: s => this.sync.attach(s), ready: s => this.sync.ready(s) })
  }

  get me() {
    return this.deps.node.ik
  }

  get db() {
    return this.deps.store.db
  }

  onChange(fn: (room: string) => void) {
    this.changeFns.add(fn)
    return () => void this.changeFns.delete(fn)
  }

  onArrive(fn: (a: Arrival) => void) {
    this.arriveFns.add(fn)
    return () => void this.arriveFns.delete(fn)
  }

  private changed(room: string) {
    for (const fn of this.changeFns) fn(room)
  }

  private quota(full: boolean) {
    if (full) this.quotaAt = this.clock.now()
    if (this.storageFull === full) return
    this.storageFull = full
    void this.rooms().then(
      list => list.forEach(r => this.changed(r.id)),
      () => {}
    )
  }

  fullText(why: FullWhy | undefined) {
    return why === 'bytes'
      ? FULL_BYTES_TEXT(this.deps.roomBytes ?? DAG.roomBytes)
      : FULL_TEXT(this.deps.roomCap ?? DAG.roomCap)
  }

  private auth(room: string, peer: string) {
    return {
      room,
      members: [this.me, peer],
      devices: (ik: string) => this.deps.node.devicesOf(ik),
    }
  }

  private stored(room: string, from: string, added: Inserted[]) {
    for (const a of added) {
      if (a.status !== 'new') continue
      if (a.rec.sender === this.me) continue
      for (const fn of this.arriveFns)
        fn({ room, peer: from, rec: a.rec, ping: a.ping, unread: a.unread })
      if (a.rec.type === 'msg') this.typed(room, a.rec.sender, false)
    }
    this.changed(room)
  }

  roomFor(ik: string) {
    return dmRoomId(this.me, ik)
  }

  // The room with a contact, created on first use.
  async open(ik: string): Promise<RoomRecord> {
    const id = this.roomFor(ik)
    const now = this.clock.now()
    return (await this.deps.store.updateRoom(id, cur =>
      cur ? null : blankRoom(id, ik, now)
    )) as RoomRecord
  }

  rooms() {
    return this.deps.store.rooms()
  }

  online(room: string) {
    return this.sync.online(room)
  }

  // Builds, checks and stores a new event of ours, then sends it. It goes through the same
  // validation as events from others, so nothing we send can be refused for its shape or size.
  private async create(room: string, type: EvType, content: Content) {
    const author = this.deps.node.author()
    if (!author) throw new DmError(MOVED_TEXT)
    const rec = await this.deps.store.room(room)
    if (!rec) throw new DmError('Unknown conversation')
    const heads = rec.heads.slice(0, EV.prev)
    const depth = heads.length ? Math.max(...heads.map(h => h.depth)) + 1 : 0
    const now = this.clock.now()
    const { id, wire } = buildEvent(
      author,
      room,
      type,
      content,
      heads.map(h => h.id),
      depth,
      now
    )
    const v = validate(wire, this.auth(room, rec.peer))
    if (!v.ok) throw new DmError(INVALID_TEXT[v.why] ?? "Couldn't send the message")
    let res: Inserted
    try {
      res = await insertEvent(this.db, id, wire, now, {
        me: this.me,
        peer: rec.peer,
        roomCap: this.deps.roomCap,
        totalCap: this.deps.totalCap,
        roomBytes: this.deps.roomBytes,
        totalBytes: this.deps.totalBytes,
        own: true,
      })
      if (res.status === 'new')
        await this.db.put('outbox', { id, room, created: now, deliveredTo: [] })
    } catch (e) {
      if (!isQuotaError(e)) throw e
      this.quota(true)
      throw new DmError(STORAGE_FULL_TEXT)
    }
    if (res.status === 'full') throw new DmError(this.fullText(res.why))
    if (res.status === 'invalid') throw new DmError("Couldn't save the message")
    this.quota(false)
    this.sync.push(room, id, wire)
    this.sync.announce(room)
    this.changed(room)
    return id
  }

  // Our events still waiting that could never be accepted (made by an older version, for
  // example) are marked failed, so they show Retry and Delete instead of waiting forever.
  async recheckOutbox() {
    const tx = this.db.transaction(['outbox', 'events', 'rooms'], 'readwrite')
    const changed = new Set<string>()
    for (const o of await tx.objectStore('outbox').getAll()) {
      if (o.failed || o.deliveredTo.length) continue
      const r = await tx.objectStore('events').get(o.id)
      const room = await tx.objectStore('rooms').get(o.room)
      if (!r || !room || this.valid(r.wire, room)) continue
      await tx.objectStore('outbox').put({ ...o, failed: true })
      changed.add(o.room)
    }
    await tx.done
    for (const room of changed) this.changed(room)
  }

  private valid(wire: Wire, room: RoomRecord) {
    return validate(wire, this.auth(room.id, room.peer)).ok
  }

  // Sends a failed message again, if it can be accepted at all.
  async retry(room: string, id: string) {
    const r = await this.db.get('events', id)
    const rec = await this.deps.store.room(room)
    const o = await this.db.get('outbox', id)
    if (!r || !rec || !o || r.room !== room || r.sender !== this.me) return
    if (!this.valid(r.wire, rec)) throw new DmError(CANT_SEND_TEXT)
    await this.db.put('outbox', { ...o, failed: false })
    this.sync.resend(room, id, r.wire)
    this.changed(room)
  }

  async send(room: string, msg: { body: string; reply?: string; fwd?: Fwd }) {
    const rec = await this.deps.store.room(room)
    const content: MsgContent = { body: msg.body }
    if (msg.reply) content.reply = msg.reply
    if (msg.fwd) content.fwd = msg.fwd
    else if (rec && mentionsIn(msg.body, this.mentionNames(rec.peer))) content.mentions = [rec.peer]
    return this.create(room, 'msg', content)
  }

  // Names the composer may write for the other member: what they call themselves, and our name
  // for them.
  mentionNames(ik: string) {
    const c = this.deps.node.contact(ik)
    return [c?.name, c?.petname].filter((n): n is string => !!n)
  }

  private async ownMessage(room: string, target: string) {
    const r = await this.db.get('events', target)
    if (!r || r.room !== room || r.type !== 'msg') throw new DmError('Message not found')
    return r
  }

  async edit(room: string, target: string, body: string) {
    const r = await this.ownMessage(room, target)
    if (r.sender !== this.me || (r.wire.c as MsgContent | null)?.fwd)
      throw new DmError("You can't edit this message")
    return this.create(room, 'edit', { target, body })
  }

  async redact(room: string, target: string) {
    const r = await this.db.get('events', target)
    if (!r || r.room !== room || r.sender !== this.me)
      throw new DmError("You can't delete this message")
    const id = await this.create(room, 'redact', { target })
    this.sync.redactWaiting(room, target)
    // A message that never went out needs no delivery any more: the redacted copy is enough.
    const o = await this.db.get('outbox', target)
    if (o?.failed) await this.db.delete('outbox', target)
    return id
  }

  async react(room: string, target: string, key: string, on: boolean) {
    await this.ownMessage(room, target)
    return this.create(room, 'react', { target, key, on })
  }

  async pin(room: string, target: string, on: boolean) {
    await this.ownMessage(room, target)
    if (on) {
      const pins = await loadPins(this.db, room, this.me, '')
      if (pins.length >= PINS_MAX) throw new DmError(`You can pin up to ${PINS_MAX} messages`)
    }
    return this.create(room, 'pin', { target, on })
  }

  async markRead(room: string) {
    await this.deps.store.updateRoom(room, cur =>
      cur && (cur.readSeq !== cur.lastSeq || cur.unread || cur.pings)
        ? { ...cur, readSeq: cur.lastSeq, unread: 0, pings: 0 }
        : null
    )
    this.changed(room)
  }

  typing(room: string, on: boolean) {
    this.sync.typing(room, on)
  }

  private typed(room: string, ik: string, on: boolean) {
    const key = `${room}\n${ik}`
    const cur = this.typers.get(key)
    if (cur) this.clock.clear(cur.timer)
    if (!on) {
      if (cur) {
        this.typers.delete(key)
        this.changed(room)
      }
      return
    }
    const ttl = this.sync.limits.typingMs
    this.typers.set(key, {
      until: this.clock.now() + ttl,
      timer: this.clock.set(() => this.typed(room, ik, false), ttl),
    })
    if (!cur) this.changed(room)
  }

  typingIn(room: string) {
    return [...this.typers.keys()].filter(k => k.startsWith(`${room}\n`)).map(k => k.split('\n')[1])
  }

  loadOlder(room: string) {
    this.sync.loadOlder(room)
  }

  stop() {
    for (const t of this.typers.values()) this.clock.clear(t.timer)
    this.typers.clear()
    this.sync.stop()
  }
}

// Whether `body` mentions someone by one of `names` (an `@` not inside a word, the name, then no
// word character), case-insensitively.
export const mentionsIn = (body: string, names: string[]) => {
  const lower = maskCode(body).toLowerCase()
  return names.some(n => {
    const name = n.toLowerCase()
    if (!name) return false
    let at = lower.indexOf(`@${name}`)
    while (at !== -1) {
      const before = at === 0 ? '' : lower[at - 1]
      const after = lower[at + 1 + name.length] ?? ''
      if (!/[\p{L}\p{N}\p{M}_]/u.test(before) && !/[\p{L}\p{N}\p{M}_]/u.test(after)) return true
      at = lower.indexOf(`@${name}`, at + 1)
    }
    return false
  })
}
