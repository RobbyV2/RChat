import { sha256 } from '@noble/hashes/sha2.js'
import { isRecord } from '../bytes'
import { b64u, bytesOf, canonical, fromB64u, randomBytes, utf8 } from './canonical'
import {
  authRefs,
  authStateOf,
  check,
  isModerator,
  isUnknownRefusal,
  mayModerate,
  targetOk,
  type Candidate,
} from './auth'
import {
  blankRoom,
  DAG,
  getEvents,
  insertEvent,
  SERVER_TOTAL,
  SERVER_TOTAL_BYTES,
  storedSize,
  stripped,
  type Inserted,
  type InsertCtx,
} from './dag'
import type {
  ChanCounts,
  CodeRecord,
  EventRecord,
  IdentRecord,
  OutboxRecord,
  P2pDatabase,
  P2pStore,
  RoomRecord,
  ServerCache,
} from './db'
import {
  buildEvent,
  claimedId,
  LIMITS as EV,
  validate,
  type Attachment,
  type Content,
  type Core,
  type EvType,
  type Fwd,
  type MsgContent,
  type PinContent,
  type Wire,
} from './event'
import type { Message } from './frames'
import { memberBindingDue } from './badge'
import { Gossip, type GossipLimits, type LinkKind } from './gossip'
import { isKeyId, peerId, verifyCert, verifyProfile, type Cert, type Profile } from './keys'
import { liveCerts } from './keys'
import { mergeCerts, mergeRevocations, displayName } from './contacts'
import type { P2pNode } from './node'
import { EMPTY_RESOLVED, parentsOf, RULES, type Resolved } from './resolve'
import { LocalHost, WorkerHost, type ResolveHost, type WorkerLike } from './resolve_host'
import { realClock, type Clock, type Session } from './session'
import { SoftFail } from './softfail'
import {
  can,
  CHAIN,
  channelOf,
  channelsOf,
  codeOf,
  EVERYONE,
  EVERYONE_PERMS,
  historyOf,
  isOwner,
  isPowerChain,
  isShortId,
  memberOf,
  membershipOf,
  membersOf,
  nameOf,
  ownerOf,
  P,
  permsOf,
  STATE_LIMITS,
  stateKey,
  systemOf,
  type ChannelContent,
  type CodeContent,
  type HistoryVis,
  type Membership,
  type StateEvent,
  type StateMap,
} from './state'
import { isQuotaError, Sync, type Check, type Link, type SyncLimits, type Walked } from './sync'
import {
  deriveMessage,
  dmRoomId,
  DmError,
  mentionsIn,
  MOVED_TEXT,
  MOVING_TEXT,
  PINS_MAX,
  STORAGE_FULL_TEXT,
  type Dms,
  type P2pMessage,
} from './dm'

// P2P servers (note section 6): groups whose state, channels and messages live only on their
// members' devices. Every event is checked against the auth rules before it is stored; state
// events are resolved into the current state (resolve.ts); messages from members who are no
// longer in are kept but not shown (softfail.ts). Rooms sync over the same sessions as DMs, with
// their own message types (prefix `s`), on at most 8 links per room (gossip.ts).

export const SERVER = {
  // Server rooms on this device, and pending invites from contacts.
  invites: 20,
  // Redeem attempts a session may make.
  redeems: 3,
  redeemMs: 15_000,
  codePeers: 4,
  descWalk: 50_000,
  // Joins walked back from per room by the history gate, and events remembered per join.
  descJoins: 8,
  descMemo: 50_000,
  // A banned member's events that are never shown are purged once the ban has stood this long
  // (or at once when the room or the device runs out of space); until then they are only hidden,
  // and come back if the ban is overturned.
  purgeAfter: 7 * 24 * 60 * 60_000,
  // A code redeemed with us: the redeemer may sync the room's state (to join) for this long,
  // at most this many at once per code and per room. Nothing enters the room unless they join.
  redeemTtl: 10 * 60_000,
  redeemsPerCode: 4,
  redeemsPerRoom: 8,
  // A session with someone who isn't a contact, left without room links, closes after this.
  idleMs: 5_000,
}

export const CODE_PREFIX = 'rci1.'

// How long a joiner waits for the rest of the state before joining with what it has.
const JOIN_WAIT = 30_000

export const CODE_TTLS = [
  { label: '1 hour', ms: 60 * 60_000 },
  { label: '1 day', ms: 24 * 60 * 60_000 },
  { label: '7 days', ms: 7 * 24 * 60 * 60_000 },
  { label: '30 days', ms: 30 * 24 * 60 * 60_000 },
]

export const NEEDS_INVITER = 'Someone who can invite must be online'
export const NOBODY_ONLINE =
  'Nobody who can invite is online right now. Try again when one of them is.'
export const BAD_CODE = "This isn't a P2P server invite code."
export const REDEEM_TEXT: Record<string, string> = {
  expired: 'This invite has expired.',
  revoked: 'This invite was revoked.',
  unknown: "This invite isn't valid any more.",
  banned: "You can't join this server.",
  busy: 'Too many people are joining with this invite right now. Try again in a few minutes.',
}

export class ServerError extends Error {}

export interface InviteCode {
  v: 1
  room: string
  name: string
  secret: string
  peers: string[]
}

const isPeerId = (x: unknown) => typeof x === 'string' && /^rcp-[a-z2-7]{26}(-[1-9])?$/.test(x)

export const encodeCode = (c: InviteCode) => CODE_PREFIX + b64u(utf8(canonical(c)))

export const parseCode = (text: string): InviteCode | null => {
  const t = text.trim()
  if (!t.startsWith(CODE_PREFIX)) return null
  try {
    const x = JSON.parse(new TextDecoder().decode(fromB64u(t.slice(CODE_PREFIX.length))))
    if (
      !isRecord(x) ||
      x.v !== 1 ||
      bytesOf(x.room, 32) === null ||
      typeof x.name !== 'string' ||
      Array.from(x.name).length > 100 ||
      bytesOf(x.secret, 16) === null ||
      !Array.isArray(x.peers) ||
      x.peers.length > SERVER.codePeers ||
      !x.peers.every(isPeerId)
    )
      return null
    return {
      v: 1,
      room: x.room as string,
      name: x.name,
      secret: x.secret as string,
      peers: x.peers as string[],
    }
  } catch {
    return null
  }
}

export const codeHash = (secret: string) => b64u(sha256(fromB64u(secret)))

export const newShortId = () => b64u(randomBytes(8))

// Where our chain in a room is kept once the room is removed from this device.
const chainMetaKey = (room: string) => `chain\n${room}`

// A stored event as resolution sees it, or null for anything that isn't a whole state event.
export const toState = (r: EventRecord): StateEvent | null => {
  const ev = r.wire.ev
  if (ev.skey === undefined || !r.wire.c) return null
  return {
    id: r.id,
    type: ev.type,
    skey: ev.skey,
    sender: ev.sender,
    ts: ev.ts,
    depth: ev.depth,
    content: r.wire.c as Record<string, unknown>,
    pstate: ev.pstate ?? [],
    auth: ev.auth ?? [],
    dseq: ev.dseq ?? 0,
    ...(ev.sprev !== undefined ? { sprev: ev.sprev } : {}),
    ...(ev.pprev !== undefined ? { pprev: ev.pprev } : {}),
  }
}

const KNOWN_STATE = new Set([
  'create',
  'owner',
  'member',
  'role',
  'roles',
  'name',
  'channel',
  'code',
  'history',
  'system',
])
const KNOWN_PLAIN = new Set(['msg', 'edit', 'redact', 'react', 'pin', 'move', 'call'])

// The server fields an event of its type must have, chain fields included.
export const serverShape = (ev: Core): string | null => {
  if (typeof ev.dseq !== 'number' || typeof ev.dwin !== 'number') return 'chain'
  if (ev.dseq > 0 !== (ev.dprev !== undefined) || (ev.dseq === 0 && ev.dwin !== 0)) return 'chain'
  if (ev.type === 'create')
    return ev.depth === 0 &&
      ev.prev.length === 0 &&
      ev.auth === undefined &&
      ev.pstate === undefined &&
      ev.skey === '' &&
      ev.dseq === 0 &&
      ev.sprev === undefined &&
      ev.pprev === undefined
      ? null
      : 'create'
  if (!ev.auth) return 'auth'
  if (KNOWN_PLAIN.has(ev.type))
    return ev.skey === undefined && !ev.pstate && ev.sprev === undefined && ev.pprev === undefined
      ? null
      : 'plain'
  if (KNOWN_STATE.has(ev.type) || ev.skey !== undefined)
    return ev.skey !== undefined && ev.pstate ? null : 'state'
  return ev.sprev === undefined && ev.pprev === undefined ? null : 'plain'
}

// The window counters of an event along its sender's chain (note section 6), from the
// previous event (`dprev`, when stored) and the previous state event (`sp`): whether the claim
// in `dwin` holds, the hourly count of state events (`cw`), whether the sender left since they
// last joined (`cl`), and whether it is past the windows. Leaving once after joining is never
// past them.
export const windowsOf = (
  ev: Core,
  c: unknown,
  dprev: Core | null,
  sp: Pick<EventRecord, 'cw' | 'cl' | 'wire'> | null,
  moderator: boolean
) => {
  const self =
    ev.type === 'member' && ev.skey === ev.sender ? (c as { m?: unknown } | null)?.m : null
  const day = (t: number) => Math.floor(t / CHAIN.day)
  const hour = (t: number) => Math.floor(t / CHAIN.hour)
  const claim =
    !dprev ||
    (dprev.sender === ev.sender &&
      ev.dseq === (dprev.dseq ?? -1) + 1 &&
      ev.ts >= dprev.ts &&
      ev.dwin === (day(ev.ts) === day(dprev.ts) ? (dprev.dwin ?? 0) + 1 : 0))
  const state = ev.skey !== undefined
  const cw = state && sp && hour(sp.wire.ev.ts) === hour(ev.ts) ? (sp.cw ?? 0) + 1 : 0
  const cl = self === 'leave' ? true : self === 'join' ? false : (sp?.cl ?? false)
  const exempt = self === 'leave' && !sp?.cl
  const over =
    !exempt &&
    ((ev.dwin ?? 0) >= CHAIN.perDay ||
      (state && cw >= (moderator ? CHAIN.modStatePerHour : CHAIN.statePerHour)))
  return { claim, cw, cl, over }
}

export interface ServerArrival {
  room: string
  ch: string
  rec: EventRecord
  ping: 'mention' | 'reply' | 'reaction' | 'everyone' | null
  unread: boolean
}

export interface MemberView {
  ik: string
  m: Membership
  name: string
  owner: boolean
  online: boolean
  contact: boolean
}

export interface ServerView {
  id: string
  name: string
  color: number | null
  me: Membership | null
  joining: boolean
  owner: string | null
  perms: number
  history: HistoryVis
  system: { ch: string | null; join: boolean; leave: boolean }
  channels: ({ id: string } & ChannelContent)[]
  members: MemberView[]
  online: number
  joined: number
  chans: Record<string, ChanCounts>
  gap: boolean
  full: boolean
}

interface Rt {
  res: Resolved
  soft: SoftFail
  // Per join point: whether an event comes after it (it has the join among its ancestors).
  desc: Map<string, Map<string, boolean>>
  joinPosted: boolean
  lock: Promise<unknown>
  // Joined members other than us, for the state they were worked out from.
  others: { res: Resolved; list: string[] } | null
  // Events cited by a moderator's event we wait for: stored past a full room.
  needed: Set<string>
  // The state events resolution has (by id).
  events: Map<string, StateEvent>
  // Resolution of the room is loading.
  loading: Promise<void> | null
}

// Someone who redeemed a code with us: they may sync the state until `until` to join.
interface Redeemer {
  code: string
  until: number
}

export interface ServerDeps {
  node: P2pNode
  store: P2pStore
  dms: Dms
  clock?: Clock
  random?: () => number
  limits?: Partial<SyncLimits>
  gossip?: Partial<GossipLimits>
  roomCap?: number
  totalCap?: number
  roomBytes?: number
  totalBytes?: number
  serverCap?: number
  serverBytes?: number
  // Images in servers up to this size are fetched as soon as they arrive (0: never).
  autoMax?: () => number
  attachments?: () => boolean
  // Where state resolution runs (a worker in the browser).
  resolver?: ResolveHost
}

const MENTION_EVERYONE = /(^|[^\p{L}\p{N}\p{M}_])@everyone(?![\p{L}\p{N}\p{M}_])/iu

export class Servers {
  readonly sync: Sync
  readonly gossip: Gossip
  private clock: Clock
  private rts = new Map<string, Rt>()
  private idents = new Map<string, IdentRecord>()
  private rooms = new Map<string, RoomRecord>()
  private changeFns = new Set<(room: string) => void>()
  private arriveFns = new Set<(a: ServerArrival) => void>()
  private redeems = new WeakMap<Session, number>()
  private waiters = new Map<string, (m: Message) => void>()
  private typingFns = new Set<(room: string) => void>()
  private host: ResolveHost
  storageFull = false

  constructor(private deps: ServerDeps) {
    this.clock = deps.clock ?? realClock
    this.host =
      deps.resolver ??
      (typeof window !== 'undefined' && typeof Worker !== 'undefined'
        ? new WorkerHost(
            () =>
              new Worker(new URL('./p2p.worker.ts', import.meta.url), {
                type: 'module',
              }) as unknown as WorkerLike
          )
        : new LocalHost())
    const { node } = deps
    this.sync = new Sync({
      prefix: 's',
      strict: false,
      store: deps.store,
      clock: this.clock,
      me: () => node.ik,
      devices: ik => node.anyDevicesOf(ik),
      contact: ik => node.contact(ik),
      allowed: link => this.may(link.room, link.ik) !== false,
      check: (link, raw) => this.check(link.room, raw),
      insert: (link, id, wire, now) => this.insert(link.room, id, wire, now),
      serving: {
        walk: (link, from, have, limit, bytes, state) =>
          this.walk(link, from, have, limit, bytes, state),
        get: (link, ids) => this.getFor(link, ids),
        push: (link, wire) => this.pushable(link, wire),
      },
      stateHeads: async room => this.rt(room)?.res.heads ?? [],
      onStored: (room, _from, added) => void this.stored(room, added).catch(() => {}),
      onDelivered: room => this.changed(room),
      onTyping: () => {},
      onState: room => this.changed(room),
      limits: deps.limits,
      roomCap: deps.roomCap,
      totalCap: deps.totalCap,
      roomBytes: deps.roomBytes,
      totalBytes: deps.totalBytes,
    })
    this.gossip = new Gossip({
      clock: this.clock,
      random: deps.random ?? Math.random,
      me: () => node.ik,
      rooms: () => this.activeRooms(),
      members: room => this.joinedOthers(room),
      may: (room, ik) => this.may(room, ik),
      shared: ik => this.sharedWith(ik),
      moderator: (room, ik) => {
        const s = this.stateOf(room)
        return can(s, ik, P.Kick | P.Ban | P.ManageMessages)
      },
      sessions: ik => node.readySessions(ik),
      certs: ik => {
        const d = node.anyDevicesOf(ik)
        return d ? { ik, certs: liveCerts(d.certs, d.revocations) } : null
      },
      link: (s, room) => this.sync.link(s, room),
      unlink: (s, room) => this.sync.unlink(s, room),
      links: room => this.sync.linksOf(room),
      linksOn: s => this.sync.linksOn(s),
      refused: (s, room) => this.tellRemoved(s, room),
      dialing: ik => node.isDialing(ik),
      dialable: ik => node.canDial(ik),
      idle: s => this.idle(s),
      onTick: () => this.tick(),
      channel: (room, ch) => this.isChannel(room, ch),
      settled: (room, ik) =>
        this.myMembership(room) === 'join' && membershipOf(this.stateOf(room), ik) === 'join',
      onPresence: room => this.changed(room),
      onTyping: room => this.typingChanged(room),
      limits: deps.gossip,
    })
    node.use({
      attach: s => {
        this.sync.attach(s)
        this.gossip.attach(s)
        s.on('gredeem', m => this.onRedeem(m, s))
        s.on('gredeemed', m => this.onRedeemed(m, s))
        s.on('ginvite', m => this.onInvite(m, s))
        s.on('gmember', m => this.onMember(m, s))
      },
      ready: s => {
        this.gossip.ready(s)
        this.offerInvites(s)
        this.farewell(s)
      },
      targets: () => this.gossip.targets(),
      wanted: (ik, hello) => this.wanted(ik, hello),
      member: ik => this.coMember(ik),
      learn: (ik, certs, revs, profile) => void this.learn(ik, certs, revs, profile),
      devices: ik => {
        const r = this.idents.get(ik)
        return r ? { certs: r.certs, revocations: r.revocations } : null
      },
    })
    deps.dms.moreEntitled = (ik, h) => this.entitled(ik, h)
    deps.dms.moreHolders = h => this.holdersOf(h)
  }

  get me() {
    return this.deps.node.ik
  }

  get db(): P2pDatabase {
    return this.deps.store.db
  }

  // ----- Lifecycle -----

  async start() {
    for (const r of await this.db.getAll('idents')) this.idents.set(r.ik, r)
    for (const r of await this.deps.store.rooms()) {
      if (r.kind !== 'server') continue
      this.rooms.set(r.id, r)
      await this.load(r)
    }
    this.gossip.start()
    for (const id of this.rooms.keys()) void this.refreshMe(id).catch(() => {})
  }

  stop() {
    this.gossip.stop()
    this.sync.stop()
    if (this.host instanceof WorkerHost) this.host.stop()
  }

  // Every gossip tick: joins that waited for the rest of the state, and bans that stood long
  // enough for what the banned member wrote (and nobody sees) to be purged.
  private tick() {
    const now = this.clock.now()
    for (const r of this.rooms.values()) {
      if (r.joining) this.maybeJoin(r.id)
      const due = Object.entries(r.bans ?? {})
        .filter(([, b]) => !b.purged && now - b.since >= SERVER.purgeAfter)
        .map(([ik]) => ik)
      if (due.length) void this.locked(r.id, () => this.purge(r.id, due)).catch(() => {})
    }
  }

  onChange(fn: (room: string) => void) {
    this.changeFns.add(fn)
    return () => void this.changeFns.delete(fn)
  }

  onArrive(fn: (a: ServerArrival) => void) {
    this.arriveFns.add(fn)
    return () => void this.arriveFns.delete(fn)
  }

  onTyping(fn: (room: string) => void) {
    this.typingFns.add(fn)
    return () => void this.typingFns.delete(fn)
  }

  private changed(room: string) {
    for (const fn of this.changeFns) fn(room)
  }

  private typingChanged(room: string) {
    for (const fn of this.typingFns) fn(room)
  }

  private rt(room: string): Rt | null {
    return this.rts.get(room) ?? null
  }

  private ensureRt(room: string): Rt {
    let rt = this.rts.get(room)
    if (!rt) {
      rt = {
        res: EMPTY_RESOLVED,
        soft: new SoftFail(this.db),
        desc: new Map(),
        joinPosted: false,
        lock: Promise.resolve(),
        others: null,
        needed: new Set(),
        events: new Map(),
        loading: null,
      }
      rt.soft.overturned = id => {
        const res = this.resolved(room)
        return res.rejected.has(id) || res.lost.has(id)
      }
      rt.soft.flagged = (ik, dseq) => {
        const f = this.rooms.get(room)?.flagged?.[ik]
        return f !== undefined && dseq >= f
      }
      this.rts.set(room, rt)
    }
    return rt
  }

  // Runs `fn` after everything else that changes this room's state.
  private locked<T>(room: string, fn: () => Promise<T>): Promise<T> {
    const rt = this.ensureRt(room)
    const run = rt.lock.then(fn, fn)
    rt.lock = run.catch(() => {})
    return run
  }

  stateOf(room: string): StateMap {
    return this.rt(room)?.res.state ?? EMPTY_RESOLVED.state
  }

  resolved(room: string): Resolved {
    return this.rt(room)?.res ?? EMPTY_RESOLVED
  }

  // ----- Rooms and members -----

  isServer(room: string) {
    return this.rooms.has(room)
  }

  serverRooms() {
    return [...this.rooms.values()]
  }

  // Writes a server room record; never over a DM's (a forged room id can't take a DM over).
  private async putRoom(rec: RoomRecord) {
    const tx = this.db.transaction('rooms', 'readwrite')
    const cur = await tx.store.get(rec.id)
    if (cur && cur.kind !== 'server') {
      await tx.done
      throw new ServerError(BAD_CODE)
    }
    await tx.store.put(rec)
    await tx.done
    this.rooms.set(rec.id, rec)
  }

  // Whether a room id is (or would be) a DM's: a stored record that isn't a server, or the DM
  // room of us and any contact. Invites and codes naming one are refused.
  private async isDmId(id: string) {
    const cur = await this.deps.store.room(id)
    if (cur && cur.kind !== 'server') return true
    return (await this.deps.store.contacts()).some(c => dmRoomId(this.me, c.ik) === id)
  }

  // Deletes a server room record that holds nothing (never a DM's).
  private async dropEmpty(room: string) {
    const tx = this.db.transaction('rooms', 'readwrite')
    const r = await tx.store.get(room)
    const gone = !!r && r.kind === 'server' && r.count === 0
    if (gone) await tx.store.delete(room)
    await tx.done
    if (r?.kind === 'server') {
      this.rooms.delete(room)
      this.rts.delete(room)
      this.host.drop(room)
    }
    return gone
  }

  private async updateRoom(id: string, fn: (cur: RoomRecord) => RoomRecord | null) {
    const next = await this.deps.store.updateRoom(id, cur => (cur ? fn(cur) : null))
    if (next) this.rooms.set(id, next)
    return next
  }

  myMembership(room: string) {
    return membershipOf(this.stateOf(room), this.me)
  }

  // Rooms we sync: joined, invited, or on our way in.
  private activeRooms() {
    const out: string[] = []
    for (const r of this.rooms.values()) {
      const m = this.myMembership(r.id)
      if (m === 'join' || m === 'invite' || r.joining) out.push(r.id)
    }
    return out
  }

  // Worked out once per resolved state (gossip asks on every frame).
  private joinedOthers(room: string) {
    const rt = this.rt(room)
    if (!rt) return []
    if (rt.others?.res === rt.res) return rt.others.list
    const list = membersOf(rt.res.state)
      .filter(m => m.m === 'join' && m.ik !== this.me)
      .map(m => m.ik)
    rt.others = { res: rt.res, list }
    return list
  }

  private sharedWith(ik: string) {
    let n = 0
    for (const id of this.rooms.keys()) if (membershipOf(this.stateOf(id), ik) === 'join') n += 1
    return n
  }

  // A member (or invitee) of a server we are in; nothing for one we have left or lost.
  private coMember(ik: string) {
    for (const room of this.rooms.keys()) {
      const s = this.stateOf(room)
      const mine = membershipOf(s, this.me)
      if (mine !== 'join' && mine !== 'invite') {
        if (this.may(room, ik) === 'full') return true
        continue
      }
      const m = membershipOf(s, ik)
      if (m === 'join' || m === 'invite') return true
    }
    return false
  }

  // Whether we link `room` with `ik`, and what we may serve them there.
  may(room: string, ik: string): LinkKind {
    const r = this.rooms.get(room)
    if (!r) return false
    const s = this.stateOf(room)
    const mine = membershipOf(s, this.me)
    // On our way in we have no state yet: whoever let us in is who we sync with.
    if (r.joining && mine !== 'join' && this.isPreferred(room, ik)) return 'full'
    if (mine !== 'join' && mine !== 'invite' && !r.joining) return false
    const m = membershipOf(s, ik)
    if (m === 'join') return 'full'
    if (m === 'invite') return 'state'
    return mine === 'join' && this.redeeming(room, ik) ? 'state' : false
  }

  // Members we link with first: who let us in, or whom we let in. It expires (gossip.ts).
  private isPreferred(room: string, ik: string) {
    return this.gossip.isPreferred(room, ik)
  }

  private prefer(room: string, ik: string) {
    this.gossip.prefer(room, ik)
  }

  // People who redeemed a code with us and may sync the state to join, per room. Redeeming
  // adds nothing to the room: the invite we sign goes to them, and enters the room with their
  // join.
  private redeemers = new Map<string, Map<string, Redeemer>>()

  private redeemersOf(room: string) {
    const now = this.clock.now()
    const map = this.redeemers.get(room)
    if (!map) return new Map<string, Redeemer>()
    const s = this.stateOf(room)
    // Done once they joined (or were banned), or after a while.
    for (const [ik, r] of map) {
      const m = membershipOf(s, ik)
      if (r.until <= now || m === 'join' || m === 'ban') map.delete(ik)
    }
    return map
  }

  private redeeming(room: string, ik: string) {
    return this.redeemersOf(room).has(ik)
  }

  // A session with someone who isn't a contact, left without room links: closed shortly after,
  // unless it found a use again.
  private idle(s: Session) {
    const ik = s.remote?.ik
    if (!ik || this.deps.node.contact(ik)) return
    this.clock.set(() => {
      if (s.state !== 'ready' || this.sync.linksOn(s).length || this.deps.node.contact(ik)) return
      if ([...this.rooms.keys()].some(room => this.redeeming(room, ik))) return
      // A file still coming or going over it keeps it.
      if (this.clock.now() - s.lastUseful < SERVER.idleMs) return this.idle(s)
      s.close('closed')
    }, SERVER.idleMs)
  }

  // A hello from someone who isn't a mutual contact: kept when they are a member (or invited)
  // of one of our rooms, or come to redeem an invite code of a room we are in.
  private wanted(ik: string, hello: Message) {
    for (const room of this.rooms.keys())
      if (this.may(room, ik) || this.removed(room, ik)) return true
    const rci = hello.rci
    return (
      typeof rci === 'string' &&
      this.myMembership(rci) === 'join' &&
      can(this.stateOf(rci), this.me, P.Invite)
    )
  }

  private async learn(
    ik: string,
    certs: Cert[],
    revs: Cert[] | unknown[],
    profile: Profile | null
  ) {
    const cur = this.idents.get(ik)
    const revocations = mergeRevocations(cur?.revocations ?? [], revs as never[], ik)
    const merged = mergeCerts(cur?.certs ?? [], certs, ik, revocations)
    const newer =
      profile && verifyProfile(profile, ik) && profile.updated > (cur?.profile?.updated ?? -1)
    if (
      cur &&
      !newer &&
      merged.length === cur.certs.length &&
      revocations.length === cur.revocations.length
    )
      return
    const next: IdentRecord = {
      ik,
      certs: merged,
      revocations,
      profile: newer ? profile : (cur?.profile ?? null),
      updated: this.clock.now(),
    }
    this.idents.set(ik, next)
    await this.db.put('idents', next).catch(() => {})
  }

  // What we know a member calls themselves (our petname for contacts first).
  nameOf(ik: string, room?: string) {
    if (ik === this.me) return this.deps.node.name
    const c = this.deps.node.contact(ik)
    if (c && (c.petname || c.name)) return displayName(c)
    const p = this.idents.get(ik)?.profile
    if (p) return p.name
    if (room) {
      const m = memberOf(this.stateOf(room), ik)
      if (m?.profile) return m.profile.name
    }
    return 'Member'
  }

  // ----- Loading and resolution -----

  private async stateEvents(room: string) {
    const recs = await this.db.getAllFromIndex('events', 'room_state', [room, 1])
    return recs.map(toState).filter((x): x is StateEvent => x !== null)
  }

  // Resolution of a room on start: what the cache says at once (when it is current), while the
  // resolver (a worker in the browser) takes in every state event.
  private async load(r: RoomRecord) {
    const rt = this.ensureRt(r.id)
    const events = await this.stateEvents(r.id)
    for (const e of events) rt.events.set(e.id, e)
    const cache = r.server
    const loading = this.host.load(r.id, events)
    // A cache made under other rules (an upgrade) is replayed: what is accepted may differ now.
    if (cache && cache.count === events.length && cache.rules === RULES) {
      const state = new Map<string, StateEvent>()
      let ok = true
      for (const [key, id] of cache.entries) {
        const e = rt.events.get(id)
        if (!e) ok = false
        else state.set(key, e)
      }
      if (ok) {
        rt.res = {
          state,
          heads: cache.heads,
          rejected: new Set(cache.rejected),
          lost: new Set(cache.lost ?? []),
          transitions: new Map(cache.transitions),
          joins: new Map(cache.joins ?? []),
          count: events.length,
          gaps: cache.gaps ?? 0,
          flagged: new Map(cache.flagged ?? []),
          power: new Map(cache.power ?? []),
        }
        rt.loading = loading.then(
          () => {},
          () => {}
        )
        return
      }
    }
    rt.res = await loading
    await this.saveCache(r.id)
  }

  private async saveCache(room: string) {
    const res = this.resolved(room)
    const cache: ServerCache = {
      rules: RULES,
      count: res.count,
      entries: [...res.state].map(([k, e]) => [k, e.id]),
      heads: res.heads,
      rejected: [...res.rejected],
      lost: [...res.lost],
      transitions: [...res.transitions],
      joins: [...res.joins],
      gaps: res.gaps,
      flagged: [...res.flagged],
      power: [...res.power],
    }
    const n = this.nameNow(room)
    await this.updateRoom(room, cur => ({ ...cur, server: cache, ...(n ? { name: n } : {}) }))
  }

  private nameNow(room: string) {
    return nameOf(this.stateOf(room))?.name ?? null
  }

  // A new state event goes to the resolver (a worker in the browser, so the page never waits on
  // it): incremental when it only extends what is known, a replay when it changes the past.
  private async applyState(room: string, rec: EventRecord) {
    const se = toState(rec)
    if (!se) return
    const rt = this.ensureRt(room)
    const before = rt.res
    rt.events.set(se.id, se)
    rt.res = await this.host.add(room, [se])
    await this.saveCache(room)
    await this.afterState(room, before)
  }

  // What a state change means here: we were let in, or put out.
  private async afterState(room: string, before: Resolved) {
    const was = membershipOf(before.state, this.me)
    const now = this.myMembership(room)
    const r = this.rooms.get(room)
    this.maybeJoin(room)
    await this.noteBans(room)
    // In once our join from this time in is (not an old one of ours the state brought back).
    const mine = this.stateOf(room).get(stateKey('member', this.me))
    if (now === 'join' && r?.joining && (mine?.ts ?? 0) >= r.joining.at)
      await this.updateRoom(room, cur => ({
        ...cur,
        joining: null,
        since: cur.since ?? this.clock.now(),
      }))
    // We are in now: everything the gates held back may come.
    if (now === 'join' && was !== 'join') this.sync.loadOlder(room)
    // Someone's membership changed: our heads again, so a member let in asks for history.
    this.sync.announce(room)
    if (was === 'join' && now !== 'join') {
      this.gossip.leave(room)
      this.ensureRt(room).joinPosted = false
    }
    this.gossip.tick()
    this.changed(room)
  }

  // Invited while on our way in: we join once we hold the whole state (our join cites what the
  // rules read in it), or after JOIN_WAIT with what we have.
  private maybeJoin(room: string) {
    const r = this.rooms.get(room)
    if (this.myMembership(room) !== 'invite' || !r?.joining) return
    if (this.resolved(room).gaps && this.clock.now() - r.joining.at < JOIN_WAIT) return
    void this.postJoin(room).catch(() => {})
  }

  // Bans in the resolved state, and since when (by our clock) each has stood. What a banned
  // member wrote is hidden at once (soft-fail); it is purged only once the ban has stood
  // SERVER.purgeAfter (tick), or at once when the room runs out of space here. A ban that is
  // overturned before that takes nothing with it.
  private async noteBans(room: string) {
    const s = this.stateOf(room)
    const now = this.clock.now()
    const banned = new Map(
      membersOf(s)
        .filter(m => m.m === 'ban')
        .map(m => [m.ik, m.id])
    )
    const cur = this.rooms.get(room)?.bans ?? {}
    const same =
      Object.keys(cur).length === banned.size &&
      [...banned].every(([ik, id]) => cur[ik]?.ban === id)
    if (same) return
    await this.updateRoom(room, rec => {
      const old = rec.bans ?? {}
      const bans: NonNullable<RoomRecord['bans']> = {}
      for (const [ik, id] of banned)
        bans[ik] = old[ik]?.ban === id ? old[ik] : { ban: id, since: now }
      return { ...rec, bans }
    })
  }

  // Purges what banned members `iks` wrote that is stored here and never shown: each such event
  // keeps only what the DAG needs (its header, never served), its files go, and the room's
  // space and event count come back.
  private async purge(room: string, iks: string[], only?: EventRecord[]) {
    const s = this.stateOf(room)
    const soft = this.ensureRt(room).soft
    const targets = iks.filter(ik => membershipOf(s, ik) === 'ban')
    const hidden = new Set<string>()
    const check = async (r: EventRecord) => {
      if (!r.state && !r.purged && !(await soft.visible(r, s))) hidden.add(r.id)
    }
    if (only) for (const r of only) if (targets.includes(r.sender)) await check(r)
    if (!only)
      for (const ik of targets)
        for (const r of await this.db.getAllFromIndex(
          'events',
          'room_dseq',
          IDBKeyRange.bound([room, ik, -Infinity], [room, ik, Infinity])
        ))
          await check(r)
    if (!hidden.size && only) return 0
    const tx = this.db.transaction(['events', 'rooms', 'meta'], 'readwrite')
    const events = tx.objectStore('events')
    const meta = tx.objectStore('meta')
    let saved = 0
    let n = 0
    const freed: string[] = []
    for (const id of hidden) {
      const r = await events.get(id)
      if (!r || r.purged) continue
      const next: EventRecord = { ...stripped(r), soft: r.soft ?? true, purged: true }
      saved += storedSize(r.wire) - storedSize(next.wire)
      n += 1
      freed.push(...(r.atts ?? []))
      await events.put(next)
    }
    const rec = await tx.objectStore('rooms').get(room)
    if (rec) {
      const bans = { ...(rec.bans ?? {}) }
      for (const ik of targets) if (bans[ik]) bans[ik] = { ...bans[ik], purged: true }
      await tx.objectStore('rooms').put({
        ...rec,
        bans,
        bytes: Math.max(0, (rec.bytes ?? 0) - saved),
        count: Math.max(0, rec.count - n),
        full: n || saved ? false : rec.full,
      })
    }
    if (n) {
      const total = ((await meta.get(SERVER_TOTAL)) as number | undefined) ?? 0
      const totalBytes = ((await meta.get(SERVER_TOTAL_BYTES)) as number | undefined) ?? 0
      await meta.put(Math.max(0, total - n), SERVER_TOTAL)
      await meta.put(Math.max(0, totalBytes - saved), SERVER_TOTAL_BYTES)
    }
    await tx.done
    const after = await this.deps.store.room(room)
    if (after) this.rooms.set(room, after)
    if (freed.length) void this.deps.dms.blobs.release([...new Set(freed)]).catch(() => {})
    if (n) this.changed(room)
    return n
  }

  // Out of space: banned members' hidden events go now, whatever their bans' age.
  private async purgeForSpace(room: string) {
    const due = Object.keys(this.rooms.get(room)?.bans ?? {})
    return due.length ? this.purge(room, due) : 0
  }

  private async postJoin(room: string) {
    const rt = this.ensureRt(room)
    if (rt.joinPosted) return
    rt.joinPosted = true
    try {
      await this.memberEvent(room, this.me, 'join')
      this.deps.node.schedule()
    } catch (e) {
      rt.joinPosted = false
      throw e
    }
  }

  // After a device move our member event names the old device: post it again with this one.
  private async refreshMe(room: string) {
    const m = memberOf(this.stateOf(room), this.me)
    if (m?.m !== 'join' || !this.deps.node.author()) return
    const cert = this.deps.node.cert
    if (m.cert?.dk === cert.dk && m.profile?.updated === this.deps.node.profile.updated) return
    await this.memberEvent(room, this.me, 'join')
  }

  // Our account badge was turned on or renewed. Members we never connect to see it only in our
  // member event; once that one is due (badge.ts), the profile is signed again (the room rules
  // take a new member event of ours only for a newer profile or device) and every server gets one.
  async refreshBadge() {
    const binding = this.deps.node.binding
    const now = this.clock.now()
    const due = [...this.rooms.keys()].some(id => {
      const m = memberOf(this.stateOf(id), this.me)
      return m?.m === 'join' && memberBindingDue(m.binding, binding, now)
    })
    if (!due || !this.deps.node.author()) return
    await this.deps.node.touchProfile()
    for (const id of this.rooms.keys()) await this.refreshMe(id).catch(() => {})
  }

  // ----- Checking incoming events -----

  async check(room: string, raw: unknown): Promise<Check> {
    const id = claimedId(raw)
    if (!isRecord(raw) || !isRecord(raw.ev)) return { ok: false, later: false, id }
    const ev = raw.ev as Partial<Core>
    const c = raw.c
    // Create and self-join events carry the device certificate they are signed with.
    let own: Cert | null = null
    if (
      isRecord(c) &&
      typeof ev.sender === 'string' &&
      (ev.type === 'create' || (ev.type === 'member' && ev.skey === ev.sender)) &&
      verifyCert(c.cert, ev.sender)
    )
      own = c.cert as Cert
    const v = validate(raw, {
      room,
      members: null,
      devices: ik => {
        const d = this.deps.node.anyDevicesOf(ik)
        if (!own || ik !== ev.sender) return d
        return { certs: [own, ...(d?.certs ?? [])], revocations: d?.revocations ?? [] }
      },
    })
    // A device we don't know yet (a member's new device): not their fault. A device we know was
    // revoked: refused, but without a strike, as others may not know of the revocation yet
    // and relay it in good faith.
    if (!v.ok) return { ok: false, later: v.why === 'device' || v.why === 'revoked', id }
    const core = v.wire.ev
    if (serverShape(core) !== null) return { ok: false, later: false, id }
    const cand = this.candidate(v.id, v.wire)
    if (core.type === 'create')
      return check(cand, new Map()) === null ? v : { ok: false, later: false, id }
    const auth = core.auth ?? []
    const recs = await getEvents(this.db, room, auth)
    if (recs.length < auth.length) {
      const have = new Set(recs.map(r => r.id))
      const lack = auth.filter(a => !have.has(a))
      // What a moderator's event cites is stored past every cap: moderation always fits.
      const rt = this.ensureRt(room)
      if (isModerator(this.stateOf(room), core.sender))
        for (const a of lack) if (rt.needed.size < DAG.missing) rt.needed.add(a)
      await this.addMissing(room, lack)
      return { ok: false, later: true, id }
    }
    const states = recs.map(toState)
    if (states.some(x => x === null)) return { ok: false, later: false, id }
    // Whether what it cites is accepted where it sits is resolution's business (deterministic),
    // not ours here: our view may lag, and refusing would split the event sets.
    const as = authStateOf(cand, states as StateEvent[])
    if (!as.ok) return { ok: false, later: false, id }
    const why = check(cand, as.state, { at: core.ts })
    // A value from a newer version: stored and synced, inert here, and no strike.
    if (why !== null && !isUnknownRefusal(why)) return { ok: false, later: false, id }
    // Dated in the future: not yet (it is fetched again once its time comes).
    if (core.ts > this.clock.now() + EV.futureMs) return { ok: false, later: true, id }
    const chain = await this.chainOk(room, core, v.wire.c, as.state)
    if (chain === 'bad') return { ok: false, later: false, id }
    if (chain === 'later') return { ok: false, later: true, id }
    return v
  }

  // The sender's chain (note section 6), as far as it is stored here: the previous event's
  // number, time and window claim when we have it, and the previous state event (which every
  // member can get) for state events. Past a window: refused without a strike, everywhere
  // alike. A link we lack is asked for.
  private async chainOk(
    room: string,
    ev: Core,
    c: unknown,
    cited: StateMap
  ): Promise<'ok' | 'later' | 'bad'> {
    const w = await this.windows(room, ev, c, cited)
    if (w === 'later' || w === 'bad') return w
    // A claim that doesn't follow the previous event: refused, but without a strike, as whoever
    // relays it may have taken it without that event (a pre-join one under history `joined`).
    if (!w.claim) return 'later'
    return w.over ? 'later' : 'ok'
  }

  private async windows(room: string, ev: Core, c: unknown, cited: StateMap) {
    if (ev.type === 'create')
      return { claim: true, cw: 0, cl: false, over: false } as ReturnType<typeof windowsOf>
    const ids = [ev.dprev, ev.sprev].filter((x): x is string => x !== undefined)
    const recs = await getEvents(this.db, room, ids)
    const dprev = recs.find(r => r.id === ev.dprev) ?? null
    let sp: EventRecord | null = null
    if (ev.sprev !== undefined) {
      sp = recs.find(r => r.id === ev.sprev) ?? null
      if (!sp) {
        await this.addMissing(room, [ev.sprev])
        return 'later' as const
      }
      if (
        sp.sender !== ev.sender ||
        !sp.state ||
        (sp.wire.ev.dseq ?? 0) >= (ev.dseq ?? 0) ||
        sp.wire.ev.ts > ev.ts
      )
        return 'bad' as const
    }
    if (dprev && dprev.room !== room) return 'bad' as const
    return windowsOf(ev, c, dprev?.wire.ev ?? null, sp, isModerator(cited, ev.sender))
  }

  private candidate(id: string, wire: Wire): Candidate {
    const ev = wire.ev
    return {
      id,
      type: ev.type,
      sender: ev.sender,
      skey: ev.skey,
      content: (wire.c as Record<string, unknown> | null) ?? null,
      auth: ev.auth ?? [],
    }
  }

  private async addMissing(room: string, ids: string[]) {
    if (!ids.length) return
    await this.updateRoom(room, cur => {
      const missing = [...new Set([...cur.missing, ...ids])].slice(-DAG.missing)
      return missing.length === cur.missing.length ? null : { ...cur, missing }
    })
  }

  // The state an event's auth events form (they are stored by the time it is).
  private async authState(room: string, ev: Core) {
    const recs = await getEvents(this.db, room, ev.auth ?? [])
    const s = new Map<string, StateEvent>()
    for (const r of recs) {
      const e = toState(r)
      if (e) s.set(stateKey(e.type, e.skey), e)
    }
    return s
  }

  insert(room: string, id: string, wire: Wire, receivedAt: number): Promise<Inserted> {
    return this.locked(room, () => this.insertNow(room, id, wire, receivedAt, false))
  }

  private async insertNow(
    room: string,
    id: string,
    wire: Wire,
    receivedAt: number,
    own: boolean
  ): Promise<Inserted> {
    const ev = wire.ev
    const as = await this.authState(room, ev)
    const cur = this.stateOf(room)
    const rt = this.ensureRt(room)
    const mark: NonNullable<InsertCtx['mark']> = {}
    if (ev.skey !== undefined) {
      mark.state = 1
      mark.skey = ev.skey
    }
    const c = wire.c as MsgContent | null
    if (ev.type === 'msg' && c && typeof c.ch === 'string') mark.chan = c.ch
    if (ev.type === 'redact' && (isOwner(as, ev.sender) || can(as, ev.sender, P.ManageMessages)))
      mark.mod = true
    // The sender's chain: its number, and the window counters along their state events. Past a
    // window, or a third event with one number (an equivocation already on record): not stored.
    const w = await this.windows(room, ev, wire.c, as)
    if (w === 'later' || w === 'bad') return { status: 'quota' }
    if (w.over && !own) return { status: 'quota' }
    if (ev.dseq !== undefined) {
      mark.dseq = ev.dseq
      if (ev.skey !== undefined) {
        mark.cw = w.cw
        if (w.cl) mark.cl = true
      }
      const same = (
        await this.db.getAllFromIndex('events', 'room_dseq', [room, ev.sender, ev.dseq])
      ).filter(r => r.id !== id)
      if (same.length >= 2) return { status: 'quota' }
      if (same.length) await this.flag(room, ev.sender, ev.dseq)
    }
    // From someone put out (kicked, banned, left) and not an ancestor of that: soft-failed for
    // good, so it stays hidden if they come back (unless that removal is overturned). Only once
    // our own view is whole.
    const m = memberOf(cur, ev.sender)
    if (
      !own &&
      ev.skey === undefined &&
      (m?.m === 'leave' || m?.m === 'ban') &&
      this.myMembership(room) === 'join' &&
      !this.resolved(room).gaps &&
      !(await rt.soft.ancestor(m.id, { id, depth: ev.depth, receivedAt }))
    )
      mark.soft = m.id
    // Owner and moderation events, what they cite, our own events and leaving fit a full room.
    const exempt =
      own ||
      isModerator(cur, ev.sender) ||
      rt.needed.has(id) ||
      (ev.type === 'member' &&
        ev.skey === ev.sender &&
        (c as { m?: unknown } | null)?.m === 'leave')
    const res = await insertEvent(this.db, id, wire, receivedAt, {
      me: this.me,
      peer: '',
      own,
      roomCap: this.deps.roomCap,
      totalCap: this.deps.totalCap,
      roomBytes: this.deps.roomBytes,
      totalBytes: this.deps.totalBytes,
      serverCap: this.deps.serverCap,
      serverBytes: this.deps.serverBytes,
      exempt,
      mark,
      target: (e, t) =>
        targetOk(
          e,
          {
            type: t.type,
            sender: t.sender,
            skey: t.skey,
            fwd: !!(t.wire.c as MsgContent | null)?.fwd,
          },
          as
        ),
      // A moderator's redaction strips its target only while the current state still allows it
      // (cited state alone isn't enough: a demoted or removed moderator keeps old citations).
      mayRedact: (r, t) =>
        r.sender === t.sender ||
        (!!r.mod &&
          membershipOf(this.stateOf(room), r.sender) === 'join' &&
          mayModerate(this.stateOf(room), r.sender, t.sender)),
    })
    // Out of space: what banned members wrote and nobody sees goes now.
    if (res.status === 'full') {
      for (const r of this.rooms.values())
        if (r.id !== room) void this.locked(r.id, () => this.purgeForSpace(r.id)).catch(() => {})
      if ((await this.purgeForSpace(room)) > 0)
        return this.insertNow(room, id, wire, receivedAt, own)
    }
    if (res.status !== 'new') return res
    rt.needed.delete(id)
    if (ev.sender === this.me && ev.dseq !== undefined) await this.noteMine(room, id, ev)
    // Hidden, from someone whose ban stood long enough to purge them: purged on arrival.
    if (mark.soft && this.rooms.get(room)?.bans?.[ev.sender]?.purged)
      await this.purge(room, [ev.sender], [res.rec])
    if (mark.state) {
      await this.learnFrom(res.rec)
      await this.applyState(room, res.rec)
      const target = res.rec.skey as string
      if (
        res.rec.type === 'member' &&
        target !== ev.sender &&
        this.resolved(room).transitions.has(id)
      )
        for (const s of this.deps.node.readySessions(target)) this.tellRemoved(s, room)
    }
    return res
  }

  // Two of a member's events with one number: they equivocated. Their messages from there on
  // aren't shown (their state events are resolution's business).
  private async flag(room: string, ik: string, dseq: number) {
    const cur = this.rooms.get(room)?.flagged?.[ik]
    if (cur !== undefined && cur <= dseq) return
    await this.updateRoom(room, rec => ({
      ...rec,
      flagged: { ...(rec.flagged ?? {}), [ik]: dseq },
    }))
    this.changed(room)
  }

  // Our own chain: the latest of our events here (ours from this device, or brought along by a
  // device move and synced back).
  private async noteMine(room: string, id: string, ev: Core) {
    const n = ev.dseq ?? 0
    await this.updateRoom(room, rec => {
      const cur = rec.mine
      const later = !cur || n > cur.dseq
      const state = ev.skey !== undefined && n > (cur?.sseq ?? -1)
      if (!later && !state) return null
      return {
        ...rec,
        mine: {
          ...(later
            ? { last: id, dseq: n, ts: ev.ts, dwin: ev.dwin ?? 0 }
            : { last: cur.last, dseq: cur.dseq, ts: cur.ts, dwin: cur.dwin }),
          ...(state
            ? { sprev: id, sseq: n }
            : cur?.sprev !== undefined
              ? { sprev: cur.sprev, sseq: cur.sseq ?? 0 }
              : {}),
        },
      }
    })
  }

  // Our next chain fields in a room. Without a record of them (an older store), from our events.
  async nextChain(
    room: string,
    ts: number
  ): Promise<{ dseq: number; dwin: number; ts: number; dprev?: string; sprev?: string }> {
    let mine = this.rooms.get(room)?.mine ?? null
    if (!mine) {
      const tx = this.db.transaction('events')
      const range = IDBKeyRange.bound([room, this.me, -Infinity], [room, this.me, Infinity])
      let cursor = await tx.store.index('room_dseq').openCursor(range, 'prev')
      let last: EventRecord | null = null
      let sp: EventRecord | null = null
      while (cursor) {
        last ??= cursor.value
        if (cursor.value.state) {
          sp = cursor.value
          break
        }
        cursor = await cursor.continue()
      }
      await tx.done
      if (last)
        mine = {
          last: last.id,
          dseq: last.wire.ev.dseq ?? 0,
          ts: last.wire.ev.ts,
          dwin: last.wire.ev.dwin ?? 0,
          ...(sp ? { sprev: sp.id, sseq: sp.wire.ev.dseq ?? 0 } : {}),
        }
    }
    // What we kept when the room was last removed from here, if it is further along.
    const kept = ((await this.db.get('meta', chainMetaKey(room))) as RoomRecord['mine']) ?? null
    if (kept && (!mine || kept.dseq > mine.dseq)) mine = kept
    if (!mine) return { dseq: 0, dwin: 0, ts }
    const at = Math.max(ts, mine.ts)
    const day = (t: number) => Math.floor(t / CHAIN.day)
    return {
      dseq: mine.dseq + 1,
      dprev: mine.last,
      dwin: day(at) === day(mine.ts) ? mine.dwin + 1 : 0,
      ts: at,
      ...(mine.sprev !== undefined ? { sprev: mine.sprev } : {}),
    }
  }

  // Whether someone else put `ik` out of a room we are in (a kick or a ban).
  private removed(room: string, ik: string) {
    if (this.myMembership(room) !== 'join') return false
    const m = memberOf(this.stateOf(room), ik)
    return !!m && m.sender !== ik && (m.m === 'leave' || m.m === 'ban')
  }

  // A session that is only up so a removed member hears it: told, then closed.
  private farewell(s: Session) {
    const ik = s.remote?.ik
    if (!ik || this.deps.node.contact(ik)?.state === 'mutual') return
    const rooms = [...this.rooms.keys()]
    if (rooms.some(room => this.may(room, ik))) return
    const gone = rooms.filter(room => this.removed(room, ik))
    if (!gone.length) return
    for (const room of gone) this.tellRemoved(s, room)
    this.clock.set(() => s.close('refused'), 5_000)
  }

  // Someone we no longer serve hears why: their own member event, when someone else wrote it
  // (a kick or a ban). Nothing else of the room goes to them.
  private tellRemoved(s: Session, room: string) {
    const ik = s.remote?.ik
    if (!ik) return
    const m = memberOf(this.stateOf(room), ik)
    if (!m || m.sender === ik || (m.m !== 'leave' && m.m !== 'ban')) return
    void this.db.get('events', m.id).then(rec => {
      if (rec) void s.send({ t: 'gmember', room, ev: rec.wire }).catch(() => {})
    })
  }

  private async onMember(m: Message, s: Session) {
    const room = m.room
    if (typeof room !== 'string' || !this.rooms.has(room)) return
    const ev = (m.ev as { ev?: { type?: unknown; skey?: unknown } } | null)?.ev
    if (ev?.type !== 'member' || ev.skey !== this.me) return s.strike()
    const v = await this.check(room, m.ev)
    if (!v.ok) {
      if (!v.later) s.strike()
      return
    }
    await this.insert(room, v.id, v.wire, this.clock.now()).catch(() => {})
  }

  // Devices and profiles from member and create events.
  private async learnFrom(rec: EventRecord) {
    const c = rec.wire.c as Record<string, unknown> | null
    if (!c) return
    const ik =
      rec.type === 'create' ? (c.creator as string) : rec.type === 'member' ? rec.skey : null
    if (!ik || !isKeyId(ik) || ik === this.me) return
    const certs = verifyCert(c.cert, ik) ? [c.cert as Cert] : []
    const profile = verifyProfile(c.profile, ik) ? (c.profile as Profile) : null
    if (certs.length || profile) await this.learn(ik, certs, [], profile)
    // The member's account badge, from their own events, checked like one from a hello.
    if (c.binding !== undefined && rec.sender === ik) this.deps.node.heardBinding(ik, c.binding)
  }

  // Counts, pings and alerts for stored messages (only those shown), and files.
  private async stored(room: string, added: Inserted[]) {
    const s = this.stateOf(room)
    const r = this.rooms.get(room)
    const rt = this.ensureRt(room)
    const since = r?.since ?? Infinity
    // Walks that met events missing here may answer differently now.
    rt.soft.arrived(added.flatMap(a => (a.status === 'new' ? [a.rec.id] : [])))
    if (r?.joining) {
      if (r.joining.ev) void this.locked(room, () => this.takeInvite(room)).catch(() => {})
      this.maybeJoin(room)
    }
    const counts: Record<string, ChanCounts> = {}
    const arrivals: ServerArrival[] = []
    for (const a of added) {
      if (a.status !== 'new') continue
      const rec = a.rec
      if (rec.type === 'redact' && a.freed.length) {
        const mine = rec.sender === this.me
        void this.deps.dms.blobs
          .release(a.freed, x => !mine || x.room !== room || x.sender === this.me)
          .catch(() => {})
      }
      if (rec.sender === this.me || rec.state) continue
      if (!(await rt.soft.visible(rec, s))) continue
      const c = rec.wire.c as Record<string, unknown> | null
      let ch: string | null = null
      let ping: ServerArrival['ping'] = null
      let unread = false
      if (rec.type === 'msg' && c && rec.chan) {
        ch = rec.chan
        unread = true
        const m = c as unknown as MsgContent
        this.gossip.stopTyping(room, ch, rec.sender)
        if (!m.fwd && m.mentions?.includes(this.me)) ping = 'mention'
        else if (m.everyone && can(s, rec.sender, P.MentionEveryone)) ping = 'everyone'
        else if (m.reply) {
          const t = await this.db.get('events', m.reply)
          if (t && t.room === room && t.type === 'msg' && t.sender === this.me) ping = 'reply'
        }
        this.autoFetch(rec, m)
      } else if (rec.type === 'react' && c?.on === true && rec.target) {
        const t = await this.db.get('events', rec.target)
        if (t && t.room === room && t.sender === this.me && t.chan) {
          ch = t.chan
          ping = 'reaction'
        }
      }
      if (!ch || rec.effTs < since) continue
      const cur = counts[ch] ?? { unread: 0, pings: 0, readSeq: 0 }
      counts[ch] = {
        ...cur,
        unread: cur.unread + (unread ? 1 : 0),
        pings: cur.pings + (ping ? 1 : 0),
      }
      arrivals.push({ room, ch, rec, ping, unread })
    }
    if (Object.keys(counts).length)
      await this.updateRoom(room, cur => {
        const chans = { ...cur.chans }
        for (const [ch, n] of Object.entries(counts)) {
          const old = chans[ch] ?? { unread: 0, pings: 0, readSeq: 0 }
          chans[ch] = { ...old, unread: old.unread + n.unread, pings: old.pings + n.pings }
        }
        return { ...cur, chans }
      })
    for (const a of arrivals) for (const fn of this.arriveFns) fn(a)
    this.changed(room)
  }

  // Images up to the server limit are fetched by themselves.
  private autoFetch(rec: EventRecord, m: MsgContent) {
    const max = this.deps.autoMax?.() ?? 0
    if (max <= 0 || this.deps.attachments?.() === false) return
    const seen = new Set<string>()
    for (const f of [...(m.att ?? []), ...(m.fwd?.att ?? [])]) {
      if (f.size > max || !f.mime.startsWith('image/') || seen.has(f.h)) continue
      seen.add(f.h)
      this.deps.dms.autoFetch(rec.sender, f)
    }
  }

  // ----- Serving -----

  // What we serve a member: everything, only what came after their join (history `joined`),
  // only state (invited, not joined yet), or nothing.
  private gate(room: string, ik: string): 'all' | 'state' | 'none' | { from: string } {
    const s = this.stateOf(room)
    const m = membershipOf(s, ik)
    if (m === 'invite') return 'state'
    // Someone who redeemed a code with us gets the state, to join.
    if (m !== 'join')
      return this.myMembership(room) === 'join' && this.redeeming(room, ik) ? 'state' : 'none'
    if (historyOf(s) === 'joined') {
      const from = this.resolved(room).joins.get(ik)
      return from ? { from } : 'state'
    }
    return 'all'
  }

  // Whether `id` comes after the join event `from` (has it among its ancestors). Bounded: past
  // SERVER.descWalk steps the answer is no.
  async after(room: string, from: string, id: string): Promise<boolean> {
    const rt = this.ensureRt(room)
    let memo = rt.desc.get(from)
    if (!memo) {
      memo = new Map()
      rt.desc.set(from, memo)
      while (rt.desc.size > SERVER.descJoins) rt.desc.delete(rt.desc.keys().next().value as string)
    }
    const top = await this.db.get('events', from)
    if (!top) return false
    const floor = top.depth
    const stack = [id]
    const recs = new Map<string, EventRecord | null>()
    const missingHere = new Set<string>()
    const falses: string[] = []
    let steps = 0
    while (stack.length) {
      const at = stack[stack.length - 1]
      if (memo.has(at)) {
        stack.pop()
        continue
      }
      if (at === from) {
        memo.set(at, true)
        stack.pop()
        continue
      }
      if (++steps > SERVER.descWalk) return false
      let rec = recs.get(at)
      if (rec === undefined) {
        rec = (await this.db.get('events', at)) ?? null
        recs.set(at, rec)
      }
      // An event missing here isn't remembered as "before": it may arrive.
      if (!rec) {
        stack.pop()
        memo.set(at, false)
        missingHere.add(at)
        continue
      }
      if (rec.room !== room || rec.depth <= floor) {
        memo.set(at, false)
        stack.pop()
        continue
      }
      const prev = rec.wire.ev.prev
      if (prev.some(p => memo.get(p) === true)) {
        memo.set(at, true)
        stack.pop()
        continue
      }
      const open = prev.filter(p => !memo.has(p))
      if (!open.length) {
        memo.set(at, false)
        falses.push(at)
        stack.pop()
      } else stack.push(...open)
      while (memo.size > SERVER.descMemo) memo.delete(memo.keys().next().value as string)
    }
    const out = memo.get(id) === true
    // A "no" that met events missing here may become a "yes" once they arrive: not kept.
    if (missingHere.size) for (const k of [...missingHere, ...falses]) memo.delete(k)
    return out
  }

  private async walk(
    link: Link,
    from: string[],
    have: string[],
    limit: number,
    bytes: number,
    state: boolean
  ): Promise<Walked> {
    const g = this.gate(link.room, link.ik)
    if (g === 'none') return { events: [], more: false, denied: true }
    if (state) return this.walkState(link.room, from, have, limit, bytes)
    if (g === 'state') return { events: [], more: false, denied: true }
    const room = link.room
    const keep = async (r: EventRecord) =>
      typeof g === 'string' || (await this.joinedSees(room, g.from, r))
    return this.walkPrev(room, from, have, limit, bytes, keep)
  }

  // The state DAG, back from `from` over `pstate` links, stopping at what the peer has.
  private async walkState(
    room: string,
    from: string[],
    have: string[],
    limit: number,
    bytes: number
  ): Promise<Walked> {
    const tx = this.db.transaction('events')
    const stop = new Set(have)
    const seen = new Set<string>()
    const queue = from.filter(id => !stop.has(id))
    const out: EventRecord[] = []
    let size = 0
    let more = false
    while (queue.length) {
      if (out.length >= limit || seen.size >= DAG.walk) {
        more = true
        break
      }
      const id = queue.shift() as string
      if (seen.has(id)) continue
      seen.add(id)
      const r = await tx.store.get(id)
      if (!r || r.room !== room || !r.state) continue
      const n = JSON.stringify(r.wire).length
      if (out.length > 0 && size + n > bytes) {
        more = true
        break
      }
      size += n
      out.push(r)
      const ev = r.wire.ev
      for (const p of [...(ev.pstate ?? []), ...(ev.auth ?? [])])
        if (!stop.has(p) && !seen.has(p)) queue.push(p)
    }
    await tx.done
    out.sort((a, b) => a.depth - b.depth || (a.id < b.id ? -1 : 1))
    return { events: out, more }
  }

  // Like dag.walkBack, skipping (and not walking past) what the requester may not have.
  private async walkPrev(
    room: string,
    from: string[],
    have: string[],
    limit: number,
    bytes: number,
    keep: (r: EventRecord) => Promise<boolean>
  ): Promise<Walked> {
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
      const r = await this.db.get('events', id)
      if (!r || r.room !== room) continue
      // A purged event is never served (the peer gets it from someone who has it), but the walk
      // goes on past it.
      if (r.purged) {
        for (const p of r.wire.ev.prev) if (!stop.has(p) && !seen.has(p)) queue.push(p)
        continue
      }
      if (!(await keep(r))) continue
      const n = JSON.stringify(r.wire).length
      if (out.length > 0 && size + n > bytes) {
        more = true
        break
      }
      size += n
      out.push(r)
      for (const p of r.wire.ev.prev) if (!stop.has(p) && !seen.has(p)) queue.push(p)
    }
    out.sort((a, b) => a.depth - b.depth || (a.id < b.id ? -1 : 1))
    return { events: out, more }
  }

  private async getFor(link: Link, ids: string[]) {
    const g = this.gate(link.room, link.ik)
    if (g === 'none') return []
    const found = await getEvents(this.db, link.room, ids)
    const out: EventRecord[] = []
    for (const r of found) {
      if (r.purged) continue
      if (r.state) out.push(r)
      else if (g === 'all') out.push(r)
      else if (typeof g === 'object' && (await this.joinedSees(link.room, g.from, r))) out.push(r)
    }
    return out
  }

  // History `joined`: an event after the join, and for an edit, reaction or pin, a target after
  // it too (an edit restates its message; a redaction carries nothing and may go).
  private async joinedSees(room: string, from: string, r: EventRecord) {
    if (!(await this.after(room, from, r.id))) return false
    if (!r.target || r.type === 'redact') return true
    return this.after(room, from, r.target)
  }

  // Our new events go out live to members who may have everything; members who only see what
  // came after their join pull them (and the gate checks each one); invited ones get state.
  private pushable(link: Link, wire: Wire) {
    const g = this.gate(link.room, link.ik)
    if (g === 'all') return true
    if (g === 'none') return false
    return wire.ev.skey !== undefined
  }

  // The file gate for server rooms: a joined member, a live message they didn't write that
  // carries the file, shown under the current state, and (history `joined`) after their join.
  async entitled(ik: string, h: string) {
    for (const r of await this.db.getAllFromIndex('events', 'att', h)) {
      if (r.redacted || r.sender === ik || !this.rooms.has(r.room)) continue
      const s = this.stateOf(r.room)
      if (membershipOf(s, ik) !== 'join') continue
      if (!(await this.ensureRt(r.room).soft.visible(r, s))) continue
      const g = this.gate(r.room, ik)
      if (g === 'all') return true
      if (typeof g === 'object' && (await this.after(r.room, g.from, r.id))) return true
    }
    return false
  }

  // Who may have a file: joined members of the rooms where someone else's live message carries
  // it.
  async holdersOf(h: string) {
    const out = new Set<string>()
    for (const r of await this.db.getAllFromIndex('events', 'att', h)) {
      if (r.redacted || r.sender === this.me || !this.rooms.has(r.room)) continue
      for (const ik of this.joinedOthers(r.room)) out.add(ik)
    }
    return [...out]
  }

  // ----- Our own events -----

  private async author() {
    const author = this.deps.node.author()
    if (!author) throw new ServerError(MOVED_TEXT)
    if (await this.deps.node.sendingPaused()) throw new ServerError(MOVING_TEXT)
    return author
  }

  // Builds and checks an event of ours on the current heads (call within the room's lock).
  private async build(
    room: string,
    type: EvType,
    content: Content,
    opts: { skey?: string; code?: string }
  ) {
    const author = await this.author()
    const rec = await this.deps.store.room(room)
    if (!rec) throw new ServerError('Unknown server')
    await this.ensureRt(room).loading
    const res = this.resolved(room)
    const heads = rec.heads.slice(0, EV.prev)
    const depth = heads.length ? Math.max(...heads.map(h => h.depth)) + 1 : 0
    const chain = await this.nextChain(room, this.clock.now())
    const now = chain.ts
    const c = content as unknown as Record<string, unknown>
    const auth = authRefs(res.state, {
      type,
      sender: this.me,
      skey: opts.skey,
      content: c,
      code: opts.code,
    })
    const state = opts.skey !== undefined
    // Our previous state event must be part of where this one sits (it always is, unless there
    // are more state heads than an event may name).
    let pstate = parentsOf(res.heads, STATE_LIMITS.pstate)
    if (
      state &&
      chain.sprev &&
      res.heads.length > STATE_LIMITS.pstate &&
      !pstate.includes(chain.sprev)
    )
      pstate = [chain.sprev, ...pstate.slice(0, STATE_LIMITS.pstate - 1)]
    const power =
      state && isPowerChain({ type, sender: this.me, skey: opts.skey as string, content: c })
        ? res.power.get(this.me)
        : undefined
    const { id, wire } = buildEvent(
      author,
      room,
      type,
      content,
      heads.map(h => h.id),
      depth,
      now,
      {
        auth,
        ...(state ? { skey: opts.skey, pstate } : {}),
        dseq: chain.dseq,
        dwin: chain.dwin,
        ...(chain.dprev !== undefined ? { dprev: chain.dprev } : {}),
        ...(state && chain.sprev !== undefined ? { sprev: chain.sprev } : {}),
        ...(power !== undefined ? { pprev: power } : {}),
      }
    )
    const v = await this.check(room, wire)
    if (!v.ok)
      throw new ServerError(
        v.later ? "You've done that too often. Try again later." : "You can't do that here"
      )
    return { id, wire, now }
  }

  // Builds, checks, stores and sends an event of ours, within the room's lock.
  private emit(
    room: string,
    type: EvType,
    content: Content,
    opts: { skey?: string; code?: string } = {}
  ) {
    return this.locked(room, async () => {
      const { id, wire, now } = await this.build(room, type, content, opts)
      let out: Inserted
      try {
        out = await this.insertNow(room, id, wire, now, true)
        if (out.status === 'new')
          await this.db.put('outbox', { id, room, created: now, deliveredTo: [] })
      } catch (e) {
        if (!isQuotaError(e)) throw e
        this.storageFull = true
        throw new ServerError(STORAGE_FULL_TEXT)
      }
      if (out.status === 'full') throw new ServerError(this.deps.dms.fullText(out.why))
      if (out.status === 'invalid' || out.status === 'quota')
        throw new ServerError("Couldn't save that")
      this.storageFull = false
      this.sync.push(room, id, wire)
      this.sync.announce(room)
      this.changed(room)
      return id
    })
  }

  // A new server, with its creator joined, @everyone, a name, a #general channel, shared history
  // and join/leave lines in #general.
  async create(name: string): Promise<string> {
    const author = await this.author()
    const clean = name.trim().slice(0, 100) || 'P2P server'
    const now = this.clock.now()
    const content = { kind: 'server', v: 1, creator: this.me, cert: this.deps.node.cert }
    const { id: room, wire } = buildEvent(
      author,
      b64u(randomBytes(32)),
      'create',
      content,
      [],
      0,
      now,
      { skey: '', dseq: 0, dwin: 0 }
    )
    await this.putRoom({
      ...blankRoom(room, '', now),
      kind: 'server',
      name: clean,
      chans: {},
      server: null,
      since: now,
    })
    await this.locked(room, async () => {
      const res = await this.insertNow(room, room, wire, now, true)
      if (res.status !== 'new') throw new ServerError("Couldn't create the server")
      await this.db.put('outbox', { id: room, room, created: now, deliveredTo: [] })
    })
    await this.memberEvent(room, this.me, 'join')
    await this.emit(
      room,
      'role',
      { name: '@everyone', color: null, perms: EVERYONE_PERMS, pos: 0 },
      { skey: EVERYONE }
    )
    await this.emit(room, 'name', { name: clean }, { skey: '' })
    const general = newShortId()
    await this.emit(room, 'channel', { name: 'general', kind: 'text', pos: 0 }, { skey: general })
    await this.emit(room, 'history', { vis: 'shared' }, { skey: '' })
    await this.emit(room, 'system', { ch: general, join: true, leave: true }, { skey: '' })
    return room
  }

  private memberEvent(
    room: string,
    target: string,
    m: Membership,
    extra: { cert?: Cert; profile?: Profile; reason?: string; code?: string } = {}
  ) {
    const content: Record<string, unknown> = { m }
    if (target === this.me && m === 'join') {
      content.cert = this.deps.node.cert
      content.profile = this.deps.node.profile
      const binding = this.deps.node.binding
      if (binding) content.binding = binding
    }
    if (extra.cert) content.cert = extra.cert
    if (extra.profile) content.profile = extra.profile
    if (extra.reason) content.reason = extra.reason.slice(0, 200)
    return this.emit(room, 'member', content, { skey: target, code: extra.code })
  }

  setName(room: string, name: string, color?: number | null) {
    const content: Record<string, unknown> = { name: name.trim().slice(0, 100) }
    if (typeof color === 'number') content.color = color
    return this.emit(room, 'name', content, { skey: '' })
  }

  setHistory(room: string, vis: HistoryVis) {
    return this.emit(room, 'history', { vis }, { skey: '' })
  }

  setSystem(room: string, sys: { ch: string | null; join: boolean; leave: boolean }) {
    return this.emit(room, 'system', sys, { skey: '' })
  }

  addChannel(room: string, name: string) {
    const pos = Math.max(-1, ...channelsOf(this.stateOf(room)).map(c => c.pos)) + 1
    const id = newShortId()
    return this.emit(
      room,
      'channel',
      { name: name.trim().slice(0, 100), kind: 'text', pos },
      { skey: id }
    ).then(() => id)
  }

  editChannel(room: string, id: string, patch: { name?: string; topic?: string; gone?: true }) {
    const cur = channelOf(this.stateOf(room), id)
    if (!cur) throw new ServerError('Unknown channel')
    const next: Record<string, unknown> = { ...cur, ...patch }
    if (patch.name !== undefined) next.name = patch.name.trim().slice(0, 100)
    if (next.topic === '') delete next.topic
    return this.emit(room, 'channel', next, { skey: id })
  }

  kick(room: string, ik: string) {
    return this.memberEvent(room, ik, 'leave')
  }

  ban(room: string, ik: string, reason?: string) {
    return this.memberEvent(room, ik, 'ban', { reason })
  }

  unban(room: string, ik: string) {
    return this.memberEvent(room, ik, 'leave')
  }

  async leave(room: string) {
    const m = this.myMembership(room)
    if (m === 'join' || m === 'invite') await this.memberEvent(room, this.me, 'leave')
    else this.gossip.leave(room)
    await this.updateRoom(room, cur => ({ ...cur, joining: null }))
    this.changed(room)
  }

  // Removes a server we are not in any more from this device.
  async forget(room: string) {
    const m = this.myMembership(room)
    if (m === 'join' || m === 'invite') throw new ServerError('Leave the server first')
    this.gossip.leave(room)
    for (const l of this.sync.linksOf(room)) this.sync.unlink(l.session, room)
    const tx = this.db.transaction(
      ['rooms', 'events', 'children', 'outbox', 'codes', 'meta'],
      'readwrite'
    )
    const events = tx.objectStore('events')
    let n = 0
    let bytes = 0
    let cursor = await events
      .index('room_seq')
      .openCursor(IDBKeyRange.bound([room, -Infinity], [room, Infinity]))
    while (cursor) {
      const r = cursor.value
      for (const p of r.wire.ev.prev) await tx.objectStore('children').delete([p, r.id])
      // A purged event gave its count back already.
      if (!r.purged) {
        n += 1
        bytes += storedSize(r.wire)
      }
      await cursor.delete()
      cursor = await cursor.continue()
    }
    for (const o of await tx.objectStore('outbox').index('room').getAll(room))
      await tx.objectStore('outbox').delete(o.id)
    for (const k of await tx.objectStore('codes').index('room').getAllKeys(room))
      await tx.objectStore('codes').delete(k)
    const meta = tx.objectStore('meta')
    const total = ((await meta.get(SERVER_TOTAL)) as number | undefined) ?? 0
    const totalBytes = ((await meta.get(SERVER_TOTAL_BYTES)) as number | undefined) ?? 0
    await meta.put(Math.max(0, total - n), SERVER_TOTAL)
    await meta.put(Math.max(0, totalBytes - bytes), SERVER_TOTAL_BYTES)
    // Our chain there outlives the room here: if we join again, we go on from it (starting over
    // would be an equivocation).
    const mine = (await tx.objectStore('rooms').get(room))?.mine
    if (mine) await meta.put(mine, chainMetaKey(room))
    await tx.objectStore('rooms').delete(room)
    await tx.done
    this.rooms.delete(room)
    this.rts.delete(room)
    this.host.drop(room)
    this.changed(room)
  }

  // ----- Invite codes -----

  async issueCode(room: string, ttl: number, label = '') {
    const s = this.stateOf(room)
    if (this.myMembership(room) !== 'join') throw new ServerError('Join the server first')
    if (!can(s, this.me, P.Invite)) throw new ServerError("You can't invite people here")
    // At the cap of live codes, our own expired ones are revoked to make room.
    if (!can(s, this.me, P.ManageServer)) {
      const mine = [...s.values()].filter(
        e =>
          e.type === 'code' &&
          e.sender === this.me &&
          !(e.content as unknown as CodeContent).revoked
      )
      const now = this.clock.now()
      const old = mine
        .filter(e => (e.content as unknown as CodeContent).exp <= now)
        .slice(0, Math.max(0, mine.length - STATE_LIMITS.codesPerMember + 1))
      for (const e of old) await this.revokeCode(room, e.skey)
      if (mine.length - old.length >= STATE_LIMITS.codesPerMember)
        throw new ServerError('Revoke one of your invites first')
    }
    const secret = b64u(randomBytes(16))
    const hash = codeHash(secret)
    const exp = this.clock.now() + ttl
    const clean = label.trim().slice(0, 64)
    const content: CodeContent = { exp }
    if (clean) content.label = clean
    await this.emit(room, 'code', content as unknown as Content, { skey: hash })
    const rec: CodeRecord = {
      hash,
      room,
      secret,
      exp,
      label: clean,
      created: this.clock.now(),
    }
    await this.db.put('codes', rec)
    return this.codeText(room, secret)
  }

  // The code string: the room, its name, the secret, and the peer ids of up to 4 members who
  // can let people in (us first). No identities, addresses or anything else.
  codeText(room: string, secret: string) {
    const s = this.stateOf(room)
    const peers = [this.deps.node.peerId]
    for (const ik of this.joinedOthers(room)) {
      if (peers.length >= SERVER.codePeers) break
      if (!can(s, ik, P.Invite)) continue
      const m = memberOf(s, ik)
      if (m?.cert) peers.push(peerId(m.cert.dk))
    }
    return encodeCode({ v: 1, room, name: this.nameNow(room) ?? 'P2P server', secret, peers })
  }

  async revokeCode(room: string, hash: string) {
    const cur = codeOf(this.stateOf(room), hash)
    if (!cur) throw new ServerError('Unknown invite')
    const content: CodeContent = { exp: cur.exp, revoked: true }
    if (cur.label) content.label = cur.label
    await this.emit(room, 'code', content as unknown as Content, { skey: hash })
  }

  // Codes of a room: from its state, with the code string for those we issued here.
  async codes(room: string) {
    const s = this.stateOf(room)
    const mine = new Map(
      (await this.db.getAllFromIndex('codes', 'room', room)).map(c => [c.hash, c])
    )
    const out: {
      hash: string
      exp: number
      revoked: boolean
      label: string
      by: string
      text: string | null
    }[] = []
    for (const e of s.values()) {
      if (e.type !== 'code') continue
      const c = e.content as unknown as CodeContent
      const rec = mine.get(e.skey)
      out.push({
        hash: e.skey,
        exp: c.exp,
        revoked: c.revoked === true,
        label: c.label ?? rec?.label ?? '',
        by: e.sender,
        text: rec ? this.codeText(room, rec.secret) : null,
      })
    }
    return out.sort((a, b) => b.exp - a.exp)
  }

  // Joins with a code: dials the members it names until one lets us in.
  async redeem(text: string): Promise<string> {
    const code = parseCode(text)
    if (!code) throw new ServerError(BAD_CODE)
    if (this.myMembership(code.room) === 'join') return code.room
    if (!this.rooms.has(code.room) && (await this.isDmId(code.room)))
      throw new ServerError(BAD_CODE)
    const now = this.clock.now()
    const had = this.rooms.get(code.room)
    if (!had)
      await this.putRoom({
        ...blankRoom(code.room, '', now),
        kind: 'server',
        name: code.name,
        chans: {},
        server: null,
        joining: { at: now, via: 'code' },
        since: now,
      })
    else await this.updateRoom(code.room, cur => ({ ...cur, joining: { at: now, via: 'code' } }))
    this.ensureRt(code.room).joinPosted = false
    let why: string | null = null
    for (const peer of code.peers) {
      const s = await this.deps.node.dialPeer(peer, { rci: code.room })
      if (!s || !s.remote) continue
      const reply = await this.request(s, {
        t: 'gredeem',
        room: code.room,
        secret: code.secret,
        profile: this.deps.node.profile,
      })
      if (reply?.ok === true) {
        this.prefer(code.room, s.remote.ik)
        // The invite they signed for us: it enters the room once we have the state it cites.
        if (isRecord(reply.ev)) {
          const ev = reply.ev as unknown as Wire
          await this.updateRoom(code.room, cur => ({
            ...cur,
            joining: { at: cur.joining?.at ?? now, via: 'code', ev },
          }))
          void this.locked(code.room, () => this.takeInvite(code.room)).catch(() => {})
        }
        this.changed(code.room)
        return code.room
      }
      const w = typeof reply?.why === 'string' ? reply.why : null
      if (w && w in REDEEM_TEXT) {
        why = w
        if (w !== 'unknown') break
      }
    }
    if (!had) await this.forgetEmpty(code.room)
    else await this.updateRoom(code.room, cur => ({ ...cur, joining: null }))
    throw new ServerError(why ? REDEEM_TEXT[why] : NOBODY_ONLINE)
  }

  private async forgetEmpty(room: string) {
    if (await this.dropEmpty(room)) this.changed(room)
  }

  private request(s: Session, msg: Message): Promise<Message | null> {
    return new Promise(resolve => {
      const key = `${s.peer}\n${msg.room as string}`
      const timer = this.clock.set(() => {
        this.waiters.delete(key)
        resolve(null)
      }, SERVER.redeemMs)
      this.waiters.set(key, m => {
        this.clock.clear(timer)
        this.waiters.delete(key)
        resolve(m)
      })
      s.onClose(() => this.waiters.get(key)?.({ t: 'gredeemed', ok: false }))
      void s.send(msg).catch(() => resolve(null))
    })
  }

  private onRedeemed(m: Message, s: Session) {
    if (typeof m.room !== 'string') return s.strike()
    this.waiters.get(`${s.peer}\n${m.room}`)?.(m)
  }

  // The invite an admitting member signed for us, once we hold what it cites: stored, and our
  // join follows (afterState). Dropped when it can never be stored.
  private async takeInvite(room: string) {
    const r = this.rooms.get(room)
    const wire = r?.joining?.ev
    if (!wire) return
    const m = this.myMembership(room)
    if (m !== 'invite' && m !== 'join') {
      const v = await this.check(room, wire)
      if (!v.ok && v.later) return
      if (v.ok) await this.insertNow(room, v.id, v.wire, this.clock.now(), false)
    }
    await this.updateRoom(room, cur =>
      cur.joining?.ev ? { ...cur, joining: { at: cur.joining.at, via: cur.joining.via } } : null
    )
  }

  // Someone redeems a code with us: we check it by our own clock and, if it holds, sign an
  // invite for them (their device certificate is the one the session proved) and let them sync
  // the state for a while. The invite goes to them only: the room gets it with their join, so
  // a redeem that never turns into a join leaves nothing behind. Redeems count against
  // per-code and per-room limits while they last.
  private async onRedeem(m: Message, s: Session) {
    const r = s.remote
    const room = m.room
    if (!r || typeof room !== 'string' || bytesOf(m.secret, 16) === null) return s.strike()
    const n = (this.redeems.get(s) ?? 0) + 1
    this.redeems.set(s, n)
    if (n > SERVER.redeems) return s.strike()
    const answer = (ok: boolean, why?: string, ev?: Wire) =>
      void s
        .send({ t: 'gredeemed', room, ok, ...(why ? { why } : {}), ...(ev ? { ev } : {}) })
        .catch(() => {})
    const st = this.stateOf(room)
    if (this.myMembership(room) !== 'join' || !can(st, this.me, P.Invite))
      return answer(false, 'unknown')
    const hash = codeHash(m.secret as string)
    const code = codeOf(st, hash)
    if (!code) return answer(false, 'unknown')
    if (code.revoked) return answer(false, 'revoked')
    // A code whose issuer was put out or may no longer invite is dead.
    if (
      membershipOf(st, code.sender) !== 'join' ||
      !(can(st, code.sender, P.Invite) || can(st, code.sender, P.ManageServer))
    )
      return answer(false, 'unknown')
    // Expiry by our clock, and never more than codeTtl after the code was made.
    const now = this.clock.now()
    const made = Math.min(st.get(stateKey('code', hash))?.ts ?? 0, now)
    if (Math.min(code.exp, made + STATE_LIMITS.codeTtl) <= now) return answer(false, 'expired')
    const cur = membershipOf(st, r.ik)
    if (cur === 'ban') return answer(false, 'banned')
    if (cur === 'join') {
      this.prefer(room, r.ik)
      return answer(true)
    }
    const map = this.redeemersOf(room)
    if (!map.has(r.ik)) {
      const perCode = [...map.values()].filter(x => x.code === hash).length
      if (perCode >= SERVER.redeemsPerCode || map.size >= SERVER.redeemsPerRoom)
        return answer(false, 'busy')
    }
    let ev: Wire | undefined
    if (cur !== 'invite') {
      const profile = verifyProfile(m.profile, r.ik) ? (m.profile as Profile) : undefined
      // It names the code and lapses with it (or sooner): the rules refuse it once the code is
      // revoked or expired where it sits, and a join after it lapsed.
      const exp = Math.min(code.exp, made + STATE_LIMITS.codeTtl, now + STATE_LIMITS.codeInviteTtl)
      const content = {
        m: 'invite',
        cert: r.cert,
        code: hash,
        exp,
        ...(profile ? { profile } : {}),
      }
      try {
        const id = await this.emit(room, 'member', content as unknown as Content, {
          skey: r.ik,
          code: hash,
        })
        ev = (await this.db.get('events', id))?.wire
      } catch {
        return answer(false, 'unknown')
      }
    } else {
      const inv = memberOf(st, r.ik)
      if (inv) ev = (await this.db.get('events', inv.id))?.wire
    }
    // A repeat redeem doesn't extend the entry (no holding a slot by redeeming again).
    if (!map.has(r.ik)) map.set(r.ik, { code: hash, until: now + SERVER.redeemTtl })
    this.redeemers.set(room, map)
    this.prefer(room, r.ik)
    answer(true, undefined, ev)
  }

  // ----- Direct invites -----

  // Invites a mutual contact; they see it under "P2P server invites" when they are online.
  async invite(room: string, ik: string) {
    const c = this.deps.node.contact(ik)
    if (!c || c.state !== 'mutual') throw new ServerError('Only mutual contacts can be invited')
    const cert = liveCerts(c.certs, c.revocations)[0]
    const cur = membershipOf(this.stateOf(room), ik)
    if (cur === 'join') throw new ServerError('Already a member')
    if (cur === 'ban') throw new ServerError('This contact is banned from the server')
    if (cur !== 'invite')
      await this.memberEvent(room, ik, 'invite', {
        ...(cert ? { cert } : {}),
        ...(c.profile ? { profile: c.profile } : {}),
      })
    for (const s of this.deps.node.readySessions(ik)) this.sendInvite(s, room)
  }

  private sendInvite(s: Session, room: string) {
    const m = memberOf(this.stateOf(room), s.remote?.ik ?? '')
    if (m?.m !== 'invite') return
    void this.db.get('events', m.id).then(rec => {
      if (!rec) return
      void s
        .send({ t: 'ginvite', room, name: this.nameNow(room) ?? 'P2P server', ev: rec.wire })
        .catch(() => {})
    })
  }

  // A contact comes online: they hear about invites they haven't answered.
  private offerInvites(s: Session) {
    const ik = s.remote?.ik
    if (!ik || this.deps.node.contact(ik)?.state !== 'mutual') return
    for (const room of this.rooms.keys())
      if (this.myMembership(room) === 'join' && membershipOf(this.stateOf(room), ik) === 'invite')
        this.sendInvite(s, room)
  }

  private async onInvite(m: Message, s: Session) {
    const from = s.remote?.ik
    const room = m.room
    if (!from || typeof room !== 'string' || typeof m.name !== 'string') return s.strike()
    // Only from mutual contacts: nobody else can put rows in our list.
    if (this.deps.node.contact(from)?.state !== 'mutual') return
    const v = validate(m.ev, {
      room,
      members: null,
      devices: ik => this.deps.node.anyDevicesOf(ik),
    })
    if (!v.ok) return s.strike()
    const ev = v.wire.ev
    if (
      ev.type !== 'member' ||
      ev.skey !== this.me ||
      (v.wire.c as { m?: unknown } | null)?.m !== 'invite'
    )
      return s.strike()
    const cur = this.rooms.get(room)
    if (cur && (cur.joining || this.myMembership(room) === 'join')) return
    // An invite naming a DM's room id is never taken.
    if (!cur && (await this.isDmId(room))) return
    const pending = [...this.rooms.values()].filter(r => r.invite).length
    if (!cur && pending >= SERVER.invites) return
    const now = this.clock.now()
    await this.putRoom({
      ...(cur ?? { ...blankRoom(room, '', now), kind: 'server', chans: {}, server: null }),
      name: Array.from(m.name).slice(0, 100).join(''),
      invite: { from, at: now, wire: v.wire },
    })
    this.ensureRt(room)
    this.changed(room)
  }

  invites() {
    return [...this.rooms.values()].filter(r => r.invite && !r.joining)
  }

  async acceptInvite(room: string) {
    const r = this.rooms.get(room)
    if (!r?.invite) return
    const from = r.invite.from
    const now = this.clock.now()
    await this.updateRoom(room, cur => ({
      ...cur,
      invite: null,
      joining: { at: now, via: 'invite' },
      since: now,
    }))
    this.ensureRt(room).joinPosted = false
    this.prefer(room, from)
    this.deps.node.schedule(true)
    this.changed(room)
  }

  async declineInvite(room: string) {
    const r = this.rooms.get(room)
    if (!r?.invite) return
    if (!(await this.dropEmpty(room)))
      await this.updateRoom(room, cur => ({ ...cur, invite: null }))
    this.changed(room)
  }

  // ----- Messages -----

  // Member names a message may mention, by member.
  private mentionables(room: string) {
    const out: { ik: string; names: string[] }[] = []
    const s = this.stateOf(room)
    for (const m of membersOf(s)) {
      if (m.m !== 'join' || m.ik === this.me) continue
      const c = this.deps.node.contact(m.ik)
      const names = [
        c?.petname,
        c?.name,
        this.idents.get(m.ik)?.profile?.name,
        memberOf(s, m.ik)?.profile?.name,
      ]
      out.push({ ik: m.ik, names: [...new Set(names.filter((n): n is string => !!n))] })
    }
    return out
  }

  async send(
    room: string,
    msg: { ch: string; body: string; reply?: string; fwd?: Fwd; att?: Attachment[] }
  ) {
    const content: MsgContent = { body: msg.body, ch: msg.ch }
    if (msg.reply) content.reply = msg.reply
    if (msg.att?.length) content.att = msg.att
    if (msg.fwd) content.fwd = msg.fwd
    else {
      const mentions = this.mentionables(room)
        .filter(m => mentionsIn(msg.body, m.names))
        .map(m => m.ik)
        .slice(0, EV.mentions)
      if (mentions.length) content.mentions = mentions
      if (MENTION_EVERYONE.test(msg.body) && can(this.stateOf(room), this.me, P.MentionEveryone))
        content.everyone = true
    }
    return this.emit(room, 'msg', content)
  }

  private async message(room: string, target: string) {
    const r = await this.db.get('events', target)
    if (!r || r.room !== room || r.type !== 'msg') throw new ServerError('Message not found')
    return r
  }

  async edit(room: string, target: string, body: string) {
    const r = await this.message(room, target)
    if (r.sender !== this.me || (r.wire.c as MsgContent | null)?.fwd)
      throw new ServerError("You can't edit this message")
    return this.emit(room, 'edit', { target, body })
  }

  async redact(room: string, target: string) {
    const r = await this.db.get('events', target)
    if (!r || r.room !== room || r.state) throw new ServerError("You can't delete this message")
    if (r.sender !== this.me && !mayModerate(this.stateOf(room), this.me, r.sender))
      throw new ServerError("You can't delete this message")
    const id = await this.emit(room, 'redact', { target })
    this.sync.redactWaiting(room, target)
    const o = await this.db.get('outbox', target)
    if (o?.failed) await this.db.delete('outbox', target)
    return id
  }

  async react(room: string, target: string, key: string, on: boolean) {
    await this.message(room, target)
    return this.emit(room, 'react', { target, key, on })
  }

  async pin(room: string, target: string, on: boolean) {
    const r = await this.message(room, target)
    if (!can(this.stateOf(room), this.me, P.ManageMessages))
      throw new ServerError('Only the owner can pin messages')
    if (on && r.chan) {
      const pins = await this.loadPins(room, r.chan)
      if (pins.length >= PINS_MAX) throw new ServerError(`You can pin up to ${PINS_MAX} messages`)
    }
    return this.emit(room, 'pin', { target, on })
  }

  async retry(room: string, id: string) {
    const r = await this.db.get('events', id)
    const o = await this.db.get('outbox', id)
    if (!r || !o || r.room !== room || r.sender !== this.me) return
    const v = await this.check(room, r.wire)
    if (!v.ok) throw new DmError("This message can't be sent. Delete it instead.")
    await this.db.put('outbox', { ...o, failed: false })
    this.sync.resend(room, id, r.wire)
    this.changed(room)
  }

  async markRead(room: string, ch: string) {
    await this.updateRoom(room, cur => {
      const old = cur.chans?.[ch]
      if (old && !old.unread && !old.pings && old.readSeq === cur.lastSeq) return null
      return {
        ...cur,
        chans: { ...cur.chans, [ch]: { unread: 0, pings: 0, readSeq: cur.lastSeq } },
      }
    })
    this.changed(room)
  }

  typing(room: string, ch: string, on: boolean) {
    this.gossip.typing(room, ch, on)
  }

  typingIn(room: string, ch: string) {
    return this.gossip.typingIn(room, ch)
  }

  loadOlder(room: string) {
    this.sync.loadOlder(room)
  }

  // ----- Views -----

  view(room: string): ServerView | null {
    const r = this.rooms.get(room)
    if (!r) return null
    const s = this.stateOf(room)
    const online = this.gossip.online(room)
    const owner = ownerOf(s)
    const members: MemberView[] = membersOf(s)
      .filter(m => m.m === 'join' || m.m === 'invite' || m.m === 'ban')
      .map(m => ({
        ik: m.ik,
        m: m.m,
        name: this.nameOf(m.ik, room),
        owner: m.ik === owner,
        online: m.m === 'join' && online.has(m.ik),
        contact: this.deps.node.contact(m.ik)?.state === 'mutual',
      }))
    const joined = members.filter(m => m.m === 'join')
    const n = nameOf(s)
    return {
      id: room,
      name: n?.name ?? r.name ?? 'P2P server',
      color: n?.color ?? null,
      me: membershipOf(s, this.me),
      joining: !!r.joining,
      owner,
      perms: membershipOf(s, this.me) === 'join' ? permsOf(s, this.me) : 0,
      history: historyOf(s),
      system: systemOf(s),
      channels: channelsOf(s),
      members,
      online: joined.filter(m => m.online).length,
      joined: joined.length,
      chans: r.chans ?? {},
      gap: r.missing.length > 0,
      full: r.full,
    }
  }

  online(room: string) {
    return this.sync.online(room)
  }

  pulling(room: string) {
    return this.sync.pulling(room)
  }

  // Messages of a channel, oldest first, with join and leave lines in the system channel.
  async loadChannel(
    room: string,
    ch: string,
    opts: { before?: string; after?: string; limit?: number } = {}
  ) {
    const limit = opts.limit ?? 100
    const range = IDBKeyRange.bound(
      [room, ch, opts.after ?? ''],
      [room, ch, opts.before ?? '￿'],
      !!opts.after,
      !!opts.before
    )
    const recs: EventRecord[] = []
    let cursor = await this.db
      .transaction('events')
      .store.index('room_chan_sort')
      .openCursor(range, 'prev')
    while (cursor && recs.length < limit + 1) {
      if (cursor.value.type === 'msg') recs.push(cursor.value)
      cursor = await cursor.continue()
    }
    const more = recs.length > limit
    const page = recs.slice(0, limit).reverse()
    const rows = await this.rows(room, page)
    const sys = systemOf(this.stateOf(room))
    if (sys.ch === ch && (sys.join || sys.leave)) {
      const lo = more ? page[0]?.sortKey : opts.after
      rows.push(...(await this.systemRows(room, lo, opts.before, sys)))
      rows.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0))
    }
    return { messages: rows, more }
  }

  // Join and leave lines from accepted member events in a sort key range.
  private async systemRows(
    room: string,
    lo: string | undefined,
    hi: string | undefined,
    sys: { join: boolean; leave: boolean }
  ) {
    const res = this.resolved(room)
    // A server that shows joiners only what came after them shows no lines from before either.
    const from = historyOf(res.state) === 'joined' ? (res.joins.get(this.me) ?? null) : null
    const recs = await this.db.getAllFromIndex(
      'events',
      'room_type_sort',
      IDBKeyRange.bound([room, 'member', lo ?? ''], [room, 'member', hi ?? '￿'], !!lo, !!hi)
    )
    const out: P2pMessage[] = []
    for (const rec of recs) {
      if (!res.transitions.has(rec.id)) continue
      if (from && rec.id !== from && !(await this.after(room, from, rec.id))) continue
      const before = res.transitions.get(rec.id) ?? null
      const m = (rec.wire.c as { m?: Membership } | null)?.m
      const ik = rec.skey as string
      const kind =
        m === 'join' && before !== 'join'
          ? 'join'
          : (m === 'leave' || m === 'ban') && before === 'join'
            ? 'leave'
            : null
      if (!kind || (kind === 'join' && !sys.join) || (kind === 'leave' && !sys.leave)) continue
      out.push({
        id: rec.id,
        sender: ik,
        ts: rec.effTs,
        sentTs: rec.wire.ev.ts,
        sortKey: rec.sortKey,
        seq: rec.seq,
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
        system: { kind, ik },
      })
    }
    return out
  }

  // Message rows: shown messages only, with reactions of members still shown.
  private async rows(room: string, recs: EventRecord[]) {
    const s = this.stateOf(room)
    const soft = this.ensureRt(room).soft
    const box = new Map<string, OutboxRecord>(
      (await this.db.getAllFromIndex('outbox', 'room', room)).map(o => [o.id, o])
    )
    const shown = new Map<string, boolean>()
    const visible = async (r: EventRecord) => {
      const hit = shown.get(r.id)
      if (hit !== undefined) return hit
      const v = await soft.visible(r, s)
      shown.set(r.id, v)
      return v
    }
    const out: P2pMessage[] = []
    for (const r of recs) {
      if (!(await visible(r))) continue
      const rel: EventRecord[] = []
      let removed = false
      for (const x of await this.db.getAllFromIndex('events', 'room_target', [room, r.id])) {
        // Pins count only from members who may still pin, under the current state.
        if (x.type === 'pin' && !can(s, x.sender, P.ManageMessages)) continue
        // A moderator's redaction refused when it arrived (their power wasn't known here yet)
        // still hides the message once the current state allows it.
        if (
          x.type === 'redact' &&
          x.sender !== r.sender &&
          membershipOf(s, x.sender) === 'join' &&
          mayModerate(s, x.sender, r.sender) &&
          (await visible(x))
        )
          removed = true
        if (x.type === 'redact' || (await visible(x))) rel.push(x)
      }
      if (removed) continue
      const reply = (r.wire.c as MsgContent | null)?.reply
      const target = reply ? await this.db.get('events', reply) : undefined
      const replyRel = target
        ? await this.db.getAllFromIndex('events', 'room_target', [room, target.id])
        : []
      const m = deriveMessage(
        r,
        rel,
        target?.room === room ? target : null,
        replyRel,
        this.me,
        box,
        ''
      )
      if (!m) continue
      const o = box.get(r.id)
      m.pending = r.sender === this.me && !!o && o.deliveredTo.length === 0
      m.failed = m.pending && !!o?.failed
      m.everyone =
        (r.wire.c as MsgContent | null)?.everyone === true && can(s, r.sender, P.MentionEveryone)
      out.push(m)
    }
    return out
  }

  async loadAround(room: string, ch: string, id: string) {
    const r = await this.db.get('events', id)
    if (!r || r.room !== room || r.chan !== ch) return null
    const older = await this.loadChannel(room, ch, { before: r.sortKey, limit: 50 })
    const newer = await this.loadChannel(room, ch, { after: r.sortKey, limit: 1000 })
    const self = await this.rows(room, [r])
    return { messages: [...older.messages, ...self, ...newer.messages], more: older.more }
  }

  // Live pins of a channel, newest first. A pin counts only when its sender is shown and may
  // still pin under the current state (a demoted or removed moderator's pins don't).
  async loadPins(room: string, ch: string) {
    const s = this.stateOf(room)
    const soft = this.ensureRt(room).soft
    const seen = new Set<string>()
    const pins: EventRecord[] = []
    let steps = 0
    let cursor = await this.db
      .transaction('events')
      .store.index('room_type_sort')
      .openCursor(IDBKeyRange.bound([room, 'pin', ''], [room, 'pin', '￿']), 'prev')
    while (cursor && steps < DAG.walk) {
      const p = cursor.value
      steps += 1
      if (p.target && p.wire.c && can(s, p.sender, P.ManageMessages)) pins.push(p)
      cursor = await cursor.continue()
    }
    const on: EventRecord[] = []
    for (const p of pins) {
      if (on.length >= PINS_MAX) break
      if (seen.has(p.target as string) || !(await soft.visible(p, s))) continue
      seen.add(p.target as string)
      if ((p.wire.c as PinContent).on) on.push(p)
    }
    const recs: EventRecord[] = []
    for (const p of on) {
      const r = await this.db.get('events', p.target as string)
      if (r && r.room === room && r.type === 'msg' && r.chan === ch) recs.push(r)
    }
    return this.rows(room, recs)
  }

  // Whether a channel id is one of the room's live text channels.
  isChannel(room: string, ch: string) {
    if (!isShortId(ch)) return false
    const c = channelOf(this.stateOf(room), ch)
    return !!c && !c.gone && c.kind === 'text'
  }
}
