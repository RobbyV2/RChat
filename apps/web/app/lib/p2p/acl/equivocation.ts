import { fiOf, type EvalResult } from './facts'
import { EMPTY, firstTrue, Ix, popcount, pushM } from './reach'
import { introduces, poster, relayed, type AclEv, type Ctx, type Rec } from './rules'

// Equivocation (spec §2.3): device and identity fork points (FI per epoch), rotation and race
// evidence, pool candidates (W3(g)), candidates, the void set X, and the revocation tails of §3.1.

// A header that counts as device evidence: a dropped event's, or one side of a proof.
export interface Header {
  dev: string
  seq: number
  aprev?: string
}

// x and y (two headers of one device) are evidence against it (E1 or E2 of §2.3).
export const evidencePair = (x: Header, y: Header) =>
  x.dev === y.dev && (x.seq === y.seq || (x.aprev ?? '') === (y.aprev ?? ''))

// The headers of dropped events (orphan rule, §2.3), outside the index. They count as every kind
// of evidence and set no fact. A header is read only against events of its own identity: an
// indexed x is in its past when x is in C(f) for one of its maximal indexed ancestors `fr`, and
// headers are ordered by their header parents `hp`. No held event has a header in its past.
export interface Hdr {
  ev: AclEv
  rec: Rec
  fr: number[]
  hp: number[]
}
export class Hdrs {
  list: Hdr[] = []
  at = new Map<string, number>()
  byDev = new Map<string, number[]>()
  byPoster = new Map<string, number[]>()
  idOps: number[] = []
  private anc = new Map<number, Set<number>>()

  // `evs`: the headers, in any order; each parent is indexed or one of them. The list is in
  // causal order (a header after its header parents).
  constructor(
    public ix: Ix,
    evs: readonly { ev: AclEv; rec: Rec }[]
  ) {
    const byId = new Map(evs.map(x => [x.ev.id, x]))
    for (const root of evs) {
      if (this.at.has(root.ev.id)) continue
      const st: { x: { ev: AclEv; rec: Rec }; k: number }[] = [{ x: root, k: 0 }]
      while (st.length) {
        const top = st[st.length - 1]
        const ap = top.x.ev.ap
        if (top.k < ap.length) {
          const pid = ap[top.k++]
          if (ix.at.has(pid) || this.at.has(pid)) continue
          const pg = byId.get(pid)
          if (!pg) throw new Error(`acl: parent ${pid} of header ${top.x.ev.id} not held`)
          st.push({ x: pg, k: 0 })
          continue
        }
        st.pop()
        if (!this.at.has(top.x.ev.id)) this.push(top.x.ev, top.x.rec)
      }
    }
  }
  private push(ev: AclEv, rec: Rec) {
    const ix = this.ix
    const cand: number[] = []
    const hp: number[] = []
    for (const pid of ev.ap) {
      const p = ix.at.get(pid)
      if (p !== undefined) cand.push(p)
      else {
        const q = this.at.get(pid)!
        if (!hp.includes(q)) hp.push(q)
        for (const f of this.list[q].fr) cand.push(f)
      }
    }
    cand.sort((a, b) => b - a)
    const fr: number[] = []
    for (const f of cand) if (!fr.some(h => h === f || ix.has(h, f))) fr.push(f)
    const k = this.list.length
    this.list.push({ ev, rec, fr, hp })
    this.at.set(ev.id, k)
    pushM(this.byDev, ev.dev, k)
    if (rec.pool) pushM(this.byPoster, poster(ev), k)
    if (rec.depth >= 0) this.idOps.push(k)
  }
  // indexed x ∈ B(header k)
  has(k: number, x: number): boolean {
    for (const f of this.list[k].fr) if (f === x || this.ix.has(f, x)) return true
    return false
  }
  // header u ∈ B(header v)
  before(u: number, v: number): boolean {
    let a = this.anc.get(v)
    if (!a) {
      a = new Set()
      const st = [...this.list[v].hp]
      while (st.length) {
        const h = st.pop()!
        if (a.has(h)) continue
        a.add(h)
        for (const g of this.list[h].hp) st.push(g)
      }
      this.anc.set(v, a)
    }
    return a.has(u)
  }
}

// An identity op among the held events (`i`) or the headers (`g`).
interface IdRef {
  i: number
  g: number
  e: AclEv
  depth: number
  epoch: string
  id: string
}

export class Equiv {
  F = new Map<string, number>()
  FI = new Map<string, number>()
  RF = new Set<string>()
  PC = new Set<string>()
  X!: Uint8Array
  tail!: Uint8Array
  tailBy = new Map<number, number[]>()
  order: number[]
  // Headers of dropped events: evidence only (§2.3).
  hdrs: Hdrs | null = null

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

  forkPoints() {
    const ix = this.ix
    const F = this.F
    const FI = this.FI
    const H = this.hdrs
    const low = (dev: string, m: number) => {
      if (m < (F.get(dev) ?? Infinity)) F.set(dev, m)
    }
    const devEvidence = (dev: string, es: readonly number[], hs: readonly number[]) => {
      const bySeq = new Set<number>()
      const byPrev = new Map<string, number>()
      const one = (e: AclEv) => {
        if (bySeq.has(e.seq)) low(dev, e.seq)
        else bySeq.add(e.seq)
        const pk = e.aprev ?? ''
        const s2 = byPrev.get(pk)
        if (s2 !== undefined) {
          low(dev, Math.min(e.seq, s2))
          byPrev.set(pk, Math.min(s2, e.seq))
        } else byPrev.set(pk, e.seq)
      }
      for (const k of hs) one(H!.list[k].ev)
      for (const i of es) if (this.inS(i)) one(ix.ev[i])
    }
    for (const [dev, es] of ix.byDev) devEvidence(dev, es, H?.byDev.get(dev) ?? EMPTY)
    if (H) for (const [dev, hs] of H.byDev) if (!ix.byDev.has(dev)) devEvidence(dev, EMPTY, hs)
    for (const p of ix.proofEv) {
      if (!this.inS(p)) continue
      const { x, y } = ix.ev[p].c as unknown as { x: Header; y: Header }
      low(x.dev, Math.min(x.seq, y.seq))
    }
    // identity ops: the held ones in index order, then the headers in causal order (a held event
    // never has a header in its past)
    const refs: IdRef[] = []
    for (const i of ix.idOps)
      if (this.inS(i))
        refs.push({
          i,
          g: -1,
          e: ix.ev[i],
          depth: ix.rec[i].depth,
          epoch: ix.rec[i].epoch,
          id: ix.ids[i],
        })
    if (H)
      for (const k of H.idOps) {
        const h = H.list[k]
        refs.push({ i: -1, g: k, e: h.ev, depth: h.rec.depth, epoch: h.rec.epoch, id: h.ev.id })
      }
    // u ∈ B(v)
    const before = (u: IdRef, v: IdRef) =>
      v.g < 0 ? u.g < 0 && ix.has(v.i, u.i) : u.g < 0 ? H!.has(v.g, u.i) : H!.before(u.g, v.g)
    const byIdn = new Map<string, Map<string, number>>()
    for (const x of refs) {
      if (x.e.t === 'primary_rotate') continue
      const key = `${x.e.a}|${x.epoch}`
      let m = byIdn.get(key)
      if (!m) byIdn.set(key, (m = new Map()))
      const pk = x.e.iprev ?? ''
      const d0 = m.get(pk)
      if (d0 !== undefined) {
        const d = Math.min(d0, x.depth)
        if (d < (FI.get(key) ?? Infinity)) FI.set(key, d)
      } else m.set(pk, x.depth)
    }
    // rotation evidence: any two concurrent rotations of one identity; race evidence: a
    // non-rotation identity op over the iprev of a rotation of its identity
    const byRot = new Map<string, IdRef[]>()
    const rotPrev = new Set<string>()
    for (const x of refs)
      if (x.e.t === 'primary_rotate') {
        pushM(byRot, x.e.a, x)
        rotPrev.add(`${x.e.a}|${x.e.iprev ?? ''}`)
      }
    if (rotPrev.size)
      for (const x of refs) {
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
    if (sib.length)
      for (const x of refs) {
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

  // Pool candidates (W3(g)): a non-owner's event x other than a rotation or its identity's own
  // device_revoke whose pool P(x) = U(x) ∪ ⋃ U(y) over the events y of its poster concurrent with
  // x, held or headers, before their device's fork point (revision 7), exceeds poolU (a relay is
  // its relayer's event here, §1.6). Per poster and device chain: on a linear chain the events
  // concurrent with x are one segment (two binary searches); prefix sums of |U| bound the union
  // from above, U(x) ∪ conc(x) from below, and the union is formed only between the bounds. A
  // chain that isn't linear is counted by popcount below x and one by one above it.
  poolCands(): Set<string> {
    const ix = this.ix
    const lim = ix.cx.lim.poolU
    const n = ix.n
    const F = this.F
    const H = this.hdrs
    const ng = H?.list.length ?? 0
    const PC = new Set<string>()
    const preF = (e: AclEv) => e.seq < (F.get(e.dev) ?? Infinity)
    const byA = new Map<string, number[]>()
    for (let i = 0; i < n; i++) {
      const a = poster(ix.ev[i])
      if (this.inS(i) && ix.rec[i].pool && !ix.owners.has(a)) pushM(byA, a, i)
    }
    let stamp: Int32Array | undefined
    let cur = 0
    let cnt = 0
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
    const hslot = (id: string) => {
      const k = H?.at.get(id)
      return k === undefined ? -1 : n + k
    }
    const addPool = (y: number) => {
      const p = poolIx(y)
      for (let k = 0; k < p.length; k++)
        if (p[k] >= 0) add(p[k])
        else if (ng) add(hslot(ix.rec[y].pool![k]))
    }
    const addHPool = (k: number) => {
      for (const id of H!.list[k].rec.pool!) add(ix.at.get(id) ?? hslot(id))
    }
    for (const [a, es] of byA) {
      const gl = (H?.byPoster.get(a) ?? EMPTY).filter(k => preF(H!.list[k].ev))
      if (es.length + gl.length <= 1) continue
      if (!gl.length) {
        let chain = true
        for (let k = 1; k < es.length && chain; k++) if (!ix.has(es[k], es[k - 1])) chain = false
        if (chain) continue
      }
      const byD = new Map<string, number[]>()
      for (const i of es) if (preF(ix.ev[i])) pushM(byD, ix.ev[i].dev, i)
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
      const sp: number[] = []
      const sq: number[] = []
      const conc: number[][] = []
      for (const x of es) {
        const xe = ix.ev[x]
        if (xe.t === 'primary_rotate' || (xe.t === 'device_revoke' && !relayed(xe))) continue
        const ux = ix.rec[x].pool!.length
        let lo = ux
        let hi = ux
        let over = false
        const ax = ix.anc[x]
        for (let si = 0; si < segs.length && !over; si++) {
          const { l, lin, pre, bits } = segs[si]
          let p = 0
          let q = 0
          if (lin) {
            let a0 = 0
            let b = l.length
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
            if (lo > lim) over = true
          } else {
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
                const t = m & -m
                cl.push((w << 5) + (31 - Math.clz32(t)))
                m ^= t
              }
            }
            for (const y of cl) hi += ix.rec[y].pool!.length
            for (let k = firstTrue(0, l.length, j => l[j] > x); k < l.length; k++) {
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
            if (H!.has(k, x)) continue
            gc.push(k)
            lo++
            hi += H!.list[k].rec.pool!.length
            if (lo > lim) {
              over = true
              break
            }
          }
        if (over) {
          PC.add(ix.ids[x])
          continue
        }
        if (hi <= lim) continue
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
        for (let k = 0; k < gc.length && cnt <= lim; k++) addHPool(gc[k])
        for (let si = 0; si < segs.length && cnt <= lim; si++) {
          const { l, lin } = segs[si]
          if (lin) for (let k = sp[si]; k < sq[si] - 1 && cnt <= lim; k++) addPool(l[k])
        }
        if (cnt > lim) PC.add(ix.ids[x])
      }
    }
    return PC
  }

  // An identity op (or the genesis) is a candidate, structurally: no witness or X involved.
  idCand(
    x: number,
    F: ReadonlyMap<string, number>,
    FI: ReadonlyMap<string, number>,
    RF: ReadonlySet<string> | undefined,
    PC?: ReadonlySet<string>
  ): boolean {
    const e = this.ix.ev[x]
    const r = this.ix.rec[x]
    const id = this.ix.ids[x]
    if (e.t === 'genesis') return false
    if (e.t === 'primary_rotate') return RF?.has(id) ?? false
    if (e.seq >= (F.get(e.dev) ?? Infinity)) return true
    if (PC?.has(id)) return true
    return r.depth >= fiOf(FI, e.a, r.epoch) || (RF?.has(id) ?? false)
  }
  private cleanIntro(x: number) {
    const e = this.ix.ev[x]
    const r = this.ix.rec[x]
    return (
      !this.RF.has(this.ix.ids[x]) &&
      !this.PC.has(this.ix.ids[x]) &&
      (e.t === 'primary_rotate' || r.depth < fiOf(this.FI, e.a, r.epoch))
    )
  }
  // Some identity op of the identity whose device signed w, in C(w), introduces w.dev cleanly.
  private introducedCleanly(w: number) {
    const ix = this.ix
    const we = ix.ev[w]
    const by = poster(we)
    for (const x of ix.introEv.get(we.dev) ?? EMPTY) {
      if (x !== w && !ix.has(w, x)) continue
      if (ix.rec[x].depth < 0 || ix.ev[x].a !== by) continue
      if (this.cleanIntro(x)) return true
    }
    return false
  }
  // drops(r, S): devices of r's identity introduced by an event not after r, other than r's own
  // and its keep; `skip` leaves out introductions (candidates for watermarks, X events for tails).
  droppedS(r: number, skip: (x: number) => boolean = () => false): string[] {
    const ix = this.ix
    const re = ix.ev[r]
    const keep = new Set<string>(introduces(re))
    const out = new Set<string>()
    for (const x of ix.introBy.get(re.a) ?? EMPTY) {
      if (x === r || !this.inS(x) || ix.has(x, r) || skip(x)) continue
      for (const v of introduces(ix.ev[x])) if (!keep.has(v)) out.add(v)
    }
    return [...out].sort()
  }
  // Candidate x in a state with fork points F, FI, contested set RF and pool candidates PC.
  candidateIn(
    x: number,
    F: ReadonlyMap<string, number>,
    FI: ReadonlyMap<string, number>,
    RF: ReadonlySet<string> | undefined,
    PC?: ReadonlySet<string>
  ) {
    const ix = this.ix
    const e = ix.ev[x]
    const r = ix.rec[x]
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
  // X: the candidates no clean witness of another identity acknowledged in good faith.
  voidSet() {
    const ix = this.ix
    const F = this.F
    const FI = this.FI
    const n = ix.n
    const wm = new Map<string, number>()
    const lower = (v: string, s: number) => {
      if (s < (wm.get(v) ?? Infinity)) wm.set(v, s)
    }
    for (const i of this.order) {
      const e = ix.ev[i]
      if (e.t === 'device_revoke' && typeof e.c.dk === 'string') {
        if (
          e.seq < (F.get(e.dev) ?? Infinity) &&
          !this.PC.has(ix.ids[i]) &&
          this.introducedCleanly(i)
        )
          lower(e.c.dk, typeof e.c.seen === 'number' ? e.c.seen : -1)
      }
      if (e.t === 'primary_rotate' && !this.RF.has(ix.ids[i]))
        for (const v of this.droppedS(i, x => this.idCand(x, F, FI, this.RF, this.PC)))
          lower(v, seenOf(e, v))
    }
    const clean = new Int8Array(n).fill(-1)
    const isClean = (w: number) => {
      if (clean[w] >= 0) return clean[w] === 1
      const we = ix.ev[w]
      const r = ix.rec[w]
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
      // witnessed: a descendant by another identity, clean, in good faith. Structural candidacy
      // only grows with the set, so the search stops at a w in whose St(w) i is a structural
      // candidate; a pool candidacy there makes w no witness but can end later (revision 7), so
      // the search goes on past it. A witness is of another identity than the candidate's, and
      // than its relayer's.
      const a = ix.ev[i].a
      const pa = poster(ix.ev[i])
      let wit = false
      const st = [i]
      while (st.length && !wit) {
        const y = st.pop()!
        for (const w of ix.kids[y]) {
          if (seen[w] === i || !this.inS(w)) continue
          seen[w] = i
          const lo = ix.rec[w].local
          if (this.candidateIn(i, lo.F, lo.FI, lo.RF, lo.PC)) {
            if (!this.candidateIn(i, lo.F, lo.FI, lo.RF)) st.push(w)
            continue
          }
          const we = ix.ev[w]
          const wp = poster(we)
          if (we.a !== a && we.a !== pa && wp !== a && wp !== pa && isClean(w)) {
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
  // Tail: the events of revoked or dropped devices past the watermark, with the revocations
  // whose tail holds them. Returns the revocations in force.
  // The watermarks of the revocations in force: a revoked or dropped device's events past `seen`.
  marks: { r: number; dev: string; seen: number }[] = []
  tails(): number[] {
    const ix = this.ix
    const n = ix.n
    const X = this.X
    this.tail = new Uint8Array(n)
    this.marks = []
    const revs: number[] = []
    for (const i of this.order) {
      const t = ix.ev[i].t
      if ((t === 'device_revoke' || t === 'primary_rotate') && !X[i]) revs.push(i)
    }
    for (const r of revs) {
      const re = ix.ev[r]
      const covered =
        re.t === 'device_revoke'
          ? [{ dev: re.c.dk, seen: typeof re.c.seen === 'number' ? re.c.seen : -1 }]
          : this.droppedS(r, x => X[x] === 1).map(v => ({ dev: v, seen: seenOf(re, v) }))
      for (const { dev, seen } of covered) {
        this.marks.push({ r, dev, seen })
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
}

// The watermark a rotation gives a device it drops (absent: -1).
export const seenOf = (e: AclEv, v: string): number => {
  const s = e.c.seen
  if (typeof s !== 'object' || s === null) return -1
  const x = s[v]
  return typeof x === 'number' ? x : -1
}

// The orphan rule of §2.3 (storage only) on the held set `ids` with state `st`: X events with no
// held descendant, other than the genesis, upgrades and proofs (a kept header doesn't hold the
// pair a proof carries, so dropping one could raise F), that are structural candidates (a
// candidate only by pool evidence can stop being one, revision 7), and whose drop leaves FI (on
// the genesis epoch and every epoch whose rotation is not contested) and the contested identity
// ops among the held events unchanged; tried in descending id order until nothing more can go.
// Returns the dropped ids; their headers stay as evidence (`ghosts`), except those `bare` gets
// (revision 7): past their device's fork point, no identity op, in no kept header's past, and
// with F, FI and the contested ops unchanged without the header.
export function orphanDrops(
  ids: readonly string[],
  st: EvalResult,
  cx: Ctx,
  ghosts: readonly string[] = [],
  bare?: Set<string>
): Set<string> {
  const out = new Set<string>()
  const gone = new Set<string>()
  if (!st.X.size) return out
  const fp = (E: readonly string[], G: readonly string[]) => {
    const ix = Ix.of(E, cx)
    const q = new Equiv(ix)
    if (G.length)
      q.hdrs = new Hdrs(
        ix,
        G.map(id => ({ ev: cx.ev(id), rec: cx.rec(id) }))
      )
    q.forkPoints()
    return q
  }
  const full = fp(ids, ghosts)
  const liveKey = (k: string) => {
    const ep = k.slice(k.indexOf('|') + 1)
    return ep === '' || !full.RF.has(ep)
  }
  const keyFI = (m: ReadonlyMap<string, number>) =>
    [...m]
      .filter(([k]) => liveKey(k))
      .map(([k, v]) => `${k},${v}`)
      .sort()
      .join(';')
  const keyF = (m: ReadonlyMap<string, number>) =>
    [...m]
      .map(([k, v]) => `${k},${v}`)
      .sort()
      .join(';')
  const fiFull = keyFI(full.FI)
  const fFull = keyF(full.F)
  const rfSame = (q: Equiv, rest: readonly string[], skip?: string) =>
    ![...full.RF].some(x => x !== skip && rest.includes(x) && !q.RF.has(x)) &&
    ![...q.RF].some(x => !full.RF.has(x))
  let kept = [...ids]
  const anc = Ix.of(ids, cx)
  const S = new Equiv(anc)
  const cands = [...st.X]
    .filter(x => anc.at.has(x))
    .sort()
    .reverse()
  const hdrs = () => [...ghosts, ...[...out].filter(x => !gone.has(x))]
  const pastHas = (x: string, id: string) => {
    const xi = anc.at.get(x)
    if (xi !== undefined) return anc.has(xi, anc.at.get(id)!)
    const seen = new Set<string>()
    const st = [...cx.ev(x).ap]
    while (st.length) {
      const p = st.pop()!
      if (p === id) return true
      if (seen.has(p)) continue
      seen.add(p)
      const pi = anc.at.get(p)
      if (pi !== undefined) {
        if (anc.has(pi, anc.at.get(id)!)) return true
        continue
      }
      st.push(...cx.ev(p).ap)
    }
    return false
  }
  for (let changed = true; changed;) {
    changed = false
    for (const id of cands) {
      if (out.has(id)) continue
      const e = cx.ev(id)
      if (e.t === 'upgrade' || e.t === 'genesis' || e.t === 'proof') continue
      const xi = anc.at.get(id)!
      if (!S.candidateIn(xi, st.F, st.FI, st.RF)) continue
      if (kept.some(x => x !== id && anc.has(anc.at.get(x)!, xi))) continue
      const rest = kept.filter(x => x !== id)
      const h = hdrs()
      const f2 = fp(rest, [...h, id])
      if (keyFI(f2.FI) !== fiFull || !rfSame(f2, rest, id)) continue
      kept = rest
      out.add(id)
      changed = true
      if (e.seq < (full.F.get(e.dev) ?? Infinity) || cx.rec(id).depth >= 0) continue
      if (h.some(x => pastHas(x, id))) continue
      const f3 = fp(rest, h)
      if (keyF(f3.F) !== fFull || keyFI(f3.FI) !== fiFull || !rfSame(f3, rest)) continue
      gone.add(id)
    }
  }
  if (bare) for (const x of gone) bare.add(x)
  return out
}
