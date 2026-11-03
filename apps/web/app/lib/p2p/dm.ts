import { sha256 } from '@noble/hashes/sha2.js'
import { b64u, concat, utf8 } from './canonical'
import { blankRoom, DAG, insertEvent, type FullWhy, type Inserted, type PingKind } from './dag'
import {
  fileKey,
  type EventRecord,
  type OutboxRecord,
  type P2pDatabase,
  type P2pStore,
  type RoomRecord,
} from './db'
import { Blobs, type BulkLimits } from './blobs'
import {
  buildEvent,
  LIMITS as EV,
  isLate,
  sizeOf,
  validate,
  CALL_OUTCOMES,
  type Invalid,
  type Wire,
  type Attachment,
  type CallContent,
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
  att: Attachment[]
  edited: number | null
  reactions: P2pReaction[]
  pinned: number | null
  // Shown more than a minute before it arrived.
  late: boolean
  // Ours: waiting in the outbox, or delivered to the other side.
  pending: boolean
  // Ours, and it can't be delivered as it is: Retry or Delete.
  failed: boolean
  // A call log row (written by the caller, `sender`), or a missed call this side noted itself
  // when the caller never wrote one (`local`).
  call: (CallContent & { local?: true }) | null
  // A line made from an event: a pin (by `ik`, of `target` while it shows), and in P2P servers a
  // join or leave line made from a member event. A mention of everyone by someone allowed to.
  system?: { kind: 'join' | 'leave' | 'pin'; ik: string; target?: string | null } | null
  everyone?: boolean
  // P2P servers: it shows, but its body was purged here and is on its way back (spec 4.3).
  unavailable?: boolean
  // P2P servers: a thread reply's root; on a top-level message, its thread's replies that show
  // and when the last one was sent.
  thread?: string | null
  replies?: number
  lastReply?: number
  // Names a thread root that isn't one here: shown in the channel, and starts no thread.
  noThread?: true
}

// What can be done with a shown message. One whose body isn't here ("Message unavailable") can't
// be edited, answered, forwarded or copied.
export const messageActs = (p: P2pMessage, canAct: boolean, mine: boolean) => {
  const live = !p.unavailable
  return {
    edit: canAct && live && mine && !p.fwd,
    reply: canAct && live,
    forward: live,
    copy: live && (p.fwd ? p.fwd.body : p.body).trim() !== '',
  }
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
  if (msg.type === 'call') return callRow(msg, related, me, outbox, peer)
  if (msg.type === 'pin') return pinRow(msg, replyTo, replyRelated)
  // A type from a newer version is stored but not shown.
  if (msg.type !== 'msg') return null
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
    att: c.att ?? [],
    edited: edit ? edit.effTs : null,
    reactions: reactionsOf(related, me),
    pinned: pinOf(related),
    late: msg.sender !== me && isLate(msg.effTs, msg.receivedAt),
    pending: msg.sender === me && o !== undefined && !o.deliveredTo.includes(peer),
    failed: msg.sender === me && o !== undefined && !o.deliveredTo.includes(peer) && !!o.failed,
    call: null,
  }
}

// "{name} pinned a message to this conversation.": a pin on, linking its message while that
// shows (`target`, `targetRelated`).
const pinRow = (
  msg: EventRecord,
  target: EventRecord | null | undefined,
  targetRelated: EventRecord[]
): P2pMessage | null => {
  const c = msg.wire.c as PinContent | null
  if (!c?.on || msg.redacted) return null
  const live =
    !!target &&
    target.type === 'msg' &&
    !target.redacted &&
    target.wire.c !== null &&
    !isRedactedBy(target, targetRelated)
  return {
    ...blankRow(msg.id, msg.sender, msg.effTs, msg.sortKey, msg.seq),
    sentTs: msg.wire.ev.ts,
    system: { kind: 'pin', ik: msg.sender, target: live ? c.target : null },
  }
}

const callRow = (
  msg: EventRecord,
  related: EventRecord[],
  me: string,
  outbox: Map<string, OutboxRecord>,
  peer: string
): P2pMessage | null => {
  const c = msg.wire.c as CallContent | null
  if (!c || msg.redacted || isRedactedBy(msg, related)) return null
  // An outcome from a newer version isn't shown.
  if (!CALL_OUTCOMES.includes(c.outcome)) return null
  const o = outbox.get(msg.id)
  return {
    ...blankRow(msg.id, msg.sender, msg.effTs, msg.sortKey, msg.seq),
    sentTs: msg.wire.ev.ts,
    late: msg.sender !== me && isLate(msg.effTs, msg.receivedAt),
    pending: msg.sender === me && o !== undefined && !o.deliveredTo.includes(peer),
    call: {
      id: c.id,
      video: c.video,
      outcome: c.outcome,
      ...(c.outcome === 'ended' ? { dur: c.dur } : {}),
    },
  }
}

const blankRow = (
  id: string,
  sender: string,
  ts: number,
  sortKey: string,
  seq: number
): P2pMessage => ({
  id,
  sender,
  ts,
  sentTs: ts,
  sortKey,
  seq,
  body: '',
  reply: null,
  mentions: [],
  fwd: null,
  att: [],
  edited: null,
  reactions: [],
  pinned: null,
  late: false,
  pending: false,
  failed: false,
  call: null,
})

// A missed call the caller never logged, as this side noted it.
export interface MissedCall {
  id: string
  from: string
  video: boolean
  at: number
}

export const MISSED_MAX = 50

export const missedRow = (m: MissedCall): P2pMessage => ({
  ...blankRow(`call:${m.id}`, m.from, m.at, `${String(m.at).padStart(16, '0')}.local`, 0),
  call: { id: m.id, video: m.video, outcome: 'missed', local: true },
})

// Local missed calls placed among loaded rows: only those the caller didn't log, and only in the
// time the page covers (everything newer than its oldest row, or all when nothing older is left).
export const withMissed = (rows: P2pMessage[], missed: MissedCall[], more: boolean) => {
  const logged = new Set(rows.flatMap(r => (r.call && !r.call.local ? [r.call.id] : [])))
  const from = more && rows.length ? rows[0].ts : -Infinity
  const extra = missed.filter(m => !logged.has(m.id) && m.at >= from).map(missedRow)
  if (!extra.length) return rows
  return [...rows, ...extra].sort((a, b) => a.ts - b.ts || (a.sortKey < b.sortKey ? -1 : 1))
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
    const reply = r.type === 'pin' ? r.target : (r.wire.c as MsgContent | null)?.reply
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
  // Messages, call rows and pin lines, newest first.
  for (const type of ['msg', 'call', 'pin'] as const) {
    let cursor = await db
      .transaction('events')
      .store.index('room_type_sort')
      .openCursor(sortRange(room, type, opts.before, opts.after), 'prev')
    let n = 0
    while (cursor && n < limit + 1) {
      recs.push(cursor.value)
      n += 1
      cursor = await cursor.continue()
    }
  }
  recs.sort((a, b) => (a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : 0))
  recs.length = Math.min(recs.length, limit + 1)
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
export const MOVING_TEXT =
  'You exported your P2P data to move it. Sending is paused here so nothing is lost.'
export const RESUME_TEXT = 'Messages you send here will not be on the new device.'
export const movedText = (at: number | null) =>
  at === null
    ? MOVED_TEXT
    : `Your P2P identity moved to another device on ${new Date(at).toLocaleDateString()}. This browser can no longer send.`

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
  bulk?: Partial<BulkLimits>
  // Attachments are off (the instance is text only).
  attachments?: () => boolean
  // Free storage for downloads, or null when unknown.
  room?: () => Promise<number | null>
  // Files up to this size are fetched as soon as they arrive (0: never).
  autoMax?: () => number
  // Bytes fetched by themselves per contact per day; past it files wait for a click.
  autoDaily?: () => number
  // Free and total storage for this site, or null when the platform can't tell. Files are only
  // fetched by themselves while at least max(10% of the quota, 512 MiB) stays free.
  space?: () => Promise<{ free: number; quota: number } | null>
}

export const AUTO_DAILY = 1024 ** 3
export const AUTO_FLOOR = 512 * 1024 ** 2
const DAY = 24 * 60 * 60_000

// Why a file that arrived was not fetched by itself.
export type AutoPause = 'daily' | 'space'
export const AUTO_PAUSED_TEXT: Record<AutoPause, string> = {
  daily: 'Auto-download paused for this contact today.',
  space: 'Auto-download paused: storage on this device is getting full.',
}

export class Dms {
  readonly sync: Sync
  readonly blobs: Blobs
  private clock: Clock
  private changeFns = new Set<(room: string) => void>()
  private arriveFns = new Set<(a: Arrival) => void>()
  private typers = new Map<string, { until: number; timer: unknown }>()
  // Files that arrived and wait for a click instead of fetching by themselves, and why.
  readonly paused = new Map<string, AutoPause>()
  // P2P servers add their own serving gate and holders (server.ts).
  moreEntitled: ((ik: string, h: string) => Promise<boolean>) | null = null
  moreHolders: ((h: string) => Promise<string[]>) | null = null
  private autoChain: Promise<unknown> = Promise.resolve()
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
    this.blobs = new Blobs({
      node,
      store: deps.store,
      clock: this.clock,
      limits: deps.bulk,
      entitled: async (ik, h) =>
        (await this.entitled(ik, h)) || ((await this.moreEntitled?.(ik, h)) ?? false),
      members: async h => [
        ...new Set([...(await this.holdersOf(h)), ...((await this.moreHolders?.(h)) ?? [])]),
      ],
      enabled: deps.attachments,
      room: deps.room,
    })
  }

  // The serving gate for files: a mutual contact, in a conversation where a live message carries
  // the file and was not written by them (we sent it there, or someone else did). Their own
  // message never counts, so posting a hash they learned elsewhere gets them nothing, not even
  // whether we have it.
  // One index lookup in our conversation with them (only we and they write there), the same work
  // for any hash, whatever else we hold.
  async entitled(ik: string, h: string) {
    if (this.deps.node.contact(ik)?.state !== 'mutual') return false
    const key = await this.db.getKeyFromIndex(
      'events',
      'file',
      fileKey(this.roomFor(ik), this.me, h)
    )
    return key !== undefined
  }

  // Who may have a file: the other members of the conversations where they sent it to us (they
  // would refuse a message we wrote as their only reason to give it back).
  async holdersOf(h: string) {
    const out = new Set<string>()
    for (const r of await this.db.getAllFromIndex('events', 'att', h)) {
      if (r.redacted || r.sender === this.me) continue
      const room = await this.deps.store.room(r.room)
      if (room && this.deps.node.contact(room.peer)?.state === 'mutual') out.add(room.peer)
    }
    return [...out]
  }

  private async peerOf(room: string) {
    return (await this.deps.store.room(room))?.peer
  }

  // Files of messages that were just deleted go away here too; new files from others are
  // fetched at once when they are small enough.
  private files(added: Inserted[]) {
    // After our own redaction in a conversation, a message its other member wrote doesn't keep
    // the file (they could have planted it just to pin our copy); every other live message does,
    // such as the one we first got it in.
    for (const a of added)
      if (a.status === 'new' && a.freed.length) {
        const run = async () => {
          const peer = a.rec.sender === this.me ? await this.peerOf(a.rec.room) : undefined
          await this.blobs.release(a.freed, peer ? r => r.sender !== peer : undefined)
        }
        void run().catch(() => {})
      }
    const max = this.deps.autoMax?.() ?? 0
    if (max <= 0 || this.deps.attachments?.() === false) return
    for (const a of added) {
      if (a.status !== 'new' || a.rec.sender === this.me || a.rec.type !== 'msg') continue
      const c = a.rec.wire.c as MsgContent | null
      const seen = new Set<string>()
      for (const f of [...(c?.att ?? []), ...(c?.fwd?.att ?? [])]) {
        if (f.size > max || seen.has(f.h)) continue
        seen.add(f.h)
        this.autoFetch(a.rec.sender, f)
      }
    }
  }

  // Queues a file to fetch by itself (one decision at a time, with the daily and storage limits).
  autoFetch(from: string, f: Attachment) {
    this.autoChain = this.autoChain.then(() => this.auto(from, f)).catch(() => {})
  }

  // Fetches a file by itself, one decision at a time: only while enough storage stays free and
  // while this contact's files today stay under the daily limit. Otherwise it waits for a click.
  private async auto(from: string, f: Attachment) {
    const rec = await this.blobs.record(f.h)
    if (rec?.done || rec?.wanted) return
    const space = (await this.deps.space?.()) ?? null
    if (space) {
      const floor = Math.max(space.quota / 10, AUTO_FLOOR)
      if (space.free - this.blobs.reservedBytes() - f.size < floor) return this.pause(f.h, 'space')
    }
    const key = `auto:${from}`
    const day = Math.floor(this.clock.now() / DAY)
    const cur = (await this.db.get('meta', key)) as { day?: unknown; bytes?: unknown } | undefined
    const used = cur?.day === day && Number.isSafeInteger(cur.bytes) ? (cur.bytes as number) : 0
    if (used + f.size > (this.deps.autoDaily?.() ?? AUTO_DAILY)) return this.pause(f.h, 'daily')
    await this.db.put('meta', { day, bytes: used + f.size }, key)
    this.paused.delete(f.h)
    await this.blobs.download(f).catch(() => {})
  }

  private pause(h: string, why: AutoPause) {
    this.paused.set(h, why)
    while (this.paused.size > 1000) this.paused.delete(this.paused.keys().next().value as string)
    this.blobs.touchView(h)
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
    this.files(added)
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
    if (await this.deps.node.sendingPaused()) throw new DmError(MOVING_TEXT)
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
    this.files([res])
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

  async send(room: string, msg: { body: string; reply?: string; fwd?: Fwd; att?: Attachment[] }) {
    const rec = await this.deps.store.room(room)
    const content: MsgContent = { body: msg.body }
    if (msg.reply) content.reply = msg.reply
    if (msg.att?.length) content.att = msg.att
    if (msg.fwd) content.fwd = msg.fwd
    else if (rec && mentionsIn(msg.body, this.mentionNames(rec.peer))) content.mentions = [rec.peer]
    return this.create(room, 'msg', content)
  }

  // The log row of a call we made.
  async logCall(room: string, call: CallContent) {
    return this.create(room, 'call', { ...call })
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

  // Pings marked read one by one (the inbox): off the counter, the read position stays.
  async unping(room: string, n: number) {
    await this.deps.store.updateRoom(room, cur =>
      cur && cur.pings > 0 ? { ...cur, pings: Math.max(0, cur.pings - n) } : null
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
    this.blobs.stop()
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
