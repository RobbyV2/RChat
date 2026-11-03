import {
  AclReplica,
  decide,
  decideContent,
  identityHead,
  pastOf,
  type AdmitOpts,
  type Verdict,
} from './acl/admit'
import {
  applyDelta,
  diffPacked,
  emptyPacked,
  packedResult,
  samePacked,
  type StDelta,
} from './acl/cache'
import type { EvalResult } from './acl/facts'
import { orphanDrops, stableDeny, underDroppable, type Drop } from './acl/storage'
import {
  canView,
  EVERYONE,
  gt,
  idOp,
  permsQ,
  poster,
  rank,
  rkey,
  RULES_VERSION,
  type AclContent,
  type AclEv,
  type Cls,
  type Rank,
  type Rec,
} from './acl/rules'
import { ContentView, type ContentEv, type Hidden } from './acl/visibility'
import { aclEvOf, contentEvOf, type WireV2 } from './event'

// One P2P server's evaluator state, where the host runs it (a worker in the browser): the ACL
// replica, the content it holds, and what the page mirrors of the current state. The page stores
// events; this decides them (spec §2.1), plans honest events (§1.2), answers visibility (§3.5)
// and history (§3.6) questions, and sends the current state as deltas.

export const HOLD_MS = 5 * 60_000
export const MAX_PARENTS = 10

// The version of the evaluator and of the records it stores (spec 2.4): a record or cache of
// another version is not read; its events are admitted again.
export const IMPL = 2

// The persisted admission record of an ACL event: its Rec without St(e), and St(e) as a delta
// against the recorded state of one of its parents (`b`), so a cold start admits nothing again.
export interface PackedRec {
  v: number
  k: Rank
  cls: Cls
  self: boolean
  exempt: boolean
  depth: number
  epoch: string
  pool?: PoolDelta
  st: PackedSt
}

// St(e) against its base's state: the statuses (StDelta), and the fork points, contested
// rotations and pool candidates as entries set and keys removed, ids added and removed.
export interface PackedSt extends StDelta {
  b?: string
  F?: [string, number][]
  Fx?: string[]
  FI?: [string, number][]
  FIx?: string[]
  RF?: [string[], string[]]
  PC?: [string[], string[]]
}

// U(e) against the pool of the latest parent posted by the same identity (`b`).
export interface PoolDelta {
  b?: string
  add?: string[]
  del?: string[]
}

export interface AclItem {
  id: string
  w: WireV2
  rec?: PackedRec
  // A dropped event's header (spec 2.3): restored from its record, never admitted again.
  hdr?: true
}

export type Received =
  | { s: 'A'; rec: PackedRec; aseq: number }
  | { s: 'C' }
  | { s: 'H' }
  | { s: 'R'; why: string }
  | { s: 'M'; why: string }
  | { s: 'U'; rules: number }
  | { s: 'P'; missing: string[] }

export type Membership = 'invite' | 'join' | 'leave' | 'ban'

export interface MemberSum {
  m: Membership
  rank: Rank
  perms: number
  roles: string[]
  devs: string[]
  profile: AclContent | null
  // The effective removal of someone who is out (kick, ban, leave) and who made it.
  rem?: string
  by?: string
  // Pending invites (add event ids).
  adds?: string[]
  // The time of the live join (or genesis) that started a member's membership.
  joinTs?: number
  // The account binding a member posted last: its profile's, else its join's (badge.ts).
  binding?: string
}

export interface RoleSum {
  pos: number
  bits: number
  name?: string
  color?: number
}

export interface CodeSum {
  a: string
  h: string
  label?: string
  exp?: number
}

export interface Summary {
  // null: no genesis held yet; another number than RULES_VERSION: unknown rules (read-only).
  rules: number | null
  owners: string[]
  creator: string | null
  members: Record<string, MemberSum>
  roles: Record<string, RoleSum>
  everyone: number
  channels: Record<string, AclContent>
  settings: AclContent | null
  codes: Record<string, CodeSum>
  upgraded: boolean
  heads: string[]
  count: number
}

type Keyed = 'members' | 'roles' | 'channels' | 'codes'
const KEYED: readonly Keyed[] = ['members', 'roles', 'channels', 'codes']

export interface SumDelta {
  top?: Partial<Omit<Summary, Keyed>>
  put?: Partial<{ [K in Keyed]: Summary[K] }>
  del?: Partial<Record<Keyed, string[]>>
}

export const emptySummary = (): Summary => ({
  rules: null,
  owners: [],
  creator: null,
  members: {},
  roles: {},
  everyone: 0,
  channels: {},
  settings: null,
  codes: {},
  upgraded: false,
  heads: [],
  count: 0,
})

// Ranks hold the infinities of owners and non-members; what is stored (and exported as JSON)
// writes them as +-2^53, which no position (a safe integer) can be.
const BIG = 2 ** 53
export const toStored = <T>(x: T): T =>
  JSON.parse(
    JSON.stringify(x, (_k, v: unknown) => (v === Infinity ? BIG : v === -Infinity ? -BIG : v))
  ) as T
export const fromStored = <T>(x: T): T =>
  JSON.parse(JSON.stringify(x), (_k, v: unknown) =>
    v === BIG ? Infinity : v === -BIG ? -Infinity : v
  ) as T

const json = (x: unknown) =>
  JSON.stringify(x, (_k, v: unknown) =>
    typeof v === 'number' && !Number.isFinite(v) ? `#${String(v)}` : v
  )

export const diffSummary = (a: Summary, b: Summary): SumDelta | null => {
  const out: SumDelta = {}
  const top: Record<string, unknown> = {}
  for (const k of Object.keys(b) as (keyof Summary)[]) {
    if ((KEYED as readonly string[]).includes(k)) continue
    if (json(a[k]) !== json(b[k])) top[k] = b[k]
  }
  if (Object.keys(top).length) out.top = top as SumDelta['top']
  for (const k of KEYED) {
    const x = a[k] as Record<string, unknown>
    const y = b[k] as Record<string, unknown>
    const put: Record<string, unknown> = {}
    for (const [id, v] of Object.entries(y)) if (!(id in x) || json(x[id]) !== json(v)) put[id] = v
    const del = Object.keys(x).filter(id => !(id in y))
    if (Object.keys(put).length) (out.put ??= {})[k] = put as never
    if (del.length) (out.del ??= {})[k] = del
  }
  return out.top || out.put || out.del ? out : null
}

export const applySummary = (s: Summary, d: SumDelta | null | undefined): Summary => {
  if (!d) return s
  const next: Summary = { ...s, ...(d.top ?? {}) }
  for (const k of KEYED) {
    const put = d.put?.[k]
    const del = d.del?.[k]
    if (!put && !del) continue
    const m = { ...(s[k] as Record<string, unknown>), ...(put ?? {}) }
    for (const id of del ?? []) delete m[id]
    ;(next as unknown as Record<string, unknown>)[k] = m
  }
  return next
}

// What a message shows: hidden or not, its last edit, its reactions and its pin, and whether its
// mention of everyone counts.
export interface Shown {
  hidden: Hidden | null
  edit: string | null
  reactions: { id: string; a: string; key: string }[]
  pin: { id: string; on: boolean } | null
  everyone: boolean
}

export interface PlanReq {
  t: string
  L: 'a' | 'c'
  a: string
  dev: string
  // kick, ban, revoke: the member the watermark covers
  to?: string
}

export interface Plan {
  ap: string[]
  iprev?: string
  seen?: Record<string, number>
  ts: number
  // The device's last ACL event in the replica and its seq, and its highest seq (ACL and content).
  aprev?: string
  aclSeq: number
  seq: number
}

// An event the evaluator admitted again on a cold start (stored without a record it can read).
export interface Fresh {
  id: string
  aseq: number
  rec: PackedRec
}

// The fields of a content event that admission and visibility read; the rest stays in storage.
export const trimContent = (m: ContentEv): ContentEv => {
  const c = m.c
  if (!c) return m
  const t: Record<string, unknown> = {}
  for (const k of ['target', 'ch', 'key', 'on', 'everyone']) if (c[k] !== undefined) t[k] = c[k]
  return { ...m, c: t }
}

const isStrs = (x: unknown) => Array.isArray(x) && x.every(v => typeof v === 'string')
const isDelta = (x: unknown) =>
  x === undefined || (Array.isArray(x) && x.length === 2 && isStrs(x[0]) && isStrs(x[1]))
const isRank = (x: unknown) =>
  Array.isArray(x) && x.length === 2 && typeof x[0] === 'number' && typeof x[1] === 'string'
const isPairs = (x: unknown, v: (y: unknown) => boolean) =>
  x === undefined ||
  (Array.isArray(x) &&
    x.every(p => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && v(p[1])))

// A record this build reads: its version and the types of every field (one from an import or an
// older build is admitted again instead).
export const recOk = (x: unknown): x is PackedRec => {
  if (typeof x !== 'object' || x === null) return false
  const r = x as Record<string, unknown>
  const st = r.st as Record<string, unknown> | undefined
  return (
    r.v === IMPL &&
    isRank(r.k) &&
    ['G', 'D', 'R', 'A'].includes(r.cls as string) &&
    typeof r.self === 'boolean' &&
    typeof r.exempt === 'boolean' &&
    Number.isSafeInteger(r.depth) &&
    typeof r.epoch === 'string' &&
    (r.pool === undefined ||
      (typeof r.pool === 'object' &&
        r.pool !== null &&
        ((r.pool as PoolDelta).b === undefined || typeof (r.pool as PoolDelta).b === 'string') &&
        ((r.pool as PoolDelta).add === undefined || isStrs((r.pool as PoolDelta).add)) &&
        ((r.pool as PoolDelta).del === undefined || isStrs((r.pool as PoolDelta).del)))) &&
    typeof st === 'object' &&
    st !== null &&
    (st.b === undefined || typeof st.b === 'string') &&
    ['X', 'T', 'E', 'V'].every(k => isDelta(st[k])) &&
    isPairs(st.C, isRank) &&
    (st.Cd === undefined || isStrs(st.Cd)) &&
    isPairs(st.F, v => typeof v === 'number') &&
    isPairs(st.FI, v => typeof v === 'number') &&
    (st.Fx === undefined || isStrs(st.Fx)) &&
    (st.FIx === undefined || isStrs(st.FIx)) &&
    isDelta(st.RF) &&
    isDelta(st.PC)
  )
}

// A record's references are to the event's own parents (restored before it), so a record can't
// name an event that isn't there, or make a cycle.
export const refsOk = (ap: readonly string[], r: PackedRec) =>
  (r.st.b === undefined || ap.includes(r.st.b)) &&
  (r.pool?.b === undefined || ap.includes(r.pool.b))

// A record keeps the infinite ranks of owners and non-members as +-2^53 (as toStored does).
const rankOut = (r: Rank): Rank => [
  r[0] === Infinity ? BIG : r[0] === -Infinity ? -BIG : r[0],
  r[1],
]
const rankIn = (r: Rank): Rank => [r[0] === BIG ? Infinity : r[0] === -BIG ? -Infinity : r[0], r[1]]

const mapDelta = (cur: ReadonlyMap<string, number>, base: ReadonlyMap<string, number>) => {
  const set: [string, number][] = []
  for (const [k, v] of cur) if (base.get(k) !== v) set.push([k, v])
  const del = [...base.keys()].filter(k => !cur.has(k))
  return { set, del }
}
const mapApply = (
  base: ReadonlyMap<string, number>,
  set: [string, number][] = [],
  del: string[] = []
): ReadonlyMap<string, number> => {
  if (!set.length && !del.length) return base
  const m = new Map(base)
  for (const k of del) m.delete(k)
  for (const [k, v] of set) m.set(k, v)
  return m
}
const setDelta = (cur: ReadonlySet<string>, base: ReadonlySet<string>) => {
  const add = [...cur].filter(x => !base.has(x))
  const del = [...base].filter(x => !cur.has(x))
  return add.length || del.length ? ([add, del] as [string[], string[]]) : undefined
}
const setApply = (base: ReadonlySet<string>, d?: [string[], string[]]): ReadonlySet<string> => {
  if (!d) return base
  const s = new Set(base)
  for (const x of d[1]) s.delete(x)
  for (const x of d[0]) s.add(x)
  return s
}

// Rejected ACL events the evaluator remembers (by id only; a rejected parent rejects its child).
export const KEEP = { rejected: 10_000 }

// What a cold start found to drop: stored events that are not admitted (an import), with the ids
// of content that failed its decision.
export interface Restored {
  fresh: Fresh[]
  refused: string[]
  // A recorded state that didn't match its evaluation: every event was admitted again.
  mismatch: boolean
  // Headers whose record can't be read: they can't be admitted again (their content is gone).
  lost: string[]
}

// What storage drops (spec 2.3, 4.2): ACL events (their headers kept as `acl/` decides), and
// content with its header (only the id stays).
export interface Drops {
  acl: Drop[]
  content: string[]
}

// Evidence a proof can carry now (spec 2.3, 4.1): the pair against `dev` with the lowest fork
// point, which a proof posted from the asking device would have admitted.
export interface ProofCand {
  dev: string
  f: number
  x: string
  y: string
}

// A cause hiding held content that still has its body (spec 4.3), with S2 and S3; S1 holds (it
// hides that content now). `self`: a counted redaction by the content's own author.
export interface Cause {
  id: string
  kind: 'deny' | 'wipe' | 'redact' | 'self'
  stable: boolean
  ids: string[]
}

export interface Purgeable {
  // Every removal and wiping ban in effect, for the page's clock (S4).
  live: string[]
  causes: Cause[]
  // Hidden bodies with no such cause (cut): evicted only under pressure.
  other: string[]
}

export class AclRoom {
  r: AclReplica
  private contents = new Map<string, ContentEv>()
  private maxContent = new Map<string, number>()
  private cv: ContentView | null = null
  private cvAt = -1
  private evals = 0
  private sent: Summary = emptySummary()
  // Deltas of stored records not rebuilt yet (rebuilt when first read, then dropped).
  private packed = new Map<string, PackedSt>()
  private rejected = new Set<string>()
  private unknownCount = 0
  // Storage: ACL events dropped from it (in the index whole, or from a header after a cold start),
  // content held without its body, devices with new events since proofs were last looked for,
  // and S2/S3 of causes in the current state.
  private gone = new Set<string>()
  private bare = new Set<string>()
  private bodiless = new Set<string>()
  private evicted = new Set<string>()
  // Evicted edits by their target: they come back with it.
  private evictedEdits = new Map<string, Set<string>>()
  private dirty = new Set<string>()
  private stab = new Map<string, boolean>()
  private stabAt = -1

  constructor(
    readonly srv: string,
    private opts: Partial<AdmitOpts> = {}
  ) {
    this.r = new AclReplica(opts)
  }

  // ----- Cold start -----

  // Rebuilds the replica from stored events in admission order. An event stored with a record this
  // build reads is indexed as it was admitted (its St(e) rebuilt, sharing its base's chunks, only
  // when read); one without (an import, another version) is admitted again. Then a few recorded
  // states are checked against their evaluation (the newest, and a sample): a mismatch admits
  // every event again (spec 2.4). `check`: content to decide (an import), not only to hold.
  restore(
    items: readonly AclItem[],
    contents: readonly ContentEv[],
    check: readonly { id: string; w: WireV2 }[] = [],
    bodiless: readonly string[] = [],
    evicted: readonly string[] = []
  ): Restored {
    const evs = items.map(it => ({ e: aclEvOf(it.id, it.w), rec: it.rec, hdr: it.hdr }))
    const out = this.restoreEvs(evs)
    for (const m of contents) this.noteContent(trimContent(m))
    for (const id of bodiless) this.bodiless.add(id)
    for (const id of evicted) if (this.bodiless.has(id)) this.evict(id, true)
    for (const i of this.r.acl.ix.byDev.keys()) this.dirty.add(i)
    for (const m of contents) this.dirty.add(m.dev)
    for (const c of check) {
      this.contents.delete(c.id)
      const v = this.receiveContent(c.id, c.w, Infinity)
      if (v.s !== 'C' && v.s !== 'U') out.refused.push(c.id)
    }
    this.changed()
    return out
  }

  // The ACL part of a cold start, from events and their stored records.
  restoreEvs(items: readonly { e: AclEv; rec?: PackedRec; hdr?: true }[]): Restored {
    let out = this.restoreAcl(items, true)
    if (this.verify(items)) return { ...out, mismatch: false }
    this.reset()
    out = this.restoreAcl(items, false)
    return { ...out, mismatch: true }
  }

  private reset() {
    this.r = new AclReplica(this.opts)
    this.packed.clear()
    this.built.clear()
    this.restoredIds.clear()
    this.rejected.clear()
    this.unknownCount = 0
    this.cv = null
    this.gone.clear()
    this.bare.clear()
  }

  private restoreAcl(
    items: readonly { e: AclEv; rec?: PackedRec; hdr?: true }[],
    records: boolean
  ) {
    const fresh: Fresh[] = []
    const refused: string[] = []
    const lost: string[] = []
    for (const it of items) {
      const e = it.e
      // A header is restored from its record whatever else is trusted: nothing can decide it again.
      if (it.hdr) {
        if (
          this.r.unknownRules === undefined &&
          recOk(it.rec) &&
          refsOk(e.ap, it.rec) &&
          e.ap.every(p => this.r.admitted(p))
        ) {
          this.r.restore(e, this.lazyRec(e, it.rec))
          this.gone.add(e.id)
          this.bare.add(e.id)
        } else lost.push(e.id)
        continue
      }
      if (this.r.unknownRules !== undefined || (e.t === 'genesis' && e.c.rules !== RULES_VERSION)) {
        this.r.restoreUnknown(e, this.r.unknownRules ?? (e.c.rules as number))
        this.r.forget(e.id)
        this.unknownCount++
        continue
      }
      if (records && recOk(it.rec) && refsOk(e.ap, it.rec) && e.ap.every(p => this.r.admitted(p))) {
        this.r.restore(e, this.lazyRec(e, it.rec))
        continue
      }
      const before = this.r.order.length
      const v = this.r.receive(e)
      if (v.s !== 'A' && v.s !== 'P') refused.push(e.id)
      for (const id of this.r.order.slice(before))
        fresh.push({
          id,
          aseq: this.r.acl.ix.at.get(id)!,
          rec: this.pack(this.r.ev(id), this.r.rec(id)),
        })
    }
    // Still pending after every stored event: never admitted here.
    for (const it of items) if (this.r.status.get(it.e.id)?.s === 'P') refused.push(it.e.id)
    return { fresh, refused, lost }
  }

  // The newest restored records and a sample of the others, against one evaluation each.
  private verify(items: readonly { e: AclEv }[]) {
    const ids = items.map(it => it.e.id).filter(id => this.r.recs.has(id))
    const restored = ids.filter(id => this.restoredIds.has(id) && !this.bare.has(id))
    if (!restored.length) return true
    const pick = new Set(restored.slice(-2))
    const same = (a: Rec, b: Rec) =>
      rkey(a.k) === rkey(b.k) &&
      a.cls === b.cls &&
      a.self === b.self &&
      a.exempt === b.exempt &&
      a.depth === b.depth &&
      a.epoch === b.epoch &&
      (a.pool ?? []).join() === (b.pool ?? []).join()
    let h = 0
    for (const id of restored) h = (h * 31 + id.charCodeAt(0) + id.charCodeAt(5)) >>> 0
    pick.add(restored[h % restored.length])
    const acl = this.r.acl
    for (const id of pick) {
      const e = this.r.ev(id)
      const rec = this.r.rec(id)
      const fresh = acl.freshStateOf(e.ap)
      if (!samePacked(acl.packedOf(rec.local), acl.packedOf(fresh))) return false
      const d = e.t === 'genesis' ? null : decide(e, pastOf(acl.ix, e.ap), fresh, this.r.opts)
      if (d && (!d.ok || !same(d.rec, rec))) return false
    }
    return true
  }

  private restoredIds = new Set<string>()

  private lazyRec(e: AclEv, p: PackedRec): Rec {
    const st: PackedSt = { ...p.st }
    if (st.C) st.C = st.C.map(([id, r]) => [id, rankIn(r)])
    this.packed.set(e.id, st)
    this.restoredIds.add(e.id)
    let local: EvalResult | undefined
    const rec = {
      k: rankIn(p.k),
      cls: p.cls,
      self: p.self,
      exempt: p.exempt,
      depth: p.depth,
      epoch: p.epoch,
    } as Rec
    if (p.pool) {
      const base = p.pool.b !== undefined ? (this.r.recs.get(p.pool.b)?.pool ?? []) : []
      const del = new Set(p.pool.del ?? [])
      rec.pool = [...base.filter(x => !del.has(x)), ...(p.pool.add ?? [])].sort()
    }
    Object.defineProperty(rec, 'local', {
      enumerable: false,
      get: () => {
        if (!local) {
          local = this.built.get(e.id) ?? this.rebuild(e.id)
          this.built.delete(e.id)
        }
        return local
      },
    })
    return rec
  }

  // States rebuilt as the base of another before their own record was read.
  private built = new Map<string, EvalResult>()

  // St(e) of a stored event from its base's (rebuilding the bases first, oldest first); each delta
  // is dropped once applied.
  private rebuild(id: string): EvalResult {
    const ix = this.r.acl.ix
    const chain: string[] = []
    for (let at: string | undefined = id; at !== undefined && this.packed.has(at);) {
      chain.push(at)
      at = this.packed.get(at)!.b
    }
    let out: EvalResult | undefined
    for (let i = chain.length - 1; i >= 0; i--) {
      const at = chain[i]
      const st = this.packed.get(at)
      if (!st) continue
      this.packed.delete(at)
      const base = st.b !== undefined ? this.r.acl.packedOf(this.r.rec(st.b).local) : emptyPacked()
      const p = applyDelta(ix, this.r.ev(at).ap, base, st, {
        F: mapApply(base.F, st.F, st.Fx),
        FI: mapApply(base.FI, st.FI, st.FIx),
        RF: setApply(base.RF, st.RF),
        PC: setApply(base.PC, st.PC),
      })
      out = packedResult(ix, p)
      if (at !== id) this.built.set(at, out)
    }
    return out!
  }

  // The record to store with a newly admitted event: St(e) as the chunks it changes against the
  // state of its latest-admitted parent.
  private pack(e: AclEv, rec: Rec): PackedRec {
    const acl = this.r.acl
    const ix = acl.ix
    let b: string | undefined
    let bi = -1
    for (const p of e.ap) {
      const i = ix.at.get(p)!
      if (i > bi) {
        bi = i
        b = p
      }
    }
    const cur = acl.packedOf(rec.local)
    const base = b === undefined ? emptyPacked() : acl.packedOf(this.r.rec(b).local)
    const st: PackedSt = diffPacked(ix, cur, base)
    if (st.C) st.C = st.C.map(([id, r]) => [id, rankOut(r)])
    if (b !== undefined) st.b = b
    const F = mapDelta(cur.F, base.F)
    if (F.set.length) st.F = F.set
    if (F.del.length) st.Fx = F.del
    const FI = mapDelta(cur.FI, base.FI)
    if (FI.set.length) st.FI = FI.set
    if (FI.del.length) st.FIx = FI.del
    const RF = setDelta(cur.RF, base.RF)
    if (RF) st.RF = RF
    const PC = setDelta(cur.PC, base.PC)
    if (PC) st.PC = PC
    const out: PackedRec = {
      v: IMPL,
      k: rankOut(rec.k),
      cls: rec.cls,
      self: rec.self,
      exempt: rec.exempt,
      depth: rec.depth,
      epoch: rec.epoch,
      st,
    }
    if (rec.pool) {
      // the pool of the latest parent by the same poster
      let pb: string | undefined
      let pi = -1
      for (const q of e.ap) {
        const i = ix.at.get(q)!
        if (i > pi && poster(ix.ev[i]) === poster(e)) {
          pi = i
          pb = q
        }
      }
      const base = new Set(pb !== undefined ? (this.r.rec(pb).pool ?? []) : [])
      const cur = new Set(rec.pool)
      const pd: PoolDelta = {}
      if (pb !== undefined) pd.b = pb
      const add = rec.pool.filter(x => !base.has(x))
      const del = [...base].filter(x => !cur.has(x))
      if (add.length) pd.add = add
      if (del.length) pd.del = del
      out.pool = pd
    }
    return out
  }

  // ----- Receipt (§2.1; the page checked the wire and that every ACL parent is held) -----

  receiveAcl(id: string, w: WireV2, now: number): Received {
    const e = aclEvOf(id, w)
    // A dropped event fetched again: admitted as it was; one restored from its header gets its
    // content back.
    if (this.gone.has(id) && this.r.admitted(id)) {
      if (this.bare.delete(id)) this.r.refill(e)
      this.gone.delete(id)
      return this.out(e, { s: 'A' })
    }
    this.dirty.add(e.dev)
    const unknown = this.r.unknownRules
    if (e.ts > now + HOLD_MS && unknown === undefined && e.t !== 'genesis') {
      const v = this.r.judge(e)
      if (v.s === 'A') return { s: 'H' }
      const out = this.out(e, v)
      this.bound(e.id, v)
      return out
    }
    const v = this.r.receive(e)
    if (v.s === 'A' || v.s === 'U') this.changed()
    const out = this.out(e, v)
    this.bound(e.id, v)
    return out
  }

  // The evaluator keeps no rejected or unknown-rules event: a rejected id is remembered (a
  // bounded number), an unknown-rules event only counted; a pending one the page holds.
  private bound(id: string, v: Verdict) {
    if (v.s === 'R') {
      this.r.forget(id, true)
      this.rejected.delete(id)
      this.rejected.add(id)
      if (this.rejected.size > KEEP.rejected) {
        const old = this.rejected.values().next().value as string
        this.rejected.delete(old)
        this.r.forget(old)
      }
    } else if (v.s === 'U') {
      this.unknownCount++
      this.r.forget(id)
    } else if (v.s === 'P') this.r.forget(id)
  }

  private out(e: AclEv, v: Verdict): Received {
    switch (v.s) {
      case 'A':
        return {
          s: 'A',
          rec: this.pack(e, this.r.rec(e.id)),
          aseq: this.r.acl.ix.at.get(e.id)!,
        }
      case 'R':
        return { s: 'R', why: v.why }
      case 'M':
        return { s: 'M', why: v.why }
      case 'U':
        return { s: 'U', rules: v.rules }
      case 'P':
        return { s: 'P', missing: v.missing }
    }
  }

  receiveContent(id: string, w: WireV2, now: number): Received {
    if (this.r.unknownRules !== undefined) return { s: 'U', rules: this.r.unknownRules }
    const m = contentEvOf(id, w)
    if (this.contents.has(id)) return { s: 'C' }
    const missing = m.ap.filter(p => !this.r.admitted(p))
    if (missing.some(p => this.r.status.get(p)?.s === 'R')) return { s: 'R', why: 'parent' }
    if (missing.length) return { s: 'P', missing }
    const ix = this.r.acl.ix
    const d = decideContent(m, pastOf(ix, m.ap), this.r.acl.contentStateOf(m.ap))
    if (!d.ok) return { s: 'R', why: d.why }
    if (m.ts > now + HOLD_MS) return { s: 'H' }
    this.noteContent(trimContent(m))
    this.cv?.add(this.contents.get(id)!)
    this.dirty.add(m.dev)
    return { s: 'C' }
  }

  private noteContent(m: ContentEv) {
    this.contents.set(m.id, m)
    this.maxContent.set(m.dev, Math.max(this.maxContent.get(m.dev) ?? -1, m.seq))
  }

  private changed() {
    this.evals++
  }

  private view(): ContentView {
    if (!this.cv) {
      this.cv = new ContentView(this.r.acl, this.contents.values())
      this.cvAt = this.evals
    } else if (this.cvAt !== this.evals) {
      this.cv.rebase()
      this.cvAt = this.evals
    }
    return this.cv
  }

  // ----- The current state, for the page -----

  summary(): Summary {
    const ix = this.r.acl.ix
    if (this.r.unknownRules !== undefined)
      return { ...emptySummary(), rules: this.r.unknownRules, count: this.unknownCount }
    if (ix.genesis < 0) return emptySummary()
    const S = this.r.state()
    const F = S.facts
    const fe = this.r.acl.evaluation()
    const who = new Set<string>([
      ...ix.byAuthor.keys(),
      ...ix.addEv.keys(),
      ...ix.banEv.keys(),
      ...ix.remEv.keys(),
    ])
    const members: Record<string, MemberSum> = {}
    for (const ik of who) {
      const m: Membership = F.mem.has(ik)
        ? 'join'
        : F.ban.has(ik)
          ? 'ban'
          : F.pending.has(ik)
            ? 'invite'
            : 'leave'
      if (m === 'leave' && !(ix.memEv.get(ik)?.length || ix.addEv.get(ik)?.length)) continue
      const sum: MemberSum = {
        m,
        rank: rank(F, ik),
        perms: m === 'join' ? permsQ(F, ik) : 0,
        roles: [...(F.holds.get(ik) ?? [])],
        devs: [...(F.devs.get(ik) ?? [])],
        profile: F.profile.get(ik) ?? null,
      }
      if (m === 'leave' || m === 'ban') {
        let last = -1
        for (const d of ix.remEv.get(ik) ?? []) if (fe.isEffI(d) && d > last) last = d
        if (last >= 0) {
          sum.rem = ix.ids[last]
          sum.by = ix.ev[last].a
        }
      }
      if (m === 'invite') sum.adds = (F.pending.get(ik) ?? []).map(p => p.id)
      if (m === 'join') {
        let j = -1
        for (const g of ix.memEv.get(ik) ?? []) if (fe.inS(g) && !fe.isVoidI(g) && g > j) j = g
        if (j >= 0) sum.joinTs = ix.ev[j].ts
        const b = sum.profile?.binding ?? (j >= 0 ? ix.ev[j].c.binding : undefined)
        if (typeof b === 'string') sum.binding = b
      }
      members[ik] = sum
    }
    const roles: Record<string, RoleSum> = {}
    for (const R of F.roles) {
      const c = ix.ev[ix.roleCreate.get(R)!]?.c
      const r: RoleSum = { pos: F.pos.get(R) ?? 0, bits: F.bits.get(R) ?? 0 }
      if (typeof c?.name === 'string') r.name = c.name
      if (typeof c?.color === 'number') r.color = c.color
      roles[R] = r
    }
    const channels: Record<string, AclContent> = {}
    for (const [id, c] of F.channels) channels[id] = c
    const codes: Record<string, CodeSum> = {}
    for (const [id, cf] of F.codes) {
      const c = ix.ev[ix.codeEv.get(id)!].c
      const x: CodeSum = { a: cf.a, h: c.h }
      if (typeof c.label === 'string') x.label = c.label
      if (typeof c.exp === 'number') x.exp = c.exp
      codes[id] = x
    }
    return {
      rules: RULES_VERSION,
      owners: [...F.owners],
      creator: ix.ev[ix.genesis].a,
      members,
      roles,
      everyone: F.bits.get(EVERYONE) ?? 0,
      channels,
      settings: F.setting ?? null,
      codes,
      upgraded: F.upgraded.length > 0,
      heads: this.heads(i => !this.gone.has(ix.ids[i])),
      count: ix.n,
    }
  }

  // What changed since the page's copy (all of it the first time).
  delta(): SumDelta | null {
    const cur = this.summary()
    const d = diffSummary(this.sent, cur)
    this.sent = cur
    return d
  }

  // Forgets what the page holds (it reloads): the next delta is the whole state.
  resetSent() {
    this.sent = emptySummary()
  }

  // ----- Honest events (§1.2, §3.5) -----

  // Maximal admitted ACL events among those `ok` keeps, newest first.
  private heads(ok: (i: number) => boolean): string[] {
    const ix = this.r.acl.ix
    const cov = new Uint32Array((ix.n + 31) >>> 5)
    const out: string[] = []
    for (let i = ix.n - 1; i >= 0; i--) {
      if (!ok(i) || (cov[i >>> 5] >>> (i & 31)) & 1) continue
      out.push(ix.ids[i])
      const a = ix.anc[i]
      for (let w = 0; w < a.length; w++) cov[w] |= a[w]
    }
    return out
  }

  // Parents and chain fields for an event of ours: the citable heads (never an event that is a
  // candidate, void by equivocation, past a revocation's watermark, or of a non-member other than
  // its effective leave, except our own device's chain), at most 10, newest first, with our
  // device's last ACL event in their closure; the identity-chain position of an identity op; the remover's watermark of a kick,
  // ban, revoke or leave over every live device of its target.
  plan(q: PlanReq): Plan {
    const ix = this.r.acl.ix
    if (ix.genesis < 0) return { ap: [], ts: 0, aclSeq: -1, seq: -1 }
    const fe = this.r.acl.evaluation()
    const F = this.r.state().facts
    const own = ix.byDev.get(q.dev) ?? []
    let mine = -1
    for (const i of own) if (mine < 0 || ix.ev[i].seq > ix.ev[mine].seq) mine = i
    const citable = (i: number) => {
      if (!fe.inS(i)) return false
      const e = ix.ev[i]
      if (e.dev === q.dev) return true
      if (fe.X[i] || fe.tail[i] || fe.candidateIn(i, fe.F, fe.FI, fe.RF, fe.PC)) return false
      // A member's own effective leave is the last event of a member, not a non-member's.
      return F.mem.has(e.a) || i === ix.genesis || (e.t === 'leave' && fe.isEffI(i))
    }
    let ap = this.heads(citable).slice(0, MAX_PARENTS)
    if (mine >= 0) {
      const { bits } = ix.closure(ap)
      if (!((bits[mine >>> 5] >>> (mine & 31)) & 1)) {
        if (ap.length >= MAX_PARENTS) ap = ap.slice(0, MAX_PARENTS - 1)
        ap.push(ix.ids[mine])
      }
    }
    let ts = 0
    for (const p of ap) ts = Math.max(ts, ix.ev[ix.at.get(p)!].ts)
    const aclSeq = mine >= 0 ? ix.ev[mine].seq : -1
    const seq = Math.max(aclSeq, this.maxContent.get(q.dev) ?? -1)
    const plan: Plan = { ap, ts, aclSeq, seq }
    if (mine >= 0) plan.aprev = ix.ids[mine]
    if (q.L === 'c') return plan
    const St = this.r.acl.stateOf(ap)
    const probe = { id: '', t: q.t, a: q.a, dev: q.dev, seq: 0, ap, ts, c: {} } as AclEv
    if (idOp(probe, St.facts)) {
      const h = identityHead(q.a, pastOf(ix, ap), q.t === 'primary_rotate', St.FI)
      if (h.iprev !== undefined) plan.iprev = h.iprev
    }
    const target =
      q.t === 'kick' || q.t === 'ban' || (q.t === 'revoke' && q.to !== q.a)
        ? q.to
        : q.t === 'leave' || q.t === 'revoke'
          ? q.a
          : undefined
    if (target !== undefined) {
      const seen: Record<string, number> = {}
      for (const v of St.facts.devs.get(target) ?? []) seen[v] = this.maxSeq(v)
      plan.seen = seen
    }
    return plan
  }

  // The highest seq of device v this replica holds, ACL or content (-1: none).
  maxSeq(v: string) {
    const ix = this.r.acl.ix
    let m = this.maxContent.get(v) ?? -1
    for (const i of ix.byDev.get(v) ?? []) m = Math.max(m, ix.ev[i].seq)
    return m
  }

  // ----- Rendering and serving -----

  // Content: whether and how it shows. An ACL event (a join or leave line): shown while a grant is
  // live or a deny is effective.
  display(ids: readonly string[]): (Shown | null)[] {
    const v = this.view()
    const ix = this.r.acl.ix
    const fe = this.r.acl.evaluation()
    return ids.map(id => {
      const m = v.byIdOf(id)
      if (!m) {
        const i = ix.at.get(id)
        if (i === undefined) return null
        const e = ix.ev[i]
        // A ban of someone who wasn't a member removes nobody from the member list.
        const ok =
          (ix.isD[i] ? fe.isEffI(i) : !fe.isVoidI(i)) &&
          (e.t !== 'ban' || ix.rec[i].local.facts.mem.has(e.c.to))
        return {
          hidden: ok ? null : { why: 'cut', at: ix.k(i) },
          edit: null,
          reactions: [],
          pin: null,
          everyone: false,
        }
      }
      const hidden = v.hidden(m)
      if (hidden) return { hidden, edit: null, reactions: [], pin: null, everyone: false }
      const pin = v.pinOf(m)
      return {
        hidden: null,
        edit: v.editOf(m)?.id ?? null,
        reactions: v.reactions(m).map(r => ({ id: r.id, a: r.a, key: String(r.c?.key) })),
        pin: pin ? { id: pin.id, on: pin.c?.on === true } : null,
        everyone: v.mentionsEveryone(m),
      }
    })
  }

  // §3.6: which of `ids` belong to X's history under history `joined`: content whose position
  // holds the live join that starts X's membership (and, for an edit, reaction or pin, its
  // target too), and ACL events (join and leave lines) that have it in their past.
  history(X: string, ids: readonly string[]): boolean[] {
    const v = this.view()
    const ix = this.r.acl.ix
    const fe = this.r.acl.evaluation()
    const rem = ix.remEv.get(X) ?? []
    const joins = (ix.memEv.get(X) ?? []).filter(
      g =>
        fe.inS(g) &&
        !fe.isVoidI(g) &&
        rem.every(r => !fe.inS(r) || !fe.isEffI(r) || ix.before(r, g))
    )
    return ids.map(id => {
      const m = v.byIdOf(id)
      if (!m) {
        const i = ix.at.get(id)
        if (i === undefined) return false
        return ix.ev[i].a === X || joins.some(g => g === i || ix.has(i, g))
      }
      if (!v.inHistory(m, X)) return false
      const t = typeof m.c?.target === 'string' ? (m.c.target as string) : null
      if (t === null || m.t === 'redact') return true
      const tm = v.byIdOf(t)
      return !!tm && v.inHistory(tm, X)
    })
  }

  // ACL backfill: the admitted events in C(from) that are not in C(have), oldest first.
  aclDiff(from: readonly string[], have: readonly string[], limit: number): string[] {
    const ix = this.r.acl.ix
    const known = (l: readonly string[]) => l.filter(id => this.r.admitted(id))
    const f = known(from)
    if (!f.length) return []
    const want = ix.closure(f).bits
    const got = ix.closure(known(have)).bits
    const out: string[] = []
    for (let i = 0; i < ix.n && out.length < limit; i++) {
      const w = i >>> 5
      const b = 1 << (i & 31)
      if (want[w] & b && !(got[w] & b)) out.push(ix.ids[i])
    }
    return out
  }

  // Whether `ik` outranks `other` in the current state (the page's kick and ban buttons).
  outranks(ik: string, other: string) {
    const F = this.r.state().facts
    return gt(rank(F, ik), rank(F, other))
  }

  // ----- Storage (spec 2.3, 4.2, 4.3) -----

  // What storage drops now, beyond what it dropped before: the orphan rule's ACL events (held
  // descendants: the ACL events that stay and visible content), and content with its header:
  // past its device's fork point (but the pair defining it), past a revocation's watermark, or
  // hidden and citing a dropped event (controller ruling). `mine`: this device, whose own events
  // stay (it cites them).
  drops(mine?: string): Drops {
    const ix = this.r.acl.ix
    if (ix.genesis < 0 || this.r.unknownRules !== undefined) return { acl: [], content: [] }
    const fe = this.r.acl.evaluation()
    const v = this.view()
    const keep = (i: number) => ix.ev[i].dev === mine
    const under = underDroppable(fe, keep)
    const touching = new Set<ContentEv>()
    const cited = new Uint8Array(ix.n)
    for (const m of this.contents.values()) {
      if (!m.ap.some(p => under[ix.at.get(p) ?? -1] === 1)) continue
      touching.add(m)
      if (v.visible(m)) for (const p of m.ap) cited[ix.at.get(p)!] = 1
    }
    const acl = orphanDrops(fe, i => cited[i] === 1, keep).filter(d => !this.gone.has(d.id))
    for (const d of acl) this.gone.add(d.id)
    const content: string[] = []
    const pairs = new Map<string, Set<string>>()
    for (const m of this.contents.values()) {
      if (m.dev === mine) continue
      const cites = touching.has(m) && m.ap.some(p => this.gone.has(p)) && !v.visible(m)
      if (!cites && v.dropKind(m) === null) continue
      let pair = pairs.get(m.dev)
      if (!pair) pairs.set(m.dev, (pair = v.fcPair(m.dev)))
      if (!pair.has(m.id)) content.push(m.id)
    }
    if (content.length) {
      for (const id of content) {
        this.evict(id, false)
        this.contents.delete(id)
        this.bodiless.delete(id)
      }
      this.cv = null
    }
    return { acl, content }
  }

  // Evidence worth a proof (spec 2.3, 4.1), for the devices with new events since the last call
  // (or `devs`): the held pair with the lowest fork point against each, when a proof of it that
  // `q` posts now would be admitted (it lowers F below an ACL event of the device there).
  proofs(q: { a: string; dev: string }, devs?: readonly string[]): ProofCand[] {
    const ix = this.r.acl.ix
    if (ix.genesis < 0 || this.r.unknownRules !== undefined) return []
    const list = devs ?? [...this.dirty]
    const v = this.view()
    const out: ProofCand[] = []
    let plan: Plan | null = null
    for (const d of list) {
      const ev = d === q.dev ? null : v.evidence(d)
      if (ev) plan ??= this.plan({ t: 'proof', L: 'a', a: q.a, dev: q.dev })
      // Without a position to post from, the rest waits for the next call.
      if (plan && !plan.ap.length) return out
      if (!devs) this.dirty.delete(d)
      if (!ev || !plan) continue
      const e: AclEv = {
        id: '',
        t: 'proof',
        a: q.a,
        dev: q.dev,
        seq: plan.seq + 1,
        ap: plan.ap,
        ts: plan.ts,
        c: { x: ev.x, y: ev.y } as unknown as AclContent,
      }
      if (plan.aprev !== undefined) e.aprev = plan.aprev
      const r = decide(e, pastOf(ix, plan.ap), this.r.acl.stateOf(plan.ap), this.r.opts)
      if (r.ok) out.push({ dev: d, f: ev.f, x: ev.x.id, y: ev.y.id })
    }
    return out
  }

  // Spec 4.3: the causes hiding held content that still has its body (of `only`, when given),
  // with S2 and S3 worked out once per state.
  purgeable(only?: readonly string[]): Purgeable {
    const ix = this.r.acl.ix
    const out: Purgeable = { live: [], causes: [], other: [] }
    if (ix.genesis < 0 || this.r.unknownRules !== undefined) return out
    const fe = this.r.acl.evaluation()
    const v = this.view()
    if (this.stabAt !== this.evals) {
      this.stab.clear()
      this.stabAt = this.evals
    }
    const live = new Set<string>()
    for (const P of new Set([...ix.remEv.keys(), ...ix.revokeEv.keys(), ...ix.byAuthor.keys()])) {
      for (const d of fe.againstMember(P)) live.add(ix.ids[d])
      const w = v.wipedBy(P)
      if (w !== null) live.add(ix.ids[w])
    }
    out.live = [...live]
    const pool = only
      ? only.flatMap(id => {
          const m = v.byIdOf(id)
          return m ? [m] : []
        })
      : v.hideable()
    const by = new Map<string, Cause>()
    const stable = (key: string, f: () => boolean) => {
      let x = this.stab.get(key)
      if (x === undefined) this.stab.set(key, (x = f()))
      return x
    }
    for (const m of pool) {
      if (this.bodiless.has(m.id)) continue
      if (v.selfRedacted(m)) {
        const c = by.get('') ?? { id: '', kind: 'self' as const, stable: true, ids: [] }
        c.ids.push(m.id)
        by.set('', c)
        continue
      }
      const h = v.hidden(m)
      if (!h) continue
      let c: Cause | undefined
      if (h.why === 'removed' || h.why === 'wipe') {
        const i = ix.at.get(h.by)!
        c = by.get(h.by) ?? {
          id: h.by,
          kind: h.why === 'wipe' ? 'wipe' : 'deny',
          stable: stable(h.by, () => stableDeny(fe, i)),
          ids: [],
        }
      } else if (h.why === 'redacted') {
        const r = v.byIdOf(h.by)!
        c = by.get(h.by) ?? {
          id: h.by,
          kind: 'redact',
          stable: stable(`${h.by}|${m.a}`, () => v.stableRedaction(r, m)),
          ids: [],
        }
      }
      if (!c) {
        out.other.push(m.id)
        continue
      }
      c.ids.push(m.id)
      by.set(c.id, c)
    }
    out.causes = [...by.values()]
    return out
  }

  // Content held without its body (purged, or evicted for space) that shows now: its body is
  // wanted from peers (spec 4.3 restore).
  // An edit is wanted only while its target shows; a body evicted for space only when viewed (the
  // page asks for those itself).
  wanted(): string[] {
    if (!this.bodiless.size) return []
    return [...this.bodiless].filter(id => !this.evicted.has(id) && this.shows(id))
  }

  // Whether these bodies may be taken back now (`viewed`: also evicted ones): each shows, and an
  // edit only with its target.
  restorable(ids: readonly string[], viewed: boolean): boolean[] {
    return ids.map(
      id => this.bodiless.has(id) && (viewed || !this.evicted.has(id)) && this.shows(id)
    )
  }

  private shows(id: string) {
    const v = this.view()
    const m = v.byIdOf(id)
    if (!m || !v.visible(m)) return false
    const t = m.t === 'edit' && typeof m.c?.target === 'string' ? v.byIdOf(m.c.target) : null
    return m.t !== 'edit' || (!!t && v.visible(t))
  }

  // Content storage didn't keep after all (refused after it was decided): it goes, and its
  // device's highest held seq is what is held again (a removal's watermark covers no more).
  unhold(ids: readonly string[]) {
    const devs = new Set<string>()
    for (const id of ids) {
      const m = this.contents.get(id)
      if (m) devs.add(m.dev)
      this.evict(id, false)
      this.contents.delete(id)
      this.bodiless.delete(id)
    }
    if (!devs.size) return
    this.cv = null
    for (const d of devs) this.maxContent.delete(d)
    for (const m of this.contents.values())
      if (devs.has(m.dev))
        this.maxContent.set(m.dev, Math.max(this.maxContent.get(m.dev) ?? -1, m.seq))
  }

  // Storage purged bodies (`have` false; `evicted`: for space) or got them back.
  bodies(ids: readonly string[], have: boolean, evicted = false) {
    for (const id of ids) {
      if (have) {
        this.bodiless.delete(id)
        this.evict(id, false)
        // Its author's edits that waited with it (evicted too) are wanted with it now.
        for (const x of [...(this.evictedEdits.get(id) ?? [])]) this.evict(x, false)
      } else if (this.contents.has(id)) {
        this.bodiless.add(id)
        if (evicted) this.evict(id, true)
      }
    }
  }

  private evict(id: string, on: boolean) {
    const m = this.contents.get(id)
    const t = m?.t === 'edit' && typeof m.c?.target === 'string' ? m.c.target : null
    if (on) {
      this.evicted.add(id)
      if (t !== null) {
        let s = this.evictedEdits.get(t)
        if (!s) this.evictedEdits.set(t, (s = new Set()))
        s.add(id)
      }
    } else if (this.evicted.delete(id) && t !== null) {
      const s = this.evictedEdits.get(t)
      s?.delete(id)
      if (s && !s.size) this.evictedEdits.delete(t)
    }
  }

  // Moderators' redactions `me` may acknowledge with a mark (spec 4.3 S2; controller ruling): each
  // hides its target here, isn't acknowledged yet, isn't by `me` or of `me`'s message, `me` hasn't
  // named it in a mark, and at least 2 members other than its two authors could acknowledge it.
  acks(me: string): string[] {
    const ix = this.r.acl.ix
    if (ix.genesis < 0 || this.r.unknownRules !== undefined) return []
    const v = this.view()
    const F = this.r.state().facts
    const named = new Set<string>()
    for (const i of ix.byAuthor.get(me) ?? []) {
      const ack = ix.ev[i].c.ack
      if (Array.isArray(ack)) for (const x of ack) if (typeof x === 'string') named.add(x)
    }
    const out: string[] = []
    for (const r of this.contents.values()) {
      if (r.t !== 'redact' || r.a === me || named.has(r.id) || typeof r.c?.target !== 'string')
        continue
      const t = v.byIdOf(r.c.target)
      if (!t || t.a === me || t.a === r.a) continue
      const h = v.hidden(t)
      if (h?.why !== 'redacted' || h.by !== r.id) continue
      // S2 needs 3 acknowledging events of 2 identities, and each names it once: 3 members besides
      // its two authors.
      let others = 0
      for (const P of F.mem) if (P !== r.a && P !== t.a) others += 1
      if (others < 3 || v.redactionWitnessed(r, t)) continue
      out.push(r.id)
      if (out.length >= 10) break
    }
    return out
  }

  // Whether `ik` may be sent content of these channels (spec 3.7, Discord order: owners and
  // Manage channels see every channel); '': content of no channel; null: a copy without its body,
  // whose channel can't be read, goes only to those who can view every channel.
  viewable(ik: string, chs: readonly (string | null)[]): boolean[] {
    const ix = this.r.acl.ix
    if (ix.genesis < 0 || this.r.unknownRules !== undefined) return chs.map(() => false)
    const F = this.r.state().facts
    let every: boolean | undefined
    const all = () => [...F.channels].every(([id, c]) => c.gone === true || canView(F, ik, id))
    return chs.map(ch => (ch === null ? (every ??= all()) : ch === '' || canView(F, ik, ch)))
  }
}
