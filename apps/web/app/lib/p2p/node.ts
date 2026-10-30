import { b64u, equalBytes, randomBytes } from './canonical'
import { BAD_CARD, decodeCard, encodeCard, makeCard, type Card } from './card'
import {
  accept,
  addFromCard,
  applySuccession,
  block,
  CERTS_KEPT,
  cleanIntro,
  dialable,
  displayName,
  ignore,
  isRevoked,
  markVerified,
  overflowRequests,
  receiveRequest,
  recheckName,
  rename,
  unfriended,
  updateDevices,
  withProfile,
  type AddResult,
  type Contact,
} from './contacts'
import type { P2pStore, SelfRecord } from './db'
import type { Me } from './handshake'
import {
  cleanName,
  keyId,
  newKeyPair,
  peerId,
  peerIds,
  signCert,
  signProfile,
  signSuccession,
  SUFFIX_MAX,
  verifyCert,
  verifyProfile,
  verifyRevocation,
  verifySuccession,
  withSuffix,
  type Cert,
  type Revocation,
} from './keys'
import type { Message } from './frames'
import {
  checkVerifyCode,
  NONCE_BYTES,
  parseVerifyCode,
  verifyCheckText,
  verifyCode,
} from './safety'
import { realClock, Session, type Clock, type Pipe } from './session'

// A P2P node: this browser's identity, its contacts and its sessions with them. It listens on
// its own PeerJS id (never the one P2P files use, and never announced to the instance), dials
// mutual contacts within a connection budget, and keeps everything in IndexedDB.

export class TransportError extends Error {
  constructor(readonly kind: 'unavailable-id' | 'peer-unavailable' | 'timeout' | 'network') {
    super(kind)
  }
}

export interface Listener {
  close: () => void
}

export interface Transport {
  // Registers our peer id and hands over every incoming connection. Rejects with
  // TransportError('unavailable-id') when someone else holds the id.
  listen: (id: string, onPipe: (pipe: Pipe) => void, onLost: () => void) => Promise<Listener>
  dial: (from: string, to: string) => Promise<Pipe>
}

export interface Visibility {
  visible: () => boolean
  onChange: (fn: () => void) => () => void
}

export const LIMITS = {
  sessions: 48,
  // Incoming connections still in their handshake (unauthenticated): a pool of their own, so
  // they never push out established sessions.
  handshakes: 8,
  inFlight: 4,
  backoff: [30_000, 60_000, 120_000, 300_000, 600_000],
  tickMs: 10_000,
  hiddenPauseMs: 5 * 60_000,
  failedHandshakes: 3,
  strikeBanMs: 10 * 60_000,
  // Message requests kept (the oldest unverified ones make room) and new ones per hour.
  requests: 50,
  requestsPerHour: 20,
}

export const ELSEWHERE = 'Your P2P identity changed in another tab. Reload this page.'

export type Status = 'starting' | 'online' | 'connecting' | 'paused' | 'squatted' | 'moved'

export type Presence = 'online' | 'dialing' | 'offline'

export const SQUATTED = 'Someone is blocking your P2P address on this instance'
export const OTHER_HOST = (host: string) =>
  `Contact uses ${host}. P2P across instances isn't supported.`

export interface NodeView {
  status: Status
  ik: string
  name: string
  contacts: Contact[]
  presence: Record<string, Presence>
  // Message requests dropped or pruned to limit spam, until the user clears the count.
  dropped: number
}

export interface NodeDeps {
  store: P2pStore
  transport: Transport
  host: string
  clock?: Clock
  visibility?: Visibility
  // Per-device label in our certificate; never personal data.
  label?: string
}

type Rel = 'request' | 'mutual' | 'none' | 'pending'

const HELLO_CERTS = 4

export const createSelf = (name: string, now: number, label = 'Browser'): SelfRecord => {
  const ik = newKeyPair()
  const dk = newKeyPair()
  const cert = signCert(ik, dk.pk, now, label)
  return {
    id: 'me',
    ik,
    dk,
    cert,
    certs: [cert],
    revocations: [],
    profile: signProfile(ik, cleanName(name) || 'P2P user', now),
    succession: null,
    suffix: 0,
    created: now,
    moved: null,
  }
}

interface DialState {
  attempt: number
  nextAt: number
}

export class P2pNode {
  status: Status = 'starting'
  private contacts = new Map<string, Contact>()
  // Ready sessions by remote device key, and every session in progress.
  private sessions = new Map<string, Session>()
  private pending = new Set<Session>()
  private dialing = new Set<string>()
  private dials = new Map<string, DialState>()
  private failed = new Map<string, number[]>()
  private banned = new Map<string, number>()
  private verifyNonces = new Map<string, string[]>()
  private requestTimes: number[] = []
  private dropped = 0
  private listener: Listener | null = null
  private ticker: unknown = null
  private hiddenTimer: unknown = null
  private unwatch: (() => void) | null = null
  private userPaused = false
  private hiddenPaused = false
  private stopped = false
  private fns = new Set<() => void>()
  private clock: Clock

  private constructor(
    private self: SelfRecord,
    private deps: NodeDeps
  ) {
    this.clock = deps.clock ?? realClock
  }

  // Loads the identity and contacts, creating an identity when `create` is given and there is
  // none yet. Null when there is none and none should be made.
  static async open(deps: NodeDeps, create?: { name: string }): Promise<P2pNode | null> {
    let self = await deps.store.self()
    if (!self) {
      if (!create) return null
      const made = createSelf(create.name, (deps.clock ?? realClock).now(), deps.label)
      self = await deps.store.updateSelf(cur => (cur ? null : made))
      if (!self) return null
    }
    const node = new P2pNode(self, deps)
    for (const c of await deps.store.contacts()) node.contacts.set(c.ik, c)
    node.userPaused = (await deps.store.meta<boolean>('paused')) === true
    const dropped = await deps.store.meta<number>('dropped')
    node.dropped = Number.isSafeInteger(dropped) ? (dropped as number) : 0
    return node
  }

  get ik() {
    return keyId(this.self.ik.pk)
  }

  get dk() {
    return keyId(this.self.dk.pk)
  }

  get peerId() {
    return withSuffix(peerId(this.self.dk.pk), this.self.suffix)
  }

  get name() {
    return this.self.profile.name
  }

  get paused() {
    return this.userPaused
  }

  get host() {
    return this.deps.host
  }

  onChange(fn: () => void) {
    this.fns.add(fn)
    return () => void this.fns.delete(fn)
  }

  private changed() {
    for (const fn of this.fns) fn()
  }

  view(): NodeView {
    const presence: Record<string, Presence> = {}
    for (const c of this.contacts.values()) presence[c.ik] = this.presence(c.ik)
    return {
      status: this.status,
      ik: this.ik,
      name: this.name,
      contacts: [...this.contacts.values()],
      presence,
      dropped: this.dropped,
    }
  }

  presence(ik: string): Presence {
    for (const s of this.sessions.values()) if (s.remote?.ik === ik) return 'online'
    return this.dialing.has(ik) ? 'dialing' : 'offline'
  }

  contact(ik: string) {
    return this.contacts.get(ik)
  }

  // ----- Lifecycle -----

  async start() {
    this.stopped = false
    if (this.self.moved) {
      this.status = 'moved'
      return this.changed()
    }
    const vis = this.deps.visibility
    this.unwatch ??= vis?.onChange(() => this.onVisibility()) ?? null
    if (this.userPaused) {
      this.status = 'paused'
      return this.changed()
    }
    if (vis && !vis.visible()) this.armHiddenPause()
    await this.listen()
  }

  private async listen() {
    if (this.listener || this.stopped) return
    this.status = 'connecting'
    this.changed()
    for (let n = this.self.suffix; n <= SUFFIX_MAX; n += 1) {
      const id = withSuffix(peerId(this.self.dk.pk), n)
      try {
        const l = await this.deps.transport.listen(
          id,
          pipe => this.incoming(pipe),
          () => this.lost()
        )
        if (this.stopped || this.isPaused()) {
          l.close()
          return
        }
        this.listener = l
        if (n !== this.self.suffix) await this.writeSelf(cur => ({ ...cur, suffix: n }))
        this.status = 'online'
        this.changed()
        this.ticker ??= this.clock.set(() => this.tick(), LIMITS.tickMs)
        this.schedule()
        return
      } catch (e) {
        if (!(e instanceof TransportError) || e.kind !== 'unavailable-id') {
          this.status = 'connecting'
          this.changed()
          this.retryListen()
          return
        }
      }
    }
    this.status = 'squatted'
    this.changed()
    this.retryListen()
  }

  private retryTimer: unknown = null

  private retryListen() {
    if (this.retryTimer !== null || this.stopped) return
    this.retryTimer = this.clock.set(() => {
      this.retryTimer = null
      if (this.isPaused()) return
      // Start from the plain id again: a squatter may be gone.
      if (this.status === 'squatted') this.self = { ...this.self, suffix: 0 }
      void this.listen()
    }, LIMITS.backoff[1])
  }

  private lost() {
    this.listener = null
    if (this.stopped || this.isPaused()) return
    this.status = 'connecting'
    this.changed()
    this.retryListen()
  }

  private isPaused() {
    return this.userPaused || this.hiddenPaused
  }

  private tick() {
    this.ticker = null
    if (this.stopped || this.isPaused()) return
    this.ticker = this.clock.set(() => this.tick(), LIMITS.tickMs)
    this.schedule()
  }

  private halt(reason: 'paused' | 'closed') {
    for (const s of [...this.sessions.values(), ...this.pending]) s.close(reason)
    this.sessions.clear()
    this.pending.clear()
    this.listener?.close()
    this.listener = null
    if (this.ticker !== null) this.clock.clear(this.ticker)
    this.ticker = null
    if (this.retryTimer !== null) this.clock.clear(this.retryTimer)
    this.retryTimer = null
    this.dialing.clear()
  }

  stop() {
    this.stopped = true
    this.halt('closed')
    this.unwatch?.()
    this.unwatch = null
    if (this.hiddenTimer !== null) this.clock.clear(this.hiddenTimer)
    this.hiddenTimer = null
    this.changed()
  }

  async setPaused(on: boolean) {
    this.userPaused = on
    await this.deps.store.setMeta('paused', on)
    if (on) {
      this.halt('paused')
      this.status = 'paused'
      this.changed()
    } else if (!this.hiddenPaused) await this.listen()
  }

  // Phones drop background tabs anyway: after 5 minutes hidden every session closes, and they
  // come back when the tab is visible again.
  private onVisibility() {
    const vis = this.deps.visibility
    if (!vis) return
    if (vis.visible()) {
      if (this.hiddenTimer !== null) this.clock.clear(this.hiddenTimer)
      this.hiddenTimer = null
      if (this.hiddenPaused) {
        this.hiddenPaused = false
        if (!this.userPaused) void this.listen()
      } else this.schedule(true)
    } else this.armHiddenPause()
  }

  private armHiddenPause() {
    if (this.hiddenTimer !== null) return
    this.hiddenTimer = this.clock.set(() => {
      this.hiddenTimer = null
      if (this.deps.visibility?.visible() !== false) return
      this.hiddenPaused = true
      this.halt('paused')
      this.status = 'paused'
      this.changed()
    }, LIMITS.hiddenPauseMs)
  }

  // ----- Sessions -----

  private me(): Me {
    return { dk: this.self.dk, cert: this.self.cert, peer: this.peerId }
  }

  private isBanned(key: string) {
    const until = this.banned.get(key)
    if (until === undefined) return false
    if (until > this.clock.now()) return true
    this.banned.delete(key)
    return false
  }

  private recentFailures(peer: string) {
    const now = this.clock.now()
    const list = (this.failed.get(peer) ?? []).filter(t => now - t < 60_000)
    this.failed.set(peer, list)
    return list.length
  }

  private incoming(pipe: Pipe) {
    if (
      this.stopped ||
      this.isPaused() ||
      this.isBanned(pipe.remote) ||
      this.recentFailures(pipe.remote) >= LIMITS.failedHandshakes ||
      [...this.pending].filter(s => s.role === 'responder').length >= LIMITS.handshakes
    )
      return pipe.close()
    this.run(new Session(this.sessionOpts('responder', pipe, null)))
  }

  private sessionOpts(role: 'initiator' | 'responder', pipe: Pipe, expect: string | null) {
    return {
      role,
      pipe,
      me: this.me(),
      clock: this.clock,
      admit: (r: { ik: string; dk: string }) => {
        const c = this.contacts.get(r.ik)
        return (
          r.ik !== this.ik &&
          !this.isBanned(r.ik) &&
          c?.state !== 'blocked' &&
          !(c && isRevoked(c, r.dk)) &&
          (expect === null || r.ik === expect)
        )
      },
      hello: (r: { ik: string }) => this.helloFor(r.ik),
      onHello: (m: Message, s: Session) => this.onHello(m, s),
    }
  }

  private run(s: Session) {
    this.pending.add(s)
    s.onReady(() => this.ready(s))
    s.onClose((_, why) => this.closed(s, why))
    s.on('profile', m => this.onProfile(m, s))
    s.on('verified', m => this.onVerified(m, s))
    s.on('devices', m => this.onDevices(m, s))
    s.start()
  }

  private ready(s: Session) {
    this.pending.delete(s)
    const dk = s.remote?.dk as string
    const other = this.sessions.get(dk)
    if (other && other !== s) {
      // Both sides dialed at once: keep the session the lower peer id started, on both ends.
      const keepNew = this.initiatorOf(s) < this.initiatorOf(other)
      if (!keepNew) return s.close('replaced')
      this.sessions.delete(dk)
      other.close('replaced')
    }
    // Only an authenticated mutual contact gets here, so only it may push out another session.
    if (!this.sessions.has(dk)) this.makeRoom(s)
    this.sessions.set(dk, s)
    const ik = s.remote?.ik as string
    this.dialing.delete(ik)
    this.dials.delete(ik)
    this.touch(ik)
    this.changed()
  }

  private initiatorOf(s: Session) {
    return s.role === 'initiator' ? this.peerId : s.peer
  }

  private closed(s: Session, why: string) {
    this.pending.delete(s)
    const r = s.remote
    // Refusals count too: blocked, revoked or not-yet-accepted keys can't probe freely.
    if ((why === 'handshake' || why === 'refused') && s.role === 'responder') {
      const list = this.failed.get(s.peer) ?? []
      list.push(this.clock.now())
      this.failed.set(s.peer, list)
    }
    if (why === 'strikes') {
      this.banned.set(s.peer, this.clock.now() + LIMITS.strikeBanMs)
      if (r) this.banned.set(r.ik, this.clock.now() + LIMITS.strikeBanMs)
    }
    if (r && this.sessions.get(r.dk) === s) {
      this.sessions.delete(r.dk)
      this.touch(r.ik)
      this.changed()
    }
  }

  private touch(ik: string) {
    const now = this.clock.now()
    // The database may be closing (sign out, Remove P2P data).
    this.update(ik, cur =>
      cur && cur.state !== 'blocked' ? { ...cur, lastSeen: now } : null
    ).catch(() => {})
  }

  // Past the budget, the least recently useful established session makes room.
  private makeRoom(keep: Session) {
    if (this.sessions.size < LIMITS.sessions) return
    const victim = [...this.sessions.values()]
      .filter(x => x !== keep)
      .sort((a, b) => a.lastUseful - b.lastUseful)[0]
    victim?.close('closed')
  }

  private relOf(ik: string): Rel {
    const c = this.contacts.get(ik)
    if (!c) return 'none'
    // An ignored requester sees the same as one still waiting.
    if (c.ignored) return c.state === 'incoming' ? 'pending' : 'none'
    switch (c.state) {
      case 'mutual':
        return 'mutual'
      case 'outgoing':
        return 'request'
      case 'incoming':
        return 'pending'
      case 'blocked':
        return 'none'
    }
  }

  private helloFor(ik: string): Message {
    const msg: Message = {
      t: 'hello',
      v: 1,
      rel: this.relOf(ik),
      profile: this.self.profile,
      certs: this.self.certs.slice(0, HELLO_CERTS),
      revs: this.self.revocations.slice(-HELLO_CERTS),
    }
    const intro = this.contacts.get(ik)?.intros[0]
    if (intro && msg.rel === 'request') msg.intro = intro
    if (this.self.succession) msg.succ = this.self.succession
    return msg
  }

  private async onHello(m: Message, s: Session): Promise<boolean> {
    const r = s.remote
    if (!r) return false
    const certs = (Array.isArray(m.certs) ? m.certs : [])
      .slice(0, HELLO_CERTS)
      .filter((c): c is Cert => verifyCert(c, r.ik))
    const revs = (Array.isArray(m.revs) ? m.revs : [])
      .slice(0, HELLO_CERTS)
      .filter((x): x is Revocation => verifyRevocation(x, r.ik))
    if (revs.some(x => x.dk === r.dk)) return false
    if (!certs.some(c => c.dk === r.dk)) certs.unshift(r.cert)
    const profile = verifyProfile(m.profile, r.ik) ? m.profile : null
    const rel = m.rel
    if (rel !== 'request' && rel !== 'mutual' && rel !== 'none' && rel !== 'pending') return false
    const now = this.clock.now()

    if (!this.contacts.has(r.ik) && verifySuccession(m.succ) && m.succ.new === r.ik) {
      const succ = m.succ
      const moved = await this.deps.store.replaceContact(succ.old, old => {
        const next = applySuccession([old], succ, certs, profile, now)
        return next && recheckName(this.others(succ.old), old, next)
      })
      if (moved) {
        this.contacts.delete(succ.old)
        this.contacts.set(moved.ik, moved)
        this.changed()
      }
    }

    const asks = rel === 'request' || rel === 'mutual'
    const known = this.contacts.has(r.ik)
    // The slot is taken before any await, so concurrent hellos can't all pass the limit.
    const slot = asks && !known
    if (slot) {
      if (!this.requestAllowed()) {
        await this.countDropped(1)
        return false
      }
      this.requestTimes.push(now)
    }
    let ok = false
    let created = false
    const c = await this.update(r.ik, cur => {
      if (cur?.state === 'blocked' || (cur && isRevoked(cur, r.dk))) return null
      let next: Contact
      if (asks) {
        const res = receiveRequest(
          cur ? [cur] : [],
          { ik: r.ik, certs, profile, intro: String(m.intro ?? '') },
          now
        )
        if (res.kind === 'dropped') return null
        next = res.contact
        created = res.kind === 'new'
      } else if (cur) {
        next = withProfile({ ...cur }, profile)
        if (rel === 'none') next = unfriended(next)
      } else return null
      next = recheckName(this.others(r.ik), cur, updateDevices(next, certs, revs, now))
      ok = true
      return next
    })
    if (slot && !created) {
      const i = this.requestTimes.lastIndexOf(now)
      if (i >= 0) this.requestTimes.splice(i, 1)
    }
    if (!ok || !c) return false
    // A hello from a new device may carry revocations for one still connected.
    for (const x of this.sessionsOf(r.ik))
      if (x !== s && x.remote && isRevoked(c, x.remote.dk)) x.close('refused')
    if (created) await this.pruneRequests()
    // Presence and messages flow only between mutual contacts.
    return c.state === 'mutual' && asks
  }

  private others(ik: string) {
    return [...this.contacts.values()].filter(c => c.ik !== ik)
  }

  private requestAllowed() {
    const now = this.clock.now()
    this.requestTimes = this.requestTimes.filter(t => now - t < 3_600_000)
    return this.requestTimes.length < LIMITS.requestsPerHour
  }

  // Keeps at most LIMITS.requests pending requests: the oldest unverified ones go.
  private async pruneRequests() {
    const drop = overflowRequests([...this.contacts.values()], LIMITS.requests)
    let n = 0
    for (const ik of drop) {
      const gone = await this.deps.store.deleteContactIf(
        ik,
        c => c.state !== 'incoming' || c.ignored || c.verified
      )
      if (gone) {
        this.contacts.delete(ik)
        n += 1
      }
    }
    if (n) await this.countDropped(n)
  }

  private async countDropped(n: number) {
    this.dropped += n
    await this.deps.store.setMeta('dropped', this.dropped).catch(() => {})
    this.changed()
  }

  async clearDropped() {
    this.dropped = 0
    await this.deps.store.setMeta('dropped', 0)
    this.changed()
  }

  private async onProfile(m: Message, s: Session) {
    const r = s.remote
    const c = r && this.contacts.get(r.ik)
    if (!c || !verifyProfile(m.profile, c.ik)) return s.strike()
    const p = m.profile
    await this.update(c.ik, cur => {
      if (!cur) return null
      const next = withProfile(cur, p)
      return next === cur ? null : recheckName(this.others(cur.ik), cur, next)
    })
  }

  private async onDevices(m: Message, s: Session) {
    const r = s.remote
    const c = r && this.contacts.get(r.ik)
    if (!c) return s.strike()
    // Bounded before any signature check: each one is a pure-JS verify.
    const certs = (Array.isArray(m.certs) ? m.certs : [])
      .slice(0, CERTS_KEPT)
      .filter((x): x is Cert => verifyCert(x, c.ik))
    const revs = (Array.isArray(m.revs) ? m.revs : [])
      .slice(0, CERTS_KEPT * 2)
      .filter((x): x is Revocation => verifyRevocation(x, c.ik))
    const now = this.clock.now()
    const next = await this.update(c.ik, cur => (cur ? updateDevices(cur, certs, revs, now) : null))
    // A device revoked just now loses its session at once.
    if (next)
      for (const x of this.sessionsOf(c.ik))
        if (x.remote && isRevoked(next, x.remote.dk)) x.close('refused')
  }

  private async onVerified(m: Message, s: Session) {
    const r = s.remote
    const c = r && this.contacts.get(r.ik)
    if (!c || typeof m.n !== 'string') return s.strike()
    if (!this.verifyNonces.get(c.ik)?.includes(m.n)) return
    this.verifyNonces.delete(c.ik)
    const now = this.clock.now()
    await this.update(c.ik, cur => (cur ? markVerified(cur, now) : null))
  }

  private sessionsOf(ik: string) {
    return [...this.sessions.values()].filter(s => s.remote?.ik === ik)
  }

  private broadcast(msg: Message) {
    for (const s of this.sessions.values()) void s.send(msg).catch(() => {})
  }

  // ----- Dialing -----

  // Starts dials to contacts without a session, at most LIMITS.inFlight at once, each contact
  // backing off while unreachable. `now` skips the backoff (the tab came back, or an accept).
  schedule(now = false) {
    if (this.stopped || this.isPaused() || !this.listener) return
    const t = this.clock.now()
    for (const c of this.contacts.values()) {
      if (this.dialing.size >= LIMITS.inFlight) return
      if (this.sessions.size + this.dialing.size >= LIMITS.sessions) return
      if (c.state !== 'mutual' && c.state !== 'outgoing') continue
      if (this.dialing.has(c.ik) || this.sessionsOf(c.ik).length > 0) continue
      if (this.isBanned(c.ik)) continue
      const d = this.dials.get(c.ik)
      if (!now && d && d.nextAt > t) continue
      void this.dial(c)
    }
  }

  private async dial(c: Contact) {
    const devices = dialable(c)
    if (devices.length === 0) return
    this.dialing.add(c.ik)
    this.changed()
    let ok = false
    for (const cert of devices) {
      if (this.sessions.has(cert.dk)) {
        ok = true
        break
      }
      for (const id of peerIds(cert.dk)) {
        if (this.stopped || this.isPaused()) break
        let pipe: Pipe
        try {
          pipe = await this.deps.transport.dial(this.peerId, id)
        } catch {
          continue
        }
        if (this.stopped || this.isPaused()) {
          pipe.close()
          break
        }
        ok = await this.handshakeWith(pipe, c.ik)
        if (ok) break
      }
      if (ok) break
    }
    this.dialing.delete(c.ik)
    const prev = this.dials.get(c.ik)
    // Outgoing requests back off even when they got through: the other side decides.
    if (!ok || this.contacts.get(c.ik)?.state !== 'mutual') {
      const attempt = Math.min((prev?.attempt ?? -1) + 1, LIMITS.backoff.length - 1)
      this.dials.set(c.ik, { attempt, nextAt: this.clock.now() + LIMITS.backoff[attempt] })
    }
    this.changed()
    this.schedule()
  }

  private handshakeWith(pipe: Pipe, ik: string) {
    return new Promise<boolean>(resolve => {
      const s = new Session(this.sessionOpts('initiator', pipe, ik))
      s.onReady(() => resolve(true))
      s.onClose(() => resolve(false))
      this.run(s)
    })
  }

  // ----- Contacts -----

  // Applies `fn` to the stored contact inside one transaction and mirrors the result.
  private async update(ik: string, fn: (cur: Contact | undefined) => Contact | null) {
    const c = await this.deps.store.updateContact(ik, fn)
    if (c) this.contacts.set(ik, c)
    else this.contacts.delete(ik)
    this.changed()
    return c
  }

  // Our own record, only while it is still the identity this node runs: a tab that missed an
  // identity reset must not write the old keys back.
  private async writeSelf(fn: (cur: SelfRecord) => SelfRecord) {
    const mine = this.self
    let ok = false
    const stored = await this.deps.store.updateSelf(cur => {
      if (!cur || !equalBytes(cur.ik.pk, mine.ik.pk) || !equalBytes(cur.dk.pk, mine.dk.pk))
        return null
      ok = true
      return fn(cur)
    })
    if (!ok || !stored) throw new Error(ELSEWHERE)
    this.self = stored
  }

  async myCard(): Promise<string> {
    return encodeCard(makeCard(this.self.ik, this.self.certs, this.name, this.deps.host))
  }

  async readCard(text: string): Promise<Card> {
    const card = await decodeCard(text)
    // The host is an unsigned hint: it only explains why a contact elsewhere can't be reached.
    if (card.sig_host !== this.deps.host) throw new Error(OTHER_HOST(card.sig_host))
    return card
  }

  async addContact(text: string, intro = ''): Promise<AddResult> {
    let card: Card
    try {
      card = await this.readCard(text)
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    const mine = cleanIntro(intro).trim()
    const now = this.clock.now()
    let res: AddResult = { ok: false, error: BAD_CARD }
    await this.update(card.ik, cur => {
      res = addFromCard([...this.others(card.ik), ...(cur ? [cur] : [])], card, this.ik, now)
      if (!res.ok) return null
      const c = res.contact
      return c.state === 'outgoing' && mine ? { ...c, intros: [mine] } : c
    })
    if (!res.ok) return res
    this.dials.delete(card.ik)
    this.schedule(true)
    return res
  }

  async accept(ik: string) {
    if (!(await this.update(ik, cur => (cur ? accept(cur) : null)))) return
    this.dials.delete(ik)
    this.schedule(true)
  }

  async ignore(ik: string) {
    await this.update(ik, cur => (cur ? ignore(cur) : null))
  }

  async block(ik: string) {
    for (const s of this.sessionsOf(ik)) s.close('refused')
    await this.update(ik, cur => (cur ? block(cur) : null))
  }

  async remove(ik: string) {
    for (const s of this.sessionsOf(ik)) s.close('refused')
    this.contacts.delete(ik)
    this.dials.delete(ik)
    await this.deps.store.deleteContact(ik)
    this.changed()
  }

  async rename(ik: string, petname: string) {
    await this.update(ik, cur => (cur ? rename(cur, petname) : null))
  }

  async markVerified(ik: string) {
    const now = this.clock.now()
    await this.update(ik, cur => (cur ? markVerified(cur, now) : null))
  }

  // The code to show for QR verification with this contact; when they scan it, their client
  // tells ours over the session and both sides mark each other verified.
  verifyCodeFor(ik: string) {
    const nonce = randomBytes(NONCE_BYTES)
    // A few recent codes stay valid, so a code shown a moment ago still works.
    this.verifyNonces.set(ik, [...(this.verifyNonces.get(ik) ?? []), b64u(nonce)].slice(-4))
    return verifyCode(this.ik, ik, nonce)
  }

  async scanVerifyCode(ik: string, text: string) {
    const check = checkVerifyCode(text, this.ik, ik)
    if (check !== 'ok') return { ok: false, text: verifyCheckText(check) }
    await this.markVerified(ik)
    const n = parseVerifyCode(text)?.n as string
    for (const s of this.sessionsOf(ik)) void s.send({ t: 'verified', n }).catch(() => {})
    return { ok: true, text: verifyCheckText(check) }
  }

  async setName(name: string) {
    const clean = cleanName(name)
    if (!clean) return
    const now = this.clock.now()
    await this.writeSelf(cur => ({
      ...cur,
      profile: signProfile(cur.ik, clean, Math.max(now, cur.profile.updated + 1)),
    }))
    this.broadcast({ t: 'profile', profile: this.self.profile })
    this.changed()
  }

  // A new identity key that the old one vouches for: contacts move over automatically, but see
  // the key change and lose their verified mark.
  async resetIdentity(label = 'Browser') {
    const now = this.clock.now()
    const ik = newKeyPair()
    const dk = newKeyPair()
    const cert = signCert(ik, dk.pk, now, label)
    const succession = signSuccession(this.self.ik, ik, now)
    await this.writeSelf(cur => ({
      ...cur,
      ik,
      dk,
      cert,
      certs: [cert],
      revocations: [],
      profile: signProfile(ik, cur.profile.name, now),
      succession,
      suffix: 0,
    }))
    this.halt('closed')
    this.dials.clear()
    if (!this.isPaused() && !this.stopped) await this.listen()
    this.changed()
  }

  // Display name for a contact, petname first.
  nameOf(ik: string) {
    const c = this.contacts.get(ik)
    return c ? displayName(c) : ''
  }
}
