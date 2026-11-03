import { Equiv, seenOf } from './equivocation'
import { fullFacts, View, type EvalResult, type FactsQ, type StIdx } from './facts'
import { chainCover, EMPTY, firstTrue, Ix, pushM } from './reach'
import {
  BOT,
  cmp,
  deviceOk,
  EVERYONE,
  exposedTo,
  gt,
  isRevocationT,
  isWithdrawalT,
  KICK,
  LIM,
  minR,
  NEG,
  permsQ,
  protectedTarget,
  rkey,
  target,
  TOP,
  authCore,
  type AclEv,
  type AuthCtx,
  type Ctx,
  type Rank,
} from './rules'

// Eval(S) (spec §3.1, §5): the stratified evaluation over an index, a port of
// notes/acl-model/fast.ts. Views are keyed and lazy (facts.ts); every authority check of §3.1 is
// such a view.

const B0 = BigInt(0)
const B1 = BigInt(1)
const bit = (i: number) => B1 << BigInt(i)

// Decisions of the strata above the one being processed, and this stratum's cuts so far.
export interface Strat {
  s: number
  kk: Rank
  K(x: number): boolean
  here(x: number): boolean
  voidK(x: number): boolean
  high(x: number): boolean
  inS(x: number): boolean
  isX(x: number): boolean
}

export type NPred = ((x: number) => boolean) | null
const EMPTYSET = new Set<number>()

// What an authority check is anchored at: an indexed operation o (B(o), St(o)), or a content
// event (C(m.ap), St(m)), which is never in the index.
export interface Anchor {
  e: AclEv
  inB(x: number): boolean
  hi: number
  lo: EvalResult
  li?: StIdx
}

const anchors = new WeakMap<Ix, Map<number, Anchor>>()
export function anchorOf(ix: Ix, o: number): Anchor {
  let m = anchors.get(ix)
  if (!m) anchors.set(ix, (m = new Map()))
  let a = m.get(o)
  if (!a) {
    const lo = ix.rec[o].local
    const li = lo.idx
    const ok = li && li.ix.ids[o] === ix.ids[o] && (o === 0 || li.ix.ids[o - 1] === ix.ids[o - 1])
    a = { e: ix.ev[o], inB: x => ix.has(o, x), hi: o, lo, li: ok ? li : undefined }
    m.set(o, a)
  }
  return a
}

// V_o(K ∪ N, +D) (mode R, resources) and V°_o(K, N) (mode O, obstacles) of §3.1.
export class OpView extends View {
  ovX = -1
  ovP = 0
  constructor(
    ix: Ix,
    public an: Anchor,
    public st: Strat | null,
    public mode: 'R' | 'O',
    public N: NPred,
    public extra: Set<number>
  ) {
    super(ix)
  }
  posAt(x: number) {
    return x === this.ovX ? this.ovP : this.ix.ev[x].c.pos
  }
  private recorded(x: number) {
    const li = this.an.li
    return li !== undefined && x < this.an.hi && li.ix.ids[x] === this.ix.ids[x] ? li : undefined
  }
  loVoid(x: number) {
    const li = this.recorded(x)
    return li ? li.void(x) : this.an.lo.void.has(this.ix.ids[x])
  }
  loEff(x: number) {
    const li = this.recorded(x)
    return li ? li.eff(x) : this.an.lo.eff.has(this.ix.ids[x])
  }
  inE(x: number) {
    return this.an.inB(x) || this.extra.has(x)
  }
  hiE() {
    return this.an.hi
  }
  extraE() {
    return this.extra
  }
  isXv(x: number) {
    const li = this.recorded(x)
    return li ? li.X(x) : this.an.lo.X.has(this.ix.ids[x])
  }
  isVoid(x: number) {
    if (this.loVoid(x)) return true
    if (this.ix.isD[x] || !this.an.inB(x) || !this.st) return false
    if (this.st.K(x)) return true
    return this.mode === 'R' && this.N !== null && this.N(x)
  }
  isEff(x: number) {
    if (this.mode === 'R') return this.extra.has(x) || this.loEff(x)
    if (!this.loEff(x)) return false
    if (!this.ix.isD[x] || !this.st) return true
    if (this.st.K(x)) return false
    return !(this.N !== null && this.N(x))
  }
}

// V_γ (later = null) and V_γ^p (later = the decisions after p, removed).
export class CauseView extends View {
  constructor(
    ix: Ix,
    public g: number,
    public st: Strat,
    public later: Set<number> | null
  ) {
    super(ix)
  }
  inE(x: number) {
    return this.st.inS(x) && !this.ix.has(x, this.g)
  }
  isXv(x: number) {
    return this.st.isX(x)
  }
  isVoid(x: number) {
    return this.st.voidK(x)
  }
  isEff(x: number) {
    return this.st.high(x) && !(this.later !== null && this.later.has(x))
  }
}

// The final state: S with X ∪ cut ∪ Tail voided and the effective denies.
class FullView extends View {
  constructor(
    ix: Ix,
    public voidA: Uint8Array,
    public effA: Uint8Array,
    public mS: Uint8Array | null,
    public XA: Uint8Array
  ) {
    super(ix)
  }
  inE(x: number) {
    return this.mS === null || this.mS[x] === 1
  }
  isXv(x: number) {
    return this.XA[x] === 1
  }
  isVoid(x: number) {
    return this.voidA[x] === 1
  }
  isEff(x: number) {
    return this.effA[x] === 1
  }
}

// w beats w2 in the stratified register: the higher k, then the lower pos, then the lower id.
export function beatsI(ix: Ix, w: number, w2: number): boolean {
  const c = cmp(ix.k(w), ix.k(w2))
  if (c !== 0) return c > 0
  const p = ix.ev[w].c.pos
  const p2 = ix.ev[w2].c.pos
  return p < p2 || (p === p2 && ix.ids[w] < ix.ids[w2])
}

// The position hull over L* (`star`) and its non-removable writes (`tops`): a write w is the
// value for some removal set iff every top that beats w is below w or below a write of L* that
// is not after w and does not beat w (§3.1 PosHull, §5).
export function hullFromStar(
  ix: Ix,
  star: number[],
  tops: number[],
  dir: 'min' | 'max'
): number | undefined {
  const pos = (x: number) => ix.ev[x].c.pos
  const cand = [...star].sort((a, b) => (dir === 'min' ? pos(a) - pos(b) : pos(b) - pos(a)))
  for (const w of cand) {
    let ok = true
    for (const y of tops) {
      if (y === w || !beatsI(ix, y, w) || ix.before(y, w)) continue
      let cov = false
      for (const k of star)
        if (k !== w && ix.before(y, k) && !ix.before(w, k) && !beatsI(ix, k, w)) {
          cov = true
          break
        }
      if (!cov) {
        ok = false
        break
      }
    }
    if (ok) return pos(w)
  }
  return undefined
}

// The monotone authority context of §3.1 (authorized_{K,N}(o, +D)) over keyed lazy views.
export class Mono {
  Fr: OpView
  Fo: OpView
  private meV?: Rank
  private memoR = new Map<string, Rank>()
  constructor(
    public ix: Ix,
    public an: Anchor,
    public st: Strat | null,
    public N: NPred,
    public extra: Set<number>
  ) {
    this.Fr = new OpView(ix, an, st, 'R', N, extra)
    this.Fo = new OpView(ix, an, st, 'O', N, EMPTYSET)
  }
  resetMe() {
    this.meV = undefined
  }
  // PosHull over the writes `inL` of R with removable writes `rem`: null when L* holds no
  // removable write (then the hull is the plain register value).
  private hullScan(
    R: string,
    inL: (x: number) => boolean,
    rem: (x: number) => boolean,
    dir: 'min' | 'max',
    extra: Iterable<number>
  ): number | undefined | null {
    const ix = this.ix
    const hi0 = this.an.hi
    const ws = ix.posW.get(R) ?? EMPTY
    const cov = ix.posCov(R)
    const star: number[] = []
    const tops: number[] = []
    let anyRem = false
    let stop = false
    const take = (x: number, k: number) => {
      for (const y of tops) if (ix.before(x, y)) return
      star.push(x)
      if (rem(x)) anyRem = true
      else {
        tops.push(x)
        if (cov[k]) stop = true
      }
    }
    let a = 0
    let b = ws.length
    while (a < b) {
      const m = (a + b) >> 1
      if (ws[m] < hi0) a = m + 1
      else b = m
    }
    const ex: number[] = []
    for (const x of extra) if (x >= hi0) ex.push(x)
    ex.sort((p, q) => q - p)
    for (const x of ex) {
      let lo = a
      let hi = ws.length
      while (lo < hi) {
        const m = (lo + hi) >> 1
        if (ws[m] < x) lo = m + 1
        else hi = m
      }
      if (lo < ws.length && ws[lo] === x && inL(x)) take(x, lo)
      if (stop) break
    }
    for (let k = a - 1; k >= 0 && !stop; k--) if (inL(ws[k])) take(ws[k], k)
    if (!anyRem) return null
    return hullFromStar(ix, star, tops, dir)
  }
  // The author's rank as a resource (rankRes): PosHull⁻ over N's cut position grants of a held role.
  me(): Rank {
    if (this.meV) return this.meV
    const ix = this.ix
    const a = this.an.e.a
    const Fr = this.Fr
    let me: Rank
    if (ix.owners.has(a)) me = TOP
    else if (!Fr.mem(a)) me = NEG
    else {
      me = BOT
      for (const R of Fr.holds(a)) {
        let p = Fr.pos(R) ?? -1
        if (this.N) {
          const st = this.st!
          const N = this.N
          const an = this.an
          const inL = (x: number) => {
            if (!Fr.inE(x)) return false
            const inB = an.inB(x)
            const bv = Fr.loVoid(x) || (inB && !ix.isD[x] && st.K(x))
            if (ix.ev[x].t === 'role_create') return ix.ids[x] === R && !bv
            return this.extra.has(x) || Fr.loEff(x) || (!bv && ix.rec[x].cls === 'G')
          }
          const rem = (x: number) =>
            ix.ev[x].t === 'role_move' && !ix.isD[x] && an.inB(x) && !st.K(x) && N(x)
          const h = this.hullScan(R, inL, rem, 'min', this.extra)
          if (h !== null) p = h ?? p
        }
        if (gt([p, R], me)) me = [p, R]
      }
    }
    return (this.meV = me)
  }
  obsRankOf(R: string): Rank {
    if (R === EVERYONE) return BOT
    let r = this.memoR.get(R)
    if (r) return r
    const Fo = this.Fo
    let p = Fo.pos(R) ?? -1
    if (this.N) {
      const ix = this.ix
      const st = this.st!
      const N = this.N
      const an = this.an
      const rem = (x: number) =>
        ix.ev[x].t === 'role_move' && ix.isD[x] && an.inB(x) && !st.K(x) && N(x)
      const inL = (x: number) => {
        if (!an.inB(x)) return false
        if (ix.ev[x].t === 'role_create') return ix.ids[x] === R && !Fo.isVoid(x)
        return rem(x) || Fo.isEff(x) || (!Fo.isVoid(x) && ix.rec[x].cls === 'G')
      }
      const h = this.hullScan(R, inL, rem, 'max', EMPTY)
      if (h !== null) p = h ?? p
    }
    this.memoR.set(R, (r = [p, R]))
    return r
  }
  rankT(T: string): Rank {
    if (this.ix.owners.has(T)) return TOP
    if (!this.Fo.mem(T)) return NEG
    let r: Rank = BOT
    for (const R of this.Fo.holds(T)) {
      const q = this.obsRankOf(R)
      if (gt(q, r)) r = q
    }
    return r
  }
  ctx(): AuthCtx {
    const me = () => this.me()
    return {
      Fr: this.Fr.facts(),
      Fo: this.Fo.facts(),
      get me() {
        return me()
      },
      rankOf: R => this.obsRankOf(R),
      rankT: T => this.rankT(T),
    }
  }
  authorized(): boolean {
    const e = this.an.e
    return deviceOk(e, this.Fr.facts()) && authCore(e, this.ctx())
  }
  // Authorized with the author's rank at its floor and every obstacle rank at its ceiling: if
  // this holds, the op is authorized under any cuts that are all role moves (§5 "Flat closure").
  floorAuthorized(): boolean {
    const ix = this.ix
    const e = this.an.e
    const a = e.a
    const Fr = this.Fr
    const Fo = this.Fo
    const me: Rank = ix.owners.has(a) ? TOP : Fr.mem(a) ? BOT : NEG
    const ctx: AuthCtx = {
      Fr: Fr.facts(),
      Fo: Fo.facts(),
      me,
      rankOf: (R: string): Rank => (R === EVERYONE ? BOT : TOP),
      rankT: (T: string): Rank =>
        ix.owners.has(T) ? TOP : !Fo.mem(T) ? NEG : Fo.holds(T).size ? TOP : BOT,
    }
    return deviceOk(e, ctx.Fr) && authCore(e, ctx)
  }
}

export interface EvalStats {
  strata: number
  causes: number
  maxCauses: number
  brokenTests: number
  worlds: number
  fallbacks: number
  maxClasses: number
  maxRegion: number
  maxFlat: number
  probes: number
  terms: number
  floorSkips: number
}

// What a stratum leaves for content visibility (§3.5 cascadeCut): its causes, which of the
// stratum's cuts a world of causes makes on its own, and the exposure of an author to a cause.
export interface StratumInfo {
  s: number
  kk: Rank
  st: Strat
  causes: number[]
  inW(x: number, W: bigint): boolean
  exposed(p: AclEv, g: number): boolean
}

// Eval(S) over an index.
export class FastEval extends Equiv {
  cutOrd: number[] = []
  cutRank: (Rank | undefined)[] = []
  effOrd: number[] = []
  effRank: (Rank | undefined)[] = []
  strataInfo: StratumInfo[] = []
  stats: EvalStats = {
    strata: 0,
    causes: 0,
    maxCauses: 0,
    brokenTests: 0,
    worlds: 0,
    fallbacks: 0,
    maxClasses: 0,
    maxRegion: 0,
    maxFlat: 0,
    probes: 0,
    terms: 0,
    floorSkips: 0,
  }
  private maxPos = new Map<string, number>()

  // The highest position any write in S gives role R (an upper bound in every view), or -1.
  maxPosOf(R: string): number {
    let m = this.maxPos.get(R)
    if (m === undefined) {
      m = -1
      for (const x of this.ix.posW.get(R) ?? EMPTY) m = Math.max(m, this.ix.ev[x].c.pos)
      this.maxPos.set(R, m)
    }
    return m
  }
  // An upper bound of rank(P) in every view of S.
  rankBound(P: string): Rank {
    if (this.ix.owners.has(P)) return TOP
    let r: Rank = BOT
    for (const R of this.ix.everHeld.get(P) ?? []) {
      const q: Rank = [this.maxPosOf(R), R]
      if (gt(q, r)) r = q
    }
    return r
  }

  private highByTarget = new Map<string, number[]>()
  private highByRole = new Map<string, number[]>()
  private noteEffective(d: number) {
    const e = this.ix.ev[d]
    if (e.t === 'kick' || e.t === 'ban' || e.t === 'revoke') pushM(this.highByTarget, e.c.to, d)
    else if (e.t === 'leave') pushM(this.highByTarget, e.a, d)
    else if (e.t === 'role_move' || e.t === 'role_bits' || e.t === 'role_del')
      pushM(this.highByRole, e.c.role, d)
  }
  // The effective denies against member P: kick, ban and revoke of P, and P's own leave.
  againstMember(P: string): readonly number[] {
    return this.highByTarget.get(P) ?? EMPTY
  }
  // The effective higher denies that can change P's rank: the only ones that matter for k* and V_γ^p.
  relevantHighs(P: string): number[] {
    const out = [...(this.highByTarget.get(P) ?? EMPTY)]
    for (const R of this.ix.everHeld.get(P) ?? [])
      for (const d of this.highByRole.get(R) ?? EMPTY) out.push(d)
    return out
  }
  // frontier(o, d): o did not see d as effective.
  frontier(o: number, d: number) {
    const ix = this.ix
    if (o === d || ix.has(d, o)) return false
    if (!ix.has(o, d)) return true
    const lo = ix.rec[o].local
    const li = lo.idx
    return !(li && li.ix.ids[d] === ix.ids[d] ? li.eff(d) : lo.eff.has(ix.ids[d]))
  }

  compute() {
    const ix = this.ix
    const n = ix.n
    this.forkPoints()
    this.voidSet()
    const revs = this.tails()
    const X = this.X
    const tail = this.tail
    this.cutOrd = new Array(n).fill(-1)
    this.cutRank = new Array(n).fill(undefined)
    this.effOrd = new Array(n).fill(-2)
    this.effRank = new Array(n).fill(undefined)
    for (const r of revs) this.effOrd[r] = -1
    const strataMap = new Map<string, Rank>()
    const tailAt = new Map<string, number[]>()
    for (const i of this.order) {
      const k = ix.k(i)
      if (tail[i]) {
        strataMap.set(rkey(k), k)
        pushM(tailAt, rkey(k), i)
      } else if (!X[i] && ix.isD[i] && !ix.fixed[i]) strataMap.set(rkey(k), k)
    }
    const strata = [...strataMap.values()].sort((a, b) => cmp(b, a))
    this.stats.strata = strata.length
    for (let s = 0; s < strata.length; s++)
      this.stratum(s, strata[s], tailAt.get(rkey(strata[s])) ?? EMPTY)
  }

  run(): EvalResult {
    this.compute()
    return this.result()
  }

  private stratum(s: number, kk: Rank, tailHere: readonly number[]) {
    const ix = this.ix
    const X = this.X
    const tail = this.tail
    const cutOrd = this.cutOrd
    const effOrd = this.effOrd
    const st: Strat = {
      s,
      kk,
      K: x => cutOrd[x] >= 0 && cutOrd[x] < s,
      here: x => cutOrd[x] === s,
      voidK: x => X[x] === 1 || tail[x] === 1 || (cutOrd[x] >= 0 && cutOrd[x] < s),
      high: x => effOrd[x] >= -1 && effOrd[x] < s,
      inS: x => this.inS(x),
      isX: x => X[x] === 1,
    }
    const alive = (i: number) => this.inS(i) && cutOrd[i] < 0 && !ix.fixed[i]
    const liveDeny = (i: number) => alive(i) && !X[i] && !tail[i] && ix.isD[i]
    const atK = (i: number) => cmp(ix.k(i), kk) === 0
    const ksMemo = new Map<number, Rank>()
    const kstar = (o: number, N: NPred): Rank => {
      if (ix.isD[o]) return ix.k(o)
      if (!N) {
        const v = ksMemo.get(o)
        if (v) return v
      }
      const extra = new Set<number>()
      for (const d of this.relevantHighs(ix.ev[o].a)) if (this.frontier(o, d)) extra.add(d)
      const v = minR(ix.k(o), new Mono(ix, anchorOf(ix, o), st, N, extra).me())
      if (!N) ksMemo.set(o, v)
      return v
    }
    const below = (o: number, N: NPred = null) =>
      cmp(ix.k(o), kk) < 0 || (!ix.isD[o] && cmp(kstar(o, N), kk) < 0)
    const atOrBelow = (o: number) =>
      cmp(ix.k(o), kk) <= 0 || (!ix.isD[o] && cmp(kstar(o, null), kk) <= 0)
    const authKMemo = new Map<number, boolean>()
    const authKMono = new Map<number, Mono>()
    const authorizedK = (o: number) => {
      let v = authKMemo.get(o)
      if (v === undefined) {
        const M = new Mono(ix, anchorOf(ix, o), st, null, EMPTYSET)
        authKMono.set(o, M)
        authKMemo.set(o, (v = M.authorized()))
      }
      return v
    }
    const floorK = (o: number) => {
      authorizedK(o)
      return authKMono.get(o)!.floorAuthorized()
    }
    const usesExact = (o: number, d: number) =>
      !new Mono(ix, anchorOf(ix, o), st, null, new Set([d])).authorized()
    // (§5 "Role-wide denies") a deny on a role that o has not seen changes o's resources only
    // through the role: memoized per op and per (R, b) or R; a covering move is monotone in its
    // position, so each op keeps the highest position known to break it and the lowest not to.
    const sigMemo = new Map<number, Map<string, boolean>>()
    const ivl = new Map<number, Map<string, [number, number]>>()
    const mxMemo = new Map<string, number[]>()
    const maxW = (o: number, R: string): number[] => {
      const key = `${o}|${R}`
      let m = mxMemo.get(key)
      if (m) return m
      m = []
      const ws = ix.posW.get(R) ?? EMPTY
      const cov = ix.posCov(R)
      let a = 0
      let b = ws.length
      while (a < b) {
        const h = (a + b) >> 1
        if (ws[h] < o) a = h + 1
        else b = h
      }
      for (let k = a - 1; k >= 0; k--) {
        const x = ws[k]
        if (!ix.has(o, x)) continue
        let dom = false
        for (const y of m)
          if (ix.has(y, x)) {
            dom = true
            break
          }
        if (dom) continue
        m.push(x)
        if (cov[k]) break
      }
      mxMemo.set(key, m)
      return m
    }
    const uses = (o: number, d: number) => {
      if (!authorizedK(o)) return false
      const de = ix.ev[d]
      if (ix.has(o, d)) return usesExact(o, d)
      if (de.t === 'role_del' || (de.t === 'role_bits' && !de.c.on)) {
        const key = de.t === 'role_del' ? `d|${de.c.role}` : `b|${de.c.role}|${de.c.bit}`
        let m = sigMemo.get(o)
        if (!m) sigMemo.set(o, (m = new Map()))
        let v = m.get(key)
        if (v === undefined) m.set(key, (v = usesExact(o, d)))
        return v
      }
      if (de.t === 'role_move') {
        const R = de.c.role
        for (const x of maxW(o, R)) if (!ix.has(d, x)) return usesExact(o, d)
        const p = de.c.pos
        let m = ivl.get(o)
        if (!m) ivl.set(o, (m = new Map()))
        let iv = m.get(R)
        if (!iv) m.set(R, (iv = [Infinity, -Infinity]))
        if (p >= iv[0]) return false
        if (p <= iv[1]) return true
        const v = usesExact(o, d)
        if (v) iv[1] = Math.max(iv[1], p)
        else iv[0] = Math.min(iv[0], p)
        return v
      }
      return usesExact(o, d)
    }
    const vMemo = new Map<string, CauseView>()
    const Vof = (g: number) => {
      const key = `${g}`
      let v = vMemo.get(key)
      if (!v) vMemo.set(key, (v = new CauseView(ix, g, st, null)))
      return v
    }
    const Vfor = (g: number, p: number) => {
      const later = this.relevantHighs(ix.ev[p].a)
        .filter(d => ix.has(d, p))
        .sort((a, b) => a - b)
      if (!later.length) return Vof(g)
      const key = `${g}|${later.join(',')}`
      let v = vMemo.get(key)
      if (!v) vMemo.set(key, (v = new CauseView(ix, g, st, new Set(later))))
      return v
    }
    const exposedE = (pe: AclEv, g: number, V: () => View): boolean => {
      const ge = ix.ev[g]
      const P = pe.a
      if (ix.owners.has(P)) return false
      const ub = this.rankBound(P)
      if (isRevocationT(ge.t)) {
        if (!gt(ub, kk)) return true
      } else if (pe.t === 'join') {
        if (isWithdrawalT(ge.t) && !(permsQ(ix.rec[g].local.facts, ge.a) & KICK)) return false
        if (cmp(ub, kk) < 0) return true
      } else if (!gt(ub, kk)) return true
      return exposedTo(pe, ge, ix.rec[g], V().facts(), kk)
    }
    const exposed = (p: number, g: number, V: () => View) => exposedE(ix.ev[p], g, V)
    const direct = new Map<number, number[]>()
    const addD = (g: number, o: number) => pushM(direct, g, o)

    // 0. revocation cuts: tail ops at this stratum, attributed to every revocation whose tail holds them
    for (const o of tailHere) if (alive(o)) for (const r of this.tailBy.get(o)!) addD(r, o)

    // 1. self-denies at kk: effective; they cut their author's ops that did not see them
    const denies = ix.deniesAt.get(rkey(kk)) ?? EMPTY
    const selves = denies.filter(d => liveDeny(d) && ix.isSelfD[d] && atK(d))
    const selfCuts = new Set<number>()
    for (const sd of selves) {
      for (const o of ix.byAuthor.get(ix.ev[sd].a) ?? EMPTY) {
        if (!alive(o) || o === sd || ix.isSelfD[o]) continue
        if (!atOrBelow(o) || !this.frontier(o, sd)) continue
        if (uses(o, sd)) {
          selfCuts.add(o)
          addD(sd, o)
        }
      }
    }

    // 2. other denies at kk: effective unless their target is protected in V_d
    const effNS = denies.filter(
      d =>
        liveDeny(d) &&
        !ix.isSelfD[d] &&
        atK(d) &&
        !selfCuts.has(d) &&
        !this.protectedFast(d, kk, Vof)
    )

    // 3. frontier cuts over the readers of what the deny can take away
    const stamp = new Int32Array(ix.n).fill(-1)
    const byRoleMv = new Map<string, number[]>()
    const byClr = new Map<string, number[]>()
    const order3: number[] = []
    for (const d of effNS) {
      const de = ix.ev[d]
      if (de.t === 'role_move') pushM(byRoleMv, de.c.role, d)
      else if (de.t === 'role_del') pushM(byClr, `d|${de.c.role}`, d)
      else if (de.t === 'role_bits' && !de.c.on) pushM(byClr, `b|${de.c.role}|${de.c.bit}`, d)
      else order3.push(d)
    }
    for (const d of order3) {
      const de = ix.ev[d]
      const tg = target(de, ix.rec[d].local.facts)
      const visit = (o: number) => {
        if (stamp[o] === d) return
        stamp[o] = d
        if (!alive(o) || !this.frontier(o, d)) return
        const sameTarget = !ix.isD[o] && tg.kind === 'member' && ix.ev[o].a === tg.who
        if (!(sameTarget ? atOrBelow(o) : below(o))) return
        if (!exposed(o, d, () => (sameTarget ? Vof(d) : Vfor(d, o)))) return
        if (uses(o, d)) addD(d, o)
      }
      this.readers(d, visit)
    }
    const monoK = (o: number) => {
      authorizedK(o)
      return authKMono.get(o)!
    }
    const mv = this.chainCuts(
      byRoleMv,
      byClr,
      st,
      alive,
      below,
      authorizedK,
      exposed,
      Vfor,
      uses,
      maxW,
      ivl,
      addD,
      monoK
    )

    // 4. the cascade with exact per-cause protection (§3.1 step 4, §3.1.1)
    const causeSet = new Set<number>(
      [...selves, ...effNS].filter(g => direct.has(g) || mv.cutBy.has(g))
    )
    for (const g of direct.keys()) if (isRevocationT(ix.ev[g].t)) causeSet.add(g)
    const byId = (a: number, b: number) =>
      ix.ids[a] < ix.ids[b] ? -1 : ix.ids[a] > ix.ids[b] ? 1 : 0
    const causes = [...causeSet].filter(g => !mv.inBlock(g)).sort(byId)
    const termDc = mv.masks(causes, causeSet)
    this.stats.causes += causes.length
    this.stats.maxCauses = Math.max(this.stats.maxCauses, causes.length)
    if (causes.length) {
      const inW = this.cascade(
        st,
        causes,
        direct,
        alive,
        authorizedK,
        below,
        exposed,
        Vfor,
        termDc,
        floorK
      )
      this.strataInfo.push({
        s,
        kk,
        st,
        causes,
        inW,
        exposed: (pe, g) => exposedE(pe, g, () => Vof(g)),
      })
    }
    for (const d of [...selves, ...effNS]) {
      effOrd[d] = s
      this.effRank[d] = kk
      this.noteEffective(d)
    }
  }

  // Step 3 for the effective moves, bit clears and deletions at this stratum (§5.2, §5.4 B): per
  // role (per role and bit, for clears) they are split into chains per author and device, and
  // each reader is matched against each chain by binary search. The cuts of a mover chain's
  // covering range are a range term (chain, lo, hi, r) found by probes; those of a clearer
  // chain's concurrent range are one role-wide `uses` test, a term without threshold.
  private chainCuts(
    byRoleMv: Map<string, number[]>,
    byClr: Map<string, number[]>,
    st: Strat,
    alive: (i: number) => boolean,
    below: (o: number, N?: NPred) => boolean,
    authorizedK: (o: number) => boolean,
    exposed: (p: number, g: number, V: () => View) => boolean,
    Vfor: (g: number, p: number) => View,
    uses: (o: number, d: number) => boolean,
    maxW: (o: number, R: string) => number[],
    ivl: Map<number, Map<string, [number, number]>>,
    addD: (g: number, o: number) => void,
    monoK: (o: number) => Mono
  ) {
    const ix = this.ix
    const kk = st.kk
    interface Ch {
      c: number[]
      rk: Int32Array
      role: number
    }
    interface Rl {
      gs: number[]
      terms: boolean
    }
    const chains: Ch[] = []
    const roles: Rl[] = []
    const terms = new Map<number, number[]>()
    const epL = new Map<object, Map<number, Int32Array | null>>()
    const neList = (o: number, ci: number): Int32Array | null => {
      const li = ix.rec[o].local.idx
      if (!li || !li.ep) return null
      let m = epL.get(li.ep.key)
      if (!m) epL.set(li.ep.key, (m = new Map()))
      let l = m.get(ci)
      if (l === undefined) {
        const c = chains[ci].c
        const out: number[] = []
        let ok = true
        for (let j = 0; j < c.length && ok; j++) {
          if (li.ix !== ix && li.ix.ids[c[j]] !== ix.ids[c[j]]) ok = false
          else if (!li.ep.eff(c[j])) out.push(j)
        }
        m.set(ci, (l = ok ? Int32Array.from(out) : null))
      }
      return l
    }
    const posProbe = (o: number, dS: number, R: string) => {
      const M = monoK(o)
      const Fr = M.Fr
      const ex = new Set([dS])
      return (p: number) => {
        const ex0 = Fr.extra
        Fr.extra = ex
        Fr.ovX = dS
        Fr.ovP = p
        Fr.resetPos(R)
        M.resetMe()
        this.stats.probes++
        const v = !M.authorized()
        Fr.extra = ex0
        Fr.ovX = -1
        Fr.resetPos(R)
        M.resetMe()
        return v
      }
    }
    const chainsOf = (gs: number[], ri: number): number[] => {
      const rk = new Map<number, number>(gs.map((d, i) => [d, i]))
      const runsBy = new Map<string, number[][]>()
      for (const d of [...gs].sort((x, y) => x - y)) {
        const k = `${ix.ev[d].a}\u0001${ix.ev[d].dev}`
        runsBy.set(k, chainCover(ix, d, runsBy.get(k) ?? []))
      }
      const chs: number[] = []
      for (const rs of runsBy.values())
        for (const c of rs) {
          chs.push(chains.length)
          chains.push({ c, rk: Int32Array.from(c, d => rk.get(d)!), role: ri })
        }
      return chs
    }
    // fr: per chain, the range concurrent with o (all frontier); seen: the chain's events in B(o)
    // that o's admission state does not hold effective
    const fr: number[] = []
    const seen: number[] = []
    const frontierOf = (o: number, chs: number[]) => {
      fr.length = 0
      seen.length = 0
      for (const ci of chs) {
        const c = chains[ci].c
        const m = c.length
        const pa = firstTrue(0, m, j => !ix.has(o, c[j]))
        const pb = firstTrue(pa, m, j => ix.has(c[j], o))
        if (pa < pb && c[pa] !== o) fr.push(ci, pa, pb)
        if (pa > 0) {
          const L = neList(o, ci)
          if (L) {
            for (let t = 0; t < L.length && L[t] < pa; t++) seen.push(c[L[t]])
          } else for (let j = 0; j < pa; j++) if (this.frontier(o, c[j])) seen.push(c[j])
        }
      }
      return fr.length > 0 || seen.length > 0
    }
    for (const [R, l] of byRoleMv) {
      const ri = roles.length
      const gs = [...l].sort((x, y) => ix.ev[x].c.pos - ix.ev[y].c.pos || x - y)
      const gpos = gs.map(d => ix.ev[d].c.pos)
      roles.push({ gs, terms: false })
      const chs = chainsOf(gs, ri)
      let guess = gs.length >> 1
      const thr = (o: number, dS: number): number => {
        let m = ivl.get(o)
        if (!m) ivl.set(o, (m = new Map()))
        let iv = m.get(R)
        if (!iv) m.set(R, (iv = [Infinity, -Infinity]))
        const ivv = iv
        let probe: ((p: number) => boolean) | undefined
        const f = (p: number) => {
          if (p >= ivv[0]) return false
          if (p <= ivv[1]) return true
          probe ??= posProbe(o, dS, R)
          const v = probe(p)
          if (v) ivv[1] = Math.max(ivv[1], p)
          else ivv[0] = Math.min(ivv[0], p)
          return v
        }
        const n = gpos.length
        const g = Math.min(Math.max(guess, 0), n)
        let lo = 0
        let hi = n
        if (g > 0) {
          if (f(gpos[g - 1])) lo = g
          else hi = g - 1
        }
        if (lo === g && g < n) {
          if (f(gpos[g])) lo = g + 1
          else hi = g
        }
        while (lo < hi) {
          const md = (lo + hi) >> 1
          if (f(gpos[md])) lo = md + 1
          else hi = md
        }
        return (guess = lo)
      }
      const moveOp = (o: number) => {
        if (!alive(o) || !frontierOf(o, chs)) return
        if (!below(o) || !authorizedK(o)) return
        const pe = ix.ev[o]
        const ub = this.rankBound(pe.a)
        const allExp = pe.t === 'join' ? cmp(ub, kk) < 0 : !gt(ub, kk)
        const pair = (d: number) => {
          if ((allExp || exposed(o, d, () => Vfor(d, o))) && uses(o, d)) addD(d, o)
        }
        for (const d of seen) pair(d)
        for (let t = 0; t < fr.length; t += 3) {
          const ci = fr[t]
          const c = chains[ci].c
          const a = fr[t + 1]
          const b = fr[t + 2]
          if (!allExp) {
            for (let j = a; j < b; j++) pair(c[j])
            continue
          }
          const mw = maxW(o, R)
          const pc = firstTrue(a, b, j => mw.every(x => ix.has(c[j], x)))
          for (let j = a; j < pc; j++) pair(c[j])
          if (pc < b) {
            const r = thr(o, c[pc])
            if (r > 0) {
              pushM(terms, o, ci)
              terms.get(o)!.push(pc, b, r)
              roles[ri].terms = true
              this.stats.terms++
            }
          }
        }
      }
      for (const P of ix.heldBy.get(R) ?? []) {
        if (ix.owners.has(P)) continue
        for (const key of ix.adOf.get(P) ?? [])
          for (const run of ix.runsOf(key)) {
            const nS = this.mS ? firstTrue(0, run.length, j => !this.inS(run[j])) : run.length
            for (let j = 0; j < nS; j++) moveOp(run[j])
          }
      }
    }
    // a concurrent clear of (R, b) or deletion of R changes uses(o, ·) the same way whichever it
    // is (the role-wide memo of uses), so an exposed reader is a direct cut of the whole range or
    // of none of it; every reader of one group is a reader of each of its denies
    for (const l of byClr.values()) {
      const ri = roles.length
      const gs = [...l].sort((x, y) => x - y)
      roles.push({ gs, terms: false })
      const chs = chainsOf(gs, ri)
      const clearOp = (o: number) => {
        if (!alive(o) || ix.owners.has(ix.ev[o].a) || !frontierOf(o, chs)) return
        if (!below(o) || !authorizedK(o)) return
        const pe = ix.ev[o]
        const ub = this.rankBound(pe.a)
        const allExp = pe.t === 'join' ? cmp(ub, kk) < 0 : !gt(ub, kk)
        const pair = (d: number) => {
          if ((allExp || exposed(o, d, () => Vfor(d, o))) && uses(o, d)) addD(d, o)
        }
        for (const d of seen) pair(d)
        for (let t = 0; t < fr.length; t += 3) {
          const ci = fr[t]
          const c = chains[ci].c
          const a = fr[t + 1]
          const b = fr[t + 2]
          if (!allExp) for (let j = a; j < b; j++) pair(c[j])
          else if (uses(o, c[a])) {
            pushM(terms, o, ci)
            terms.get(o)!.push(a, b, gs.length)
            roles[ri].terms = true
            this.stats.terms++
          }
        }
      }
      const vis = new Uint8Array(ix.n)
      this.readers(gs[0], o => {
        if (vis[o]) return
        vis[o] = 1
        clearOp(o)
      })
    }
    const cutBy = new Set<number>()
    const byChain = new Map<number, number[]>()
    for (const ts of terms.values())
      for (let t = 0; t < ts.length; t += 4) {
        pushM(byChain, ts[t], ts[t + 1])
        byChain.get(ts[t])!.push(ts[t + 2], ts[t + 3])
      }
    for (const [ci, ts] of byChain) {
      const ch = chains[ci]
      const m = ch.c.length
      const best = new Int32Array(m).fill(-1)
      const nxt = Int32Array.from({ length: m + 1 }, (_, j) => j)
      const find = (j: number) => {
        let r = j
        while (nxt[r] !== r) r = nxt[r]
        while (nxt[j] !== r) {
          const q = nxt[j]
          nxt[j] = r
          j = q
        }
        return r
      }
      const ord = Array.from({ length: ts.length / 3 }, (_, k) => k).sort(
        (p, q) => ts[3 * q + 2] - ts[3 * p + 2]
      )
      for (const k of ord) {
        const lo = ts[3 * k]
        const hi = ts[3 * k + 1]
        const r = ts[3 * k + 2]
        for (let j = find(lo); j < hi; j = find(j + 1)) {
          best[j] = r
          nxt[j] = j + 1
        }
      }
      for (let j = 0; j < m; j++) if (ch.rk[j] < best[j]) cutBy.add(ch.c[j])
    }
    const blockRole = new Map<number, number>()
    for (let ri = 0; ri < roles.length; ri++)
      if (roles[ri].terms) for (const d of roles[ri].gs) blockRole.set(d, ri)
    return {
      cutBy,
      inBlock: (g: number) => blockRole.has(g),
      // appends each block (a role's causes in position order) to `causes` and returns the term
      // masks per op
      masks: (causes: number[], causeSet: Set<number>): Map<number, bigint> => {
        const out = new Map<number, bigint>()
        if (!terms.size) return out
        const base: number[] = []
        const K: Int32Array[] = []
        for (let ri = 0; ri < roles.length; ri++) {
          const rl = roles[ri]
          if (!rl.terms) continue
          base[ri] = causes.length
          const k = new Int32Array(rl.gs.length + 1)
          for (let i = 0; i < rl.gs.length; i++) {
            const isC = causeSet.has(rl.gs[i])
            k[i + 1] = k[i] + (isC ? 1 : 0)
            if (isC) causes.push(rl.gs[i])
          }
          K[ri] = k
        }
        const bitOf = new Map<number, number>(causes.map((g, i) => [g, i]))
        const pref = new Map<number, bigint[]>()
        const prefOf = (ci: number) => {
          let p = pref.get(ci)
          if (!p) {
            const c = chains[ci].c
            p = [B0]
            for (let j = 0; j < c.length; j++) {
              const b = bitOf.get(c[j])
              p.push(b === undefined ? p[j] : p[j] | bit(b))
            }
            pref.set(ci, p)
          }
          return p
        }
        for (const [o, ts] of terms) {
          let m = B0
          for (let t = 0; t < ts.length; t += 4) {
            const ci = ts[t]
            const ri = chains[ci].role
            const p = prefOf(ci)
            m |= (p[ts[t + 2]] ^ p[ts[t + 1]]) & (bit(base[ri] + K[ri][ts[t + 3]]) - B1)
          }
          if (m !== B0) out.set(o, m)
        }
        return out
      },
    }
  }

  // protectedTarget (§3.1 step 2), skipping the view when the target's rank bound decides it.
  protectedFast(d: number, kk: Rank, Vof: (g: number) => View): boolean {
    const ix = this.ix
    const de = ix.ev[d]
    const St = ix.rec[d].local.facts
    const tg = target(de, St)
    if (tg.kind === 'member') {
      if (ix.owners.has(tg.who)) return true
      if (cmp(this.rankBound(tg.who), kk) < 0) return false
    } else if (tg.kind === 'role') {
      if (!gt([this.maxPosOf(tg.who), tg.who], kk)) return false
    } else return false
    return protectedTarget(de, St, Vof(d).facts(), kk)
  }

  // The operations whose resources a deny d can change (§5 authority index): step 3 visits only these.
  private readers(d: number, visit: (o: number) => void) {
    const ix = this.ix
    const e = ix.ev[d]
    const c = e.c
    const each = (l: readonly number[] | undefined) => {
      if (l) for (const o of l) visit(o)
    }
    const opsOf = (P: string) => each(ix.byAuthor.get(P))
    const codeUsers = (code: string) => {
      for (const g of ix.codeAdds.get(code) ?? EMPTY) {
        visit(g)
        each(ix.joinEv.get(ix.ev[g].c.to))
      }
    }
    const codesOf = (P: string) => {
      for (const x of ix.byAuthor.get(P) ?? EMPTY) if (ix.ev[x].t === 'code') codeUsers(ix.ids[x])
    }
    const holders = (R: string, codes: boolean) => {
      for (const P of ix.heldBy.get(R) ?? []) {
        opsOf(P)
        if (codes) codesOf(P)
      }
    }
    switch (e.t) {
      case 'kick':
      case 'revoke':
        opsOf(c.to)
        codesOf(c.to)
        break
      case 'ban':
        opsOf(c.to)
        codesOf(c.to)
        each(ix.addEv.get(c.to))
        each(ix.unbanEv.get(c.to))
        break
      case 'uninvite':
        each(ix.joinEv.get(c.to))
        break
      case 'code_revoke':
        codeUsers(c.code ?? '')
        break
      case 'role_move':
        holders(c.role, false)
        break
      case 'role_bits':
        if (c.role === EVERYONE) {
          for (const o of this.order) visit(o)
        } else holders(c.role, true)
        break
      case 'role_del':
        holders(c.role, true)
        each(ix.roleNamed.get(c.role))
        break
      default:
        for (const o of this.order) visit(o)
    }
  }

  // Step 4: the region, the flat closure, protection classes, and the exact branch (worlds) or
  // the fallback. Returns in(x, W) for the stratum's cuts.
  private cascade(
    st: Strat,
    causes: number[],
    direct: Map<number, number[]>,
    alive: (i: number) => boolean,
    authorizedK: (o: number) => boolean,
    below: (o: number, N?: NPred) => boolean,
    exposed: (p: number, g: number, V: () => View) => boolean,
    Vfor: (g: number, p: number) => View,
    termDc: Map<number, bigint>,
    floorK: (o: number) => boolean
  ): (x: number, W: bigint) => boolean {
    const ix = this.ix
    const n = ix.n
    const s = st.s
    const cutOrd = this.cutOrd
    const bitIx = new Map<number, number>(causes.map((g, i) => [g, i]))
    const ALLm = bit(causes.length) - B1
    const maskOf = (is: number[]): bigint => {
      if (is.length < 32) {
        let m = B0
        for (const i of is) m |= bit(i)
        return m
      }
      const wd = new Uint32Array((causes.length + 31) >>> 5)
      for (const i of is) wd[i >>> 5] |= 1 << (i & 31)
      let h = ''
      for (let k = wd.length - 1; k >= 0; k--) h += wd[k].toString(16).padStart(8, '0')
      return BigInt('0x' + h)
    }
    const DcL = new Map<number, number[]>()
    for (const [g, os] of direct) {
      const b = bitIx.get(g)
      if (b === undefined) continue
      for (const o of os) pushM(DcL, o, b)
    }
    const Dc = new Map<number, bigint>()
    for (const [o, is] of DcL) Dc.set(o, maskOf(is))
    for (const [o, m] of termDc) Dc.set(o, (Dc.get(o) ?? B0) | m)
    const Um = new Map<number, bigint>()
    const kk = st.kk
    const U = (p: number) => {
      let m = Um.get(p)
      if (m === undefined) {
        const pe = ix.ev[p]
        const P = pe.a
        if (!ix.owners.has(P) && pe.t !== 'join' && !gt(this.rankBound(P), kk)) m = ALLm
        else {
          const is: number[] = []
          causes.forEach((g, i) => {
            if (exposed(p, g, () => Vfor(g, p))) is.push(i)
          })
          m = maskOf(is)
        }
        Um.set(p, m)
      }
      return m
    }
    const dp = new Uint8Array(n)
    const region: number[] = []
    for (const i of this.order) {
      for (const p of ix.pa[i])
        if (dp[p] || Dc.has(p)) {
          dp[i] = 1
          break
        }
      if (alive(i) && (dp[i] || Dc.has(i))) region.push(i)
    }
    const flatA = new Uint8Array(n)
    const nm = new Uint8Array(n)
    const inR = new Uint8Array(n)
    for (const q of region) inR[q] = 1
    const flat: number[] = []
    for (const q of this.order) {
      for (const p of ix.pa[q])
        if (nm[p] || (flatA[p] && ix.ev[p].t !== 'role_move')) {
          nm[q] = 1
          break
        }
      if (!inR[q]) continue
      let f = Dc.has(q)
      if (!f && authorizedK(q)) {
        if (!nm[q] && floorK(q)) this.stats.floorSkips++
        else {
          const N = (x: number) => flatA[x] === 1 && ix.has(q, x)
          this.stats.brokenTests++
          f = below(q, N) && !new Mono(ix, anchorOf(ix, q), st, N, EMPTYSET).authorized()
        }
      }
      if (f) {
        flatA[q] = 1
        flat.push(q)
      }
    }
    const Gm = new Map<number, bigint>()
    for (const i of this.order) {
      let g = Dc.get(i) ?? B0
      for (const p of ix.pa[i]) g |= Gm.get(p) ?? B0
      if (g !== B0) Gm.set(i, g)
    }
    const G = (q: number) => Gm.get(q) ?? B0
    const classSet = new Set<bigint>()
    for (const q of flat) {
      if (this.X[q]) continue
      const g = G(q)
      const m = U(q) & g
      if (m !== B0 && m !== g) classSet.add(m)
    }
    const cutQ = (q: number) => {
      cutOrd[q] = s
      this.cutRank[q] = st.kk
    }
    this.stats.maxClasses = Math.max(this.stats.maxClasses, classSet.size)
    this.stats.maxRegion = Math.max(this.stats.maxRegion, region.length)
    this.stats.maxFlat = Math.max(this.stats.maxFlat, flat.length)
    if (classSet.size > LIM.classes) {
      this.stats.fallbacks++
      const cascTop = new Map<number, boolean>()
      for (const q of flat) {
        const Wq = U(q)
        let ct = false
        if (Wq !== B0 && authorizedK(q)) {
          const N = (x: number) =>
            ix.has(q, x) &&
            cutOrd[x] === s &&
            (((Dc.get(x) ?? B0) & Wq) !== B0 ||
              (cascTop.get(x) === true && (U(x) & G(x) & ~Wq) === B0))
          this.stats.brokenTests++
          ct = below(q, N) && !new Mono(ix, anchorOf(ix, q), st, N, EMPTYSET).authorized()
        }
        cascTop.set(q, ct)
        if (Dc.has(q) || ct) cutQ(q)
      }
      return (x, W) =>
        ((Dc.get(x) ?? B0) & W) !== B0 || (cascTop.get(x) === true && (U(x) & G(x) & ~W) === B0)
    }
    const casc = new Map<number, Map<bigint, boolean>>()
    const worlds = new Set<bigint>()
    const inW = (x: number, W: bigint): boolean => {
      if (((Dc.get(x) ?? B0) & W) !== B0) return true
      const Wx = W & U(x)
      return Wx !== B0 && cascadeIn(x, Wx)
    }
    // (§5.4 C) per op, the minimal worlds known to break it and the maximal ones known not to
    // (cascadeIn is monotone in the world), and what each broken test asked of the world: the
    // events N was consulted on, with the answers, in order. A test is a deterministic function
    // of those answers, so a world that gives the same ones gets the same result.
    interface Trace {
      xs: number[]
      as: boolean[]
      v: boolean
    }
    interface WMemo {
      t: bigint[]
      f: bigint[]
      tr: Trace[]
    }
    const wm = new Map<number, WMemo>()
    const replays = (r: Trace, W: bigint) => {
      for (let i = 0; i < r.xs.length; i++) if (inW(r.xs[i], W) !== r.as[i]) return false
      return true
    }
    const known = (m: WMemo, W: bigint): boolean | undefined => {
      for (const T of m.t) if ((T & ~W) === B0) return true
      for (const F of m.f) if ((W & ~F) === B0) return false
      for (const r of m.tr) if (replays(r, W)) return r.v
      return undefined
    }
    const note = (m: WMemo, W: bigint, v: boolean) => {
      if (v) {
        if (m.t.some(T => (T & ~W) === B0)) return
        m.t = m.t.filter(T => (W & ~T) !== B0)
        m.t.push(W)
      } else {
        if (m.f.some(F => (W & ~F) === B0)) return
        m.f = m.f.filter(F => (F & ~W) !== B0)
        m.f.push(W)
      }
    }
    const cascadeIn = (q: number, Wq: bigint): boolean => {
      let mq = casc.get(q)
      if (!mq) casc.set(q, (mq = new Map()))
      const memo = mq.get(Wq)
      if (memo !== undefined) return memo
      worlds.add(Wq)
      let v = false
      if (authorizedK(q)) {
        let m = wm.get(q)
        if (!m) wm.set(q, (m = { t: [], f: [], tr: [] }))
        const k = known(m, Wq)
        if (k !== undefined) v = k
        else {
          const xs: number[] = []
          const as: boolean[] = []
          const asked = new Map<number, boolean>()
          const N = (x: number) => {
            if (!ix.has(q, x) || cutOrd[x] !== s) return false
            let a = asked.get(x)
            if (a === undefined) {
              asked.set(x, (a = inW(x, Wq)))
              xs.push(x)
              as.push(a)
            }
            return a
          }
          this.stats.brokenTests++
          v = below(q, N) && !new Mono(ix, anchorOf(ix, q), st, N, EMPTYSET).authorized()
          m.tr.push({ xs, as, v })
        }
        note(m, Wq, v)
      }
      mq.set(Wq, v)
      return v
    }
    for (const q of flat) {
      let isCut = Dc.has(q)
      if (!isCut) {
        const Wq = U(q)
        isCut = Wq !== B0 && cascadeIn(q, Wq)
      }
      if (isCut) cutQ(q)
    }
    this.stats.worlds += worlds.size
    return (x, W) => cutOrd[x] === s && inW(x, W)
  }

  // An event on the heads (C(ap) = S): Eval(S ∪ {e}) = Eval(S) ⊕ e (§5). What is left: whether e
  // is void, whether e, if a deny, is effective at k(e), and the facts.
  appendHead(i: number) {
    const ix = this.ix
    if (this.mS) throw new Error('acl: appendHead on a subset evaluation')
    const grow = (a: Uint8Array) => {
      const b = new Uint8Array(ix.n)
      b.set(a)
      return b
    }
    this.X = grow(this.X)
    this.tail = grow(this.tail)
    this.cutOrd.push(-1)
    this.cutRank.push(undefined)
    this.effOrd.push(-2)
    this.effRank.push(undefined)
    this.order.push(i)
    this.maxPos.clear()
    const e = ix.ev[i]
    const pl = ix.rec[i].pool
    if (pl && !ix.owners.has(e.a) && e.t !== 'primary_rotate' && pl.length > LIM.poolU)
      this.PC.add(ix.ids[i])
    if (this.candidateIn(i, this.F, this.FI, this.RF, this.PC)) {
      this.X[i] = 1
      return
    }
    if (e.t === 'device_revoke' || e.t === 'primary_rotate') {
      this.effOrd[i] = -1
      if (e.t === 'device_revoke')
        this.marks.push({ r: i, dev: e.c.dk, seen: typeof e.c.seen === 'number' ? e.c.seen : -1 })
      else
        for (const v of this.droppedS(i, x => this.X[x] === 1))
          this.marks.push({ r: i, dev: v, seen: seenOf(e, v) })
    } else if (ix.isD[i]) {
      const kk = ix.k(i)
      const st = this.above(kk)
      if (ix.isSelfD[i] || !this.protectedFast(i, kk, g => new CauseView(ix, g, st, null))) {
        this.effOrd[i] = 0
        this.effRank[i] = kk
        this.noteEffective(i)
      }
    }
  }

  // The decisions above stratum kk of the final state, as a stratum context (no cuts at kk).
  above(kk: Rank): Strat {
    const cutRank = this.cutRank
    const effRank = this.effRank
    const effOrd = this.effOrd
    const X = this.X
    const tail = this.tail
    const K = (x: number) => cutRank[x] !== undefined && cmp(cutRank[x]!, kk) > 0
    return {
      s: -1,
      kk,
      K,
      here: () => false,
      voidK: x => X[x] === 1 || tail[x] === 1 || K(x),
      high: x => effOrd[x] === -1 || (effRank[x] !== undefined && cmp(effRank[x]!, kk) > 0),
      inS: x => this.inS(x),
      isX: x => X[x] === 1,
    }
  }

  // This evaluation as the source of recorded states: its final state and every head-path
  // snapshot of it agree on eff over their common events.
  private ep?: { key: object; eff(i: number): boolean }
  epoch() {
    return (this.ep ??= { key: this, eff: (i: number) => this.inS(i) && this.effOrd[i] >= -1 })
  }

  isVoidI(i: number) {
    return this.X[i] === 1 || this.tail[i] === 1 || this.cutOrd[i] >= 0
  }
  isEffI(i: number) {
    return this.effOrd[i] >= -1
  }

  // The final state, materialized (for a large subset, cache.ts keeps a packed copy instead).
  result(): EvalResult {
    const ix = this.ix
    const n = ix.n
    const voidA = new Uint8Array(n)
    const effA = new Uint8Array(n)
    const X = new Set<string>()
    const tail = new Set<string>()
    const cut = new Map<string, Rank>()
    const eff = new Set<string>()
    const voidS = new Set<string>()
    for (const i of this.order) {
      const id = ix.ids[i]
      if (this.X[i]) X.add(id)
      if (this.tail[i]) tail.add(id)
      if (this.cutOrd[i] >= 0) cut.set(id, this.cutRank[i]!)
      if (this.isVoidI(i)) {
        voidA[i] = 1
        voidS.add(id)
      }
      if (this.isEffI(i)) {
        effA[i] = 1
        eff.add(id)
      }
    }
    const facts = fullFacts(new FullView(ix, voidA, effA, this.mS, this.X))
    const XA = this.X
    const mS = this.mS
    const idx: StIdx = {
      ix,
      X: i => XA[i] === 1,
      void: i => voidA[i] === 1,
      eff: i => effA[i] === 1 && (mS === null || mS[i] === 1),
      ep: this.epoch(),
    }
    return {
      facts,
      X,
      tail,
      cut,
      eff,
      void: voidS,
      F: this.F,
      FI: this.FI,
      RF: this.RF,
      PC: this.PC,
      idx,
    }
  }
}

// Eval(S) by the production algorithm: the equivalent of the model's `evaluate(ids, cx)`.
// `ghosts`: events dropped by the orphan rule, whose headers still count as evidence.
export function evaluate(
  ids: Iterable<string>,
  cx: Ctx,
  ghosts: readonly string[] = []
): EvalResult {
  if (!ghosts.length) return new FastEval(Ix.of(ids, cx)).run()
  const list = [...ids]
  const ix = Ix.of([...list, ...ghosts], cx)
  const mS = new Uint8Array(ix.n)
  const gm = new Uint8Array(ix.n)
  for (const id of list) mS[ix.at.get(id)!] = 1
  for (const id of ghosts) gm[ix.at.get(id)!] = 1
  const fe = new FastEval(ix, mS)
  fe.ghost = gm
  return fe.run()
}

export type { FactsQ }
