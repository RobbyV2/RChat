/* eslint-disable */
// @ts-nocheck
// Copy of notes/acl-model/world.ts (the executable reference model of the P2P ACL spec), used only by the differential tests.
// Scenario builder: a universe of events plus a reference replica that holds everything.
import {
  type Ev,
  type T,
  Replica,
  idOp,
  devOwner,
  identityHead,
  type Verdict,
  LIM,
  MUT,
  candidate,
} from './model'

export interface Opts {
  ap?: string[] // explicit ACL parents (backdating / partitions)
  keepOwn?: boolean // with ap: also cite the device's own latest event (honest stale device). Default: true unless seq/aprev are forced.
  seq?: number
  aprev?: string | null
  iprev?: string | null
  ts?: number
}

export class World {
  ref = new Replica()
  all: Ev[] = [] // every event built, in creation order (admitted or not)
  n = 0

  heads(ids?: string[]): string[] {
    const set = ids ?? this.ref.order
    const inPast = new Set<string>()
    for (const id of set) for (const x of this.ref.anc(id)) inPast.add(x)
    return set.filter(id => !inPast.has(id))
  }
  closure(ap: string[]): Set<string> {
    const B = new Set<string>()
    for (const p of ap) {
      B.add(p)
      for (const x of this.ref.anc(p)) B.add(x)
    }
    return B
  }
  latestOwn(dev: string): Ev | undefined {
    let best: Ev | undefined
    for (const id of this.ref.order) {
      const e = this.ref.ev(id)
      if (e.dev === dev && (!best || e.seq > best.seq)) best = e
    }
    return best
  }

  genesis(dev: string, owners: string[], everyone = 0, ts = 0): Ev {
    const e: Ev = {
      id: `g${this.n++}`,
      t: 'genesis',
      a: devOwner(dev),
      dev,
      seq: 0,
      ap: [],
      ts,
      c: { owners, everyone },
    }
    this.all.push(e)
    this.ref.receive(e)
    return e
  }

  /**
   * Revision 7 (controller ruling on r6.1, client rule): the events an honest client never cites, in its own state
   * (here the reference replica's): candidates, X and Tail events other than upgrades. Mutant `cite-cands` cites every head.
   */
  excluded(): Set<string> {
    const st = this.ref.state(),
      out = new Set<string>([...st.X, ...st.tail])
    const forked =
      st.F.size > 0 ||
      [...st.FI.values()].some(d => d < Infinity) ||
      (st.RF?.size ?? 0) > 0 ||
      (st.PC?.size ?? 0) > 0
    if (forked)
      for (const id of this.ref.order)
        if (!out.has(id) && candidate(id, this.ref, st.F, st.FI, st.X, st.RF, st.PC)) out.add(id)
    // an upgrade is immune to X (§1.5, §3.8): honest clients cite it, so the old server freezes (vector I7; mutant
    // `cite-no-upgrade`)
    if (MUT !== 'cite-no-upgrade')
      for (const id of out) if (this.ref.ev(id).t === 'upgrade') out.delete(id)
    return out
  }
  /**
   * An honest client's parents (§1.2, revision 6): the heads, at most LIM.ap of them; with more, the most recently
   * admitted ones, and the device's own latest event stays in their closure (else its next event would fork it).
   * Revision 7 (client rule): the heads of the events it may cite (no candidate, X or Tail event); its own device's
   * latest event stays in the closure whatever it is (its own chain acknowledges nothing).
   */
  capHeads(dev: string): string[] {
    let hs = this.heads()
    if (MUT !== 'cite-cands') {
      const ex = this.excluded()
      if (hs.some(h => ex.has(h))) hs = this.heads(this.ref.order.filter(id => !ex.has(id)))
    }
    let ap = hs
    if (hs.length > LIM.ap) {
      const at = new Map(this.ref.order.map((id, i) => [id, i]))
      ap = [...hs].sort((x, y) => at.get(y)! - at.get(x)!).slice(0, LIM.ap)
    }
    const own = this.latestOwn(dev)
    if (own && !this.closure(ap).has(own.id)) {
      if (ap.length >= LIM.ap) ap[ap.length - 1] = own.id
      else ap.push(own.id)
    }
    return ap
  }

  build(dev: string, t: T, c: any = {}, o: Opts = {}): Ev {
    const a = devOwner(dev)
    let ap = o.ap ? [...o.ap] : this.capHeads(dev)
    if (o.ap && (o.keepOwn ?? (o.seq === undefined && o.aprev === undefined))) {
      const own = this.latestOwn(dev)
      if (own && !this.closure(ap).has(own.id)) ap.push(own.id)
    }
    ap = [...new Set(ap)]
    const B = this.closure(ap)
    const evs = [...B].map(id => this.ref.ev(id))
    const own = evs.filter(x => x.dev === dev).sort((x, y) => x.seq - y.seq)
    const last = own[own.length - 1]
    const Fb = this.ref.evalSet(this.ref.order.filter(id => B.has(id))).facts
    const ts = o.ts ?? Math.max(0, ...ap.map(p => this.ref.ev(p).ts)) + 1
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
    if (idOp(e, Fb)) {
      // the epoch-aware identity-chain head (§2.2): what an honest primary key would sign over
      const ip =
        o.iprev === undefined
          ? identityHead(a, [...B], this.ref, t === 'primary_rotate').iprev
          : (o.iprev ?? undefined)
      if (ip) e.iprev = ip
    }
    return e
  }

  /** Build, deliver to the reference replica, return the event and its verdict. */
  act(dev: string, t: T, c: any = {}, o: Opts = {}): { e: Ev; v: Verdict } {
    const e = this.build(dev, t, c, o)
    this.all.push(e)
    this.ref.receive(e)
    return { e, v: this.ref.status.get(e.id)! }
  }
  /** Like act, but throws unless admitted. */
  ok(dev: string, t: T, c: any = {}, o: Opts = {}): Ev {
    const { e, v } = this.act(dev, t, c, o)
    if (v.s !== 'A') throw new Error(`expected admit: ${e.id} ${JSON.stringify(v)}`)
    return e
  }
  state() {
    return this.ref.state()
  }
}
