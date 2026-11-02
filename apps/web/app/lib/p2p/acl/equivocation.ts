import { fiOf, type EvalResult } from './facts'
import { EMPTY, Ix, pushM } from './reach'
import { introduces, LIM, type AclEv, type Ctx } from './rules'

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

export class Equiv {
  F = new Map<string, number>()
  FI = new Map<string, number>()
  RF = new Set<string>()
  PC = new Set<string>()
  X!: Uint8Array
  tail!: Uint8Array
  tailBy = new Map<number, number[]>()
  order: number[]

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

  // Dropped events (orphan rule): indexed, not in S, and still counted as every kind of evidence.
  ghost: Uint8Array | null = null
  inEv(i: number) {
    return this.inS(i) || (this.ghost !== null && this.ghost[i] === 1)
  }

  forkPoints() {
    const ix = this.ix
    const F = this.F
    const FI = this.FI
    const low = (dev: string, m: number) => {
      if (m < (F.get(dev) ?? Infinity)) F.set(dev, m)
    }
    for (const [dev, es] of ix.byDev) {
      const bySeq = new Map<number, number>()
      const byPrev = new Map<string, number>()
      for (const i of es) {
        if (!this.inEv(i)) continue
        const e = ix.ev[i]
        const s1 = bySeq.get(e.seq)
        if (s1 !== undefined) low(dev, Math.min(e.seq, s1))
        else bySeq.set(e.seq, e.seq)
        const pk = e.aprev ?? ''
        const s2 = byPrev.get(pk)
        if (s2 !== undefined) {
          low(dev, Math.min(e.seq, s2))
          byPrev.set(pk, Math.min(s2, e.seq))
        } else byPrev.set(pk, e.seq)
      }
    }
    for (const p of ix.proofEv) {
      if (!this.inS(p)) continue
      const { x, y } = ix.ev[p].c as unknown as { x: Header; y: Header }
      low(x.dev, Math.min(x.seq, y.seq))
    }
    const byIdn = new Map<string, Map<string, number>>()
    for (const i of ix.idOps) {
      const e = ix.ev[i]
      const r = ix.rec[i]
      if (e.t === 'primary_rotate' || !this.inEv(i)) continue
      const key = `${e.a}|${r.epoch}`
      let m = byIdn.get(key)
      if (!m) byIdn.set(key, (m = new Map()))
      const pk = e.iprev ?? ''
      const d0 = m.get(pk)
      if (d0 !== undefined) {
        const d = Math.min(d0, r.depth)
        if (d < (FI.get(key) ?? Infinity)) FI.set(key, d)
      } else m.set(pk, r.depth)
    }
    // rotation evidence: any two concurrent rotations of one identity; race evidence: a
    // non-rotation identity op over the iprev of a rotation of its identity
    const byRot = new Map<string, number[]>()
    const rotPrev = new Set<string>()
    for (const i of ix.idOps)
      if (this.inEv(i) && ix.ev[i].t === 'primary_rotate') {
        pushM(byRot, ix.ev[i].a, i)
        rotPrev.add(`${ix.ev[i].a}|${ix.ev[i].iprev ?? ''}`)
      }
    if (rotPrev.size)
      for (const i of ix.idOps) {
        const e = ix.ev[i]
        const r = ix.rec[i]
        if (e.t === 'primary_rotate' || !this.inEv(i) || !rotPrev.has(`${e.a}|${e.iprev ?? ''}`))
          continue
        const key = `${e.a}|${r.epoch}`
        if (r.depth < (FI.get(key) ?? Infinity)) FI.set(key, r.depth)
      }
    const sib: number[] = []
    const sibS = new Set<number>()
    for (const rs of byRot.values())
      for (let x = 0; x < rs.length; x++)
        for (let y = x + 1; y < rs.length; y++)
          if (!ix.has(rs[x], rs[y]) && !ix.has(rs[y], rs[x])) {
            sibS.add(rs[x])
            sibS.add(rs[y])
          }
    for (const r of sibS) {
      this.RF.add(ix.ids[r])
      sib.push(r)
    }
    if (sib.length)
      for (const i of ix.idOps) {
        if (!this.inEv(i)) continue
        const e = ix.ev[i]
        const id = ix.ids[i]
        if (this.RF.has(id)) continue
        if (e.t === 'primary_rotate') {
          if (
            e.iprev !== undefined &&
            this.RF.has(e.iprev) &&
            sib.some(q => ix.ev[q].a === e.a && !ix.has(i, q) && !ix.has(q, i))
          )
            this.RF.add(id)
        } else if (ix.rec[i].epoch !== '' && this.RF.has(ix.rec[i].epoch)) this.RF.add(id)
      }
    this.PC = this.poolCands()
  }

  // Pool candidates (W3(g)): a non-owner's event x other than a rotation whose pool
  // P(x) = U(x) ∪ ⋃ U(y) over the events y of its identity concurrent with x exceeds poolU.
  poolCands(): Set<string> {
    const ix = this.ix
    const lim = LIM.poolU
    const PC = new Set<string>()
    const byA = new Map<string, number[]>()
    for (let i = 0; i < ix.n; i++)
      if (this.inEv(i) && ix.rec[i].pool && !ix.owners.has(ix.ev[i].a)) pushM(byA, ix.ev[i].a, i)
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
    const addPool = (y: number) => {
      const p = poolIx(y)
      for (let k = 0; k < p.length; k++) add(p[k])
    }
    for (const es of byA.values()) {
      if (es.length <= 1) continue
      let chain = true
      for (let k = 1; k < es.length && chain; k++) if (!ix.has(es[k], es[k - 1])) chain = false
      if (chain) continue
      const byD = new Map<string, number[]>()
      for (const i of es) pushM(byD, ix.ev[i].dev, i)
      const segs: { l: number[]; lin: boolean; pre: number[] }[] = []
      for (const l of byD.values()) {
        let lin = true
        for (let k = 1; k < l.length && lin; k++) if (!ix.has(l[k], l[k - 1])) lin = false
        const pre = [0]
        for (const y of l) pre.push(pre[pre.length - 1] + ix.rec[y].pool!.length)
        segs.push({ l, lin, pre })
      }
      const sp: number[] = []
      const sq: number[] = []
      for (const x of es) {
        if (ix.ev[x].t === 'primary_rotate') continue
        const ux = ix.rec[x].pool!.length
        let lo = ux
        let hi = ux
        for (let si = 0; si < segs.length; si++) {
          const { l, lin, pre } = segs[si]
          let p = 0
          let q = 0
          if (lin) {
            let a = 0
            let b = l.length
            while (a < b) {
              const m = (a + b) >> 1
              if (ix.has(x, l[m])) a = m + 1
              else b = m
            }
            p = a
            b = l.length
            while (a < b) {
              const m = (a + b) >> 1
              if (l[m] === x || ix.has(l[m], x)) b = m
              else a = m + 1
            }
            q = a
            if (q > p) {
              lo += q - p
              hi += pre[q] - pre[p]
            }
          } else
            for (const y of l)
              if (y !== x && !ix.has(x, y) && !ix.has(y, x)) {
                lo++
                hi += ix.rec[y].pool!.length
              }
          sp[si] = p
          sq[si] = q
        }
        if (lo > lim) {
          PC.add(ix.ids[x])
          continue
        }
        if (hi <= lim) continue
        if (!stamp) stamp = new Int32Array(ix.n)
        cur++
        cnt = 0
        addPool(x)
        for (let si = 0; si < segs.length && cnt <= lim; si++) {
          const { l, lin } = segs[si]
          if (lin) {
            for (let k = sp[si]; k < sq[si]; k++) add(l[k])
            if (sq[si] > sp[si]) addPool(l[sq[si] - 1])
          } else for (const y of l) if (y !== x && !ix.has(x, y) && !ix.has(y, x)) addPool(y)
        }
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
  // Some identity op of w's own identity in C(w) introduces w.dev cleanly.
  private introducedCleanly(w: number) {
    const ix = this.ix
    const we = ix.ev[w]
    for (const x of ix.introEv.get(we.dev) ?? EMPTY) {
      if (x !== w && !ix.has(w, x)) continue
      if (ix.rec[x].depth < 0 || ix.ev[x].a !== we.a) continue
      if (this.cleanIntro(x)) return true
    }
    return false
  }
  // drops(r, S): devices of r's identity introduced by an event not after r, other than r's own
  // and its keep; `skip` leaves out introductions (candidates for watermarks, X events for tails).
  droppedS(r: number, skip: (x: number) => boolean = () => false): string[] {
    const ix = this.ix
    const re = ix.ev[r]
    const keep = new Set<string>([re.dev, ...(re.c.keep ?? [])])
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
      // witnessed: a descendant by another identity, clean, in good faith; candidacy only grows
      // with the set, so the search stops at a w in whose St(w) i is a candidate
      const a = ix.ev[i].a
      let wit = false
      const st = [i]
      while (st.length && !wit) {
        const y = st.pop()!
        for (const w of ix.kids[y]) {
          if (seen[w] === i || !this.inS(w)) continue
          seen[w] = i
          const lo = ix.rec[w].local
          if (this.candidateIn(i, lo.F, lo.FI, lo.RF, lo.PC)) continue
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
// held descendant, other than the genesis and upgrades, whose drop leaves FI (on the genesis
// epoch and every epoch whose rotation is not contested) and the contested identity ops among the
// held events unchanged; tried in descending id order until nothing more can go. Returns the
// dropped ids; their headers stay as evidence (`ghosts`).
export function orphanDrops(
  ids: readonly string[],
  st: EvalResult,
  cx: Ctx,
  ghosts: readonly string[] = []
): Set<string> {
  const out = new Set<string>()
  if (!st.X.size) return out
  const fp = (E: readonly string[], G: readonly string[]) => {
    const ix = Ix.of([...E, ...G], cx)
    const mS = new Uint8Array(ix.n)
    const gm = new Uint8Array(ix.n)
    for (const id of E) mS[ix.at.get(id)!] = 1
    for (const id of G) gm[ix.at.get(id)!] = 1
    const q = new Equiv(ix, mS)
    q.ghost = gm
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
  const fiFull = keyFI(full.FI)
  let kept = [...ids]
  const anc = Ix.of(ids, cx)
  const cands = [...st.X]
    .filter(x => anc.at.has(x))
    .sort()
    .reverse()
  for (let changed = true; changed;) {
    changed = false
    for (const id of cands) {
      if (out.has(id)) continue
      const e = cx.ev(id)
      if (e.t === 'upgrade' || e.t === 'genesis') continue
      const xi = anc.at.get(id)!
      if (kept.some(x => x !== id && anc.has(anc.at.get(x)!, xi))) continue
      const rest = kept.filter(x => x !== id)
      const f2 = fp(rest, [...ghosts, ...out, id])
      if (keyFI(f2.FI) !== fiFull) continue
      if (
        [...full.RF].some(x => x !== id && rest.includes(x) && !f2.RF.has(x)) ||
        [...f2.RF].some(x => !full.RF.has(x))
      )
        continue
      kept = rest
      out.add(id)
      changed = true
    }
  }
  return out
}
