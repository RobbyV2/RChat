import { Hdrs } from './equivocation'
import { LOCAL } from '../limits'
import { FastEval } from './eval'
import {
  emptyResult,
  factsInScope,
  fromOf,
  fullFacts,
  View,
  type CodeFact,
  type EvalResult,
  type Facts,
  type Pend,
  type RMap,
  type RSet,
  type StIdx,
} from './facts'
import { EMPTY, Ix } from './reach'
import {
  EVERYONE,
  introduces,
  poster,
  rkey,
  type AclContent,
  type AclEv,
  type Ctx,
  type Rank,
} from './rules'

// Recorded states and the client's incremental evaluator (spec §5). Every admitted event records
// St(e). On the head path St(e) is the current state, and an event on the heads changes no
// earlier status, so the state after `len` events is the evaluator's arrays read below `len`: a
// snapshot costs O(1) memory. Off the heads, St(e) = Eval(C(ap)) is one evaluation of the downset
// over the shared index, kept in a merge cache keyed by the sorted parents.

// The final state of `fe` after its first `len` events.
class SnapView extends View {
  constructor(
    ix: Ix,
    public fe: FastEval,
    public len: number
  ) {
    super(ix)
  }
  fresh() {
    return new SnapView(this.ix, this.fe, this.len)
  }
  hiE() {
    return this.len
  }
  inE(x: number) {
    return x < this.len && this.fe.inS(x)
  }
  isXv(x: number) {
    return this.fe.X[x] === 1
  }
  isVoid(x: number) {
    return this.fe.isVoidI(x)
  }
  isEff(x: number) {
    return this.fe.isEffI(x)
  }
}

// The final state of a subset evaluation (a downset of the index), from its packed sets.
class SubView extends View {
  constructor(
    ix: Ix,
    public setBits: Bits,
    public XB: Bits,
    public VB: Bits,
    public EB: Bits,
    public len: number
  ) {
    super(ix)
  }
  fresh() {
    return new SubView(this.ix, this.setBits, this.XB, this.VB, this.EB, this.len)
  }
  hiE() {
    return this.len
  }
  inE(x: number) {
    return x < this.len && bitOf(this.setBits, x)
  }
  isXv(x: number) {
    return bitOf(this.XB, x)
  }
  isVoid(x: number) {
    return bitOf(this.VB, x)
  }
  isEff(x: number) {
    return bitOf(this.EB, x)
  }
}

// Bounded caches per index (a replica's), so a dropped replica takes its entries along: whole
// enumerations (16), and the facts of recorded states (FACTS_CAP; a state's facts are built again
// when read after they left, its statuses stay packed).
const lrus = new WeakMap<Ix, Map<string, Map<object, unknown>>>()
const LRU_CAP = LOCAL.cache.lruCap
export const FACTS_CAP = LOCAL.cache.factsCap
function lruGet<T>(ix: Ix, k: object, make: () => T, kind = 'all', cap = LRU_CAP): T {
  let byKind = lrus.get(ix)
  if (!byKind) lrus.set(ix, (byKind = new Map()))
  let lru = byKind.get(kind)
  if (!lru) byKind.set(kind, (lru = new Map()))
  if (lru.has(k)) {
    const v = lru.get(k) as T
    lru.delete(k)
    lru.set(k, v)
    return v
  }
  const v = make()
  lru.set(k, v)
  if (lru.size > cap) lru.delete(lru.keys().next().value!)
  return v
}

// Read-only collections whose lookups are keyed and whose enumeration comes from `all()`.
function lazySet<K>(has: (k: K) => boolean, all: () => ReadonlySet<K>): RSet<K> {
  return {
    has,
    get size() {
      return all().size
    },
    [Symbol.iterator]: () => all()[Symbol.iterator](),
  }
}
function lazyMap<K, V>(
  has: (k: K) => boolean,
  get: (k: K) => V | undefined,
  all: () => ReadonlyMap<K, V>
): RMap<K, V> {
  return {
    has,
    get,
    get size() {
      return all().size
    },
    keys: () => all().keys(),
    values: () => all().values(),
    [Symbol.iterator]: () => all()[Symbol.iterator](),
  }
}

// The facts of a recorded state as keyed views over it, each member built on first read (an
// evaluation reads one to three of a deny's or a cause's admission state).
class SnapFacts implements Facts {
  private m: Partial<Record<keyof Facts, unknown>> = {}
  constructor(private V: SnapView | SubView) {}
  private get ix() {
    return this.V.ix
  }
  private full() {
    return lruGet(this.ix, this.V, () => fullFacts(this.V.fresh()))
  }
  private one<K extends keyof Facts>(k: K, make: () => Facts[K]): Facts[K] {
    const m = this.m as Partial<Facts>
    return (m[k] ??= make()) as Facts[K]
  }
  private inv(T: string) {
    const l = this.V.invited(T)
    return l.length ? l : undefined
  }
  get owners() {
    return this.ix.owners
  }
  get upgraded() {
    return this.ix.upgradeEv.filter(x => this.V.inE(x)).map(x => this.ix.ids[x])
  }
  get mem() {
    return this.one('mem', () =>
      lazySet(
        T => this.V.mem(T),
        () => this.full().mem as ReadonlySet<string>
      )
    )
  }
  get ban() {
    return this.one('ban', () =>
      lazySet(
        T => this.V.ban(T),
        () => this.full().ban as ReadonlySet<string>
      )
    )
  }
  get effBanK() {
    return this.one('effBanK', () =>
      lazyMap(
        T => this.V.effBanK(T) !== undefined,
        T => this.V.effBanK(T),
        () => this.full().effBanK as ReadonlyMap<string, readonly Rank[]>
      )
    )
  }
  get invited() {
    return this.one('invited', () =>
      lazyMap(
        T => this.inv(T) !== undefined,
        T => this.inv(T),
        () => this.full().invited as ReadonlyMap<string, readonly Pend[]>
      )
    )
  }
  get pending() {
    return this.one('pending', () => {
      const V = this.V
      const pend = (T: string): readonly Pend[] | undefined => {
        const l = this.inv(T)
        return l && !V.mem(T) && !V.ban(T) ? l : undefined
      }
      return lazyMap(
        T => pend(T) !== undefined,
        pend,
        () => this.full().pending as ReadonlyMap<string, readonly Pend[]>
      )
    })
  }
  get roles() {
    return this.one('roles', () =>
      lazySet(
        R => this.V.role(R),
        () => this.full().roles as ReadonlySet<string>
      )
    )
  }
  get pos() {
    return this.one('pos', () =>
      lazyMap(
        R => this.V.pos(R) !== undefined,
        R => this.V.pos(R),
        () => this.full().pos as ReadonlyMap<string, number>
      )
    )
  }
  get bits() {
    return this.one('bits', () => {
      const V = this.V
      const bitsOf = (R: string) =>
        R === EVERYONE ? (V.bits(EVERYONE) ?? 0) : V.role(R) ? (V.bits(R) ?? 0) : undefined
      return lazyMap(
        R => bitsOf(R) !== undefined,
        bitsOf,
        () => this.full().bits as ReadonlyMap<string, number>
      )
    })
  }
  get holds() {
    return this.one('holds', () => {
      const holdsOf = (T: string) => {
        const h = this.V.holds(T)
        return h.size ? h : undefined
      }
      return lazyMap(
        T => holdsOf(T) !== undefined,
        holdsOf,
        () => this.full().holds as ReadonlyMap<string, ReadonlySet<string>>
      )
    })
  }
  get devs() {
    return this.one('devs', () => {
      const { V, ix } = this
      const devsOf = (a: string) => {
        const s = new Set<string>()
        for (const x of ix.introBy.get(a) ?? EMPTY)
          if (V.live(x)) for (const v of introduces(ix.ev[x])) if (!V.revoked(v)) s.add(v)
        return s.size ? s : undefined
      }
      return lazyMap(
        a => devsOf(a) !== undefined,
        devsOf,
        () => this.full().devs as ReadonlyMap<string, ReadonlySet<string>>
      )
    })
  }
  get revoked() {
    return this.one('revoked', () =>
      lazySet(
        v => this.V.revoked(v),
        () => this.full().revoked as ReadonlySet<string>
      )
    )
  }
  get codes() {
    return this.one('codes', () => {
      const { V, ix } = this
      const codeOf = (c: string): CodeFact | undefined => {
        const x = ix.codeEv.get(c)
        if (x === undefined || !V.inE(x) || !V.codeOk(c) || V.codeDead(c)) return undefined
        return { id: c, a: ix.ev[x].a, dev: ix.ev[x].dev, k: ix.k(x) }
      }
      return lazyMap(
        c => codeOf(c) !== undefined,
        codeOf,
        () => this.full().codes as ReadonlyMap<string, CodeFact>
      )
    })
  }
  get codeIssuer() {
    return this.one('codeIssuer', () =>
      lazyMap(
        c => this.V.codeIssuer(c) !== undefined,
        c => this.V.codeIssuer(c),
        () => this.full().codeIssuer as ReadonlyMap<string, string>
      )
    )
  }
  get profile() {
    return this.one('profile', () =>
      lazyMap(
        T => this.V.profileOf(T) !== undefined,
        T => this.V.profileOf(T),
        () => this.full().profile as ReadonlyMap<string, AclContent>
      )
    )
  }
  get setting() {
    return this.V.setting()
  }
  get channels() {
    return this.one('channels', () =>
      lazyMap(
        id => this.V.channel(id) !== undefined,
        id => this.V.channel(id),
        () => this.full().channels as ReadonlyMap<string, AclContent>
      )
    )
  }
  get roleMeta() {
    return this.one('roleMeta', () =>
      lazyMap(
        R => this.V.roleMetaOf(R) !== undefined,
        R => this.V.roleMetaOf(R),
        () => this.full().roleMeta as ReadonlyMap<string, AclContent>
      )
    )
  }
  get overwrites() {
    return this.one('overwrites', () => {
      const of = (ch: string) => this.full().overwrites.get(ch)
      return lazyMap(
        ch => of(ch) !== undefined,
        of,
        () => this.full().overwrites as ReadonlyMap<string, ReadonlyMap<string, AclContent>>
      )
    })
  }
  get addsTo() {
    return this.one('addsTo', () => {
      const addsOf = (T: string) => {
        const l = this.V.addsTo(T)
        return l.length ? l : undefined
      }
      return lazyMap(
        T => addsOf(T) !== undefined,
        addsOf,
        () => this.full().addsTo as ReadonlyMap<string, readonly Pend[]>
      )
    })
  }
  get consumed() {
    return this.one('consumed', () => {
      const { V, ix } = this
      const consumed = (g: string) => {
        const i = ix.at.get(g)
        if (i === undefined || !V.inE(i) || ix.ev[i].t !== 'add') return false
        return V.consumedIdx(i)
      }
      return lazySet(consumed, () => this.full().consumed as ReadonlySet<string>)
    })
  }
  private codeLive(c: string) {
    const x = this.ix.codeEv.get(c)
    return x !== undefined && this.V.inE(x)
  }
  get codeOk() {
    return this.one('codeOk', () =>
      lazySet(
        c => this.codeLive(c) && this.V.codeOk(c),
        () => this.full().codeOk as ReadonlySet<string>
      )
    )
  }
  get codeDead() {
    return this.one('codeDead', () =>
      lazySet(
        c => this.codeLive(c) && this.V.codeDead(c),
        () => this.full().codeDead as ReadonlySet<string>
      )
    )
  }
  get from() {
    return fromOf(this.ix)
  }
}
const snapFacts = (V: SnapView | SubView): Facts => new SnapFacts(V)

// EvalResult of `fe` after its first `len` events, sharing fe's arrays. Its views, id sets and
// facts are built on first read: most recorded states are read only for their fork points, pools
// and statuses, if at all.
class SnapResult implements EvalResult {
  constructor(
    readonly fe: FastEval,
    readonly len: number
  ) {}
  get F() {
    return this.fe.F
  }
  get FI() {
    return this.fe.FI
  }
  get RF() {
    return this.fe.RF
  }
  get PC() {
    return this.fe.PC
  }
  get src() {
    return { fe: this.fe, len: this.len }
  }
  private at(id: string) {
    const i = this.fe.ix.at.get(id)
    return i !== undefined && i < this.len && this.fe.inS(i) ? i : -1
  }
  private set(p: (i: number) => boolean): RSet<string> {
    const out: RSet<string> = lazySet(
      (id: string) => {
        const i = this.at(id)
        return i >= 0 && p(i)
      },
      () =>
        lruGet(this.fe.ix, out, () => {
          const s = new Set<string>()
          for (const i of this.fe.order) {
            if (i >= this.len) break
            if (p(i)) s.add(this.fe.ix.ids[i])
          }
          return s
        })
    )
    return out
  }
  private pX(i: number) {
    return this.fe.X[i] === 1
  }
  private pT(i: number) {
    return this.fe.tail[i] === 1
  }
  private pC(i: number) {
    return this.fe.cutOrd[i] >= 0
  }
  private pE(i: number) {
    return this.fe.isEffI(i)
  }
  private pV(i: number) {
    return this.pX(i) || this.pT(i) || this.pC(i)
  }
  private m?: {
    X?: RSet<string>
    tail?: RSet<string>
    eff?: RSet<string>
    void?: RSet<string>
    cut?: RMap<string, Rank>
    idx?: StIdx
  }
  private get memo() {
    return (this.m ??= {})
  }
  get facts() {
    return factsInScope(this, () =>
      lruGet(
        this.fe.ix,
        this,
        () => snapFacts(new SnapView(this.fe.ix, this.fe, this.len)),
        'facts',
        FACTS_CAP
      )
    )
  }
  get X() {
    return (this.memo.X ??= this.set(i => this.pX(i)))
  }
  get tail() {
    return (this.memo.tail ??= this.set(i => this.pT(i)))
  }
  get eff() {
    return (this.memo.eff ??= this.set(i => this.pE(i)))
  }
  get void() {
    return (this.memo.void ??= this.set(i => this.pV(i)))
  }
  get cut(): RMap<string, Rank> {
    if (this.memo.cut) return this.memo.cut
    const fe = this.fe
    const out: RMap<string, Rank> = lazyMap(
      (id: string) => {
        const i = this.at(id)
        return i >= 0 && this.pC(i)
      },
      (id: string) => {
        const i = this.at(id)
        return i >= 0 && this.pC(i) ? fe.cutRank[i] : undefined
      },
      () =>
        lruGet(fe.ix, out, () => {
          const m = new Map<string, Rank>()
          for (const i of fe.order) {
            if (i >= this.len) break
            if (this.pC(i)) m.set(fe.ix.ids[i], fe.cutRank[i]!)
          }
          return m
        })
    )
    return (this.memo.cut ??= out)
  }
  get idx(): StIdx {
    return (this.memo.idx ??= new SnapIdx(this))
  }
  // The statuses of index i in this state (the head-path snapshot's arrays, read below len).
  has(i: number) {
    return i < this.len && this.fe.inS(i)
  }
  isX(i: number) {
    return this.has(i) && this.pX(i)
  }
  isVoid(i: number) {
    return this.has(i) && this.pV(i)
  }
  isEff(i: number) {
    return this.has(i) && this.pE(i)
  }
}
class SnapIdx implements StIdx {
  constructor(private r: SnapResult) {}
  get ix() {
    return this.r.fe.ix
  }
  get ep() {
    return this.r.fe.epoch()
  }
  X(i: number) {
    return this.r.isX(i)
  }
  void(i: number) {
    return this.r.isVoid(i)
  }
  eff(i: number) {
    return this.r.isEff(i)
  }
}
export const snapResult = (fe: FastEval, len: number): EvalResult => new SnapResult(fe, len)

// Packed statuses of a downset, in chunked bitsets: chunk k holds indices [k*CB, (k+1)*CB). A
// state built from another shares the chunks it doesn't change, so the recorded states of a
// replica (off the heads, and every one after a cold start) cost the chunks they change.
export const CB = LOCAL.cache.chunk
export type Bits = (Uint32Array | undefined)[]
// Per index, 1 + the ordinal of the stratum it is cut at (rankOrd), 0 when not cut.
export type Ords = (Uint32Array | undefined)[]

export const bitOf = (b: Bits, x: number) => {
  const c = b[x >>> 11]
  return c !== undefined && ((c[(x >>> 5) & 63] >>> (x & 31)) & 1) === 1
}
export const ordOf = (o: Ords, x: number) => o[x >>> 11]?.[x & (CB - 1)] ?? 0

const RANKS: Rank[] = []
const RANK_AT = new Map<string, number>()
export const rankOrd = (r: Rank) => {
  const k = rkey(r)
  let o = RANK_AT.get(k)
  if (o === undefined) {
    o = RANKS.length
    RANKS.push(r)
    RANK_AT.set(k, o)
  }
  return o + 1
}
export const ordRank = (o: number) => RANKS[o - 1]

const sameWords = (a: Uint32Array | undefined, b: Uint32Array | undefined) => {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
const zero = (a: Uint32Array) => {
  for (let i = 0; i < a.length; i++) if (a[i]) return false
  return true
}

// Copy-on-write writers over a base's chunks.
export class BitsW {
  b: Bits
  own = new Set<number>()
  constructor(base: Bits = []) {
    this.b = [...base]
  }
  private chunk(k: number) {
    if (!this.own.has(k)) {
      const c = this.b[k]
      this.b[k] = c ? c.slice() : new Uint32Array(CB >>> 5)
      this.own.add(k)
    }
    return this.b[k]!
  }
  set(x: number, on = true) {
    if (bitOf(this.b, x) === on) return
    const c = this.chunk(x >>> 11)
    if (on) c[(x >>> 5) & 63] |= 1 << (x & 31)
    else c[(x >>> 5) & 63] &= ~(1 << (x & 31))
  }
  done(): Bits {
    for (const k of this.own) if (zero(this.b[k]!)) this.b[k] = undefined
    return this.b
  }
}
export class OrdsW {
  o: Ords
  own = new Set<number>()
  constructor(base: Ords = []) {
    this.o = [...base]
  }
  put(x: number, v: number) {
    if (ordOf(this.o, x) === v) return
    const k = x >>> 11
    if (!this.own.has(k)) {
      const c = this.o[k]
      this.o[k] = c ? c.slice() : new Uint32Array(CB)
      this.own.add(k)
    }
    this.o[k]![x & (CB - 1)] = v
  }
  done(): Ords {
    for (const k of this.own) if (zero(this.o[k]!)) this.o[k] = undefined
    return this.o
  }
}

// A flat word bitset as chunks, sharing those equal to `base`'s.
export function chunked(flat: Uint32Array, base: Bits = []): Bits {
  const out: Bits = []
  const W = CB >>> 5
  for (let k = 0; k * W < flat.length; k++) {
    const c = new Uint32Array(W)
    c.set(flat.subarray(k * W, Math.min(flat.length, (k + 1) * W)))
    out[k] = sameWords(c, base[k]) ? base[k] : zero(c) ? undefined : c
  }
  return out
}

// Shares every chunk of `b` equal to `base`'s.
const shared = <T extends Uint32Array>(b: (T | undefined)[], base: (T | undefined)[] = []) =>
  b.map((c, k) => (sameWords(c, base[k]) ? base[k] : c))

export interface Packed {
  len: number
  set: Bits
  X: Bits
  T: Bits
  V: Bits
  E: Bits
  // null: not kept (a content position's state, spec 5.7: rendering never reads its cuts);
  // `recut` works them out again when asked.
  cut: Ords | null
  recut?: () => Ords
  F: ReadonlyMap<string, number>
  FI: ReadonlyMap<string, number>
  RF: ReadonlySet<string>
  PC: ReadonlySet<string>
}

export const emptyPacked = (): Packed => ({
  len: 0,
  set: [],
  X: [],
  T: [],
  V: [],
  E: [],
  cut: [],
  F: new Map(),
  FI: new Map(),
  RF: new Set(),
  PC: new Set(),
})

// Indices set in a chunked bitset, ascending.
export function* bitsIn(b: Bits) {
  for (let k = 0; k < b.length; k++) {
    const c = b[k]
    if (!c) continue
    for (let w = 0; w < c.length; w++) {
      let x = c[w]
      while (x) {
        const t = x & -x
        yield (k << 11) | (w << 5) | (31 - Math.clz32(t))
        x ^= t
      }
    }
  }
}
export function* ordsIn(o: Ords) {
  for (let k = 0; k < o.length; k++) {
    const c = o[k]
    if (!c) continue
    for (let j = 0; j < c.length; j++) if (c[j]) yield [(k << 11) | j, c[j]] as const
  }
}

// An EvalResult over packed statuses, built on first read: the id sets only when enumerated
// (tests, the persisted form), and its facts as keyed views.
class PackedResult implements EvalResult {
  constructor(
    readonly ix: Ix,
    readonly pk: Packed
  ) {}
  get F() {
    return this.pk.F
  }
  get FI() {
    return this.pk.FI
  }
  get RF() {
    return this.pk.RF
  }
  get PC() {
    return this.pk.PC
  }
  private at(id: string) {
    const i = this.ix.at.get(id)
    const p = this.pk
    return i !== undefined && i < p.len && bitOf(p.set, i) ? i : -1
  }
  private set(b: Bits): RSet<string> {
    const p = this.pk
    return lazySet(
      (id: string) => {
        const i = this.at(id)
        return i >= 0 && bitOf(b, i)
      },
      () => {
        const s = new Set<string>()
        for (const i of bitsIn(b)) if (i < p.len && bitOf(p.set, i)) s.add(this.ix.ids[i])
        return s
      }
    )
  }
  private cuts() {
    const p = this.pk
    return (p.cut ??= p.recut!())
  }
  private m?: {
    X?: RSet<string>
    tail?: RSet<string>
    eff?: RSet<string>
    void?: RSet<string>
    cut?: RMap<string, Rank>
    idx?: StIdx
  }
  private get memo() {
    return (this.m ??= {})
  }
  get facts() {
    const p = this.pk
    return factsInScope(this, () =>
      lruGet(
        this.ix,
        this,
        () => snapFacts(new SubView(this.ix, p.set, p.X, p.V, p.E, p.len)),
        'facts',
        FACTS_CAP
      )
    )
  }
  get X() {
    return (this.memo.X ??= this.set(this.pk.X))
  }
  get tail() {
    return (this.memo.tail ??= this.set(this.pk.T))
  }
  get eff() {
    return (this.memo.eff ??= this.set(this.pk.E))
  }
  get void() {
    return (this.memo.void ??= this.set(this.pk.V))
  }
  get cut(): RMap<string, Rank> {
    return (this.memo.cut ??= lazyMap(
      (id: string) => {
        const i = this.at(id)
        return i >= 0 && ordOf(this.cuts(), i) > 0
      },
      (id: string) => {
        const i = this.at(id)
        const o = i >= 0 ? ordOf(this.cuts(), i) : 0
        return o ? ordRank(o) : undefined
      },
      () =>
        new Map(Array.from(ordsIn(this.cuts()), ([i, o]) => [this.ix.ids[i], ordRank(o)] as const))
    ))
  }
  get idx(): StIdx {
    return (this.memo.idx ??= new PackedIdx(this.ix, this.pk))
  }
}
// A packed state's statuses by index; it is its own epoch key (its effective denies).
class PackedIdx implements StIdx {
  constructor(
    readonly ix: Ix,
    private p: Packed
  ) {}
  get ep() {
    return this
  }
  get key() {
    return this.p.E
  }
  X(i: number) {
    return bitOf(this.p.X, i)
  }
  void(i: number) {
    return bitOf(this.p.V, i)
  }
  eff(i: number) {
    return bitOf(this.p.E, i)
  }
}
export const packedResult = (ix: Ix, p: Packed): EvalResult => new PackedResult(ix, p)

const words = (n: number) => new Uint32Array((n + 31) >>> 5)
const setBit = (b: Uint32Array, x: number) => {
  b[x >>> 5] |= 1 << (x & 31)
}

const cutsOf = (fe: FastEval, base: Ords = []): Ords => {
  const w = new OrdsW()
  for (const i of fe.order) if (fe.cutOrd[i] >= 0) w.put(i, rankOrd(fe.cutRank[i]!))
  return shared(w.done(), base)
}

// The final state of a subset evaluation (an admission state St(e) = Eval(C(ap)) off the heads),
// sharing the chunks it has in common with `base` (a parent's recorded state). `light`: without
// its cuts (a content position's, kept for rendering).
export function subsetResult(fe: FastEval, light = false, base?: Packed): EvalResult {
  const ix = fe.ix
  const n = ix.n
  const set = words(n)
  const X = words(n)
  const T = words(n)
  const Vb = words(n)
  const E = words(n)
  for (const i of fe.order) {
    setBit(set, i)
    if (fe.X[i]) setBit(X, i)
    if (fe.tail[i]) setBit(T, i)
    if (fe.isVoidI(i)) setBit(Vb, i)
    if (fe.isEffI(i)) setBit(E, i)
  }
  const p: Packed = {
    len: n,
    set: chunked(set, base?.set),
    X: chunked(X, base?.X),
    T: chunked(T, base?.T),
    V: chunked(Vb, base?.V),
    E: chunked(E, base?.E),
    cut: light ? null : cutsOf(fe, base?.cut ?? undefined),
    F: fe.F,
    FI: fe.FI,
    RF: fe.RF,
    PC: fe.PC,
  }
  if (light)
    p.recut = () => {
      const mS = new Uint8Array(n)
      for (const i of bitsIn(p.set)) mS[i] = 1
      const again = new FastEval(ix, mS)
      again.compute()
      return cutsOf(again)
    }
  return packedResult(ix, p)
}

// The packed form of a head-path snapshot (the evaluation `fe` after `len` events), built from
// `prev` (an earlier snapshot of the same evaluation) by the statuses of the events after it: the
// head path changes no earlier status.
export function snapPacked(fe: FastEval, len: number, prev?: { len: number; p: Packed }): Packed {
  const from = prev && prev.len <= len ? prev : undefined
  const b = from?.p
  const set = new BitsW(b?.set)
  const X = new BitsW(b?.X)
  const T = new BitsW(b?.T)
  const Vw = new BitsW(b?.V)
  const E = new BitsW(b?.E)
  const cut = new OrdsW(b?.cut ?? [])
  for (let i = from?.len ?? 0; i < len; i++) {
    if (!fe.inS(i)) continue
    set.set(i)
    if (fe.X[i]) X.set(i)
    if (fe.tail[i]) T.set(i)
    if (fe.isVoidI(i)) Vw.set(i)
    if (fe.isEffI(i)) E.set(i)
    if (fe.cutOrd[i] >= 0) cut.put(i, rankOrd(fe.cutRank[i]!))
  }
  return {
    len,
    set: set.done(),
    X: X.done(),
    T: T.done(),
    V: Vw.done(),
    E: E.done(),
    cut: cut.done(),
    F: fe.F,
    FI: fe.FI,
    RF: fe.RF,
    PC: fe.PC,
  }
}

// The packed form of any recorded state, from its enumerations (a state that is neither packed
// nor a snapshot: the empty state of a genesis, or one rebuilt by a test).
export function packedOfSets(ix: Ix, r: EvalResult): Packed {
  const n = ix.n
  const fill = (l: Iterable<string>) => {
    const w = new BitsW()
    for (const id of l) {
      const i = ix.at.get(id)
      if (i !== undefined) w.set(i)
    }
    return w.done()
  }
  const cut = new OrdsW()
  for (const [id, k] of r.cut) {
    const i = ix.at.get(id)
    if (i !== undefined) cut.put(i, rankOrd(k))
  }
  const set = new BitsW()
  for (const id of [...r.X, ...r.tail, ...r.void, ...r.eff]) {
    const i = ix.at.get(id)
    if (i !== undefined) set.set(i)
  }
  return {
    len: n,
    set: set.done(),
    X: fill(r.X),
    T: fill(r.tail),
    V: fill(r.void),
    E: fill(r.eff),
    cut: cut.done(),
    F: r.F,
    FI: r.FI,
    RF: r.RF,
    PC: r.PC,
  }
}

// What a recorded state lists that another doesn't (the persisted form of St(e), acl_room.ts):
// ids added and removed per status, cuts added or changed (with their strata) and removed.
export interface StDelta {
  X?: [string[], string[]]
  T?: [string[], string[]]
  E?: [string[], string[]]
  V?: [string[], string[]]
  C?: [string, Rank][]
  Cd?: string[]
}

const bitsDelta = (ix: Ix, cur: Bits, base: Bits): [string[], string[]] | undefined => {
  const add: string[] = []
  const del: string[] = []
  const W = CB >>> 5
  for (let k = 0; k < Math.max(cur.length, base.length); k++) {
    const a = cur[k]
    const b = base[k]
    if (a === b) continue
    for (let w = 0; w < W; w++) {
      const x = a?.[w] ?? 0
      const y = b?.[w] ?? 0
      let d = x ^ y
      while (d) {
        const t = d & -d
        const i = (k << 11) | (w << 5) | (31 - Math.clz32(t))
        ;(x & t ? add : del).push(ix.ids[i])
        d ^= t
      }
    }
  }
  return add.length || del.length ? [add, del] : undefined
}

// The delta of `cur` against `base`, over chunks: O(the chunks that differ).
export function diffPacked(ix: Ix, cur: Packed, base: Packed): StDelta {
  const out: StDelta = {}
  const X = bitsDelta(ix, cur.X, base.X)
  const T = bitsDelta(ix, cur.T, base.T)
  const E = bitsDelta(ix, cur.E, base.E)
  const V = bitsDelta(ix, cur.V, base.V)
  if (X) out.X = X
  if (T) out.T = T
  if (E) out.E = E
  if (V) out.V = V
  const c = cur.cut ?? cur.recut!()
  const b = base.cut ?? base.recut!()
  const C: [string, Rank][] = []
  const Cd: string[] = []
  for (let k = 0; k < Math.max(c.length, b.length); k++) {
    const x = c[k]
    const y = b[k]
    if (x === y) continue
    for (let j = 0; j < CB; j++) {
      const u = x?.[j] ?? 0
      const v = y?.[j] ?? 0
      if (u === v) continue
      const id = ix.ids[(k << 11) | j]
      if (u) C.push([id, ordRank(u)])
      else Cd.push(id)
    }
  }
  if (C.length) out.C = C
  if (Cd.length) out.Cd = Cd
  return out
}

// A recorded state Eval(C(ap)) rebuilt from `base`'s and a delta, sharing base's chunks.
export function applyDelta(
  ix: Ix,
  ap: readonly string[],
  base: Packed,
  d: StDelta,
  maps: Pick<Packed, 'F' | 'FI' | 'RF' | 'PC'>
): Packed {
  const n = ix.n
  const put = (b: Bits, x?: [string[], string[]]) => {
    if (!x) return b
    const w = new BitsW(b)
    for (const id of x[1]) {
      const i = ix.at.get(id)
      if (i !== undefined) w.set(i, false)
    }
    for (const id of x[0]) {
      const i = ix.at.get(id)
      if (i !== undefined) w.set(i)
    }
    return w.done()
  }
  const cw = new OrdsW(base.cut ?? base.recut!())
  for (const id of d.Cd ?? []) {
    const i = ix.at.get(id)
    if (i !== undefined) cw.put(i, 0)
  }
  for (const [id, r] of d.C ?? []) {
    const i = ix.at.get(id)
    if (i !== undefined) cw.put(i, rankOrd(r))
  }
  return {
    len: n,
    set: chunked(ap.length ? ix.closure(ap).bits : words(n), base.set),
    X: put(base.X, d.X),
    T: put(base.T, d.T),
    V: put(base.V, d.V),
    E: put(base.E, d.E),
    cut: cw.done(),
    ...maps,
  }
}

// Whether two packed states hold the same statuses over the same set.
export function samePacked(a: Packed, b: Packed): boolean {
  const eq = (x: Bits, y: Bits) => {
    for (let k = 0; k < Math.max(x.length, y.length); k++)
      if (!sameWords(x[k] ?? new Uint32Array(CB >>> 5), y[k] ?? new Uint32Array(CB >>> 5)))
        return false
    return true
  }
  const ca = a.cut ?? a.recut!()
  const cb = b.cut ?? b.recut!()
  const sameMap = (x: ReadonlyMap<string, number>, y: ReadonlyMap<string, number>) =>
    x.size === y.size && [...x].every(([k, v]) => y.get(k) === v)
  const sameSet = (x: ReadonlySet<string>, y: ReadonlySet<string>) =>
    x.size === y.size && [...x].every(k => y.has(k))
  return (
    eq(a.set, b.set) &&
    eq(a.X, b.X) &&
    eq(a.T, b.T) &&
    eq(a.V, b.V) &&
    eq(a.E, b.E) &&
    eq(ca, cb) &&
    sameMap(a.F, b.F) &&
    sameMap(a.FI, b.FI) &&
    sameSet(a.RF, b.RF) &&
    sameSet(a.PC, b.PC)
  )
}

// The client's evaluator state (§5): one append-only index of every admitted ACL event, the
// current Eval(S), and the admission states St(e) = Eval(C(ap)) through a merge cache.
export class AclState {
  ix: Ix
  private fe?: FastEval
  private cur?: EvalResult
  cache = new Map<string, EvalResult>()
  cap = LOCAL.cache.mergeCap
  // Admission states of content positions (spec 5.7), kept for rendering within a count and a byte
  // budget (a packed state takes about five bits per indexed event).
  content = new Map<string, EvalResult>()
  contentCap = LOCAL.cache.contentCap
  contentBytes = LOCAL.cache.contentBytes
  stats = { head: 0, full: 0, subsets: 0, hits: 0, contentHits: 0 }
  constructor(public cx: Ctx) {
    this.ix = new Ix(cx)
  }
  // Headers of events storage dropped (spec 2.3), outside the index: evidence for the current
  // state only (no held event has one in its past, so no St(e) reads them).
  private hdrIds = new Set<string>()
  private hdrSet: Hdrs | null = null
  isHeader(id: string) {
    return this.hdrIds.has(id)
  }
  headerIds(): ReadonlySet<string> {
    return this.hdrIds
  }
  addHeader(id: string) {
    this.hdrIds.add(id)
    this.hdrSet = null
    this.invalidate()
  }
  dropHeader(id: string) {
    if (!this.hdrIds.delete(id)) return
    this.hdrSet = null
    this.ix.poolIx = []
    this.invalidate()
  }
  headers(): Hdrs | null {
    if (!this.hdrIds.size) return null
    this.hdrSet ??= new Hdrs(
      this.ix,
      [...this.hdrIds].map(id => ({ ev: this.cx.ev(id), rec: this.cx.rec(id) }))
    )
    return this.hdrSet
  }
  // An event next to which headers are evidence (its device, poster or identity has some): it
  // can't take the head path, which reads none.
  private nearHeaders(e: AclEv) {
    const H = this.headers()
    if (!H) return false
    return (
      H.byDev.has(e.dev) || H.byPoster.has(poster(e)) || H.idOps.some(k => H.list[k].ev.a === e.a)
    )
  }
  // The current Eval(S) of every indexed event.
  state(): EvalResult {
    if (!this.cur) {
      this.fe = new FastEval(this.ix)
      this.fe.hdrs = this.headers()
      this.cur = { ...this.fe.run(), src: { fe: this.fe, len: this.ix.n } }
    }
    return this.cur
  }
  // The packed form of a recorded state: its own, or a head-path snapshot's built from the
  // nearest earlier one of the same evaluation (kept for a few), or enumerated.
  private snaps: { fe: object; len: number; p: Packed }[] = []
  packedOf(r: EvalResult): Packed {
    if (r.pk) return r.pk as Packed
    const src = r.src as { fe: FastEval; len: number } | undefined
    if (src) {
      let prev: { len: number; p: Packed } | undefined
      for (const s of this.snaps)
        if (s.fe === src.fe && s.len <= src.len && (!prev || s.len > prev.len)) prev = s
      if (prev?.len === src.len) return prev.p
      const p = snapPacked(src.fe, src.len, prev)
      this.snaps.push({ fe: src.fe, len: src.len, p })
      if (this.snaps.length > LOCAL.cache.headSnaps) this.snaps.shift()
      return p
    }
    return packedOfSets(this.ix, r)
  }
  // The recorded state of the latest-admitted parent in `ap`, which a new state shares chunks with.
  baseOf(ap: readonly string[]): Packed | undefined {
    let bi = -1
    for (const p of ap) bi = Math.max(bi, this.ix.at.get(p) ?? -1)
    return bi < 0 ? undefined : this.packedOf(this.cx.rec(this.ix.ids[bi]).local)
  }
  // The evaluation behind the current state (strata, cuts), for content visibility.
  evaluation(): FastEval {
    this.state()
    return this.fe!
  }
  // St(e) for an event with ACL parents `ap` (all indexed): Eval(C(ap)).
  stateOf(ap: readonly string[]): EvalResult {
    const key = [...new Set(ap)].sort().join(',')
    const hit = this.cache.get(key)
    if (hit) {
      this.cache.delete(key)
      this.cache.set(key, hit)
      this.stats.hits++
      return hit
    }
    const { bits, size } = this.ix.closure(ap)
    let r: EvalResult
    if (size === this.ix.n) r = this.state()
    else {
      const mS = new Uint8Array(this.ix.n)
      for (let i = 0; i < this.ix.n; i++) if ((bits[i >>> 5] >>> (i & 31)) & 1) mS[i] = 1
      const fe = new FastEval(this.ix, mS)
      fe.compute()
      r = subsetResult(fe, false, this.baseOf(ap))
      this.stats.subsets++
    }
    this.cache.set(key, r)
    if (this.cache.size > this.cap) this.cache.delete(this.cache.keys().next().value!)
    return r
  }
  // Eval(C(ap)) worked out again, past every cache (checking a recorded state).
  freshStateOf(ap: readonly string[]): EvalResult {
    const { bits, size } = this.ix.closure(ap)
    const mS = new Uint8Array(this.ix.n)
    for (let i = 0; i < this.ix.n; i++) if ((bits[i >>> 5] >>> (i & 31)) & 1) mS[i] = 1
    if (size === 0) return emptyResult()
    const fe = new FastEval(this.ix, mS)
    fe.compute()
    return subsetResult(fe)
  }
  // St(m) of a content position: from the content cache, the merge cache, or one evaluation that
  // the content cache keeps.
  contentStateOf(ap: readonly string[]): EvalResult {
    const key = [...new Set(ap)].sort().join(',')
    const hit = this.content.get(key)
    if (hit) {
      this.content.delete(key)
      this.content.set(key, hit)
      this.stats.contentHits++
      return hit
    }
    let r = this.cache.get(key)
    if (!r) {
      const { bits, size } = this.ix.closure(ap)
      if (size === this.ix.n) r = this.state()
      else {
        const mS = new Uint8Array(this.ix.n)
        for (let i = 0; i < this.ix.n; i++) if ((bits[i >>> 5] >>> (i & 31)) & 1) mS[i] = 1
        const fe = new FastEval(this.ix, mS)
        fe.compute()
        r = subsetResult(fe, true, this.baseOf(ap))
        this.stats.subsets++
      }
    }
    this.content.set(key, r)
    const max = Math.min(
      this.contentCap,
      Math.max(64, Math.floor(this.contentBytes / ((this.ix.n * 5) / 8 + 256)))
    )
    while (this.content.size > max) this.content.delete(this.content.keys().next().value!)
    return r
  }
  // Indexes an admitted event (its admission record is in cx). An event on the heads of a fresh
  // current state takes the head path; any other arrival, and a proof (it lowers a fork point),
  // marks the current state stale.
  append(id: string): void {
    const ev = this.cx.ev(id)
    const onHeads =
      this.cur !== undefined &&
      ev.ap.length > 0 &&
      ev.t !== 'proof' &&
      this.ix.closure(ev.ap).size === this.ix.n &&
      !this.nearHeaders(ev)
    const i = this.ix.add(id)
    if (onHeads && this.fe) {
      this.fe.appendHead(i)
      this.cur = snapResult(this.fe, this.ix.n)
      this.stats.head++
    } else {
      this.cur = undefined
      this.fe = undefined
      this.stats.full++
    }
  }
  // Forgets the current state (the next state() re-runs the stratum loop over the kept index).
  invalidate() {
    this.cur = undefined
    this.fe = undefined
  }
}
