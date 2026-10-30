import type { Contact } from './contacts'
import { ancestorsAmong, getEvents, insertEvent, vouched, walkBack, type Inserted } from './dag'
import type { EventRecord, P2pStore } from './db'
import { claimedId, isEventId, redacted, validate, type Devices, type Wire } from './event'
import type { Message } from './frames'
import type { Clock, Session } from './session'

// Room sync over a session (note section 5): `heads` announces the frontier, `want` and `get`
// pull what is missing, `push` carries live events, `ack` confirms what was stored (delivery).
// Flow control is credit based on both sides: we keep at most `requests` pulls outstanding, each
// answer is capped at `responseBytes`, and live pushes wait for acks once `pushBytes` are in
// flight. A peer that sends more than it was granted is struck, never queued without bound.

export const SYNC = {
  requests: 4,
  responseBytes: 192 * 1024,
  wantLimit: 200,
  getIds: 100,
  fromMax: 20,
  headsMax: 50,
  acksMax: 200,
  pushEvents: 16,
  pushBytes: 256 * 1024,
  // What a peer may have queued with us before it counts as flooding.
  pushQueueEvents: 64,
  pushQueueBytes: 512 * 1024,
  pushPerMin: 600,
  // Events pulled per session before older history waits for "Load older".
  horizon: 2000,
  headsDebounceMs: 250,
  typingMs: 8000,
  // Delivery checks against the peer's heads walk at most this far.
  deliveredWalk: 500,
  // After the other side said its storage is full, live pushes pause this long.
  peerFullMs: 10 * 60_000,
}

export type SyncLimits = typeof SYNC

export interface SyncDeps {
  store: P2pStore
  clock: Clock
  me: () => string
  devices: (ik: string) => Devices | null
  contact: (ik: string) => Contact | undefined
  roomOf: (ik: string) => string
  // Events stored from a peer (new ones only).
  onStored: (room: string, from: string, added: Inserted[]) => void
  onDelivered: (room: string, ids: string[]) => void
  onTyping: (room: string, ik: string, on: boolean) => void
  // Called when a room's sync state changes (gaps, outstanding pulls).
  onState?: (room: string) => void
  limits?: Partial<SyncLimits>
  roomCap?: number
  totalCap?: number
  roomBytes?: number
  totalBytes?: number
  // The browser refused to store more (quota): true when it happens, false once a write works.
  onQuota?: (full: boolean) => void
  quotaFull?: () => boolean
  // Runs before each batch is stored; lets a test stand in for a slow device.
  pace?: () => Promise<void>
}

export const isQuotaError = (e: unknown) =>
  typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'QuotaExceededError'

interface Request {
  kind: 'want' | 'get'
  room: string
  from: string[]
  limit: number
  // The answer came and waits to be stored; the credit returns once it is.
  answered: boolean
}

interface Pushed {
  id: string
  bytes: number
}

export class Link {
  work: Promise<void> = Promise.resolve()
  // Bytes of received sync messages waiting for or in processing.
  backlog = 0
  maxBacklog = 0
  requests = new Map<number, Request>()
  serving = 0
  inFlight: Pushed[] = []
  waiting: { id: string; wire: Wire }[] = []
  theirPushes = 0
  theirPushBytes = 0
  pushTimes: number[] = []
  pulled = 0
  unavailable = new Set<string>()
  peerHeads: string[] = []
  headsQueued = false
  rid = 0
  headsTimer: unknown = null
  // The other side said its storage is full: no live pushes until peerFullMs passed.
  peerFull: unknown = null
  closed = false

  constructor(
    readonly session: Session,
    readonly ik: string,
    readonly room: string
  ) {}
}

const strArray = (x: unknown, max: number, ok: (v: unknown) => boolean): string[] | null =>
  Array.isArray(x) && x.length <= max && x.every(ok) ? (x as string[]) : null

const isRid = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) > 0

const wireSize = (w: unknown) => {
  try {
    return JSON.stringify(w).length
  } catch {
    return Infinity
  }
}

export class Sync {
  readonly limits: SyncLimits
  private links = new Map<Session, Link>()
  private headsTimers = new Map<string, unknown>()

  constructor(private deps: SyncDeps) {
    this.limits = { ...SYNC, ...deps.limits }
  }

  // ----- Sessions -----

  attach(s: Session) {
    s.on('heads', m => this.onHeads(m, s))
    s.on('want', m => this.onWant(m, s))
    s.on('get', m => this.onGet(m, s))
    s.on('events', m => this.onEvents(m, s))
    s.on('push', m => this.onPush(m, s))
    s.on('ack', m => this.onAck(m, s))
    s.on('typing', m => this.onTypingMsg(m, s))
  }

  ready(s: Session) {
    const ik = s.remote?.ik
    if (!ik || !this.mutual(ik)) return
    const link = new Link(s, ik, this.deps.roomOf(ik))
    this.links.set(s, link)
    s.onClose(() => this.drop(s))
    void this.sendHeads(link)
  }

  private drop(s: Session) {
    const link = this.links.get(s)
    if (!link) return
    link.closed = true
    if (link.headsTimer !== null) this.deps.clock.clear(link.headsTimer)
    if (link.peerFull !== null) this.deps.clock.clear(link.peerFull)
    this.links.delete(s)
    this.deps.onTyping(link.room, link.ik, false)
    this.deps.onState?.(link.room)
  }

  linksOf(room: string) {
    return [...this.links.values()].filter(l => l.room === room && !l.closed)
  }

  linkOf(s: Session) {
    return this.links.get(s)
  }

  online(room: string) {
    return this.linksOf(room).length > 0
  }

  private mutual(ik: string) {
    return this.deps.contact(ik)?.state === 'mutual'
  }

  // The link for a message from `s`, or null (and a strike) when it may not talk about `room`.
  private linkFor(s: Session, room: unknown): Link | null {
    const link = this.links.get(s)
    if (!link || link.closed) return null
    if (room !== link.room || !this.mutual(link.ik)) {
      s.strike()
      return null
    }
    return link
  }

  private queue(link: Link, bytes: number, fn: () => Promise<void>) {
    link.backlog += bytes
    link.maxBacklog = Math.max(link.maxBacklog, link.backlog + link.session.queued)
    link.work = link.work
      .then(() => (link.closed ? undefined : fn()))
      .catch(() => {})
      .finally(() => {
        link.backlog -= bytes
      })
  }

  private send(link: Link, msg: Message) {
    if (link.closed) return
    void link.session.send(msg).catch(() => {})
  }

  // ----- Heads -----

  private async sendHeads(link: Link) {
    const room = await this.deps.store.room(link.room)
    this.send(link, {
      t: 'heads',
      room: link.room,
      heads: (room?.heads ?? []).map(h => h.id).slice(0, this.limits.headsMax),
    })
  }

  // After new events, every session of the room hears the new frontier (debounced).
  announce(room: string) {
    if (this.headsTimers.has(room)) return
    this.headsTimers.set(
      room,
      this.deps.clock.set(() => {
        this.headsTimers.delete(room)
        for (const l of this.linksOf(room)) void this.sendHeads(l)
      }, this.limits.headsDebounceMs)
    )
  }

  private onHeads(m: Message, s: Session) {
    const link = this.linkFor(s, m.room)
    if (!link) return
    const heads = strArray(m.heads, this.limits.headsMax, isEventId)
    if (!heads) return s.strike()
    link.peerHeads = heads
    // One check at a time: a burst of heads frames costs one walk, with the newest heads.
    if (link.headsQueued) return
    link.headsQueued = true
    this.queue(link, 64 * heads.length, async () => {
      link.headsQueued = false
      await this.checkDelivered(link, link.peerHeads)
      await this.fillGaps(link)
    })
  }

  private async checkDelivered(link: Link, heads: string[]) {
    const pending = (await this.deps.store.outbox(link.room)).filter(
      o => !o.deliveredTo.includes(link.ik)
    )
    if (!pending.length) return
    const found = await ancestorsAmong(
      this.deps.store.db,
      link.room,
      heads,
      new Set(pending.map(o => o.id)),
      this.limits.deliveredWalk
    )
    if (found.size) await this.delivered(link, [...found])
  }

  private async delivered(link: Link, ids: string[]) {
    const tx = this.deps.store.db.transaction('outbox', 'readwrite')
    const marked: string[] = []
    for (const id of ids) {
      const o = await tx.store.get(id)
      if (o && o.room === link.room && !o.deliveredTo.includes(link.ik)) {
        await tx.store.put({ ...o, deliveredTo: [...o.deliveredTo, link.ik] })
        marked.push(id)
      }
    }
    await tx.done
    if (marked.length) this.deps.onDelivered(link.room, marked)
  }

  // ----- Pulling -----

  // One walk back at a time: the next one starts from what is still missing, so answers don't
  // overlap.
  private pull(link: Link, from: string[]) {
    if (link.closed || link.requests.size >= this.limits.requests) return
    if ([...link.requests.values()].some(r => r.kind === 'want')) return
    if (link.pulled >= this.limits.horizon) return this.deps.onState?.(link.room)
    const ids = from.slice(0, this.limits.fromMax)
    if (!ids.length) return
    const rid = ++link.rid
    const limit = Math.min(this.limits.wantLimit, this.limits.horizon - link.pulled)
    link.requests.set(rid, { kind: 'want', room: link.room, from: ids, limit, answered: false })
    void this.deps.store.room(link.room).then(room =>
      this.send(link, {
        t: 'want',
        rid,
        room: link.room,
        from: ids,
        have: (room?.heads ?? []).map(h => h.id).slice(0, this.limits.fromMax),
        limit,
      })
    )
    this.deps.onState?.(link.room)
  }

  // What the peer has and we don't: its heads, and parents we miss. Ask for them, unless this
  // peer already said it has none of them.
  private async fillGaps(link: Link) {
    const room = await this.deps.store.room(link.room)
    // Nothing more can be stored: asking would only bring refusals.
    if (room?.full || this.deps.quotaFull?.()) return
    const known = new Set(
      (await getEvents(this.deps.store.db, link.room, link.peerHeads)).map(r => r.id)
    )
    const want = [...link.peerHeads.filter(h => !known.has(h)), ...(room?.missing ?? [])].filter(
      id => !link.unavailable.has(id)
    )
    if (want.length) this.pull(link, [...new Set(want)])
    // Caught up: the horizon counts history again from here, not live catch-ups.
    else if (!room?.missing.length) link.pulled = 0
  }

  // "Load older": one more horizon of history from whoever is online.
  loadOlder(room: string) {
    for (const link of this.linksOf(room)) {
      link.pulled = 0
      link.unavailable.clear()
      void this.fillGaps(link)
    }
  }

  pulling(room: string) {
    return this.linksOf(room).some(l => l.requests.size > 0)
  }

  // Missing history that a peer could still send if asked.
  horizonReached(room: string) {
    return this.linksOf(room).some(l => l.pulled >= this.limits.horizon)
  }

  private onEvents(m: Message, s: Session) {
    const link = this.links.get(s)
    if (!link || link.closed) return
    const rid = m.rid
    const req = isRid(rid) ? link.requests.get(rid) : undefined
    const evs = Array.isArray(m.evs) ? m.evs : null
    // Only answers we asked for, once, within the size we granted.
    if (!req || req.answered || m.room !== req.room || !evs || evs.length > req.limit)
      return s.strike()
    const bytes = wireSize(evs)
    if (bytes > this.limits.responseBytes + 4096) return s.strike()
    req.answered = true
    link.pulled += evs.length
    const more = m.more === true
    this.queue(link, bytes, async () => {
      try {
        const added = await this.ingest(link, evs)
        if (evs.length === 0 || (!more && added === 0))
          for (const id of req.from) link.unavailable.add(id)
      } finally {
        link.requests.delete(rid as number)
      }
      await this.fillGaps(link)
      this.deps.onState?.(link.room)
    })
  }

  // Validates and stores events from a peer. Every invalid one is a strike. The ack says what
  // was stored (`ids`), refused for good (`drop`), refused for lack of space (`full`), and not
  // stored for now (`later`); all of them leave the sender's push window.
  private async ingest(link: Link, raw: unknown[]): Promise<number> {
    const me = this.deps.me()
    const auth = {
      room: link.room,
      members: [me, link.ik],
      devices: (ik: string) => this.deps.devices(ik),
    }
    await this.deps.pace?.()
    const added: Inserted[] = []
    const acks: string[] = []
    const refused: string[] = []
    const full: string[] = []
    const later: string[] = []
    let quota = false
    const now = this.deps.clock.now()
    const db = this.deps.store.db
    for (const r of raw) {
      if (link.closed) break
      const v = validate(r, auth)
      if (!v.ok) {
        const id = claimedId(r)
        const sender = (r as { ev?: { sender?: unknown } }).ev?.sender
        // A device of the contact we don't know yet (a move whose cert hasn't reached us):
        // not their fault, and it may be fine once we know it.
        if (v.why === 'device' && sender === link.ik) {
          if (id) later.push(id)
          continue
        }
        link.session.strike()
        if (id) {
          refused.push(id)
          link.unavailable.add(id)
        }
        continue
      }
      if (quota) {
        full.push(v.id)
        continue
      }
      // A since-revoked device with a time before its revocation: kept only when we have it
      // or a good device of the sender built on it. Otherwise it may be backdated.
      if (v.revoked && !(await this.deps.store.event(v.id))) {
        const revs = this.deps.devices(v.wire.ev.sender)?.revocations ?? []
        const good = (dev: string) => !revs.some(x => x.dk === dev)
        if (!(await vouched(db, link.room, v.id, v.wire.ev.sender, good))) {
          later.push(v.id)
          continue
        }
      }
      let res: Inserted
      try {
        res = await insertEvent(db, v.id, v.wire, now, {
          me,
          peer: link.ik,
          roomCap: this.deps.roomCap,
          totalCap: this.deps.totalCap,
          roomBytes: this.deps.roomBytes,
          totalBytes: this.deps.totalBytes,
        })
      } catch (e) {
        if (!isQuotaError(e)) {
          later.push(v.id)
          continue
        }
        this.deps.onQuota?.(true)
        quota = true
        full.push(v.id)
        continue
      }
      if (res.status === 'invalid') {
        link.session.strike()
        refused.push(v.id)
        link.unavailable.add(v.id)
      } else if (res.status === 'full') {
        full.push(v.id)
        this.deps.onState?.(link.room)
      } else {
        acks.push(v.id)
        if (res.status === 'new') added.push(res)
      }
    }
    if (added.length && !quota) this.deps.onQuota?.(false)
    const max = this.limits.acksMax
    for (let i = 0; i < acks.length; i += max)
      this.send(link, { t: 'ack', room: link.room, ids: acks.slice(i, i + max) })
    if (refused.length || full.length || later.length) {
      const msg: Message = { t: 'ack', room: link.room, ids: [] }
      if (refused.length) msg.drop = refused.slice(0, max)
      if (full.length) msg.full = full.slice(0, max)
      if (later.length) msg.later = later.slice(0, max)
      this.send(link, msg)
    }
    if (added.length) {
      link.session.useful()
      this.deps.onStored(link.room, link.ik, added)
      this.announce(link.room)
    }
    return added.length
  }

  // ----- Serving -----

  private serve(
    link: Link,
    rid: unknown,
    fn: () => Promise<{ events: EventRecord[]; more: boolean }>
  ) {
    if (!isRid(rid)) return link.session.strike()
    if (link.serving >= this.limits.requests) return link.session.strike()
    link.serving += 1
    this.queue(link, 256, async () => {
      try {
        const { events, more } = await fn()
        this.send(link, {
          t: 'events',
          rid,
          room: link.room,
          evs: events.map(e => e.wire),
          more,
        })
        if (events.length) link.session.useful()
      } finally {
        link.serving -= 1
      }
    })
  }

  private onWant(m: Message, s: Session) {
    const link = this.linkFor(s, m.room)
    if (!link) return
    const from = strArray(m.from, this.limits.fromMax, isEventId)
    const have = strArray(m.have, this.limits.fromMax, isEventId)
    const limit = Number.isSafeInteger(m.limit)
      ? Math.min(m.limit as number, this.limits.wantLimit)
      : -1
    if (!from || !have || limit < 1) return s.strike()
    this.serve(link, m.rid, () =>
      walkBack(this.deps.store.db, link.room, from, have, limit, this.limits.responseBytes)
    )
  }

  private onGet(m: Message, s: Session) {
    const link = this.linkFor(s, m.room)
    if (!link) return
    const ids = strArray(m.ids, this.limits.getIds, isEventId)
    if (!ids) return s.strike()
    this.serve(link, m.rid, async () => {
      const found = await getEvents(this.deps.store.db, link.room, ids)
      const out: EventRecord[] = []
      let size = 0
      for (const r of found) {
        const n = wireSize(r.wire)
        if (out.length && size + n > this.limits.responseBytes) return { events: out, more: true }
        size += n
        out.push(r)
      }
      return { events: out, more: false }
    })
  }

  // ----- Live -----

  // A new event of ours: to every session of its room, as far as their windows allow.
  push(room: string, id: string, wire: Wire) {
    for (const link of this.linksOf(room)) {
      link.waiting.push({ id, wire })
      this.pump(link)
    }
  }

  // A message deleted before it went out: what still waits goes without its content.
  redactWaiting(room: string, id: string) {
    for (const link of this.linksOf(room))
      link.waiting = link.waiting.map(w => (w.id === id ? { id, wire: redacted(w.wire) } : w))
  }

  // Retry: a failed event goes out again on every session of its room.
  resend(room: string, id: string, wire: Wire) {
    for (const link of this.linksOf(room)) {
      if (link.waiting.some(w => w.id === id) || link.inFlight.some(p => p.id === id)) continue
      link.waiting.push({ id, wire })
      this.pump(link)
    }
  }

  peerFull(room: string) {
    return this.linksOf(room).some(l => l.peerFull !== null)
  }

  private pump(link: Link) {
    while (link.waiting.length && !link.closed && link.peerFull === null) {
      const bytes = link.inFlight.reduce((n, p) => n + p.bytes, 0)
      const next = link.waiting[0]
      const size = wireSize(next.wire)
      if (
        link.inFlight.length >= this.limits.pushEvents ||
        (link.inFlight.length > 0 && bytes + size > this.limits.pushBytes)
      )
        return
      link.waiting.shift()
      link.inFlight.push({ id: next.id, bytes: size })
      this.send(link, { t: 'push', room: link.room, ev: next.wire })
    }
  }

  private onPush(m: Message, s: Session) {
    const link = this.linkFor(s, m.room)
    if (!link) return
    const bytes = wireSize(m.ev)
    if (
      link.theirPushes + 1 > this.limits.pushQueueEvents ||
      link.theirPushBytes + bytes > this.limits.pushQueueBytes
    )
      return s.strike()
    link.theirPushes += 1
    link.theirPushBytes += bytes
    this.queue(link, bytes, async () => {
      try {
        await this.pushRate(link)
        await this.ingest(link, [m.ev])
        await this.fillGaps(link)
      } finally {
        link.theirPushes -= 1
        link.theirPushBytes -= bytes
      }
    })
  }

  // Past pushPerMin live events a minute, the next one waits; its ack (and so the sender's
  // window) waits with it.
  private async pushRate(link: Link) {
    const { clock } = this.deps
    for (;;) {
      const now = clock.now()
      link.pushTimes = link.pushTimes.filter(t => now - t < 60_000)
      if (link.pushTimes.length < this.limits.pushPerMin || link.closed) break
      const wait = 60_000 - (now - link.pushTimes[0]) + 1
      await new Promise<void>(resolve => clock.set(resolve, wait))
    }
    link.pushTimes.push(clock.now())
  }

  private onAck(m: Message, s: Session) {
    const link = this.linkFor(s, m.room)
    if (!link) return
    const list = (x: unknown) =>
      x === undefined ? [] : strArray(x, this.limits.acksMax, isEventId)
    const ids = list(m.ids)
    const drop = list(m.drop)
    const full = list(m.full)
    const later = list(m.later)
    if (m.ids === undefined || !ids || !drop || !full || !later) return s.strike()
    const set = new Set([...ids, ...drop, ...full, ...later])
    link.inFlight = link.inFlight.filter(p => !set.has(p.id))
    if (full.length && link.peerFull === null) {
      // Their storage is full: stop pushing for a while; what waits stays in the outbox.
      link.peerFull = this.deps.clock.set(() => {
        link.peerFull = null
        this.pump(link)
      }, this.limits.peerFullMs)
    }
    this.pump(link)
    this.queue(link, 64, async () => {
      await this.delivered(link, ids)
      if (drop.length) await this.failed(link, drop)
      if (full.length || ids.length) await this.notePeerFull(link, full.length > 0)
    })
  }

  // Events the other side refused for good: they show as failed, with Retry and Delete.
  private async failed(link: Link, ids: string[]) {
    const tx = this.deps.store.db.transaction('outbox', 'readwrite')
    let marked = false
    for (const id of ids) {
      const o = await tx.store.get(id)
      if (o && o.room === link.room && !o.deliveredTo.includes(link.ik) && !o.failed) {
        await tx.store.put({ ...o, failed: true })
        marked = true
      }
    }
    await tx.done
    if (marked) this.deps.onState?.(link.room)
  }

  private async notePeerFull(link: Link, full: boolean) {
    const now = this.deps.clock.now()
    const before = await this.deps.store.room(link.room)
    if (!before || !!before.peerFull === full) return
    await this.deps.store.updateRoom(link.room, cur =>
      cur && !!cur.peerFull !== full ? { ...cur, peerFull: full ? now : null } : null
    )
    this.deps.onState?.(link.room)
  }

  // ----- Typing -----

  typing(room: string, on: boolean) {
    for (const link of this.linksOf(room)) this.send(link, { t: 'typing', room, on })
  }

  private onTypingMsg(m: Message, s: Session) {
    const link = this.linkFor(s, m.room)
    if (!link) return
    if (typeof m.on !== 'boolean') return s.strike()
    this.deps.onTyping(link.room, link.ik, m.on)
  }

  stop() {
    for (const t of this.headsTimers.values()) this.deps.clock.clear(t)
    this.headsTimers.clear()
    for (const s of [...this.links.keys()]) this.drop(s)
  }
}
