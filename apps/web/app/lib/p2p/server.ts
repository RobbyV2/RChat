import { sha256 } from '@noble/hashes/sha2.js'
import { isRecord } from '../bytes'
import { deviceCertOk, genesisBundle, genesisSrv, signDeviceCert2 } from './acl/binding'
import { aclContentOk, gt, RULES_VERSION, type Rank } from './acl/rules'
import type { ContentEv } from './acl/visibility'
import {
  applySummary,
  emptySummary,
  fromStored,
  IMPL,
  toStored,
  type AclItem,
  type PackedRec,
  type Plan,
  type Received,
  type Shown,
  type SumDelta,
  type Summary,
} from './acl_room'
import { b64u, bytesOf, canonical, fromB64u, randomBytes, utf8 } from './canonical'
import {
  blankRoom,
  chainKey,
  DAG,
  getEvents,
  insertServer,
  SERVER_TOTAL,
  SERVER_TOTAL_BYTES,
  storedSize,
  stripped,
  stripServer,
  UNKNOWN,
  type DevChain,
  type Inserted,
} from './dag'
import {
  serverWire,
  type CodeRecord,
  type EventRecord,
  type IdentRecord,
  type OutboxRecord,
  type P2pDatabase,
  type P2pStore,
  type RoomRecord,
  type ServerCache,
} from './db'
import { reactionsOf } from './dm'
import {
  buildEvent2,
  claimedId2,
  contentEvOf,
  LIMITS as EV,
  LIMITS2,
  sizeOf,
  validate2,
  type Attachment,
  type ChainFields,
  type Fwd,
  type MsgContent,
  type Wire,
  type WireV2,
} from './event'
import type { Message } from './frames'
import { memberBindingDue } from './badge'
import { Gossip, type GossipLimits, type LinkKind } from './gossip'
import { isKeyId, keyId, peerId, verifyCert, verifyProfile, type Cert, type Profile } from './keys'
import { liveCerts } from './keys'
import { mergeCerts, mergeRevocations, displayName } from './contacts'
import type { P2pNode } from './node'
import { LocalHost, WorkerHost, type AclHost, type WorkerLike } from './resolve_host'
import { realClock, type Clock, type Session } from './session'
import {
  can,
  channelOf,
  channelsOf,
  historyOf,
  isOwner,
  isShortId,
  LIMITS as STATE_LIMITS,
  memberOf,
  membershipOf,
  membersOf,
  MOD_BITS,
  nameOf,
  outranks,
  P,
  permsOf,
  systemOf,
  type ChannelContent,
  type HistoryVis,
  type Membership,
  type SystemContent,
} from './state'
import { isQuotaError, Sync, type Check, type Link, type SyncLimits, type Walked } from './sync'
import {
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

// P2P servers (spec p2p-acl-spec §1 to §4): groups whose membership, permissions, channels and
// messages live only on their members' devices. Every event is a signed v2 event of one of two
// layers: ACL events (membership, roles, channels, settings) form a DAG every member holds
// whole; content events (messages) hang off an ACL position. The evaluator (acl_room.ts, in a
// worker in the browser) decides every event (spec §2.1: admitted, rejected, pending, held) and
// works out the current state and what each message shows; this module stores, syncs and serves
// events, builds our own, and keeps the page's mirror of the state. Rooms sync over the same
// sessions as DMs, with their own message types (prefix `s`), on at most 8 links per room
// (gossip.ts).

export const SERVER = {
  // Server rooms on this device, and pending invites from contacts.
  invites: 20,
  // Redeem attempts a session may make.
  redeems: 3,
  redeemMs: 15_000,
  codePeers: 4,
  // A banned member's events that are never shown are purged once the ban has stood this long
  // (or at once when the room or the device runs out of space).
  purgeAfter: 7 * 24 * 60 * 60_000,
  // A code redeemed with us: the redeemer may sync the ACL (to join) for this long, at most
  // this many at once per code and per room. An invite they don't use is withdrawn after it.
  redeemTtl: 10 * 60_000,
  redeemsPerCode: 4,
  redeemsPerRoom: 8,
  // A session with someone who isn't a contact, left without room links, closes after this.
  idleMs: 5_000,
  // Local limits (spec 4.2): events waiting for their ACL parents, per room, and events dated
  // in the future, per device. Overflow is dropped and fetched again later.
  pendingEvents: 2000,
  pendingBytes: 8 * 1024 * 1024,
  heldPerDevice: 256,
  rejectedKept: 10_000,
}

// Vouching marks (Rt.vouch): at most one per room this often, and one per inviter.
export const VOUCH = { roomMs: 10 * 60_000, inviterMs: 60 * 60_000 }

export const CODE_PREFIX = 'rci1.'

// How long a joiner waits for missing ACL events before joining with what it has, and how soon
// the evaluation cache is written after a change.
const JOIN_WAIT = 30_000
const SAVE_MS = 1_000

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
export const LEGACY_TEXT = 'Created with an earlier test version. Recreate it.'
export const UPDATE_TEXT = 'Update the app to take part'
export const TOO_OFTEN_TEXT = "You've done that too often. Try again later."
export const CANT_TEXT = "You can't do that here"
export const SYNC_TEXT = 'Waiting to sync. Try again in a moment.'

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

// What @everyone may do in a new server.
export const EVERYONE_BITS = P.Invite | P.ViewChannel | P.SendMessages

const WINDOW_REASONS = ['W3', 'W3b', 'W3c', 'W3d', 'W3g']

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
  // We outrank them (kick and ban need it, spec 1.6).
  below: boolean
}

export interface ServerView {
  id: string
  name: string
  color: number | null
  me: Membership | null
  joining: boolean
  owner: string | null
  owners: string[]
  perms: number
  history: HistoryVis
  system: SystemContent
  channels: ({ id: string } & ChannelContent)[]
  members: MemberView[]
  online: number
  joined: number
  chans: Record<string, import('./db').ChanCounts>
  // Arrival number of the newest stored event: it moves only when stored content changes.
  seq: number
  gap: boolean
  full: boolean
  // Shown read-only, with this text (a server of old or unknown rules).
  readOnly: string | null
}

interface Parked {
  wire: WireV2
  missing: Set<string>
  size: number
}

interface Rt {
  sum: Summary
  lock: Promise<unknown>
  loading: Promise<void> | null
  joinPosted: boolean
  others: { sum: Summary; list: string[] } | null
  // Events waiting for ACL parents, by id, and who waits on which parent.
  pending: Map<string, Parked>
  pendingBytes: number
  waits: Map<string, Set<string>>
  // Admitted events dated in the future, until local time reaches them.
  held: Map<string, { wire: WireV2; due: number }>
  rejected: Set<string>
  // Invites (add ids, by inviter) another member posted: a tick posts a mark, so the invitee's
  // join has the acknowledgement of a third member it needs (spec 4.1 W3(e)), while the invite is
  // pending and its inviter a member; at most one per inviter per VOUCH.inviterMs and one per room
  // per VOUCH.roomMs.
  vouch: Map<string, string>
  vouchedAt: number
  // Our own ACL events we must hold before we sign again.
  need: Set<string>
}

// Someone who redeemed a code with us: they may sync the ACL until `until` to join; the invite
// we posted for them is withdrawn after that unless they joined.
interface Redeemer {
  code: string
  until: number
  add: string
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
  // Where the evaluator runs (a worker in the browser).
  resolver?: AclHost
}

const MENTION_EVERYONE = /(^|[^\p{L}\p{N}\p{M}_])@everyone(?![\p{L}\p{N}\p{M}_])/iu

interface LockLike {
  request: (name: string, cb: () => Promise<unknown>) => Promise<unknown>
}

const webLocks = (): LockLike | null =>
  typeof navigator !== 'undefined' && navigator.locks
    ? (navigator.locks as unknown as LockLike)
    : null

const sizeOfWire = (w: WireV2) => storedSize(w as unknown as Wire)

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
  private host: AclHost
  private devLocks = new Map<string, Promise<unknown>>()
  // Contacts we agreed to be listed as co-owner by, for a server they are creating.
  private coOwnerOk = new Set<string>()
  // When we last vouched for an invite by each inviter.
  private vouchedBy = new Map<string, number>()
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
    if (this.host instanceof WorkerHost)
      this.host.onLost = () => {
        for (const r of this.rooms.values())
          void this.locked(r.id, () => this.load(r)).catch(() => {})
      }
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
      stateHeads: async room => this.sumOf(room).heads,
      stateWanted: room => this.wanted(room),
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
      moderator: (room, ik) => can(this.sumOf(room), ik, MOD_BITS),
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
        this.myMembership(room) === 'join' && membershipOf(this.sumOf(room), ik) === 'join',
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
        s.on('gbundle', m => this.onBundle(m, s))
        s.on('gbundled', m => this.onRedeemed(m, s))
      },
      ready: s => {
        this.gossip.ready(s)
        this.offerInvites(s)
        this.farewell(s)
      },
      targets: () => this.gossip.targets(),
      wanted: (ik, hello) => this.wantedPeer(ik, hello),
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

  // Every gossip tick: joins that wait, held events that are due, invites redeemed and never
  // used, and bans that stood long enough for what the banned member wrote to be purged.
  private tick() {
    const now = this.clock.now()
    for (const r of this.rooms.values()) {
      if (r.joining) this.maybeJoin(r.id)
      const rt = this.rt(r.id)
      if (rt?.held.size) {
        const due = [...rt.held].filter(([, h]) => h.due <= now)
        for (const [id, h] of due) {
          rt.held.delete(id)
          void this.insert(r.id, id, h.wire as unknown as Wire, now).catch(() => {})
        }
      }
      void this.lapseRedeems(r.id).catch(() => {})
      if (rt?.vouch.size) this.vouch(r.id, rt, now)
      const bans = Object.entries(r.bans ?? {})
        .filter(([, b]) => !b.purged && now - b.since >= SERVER.purgeAfter)
        .map(([ik]) => ik)
      if (bans.length) void this.locked(r.id, () => this.purge(r.id, bans)).catch(() => {})
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
        sum: emptySummary(),
        lock: Promise.resolve(),
        loading: null,
        joinPosted: false,
        others: null,
        pending: new Map(),
        pendingBytes: 0,
        waits: new Map(),
        held: new Map(),
        rejected: new Set(),
        vouch: new Map(),
        vouchedAt: -Infinity,
        need: new Set(),
      }
      this.rts.set(room, rt)
    }
    return rt
  }

  // Runs `fn` after everything else that changes this room.
  private locked<T>(room: string, fn: () => Promise<T>): Promise<T> {
    const rt = this.ensureRt(room)
    const run = rt.lock.then(fn, fn)
    rt.lock = run.catch(() => {})
    return run
  }

  // Signing is serialized per device key across tabs (spec 3.9): a Web Lock where there is one.
  private withDevice<T>(dk: string, fn: () => Promise<T>): Promise<T> {
    const locks = webLocks()
    if (locks) return locks.request(`rchat-p2p-dev:${dk}`, fn) as Promise<T>
    const prev = this.devLocks.get(dk) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    this.devLocks.set(
      dk,
      run.catch(() => {})
    )
    return run
  }

  sumOf(room: string): Summary {
    return this.rt(room)?.sum ?? emptySummary()
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
    return membershipOf(this.sumOf(room), this.me)
  }

  // Read-only: made under rules this build doesn't run.
  readOnly(room: string): string | null {
    const r = this.rooms.get(room)
    if (r?.legacy) return LEGACY_TEXT
    const rules = this.sumOf(room).rules
    return rules !== null && rules !== RULES_VERSION ? UPDATE_TEXT : null
  }

  // Rooms we sync: joined, invited, or on our way in.
  private activeRooms() {
    const out: string[] = []
    for (const r of this.rooms.values()) {
      if (r.legacy) continue
      const m = this.myMembership(r.id)
      if (m === 'join' || m === 'invite' || r.joining) out.push(r.id)
    }
    return out
  }

  // Worked out once per state (gossip asks on every frame).
  private joinedOthers(room: string) {
    const rt = this.rt(room)
    if (!rt) return []
    if (rt.others?.sum === rt.sum) return rt.others.list
    const list = membersOf(rt.sum)
      .filter(m => m.m === 'join' && m.ik !== this.me)
      .map(m => m.ik)
    rt.others = { sum: rt.sum, list }
    return list
  }

  private sharedWith(ik: string) {
    let n = 0
    for (const id of this.rooms.keys()) if (membershipOf(this.sumOf(id), ik) === 'join') n += 1
    return n
  }

  // A member (or invitee) of a server we are in; nothing for one we have left or lost.
  private coMember(ik: string) {
    for (const room of this.rooms.keys()) {
      const s = this.sumOf(room)
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

  // Whether we link `room` with `ik`, and what we may serve them there (spec 3.7).
  may(room: string, ik: string): LinkKind {
    const r = this.rooms.get(room)
    if (!r || r.legacy) return false
    const s = this.sumOf(room)
    const mine = membershipOf(s, this.me)
    // On our way in we have no state yet: whoever let us in is who we sync with.
    if (r.joining && mine !== 'join' && this.isPreferred(room, ik)) return 'full'
    if (mine !== 'join' && mine !== 'invite' && !r.joining) return false
    const m = membershipOf(s, ik)
    if (m === 'join') return 'full'
    if (m === 'invite') return 'state'
    return mine === 'join' && this.redeeming(room, ik) ? 'state' : false
  }

  private isPreferred(room: string, ik: string) {
    return this.gossip.isPreferred(room, ik)
  }

  private prefer(room: string, ik: string) {
    this.gossip.prefer(room, ik)
  }

  // People who redeemed a code with us and may sync the ACL to join, per room.
  private redeemers = new Map<string, Map<string, Redeemer>>()

  private redeemersOf(room: string) {
    const map = this.redeemers.get(room)
    if (!map) return new Map<string, Redeemer>()
    const s = this.sumOf(room)
    for (const [ik] of map) {
      const m = membershipOf(s, ik)
      if (m === 'join' || m === 'ban') map.delete(ik)
    }
    return map
  }

  private redeeming(room: string, ik: string) {
    const r = this.redeemersOf(room).get(ik)
    return !!r && r.until > this.clock.now()
  }

  // Housekeeping (spec 8.1): an invite posted for a redeemer who didn't join within the redeem
  // time is withdrawn.
  private async lapseRedeems(room: string) {
    const map = this.redeemersOf(room)
    const now = this.clock.now()
    for (const [ik, r] of map) {
      if (r.until > now) continue
      map.delete(ik)
      const m = memberOf(this.sumOf(room), ik)
      if (m?.m === 'invite' && m.adds?.includes(r.add))
        await this.emit(room, 'uninvite', () => ({ to: ik })).catch(() => {})
    }
  }

  // A session with someone who isn't a contact, left without room links: closed shortly after,
  // unless it found a use again.
  private idle(s: Session) {
    const ik = s.remote?.ik
    if (!ik || this.deps.node.contact(ik)) return
    this.clock.set(() => {
      if (s.state !== 'ready' || this.sync.linksOn(s).length || this.deps.node.contact(ik)) return
      if ([...this.rooms.keys()].some(room => this.redeeming(room, ik))) return
      if (this.clock.now() - s.lastUseful < SERVER.idleMs) return this.idle(s)
      s.close('closed')
    }, SERVER.idleMs)
  }

  // A hello from someone who isn't a mutual contact: kept when they are a member (or invited)
  // of one of our rooms, or come to redeem an invite code of a room we are in.
  private wantedPeer(ik: string, hello: Message) {
    for (const room of this.rooms.keys())
      if (this.may(room, ik) || this.removed(room, ik)) return true
    const rci = hello.rci
    return (
      typeof rci === 'string' &&
      this.myMembership(rci) === 'join' &&
      can(this.sumOf(rci), this.me, P.Invite)
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
    if (room) {
      const n = memberOf(this.sumOf(room), ik)?.profile?.name
      if (typeof n === 'string' && n.trim()) return Array.from(n).slice(0, 64).join('')
    }
    const p = this.idents.get(ik)?.profile
    if (p) return p.name
    return 'Member'
  }

  // ----- Loading -----

  // A room on start: what the cache says at once (when it is current), while the evaluator
  // rebuilds from the stored events and their admission records (no event is decided again
  // unless its record is missing).
  private async load(r: RoomRecord, records = true): Promise<void> {
    const rt = this.ensureRt(r.id)
    const recs = await this.db.getAllFromIndex(
      'events',
      'room_seq',
      IDBKeyRange.bound([r.id, -Infinity], [r.id, Infinity])
    )
    if (r.legacy || recs.some(x => x.wire.ev.v === 1)) {
      if (!r.legacy) await this.updateRoom(r.id, cur => ({ ...cur, legacy: true }))
      rt.sum = emptySummary()
      this.changed(r.id)
      return
    }
    const cached = r.server?.impl === IMPL ? fromStored(r.server.sum) : null
    if (cached && records) rt.sum = cached
    // Imported rows: the wire checks first (an import is trusted no more than a peer).
    const g = recs.find(x => x.id === r.id)
    const gr = g ? serverWire(g).c?.rules : undefined
    const rules = typeof gr === 'number' ? gr : RULES_VERSION
    const bad: string[] = []
    const acl: (AclItem & { order: number })[] = []
    const contents: ContentEv[] = []
    const check: { id: string; w: WireV2 }[] = []
    for (const x of recs) {
      const w = serverWire(x)
      if (x.imp) {
        const v = x.id === r.id ? validate2(w, null) : validate2(w, r.id, rules)
        if (!v.ok || v.id !== x.id) {
          bad.push(x.id)
          continue
        }
      }
      if (x.layer === 'c' || w.ev.L === 'c') {
        if (x.imp) check.push({ id: x.id, w })
        else contents.push(contentEvOf(x.id, w))
      } else
        acl.push({
          id: x.id,
          w,
          ...(records && x.acl ? { rec: x.acl } : {}),
          order: x.aseq ?? 1e15 + x.seq,
        })
    }
    acl.sort((a, b) => a.order - b.order)
    const run = (async () => {
      const out = await this.host.load(
        r.id,
        acl.map(({ order: _o, ...it }) => it),
        contents,
        check
      )
      const before = rt.sum
      rt.sum = applySummary(emptySummary(), out.delta)
      // A wrong restore shows in the state: the cache was written with these same events.
      if (
        records &&
        !out.mismatch &&
        cached &&
        r.server?.count === rt.sum.count &&
        JSON.stringify(toStored(cached)) !== JSON.stringify(toStored(rt.sum))
      ) {
        rt.sum = before
        return this.load(r, false)
      }
      if (out.fresh.length) {
        const tx = this.db.transaction('events', 'readwrite')
        for (const f of out.fresh) {
          const e = await tx.store.get(f.id)
          if (e) await tx.store.put({ ...e, aseq: f.aseq, acl: f.rec })
        }
        await tx.done
      }
      await this.dropRows(r.id, [...bad, ...out.refused])
      if (recs.some(x => x.imp)) {
        const tx = this.db.transaction('events', 'readwrite')
        for (const x of recs) {
          if (!x.imp) continue
          const e = await tx.store.get(x.id)
          if (e?.imp) {
            const { imp: _i, ...rest } = e
            await tx.store.put(rest)
          }
        }
        await tx.done
      }
      await this.saveCache(r.id)
      await this.afterState(r.id, before)
    })()
    rt.loading = run.catch(() => {})
    await run
  }

  // Stored events that turned out not to be admitted (an import): deleted, their space back.
  private async dropRows(room: string, ids: string[]) {
    if (!ids.length) return
    const tx = this.db.transaction(['events', 'rooms', 'meta'], 'readwrite')
    const events = tx.objectStore('events')
    let n = 0
    let bytes = 0
    for (const id of ids) {
      const e = await events.get(id)
      if (!e || e.room !== room) continue
      await events.delete(id)
      if (e.purged) continue
      n += 1
      bytes += storedSize(e.wire)
    }
    const rec = await tx.objectStore('rooms').get(room)
    if (rec)
      await tx.objectStore('rooms').put({
        ...rec,
        count: Math.max(0, rec.count - n),
        bytes: Math.max(0, (rec.bytes ?? 0) - bytes),
      })
    const meta = tx.objectStore('meta')
    const total = ((await meta.get(SERVER_TOTAL)) as number | undefined) ?? 0
    const tb = ((await meta.get(SERVER_TOTAL_BYTES)) as number | undefined) ?? 0
    await meta.put(Math.max(0, total - n), SERVER_TOTAL)
    await meta.put(Math.max(0, tb - bytes), SERVER_TOTAL_BYTES)
    await tx.done
  }

  private async saveCache(room: string) {
    const sum = this.sumOf(room)
    const cache: ServerCache = {
      impl: IMPL,
      rules: sum.rules,
      count: sum.count,
      sum: toStored(sum),
    }
    const n = nameOf(sum)?.name
    await this.updateRoom(room, cur => ({ ...cur, server: cache, ...(n ? { name: n } : {}) }))
  }

  // What a state change means here: we were let in, or put out.
  private async afterState(room: string, before: Summary, changed?: string[]) {
    const was = membershipOf(before, this.me)
    const now = this.myMembership(room)
    const r = this.rooms.get(room)
    this.maybeJoin(room)
    await this.noteBans(room)
    // In once a join of ours from after we set out is (not an old one the backfill brings
    // first); our own join clears it in postJoin.
    const mine = memberOf(this.sumOf(room), this.me)
    if (now === 'join' && r?.joining && (mine?.joinTs ?? 0) > r.joining.at)
      await this.updateRoom(room, cur => ({
        ...cur,
        joining: null,
        since: cur.since ?? this.clock.now(),
      }))
    // We are in now: everything the gates held back may come.
    if (now === 'join' && was !== 'join') this.sync.loadOlder(room)
    this.sync.announce(room)
    if (was === 'join' && now !== 'join') {
      this.gossip.leave(room)
      this.ensureRt(room).joinPosted = false
    }
    // Those someone else removed hear it from us.
    const s = this.sumOf(room)
    for (const ik of changed ?? Object.keys(s.members)) {
      const m = s.members[ik]
      if (
        m &&
        (m.m === 'leave' || m.m === 'ban') &&
        m.by !== ik &&
        before.members[ik]?.m !== m.m &&
        ik !== this.me
      )
        for (const sess of this.deps.node.readySessions(ik)) this.tellRemoved(sess, room)
    }
    this.gossip.tick()
    this.changed(room)
  }

  // Invited while on our way in: we join once the invite is in the state we hold.
  private maybeJoin(room: string) {
    const r = this.rooms.get(room)
    if (this.myMembership(room) !== 'invite' || !r?.joining) return
    // Not while ACL events we know of are still missing, for at most JOIN_WAIT.
    if (this.rt(room)?.waits.size && this.clock.now() - r.joining.at < JOIN_WAIT) return
    void this.postJoin(room).catch(() => {})
  }

  // Bans in the current state, and since when (by our clock) each has stood. What a banned
  // member wrote is hidden at once; it is purged only once the ban has stood SERVER.purgeAfter,
  // or at once when the room runs out of space here.
  private async noteBans(room: string) {
    const s = this.sumOf(room)
    const now = this.clock.now()
    const banned = new Map(
      membersOf(s)
        .filter(m => m.m === 'ban')
        .map(m => [m.ik, m.rem ?? ''])
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

  // Purges the content banned members `iks` wrote that is stored here and not shown: each such
  // event keeps only its header (never served), its files go, and the room's space comes back.
  private async purge(room: string, iks: string[], only?: EventRecord[]) {
    const s = this.sumOf(room)
    const targets = iks.filter(ik => membershipOf(s, ik) === 'ban')
    const cands: EventRecord[] = []
    if (only) for (const r of only) if (targets.includes(r.sender)) cands.push(r)
    if (!only)
      for (const ik of targets)
        for (const r of await this.db.getAllFromIndex(
          'events',
          'room_dseq',
          IDBKeyRange.bound([room, ik, -Infinity], [room, ik, Infinity])
        ))
          if (r.layer === 'c' && !r.purged) cands.push(r)
    if (!cands.length) return 0
    const shown = await this.host.display(
      room,
      cands.map(r => r.id)
    )
    const hidden = cands.filter((_r, i) => shown[i]?.hidden).map(r => r.id)
    if (!hidden.length && only) return 0
    const tx = this.db.transaction(['events', 'rooms', 'meta'], 'readwrite')
    const events = tx.objectStore('events')
    const meta = tx.objectStore('meta')
    let saved = 0
    let n = 0
    const freed: string[] = []
    for (const id of hidden) {
      const r = await events.get(id)
      if (!r || r.purged) continue
      const next: EventRecord = { ...stripped(r), purged: true }
      saved += storedSize(r.wire) - storedSize(next.wire)
      n += 1
      freed.push(...(r.atts ?? []))
      await events.put(next)
    }
    const rec = await tx.objectStore('rooms').get(room)
    if (rec) {
      const bans = { ...(rec.bans ?? {}) }
      if (!only) for (const ik of targets) if (bans[ik]) bans[ik] = { ...bans[ik], purged: true }
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

  // Out of space: banned members' hidden content goes now, whatever their bans' age.
  private async purgeForSpace(room: string) {
    const due = Object.keys(this.rooms.get(room)?.bans ?? {})
    return due.length ? this.purge(room, due) : 0
  }

  private async postJoin(room: string) {
    const rt = this.ensureRt(room)
    if (rt.joinPosted) return
    rt.joinPosted = true
    try {
      await this.emit(room, 'join', plan => this.joinContent(room, plan))
      await this.updateRoom(room, cur => ({
        ...cur,
        joining: null,
        since: cur.since ?? this.clock.now(),
      }))
      this.changed(room)
      this.deps.node.schedule()
    } catch (e) {
      rt.joinPosted = false
      throw e
    }
  }

  // A join that introduces this device carries its certificate (spec 1.1), signed by the
  // identity key (it plays primary until Task 17), and the v1 certificate and profile peers use
  // to reach and name us.
  private joinContent(room: string, plan: Plan): Record<string, unknown> {
    const author = this.deps.node.author()
    if (!author) throw new ServerError(MOVED_TEXT)
    const dk = keyId(author.dk.pk)
    const c: Record<string, unknown> = {
      idb: { ik: this.me, dcert: signDeviceCert2(author.ik, room, this.me, dk, plan.iprev) },
      profile: this.deps.node.profile,
      cert: this.deps.node.cert,
    }
    const binding = this.deps.node.binding
    if (binding) c.binding = binding
    return c
  }

  // After a device move this device isn't one of ours in the server yet: it introduces itself
  // (device_add). A changed name goes out as a profile write.
  private async refreshMe(room: string) {
    const m = memberOf(this.sumOf(room), this.me)
    const author = this.deps.node.author()
    if (m?.m !== 'join' || !author) return
    const dk = keyId(author.dk.pk)
    if (!m.devs.includes(dk))
      await this.emit(room, 'device_add', plan => ({
        dcert: signDeviceCert2(author.ik, room, this.me, dk, plan.iprev),
        cert: this.deps.node.cert,
        profile: this.deps.node.profile,
      }))
    const name = this.deps.node.name
    if (m.profile && m.profile.name !== name)
      await this.emit(room, 'profile', () => this.profileContent())
  }

  private profileContent() {
    const c: Record<string, unknown> = { name: this.deps.node.name }
    const binding = this.deps.node.binding
    if (binding) c.binding = binding
    return c
  }

  // Our account badge was turned on or renewed: once it is due (badge.ts) every server where it
  // is gets a profile write with it.
  async refreshBadge() {
    const binding = this.deps.node.binding
    const now = this.clock.now()
    const due = [...this.rooms.keys()].filter(id => {
      const m = memberOf(this.sumOf(id), this.me)
      return m?.m === 'join' && memberBindingDue(m.binding, binding, now)
    })
    if (!due.length || !this.deps.node.author()) return
    await this.deps.node.touchProfile()
    for (const id of due)
      await this.emit(id, 'profile', () => this.profileContent()).catch(() => {})
  }

  // ----- Receiving (spec 2.1) -----

  // The wire checks: schema, sizes, id, `ch` and the device's signature. Everything else is
  // admission's (insert). Malformed: a strike.
  async check(room: string, raw: unknown): Promise<Check> {
    const id = claimedId2(raw)
    const r = this.rooms.get(room)
    if (!r || r.legacy) return { ok: false, later: true, id }
    const genesis = isRecord(raw) && isRecord(raw.ev) && raw.ev.t === 'genesis'
    // Before the genesis its rules version is unknown: nothing else is judged yet (no strike).
    if (!genesis && this.sumOf(room).rules === null) return { ok: false, later: true, id }
    const rules = this.sumOf(room).rules ?? RULES_VERSION
    const v = genesis ? validate2(raw, null) : validate2(raw, room, rules)
    if (!v.ok) return { ok: false, later: false, id }
    if (genesis && v.id !== room) return { ok: false, later: false, id }
    return { ok: true, id: v.id, wire: v.wire as unknown as Wire, revoked: false }
  }

  insert(room: string, id: string, wire: Wire, receivedAt: number): Promise<Inserted> {
    return this.locked(room, async () => {
      const out = await this.take(room, id, wire as unknown as WireV2, receivedAt)
      return out
    })
  }

  // ACL ids the room waits for: missing parents of pending events.
  private wanted(room: string) {
    const rt = this.rt(room)
    if (!rt) return []
    return [...rt.need, ...rt.waits.keys()].slice(0, DAG.missing)
  }

  private async admittedHere(room: string, id: string) {
    const r = await this.db.get('events', id)
    return !!r && r.room === room && (r.aseq !== undefined || r.layer === 'a')
  }

  // One received event, within the room's lock: pending while an ACL parent isn't held, refused
  // after a rejected parent, otherwise decided and (admitted) stored, then whatever waited on it.
  private async take(room: string, id: string, w: WireV2, now: number): Promise<Inserted> {
    const rt = this.ensureRt(room)
    await rt.loading
    const have = await this.db.get('events', id)
    if (have) return { status: 'dup', rec: have }
    if (rt.rejected.has(id)) return { status: 'rejected', why: 'known' }
    const ap = w.ev.ap ?? []
    if (ap.some(p => rt.rejected.has(p))) return this.reject(room, id, 'parent')
    const missing: string[] = []
    for (const p of ap) if (!(await this.admittedHere(room, p))) missing.push(p)
    if (missing.length) {
      this.park(room, id, w, missing)
      return { status: 'quota' }
    }
    const res = await this.decide(room, id, w, now)
    if (res.status === 'new') {
      rt.need.delete(id)
      await this.release(room, id, now)
    }
    return res
  }

  private reject(room: string, id: string, why: string): Inserted {
    const rt = this.ensureRt(room)
    rt.rejected.add(id)
    if (rt.rejected.size > SERVER.rejectedKept)
      rt.rejected.delete(rt.rejected.values().next().value as string)
    // What waited on it is refused with it.
    const q = [id]
    while (q.length) {
      const p = q.pop() as string
      for (const c of rt.waits.get(p) ?? []) {
        this.unpark(rt, c)
        rt.rejected.add(c)
        q.push(c)
      }
      rt.waits.delete(p)
    }
    return { status: 'rejected', why }
  }

  // The pending store (spec 4.2): bounded per room; the oldest goes first.
  private park(room: string, id: string, w: WireV2, missing: string[]) {
    const rt = this.ensureRt(room)
    if (rt.pending.has(id)) return
    const size = sizeOfWire(w)
    rt.pending.set(id, { wire: w, missing: new Set(missing), size })
    rt.pendingBytes += size
    for (const p of missing) {
      const s = rt.waits.get(p) ?? new Set<string>()
      s.add(id)
      rt.waits.set(p, s)
    }
    while (
      rt.pending.size > SERVER.pendingEvents ||
      (rt.pendingBytes > SERVER.pendingBytes && rt.pending.size > 1)
    )
      this.unpark(rt, rt.pending.keys().next().value as string)
  }

  private unpark(rt: Rt, id: string) {
    const p = rt.pending.get(id)
    if (!p) return
    rt.pending.delete(id)
    rt.pendingBytes -= p.size
    for (const m of p.missing) {
      const s = rt.waits.get(m)
      s?.delete(id)
      if (s && !s.size) rt.waits.delete(m)
    }
  }

  // Events that waited on `id` and now have every ACL parent: decided in turn.
  private async release(room: string, id: string, now: number) {
    const rt = this.ensureRt(room)
    const queue = [id]
    const added: Inserted[] = []
    while (queue.length) {
      const p = queue.shift() as string
      const ws = [...(rt.waits.get(p) ?? [])]
      rt.waits.delete(p)
      for (const c of ws) {
        const x = rt.pending.get(c)
        if (!x) continue
        x.missing.delete(p)
        if (x.missing.size) continue
        this.unpark(rt, c)
        const res = await this.decide(room, c, x.wire, now)
        if (res.status === 'new') {
          added.push(res)
          queue.push(c)
        }
      }
    }
    if (added.length) {
      void this.stored(room, added).catch(() => {})
      this.sync.announce(room)
    }
  }

  // Decides an event whose ACL parents are all held, and stores it if admitted.
  private async decide(
    room: string,
    id: string,
    w: WireV2,
    now: number,
    retried = false
  ): Promise<Inserted> {
    const rt = this.ensureRt(room)
    if (w.ev.L === 'c' && (await this.contentFull(room, w))) {
      const why = (await this.deps.store.room(room))?.fullWhy ?? 'events'
      if ((await this.purgeForSpace(room)) > 0) return this.decide(room, id, w, now)
      return { status: 'full', why }
    }
    let out: Received
    let delta = null
    if (w.ev.L === 'a') ({ out, delta } = await this.host.acl(room, id, w, now))
    else out = await this.host.content(room, id, w, now)
    switch (out.s) {
      case 'M':
        return { status: 'invalid', why: 'auth' }
      case 'R':
        return this.reject(room, id, out.why)
      case 'P': {
        // Parents stored here that the evaluator doesn't hold (it lost the room): load it again.
        const stored = await getEvents(this.db, room, out.missing)
        if (!retried && stored.length === out.missing.length) {
          await this.reload(room)
          return this.decide(room, id, w, now, true)
        }
        this.park(room, id, w, out.missing)
        return { status: 'quota' }
      }
      case 'H':
        return this.hold(room, id, w)
    }
    let res
    try {
      res = await insertServer(this.db, room, id, w, now, {
        me: this.me,
        ...(out.s === 'A' ? { aseq: out.aseq, acl: out.rec } : {}),
        unknown: out.s === 'U',
        roomCap: this.deps.roomCap,
        roomBytes: this.deps.roomBytes,
        serverCap: this.deps.serverCap,
        serverBytes: this.deps.serverBytes,
      })
    } catch (e) {
      // The evaluator took it and the page's copy missed its delta: both start again from what
      // is stored.
      if (out.s === 'A' || out.s === 'U') await this.reload(room)
      throw e
    }
    if (res.status !== 'new' && res.status !== 'dup' && (out.s === 'A' || out.s === 'U'))
      await this.reload(room)
    if (res.status === 'stale') return { status: 'quota' }
    if (res.status !== 'new') return res
    const cached = this.rooms.get(room)
    if (cached && cached.lastSeq < res.rec.seq)
      this.rooms.set(room, { ...cached, lastSeq: res.rec.seq })
    if (w.ev.L === 'a') {
      await this.learnFrom(res.rec)
      const to = w.c?.to
      if (w.ev.t === 'add' && w.ev.a !== this.me && to !== this.me && !isOwner(rt.sum, w.ev.a))
        rt.vouch.set(id, w.ev.a)
      if (delta) await this.applyDelta(room, delta)
    } else {
      await this.purgeRedacted(room, res.rec)
      if (this.rooms.get(room)?.bans?.[w.ev.a]?.purged) await this.purge(room, [w.ev.a], [res.rec])
    }
    return res
  }

  // A redaction by its target's author that counts (visible, positioned after its target: the
  // evaluator decides) purges the target here at once (spec 4.3). Asked when the redaction or the
  // target arrives, whichever comes last.
  private async purgeRedacted(room: string, rec: EventRecord) {
    const ids =
      rec.type === 'redact'
        ? rec.target
          ? [rec.target]
          : []
        : (await this.db.getAllFromIndex('events', 'room_target', [room, rec.id])).some(
              x => x.type === 'redact' && x.sender === rec.sender
            )
          ? [rec.id]
          : []
    if (!ids.length) return
    const [sh] = await this.host.display(room, ids)
    const by = sh?.hidden?.why === 'redacted' ? sh.hidden.by : null
    const r = by ? await this.db.get('events', by) : undefined
    const t = await this.db.get('events', ids[0])
    if (!r || !t || r.sender !== t.sender) return
    const freed = await stripServer(this.db, room, t.id, t.sender)
    if (freed.length) {
      const mine = t.sender === this.me
      void this.deps.dms.blobs
        .release(freed, x => !mine || x.room !== room || x.sender === this.me)
        .catch(() => {})
    }
  }

  // The page's copy takes a delta from the evaluator; what follows from it runs for the members
  // it changed, and the cache is written soon after.
  private async applyDelta(room: string, delta: SumDelta) {
    const rt = this.ensureRt(room)
    const before = rt.sum
    rt.sum = applySummary(rt.sum, delta)
    this.saveSoon(room)
    await this.afterState(room, before, [
      ...Object.keys(delta.put?.members ?? {}),
      ...(delta.del?.members ?? []),
    ])
  }

  private saving = new Set<string>()

  private saveSoon(room: string) {
    if (this.saving.has(room)) return
    this.saving.add(room)
    this.clock.set(() => {
      this.saving.delete(room)
      if (this.rooms.has(room)) void this.saveCache(room).catch(() => {})
    }, SAVE_MS)
  }

  private async contentFull(room: string, w: WireV2) {
    const r = await this.deps.store.room(room)
    if (!r) return true
    const size = sizeOfWire(w)
    const meta = this.db
    const total = ((await meta.get('meta', SERVER_TOTAL)) as number | undefined) ?? 0
    const bytes = ((await meta.get('meta', SERVER_TOTAL_BYTES)) as number | undefined) ?? 0
    return (
      r.count >= (this.deps.roomCap ?? DAG.roomCap) ||
      total >= (this.deps.serverCap ?? DAG.serverCap) ||
      (r.bytes ?? 0) + size > (this.deps.roomBytes ?? DAG.roomBytes) ||
      bytes + size > (this.deps.serverBytes ?? DAG.serverBytes)
    )
  }

  // The hold store (spec 2.1): admitted, dated more than 5 minutes ahead of our clock; kept
  // until our clock reaches it, at most SERVER.heldPerDevice per device.
  private hold(room: string, id: string, w: WireV2): Inserted {
    const rt = this.ensureRt(room)
    const n = [...rt.held.values()].filter(h => h.wire.ev.dev === w.ev.dev).length
    if (n < SERVER.heldPerDevice) rt.held.set(id, { wire: w, due: w.ev.ts - 5 * 60_000 })
    return { status: 'quota' }
  }

  // The vouching mark (see Rt.vouch).
  private vouch(room: string, rt: Rt, now: number) {
    if (this.myMembership(room) !== 'join' || this.readOnly(room)) return
    if (now - rt.vouchedAt < VOUCH.roomMs) return
    const s = rt.sum
    const live = [...rt.vouch].filter(([add, by]) => {
      const to = Object.entries(s.members).find(([, m]) => m.adds?.includes(add))
      return !!to && membershipOf(s, by) === 'join'
    })
    rt.vouch = new Map(live)
    const due = live.filter(
      ([, by]) => now - (this.vouchedBy.get(by) ?? -Infinity) >= VOUCH.inviterMs
    )
    if (!due.length) return
    rt.vouchedAt = now
    for (const [add, by] of due) {
      this.vouchedBy.set(by, now)
      rt.vouch.delete(add)
    }
    void this.emit(room, 'mark', () => ({})).catch(() => {})
  }

  // Whether someone else put `ik` out of a room we are in (a kick or a ban).
  private removed(room: string, ik: string) {
    if (this.myMembership(room) !== 'join') return false
    const m = memberOf(this.sumOf(room), ik)
    return !!m && m.by !== undefined && m.by !== ik && (m.m === 'leave' || m.m === 'ban')
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

  // Someone we no longer serve hears why: the removal someone else made. Nothing else of the
  // room goes to them.
  private tellRemoved(s: Session, room: string) {
    const ik = s.remote?.ik
    if (!ik) return
    const m = memberOf(this.sumOf(room), ik)
    if (!m?.rem || m.by === ik || (m.m !== 'leave' && m.m !== 'ban')) return
    void this.db.get('events', m.rem).then(rec => {
      if (rec) void s.send({ t: 'gmember', room, ev: rec.wire }).catch(() => {})
    })
  }

  private async onMember(m: Message, s: Session) {
    const room = m.room
    if (typeof room !== 'string' || !this.rooms.has(room)) return
    const ev = (m.ev as { ev?: { t?: unknown } } | null)?.ev
    const c = (m.ev as { c?: { to?: unknown } } | null)?.c
    if ((ev?.t !== 'kick' && ev?.t !== 'ban') || c?.to !== this.me) return s.strike()
    const v = await this.check(room, m.ev)
    if (!v.ok) {
      if (!v.later) s.strike()
      return
    }
    await this.insert(room, v.id, v.wire, this.clock.now()).catch(() => {})
  }

  // Devices and profiles from introductions (genesis, join, device_add).
  private async learnFrom(rec: EventRecord) {
    const w = serverWire(rec)
    const c = w.c
    if (!c || !['genesis', 'join', 'device_add'].includes(w.ev.t)) return
    const ik = w.ev.a
    if (!isKeyId(ik) || ik === this.me) return
    const certs = verifyCert(c.cert, ik) ? [c.cert as Cert] : []
    const profile = verifyProfile(c.profile, ik) ? (c.profile as Profile) : null
    if (certs.length || profile) await this.learn(ik, certs, [], profile)
    if (c.binding !== undefined) this.deps.node.heardBinding(ik, c.binding)
  }

  // Counts, pings and alerts for stored messages that show, and files.
  private async stored(room: string, added: Inserted[]) {
    const r = this.rooms.get(room)
    const s = this.sumOf(room)
    const since = r?.since ?? Infinity
    if (r?.joining) {
      if (r.joining.ev) void this.locked(room, () => this.takeInvite(room)).catch(() => {})
      this.maybeJoin(room)
    }
    const news = added.flatMap(a =>
      a.status === 'new' && a.rec.layer === 'c' && a.rec.sender !== this.me ? [a.rec] : []
    )
    for (const a of added)
      if (a.status === 'new' && a.rec.type === 'redact' && a.freed.length) {
        const mine = a.rec.sender === this.me
        void this.deps.dms.blobs
          .release(a.freed, x => !mine || x.room !== room || x.sender === this.me)
          .catch(() => {})
      }
    if (!news.length) return this.changed(room)
    const shown = await this.host.display(
      room,
      news.map(x => x.id)
    )
    const counts: Record<string, import('./db').ChanCounts> = {}
    const arrivals: ServerArrival[] = []
    for (let i = 0; i < news.length; i++) {
      const rec = news[i]
      const sh = shown[i]
      if (!sh || sh.hidden) continue
      const c = serverWire(rec).c
      let ch: string | null = null
      let ping: ServerArrival['ping'] = null
      let unread = false
      if (rec.type === 'msg' && c && rec.chan) {
        ch = rec.chan
        unread = true
        const m = c as unknown as MsgContent
        this.gossip.stopTyping(room, ch, rec.sender)
        if (!m.fwd && m.mentions?.includes(this.me)) ping = 'mention'
        else if (m.everyone && sh.everyone) ping = 'everyone'
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
      if (!ch || rec.effTs < since || membershipOf(s, this.me) !== 'join') continue
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

  // ----- Serving (spec 3.6, 3.7) -----

  // What we serve a member: everything, only what belongs to their history (history `joined`),
  // only the ACL DAG (invited, or redeeming a code with us), or nothing.
  private gate(room: string, ik: string): 'all' | 'joined' | 'acl' | 'none' {
    const s = this.sumOf(room)
    const m = membershipOf(s, ik)
    if (m === 'invite') return 'acl'
    if (m !== 'join')
      return this.myMembership(room) === 'join' && this.redeeming(room, ik) ? 'acl' : 'none'
    return historyOf(s) === 'joined' ? 'joined' : 'all'
  }

  private async walk(
    link: Link,
    from: string[],
    have: string[],
    limit: number,
    bytes: number,
    state: boolean
  ): Promise<Walked> {
    const room = link.room
    const g = this.gate(room, link.ik)
    if (g === 'none') return { events: [], more: false, denied: true }
    if (state) {
      const ids = await this.host.diff(room, from, have, limit)
      const recs = await getEvents(this.db, room, ids)
      const out: EventRecord[] = []
      let size = 0
      for (const r of recs) {
        const n = JSON.stringify(r.wire).length
        if (out.length > 0 && size + n > bytes) return { events: out, more: true }
        size += n
        out.push(r)
      }
      return { events: out, more: ids.length >= limit }
    }
    if (g === 'acl') return { events: [], more: false, denied: true }
    return this.walkContent(link, from, have, limit, bytes, g === 'joined')
  }

  // Content back over `prev` from `from`, stopping at what the peer has; under history `joined`
  // only what belongs to its history (the walk goes on past the rest).
  private async walkContent(
    link: Link,
    from: string[],
    have: string[],
    limit: number,
    bytes: number,
    joined: boolean
  ): Promise<Walked> {
    const room = link.room
    const stop = new Set(have)
    const seen = new Set<string>()
    const queue = from.filter(id => !stop.has(id))
    const picked: EventRecord[] = []
    let steps = 0
    let more = false
    while (queue.length) {
      if (picked.length >= limit || steps >= DAG.walk) {
        more = true
        break
      }
      const id = queue.shift() as string
      if (seen.has(id)) continue
      seen.add(id)
      steps += 1
      const r = await this.db.get('events', id)
      if (!r || r.room !== room || r.layer !== 'c') continue
      for (const p of serverWire(r).ev.prev ?? []) if (!stop.has(p) && !seen.has(p)) queue.push(p)
      if (r.purged) continue
      picked.push(r)
    }
    const ok = joined
      ? await this.host.history(
          room,
          link.ik,
          picked.map(r => r.id)
        )
      : picked.map(() => true)
    const out: EventRecord[] = []
    let size = 0
    for (let i = 0; i < picked.length; i++) {
      if (!ok[i]) continue
      const n = JSON.stringify(picked[i].wire).length
      if (out.length > 0 && size + n > bytes) {
        more = true
        break
      }
      size += n
      out.push(picked[i])
    }
    out.sort((a, b) => a.seq - b.seq)
    return { events: out, more }
  }

  private async getFor(link: Link, ids: string[]) {
    const g = this.gate(link.room, link.ik)
    if (g === 'none') return []
    const found = (await getEvents(this.db, link.room, ids)).filter(r => !r.purged)
    const acl = found.filter(r => r.layer !== 'c')
    const content = g === 'all' || g === 'joined' ? found.filter(r => r.layer === 'c') : []
    if (g !== 'joined') return [...acl, ...content]
    const ok = await this.host.history(
      link.room,
      link.ik,
      content.map(r => r.id)
    )
    return [...acl, ...content.filter((_r, i) => ok[i])]
  }

  // Our new events go out live to members who may have everything; members under history
  // `joined` pull content (the gate checks each one); invitees get the ACL.
  private pushable(link: Link, wire: Wire) {
    const g = this.gate(link.room, link.ik)
    if (g === 'all') return true
    if (g === 'none') return false
    return (wire as unknown as WireV2).ev.L === 'a'
  }

  // The file gate for server rooms: a joined member, a message they didn't write that carries
  // the file and shows, and (history `joined`) belongs to their history.
  async entitled(ik: string, h: string) {
    for (const r of await this.db.getAllFromIndex('events', 'att', h)) {
      if (r.redacted || r.sender === ik || !this.rooms.has(r.room)) continue
      const g = this.gate(r.room, ik)
      if (g !== 'all' && g !== 'joined') continue
      const [sh] = await this.host.display(r.room, [r.id])
      if (!sh || sh.hidden) continue
      if (g === 'all') return true
      const [ok] = await this.host.history(r.room, ik, [r.id])
      if (ok) return true
    }
    return false
  }

  // Who may have a file: joined members of the rooms where someone else's message carries it.
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

  // Builds, decides, stores and sends an event of ours, within the room's lock and the device's
  // signing lock. `make` writes the content from the plan (its parents, identity-chain position,
  // watermark). The device's chain is read from the store and checked again in the transaction
  // that stores the event.
  private emit(
    room: string,
    t: string,
    make: (plan: Plan) => Record<string, unknown>,
    opts: { L?: 'a' | 'c'; to?: string } = {}
  ) {
    return this.locked(room, () => this.emitNow(room, t, make, opts))
  }

  private async emitNow(
    room: string,
    t: string,
    make: (plan: Plan) => Record<string, unknown>,
    opts: { L?: 'a' | 'c'; to?: string } = {}
  ): Promise<string> {
    const author = await this.author()
    if (this.readOnly(room)) throw new ServerError(this.readOnly(room) as string)
    const rt = this.ensureRt(room)
    await rt.loading
    const dev = keyId(author.dk.pk)
    const L = opts.L ?? 'a'
    const chainNow = async () =>
      ((await this.db.get('meta', chainKey(room, dev))) as DevChain | undefined) ?? null
    return this.withDevice(dev, async () => {
      let chain = await chainNow()
      let plan = await this.host.plan(room, { t, L, a: this.me, dev, to: opts.to })
      if (!plan.ap.length) throw new ServerError('Unknown server')
      // Never sign from a position without this device's last ACL event (a room removed here
      // and joined again, a backfill under way): that would fork the device.
      if ((chain?.aprev ?? plan.aprev) !== plan.aprev) {
        if (chain?.aprev) rt.need.add(chain.aprev)
        throw new ServerError(SYNC_TEXT)
      }
      // W4 (spec 4.1): a mark at least every 500 content events of this device.
      if (L === 'c' && Math.max(chain?.seq ?? -1, plan.seq) + 1 - plan.aclSeq > 500) {
        const mp = await this.host.plan(room, { t: 'mark', L: 'a', a: this.me, dev })
        await this.emitOne(room, 'mark', {}, 'a', chain, mp)
        chain = await chainNow()
        plan = await this.host.plan(room, { t, L, a: this.me, dev, to: opts.to })
      }
      return this.emitOne(room, t, make(plan), L, chain, plan)
    })
  }

  private async emitOne(
    room: string,
    t: string,
    content: Record<string, unknown>,
    L: 'a' | 'c',
    chain: DevChain | null,
    plan: Plan
  ): Promise<string> {
    const author = await this.author()
    const now = this.clock.now()
    const seq = Math.max(chain?.seq ?? -1, plan.seq) + 1
    const fields: ChainFields = { seq, ap: plan.ap }
    if (L === 'a') {
      if (plan.aprev !== undefined) fields.aprev = plan.aprev
      if (plan.iprev !== undefined) fields.iprev = plan.iprev
    } else {
      const rec = await this.deps.store.room(room)
      fields.prev = (rec?.heads ?? []).map(h => h.id).slice(0, EV.prev)
      if (chain?.cprev !== undefined) fields.cprev = chain.cprev
    }
    const ts = Math.max(now, plan.ts)
    const { id, wire } = buildEvent2(author, room, t, L, content, fields, ts)
    let out: Received
    let delta = null
    if (L === 'a') ({ out, delta } = await this.host.acl(room, id, wire, ts))
    else out = await this.host.content(room, id, wire, ts)
    if (out.s === 'R')
      throw new ServerError(WINDOW_REASONS.includes(out.why) ? TOO_OFTEN_TEXT : CANT_TEXT)
    if (out.s !== 'A' && out.s !== 'C') throw new ServerError(CANT_TEXT)
    let res
    try {
      res = await insertServer(this.db, room, id, wire, now, {
        me: this.me,
        chain,
        ...(out.s === 'A' ? { aseq: out.aseq, acl: out.rec } : {}),
        roomCap: this.deps.roomCap,
        roomBytes: this.deps.roomBytes,
        serverCap: this.deps.serverCap,
        serverBytes: this.deps.serverBytes,
      })
    } catch (e) {
      await this.reload(room)
      if (!isQuotaError(e)) throw e
      this.storageFull = true
      throw new ServerError(STORAGE_FULL_TEXT)
    }
    if (res.status !== 'new') {
      // The evaluator took it but it isn't stored: start again from what is.
      await this.reload(room)
      if (res.status === 'full') throw new ServerError(this.deps.dms.fullText(res.why))
      throw new ServerError("Couldn't save that")
    }
    this.storageFull = false
    await this.db.put('outbox', { id, room, created: now, deliveredTo: [] })
    const cached = this.rooms.get(room)
    if (cached && cached.lastSeq < res.rec.seq)
      this.rooms.set(room, { ...cached, lastSeq: res.rec.seq })
    if (delta) await this.applyDelta(room, delta)
    if (L === 'c') await this.purgeRedacted(room, res.rec)
    this.sync.push(room, id, wire as unknown as Wire)
    this.sync.announce(room)
    this.changed(room)
    return id
  }

  // Reloads a room's evaluator from what is stored (after a failed store).
  private async reload(room: string) {
    const r = await this.deps.store.room(room)
    if (r) await this.load(r)
  }

  // A new server (spec 3.8): its owners are fixed in its genesis. With co-owners it takes two
  // rounds over a session with each (they agreed with allowCoOwner): the creator assembles the
  // whole genesis content without the owners' device certificates, naming each co-owner's
  // device of that session, and sends it; each co-owner checks it and returns its certificate
  // over the digest of that content (binding.ts genesisDigest); the creator adds them and signs.
  // Then a #general channel and the settings.
  async create(name: string, coOwners: string[] = []): Promise<string> {
    const author = await this.author()
    const clean = name.trim().slice(0, 100) || 'P2P server'
    const dk = keyId(author.dk.pk)
    const sessions = coOwners.map(ik => {
      const s = this.deps.node.readySessions(ik).find(x => x.remote?.ik === ik)
      if (!s?.remote) throw new ServerError('Every co-owner must be online')
      return s
    })
    const owners = [
      { ik: this.me, dk },
      ...sessions.map(s => ({ ik: s.remote!.ik, dk: s.remote!.dk })),
    ]
    const bare: Record<string, unknown> = {
      rules: RULES_VERSION,
      nonce: b64u(randomBytes(16)),
      owners,
      everyone_bits: EVERYONE_BITS,
      name: clean,
      cert: this.deps.node.cert,
      profile: this.deps.node.profile,
    }
    const binding = this.deps.node.binding
    if (binding) bare.binding = binding
    const dcerts = [genesisBundle(author.ik, dk, bare).dcert]
    for (const s of sessions) dcerts.push(await this.askBundle(s, bare))
    const content = { ...bare, owners: owners.map((o, i) => ({ ...o, dcert: dcerts[i] })) }
    const now = this.clock.now()
    const { id: room, wire } = buildEvent2(author, null, 'genesis', 'a', content, { seq: 0 }, now)
    await this.putRoom({
      ...blankRoom(room, '', now),
      kind: 'server',
      name: clean,
      chans: {},
      server: null,
      since: now,
    })
    await this.locked(room, async () => {
      const res = await this.withDevice(dk, () => this.take(room, room, wire, now))
      if (res.status !== 'new') throw new ServerError("Couldn't create the server")
      await this.db.put('outbox', { id: room, room, created: now, deliveredTo: [] })
    })
    const general = newShortId()
    await this.emit(room, 'channel', () => ({ id: general, name: 'general', kind: 'text', pos: 0 }))
    await this.emit(room, 'settings', () => ({
      name: clean,
      history: 'shared',
      system: { ch: general, join: true, leave: true },
    }))
    return room
  }

  // We agree to be listed as a co-owner of a server `ik` creates (asked from the UI).
  allowCoOwner(ik: string, on = true) {
    if (on) this.coOwnerOk.add(ik)
    else this.coOwnerOk.delete(ik)
  }

  // Round two with one co-owner: the genesis content without certificates goes out, its device
  // certificate over that content's digest comes back.
  private async askBundle(s: Session, g: Record<string, unknown>) {
    const r = s.remote!
    const reply = await this.request(s, { t: 'gbundle', room: g.nonce as string, g })
    const dcert = (reply?.b as { dcert?: unknown } | undefined)?.dcert
    if (typeof dcert !== 'string' || !deviceCertOk(r.ik, genesisSrv(g), r.ik, r.dk, '', dcert))
      throw new ServerError(`${this.nameOf(r.ik)} didn't agree to be a co-owner`)
    return dcert
  }

  // A contact we agreed to co-own a server with sends its genesis content: we sign our device's
  // certificate over its digest if it is a genesis of rules we know, by that contact, with no
  // certificates yet, listing us once with this device.
  private onBundle(m: Message, s: Session) {
    const from = s.remote?.ik
    const g = m.g
    if (!from || !isRecord(g) || bytesOf(g.nonce, 16) === null || typeof m.room !== 'string')
      return s.strike()
    const author = this.deps.node.author()
    const dk = author ? keyId(author.dk.pk) : ''
    const owners = Array.isArray(g.owners) ? g.owners : []
    const ok =
      !!author &&
      this.coOwnerOk.has(from) &&
      this.deps.node.contact(from)?.state === 'mutual' &&
      m.room === g.nonce &&
      g.rules === RULES_VERSION &&
      aclContentOk('genesis', g) &&
      sizeOf(g) <= LIMITS2.aclContent &&
      owners.every(o => isRecord(o) && o.dcert === undefined) &&
      owners.some(o => isRecord(o) && o.ik === from) &&
      owners.filter(o => isRecord(o) && o.ik === this.me).length === 1 &&
      owners.some(o => isRecord(o) && o.ik === this.me && o.dk === dk)
    const b = ok && author ? { dcert: genesisBundle(author.ik, dk, g).dcert } : null
    void s.send({ t: 'gbundled', room: m.room, ok: !!b, ...(b ? { b } : {}) }).catch(() => {})
  }

  private settings(room: string, patch: Record<string, unknown>) {
    return this.emit(room, 'settings', () => {
      const cur = { ...(this.sumOf(room).settings ?? {}) } as Record<string, unknown>
      return { ...cur, ...patch }
    })
  }

  setName(room: string, name: string, color?: number | null) {
    const patch: Record<string, unknown> = { name: name.trim().slice(0, 100) }
    if (typeof color === 'number') patch.color = color
    return this.settings(room, patch)
  }

  setHistory(room: string, vis: HistoryVis) {
    return this.settings(room, { history: vis })
  }

  setSystem(room: string, sys: SystemContent) {
    return this.settings(room, { system: sys })
  }

  addChannel(room: string, name: string) {
    const pos = Math.max(-1, ...channelsOf(this.sumOf(room)).map(c => c.pos)) + 1
    const id = newShortId()
    return this.emit(room, 'channel', () => ({
      id,
      name: name.trim().slice(0, 100),
      kind: 'text',
      pos,
    })).then(() => id)
  }

  editChannel(room: string, id: string, patch: { name?: string; topic?: string; gone?: true }) {
    const cur = channelOf(this.sumOf(room), id)
    if (!cur) throw new ServerError('Unknown channel')
    const next: Record<string, unknown> = { ...cur, ...patch, id }
    if (patch.name !== undefined) next.name = patch.name.trim().slice(0, 100)
    if (next.topic === '') delete next.topic
    return this.emit(room, 'channel', () => next)
  }

  // Kicking someone invited withdraws the invite.
  kick(room: string, ik: string) {
    if (membershipOf(this.sumOf(room), ik) === 'invite')
      return this.emit(room, 'uninvite', () => ({ to: ik }))
    return this.emit(room, 'kick', plan => ({ to: ik, seen: plan.seen ?? {} }), { to: ik })
  }

  ban(room: string, ik: string, reason?: string) {
    return this.emit(
      room,
      'ban',
      plan => ({
        to: ik,
        seen: plan.seen ?? {},
        ...(reason ? { reason: reason.slice(0, STATE_LIMITS.reason) } : {}),
      }),
      { to: ik }
    )
  }

  unban(room: string, ik: string) {
    return this.emit(room, 'unban', () => ({ to: ik }))
  }

  async leave(room: string) {
    const m = this.myMembership(room)
    if (m === 'join') await this.emit(room, 'leave', plan => ({ seen: plan.seen ?? {} }))
    else this.gossip.leave(room)
    await this.updateRoom(room, cur => ({ ...cur, joining: null }))
    this.changed(room)
  }

  // Removes a server we are not in any more from this device. Our device's chain there is kept,
  // so if we join again we go on from it (starting over would fork it).
  async forget(room: string) {
    const m = this.myMembership(room)
    if ((m === 'join' || m === 'invite') && !this.readOnly(room))
      throw new ServerError('Leave the server first')
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
      for (const p of (r.wire.ev as { prev?: string[] }).prev ?? [])
        await tx.objectStore('children').delete([p, r.id])
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
    await tx.objectStore('rooms').delete(room)
    await tx.done
    this.rooms.delete(room)
    this.rts.delete(room)
    this.host.drop(room)
    this.changed(room)
  }

  // ----- Invite codes -----

  async issueCode(room: string, ttl: number, label = '') {
    const s = this.sumOf(room)
    if (this.myMembership(room) !== 'join') throw new ServerError('Join the server first')
    if (!can(s, this.me, P.Invite)) throw new ServerError("You can't invite people here")
    const now = this.clock.now()
    // At the cap of live codes, our own expired ones are revoked to make room.
    if (!can(s, this.me, P.ManageServer)) {
      const mine = Object.entries(s.codes).filter(([, c]) => c.a === this.me)
      const old = mine
        .filter(([, c]) => (c.exp ?? Infinity) <= now)
        .slice(0, Math.max(0, mine.length - STATE_LIMITS.codesPerMember + 1))
      for (const [id] of old) await this.emit(room, 'code_revoke', () => ({ code: id }))
      if (mine.length - old.length >= STATE_LIMITS.codesPerMember)
        throw new ServerError('Revoke one of your invites first')
    }
    const secret = b64u(randomBytes(16))
    const hash = codeHash(secret)
    const exp = now + ttl
    const clean = label.trim().slice(0, STATE_LIMITS.label)
    await this.emit(room, 'code', () => ({ h: hash, exp, ...(clean ? { label: clean } : {}) }))
    const rec: CodeRecord = { hash, room, secret, exp, label: clean, created: now }
    await this.db.put('codes', rec)
    return this.codeText(room, secret)
  }

  // The code string: the room, its name, the secret, and the peer ids of up to 4 members who
  // can let people in (us first). No identities, addresses or anything else.
  codeText(room: string, secret: string) {
    const s = this.sumOf(room)
    const peers = [this.deps.node.peerId]
    for (const ik of this.joinedOthers(room)) {
      if (peers.length >= SERVER.codePeers) break
      if (!can(s, ik, P.Invite)) continue
      const d = this.deps.node.anyDevicesOf(ik)
      const cert = d ? liveCerts(d.certs, d.revocations)[0] : undefined
      if (cert) peers.push(peerId(cert.dk))
    }
    return encodeCode({
      v: 1,
      room,
      name: nameOf(s)?.name ?? 'P2P server',
      secret,
      peers,
    })
  }

  // The live code with this hash (codes are named by their event id, spec 1.4).
  private codeByHash(room: string, hash: string) {
    for (const [id, c] of Object.entries(this.sumOf(room).codes))
      if (c.h === hash) return { id, ...c }
    return null
  }

  async revokeCode(room: string, hash: string) {
    const cur = this.codeByHash(room, hash)
    if (!cur) throw new ServerError('Unknown invite')
    await this.emit(room, 'code_revoke', () => ({ code: cur.id }))
  }

  // Live codes of a room, with the code string for those we issued here.
  async codes(room: string) {
    const s = this.sumOf(room)
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
    for (const c of Object.values(s.codes)) {
      const rec = mine.get(c.h)
      mine.delete(c.h)
      out.push({
        hash: c.h,
        exp: c.exp ?? rec?.exp ?? 0,
        revoked: false,
        label: c.label ?? rec?.label ?? '',
        by: c.a,
        text: rec ? this.codeText(room, rec.secret) : null,
      })
    }
    // Ours that are no longer live: revoked, or dead with our right to invite.
    for (const rec of mine.values())
      out.push({
        hash: rec.hash,
        exp: rec.exp,
        revoked: true,
        label: rec.label,
        by: this.me,
        text: null,
      })
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
        // The invite they posted for us: it enters the room once we hold what it sits on.
        if (isRecord(reply.ev)) {
          const ev = reply.ev as unknown as WireV2
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

  // The invite an admitting member posted for us: through the pending store, so it is decided
  // once we hold its ACL parents; our join follows (afterState).
  private async takeInvite(room: string) {
    const r = this.rooms.get(room)
    const wire = r?.joining?.ev
    if (!wire) return
    const m = this.myMembership(room)
    if (m !== 'invite' && m !== 'join') {
      const v = await this.check(room, wire)
      if (v.ok) await this.take(room, v.id, wire, this.clock.now())
    }
    await this.updateRoom(room, cur =>
      cur.joining?.ev ? { ...cur, joining: { at: cur.joining.at, via: cur.joining.via } } : null
    )
  }

  // Someone redeems a code with us: we check it by our own clock and, if it holds, post an
  // invite for them that names the code (spec 8.1), send it to them and let them sync the ACL for
  // a while. The invite is withdrawn if they don't join by then (lapseRedeems).
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
    const st = this.sumOf(room)
    if (this.myMembership(room) !== 'join' || !can(st, this.me, P.Invite) || this.readOnly(room))
      return answer(false, 'unknown')
    const hash = codeHash(m.secret as string)
    const code = this.codeByHash(room, hash)
    if (!code) {
      const rec = await this.db.get('codes', hash)
      return answer(false, rec && rec.room === room ? 'revoked' : 'unknown')
    }
    const now = this.clock.now()
    if ((code.exp ?? Infinity) <= now) return answer(false, 'expired')
    const cur = membershipOf(st, r.ik)
    if (cur === 'ban') return answer(false, 'banned')
    if (cur === 'join') {
      this.prefer(room, r.ik)
      return answer(true)
    }
    const map = this.redeemersOf(room)
    if (!map.has(r.ik)) {
      const perCode = [...map.values()].filter(x => x.code === code.id).length
      if (perCode >= SERVER.redeemsPerCode || map.size >= SERVER.redeemsPerRoom)
        return answer(false, 'busy')
    }
    let add = memberOf(st, r.ik)?.adds?.[0]
    if (cur !== 'invite') {
      try {
        add = await this.emit(room, 'add', () => ({ to: r.ik, code: code.id }))
      } catch {
        return answer(false, 'unknown')
      }
    }
    const ev = add ? (await this.db.get('events', add))?.wire : undefined
    if (!map.has(r.ik) && add) map.set(r.ik, { code: code.id, until: now + SERVER.redeemTtl, add })
    this.redeemers.set(room, map)
    this.prefer(room, r.ik)
    answer(true, undefined, ev)
  }

  // ----- Direct invites -----

  // Invites a mutual contact; they see it under "P2P server invites" when they are online.
  async invite(room: string, ik: string) {
    const c = this.deps.node.contact(ik)
    if (!c || c.state !== 'mutual') throw new ServerError('Only mutual contacts can be invited')
    const cur = membershipOf(this.sumOf(room), ik)
    if (cur === 'join') throw new ServerError('Already a member')
    if (cur === 'ban') throw new ServerError('This contact is banned from the server')
    if (cur !== 'invite') await this.emit(room, 'add', () => ({ to: ik }))
    for (const s of this.deps.node.readySessions(ik)) this.sendInvite(s, room)
  }

  private sendInvite(s: Session, room: string) {
    const m = memberOf(this.sumOf(room), s.remote?.ik ?? '')
    const add = m?.m === 'invite' ? m.adds?.[0] : undefined
    if (!add) return
    void this.db.get('events', add).then(rec => {
      if (!rec) return
      void s
        .send({
          t: 'ginvite',
          room,
          name: nameOf(this.sumOf(room))?.name ?? 'P2P server',
          ev: rec.wire,
        })
        .catch(() => {})
    })
  }

  // A contact comes online: they hear about invites they haven't answered.
  private offerInvites(s: Session) {
    const ik = s.remote?.ik
    if (!ik || this.deps.node.contact(ik)?.state !== 'mutual') return
    for (const room of this.rooms.keys())
      if (this.myMembership(room) === 'join' && membershipOf(this.sumOf(room), ik) === 'invite')
        this.sendInvite(s, room)
  }

  private async onInvite(m: Message, s: Session) {
    const from = s.remote?.ik
    const room = m.room
    if (!from || typeof room !== 'string' || typeof m.name !== 'string') return s.strike()
    // Only from mutual contacts: nobody else can put rows in our list.
    if (this.deps.node.contact(from)?.state !== 'mutual') return
    const v = validate2(m.ev, room)
    if (!v.ok) return s.strike()
    const ev = v.wire.ev
    if (ev.t !== 'add' || v.wire.c?.to !== this.me || ev.a !== from) return s.strike()
    const cur = this.rooms.get(room)
    if (cur && (cur.joining || this.myMembership(room) === 'join')) return
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
      joining: { at: now, via: 'invite', ev: cur.invite?.wire },
      since: now,
    }))
    this.ensureRt(room).joinPosted = false
    this.prefer(room, from)
    void this.locked(room, () => this.takeInvite(room)).catch(() => {})
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
    const s = this.sumOf(room)
    for (const m of membersOf(s)) {
      if (m.m !== 'join' || m.ik === this.me) continue
      const c = this.deps.node.contact(m.ik)
      const names = [
        c?.petname,
        c?.name,
        this.idents.get(m.ik)?.profile?.name,
        typeof m.profile?.name === 'string' ? m.profile.name : undefined,
      ]
      out.push({ ik: m.ik, names: [...new Set(names.filter((n): n is string => !!n))] })
    }
    return out
  }

  private content(room: string, t: string, c: Record<string, unknown>) {
    return this.emit(room, t, () => c, { L: 'c' })
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
      if (MENTION_EVERYONE.test(msg.body) && can(this.sumOf(room), this.me, P.MentionEveryone))
        content.everyone = true
    }
    return this.content(room, 'msg', content as unknown as Record<string, unknown>)
  }

  private async message(room: string, target: string) {
    const r = await this.db.get('events', target)
    if (!r || r.room !== room || r.type !== 'msg' || !r.chan)
      throw new ServerError('Message not found')
    return r
  }

  async edit(room: string, target: string, body: string) {
    const r = await this.message(room, target)
    if (r.sender !== this.me || (serverWire(r).c as MsgContent | null)?.fwd)
      throw new ServerError("You can't edit this message")
    return this.content(room, 'edit', { target, body, ch: r.chan })
  }

  async redact(room: string, target: string) {
    const r = await this.db.get('events', target)
    if (!r || r.room !== room || r.layer !== 'c' || !r.chan)
      throw new ServerError("You can't delete this message")
    const s = this.sumOf(room)
    if (
      r.sender !== this.me &&
      !isOwner(s, this.me) &&
      !(can(s, this.me, P.ManageMessages) && outranks(s, this.me, r.sender))
    )
      throw new ServerError("You can't delete this message")
    const id = await this.content(room, 'redact', { target, ch: r.chan })
    this.sync.redactWaiting(room, target)
    const o = await this.db.get('outbox', target)
    if (o?.failed) await this.db.delete('outbox', target)
    return id
  }

  async react(room: string, target: string, key: string, on: boolean) {
    const r = await this.message(room, target)
    return this.content(room, 'react', { target, key, on, ch: r.chan })
  }

  async pin(room: string, target: string, on: boolean) {
    const r = await this.message(room, target)
    if (!can(this.sumOf(room), this.me, P.ManageMessages))
      throw new ServerError('Only the owner can pin messages')
    if (on && r.chan) {
      const pins = await this.loadPins(room, r.chan)
      if (pins.length >= PINS_MAX) throw new ServerError(`You can pin up to ${PINS_MAX} messages`)
    }
    return this.content(room, 'pin', { target, on, ch: r.chan })
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

  // Pings marked read one by one (the inbox): off the channel's counter, the read position stays.
  async unping(room: string, ch: string, n: number) {
    await this.updateRoom(room, cur => {
      const old = cur.chans?.[ch]
      if (!old?.pings) return null
      return {
        ...cur,
        chans: { ...cur.chans, [ch]: { ...old, pings: Math.max(0, old.pings - n) } },
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
    const s = this.sumOf(room)
    const online = this.gossip.online(room)
    const owners = s.owners
    const meRank = memberOf(s, this.me)?.rank
    const members: MemberView[] = membersOf(s)
      .filter(m => m.m === 'join' || m.m === 'invite' || m.m === 'ban')
      .map(m => ({
        ik: m.ik,
        m: m.m,
        name: this.nameOf(m.ik, room),
        owner: owners.includes(m.ik),
        online: m.m === 'join' && online.has(m.ik),
        contact: this.deps.node.contact(m.ik)?.state === 'mutual',
        below: !!meRank && gt(meRank, m.rank as Rank),
      }))
    const joined = members.filter(m => m.m === 'join')
    const n = nameOf(s)
    const readOnly = this.readOnly(room)
    const me = readOnly ? null : membershipOf(s, this.me)
    return {
      id: room,
      name: n?.name ?? r.name ?? 'P2P server',
      color: n?.color ?? null,
      me,
      joining: !!r.joining,
      owner: s.creator,
      owners,
      perms: me === 'join' ? permsOf(s, this.me) : 0,
      history: historyOf(s),
      system: systemOf(s),
      channels: readOnly ? [] : channelsOf(s),
      members: readOnly ? [] : members,
      online: joined.filter(m => m.online).length,
      joined: joined.length,
      chans: r.chans ?? {},
      seq: r.lastSeq,
      gap: r.missing.length > 0 || (this.rt(room)?.waits.size ?? 0) > 0,
      full: r.full,
      readOnly,
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
    if (this.readOnly(room)) return { messages: [], more: false }
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
    const sys = systemOf(this.sumOf(room))
    if (sys.ch === ch && (sys.join || sys.leave)) {
      const lo = more ? page[0]?.sortKey : opts.after
      rows.push(...(await this.systemRows(room, lo, opts.before, sys)))
      rows.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0))
    }
    return { messages: rows, more }
  }

  // Join and leave lines from ACL events in a sort key range: the genesis (its creator) and a live
  // join, an effective leave, kick or ban.
  private async systemRows(
    room: string,
    lo: string | undefined,
    hi: string | undefined,
    sys: { join: boolean; leave: boolean }
  ) {
    const kinds = [
      ...(sys.join ? ['genesis', 'join'] : []),
      ...(sys.leave ? ['leave', 'kick', 'ban'] : []),
    ]
    const recs: EventRecord[] = []
    for (const t of kinds)
      recs.push(
        ...(await this.db.getAllFromIndex(
          'events',
          'room_type_sort',
          IDBKeyRange.bound([room, t, lo ?? ''], [room, t, hi ?? '￿'], !!lo, !!hi)
        ))
      )
    if (!recs.length) return []
    const ids = recs.map(r => r.id)
    const shown = await this.host.display(room, ids)
    // A server that shows joiners only what came after them shows no lines from before either.
    const mine =
      historyOf(this.sumOf(room)) === 'joined'
        ? await this.host.history(room, this.me, ids)
        : ids.map(() => true)
    const out: P2pMessage[] = []
    recs.forEach((rec, i) => {
      if (!shown[i] || shown[i]?.hidden || !mine[i]) return
      const c = serverWire(rec).c
      const ik = rec.type === 'kick' || rec.type === 'ban' ? (c?.to as string) : rec.sender
      if (typeof ik !== 'string') return
      out.push({
        id: rec.id,
        sender: ik,
        ts: rec.effTs,
        sentTs: serverWire(rec).ev.ts,
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
        system: { kind: rec.type === 'join' || rec.type === 'genesis' ? 'join' : 'leave', ik },
      })
    })
    return out
  }

  // Message rows: what shows, with its last edit, its reactions and its pin (spec 3.5).
  private async rows(room: string, recs: EventRecord[]) {
    if (!recs.length) return []
    const box = new Map<string, OutboxRecord>(
      (await this.db.getAllFromIndex('outbox', 'room', room)).map(o => [o.id, o])
    )
    const shown = await this.host.display(
      room,
      recs.map(r => r.id)
    )
    const out: P2pMessage[] = []
    const replies = new Map<string, Shown | null>()
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i]
      const sh = shown[i]
      const c = serverWire(r).c as MsgContent | null
      // Not decided here yet (our own message on its way in), or hidden.
      if (!sh || sh.hidden || !c || r.redacted) continue
      const edit = sh.edit && !c.fwd ? await this.db.get('events', sh.edit) : undefined
      const reacts = (await getEvents(
        this.db,
        room,
        sh.reactions.map(x => x.id)
      )) as EventRecord[]
      const pin = sh.pin ? await this.db.get('events', sh.pin.id) : undefined
      let reply: P2pMessage['reply'] = null
      if (c.reply) {
        const t = await this.db.get('events', c.reply)
        let ts = replies.get(c.reply)
        if (ts === undefined && t && t.room === room) {
          ts = (await this.host.display(room, [t.id]))[0]
          replies.set(c.reply, ts)
        }
        const tc = t && t.room === room ? (serverWire(t).c as MsgContent | null) : null
        const gone = !t || !tc || t.redacted || !ts || !!ts.hidden
        const tedit = !gone && ts?.edit ? await this.db.get('events', ts.edit) : undefined
        reply = {
          id: c.reply,
          sender: t?.room === room ? t.sender : null,
          body: gone
            ? null
            : tedit
              ? String((serverWire(tedit).c as { body?: unknown } | null)?.body ?? '')
              : (tc as MsgContent).body,
        }
      }
      const o = box.get(r.id)
      const pending = r.sender === this.me && !!o && o.deliveredTo.length === 0
      out.push({
        id: r.id,
        sender: r.sender,
        ts: r.effTs,
        sentTs: serverWire(r).ev.ts,
        sortKey: r.sortKey,
        seq: r.seq,
        body: edit ? String((serverWire(edit).c as { body?: unknown } | null)?.body ?? '') : c.body,
        reply,
        mentions: c.fwd ? [] : (c.mentions ?? []),
        fwd: c.fwd ?? null,
        att: c.att ?? [],
        edited: edit ? edit.effTs : null,
        reactions: reactionsOf(reacts, this.me),
        pinned: sh.pin?.on && pin ? pin.effTs : null,
        late: r.sender !== this.me && r.receivedAt - r.effTs > EV.lateMs,
        pending,
        failed: pending && !!o?.failed,
        call: null,
        everyone: c.everyone === true && sh.everyone,
      })
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

  // Pinned messages of a channel, newest pin first (spec 3.5: the latest visible pin by someone
  // with Manage messages in its admission state decides).
  async loadPins(room: string, ch: string) {
    const seen = new Set<string>()
    const targets: string[] = []
    let steps = 0
    let cursor = await this.db
      .transaction('events')
      .store.index('room_type_sort')
      .openCursor(IDBKeyRange.bound([room, 'pin', ''], [room, 'pin', '￿']), 'prev')
    while (cursor && steps < DAG.walk) {
      const p = cursor.value
      steps += 1
      if (p.target && p.chan === ch && !seen.has(p.target)) {
        seen.add(p.target)
        targets.push(p.target)
      }
      cursor = await cursor.continue()
    }
    if (!targets.length) return []
    const shown = await this.host.display(room, targets)
    const on = targets.filter((_t, i) => shown[i]?.pin?.on && !shown[i]?.hidden)
    const recs = (await getEvents(this.db, room, on.slice(0, PINS_MAX))).filter(
      r => r.type === 'msg' && r.chan === ch
    )
    return this.rows(room, recs)
  }

  // Whether a channel id is one of the room's live text channels.
  isChannel(room: string, ch: string) {
    if (!isShortId(ch)) return false
    const c = channelOf(this.sumOf(room), ch)
    return !!c && (c.kind === undefined || c.kind === 'text')
  }

  // The admission record of a stored ACL event (tests).
  async recordOf(id: string): Promise<PackedRec | null> {
    return (await this.db.get('events', id))?.acl ?? null
  }

  // Server events held for later (tests): pending (waiting for ACL parents) and held (dated ahead).
  waiting(room: string) {
    const rt = this.rt(room)
    return { pending: rt?.pending.size ?? 0, held: rt?.held.size ?? 0, unknown: UNKNOWN }
  }
}
