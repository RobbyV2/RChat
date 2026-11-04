import { isRecord } from '../../bytes'
import { deviceCertOk, genesisBundle, genesisSrv, signDeviceCert2 } from '../acl/binding'
import { aclContentOk, gt, RULES_VERSION } from '../acl/rules'
import type { ContentEv } from '../acl/visibility'
import {
  applySummary,
  emptySummary,
  fromStored,
  sameSummary,
  SUM_SHAPE,
  toStored,
  type SumDelta,
  type Summary,
} from '../acl/summary'
import {
  IMPL,
  trimContent,
  type AclItem,
  type Carried,
  type PackedRec,
  type Plan,
  type Received,
} from '../acl_room'
import { b64u, bytesOf, randomBytes } from '../canonical'
import {
  blankRoom,
  cacheKey,
  chainKey,
  contentCounts,
  countOf,
  moveCounts,
  DAG,
  dropServer,
  getEvents,
  unindexAll,
  insertServer,
  evictionOrder,
  oldestBodies,
  purgeServer,
  resetHeld,
  restoreBody,
  SERVER_TOTAL_BYTES,
  storedSize,
  withinShareNow,
  type DevChain,
  type Inserted,
} from '../dag'
import {
  serverWire,
  type ChanCounts,
  type EventRecord,
  type IdentRecord,
  type P2pDatabase,
  type RoomRecord,
  type ServerCache,
} from '../db'
import type { PageOpts } from '../jump'
import {
  buildEvent2,
  claimedId2,
  signRevocation2,
  contentEvOf,
  headerOk,
  LIMITS as EV,
  LIMITS2,
  shownReaction,
  sizeOf,
  validate2,
  type Attachment,
  type ChainFields,
  type Fwd,
  type MsgContent,
  type Wire,
  type WireV2,
} from '../event'
import {
  CANT_TEXT,
  CONFLICT_TEXT,
  CO_OWNERS_MAX_TEXT,
  TOO_BIG_TEXT,
  reachedBy,
  TRANSFERRED_TEXT,
  CUT_MS,
  cutOut,
  VOUCH_WAIT_TEXT,
  refusalText,
  syncedSince,
  TOO_OFTEN_TEXT,
  type HeadsReport,
  type Reached,
} from '../flows'
import type { Message } from '../frames'
import { memberBindingDue } from '../badge'
import { Gossip, type LinkKind } from '../gossip'
import {
  isKeyId,
  keyId,
  verifyCert,
  verifyProfile,
  liveCerts,
  type Cert,
  type Profile,
} from '../keys'
import { mergeCerts, mergeRevocations, displayName } from '../contacts'
import { AGREED, LOCAL } from '../limits'
import { LocalHost, WorkerHost, type AclHost, type WorkerLike } from '../resolve_host'
import { realClock, type Clock, type Session } from '../session'
import {
  can,
  chanFactsOf,
  channelOf,
  channelPermsOf,
  channelsOf,
  historyOf,
  isOwner,
  knownChannel,
  knownSettings,
  LIMITS as STATE_LIMITS,
  memberOf,
  membershipOf,
  membersOf,
  MOD_BITS,
  nameOf,
  P,
  rankOf,
  roleRank,
  type HistoryVis,
  type SystemContent,
} from '../state'
import { isQuotaError, Sync, type Check, type Link, type Walked } from '../sync'
import { indexEstimate, rebuildStep, SEARCH, unindexRoom } from '../search'
import { Voice } from '../voice'
import { dmRoomId, MOVED_TEXT, MOVING_TEXT, STORAGE_FULL_TEXT, type P2pMessage } from '../dm'
import type { ServerCtx } from './context'
import {
  SERVER,
  VOUCH,
  JOIN_WAIT,
  SAVE_MS,
  BAD_CODE,
  LEGACY_TEXT,
  UPDATE_TEXT,
  SYNC_TEXT,
  ServerError,
  newShortId,
  EVERYONE_BITS,
  webLocks,
  sizeOfWire,
  SETTLE_MS,
  ARCHIVE_LINKS,
  SETTLE_RESAMPLE,
  ROLE_NAME_MAX,
  NO_ROOM_TEXT,
  newRolePos,
  type ServerArrival,
  type SearchQuery,
  type ServerView,
  type Rt,
  type Redeemer,
  type ServerDeps,
  type EmitOpts,
  type Migrated,
  type LostRoom,
  type ChannelPatch,
} from './types'
import * as views from './views'
import * as search from './search'
import * as messages from './messages'
import * as transfer from './transfer'
import * as codes from './codes'
import * as devices from './devices'

export {
  SERVER,
  VOUCH,
  CODE_PREFIX,
  CODE_TTLS,
  NEEDS_INVITER,
  NOBODY_ONLINE,
  BAD_CODE,
  REDEEM_TEXT,
  LEGACY_TEXT,
  UPDATE_TEXT,
  SYNC_TEXT,
  OLD_GONE_TEXT,
  ServerError,
  encodeCode,
  parseCode,
  codeHash,
  newShortId,
  EVERYONE_BITS,
  THREAD_ROOT_TEXT,
  PIN_TEXT,
  PIN_THREAD_TEXT,
  ROLE_NAME_MAX,
  ROLE_STEP,
  NO_ROOM_TEXT,
  newRolePos,
} from './types'
export type {
  InviteCode,
  ServerArrival,
  SearchQuery,
  SearchHit,
  MemberView,
  RoleView,
  ChannelView,
  ModView,
  ReachedView,
  ServerView,
  ServerDeps,
  Migrated,
  LostRoom,
  ChannelPatch,
} from './types'

export { CANT_TEXT, TOO_OFTEN_TEXT }

// The facade as its modules see it (server/context.ts).
const ctx = (s: Servers) => s as unknown as ServerCtx

export class Servers {
  readonly sync: Sync
  readonly gossip: Gossip
  readonly voice: Voice
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
  // Contacts we agreed to be listed as co-owner by, for a server they are creating, and those who
  // asked and wait for an answer.
  private coAsks = new Map<
    string,
    { from: string; name: string; room: string; g: Record<string, unknown>; s: Session }
  >()
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
              new Worker(new URL('../p2p.worker.ts', import.meta.url), {
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
      onHeads: link => this.heard(link),
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
      members: room => this.linkCandidates(room),
      may: (room, ik) => this.may(room, ik),
      budget: room => (this.archived(room) ? ARCHIVE_LINKS : null),
      needs: (room, ik) => {
        const next = this.archived(room) ? this.rooms.get(room)?.next : undefined
        const m = next ? membershipOf(this.sumOf(next), ik) : 'join'
        return m === null || m === 'invite'
      },
      shared: ik => this.sharedWith(ik),
      moderator: (room, ik) => can(this.sumOf(room), ik, MOD_BITS),
      sessions: ik => node.readySessions(ik),
      certs: ik => {
        const d = node.anyDevicesOf(ik)
        return d ? { ik, certs: liveCerts(d.certs, d.revocations) } : null
      },
      link: (s, room) => {
        const l = this.sync.link(s, room)
        // A peer that may hold bodies we want back.
        const rt = this.rt(room)
        if (l && (rt?.want.size || rt?.viewed.size))
          this.sync.fetch(room, [...new Set([...rt.want, ...rt.viewed])])
        return l
      },
      unlink: (s, room) => this.sync.unlink(s, room),
      links: room => this.sync.linksOf(room),
      linksOn: s => this.sync.linksOn(s),
      refused: (s, room) => this.tellRemoved(s, room),
      dialing: ik => node.isDialing(ik),
      dialable: ik => node.canDial(ik),
      idle: s => this.idle(s),
      onTick: () => this.tick(),
      channel: (room, ch) => this.isChannel(room, ch),
      sees: (room, ch, ik) => (channelPermsOf(this.sumOf(room), ik, ch) & P.ViewChannel) !== 0,
      settled: (room, ik) =>
        this.myMembership(room) === 'join' && membershipOf(this.sumOf(room), ik) === 'join',
      onPresence: room => this.changed(room),
      onTyping: room => this.typingChanged(room),
      limits: deps.gossip,
    })
    this.voice = new Voice({
      clock: this.clock,
      me: () => node.ik,
      sessions: room => node.allReady().filter(s => this.voiceMember(room, s.remote?.ik)),
      links: room =>
        this.sync
          .linksOf(room)
          .filter(l => this.voiceMember(room, l.ik))
          .map(l => l.session),
      sessionsOf: ik => node.readySessions(ik),
      member: (room, ik) => this.voiceMember(room, ik),
      isVoice: (room, ch) => this.isVoiceChannel(room, ch),
      device: (room, ik, dk) => memberOf(this.sumOf(room), ik)?.devs.includes(dk) === true,
      signer: () => {
        const a = node.author()
        return a ? { dk: keyId(a.dk.pk), sk: a.dk.sk } : null
      },
      allowed: (room, ch, ik) => this.voiceAllowed(room, ch, ik),
      certs: ik => {
        const d = node.anyDevicesOf(ik)
        return d ? { ik, certs: liveCerts(d.certs, d.revocations) } : null
      },
      onChange: room => this.changed(room),
      wake: () => node.schedule(),
      limits: deps.voice,
    })
    node.use({
      attach: s => {
        this.sync.attach(s)
        this.gossip.attach(s)
        this.voice.attach(s)
        s.on('gredeem', m => this.onRedeem(m, s))
        s.on('gredeemed', m => this.onRedeemed(m, s))
        s.on('ginvite', m => this.onInvite(m, s))
        s.on('gmember', m => this.onMember(m, s))
        s.on('gbundle', m => this.onBundle(m, s))
        s.on('gbundled', m => this.onRedeemed(m, s))
        s.on('gxfer', m => this.onTransfer(m, s, 'take'))
        s.on('gxfered', m => this.onRedeemed(m, s))
        s.on('gcosign', m => this.onTransfer(m, s, 'cosign'))
        s.on('gcosigned', m => this.onRedeemed(m, s))
      },
      ready: s => {
        this.gossip.ready(s)
        this.voice.ready(s)
        this.offerInvites(s)
        this.farewell(s)
      },
      targets: () => this.gossip.targets(),
      urgent: () => this.voice.targets(),
      keep: s => this.voice.keeps(s.remote?.ik, s.remote?.dk),
      wanted: (ik, hello) => this.wantedPeer(ik, hello),
      member: ik => this.coMember(ik),
      learn: (ik, certs, revs, profile) => void this.learn(ik, certs, revs, profile),
      devices: ik => {
        const r = this.idents.get(ik)
        return r ? { certs: r.certs, revocations: r.revocations } : null
      },
      owner: dk => {
        for (const r of this.idents.values()) if (r.certs.some(c => c.dk === dk)) return r.ik
        return null
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
    this.started = true
    this.gossip.start()
    this.voice.start()
    for (const id of this.rooms.keys()) void this.refreshMe(id).catch(() => {})
    this.indexing = this.indexPass()
    // Spec 3.8: a new copy loaded before its old one is checked and carried again now.
    for (const r of this.rooms.values()) {
      if (r.prev) void this.checkMigrated(r.id, r.prev).catch(() => {})
      if (r.carry && r.carry.state !== 'done' && r.carry.state !== 'failed')
        void this.carryOver(r.id).catch(() => {})
    }
  }

  // Every stored room is loaded.
  private started = false

  // Search index: built again from the stored events step by step until it is complete (the
  // first start on this schema, after an import).
  indexed = false
  indexing: Promise<void> = Promise.resolve()
  private stopped = false

  private async indexPass() {
    try {
      while (!this.stopped && !this.deps.store.closed) {
        if (await rebuildStep(this.db, SEARCH.step, room => this.readOnly(room) !== null)) {
          this.indexed = true
          return
        }
        await new Promise(r => setTimeout(r, 0))
      }
    } catch {
      // Storage went away.
    }
  }

  stop() {
    this.stopped = true
    this.voice.leave()
    this.voice.stop()
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
      if (rt?.mods.length) void this.runMods(r.id)
      if (!rt || r.legacy) continue
      const every = Object.keys(r.causes ?? {}).length ? SERVER.causesMs : Infinity
      if ((rt.storeDirty && now - rt.storeAt >= SERVER.storeMs) || now - rt.storeAt >= every) {
        rt.storeDirty = false
        rt.storeAt = now
        void this.locked(r.id, () => this.storePass(r.id)).catch(() => {})
      }
      // Bodies still wanted are asked for again while some are.
      if ((rt.want.size || rt.viewed.size) && now - rt.wantAt >= SERVER.causesMs) {
        rt.wantAt = now
        void this.locked(r.id, () => this.wantPass(r.id)).catch(() => {})
      }
      if (rt.proofs.size) this.postProofs(r.id, rt, now)
      if (rt.ackDue !== null && rt.ackDue <= now) this.ackRedactions(r.id, rt, now)
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
        storeDirty: true,
        storeAt: -Infinity,
        bodiless: new Set(),
        want: new Set(),
        wantAt: -Infinity,
        viewed: new Set(),
        evictFrom: new Map(),
        proofs: new Map(),
        proofed: new Map(),
        proofTimes: [],
        ackDue: null,
        ackAt: -Infinity,
        views: new Map(),
        mods: [],
        modsBusy: false,
        reports: new Map(),
        reached: [],
        reapply: [],
        joinWait: null,
        // Kept in the room record until this device is set up anew (its key changes).
        conflict: !!this.myDev() && this.rooms.get(room)?.conflict === this.myDev(),
        following: false,
        carrying: false,
        migrateDiff: null,
        carryAckAt: -Infinity,
        carryAckCount: null,
        carryDone: false,
        carryAcks: 0,
        carrySeen: null,
        carryAt: 0,
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

  // Nothing more can be signed here: read-only, or transferred to a new copy (only a leave).
  private frozen(room: string) {
    return !!this.readOnly(room) || this.sumOf(room).upgraded
  }

  // Rooms we sync: joined, invited, or on our way in.
  private activeRooms() {
    const out: string[] = []
    for (const r of this.rooms.values()) {
      if (r.legacy) continue
      const m = this.myMembership(r.id)
      if (m === 'join' || m === 'invite' || r.joining || this.outForNow(r)) out.push(r.id)
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
    // Following a transfer, on our way in: the old copy's members (spec 3.8), who may hold the
    // new one already.
    const r = this.rooms.get(room)
    if (r?.prev && r.joining && membershipOf(rt.sum, this.me) !== 'join')
      for (const m of membersOf(this.sumOf(r.prev)))
        if (m.m === 'join' && m.ik !== this.me && !list.includes(m.ik)) list.push(m.ik)
    rt.others = { sum: rt.sum, list }
    return list
  }

  // A joined member of the old copy of a new copy we follow (spec 3.8).
  private oldMember(r: RoomRecord, ik: string) {
    return !!r.prev && membershipOf(this.sumOf(r.prev), ik) === 'join'
  }

  // A new copy we joined lately (spec 3.8): we may still know few of its members.
  private settling(r: RoomRecord | undefined) {
    if (!r?.prev) return false
    const me = memberOf(this.sumOf(r.id), this.me)
    return me?.m === 'join' && this.clock.now() - (me.joinTs ?? 0) < SETTLE_MS
  }

  // Who a room links with: its joined members; a new copy we joined lately, the old copy's
  // members too that we don't know to be in or out here, who may hold it and tell us who is in.
  private linkCandidates(room: string) {
    const list = this.joinedOthers(room)
    const r = this.rooms.get(room)
    const rt = this.rt(room)
    if (!rt || !r?.prev || !this.settling(r)) return list
    const old = this.sumOf(r.prev)
    if (rt.candidates?.sum === rt.sum && rt.candidates.old === old) return rt.candidates.list
    const have = new Set(list)
    const extra = membersOf(old)
      .filter(m => m.m === 'join' && m.ik !== this.me && !have.has(m.ik))
      .filter(m => this.carriedHere(r, m.ik))
      .filter(m => {
        const here = membershipOf(rt.sum, m.ik)
        return here === null || here === 'invite'
      })
      .map(m => m.ik)
    const out = extra.length ? [...list, ...extra] : list
    rt.candidates = { sum: rt.sum, old, list: out }
    return out
  }

  // Whether the new copy `r` brings `ik` over (spec 3.8): its carry-over names them, or before
  // that is here, the old copy's members at the upgrade do. False while neither is known.
  private carriedHere(r: RoomRecord, ik: string) {
    if (!r.prev || !this.oldMember(r, ik)) return false
    const named = this.rt(r.id)?.carriedMembers
    if (named) return named.has(ik)
    const at = this.rt(r.prev)?.carried
    if (!at) return false
    at.set ??= new Set(at.s.members)
    return at.set.has(ik)
  }

  // An old copy whose new copy we are in (spec 3.8): it keeps a link or two, so members who were
  // away hear of the transfer, and takes no more of the session budget.
  private archived(room: string) {
    const next = this.rooms.get(room)?.next
    return !!next && this.sumOf(room).upgraded && this.myMembership(next) === 'join'
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
    // On our way in we have no state yet: whoever let us in is who we sync with (or, following a
    // transfer, any member of the old copy: the new owner links with a few at a time).
    if (r.joining && mine !== 'join' && (this.isPreferred(room, ik) || this.oldMember(r, ik)))
      return 'full'
    const m = membershipOf(s, ik)
    // Out by a cascade or by someone else's removal, lately: the ACL only, with members, so we
    // learn of an invite back, or of the removal being undone.
    if ((mine === 'leave' || mine === 'ban') && !r.joining && this.outForNow(r))
      return m === 'join' ? 'state' : false
    if (mine !== 'join' && mine !== 'invite' && !r.joining) return false
    if (m === 'join') return 'full'
    if (m === 'invite') return 'state'
    // A member of the old copy this one doesn't know yet (spec 3.8): the state, so who is in
    // spreads from those who hold it; only one the carry-over names (before it is here, the
    // upgrade's member list).
    if (m === null && (mine === 'join' || mine === 'invite') && this.carriedHere(r, ik))
      return 'state'
    // Cut out by a cascade: they get the ACL, so they learn it (and of an invite back).
    if (mine === 'join' && cutOut(s, ik, this.clock.now())) return 'state'
    return mine === 'join' && this.redeeming(room, ik) ? 'state' : false
  }

  // Out of a room by a cascade (no removal of ours) within the last week.
  private lostByCascade(r: RoomRecord) {
    return !!r.cascade && this.clock.now() - r.cascade < CUT_MS
  }

  // Out by a cascade, or by someone else's removal, within the last week.
  private outForNow(r: RoomRecord) {
    if (this.lostByCascade(r)) return true
    const m = memberOf(this.sumOf(r.id), this.me)
    return !!m?.rem && m.by !== this.me && this.clock.now() - (m.remTs ?? -Infinity) < CUT_MS
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
    for (const [ik, r] of map) {
      const m = membershipOf(s, ik)
      if (m === 'join') {
        // A real joiner: the code's limits are for invites nobody uses.
        const u = this.codeUseOf(room, r.code)
        u.lapses = 0
        const i = r.at === undefined ? -1 : u.adds.indexOf(r.at)
        if (i >= 0) u.adds.splice(i, 1)
      }
      if (m === 'join' || m === 'ban') map.delete(ik)
    }
    return map
  }

  // What each code made us post here (spec 4.1): invites not used yet, by our clock, and lapses in
  // a row.
  private codeUse = new Map<string, { adds: number[]; lapses: number; until: number }>()

  private codeUseOf(room: string, code: string) {
    const key = `${room}\n${code}`
    let u = this.codeUse.get(key)
    if (!u) this.codeUse.set(key, (u = { adds: [], lapses: 0, until: 0 }))
    return u
  }

  // Whether we take a code now: not paused here, and under its hourly invites.
  private codeOpen(room: string, code: string, now: number) {
    const u = this.codeUseOf(room, code)
    u.adds = u.adds.filter(t => now - t < 60 * 60_000)
    return u.until <= now && u.adds.length < SERVER.codeAddsPerHour
  }

  // Codes we stopped taking here, by hash.
  pausedCodes(room: string) {
    const now = this.clock.now()
    const out = new Set<string>()
    for (const [id, c] of Object.entries(this.sumOf(room).codes))
      if ((this.codeUse.get(`${room}\n${id}`)?.until ?? 0) > now) out.add(c.h)
    return out
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
      if (m?.m !== 'invite' || !m.adds?.includes(r.add)) continue
      const u = this.codeUseOf(room, r.code)
      if ((u.lapses += 1) >= SERVER.codeLapses) {
        u.until = now + SERVER.codePauseMs
        u.lapses = 0
        this.changed(room)
      }
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
      if (this.voice.keeps(ik, s.remote?.dk)) return
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
      if (typeof n === 'string' && n.trim())
        return Array.from(n).slice(0, LOCAL.server.memberNameMax).join('')
    }
    const p = this.idents.get(ik)?.profile
    if (p) return p.name
    return 'Member'
  }

  // The name someone gives themselves (their profile), never our petname for them: what a
  // forward carries to others.
  profileName(ik: string, room?: string) {
    if (ik === this.me) return this.deps.node.name
    const n = room ? memberOf(this.sumOf(room), ik)?.profile?.name : undefined
    if (typeof n === 'string' && n.trim())
      return Array.from(n).slice(0, LOCAL.server.memberNameMax).join('')
    const c = this.deps.node.contact(ik)
    if (c?.name) return c.name
    return this.idents.get(ik)?.profile?.name || 'Member'
  }

  // ----- Loading -----

  // A room on start: what the cache says at once (when it is current), while the evaluator
  // rebuilds from the stored events and their admission records (no event is decided again
  // unless its record is missing).
  private async load(r: RoomRecord, records = true): Promise<void> {
    const rt = this.ensureRt(r.id)
    const legacy = async () => {
      if (!r.legacy) await this.updateRoom(r.id, cur => ({ ...cur, legacy: true }))
      rt.sum = emptySummary()
      this.changed(r.id)
    }
    if (r.legacy) return legacy()
    // Older builds kept the cache in the room record.
    const kept =
      ((await this.db.get('meta', cacheKey(r.id))) as ServerCache | undefined) ?? r.server
    const cached = kept?.impl === IMPL && kept.shape === SUM_SHAPE ? fromStored(kept.sum) : null
    if (cached && records) rt.sum = cached
    // Imported rows: the wire checks first (an import is trusted no more than a peer).
    const g = await this.db.get('events', r.id)
    const gr = g?.room === r.id ? serverWire(g).c?.rules : undefined
    const rules = typeof gr === 'number' ? gr : RULES_VERSION
    const bad: string[] = []
    const acl: (AclItem & { order: number })[] = []
    const contents: ContentEv[] = []
    const check: { id: string; w: WireV2 }[] = []
    const bodiless: string[] = []
    // Bodies evicted for space: wanted back only when viewed, after a start too.
    const evicted: string[] = []
    const held = new Set<string>()
    const imported: string[] = []
    const bodies = new Map<string, number>()
    let old = false
    // One record at a time: content goes to the evaluator trimmed to what it reads.
    rt.evictFrom.clear()
    rt.migrated = undefined
    const tx = this.db.transaction('events')
    const range = IDBKeyRange.bound([r.id, -Infinity], [r.id, Infinity])
    for (
      let cur = await tx.store.index('room_seq').openCursor(range);
      cur;
      cur = await cur.continue()
    ) {
      const x = cur.value
      if (x.wire.ev.v === 1) {
        old = true
        break
      }
      held.add(x.id)
      if (x.layer === 'c' && !x.purged && !x.redacted)
        bodies.set(x.sender, (bodies.get(x.sender) ?? 0) + storedSize(x.wire) + indexEstimate(x))
      const w = serverWire(x)
      if (x.imp) {
        imported.push(x.id)
        const v = x.id === r.id ? validate2(w, null) : validate2(w, r.id, rules)
        if (!v.ok || v.id !== x.id) {
          bad.push(x.id)
          continue
        }
      }
      if (x.layer === 'c' || w.ev.L === 'c') {
        if (x.imp) check.push({ id: x.id, w })
        else {
          // Without its body, it keeps its channel and target (the record's).
          const m = contentEvOf(x.id, w)
          if (m.c === null) {
            bodiless.push(x.id)
            if (x.evicted) evicted.push(x.id)
            if (x.chan !== undefined || x.target !== undefined)
              m.c = {
                ...(x.chan !== undefined ? { ch: x.chan } : {}),
                ...(x.target !== undefined ? { target: x.target } : {}),
              }
          }
          contents.push(trimContent(m))
        }
      } else
        acl.push({
          id: x.id,
          w,
          ...(records && x.acl ? { rec: x.acl } : {}),
          order: x.aseq ?? 1e15 + x.seq,
        })
    }
    await tx.done.catch(() => {})
    if (old) return legacy()
    // Dropped events whose header stays (spec 2.3): evidence, restored from their records. A
    // record of an event stored whole (a merged import) goes; an imported header must check out.
    const stale: string[] = []
    const checked: string[] = []
    for (const d of await this.db.getAllFromIndex('dropped', 'room', r.id)) {
      if (held.has(d.id) || (d.imp && d.hdr && !headerOk(d.id, d.hdr, r.id))) {
        stale.push(d.id)
        continue
      }
      if (d.imp) checked.push(d.id)
      if (d.layer === 'a' && d.hdr)
        acl.push({ id: d.id, w: d.hdr, rec: d.acl, hdr: true, order: d.aseq ?? 1e15 })
    }
    if (stale.length || checked.length) {
      const tx = this.db.transaction('dropped', 'readwrite')
      for (const id of stale) await tx.store.delete(id)
      for (const id of checked) {
        const d = await tx.store.get(id)
        if (d) {
          const { imp: _i, ...rest } = d
          await tx.store.put(rest)
        }
      }
      await tx.done
    }
    await resetHeld(this.db, r.id, bodies)
    acl.sort((a, b) => a.order - b.order)
    const run = (async () => {
      const out = await this.host.load(
        r.id,
        acl.map(({ order: _o, ...it }) => it),
        contents,
        check,
        bodiless,
        evicted
      )
      rt.bodiless = new Set(bodiless)
      rt.want.clear()
      rt.views.clear()
      rt.storeDirty = true
      const before = rt.sum
      rt.sum = applySummary(emptySummary(), out.delta)
      // A wrong restore shows in the state: the cache was written with these same events.
      if (
        records &&
        !out.mismatch &&
        cached &&
        kept?.count === rt.sum.count &&
        !sameSummary(cached, rt.sum)
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
      // Headers that can't be read any more: only their ids stay.
      if (out.lost.length) {
        const tx = this.db.transaction('dropped', 'readwrite')
        for (const id of out.lost) {
          const d = await tx.store.get(id)
          if (d) await tx.store.put({ id: d.id, room: d.room, layer: d.layer })
        }
        await tx.done
      }
      if (imported.length) {
        const tx = this.db.transaction('events', 'readwrite')
        for (const id of imported) {
          const e = await tx.store.get(id)
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
    const tx = this.db.transaction(['events', 'rooms', 'meta', 'search'], 'readwrite')
    const events = tx.objectStore('events')
    let n = 0
    let acl = 0
    let bytes = 0
    // Out of the index first, while everything is still stored.
    bytes += await unindexAll(tx.objectStore('search'), events, null, room, ids)
    for (const id of ids) {
      const e = await events.get(id)
      if (!e || e.room !== room) continue
      await events.delete(id)
      const k = countOf(e)
      n += k.n
      acl += k.acl
      bytes += storedSize(e.wire)
    }
    const rec = await tx.objectStore('rooms').get(room)
    if (rec)
      await tx
        .objectStore('rooms')
        .put(await moveCounts(tx.objectStore('meta'), rec, { n: -n, acl: -acl, bytes: -bytes }))
    await tx.done
  }

  private async saveCache(room: string) {
    const sum = this.sumOf(room)
    const cache: ServerCache = {
      impl: IMPL,
      shape: SUM_SHAPE,
      rules: sum.rules,
      count: sum.count,
      sum: toStored(sum),
    }
    await this.db.put('meta', cache, cacheKey(room))
    const n = nameOf(sum)?.name
    const r = this.rooms.get(room)
    if (r && (r.server || (n && n !== r.name)))
      await this.updateRoom(room, cur => ({ ...cur, server: null, ...(n ? { name: n } : {}) }))
  }

  // What a state change means here: we were let in, or put out.
  private async afterState(room: string, before: Summary, changed?: string[]) {
    const was = membershipOf(before, this.me)
    const now = this.myMembership(room)
    const r = this.rooms.get(room)
    this.maybeJoin(room)
    const rt = this.ensureRt(room)
    rt.storeDirty = true
    rt.views.clear()
    // A channel we may view now that we couldn't (spec 3.7): what peers held back can come.
    const seen = (s: Summary) => {
      const F = chanFactsOf(s)
      return channelsOf(s).filter(c => channelPermsOf(s, this.me, c.id, F) & P.ViewChannel)
    }
    const had = new Set(seen(before).map(c => c.id))
    const opened = seen(this.sumOf(room)).filter(c => !had.has(c.id))
    if (now === 'join' && opened.length) this.sync.retryGaps(room)
    // Its history that comes now isn't new to us: counted from here (stored).
    if (now === 'join' && was === 'join' && opened.length) {
      const at = this.clock.now()
      await this.updateRoom(room, cur => {
        const viewFrom = Object.assign(Object.create(null) as Record<string, number>, cur.viewFrom)
        for (const c of opened) viewFrom[c.id] = at
        return { ...cur, viewFrom }
      })
    }
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
    // A new copy (spec 3.8): links are drawn again soon, once we know more of who is in.
    if (now === 'join' && was !== 'join' && r?.prev)
      for (const ms of SETTLE_RESAMPLE) this.clock.set(() => this.gossip.resample(), ms)
    // Out without a removal of our own (a cascade took our join, spec 3.1): we keep syncing the
    // ACL with members, and join again by ourselves if someone invites us again (spec 8.2).
    if (
      was === 'join' &&
      now === 'leave' &&
      !mine?.rem &&
      r &&
      !r.cascade &&
      cutOut(this.sumOf(room), this.me, this.clock.now())
    )
      await this.updateRoom(room, cur => ({ ...cur, cascade: this.clock.now() }))
    // Only after a cascade this device saw and recently: any other invite waits for the user.
    const lost = this.rooms.get(room)
    if (
      now === 'invite' &&
      was !== 'invite' &&
      lost &&
      !lost.joining &&
      !lost.invite &&
      this.lostByCascade(lost)
    ) {
      await this.updateRoom(room, cur => ({
        ...cur,
        cascade: null,
        joining: { at: this.clock.now(), via: 'invite' },
      }))
      this.ensureRt(room).joinPosted = false
      this.maybeJoin(room)
    }
    if (now === 'join' && r?.cascade)
      await this.updateRoom(room, cur => ({ ...cur, cascade: null }))
    // Spec 3.8: an upgrade is followed; roles go to members who joined the new copy. What we
    // hold of the old copy then is its archive.
    if (this.sumOf(room).upgraded && !this.rooms.get(room)?.archive) await this.markArchive(room)
    if (this.sumOf(room).upgrades?.length) void this.follow(room).catch(() => {})
    if (r?.carry) void this.carryRoles(room).catch(() => {})
    if (r?.carry && r.carry.state !== 'done' && r.carry.state !== 'failed')
      void this.carryOver(room).catch(() => {})
    if (r?.prev) {
      await this.checkMigrated(room, r.prev)
      this.ackCarry(room, rt)
    }
    // Spec 3.9: evidence against this device stops it signing here.
    const dev = this.myDev()
    if (dev && this.sumOf(room).forks?.includes(dev)) this.conflicted(room)
    // Spec 9 rule 18 (I2): our denies the state doesn't count that we may still make.
    rt.reapply = now === 'join' && !this.frozen(room) ? await this.reapplyOf(room) : []
    // A change in an old copy can be one of ours the new copy didn't get (spec 3.8 step 7).
    const nx = this.rooms.get(room)?.next
    if (nx && this.rooms.has(nx) && this.myMembership(nx) === 'join' && !this.frozen(nx)) {
      this.ensureRt(nx).reapply = await this.reapplyOf(nx)
      this.changed(nx)
    }
    this.sync.announce(room)
    if (was === 'join' && now !== 'join') {
      this.gossip.leave(room)
      this.voice.forget(room)
      this.ensureRt(room).joinPosted = false
    }
    this.checkVoice(room)
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

  // ----- Storage (spec 2.3, 4.2, 4.3) -----

  // What the state and the held content let storage do now: drop what the ACL core names, purge
  // bodies whose cause is stable, ask for bodies that show again, and look for proofs to post.
  private async storePass(room: string) {
    if (!this.rooms.has(room) || this.sumOf(room).rules !== RULES_VERSION) return
    await this.dropPass(room)
    await this.purgePass(room, false)
    await this.wantPass(room)
    await this.proofPass(room)
  }

  private myDev() {
    const author = this.deps.node.author()
    return author ? keyId(author.dk.pk) : undefined
  }

  private async dropPass(room: string) {
    const d = await this.host.drops(room, this.myDev())
    if (!d.acl.length && !d.content.length) return
    let freed: string[]
    try {
      freed = await dropServer(this.db, room, d)
    } catch (e) {
      // The evaluator let go of what is still stored: it starts again from storage.
      await this.reload(room)
      throw e
    }
    const rt = this.ensureRt(room)
    for (const id of d.content) {
      rt.bodiless.delete(id)
      rt.want.delete(id)
    }
    await this.refreshRoom(room)
    if (d.delta) await this.applyDelta(room, d.delta)
    if (freed.length) void this.deps.dms.blobs.release([...new Set(freed)]).catch(() => {})
    this.changed(room)
  }

  private async refreshRoom(room: string) {
    const after = await this.deps.store.room(room)
    if (after) this.rooms.set(room, after)
  }

  // Spec 4.3: a hidden body goes when its cause is stable (S1 to S4; S4 is the time it has stood
  // here, kept per cause), or under `pressure` when S1 to S3 hold; a counted redaction by the
  // content's own author at once. Under pressure with nothing stable, every hidden body goes
  // (they can be fetched again), keeping its files as an eviction does. `only`: just these
  // content events. Returns how many went.
  private async purgePass(room: string, pressure: boolean, only?: string[]) {
    const p = await this.host.purgeable(room, only)
    const now = this.clock.now()
    const old = this.rooms.get(room)?.causes ?? {}
    const causes: Record<string, number> = only ? { ...old } : {}
    for (const id of [...p.live, ...p.causes.filter(c => c.kind !== 'self').map(c => c.id)])
      causes[id] = old[id] ?? now
    const keys = (x: Record<string, number>) => Object.keys(x).sort().join()
    if (keys(causes) !== keys(old)) await this.updateRoom(room, cur => ({ ...cur, causes }))
    const due = (c: (typeof p.causes)[number]) =>
      c.kind === 'self' || (c.stable && (pressure || now - causes[c.id] >= SERVER.purgeAfter))
    const ids = p.causes.filter(due).flatMap(c => c.ids)
    const n = await this.purge(room, ids)
    if (!pressure || p.causes.some(c => c.kind !== 'self' && due(c))) return n
    const rest = [...p.causes.filter(c => !due(c)).flatMap(c => c.ids), ...p.other]
    return n + (await this.purge(room, rest, false, true))
  }

  // Purges the bodies of `ids` and their authors' edits of them: each keeps only its header
  // (never served), its files go, and the room's space comes back. `evict`: bodies that show,
  // evicted for space, fetched again only when viewed. `keepFiles`: bodies that can be fetched
  // again free no file space the budget counts, so files of our own messages stay, and so does
  // every file we sent (our uploads), until we delete them.
  private async purge(room: string, ids: string[], evict = false, keepFiles = evict) {
    if (!ids.length) return 0
    const { done, freed, mine } = await purgeServer(this.db, room, ids, this.me, evict)
    if (!done.length) return 0
    const rt = this.ensureRt(room)
    for (const id of done) rt.bodiless.add(id)
    await this.host.bodies(room, done, false, evict)
    await this.refreshRoom(room)
    const blobs = this.deps.dms.blobs
    if (freed.length) void blobs.release([...new Set(freed)], undefined, keepFiles).catch(() => {})
    if (mine.length && !keepFiles)
      void blobs
        .release([...new Set(mine)], x => x.room !== room || x.sender === this.me)
        .catch(() => {})
    this.changed(room)
    return done.length
  }

  // Bodies that show again after a purge (a later event overturned their cause), and evicted ones
  // someone viewed: fetched by id from a peer that still holds them.
  private async wantPass(room: string) {
    const rt = this.ensureRt(room)
    rt.wantAt = this.clock.now()
    if (!rt.bodiless.size) return
    // Viewed bodies that no longer show aren't asked for any more.
    const viewed = [...rt.viewed]
    const still = await this.host.restorable(room, viewed, true)
    rt.viewed = new Set(viewed.filter((_id, i) => still[i]))
    const w = [...new Set([...(await this.host.wanted(room)), ...rt.viewed])]
    rt.want = new Set(w)
    if (w.length) {
      this.sync.fetch(room, w)
      this.changed(room)
    }
  }

  private async restoreBody(room: string, id: string, w: WireV2): Promise<Inserted> {
    // Room for it first: just its size, from bodies not fetched back lately.
    const full = await this.contentFull(room, w)
    if (full) await this.evictForSpace(room, sizeOfWire(w), full === 'total', true)
    const rec = await restoreBody(this.db, room, id, w, this.clock.now())
    const rt = this.ensureRt(room)
    if (!rec) return { status: 'dropped' }
    rt.evictFrom.delete(rec.sender)
    rt.bodiless.delete(id)
    rt.want.delete(id)
    rt.viewed.delete(id)
    // What waited on it (its author's edits) may be wanted now.
    rt.storeDirty = true
    await this.host.bodies(room, [id], true)
    await this.refreshRoom(room)
    this.changed(room)
    return { status: 'dup', rec }
  }

  // Proofs (spec 2.3, 4.1): evidence that lowers a device's fork point below an ACL event of it
  // is posted after a random delay, unless what arrived meanwhile already lowered it as far.
  private async proofPass(room: string) {
    const author = this.deps.node.author()
    if (!author || this.myMembership(room) !== 'join' || this.frozen(room)) return
    const rt = this.ensureRt(room)
    const now = this.clock.now()
    for (const c of await this.host.proofs(room, this.me, keyId(author.dk.pk))) {
      if ((rt.proofed.get(c.dev) ?? Infinity) <= c.f) continue
      const q = rt.proofs.get(c.dev)
      if (q && q.f <= c.f) continue
      const rand = this.deps.random ?? Math.random
      rt.proofs.set(c.dev, { f: c.f, due: now + Math.floor(rand() * SERVER.proofDelayMs) })
    }
  }

  private postProofs(room: string, rt: Rt, now: number) {
    rt.proofTimes = rt.proofTimes.filter(t => now - t < 60 * 60_000)
    for (const [dev, q] of rt.proofs) {
      if (q.due > now) continue
      if (rt.proofTimes.length >= SERVER.proofsPerHour) return
      rt.proofs.delete(dev)
      rt.proofTimes.push(now)
      void this.postProof(room, dev).catch(() => {})
    }
  }

  private async postProof(room: string, dev: string) {
    const author = this.deps.node.author()
    if (!author || this.myMembership(room) !== 'join' || this.frozen(room)) return
    const [c] = await this.host.proofs(room, this.me, keyId(author.dk.pk), [dev])
    if (!c) return
    // A side is a stored event's core, or a dropped event's header; either must check out.
    const side = async (id: string) => {
      const e = await this.db.get('events', id)
      const w = e?.room === room ? serverWire(e) : (await this.db.get('dropped', id))?.hdr
      const x = w ? { ev: w.ev, sig: w.sig } : null
      return x && headerOk(id, x, room) ? x : null
    }
    const x = await side(c.x)
    const y = await side(c.y)
    if (!x || !y) return
    await this.emit(room, 'proof', () => ({ x, y }))
    const rt = this.ensureRt(room)
    rt.proofed.set(dev, Math.min(rt.proofed.get(dev) ?? Infinity, c.f))
  }

  // A moderator's redaction we applied: a mark naming it within a minute, so it can be
  // acknowledged (spec 4.3 S2), at most one per room per SERVER.ackMs, and only while some
  // redaction still needs it (ackRedactions).
  private noteRedaction(room: string) {
    const rt = this.ensureRt(room)
    if (rt.ackDue !== null) return
    const rand = this.deps.random ?? Math.random
    const at = this.clock.now() + Math.floor(rand() * SERVER.ackDelayMs)
    rt.ackDue = Math.max(at, rt.ackAt + SERVER.ackMs)
  }

  // Controller ruling: a mark only names redactions not yet acknowledged that can still be
  // (at least 2 identities other than their authors, us among them); with none, no mark.
  private ackRedactions(room: string, rt: Rt, now: number) {
    rt.ackDue = null
    if (this.myMembership(room) !== 'join' || this.frozen(room)) return
    void this.locked(room, async () => {
      const ack = await this.host.acks(room, this.me)
      if (!ack.length) return
      rt.ackAt = now
      await this.emitNow(room, 'mark', () => ({ ack }))
    }).catch(() => {})
  }

  // Out of space (spec 4.2): purgeable bodies go first, then hidden ones that can be fetched
  // again, then the oldest bodies of the sender whose bodies take the most here (`total`: in
  // every server), until `size` more bytes fit, at least SERVER.evictBytes. Bodies fetched back
  // lately go only when nothing else can. `restore`: making room for a body fetched back, which
  // takes just its size and never one fetched back lately.
  private async evictForSpace(room: string, size: number, total: boolean, restore = false) {
    const n = await this.purgePass(room, true)
    if (n) return n
    const now = this.clock.now()
    const need = restore ? size : Math.max(size, SERVER.evictBytes)
    let late: { room: string; ids: string[] } | null = null
    for (const c of await evictionOrder(this.db, total ? null : room, this.me)) {
      const starts = this.ensureRt(c.room).evictFrom
      const walk = (from?: string) =>
        oldestBodies(this.db, c.room, c.ik, need, now, 500, {
          from,
          undelivered: c.ik === this.me,
        })
      const at = starts.get(c.ik)
      let got = await walk(at)
      // Nothing past where the last walk stopped: from the start once (a body stored since below
      // it).
      if (at !== undefined && !got.ids.length && !got.late.length) got = await walk()
      if (got.from !== undefined) starts.set(c.ik, got.from)
      if (got.ids.length) return this.purge(c.room, got.ids, true)
      if (!late && got.late.length) late = { room: c.room, ids: got.late }
    }
    return late && !restore ? this.purge(late.room, late.ids, true) : 0
  }

  private async postJoin(room: string) {
    const rt = this.ensureRt(room)
    if (rt.joinPosted) return
    rt.joinPosted = true
    try {
      await this.emit(room, 'join', plan => this.joinContent(room, plan))
      rt.joinWait = null
      await this.updateRoom(room, cur => ({
        ...cur,
        joining: null,
        since: cur.since ?? this.clock.now(),
      }))
      this.changed(room)
      this.deps.node.schedule()
    } catch (e) {
      rt.joinPosted = false
      // Spec 9 rule 14: the join waits for a third member's acknowledgement (shown, retried).
      const wait = e instanceof ServerError && e.message === VOUCH_WAIT_TEXT ? e.message : null
      if (wait !== rt.joinWait) {
        rt.joinWait = wait
        this.changed(room)
      }
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
    // Spec 3.9: a move or import makes a new device; the one it moved from is revoked with the
    // watermark of what we hold of it, so whatever it signs later doesn't count.
    const live = memberOf(this.sumOf(room), this.me)?.devs ?? []
    for (const old of this.deps.node.movedFrom())
      if (old !== dk && live.includes(old))
        await this.emit(
          room,
          'device_revoke',
          plan => {
            const seen = plan.seen?.[old] ?? -1
            return { ik: this.me, dk: old, seen, rec: signRevocation2(author.ik, room, old, seen) }
          },
          { to: old }
        )
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
    return this.locked(room, () => this.take(room, id, wire as unknown as WireV2, receivedAt, true))
  }

  // A peer's event (now, or released once its parents are here). Spec 3.9: one signed with this
  // device's key (checked by `check`), admitted and stored here, past this device's own chain:
  // another copy of this device (a profile restored from a backup) signs too.
  private async decidePeer(room: string, id: string, w: WireV2, now: number) {
    const mine = w.ev.a === this.me && w.ev.dev === this.myDev()
    const chain = mine
      ? ((await this.db.get('meta', chainKey(room, w.ev.dev))) as DevChain | undefined)
      : undefined
    const out = await this.decide(room, id, w, now)
    if (mine && out.status === 'new' && w.ev.seq > (chain?.seq ?? -1)) this.conflicted(room)
    return out
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
  private async take(
    room: string,
    id: string,
    w: WireV2,
    now: number,
    peer = false
  ): Promise<Inserted> {
    const rt = this.ensureRt(room)
    await rt.loading
    const have = await this.db.get('events', id)
    if (have) {
      // A purged body that shows again, fetched back (spec 4.3).
      if (
        have.purged &&
        (rt.want.has(id) || rt.viewed.has(id)) &&
        w.c !== null &&
        have.room === room
      ) {
        // Only while it still shows: what was hidden again stays purged.
        const [ok] = await this.host.restorable(room, [id], rt.viewed.has(id))
        if (ok) return this.restoreBody(room, id, w)
        rt.want.delete(id)
        rt.viewed.delete(id)
      }
      return { status: 'dup', rec: have }
    }
    // Dropped here (spec 2.3, 4.2): an ACL event is taken again only when something cites it.
    const gone = await this.db.get('dropped', id)
    if (gone?.room === room && !(gone.layer === 'a' && (rt.waits.has(id) || rt.need.has(id)))) {
      if ((await this.deps.store.room(room))?.missing.includes(id))
        await this.updateRoom(room, cur => ({ ...cur, missing: cur.missing.filter(m => m !== id) }))
      return { status: 'dropped' }
    }
    if (rt.rejected.has(id)) return { status: 'rejected', why: 'known' }
    const ap = w.ev.ap ?? []
    if (ap.some(p => rt.rejected.has(p))) return this.reject(room, id, 'parent')
    const missing: string[] = []
    for (const p of ap) if (!(await this.admittedHere(room, p))) missing.push(p)
    if (missing.length) {
      this.park(room, id, w, missing)
      return { status: 'quota' }
    }
    const res = peer ? await this.decidePeer(room, id, w, now) : await this.decide(room, id, w, now)
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
        const res = await this.decidePeer(room, c, x.wire, now)
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
    // Someone else's content past its share of the budgets (spec 4.2): not now, no strike.
    if (
      w.ev.L === 'c' &&
      w.ev.a !== this.me &&
      !(await withinShareNow(this.db, room, w.ev.a, sizeOfWire(w), now, this.caps()))
    )
      return { status: 'quota' }
    if (w.ev.L === 'c') {
      const full = await this.contentFull(room, w)
      if (full) {
        const why = (await this.deps.store.room(room))?.fullWhy ?? 'events'
        if ((await this.evictForSpace(room, sizeOfWire(w), full === 'total')) > 0)
          return this.decide(room, id, w, now)
        return { status: 'full', why }
      }
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
    // The evaluator took it but storage didn't: an ACL event (its state and the page's copy moved)
    // makes both start again from what is stored; content is let go of. An unknown-rules event
    // only counted.
    const undo = async () => {
      if (out.s === 'A') await this.reload(room)
      else if (out.s === 'C') await this.host.unhold(room, [id])
    }
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
      await undo()
      throw e
    }
    if (res.status !== 'new' && res.status !== 'dup') await undo()
    if (res.status === 'stale') return { status: 'quota' }
    if (res.status === 'rejected') return this.reject(room, id, res.why)
    if (res.status !== 'new') return res
    const cached = this.rooms.get(room)
    if (cached && cached.lastSeq < res.rec.seq)
      this.rooms.set(room, { ...cached, lastSeq: res.rec.seq })
    rt.storeDirty = true
    // Stored without its body (an edit of a message purged here).
    if (res.rec.purged) {
      rt.bodiless.add(id)
      await this.host.bodies(room, [id], false, !!res.rec.evicted)
    }
    if (w.ev.L === 'a') {
      if (w.ev.t === 'migrate') this.migrateArrived(rt)
      await this.db.delete('dropped', id)
      await this.learnFrom(res.rec)
      const to = w.c?.to
      if (w.ev.t === 'add' && w.ev.a !== this.me && to !== this.me && !isOwner(rt.sum, w.ev.a))
        rt.vouch.set(id, w.ev.a)
      if (delta) await this.applyDelta(room, delta)
    } else {
      this.evictBelow(room, res.rec)
      await this.purgeRedacted(room, res.rec)
    }
    return res
  }

  // A body stored below where its sender's eviction walk starts moves the start back.
  private evictBelow(room: string, rec: EventRecord) {
    const starts = this.ensureRt(room).evictFrom
    const at = starts.get(rec.sender)
    if (at !== undefined && rec.sortKey < at) starts.delete(rec.sender)
  }

  // Purges at arrival (spec 4.3): a counted redaction by its target's author strips the target at
  // once, asked when the redaction or the target arrives, whichever comes last (any such
  // redaction, whatever else came first); content of someone out of the server whose cause is
  // already due goes at once too. A moderator's redaction we applied gets acknowledged.
  private async purgeRedacted(room: string, rec: EventRecord) {
    const ids =
      rec.type === 'redact'
        ? rec.target
          ? [rec.target]
          : []
        : (await this.db.getAllFromIndex('events', 'room_target', [room, rec.id])).some(
              x => x.type === 'redact'
            )
          ? [rec.id]
          : []
    if (membershipOf(this.sumOf(room), rec.sender) !== 'join') ids.push(rec.id)
    if (ids.length) await this.purgePass(room, false, ids)
    if (rec.type === 'redact' && rec.target && rec.sender !== this.me) {
      const t = await this.db.get('events', rec.target)
      const [sh] = await this.host.display(room, [rec.target])
      if (t && t.sender !== rec.sender && sh?.hidden?.why === 'redacted' && sh.hidden.by === rec.id)
        this.noteRedaction(room)
    }
  }

  private caps() {
    return {
      roomCap: this.deps.roomCap,
      roomBytes: this.deps.roomBytes,
      serverCap: this.deps.serverCap,
      serverBytes: this.deps.serverBytes,
    }
  }

  // The page's copy takes a delta from the evaluator; what follows from it runs for the members
  // it changed, and the cache is written soon after.
  private async applyDelta(room: string, delta: SumDelta) {
    const rt = this.ensureRt(room)
    const before = rt.sum
    rt.sum = applySummary(rt.sum, delta)
    // Only removals of the last day, and not from an empty copy (a start without a cache).
    const reached = before.count ? reachedBy(before, rt.sum, this.me, this.clock.now()) : []
    if (reached.length) this.noteReached(rt, reached)
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

  // Whether content of `w`'s size fits: no ('room' or 'total', the budget it doesn't fit) or yes.
  private async contentFull(room: string, w: WireV2): Promise<'room' | 'total' | null> {
    const r = await this.deps.store.room(room)
    if (!r) return 'room'
    const size = sizeOfWire(w)
    const bytes = ((await this.db.get('meta', SERVER_TOTAL_BYTES)) as number | undefined) ?? 0
    const cc = await contentCounts({ get: k => this.db.get('meta', k) }, r)
    if (
      cc.room >= (this.deps.roomCap ?? DAG.roomCap) ||
      (r.bytes ?? 0) + size > (this.deps.roomBytes ?? DAG.roomBytes)
    )
      return 'room'
    if (
      cc.total >= (this.deps.serverCap ?? DAG.serverCap) ||
      bytes + size > (this.deps.serverBytes ?? DAG.serverBytes)
    )
      return 'total'
    return null
  }

  // The hold store (spec 2.1): admitted, dated more than 5 minutes ahead of our clock; kept
  // until our clock reaches it, at most SERVER.heldPerDevice per device.
  private hold(room: string, id: string, w: WireV2): Inserted {
    const rt = this.ensureRt(room)
    const n = [...rt.held.values()].filter(h => h.wire.ev.dev === w.ev.dev).length
    if (n < SERVER.heldPerDevice)
      rt.held.set(id, { wire: w, due: w.ev.ts - LOCAL.server.heldEarlyMs })
    return { status: 'quota' }
  }

  // The vouching mark (see Rt.vouch).
  private vouch(room: string, rt: Rt, now: number) {
    if (this.myMembership(room) !== 'join' || this.frozen(room)) return
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
    this.clock.set(() => {
      if (![...this.rooms.keys()].some(room => this.may(room, ik))) s.close('refused')
    }, 5_000)
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

  // A removal sent to us directly (it bypasses sync's pace): one per room per session, and only
  // while we are still in.
  private memberFrames = new WeakMap<Session, Set<string>>()

  private async onMember(m: Message, s: Session) {
    const room = m.room
    if (typeof room !== 'string' || !this.rooms.has(room)) return
    const ev = (m.ev as { ev?: { t?: unknown } } | null)?.ev
    const c = (m.ev as { c?: { to?: unknown } } | null)?.c
    if ((ev?.t !== 'kick' && ev?.t !== 'ban') || c?.to !== this.me) return s.strike()
    const seen = this.memberFrames.get(s) ?? new Set<string>()
    this.memberFrames.set(s, seen)
    const mine = this.myMembership(room)
    if (seen.has(room) || (mine !== 'join' && mine !== 'invite')) return
    seen.add(room)
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
    if (this.rt(room)?.mods.length) void this.runMods(room)
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
    // Spec 3.8: an old copy counts and announces nothing new (what shows of it is its archive).
    if (s.upgraded) return this.changed(room)
    const shown = await this.host.display(
      room,
      news.map(x => x.id)
    )
    const counts = new Map<string, ChanCounts>()
    const from = r?.viewFrom ?? {}
    const arrivals: ServerArrival[] = []
    let F: ReturnType<typeof chanFactsOf> | undefined
    for (let i = 0; i < news.length; i++) {
      const rec = news[i]
      const sh = shown[i]
      if (!sh || sh.hidden) continue
      const c = serverWire(rec).c
      let ch: string | null = null
      let ping: ServerArrival['ping'] = null
      let unread = false
      let thread: string | null = null
      if (rec.type === 'msg' && c && rec.chan) {
        ch = rec.chan
        // Thread replies aren't unread in the channel; their pings count, per thread too.
        thread = await this.rootOf(rec)
        unread = thread === null
        const m = c as unknown as MsgContent
        this.gossip.stopTyping(room, ch, rec.sender, thread)
        if (!m.fwd && m.mentions?.includes(this.me)) ping = 'mention'
        else if (m.everyone && sh.everyone) ping = 'everyone'
        else if (m.reply) {
          const t = await this.db.get('events', m.reply)
          if (t && t.room === room && t.type === 'msg' && t.sender === this.me) ping = 'reply'
        }
      } else if (rec.type === 'react' && c?.on === true && rec.target && shownReaction(c)) {
        const t = await this.db.get('events', rec.target)
        if (t && t.room === room && t.sender === this.me && t.chan) {
          ch = t.chan
          ping = 'reaction'
          thread = await this.rootOf(t)
        }
      }
      if (!ch || !(channelPermsOf(s, this.me, ch, (F ??= chanFactsOf(s))) & P.ViewChannel)) continue
      if (rec.type === 'msg' && c) this.autoFetch(rec, c as unknown as MsgContent)
      if (rec.effTs < since || membershipOf(s, this.me) !== 'join') continue
      // A channel we may view lately: what was held back from us before isn't new (no unread,
      // pings or alerts for it).
      if (Object.hasOwn(from, ch) && rec.effTs < from[ch]) continue
      const cur = counts.get(ch) ?? { unread: 0, pings: 0, readSeq: 0 }
      const next: ChanCounts = {
        ...cur,
        unread: cur.unread + (unread ? 1 : 0),
        pings: cur.pings + (ping ? 1 : 0),
      }
      if (ping && thread)
        next.threads = Object.assign(Object.create(null) as Record<string, number>, cur.threads, {
          [thread]: (cur.threads?.[thread] ?? 0) + 1,
        })
      counts.set(ch, next)
      arrivals.push({ room, ch, rec, ping, unread, thread })
    }
    if (counts.size)
      await this.updateRoom(room, cur => {
        const chans = Object.assign(Object.create(null) as Record<string, ChanCounts>, cur.chans)
        for (const [ch, n] of counts) {
          const old = Object.hasOwn(chans, ch) ? chans[ch] : { unread: 0, pings: 0, readSeq: 0 }
          const next: ChanCounts = {
            ...old,
            unread: old.unread + n.unread,
            pings: old.pings + n.pings,
          }
          if (n.threads) {
            const threads = Object.assign(
              Object.create(null) as Record<string, number>,
              old.threads
            )
            for (const [t, k] of Object.entries(n.threads))
              threads[t] = (Object.hasOwn(threads, t) ? threads[t] : 0) + k
            next.threads = threads
          }
          chans[ch] = next
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
      return this.myMembership(room) === 'join' &&
        (this.redeeming(room, ik) || cutOut(s, ik, this.clock.now()))
        ? 'acl'
        : 'none'
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
    const see = await this.viewable(room, link.ik, picked)
    const out: EventRecord[] = []
    let size = 0
    for (let i = 0; i < picked.length; i++) {
      if (!ok[i] || !see[i]) continue
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
    let content = g === 'all' || g === 'joined' ? found.filter(r => r.layer === 'c') : []
    const see = await this.viewable(link.room, link.ik, content)
    content = content.filter((_r, i) => see[i])
    if (g !== 'joined') return [...acl, ...content]
    const ok = await this.host.history(
      link.room,
      link.ik,
      content.map(r => r.id)
    )
    return [...acl, ...content.filter((_r, i) => ok[i])]
  }

  // Whether `ik` may be sent these content events: each one's channel must be one they may view
  // (spec 3.7, Discord order); a copy without its body only to who may view every channel.
  private viewable(room: string, ik: string, recs: EventRecord[]) {
    if (!recs.length) return Promise.resolve([])
    return this.host.viewable(
      room,
      ik,
      recs.map(r => (serverWire(r).c === null ? null : (r.chan ?? '')))
    )
  }

  // Our new events go out live to members who may have everything (content only of channels they
  // may view: `views`, filled before the push); members under history `joined` pull content (the
  // gate checks each one); invitees get the ACL.
  private pushable(link: Link, wire: Wire) {
    const g = this.gate(link.room, link.ik)
    if (g === 'none') return false
    const w = wire as unknown as WireV2
    if (w.ev.L === 'a') return true
    if (g !== 'all') return false
    const ch = typeof w.c?.ch === 'string' ? w.c.ch : w.c === null ? null : ''
    return this.rt(link.room)?.views.get(`${link.ik}\n${ch}`) === true
  }

  // Who of the room's links may be sent our content of `ch` (null: without its body).
  private async fillViews(room: string, ch: string | null) {
    const rt = this.ensureRt(room)
    const iks = [...new Set(this.sync.linksOf(room).map(l => l.ik))].filter(
      ik => !rt.views.has(`${ik}\n${ch}`)
    )
    if (!iks.length) return
    for (const ik of iks) {
      const sum = rt.sum
      const [ok] = await this.host.viewable(room, ik, [ch])
      // An answer for a state that changed meanwhile is stale (voice reads these): not kept.
      if (rt.sum !== sum) return
      rt.views.set(`${ik}\n${ch}`, ok)
    }
  }

  // The file gate for server rooms: a joined member, a message they didn't write that carries
  // the file and shows in a channel they may view, and (history `joined`) belongs to their
  // history.
  async entitled(ik: string, h: string) {
    for (const r of await this.db.getAllFromIndex('events', 'att', h)) {
      if (r.redacted || r.sender === ik || !this.rooms.has(r.room)) continue
      const g = this.gate(r.room, ik)
      if (g !== 'all' && g !== 'joined') continue
      const [sh] = await this.host.display(r.room, [r.id])
      if (!sh || sh.hidden) continue
      const [see] = await this.viewable(r.room, ik, [r])
      if (!see) continue
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
    opts: EmitOpts = {}
  ) {
    return this.locked(room, () => this.emitNow(room, t, make, opts))
  }

  private async emitNow(
    room: string,
    t: string,
    make: (plan: Plan) => Record<string, unknown>,
    opts: EmitOpts = {}
  ): Promise<string> {
    const author = await this.author()
    if (this.readOnly(room)) throw new ServerError(this.readOnly(room) as string)
    const rt = this.ensureRt(room)
    await rt.loading
    // Spec 3.9: a device whose history conflicts with another copy of it stops signing.
    if (rt.conflict) throw new ServerError(CONFLICT_TEXT)
    // Spec 3.8: a copy transferred to a new one takes nothing but leaving.
    if (this.sumOf(room).upgraded && t !== 'leave') throw new ServerError(TRANSFERRED_TEXT)
    const dev = keyId(author.dk.pk)
    const L = opts.L ?? 'a'
    const chainNow = async () =>
      ((await this.db.get('meta', chainKey(room, dev))) as DevChain | undefined) ?? null
    return this.withDevice(dev, async () => {
      let chain = await chainNow()
      const req = { t, L, a: this.me, dev, to: opts.to, ...(opts.ap ? { ap: opts.ap } : {}) }
      let plan = await this.host.plan(room, req)
      if (!plan.ap.length) throw new ServerError('Unknown server')
      // Never sign from a position without this device's last ACL event (a room removed here
      // and joined again, a backfill under way): that would fork the device.
      if ((chain?.aprev ?? plan.aprev) !== plan.aprev) {
        // Spec 3.9: this device's key signed past what this device stored: another copy of it.
        if (plan.aclSeq > (chain?.seq ?? -1)) {
          this.conflicted(room)
          throw new ServerError(CONFLICT_TEXT)
        }
        if (chain?.aprev) rt.need.add(chain.aprev)
        throw new ServerError(SYNC_TEXT)
      }
      // W4 (spec 4.1): a mark at least every 500 content events of this device.
      if (L === 'c' && Math.max(chain?.seq ?? -1, plan.seq) + 1 - plan.aclSeq > AGREED.w4) {
        const mp = await this.host.plan(room, { t: 'mark', L: 'a', a: this.me, dev })
        await this.emitOne(room, 'mark', {}, 'a', chain, mp)
        chain = await chainNow()
        plan = await this.host.plan(room, req)
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
    // The wire checks peers apply (a strike there): one of ours that fails them is never kept.
    const v = validate2(wire, room, this.sumOf(room).rules ?? RULES_VERSION)
    if (!v.ok) throw new ServerError(v.why === 'size' ? TOO_BIG_TEXT : CANT_TEXT)
    // Our own content needs room too (spec 4.2): evicted for in the stated order.
    for (let full = L === 'c' ? await this.contentFull(room, wire) : null; full;) {
      if (!(await this.evictForSpace(room, sizeOfWire(wire), full === 'total'))) break
      full = await this.contentFull(room, wire)
    }
    let out: Received
    let delta = null
    if (L === 'a') ({ out, delta } = await this.host.acl(room, id, wire, ts))
    else out = await this.host.content(room, id, wire, ts)
    if (out.s === 'R') {
      if (out.why === 'forked') this.conflicted(room)
      throw new ServerError(refusalText(out.why))
    }
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
    if (t === 'migrate') this.migrateArrived(this.ensureRt(room))
    await this.db.put('outbox', { id, room, created: now, deliveredTo: [] })
    const cached = this.rooms.get(room)
    if (cached && cached.lastSeq < res.rec.seq)
      this.rooms.set(room, { ...cached, lastSeq: res.rec.seq })
    if (delta) await this.applyDelta(room, delta)
    if (L === 'c') {
      await this.purgeRedacted(room, res.rec)
      await this.fillViews(room, typeof wire.c?.ch === 'string' ? wire.c.ch : '')
    }
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
  // rounds over a session with each (each agrees when asked, answerCoOwner): the creator assembles the
  // whole genesis content without the owners' device certificates, naming each co-owner's
  // device of that session, and sends it; each co-owner checks it and returns its certificate
  // over the digest of that content (binding.ts genesisDigest); the creator adds them and signs.
  // Then a #general channel and the settings.
  async create(name: string, coOwners: string[] = []): Promise<string> {
    const author = await this.author()
    const clean = name.trim().slice(0, LOCAL.server.nameMax) || 'P2P server'
    const dk = keyId(author.dk.pk)
    if (coOwners.length > SERVER.coOwners) throw new ServerError(CO_OWNERS_MAX_TEXT)
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
    // Every owner's certificate is about as long as ours: don't ask anyone for a genesis that
    // can't be sent.
    const est = { ...bare, owners: owners.map(o => ({ ...o, dcert: dcerts[0] })) }
    if (sizeOf(est) > LIMITS2.aclContent) throw new ServerError(TOO_BIG_TEXT)
    for (const s of sessions) dcerts.push(await this.askBundle(s, bare))
    const content = { ...bare, owners: owners.map((o, i) => ({ ...o, dcert: dcerts[i] })) }
    const now = this.clock.now()
    const { id: room, wire } = buildEvent2(author, null, 'genesis', 'a', content, { seq: 0 }, now)
    if (!validate2(wire, null).ok) throw new ServerError(TOO_BIG_TEXT)
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

  // Round two with one co-owner: the genesis content without certificates goes out, its device
  // certificate over that content's digest comes back.
  private async askBundle(s: Session, g: Record<string, unknown>) {
    const r = s.remote!
    const reply = await this.request(
      s,
      { t: 'gbundle', room: g.nonce as string, g },
      SERVER.coOwnerMs
    )
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
      this.deps.node.contact(from)?.state === 'mutual' &&
      m.room === g.nonce &&
      g.rules === RULES_VERSION &&
      aclContentOk('genesis', g) &&
      sizeOf(g) <= LIMITS2.aclContent &&
      owners.every(o => isRecord(o) && o.dcert === undefined) &&
      owners.some(o => isRecord(o) && o.ik === from) &&
      owners.filter(o => isRecord(o) && o.ik === this.me).length === 1 &&
      owners.some(o => isRecord(o) && o.ik === this.me && o.dk === dk)
    if (!ok || !author) return this.answerBundle(s, m.room, g, ok)
    // Asked here (coOwnerAsks): agreed or declined from the UI, or no answer in time.
    const key = `${from}\n${m.room}`
    if (this.coAsks.size >= SERVER.coOwnerAsks && !this.coAsks.has(key))
      return this.answerBundle(s, m.room, g, false)
    this.coAsks.set(key, {
      from,
      name:
        typeof g.name === 'string'
          ? Array.from(g.name).slice(0, LOCAL.server.nameMax).join('')
          : '',
      room: m.room,
      g,
      s,
    })
    const drop = () => {
      if (this.coAsks.delete(key)) this.changed('')
    }
    s.onClose(drop)
    this.clock.set(drop, SERVER.coOwnerMs)
    this.changed('')
  }

  private answerBundle(s: Session, room: string, g: Record<string, unknown>, ok: boolean) {
    const author = this.deps.node.author()
    const dk = author ? keyId(author.dk.pk) : ''
    const b = ok && author ? { dcert: genesisBundle(author.ik, dk, g).dcert } : null
    void s.send({ t: 'gbundled', room, ok: !!b, ...(b ? { b } : {}) }).catch(() => {})
  }

  // Contacts asking to list us as co-owner of a server they are creating (spec 8.2).
  coOwnerAsks() {
    return [...this.coAsks].map(([key, a]) => ({ key, from: a.from, name: a.name }))
  }

  answerCoOwner(key: string, yes: boolean) {
    const a = this.coAsks.get(key)
    if (!a) return
    this.coAsks.delete(key)
    this.answerBundle(a.s, a.room, a.g, yes)
    this.changed('')
  }

  // Only the fields this version knows are written again: one planted by someone else never
  // makes our change too big to send.
  private settings(room: string, patch: Record<string, unknown>) {
    return this.emit(room, 'settings', () => ({
      ...knownSettings(this.sumOf(room).settings ?? {}),
      ...patch,
    }))
  }

  setName(room: string, name: string, color?: number | null) {
    const patch: Record<string, unknown> = { name: name.trim().slice(0, LOCAL.server.nameMax) }
    if (typeof color === 'number') patch.color = color
    return this.settings(room, patch)
  }

  setHistory(room: string, vis: HistoryVis) {
    return this.settings(room, { history: vis })
  }

  setSystem(room: string, sys: SystemContent) {
    return this.settings(room, { system: sys })
  }

  // `restrictView`: only owners, Manage channels and overwrites that allow it may view it (spec
  // 1.4; the editor for overwrites is Task 23's).
  addChannel(
    room: string,
    name: string,
    opts: { restrictView?: boolean; kind?: 'text' | 'voice' } = {}
  ) {
    const pos = Math.max(-1, ...channelsOf(this.sumOf(room)).map(c => c.pos)) + 1
    const id = newShortId()
    return this.emit(room, 'channel', () => ({
      id,
      name: name.trim().slice(0, LOCAL.server.nameMax),
      kind: opts.kind ?? 'text',
      pos,
      ...(opts.restrictView ? { restrict_view: true } : {}),
    })).then(() => id)
  }

  // Restrictions and slow mode (seconds) too; a restriction off or slow mode 0 is left out.
  editChannel(room: string, id: string, patch: ChannelPatch) {
    const cur = channelOf(this.sumOf(room), id)
    if (!cur) throw new ServerError('Unknown channel')
    const next: Record<string, unknown> = { ...knownChannel(cur), ...patch, id }
    if (patch.name !== undefined) next.name = patch.name.trim().slice(0, LOCAL.server.nameMax)
    if (next.topic === '') delete next.topic
    for (const k of ['restrict_view', 'restrict_send']) if (next[k] !== true) delete next[k]
    if (!Number.isSafeInteger(next.slow) || (next.slow as number) <= 0) delete next.slow
    return this.emit(room, 'channel', () => next)
  }

  // A channel overwrite (spec 1.4 `chperm`): `subj` is `r:<role>` or `u:<ik>`; allow and deny 0
  // clear it.
  setOverwrite(room: string, ch: string, subj: string, allow: number, deny: number) {
    return this.emit(room, 'chperm', () => ({ ch, subj, allow, deny }))
  }

  // ----- Roles (spec 1.4, 1.6) -----

  // A new role goes to the bottom of the list.
  async createRole(room: string, role: { name: string; color: number | null; bits: number }) {
    const s = this.sumOf(room)
    const me = rankOf(s, this.me)
    const pos = newRolePos(
      Object.values(s.roles).map(r => r.pos),
      me[0] === Infinity ? Infinity : me[0]
    )
    if (pos === null) throw new ServerError(NO_ROOM_TEXT)
    const name = Array.from(role.name.trim()).slice(0, ROLE_NAME_MAX).join('')
    return this.emit(room, 'role_create', () => ({
      pos,
      bits: role.bits,
      ...(name ? { name } : {}),
      ...(role.color !== null ? { color: role.color } : {}),
    }))
  }

  // A role's name and color (spec 1.4 `role_meta`).
  async editRole(room: string, role: string, meta: { name: string; color: number | null }) {
    // Admitted by the generic rule (spec 1.4): one we may not make would show nothing.
    const s = this.sumOf(room)
    if (
      !can(s, this.me, P.ManageRoles) ||
      !s.roles[role] ||
      !gt(rankOf(s, this.me), roleRank(s, role))
    )
      throw new ServerError(CANT_TEXT)
    const name = Array.from(meta.name.trim()).slice(0, ROLE_NAME_MAX).join('')
    return this.emit(room, 'role_meta', () => ({
      role,
      ...(name ? { name } : {}),
      ...(meta.color !== null ? { color: meta.color } : {}),
    }))
  }

  moveRole(room: string, role: string, pos: number) {
    return this.emit(room, 'role_move', () => ({ role, pos }))
  }

  // `role` may be `everyone`.
  setRoleBit(room: string, role: string, bit: number, on: boolean) {
    return this.emit(room, 'role_bits', () => ({ role, bit, on }))
  }

  deleteRole(room: string, role: string) {
    return this.emit(room, 'role_del', () => ({ role }))
  }

  assignRole(room: string, ik: string, role: string) {
    return this.emit(room, 'assign', () => ({ to: ik, role }))
  }

  // Taking a role from someone else carries the watermark of a removal (spec 3.5).
  revokeRole(room: string, ik: string, role: string) {
    if (ik === this.me) return this.emit(room, 'revoke', () => ({ to: ik, role }))
    return this.emit(room, 'revoke', plan => ({ to: ik, role, seen: plan.seen ?? {} }), { to: ik })
  }

  // How long until we may post in `ch` again (slow mode, spec 3.5): 0 when it's off or leaves us
  // out.
  async slowLeft(room: string, ch: string) {
    const s = this.sumOf(room)
    const c = channelsOf(s).find(x => x.id === ch)
    if (!c?.slow || channelPermsOf(s, this.me, ch) & (P.ManageChannels | P.ManageMessages)) return 0
    const last = await this.host.lastSent(room, this.me, ch)
    return last === null ? 0 : Math.max(0, last + c.slow * 1000 - this.clock.now())
  }

  // Kicking someone invited withdraws the invite.
  kick(room: string, ik: string) {
    if (membershipOf(this.sumOf(room), ik) === 'invite')
      return this.emit(room, 'uninvite', () => ({ to: ik }))
    return this.emit(room, 'kick', plan => ({ to: ik, seen: plan.seen ?? {} }), { to: ik })
  }

  // `wipe`: "Also hide all their messages" (spec 3.5, needs Manage messages).
  ban(room: string, ik: string, reason?: string, wipe = false) {
    return this.emit(
      room,
      'ban',
      plan => ({
        to: ik,
        seen: plan.seen ?? {},
        ...(reason ? { reason: reason.slice(0, STATE_LIMITS.reason) } : {}),
        ...(wipe ? { wipe: true } : {}),
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
      ['rooms', 'events', 'children', 'outbox', 'codes', 'meta', 'search', 'dropped'],
      'readwrite'
    )
    const events = tx.objectStore('events')
    let n = 0
    let acl = 0
    let bytes = await unindexRoom(tx.objectStore('search'), room)
    const files = new Set<string>()
    let cursor = await events
      .index('room_seq')
      .openCursor(IDBKeyRange.bound([room, -Infinity], [room, Infinity]))
    while (cursor) {
      const r = cursor.value
      for (const p of (r.wire.ev as { prev?: string[] }).prev ?? [])
        await tx.objectStore('children').delete([p, r.id])
      const k = countOf(r)
      n += k.n
      acl += k.acl
      bytes += storedSize(r.wire)
      for (const h of r.atts ?? []) files.add(h)
      await cursor.delete()
      cursor = await cursor.continue()
    }
    for (const o of await tx.objectStore('outbox').index('room').getAll(room))
      await tx.objectStore('outbox').delete(o.id)
    for (const k of await tx.objectStore('codes').index('room').getAllKeys(room))
      await tx.objectStore('codes').delete(k)
    for (const k of await tx.objectStore('dropped').index('room').getAllKeys(room))
      await tx.objectStore('dropped').delete(k)
    const meta = tx.objectStore('meta')
    // Its per-sender counters and cache; this device's chains stay (spec 3.9).
    for (const lo of [`held\n${room}\n`, `share\n${room}\n`])
      await meta.delete(IDBKeyRange.bound(lo, `${lo}\uffff`))
    await meta.delete(cacheKey(room))
    const rec = await tx.objectStore('rooms').get(room)
    if (rec) await moveCounts(meta, rec, { n: -n, acl: -acl, bytes: -bytes })
    await tx.objectStore('rooms').delete(room)
    await tx.done
    this.rooms.delete(room)
    this.rts.delete(room)
    this.host.drop(room)
    // Downloaded files no other message here carries go too; files we sent stay.
    if (files.size) await this.deps.dms.blobs.release([...files], undefined, true).catch(() => {})
    this.changed(room)
  }

  // ----- Moderation waits for sync (spec 8.2, 9 rule 2) -----

  private modSeq = 0

  // `run` (a moderation action) is signed only after a member sent us its heads since it was
  // asked for and we hold everything they named, or once the user applies it anyway. Null when
  // it was cancelled.
  moderate<T>(
    room: string,
    what: { act: string; who?: string },
    run: () => Promise<T>
  ): Promise<T | null> {
    const rt = this.ensureRt(room)
    return new Promise<T | null>((done, fail) => {
      rt.mods.push({
        id: ++this.modSeq,
        act: what.act,
        who: what.who ?? null,
        at: this.clock.now(),
        force: false,
        run,
        done: done as (v: unknown) => void,
        fail,
      })
      this.sync.exchange(room)
      this.changed(room)
      void this.runMods(room)
    })
  }

  applyAnyway(room: string, id: number) {
    const m = this.rt(room)?.mods.find(x => x.id === id)
    if (!m) return
    m.force = true
    void this.runMods(room)
  }

  cancelMod(room: string, id: number) {
    const rt = this.rt(room)
    const m = rt?.mods.find(x => x.id === id)
    if (!rt || !m) return
    rt.mods = rt.mods.filter(x => x !== m)
    m.done(null)
    this.changed(room)
  }

  // A peer's heads: what a waiting moderation action checks.
  private heard(link: Link) {
    if (!this.rooms.has(link.room)) return
    const rt = this.ensureRt(link.room)
    rt.reports.set(link.ik, { at: this.clock.now(), state: link.peerState })
    if (rt.mods.length) void this.runMods(link.room)
  }

  private async runMods(room: string) {
    const rt = this.rt(room)
    if (!rt || rt.modsBusy) return
    rt.modsBusy = true
    try {
      while (rt.mods.length) {
        // One applied anyway goes at once, wherever it waits; the others in order, once synced.
        let i = rt.mods.findIndex(x => x.force)
        if (i < 0) {
          if (!(await this.syncedSince(room, rt.mods[0].at))) break
          i = 0
        }
        const [m] = rt.mods.splice(i, 1)
        this.changed(room)
        try {
          m.done(await m.run())
        } catch (e) {
          m.fail(e)
        }
      }
    } finally {
      rt.modsBusy = false
    }
  }

  private async syncedSince(room: string, since: number) {
    const rt = this.ensureRt(room)
    const s = this.sumOf(room)
    const reports: HeadsReport[] = []
    for (const [ik, r] of rt.reports) {
      if (r.at < since) continue
      const held = new Set((await getEvents(this.db, room, r.state)).map(x => x.id))
      let missing = 0
      for (const id of r.state)
        if (!held.has(id) && !rt.rejected.has(id) && !(await this.db.get('dropped', id))) missing++
      reports.push({ ik, at: r.at, missing })
    }
    return syncedSince(since, reports, ik => ik !== this.me && membershipOf(s, ik) === 'join')
  }

  // ----- Removals that reach invitees (spec 8.2) -----

  private noteReached(rt: Rt, list: Reached[]) {
    for (const r of list) {
      const cur = rt.reached.find(x => x.by === r.by)
      if (cur) cur.lost = [...new Set([...cur.lost, ...r.lost])].sort()
      else rt.reached.push({ by: r.by, lost: [...r.lost] })
    }
  }

  dismissReached(room: string, by: string) {
    const rt = this.ensureRt(room)
    rt.reached = rt.reached.filter(x => x.by !== by)
    this.changed(room)
  }

  // "Invite them again": an invite for each of them who is still out; contacts hear of it at once.
  async inviteAgain(room: string, by: string) {
    const rt = this.ensureRt(room)
    const r = rt.reached.find(x => x.by === by)
    if (!r) return
    this.dismissReached(room, by)
    // Each one apart: who couldn't be invited (a limit, say) stays in the note.
    const left: string[] = []
    let why: unknown = null
    for (const ik of r.lost) {
      const m = membershipOf(this.sumOf(room), ik)
      if (m === 'join' || m === 'ban' || m === 'invite') continue
      try {
        if (this.deps.node.contact(ik)?.state === 'mutual') await this.invite(room, ik)
        else await this.emit(room, 'add', () => ({ to: ik }))
      } catch (e) {
        left.push(ik)
        why ??= e
      }
    }
    if (!left.length) return
    this.noteReached(rt, [{ by, lost: left }])
    this.changed(room)
    throw why
  }

  // ----- Cut denies (spec 9 rule 18, 3.9) -----

  reapplyAll(room: string) {
    return devices.reapplyAll(ctx(this), room)
  }

  private reapplyOf(room: string) {
    return devices.reapplyOf(ctx(this), room)
  }

  // ----- Devices (spec 3.9) -----

  myDevices() {
    return devices.myDevices(ctx(this))
  }

  private joinedRooms() {
    return devices.joinedRooms(ctx(this))
  }

  private witnesses(room: string, dk: string, t: number) {
    return devices.witnesses(ctx(this), room, dk, t)
  }

  private ownEvents(room: string, dev: string) {
    return devices.ownEvents(ctx(this), room, dev)
  }

  private resignable(room: string, dev: string) {
    return devices.resignable(ctx(this), room, dev)
  }

  lostPreview(dk: string, t: number): Promise<LostRoom[]> {
    return devices.lostPreview(ctx(this), dk, t)
  }

  disownDevice(dk: string, t: number) {
    return devices.disownDevice(ctx(this), dk, t)
  }

  private resign(room: string, recs: EventRecord[]) {
    return devices.resign(ctx(this), room, recs)
  }

  recover(keep: string[]) {
    return devices.recover(ctx(this), keep)
  }

  private conflicted(room: string) {
    return devices.conflicted(ctx(this), room)
  }

  newDevice() {
    return devices.newDevice(ctx(this))
  }

  // ----- Transfer (spec 3.8) -----

  // Questions about a transfer from an owner: take ownership of a new copy, or (a co-owner)
  // approve it. Answered from the UI, or nothing in time.
  private xferAsks = new Map<
    string,
    {
      kind: 'take' | 'cosign'
      from: string
      room: string
      name: string
      to: string
      g?: WireV2
      s: Session
    }
  >()

  transferAsks() {
    return transfer.transferAsks(ctx(this))
  }

  transfer(room: string, to: string) {
    return transfer.transfer(ctx(this), room, to)
  }

  private sessionTo(room: string, ik: string) {
    return transfer.sessionTo(ctx(this), room, ik)
  }

  successors(room: string) {
    return transfer.successors(ctx(this), room)
  }

  private successorOk(room: string, g: unknown, to?: string): WireV2 | null {
    return transfer.successorOk(ctx(this), room, g, to)
  }

  private onTransfer(m: Message, s: Session, kind: 'take' | 'cosign') {
    return transfer.onTransfer(ctx(this), m, s, kind)
  }

  answerTransfer(key: string, yes: boolean) {
    return transfer.answerTransfer(ctx(this), key, yes)
  }

  private successorOf(room: string): Promise<WireV2> {
    return transfer.successorOf(ctx(this), room)
  }

  private follow(room: string) {
    return transfer.follow(ctx(this), room)
  }

  followTo(room: string, g: WireV2) {
    return transfer.followTo(ctx(this), room, g)
  }

  private carryOver(to: string) {
    return transfer.carryOver(ctx(this), to)
  }

  retryCarry(room: string) {
    return transfer.retryCarry(ctx(this), room)
  }

  private upgradeOf(from: string, to: string) {
    return transfer.upgradeOf(ctx(this), from, to)
  }

  private carriedOf(from: string, up: string) {
    return transfer.carriedOf(ctx(this), from, up)
  }

  private migrateChunks(from: string, s: Carried) {
    return transfer.migrateChunks(ctx(this), from, s)
  }

  private migratedOf(room: string): Promise<Migrated | null> {
    return transfer.migratedOf(ctx(this), room)
  }

  private migrateArrived(rt: Rt) {
    return transfer.migrateArrived(ctx(this), rt)
  }

  private readMigrated(room: string): Promise<Migrated | null> {
    return transfer.readMigrated(ctx(this), room)
  }

  private ackCarry(room: string, rt: Rt) {
    return transfer.ackCarry(ctx(this), room, rt)
  }

  private checkMigrated(room: string, prev: string, tries = 0) {
    return transfer.checkMigrated(ctx(this), room, prev, tries)
  }

  private untilAllowed(
    room: string,
    step: () => Promise<unknown>,
    waiting: (why: string) => Promise<void>
  ): Promise<string | null> {
    return transfer.untilAllowed(ctx(this), room, step, waiting)
  }

  private carryRoles(room: string) {
    return transfer.carryRoles(ctx(this), room)
  }

  private giveRoles(room: string) {
    return transfer.giveRoles(ctx(this), room)
  }

  // ----- Invite codes -----

  issueCode(room: string, ttl: number, label = '') {
    return codes.issueCode(ctx(this), room, ttl, label)
  }

  codeText(room: string, secret: string) {
    return codes.codeText(ctx(this), room, secret)
  }

  private codeByHash(room: string, hash: string) {
    return codes.codeByHash(ctx(this), room, hash)
  }

  // Codes whose revocation waits for sync: refused here from the moment it is asked.
  private holding = new Set<string>()

  revokeCodeSynced(room: string, hash: string) {
    return codes.revokeCodeSynced(ctx(this), room, hash)
  }

  revokeCode(room: string, hash: string) {
    return codes.revokeCode(ctx(this), room, hash)
  }

  codes(room: string) {
    return codes.codes(ctx(this), room)
  }

  redeem(text: string): Promise<string> {
    return codes.redeem(ctx(this), text)
  }

  private forgetEmpty(room: string) {
    return codes.forgetEmpty(ctx(this), room)
  }

  private request(s: Session, msg: Message, ms = SERVER.redeemMs): Promise<Message | null> {
    return codes.request(ctx(this), s, msg, ms)
  }

  private onRedeemed(m: Message, s: Session) {
    return codes.onRedeemed(ctx(this), m, s)
  }

  private takeInvite(room: string) {
    return codes.takeInvite(ctx(this), room)
  }

  private onRedeem(m: Message, s: Session) {
    return codes.onRedeem(ctx(this), m, s)
  }

  // ----- Direct invites -----

  invite(room: string, ik: string) {
    return codes.invite(ctx(this), room, ik)
  }

  private sendInvite(s: Session, room: string) {
    return codes.sendInvite(ctx(this), s, room)
  }

  private offerInvites(s: Session) {
    return codes.offerInvites(ctx(this), s)
  }

  private onInvite(m: Message, s: Session) {
    return codes.onInvite(ctx(this), m, s)
  }

  invites() {
    return codes.invites(ctx(this))
  }

  acceptInvite(room: string) {
    return codes.acceptInvite(ctx(this), room)
  }

  declineInvite(room: string) {
    return codes.declineInvite(ctx(this), room)
  }
  // ----- Messages -----

  private mentionables(room: string) {
    return messages.mentionables(ctx(this), room)
  }

  private content(room: string, t: string, c: Record<string, unknown>) {
    return messages.content(ctx(this), room, t, c)
  }

  send(
    room: string,
    msg: {
      ch: string
      body: string
      reply?: string
      fwd?: Fwd
      att?: Attachment[]
      thread?: string
    }
  ) {
    return messages.send(ctx(this), room, msg)
  }

  private rootOf(
    rec: EventRecord,
    get: (id: string) => Promise<EventRecord | undefined> = id => this.db.get('events', id)
  ): Promise<string | null> {
    return messages.rootOf(ctx(this), rec, get)
  }

  threadOf(id: string) {
    return messages.threadOf(ctx(this), id)
  }

  private threadRoot(room: string, id: string, ch?: string) {
    return messages.threadRoot(ctx(this), room, id, ch)
  }

  private message(room: string, target: string) {
    return messages.message(ctx(this), room, target)
  }

  edit(room: string, target: string, body: string) {
    return messages.edit(ctx(this), room, target, body)
  }

  redact(room: string, target: string) {
    return messages.redact(ctx(this), room, target)
  }

  react(room: string, target: string, key: string, on: boolean) {
    return messages.react(ctx(this), room, target, key, on)
  }

  pin(room: string, target: string, on: boolean) {
    return messages.pin(ctx(this), room, target, on)
  }

  retry(room: string, id: string) {
    return messages.retry(ctx(this), room, id)
  }

  markRead(room: string, ch: string, drop: Readonly<Record<string, number>> = {}) {
    return messages.markRead(ctx(this), room, ch, drop)
  }

  readChannel(
    room: string,
    ch: string,
    pings: readonly { id: string; thread: string }[],
    counts: Readonly<Record<string, number>> = this.threadCounts(room, ch)
  ) {
    return messages.readChannel(ctx(this), room, ch, pings, counts)
  }

  threadCounts(room: string, ch: string): Record<string, number> {
    return messages.threadCounts(ctx(this), room, ch)
  }

  private livePings(room: string, pings: readonly { id: string; thread: string }[]) {
    return messages.livePings(ctx(this), room, pings)
  }

  markThread(room: string, ch: string, root: string) {
    return messages.markThread(ctx(this), room, ch, root)
  }

  unping(room: string, ch: string, n: number, thread: string | null = null) {
    return messages.unping(ctx(this), room, ch, n, thread)
  }

  typing(room: string, ch: string, on: boolean, root?: string) {
    return messages.typing(ctx(this), room, ch, on, root)
  }

  typingIn(room: string, ch: string, root: string | null = null) {
    return messages.typingIn(ctx(this), room, ch, root)
  }

  loadOlder(room: string) {
    return messages.loadOlder(ctx(this), room)
  }

  // ----- Views -----

  view(room: string): ServerView | null {
    return views.view(ctx(this), room)
  }

  private canViewCh(room: string, ch: string) {
    return views.canViewCh(ctx(this), room, ch)
  }

  online(room: string) {
    return views.online(ctx(this), room)
  }

  pulling(room: string) {
    return views.pulling(ctx(this), room)
  }

  loadChannel(
    room: string,
    ch: string,
    opts: PageOpts & { keep?: (r: EventRecord) => boolean } = {}
  ): Promise<{ messages: P2pMessage[]; more: boolean }> {
    return views.loadChannel(ctx(this), room, ch, opts)
  }

  private archiveKeep(old: string, next?: string) {
    return views.archiveKeep(ctx(this), old, next)
  }

  private markArchive(room: string) {
    return views.markArchive(ctx(this), room)
  }

  private pinRows(room: string, pins: EventRecord[]) {
    return views.pinRows(ctx(this), room, pins)
  }

  private withReplies(room: string, ch: string, rows: P2pMessage[]) {
    return views.withReplies(ctx(this), room, ch, rows)
  }

  loadThread(
    room: string,
    root: string,
    opts: { before?: string; after?: string; limit?: number } = {}
  ) {
    return views.loadThread(ctx(this), room, root, opts)
  }

  loadThreadAround(room: string, root: string, id: string) {
    return views.loadThreadAround(ctx(this), room, root, id)
  }

  private systemRows(
    room: string,
    lo: string | undefined,
    hi: string | undefined,
    sys: { join: boolean; leave: boolean }
  ) {
    return views.systemRows(ctx(this), room, lo, hi, sys)
  }

  private rows(room: string, recs: EventRecord[]) {
    return views.rows(ctx(this), room, recs)
  }

  loadAround(room: string, ch: string, id: string) {
    return views.loadAround(ctx(this), room, ch, id)
  }

  loadPins(room: string, ch: string) {
    return views.loadPins(ctx(this), room, ch)
  }

  // ----- Search -----

  search(q: SearchQuery, cursor: string | null = null, page: number = SEARCH.page) {
    return search.search(ctx(this), q, cursor, page)
  }

  // The candidates of a query, newest first below `cursor`. Words: from the index, kept for the
  // query's next pages a minute (at most SEARCH.pool); else by a scan of recent messages.
  private searchCache: {
    key: string
    at: number
    pool: { room: string; id: string; sk: string }[]
    capped: boolean
  } | null = null
  private searchPool(
    q: SearchQuery,
    query: readonly string[],
    rooms: readonly string[],
    cursor: string | null
  ) {
    return search.searchPool(ctx(this), q, query, rooms, cursor)
  }

  private recent(room: string, q: SearchQuery, before: string | null, max: number) {
    return search.recent(ctx(this), room, q, before, max)
  }

  isChannel(room: string, ch: string) {
    return search.isChannel(ctx(this), room, ch)
  }

  isVoiceChannel(room: string, ch: string) {
    return search.isVoiceChannel(ctx(this), room, ch)
  }

  private voiceMember(room: string, ik: string | undefined) {
    return search.voiceMember(ctx(this), room, ik)
  }

  voiceAllowed(room: string, ch: string, ik: string): boolean | Promise<boolean> {
    return search.voiceAllowed(ctx(this), room, ch, ik)
  }

  private checkVoice(room: string) {
    return search.checkVoice(ctx(this), room)
  }

  recordOf(id: string): Promise<PackedRec | null> {
    return search.recordOf(ctx(this), id)
  }

  waiting(room: string) {
    return search.waiting(ctx(this), room)
  }
}
