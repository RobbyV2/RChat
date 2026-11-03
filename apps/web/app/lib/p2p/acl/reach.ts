import {
  EVERYONE,
  INVITE,
  introduces,
  isFixedT,
  ownersOf,
  permsQ,
  rkey,
  type AclEv,
  type Ctx,
  type Rec,
} from './rules'

// The index of a causally closed set of admitted ACL events (spec §5): topological numbering,
// strict-ancestor bitsets built from `ap`, and one event list per fact key of §3.2.

export const pushM = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
  const a = m.get(k)
  if (a) a.push(v)
  else m.set(k, [v])
}
export const addS = <K, V>(m: Map<K, Set<V>>, k: K, v: V) => {
  const a = m.get(k)
  if (a) a.add(v)
  else m.set(k, new Set([v]))
}
export const EMPTY: readonly number[] = []

// The writes of one bit of one role (setters and clears) in index order, with their chains.
export interface BitW {
  w: number[]
  cov: boolean[]
  ch?: WChains
}

// A register's writes as causal chains (§5.4 A): per (author, device), split by the chain cover;
// `of` gives each write's chain. Extended as the writes grow.
export interface WChains {
  k: number
  runs: number[][]
  byKey: Map<string, number[][]>
  id: Map<number[], number>
  of: Map<number, number>
}

export const popcount = (w: number) => {
  w = w - ((w >>> 1) & 0x55555555)
  w = (w & 0x33333333) + ((w >>> 2) & 0x33333333)
  return (((w + (w >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
}

// Adds x (indexed after every event of `runs`) to a chain cover: the last of the latest 8 chains
// whose tip is in B(x), else a new chain.
export function chainCover(ix: Ix, x: number, runs: number[][]): number[][] {
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

// The first j in [lo, hi) with p(j), for p false then true on [lo, hi).
export function firstTrue(lo: number, hi: number, p: (j: number) => boolean): number {
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (p(m)) hi = m
    else lo = m + 1
  }
  return lo
}

const newChains = (): WChains => ({
  k: 0,
  runs: [],
  byKey: new Map(),
  id: new Map(),
  of: new Map(),
})

export class Ix {
  n = 0
  ids: string[] = []
  at = new Map<string, number>()
  ev: AclEv[] = []
  rec: Rec[] = []
  anc: Uint32Array[] = []
  kids: number[][] = []
  pa: number[][] = []
  isD: boolean[] = []
  isSelfD: boolean[] = []
  fixed: boolean[] = []
  owners = new Set<string>()
  genesis = -1
  byAuthor = new Map<string, number[]>()
  byDev = new Map<string, number[]>()
  byAD = new Map<string, number[]>()
  adOf = new Map<string, string[]>()
  memEv = new Map<string, number[]>()
  joinEv = new Map<string, number[]>()
  remEv = new Map<string, number[]>()
  banEv = new Map<string, number[]>()
  unbanEv = new Map<string, number[]>()
  roleCreate = new Map<string, number>()
  roleDel = new Map<string, number[]>()
  bitW = new Map<string, Map<number, BitW>>()
  posW = new Map<string, number[]>()
  assignEv = new Map<string, number[]>()
  revokeEv = new Map<string, number[]>()
  everHeld = new Map<string, Set<string>>()
  heldBy = new Map<string, Set<string>>()
  codeEv = new Map<string, number>()
  codeRev = new Map<string, number[]>()
  codeAdds = new Map<string, number[]>()
  addEv = new Map<string, number[]>()
  uninvEv = new Map<string, number[]>()
  devRevEv = new Map<string, number[]>()
  rotBy = new Map<string, number[]>()
  introEv = new Map<string, number[]>()
  introBy = new Map<string, number[]>()
  roleNamed = new Map<string, number[]>()
  roleMetaEv = new Map<string, number[]>()
  profileBy = new Map<string, number[]>()
  settingsEv: number[] = []
  upgradeEv: number[] = []
  channelEv = new Map<string, number[]>()
  chpermEv = new Map<string, number[]>()
  proofEv: number[] = []
  deniesAt = new Map<string, number[]>()
  idOps: number[] = []
  deathMemo = new Map<string, number[]>()
  poolIx: (Int32Array | undefined)[] = []

  constructor(public cx: Ctx) {}

  // x ∈ B(i)
  has(i: number, x: number): boolean {
    if (x >= i) return false
    return ((this.anc[i][x >>> 5] >>> (x & 31)) & 1) !== 0
  }
  // x ∈ B(y)
  before(x: number, y: number) {
    return this.has(y, x)
  }
  k(i: number) {
    return this.rec[i].k
  }

  // Appends one event whose ACL parents are already indexed.
  add(id: string): number {
    const cx = this.cx
    const i = this.n++
    const e = cx.ev(id)
    const r = cx.rec(id)
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
      if (p === undefined) throw new Error(`acl: parent ${pid} of ${id} not indexed`)
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
    const c = e.c
    switch (e.t) {
      case 'genesis':
        this.genesis = i
        for (const o of ownersOf(c)) this.owners.add(o)
        pushM(this.memEv, e.a, i)
        this.addBits(EVERYONE, c.everyone_bits ?? 0, i)
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
        this.addBits(id, c.bits, i)
        pushM(this.posW, id, i)
        break
      case 'role_move':
        pushM(this.posW, c.role, i)
        pushM(this.roleNamed, c.role, i)
        break
      case 'role_bits':
        this.addBits(c.role, c.bit, i)
        pushM(this.roleNamed, c.role, i)
        break
      case 'role_del':
        pushM(this.roleDel, c.role, i)
        pushM(this.roleNamed, c.role, i)
        break
      case 'role_meta':
        if (typeof c.role === 'string') pushM(this.roleMetaEv, c.role, i)
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
        pushM(this.codeRev, c.code ?? '', i)
        break
      case 'add':
        pushM(this.addEv, c.to, i)
        if (c.code !== undefined) pushM(this.codeAdds, c.code, i)
        break
      case 'uninvite':
        pushM(this.uninvEv, c.to, i)
        break
      case 'device_revoke':
        pushM(this.devRevEv, c.dk, i)
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
      case 'channel':
        pushM(this.channelEv, c.id ?? '', i)
        break
      case 'chperm':
        pushM(this.chpermEv, `${c.ch}|${c.subj}`, i)
        break
      case 'proof':
        this.proofEv.push(i)
        break
    }
    const intro = introduces(e)
    if (intro.length) {
      pushM(this.introBy, e.a, i)
      for (const v of intro) pushM(this.introEv, v, i)
    }
    if (d) pushM(this.deniesAt, rkey(r.k), i)
    if (this.deathMemo.size) this.deathMemo.clear()
    return i
  }

  // Indexes a whole set in a topological order of its `ap` links (Kahn), whatever order `ids`
  // is given in.
  static of(ids: Iterable<string>, cx: Ctx): Ix {
    const ix = new Ix(cx)
    const list = [...ids]
    const inSet = new Set(list)
    const indeg = new Map<string, number>()
    const kidsOf = new Map<string, string[]>()
    for (const id of list) {
      let d = 0
      for (const p of new Set(cx.ev(id).ap))
        if (inSet.has(p)) {
          d++
          pushM(kidsOf, p, id)
        }
      indeg.set(id, d)
    }
    const q: string[] = list.filter(id => indeg.get(id) === 0)
    for (let h = 0; h < q.length; h++) {
      const id = q[h]
      ix.add(id)
      for (const k of kidsOf.get(id) ?? []) {
        const d = indeg.get(k)! - 1
        indeg.set(k, d)
        if (d === 0) q.push(k)
      }
    }
    if (ix.n !== list.length) throw new Error('acl: set is not causally closed')
    return ix
  }

  private addBits(R: string, mask: number, i: number) {
    let m = this.bitW.get(R)
    if (!m) this.bitW.set(R, (m = new Map()))
    for (let b = 1; b > 0 && b <= mask; b <<= 1) {
      if (!(mask & b)) continue
      const l = m.get(b)
      if (l) l.w.push(i)
      else m.set(b, { w: [i], cov: [] })
    }
  }

  // C(ap) as a word bitset over the index, and its size.
  closure(ap: readonly string[]): { bits: Uint32Array; size: number } {
    const bits = new Uint32Array((this.n + 31) >>> 5)
    for (const pid of ap) {
      const p = this.at.get(pid)
      if (p === undefined) throw new Error(`acl: ${pid} not indexed`)
      const a = this.anc[p]
      for (let w = 0; w < a.length; w++) bits[w] |= a[w]
      bits[p >>> 5] |= 1 << (p & 31)
    }
    let size = 0
    for (let w = 0; w < bits.length; w++) size += popcount(bits[w])
    return { bits, size }
  }

  // posCov(R)[k]: every position write of R indexed before posW(R)[k] is in its past (extended
  // lazily). A register read from the top stops at the first maximal write with this flag.
  private cov = new Map<string, boolean[]>()
  posCov(R: string): boolean[] {
    let c = this.cov.get(R)
    if (!c) this.cov.set(R, (c = []))
    return this.extendCov(this.posW.get(R) ?? EMPTY, c)
  }
  // The same flags over the writes of one bit of a role.
  bitCov(l: BitW): boolean[] {
    return this.extendCov(l.w, l.cov)
  }
  // The chains of a register's writes `ws` (§5.4 A), extended lazily.
  chainsOf(ws: readonly number[], c: WChains): WChains {
    for (; c.k < ws.length; c.k++) {
      const x = ws[c.k]
      const key = `${this.ev[x].a}\u0001${this.ev[x].dev}`
      let mine = c.byKey.get(key)
      if (!mine) c.byKey.set(key, (mine = []))
      const n = mine.length
      chainCover(this, x, mine)
      if (mine.length > n) {
        c.id.set(mine[n], c.runs.length)
        c.runs.push(mine[n])
      }
      const run = mine.length > n ? mine[n] : mine.find(r => r[r.length - 1] === x)!
      c.of.set(x, c.id.get(run)!)
    }
    return c
  }
  bitChains(l: BitW): WChains {
    return this.chainsOf(l.w, (l.ch ??= newChains()))
  }
  private posCh = new Map<string, WChains>()
  posChains(R: string): WChains {
    let c = this.posCh.get(R)
    if (!c) this.posCh.set(R, (c = newChains()))
    return this.chainsOf(this.posW.get(R) ?? EMPTY, c)
  }
  private extendCov(ws: readonly number[], c: boolean[]): boolean[] {
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

  // The events of one (author, device) as chains, extended lazily: on a chain the events in B(d)
  // are a prefix and those with d in their past a suffix (§5 "Move storms").
  private runM = new Map<string, { k: number; runs: number[][] }>()
  runsOf(key: string): number[][] {
    const l = this.byAD.get(key) ?? EMPTY
    let r = this.runM.get(key)
    if (!r) this.runM.set(key, (r = { k: 0, runs: [] }))
    for (; r.k < l.length; r.k++) r.runs = chainCover(this, l[r.k], r.runs)
    return r.runs
  }

  // Events x with the code in B(x) whose admission state lacks the issuer's Mem or Invite (sticky
  // code death, §1.5).
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
          if (!lf.mem.has(iss) || !(permsQ(lf, iss) & INVITE)) l.push(z)
        }
      }
      l.sort((a, b) => a - b)
    }
    this.deathMemo.set(code, l)
    return l
  }
}
