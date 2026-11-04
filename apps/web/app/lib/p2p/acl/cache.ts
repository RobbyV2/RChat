import { Hdrs } from './equivocation'
import { LOCAL } from '../limits'
import { FastEval } from './eval'
import { emptyResult, type EvalResult } from './facts'
import { Ix } from './reach'
import { poster, type AclEv, type Ctx } from './rules'
import { snapPacked, packedOfSets, subsetResult, snapResult, type Packed } from './packed'

// Recorded states and the client's incremental evaluator (spec §5). Every admitted event records
// St(e). On the head path St(e) is the current state, and an event on the heads changes no
// earlier status, so the state after `len` events is the evaluator's arrays read below `len`: a
// snapshot costs O(1) memory. Off the heads, St(e) = Eval(C(ap)) is one evaluation of the downset
// over the shared index, kept in a merge cache keyed by the sorted parents.

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
