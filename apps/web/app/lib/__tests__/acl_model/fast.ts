/* eslint-disable */
// @ts-nocheck
// Copy of notes/acl-model/fast.ts (the executable reference model of the P2P ACL spec), used only by the differential tests.
// Production-style evaluator of Eval(S) (spec §5, revision 5): the same result as model.ts's `evaluate`, computed the way
// a client computes it. Kept separate from the reference; the fuzz checks that both agree on every evaluated set (§7.1
// O13-fast). No dependencies; plain TypeScript.
//
// Structure (spec §5):
// - Ix: the index of a causally closed set, append-only: topological numbering, strict-ancestor bitsets built from `ap`
//   (reachability in one bit test), per-key event lists (one list per fact key of §3.2: the joins, removals, bans and
//   unbans of a principal, the assignments and revocations of (principal, role), the creates, moves, deletes, bit
//   setters and clears of a role, codes, adds and uninvites, device introductions and revocations).
// - Views: a view is (event set E, void set, effective denies) given by three predicates. Facts are computed per key,
//   lazily and memoized, from that key's event list only (keyed facts), never by a pass over E. Every authority check
//   of §3.1 (V_o(K ∪ N, +D), V°_o(K, N), V_γ, V_γ^p, the final state) is such a view; `LazyFacts` presents a view
//   through the `Facts` interface so the reference's authority, rank and protection functions run on it unchanged.
// - The stratum loop of §3.1 with indexed candidate sets (step 1: the author's ops; step 3: the readers of the keys a
//   deny can change), exposure decided from a per-principal rank bound before any view is built, and step 4 as a
//   propagation in causal order in which a world's cuts are a predicate read only on the keys an op's authority reads
//   (an op's world is consulted only through its own supports).
// - FastState: incremental append (§5 "Incremental arrival").
import {
  type Ctx,
  type Ev,
  type EvalResult,
  type Facts,
  type Pend,
  type Rank,
  type Rec,
  type AuthCtx,
  TOP,
  BOT,
  NEG,
  cmp,
  gt,
  minR,
  rkey,
  EVERYONE,
  ALL,
  INVITE,
  BITS,
  LIM,
  introduces,
  fiOf,
  authCore,
  deviceOk,
  protectedTarget,
  exposedTo,
  target,
  KICK,
} from './model'

// ---------------------------------------------------------------- index

const pushM = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
  const a = m.get(k)
  if (a) a.push(v)
  else m.set(k, [v])
}
const addS = <K, V>(m: Map<K, Set<V>>, k: K, v: V) => {
  const a = m.get(k)
  if (a) a.add(v)
  else m.set(k, new Set([v]))
}
const EMPTY: number[] = []

/** add x (indexed after every event of `runs`) to a chain cover: the last of the latest 8 chains whose tip is in B(x) */
function chainCover(ix: Ix, x: number, runs: number[][]): number[][] {
  for (let q = runs.length - 1; q >= 0 && q >= runs.length - 8; q--) {
    const run = runs[q]
    if (ix.has(x, run[run.length - 1])) {
      run.push(x)
      return runs
    }
  }
  runs.push([x])
  return runs
}
function popcount(w: number) {
  w = w - ((w >>> 1) & 0x55555555)
  w = (w & 0x33333333) + ((w >>> 2) & 0x33333333)
  return (((w + (w >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
}
/** first j in [lo, hi) with p(j), for p false then true on [lo, hi) */
function firstTrue(lo: number, hi: number, p: (j: number) => boolean): number {
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (p(m)) hi = m
    else lo = m + 1
  }
  return lo
}

/**
 * A/B switches for checks (env ACL_FASTOPT): `legacy` visits every holder op per move (5b-ii.3's step 3); `noterms`
 * tests every concurrent move of a chain as a pair instead of a range term; `nofloor` drops the flat closure's floor test
 */
const fastEnv = (typeof process !== 'undefined' && process.env.ACL_FASTOPT) || ''
export const FASTOPT = {
  moveChains: fastEnv !== 'legacy',
  terms: fastEnv !== 'noterms',
  floor: fastEnv !== 'nofloor' && fastEnv !== 'legacy',
}
/** fast-only mutants (ACL_MUT `fast-…`; the reference runs unmutated, so O13-fast compares): `fast-ghost-dev` counts headers as device evidence only (revision 5's fast.ts, r5 review I1) */
const FMUT = (typeof process !== 'undefined' && process.env.ACL_MUT) || ''

export const isFixedT = (t: string) =>
  t === 'genesis' || t === 'device_revoke' || t === 'primary_rotate'

/** Index of a causally closed set of admitted ACL events. Events are numbered in a topological order (append-only). */
export class Ix {
  n = 0
  ids: string[] = []
  at = new Map<string, number>()
  ev: Ev[] = []
  rec: Rec[] = []
  anc: Uint32Array[] = [] // strict ancestors: bit x of anc[i] (x < i) iff x ∈ B(i)
  kids: number[][] = []
  pa: number[][] = [] // ACL parents (indices)
  isD: boolean[] = []
  isSelfD: boolean[] = []
  fixed: boolean[] = []
  owners = new Set<string>()
  genesis = -1
  // per-key event lists (ascending index order)
  byAuthor = new Map<string, number[]>()
  byDev = new Map<string, number[]>()
  byAD = new Map<string, number[]>() // `${author}\u0001${device}` -> its events
  adOf = new Map<string, string[]>() // author -> its byAD keys
  memEv = new Map<string, number[]>() // joins and the genesis of principal T
  joinEv = new Map<string, number[]>() // joins only
  remEv = new Map<string, number[]>() // kick(T), ban(T), leave by T
  banEv = new Map<string, number[]>()
  unbanEv = new Map<string, number[]>()
  roleCreate = new Map<string, number>()
  roleDel = new Map<string, number[]>()
  bitSet = new Map<string, number[]>() // role_create R (its bits), role_bits on R; genesis for everyone
  bitClr = new Map<string, number[]>()
  posW = new Map<string, number[]>() // role_create R and role_move of R
  assignEv = new Map<string, number[]>() // `${T}|${R}`
  revokeEv = new Map<string, number[]>() // `${T}|${R}`
  everHeld = new Map<string, Set<string>>() // T -> roles assigned to T somewhere in the set
  heldBy = new Map<string, Set<string>>() // R -> principals assigned R somewhere in the set
  codeEv = new Map<string, number>()
  codeRev = new Map<string, number[]>()
  codeAdds = new Map<string, number[]>() // adds through code c
  addEv = new Map<string, number[]>() // adds naming T
  uninvEv = new Map<string, number[]>()
  devRevEv = new Map<string, number[]>() // device_revoke naming device v
  rotBy = new Map<string, number[]>()
  introEv = new Map<string, number[]>() // events introducing device v
  introBy = new Map<string, number[]>() // events of identity a that introduce some device
  roleNamed = new Map<string, number[]>() // role_move, role_bits, role_del, assign naming R (Fr.roles reads)
  profileBy = new Map<string, number[]>()
  settingsEv: number[] = []
  upgradeEv: number[] = []
  deniesAt = new Map<string, number[]>() // rkey(k) -> denies (D or S class) at that stratum
  idOps: number[] = [] // identity ops (depth >= 0)
  deathMemo = new Map<string, number[]>() // code -> events with the code in their past whose St lacks the issuer's Mem/Invite
  poolIx: (Int32Array | undefined)[] = [] // W3(g): recorded pools as indices (lazily)

  constructor(public cx: Ctx) {}

  has(i: number, x: number): boolean {
    if (x >= i) return false
    return ((this.anc[i][x >>> 5] >>> (x & 31)) & 1) !== 0
  }
  /** x ∈ B(y) */
  before(x: number, y: number) {
    return this.has(y, x)
  }
  k(i: number) {
    return this.rec[i].k
  }

  /** Append one event whose ACL parents are already indexed. */
  add(id: string): number {
    const cx = this.cx,
      i = this.n++
    const e = cx.ev(id),
      r = cx.rec(id)
    this.ids.push(id)
    this.at.set(id, i)
    this.ev.push(e)
    this.rec.push(r)
    this.kids.push([])
    const a = new Uint32Array((i + 31) >>> 5)
    const pa: number[] = []
    this.pa.push(pa)
    for (const pid of e.ap) {
      const p = this.at.get(pid)
      if (p === undefined) throw new Error(`fast: parent ${pid} of ${id} not indexed`)
      if (pa.includes(p)) continue
      pa.push(p)
      const ap = this.anc[p]
      for (let w = 0; w < ap.length; w++) a[w] |= ap[w]
      a[p >>> 5] |= 1 << (p & 31)
      this.kids[p].push(i)
    }
    this.anc.push(a)
    const d = r.cls === 'D'
    this.isD.push(d)
    this.isSelfD.push(d && r.self)
    this.fixed.push(isFixedT(e.t))
    pushM(this.byAuthor, e.a, i)
    pushM(this.byDev, e.dev, i)
    const adk = `${e.a}\u0001${e.dev}`
    if (!this.byAD.has(adk)) pushM(this.adOf, e.a, adk)
    pushM(this.byAD, adk, i)
    if (r.depth >= 0) this.idOps.push(i)
    const c = e.c ?? {}
    switch (e.t) {
      case 'genesis':
        this.genesis = i
        for (const o of c.owners ?? []) this.owners.add(o)
        pushM(this.memEv, e.a, i)
        pushM(this.bitSet, EVERYONE, i)
        break
      case 'join':
        pushM(this.memEv, e.a, i)
        pushM(this.joinEv, e.a, i)
        break
      case 'kick':
        pushM(this.remEv, c.to, i)
        break
      case 'ban':
        pushM(this.remEv, c.to, i)
        pushM(this.banEv, c.to, i)
        break
      case 'leave':
        pushM(this.remEv, e.a, i)
        break
      case 'unban':
        pushM(this.unbanEv, c.to, i)
        break
      case 'role_create':
        this.roleCreate.set(id, i)
        pushM(this.bitSet, id, i)
        pushM(this.posW, id, i)
        break
      case 'role_move':
        pushM(this.posW, c.role, i)
        pushM(this.roleNamed, c.role, i)
        break
      case 'role_bits':
        pushM(c.on ? this.bitSet : this.bitClr, c.role, i)
        pushM(this.roleNamed, c.role, i)
        break
      case 'role_del':
        pushM(this.roleDel, c.role, i)
        pushM(this.roleNamed, c.role, i)
        break
      case 'assign':
        pushM(this.assignEv, `${c.to}|${c.role}`, i)
        addS(this.everHeld, c.to, c.role)
        addS(this.heldBy, c.role, c.to)
        pushM(this.roleNamed, c.role, i)
        break
      case 'revoke':
        pushM(this.revokeEv, `${c.to}|${c.role}`, i)
        break
      case 'code':
        this.codeEv.set(id, i)
        break
      case 'code_revoke':
        pushM(this.codeRev, c.code, i)
        break
      case 'add':
        pushM(this.addEv, c.to, i)
        if (c.code !== undefined) pushM(this.codeAdds, c.code, i)
        break
      case 'uninvite':
        pushM(this.uninvEv, c.to, i)
        break
      case 'device_revoke':
        pushM(this.devRevEv, c.dev, i)
        break
      case 'primary_rotate':
        pushM(this.rotBy, e.a, i)
        break
      case 'profile':
        pushM(this.profileBy, e.a, i)
        break
      case 'settings':
        this.settingsEv.push(i)
        break
      case 'upgrade':
        this.upgradeEv.push(i)
        break
    }
    const intro = introduces(e)
    if (intro.length) {
      pushM(this.introBy, e.a, i)
      for (const v of intro) pushM(this.introEv, v, i)
    }
    if (d) pushM(this.deniesAt, rkey(r.k), i)
    if (this.deathMemo.size) this.deathMemo.clear() // a new event can be a death witness of any code in its past
    return i
  }

  /** Index a whole set in a topological order of its `ap` links (Kahn), whatever order `ids` is given in. */
  static of(ids: string[], cx: Ctx): Ix {
    const ix = new Ix(cx)
    const inSet = new Set(ids)
    const indeg = new Map<string, number>()
    const kidsOf = new Map<string, string[]>()
    for (const id of ids) {
      let d = 0
      for (const p of new Set(cx.ev(id).ap))
        if (inSet.has(p)) {
          d++
          pushM(kidsOf, p, id)
        }
      indeg.set(id, d)
    }
    const q: string[] = ids.filter(id => indeg.get(id) === 0)
    for (let h = 0; h < q.length; h++) {
      const id = q[h]
      ix.add(id)
      for (const k of kidsOf.get(id) ?? []) {
        const d = indeg.get(k)! - 1
        indeg.set(k, d)
        if (d === 0) q.push(k)
      }
    }
    if (ix.n !== ids.length) throw new Error('fast: set is not causally closed')
    return ix
  }

  /**
   * posCov(R)[k]: every position write of R indexed before posW(R)[k] is in its past (append-only, extended lazily). A
   * register read from the top stops at the first maximal write with this flag: every lower write is dominated (§5).
   */
  private cov = new Map<string, boolean[]>()
  posCov(R: string): boolean[] {
    const ws = this.posW.get(R) ?? EMPTY
    let c = this.cov.get(R)
    if (!c) this.cov.set(R, (c = []))
    for (let k = c.length; k < ws.length; k++) {
      if (k === 0) {
        c.push(true)
        continue
      }
      let v = this.has(ws[k], ws[k - 1]) && c[k - 1]
      if (!v) {
        v = true
        for (let j = 0; j < k; j++)
          if (!this.has(ws[k], ws[j])) {
            v = false
            break
          }
      }
      c.push(v)
    }
    return c
  }

  /**
   * The events of one (author, device) as chains, extended lazily: each event joins the latest of the last 8 chains whose
   * tip is in its past, else starts a chain (a device without forks is one chain). On a chain the events in B(d) are a
   * prefix and those with d in their past a suffix, so both are found by binary search (§5 "Move storms").
   */
  private runM = new Map<string, { k: number; runs: number[][] }>()
  runsOf(key: string): number[][] {
    const l = this.byAD.get(key) ?? EMPTY
    let r = this.runM.get(key)
    if (!r) this.runM.set(key, (r = { k: 0, runs: [] }))
    for (; r.k < l.length; r.k++) r.runs = chainCover(this, l[r.k], r.runs)
    return r.runs
  }

  /** Events x ∈ S with c ∈ B(x) whose admission state lacks the issuer's Mem or Invite (sticky code death, §1.5). */
  deathList(code: string): number[] {
    let l = this.deathMemo.get(code)
    if (l) return l
    l = []
    const c = this.codeEv.get(code)
    if (c !== undefined) {
      const iss = this.ev[c].a
      const seen = new Uint8Array(this.n)
      const st = [c]
      while (st.length) {
        const y = st.pop()!
        for (const z of this.kids[y]) {
          if (seen[z]) continue
          seen[z] = 1
          st.push(z)
          const lf = this.rec[z].local.facts
          if (!lf.mem.has(iss) || !(permsF(lf, iss) & INVITE)) l.push(z)
        }
      }
      l.sort((a, b) => a - b)
    }
    this.deathMemo.set(code, l)
    return l
  }
}

/** perms over a real Facts object (same as model.ts `perms`). */
function permsF(F: Facts, P: string): number {
  if (F.owners.has(P)) return ALL
  let m = F.bits.get(EVERYONE) ?? 0
  for (const R of F.holds.get(P) ?? []) m |= F.bits.get(R) ?? 0
  return m
}

// ---------------------------------------------------------------- keyed lazy views

/**
 * A view (§3.2 `facts(E, void, eff)` restricted to the keys that are read). Subclasses give E, void and eff as
 * predicates over event indices; every fact is computed from its key's event list and memoized for the view's life.
 */
export abstract class View {
  constructor(public ix: Ix) {}
  abstract inE(x: number): boolean
  /** x ∈ void (only asked for x ∈ E) */
  abstract isVoid(x: number): boolean
  /** x ∈ eff (only asked for x ∈ E) */
  abstract isEff(x: number): boolean
  /** x ∈ X of the state this view belongs to ([H17]: a rotation drops only devices a non-X event introduces) */
  abstract isXv(x: number): boolean
  live(x: number) {
    return this.inE(x) && !this.isVoid(x)
  }
  effIn(x: number) {
    return this.inE(x) && this.isEff(x)
  }

  private _mBan?: Map<string, boolean>
  private get mBan(): Map<string, boolean> {
    return (this._mBan ??= new Map())
  }
  private _mMem?: Map<string, boolean>
  private get mMem(): Map<string, boolean> {
    return (this._mMem ??= new Map())
  }
  private _mRole?: Map<string, boolean>
  private get mRole(): Map<string, boolean> {
    return (this._mRole ??= new Map())
  }
  private _mBits?: Map<string, number | undefined>
  private get mBits(): Map<string, number | undefined> {
    return (this._mBits ??= new Map())
  }
  private _mPos?: Map<string, number | undefined>
  private get mPos(): Map<string, number | undefined> {
    return (this._mPos ??= new Map())
  }
  private _mHolds?: Map<string, Set<string>>
  private get mHolds(): Map<string, Set<string>> {
    return (this._mHolds ??= new Map())
  }
  private _mRevC?: Map<string, boolean>
  private get mRevC(): Map<string, boolean> {
    return (this._mRevC ??= new Map())
  }
  private _mDead?: Map<string, boolean>
  private get mDead(): Map<string, boolean> {
    return (this._mDead ??= new Map())
  }
  private _mCodeOk?: Map<string, boolean>
  private get mCodeOk(): Map<string, boolean> {
    return (this._mCodeOk ??= new Map())
  }
  private _mAdds?: Map<string, Pend[]>
  private get mAdds(): Map<string, Pend[]> {
    return (this._mAdds ??= new Map())
  }
  private _mCons?: Map<number, boolean>
  private get mCons(): Map<number, boolean> {
    return (this._mCons ??= new Map())
  }
  private _mInv?: Map<string, Pend[]>
  private get mInv(): Map<string, Pend[]> {
    return (this._mInv ??= new Map())
  }
  private _mRevoked?: Map<string, boolean>
  private get mRevoked(): Map<string, boolean> {
    return (this._mRevoked ??= new Map())
  }
  ban(T: string): boolean {
    let v = this.mBan.get(T)
    if (v === undefined) {
      v = false
      const ix = this.ix
      for (const b of ix.banEv.get(T) ?? EMPTY) {
        if (!this.effIn(b)) continue
        const kb = ix.k(b)
        const lifted = (ix.unbanEv.get(T) ?? EMPTY).some(
          u => this.live(u) && ix.before(b, u) && cmp(ix.k(u), kb) >= 0
        )
        if (!lifted) {
          v = true
          break
        }
      }
      this.mBan.set(T, v)
    }
    return v
  }
  effBanK(T: string): Rank[] | undefined {
    const l = this.ix.banEv.get(T)
    if (!l) return undefined
    const out: Rank[] = []
    for (const b of l) if (this.effIn(b)) out.push(this.ix.k(b))
    return out.length ? out : undefined
  }
  mem(T: string): boolean {
    let v = this.mMem.get(T)
    if (v === undefined) {
      v = false
      if (!this.ban(T)) {
        const ix = this.ix,
          rem = ix.remEv.get(T) ?? EMPTY
        for (const g of ix.memEv.get(T) ?? EMPTY) {
          if (!this.live(g)) continue
          if (rem.every(r => !this.effIn(r) || ix.before(r, g))) {
            v = true
            break
          }
        }
      }
      this.mMem.set(T, v)
    }
    return v
  }
  role(R: string): boolean {
    let v = this.mRole.get(R)
    if (v === undefined) {
      const rc = this.ix.roleCreate.get(R)
      v =
        rc !== undefined &&
        this.live(rc) &&
        !(this.ix.roleDel.get(R) ?? EMPTY).some(d => this.effIn(d))
      this.mRole.set(R, v)
    }
    return v
  }
  /** Bit(R, ·) mask; defined for everyone and live roles only (§3.2), else undefined */
  bits(R: string): number | undefined {
    if (this.mBits.has(R)) return this.mBits.get(R)
    let v: number | undefined
    if (R === EVERYONE || this.role(R)) {
      const ix = this.ix
      const setters = ix.bitSet.get(R) ?? EMPTY
      const clears = (ix.bitClr.get(R) ?? EMPTY).filter(c => this.effIn(c))
      let m = 0
      for (const b of BITS) {
        // every effective clear of b is in B(s) iff every maximal one is (B(s) is a downset): the maximal clears, read
        // from the newest, then the setters against them only (O(setters + clears) per bit on a chain)
        const mx: number[] = []
        for (let k = clears.length - 1; k >= 0; k--) {
          const c = clears[k]
          if (ix.ev[c].c.bit !== b) continue
          let below = false
          for (const y of mx)
            if (ix.before(c, y)) {
              below = true
              break
            }
          if (!below) mx.push(c)
        }
        for (let k = setters.length - 1; k >= 0; k--) {
          const s = setters[k],
            se = ix.ev[s]
          const mask =
            se.t === 'genesis'
              ? (se.c.everyone ?? 0)
              : se.t === 'role_create'
                ? se.c.bits
                : se.c.bit
          if (!(mask & b)) continue
          if (se.t !== 'genesis' && !this.live(s)) continue
          let ok = true
          for (const c of mx)
            if (!ix.before(c, s)) {
              ok = false
              break
            }
          if (ok) {
            m |= b
            break
          }
        }
      }
      v = m
    }
    this.mBits.set(R, v)
    return v
  }
  /** a position write of R in this view (§3.2 Pos): a live create, a live G move, an effective move */
  isPosWrite(x: number, R: string): boolean {
    const e = this.ix.ev[x]
    if (!this.inE(x)) return false
    if (e.t === 'role_create') return e.id === R && !this.isVoid(x)
    return this.isEff(x) || (!this.isVoid(x) && this.ix.rec[x].cls === 'G')
  }
  /** E holds no event indexed at or above hiE() other than those of extraE() */
  hiE(): number {
    return this.ix.n
  }
  extraE(): Iterable<number> {
    return EMPTY
  }
  /**
   * Pos(R): posValue over this view's position writes of R, read from the top down (the same scan as posValue), with
   * the write test fused in and a stop at the first maximal write that has every lower write of R in its past.
   */
  pos(R: string): number | undefined {
    if (this.mPos.has(R)) return this.mPos.get(R)
    const ix = this.ix,
      ws = ix.posW.get(R) ?? EMPTY
    let v: number | undefined
    if (ws.length) {
      const cov = ix.posCov(R),
        hi = this.hiE()
      const maxes: number[] = []
      let best = -1
      const consider = (w: number) => {
        for (const m of maxes) if (ix.has(m, w)) return false
        maxes.push(w)
        if (best < 0 || beatsI(ix, w, best)) best = w
        return true
      }
      let a = 0,
        b = ws.length
      while (a < b) {
        const m = (a + b) >> 1
        if (ws[m] < hi) a = m + 1
        else b = m
      }
      let stop = false
      if (a < ws.length) {
        const ex: number[] = []
        for (const x of this.extraE()) if (x >= hi) ex.push(x)
        if (ex.length) {
          ex.sort((p, q) => q - p)
          for (const x of ex) {
            let lo = a,
              hi2 = ws.length
            while (lo < hi2) {
              const m = (lo + hi2) >> 1
              if (ws[m] < x) lo = m + 1
              else hi2 = m
            }
            if (lo < ws.length && ws[lo] === x && this.isPosWrite(x, R) && consider(x) && cov[lo]) {
              stop = true
              break
            }
          }
        }
      }
      for (let k = a - 1; k >= 0 && !stop; k--)
        if (this.isPosWrite(ws[k], R) && consider(ws[k]) && cov[k]) stop = true
      v = best < 0 ? undefined : this.posAt(best)
    }
    this.mPos.set(R, v)
    return v
  }
  posAt(x: number): number {
    return this.ix.ev[x].c.pos
  }
  /** forget Pos(R) (a probe changed the position of its extra write) */
  resetPos(R: string) {
    this.mPos.delete(R)
  }
  holds(T: string): Set<string> {
    let v = this.mHolds.get(T)
    if (v === undefined) {
      v = new Set<string>()
      if (this.mem(T)) {
        const ix = this.ix,
          rem = ix.remEv.get(T) ?? EMPTY
        for (const R of ix.everHeld.get(T) ?? []) {
          if (!this.role(R)) continue
          const key = `${T}|${R}`,
            revs = ix.revokeEv.get(key) ?? EMPTY
          for (const g of ix.assignEv.get(key) ?? EMPTY) {
            if (!this.live(g)) continue
            if (
              revs.every(r => !this.effIn(r) || ix.before(r, g)) &&
              rem.every(r => !this.effIn(r) || ix.before(r, g))
            ) {
              v.add(R)
              break
            }
          }
        }
      }
      this.mHolds.set(T, v)
    }
    return v
  }
  perms(P: string): number {
    if (this.ix.owners.has(P)) return ALL
    let m = this.bits(EVERYONE) ?? 0
    for (const R of this.holds(P)) m |= this.bits(R) ?? 0
    return m
  }
  rankOf(R: string): Rank {
    return R === EVERYONE ? BOT : [this.pos(R) ?? -1, R]
  }
  rank(P: string): Rank {
    if (this.ix.owners.has(P)) return TOP
    if (!this.mem(P)) return NEG
    let r: Rank = BOT
    for (const R of this.holds(P)) {
      const q = this.rankOf(R)
      if (gt(q, r)) r = q
    }
    return r
  }
  codeIssuer(c: string): string | undefined {
    const x = this.ix.codeEv.get(c)
    return x !== undefined && this.inE(x) ? this.ix.ev[x].a : undefined
  }
  revokedC(c: string): boolean {
    let v = this.mRevC.get(c)
    if (v === undefined) {
      v = (this.ix.codeRev.get(c) ?? EMPTY).some(r => this.effIn(r))
      this.mRevC.set(c, v)
    }
    return v
  }
  codeDead(c: string): boolean {
    let v = this.mDead.get(c)
    if (v === undefined) {
      const x = this.ix.codeEv.get(c)
      v = x !== undefined && this.live(x) && this.ix.deathList(c).some(y => this.live(y))
      this.mDead.set(c, v)
    }
    return v
  }
  codeOk(c: string): boolean {
    let v = this.mCodeOk.get(c)
    if (v === undefined) {
      const x = this.ix.codeEv.get(c)
      v = false
      if (x !== undefined && this.live(x) && !this.revokedC(c)) {
        const iss = this.ix.ev[x].a
        v = this.mem(iss) && (this.perms(iss) & INVITE) !== 0
      }
      this.mCodeOk.set(c, v)
    }
    return v
  }
  hasCode(c: string): boolean {
    return this.codeOk(c) && !this.codeDead(c)
  }
  addsTo(T: string): Pend[] {
    let v = this.mAdds.get(T)
    if (v === undefined) {
      v = []
      const ix = this.ix,
        un = ix.uninvEv.get(T) ?? EMPTY
      for (const g of ix.addEv.get(T) ?? EMPTY) {
        if (!this.live(g)) continue
        if (!un.every(u => !this.effIn(u) || ix.before(u, g))) continue
        const e = ix.ev[g]
        v.push({ id: e.id, a: e.a, dev: e.dev, k: ix.k(g), code: e.c.code })
      }
      this.mAdds.set(T, v)
    }
    return v
  }
  /** add g (to T) is consumed: it passes the uninvite filter and a live join by T has it in its past */
  consumedIdx(g: number): boolean {
    let v = this.mCons.get(g)
    if (v === undefined) {
      const ix = this.ix,
        T = ix.ev[g].c.to
      v =
        this.addsTo(T).some(p => p.id === ix.ids[g]) &&
        (ix.joinEv.get(T) ?? EMPTY).some(j => this.live(j) && ix.before(g, j))
      this.mCons.set(g, v)
    }
    return v
  }
  invited(T: string): Pend[] {
    let v = this.mInv.get(T)
    if (v === undefined) {
      v = []
      for (const p of this.addsTo(T)) {
        if (this.consumedIdx(this.ix.at.get(p.id)!)) continue
        if (p.code !== undefined && !this.hasCode(p.code)) continue
        v.push(p)
      }
      this.mInv.set(T, v)
    }
    return v
  }
  /** v ∈ revoked: an effective device_revoke of v, or an effective primary_rotate that drops v (§3.9) */
  revoked(v: string): boolean {
    let r = this.mRevoked.get(v)
    if (r === undefined) {
      const ix = this.ix
      r = (ix.devRevEv.get(v) ?? EMPTY).some(d => this.effIn(d))
      if (!r) {
        for (const x of ix.introEv.get(v) ?? EMPTY) {
          if (!this.inE(x) || this.isXv(x)) continue
          const xa = ix.ev[x].a
          for (const rr of ix.rotBy.get(xa) ?? EMPTY) {
            if (rr === x || !this.effIn(rr) || ix.before(rr, x)) continue
            const re = ix.ev[rr]
            if (re.dev === v || ((re.c?.keep ?? []) as string[]).includes(v)) continue
            r = true
            break
          }
          if (r) break
        }
      }
      this.mRevoked.set(v, r)
    }
    return r
  }
  devHas(a: string, v: string): boolean {
    return (
      (this.ix.introEv.get(v) ?? EMPTY).some(x => this.ix.ev[x].a === a && this.live(x)) &&
      !this.revoked(v)
    )
  }

  private lf?: Facts
  /** This view through the `Facts` interface (only the parts that authority, rank and protection read). */
  facts(): Facts {
    if (this.lf) return this.lf
    const V = this
    const lf: any = {
      owners: this.ix.owners,
      mem: { has: (T: string) => V.mem(T) },
      ban: { has: (T: string) => V.ban(T) },
      effBanK: { get: (T: string) => V.effBanK(T) },
      invited: {
        get: (T: string) => {
          const l = V.invited(T)
          return l.length ? l : undefined
        },
      },
      roles: { has: (R: string) => V.role(R) },
      pos: { get: (R: string) => V.pos(R) },
      bits: { get: (R: string) => V.bits(R) },
      holds: {
        get: (T: string) => {
          const s = V.holds(T)
          return s.size ? s : undefined
        },
      },
      devs: { get: (a: string) => ({ has: (v: string) => V.devHas(a, v) }) },
      revoked: { has: (v: string) => V.revoked(v) },
      codes: { has: (c: string) => V.hasCode(c) },
      codeIssuer: { get: (c: string) => V.codeIssuer(c) },
      addsTo: {
        get: (T: string) => {
          const l = V.addsTo(T)
          return l.length ? l : undefined
        },
      },
      consumed: {
        has: (g: string) => {
          const i = V.ix.at.get(g)
          return i !== undefined && V.consumedIdx(i)
        },
      },
      codeOk: { has: (c: string) => V.codeOk(c) },
      codeDead: { has: (c: string) => V.codeDead(c) },
    }
    return (this.lf = lf as Facts)
  }
}

/** Register value of the position writes `ws` (ascending indices): the best maximal write (§1.5), or undefined. */
export function posValue(ix: Ix, ws: number[]): number | undefined {
  if (!ws.length) return undefined
  let best = -1
  const maxes: number[] = []
  for (let j = ws.length - 1; j >= 0; j--) {
    const w = ws[j]
    let dom = false
    for (const m of maxes)
      if (ix.has(m, w)) {
        dom = true
        break
      }
    if (dom) continue
    maxes.push(w)
    if (best < 0 || beatsI(ix, w, best)) best = w
  }
  return ix.ev[best].c.pos
}
/** w beats w2 in the stratified register: the higher k, then the lower pos, then the lower id */
export function beatsI(ix: Ix, w: number, w2: number): boolean {
  const c = cmp(ix.k(w), ix.k(w2))
  if (c !== 0) return c > 0
  const p = ix.ev[w].c.pos,
    p2 = ix.ev[w2].c.pos
  return p < p2 || (p === p2 && ix.ids[w] < ix.ids[w2])
}

/**
 * Position hull (§3.1 `PosHull`): the lowest ("min") or highest ("max") register value of the writes L when any subset
 * of the removable writes V is removed. A write w can be the value only if every write after it is removable; then w
 * wins iff the closure of beating writes that become maximal (scanning down from the top, only beating writes are
 * removed) contains no non-removable one. O(|L|·|L|) bit tests per hull, O(|L|) per candidate.
 */
export function hullI(ix: Ix, L: number[], V: Set<number>, dir: 'min' | 'max'): number | undefined {
  // (§5 "Position hull") Only L* matters: the writes all of whose later writes in L are removable. A write with a
  // non-removable later write y is below y, and y is either kept (hiding it) or an exposed beater that fails every
  // candidate, so it is never the value and never decides one. The non-removable writes of L* ("tops") are an
  // antichain (a non-removable write below another is not in L*), at most one per concurrent writer chain. Every write
  // of L* is a candidate (its later writes can all be removed), and w is the value for some removal set iff every
  // top that beats w is below w or below a write of L* that is not after w and does not beat w (remove every later
  // write and every removable beater, keep the rest: keeping more only hides more). Candidates are tried in the order
  // of the wanted position, so the first that passes is the hull. O(|L|·|tops|) for L*, then O(|L*|·|tops|) per tried
  // candidate; on a chain the first candidate passes. Equal to `hullRef` below (randomized check in the 5b-ii.3 report).
  if (!L.length) return undefined
  const star: number[] = [],
    tops: number[] = []
  for (let j = L.length - 1; j >= 0; j--) {
    const m = L[j]
    let hid = false
    for (const y of tops)
      if (ix.before(m, y)) {
        hid = true
        break
      }
    if (hid) continue
    star.push(m)
    if (!V.has(m)) tops.push(m)
  }
  return hullFromStar(ix, star, tops, dir)
}
/** the candidate test of `hullI` over L* (`star`) and its non-removable writes (`tops`) */
export function hullFromStar(
  ix: Ix,
  star: number[],
  tops: number[],
  dir: 'min' | 'max'
): number | undefined {
  const pos = (x: number) => ix.ev[x].c.pos as number
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

/** revision 5a's position hull, O(|L|^3) (reference for the randomized check of `hullI`) */
export function hullRef(
  ix: Ix,
  L: number[],
  V: Set<number>,
  dir: 'min' | 'max'
): number | undefined {
  let best: number | undefined
  for (const w of L) {
    let ok = true
    for (const x of L)
      if (x !== w && ix.before(w, x) && !V.has(x)) {
        ok = false
        break
      }
    if (!ok) continue
    const wp = ix.ev[w].c.pos
    if (best !== undefined && (dir === 'min' ? wp >= best : wp <= best)) continue
    // P = L minus the writes after w; scan P from the top: an element is exposed iff no kept element is after it
    const kept: number[] = []
    for (let j = L.length - 1; j >= 0 && ok; j--) {
      const m = L[j]
      if (m !== w && ix.before(w, m)) continue // removed with succ(w)
      let exposed = true
      for (const y of kept)
        if (ix.before(m, y)) {
          exposed = false
          break
        }
      if (!exposed) continue // below a kept element: never maximal, never needs removal
      if (m !== w && beatsI(ix, m, w)) {
        if (!V.has(m)) ok = false
        continue
      } // removed (or blocks w)
      kept.push(m)
    }
    if (ok) best = wp
  }
  return best
}

// ---------------------------------------------------------------- the views of §3.1

/** Decisions of the strata above the one being processed, and this stratum's cuts so far. */
export interface Strat {
  s: number // ordinal of the stratum being processed (0 = most senior)
  kk: Rank
  K(x: number): boolean // cut above
  here(x: number): boolean // cut at this stratum (decided so far)
  voidK(x: number): boolean // X ∪ K ∪ Tail
  high(x: number): boolean // effective above (revocations in force from the start)
  inS(x: number): boolean // x ∈ S (the set being evaluated; a downset of the index)
  isX(x: number): boolean // x ∈ X
}

/** index predicates of a recorded state (fast.ts only; the sets of EvalResult answer the same by id) */
export interface StIdx {
  ix: Ix
  X(i: number): boolean
  void(i: number): boolean
  eff(i: number): boolean
  /** the evaluation this state reads (states with one key agree on eff over their common events): `eff` for any of them */
  ep?: { key: object; eff(i: number): boolean }
}

const EMPTYSET = new Set<number>()
type NPred = ((x: number) => boolean) | null

/**
 * V_o(K ∪ N, +D) (mode "R", resources) and V°_o(K, N) (mode "O", obstacles) of §3.1: o's admission state St(o) with the
 * grants cut above (and, for resources, this world's grant cuts N) voided; resources add the denies D; obstacles drop
 * the denies o saw that are cut above or in N.
 */
class OpView extends View {
  lo: EvalResult
  li?: StIdx // the recorded state's own index predicates, when it was computed over an index numbered like this one
  ovX = -1 // a probe's extra move and the position it is read at (`posProbe`)
  ovP = 0
  posAt(x: number) {
    return x === this.ovX ? this.ovP : this.ix.ev[x].c.pos
  }
  constructor(
    ix: Ix,
    public o: number,
    public st: Strat | null,
    public mode: 'R' | 'O',
    public N: NPred,
    public extra: Set<number>
  ) {
    super(ix)
    this.lo = ix.rec[o].local
    const li = (this.lo as any)._idx as StIdx | undefined
    if (li && li.ix.ids[o] === ix.ids[o] && (o === 0 || li.ix.ids[o - 1] === ix.ids[o - 1]))
      this.li = li
  }
  // x ∈ B(o) ∪ extra; for x ∈ B(o) the numbering of both indexes agrees (an index numbers a set in admission order)
  loVoid(x: number) {
    const li = this.li
    return li && x < this.o && li.ix.ids[x] === this.ix.ids[x]
      ? li.void(x)
      : this.lo.void.has(this.ix.ids[x])
  }
  loEff(x: number) {
    const li = this.li
    return li && x < this.o && li.ix.ids[x] === this.ix.ids[x]
      ? li.eff(x)
      : this.lo.eff.has(this.ix.ids[x])
  }
  inE(x: number) {
    return this.ix.has(this.o, x) || this.extra.has(x)
  }
  hiE() {
    return this.o
  }
  extraE() {
    return this.extra
  }
  isXv(x: number) {
    const li = this.li
    return li && x < this.o && li.ix.ids[x] === this.ix.ids[x]
      ? li.X(x)
      : this.lo.X.has(this.ix.ids[x])
  }
  isVoid(x: number) {
    const ix = this.ix
    if (this.loVoid(x)) return true
    if (ix.isD[x] || !ix.has(this.o, x) || !this.st) return false
    if (this.st.K(x)) return true
    return this.mode === 'R' && this.N !== null && this.N(x)
  }
  isEff(x: number) {
    const ix = this.ix
    if (this.mode === 'R') return this.extra.has(x) || this.loEff(x)
    if (!this.loEff(x)) return false
    if (!ix.isD[x] || !this.st) return true
    if (this.st.K(x)) return false
    return !(this.N !== null && this.N(x))
  }
}

/** V_γ (later = null) and V_γ^p (later = the decisions after p that are removed): facts of S \ fut(γ) under the strata above. */
class CauseView extends View {
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

/** The final state: S with X ∪ cut ∪ Tail voided and the effective denies. */
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

/** An admission-state view of o (St(o) itself, or with the denies `extra` added): used when no stratum is involved. */
const stView = (ix: Ix, o: number, extra: Set<number> = EMPTYSET) =>
  new OpView(ix, o, null, 'R', null, extra)

/**
 * The monotone authority context of §3.1 (`authorized_{K,N}(o, +D)`, model.ts `monoCtx`), over keyed lazy views: the
 * author's rank `me` is `rankRes` (position hull PosHull⁻ over N's cut position grants of a held role), an obstacle
 * role's position is PosHull⁺ over N's cut position denies of that role.
 */
export class Mono {
  Fr: OpView
  Fo: OpView
  private meV?: Rank
  /** forget the author's rank (a probe moved its extra write) */
  resetMe() {
    this.meV = undefined
  }
  private memoR = new Map<string, Rank>()
  constructor(
    public ix: Ix,
    public o: number,
    public st: Strat | null,
    public N: NPred,
    public extra: Set<number>
  ) {
    this.Fr = new OpView(ix, o, st, 'R', N, extra)
    this.Fo = new OpView(ix, o, st, 'O', N, EMPTYSET)
  }
  /** NG / ND: position moves of R in B(o), not cut above, cut in this world, of class grant (G) or deny (D) */
  private nMoves(R: string, deny: boolean): number[] {
    const N = this.N
    if (!N) return EMPTY
    const ix = this.ix,
      o = this.o
    const out: number[] = []
    for (const x of ix.posW.get(R) ?? EMPTY) {
      if (ix.ev[x].t !== 'role_move' || ix.isD[x] !== deny || !ix.has(o, x)) continue
      if (this.st!.K(x) || !N(x)) continue
      out.push(x)
    }
    return out
  }
  /**
   * PosHull over the writes `inL` of R with removable writes `rem` (§3.1, §5): L* read from the top of R's position
   * writes, stopping at a non-removable write of L* that has every lower write of R in its past (everything below is
   * hidden); null when L* holds no removable write (then the hull is the plain register value).
   */
  private hullScan(
    R: string,
    inL: (x: number) => boolean,
    rem: (x: number) => boolean,
    dir: 'min' | 'max',
    extra: Iterable<number>
  ): number | undefined | null {
    const ix = this.ix,
      o = this.o,
      ws = ix.posW.get(R) ?? EMPTY,
      cov = ix.posCov(R)
    const star: number[] = [],
      tops: number[] = []
    let anyRem = false,
      stop = false
    const take = (x: number, k: number) => {
      for (const y of tops) if (ix.before(x, y)) return
      star.push(x)
      if (rem(x)) anyRem = true
      else {
        tops.push(x)
        if (cov[k]) stop = true
      }
    }
    let a = 0,
      b = ws.length
    while (a < b) {
      const m = (a + b) >> 1
      if (ws[m] < o) a = m + 1
      else b = m
    }
    const ex: number[] = []
    for (const x of extra) if (x >= o) ex.push(x)
    ex.sort((p, q) => q - p)
    for (const x of ex) {
      let lo = a,
        hi = ws.length
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
  me(): Rank {
    if (this.meV) return this.meV
    const ix = this.ix,
      a = ix.ev[this.o].a,
      Fr = this.Fr
    let me: Rank
    if (ix.owners.has(a)) me = TOP
    else if (!Fr.mem(a)) me = NEG
    else {
      me = BOT
      for (const R of Fr.holds(a)) {
        let p = Fr.pos(R) ?? -1
        if (this.N) {
          // roleWrites(B(o) + extra, void(St(o)) ∪ KG, eff(St(o)) ∪ extra): the cut grants of N stay in as removable
          const st = this.st!,
            N = this.N,
            o = this.o
          const inL = (x: number) => {
            if (!Fr.inE(x)) return false
            const inB = ix.has(o, x)
            const bv = Fr.loVoid(x) || (inB && !ix.isD[x] && st.K(x))
            if (ix.ev[x].t === 'role_create') return ix.ids[x] === R && !bv
            return this.extra.has(x) || Fr.loEff(x) || (!bv && ix.rec[x].cls === 'G')
          }
          const rem = (x: number) =>
            ix.ev[x].t === 'role_move' && !ix.isD[x] && ix.has(o, x) && !st.K(x) && N(x)
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
      const ix = this.ix,
        st = this.st!,
        N = this.N,
        o = this.o
      const rem = (x: number) =>
        ix.ev[x].t === 'role_move' && ix.isD[x] && ix.has(o, x) && !st.K(x) && N(x)
      const inL = (x: number) => {
        if (!ix.has(o, x)) return false
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
    const self = this
    return {
      Fr: this.Fr.facts(),
      Fo: this.Fo.facts(),
      get me() {
        return self.me()
      },
      rankOf: (R: string) => self.obsRankOf(R),
      rankT: (T: string) => self.rankT(T),
    } as AuthCtx
  }
  authorized(): boolean {
    const e = this.ix.ev[this.o]
    return deviceOk(e, this.Fr.facts()) && authCore(e, this.ctx())
  }
  /**
   * Authorized with the author's rank at its floor (BOT for a member) and every obstacle rank at its ceiling (TOP for a
   * member holding a role or a role other than @everyone), over these views. Cuts that are all role moves change only
   * positions (a move is read only by Pos), and authCore reads positions only through monotone rank comparisons, so if
   * this holds the op is authorized under any such cuts (§5 "Flat closure").
   */
  floorAuthorized(): boolean {
    const ix = this.ix,
      e = ix.ev[this.o],
      a = e.a,
      Fr = this.Fr,
      Fo = this.Fo
    const me: Rank = ix.owners.has(a) ? TOP : Fr.mem(a) ? BOT : NEG
    const ctx = {
      Fr: Fr.facts(),
      Fo: Fo.facts(),
      me,
      rankOf: (R: string): Rank => (R === EVERYONE ? BOT : TOP),
      rankT: (T: string): Rank =>
        ix.owners.has(T) ? TOP : !Fo.mem(T) ? NEG : Fo.holds(T).size ? TOP : BOT,
    } as AuthCtx
    return deviceOk(e, ctx.Fr) && authCore(e, ctx)
  }
}

// ---------------------------------------------------------------- Eval

const isRevocationT = (t: string) => t === 'device_revoke' || t === 'primary_rotate'
const isWithdrawalT = (t: string) => t === 'uninvite' || t === 'code_revoke'

export interface FastStats {
  strata: number
  causes: number
  maxCauses: number
  brokenTests: number
  worlds: number
  fallbacks: number
  maxClasses?: number
  maxRegion?: number
  maxFlat?: number
  probes?: number
  terms?: number
  floorSkips?: number
  maxWork?: number
}

/** Eval(S) over an index (spec §3.1, §5). */
export class FastEval {
  F = new Map<string, number>()
  FI = new Map<string, number>()
  X!: Uint8Array
  tail!: Uint8Array
  tailBy = new Map<number, number[]>()
  cutOrd: number[] = []
  cutRank: (Rank | undefined)[] = []
  effOrd: number[] = []
  effRank: (Rank | undefined)[] = []
  stats: FastStats = { strata: 0, causes: 0, maxCauses: 0, brokenTests: 0, worlds: 0, fallbacks: 0 }
  /** time per phase of the last runs (benchmarks, §7.7) */
  ms = { forks: 0, void: 0, tails: 0, strata: 0, result: 0, s3: 0, mv: 0, casc: 0 }
  private maxPos = new Map<string, number>()
  order: number[] // the indices of S, ascending (a topological order)
  constructor(
    public ix: Ix,
    public mS: Uint8Array | null = null
  ) {
    if (mS) {
      this.order = []
      for (let i = 0; i < ix.n; i++) if (mS[i]) this.order.push(i)
    } else this.order = Array.from({ length: ix.n }, (_, i) => i)
  }
  inS(i: number) {
    return this.mS === null || this.mS[i] === 1
  }

  // ---- §2.3 fork points and the void set
  /** contested identity ops (§2.3, [H17]): rotations with a sibling over the same iprev, and what builds on them */
  RF = new Set<string>()
  /**
   * headers of events this replica dropped (§2.3 orphan rule): device, seq, aprev, iprev, ap and the recorded depth,
   * epoch and pool. They count as every kind of evidence (revision 6, r5 review I1): device evidence for F, identity and
   * race evidence for FI, rotation evidence for RF, and their pools and places in the causal order for the pool
   * candidates, as model.ts `forkPoints` counts them. No held event has a header in its past.
   */
  ghosts: Ev[] = []
  /**
   * per header: its maximal indexed ancestors (`fr`, an antichain: B(g) ∩ indexed = ⋃ C(f) over f ∈ fr) and its header
   * parents (`hp`). Revision 7c (r7 re-review I1 (b)): a header is only ever tested against events of its own identity
   * (identity ops for FI, RF and the contested spread, pool events for P(x)), so x ∈ B(g) is |fr| bit tests on the
   * index, and no ancestor bitset over the index is built per header (revision 6 built one, O(n/32) per header per
   * evaluation: hdrbench). `FastEval.hdrBitset` restores that read for the differential (vector "r7c header read").
   */
  static hdrBitset = false
  private gInfo?: {
    ev: Ev
    slot: number
    fr: number[]
    hp: number[]
    anc?: Uint32Array
    gAnc?: Set<string>
  }[]
  private ghostInfo() {
    if (this.gInfo) return this.gInfo
    const ix = this.ix,
      byId = new Map(this.ghosts.map(g => [g.id, g]))
    type GI = {
      ev: Ev
      slot: number
      fr: number[]
      hp: number[]
      anc?: Uint32Array
      gAnc?: Set<string>
    }
    const memo = new Map<string, GI>()
    const out: GI[] = []
    const words = (ix.n + 31) >>> 5
    const info = (g: Ev): GI => {
      let r = memo.get(g.id)
      if (r) return r
      const cand: number[] = [],
        hp: number[] = []
      let anc: Uint32Array | undefined, gAnc: Set<string> | undefined
      if (FastEval.hdrBitset) {
        anc = new Uint32Array(words)
        gAnc = new Set()
      }
      for (const pid of g.ap) {
        const p = ix.at.get(pid)
        if (p !== undefined) {
          cand.push(p)
          if (anc) {
            const a = ix.anc[p]
            for (let w = 0; w < a.length; w++) anc[w] |= a[w]
            anc[p >>> 5] |= 1 << (p & 31)
          }
          continue
        }
        const pg = byId.get(pid)
        if (!pg)
          throw new Error(`fast: parent ${pid} of header ${g.id} neither indexed nor a header`)
        const q = info(pg)
        for (const f of q.fr) cand.push(f)
        hp.push(q.slot)
        if (anc) {
          for (let w = 0; w < words; w++) anc[w] |= q.anc![w]
          gAnc!.add(pid)
          for (const z of q.gAnc!) gAnc!.add(z)
        }
      }
      // the maximal ones: f is dropped when another candidate has it in its past (or equals it)
      const fr: number[] = []
      cand.sort((a, b) => b - a)
      for (const f of cand) if (!fr.some(h => h === f || ix.has(h, f))) fr.push(f)
      r = { ev: g, slot: out.length, fr, hp, anc, gAnc }
      memo.set(g.id, r)
      out.push(r) // post-order: a header after its header ancestors (causal order)
      return r
    }
    for (const g of this.ghosts) info(g)
    this.gInfo = out
    return out
  }
  /** x (indexed) ∈ B(g) for header slot k */
  private hdrHas(k: number, x: number): boolean {
    const g = this.gInfo![k]
    if (g.anc) return ((g.anc[x >>> 5] >>> (x & 31)) & 1) === 1
    for (const f of g.fr)
      if (f === x || (FMUT !== 'fast-hdr-parents' && this.ix.has(f, x))) return true
    return false
  }
  /** header slot u ∈ B(header slot v), by the header parents (identity ops only; memoized per v) */
  private hdrAnc = new Map<number, Set<number>>()
  private hdrBefore(u: number, v: number): boolean {
    const g = this.gInfo![v]
    if (g.gAnc) return g.gAnc.has(this.gInfo![u].ev.id)
    let a = this.hdrAnc.get(v)
    if (!a) {
      a = new Set()
      const st = [...g.hp]
      while (st.length) {
        const h = st.pop()!
        if (!a.has(h)) {
          a.add(h)
          st.push(...this.gInfo![h].hp)
        }
      }
      this.hdrAnc.set(v, a)
    }
    return a.has(u)
  }
  forkPoints() {
    const ix = this.ix,
      F = this.F,
      FI = this.FI,
      cx = ix.cx
    const gs = this.ghostInfo()
    const gBy = new Map<string, Ev[]>()
    for (const g of this.ghosts) pushM(gBy, g.dev, g)
    for (const [dev, es0] of ix.byDev) {
      const bySeq = new Map<number, number>(),
        byPrev = new Map<string, number>()
      const es: (number | Ev)[] = [...(gBy.get(dev) ?? []), ...es0]
      for (const i0 of es) {
        const i = typeof i0 === 'number' ? i0 : -1
        if (i >= 0 && !this.inS(i)) continue
        const e = i >= 0 ? ix.ev[i] : (i0 as Ev)
        const s1 = bySeq.get(e.seq)
        if (s1 !== undefined) {
          const m = Math.min(e.seq, s1)
          if (m < (F.get(dev) ?? Infinity)) F.set(dev, m)
        } else bySeq.set(e.seq, e.seq)
        const pk = e.aprev ?? ''
        const s2 = byPrev.get(pk)
        if (s2 !== undefined) {
          const m = Math.min(e.seq, s2)
          if (m < (F.get(dev) ?? Infinity)) F.set(dev, m)
          byPrev.set(pk, Math.min(s2, e.seq))
        } else byPrev.set(pk, e.seq)
      }
    }
    // a header alone on its device (no indexed events there)
    for (const [dev, gl] of gBy) {
      if (ix.byDev.has(dev)) continue
      const bySeq = new Set<number>(),
        byPrev = new Map<string, number>()
      for (const e of gl) {
        if (bySeq.has(e.seq)) {
          if (e.seq < (F.get(dev) ?? Infinity)) F.set(dev, e.seq)
        } else bySeq.add(e.seq)
        const pk = e.aprev ?? '',
          s2 = byPrev.get(pk)
        if (s2 !== undefined) {
          const m = Math.min(e.seq, s2)
          if (m < (F.get(dev) ?? Infinity)) F.set(dev, m)
          byPrev.set(pk, Math.min(s2, e.seq))
        } else byPrev.set(pk, e.seq)
      }
    }
    // identity ops: the indexed ones of S, then the headers (revision 6, I1: headers are identity, race and rotation
    // evidence too); `ref` is an index or a header
    type IdRef = { i: number; g?: number; e: Ev; depth: number; epoch: string; id: string }
    const idRefs: IdRef[] = []
    for (const i of ix.idOps)
      if (this.inS(i))
        idRefs.push({
          i,
          e: ix.ev[i],
          depth: ix.rec[i].depth,
          epoch: ix.rec[i].epoch,
          id: ix.ids[i],
        })
    if (FMUT !== 'fast-ghost-dev')
      gs.forEach((g, k) => {
        const r = cx.rec(g.ev.id)
        if (r.depth >= 0)
          idRefs.push({ i: -1, g: k, e: g.ev, depth: r.depth, epoch: r.epoch, id: g.ev.id })
      })
    // u ∈ B(v) over indexed events and headers (no indexed event has a header in its past)
    const before = (u: IdRef, v: IdRef) =>
      v.g === undefined
        ? u.g === undefined && ix.has(v.i, u.i)
        : u.g === undefined
          ? this.hdrHas(v.g, u.i)
          : this.hdrBefore(u.g, v.g)
    const byIdn = new Map<string, Map<string, number>>()
    for (const x of idRefs) {
      if (x.e.t === 'primary_rotate') continue
      const key = `${x.e.a}|${x.epoch}`
      let m = byIdn.get(key)
      if (!m) byIdn.set(key, (m = new Map()))
      const pk = x.e.iprev ?? ''
      const d0 = m.get(pk)
      if (d0 !== undefined) {
        const d = Math.min(d0, x.depth)
        if (d < (FI.get(key) ?? Infinity)) FI.set(key, d)
        m.set(pk, d)
      } else m.set(pk, x.depth)
    }
    // rotation evidence and contested identity ops (model.ts forkPoints): any two concurrent rotations of one identity
    // ([H19]); race evidence: a non-rotation identity op over the iprev of a rotation of its identity lowers FI of its
    // epoch to its depth
    const byRot = new Map<string, IdRef[]>()
    const rotPrev = new Set<string>()
    for (const x of idRefs)
      if (x.e.t === 'primary_rotate') {
        pushM(byRot, x.e.a, x)
        rotPrev.add(`${x.e.a}|${x.e.iprev ?? ''}`)
      }
    if (rotPrev.size)
      for (const x of idRefs) {
        if (x.e.t === 'primary_rotate' || !rotPrev.has(`${x.e.a}|${x.e.iprev ?? ''}`)) continue
        const key = `${x.e.a}|${x.epoch}`
        if (x.depth < (FI.get(key) ?? Infinity)) FI.set(key, x.depth)
      }
    const sib: IdRef[] = []
    for (const rs of byRot.values())
      for (let p = 0; p < rs.length; p++)
        for (let q = p + 1; q < rs.length; q++)
          if (!before(rs[p], rs[q]) && !before(rs[q], rs[p])) {
            this.RF.add(rs[p].id)
            this.RF.add(rs[q].id)
          }
    for (const rs of byRot.values()) for (const r of rs) if (this.RF.has(r.id)) sib.push(r)
    // indexed identity ops in index order, then the headers in causal order (an indexed op never builds on a header)
    if (sib.length)
      for (const x of idRefs) {
        if (this.RF.has(x.id)) continue
        if (x.e.t === 'primary_rotate') {
          if (
            x.e.iprev !== undefined &&
            this.RF.has(x.e.iprev) &&
            sib.some(q => q.e.a === x.e.a && !before(q, x) && !before(x, q))
          )
            this.RF.add(x.id)
        } else if (x.epoch !== '' && this.RF.has(x.epoch)) this.RF.add(x.id)
      }
    this.PC = this.poolCands()
  }
  /** pool candidates (model.ts poolCands; W3(g), [H20]) */
  PC = new Set<string>()
  /**
   * P(x) = U(x) ∪ ⋃ U(y) over the events y of x's identity concurrent with x, headers included (revision 6, I1).
   * Per identity, per device chain: on a linear chain the events concurrent with x are one segment (its ancestors of x
   * are a prefix, its descendants a suffix), found by two binary searches; prefix sums of |U| bound the union from
   * above, and U(x) ∪ conc(x) (disjoint, every event in its own U) from below; the union is formed only between the
   * two bounds. A device with forks (revision 6, r5 review C1 (b)): its events concurrent with x below x's index are
   * counted by popcount of the device's event bitset without anc(x); those above x one by one, stopping once the count
   * passes poolU (a sibling flood was O(N²) here). Rotations and device_revokes are never pool candidates (revision 6:
   * C1 (c)). Revision 7: only events before their device's fork point count as concurrent events (indexed or headers),
   * so every segment is linear and a forked device's siblings cost nothing here; the popcount branch stays for a device
   * whose pre-fork events are not totally ordered, which admission never produces.
   */
  poolCands(): Set<string> {
    const ix = this.ix,
      lim = LIM.poolU,
      PC = new Set<string>(),
      n = ix.n,
      Fd = this.F
    const gs = FMUT === 'fast-ghost-dev' ? [] : this.ghostInfo(),
      ng = gs.length
    const gSlot = new Map<string, number>(gs.map((g, k) => [g.ev.id, n + k]))
    const byA = new Map<string, number[]>()
    for (const i of this.order)
      if (ix.rec[i].pool && !ix.owners.has(ix.ev[i].a)) pushM(byA, ix.ev[i].a, i)
    const gByA = new Map<string, number[]>()
    gs.forEach((g, k) => {
      if (ix.cx.rec(g.ev.id).pool && !ix.owners.has(g.ev.a)) pushM(gByA, g.ev.a, k)
    })
    let stamp: Int32Array | undefined,
      cur = 0,
      cnt = 0
    const poolIx = (y: number) => {
      let p = ix.poolIx[y]
      if (!p) {
        const l = ix.rec[y].pool!
        p = ix.poolIx[y] = Int32Array.from(l, id => ix.at.get(id) ?? -1)
      }
      return p
    }
    const add = (z: number) => {
      if (z >= 0 && stamp![z] !== cur) {
        stamp![z] = cur
        cnt++
      }
    }
    // pool ids that are headers (not indexed) are found by id
    const addPool = (y: number) => {
      const p = poolIx(y)
      for (let k = 0; k < p.length; k++) {
        if (p[k] >= 0) add(p[k])
        else if (ng) {
          const s = gSlot.get(ix.rec[y].pool![k])
          if (s !== undefined) add(s)
        }
      }
    }
    const addGPool = (k: number) => {
      for (const id of ix.cx.rec(gs[k].ev.id).pool!) {
        const z = ix.at.get(id) ?? gSlot.get(id)
        if (z !== undefined) add(z)
      }
    }
    const exempt = (t: string) => t === 'primary_rotate' || t === 'device_revoke'
    for (const [a, es] of byA) {
      const gl = (gByA.get(a) ?? EMPTY).filter(
        k => gs[k].ev.seq < (Fd.get(gs[k].ev.dev) ?? Infinity)
      )
      if (es.length + gl.length <= 1) continue
      if (!gl.length) {
        let chain = true
        for (let k = 1; k < es.length && chain; k++) if (!ix.has(es[k], es[k - 1])) chain = false
        if (chain) continue // totally ordered: nothing is concurrent
      }
      // revision 7 (controller ruling on r6.1, C1 option 2): only events before their device's fork point count as y
      // (model.ts poolCands); they are one linear chain per device
      const byD = new Map<string, number[]>()
      for (const i of es)
        if (ix.ev[i].seq < (Fd.get(ix.ev[i].dev) ?? Infinity)) pushM(byD, ix.ev[i].dev, i)
      const segs: { l: number[]; lin: boolean; pre: number[]; bits?: Uint32Array }[] = []
      for (const l of byD.values()) {
        let lin = true
        for (let k = 1; k < l.length && lin; k++) if (!ix.has(l[k], l[k - 1])) lin = false
        const pre = [0]
        for (const y of l) pre.push(pre[pre.length - 1] + ix.rec[y].pool!.length)
        let bits: Uint32Array | undefined
        if (!lin) {
          bits = new Uint32Array((n + 31) >>> 5)
          for (const y of l) bits[y >>> 5] |= 1 << (y & 31)
        }
        segs.push({ l, lin, pre, bits })
      }
      const sp: number[] = [],
        sq: number[] = [],
        conc: number[][] = []
      for (const x of es) {
        if (exempt(ix.ev[x].t)) continue
        const ux = ix.rec[x].pool!.length
        let lo = ux,
          hi = ux,
          over = false
        const ax = ix.anc[x]
        for (let si = 0; si < segs.length && !over; si++) {
          const { l, lin, pre, bits } = segs[si]
          let p = 0,
            q = 0
          if (lin) {
            // first index not in B(x); first index with x in its past (or x itself)
            let a0 = 0,
              b = l.length
            while (a0 < b) {
              const m = (a0 + b) >> 1
              if (ix.has(x, l[m])) a0 = m + 1
              else b = m
            }
            p = a0
            b = l.length
            while (a0 < b) {
              const m = (a0 + b) >> 1
              if (l[m] === x || ix.has(l[m], x)) b = m
              else a0 = m + 1
            }
            q = a0
            if (q > p) {
              lo += q - p
              hi += pre[q] - pre[p]
            }
            // revision 7c (r7 re-review I1 (a)): stop once the lower bound passes poolU, as for a forked device; without
            // it every event of an identity visited every device chain (idbench: 820 sibling introductions, 1.2 s)
            if (lo > lim) {
              over = true
              break
            }
          } else {
            // below x: concurrent iff not in B(x) (popcount); above x: concurrent iff x not in its past
            const xw = x >>> 5
            let c = 0
            for (let w = 0; w < xw; w++) c += popcount(bits![w] & ~ax[w])
            c += popcount(bits![xw] & ~(ax[xw] ?? 0) & ((1 << (x & 31)) - 1))
            lo += c
            if (lo > lim) {
              over = true
              break
            }
            const cl: number[] = []
            for (let w = 0; w <= xw; w++) {
              let m = bits![w] & ~(ax[w] ?? 0)
              if (w === xw) m &= (1 << (x & 31)) - 1
              while (m) {
                const b = m & -m
                cl.push((w << 5) + (31 - Math.clz32(b)))
                m ^= b
              }
            }
            for (const y of cl) hi += ix.rec[y].pool!.length
            let k = firstTrue(0, l.length, j => l[j] > x)
            for (; k < l.length; k++) {
              const y = l[k]
              if (ix.has(y, x)) continue
              cl.push(y)
              lo++
              hi += ix.rec[y].pool!.length
              if (lo > lim) {
                over = true
                break
              }
            }
            conc[si] = cl
          }
          sp[si] = p
          sq[si] = q
        }
        const gc: number[] = []
        if (!over)
          for (const k of gl) {
            if (this.hdrHas(k, x)) continue // x in the header's past
            gc.push(k)
            lo++
            hi += ix.cx.rec(gs[k].ev.id).pool!.length
            if (lo > lim) {
              over = true
              break
            }
          }
        if (over || lo > lim) {
          PC.add(ix.ids[x])
          continue
        }
        if (hi <= lim) continue
        // exact union, by a stamp per event: U(x), then per linear segment its events and the pool of its last event
        // (which holds most of the segment's pools), then the remaining pools, stopping once past the limit
        if (!stamp) stamp = new Int32Array(n + ng)
        cur++
        cnt = 0
        addPool(x)
        for (let si = 0; si < segs.length && cnt <= lim; si++) {
          const { l, lin } = segs[si]
          if (lin) {
            for (let k = sp[si]; k < sq[si]; k++) add(l[k])
            if (sq[si] > sp[si]) addPool(l[sq[si] - 1])
          } else for (const y of conc[si]) addPool(y)
        }
        for (let k = 0; k < gc.length && cnt <= lim; k++) addGPool(gc[k])
        for (let si = 0; si < segs.length && cnt <= lim; si++) {
          const { l, lin } = segs[si]
          if (lin) for (let k = sp[si]; k < sq[si] - 1 && cnt <= lim; k++) addPool(l[k])
        }
        if (cnt > lim) PC.add(ix.ids[x])
      }
    }
    return PC
  }
  /** an identity op (or the genesis) is a candidate, structurally (§2.3): no witness or X involved */
  idCand(
    x: number,
    F: Map<string, number>,
    FI: Map<string, number>,
    RF: Set<string> | undefined,
    PC?: Set<string>
  ): boolean {
    const e = this.ix.ev[x],
      r = this.ix.rec[x],
      id = this.ix.ids[x]
    if (e.t === 'genesis') return false
    if (e.t === 'primary_rotate') return RF?.has(id) ?? false
    if (e.seq >= (F.get(e.dev) ?? Infinity)) return true
    if (PC?.has(id)) return true
    return r.depth >= fiOf(FI, e.a, r.epoch) || (RF?.has(id) ?? false)
  }
  /** cleanIntro(x): not contested, and a rotation or an identity op before its epoch's fork point */
  private cleanIntro(x: number) {
    const e = this.ix.ev[x],
      r = this.ix.rec[x]
    return (
      !this.RF.has(this.ix.ids[x]) &&
      !this.PC.has(this.ix.ids[x]) &&
      (e.t === 'primary_rotate' || r.depth < fiOf(this.FI, e.a, r.epoch))
    )
  }
  /** some identity op of w's own identity in C(w) introduces w.dev cleanly */
  private introducedCleanly(w: number) {
    const ix = this.ix,
      we = ix.ev[w]
    for (const x of ix.introEv.get(we.dev) ?? EMPTY) {
      if (x !== w && !ix.has(w, x)) continue
      if (ix.rec[x].depth < 0 || ix.ev[x].a !== we.a) continue
      if (this.cleanIntro(x)) return true
    }
    return false
  }
  /**
   * droppedBy(r, S) of model.ts: devices of r's identity introduced by an event not after r, other than r's own and its
   * keep; `skip` leaves out introductions ([H17]: candidates for watermarks, X events for tails)
   */
  droppedS(r: number, skip: (x: number) => boolean = () => false): string[] {
    const ix = this.ix,
      re = ix.ev[r]
    const keep = new Set<string>([re.dev, ...((re.c?.keep ?? []) as string[])])
    const out = new Set<string>()
    for (const x of ix.introBy.get(re.a) ?? EMPTY) {
      if (x === r || !this.inS(x) || ix.has(x, r) || skip(x)) continue
      for (const v of introduces(ix.ev[x])) if (!keep.has(v)) out.add(v)
    }
    return [...out].sort()
  }
  /** candidate x in a state with fork points F, FI and contested set RF (§2.3; [H17]: introductions by structure) */
  candidateIn(
    x: number,
    F: Map<string, number>,
    FI: Map<string, number>,
    RF: Set<string> | undefined,
    PC?: Set<string>
  ) {
    const ix = this.ix,
      e = ix.ev[x],
      r = ix.rec[x]
    if (r.depth >= 0 || e.t === 'genesis') return this.idCand(x, F, FI, RF, PC)
    if (e.seq >= (F.get(e.dev) ?? Infinity)) return true
    if (PC?.has(ix.ids[x])) return true
    let n = 0
    for (const y of ix.introEv.get(e.dev) ?? EMPTY) {
      if (!ix.has(x, y) || ix.rec[y].depth < 0) continue
      if (!this.idCand(y, F, FI, RF, PC)) return false
      n++
    }
    return n > 0
  }
  voidSet() {
    const ix = this.ix,
      F = this.F,
      FI = this.FI,
      n = ix.n
    const wm = new Map<string, number>()
    const lower = (v: string, s: number) => {
      if (s < (wm.get(v) ?? Infinity)) wm.set(v, s)
    }
    for (const i of this.order) {
      const e = ix.ev[i]
      if (e.t === 'device_revoke' && typeof e.c?.dev === 'string') {
        if (
          e.seq < (F.get(e.dev) ?? Infinity) &&
          !this.PC.has(ix.ids[i]) &&
          this.introducedCleanly(i)
        )
          lower(e.c.dev, typeof e.c.seen === 'number' ? e.c.seen : -1)
      }
      if (e.t === 'primary_rotate' && !this.RF.has(ix.ids[i]))
        for (const v of this.droppedS(i, x => this.idCand(x, F, FI, this.RF, this.PC)))
          lower(v, (e.c.seen?.[v] ?? -1) as number)
    }
    const clean = new Int8Array(n).fill(-1)
    const isClean = (w: number) => {
      if (clean[w] >= 0) return clean[w] === 1
      const we = ix.ev[w],
        r = ix.rec[w]
      const v =
        we.seq < (F.get(we.dev) ?? Infinity) &&
        !(we.seq > (wm.get(we.dev) ?? Infinity)) &&
        !(r.depth >= 0 && we.t !== 'primary_rotate' && r.depth >= fiOf(FI, we.a, r.epoch)) &&
        !(r.depth >= 0 && this.RF.has(ix.ids[w])) &&
        !this.PC.has(ix.ids[w]) &&
        this.introducedCleanly(w)
      clean[w] = v ? 1 : 0
      return v
    }
    const X = new Uint8Array(n)
    const seen = new Int32Array(n).fill(-1)
    for (const i of this.order) {
      if (!this.candidateIn(i, F, FI, this.RF, this.PC)) continue
      // witnessed: a descendant by another identity, clean, in good faith (i not a candidate in its admission state).
      // Structural candidacy only grows with the set (§2.3), so once i is a structural candidate in St(w), it is one in
      // St(w') for every w' after w: the search does not go past such a w (§5; without it each candidate costs a walk
      // of its whole future). Revision 7: pool candidacy can end (only events before their fork points count), so a
      // pool candidacy in St(w) makes w no witness but does not stop the search (vector "r7.9"; mutant fast-prune-pool)
      const a = ix.ev[i].a
      let wit = false
      const st = [i]
      while (st.length && !wit) {
        const y = st.pop()!
        for (const w of ix.kids[y]) {
          if (seen[w] === i || !this.inS(w)) continue
          seen[w] = i
          const lo = ix.rec[w].local
          if (this.candidateIn(i, lo.F, lo.FI, lo.RF, lo.PC)) {
            if (FMUT === 'fast-prune-pool' || this.candidateIn(i, lo.F, lo.FI, lo.RF, undefined))
              continue
            st.push(w)
            continue
          }
          if (ix.ev[w].a !== a && isClean(w)) {
            wit = true
            break
          }
          st.push(w)
        }
      }
      if (!wit) X[i] = 1
    }
    this.X = X
  }
  tails(): number[] {
    const ix = this.ix,
      n = ix.n,
      X = this.X
    this.tail = new Uint8Array(n)
    const revs: number[] = []
    for (const i of this.order) {
      const t = ix.ev[i].t
      if ((t === 'device_revoke' || t === 'primary_rotate') && !X[i]) revs.push(i)
    }
    for (const r of revs) {
      const re = ix.ev[r]
      const covered =
        re.t === 'device_revoke'
          ? [{ dev: re.c.dev as string, seen: re.c.seen as number }]
          : this.droppedS(r, x => X[x] === 1).map(v => ({
              dev: v,
              seen: (re.c.seen?.[v] ?? -1) as number,
            }))
      for (const { dev, seen } of covered) {
        for (const o of ix.byDev.get(dev) ?? EMPTY) {
          if (!this.inS(o) || ix.ev[o].seq <= seen || ix.fixed[o]) continue
          let l = this.tailBy.get(o)
          if (!l) this.tailBy.set(o, (l = []))
          if (!l.includes(r)) l.push(r)
          this.tail[o] = 1
        }
      }
    }
    return revs
  }
  /** the highest position any write in S gives role R (an upper bound of its position in every view), or -1 */
  maxPosOf(R: string): number {
    let m = this.maxPos.get(R)
    if (m === undefined) {
      m = -1
      for (const x of this.ix.posW.get(R) ?? EMPTY) m = Math.max(m, this.ix.ev[x].c.pos)
      this.maxPos.set(R, m)
    }
    return m
  }
  /** an upper bound of rank(P) in every view of S (owners ⊤; otherwise the best role P was ever assigned at its highest written position) */
  rankBound(P: string): Rank {
    if (this.ix.owners.has(P)) return TOP
    let r: Rank = BOT
    for (const R of this.ix.everHeld.get(P) ?? []) {
      const q: Rank = [this.maxPosOf(R), R]
      if (gt(q, r)) r = q
    }
    return r
  }

  // ---- §3.1 the stratum loop
  private highByTarget = new Map<string, number[]>() // effective denies about principal P (kick/ban/revoke of P, leave by P)
  private highByRole = new Map<string, number[]>() // effective role_move / role_bits / role_del of R
  private noteEffective(d: number) {
    const e = this.ix.ev[d]
    if (e.t === 'kick' || e.t === 'ban' || e.t === 'revoke') pushM(this.highByTarget, e.c.to, d)
    else if (e.t === 'leave') pushM(this.highByTarget, e.a, d)
    else if (e.t === 'role_move' || e.t === 'role_bits' || e.t === 'role_del')
      pushM(this.highByRole, e.c.role, d)
  }
  /** the effective higher denies that can change P's rank (model.ts `relevant`): the only ones that matter for k* and V_γ^p */
  private relevantHighs(P: string): number[] {
    const out = [...(this.highByTarget.get(P) ?? EMPTY)]
    for (const R of this.ix.everHeld.get(P) ?? [])
      for (const d of this.highByRole.get(R) ?? EMPTY) out.push(d)
    return out
  }
  frontier(o: number, d: number) {
    const ix = this.ix
    if (o === d || ix.has(d, o)) return false
    if (!ix.has(o, d)) return true
    const lo = ix.rec[o].local,
      li = (lo as any)._idx as StIdx | undefined
    return !(li && li.ix.ids[d] === ix.ids[d] ? li.eff(d) : lo.eff.has(ix.ids[d]))
  }

  run(): EvalResult {
    const ix = this.ix,
      n = ix.n
    const t0 = performance.now()
    this.forkPoints()
    const t1 = performance.now()
    this.voidSet()
    const t2 = performance.now()
    const revs = this.tails()
    const t3 = performance.now()
    this.ms.forks += t1 - t0
    this.ms.void += t2 - t1
    this.ms.tails += t3 - t2
    const X = this.X,
      tail = this.tail
    const cutOrd = (this.cutOrd = new Array(n).fill(-1))
    this.cutRank = new Array(n).fill(undefined)
    const effOrd = (this.effOrd = new Array(n).fill(-2))
    this.effRank = new Array(n).fill(undefined)
    for (const r of revs) effOrd[r] = -1
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
    const t4 = performance.now()
    for (let s = 0; s < strata.length; s++)
      this.stratum(s, strata[s], tailAt.get(rkey(strata[s])) ?? EMPTY)
    const t5 = performance.now()
    const r = this.result()
    this.ms.strata += t5 - t4
    this.ms.result += performance.now() - t5
    return r
  }

  private stratum(s: number, kk: Rank, tailHere: number[]) {
    const ix = this.ix,
      X = this.X,
      tail = this.tail,
      cutOrd = this.cutOrd,
      effOrd = this.effOrd
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
    // k*(o) under the decisions above (memo), and with a world's cuts N (§1.6, §3.1)
    const ksMemo = new Map<number, Rank>()
    const kstar = (o: number, N: NPred): Rank => {
      if (ix.isD[o]) return ix.k(o)
      if (!N) {
        const v = ksMemo.get(o)
        if (v) return v
      }
      const extra = new Set<number>()
      for (const d of this.relevantHighs(ix.ev[o].a)) if (this.frontier(o, d)) extra.add(d)
      const v = minR(ix.k(o), new Mono(ix, o, st, N, extra).me())
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
        const M = new Mono(ix, o, st, null, EMPTYSET)
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
      !new Mono(ix, o, st, null, new Set([d])).authorized()
    // (§5 "Role-wide denies") a deny on a role R that o has not seen changes o's resources only through R: a bit clear
    // of (R, b) clears b of R whichever event it is (no setter in B(o) is after it), a deletion removes R whichever event
    // it is, so uses(o, d) is memoized per op and per (R, b) or R. A move of R whose past holds every position write of
    // R in B(o) makes R's position its own; authCore reads the author's rank only through monotone comparisons, so
    // uses(o, d) is monotone in that position, and each op keeps the highest position known to break it and the lowest
    // known not to: with the moves visited in bisection order of position (step 3), O(log) exact tests per op and role.
    const sigMemo = new Map<number, Map<string, boolean>>()
    const ivl = new Map<number, Map<string, [number, number]>>()
    const mxMemo = new Map<string, number[]>()
    const maxW = (o: number, R: string): number[] => {
      const key = `${o}|${R}`
      let m = mxMemo.get(key)
      if (m) return m
      m = []
      const ws = ix.posW.get(R) ?? EMPTY,
        cov = ix.posCov(R)
      let a = 0,
        b = ws.length
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
        const R = de.c.role as string
        for (const x of maxW(o, R)) if (!ix.has(d, x)) return usesExact(o, d)
        const p = de.c.pos as number
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
    // V_γ and V_γ^p (§3.1), one lazy view per cause and per distinct set of later relevant decisions
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
    const exposed = (p: number, g: number, V: () => View): boolean => {
      const pe = ix.ev[p],
        ge = ix.ev[g],
        P = pe.a
      if (ix.owners.has(P)) return false
      const ub = this.rankBound(P)
      if (isRevocationT(ge.t)) {
        if (!gt(ub, kk)) return true
      } else if (pe.t === 'join') {
        if (isWithdrawalT(ge.t) && !(permsF(ix.rec[g].local.facts, ge.a) & KICK)) return false
        if (cmp(ub, kk) < 0) return true
      } else if (!gt(ub, kk)) return true
      return exposedTo(pe, ge, ix.rec[g], V().facts(), kk)
    }
    const direct = new Map<number, number[]>() // cause -> its direct cuts at kk
    const addD = (g: number, o: number) => pushM(direct, g, o)

    // 0. revocation cuts: tail ops at this stratum, attributed to every revocation whose tail holds them
    for (const o of tailHere) if (alive(o)) for (const r of this.tailBy.get(o)!) addD(r, o)

    // 1. self-denies at kk: effective; they cut their author's ops that did not see them, at or below kk
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

    // 3. frontier cuts over the readers of what the deny can take away. Moves of one role are visited in bisection
    // order of their position (the per-op intervals of `uses` then settle each op in O(log) exact tests); the order of
    // visits changes nothing else
    const tS3 = performance.now()
    const stamp = new Int32Array(ix.n).fill(-1)
    const byRoleMv = new Map<string, number[]>()
    const order3: number[] = []
    for (const d of effNS)
      if (ix.ev[d].t === 'role_move') pushM(byRoleMv, ix.ev[d].c.role, d)
      else order3.push(d)
    if (!FASTOPT.moveChains)
      for (const l of byRoleMv.values()) {
        l.sort((x, y) => ix.ev[x].c.pos - ix.ev[y].c.pos || x - y)
        const q: [number, number][] = [[0, l.length]]
        for (let h = 0; h < q.length; h++) {
          const [lo, hi] = q[h]
          if (lo >= hi) continue
          const mid = (lo + hi) >> 1
          order3.push(l[mid])
          q.push([lo, mid], [mid + 1, hi])
        }
      }
    for (const d of order3) {
      const de = ix.ev[d],
        dr = ix.rec[d]
      const tg = target(de, dr.local.facts)
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
    const tMv = performance.now()
    const monoK = (o: number) => {
      authorizedK(o)
      return authKMono.get(o)!
    }
    const mv = FASTOPT.moveChains
      ? this.moveCuts(
          byRoleMv,
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
      : null
    const tC = performance.now()
    this.ms.s3 += tMv - tS3
    this.ms.mv += tC - tMv

    // 4. the cascade with exact per-cause protection (§3.1 step 4, §3.1.1)
    // Γ: the causes with direct cuts (a cause that cuts nothing contributes to no world, [H16])
    const causeSet = new Set<number>(
      [...selves, ...effNS].filter(g => direct.has(g) || (mv !== null && mv.cutBy.has(g)))
    )
    for (const g of direct.keys()) if (isRevocationT(ix.ev[g].t)) causeSet.add(g)
    const byId = (a: number, b: number) =>
      ix.ids[a] < ix.ids[b] ? -1 : ix.ids[a] > ix.ids[b] ? 1 : 0
    // the bit order of the causes is free (step 4 compares cause sets only): the moves of a role with range terms take
    // one block in position order, so a term is a range of bits
    const causes = [...causeSet].filter(g => mv === null || !mv.inBlock(g)).sort(byId)
    const termDc = mv === null ? new Map<number, bigint>() : mv.masks(causes, causeSet)
    this.stats.causes += causes.length
    this.stats.maxCauses = Math.max(this.stats.maxCauses, causes.length)
    if (causes.length)
      this.cascade(st, causes, direct, alive, authorizedK, below, exposed, Vfor, termDc, floorK)
    this.ms.casc += performance.now() - tC
    for (const d of [...selves, ...effNS]) {
      effOrd[d] = s
      this.effRank[d] = kk
      this.noteEffective(d)
    }
  }

  /**
   * Step 3 for the effective moves at this stratum (§5 "Move storms"): per role R, the moves are split into mover chains
   * (per author and device), and each holder op o of R is matched against each chain by binary search: the moves in
   * B(o) are a prefix, those after o a suffix, the concurrent ones the range between (all frontier). Of the prefix, only
   * the moves o's admission state does not hold effective are frontier; states read from one evaluation agree on that,
   * so the chain's list is built once per evaluation and per chain. A concurrent move whose past holds o's maximal
   * writes of R ("cover", a suffix of the chain) gives R its own position, and uses(o, ·) is monotone in it: with
   * exposure decided by o's rank bound, the cuts of the chain's covering range are the moves of rank (position order)
   * below a threshold r found by probes at positions, a range term (chain, lo, hi, r). Every other pair is tested as in
   * the visit loop. O(holder ops × chains × log) instead of O(holder ops × moves), plus the pairs that are tested.
   */
  private moveCuts(
    byRoleMv: Map<string, number[]>,
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
    const ix = this.ix,
      kk = st.kk
    interface Ch {
      c: number[]
      rk: Int32Array
      role: number
    }
    interface Rl {
      R: string
      gs: number[]
      gpos: number[]
      terms: boolean
    }
    const chains: Ch[] = [],
      roles: Rl[] = []
    const terms = new Map<number, number[]>() // op -> [chain, lo, hi, r]*: the chain's moves in [lo, hi) of rank < r cut o
    const epL = new Map<object, Map<number, Int32Array | null>>()
    const neList = (o: number, ci: number): Int32Array | null => {
      const li = (ix.rec[o].local as any)._idx as StIdx | undefined
      if (!li || !li.ep) return null
      let m = epL.get(li.ep.key)
      if (!m) epL.set(li.ep.key, (m = new Map()))
      let l = m.get(ci)
      if (l === undefined) {
        const c = chains[ci].c,
          out: number[] = []
        let ok = true
        for (let j = 0; j < c.length && ok; j++) {
          if (li.ix !== ix && li.ix.ids[c[j]] !== ix.ids[c[j]]) ok = false
          else if (!li.ep.eff(c[j])) out.push(j)
        }
        m.set(ci, (l = ok ? Int32Array.from(out) : null))
      }
      return l
    }
    // a probe reuses o's view of step 1-3 (authorizedK): adding the move dS changes only Pos(R) (a move is read only by
    // Pos), so the view gets dS as its extra write, read at the probed position, and Pos(R) and the author's rank are
    // recomputed; the view is restored after each probe
    const posProbe = (o: number, dS: number, R: string) => {
      const M = monoK(o),
        Fr = M.Fr,
        ex = new Set([dS])
      return (p: number) => {
        const ex0 = Fr.extra
        Fr.extra = ex
        Fr.ovX = dS
        Fr.ovP = p
        Fr.resetPos(R)
        M.resetMe()
        this.stats.probes = (this.stats.probes ?? 0) + 1
        const v = !M.authorized()
        Fr.extra = ex0
        Fr.ovX = -1
        Fr.resetPos(R)
        M.resetMe()
        return v
      }
    }
    for (const [R, l] of byRoleMv) {
      const ri = roles.length
      const gs = [...l].sort((x, y) => ix.ev[x].c.pos - ix.ev[y].c.pos || x - y)
      const gpos = gs.map(d => ix.ev[d].c.pos as number)
      const rk = new Map<number, number>(gs.map((d, i) => [d, i]))
      roles.push({ R, gs, gpos, terms: false })
      const runsBy = new Map<string, number[][]>()
      for (const d of [...l].sort((x, y) => x - y)) {
        const k = `${ix.ev[d].a}\u0001${ix.ev[d].dev}`
        runsBy.set(k, chainCover(ix, d, runsBy.get(k) ?? []))
      }
      const chs: number[] = []
      for (const rs of runsBy.values())
        for (const c of rs) {
          chs.push(chains.length)
          chains.push({ c, rk: Int32Array.from(c, d => rk.get(d)!), role: ri })
        }
      let guess = gs.length >> 1
      const thr = (o: number, dS: number): number => {
        let m = ivl.get(o)
        if (!m) ivl.set(o, (m = new Map()))
        let iv = m.get(R)
        if (!iv) m.set(R, (iv = [Infinity, -Infinity]))
        let probe: ((p: number) => boolean) | undefined
        const f = (p: number) => {
          if (p >= iv![0]) return false
          if (p <= iv![1]) return true
          probe ??= posProbe(o, dS, R)
          const v = probe(p)
          if (v) iv![1] = Math.max(iv![1], p)
          else iv![0] = Math.min(iv![0], p)
          return v
        }
        const n = gpos.length,
          g = Math.min(Math.max(guess, 0), n)
        let lo = 0,
          hi = n
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
      const fr: number[] = [],
        seen: number[] = []
      const moveOp = (o: number) => {
        if (!alive(o)) return
        fr.length = 0
        seen.length = 0
        for (const ci of chs) {
          const c = chains[ci].c,
            m = c.length
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
        if (!fr.length && !seen.length) return
        if (!below(o) || !authorizedK(o)) return
        const pe = ix.ev[o],
          ub = this.rankBound(pe.a)
        const allExp = pe.t === 'join' ? cmp(ub, kk) < 0 : !gt(ub, kk)
        const pair = (d: number) => {
          if ((allExp || exposed(o, d, () => Vfor(d, o))) && uses(o, d)) addD(d, o)
        }
        for (const d of seen) pair(d)
        for (let t = 0; t < fr.length; t += 3) {
          const ci = fr[t],
            c = chains[ci].c,
            a = fr[t + 1],
            b = fr[t + 2]
          if (!allExp || !FASTOPT.terms) {
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
              this.stats.terms = (this.stats.terms ?? 0) + 1
            }
          }
        }
      }
      for (const P of ix.heldBy.get(R) ?? []) {
        if (ix.owners.has(P)) continue // never exposed (§3.1 step 3)
        for (const key of ix.adOf.get(P) ?? EMPTY)
          for (const run of ix.runsOf(key)) {
            const nS = this.mS ? firstTrue(0, run.length, j => !this.inS(run[j])) : run.length
            for (let j = 0; j < nS; j++) moveOp(run[j])
          }
      }
    }
    // the moves with a direct cut through a term: per chain, each position's highest rank bound (terms in descending r,
    // each position assigned once through a union-find over the unassigned ones)
    const cutBy = new Set<number>()
    const byChain = new Map<number, number[]>()
    for (const ts of terms.values())
      for (let t = 0; t < ts.length; t += 4) {
        pushM(byChain, ts[t], ts[t + 1])
        byChain.get(ts[t])!.push(ts[t + 2], ts[t + 3])
      }
    for (const [ci, ts] of byChain) {
      const ch = chains[ci],
        m = ch.c.length,
        best = new Int32Array(m).fill(-1),
        nxt = Int32Array.from({ length: m + 1 }, (_, j) => j)
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
        const lo = ts[3 * k],
          hi = ts[3 * k + 1],
          r = ts[3 * k + 2]
        for (let j = find(lo); j < hi; j = find(j + 1)) {
          best[j] = r
          nxt[j] = j + 1
        }
      }
      for (let j = 0; j < m; j++) if (ch.rk[j] < best[j]) cutBy.add(ch.c[j])
    }
    const blockRole = new Map<number, number>() // move -> its role, for the roles with terms
    for (let ri = 0; ri < roles.length; ri++)
      if (roles[ri].terms) for (const d of roles[ri].gs) blockRole.set(d, ri)
    return {
      cutBy,
      inBlock: (g: number) => blockRole.has(g),
      /** append each block (a role's causes in position order) to `causes` and return the term masks per op */
      masks: (causes: number[], causeSet: Set<number>): Map<number, bigint> => {
        const out = new Map<number, bigint>()
        if (!terms.size) return out
        const base: number[] = [],
          K: Int32Array[] = []
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
            p = [0n]
            for (let j = 0; j < c.length; j++) {
              const b = bitOf.get(c[j])
              p.push(b === undefined ? p[j] : p[j] | (1n << BigInt(b)))
            }
            pref.set(ci, p)
          }
          return p
        }
        for (const [o, ts] of terms) {
          let m = 0n
          for (let t = 0; t < ts.length; t += 4) {
            const ci = ts[t],
              ri = chains[ci].role,
              p = prefOf(ci)
            m |= (p[ts[t + 2]] ^ p[ts[t + 1]]) & ((1n << BigInt(base[ri] + K[ri][ts[t + 3]])) - 1n)
          }
          // a term whose range holds no move below its threshold cuts nothing: an empty mask is no direct cut (step 4
          // reads Dc.has(o)); fuzz seed 5019136 (5b-iii)
          if (m !== 0n) out.set(o, m)
        }
        return out
      },
    }
  }

  /** protectedTarget (§3.1 step 2), skipping the view when the target's rank bound already decides it */
  private protectedFast(d: number, kk: Rank, Vof: (g: number) => View): boolean {
    const ix = this.ix,
      de = ix.ev[d],
      St = ix.rec[d].local.facts
    const tg = target(de, St)
    if (tg.kind === 'member') {
      if (ix.owners.has(tg.who)) return true
      if (cmp(this.rankBound(tg.who), kk) < 0) return false
    } else if (tg.kind === 'role') {
      if (!gt([this.maxPosOf(tg.who), tg.who], kk)) return false
    } else return false
    return protectedTarget(de, St, Vof(d).facts(), kk)
  }

  /**
   * The operations whose resources a deny d can change (§5 authority index): uses(o, d) is false for every other op, so
   * step 3 visits only these (duplicates allowed).
   */
  private readers(d: number, visit: (o: number) => void) {
    const ix = this.ix,
      e = ix.ev[d],
      c = e.c ?? {}
    const each = (l: number[] | undefined) => {
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
        codeUsers(c.code)
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
  ) {
    const ix = this.ix,
      n = ix.n,
      s = st.s,
      cutOrd = this.cutOrd
    const bit = new Map<number, bigint>(causes.map((g, i) => [g, 1n << BigInt(i)]))
    const bitIx = new Map<number, number>(causes.map((g, i) => [g, i]))
    const ALLm = (1n << BigInt(causes.length)) - 1n
    // masks over many causes are built from index lists in one conversion (one bigint per op, not one per pair)
    const maskOf = (is: number[]): bigint => {
      if (is.length < 32) {
        let m = 0n
        for (const i of is) m |= 1n << BigInt(i)
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
      const b = bitIx.get(g)!
      for (const o of os) pushM(DcL, o, b)
    }
    const Dc = new Map<number, bigint>()
    for (const [o, is] of DcL) Dc.set(o, maskOf(is))
    for (const [o, m] of termDc) Dc.set(o, (Dc.get(o) ?? 0n) | m)
    const Um = new Map<number, bigint>()
    const kk = st.kk
    const U = (p: number) => {
      let m = Um.get(p)
      if (m === undefined) {
        const pe = ix.ev[p],
          P = pe.a
        // exposed() is true for every cause when the author's rank bound is not above the stratum (not a join)
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
    // the region: alive ops that are direct cuts or have one in their causal past (nothing else can be cut)
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
    // the flat closure: what the causes would cut if no author were protected. By the monotonicity lemma it holds every
    // cut of either branch, so the protection classes are counted among these ops only ([H16]) and nothing else is tested
    // (§5 "Flat closure") nm[q]: a flat op other than a role move is in B(q); while there is none, an op authorized at
    // its rank floor and its obstacles' ceilings (`floorAuthorized`) is not broken, and no view with N is built
    const flatA = new Uint8Array(n),
      nm = new Uint8Array(n),
      inR = new Uint8Array(n)
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
        if (FASTOPT.floor && !nm[q] && floorK(q))
          this.stats.floorSkips = (this.stats.floorSkips ?? 0) + 1
        else {
          const N = (x: number) => flatA[x] === 1 && ix.has(q, x)
          this.stats.brokenTests++
          f = below(q, N) && !new Mono(ix, q, st, N, EMPTYSET).authorized()
        }
      }
      if (f) {
        flatA[q] = 1
        flat.push(q)
      }
    }
    // [H17] latent defect (c): an op's cut in a world depends only on the causes with a direct cut in C(q) (G(q)), so
    // classes are counted over flat ops not in X, projected onto G(q), and the fallback's subset test is projected too:
    // an X event without descendants (an orphan) can't switch the branch or change the fallback's result
    const Gm = new Map<number, bigint>()
    for (const i of this.order) {
      let g = Dc.get(i) ?? 0n
      for (const p of ix.pa[i]) g |= Gm.get(p) ?? 0n
      if (g !== 0n) Gm.set(i, g)
    }
    const G = (q: number) => Gm.get(q) ?? 0n
    // revision 7c (r7 re-review C1): classes are distinct U(q) ∩ Γ⁺ over flat ops not in X, Γ⁺ = the causes with a
    // direct cut on an event outside X (one set for the stratum, so what q cites can't split q's exposure)
    let Gp = 0n
    for (const [o, m] of Dc) if (!this.X[o]) Gp |= m
    const classSet = new Set<bigint>()
    for (const q of flat) {
      if (this.X[q]) continue
      const m = U(q) & Gp
      if (m !== 0n && m !== Gp) classSet.add(m)
    }
    const cutQ = (q: number) => {
      cutOrd[q] = s
      this.cutRank[q] = st.kk
    }
    this.stats.maxClasses = Math.max(this.stats.maxClasses ?? 0, classSet.size)
    this.stats.maxRegion = Math.max(this.stats.maxRegion ?? 0, region.length)
    this.stats.maxFlat = Math.max(this.stats.maxFlat ?? 0, flat.length)
    // the exact branch's work, (2^classes + 1) worlds × the flat ops outside X and Tail (measured only: the ruled bound
    // on it is not adopted, §10.16)
    let flatN = 0
    for (const q of flat) if (!this.X[q] && !this.tail[q]) flatN++
    this.stats.maxWork = Math.max(this.stats.maxWork ?? 0, (2 ** classSet.size + 1) * flatN)
    if (classSet.size > LIM.classes) {
      this.stats.fallbacks++
      const cascTop = new Map<number, boolean>()
      for (const q of flat) {
        const Wq = U(q)
        let ct = false
        if (Wq !== 0n && authorizedK(q)) {
          const N = (x: number) =>
            ix.has(q, x) &&
            cutOrd[x] === s &&
            (((Dc.get(x) ?? 0n) & Wq) !== 0n ||
              (cascTop.get(x) === true && (U(x) & G(x) & ~Wq) === 0n))
          this.stats.brokenTests++
          ct = below(q, N) && !new Mono(ix, q, st, N, EMPTYSET).authorized()
        }
        cascTop.set(q, ct)
        if (Dc.has(q) || ct) cutQ(q)
      }
      return
    }
    const casc = new Map<number, Map<bigint, boolean>>()
    const worlds = new Set<bigint>()
    const inW = (x: number, W: bigint): boolean => {
      if (((Dc.get(x) ?? 0n) & W) !== 0n) return true
      const Wx = W & U(x)
      return Wx !== 0n && cascadeIn(x, Wx)
    }
    const cascadeIn = (q: number, Wq: bigint): boolean => {
      let mq = casc.get(q)
      if (!mq) casc.set(q, (mq = new Map()))
      const memo = mq.get(Wq)
      if (memo !== undefined) return memo
      worlds.add(Wq)
      let v = false
      if (authorizedK(q)) {
        // the cuts that the causes Wq alone make, read only where q's authority looks (N ≠ ∅ is implied by broken)
        const N = (x: number) => ix.has(q, x) && cutOrd[x] === s && inW(x, Wq)
        this.stats.brokenTests++
        v = below(q, N) && !new Mono(ix, q, st, N, EMPTYSET).authorized()
      }
      mq.set(Wq, v)
      return v
    }
    for (const q of flat) {
      let isCut = Dc.has(q)
      if (!isCut) {
        const Wq = U(q)
        isCut = Wq !== 0n && cascadeIn(q, Wq)
      }
      if (isCut) cutQ(q)
    }
    this.stats.worlds += worlds.size
  }

  /**
   * An event on the heads (C(ap) = S): Eval(S ∪ {e}) = Eval(S) ⊕ e (§5). Nothing in S can see it, so it is in no
   * frontier, no V_γ (it is in fut(γ) of every cause) and no V_o; it creates no evidence pair (its aprev and iprev are
   * the last of their chains in S), witnesses nothing in good faith (every candidate of S is a candidate in St(e)), is
   * never broken (St(e) has every cut of S applied), and as a cause it cuts nothing, so it is not in Γ ([H16]). What is
   * left: whether e, if a deny, is effective at k(e) (protection in V_e under the decisions above k(e)), and the facts.
   */
  appendHead(i: number): EvalResult {
    const ix = this.ix
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
    if (this.mS) throw new Error('appendHead on a subset evaluation')
    this.order.push(i)
    this.maxPos.clear()
    const e = ix.ev[i]
    // [H17]: a head event can still be a candidate (its device introduced only by candidate introductions that someone
    // witnessed); nothing witnesses it yet, so it is in X and has no effect. It is never a rotation sibling: its iprev is
    // the deepest identity op of S, deeper than any earlier rotation's
    // W3(g): a head event is concurrent with nothing, so no other event's pool changes; its own pool is U(e)
    const pl = ix.rec[i].pool
    if (
      pl &&
      !ix.owners.has(e.a) &&
      e.t !== 'primary_rotate' &&
      e.t !== 'device_revoke' &&
      pl.length > LIM.poolU
    )
      this.PC.add(ix.ids[i])
    if (this.candidateIn(i, this.F, this.FI, this.RF, this.PC)) {
      this.X[i] = 1
      return snapResult(this, ix.n)
    }
    if (e.t === 'device_revoke' || e.t === 'primary_rotate') this.effOrd[i] = -1
    else if (ix.isD[i]) {
      const kk = ix.k(i),
        cutRank = this.cutRank,
        effRank = this.effRank,
        effOrd = this.effOrd,
        X = this.X,
        tail = this.tail
      const K = (x: number) => cutRank[x] !== undefined && cmp(cutRank[x]!, kk) > 0
      const st: Strat = {
        s: -1,
        kk,
        K,
        here: () => false,
        voidK: x => X[x] === 1 || tail[x] === 1 || K(x),
        high: x => effOrd[x] === -1 || (effRank[x] !== undefined && cmp(effRank[x]!, kk) > 0),
        inS: () => true,
        isX: x => X[x] === 1,
      }
      if (ix.isSelfD[i] || !this.protectedFast(i, kk, g => new CauseView(ix, g, st, null))) {
        this.effOrd[i] = 0
        this.effRank[i] = kk
        this.noteEffective(i)
      }
    }
    return snapResult(this, ix.n)
  }

  /**
   * This evaluation as the source of recorded states: its final state and every head-path snapshot of it agree on eff
   * over their common events (an event on the heads changes no earlier status, O3-heads)
   */
  private ep?: { key: object; eff(i: number): boolean }
  epoch() {
    return (this.ep ??= { key: this, eff: (i: number) => this.inS(i) && this.effOrd[i] >= -1 })
  }

  // ---- the result
  result(): EvalResult {
    const ix = this.ix,
      n = ix.n
    if (this.mS) {
      // a subset state (an admission state St(e) = Eval(C(ap)) off the heads): its sets are small, its facts are keyed
      // views over a packed copy of the subset (n/8 bytes), so a recorded St(e) never copies the whole facts (§5)
      const bitsP = new Uint32Array((n + 31) >>> 5)
      const XI = new Set<number>(),
        VI = new Set<number>(),
        EI = new Set<number>()
      const X = new Set<string>(),
        tail = new Set<string>(),
        cut = new Map<string, Rank>(),
        eff = new Set<string>(),
        voidS = new Set<string>()
      for (const i of this.order) {
        bitsP[i >>> 5] |= 1 << (i & 31)
        const id = ix.ids[i]
        if (this.X[i]) {
          X.add(id)
          XI.add(i)
        }
        if (this.tail[i]) tail.add(id)
        if (this.cutOrd[i] >= 0) cut.set(id, this.cutRank[i]!)
        if (this.X[i] || this.tail[i] || this.cutOrd[i] >= 0) {
          VI.add(i)
          voidS.add(id)
        }
        if (this.effOrd[i] >= -1) {
          EI.add(i)
          eff.add(id)
        }
      }
      const V = new SubView(ix, bitsP, XI, VI, EI, n)
      const _idx: StIdx = {
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
        F: this.F,
        FI: this.FI,
        RF: this.RF,
        PC: this.PC,
        void: voidS,
        _idx,
      } as EvalResult
    }
    const voidA = new Uint8Array(n),
      effA = new Uint8Array(n)
    const X = new Set<string>(),
      tail = new Set<string>(),
      cut = new Map<string, Rank>(),
      eff = new Set<string>(),
      voidS = new Set<string>()
    for (const i of this.order) {
      const id = ix.ids[i]
      if (this.X[i]) X.add(id)
      if (this.tail[i]) tail.add(id)
      if (this.cutOrd[i] >= 0) cut.set(id, this.cutRank[i]!)
      if (this.X[i] || this.tail[i] || this.cutOrd[i] >= 0) {
        voidA[i] = 1
        voidS.add(id)
      }
      if (this.effOrd[i] >= -1) {
        effA[i] = 1
        eff.add(id)
      }
    }
    const facts = fullFacts(new FullView(ix, voidA, effA, this.mS, this.X))
    const XA = this.X,
      mS = this.mS
    const _idx: StIdx = {
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
      F: this.F,
      FI: this.FI,
      RF: this.RF,
      PC: this.PC,
      void: voidS,
      _idx,
    } as EvalResult
  }
}

/** The whole state of a view as a real `Facts` object (§3.2), key by key. */
export function fullFacts(V: View): Facts {
  const ix = V.ix
  const mem = new Set<string>(),
    ban = new Set<string>(),
    effBanK = new Map<string, Rank[]>()
  for (const T of ix.memEv.keys()) if (V.mem(T)) mem.add(T)
  for (const T of ix.banEv.keys()) {
    if (V.ban(T)) ban.add(T)
    const ks = V.effBanK(T)
    if (ks) effBanK.set(T, ks)
  }
  const roles = new Set<string>()
  for (const R of ix.roleCreate.keys()) if (V.role(R)) roles.add(R)
  const pos = new Map<string, number>()
  for (const R of ix.posW.keys()) {
    const p = V.pos(R)
    if (p !== undefined) pos.set(R, p)
  }
  const bits = new Map<string, number>()
  bits.set(EVERYONE, V.bits(EVERYONE) ?? 0)
  for (const R of roles) bits.set(R, V.bits(R) ?? 0)
  const holds = new Map<string, Set<string>>()
  for (const T of ix.everHeld.keys()) {
    const h = V.holds(T)
    if (h.size) holds.set(T, new Set(h))
  }
  const revoked = new Set<string>()
  for (const v of new Set([...ix.devRevEv.keys(), ...ix.introEv.keys()]))
    if (V.revoked(v)) revoked.add(v)
  const devs = new Map<string, Set<string>>()
  for (const [v, xs] of ix.introEv) {
    if (revoked.has(v)) continue
    for (const x of xs) if (V.live(x)) addS(devs, ix.ev[x].a, v)
  }
  const codes = new Map<string, { id: string; a: string; dev: string; k: Rank }>()
  const codeIssuer = new Map<string, string>(),
    codeOk = new Set<string>(),
    codeDead = new Set<string>()
  for (const [c, x] of ix.codeEv) {
    if (!V.inE(x)) continue
    codeIssuer.set(c, ix.ev[x].a)
    if (V.codeDead(c)) codeDead.add(c)
    if (V.codeOk(c)) {
      codeOk.add(c)
      if (!V.codeDead(c)) codes.set(c, { id: c, a: ix.ev[x].a, dev: ix.ev[x].dev, k: ix.k(x) })
    }
  }
  const invited = new Map<string, Pend[]>(),
    pending = new Map<string, Pend[]>(),
    addsTo = new Map<string, Pend[]>()
  const consumed = new Set<string>()
  for (const T of ix.addEv.keys()) {
    const at = V.addsTo(T)
    if (at.length) addsTo.set(T, at)
    for (const p of at) if (V.consumedIdx(ix.at.get(p.id)!)) consumed.add(p.id)
    const inv = V.invited(T)
    if (!inv.length) continue
    invited.set(T, inv)
    if (!mem.has(T) && !ban.has(T)) pending.set(T, inv)
  }
  const pickReg = (ws: number[]) => {
    const live = ws.filter(x => V.live(x))
    let best = -1
    for (const w of live) {
      if (live.some(w2 => w2 !== w && ix.before(w, w2))) continue
      if (best < 0) {
        best = w
        continue
      }
      const c = cmp(ix.k(w), ix.k(best))
      if (c > 0 || (c === 0 && ix.ids[w] < ix.ids[best])) best = w
    }
    return best < 0 ? undefined : ix.ev[best]
  }
  const profile = new Map<string, number>()
  for (const [T, ws] of ix.profileBy) {
    const b = pickReg(ws)
    if (b) profile.set(T, b.c.name)
  }
  const sw = pickReg(ix.settingsEv)
  return {
    owners: new Set(ix.owners),
    upgraded: ix.upgradeEv.filter(x => V.inE(x)).map(x => ix.ids[x]),
    mem,
    ban,
    effBanK,
    invited,
    pending,
    roles,
    pos,
    bits,
    holds,
    devs,
    revoked,
    codes,
    codeIssuer,
    profile,
    setting: sw?.c.name,
    addsTo,
    consumed,
    codeOk,
    codeDead,
  }
}

// ---------------------------------------------------------------- recorded states on the head path (§5)
//
// Every admitted event records St(e). On the head path St(e) is the current state, and an event on the heads changes
// no earlier status (O3-heads), so the state after `len` events is the evaluator's arrays read below `len`: a snapshot
// costs O(1) memory instead of a copy of every set. Its facts are keyed views over the same arrays, computed per key on
// demand and memoized; enumerations (rare: W5 counts, the differential) materialize the whole facts through a small
// LRU, so no snapshot keeps an O(n) copy. Results are identical to the eager `result()` (O13-fast compares them).

/** the final state of `fe` after its first `len` events */
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
    const fe = this.fe
    return fe.X[x] === 1 || fe.tail[x] === 1 || fe.cutOrd[x] >= 0
  }
  isEff(x: number) {
    return this.fe.effOrd[x] >= -1
  }
}

/** the final state of a subset evaluation (mS a downset of the index), from its packed set and its void/eff/X indices */
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

const lru = new Map<object, any>()
const LRU_CAP = 16
function lruGet<T>(k: object, make: () => T): T {
  let v = lru.get(k)
  if (v !== undefined) {
    lru.delete(k)
    lru.set(k, v)
    return v
  }
  v = make()
  lru.set(k, v)
  if (lru.size > LRU_CAP) lru.delete(lru.keys().next().value!)
  return v
}

/** a read-only Set or Map whose lookups are keyed and whose enumeration comes from `all()` */
function lazyColl(
  has: (k: any) => boolean,
  get: ((k: any) => any) | null,
  all: () => Set<any> | Map<any, any>
): any {
  return {
    has,
    get: get ?? ((k: any) => (has(k) ? k : undefined)),
    get size() {
      return all().size
    },
    keys: () => all().keys(),
    values: () => all().values(),
    entries: () => all().entries(),
    forEach: (f: any) => all().forEach(f),
    [Symbol.iterator]: () => (all() as any)[Symbol.iterator](),
  }
}

function snapFacts(V: SnapView | SubView): Facts {
  const ix = V.ix
  // an enumeration materializes the whole facts on a fresh view (same predicates, empty memos): the recorded state's own
  // view keeps only the keys read one by one, so a kept St(e) never holds per-principal memos for every principal
  const full = () => lruGet(V, () => fullFacts(V.fresh()))
  const idx = (id: string) => ix.at.get(id)
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
  const codeOf = (c: string) => {
    const x = ix.codeEv.get(c)
    if (x === undefined || !V.inE(x) || !V.codeOk(c) || V.codeDead(c)) return undefined
    return { id: c, a: ix.ev[x].a, dev: ix.ev[x].dev, k: ix.k(x) }
  }
  const bitsOf = (R: string) =>
    R === EVERYONE ? (V.bits(EVERYONE) ?? 0) : V.role(R) ? (V.bits(R) ?? 0) : undefined
  const pickReg = (ws: number[]) => {
    const live = ws.filter(x => V.live(x))
    let best = -1
    for (const w of live) {
      if (live.some(w2 => w2 !== w && ix.before(w, w2))) continue
      if (best < 0) {
        best = w
        continue
      }
      const c = cmp(ix.k(w), ix.k(best))
      if (c > 0 || (c === 0 && ix.ids[w] < ix.ids[best])) best = w
    }
    return best < 0 ? undefined : ix.ev[best]
  }
  const prof = (T: string) => {
    const b = pickReg(ix.profileBy.get(T) ?? EMPTY)
    return b ? (b.c.name as number) : undefined
  }
  const pend = (T: string) => {
    const l = inv(T)
    return l && !V.mem(T) && !V.ban(T) ? l : undefined
  }
  const consumed = (g: string) => {
    const i = idx(g)
    if (i === undefined || !V.inE(i) || ix.ev[i].t !== 'add') return false
    return V.consumedIdx(i)
  }
  const f: any = {
    owners: ix.owners,
    get upgraded() {
      return ix.upgradeEv.filter(x => V.inE(x)).map(x => ix.ids[x])
    },
    mem: lazyColl(
      T => V.mem(T),
      null,
      () => full().mem
    ),
    ban: lazyColl(
      T => V.ban(T),
      null,
      () => full().ban
    ),
    effBanK: lazyColl(
      T => V.effBanK(T) !== undefined,
      T => V.effBanK(T),
      () => full().effBanK
    ),
    invited: lazyColl(
      T => inv(T) !== undefined,
      inv,
      () => full().invited
    ),
    pending: lazyColl(
      T => pend(T) !== undefined,
      pend,
      () => full().pending
    ),
    roles: lazyColl(
      R => V.role(R),
      null,
      () => full().roles
    ),
    pos: lazyColl(
      R => V.pos(R) !== undefined,
      R => V.pos(R),
      () => full().pos
    ),
    bits: lazyColl(
      R => bitsOf(R) !== undefined,
      bitsOf,
      () => full().bits
    ),
    holds: lazyColl(
      T => V.holds(T).size > 0,
      T => {
        const h = V.holds(T)
        return h.size ? h : undefined
      },
      () => full().holds
    ),
    devs: lazyColl(
      a => devsOf(a) !== undefined,
      devsOf,
      () => full().devs
    ),
    revoked: lazyColl(
      v => V.revoked(v),
      null,
      () => full().revoked
    ),
    codes: lazyColl(
      c => codeOf(c) !== undefined,
      codeOf,
      () => full().codes
    ),
    codeIssuer: lazyColl(
      c => V.codeIssuer(c) !== undefined,
      c => V.codeIssuer(c),
      () => full().codeIssuer
    ),
    profile: lazyColl(
      T => prof(T) !== undefined,
      prof,
      () => full().profile
    ),
    get setting() {
      return pickReg(ix.settingsEv)?.c.name
    },
    addsTo: lazyColl(
      T => V.addsTo(T).length > 0,
      T => {
        const l = V.addsTo(T)
        return l.length ? l : undefined
      },
      () => full().addsTo
    ),
    consumed: lazyColl(consumed, null, () => full().consumed),
    codeOk: lazyColl(
      c => codeLive(c) && V.codeOk(c),
      null,
      () => full().codeOk
    ),
    codeDead: lazyColl(
      c => codeLive(c) && V.codeDead(c),
      null,
      () => full().codeDead
    ),
  }
  return f as Facts
}

/** EvalResult of `fe` after its first `len` events, sharing fe's arrays */
function snapResult(fe: FastEval, len: number): EvalResult {
  const ix = fe.ix,
    V = new SnapView(ix, fe, len)
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
  const pX = (i: number) => fe.X[i] === 1,
    pT = (i: number) => fe.tail[i] === 1,
    pC = (i: number) => fe.cutOrd[i] >= 0
  const pE = (i: number) => fe.effOrd[i] >= -1,
    pV = (i: number) => pX(i) || pT(i) || pC(i)
  const set = (p: (i: number) => boolean) =>
    lazyColl(
      id => {
        const i = at(id)
        return i >= 0 && p(i)
      },
      null,
      list(p)
    )
  const cutAll = () =>
    lruGet(pC as object, () => {
      const m = new Map<string, Rank>()
      for (const i of fe.order) {
        if (i >= len) break
        if (pC(i)) m.set(ix.ids[i], fe.cutRank[i]!)
      }
      return m
    })
  // list() memoizes by predicate identity: per snapshot, so each snapshot gets its own predicates
  return {
    facts: snapFacts(V),
    X: set(pX),
    tail: set(pT),
    eff: set(pE),
    void: set(pV),
    cut: lazyColl(
      id => {
        const i = at(id)
        return i >= 0 && pC(i)
      },
      id => {
        const i = at(id)
        return i >= 0 && pC(i) ? fe.cutRank[i] : undefined
      },
      cutAll
    ),
    F: fe.F,
    FI: fe.FI,
    RF: fe.RF,
    PC: fe.PC,
    _idx: {
      ix,
      X: (i: number) => i < len && fe.inS(i) && pX(i),
      void: (i: number) => i < len && fe.inS(i) && pV(i),
      eff: (i: number) => i < len && fe.inS(i) && pE(i),
      ep: fe.epoch(),
    },
  } as EvalResult
}

/** Eval(S) by the production algorithm (spec §5): the drop-in equivalent of model.ts `evaluate(ids, cx)`. */
export function fastEvaluate(ids: string[], cx: Ctx, ghosts: string[] = []): EvalResult {
  const fe = new FastEval(Ix.of(ids, cx))
  // headers of dropped events (§2.3 orphan rule; revision 6, r5 review I1): every kind of evidence
  fe.ghosts = ghosts.map(id => cx.ev(id))
  return fe.run()
}

// ---------------------------------------------------------------- the client's incremental state (§5)

/**
 * The client's evaluator state (§5): one append-only index of every admitted ACL event, the current Eval(S), and the
 * admission states St(e) = Eval(C(ap)) through a merge cache keyed by the sorted parents (C(ap) = S: the current
 * state; otherwise one evaluation of the downset C(ap) over the shared index).
 */
export class FastState {
  ix: Ix
  private fe?: FastEval
  private cur?: EvalResult
  cache = new Map<string, EvalResult>()
  cap = 4096
  stats = { head: 0, full: 0, subsets: 0, hits: 0 }
  constructor(public cx: Ctx) {
    this.ix = new Ix(cx)
  }

  /** C(ap) over the index as a word bitset, and its size */
  private closure(ap: string[]): { bits: Uint32Array; size: number } {
    const ix = this.ix,
      bits = new Uint32Array((ix.n + 31) >>> 5)
    for (const pid of ap) {
      const p = ix.at.get(pid)
      if (p === undefined) throw new Error(`fast: ${pid} not indexed`)
      const a = ix.anc[p]
      for (let w = 0; w < a.length; w++) bits[w] |= a[w]
      bits[p >>> 5] |= 1 << (p & 31)
    }
    let size = 0
    for (let w = 0; w < bits.length; w++) size += popcount(bits[w])
    return { bits, size }
  }
  /** the current Eval(S) of every indexed event */
  state(): EvalResult {
    if (!this.cur) {
      this.fe = new FastEval(this.ix)
      this.cur = this.fe.run()
    }
    return this.cur
  }
  /** St(e) for an event with ACL parents `ap` (all indexed): Eval(C(ap)) */
  stateOf(ap: string[]): EvalResult {
    const key = [...new Set(ap)].sort().join(',')
    const hit = this.cache.get(key)
    if (hit) {
      this.cache.delete(key)
      this.cache.set(key, hit)
      this.stats.hits++
      return hit
    }
    const { bits, size } = this.closure(ap)
    let r: EvalResult
    if (size === this.ix.n) r = this.state()
    else {
      const mS = new Uint8Array(this.ix.n)
      for (let i = 0; i < this.ix.n; i++) if ((bits[i >>> 5] >>> (i & 31)) & 1) mS[i] = 1
      r = new FastEval(this.ix, mS).run()
      this.stats.subsets++
    }
    this.cache.set(key, r)
    if (this.cache.size > this.cap) this.cache.delete(this.cache.keys().next().value!)
    return r
  }
  /**
   * Index an admitted event (its admission record is in cx). An event on the heads of a fresh current state takes the
   * head path (Eval(S) ⊕ e); any other arrival marks the current state stale, and the next `state()` re-runs the
   * stratum loop over the kept index (§5 "Incremental arrival").
   */
  append(id: string): void {
    const ev = this.cx.ev(id)
    const onHeads =
      this.cur !== undefined && ev.ap.length > 0 && this.closure(ev.ap).size === this.ix.n
    const i = this.ix.add(id)
    if (onHeads && this.fe) {
      this.cur = this.fe.appendHead(i)
      this.stats.head++
    } else {
      this.cur = undefined
      this.fe = undefined
      this.stats.full++
    }
  }
}
