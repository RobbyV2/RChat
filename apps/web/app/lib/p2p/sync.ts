import type { Contact } from './contacts'
import { ancestorsAmong, getEvents, insertEvent, vouched, walkBack, type Inserted } from './dag'
import type { EventRecord, P2pStore } from './db'
import { claimedId, redacted, validate, type Devices, type Wire } from './event_v1'
import { isEventId } from './content'
import type { Message } from './frames'
import { LOCAL } from './limits'
import { RateWindow } from './rate'
import type { Clock, Session } from './session'

// The outcome of checking an event from a peer: stored next, refused (a strike), or not stored
// for now (`later`: no strike, it may be fine once we know more).
export type Check =
  | { ok: true; id: string; wire: Wire; revoked: boolean }
  | { ok: false; later: boolean; id: string | null }

export interface Walked {
  events: EventRecord[]
  more: boolean
  // Not now: the requester isn't let in (yet). It asks again when it hears our heads.
  denied?: boolean
}

// How a room kind serves its events. Each is asked for every request, so a gate always applies to
// what is current.
export interface Serving {
  // A walk back over `prev` links (servers: over the ACL DAG, for `state`), oldest first.
  walk: (
    link: Link,
    from: string[],
    have: string[],
    limit: number,
    bytes: number,
    state: boolean
  ) => Promise<Walked>
  get: (link: Link, ids: string[]) => Promise<EventRecord[]>
  // Whether a live event of ours may go to this link.
  push?: (link: Link, wire: Wire) => boolean
}

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
  ...LOCAL.sync,
}

export type SyncLimits = typeof SYNC

export interface SyncDeps {
  store: P2pStore
  clock: Clock
  me: () => string
  devices: (ik: string) => Devices | null
  contact: (ik: string) => Contact | undefined
  // DMs: the room a ready session with a mutual contact links at once. Servers link rooms one by
  // one (gossip.ts) and leave it out.
  roomOf?: (ik: string) => string
  // Message types get this prefix ('' for DMs), so two kinds of rooms share a session.
  prefix?: string
  // Whether the peer of a link may still talk about its room (DMs: a mutual contact).
  allowed?: (link: Link) => boolean
  // DMs strike messages about a room the link isn't for; servers ignore them (a link may have
  // just closed on one side, or the other side's state may lag).
  strict?: boolean
  // Checks an event from a peer (DMs: the two members and their devices).
  check?: (link: Link, raw: unknown) => Promise<Check>
  // Stores a checked event (DMs: insertEvent with the conversation's caps).
  insert?: (link: Link, id: string, wire: Wire, receivedAt: number) => Promise<Inserted>
  serving?: Serving
  // Servers: the ACL heads, sent with `heads` and pulled first, and ACL events we wait for (the
  // missing parents of pending events).
  stateHeads?: (room: string) => Promise<string[]>
  stateWanted?: (room: string) => string[]
  // A peer sent its heads (servers: moderation waits for a fresh exchange, spec 8.2).
  onHeads?: (link: Link) => void
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
  // A walk over the state DAG.
  state: boolean
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
  pushTimes = new RateWindow(60_000, Infinity)
  pulled = 0
  stateTimes = new RateWindow(60_000, Infinity)
  unavailable = new Set<string>()
  // Acked `later` here (a device or a vouching head we don't have yet): asked again once it may
  // be stored.
  later = new Set<string>()
  devices = ''
  peerHeads: string[] = []
  peerState: string[] = []
  // The peer said no to history until it sends heads again.
  held = false
  headsQueued = false
  // When we last answered the peer's request for our heads.
  answeredAt = -Infinity
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

const prevsOf = (w: unknown): string[] => {
  const p = (w as { ev?: { prev?: unknown } } | null)?.ev?.prev
  return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : []
}

const wireSize = (w: unknown) => {
  try {
    return JSON.stringify(w).length
  } catch {
    return Infinity
  }
}

export class Sync {
  readonly limits: SyncLimits
  // Links per session, one per room the session syncs.
  private links = new Map<Session, Map<string, Link>>()
  private headsTimers = new Map<string, unknown>()
  private t: (name: string) => string

  constructor(private deps: SyncDeps) {
    this.limits = { ...SYNC, ...deps.limits }
    const prefix = deps.prefix ?? ''
    this.t = name => prefix + name
  }

  // ----- Sessions -----

  attach(s: Session) {
    s.on(this.t('heads'), m => this.onHeads(m, s))
    s.on(this.t('want'), m => this.onWant(m, s))
    s.on(this.t('get'), m => this.onGet(m, s))
    s.on(this.t('events'), m => this.onEvents(m, s))
    s.on(this.t('push'), m => this.onPush(m, s))
    s.on(this.t('ack'), m => this.onAck(m, s))
    s.on(this.t('typing'), m => this.onTypingMsg(m, s))
  }

  ready(s: Session) {
    const ik = s.remote?.ik
    const { roomOf } = this.deps
    if (!ik || !roomOf || !this.mutual(ik)) return
    this.link(s, roomOf(ik))
  }

  // Starts syncing `room` over a ready session.
  link(s: Session, room: string) {
    const ik = s.remote?.ik
    if (!ik || s.state !== 'ready') return null
    let byRoom = this.links.get(s)
    if (!byRoom) {
      byRoom = new Map()
      this.links.set(s, byRoom)
      s.onClose(() => this.drop(s))
    }
    const have = byRoom.get(room)
    if (have) return have
    const link = new Link(s, ik, room)
    byRoom.set(room, link)
    void this.sendHeads(link)
    return link
  }

  unlink(s: Session, room: string) {
    const link = this.links.get(s)?.get(room)
    if (link) this.close(link)
  }

  private close(link: Link) {
    if (link.closed) return
    link.closed = true
    if (link.headsTimer !== null) this.deps.clock.clear(link.headsTimer)
    if (link.peerFull !== null) this.deps.clock.clear(link.peerFull)
    const byRoom = this.links.get(link.session)
    byRoom?.delete(link.room)
    if (byRoom && !byRoom.size) this.links.delete(link.session)
    this.deps.onTyping(link.room, link.ik, false)
    this.deps.onState?.(link.room)
  }

  private drop(s: Session) {
    for (const link of [...(this.links.get(s)?.values() ?? [])]) this.close(link)
    this.links.delete(s)
  }

  linksOf(room: string) {
    const out: Link[] = []
    for (const byRoom of this.links.values()) {
      const l = byRoom.get(room)
      if (l && !l.closed) out.push(l)
    }
    return out
  }

  // The links of a session.
  linksOn(s: Session) {
    return [...(this.links.get(s)?.values() ?? [])].filter(l => !l.closed)
  }

  linkOf(s: Session, room?: string) {
    const byRoom = this.links.get(s)
    if (!byRoom) return undefined
    return room === undefined ? byRoom.values().next().value : byRoom.get(room)
  }

  online(room: string) {
    return this.linksOf(room).length > 0
  }

  private mutual(ik: string) {
    return this.deps.contact(ik)?.state === 'mutual'
  }

  private allowed(link: Link) {
    return this.deps.allowed ? this.deps.allowed(link) : this.mutual(link.ik)
  }

  private strict() {
    return this.deps.strict ?? true
  }

  // The link for a message from `s`, or null when it may not talk about `room` (a strike for
  // DMs).
  private linkFor(s: Session, room: unknown): Link | null {
    const byRoom = this.links.get(s)
    if (!byRoom) return null
    const link = typeof room === 'string' ? byRoom.get(room) : undefined
    if (!link || link.closed || !this.allowed(link)) {
      if (this.strict()) s.strike()
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

  private async sendHeads(link: Link, ask = false) {
    const room = await this.deps.store.room(link.room)
    const msg: Message = {
      t: this.t('heads'),
      room: link.room,
      heads: (room?.heads ?? []).map(h => h.id).slice(0, this.limits.headsMax),
    }
    if (ask) msg.ask = true
    if (this.deps.stateHeads)
      msg.state = (await this.deps.stateHeads(link.room)).slice(0, this.limits.headsMax)
    this.send(link, msg)
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

  // Asks every peer of the room for its heads now (a fresh exchange), sending ours.
  exchange(room: string) {
    for (const l of this.linksOf(room)) void this.sendHeads(l, true)
  }

  private onHeads(m: Message, s: Session) {
    const link = this.linkFor(s, m.room)
    if (!link) return
    const heads = strArray(m.heads, this.limits.headsMax, isEventId)
    const state = m.state === undefined ? [] : strArray(m.state, this.limits.headsMax, isEventId)
    if (!heads || !state) return s.strike()
    link.peerHeads = heads
    link.peerState = state
    link.held = false
    // Asked for ours: answered at most once per headsAnswerMs per link.
    const now = this.deps.clock.now()
    if (m.ask === true && now - link.answeredAt >= this.limits.headsAnswerMs) {
      link.answeredAt = now
      void this.sendHeads(link)
    }
    this.deps.onHeads?.(link)
    // One check at a time: a burst of heads frames costs one walk, with the newest heads.
    if (link.headsQueued) return
    link.headsQueued = true
    this.queue(link, 64 * heads.length, async () => {
      link.headsQueued = false
      await this.checkDelivered(link, [...link.peerHeads, ...link.peerState])
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
  private pull(link: Link, from: string[], state = false) {
    if (link.closed || link.requests.size >= this.limits.requests) return
    if ([...link.requests.values()].some(r => r.kind === 'want')) return
    if (!state && link.pulled >= this.limits.horizon) return this.deps.onState?.(link.room)
    const ids = from.slice(0, this.limits.fromMax)
    if (!ids.length) return
    const rid = ++link.rid
    const limit = state
      ? this.limits.wantLimit
      : Math.min(this.limits.wantLimit, this.limits.horizon - link.pulled)
    link.requests.set(rid, {
      kind: 'want',
      room: link.room,
      from: ids,
      limit,
      answered: false,
      state,
    })
    const send = async () => {
      const room = await this.deps.store.room(link.room)
      const have = state
        ? ((await this.deps.stateHeads?.(link.room)) ?? [])
        : (room?.heads ?? []).map(h => h.id)
      const msg: Message = {
        t: this.t('want'),
        rid,
        room: link.room,
        from: ids,
        have: have.slice(0, this.limits.fromMax),
        limit,
      }
      if (state) msg.state = true
      this.send(link, msg)
    }
    void send().catch(() => {})
    this.deps.onState?.(link.room)
  }

  // Events acked `later` that may be stored now: a stored child vouches for them, or the
  // contact's devices changed.
  private retryLater(link: Link, ids: Iterable<string>) {
    for (const id of ids) if (link.later.delete(id)) link.unavailable.delete(id)
  }

  // What the peer has and we don't: its heads, and parents we miss. Ask for them, unless this
  // peer already said it has none of them.
  private async fillGaps(link: Link) {
    if (!this.deps.check) {
      const d = this.deps.devices(link.ik)
      const key = d ? `${d.certs.map(c => c.dk).join()};${d.revocations.length}` : ''
      if (key !== link.devices) {
        link.devices = key
        this.retryLater(link, [...link.later])
      }
    }
    const room = await this.deps.store.room(link.room)
    // Nothing more can be stored: asking would only bring refusals.
    if (room?.full || this.deps.quotaFull?.()) return
    if (this.deps.stateHeads) {
      const ask = [...new Set([...link.peerState, ...(this.deps.stateWanted?.(link.room) ?? [])])]
      const have = new Set((await getEvents(this.deps.store.db, link.room, ask)).map(r => r.id))
      const state = ask.filter(h => !have.has(h) && !link.unavailable.has(h))
      if (state.length) return this.pull(link, state, true)
    }
    if (link.held) return
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

  // Asks one peer of the room for events by id that it hasn't said it lacks (bodies we want back,
  // spec 4.3); what comes is checked and stored like any answer. False: no peer to ask now.
  fetch(room: string, ids: string[]) {
    for (const link of this.linksOf(room)) {
      if (link.closed || link.requests.size >= this.limits.requests) continue
      const want = ids.filter(id => !link.unavailable.has(id)).slice(0, this.limits.getIds)
      if (!want.length) continue
      const rid = ++link.rid
      link.requests.set(rid, {
        kind: 'get',
        room,
        from: want,
        limit: want.length,
        answered: false,
        state: false,
      })
      this.send(link, { t: this.t('get'), rid, room, ids: want })
      return true
    }
    return false
  }

  // We may be sent more now (a channel we may view): ask again for what peers didn't send.
  retryGaps(room: string) {
    for (const link of this.linksOf(room)) {
      link.unavailable.clear()
      void this.fillGaps(link)
    }
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

  // A walk over the ACL DAG is under way (servers: sync progress, spec 9 rule 19).
  pullingState(room: string) {
    return this.linksOf(room).some(l => [...l.requests.values()].some(r => r.state))
  }

  // Missing history that a peer could still send if asked.
  horizonReached(room: string) {
    return this.linksOf(room).some(l => l.pulled >= this.limits.horizon)
  }

  private onEvents(m: Message, s: Session) {
    const link = typeof m.room === 'string' ? this.links.get(s)?.get(m.room) : undefined
    if (!link || link.closed) return this.strict() ? s.strike() : undefined
    const rid = m.rid
    const req = isRid(rid) ? link.requests.get(rid) : undefined
    const evs = Array.isArray(m.evs) ? m.evs : null
    // Only answers we asked for, once, within the size we granted.
    if (!req || req.answered || m.room !== req.room || !evs || evs.length > req.limit)
      return s.strike()
    const bytes = wireSize(evs)
    if (bytes > this.limits.responseBytes + 4096) return s.strike()
    req.answered = true
    if (!req.state) link.pulled += evs.length
    const more = m.more === true
    const denied = m.denied === true && evs.length === 0
    if (denied) link.held = true
    this.queue(link, bytes, async () => {
      try {
        if (req.state) await this.stateRate(link, evs.length)
        const added = await this.ingest(link, evs)
        if (!denied && (evs.length === 0 || (!more && added === 0)))
          for (const id of req.from) link.unavailable.add(id)
      } finally {
        link.requests.delete(rid as number)
      }
      await this.fillGaps(link)
      this.deps.onState?.(link.room)
    })
  }

  // DMs: the two members and their devices.
  private async checkDm(link: Link, r: unknown): Promise<Check> {
    const v = validate(r, {
      room: link.room,
      members: [this.deps.me(), link.ik],
      devices: (ik: string) => this.deps.devices(ik),
    })
    if (v.ok) return v
    const id = claimedId(r)
    const sender = (r as { ev?: { sender?: unknown } }).ev?.sender
    // A device of the contact we don't know yet (a move whose cert hasn't reached us): not their
    // fault, and it may be fine once we know it.
    return { ok: false, later: v.why === 'device' && sender === link.ik, id }
  }

  private insertDm(link: Link, id: string, wire: Wire, now: number) {
    return insertEvent(this.deps.store.db, id, wire, now, {
      me: this.deps.me(),
      peer: link.ik,
      roomCap: this.deps.roomCap,
      totalCap: this.deps.totalCap,
      roomBytes: this.deps.roomBytes,
      totalBytes: this.deps.totalBytes,
    })
  }

  // Validates and stores events from a peer. Every invalid one is a strike. The ack says what
  // was stored (`ids`), refused for good (`drop`), refused for lack of space (`full`), and not
  // stored for now (`later`); all of them leave the sender's push window.
  private async ingest(link: Link, raw: unknown[]): Promise<number> {
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
      let v: Check
      try {
        v = this.deps.check ? await this.deps.check(link, r) : await this.checkDm(link, r)
      } catch {
        v = { ok: false, later: true, id: claimedId(r) }
      }
      if (!v.ok) {
        if (v.later) {
          if (v.id) later.push(v.id)
          if (v.id) link.later.add(v.id)
          continue
        }
        link.session.strike()
        if (v.id) {
          refused.push(v.id)
          link.unavailable.add(v.id)
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
          link.later.add(v.id)
          continue
        }
      }
      let res: Inserted
      try {
        res = this.deps.insert
          ? await this.deps.insert(link, v.id, v.wire, now)
          : await this.insertDm(link, v.id, v.wire, now)
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
      } else if (res.status === 'rejected') {
        refused.push(v.id)
        link.unavailable.add(v.id)
      } else if (res.status === 'full') {
        full.push(v.id)
        this.deps.onState?.(link.room)
      } else if (res.status === 'quota') {
        // Past its sender's share here: not this peer's fault, and no reason to stop pushing.
        later.push(v.id)
      } else {
        acks.push(v.id)
        if (res.status === 'new') {
          added.push(res)
          this.retryLater(link, prevsOf(v.wire))
        }
      }
    }
    if (added.length && !quota) this.deps.onQuota?.(false)
    const max = this.limits.acksMax
    for (let i = 0; i < acks.length; i += max)
      this.send(link, { t: this.t('ack'), room: link.room, ids: acks.slice(i, i + max) })
    if (refused.length || full.length || later.length) {
      const msg: Message = { t: this.t('ack'), room: link.room, ids: [] }
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

  private serve(link: Link, rid: unknown, fn: () => Promise<Walked>) {
    if (!isRid(rid)) return link.session.strike()
    if (link.serving >= this.limits.requests) return link.session.strike()
    link.serving += 1
    this.queue(link, 256, async () => {
      try {
        const { events, more, denied } = await fn()
        this.send(link, {
          t: this.t('events'),
          rid,
          room: link.room,
          evs: events.map(e => e.wire),
          more,
          ...(denied ? { denied: true } : {}),
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
    const state = m.state === true
    const bytes = this.limits.responseBytes
    this.serve(link, m.rid, () =>
      this.deps.serving
        ? this.deps.serving.walk(link, from, have, limit, bytes, state)
        : walkBack(this.deps.store.db, link.room, from, have, limit, bytes)
    )
  }

  private onGet(m: Message, s: Session) {
    const link = this.linkFor(s, m.room)
    if (!link) return
    const ids = strArray(m.ids, this.limits.getIds, isEventId)
    if (!ids) return s.strike()
    this.serve(link, m.rid, async () => {
      const found = this.deps.serving
        ? await this.deps.serving.get(link, ids)
        : await getEvents(this.deps.store.db, link.room, ids)
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
      if (this.deps.serving?.push && !this.deps.serving.push(link, wire)) continue
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
      if (this.deps.serving?.push && !this.deps.serving.push(link, wire)) continue
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
      this.send(link, { t: this.t('push'), room: link.room, ev: next.wire })
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

  // Past statePerMin pulled state events a minute, the next answer waits.
  private async stateRate(link: Link, n: number) {
    const { clock } = this.deps
    for (;;) {
      const now = clock.now()
      const used = link.stateTimes.count(now)
      if (used + n <= this.limits.statePerMin || !link.stateTimes.times.length || link.closed) break
      const wait = 60_000 - (now - link.stateTimes.oldest()!) + 1
      await new Promise<void>(resolve => clock.set(resolve, wait))
    }
    link.stateTimes.note(clock.now(), n)
  }

  // Past pushPerMin live events a minute, the next one waits; its ack (and so the sender's
  // window) waits with it.
  private async pushRate(link: Link) {
    const { clock } = this.deps
    for (;;) {
      const now = clock.now()
      if (link.pushTimes.count(now) < this.limits.pushPerMin || link.closed) break
      const wait = 60_000 - (now - link.pushTimes.oldest()!) + 1
      await new Promise<void>(resolve => clock.set(resolve, wait))
    }
    link.pushTimes.note(clock.now())
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
        // What was acked `full` left the window: the peer pulls it once it hears our heads.
        void this.sendHeads(link)
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
    for (const link of this.linksOf(room)) this.send(link, { t: this.t('typing'), room, on })
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
    this.links.clear()
  }
}
