import { isRecord } from '../bytes'
import { declaredHosts } from '../relays'
import type { RtcTarget, Signaler } from '../rtc'
import type { RtcPayload } from '../types'
import { bytesOf, hasKeys } from './canonical'
import type { Message } from './frames'
import { isKeyId, signTagged, verifyTagged, type Cert } from './keys'
import type { Clock, Session } from './session'
import { isRoomId, readPayload } from './signal'
import { isShortId } from './state'

// Voice channels of P2P servers (note section 5, "Calls and voice"): a full mesh, like instance
// voice. Who is in a channel travels in `gvoice {room, ch, on, n, dk, sig}` frames, signed by the
// device the participant is in voice on (one of its devices in the room), so a frame passed on
// can't be forged or changed. They are sent to every session with a member of the room who may
// view the channel and refreshed every `refreshMs`. Every frame that changes what we know goes on
// over the room's links (with `ik`, whose state it is), so participants any number of links apart
// find each other: each state crosses each link once (its stamp `n`), at most one per member
// every `gapMs` (the latest goes when the gap is over) and `linkPerSec` frames a link. Someone
// not heard of for `ttlMs` is gone; `n` orders one member's frames, so a late copy never undoes a
// newer one. The media runs through rtc.ts, negotiated in `gvrtc {to, target, payload}` frames
// over the session with the participant's voice device; those sessions are kept outside the
// rooms' link budget. Not DAG events: they are never stored. Unknown fields are ignored;
// malformed known ones strike.
//
// Someone who joins a channel hears back, from each member it told, whom that member knows in
// it, and a session that comes up with a participant hears the same. What a participant says on
// its own session beats anything passed on about it. Once we have a session with its voice
// device, passed-on frames about it no longer count: a claim it doesn't confirm within
// `confirmMs` is dropped and ignored for `ttlMs`. At most `keepMax` participants hold sessions
// outside the budget.

export const VOICE = {
  refreshMs: 20_000,
  ttlMs: 60_000,
  tickMs: 5_000,
  // A participant whose session with its voice device went away, and who isn't heard of again
  // (also through others), is gone after this: longer than a refresh.
  lostMs: 30_000,
  // How long someone we have a session with has to confirm what was passed on about them.
  confirmMs: 10_000,
  // A passed-on frame stamped (by its participant's clock) more than ttlMs plus this before ours
  // is stale.
  skewMs: 5 * 60_000,
  // Frames a session may send us (a bucket: this many a second, bursts up to inBurst, for a
  // newcomer's list); the rest is dropped.
  inPerSec: 20,
  inBurst: 80,
  // Passing on: one state per member every gapMs at most, an unchanged one every relayMs, and
  // linkPerSec frames a second on each link (the rest is dropped; refreshes come again).
  gapMs: 1_000,
  relayMs: 5_000,
  linkPerSec: 10,
  // Participants a channel lists at most, and those we keep sessions with outside the budget.
  listMax: 64,
  keepMax: 40,
}

export type VoiceLimits = typeof VOICE

// Past these many in a channel (the second with a camera or a screen share on), the channel and
// the voice panel say how far a mesh goes. Joining is never blocked.
export const VOICE_FIT = { audio: 8, video: 4 }
export const VOICE_NOTICE =
  'Voice in P2P servers is peer-to-peer. It works best with up to 8 people (4 with video).'

export const pastFit = (count: number, video: boolean) =>
  count > (video ? VOICE_FIT.video : VOICE_FIT.audio)

export const NO_VOICE = "You can't join this voice channel."
export const RELAY_DENIED_TEXT = 'Relay not allowed. Not connected to'

export interface VoiceFrame {
  t: 'gvoice'
  room: string
  ch: string
  on: boolean
  n: number
  // A camera or a screen share is on.
  video?: boolean
  // The relay hosts the participant may connect through (relays.ts).
  relays?: string[]
  // Passed on: whose state it is (absent: the sender's own).
  ik?: string
  // The participant's device and its signature over voiceBody.
  dk: string
  sig: string
}

export const VOICE_TAG = 'rchat-p2p-voice1\0'

// What a participant signs: its state, whoever passes it on. The body is a fixed projection of
// the known fields: a field signed in a later version needs a new tag (or frame type), because
// peers of this version would rebuild the smaller body, fail to verify it and strike, and
// relayers drop unknown fields.
export const voiceBody = (
  f: { room: string; ch: string; on: boolean; n: number; video?: boolean; relays?: string[] },
  ik: string
) => ({
  room: f.room,
  ch: f.ch,
  on: f.on,
  n: f.n,
  video: f.video === true,
  relays: f.relays ?? [],
  ik,
})

const isSig = (x: unknown): x is string => typeof x === 'string' && bytesOf(x, 64) !== null

export interface VoiceRtcFrame {
  t: 'gvrtc'
  to: string
  target: { p2pRoom: string; ch: string }
  payload: RtcPayload
}

export const readVoiceFrame = (x: unknown): VoiceFrame | null => {
  if (!isRecord(x) || !hasKeys(x, ['t', 'room', 'ch', 'on', 'n', 'dk', 'sig'])) return null
  const { t, room, ch, on, n, video, relays, ik, dk, sig } = x
  if (t !== 'gvoice' || !isRoomId(room) || !isShortId(ch) || typeof on !== 'boolean') return null
  if (!isKeyId(dk) || !isSig(sig)) return null
  if (!Number.isSafeInteger(n) || (n as number) < 0) return null
  if (video !== undefined && typeof video !== 'boolean') return null
  if (ik !== undefined && !isKeyId(ik)) return null
  const hosts = declaredHosts(relays)
  if (hosts === null || (Array.isArray(relays) && hosts.length !== relays.length)) return null
  return {
    t,
    room,
    ch,
    on,
    n: n as number,
    ...(video === true ? { video: true } : {}),
    ...(hosts.length ? { relays: hosts } : {}),
    ...(ik !== undefined ? { ik } : {}),
    dk,
    sig,
  }
}

// `gvrefuse {room, ch, relays}`: we don't connect through these relays of yours, so the other
// side stops trying (as a denied contact call ends on both sides).
export interface VoiceRefuse {
  t: 'gvrefuse'
  room: string
  ch: string
  relays: string[]
}

export const readVoiceRefuse = (x: unknown): VoiceRefuse | null => {
  if (!isRecord(x) || !hasKeys(x, ['t', 'room', 'ch', 'relays'])) return null
  const { t, room, ch, relays } = x
  if (t !== 'gvrefuse' || !isRoomId(room) || !isShortId(ch) || !Array.isArray(relays)) return null
  const hosts = declaredHosts(relays)
  if (hosts === null || hosts.length !== relays.length) return null
  return { t, room, ch, relays: hosts }
}

export const readVoiceRtc = (x: unknown): VoiceRtcFrame | null => {
  if (!isRecord(x) || !hasKeys(x, ['t', 'to', 'target', 'payload'])) return null
  const { t, to, target, payload } = x
  if (t !== 'gvrtc' || !isKeyId(to) || !isRecord(target)) return null
  if (!isRoomId(target.p2pRoom) || !isShortId(target.ch)) return null
  const p = readPayload(payload)
  return p ? { t, to, target: { p2pRoom: target.p2pRoom, ch: target.ch }, payload: p } : null
}

export interface VoiceState {
  ch: string
  on: boolean
  n: number
  // When we last heard of it, and since when they are in this channel (our clock).
  at: number
  since: number
  video: boolean
  relays: string[]
  // Heard from them on their own session.
  direct: boolean
  // Their signature, passed on with it.
  dk: string
  sig: string
}

// Who is in which voice channel of each room, as far as we heard.
export class VoiceRoster {
  private rooms = new Map<string, Map<string, VoiceState>>()
  // The newest stamp seen of each member, kept past expiry, so an old frame never comes back.
  private high = new Map<string, Map<string, number>>()

  constructor(private ttl = VOICE.ttlMs) {}

  // Takes a frame about `ik` (`direct`: from them): true when it changed what we had. Their own
  // word beats a passed-on one; a passed-on one never replaces it while it is fresh.
  apply(
    room: string,
    ik: string,
    f: {
      ch: string
      on: boolean
      n: number
      video?: boolean
      relays?: string[]
      dk?: string
      sig?: string
    },
    now: number,
    direct: boolean
  ) {
    let map = this.rooms.get(room)
    const cur = map?.get(ik)
    const fresh = !!cur && now - cur.at <= this.ttl
    let high = this.high.get(room)
    if (cur && direct && cur.direct && f.n <= cur.n) return false
    if (cur && !direct && ((cur.direct && fresh) || f.n <= cur.n)) return false
    if (!direct && f.n <= (high?.get(ik) ?? -1)) return false
    if (!map) {
      map = new Map()
      this.rooms.set(room, map)
    }
    if (!high) {
      high = new Map()
      this.high.set(room, high)
    }
    high.set(ik, Math.max(high.get(ik) ?? -1, f.n))
    const stays = cur?.on && cur.ch === f.ch && now - cur.at <= this.ttl
    map.set(ik, {
      ch: f.ch,
      on: f.on,
      n: f.n,
      at: now,
      since: stays ? cur.since : now,
      video: f.video === true,
      relays: f.relays ?? [],
      direct,
      dk: f.dk ?? '',
      sig: f.sig ?? '',
    })
    return true
  }

  // Forgets what we haven't heard of within the time to live; the rooms someone left that way.
  prune(now: number): string[] {
    const out: string[] = []
    for (const [room, map] of this.rooms) {
      let gone = false
      for (const [ik, s] of map)
        if (now - s.at > this.ttl) {
          map.delete(ik)
          if (s.on) gone = true
        }
      if (!map.size) this.rooms.delete(room)
      if (gone) out.push(room)
    }
    return out
  }

  state(room: string, ik: string, now: number): VoiceState | null {
    const s = this.rooms.get(room)?.get(ik)
    return s && s.on && now - s.at <= this.ttl ? s : null
  }

  // Who is in a channel, longest there first.
  in(room: string, ch: string, now: number): string[] {
    const out: [string, VoiceState][] = []
    for (const [ik, s] of this.rooms.get(room) ?? [])
      if (s.on && s.ch === ch && now - s.at <= this.ttl) out.push([ik, s])
    return out.sort(([a, x], [b, y]) => x.since - y.since || (a < b ? -1 : 1)).map(([ik]) => ik)
  }

  // Everyone in a voice channel of the room, by channel.
  channels(room: string, now: number): Map<string, string[]> {
    const out = new Map<string, string[]>()
    for (const [ik, s] of this.rooms.get(room) ?? [])
      if (s.on && now - s.at <= this.ttl) out.set(s.ch, [...(out.get(s.ch) ?? []), ik])
    for (const [ch] of out) out.set(ch, this.in(room, ch, now))
    return out
  }

  // What they said themselves no longer outranks what is passed on (their session went).
  demote(room: string, ik: string) {
    const s = this.rooms.get(room)?.get(ik)
    if (s) s.direct = false
  }

  roomsOf(ik: string): string[] {
    return [...this.rooms].filter(([, map]) => map.has(ik)).map(([room]) => room)
  }

  // A member left the room (`gone`: or may no longer be in its voice), or we did.
  forget(room: string, ik?: string, gone = false) {
    if (ik === undefined) {
      this.rooms.delete(room)
      this.high.delete(room)
      return
    }
    this.rooms.get(room)?.delete(ik)
    if (gone) this.high.get(room)?.delete(ik)
  }
}

export interface VoiceMedia {
  join(me: string, target: RtcTarget, muted: boolean): Promise<void>
  sync(users: string[]): void
  leave(): void
  onSignal(from: string, payload: RtcPayload, scope: { p2pRoom: string; ch: string }): Promise<void>
}

export interface VoicePlan {
  config: RTCConfiguration
  // Our TURN hosts the others are told about.
  declared: string[]
  // Relayed candidates only: nobody's relay sees our address, so nobody is asked about.
  hidesIp: boolean
}

export interface VoiceUser {
  ik: string
  video: boolean
}

export interface VoiceDeps {
  clock: Clock
  me: () => string
  // Ready sessions with members of the room, and those that are links of the room.
  sessions: (room: string) => Session[]
  links: (room: string) => Session[]
  sessionsOf: (ik: string) => Session[]
  // A joined member of a room we are joined in.
  member: (room: string, ik: string) => boolean
  // A live voice channel of the room, and a device of a member in it.
  isVoice: (room: string, ch: string) => boolean
  device: (room: string, ik: string, dk: string) => boolean
  // Our device key, to sign our state with.
  signer: () => { dk: string; sk: Uint8Array } | null
  // A member who may view the channel.
  allowed: (room: string, ch: string, ik: string) => boolean | Promise<boolean>
  certs: (ik: string) => { ik: string; certs: Cert[] } | null
  onChange: (room: string) => void
  // Dials participants we have no session with.
  wake?: () => void
  limits?: Partial<VoiceLimits>
}

interface Relayed {
  at: number
  n: number
  key: string
  due: { f: VoiceFrame; from: Session } | null
  timer: unknown
}

const stateKey = (f: VoiceFrame) =>
  `${f.ch}\n${f.on}\n${f.video === true}\n${(f.relays ?? []).join()}`

interface Mine {
  room: string
  ch: string
  video: boolean
  plan: VoicePlan
  since: number
  timer: unknown
}

export class Voice implements Signaler {
  readonly limits: VoiceLimits
  readonly roster: VoiceRoster
  media: VoiceMedia | null = null
  // Asks about a participant's relays; the host denied, or null.
  consent: (hosts: string[], ik: string) => Promise<string | null> = () => Promise.resolve(null)
  // A participant left out because their relay wasn't allowed.
  denied: (ik: string) => void = () => {}
  private mine: Mine | null = null
  // We said goodbye (the page may be going away) and haven't been used since.
  private away = false
  private n = 0
  // Per participant, the relay list allowed or denied, and who is being asked about.
  private ok = new Map<string, string>()
  private no = new Map<string, string>()
  // Participants who refused our relays.
  private refusedBy = new Set<string>()
  private asking = new Set<string>()
  private synced = new Set<string>()
  private lost = new Map<string, unknown>()
  // Members whose passed-on state we ignore until then (they didn't confirm it).
  private refuted = new Map<string, number>()
  private rate = new WeakMap<Session, { tokens: number; at: number }>()
  private out = new WeakMap<Session, { sec: number; n: number }>()
  // What we last passed on about each member (and the latest waiting for the gap), and when we
  // last told a newcomer whom we know.
  private relayed = new Map<string, Relayed>()
  private told = new Map<string, number>()
  private timer: unknown = null
  private fns = new Set<() => void>()

  constructor(private deps: VoiceDeps) {
    this.limits = { ...VOICE, ...deps.limits }
    this.roster = new VoiceRoster(this.limits.ttlMs)
  }

  start() {
    this.stop()
    const run = () => {
      this.tick()
      this.timer = this.deps.clock.set(run, this.limits.tickMs)
    }
    this.timer = this.deps.clock.set(run, this.limits.tickMs)
  }

  stop() {
    if (this.timer !== null) this.deps.clock.clear(this.timer)
    this.timer = null
  }

  onChange(fn: () => void) {
    this.fns.add(fn)
    return () => void this.fns.delete(fn)
  }

  private changed() {
    for (const fn of this.fns) fn()
  }

  // The channel we are in.
  current(): { room: string; ch: string } | null {
    const m = this.mine
    return m ? { room: m.room, ch: m.ch } : null
  }

  config(): RTCConfiguration {
    return this.mine?.plan.config ?? { iceServers: [], iceTransportPolicy: 'relay' }
  }

  // ----- Sessions -----

  attach(s: Session) {
    s.on('gvoice', m => this.onFrame(m, s))
    s.on('gvrtc', m => this.onRtc(m, s))
    s.on('gvrefuse', m => this.onRefuse(m, s))
    s.onClose(() => this.closed(s))
  }

  // A session came up: someone in our channel hears our state from us, and whom we hear in it,
  // so a newcomer learns the whole call from any one of us. What was passed on about them they
  // confirm on this session, or it goes.
  ready(s: Session) {
    const ik = s.remote?.ik
    if (ik) this.deps.clock.set(() => this.confirm(s, ik), this.limits.confirmMs)
    if (ik && this.lost.has(ik) && this.isVoiceDevice(s)) this.clearLost(ik)
    const m = this.mine
    if (!m || !ik || !this.deps.member(m.room, ik)) return
    void (async () => {
      if (!(await this.deps.allowed(m.room, m.ch, ik)) || this.mine !== m) return
      this.sendTo(s, this.own(m))
      this.tell(s, m.room, m.ch, ik)
      this.refuseOn(s, m, ik)
      this.resync()
    })().catch(() => {})
  }

  private confirm(s: Session, ik: string) {
    if (s.state !== 'ready') return
    const now = this.deps.clock.now()
    for (const room of this.roster.roomsOf(ik)) {
      const st = this.roster.state(room, ik, now)
      if (!st || st.direct || st.dk !== s.remote?.dk) continue
      this.roster.forget(room, ik)
      this.refuted.set(ik, now + this.limits.ttlMs)
      this.deps.onChange(room)
      if (this.mine?.room === room) this.resync()
    }
  }

  // Passed-on frames about `ik` signed on its device `dk` don't count: we have a session with
  // that device (it speaks for itself), or they didn't confirm one lately.
  private ownWordOnly(ik: string, dk: string, now: number) {
    const until = this.refuted.get(ik)
    if (until !== undefined && until <= now) this.refuted.delete(ik)
    if (until !== undefined && until > now) return true
    return this.deps
      .sessionsOf(ik)
      .some(s => s.remote?.dk === dk && s.openedAt > 0 && now - s.openedAt >= this.limits.confirmMs)
  }

  // The session with the device a participant is in voice on: the one that signed its state.
  private voiceSession(room: string, ik: string): Session | null {
    const st = this.roster.state(room, ik, this.deps.clock.now())
    if (!st) return null
    return this.deps.sessionsOf(ik).find(s => s.remote?.dk === st.dk) ?? null
  }

  private isVoiceDevice(s: Session) {
    const r = s.remote
    if (!r) return false
    const now = this.deps.clock.now()
    return this.roster.roomsOf(r.ik).some(room => this.roster.state(room, r.ik, now)?.dk === r.dk)
  }

  // Whom we hear in a channel, to `s` (about anyone but `ik`), at most listMax of them.
  private tell(s: Session, room: string, ch: string, ik: string) {
    const now = this.deps.clock.now()
    const me = this.deps.me()
    for (const p of this.roster.in(room, ch, now).slice(0, this.limits.listMax)) {
      const st = this.roster.state(room, p, now)
      if (p === ik || p === me || !st || !this.deps.member(room, p)) continue
      this.sendTo(s, this.frameOf(room, p, st))
    }
  }

  // The session with a participant's voice device closed: unless it comes back or the
  // participant is heard of again (through others too), it is gone after lostMs.
  private closed(s: Session) {
    const r = s.remote
    if (!r || this.lost.has(r.ik)) return
    const { ik, dk } = r
    if (this.deps.sessionsOf(ik).some(x => x !== s && x.remote?.dk === dk)) return
    const now = this.deps.clock.now()
    const heard: { room: string; n: number }[] = []
    for (const room of this.roster.roomsOf(ik)) {
      const st = this.roster.state(room, ik, now)
      if (st?.dk === dk) heard.push({ room, n: st.n })
    }
    if (!heard.length) return
    this.lost.set(
      ik,
      this.deps.clock.set(() => {
        this.lost.delete(ik)
        for (const { room, n } of heard) {
          if (this.voiceSession(room, ik)) continue
          if (this.roster.state(room, ik, this.deps.clock.now())?.n !== n) continue
          this.roster.forget(room, ik)
          this.deps.onChange(room)
          if (this.mine?.room === room) this.resync()
        }
      }, this.limits.lostMs)
    )
    if (this.keeps(ik, dk)) this.deps.wake?.()
  }

  private clearLost(ik: string) {
    const t = this.lost.get(ik)
    if (t !== undefined) this.deps.clock.clear(t)
    this.lost.delete(ik)
  }

  private sendTo(s: Session, f: VoiceFrame | VoiceRtcFrame | VoiceRefuse | null) {
    if (f && s.state === 'ready') void s.send(f as unknown as Message).catch(() => {})
  }

  // Frames a session sends us, within its bucket; the rest is dropped.
  private allow(s: Session) {
    const now = this.deps.clock.now()
    const { inPerSec, inBurst } = this.limits
    const b = this.rate.get(s) ?? { tokens: inBurst, at: now }
    b.tokens = Math.min(inBurst, b.tokens + ((now - b.at) * inPerSec) / 1000)
    b.at = now
    this.rate.set(s, b)
    if (b.tokens < 1) return false
    b.tokens -= 1
    return true
  }

  // Frames we pass on over a link, within its budget a second.
  private allowOut(s: Session) {
    const sec = Math.floor(this.deps.clock.now() / 1000)
    let o = this.out.get(s)
    if (!o || o.sec !== sec) {
      o = { sec, n: 0 }
      this.out.set(s, o)
    }
    if (o.n >= this.limits.linkPerSec) return false
    o.n += 1
    return true
  }

  // ----- Actions -----

  private next() {
    this.n = Math.max(this.n + 1, this.deps.clock.now())
    return this.n
  }

  private own(m: Mine, on = true): VoiceFrame | null {
    const key = this.deps.signer()
    if (!key || (on && this.away)) return null
    const f = {
      room: m.room,
      ch: m.ch,
      on,
      n: this.next(),
      ...(on && m.video ? { video: true } : {}),
      ...(on && m.plan.declared.length ? { relays: m.plan.declared } : {}),
    }
    const sig = signTagged(key.sk, VOICE_TAG, voiceBody(f, this.deps.me()))
    return { t: 'gvoice', ...f, dk: key.dk, sig }
  }

  private frameOf(room: string, ik: string, st: VoiceState): VoiceFrame {
    return {
      t: 'gvoice',
      room,
      ch: st.ch,
      on: st.on,
      n: st.n,
      ...(st.video ? { video: true } : {}),
      ...(st.relays.length ? { relays: st.relays } : {}),
      ik,
      dk: st.dk,
      sig: st.sig,
    }
  }

  // Our frame to every member of the room who may view the channel.
  // Sent at once where the answer is known (a page closing has no time to wait).
  private broadcast(f: VoiceFrame | null) {
    if (!f) return
    for (const s of this.deps.sessions(f.room)) {
      const ik = s.remote?.ik
      if (!ik) continue
      const ok = this.deps.allowed(f.room, f.ch, ik)
      if (ok === true) this.sendTo(s, f)
      else if (ok !== false) void ok.then(yes => yes && this.sendTo(s, f)).catch(() => {})
    }
  }

  // Whether we may join: checked before anything else ends (`leaveOthers`, our other call or
  // voice channel) or the plan is made.
  async join(
    room: string,
    ch: string,
    o: {
      plan: VoicePlan | (() => Promise<VoicePlan>)
      muted: boolean | (() => boolean)
      leaveOthers?: () => void
    }
  ) {
    const media = this.media
    if (!media || !this.deps.isVoice(room, ch)) throw new Error(NO_VOICE)
    if (!(await this.deps.allowed(room, ch, this.deps.me()))) throw new Error(NO_VOICE)
    const plan = typeof o.plan === 'function' ? await o.plan() : o.plan
    o.leaveOthers?.()
    const muted = typeof o.muted === 'function' ? o.muted() : o.muted
    this.leave()
    this.away = false
    const m: Mine = { room, ch, video: false, plan, since: this.deps.clock.now(), timer: null }
    this.mine = m
    this.changed()
    try {
      await media.join(this.deps.me(), { p2pRoom: room, ch }, muted)
    } catch (e) {
      if (this.mine === m) {
        this.mine = null
        this.changed()
      }
      throw e
    }
    if (this.mine !== m) return
    this.broadcast(this.own(m))
    this.arm(m)
    this.deps.onChange(room)
    this.resync()
    this.deps.wake?.()
  }

  private arm(m: Mine) {
    m.timer = this.deps.clock.set(() => {
      if (this.mine !== m) return
      this.broadcast(this.own(m))
      this.arm(m)
    }, this.limits.refreshMs)
  }

  leave() {
    const m = this.mine
    if (!m) return
    this.mine = null
    if (m.timer !== null) this.deps.clock.clear(m.timer)
    this.broadcast(this.own(m, false))
    this.ok.clear()
    this.no.clear()
    this.refusedBy.clear()
    this.asking.clear()
    this.synced.clear()
    this.media?.leave()
    this.deps.onChange(m.room)
    this.changed()
  }

  // The page may be going away (beforeunload): the others hear we left while there is still time
  // to seal and send it. Until `back()` (the page stayed: it is used again), nothing says we are
  // in, refreshes included, so a slow navigation or reload never brings us back as a ghost.
  goodbye() {
    const m = this.mine
    if (!m || this.away) return
    this.broadcast(this.own(m, false))
    this.away = true
  }

  back() {
    const m = this.mine
    if (!this.away) return
    this.away = false
    if (m) this.broadcast(this.own(m))
  }

  // A camera or a screen share went on or off.
  setVideo(on: boolean) {
    const m = this.mine
    if (!m || m.video === on) return
    m.video = on
    this.broadcast(this.own(m))
    this.deps.onChange(m.room)
  }

  // We left the room or were removed: out of its voice too.
  forget(room: string) {
    if (this.mine?.room === room) this.leave()
    this.roster.forget(room)
  }

  // ----- Views -----

  // Who is in each voice channel of the room: us while we are in one, and whom we heard of.
  channels(room: string): Record<string, VoiceUser[]> {
    const now = this.deps.clock.now()
    const out: Record<string, VoiceUser[]> = {}
    const m = this.mine
    const all: (VoiceUser & { ch: string; since: number })[] = []
    for (const [ch, iks] of this.roster.channels(room, now))
      for (const ik of iks) {
        const st = this.roster.state(room, ik, now)
        if (st && this.deps.member(room, ik) && this.deps.isVoice(room, ch))
          all.push({ ik, ch, video: st.video, since: st.since })
      }
    if (m && m.room === room)
      all.push({ ik: this.deps.me(), ch: m.ch, video: m.video, since: m.since })
    all.sort((a, b) => a.since - b.since || (a.ik < b.ik ? -1 : 1))
    for (const { ik, ch, video } of all) (out[ch] ??= []).push({ ik, video })
    return out
  }

  // Participants of our channel to keep sessions with (outside the link budget, at most
  // keepMax, longest there first), and to dial.
  private kept(): string[] {
    const m = this.mine
    if (!m) return []
    const me = this.deps.me()
    return this.roster
      .in(m.room, m.ch, this.deps.clock.now())
      .filter(
        ik =>
          ik !== me && this.deps.member(m.room, ik) && !this.no.has(ik) && !this.refusedBy.has(ik)
      )
      .slice(0, this.limits.keepMax)
  }

  // `dk`: only the session with the device they are in voice on.
  keeps(ik: string | undefined, dk?: string) {
    const m = this.mine
    if (!m || !ik || !this.kept().includes(ik)) return false
    return dk === undefined || this.roster.state(m.room, ik, this.deps.clock.now())?.dk === dk
  }

  // Participants without a session with their voice device: that device to dial.
  targets(): { ik: string; certs: Cert[] }[] {
    const m = this.mine
    if (!m) return []
    const now = this.deps.clock.now()
    const out: { ik: string; certs: Cert[] }[] = []
    for (const ik of this.kept()) {
      const st = this.roster.state(m.room, ik, now)
      if (!st || this.voiceSession(m.room, ik)) continue
      const certs = (this.deps.certs(ik)?.certs ?? []).filter(c => c.dk === st.dk)
      if (certs.length) out.push({ ik, certs })
    }
    return out
  }

  // ----- Media -----

  // Media with every participant we have a session with (or had media with), once their relays
  // are allowed.
  private resync() {
    const m = this.mine
    const media = this.media
    if (!m || !media) return
    const me = this.deps.me()
    const now = this.deps.clock.now()
    const users: string[] = []
    for (const ik of this.roster.in(m.room, m.ch, now)) {
      const st = this.roster.state(m.room, ik, now)
      if (ik === me || !st || !this.deps.member(m.room, ik)) continue
      const key = st.relays.join(',')
      if (this.no.get(ik) === key || this.refusedBy.has(ik)) continue
      if (!m.plan.hidesIp && st.relays.length && this.ok.get(ik) !== key) {
        this.ask(m, ik, key, st.relays)
        continue
      }
      if (this.synced.has(ik) || this.voiceSession(m.room, ik)) users.push(ik)
    }
    this.synced = new Set(users)
    media.sync([me, ...users])
    this.changed()
  }

  // A participant whose relays we refused hears it on its voice session, also one that comes up
  // after the answer.
  private refuseOn(s: Session, m: Mine, ik: string) {
    const st = this.roster.state(m.room, ik, this.deps.clock.now())
    if (!st?.relays.length || this.no.get(ik) !== st.relays.join(',')) return
    if (this.voiceSession(m.room, ik) === s)
      this.sendTo(s, { t: 'gvrefuse', room: m.room, ch: m.ch, relays: st.relays })
  }

  private ask(m: Mine, ik: string, key: string, hosts: string[]) {
    if (this.asking.has(ik)) return
    this.asking.add(ik)
    void this.consent(hosts, ik).then(
      denied => {
        this.asking.delete(ik)
        if (this.mine !== m) return
        if (denied === null) this.ok.set(ik, key)
        else {
          this.no.set(ik, key)
          this.denied(ik)
          const s = this.voiceSession(m.room, ik)
          if (s) this.refuseOn(s, m, ik)
        }
        this.resync()
      },
      () => this.asking.delete(ik)
    )
  }

  // rtc.ts Signaler: one negotiation step to a participant, over our session with the device
  // it is in voice on.
  send(to: string, target: RtcTarget, payload: RtcPayload) {
    const m = this.mine
    if (!m || target.p2pRoom !== m.room || target.ch !== m.ch) return
    const s = this.voiceSession(m.room, to)
    if (s) this.sendTo(s, { t: 'gvrtc', to, target: { p2pRoom: m.room, ch: m.ch }, payload })
  }

  // ----- Incoming -----

  private async onFrame(raw: Message, s: Session) {
    const f = readVoiceFrame(raw)
    const from = s.remote?.ik
    if (!f || !from) return s.strike()
    if (!this.allow(s)) return
    const { room, ch } = f
    const ik = f.ik ?? from
    if (ik === this.deps.me()) return
    if (!this.deps.member(room, from) || !this.deps.member(room, ik)) return
    if (!this.deps.isVoice(room, ch)) return
    const now = this.deps.clock.now()
    const direct = f.ik === undefined
    // Our own frames are signed by the device we send them from.
    if (direct && f.dk !== s.remote?.dk) return
    if (!direct && this.ownWordOnly(ik, f.dk, now)) return
    if (!direct && f.n < now - this.limits.ttlMs - this.limits.skewMs) return
    // A device the room doesn't list (yet) for them: dropped. A bad signature strikes.
    if (!this.deps.device(room, ik, f.dk)) return
    if (!verifyTagged(f.dk, VOICE_TAG, voiceBody(f, ik), f.sig)) return s.strike()
    if (!(await this.deps.allowed(room, ch, from))) return
    if (ik !== from && !(await this.deps.allowed(room, ch, ik))) return
    const was = this.roster.state(room, ik, now)
    // Their own word counts while we still hear them on their voice device's session.
    if (!direct && was?.direct && !this.voiceSession(room, ik)) this.roster.demote(room, ik)
    const known = was?.ch === ch
    if (f.on && !known && this.roster.in(room, ch, now).length >= this.limits.listMax) return
    if (!this.roster.apply(room, ik, f, now, direct)) return
    this.forward(f, ik, s)
    // A newcomer to the channel hears whom we know in it, at most once per refresh.
    const tk = `${room}\n${ch}\n${ik}`
    if (
      direct &&
      f.on &&
      !known &&
      now - (this.told.get(tk) ?? -Infinity) >= this.limits.refreshMs
    ) {
      this.told.set(tk, now)
      const m = this.mine
      if (m && m.room === room && m.ch === ch) this.sendTo(s, this.own(m))
      this.tell(s, room, ch, ik)
    }
    this.deps.onChange(room)
    const m = this.mine
    if (!m || m.room !== room) return
    this.resync()
    if (f.on && ch === m.ch && !this.voiceSession(room, ik)) this.deps.wake?.()
  }

  // On to the room's other links who may view the channel (see the top): each state of a member
  // once, one every gapMs (the latest waits for the gap), an unchanged one every relayMs.
  private forward(f: VoiceFrame, ik: string, from: Session) {
    const k = `${f.room}\n${ik}`
    const now = this.deps.clock.now()
    let r = this.relayed.get(k)
    if (!r) {
      r = { at: -Infinity, n: -1, key: '', due: null, timer: null }
      this.relayed.set(k, r)
    }
    if (f.n <= r.n) return
    // During a gap the newest always waits (an older one is never passed on last); whether it
    // still says something new is decided when it goes.
    if (r.timer !== null || now - r.at < this.limits.gapMs) {
      if (!r.due || f.n > r.due.f.n) r.due = { f, from }
      const rr = r
      rr.timer ??= this.deps.clock.set(
        () => {
          rr.timer = null
          const d = rr.due
          rr.due = null
          if (d && d.f.n > rr.n) this.maybePass(rr, d.f, ik, d.from)
        },
        Math.max(0, this.limits.gapMs - (now - r.at))
      )
      return
    }
    this.maybePass(r, f, ik, from)
  }

  // An unchanged state goes on at most every relayMs.
  private maybePass(r: Relayed, f: VoiceFrame, ik: string, from: Session) {
    if (r.key === stateKey(f) && this.deps.clock.now() - r.at < this.limits.relayMs) return
    this.pass(r, f, ik, from)
  }

  private pass(r: Relayed, f: VoiceFrame, ik: string, from: Session) {
    r.at = this.deps.clock.now()
    r.n = f.n
    r.key = stateKey(f)
    const out: VoiceFrame = { ...f, ik }
    for (const s of this.deps.links(f.room)) {
      const to = s.remote?.ik
      if (s === from || !to || to === ik) continue
      const ok = this.deps.allowed(f.room, f.ch, to)
      const go = () => this.allowOut(s) && this.sendTo(s, out)
      if (ok === true) go()
      else if (ok !== false) void ok.then(yes => yes && go()).catch(() => {})
    }
  }

  private onRtc(raw: Message, s: Session) {
    const f = readVoiceRtc(raw)
    const from = s.remote?.ik
    if (!f || !from) return s.strike()
    if (f.to !== this.deps.me()) return s.strike()
    const m = this.mine
    // Late frames of a channel we left, anyone we don't connect media with, and their other
    // devices are dropped.
    if (!m || f.target.p2pRoom !== m.room || f.target.ch !== m.ch || !this.synced.has(from)) return
    if (this.voiceSession(m.room, from) !== s) return
    void this.media?.onSignal(from, f.payload, f.target).catch(() => {})
  }

  // A participant refused the relays we declare now: we stop trying to connect to it.
  private onRefuse(raw: Message, s: Session) {
    const f = readVoiceRefuse(raw)
    const from = s.remote?.ik
    if (!f || !from) return s.strike()
    const m = this.mine
    if (!m || f.room !== m.room || f.ch !== m.ch || !this.deps.member(m.room, from)) return
    if (f.relays.join(',') !== m.plan.declared.join(',') || this.refusedBy.has(from)) return
    this.refusedBy.add(from)
    this.denied(from)
    this.resync()
  }

  // The room's state changed: participants who may no longer view their channel are gone.
  async recheck(room: string) {
    const now = this.deps.clock.now()
    let gone = false
    for (const [ch, iks] of this.roster.channels(room, now))
      for (const ik of iks)
        if (!this.deps.member(room, ik) || !(await this.deps.allowed(room, ch, ik))) {
          this.roster.forget(room, ik, !this.deps.member(room, ik))
          gone = true
        }
    if (!gone) return
    this.deps.onChange(room)
    if (this.mine?.room === room) this.resync()
  }

  // Housekeeping: who wasn't heard of within the time to live is gone.
  tick() {
    const now = this.deps.clock.now()
    for (const [k, r] of this.relayed)
      if (now - r.at > this.limits.ttlMs && r.timer === null) this.relayed.delete(k)
    for (const [k, t] of this.told) if (now - t > this.limits.ttlMs) this.told.delete(k)
    for (const room of this.roster.prune(now)) {
      this.deps.onChange(room)
      if (this.mine?.room === room) this.resync()
    }
  }
}
