import { DENIED_CALL, type Resolved } from '../relays'
import type { RtcTarget } from '../rtc'
import type { RtcPayload } from '../types'
import { b64u, randomBytes } from './canonical'
import { CALL_ID_LEN, type CallContent, type CallOutcome } from './event'
import type { Message } from './frames'
import { LOCAL } from './limits'
import type { MissedCall } from './dm'
import { realClock, type Clock, type Session } from './session'
import {
  P2pSignaler,
  readCallFrame,
  readRtcFrame,
  type CallFrame,
  type CallOp,
  type RtcFrame,
} from './signal'

// Voice and video calls with a contact (Task 21). Media runs through rtc.ts like an instance
// call; everything that sets it up rides the encrypted session with the contact. A call is bound
// to the conversation's room, both identities and, once answered, the one device that answered.
// Only the tab that runs P2P (the leader) has a node, so only it rings and handles calls.

export const RING_MS = LOCAL.calls.ringMs
// The callee gives up a moment after the caller would have.
export const RING_GRACE_MS = LOCAL.calls.ringGraceMs
// Rings per contact per minute; more are dropped without an answer.
export const RINGS_PER_MIN = LOCAL.calls.ringsPerMin
// How often a minute one session is told that a call it named doesn't exist.
export const UNKNOWN_PER_MIN = LOCAL.calls.unknownPerMin
// How long an answered call waits for its session to come back (a short network drop), and
// after the other side said goodbye (a reload or a closed tab).
export const LOST_MS = LOCAL.calls.lostMs
export const BYE_MS = LOCAL.calls.byeMs
// Negotiation frames from the callee held while the caller is still deciding on its relays.
export const HELD_MAX = LOCAL.calls.heldMax
// How often the caller notes the call is still going, for the log after a crash or reload.
export const ALIVE_MS = LOCAL.calls.aliveMs

export const OFFLINE_TEXT = (name: string) => `${name} is offline. Try again when they are online.`
export const BUSY_TEXT = (name: string) => `${name} is in another call.`
export const NOT_MUTUAL_TEXT = 'You can only call mutual contacts.'
export const IN_CALL_TEXT = 'Already in a call'

export type CallPlan = Resolved & { ok: true }

export interface CallMedia {
  join(me: string, target: RtcTarget, muted: boolean): Promise<void>
  sync(users: string[]): void
  leave(): void
  onSignal(from: string, payload: RtcPayload, scope: { p2pRoom: string }): Promise<void>
}

// The caller's call while it lasts, kept so a reload or crash still logs how it went.
export interface PendingCall {
  id: string
  room: string
  peer: string
  video: boolean
  startedAt: number
  answeredAt: number | null
  alive: number
}

export interface CallView {
  id: string
  room: string
  // The contact's identity key.
  peer: string
  dir: 'out' | 'in'
  state: 'ringing' | 'active'
  video: boolean
  startedAt: number
  // When it was answered (ms).
  since: number | null
}

export interface CallDeps {
  me: () => string
  // Ready sessions with the devices of a contact.
  sessions: (ik: string) => Session[]
  // A mutual contact, not blocked or removed.
  mutual: (ik: string) => boolean
  roomOf: (ik: string) => string
  name: (ik: string) => string
  media: CallMedia
  // This side's ICE plan (relays.ts), for the choice given or the default.
  plan: (choice?: string) => Promise<CallPlan>
  hidesIp: (plan: CallPlan) => boolean
  // Asks about the other side's relays; the host denied, or null.
  consent: (hosts: string[]) => Promise<string | null>
  log: (room: string, call: CallContent) => Promise<unknown>
  // The callee's own note of a call it missed (shown until the caller's log row arrives).
  missed: (room: string, m: MissedCall) => void
  // In an instance call or voice channel.
  busy: () => boolean
  muted: () => boolean
  save: (p: PendingCall | null) => void
  notice: (text: string) => void
  // Leaves any instance call or voice channel: called only once this call is sure to go ahead,
  // right before it takes the microphone.
  leaveOthers?: () => void
  clock?: Clock
}

interface Live extends CallView {
  plan: CallPlan | null
  // The relay hosts the other side declared.
  theirs: string[]
  // The session (and device) the call is bound to: the one that rang us, or that answered.
  session: Session | null
  dk: string | null
  // Sessions rung and those that said busy (the caller).
  rung: Set<Session>
  busy: Set<Session>
  media: boolean
  accepting: boolean
  held: RtcFrame[]
  timer: unknown
  lost: unknown
  alive: unknown
}

export const newCallId = () => b64u(randomBytes(CALL_ID_LEN))

export class Calls {
  private cur: Live | null = null
  private clock: Clock
  private rings = new Map<string, number[]>()
  // Calls we told a peer are over, so a burst of late frames gets one answer, and when each
  // session was last told (a few times a minute at most, whatever ids it makes up).
  private answered: string[] = []
  private told = new WeakMap<Session, number[]>()
  private fns = new Set<() => void>()
  private ringFns = new Set<(c: CallView) => void>()
  readonly signaler: P2pSignaler

  constructor(private deps: CallDeps) {
    this.clock = deps.clock ?? realClock
    this.signaler = new P2pSignaler(
      () => this.cur?.id ?? null,
      (to, frame) => this.out(to, frame)
    )
  }

  view(): CallView | null {
    const c = this.cur
    if (!c) return null
    const { id, room, peer, dir, state, video, startedAt, since } = c
    return { id, room, peer, dir, state, video, startedAt, since }
  }

  // The session of an answered call never makes room for another (node.ts keep).
  keeps(s: Session) {
    const c = this.cur
    return c?.state === 'active' && c.dk !== null && s.remote?.ik === c.peer && s.remote.dk === c.dk
  }

  // A call keeps P2P up while the page is hidden (node.ts awake).
  awake() {
    return this.cur !== null
  }

  // The ICE config of the call's peer connection: the plan of this side, nothing without one.
  config(): RTCConfiguration {
    return this.cur?.plan?.config ?? { iceServers: [], iceTransportPolicy: 'relay' }
  }

  onChange(fn: () => void) {
    this.fns.add(fn)
    return () => void this.fns.delete(fn)
  }

  onRing(fn: (c: CallView) => void) {
    this.ringFns.add(fn)
    return () => void this.ringFns.delete(fn)
  }

  private changed() {
    for (const fn of this.fns) fn()
  }

  // ----- Sessions -----

  attach(s: Session) {
    s.on('call', m => this.onCall(m, s))
    s.on('rtc', m => this.onRtc(m, s))
    s.onClose((_, why) => this.lostSession(s, why))
  }

  ready(s: Session) {
    const c = this.cur
    const r = s.remote
    if (!c || !r || r.ik !== c.peer) return
    if (c.dk !== null && r.dk === c.dk && c.session !== s) {
      c.session = s
      this.clear(c, 'lost')
      return
    }
    if (c.dir === 'out' && c.state === 'ringing' && c.dk === null && !c.rung.has(s)) {
      c.rung.add(s)
      this.send(s, this.ringFrame(c))
    }
  }

  private send(s: Session | null, frame: CallFrame | RtcFrame) {
    if (s && s.state === 'ready') void s.send(frame as unknown as Message).catch(() => {})
  }

  private frame(c: Live, op: CallOp): CallFrame {
    return { t: 'call', op, id: c.id, room: c.room }
  }

  private ringFrame(c: Live): CallFrame {
    return {
      ...this.frame(c, 'ring'),
      video: c.video,
      ...(c.plan?.declared.length ? { relays: c.plan.declared } : {}),
    }
  }

  private out(to: string, frame: RtcFrame) {
    const c = this.cur
    if (!c || to !== c.peer || c.state !== 'active') return
    this.send(c.session, frame)
  }

  // ----- Actions -----

  async start(ik: string, video: boolean, choice?: string) {
    if (this.cur) throw new Error(IN_CALL_TEXT)
    if (!this.deps.mutual(ik)) throw new Error(NOT_MUTUAL_TEXT)
    if (!this.deps.sessions(ik).length) throw new Error(OFFLINE_TEXT(this.deps.name(ik)))
    const plan = await this.deps.plan(choice)
    if (this.cur) throw new Error(IN_CALL_TEXT)
    const now = this.clock.now()
    const c: Live = {
      id: newCallId(),
      room: this.deps.roomOf(ik),
      peer: ik,
      dir: 'out',
      state: 'ringing',
      video,
      startedAt: now,
      since: null,
      plan,
      theirs: [],
      session: null,
      dk: null,
      rung: new Set(),
      busy: new Set(),
      media: true,
      accepting: false,
      held: [],
      timer: null,
      lost: null,
      alive: null,
    }
    this.cur = c
    this.changed()
    try {
      this.deps.leaveOthers?.()
      await this.deps.media.join(this.deps.me(), { p2pRoom: c.room }, this.deps.muted())
    } catch (e) {
      if (this.cur === c) this.end(c, { quiet: true })
      throw e
    }
    if (this.cur !== c) return
    this.saveOut(c)
    const sessions = this.deps.sessions(ik)
    for (const s of sessions) {
      c.rung.add(s)
      this.send(s, this.ringFrame(c))
    }
    c.timer = this.clock.set(() => this.end(c, { op: 'end', outcome: 'missed' }), RING_MS)
  }

  async accept() {
    const c = this.cur
    if (!c || c.dir !== 'in' || c.state !== 'ringing' || c.accepting) return
    c.accepting = true
    this.changed()
    try {
      const plan = await this.deps.plan()
      if (this.cur !== c) return
      if (!this.deps.hidesIp(plan) && (await this.deps.consent(c.theirs)) !== null) {
        if (this.cur === c) this.end(c, { op: 'decline' })
        throw new Error(DENIED_CALL)
      }
      if (this.cur !== c) return
      c.plan = plan
      c.media = true
      try {
        this.deps.leaveOthers?.()
        await this.deps.media.join(this.deps.me(), { p2pRoom: c.room }, this.deps.muted())
      } catch (e) {
        if (this.cur === c) this.end(c, { op: 'decline' })
        throw e
      }
      if (this.cur !== c) return
      // The caller's device went away while we decided.
      if (c.session?.state !== 'ready') {
        this.end(c, { missed: true })
        throw new Error(OFFLINE_TEXT(this.deps.name(c.peer)))
      }
      this.clear(c, 'timer')
      c.state = 'active'
      c.since = this.clock.now()
      this.send(c.session, {
        ...this.frame(c, 'accept'),
        ...(plan.declared.length ? { relays: plan.declared } : {}),
      })
      this.deps.media.sync([this.deps.me(), c.peer])
      this.changed()
    } finally {
      c.accepting = false
      if (this.cur === c) this.changed()
    }
  }

  decline() {
    const c = this.cur
    if (c && c.dir === 'in' && c.state === 'ringing') this.end(c, { op: 'decline' })
  }

  // Ends the call: a ringing call of ours is logged as missed, an answered one as ended.
  hangup() {
    const c = this.cur
    if (!c) return
    if (c.dir === 'in' && c.state === 'ringing') return this.decline()
    this.end(c, {
      op: 'end',
      outcome: c.dir === 'out' ? (c.state === 'active' ? 'ended' : 'missed') : null,
    })
  }

  // The tab stops running P2P (closed, reloaded or handed over): the other side is told, and the
  // log of our own call is written from the pending record on the next start.
  stop() {
    const c = this.cur
    if (!c) return
    for (const s of c.dk === null ? c.rung : [c.session]) this.send(s, this.frame(c, 'end'))
    this.clearAll(c)
    this.cur = null
    if (c.media) this.deps.media.leave()
    this.changed()
  }

  // A call of ours that was going when this browser last stopped: log it now.
  async recover(p: PendingCall | null) {
    if (!p || this.cur?.id === p.id) return
    // A call started since owns the record now: its own saves keep it.
    if (this.cur === null) this.deps.save(null)
    const outcome: CallOutcome = p.answeredAt === null ? 'missed' : 'ended'
    await this.deps
      .log(p.room, {
        id: p.id,
        video: p.video,
        outcome,
        ...(p.answeredAt === null
          ? {}
          : { dur: Math.max(0, Math.floor((p.alive - p.answeredAt) / 1000)) }),
      })
      .catch(() => {})
  }

  // ----- Incoming -----

  private onCall(raw: Message, s: Session) {
    const f = readCallFrame(raw)
    const r = s.remote
    if (!f || !r) return s.strike()
    // An op from a newer version: dropped, at no cost.
    if (f === 'unknown') return
    if (f.room !== this.deps.roomOf(r.ik)) return s.strike()
    // Blocked or removed since the session came up: nothing they send is taken.
    if (!this.deps.mutual(r.ik)) return
    if (f.op === 'ring') return this.incoming(f, s)
    const c = this.cur
    if (!c || c.id !== f.id || c.peer !== r.ik) {
      if (f.op === 'accept') this.unknown(s, f.id, f.room)
      return
    }
    if (c.dk !== null && r.dk !== c.dk) {
      if (f.op === 'accept' && c.dir === 'out') this.send(s, this.frame(c, 'taken'))
      return
    }
    switch (f.op) {
      case 'accept':
        if (c.dir === 'out' && c.state === 'ringing' && c.dk === null)
          this.answeredBy(c, s, f.relays ?? [])
        return
      case 'decline':
        if (c.dir === 'out' && c.state === 'ringing') {
          this.notifyRung(c, s)
          this.end(c, { outcome: 'declined' })
        }
        return
      case 'busy':
        if (c.dir === 'out' && c.state === 'ringing' && c.rung.has(s)) {
          c.busy.add(s)
          if ([...c.rung].every(x => c.busy.has(x) || x.state === 'closed')) {
            this.deps.notice(BUSY_TEXT(this.deps.name(c.peer)))
            this.end(c, { outcome: 'missed' })
          }
        }
        return
      case 'taken':
        if (c.dir === 'in' && c.state === 'ringing') this.end(c, {})
        return
      case 'end':
        if (c.dir === 'in' && c.state === 'ringing') return this.end(c, { missed: true })
        return this.end(c, {
          outcome: c.dir === 'out' ? (c.state === 'active' ? 'ended' : 'missed') : null,
        })
    }
  }

  private incoming(f: CallFrame, s: Session) {
    const r = s.remote
    if (!r) return
    const now = this.clock.now()
    for (const [ik, ts] of this.rings) if (ts.every(t => now - t >= 60_000)) this.rings.delete(ik)
    const recent = (this.rings.get(r.ik) ?? []).filter(t => now - t < 60_000)
    if (recent.length >= RINGS_PER_MIN) return
    recent.push(now)
    this.rings.set(r.ik, recent)
    const c = this.cur
    // Both sides called each other at once: the call with the lower id goes ahead. The side
    // holding the higher one drops its own quietly and takes the ring.
    if (c && c.dir === 'out' && c.state === 'ringing' && c.dk === null && c.peer === r.ik) {
      if (c.id < f.id) return
      this.end(c, { op: 'end', quiet: true })
    }
    if (this.cur) {
      if (this.cur.id !== f.id) this.send(s, { t: 'call', op: 'busy', id: f.id, room: f.room })
      return
    }
    if (this.deps.busy()) return this.send(s, { t: 'call', op: 'busy', id: f.id, room: f.room })
    const next: Live = {
      id: f.id,
      room: f.room,
      peer: r.ik,
      dir: 'in',
      state: 'ringing',
      video: f.video === true,
      startedAt: now,
      since: null,
      plan: null,
      theirs: f.relays ?? [],
      session: s,
      dk: r.dk,
      rung: new Set(),
      busy: new Set(),
      media: false,
      accepting: false,
      held: [],
      timer: null,
      lost: null,
      alive: null,
    }
    this.cur = next
    next.timer = this.clock.set(() => this.end(next, { missed: true }), RING_MS + RING_GRACE_MS)
    const v = this.view() as CallView
    for (const fn of this.ringFns) fn(v)
    this.changed()
  }

  // The callee answered on session `s`: the caller binds the call to that device, tells its
  // other devices, asks about the callee's relays and only then lets negotiation in.
  private answeredBy(c: Live, s: Session, theirs: string[]) {
    const r = s.remote
    if (!r) return
    c.session = s
    c.dk = r.dk
    c.theirs = theirs
    this.clear(c, 'timer')
    this.notifyRung(c, s)
    const plan = c.plan
    const asked =
      plan && this.deps.hidesIp(plan) ? Promise.resolve(null) : this.deps.consent(theirs)
    void asked.then(denied => {
      if (this.cur !== c) return
      if (denied !== null) {
        this.deps.notice(DENIED_CALL)
        return this.end(c, { op: 'end', outcome: 'declined' })
      }
      // The callee's device went away while we decided.
      if (c.session?.state !== 'ready') return this.end(c, { op: 'end', outcome: 'missed' })
      c.state = 'active'
      c.since = this.clock.now()
      this.saveOut(c)
      c.alive = this.clock.set(() => this.tickAlive(c), ALIVE_MS)
      this.deps.media.sync([this.deps.me(), c.peer])
      this.changed()
      const held = c.held
      c.held = []
      for (const h of held) void this.deps.media.onSignal(c.peer, h.payload, h.target)
    })
  }

  // The other devices we rang stop ringing.
  private notifyRung(c: Live, except: Session) {
    for (const x of c.rung) if (x !== except) this.send(x, this.frame(c, 'taken'))
  }

  private onRtc(raw: Message, s: Session) {
    const f = readRtcFrame(raw)
    const r = s.remote
    if (!f || !r) return s.strike()
    if (f.to !== this.deps.me() || f.target.p2pRoom !== this.deps.roomOf(r.ik)) return s.strike()
    if (!this.deps.mutual(r.ik)) return
    const c = this.cur
    // Late frames of a call that is over (or never was, after a reload) are dropped; the
    // other side is told once that there is no such call.
    if (!c || c.id !== f.call || c.peer !== r.ik) return this.unknown(s, f.call, f.target.p2pRoom)
    if (c.dk !== null && r.dk !== c.dk) return
    if (c.state !== 'active') {
      if (c.dir === 'out' && c.dk !== null && c.held.length < HELD_MAX) c.held.push(f)
      return
    }
    void this.deps.media.onSignal(r.ik, f.payload, f.target)
  }

  private unknown(s: Session, id: string, room: string) {
    if (this.answered.includes(id)) return
    const now = this.clock.now()
    const told = (this.told.get(s) ?? []).filter(t => now - t < 60_000)
    if (told.length >= UNKNOWN_PER_MIN) return
    told.push(now)
    this.told.set(s, told)
    this.answered.push(id)
    if (this.answered.length > LOCAL.calls.answeredMax) this.answered.shift()
    this.send(s, { t: 'call', op: 'end', id, room })
  }

  private lostSession(s: Session, why: string) {
    const c = this.cur
    if (!c) return
    c.rung.delete(s)
    if (c.session !== s) return
    c.session = null
    const outcome = c.dir === 'out' ? 'ended' : null
    // Blocked, removed or misbehaving: over at once.
    if (why === 'refused' || why === 'strikes') return this.end(c, { outcome })
    if (c.state !== 'active' || c.lost !== null) return
    c.lost = this.clock.set(
      () =>
        this.end(c, {
          outcome: c.dir === 'out' ? 'ended' : null,
        }),
      why === 'remote' ? BYE_MS : LOST_MS
    )
  }

  // ----- Ending -----

  private clear(c: Live, which: 'timer' | 'lost' | 'alive') {
    if (c[which] !== null) this.clock.clear(c[which])
    c[which] = null
  }

  private clearAll(c: Live) {
    this.clear(c, 'timer')
    this.clear(c, 'lost')
    this.clear(c, 'alive')
  }

  private end(
    c: Live,
    o: { op?: CallOp; outcome?: CallOutcome | null; missed?: boolean; quiet?: boolean }
  ) {
    if (this.cur !== c) return
    this.clearAll(c)
    this.cur = null
    if (o.op) {
      const to = c.dk === null ? [...c.rung, ...(c.dir === 'in' ? [c.session] : [])] : [c.session]
      for (const s of to) this.send(s, this.frame(c, o.op))
    }
    if (c.media) this.deps.media.leave()
    if (c.dir === 'out') this.deps.save(null)
    if (c.dir === 'out' && !o.quiet) {
      const outcome = o.outcome ?? 'missed'
      const ended = outcome === 'ended' && c.since !== null
      void this.deps
        .log(c.room, {
          id: c.id,
          video: c.video,
          outcome: ended ? 'ended' : outcome === 'ended' ? 'missed' : outcome,
          ...(ended
            ? { dur: Math.max(0, Math.floor((this.clock.now() - (c.since as number)) / 1000)) }
            : {}),
        })
        .catch(() => {})
    }
    if (o.missed && c.dir === 'in')
      this.deps.missed(c.room, { id: c.id, from: c.peer, video: c.video, at: c.startedAt })
    this.changed()
  }

  private saveOut(c: Live) {
    this.deps.save({
      id: c.id,
      room: c.room,
      peer: c.peer,
      video: c.video,
      startedAt: c.startedAt,
      answeredAt: c.since,
      alive: this.clock.now(),
    })
  }

  private tickAlive(c: Live) {
    if (this.cur !== c) return
    this.saveOut(c)
    c.alive = this.clock.set(() => this.tickAlive(c), ALIVE_MS)
  }
}
