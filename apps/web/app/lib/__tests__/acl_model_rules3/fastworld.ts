/* eslint-disable */
// @ts-nocheck
// Part of the P2P ACL reference model, used only by tests.
// A scenario builder with the API of world.ts for large universes (benchmarks): events are admitted by the
// reference `decide` (model.ts), but every admission state St(e) = Eval(C(ap)) comes from fast.ts (`FastState`), and
// ancestry from fast.ts's bitset index. O13-fast checks on every fuzz case that fast.ts computes the reference's states,
// so a universe built here is one the reference replica would build; `bench.ts` also re-checks a sample at small sizes.
import {
  type Ctx,
  type Ev,
  type EvalResult,
  type Rec,
  type T,
  type Verdict,
  TOP,
  LIM,
  decide,
  devOwner,
  idOp,
  identityHead,
  candidate,
  limitsOf,
  withLim,
} from './model'
import { FastState } from './fast'
import type { Opts } from './world'

/** B(e) as a read-only set of ids, backed by the ancestor bitset of e */
class AncSet implements Iterable<string> {
  private n = -1
  constructor(
    private fs: FastState,
    private i: number
  ) {}
  has(id: string) {
    const x = this.fs.ix.at.get(id)
    return x !== undefined && this.fs.ix.has(this.i, x)
  }
  get size() {
    if (this.n < 0) {
      let c = 0
      for (let x = 0; x < this.i; x++) if (this.fs.ix.has(this.i, x)) c++
      this.n = c
    }
    return this.n
  }
  *[Symbol.iterator]() {
    for (let x = 0; x < this.i; x++) if (this.fs.ix.has(this.i, x)) yield this.fs.ix.ids[x]
  }
  forEach(f: (id: string) => void) {
    for (const id of this) f(id)
  }
}

export class FastReplica implements Ctx {
  evs = new Map<string, Ev>()
  recs = new Map<string, Rec>()
  status = new Map<string, Verdict>()
  order: string[] = []
  fs = new FastState(this)
  private ancs = new Map<string, AncSet>()
  ev(id: string) {
    return this.evs.get(id)!
  }
  rec(id: string) {
    return this.recs.get(id)!
  }
  anc(id: string): Set<string> {
    let a = this.ancs.get(id)
    if (!a) {
      a = new AncSet(this.fs, this.fs.ix.at.get(id)!)
      this.ancs.set(id, a)
    }
    return a as unknown as Set<string>
  }
  /** the server's limits (rules 3 genesis) */
  lim?: typeof LIM
  state(): EvalResult {
    return withLim(this.lim, () => this.fs.state())
  }
  admitted(id: string) {
    return this.status.get(id)?.s === 'A'
  }
  /** C(ap) as ids, in index order */
  closureIds(ap: string[]): string[] {
    const ix = this.fs.ix,
      m = new Uint8Array(ix.n)
    for (const p of ap) {
      const i = ix.at.get(p)!
      m[i] = 1
      const a = ix.anc[i]
      for (let x = 0; x < i; x++) if ((a[x >>> 5] >>> (x & 31)) & 1) m[x] = 1
    }
    const out: string[] = []
    for (let x = 0; x < ix.n; x++) if (m[x]) out.push(ix.ids[x])
    return out
  }
  receive(e: Ev): Verdict {
    return withLim(this.lim, () => this.receive1(e))
  }
  private receive1(e: Ev): Verdict {
    if (this.status.has(e.id)) return this.status.get(e.id)!
    this.evs.set(e.id, e)
    if (e.t === 'genesis') {
      const L = limitsOf(e.c)
      if (L.bad) return this.set(e.id, { s: 'R', why: 'genesis' })
      if (L.lim) this.lim = L.lim
      const emptyF = {
        facts: undefined as any,
        X: new Set<string>(),
        tail: new Set<string>(),
        cut: new Map(),
        eff: new Set<string>(),
        F: new Map(),
        FI: new Map(),
        void: new Set<string>(),
      }
      this.recs.set(e.id, {
        k: TOP,
        cls: 'G',
        self: false,
        exempt: true,
        depth: 0,
        epoch: '',
        local: emptyF,
      })
      return this.admit(e)
    }
    for (const p of e.ap) {
      const st = this.status.get(p)
      if (st?.s === 'R') return this.set(e.id, { s: 'R', why: 'parent' })
      if (st?.s !== 'A')
        throw new Error(`fastworld: parent ${p} of ${e.id} not admitted (no pending store here)`)
    }
    const B = this.closureIds(e.ap)
    const S = this.fs.stateOf(e.ap)
    const d = decide(e, B, this, S)
    if (!d.ok) return this.set(e.id, { s: 'R', why: d.why })
    this.recs.set(e.id, d.rec)
    return this.admit(e)
  }
  private set(id: string, v: Verdict) {
    this.status.set(id, v)
    return v
  }
  private admit(e: Ev): Verdict {
    this.status.set(e.id, { s: 'A' })
    this.order.push(e.id)
    this.fs.append(e.id)
    return { s: 'A' }
  }
}

export class FastWorld {
  ref = new FastReplica()
  all: Ev[] = []
  n = 0
  private headSet = new Set<string>()
  private lastOwn = new Map<string, Ev>()

  heads(): string[] {
    return [...this.headSet]
  }
  /**
   * The client rule, on when `clientRule` is set (bench.ts sets it for its measured events; the shapes
   * choose their parents explicitly where it matters): the default parents are the maximal events that are no
   * candidate, X or Tail event (upgrades excepted) in the current state, walking down from excluded heads.
   */
  clientRule = false
  private citable(): string[] {
    const R = this.ref,
      st = R.state(),
      hs = this.heads()
    const forked =
      st.F.size > 0 ||
      [...st.FI.values()].some(d => d < Infinity) ||
      (st.RF?.size ?? 0) > 0 ||
      (st.PC?.size ?? 0) > 0
    const bad = (id: string) =>
      R.ev(id).t !== 'upgrade' &&
      (st.X.has(id) ||
        st.tail.has(id) ||
        (forked && candidate(id, R, st.F, st.FI, st.X, st.RF, st.PC)))
    if (!hs.some(bad)) return hs
    const out = new Set<string>(),
      seen = new Set<string>(),
      todo = [...hs]
    while (todo.length) {
      const x = todo.pop()!
      if (seen.has(x)) continue
      seen.add(x)
      if (!bad(x)) out.add(x)
      else for (const p of R.ev(x).ap) todo.push(p)
    }
    const l = [...out]
    return l.filter(x => !l.some(y => y !== x && R.anc(y).has(x)))
  }
  /** the honest client's parents under the client rule: citable heads, at most LIM.ap, own latest event kept */
  defaultParents(dev: string): string[] {
    const R = this.ref,
      ix = R.fs.ix
    let ap = this.citable()
    if (ap.length > LIM.ap) ap = ap.sort((x, y) => ix.at.get(y)! - ix.at.get(x)!).slice(0, LIM.ap)
    const own = this.latestOwn(dev)
    if (own && !ap.some(p => p === own.id || R.anc(p).has(own.id))) {
      if (ap.length >= LIM.ap) ap[ap.length - 1] = own.id
      else ap.push(own.id)
    }
    return ap
  }
  latestOwn(dev: string): Ev | undefined {
    return this.lastOwn.get(dev)
  }
  private note(e: Ev, v: Verdict) {
    if (v.s !== 'A') return
    for (const p of e.ap) this.headSet.delete(p)
    this.headSet.add(e.id)
    const l = this.lastOwn.get(e.dev)
    if (!l || e.seq > l.seq) this.lastOwn.set(e.dev, e)
  }
  genesis(
    dev: string,
    owners: string[],
    everyone = 0,
    ts = 0,
    extra: Record<string, unknown> = {}
  ): Ev {
    const e: Ev = {
      id: `g${this.n++}`,
      t: 'genesis',
      a: devOwner(dev),
      dev,
      seq: 0,
      ap: [],
      ts,
      c: { owners, everyone, ...extra },
    }
    this.all.push(e)
    this.note(e, this.ref.receive(e))
    return e
  }
  build(dev: string, t: T, c: any = {}, o: Opts = {}): Ev {
    const a = devOwner(dev),
      R = this.ref
    let ap = o.ap ? [...o.ap] : this.clientRule ? this.defaultParents(dev) : this.heads()
    if (!o.ap && ap.length > LIM.ap) {
      // world.ts capHeads: the most recently admitted heads, keeping the device's own latest event in their closure
      const ix = R.fs.ix
      ap = ap.sort((x, y) => ix.at.get(y)! - ix.at.get(x)!).slice(0, LIM.ap)
      const own = this.latestOwn(dev)
      if (own && !ap.some(p => p === own.id || R.anc(p).has(own.id))) ap[ap.length - 1] = own.id
    }
    if (!o.ap && this.clientRule) {
      // the own device's latest event stays in the closure (world.ts capHeads)
      const own = this.latestOwn(dev)
      if (own && !ap.some(p => p === own.id || R.anc(p).has(own.id))) {
        if (ap.length >= LIM.ap) ap[ap.length - 1] = own.id
        else ap.push(own.id)
      }
    }
    if (o.ap && (o.keepOwn ?? (o.seq === undefined && o.aprev === undefined))) {
      const own = this.latestOwn(dev)
      if (own && !ap.some(p => p === own.id || R.anc(p).has(own.id))) ap.push(own.id)
    }
    ap = [...new Set(ap)]
    // the device's last ACL event in C(ap)
    let last: Ev | undefined
    const ix = R.fs.ix
    for (const x of ix.byDev.get(dev) ?? []) {
      const xe = ix.ev[x]
      if (!ap.some(p => p === xe.id || R.anc(p).has(xe.id))) continue
      if (!last || xe.seq > last.seq) last = xe
    }
    const ts = o.ts ?? Math.max(0, ...ap.map(p => R.ev(p).ts)) + 1
    const e: Ev = {
      id: `${t}.${dev}.${this.n++}`,
      t,
      a,
      dev,
      seq: o.seq ?? (last ? last.seq + 1 : 1),
      ap,
      ts,
      c,
    }
    const aprev = o.aprev === undefined ? last?.id : (o.aprev ?? undefined)
    if (aprev) e.aprev = aprev
    const Fb = R.fs.stateOf(ap).facts
    if (idOp(e, Fb)) {
      const ip =
        o.iprev === undefined
          ? identityHead(a, R.closureIds(ap), R, t === 'primary_rotate').iprev
          : (o.iprev ?? undefined)
      if (ip) e.iprev = ip
    }
    return e
  }
  act(dev: string, t: T, c: any = {}, o: Opts = {}): { e: Ev; v: Verdict } {
    const e = withLim(this.ref.lim, () => this.build(dev, t, c, o))
    this.all.push(e)
    const v = this.ref.receive(e)
    this.note(e, v)
    return { e, v }
  }
  ok(dev: string, t: T, c: any = {}, o: Opts = {}): Ev {
    const { e, v } = this.act(dev, t, c, o)
    if (v.s !== 'A') throw new Error(`expected admit: ${e.id} ${JSON.stringify(v)}`)
    return e
  }
  state() {
    return this.ref.state()
  }
}
