import { isRecord } from '../bytes'
import { b64u, equalBytes, randomBytes } from './canonical'
import { BAD_CARD, decodeCard, encodeCard, makeCard, type Card } from './card'
import {
  accept,
  addFromCard,
  applySuccession,
  block,
  cleanIntro,
  dialable,
  displayName,
  ignore,
  isRevoked,
  markVerified,
  mergeCerts,
  mergeRevocations,
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
import { hasSecrets, withoutSecrets, type OwnBadge, type P2pStore, type SelfRecord } from './db'
import type { Me } from './handshake'
import {
  bindingProof,
  cleanName,
  isKeyId,
  keyId,
  newKeyPair,
  peerId,
  peerIds,
  signCert,
  signProfile,
  signRevocation,
  signSuccession,
  signTagged,
  SUFFIX_MAX,
  TAG,
  verifyCert,
  verifyProfile,
  verifyRevocation,
  verifySuccession,
  verifyTagged,
  withSuffix,
  type Cert,
  type Profile,
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
  dial: (from: string, to: string, kind?: 'bulk') => Promise<Pipe>
  // The node's proofs for offers that declare relays, and its check of others' (relays.ts asks
  // about a relay only for a signed device of someone we'd talk to).
  guard?: (g: OfferGuard) => void
}

// An offer's proof: our device key (no more than the peer id tells) and its signature over who
// dials whom, the relays declared and when. Never the identity: signaling sees offers in clear.
export interface OfferProof {
  dk: string
  ts: number
  sig: string
}

export interface OfferGuard {
  vouch: (from: string, to: string, relays: string[]) => OfferProof | null
  // The identity behind an offer from peer id `src`, or null.
  sender: (src: string, proof: unknown, relays: string[]) => string | null
}

export const OFFER_SKEW_MS = 2 * 60_000

export interface Visibility {
  visible: () => boolean
  onChange: (fn: () => void) => () => void
  // Sessions pause after a while hidden (phones drop background pages anyway).
  pauses?: () => boolean
}

export const LIMITS = {
  sessions: 48,
  // Of those, sessions with identities that aren't mutual contacts (P2P server members): they
  // never push out a contact's session.
  memberSessions: 32,
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
  // When this browser's identity moved to another device.
  movedAt: number | null
  // When a P2P export paused sending here (until the user resumes).
  movingAt: number | null
  // When we saw signs that another device uses this identity.
  alertAt: number | null
  badge: OwnBadge | null
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

const REL = ['request', 'mutual', 'none', 'pending']
const HELLO_CERTS = 4
// Devices of ours recorded as no longer ours (lost, stolen or signed out by recovery).
const LOST_KEPT = 256

// Our devices as a contact knows them disagree with a single line of moves: one device revoked
// twice with different successors, or a live device that isn't this one. Every device holds the
// identity key, so this means a copy of it is in use somewhere else.
export const identityConflict = (self: SelfRecord, certs: Cert[], revs: Revocation[]) => {
  const me = keyId(self.dk.pk)
  const all = [...self.revocations, ...revs]
  const forked = all.some(a =>
    all.some(
      b =>
        b.dk === a.dk &&
        a.successor !== undefined &&
        b.successor !== undefined &&
        b.successor !== a.successor
    )
  )
  const revoked = (dk: string) => all.some(r => r.dk === dk)
  return forked || certs.some(c => c.dk !== me && !revoked(c.dk))
}

const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : [])

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

// Features that ride on sessions (room sync): handlers go on every session before it is up,
// `ready` runs once it is an established session with a mutual contact (or someone an extension
// wants a session with, such as a fellow P2P server member).
export interface NodeExt {
  attach: (s: Session) => void
  ready: (s: Session) => void
  // A bulk pipe a ready session's peer opened to us.
  bulk?: (pipe: Pipe, s: Session) => void
  // Identities to keep sessions with besides contacts, with their devices, most wanted first.
  targets?: () => { ik: string; certs: Cert[] }[]
  // Identities to dial before anyone else, past the session budget (voice participants).
  urgent?: () => { ik: string; certs: Cert[] }[]
  // Sessions that never make room for others.
  keep?: (s: Session) => boolean
  // Keeps every session up while the page is hidden (an answered call, a joined voice channel).
  awake?: () => boolean
  // Whether a session with an identity that isn't a mutual contact is wanted, given its hello.
  wanted?: (ik: string, hello: Message) => boolean
  // Signed devices and profile of a session peer that isn't a contact.
  learn?: (ik: string, certs: Cert[], revs: Revocation[], profile: Profile | null) => void
  // Whether `ik` is a fellow member of a server we are in.
  member?: (ik: string) => boolean
  // Devices of an identity that isn't a contact (fellow server members).
  devices?: (ik: string) => { certs: Cert[]; revocations: Revocation[] } | null
  // The fellow member a device key is certified for, if we know it.
  owner?: (dk: string) => string | null
}

// What a dial to a peer id we only know from an invite code says in its hello.
export type Purpose = Record<string, unknown>

export interface Held {
  contact: boolean
  kept: boolean
  lastUseful: number
}

// Which held session makes room for a new one past the budget (LIMITS): -1 when none has to,
// null when none may. The least recently useful goes first; a kept session (a voice participant)
// never goes. At the total cap, a contact's or a kept session may push out anyone else, a
// member's only another member's. Members have a budget of their own: a kept newcomer is let in
// past it, while kept member sessions still count towards it for anyone else.
export const victimFor = (
  held: Held[],
  s: { contact: boolean; kept: boolean },
  limits: { sessions: number; memberSessions: number } = LIMITS
): number | null => {
  const members = held.filter(x => !x.contact).length
  const full = held.length >= limits.sessions
  if (!full && (s.contact || s.kept || members < limits.memberSessions)) return -1
  const any = full && (s.contact || s.kept)
  let best: number | null = null
  held.forEach((x, i) => {
    if (x.kept || (!any && x.contact)) return
    if (best === null || x.lastUseful < held[best].lastUseful) best = i
  })
  return best
}

export class P2pNode {
  status: Status = 'starting'
  private contacts = new Map<string, Contact>()
  // Ready sessions by remote device key, and every session in progress.
  private sessions = new Map<string, Session>()
  private pending = new Set<Session>()
  private dialing = new Set<string>()
  private dials = new Map<string, DialState>()
  // Peer ids dialed for a purpose (an invite code): our hello says it, and the session is let
  // through whoever answers.
  private purposes = new Map<string, Purpose>()
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
  private bindingFns = new Set<(ik: string, token: unknown) => void>()
  private exts: NodeExt[] = []
  private clock: Clock

  private constructor(
    private self: SelfRecord,
    private deps: NodeDeps
  ) {
    this.clock = deps.clock ?? realClock
    deps.transport.guard?.({
      vouch: (from, to, relays) => this.vouch(from, to, relays),
      sender: (src, proof, relays) => this.offerFrom(src, proof, relays),
    })
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
    // Stored before moved browsers dropped their secrets.
    if (self.moved && hasSecrets(self))
      self =
        (await deps.store.updateSelf(cur =>
          cur?.moved && hasSecrets(cur) ? withoutSecrets(cur) : null
        )) ?? self
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

  use(ext: NodeExt) {
    this.exts.push(ext)
  }

  // The keys new events are signed with; none once this identity moved to another device.
  author() {
    return this.self.moved ? null : { ik: this.self.ik, dk: this.self.dk }
  }

  get moved() {
    return this.self.moved !== null
  }

  // Certified devices of an identity: ours, or a contact's.
  devicesOf(ik: string) {
    if (ik === this.ik) return { certs: this.self.certs, revocations: this.self.revocations }
    const c = this.contacts.get(ik)
    return c ? { certs: c.certs, revocations: c.revocations } : null
  }

  // The same, also for fellow members of our P2P servers.
  anyDevicesOf(ik: string) {
    const own = this.devicesOf(ik)
    let more: { certs: Cert[]; revocations: Revocation[] } | null = null
    for (const x of this.exts) more ??= x.devices?.(ik) ?? null
    if (!own) return more
    if (!more) return own
    return {
      certs: [...own.certs, ...more.certs],
      revocations: [...own.revocations, ...more.revocations],
    }
  }

  // Our signed profile and devices, for server member events.
  get profile(): Profile {
    return this.self.profile
  }

  get cert(): Cert {
    return this.self.cert
  }

  // ----- Account badge -----

  get badge(): OwnBadge | null {
    return this.self.badge ?? null
  }

  // The binding we hand out: while the badge is on, for this identity key, not expired.
  get binding(): string | null {
    const b = this.self.badge
    return b?.on &&
      typeof b.token === 'string' &&
      b.ik === this.ik &&
      b.exp * 1000 > this.clock.now() &&
      !this.self.moved
      ? b.token
      : null
  }

  async setBadge(badge: OwnBadge | null) {
    await this.writeSelf(cur => ({ ...cur, badge }))
    this.broadcastProfile()
    this.changed()
  }

  // The identity key's signature the instance wants before it binds the key to `sub`.
  bindingProof(sub: string, ts: number): string | null {
    return this.self.moved || !hasSecrets(this.self) ? null : bindingProof(this.self.ik, sub, ts)
  }

  // Bindings peers send for themselves (hello, profile) or that member events carry; unchecked.
  onBinding(fn: (ik: string, token: unknown) => void) {
    this.bindingFns.add(fn)
    return () => void this.bindingFns.delete(fn)
  }

  heardBinding(ik: string, token: unknown) {
    if (ik === this.ik) return
    for (const fn of this.bindingFns) fn(ik, token)
  }

  // A contact confirmed as the account another contact was confirmed as: the identity warning,
  // unless they were verified.
  async warnAccount(ik: string, other: string) {
    await this.update(ik, cur =>
      cur && cur.warning === null && !cur.verified && cur.state !== 'blocked'
        ? { ...cur, warning: other }
        : null
    )
  }

  // The binding goes only to who the opt-in names: mutual contacts, contacts we asked, and
  // fellow server members (or the peer of an invite code we dialed).
  private bindingFor(ik: string, peer: string): string | null {
    const binding = this.binding
    if (!binding || this.contacts.get(ik)?.state === 'blocked') return null
    const rel = this.relOf(ik)
    if (rel === 'mutual' || rel === 'request') return binding
    if (this.purposes.has(peer) || this.exts.some(x => x.member?.(ik) === true)) return binding
    return null
  }

  private profileMsg(ik: string, peer: string): Message {
    const binding = this.bindingFor(ik, peer)
    return binding
      ? { t: 'profile', profile: this.self.profile, binding }
      : { t: 'profile', profile: this.self.profile }
  }

  private broadcastProfile() {
    for (const s of this.sessions.values())
      if (s.remote) void s.send(this.profileMsg(s.remote.ik, s.peer)).catch(() => {})
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
      movedAt: this.self.moved?.at ?? null,
      movingAt: this.self.moving?.at ?? null,
      alertAt: this.self.alert ?? null,
      badge: this.self.badge ?? null,
    }
  }

  presence(ik: string): Presence {
    for (const s of this.sessions.values()) if (s.remote?.ik === ik) return 'online'
    return this.dialing.has(ik) ? 'dialing' : 'offline'
  }

  contact(ik: string) {
    return this.contacts.get(ik)
  }

  contactList() {
    return [...this.contacts.values()]
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
    this.prune()
    this.schedule()
  }

  // Failed handshakes older than a minute and ended bans are forgotten.
  private prune() {
    const now = this.clock.now()
    for (const [peer, ts] of this.failed)
      if (ts.every(t => now - t >= 60_000)) this.failed.delete(peer)
    for (const [key, until] of this.banned) if (until <= now) this.banned.delete(key)
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

  // Phones drop background tabs anyway: there, after 5 minutes hidden every session closes
  // (not during a call or in a voice channel), and they come back when the tab is visible again.
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
    if (this.hiddenTimer !== null || this.deps.visibility?.pauses?.() !== true) return
    this.hiddenTimer = this.clock.set(() => {
      this.hiddenTimer = null
      if (this.deps.visibility?.visible() !== false) return
      if (this.exts.some(x => x.awake?.() === true)) return this.armHiddenPause()
      this.hiddenPaused = true
      this.halt('paused')
      this.status = 'paused'
      this.changed()
    }, LIMITS.hiddenPauseMs)
  }

  // ----- Offers -----

  private vouch(from: string, to: string, relays: string[]): OfferProof | null {
    if (this.self.moved || !hasSecrets(this.self)) return null
    const ts = this.clock.now()
    const sig = signTagged(this.self.dk.sk, TAG.offer, { from, to, relays, ts })
    return { dk: this.dk, ts, sig }
  }

  // Signed by the device that registered `src`, for us, lately: a device we already know of a
  // contact or a fellow member, not one we refuse. Anyone else gets no prompt.
  private offerFrom(src: string, proof: unknown, relays: string[]): string | null {
    if (!isRecord(proof)) return null
    const { dk, ts, sig } = proof
    if (!Number.isSafeInteger(ts) || Math.abs(this.clock.now() - (ts as number)) > OFFER_SKEW_MS)
      return null
    if (!isKeyId(dk) || !peerIds(dk).includes(src)) return null
    const ik = this.ownerOf(dk)
    if (ik === null || ik === this.ik || this.isBanned(ik) || this.isBanned(src)) return null
    if (this.revokedDevice(ik, dk)) return null
    const body = { from: src, to: this.peerId, relays, ts }
    return verifyTagged(dk, TAG.offer, body, sig) ? ik : null
  }

  // Whose device `dk` is: a contact we talk to (not blocked or ignored), or a fellow member.
  private ownerOf(dk: string): string | null {
    for (const c of this.contacts.values())
      if (c.certs.some(x => x.dk === dk)) return c.state !== 'blocked' && !c.ignored ? c.ik : null
    for (const x of this.exts) {
      const ik = x.owner?.(dk) ?? null
      if (ik !== null && this.exts.some(y => y.member?.(ik) === true)) return ik
    }
    return null
  }

  // ----- Sessions -----

  // A device revoked in what we know of the identity: a contact's, or a fellow member's.
  private revokedDevice(ik: string, dk: string) {
    return this.anyDevicesOf(ik)?.revocations.some(r => r.dk === dk) === true
  }

  // The revocation that moved this device to a new one, if any.
  private movedDevice(ik: string, dk: string) {
    return (
      this.anyDevicesOf(ik)?.revocations.find(r => r.dk === dk && r.successor !== undefined) ?? null
    )
  }

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
    if (pipe.kind === 'bulk') return this.incomingBulk(pipe)
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

  // Only from the peer of a ready session, and only to an extension that takes bulk pipes.
  private incomingBulk(pipe: Pipe) {
    const s = [...this.sessions.values()].find(x => x.peer === pipe.remote && x.state === 'ready')
    const ext = this.exts.find(x => x.bulk)
    if (!s || !ext?.bulk || this.stopped || this.isPaused()) return pipe.close()
    ext.bulk(pipe, s)
  }

  // Opens a bulk pipe to the device of a ready session.
  async dialBulk(s: Session): Promise<Pipe> {
    if (s.state !== 'ready' || this.stopped) throw new TransportError('network')
    return this.deps.transport.dial(this.peerId, s.peer, 'bulk')
  }

  allReady() {
    return [...this.sessions.values()].filter(s => s.state === 'ready')
  }

  // Ready sessions with the devices of an identity.
  readySessions(ik: string) {
    return [...this.sessions.values()].filter(s => s.remote?.ik === ik && s.state === 'ready')
  }

  private sessionOpts(role: 'initiator' | 'responder', pipe: Pipe, expect: string | null) {
    return {
      role,
      pipe,
      me: this.me(),
      clock: this.clock,
      // A device that moved away is let through only to hear that it moved (our hello says so),
      // then refused.
      admit: (r: { ik: string; dk: string }) =>
        r.ik !== this.ik &&
        !this.isBanned(r.ik) &&
        this.contacts.get(r.ik)?.state !== 'blocked' &&
        !(this.revokedDevice(r.ik, r.dk) && !this.movedDevice(r.ik, r.dk)) &&
        (expect === null || r.ik === expect),
      hello: (r: { ik: string; dk: string }) => this.helloFor(r, pipe.remote),
      onHello: (m: Message, s: Session) => this.hello(m, s),
    }
  }

  private run(s: Session) {
    this.pending.add(s)
    s.onReady(() => this.ready(s))
    s.onClose((_, why) => this.closed(s, why))
    s.on('profile', m => this.onProfile(m, s))
    s.on('verified', m => this.onVerified(m, s))
    s.on('yours', m => this.onYours(m, s))
    for (const x of this.exts) x.attach(s)
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
    // Past the budget, someone makes room; a server member's session never pushes out a
    // contact's (and is closed itself when nothing else can go).
    if (!this.sessions.has(dk) && !this.makeRoom(s)) return s.close('closed')
    this.sessions.set(dk, s)
    const ik = s.remote?.ik as string
    this.dialing.delete(ik)
    this.dials.delete(ik)
    this.touch(ik)
    this.changed()
    for (const x of this.exts) x.ready(s)
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

  private isContactSession(s: Session) {
    const ik = s.remote?.ik
    return !!ik && this.contacts.get(ik)?.state === 'mutual'
  }

  // Past the budget, the least recently useful established session makes room: any session
  // for a contact, only another member's session for a server member (which also has a budget
  // of its own). False when nothing may go.
  private makeRoom(keep: Session) {
    const others = [...this.sessions.values()].filter(x => x !== keep)
    const held = others.map(x => ({
      contact: this.isContactSession(x),
      kept: this.isKept(x),
      lastUseful: x.lastUseful,
    }))
    const i = victimFor(held, { contact: this.isContactSession(keep), kept: this.isKept(keep) })
    if (i === null) return false
    if (i >= 0) others[i].close('closed')
    return true
  }

  private isKept(s: Session) {
    return this.exts.some(x => x.keep?.(s) === true)
  }

  // Whether a dial to `ik` is under way, and whether one may start now.
  isDialing(ik: string) {
    return this.dialing.has(ik)
  }

  canDial(ik: string) {
    const d = this.dials.get(ik)
    return (
      ik !== this.ik &&
      !this.dialing.has(ik) &&
      !this.isBanned(ik) &&
      this.contacts.get(ik)?.state !== 'blocked' &&
      !(d && d.nextAt > this.clock.now())
    )
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

  private helloFor({ ik, dk }: { ik: string; dk: string }, peer: string): Message {
    const moved = this.movedDevice(ik, dk)
    if (moved) return { t: 'hello', v: 1, rel: 'none', moved }
    const purpose = this.purposes.get(peer)
    const msg: Message = {
      t: 'hello',
      v: 1,
      rel: this.relOf(ik),
      profile: this.self.profile,
      certs: this.self.certs.slice(0, HELLO_CERTS),
      revs: this.self.revocations.slice(-HELLO_CERTS),
    }
    const binding = this.bindingFor(ik, peer)
    if (binding) msg.binding = binding
    const intro = this.contacts.get(ik)?.intros[0]
    if (intro && msg.rel === 'request') msg.intro = intro
    if (this.self.succession) msg.succ = this.self.succession
    const yours = this.yoursFor(ik)
    if (yours) msg.yours = yours
    if (purpose) Object.assign(msg, purpose)
    return msg
  }

  private extWants(ik: string, m: Message) {
    return this.exts.some(x => x.wanted?.(ik, m) === true)
  }

  // What we know of a contact's devices, echoed back to them: their device can tell when a copy
  // of their identity is in use somewhere else.
  private yoursFor(ik: string) {
    const c = this.contacts.get(ik)
    if (!c || c.state === 'blocked') return null
    return { certs: c.certs.slice(0, HELLO_CERTS), revs: c.revocations.slice(-HELLO_CERTS * 2) }
  }

  private async checkYours(y: unknown) {
    if (!isRecord(y) || this.self.moved) return
    const certs = arr(y.certs)
      .slice(0, HELLO_CERTS)
      .filter((c): c is Cert => verifyCert(c, this.ik))
    const revs = arr(y.revs)
      .slice(0, HELLO_CERTS * 2)
      .filter((x): x is Revocation => verifyRevocation(x, this.ik))
    const ours = revs.find(x => this.isOurMove(x))
    if (ours) return this.markMoved(ours)
    if (identityConflict(this.self, certs, revs)) await this.raiseAlert()
  }

  private async onYours(m: Message, s: Session) {
    const r = s.remote
    if (!r || !this.contacts.has(r.ik)) return s.strike()
    await this.checkYours(m)
  }

  private async raiseAlert() {
    if (this.self.alert) return
    const now = this.clock.now()
    await this.writeSelf(cur => ({ ...cur, alert: cur.alert ?? now })).catch(() => {})
    this.changed()
  }

  // A hello, then the binding it carries: from a session peer we keep, or a request we hold.
  private async hello(m: Message, s: Session): Promise<boolean> {
    const ok = await this.onHello(m, s)
    const ik = s.remote?.ik
    const c = ik ? this.contacts.get(ik) : undefined
    if (ik && m.binding !== undefined && m.moved === undefined && c?.state !== 'blocked')
      if (ok || c) this.heardBinding(ik, m.binding)
    return ok
  }

  private async onHello(m: Message, s: Session): Promise<boolean> {
    const r = s.remote
    if (!r) return false
    // Our identity moved to another device, and a contact tells us with our own signed
    // revocation of this device.
    if (m.moved !== undefined) {
      if (this.isOurMove(m.moved)) await this.markMoved(m.moved)
      return false
    }
    const known = this.contacts.get(r.ik)
    if (known && m.yours !== undefined) {
      await this.checkYours(m.yours)
      if (this.self.moved) return false
    }
    if (known && isRevoked(known, r.dk)) return false
    const certs = (Array.isArray(m.certs) ? m.certs : [])
      .slice(0, HELLO_CERTS)
      .filter((c): c is Cert => verifyCert(c, r.ik))
    const revs = (Array.isArray(m.revs) ? m.revs : [])
      .slice(0, HELLO_CERTS)
      .filter((x): x is Revocation => verifyRevocation(x, r.ik))
    if (revs.some(x => x.dk === r.dk)) return false
    if (!certs.some(c => c.dk === r.dk)) certs.unshift(r.cert)
    const profile = verifyProfile(m.profile, r.ik) ? m.profile : null
    // A relation from a newer version is read as `pending`: it asks for nothing and changes
    // nothing (forward compatibility).
    const rel = REL.includes(m.rel as string) ? m.rel : typeof m.rel === 'string' ? 'pending' : null
    if (rel === null) return false
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
    // Someone who isn't a contact and doesn't ask to be one: a fellow server member, or the
    // other side of an invite code. Only an extension that wants the session keeps it.
    const dialedFor = this.purposes.has(s.peer)
    if (!this.contacts.has(r.ik) && (!asks || dialedFor)) {
      if (!dialedFor && !this.extWants(r.ik, m)) return false
      for (const x of this.exts) x.learn?.(r.ik, certs, revs, profile)
      return true
    }
    // The slot is taken before any await, so concurrent hellos can't all pass the limit.
    const slot = asks && !this.contacts.has(r.ik)
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
    if (!ok || !c) return this.contacts.get(r.ik)?.state !== 'blocked' && this.extWants(r.ik, m)
    // A hello from a new device may carry revocations for one still connected; the others hear
    // what we now know of their devices.
    const yours = this.yoursFor(r.ik)
    for (const x of this.sessionsOf(r.ik))
      if (x !== s && x.remote && isRevoked(c, x.remote.dk)) x.close('refused')
      else if (x !== s && yours) void x.send({ t: 'yours', ...yours }).catch(() => {})
    if (created) await this.pruneRequests()
    // Presence and messages flow only between mutual contacts, and server members.
    if (c.state === 'mutual' && asks) return true
    if (c.state === 'blocked' || !this.extWants(r.ik, m)) return false
    for (const x of this.exts) x.learn?.(r.ik, certs, revs, profile)
    return true
  }

  private isOurMove(x: unknown): x is Revocation {
    return (
      verifyRevocation(x, this.ik) &&
      x.dk === this.dk &&
      typeof x.successor === 'string' &&
      x.successor !== this.dk
    )
  }

  // This browser may no longer sign anything: every session closes, the node stays down and the
  // secret keys are dropped. A move nobody exported for here is a sign of a copy elsewhere.
  private async markMoved(rev: Revocation) {
    if (this.self.moved) return
    const now = this.clock.now()
    const moved = { at: rev.revoked_at, successor: rev.successor as string }
    const next = (cur: SelfRecord): SelfRecord =>
      withoutSecrets({
        ...cur,
        revocations: cur.revocations.some(x => x.dk === rev.dk)
          ? cur.revocations
          : [...cur.revocations, rev],
        moved,
        moving: null,
        alert: cur.alert ?? (cur.exported ? null : now),
      })
    await this.writeSelf(next).catch(() => {
      // Another tab changed the identity: this one still stops signing.
      this.self = next(this.self)
    })
    this.halt('closed')
    this.dials.clear()
    this.status = 'moved'
    this.changed()
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

  // A profile this version can't check (a newer one) changes nothing, at no cost.
  private async onProfile(m: Message, s: Session) {
    const r = s.remote
    if (!r || !verifyProfile(m.profile, r.ik)) return
    const c = this.contacts.get(r.ik)
    if (!c) {
      for (const x of this.exts) x.learn?.(r.ik, [], [], m.profile)
      if (m.binding !== undefined) this.heardBinding(r.ik, m.binding)
      return
    }
    const p = m.profile
    await this.update(c.ik, cur => {
      if (!cur) return null
      const next = withProfile(cur, p)
      return next === cur ? null : recheckName(this.others(cur.ik), cur, next)
    })
    if (m.binding !== undefined && c.state !== 'blocked') this.heardBinding(c.ik, m.binding)
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

  // ----- Dialing -----

  // Starts dials to contacts without a session, at most LIMITS.inFlight at once, each contact
  // backing off while unreachable. `now` skips the backoff (the tab came back, or an accept).
  schedule(now = false) {
    if (this.stopped || this.isPaused() || !this.listener) return
    const t = this.clock.now()
    // Voice participants first, also past the budget while a session may make room for them.
    for (const x of this.exts)
      for (const target of x.urgent?.() ?? []) {
        if (this.dialing.size >= LIMITS.inFlight) return
        const { ik } = target
        // Only the devices named (the one a participant is in voice on), with or without a
        // session with another device of theirs.
        if (
          ik === this.ik ||
          this.dialing.has(ik) ||
          target.certs.some(c => this.sessions.has(c.dk))
        )
          continue
        if (this.sessions.size + this.dialing.size >= LIMITS.sessions && !this.evictable()) break
        const c = this.contacts.get(ik)
        if (c?.state === 'blocked' || this.isBanned(ik)) continue
        const d = this.dials.get(ik)
        if (!now && d && d.nextAt > t) continue
        const revs = c?.revocations ?? []
        void this.dialTo(
          ik,
          target.certs.filter(x => !revs.some(r => r.dk === x.dk)),
          true
        )
      }
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
    for (const x of this.exts)
      for (const target of x.targets?.() ?? []) {
        if (this.dialing.size >= LIMITS.inFlight) return
        if (this.sessions.size + this.dialing.size >= LIMITS.sessions) return
        const { ik } = target
        if (ik === this.ik || this.dialing.has(ik) || this.sessionsOf(ik).length > 0) continue
        const c = this.contacts.get(ik)
        if (c?.state === 'blocked' || this.isBanned(ik)) continue
        const d = this.dials.get(ik)
        if (!now && d && d.nextAt > t) continue
        const revs = c?.revocations ?? []
        void this.dialTo(
          ik,
          target.certs.filter(x => !revs.some(r => r.dk === x.dk)),
          true
        )
      }
  }

  // A held session that may make room for a voice participant.
  private evictable() {
    return [...this.sessions.values()].some(x => !this.isKept(x))
  }

  private dial(c: Contact) {
    return this.dialTo(c.ik, dialable(c))
  }

  private async dialTo(ik: string, devices: Cert[], member = false) {
    if (devices.length === 0) return
    this.dialing.add(ik)
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
        ok = await this.handshakeWith(pipe, ik)
        if (ok) break
      }
      if (ok) break
    }
    this.dialing.delete(ik)
    const prev = this.dials.get(ik)
    // Outgoing requests back off even when they got through: the other side decides.
    if (!ok || (!member && this.contacts.get(ik)?.state !== 'mutual')) {
      const attempt = Math.min((prev?.attempt ?? -1) + 1, LIMITS.backoff.length - 1)
      this.dials.set(ik, { attempt, nextAt: this.clock.now() + LIMITS.backoff[attempt] })
    }
    this.changed()
    this.schedule()
  }

  // Dials a peer id we only know from an invite code, whoever answers. Resolves with the ready
  // session, or null when nobody answered or the other side refused.
  async dialPeer(peer: string, purpose: Purpose): Promise<Session | null> {
    if (this.stopped || this.isPaused() || !this.listener) return null
    const have = [...this.sessions.values()].find(s => s.peer === peer && s.state === 'ready')
    if (have) return have
    let pipe: Pipe
    try {
      pipe = await this.deps.transport.dial(this.peerId, peer)
    } catch {
      return null
    }
    this.purposes.set(peer, purpose)
    return new Promise<Session | null>(resolve => {
      const s = new Session(this.sessionOpts('initiator', pipe, null))
      s.onReady(() => {
        this.purposes.delete(peer)
        resolve(s)
      })
      s.onClose(() => {
        this.purposes.delete(peer)
        resolve(null)
      })
      this.run(s)
    })
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
    if (this.binding)
      for (const s of this.sessionsOf(ik)) void s.send(this.profileMsg(ik, s.peer)).catch(() => {})
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
    if (!clean || this.self.moved) return
    const now = this.clock.now()
    await this.writeSelf(cur => ({
      ...cur,
      profile: signProfile(cur.ik, clean, Math.max(now, cur.profile.updated + 1)),
    }))
    this.broadcastProfile()
    this.changed()
  }

  // The same profile signed again with a newer date (servers.refreshBadge).
  async touchProfile() {
    if (this.self.moved) return
    const now = this.clock.now()
    await this.writeSelf(cur => ({
      ...cur,
      profile: signProfile(
        cur.ik,
        cur.profile.name,
        Math.max(now, cur.profile.updated + 1),
        cur.profile.color
      ),
    }))
    this.broadcastProfile()
    this.changed()
  }

  // A new identity key that the old one vouches for: contacts move over automatically, but see
  // the key change and lose their verified mark.
  // A browser that moved has no old key to vouch with: its new identity starts without one, and
  // contacts get a request from it.
  async resetIdentity(label = 'Browser') {
    const now = this.clock.now()
    const ik = newKeyPair()
    const dk = newKeyPair()
    const cert = signCert(ik, dk.pk, now, label)
    const succession = hasSecrets(this.self) ? signSuccession(this.self.ik, ik, now) : null
    const wasMoved = this.self.moved !== null
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
      moved: null,
      moving: null,
      exported: null,
      alert: null,
      imports: [],
      // The binding names the old key: a new one is fetched for this one.
      badge: cur.badge ? { ...cur.badge, token: null } : (cur.badge ?? null),
    }))
    this.halt('closed')
    this.dials.clear()
    if (wasMoved && !this.stopped) {
      await this.start()
      return this.changed()
    }
    if (!this.isPaused() && !this.stopped) await this.listen()
    this.changed()
  }

  // A new device key for this browser, under the same identity (spec 3.9). A copy whose history
  // conflicts with another copy of it becomes a new device: the old key stays the other copy's.
  // `moved`: this browser leaves its old key (it is revoked, a move to the new one); `lost`:
  // other devices of ours revoked too.
  async rekey(opts: { moved?: boolean; lost?: string[] } = {}) {
    if (!hasSecrets(this.self) || this.self.moved) return
    const now = this.clock.now()
    const dk = newKeyPair()
    const cert = signCert(this.self.ik, dk.pk, now, this.self.cert.label)
    const ik = keyId(this.self.ik.pk)
    const old = keyId(this.self.dk.pk)
    const revs = [
      ...(opts.moved ? [signRevocation(this.self.ik, old, now, keyId(dk.pk))] : []),
      ...(opts.lost ?? []).map(v => signRevocation(this.self.ik, v, now)),
    ]
    await this.writeSelf(cur => {
      const revocations = mergeRevocations(cur.revocations, revs, ik)
      const lost = [...new Set([...(cur.lost ?? []), ...(opts.lost ?? [])])].slice(-LOST_KEPT)
      return {
        ...cur,
        dk,
        cert,
        certs: mergeCerts([cert], cur.certs, ik, revocations),
        revocations,
        suffix: 0,
        ...(lost.length ? { lost } : {}),
      }
    })
    this.halt('closed')
    this.dials.clear()
    if (!this.isPaused() && !this.stopped) await this.listen()
    this.changed()
  }

  // The device keys this identity moved away from (Task 19 moves and imports).
  movedFrom() {
    return this.self.revocations.filter(r => r.successor !== undefined).map(r => r.dk)
  }

  // Devices of ours we disowned as lost or stolen (revoked without moving to them), or that
  // recovery signed out.
  lostDevices() {
    const gone = this.self.revocations.filter(r => r.successor === undefined).map(r => r.dk)
    return [...new Set([...gone, ...(this.self.lost ?? [])])]
  }

  // Records devices of ours that are not ours any more (recovery signed them out).
  async disowned(dks: string[]) {
    await this.writeSelf(cur => ({
      ...cur,
      lost: [...new Set([...(cur.lost ?? []), ...dks])].slice(-LOST_KEPT),
    }))
  }

  // Our certified devices: key, label and when each was made.
  ownDevices() {
    return this.self.certs.map(c => ({ dk: c.dk, label: c.label, created: c.created }))
  }

  // ----- Device move -----

  // After a P2P export: sending pauses here so nothing written here is left behind by the move.
  async markExported(at = this.clock.now()) {
    if (this.self.moved) return
    await this.writeSelf(cur => ({ ...cur, moving: { at }, exported: at }))
    this.changed()
  }

  async resumeSending() {
    await this.writeSelf(cur => ({ ...cur, moving: null }))
    this.changed()
  }

  // Whether sending is paused for a move. Another tab may have exported, so this reads the
  // stored record.
  async sendingPaused() {
    const cur = await this.deps.store.self()
    if (
      cur &&
      equalBytes(cur.ik.pk, this.self.ik.pk) &&
      equalBytes(cur.dk.pk, this.self.dk.pk) &&
      (cur.moving?.at ?? null) !== (this.self.moving?.at ?? null)
    ) {
      this.self = { ...this.self, moving: cur.moving ?? null, exported: cur.exported ?? null }
      this.changed()
    }
    return !!this.self.moving
  }

  async clearAlert() {
    await this.writeSelf(cur => ({ ...cur, alert: null }))
    this.changed()
  }

  // Display name for a contact, petname first.
  nameOf(ik: string) {
    const c = this.contacts.get(ik)
    return c ? displayName(c) : ''
  }
}
