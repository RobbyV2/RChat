import { FastEval } from './eval'
import {
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
import { EVERYONE, introduces, type AclContent, type Ctx, type Rank } from './rules'

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
  inE(x: number) {
    return x < this.len && this.fe.inS(x)
  }
  hiE() {
    return this.len
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

// The final state of a subset evaluation (a downset of the index), from its packed set.
class SubView extends View {
  constructor(
    ix: Ix,
    public setBits: Uint32Array,
    public XI: Set<number>,
    public VI: Set<number>,
    public EI: Set<number>,
    public len: number
  ) {
    super(ix)
  }
  fresh() {
    return new SubView(this.ix, this.setBits, this.XI, this.VI, this.EI, this.len)
  }
  inE(x: number) {
    return x < this.len && ((this.setBits[x >>> 5] >>> (x & 31)) & 1) === 1
  }
  hiE() {
    return this.len
  }
  isXv(x: number) {
    return this.XI.has(x)
  }
  isVoid(x: number) {
    return this.VI.has(x)
  }
  isEff(x: number) {
    return this.EI.has(x)
  }
}

const lru = new Map<object, unknown>()
const LRU_CAP = 16
function lruGet<T>(k: object, make: () => T): T {
  if (lru.has(k)) {
    const v = lru.get(k) as T
    lru.delete(k)
    lru.set(k, v)
    return v
  }
  const v = make()
  lru.set(k, v)
  if (lru.size > LRU_CAP) lru.delete(lru.keys().next().value!)
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

function snapFacts(V: SnapView | SubView): Facts {
  const ix = V.ix
  const full = () => lruGet(V, () => fullFacts(V.fresh()))
  const inv = (T: string) => {
    const l = V.invited(T)
    return l.length ? l : undefined
  }
  const devsOf = (a: string) => {
    const s = new Set<string>()
    for (const x of ix.introBy.get(a) ?? EMPTY)
      if (V.live(x)) for (const v of introduces(ix.ev[x])) if (!V.revoked(v)) s.add(v)
    return s.size ? s : undefined
  }
  const codeLive = (c: string) => {
    const x = ix.codeEv.get(c)
    return x !== undefined && V.inE(x)
  }
  const codeOf = (c: string): CodeFact | undefined => {
    const x = ix.codeEv.get(c)
    if (x === undefined || !V.inE(x) || !V.codeOk(c) || V.codeDead(c)) return undefined
    return { id: c, a: ix.ev[x].a, dev: ix.ev[x].dev, k: ix.k(x) }
  }
  const bitsOf = (R: string) =>
    R === EVERYONE ? (V.bits(EVERYONE) ?? 0) : V.role(R) ? (V.bits(R) ?? 0) : undefined
  const pend = (T: string): readonly Pend[] | undefined => {
    const l = inv(T)
    return l && !V.mem(T) && !V.ban(T) ? l : undefined
  }
  const consumed = (g: string) => {
    const i = ix.at.get(g)
    if (i === undefined || !V.inE(i) || ix.ev[i].t !== 'add') return false
    return V.consumedIdx(i)
  }
  const holdsOf = (T: string) => {
    const h = V.holds(T)
    return h.size ? h : undefined
  }
  const addsOf = (T: string) => {
    const l = V.addsTo(T)
    return l.length ? l : undefined
  }
  const overwritesOf = (ch: string) => full().overwrites.get(ch)
  return {
    owners: ix.owners,
    get upgraded() {
      return ix.upgradeEv.filter(x => V.inE(x)).map(x => ix.ids[x])
    },
    mem: lazySet(
      T => V.mem(T),
      () => full().mem as ReadonlySet<string>
    ),
    ban: lazySet(
      T => V.ban(T),
      () => full().ban as ReadonlySet<string>
    ),
    effBanK: lazyMap(
      T => V.effBanK(T) !== undefined,
      T => V.effBanK(T),
      () => full().effBanK as ReadonlyMap<string, readonly Rank[]>
    ),
    invited: lazyMap(
      T => inv(T) !== undefined,
      inv,
      () => full().invited as ReadonlyMap<string, readonly Pend[]>
    ),
    pending: lazyMap(
      T => pend(T) !== undefined,
      pend,
      () => full().pending as ReadonlyMap<string, readonly Pend[]>
    ),
    roles: lazySet(
      R => V.role(R),
      () => full().roles as ReadonlySet<string>
    ),
    pos: lazyMap(
      R => V.pos(R) !== undefined,
      R => V.pos(R),
      () => full().pos as ReadonlyMap<string, number>
    ),
    bits: lazyMap(
      R => bitsOf(R) !== undefined,
      bitsOf,
      () => full().bits as ReadonlyMap<string, number>
    ),
    holds: lazyMap(
      T => holdsOf(T) !== undefined,
      holdsOf,
      () => full().holds as ReadonlyMap<string, ReadonlySet<string>>
    ),
    devs: lazyMap(
      a => devsOf(a) !== undefined,
      devsOf,
      () => full().devs as ReadonlyMap<string, ReadonlySet<string>>
    ),
    revoked: lazySet(
      v => V.revoked(v),
      () => full().revoked as ReadonlySet<string>
    ),
    codes: lazyMap(
      c => codeOf(c) !== undefined,
      codeOf,
      () => full().codes as ReadonlyMap<string, CodeFact>
    ),
    codeIssuer: lazyMap(
      c => V.codeIssuer(c) !== undefined,
      c => V.codeIssuer(c),
      () => full().codeIssuer as ReadonlyMap<string, string>
    ),
    profile: lazyMap(
      T => V.profileOf(T) !== undefined,
      T => V.profileOf(T),
      () => full().profile as ReadonlyMap<string, AclContent>
    ),
    get setting() {
      return V.setting()
    },
    channels: lazyMap(
      id => V.channel(id) !== undefined,
      id => V.channel(id),
      () => full().channels as ReadonlyMap<string, AclContent>
    ),
    overwrites: lazyMap(
      ch => overwritesOf(ch) !== undefined,
      overwritesOf,
      () => full().overwrites as ReadonlyMap<string, ReadonlyMap<string, AclContent>>
    ),
    addsTo: lazyMap(
      T => addsOf(T) !== undefined,
      addsOf,
      () => full().addsTo as ReadonlyMap<string, readonly Pend[]>
    ),
    consumed: lazySet(consumed, () => full().consumed as ReadonlySet<string>),
    codeOk: lazySet(
      c => codeLive(c) && V.codeOk(c),
      () => full().codeOk as ReadonlySet<string>
    ),
    codeDead: lazySet(
      c => codeLive(c) && V.codeDead(c),
      () => full().codeDead as ReadonlySet<string>
    ),
    from: fromOf(ix),
  }
}

// EvalResult of `fe` after its first `len` events, sharing fe's arrays.
export function snapResult(fe: FastEval, len: number): EvalResult {
  const ix = fe.ix
  const V = new SnapView(ix, fe, len)
  const at = (id: string) => {
    const i = ix.at.get(id)
    return i !== undefined && i < len && fe.inS(i) ? i : -1
  }
  const list = (p: (i: number) => boolean) => () =>
    lruGet(p, () => {
      const s = new Set<string>()
      for (const i of fe.order) {
        if (i >= len) break
        if (p(i)) s.add(ix.ids[i])
      }
      return s
    })
  const pX = (i: number) => fe.X[i] === 1
  const pT = (i: number) => fe.tail[i] === 1
  const pC = (i: number) => fe.cutOrd[i] >= 0
  const pE = (i: number) => fe.isEffI(i)
  const pV = (i: number) => pX(i) || pT(i) || pC(i)
  const set = (p: (i: number) => boolean) =>
    lazySet((id: string) => {
      const i = at(id)
      return i >= 0 && p(i)
    }, list(p))
  const cutAll = () =>
    lruGet(pC, () => {
      const m = new Map<string, Rank>()
      for (const i of fe.order) {
        if (i >= len) break
        if (pC(i)) m.set(ix.ids[i], fe.cutRank[i]!)
      }
      return m
    })
  const idx: StIdx = {
    ix,
    X: i => i < len && fe.inS(i) && pX(i),
    void: i => i < len && fe.inS(i) && pV(i),
    eff: i => i < len && fe.inS(i) && pE(i),
    ep: fe.epoch(),
  }
  return {
    facts: snapFacts(V),
    X: set(pX),
    tail: set(pT),
    eff: set(pE),
    void: set(pV),
    cut: lazyMap(
      (id: string) => {
        const i = at(id)
        return i >= 0 && pC(i)
      },
      (id: string) => {
        const i = at(id)
        return i >= 0 && pC(i) ? fe.cutRank[i] : undefined
      },
      cutAll
    ),
    F: fe.F,
    FI: fe.FI,
    RF: fe.RF,
    PC: fe.PC,
    idx,
  }
}

// The final state of a subset evaluation (an admission state St(e) = Eval(C(ap)) off the heads):
// its sets are small, its facts are keyed views over a packed copy of the subset.
export function subsetResult(fe: FastEval): EvalResult {
  const ix = fe.ix
  const n = ix.n
  const bitsP = new Uint32Array((n + 31) >>> 5)
  const XI = new Set<number>()
  const VI = new Set<number>()
  const EI = new Set<number>()
  const X = new Set<string>()
  const tail = new Set<string>()
  const cut = new Map<string, Rank>()
  const eff = new Set<string>()
  const voidS = new Set<string>()
  for (const i of fe.order) {
    bitsP[i >>> 5] |= 1 << (i & 31)
    const id = ix.ids[i]
    if (fe.X[i]) {
      X.add(id)
      XI.add(i)
    }
    if (fe.tail[i]) tail.add(id)
    if (fe.cutOrd[i] >= 0) cut.set(id, fe.cutRank[i]!)
    if (fe.isVoidI(i)) {
      VI.add(i)
      voidS.add(id)
    }
    if (fe.isEffI(i)) {
      EI.add(i)
      eff.add(id)
    }
  }
  const V = new SubView(ix, bitsP, XI, VI, EI, n)
  const idx: StIdx = {
    ix,
    X: i => XI.has(i),
    void: i => VI.has(i),
    eff: i => EI.has(i),
    ep: { key: EI, eff: i => EI.has(i) },
  }
  return {
    facts: snapFacts(V),
    X,
    tail,
    cut,
    eff,
    void: voidS,
    F: fe.F,
    FI: fe.FI,
    RF: fe.RF,
    PC: fe.PC,
    idx,
  }
}

// The client's evaluator state (§5): one append-only index of every admitted ACL event, the
// current Eval(S), and the admission states St(e) = Eval(C(ap)) through a merge cache.
export class AclState {
  ix: Ix
  private fe?: FastEval
  private cur?: EvalResult
  cache = new Map<string, EvalResult>()
  cap = 4096
  stats = { head: 0, full: 0, subsets: 0, hits: 0 }
  constructor(public cx: Ctx) {
    this.ix = new Ix(cx)
  }
  // The current Eval(S) of every indexed event.
  state(): EvalResult {
    if (!this.cur) {
      this.fe = new FastEval(this.ix)
      this.cur = this.fe.run()
    }
    return this.cur
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
      r = subsetResult(fe)
      this.stats.subsets++
    }
    this.cache.set(key, r)
    if (this.cache.size > this.cap) this.cache.delete(this.cache.keys().next().value!)
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
      this.ix.closure(ev.ap).size === this.ix.n
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
