import { knownRules } from '../acl/rules'
import { emptySummary, type SumDelta, type Summary } from '../acl/summary'
import type { Carried, PackedRec, Plan } from '../acl_room'
import { aimedAt, capped, refitFull, type DevChain, type Inserted, type StoreLimits } from '../dag'
import type { EventRecord, IdentRecord, P2pDatabase, RoomRecord } from '../db'
import type { PageOpts } from '../jump'
import type { Attachment, Fwd, MsgContent } from '../content'
import type { Wire } from '../event_v1'
import type { WireV2 } from '../event_v2'
import { CANT_TEXT, cutOut, TOO_OFTEN_TEXT, type Reached } from '../flows'
import type { Message } from '../frames'
import { Gossip, type LinkKind } from '../gossip'
import { cleanName, keyId, verifyProfile, liveCerts, type Cert, type Profile } from '../keys'
import type { PlaceProfile, RoomExtras } from '../../profile_fields'
import {
  nextLockEnd,
  roomLock,
  shownRoomProfile,
  type LockSecs,
  type LockState,
  type ResetField,
} from '../../profile_reset'
import type { ProfilesMode } from '../../types'
import { mergeCerts, mergeRevocations, displayName } from '../contacts'
import { LOCAL, type Local } from '../limits'
import { RateWindow, clip } from '../rate'
import { LocalHost, WorkerHost, type AclHost, type WorkerLike } from '../resolve_host'
import { realClock, type Clock, type Session } from '../session'
import {
  can,
  channelPermsOf,
  memberOf,
  membershipOf,
  membersOf,
  MOD_BITS,
  P,
  type HistoryVis,
  type SystemContent,
} from '../state'
import { Sync, type Check, type Link, type Walked } from '../sync'
import { rebuildStep } from '../search'
import { Voice } from '../voice'
import { dmRoomId, type P2pMessage } from '../dm'
import type { ServerCtx } from './context'
import type { AboutChange } from '../../server_about'
import {
  BAD_CODE,
  LEGACY_TEXT,
  UPDATE_TEXT,
  ServerError,
  webLocks,
  type ServerArrival,
  type SearchQuery,
  type ServerView,
  type Redeemer,
  type ServerDeps,
  type EmitOpts,
  type Migrated,
  type LostRoom,
  type ChannelPatch,
  type Outgoing,
} from './types'
import { type Rt } from './rt'
import * as views from './views'
import * as search from './search'
import * as messages from './messages'
import * as transfer from './transfer'
import * as codes from './codes'
import * as devices from './devices'
import * as loader from './load'
import * as storage from './storage'
import * as receive from './receive'
import * as serve from './serve'
import * as emitter from './emit'
import * as roles from './roles'
import * as modlog from './modlog'
import * as categories from './categories'
import * as sealing from './sealing'
import * as moderation from './moderation'
import { time } from '../../platform/time'
import { sleep } from '../../clock'

export {
  SERVER,
  CODE_PREFIX,
  codeTtls,
  NEEDS_INVITER,
  NOBODY_ONLINE,
  BAD_CODE,
  REDEEM_TEXT,
  LEGACY_TEXT,
  UPDATE_TEXT,
  SYNC_TEXT,
  OLD_GONE_TEXT,
  ServerError,
  SlowModeError,
  encodeCode,
  parseCode,
  codeHash,
  newShortId,
  EVERYONE_BITS,
  THREAD_ROOT_TEXT,
  PIN_TEXT,
  PIN_THREAD_TEXT,
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
  CategoryView,
  ChannelView,
  ModView,
  ReachedView,
  ServerView,
  ServerDeps,
  ServerLimits,
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
  private deliveredFns = new Set<() => void>()
  private arriveFns = new Set<(a: ServerArrival) => void>()
  private aimedFns = new Set<(targets: string[]) => void>()
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
  // The account's limits (limits.ts).
  readonly local: Readonly<Local>

  constructor(private deps: ServerDeps) {
    this.clock = deps.clock ?? realClock
    this.local = deps.local ?? LOCAL
    const evaluator = { acl: this.local.acl, cache: this.local.cache }
    this.host =
      deps.resolver ??
      (typeof window !== 'undefined' && typeof Worker !== 'undefined'
        ? new WorkerHost(
            () =>
              new Worker(new URL('../p2p.worker.ts', import.meta.url), {
                type: 'module',
              }) as unknown as WorkerLike,
            evaluator
          )
        : new LocalHost({ local: evaluator }))
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
      onDelivered: room => {
        this.changed(room)
        for (const fn of [...this.deliveredFns]) fn()
      },
      onTyping: () => {},
      onState: room => this.changed(room),
      limits: { ...this.local.sync, ...deps.limits },
      dag: () => this.storeLimits().dag,
    })
    this.gossip = new Gossip({
      clock: this.clock,
      random: deps.random ?? Math.random,
      me: () => node.ik,
      rooms: () => this.activeRooms(),
      members: room => this.linkCandidates(room),
      may: (room, ik) => this.may(room, ik),
      budget: room => {
        if (!this.archived(room)) return null
        const g = this.gossip.limits
        return { perRoom: g.archivePerRoom, outTarget: g.archiveOutTarget }
      },
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
      limits: { ...this.local.gossip, ...deps.gossip },
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
      audio: () => deps.audio?.() ?? { muted: false, deafened: false },
      allowed: (room, ch, ik) => this.voiceAllowed(room, ch, ik),
      rights: (room, ch, ik) => search.voiceRights(ctx(this), room, ch, ik),
      certs: ik => {
        const d = node.anyDevicesOf(ik)
        return d ? { ik, certs: liveCerts(d.certs, d.revocations) } : null
      },
      onChange: room => this.changed(room),
      wake: () => node.schedule(),
      limits: { ...this.local.voice, ...deps.voice },
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
    const generation = ++this.generation
    this.stopped = false
    const idents = await this.db.getAll('idents')
    if (generation !== this.generation) return
    for (const r of idents) this.idents.set(r.ik, r)
    const rooms = await this.deps.store.rooms()
    if (generation !== this.generation) return
    for (const r of rooms) {
      if (r.kind !== 'server') continue
      this.rooms.set(r.id, r)
      await this.load(r)
      if (generation !== this.generation) return
    }
    // Rooms that filled under lower limits than these take events again; one whose rules this
    // build doesn't run (or doesn't know yet) only within what it stores of it.
    const unknown = (r: RoomRecord) => !knownRules(this.sumOf(r.id).rules)
    const refitted = await refitFull(this.db, 'server', this.storeLimits().dag, unknown)
    if (generation !== this.generation) return
    for (const id of refitted) {
      const r = this.rooms.get(id)
      if (r) this.rooms.set(id, { ...r, full: false })
    }
    this.started = true
    this.gossip.start()
    this.voice.start()
    for (const id of this.rooms.keys()) void this.refreshMe(id).catch(() => {})
    this.indexing = this.indexPass(generation)
    // A new copy loaded before its old one is checked and carried again now.
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
  private generation = 0
  private stopped = false

  private async indexPass(generation: number) {
    try {
      while (generation === this.generation && !this.deps.store.closed) {
        const skip = (room: string) => this.readOnly(room) !== null
        if (await rebuildStep(this.db, this.local.search, skip)) {
          if (generation === this.generation) this.indexed = true
          return
        }
        await sleep(time(), 0)
      }
    } catch {
      // Storage went away.
    }
  }

  stop() {
    ++this.generation
    this.started = false
    this.stopped = true
    for (const t of this.lockTimers.values()) this.clock.clear(t)
    this.lockTimers.clear()
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
      for (const ik of r.joining?.from ?? []) this.prefer(r.id, ik)
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
      storage.tick(ctx(this), r, rt, now)
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

  // Edits and redactions stored here, by the events they are aimed at.
  onAimed(fn: (targets: string[]) => void) {
    this.aimedFns.add(fn)
    return () => void this.aimedFns.delete(fn)
  }

  private aimed(recs: EventRecord[]) {
    const targets = aimedAt(recs)
    if (targets.length) for (const fn of this.aimedFns) fn(targets)
  }

  onTyping(fn: (room: string) => void) {
    this.typingFns.add(fn)
    return () => void this.typingFns.delete(fn)
  }

  private changed(room: string) {
    this.watchLocks(room)
    for (const fn of this.changeFns) fn(room)
  }

  private lockTimers = new Map<string, unknown>()

  // A profile lock that runs out changes what the server shows without any event: its views are
  // built again then.
  private watchLocks(room: string) {
    const had = this.lockTimers.get(room)
    if (had !== undefined) this.clock.clear(had)
    this.lockTimers.delete(room)
    if (this.stopped || !this.rooms.has(room)) return
    const now = this.clock.now()
    const next = nextLockEnd(
      membersOf(this.sumOf(room)).map(m => m.reset),
      Math.floor(now / 1000)
    )
    if (next === null) return
    this.lockTimers.set(
      room,
      this.clock.set(
        () => {
          this.lockTimers.delete(room)
          this.changed(room)
        },
        Math.min(next * 1000 - now + 1000, 2 ** 31 - 1)
      )
    )
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
        proofTimes: new RateWindow(60 * 60_000, () => this.local.server.proofsPerHour),
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

  // Signing is serialized per device key across tabs: a Web Lock where there is one.
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
    return rules !== null && !knownRules(rules) ? UPDATE_TEXT : null
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
    // Following a transfer, on our way in: the old copy's members, who may hold the
    // new one already.
    const r = this.rooms.get(room)
    if (r?.prev && r.joining && membershipOf(rt.sum, this.me) !== 'join')
      for (const m of membersOf(this.sumOf(r.prev)))
        if (m.m === 'join' && m.ik !== this.me && !list.includes(m.ik)) list.push(m.ik)
    rt.others = { sum: rt.sum, list }
    return list
  }

  // A joined member of the old copy of a new copy we follow.
  private oldMember(r: RoomRecord, ik: string) {
    return !!r.prev && membershipOf(this.sumOf(r.prev), ik) === 'join'
  }

  // A new copy we joined lately: we may still know few of its members.
  private settling(r: RoomRecord | undefined) {
    if (!r?.prev) return false
    const me = memberOf(this.sumOf(r.id), this.me)
    return me?.m === 'join' && this.clock.now() - (me.joinTs ?? 0) < this.local.server.settleMs
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

  // Whether the new copy `r` brings `ik` over: its carry-over names them, or before
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

  // An old copy whose new copy we are in: it keeps a link or two, so members who were
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

  // Whether we link `room` with `ik`, and what we may serve them there.
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
    // A member of the old copy this one doesn't know yet: the state, so who is in
    // spreads from those who hold it; only one the carry-over names (before it is here, the
    // upgrade's member list).
    if (m === null && (mine === 'join' || mine === 'invite') && this.carriedHere(r, ik))
      return 'state'
    // Cut out by a cascade: they get the ACL, so they learn it (and of an invite back).
    if (mine === 'join' && cutOut(s, ik, this.clock.now(), this.local.misc)) return 'state'
    return mine === 'join' && this.redeeming(room, ik) ? 'state' : false
  }

  // Out of a room by a cascade (no removal of ours) within the last week.
  private lostByCascade(r: RoomRecord) {
    return !!r.cascade && this.clock.now() - r.cascade < this.local.misc.cutMs
  }

  // Out by a cascade, or by someone else's removal, within the last week.
  private outForNow(r: RoomRecord) {
    if (this.lostByCascade(r)) return true
    const m = memberOf(this.sumOf(r.id), this.me)
    return (
      !!m?.rem &&
      m.by !== this.me &&
      this.clock.now() - (m.remTs ?? -Infinity) < this.local.misc.cutMs
    )
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

  // What each code made us post here: invites not used yet, by our clock, and lapses in
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
    const per = this.local.server.codeAddsPerHour
    const adds = new RateWindow(60 * 60_000, per, u.adds).count(now)
    return u.until <= now && adds < per
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

  // Housekeeping: an invite posted for a redeemer who didn't join within the redeem
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
      if ((u.lapses += 1) >= this.local.server.codeLapses) {
        u.until = now + this.local.server.codePauseMs
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
      if (this.clock.now() - s.lastUseful < this.local.server.idleMs) return this.idle(s)
      s.close('closed')
    }, this.local.server.idleMs)
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
    const lim = this.local.contacts
    const revocations = mergeRevocations(cur?.revocations ?? [], revs as never[], ik, lim)
    const merged = mergeCerts(cur?.certs ?? [], certs, ik, revocations, lim)
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
      const nick = this.roomProfileOf(room, ik).look?.name
      if (nick) return nick
      const n = memberOf(this.sumOf(room), ik)?.profile?.name
      if (typeof n === 'string' && n.trim()) return clip(n, this.local.server.memberNameMax)
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
    if (typeof n === 'string' && n.trim()) return clip(n, this.local.server.memberNameMax)
    const c = this.deps.node.contact(ik)
    if (c?.name) return c.name
    return this.idents.get(ik)?.profile?.name || 'Member'
  }

  // ----- Loading -----

  private load(r: RoomRecord, records = true): Promise<void> {
    return loader.load(ctx(this), r, records)
  }

  private dropRows(room: string, ids: string[]) {
    return loader.dropRows(ctx(this), room, ids)
  }

  private saveCache(room: string) {
    return loader.saveCache(ctx(this), room)
  }

  private afterState(room: string, before: Summary, changed?: string[]) {
    return loader.afterState(ctx(this), room, before, changed)
  }

  private maybeJoin(room: string) {
    return loader.maybeJoin(ctx(this), room)
  }

  // ----- Storage -----

  private storePass(room: string) {
    return storage.storePass(ctx(this), room)
  }

  private myDev() {
    return storage.myDev(ctx(this))
  }

  private dropPass(room: string) {
    return storage.dropPass(ctx(this), room)
  }

  private refreshRoom(room: string) {
    return storage.refreshRoom(ctx(this), room)
  }

  private purgePass(room: string, pressure: boolean, only?: string[]) {
    return storage.purgePass(ctx(this), room, pressure, only)
  }

  private purge(room: string, ids: string[], evict = false, keepFiles = evict) {
    return storage.purge(ctx(this), room, ids, evict, keepFiles)
  }

  private wantPass(room: string) {
    return storage.wantPass(ctx(this), room)
  }

  private restoreBody(room: string, id: string, w: WireV2): Promise<Inserted> {
    return storage.restoreBody(ctx(this), room, id, w)
  }

  private proofPass(room: string) {
    return storage.proofPass(ctx(this), room)
  }

  private postProofs(room: string, rt: Rt, now: number) {
    return storage.postProofs(ctx(this), room, rt, now)
  }

  private postProof(room: string, dev: string) {
    return storage.postProof(ctx(this), room, dev)
  }

  private noteRedaction(room: string) {
    return storage.noteRedaction(ctx(this), room)
  }

  private ackRedactions(room: string, rt: Rt, now: number) {
    return storage.ackRedactions(ctx(this), room, rt, now)
  }

  private evictForSpace(room: string, size: number, total: boolean, restore = false) {
    return storage.evictForSpace(ctx(this), room, size, total, restore)
  }

  private postJoin(room: string) {
    return storage.postJoin(ctx(this), room)
  }

  private joinContent(room: string, plan: Plan): Record<string, unknown> {
    return storage.joinContent(ctx(this), room, plan)
  }

  private refreshMe(room: string) {
    return storage.refreshMe(ctx(this), room)
  }

  private profileContent(room?: string) {
    return storage.profileContent(ctx(this), room)
  }

  // What we show in one server, over our global profile.
  setRoomProfile(room: string, intent: RoomExtras) {
    return storage.setRoomProfile(ctx(this), room, intent)
  }

  // What members may set in their profile in a server.
  setProfileMode(room: string, mode: ProfilesMode) {
    return storage.setProfileMode(ctx(this), room, mode)
  }

  // A member's room profile as the room shows it now, under its mode and the resets that count.
  roomProfileOf(room: string, ik: string): PlaceProfile {
    const s = this.sumOf(room)
    return shownRoomProfile(memberOf(s, ik), s.profiles, this.clock.now(), cleanName)
  }

  // What this device set for us in a server.
  myRoomProfile(room: string): RoomExtras {
    return this.rooms.get(room)?.profile ?? {}
  }

  // Whether a moderator's lock on a member's room profile runs now.
  roomLockOf(room: string, ik: string): LockState {
    return roomLock(memberOf(this.sumOf(room), ik)?.reset, Math.floor(this.clock.now() / 1000))
  }

  // Clears parts of another member's room profile, with a lock when `secs` is given.
  resetRoomProfile(room: string, ik: string, fields: readonly ResetField[], secs: LockSecs) {
    return storage.resetRoomProfile(ctx(this), room, ik, fields, secs)
  }

  // Lifts the lock on another member's room profile.
  unlockRoomProfile(room: string, ik: string) {
    return storage.unlockRoomProfile(ctx(this), room, ik)
  }

  refreshBadge() {
    return storage.refreshBadge(ctx(this))
  }

  // ----- Receiving -----

  check(room: string, raw: unknown): Promise<Check> {
    return receive.check(ctx(this), room, raw)
  }

  insert(room: string, id: string, wire: Wire, receivedAt: number): Promise<Inserted> {
    return receive.insert(ctx(this), room, id, wire, receivedAt)
  }

  private decidePeer(room: string, id: string, w: WireV2, now: number) {
    return receive.decidePeer(ctx(this), room, id, w, now)
  }

  private wanted(room: string) {
    return receive.wanted(ctx(this), room)
  }

  private admittedHere(room: string, id: string) {
    return receive.admittedHere(ctx(this), room, id)
  }

  private take(room: string, id: string, w: WireV2, now: number, peer = false): Promise<Inserted> {
    return receive.take(ctx(this), room, id, w, now, peer)
  }

  private reject(room: string, id: string, why: string): Inserted {
    return receive.reject(ctx(this), room, id, why)
  }

  private park(room: string, id: string, w: WireV2, missing: string[]) {
    return receive.park(ctx(this), room, id, w, missing)
  }

  private unpark(rt: Rt, id: string) {
    return receive.unpark(ctx(this), rt, id)
  }

  private release(room: string, id: string, now: number) {
    return receive.release(ctx(this), room, id, now)
  }

  private decide(
    room: string,
    id: string,
    w: WireV2,
    now: number,
    retried = false
  ): Promise<Inserted> {
    return receive.decide(ctx(this), room, id, w, now, retried)
  }

  private evictBelow(room: string, rec: EventRecord) {
    return receive.evictBelow(ctx(this), room, rec)
  }

  private purgeRedacted(room: string, rec: EventRecord) {
    return receive.purgeRedacted(ctx(this), room, rec)
  }

  // What the servers' events are stored within now: the account's limits, with the budgets set
  // apart (deps) first.
  storeLimits(): StoreLimits {
    const l = this.local
    return { dag: capped(l.dag, this.deps), share: l.share, search: l.search }
  }

  private applyDelta(room: string, delta: SumDelta) {
    return receive.applyDelta(ctx(this), room, delta)
  }

  private saving = new Set<string>()

  private saveSoon(room: string) {
    return receive.saveSoon(ctx(this), room)
  }

  private contentFull(room: string, w: WireV2): Promise<'room' | 'total' | null> {
    return receive.contentFull(ctx(this), room, w)
  }

  private hold(room: string, id: string, w: WireV2): Inserted {
    return receive.hold(ctx(this), room, id, w)
  }

  private vouch(room: string, rt: Rt, now: number) {
    return receive.vouch(ctx(this), room, rt, now)
  }

  private removed(room: string, ik: string) {
    return receive.removed(ctx(this), room, ik)
  }

  private farewell(s: Session) {
    return receive.farewell(ctx(this), s)
  }

  private tellRemoved(s: Session, room: string) {
    return receive.tellRemoved(ctx(this), s, room)
  }

  // A removal sent to us directly (it bypasses sync's pace): one per room per session, and only
  // while we are still in.
  private memberFrames = new WeakMap<Session, Set<string>>()

  private onMember(m: Message, s: Session) {
    return receive.onMember(ctx(this), m, s)
  }

  private learnFrom(rec: EventRecord) {
    return receive.learnFrom(ctx(this), rec)
  }

  private stored(room: string, added: Inserted[]) {
    return receive.stored(ctx(this), room, added)
  }

  private autoFetch(rec: EventRecord, m: MsgContent) {
    return receive.autoFetch(ctx(this), rec, m)
  }

  // ----- Serving -----

  private gate(room: string, ik: string): 'all' | 'joined' | 'acl' | 'none' {
    return serve.gate(ctx(this), room, ik)
  }

  private walk(
    link: Link,
    from: string[],
    have: string[],
    limit: number,
    bytes: number,
    state: boolean
  ): Promise<Walked> {
    return serve.walk(ctx(this), link, from, have, limit, bytes, state)
  }

  private walkContent(
    link: Link,
    from: string[],
    have: string[],
    limit: number,
    bytes: number,
    joined: boolean
  ): Promise<Walked> {
    return serve.walkContent(ctx(this), link, from, have, limit, bytes, joined)
  }

  private getFor(link: Link, ids: string[]) {
    return serve.getFor(ctx(this), link, ids)
  }

  private viewable(room: string, ik: string, recs: EventRecord[]) {
    return serve.viewable(ctx(this), room, ik, recs)
  }

  private pushable(link: Link, wire: Wire) {
    return serve.pushable(ctx(this), link, wire)
  }

  private fillViews(room: string, ch: string | null) {
    return serve.fillViews(ctx(this), room, ch)
  }

  entitled(ik: string, h: string) {
    return serve.entitled(ctx(this), ik, h)
  }

  holdersOf(h: string) {
    return serve.holdersOf(ctx(this), h)
  }

  // ----- Our own events -----

  private author() {
    return emitter.author(ctx(this))
  }

  private emit(
    room: string,
    t: string,
    make: (plan: Plan) => Record<string, unknown>,
    opts: EmitOpts = {}
  ) {
    return emitter.emit(ctx(this), room, t, make, opts)
  }

  private emitNow(
    room: string,
    t: string,
    make: (plan: Plan) => Record<string, unknown>,
    opts: EmitOpts = {}
  ): Promise<string> {
    return emitter.emitNow(ctx(this), room, t, make, opts)
  }

  private emitOne(
    room: string,
    t: string,
    content: Record<string, unknown>,
    L: 'a' | 'c',
    chain: DevChain | null,
    plan: Plan
  ): Promise<string> {
    return emitter.emitOne(ctx(this), room, t, content, L, chain, plan)
  }

  private reload(room: string) {
    return emitter.reload(ctx(this), room)
  }

  create(name: string, coOwners: string[] = []): Promise<string> {
    return emitter.create(ctx(this), name, coOwners)
  }

  private askBundle(s: Session, g: Record<string, unknown>) {
    return emitter.askBundle(ctx(this), s, g)
  }

  private onBundle(m: Message, s: Session) {
    return emitter.onBundle(ctx(this), m, s)
  }

  private answerBundle(s: Session, room: string, g: Record<string, unknown>, ok: boolean) {
    return emitter.answerBundle(ctx(this), s, room, g, ok)
  }

  coOwnerAsks() {
    return emitter.coOwnerAsks(ctx(this))
  }

  answerCoOwner(key: string, yes: boolean) {
    return emitter.answerCoOwner(ctx(this), key, yes)
  }

  private settings(room: string, patch: Record<string, unknown>) {
    return emitter.settings(ctx(this), room, patch)
  }

  setName(room: string, name: string, color?: number | null) {
    return emitter.setName(ctx(this), room, name, color)
  }

  // What the server is about and how its icon looks.
  setAbout(room: string, change: AboutChange) {
    return emitter.setAbout(ctx(this), room, change)
  }

  setHistory(room: string, vis: HistoryVis) {
    return emitter.setHistory(ctx(this), room, vis)
  }

  setSystem(room: string, sys: SystemContent) {
    return emitter.setSystem(ctx(this), room, sys)
  }

  addChannel(
    room: string,
    name: string,
    opts: { restrictView?: boolean; kind?: 'text' | 'voice' } = {}
  ) {
    return emitter.addChannel(ctx(this), room, name, opts)
  }

  editChannel(room: string, id: string, patch: ChannelPatch) {
    return emitter.editChannel(ctx(this), room, id, patch)
  }

  setOverwrite(
    room: string,
    ch: string,
    subj: string,
    allow: number,
    deny: number,
    reason?: string
  ) {
    return categories.setChannelOverwrite(ctx(this), room, ch, subj, { allow, deny }, reason)
  }

  // ----- Categories -----

  addChannelIn(
    room: string,
    name: string,
    cat: string,
    opts: { restrictView?: boolean; kind?: 'text' | 'voice' } = {}
  ) {
    return categories.addChannelIn(ctx(this), room, name, cat, opts)
  }

  createCategory(room: string, name: string) {
    return categories.createCategory(ctx(this), room, name)
  }

  editCategory(room: string, id: string, patch: categories.CategoryPatch) {
    return categories.editCategory(ctx(this), room, id, patch)
  }

  deleteCategory(room: string, id: string) {
    return categories.deleteCategory(ctx(this), room, id)
  }

  placeChannel(room: string, ch: string, cat: string | null) {
    return categories.placeChannel(ctx(this), room, ch, cat)
  }

  setCategoryOverwrite(
    room: string,
    cat: string,
    subj: string,
    allow: number,
    deny: number,
    reason?: string
  ) {
    return categories.setCategoryOverwrite(ctx(this), room, cat, subj, { allow, deny }, reason)
  }

  syncChannel(room: string, ch: string) {
    return categories.syncChannel(ctx(this), room, ch)
  }

  syncWidens(room: string, ch: string) {
    return categories.syncWidens(ctx(this), room, ch)
  }

  moderationLog(room: string, before: number | null, limit?: number) {
    return modlog.moderationLog(ctx(this), room, before, limit)
  }

  // ----- Roles -----

  createRole(
    room: string,
    role: { name: string; color: number | null; bits: number },
    reason?: string
  ) {
    return roles.createRole(ctx(this), room, role, reason)
  }

  editRole(room: string, role: string, patch: roles.RoleMetaPatch) {
    return roles.editRole(ctx(this), room, role, patch)
  }

  // "Encrypt stored messages" of a room: every member's device stores the events it gets from
  // then on sealed, or plain again.
  setStore(room: string, on: boolean, earlier = false) {
    return sealing.setStore(ctx(this), room, on, earlier)
  }

  moveRole(room: string, role: string, pos: number, reason?: string) {
    return roles.moveRole(ctx(this), room, role, pos, reason)
  }

  setRoleBit(room: string, role: string, bit: number, on: boolean, reason?: string) {
    return roles.setRoleBit(ctx(this), room, role, bit, on, reason)
  }

  deleteRole(room: string, role: string, reason?: string) {
    return roles.deleteRole(ctx(this), room, role, reason)
  }

  assignRole(room: string, ik: string, role: string, reason?: string) {
    return roles.assignRole(ctx(this), room, ik, role, reason)
  }

  revokeRole(room: string, ik: string, role: string, reason?: string) {
    return roles.revokeRole(ctx(this), room, ik, role, reason)
  }

  slowLeft(room: string, ch: string) {
    return roles.slowLeft(ctx(this), room, ch)
  }

  kick(room: string, ik: string, reason?: string) {
    return roles.kick(ctx(this), room, ik, reason)
  }

  ban(
    room: string,
    ik: string,
    reason?: string,
    wipe = false,
    terms: { seconds?: number; purgeH?: number } = {}
  ) {
    return roles.ban(ctx(this), room, ik, reason, wipe, terms)
  }

  unban(room: string, ik: string) {
    return roles.unban(ctx(this), room, ik)
  }

  // `seconds` 0 ends the member's timeout.
  timeout(room: string, ik: string, seconds: number, reason?: string) {
    return roles.timeout(ctx(this), room, ik, seconds, reason)
  }

  leave(room: string) {
    return roles.leave(ctx(this), room)
  }

  retire() {
    return roles.retire(ctx(this))
  }

  // Waits until each of our `events` reached a member of its server (one acknowledged it), for at
  // most `ms`. True when every one did. A store that can't be read leaves it to the bound.
  delivered(events: readonly Outgoing[], ms: number): Promise<boolean> {
    return new Promise(resolve => {
      let done = false
      const finish = (ok: boolean) => {
        if (done) return
        done = true
        this.deliveredFns.delete(check)
        this.clock.clear(timer)
        resolve(ok)
      }
      const check = () =>
        void Promise.all(events.map(e => this.db.get('outbox', e.id))).then(
          rows => rows.every(o => o !== undefined && o.deliveredTo.length > 0) && finish(true),
          () => {}
        )
      const timer = this.clock.set(() => finish(false), ms)
      this.deliveredFns.add(check)
      check()
    })
  }

  forget(room: string) {
    return roles.forget(ctx(this), room)
  }

  // ----- Moderation waits for sync -----

  private modSeq = 0

  moderate<T>(
    room: string,
    what: { act: string; who?: string },
    run: () => Promise<T>
  ): Promise<T | null> {
    return moderation.moderate<T>(ctx(this), room, what, run)
  }

  applyAnyway(room: string, id: number) {
    return moderation.applyAnyway(ctx(this), room, id)
  }

  cancelMod(room: string, id: number) {
    return moderation.cancelMod(ctx(this), room, id)
  }

  private heard(link: Link) {
    return moderation.heard(ctx(this), link)
  }

  private runMods(room: string) {
    return moderation.runMods(ctx(this), room)
  }

  private syncedSince(room: string, since: number) {
    return moderation.syncedSince(ctx(this), room, since)
  }

  // ----- Removals that reach invitees -----

  private noteReached(rt: Rt, list: Reached[]) {
    return moderation.noteReached(ctx(this), rt, list)
  }

  dismissReached(room: string, by: string) {
    return moderation.dismissReached(ctx(this), room, by)
  }

  inviteAgain(room: string, by: string) {
    return moderation.inviteAgain(ctx(this), room, by)
  }

  // ----- Cut denies -----

  reapplyAll(room: string) {
    return devices.reapplyAll(ctx(this), room)
  }

  private reapplyOf(room: string) {
    return devices.reapplyOf(ctx(this), room)
  }

  // ----- Devices -----

  myDevices() {
    return devices.myDevices(ctx(this))
  }

  // Servers we are in and can still sign in: the ones a leave can be written for.
  joinedRooms() {
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

  // ----- Transfer -----

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

  private request(
    s: Session,
    msg: Message,
    ms = this.local.server.redeemMs
  ): Promise<Message | null> {
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

  edit(room: string, target: string, body: string, alts?: Record<string, string>) {
    return messages.edit(ctx(this), room, target, body, alts)
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

  listThreads(room: string, ch: string) {
    return views.listThreads(ctx(this), room, ch)
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

  search(q: SearchQuery, cursor: string | null = null, page: number = this.local.search.page) {
    return search.search(ctx(this), q, cursor, page)
  }

  // The candidates of a query, newest first below `cursor`. Words: from the index, kept for the
  // query's next pages for `search.poolMs` (at most `search.pool`); else by a scan of recent
  // messages.
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
