import { isKeyId } from './keys'
import type { Message } from './frames'
import type { Clock, Session } from './session'
import type { Link } from './sync'
import { isShortId } from './state'
import { isEventId } from './event'

// Which members a P2P server room syncs with (note section 5, "Connection budget"). Nobody
// connects to everyone: each member links a room with at most `perRoom` sessions (a hard cap,
// dials in flight and members being let in included), asks for `outTarget` of them itself (the
// rest are others asking it), and events spread hop by hop. Candidates are drawn at random,
// weighted towards members we share more rooms with, who can moderate, or we already have a
// session with, and drawn again every `resampleMs`: load spreads over the room instead of
// everyone dialing the owner, and the overlay keeps mixing.
//
// A link for a room is agreed per session: `grlink {rooms}` asks, `grlink_ok {rooms, busy}`
// answers (a room past its budget is busy), `grlink_drop {rooms}` ends it. A session left
// without links (answered busy, or dropped) is handed back (`idle`) to be closed. Presence and
// typing travel one hop, only between joined members over links of that room, so they never
// reach anyone outside it (not even someone only invited), and the presence list names only
// members linked in that room (never who else we have sessions with). Typing is relayed only
// when it changes, at most once per `typingRelayMs` per typer, within a per-link budget.

export const GOSSIP = {
  perRoom: 8,
  outTarget: 4,
  resampleMs: 10 * 60_000,
  tickMs: 5_000,
  presenceMs: 20_000,
  presenceTtl: 60_000,
  presenceMax: 64,
  typingMs: 8_000,
  // Relayed typing: once per typer and channel this often at most, and per link this many
  // frames a second (in and out; the rest is dropped).
  typingRelayMs: 3_000,
  typingPerSec: 5,
  // Members let in (who redeemed a code with us, or invited us) are linked first for this long.
  preferMs: 10 * 60_000,
  preferMax: 4,
  // Candidates per room we ask for links at once, and members per room handed to the dialer
  // (it skips those that didn't answer lately, so it goes down the list).
  candidates: 16,
  dialList: 256,
  linkRooms: 32,
  // After a busy answer, that member isn't asked for that room again for this long.
  busyMs: 2 * 60_000,
  // An unanswered link request is given up after this long.
  askMs: 15_000,
  // Links of a room we left stay this long, for our last events and their acks.
  leaveMs: 3_000,
}

export type GossipLimits = typeof GOSSIP

// How a room may be linked with a member: everything, its state only (an invited member who
// hasn't joined), or not at all.
export type LinkKind = 'full' | 'state' | false

export interface Candidate {
  ik: string
  shared: number
  moderator: boolean
  live: boolean
}

// FNV-1a over a string, as a number in [0, 1): a stable shuffle within one sampling period.
export const salted = (salt: string, ik: string) => {
  let h = 0x811c9dc5
  const s = salt + ik
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0) / 4294967296
}

// A weighted random order (Efraimidis-Spirakis): each member draws salted^(1/weight), highest
// first. Shared rooms, moderation and a live session raise the weight; nobody is always first.
export const weightOf = (c: Candidate) => 1 + c.shared + (c.moderator ? 1 : 0) + (c.live ? 2 : 0)

export const rankCandidates = (list: Candidate[], salt: string) => {
  const key = new Map(list.map(c => [c.ik, Math.pow(salted(salt, c.ik), 1 / weightOf(c))]))
  return [...list].sort(
    (a, b) => (key.get(b.ik) as number) - (key.get(a.ik) as number) || (a.ik < b.ik ? -1 : 1)
  )
}

export interface GossipDeps {
  clock: Clock
  random: () => number
  me: () => string
  // Server rooms we take part in.
  rooms: () => string[]
  // Members of a room other than us that links can be made with (joined).
  members: (room: string) => string[]
  may: (room: string, ik: string) => LinkKind
  shared: (ik: string) => number
  moderator: (room: string, ik: string) => boolean
  sessions: (ik: string) => Session[]
  certs: (ik: string) => { ik: string; certs: import('./keys').Cert[] } | null
  link: (s: Session, room: string) => Link | null
  unlink: (s: Session, room: string) => void
  links: (room: string) => Link[]
  linksOn: (s: Session) => Link[]
  // A link was refused because the asker isn't (or is no longer) let in.
  refused?: (s: Session, room: string) => void
  // Both we and `ik` are joined: a link made while letting them in follows the budget again.
  settled?: (room: string, ik: string) => boolean
  // Whether a dial to `ik` is in flight (it counts against the room's budget), and whether one
  // may start now (not backing off).
  dialing?: (ik: string) => boolean
  dialable?: (ik: string) => boolean
  // A session left without room links.
  idle?: (s: Session) => void
  // After every tick.
  onTick?: () => void
  // Whether `ch` is a live text channel of the room (typing elsewhere is ignored).
  channel?: (room: string, ch: string) => boolean
  onPresence: (room: string) => void
  onTyping: (room: string, ch: string, ik: string, on: boolean) => void
  limits?: Partial<GossipLimits>
}

const strings = (x: unknown, max: number, ok: (v: unknown) => boolean): string[] | null =>
  Array.isArray(x) && x.length <= max && x.every(ok) ? (x as string[]) : null

const isRoomId = (x: unknown) => typeof x === 'string' && /^[A-Za-z0-9_-]{43}$/.test(x)

export class Gossip {
  readonly limits: GossipLimits
  // Room links we asked for, per room.
  private out = new Map<string, Set<string>>()
  private asked = new Map<string, number>()
  private busy = new Map<string, number>()
  // Members to link with first (who let us in, or invited us), until when.
  private preferred = new Map<string, Map<string, number>>()
  private seen = new Map<string, Map<string, number>>()
  private typers = new Map<string, { until: number; timer: unknown }>()
  // When we last relayed each typer's state, and frames per link this second.
  private relayed = new Map<string, { at: number; on: boolean }>()
  private budget = new WeakMap<Session, { sec: number; in: number; out: number }>()
  private salt: string
  private rankCache = new Map<string, { key: string; members: string[]; list: Candidate[] }>()
  // Sessions and when they came up: one without room links after askMs is handed back.
  private since = new Map<Session, number>()
  private timers: unknown[] = []
  private stopped = false

  constructor(private deps: GossipDeps) {
    this.limits = { ...GOSSIP, ...deps.limits }
    this.salt = String(deps.random())
  }

  start() {
    this.stopped = false
    const every = (ms: number, fn: () => void) => {
      const run = () => {
        if (this.stopped) return
        fn()
        this.timers.push(this.deps.clock.set(run, ms))
      }
      this.timers.push(this.deps.clock.set(run, ms))
    }
    every(this.limits.tickMs, () => this.tick())
    every(this.limits.presenceMs, () => this.sendPresence())
    every(this.limits.resampleMs, () => this.resample())
  }

  stop() {
    this.stopped = true
    for (const t of this.timers) this.deps.clock.clear(t)
    this.timers = []
    for (const t of this.typers.values()) this.deps.clock.clear(t.timer)
    this.typers.clear()
  }

  attach(s: Session) {
    s.on('grlink', m => this.onLink(m, s))
    s.on('grlink_ok', m => this.onLinked(m, s))
    s.on('grlink_drop', m => this.onDrop(m, s))
    s.on('gpresence', m => this.onPresenceMsg(m, s))
    s.on('gtyping', m => this.onTypingMsg(m, s))
    s.on('ttyping', m => this.onTypingMsg(m, s))
  }

  // A session is up: ask it for the rooms we want it for.
  ready(s: Session) {
    const ik = s.remote?.ik
    if (!ik) return
    this.since.set(s, this.deps.clock.now())
    s.onClose(() => {
      this.since.delete(s)
      this.closed(s)
    })
    const want = this.deps.rooms().filter(room => this.wants(room, ik))
    this.ask(s, want)
  }

  prefer(room: string, ik: string) {
    const map = this.preferred.get(room) ?? new Map<string, number>()
    map.delete(ik)
    map.set(ik, this.deps.clock.now() + this.limits.preferMs)
    while (map.size > this.limits.preferMax) map.delete(map.keys().next().value as string)
    this.preferred.set(room, map)
    for (const s of this.deps.sessions(ik)) this.ask(s, [room])
  }

  isPreferred(room: string, ik: string) {
    return (this.preferred.get(room)?.get(ik) ?? 0) > this.deps.clock.now()
  }

  private preferredOf(room: string) {
    const now = this.deps.clock.now()
    return [...(this.preferred.get(room) ?? [])].filter(([, t]) => t > now).map(([ik]) => ik)
  }

  // A frame within the per-link typing budget.
  private allow(s: Session, dir: 'in' | 'out') {
    const sec = Math.floor(this.deps.clock.now() / 1000)
    let b = this.budget.get(s)
    if (!b || b.sec !== sec) {
      b = { sec, in: 0, out: 0 }
      this.budget.set(s, b)
    }
    if (b[dir] >= this.limits.typingPerSec) return false
    b[dir] += 1
    return true
  }

  private full(room: string, ik: string) {
    return this.deps.may(room, ik) === 'full'
  }

  private key(ik: string, room: string) {
    return `${ik}\n${room}`
  }

  private outOf(room: string) {
    let set = this.out.get(room)
    if (!set) {
      set = new Set()
      this.out.set(room, set)
    }
    return set
  }

  private linked(room: string, ik: string) {
    return this.deps.links(room).some(l => l.ik === ik)
  }

  // Link requests to a room still waiting for an answer.
  private pending(room: string) {
    const now = this.deps.clock.now()
    let n = 0
    for (const [k, until] of this.asked) if (until > now && k.endsWith(`\n${room}`)) n += 1
    return n
  }

  // Whether we would ask `ik` for a link to `room` now.
  private wants(room: string, ik: string) {
    if (!this.deps.may(room, ik) || this.linked(room, ik)) return false
    const now = this.deps.clock.now()
    const k = this.key(ik, room)
    if ((this.busy.get(k) ?? 0) > now || (this.asked.get(k) ?? 0) > now) return false
    if (this.isPreferred(room, ik)) return true
    const asking = this.pending(room)
    if (this.deps.links(room).length + asking >= this.limits.perRoom) return false
    if (this.outOf(room).size + asking >= this.limits.outTarget) return false
    return this.deps.members(room).includes(ik)
  }

  // Members in preference order (worked out once per tick, sampling period and member list).
  private ranked(room: string) {
    const key = `${this.salt}|${Math.floor(this.deps.clock.now() / this.limits.tickMs)}`
    const members = this.deps.members(room)
    const hit = this.rankCache.get(room)
    if (hit?.key === key && hit.members === members) return hit.list
    const list = this.rank(room)
    this.rankCache.set(room, { key, members, list })
    return list
  }

  private rank(room: string) {
    const list = this.deps
      .members(room)
      .filter(ik => ik !== this.deps.me())
      .map(ik => ({
        ik,
        shared: this.deps.shared(ik),
        moderator: this.deps.moderator(room, ik),
        live: this.deps.sessions(ik).length > 0,
      }))
    return rankCandidates(list, this.salt)
  }

  private ask(s: Session, rooms: string[]) {
    const ik = s.remote?.ik
    if (!ik || !rooms.length) return
    const until = this.deps.clock.now() + this.limits.askMs
    for (const room of rooms) this.asked.set(this.key(ik, room), until)
    for (let i = 0; i < rooms.length; i += this.limits.linkRooms)
      void s.send({ t: 'grlink', rooms: rooms.slice(i, i + this.limits.linkRooms) }).catch(() => {})
  }

  // Members to dial for rooms that need more links, best first. Dials in flight to members of
  // a room count against its budget, so a room never has more than `perRoom` sessions coming.
  targets() {
    const out: { ik: string; certs: import('./keys').Cert[] }[] = []
    const seen = new Set<string>()
    for (const room of this.deps.rooms()) {
      const pref = this.preferredOf(room)
      const members = this.deps.members(room)
      let flying = 0
      if (this.deps.dialing) for (const ik of members) if (this.deps.dialing(ik)) flying += 1
      const asking = this.pending(room)
      const used = this.deps.links(room).length + asking + flying
      // Only as many as the room still needs, so nobody is dialed just to be told it's busy.
      const need = Math.max(
        0,
        Math.min(
          this.limits.perRoom - used,
          this.limits.outTarget - this.outOf(room).size - asking - flying
        )
      )
      const list = [...pref, ...(need ? this.ranked(room).map(c => c.ik) : [])]
      let n = 0
      let fresh = 0
      for (const ik of list) {
        if (n >= this.limits.dialList) break
        const isPref = pref.includes(ik)
        if (!isPref && fresh >= need) break
        if (seen.has(ik) || this.linked(room, ik) || this.deps.sessions(ik).length) continue
        if (!this.deps.may(room, ik)) continue
        // Answered busy lately: dialing again would only open a session to close.
        if ((this.busy.get(this.key(ik, room)) ?? 0) > this.deps.clock.now()) continue
        if (this.deps.dialable && !this.deps.dialable(ik)) continue
        const c = this.deps.certs(ik)
        if (!c) continue
        seen.add(ik)
        out.push(c)
        n += 1
        if (!isPref) fresh += 1
      }
    }
    return out
  }

  // Asks live sessions for the rooms that need links, and keeps rooms within their budget.
  tick() {
    const now = this.deps.clock.now()
    for (const [k, t] of this.asked) if (t <= now) this.asked.delete(k)
    for (const [k, t] of this.busy) if (t <= now) this.busy.delete(k)
    for (const [k, t] of this.relayed) if (now - t.at > this.limits.typingMs) this.relayed.delete(k)
    for (const [s, t] of this.since) if (now - t >= this.limits.askMs) this.checkIdle(s)
    for (const room of this.deps.rooms()) {
      for (const l of this.deps.links(room))
        if (!this.deps.may(room, l.ik)) this.drop(l.session, room)
      const pref = this.preferred.get(room)
      for (const [ik, t] of pref ?? [])
        if (t <= now || this.deps.settled?.(room, ik)) pref?.delete(ik)
      this.trim(room)
      // Members we already have a session with, best first.
      for (const c of this.ranked(room)) {
        if (!c.live) continue
        if (!this.wants(room, c.ik)) continue
        const s = this.deps.sessions(c.ik)[0]
        if (s) this.ask(s, [room])
      }
      for (const ik of this.preferredOf(room))
        if (this.wants(room, ik)) {
          const s = this.deps.sessions(ik)[0]
          if (s) this.ask(s, [room])
        }
    }
    this.deps.onTick?.()
  }

  // Past the budget (members let in on top of it), the links others asked for go first, the
  // least preferred first.
  private trim(room: string) {
    const links = this.deps.links(room)
    let extra = links.length - this.limits.perRoom
    if (extra <= 0) return
    const order = new Map(this.ranked(room).map((c, i) => [c.ik, i]))
    const victims = links
      .filter(l => !this.isPreferred(room, l.ik))
      .sort(
        (a, b) =>
          Number(this.outOf(room).has(a.ik)) - Number(this.outOf(room).has(b.ik)) ||
          (order.get(b.ik) ?? 0) - (order.get(a.ik) ?? 0)
      )
    for (const l of victims) {
      if (extra <= 0) break
      this.drop(l.session, room)
      extra -= 1
    }
  }

  // A new sampling period: links we asked for that the new order doesn't keep are ended, and
  // tick() asks others.
  resample() {
    this.salt = String(this.deps.random())
    for (const room of this.deps.rooms()) {
      const keep = new Set(
        this.ranked(room)
          .slice(0, this.limits.outTarget)
          .map(c => c.ik)
      )
      for (const ik of [...this.outOf(room)]) {
        if (keep.has(ik) || this.isPreferred(room, ik)) continue
        for (const l of this.deps.links(room)) if (l.ik === ik) this.drop(l.session, room)
      }
    }
    this.tick()
  }

  private drop(s: Session, room: string) {
    const ik = s.remote?.ik
    if (ik) this.outOf(room).delete(ik)
    this.deps.unlink(s, room)
    void s.send({ t: 'grlink_drop', rooms: [room] }).catch(() => {})
    this.checkIdle(s)
  }

  private checkIdle(s: Session) {
    if (!this.deps.linksOn(s).length) this.deps.idle?.(s)
  }

  // Room for a preferred member at the cap: the least preferred link someone else asked for
  // goes. False when every link is preferred.
  private evictFor(room: string) {
    const order = new Map(this.ranked(room).map((c, i) => [c.ik, i]))
    const victim = this.deps
      .links(room)
      .filter(l => !this.isPreferred(room, l.ik))
      .sort(
        (a, b) =>
          Number(this.outOf(room).has(a.ik)) - Number(this.outOf(room).has(b.ik)) ||
          (order.get(b.ik) ?? 0) - (order.get(a.ik) ?? 0)
      )[0]
    if (!victim) return false
    this.drop(victim.session, room)
    return true
  }

  // Ends every link of a room (we left it), after a moment, so our last events still go out.
  leave(room: string) {
    this.out.delete(room)
    this.preferred.delete(room)
    this.timers.push(
      this.deps.clock.set(() => {
        if (this.deps.rooms().includes(room)) return
        for (const l of this.deps.links(room)) this.drop(l.session, room)
      }, this.limits.leaveMs)
    )
  }

  private closed(s: Session) {
    const ik = s.remote?.ik
    if (!ik) return
    for (const set of this.out.values()) if (!this.deps.sessions(ik).length) set.delete(ik)
  }

  private onLink(m: Message, s: Session) {
    const ik = s.remote?.ik
    const rooms = strings(m.rooms, this.limits.linkRooms, isRoomId)
    if (!ik || !rooms) return s.strike()
    const ok: string[] = []
    const busy: string[] = []
    for (const room of rooms) {
      if (!this.deps.rooms().includes(room) || !this.deps.may(room, ik)) {
        busy.push(room)
        if (this.deps.rooms().includes(room)) this.deps.refused?.(s, room)
        continue
      }
      const have = this.linked(room, ik)
      const atCap = !have && this.deps.links(room).length >= this.limits.perRoom
      if (atCap && !(this.isPreferred(room, ik) && this.evictFor(room))) busy.push(room)
      else ok.push(room)
    }
    // The answer goes out before our heads, so the other side links first.
    void s.send({ t: 'grlink_ok', rooms: ok, busy }).catch(() => {})
    for (const room of ok) this.deps.link(s, room)
    if (!ok.length) this.checkIdle(s)
  }

  private onLinked(m: Message, s: Session) {
    const ik = s.remote?.ik
    const rooms = strings(m.rooms, this.limits.linkRooms, isRoomId)
    const busy = strings(m.busy ?? [], this.limits.linkRooms, isRoomId)
    if (!ik || !rooms || !busy) return s.strike()
    const now = this.deps.clock.now()
    for (const room of rooms) {
      this.asked.delete(this.key(ik, room))
      const atCap = !this.linked(room, ik) && this.deps.links(room).length >= this.limits.perRoom
      const full = atCap && !(this.isPreferred(room, ik) && this.evictFor(room))
      if (full || !this.deps.rooms().includes(room) || !this.deps.may(room, ik)) {
        void s.send({ t: 'grlink_drop', rooms: [room] }).catch(() => {})
        continue
      }
      if (this.deps.link(s, room)) this.outOf(room).add(ik)
    }
    for (const room of busy) {
      this.asked.delete(this.key(ik, room))
      this.busy.set(this.key(ik, room), now + this.limits.busyMs)
    }
    this.checkIdle(s)
  }

  private onDrop(m: Message, s: Session) {
    const ik = s.remote?.ik
    const rooms = strings(m.rooms, this.limits.linkRooms, isRoomId)
    if (!ik || !rooms) return s.strike()
    for (const room of rooms) {
      this.outOf(room).delete(ik)
      this.deps.unlink(s, room)
    }
    this.checkIdle(s)
  }

  // ----- Presence -----

  private sendPresence() {
    for (const room of this.deps.rooms()) {
      const links = this.deps.links(room).filter(l => this.full(room, l.ik))
      if (!links.length) continue
      const on = this.linkedMembers(room).slice(0, this.limits.presenceMax)
      for (const l of links) void l.session.send({ t: 'gpresence', room, on }).catch(() => {})
    }
    this.prune()
  }

  // Joined members we have a link of this room with: all a presence report may name.
  private linkedMembers(room: string) {
    return [...new Set(this.deps.links(room).map(l => l.ik))].filter(ik => this.full(room, ik))
  }

  // Members of the room we have a session with right now (shown here, never sent).
  private direct(room: string) {
    return this.deps.members(room).filter(ik => this.deps.sessions(ik).length > 0)
  }

  // A link of this room with a joined member, on this session.
  private fullLink(s: Session, room: string) {
    const ik = s.remote?.ik
    return !!ik && this.full(room, ik) && this.deps.linksOn(s).some(l => l.room === room)
  }

  private onPresenceMsg(m: Message, s: Session) {
    const room = m.room
    const on = strings(m.on, this.limits.presenceMax, isKeyId)
    if (typeof room !== 'string' || !on) return s.strike()
    // Only over a link of that room with a joined member: presence never comes from (or goes
    // to) outside it.
    if (!this.fullLink(s, room)) return
    const members = new Set(this.deps.members(room))
    const now = this.deps.clock.now()
    let seen = this.seen.get(room)
    if (!seen) {
      seen = new Map()
      this.seen.set(room, seen)
    }
    for (const ik of on) if (members.has(ik)) seen.set(ik, now)
    this.deps.onPresence(room)
  }

  private prune() {
    const now = this.deps.clock.now()
    for (const [room, seen] of this.seen) {
      let changed = false
      for (const [ik, at] of seen)
        if (now - at > this.limits.presenceTtl) {
          seen.delete(ik)
          changed = true
        }
      if (changed) this.deps.onPresence(room)
    }
  }

  // Members online as far as we know: us, members we have a session with, and members a session
  // peer of this room reported in the last minute.
  online(room: string): Set<string> {
    const out = new Set<string>([this.deps.me()])
    const members = new Set(this.deps.members(room))
    for (const ik of this.direct(room)) out.add(ik)
    const now = this.deps.clock.now()
    for (const [ik, at] of this.seen.get(room) ?? [])
      if (now - at <= this.limits.presenceTtl && members.has(ik)) out.add(ik)
    return out
  }

  // ----- Typing -----

  // Typing in a channel (`gtyping`), or in one of its threads (`ttyping`, with the root): its own
  // op, so older clients ignore it and older relays don't pass it on as channel typing.
  typing(room: string, ch: string, on: boolean, root?: string) {
    const frame = root ? { t: 'ttyping', room, ch, root, on } : { t: 'gtyping', room, ch, on }
    for (const l of this.deps.links(room))
      if (this.full(room, l.ik) && this.allow(l.session, 'out'))
        void l.session.send(frame).catch(() => {})
  }

  private onTypingMsg(m: Message, s: Session) {
    const from = s.remote?.ik
    const { room, ch, on } = m
    const thread = m.t === 'ttyping'
    if (
      !from ||
      typeof room !== 'string' ||
      !isShortId(ch) ||
      typeof on !== 'boolean' ||
      (thread && !isEventId(m.root)) ||
      (m.ik !== undefined && !isKeyId(m.ik))
    )
      return s.strike()
    if (!this.fullLink(s, room) || !this.allow(s, 'in')) return
    if (this.deps.channel && !this.deps.channel(room, ch)) return
    const ik = (m.ik as string | undefined) ?? from
    if (ik === this.deps.me() || !this.deps.members(room).includes(ik)) return
    const root = thread ? (m.root as string) : null
    const place = placeOf(ch, root)
    const changed = this.typed(room, place, ik, on)
    // One hop: what a peer typed goes on to our other links of the room, and no further; at
    // most once per typingRelayMs per typer (a stop only when it changes something), within
    // each link's budget.
    if (m.ik !== undefined) return
    const key = `${room}\n${place}\n${ik}`
    const now = this.deps.clock.now()
    const last = this.relayed.get(key)
    if (on) {
      if (last && now - last.at < this.limits.typingRelayMs) return
      this.relayed.set(key, { at: now, on: true })
    } else {
      if (!changed || !last?.on) return
      this.relayed.set(key, { at: now, on: false })
    }
    const frame = root
      ? { t: 'ttyping', room, ch, root, on, ik }
      : { t: 'gtyping', room, ch, on, ik }
    for (const l of this.deps.links(room))
      if (l.session !== s && l.ik !== ik && this.full(room, l.ik) && this.allow(l.session, 'out'))
        void l.session.send(frame).catch(() => {})
  }

  // Shows or stops showing a typer in a place (a channel, or `{channel}#{root}`); true when that
  // changed.
  private typed(room: string, place: string, ik: string, on: boolean) {
    const key = `${room}\n${place}\n${ik}`
    const cur = this.typers.get(key)
    if (cur) this.deps.clock.clear(cur.timer)
    if (!on) {
      if (cur) {
        this.typers.delete(key)
        this.deps.onTyping(room, place, ik, false)
      }
      return !!cur
    }
    const ttl = this.limits.typingMs
    this.typers.set(key, {
      until: this.deps.clock.now() + ttl,
      timer: this.deps.clock.set(() => this.typed(room, place, ik, false), ttl),
    })
    if (!cur) this.deps.onTyping(room, place, ik, true)
    return !cur
  }

  // Stops showing someone typing (their message arrived).
  stopTyping(room: string, ch: string, ik: string, root: string | null = null) {
    this.typed(room, placeOf(ch, root), ik, false)
  }

  typingIn(room: string, ch: string, root: string | null = null) {
    const prefix = `${room}\n${placeOf(ch, root)}\n`
    return [...this.typers.keys()].filter(k => k.startsWith(prefix)).map(k => k.split('\n')[2])
  }
}

const placeOf = (ch: string, root: string | null) => (root ? `${ch}#${root}` : ch)
