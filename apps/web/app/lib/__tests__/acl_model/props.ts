/* eslint-disable */
// @ts-nocheck
// Copy of notes/acl-model/props.ts (the executable reference model of the P2P ACL spec), used only by the differential tests.
// Property oracles (spec §7.1) checked on generated cases.
import {
  type Ctx,
  type Ev,
  type EvalResult,
  type Facts,
  type Rank,
  Replica,
  authorizeFull,
  admissible,
  cmp,
  evalSummary,
  evaluate,
  facts,
  gt,
  minR,
  perms,
  rank,
  target,
  view,
  BOT,
  KICK,
  SERVER,
  INVITE,
  LIM,
  MODBITS,
  authorizedIn,
  hullCheck,
  hullLog,
  posHullBrute,
  MUT,
  forkPoints,
  candidate,
  totCounted,
  stats,
} from './model'
import { type Case, Rng } from './gen'
import { g5Oracle } from './oracle'
import { fastEvaluate, FastState } from './fast'

/** Strata with more same-stratum causes than this are not checked by the exponential G5 oracle (counted as skipped). */
export const ORACLE_BOUND = Number(
  (typeof process !== 'undefined' && process.env.ACL_ORACLE_BOUND) || 10
)
export const oracleStats = {
  cases: 0,
  strata: 0,
  checked: 0,
  skipped: 0,
  maxCauses: 0,
  subsets: 0,
  fallback: 0,
  workFallback: 0,
  lazy: 0,
  monoTests: 0,
  hulls: 0,
  earlyDrops: 0,
  earlyDropCases: 0,
  tailDrops: 0,
  fastSets: 0,
  fastSteps: 0,
  fastHead: 0,
  fastHeaderSets: 0,
  finalDrops: 0,
  bareDrops: 0,
  idDrops: 0,
  pcCases: 0,
  rfCases: 0,
  maxStoredHeaders: 0,
  headerOver: 0,
  maxIdHeaders: 0,
  maxPerDevice: 0,
  maxBelowId: 0,
}

/**
 * O13-fast (revision 5, dispatch 5b): the production-style evaluator of fast.ts equals the reference on every set the
 * reference evaluated for this replica (every admission state St(e), every prefix of the admission order that the
 * prefix properties evaluated, the final state), and its incremental state (append in admission order, head fast path
 * or re-run) equals the reference after every step, with every admission state St(e) = stateOf(e.ap). Skipped under a
 * mutant (the fast evaluator implements the unmutated rules).
 */
export function fastDiff(ref: Replica, fail: (prop: string, detail: string) => void) {
  if (!fastOn()) return
  const want = new Map<string, string>()
  for (const [key, r] of ref.memo) {
    if (!key) continue
    const ids = key.split(',')
    const w = evalSummary(r)
    want.set(key, w)
    oracleStats.fastSets++
    let got: string
    try {
      got = evalSummary(fastEvaluate(ids, ref))
    } catch (e) {
      got = `error ${(e as Error).message}`
    }
    if (got !== w) {
      fail('O13-fast', `Eval of a set of ${ids.length} differs`)
      return
    }
  }
  const order = ref.order,
    fs = new FastState(ref)
  for (let i = 0; i < order.length; i++) {
    const id = order[i]
    if (i > 0 && evalSummary(fs.stateOf(ref.ev(id).ap)) !== evalSummary(ref.rec(id).local)) {
      fail('O13-fast', `St(${id}) differs`)
      return
    }
    fs.append(id)
    const r = fs.state()
    oracleStats.fastSteps++
    const key = [...order.slice(0, i + 1)].sort().join(',')
    const w = want.get(key)
    if (w !== undefined && evalSummary(r) !== w) {
      fail('O13-fast', `incremental state after ${id} differs`)
      return
    }
  }
  oracleStats.fastHead += fs.stats.head
  if (evalSummary(fs.state()) !== evalSummary(ref.state()))
    fail('O13-fast', 'incremental final state differs')
}

/** fast.ts implements the unmutated rules: O13-fast runs without a mutant, or under a fast-only one (`fast-…`) */
const fastOn = () => !MUT || MUT.startsWith('fast-')
/**
 * O13-fast on a set with headers (revision 6, r5 review I1): fast.ts with the headers of the dropped events equals the
 * reference with the same headers (every set the orphan, absent and tail-drop properties build).
 */
export const fastHeaderFail: { last?: { ids: string[]; ghosts: string[]; tag: string } } = {}
function fastHeaders(
  ids: string[],
  ghosts: string[],
  want: EvalResult,
  cx: Ctx,
  tag: string,
  fail: (prop: string, detail: string) => void
) {
  if (!fastOn() || !ghosts.length) return
  // a replica's held set is causally closed (O7-absent's need not be: it may remove an X event a kept pair cites)
  const held = new Set(ids)
  if (ids.some(id => cx.ev(id).ap.some(p => !held.has(p)))) return
  oracleStats.fastHeaderSets++
  let got: string
  try {
    got = evalSummary(fastEvaluate(ids, cx, ghosts))
  } catch (e) {
    got = `error ${(e as Error).message}`
  }
  if (got !== evalSummary(want)) {
    fastHeaderFail.last = { ids, ghosts, tag }
    fail('O13-fast', `${tag}: Eval of ${ids.length} events with ${ghosts.length} headers differs`)
  }
}

export type Fail = { prop: string; detail: string }

const live = (r: EvalResult, id: string) => !r.void.has(id)
// Written here again, independently of model.ts (and of its mutation hooks), so the oracles don't share its code.
const frontier = (o: string, d: string, cx: Ctx) =>
  o !== d && !cx.anc(d).has(o) && !(cx.anc(o).has(d) && cx.rec(o).local.eff.has(d))
// k* (§1.6): the author's rank in V_o(K) with the effective higher denies o did not see as effective applied
const kstar = (o: string, cx: Ctx, K: Set<string>, high: Set<string>): Rank =>
  cx.rec(o).cls === 'D'
    ? cx.rec(o).k
    : minR(
        cx.rec(o).k,
        rank(view(o, cx, K, [...high].filter(d => frontier(o, d, cx)).sort()), cx.ev(o).a)
      )
const isRev = (e: Ev) => e.t === 'device_revoke' || (e.t as string) === 'primary_rotate'
const isWithdrawal = (e: Ev) => e.t === 'uninvite' || e.t === 'code_revoke'
/**
 * exposed(p, γ) (§3.1), written independently: the author of p is not protected against cause γ at stratum kk in V_γ.
 * Revocations and non-join operations: exposed unless ranked strictly above kk. A join (it creates a membership) is
 * exposed only if ranked strictly below kk, and to a withdrawal only if the withdrawer also held Kick in St(γ).
 */
function exposedP(p: Ev, g: Ev, cx: Ctx, V: Facts, kk: Rank) {
  if (V.owners.has(p.a)) return false
  const r = rank(V, p.a)
  if (isRev(g)) return !gt(r, kk)
  if (p.t === 'join') {
    if (isWithdrawal(g) && !(perms(cx.rec(g.id).local.facts, g.a) & KICK)) return false
    return cmp(r, kk) < 0
  }
  return !gt(r, kk)
}
/** Evidence pairs (device and identity) of the set `ids` in its state `st`: they define F and FI, so they are never dropped. */
function evidencePairs(ids: string[], st: EvalResult, cx: Ctx): Set<string> {
  const pairs = new Set<string>()
  for (const [dev, f] of st.F) {
    for (const id of ids) if (cx.ev(id).dev === dev && cx.ev(id).seq === f) pairs.add(id)
    const byAprev = new Map<string, string[]>()
    for (const id of ids)
      if (cx.ev(id).dev === dev) {
        const key = cx.ev(id).aprev ?? ''
        if (!byAprev.has(key)) byAprev.set(key, [])
        byAprev.get(key)!.push(id)
      }
    for (const g of byAprev.values()) if (g.length > 1) for (const x of g) pairs.add(x)
  }
  for (const [key, d] of st.FI) {
    if (!(d < Infinity)) continue
    const bar = key.lastIndexOf('|')
    const ik = bar >= 0 ? key.slice(0, bar) : key
    for (const id of ids) if (cx.ev(id).a === ik && cx.rec(id).depth >= 0) pairs.add(id)
  }
  return pairs
}
/**
 * The orphan rule of §2.3 (revision 5, dispatch 5b, [H17]) applied to the held set `ids` (state `st`) until nothing
 * more can go: X events with no held descendant, other than the genesis, upgrades and proofs, whose drop leaves the structural
 * evidence of the held set unchanged: FI, and the contested identity ops (rotation evidence) among the held events.
 * `ghosts` are the replica's earlier drops whose headers it keeps. Candidates are tried in descending id order, so each
 * group that defines FI or a rotation fork keeps its lowest ids, and an event dropped at one point of a replica's
 * history stays droppable later (new members of a group can only have lower ids or more).
 * Revision 7 (controller ruling on r6.1, C1 option 2): pool candidacy is not monotone (only events before their device's
 * fork point count in P), so an event that is a candidate only by pool evidence is never dropped (mutant `pool-drop`).
 * An event past its device's fork point that is not an identity op is dropped without its header (only its id stays;
 * `bare` collects them) when F is unchanged without the header, i.e. it is not needed for a pair defining F(dev): it
 * counts in no P and is no other evidence (mutant `keep-headers` keeps every header). An identity op keeps its header:
 * a later rotation concurrent with it, or a later sibling over its iprev, needs it as rotation, race or identity
 * evidence (mutant `bare-idops`, vector "r7: a dropped identity op keeps its header"), and so does an event that a kept
 * header has in its past (a header's place in the causal order is known only through its ap; mutant `fast-bare-anc`).
 * Returns the dropped ids. Dispatch 5a's rule (X events past F(dev), no identity ops, outside the pairs defining F) is
 * the special case without identity ops; mutant `orphan-5a` restores it.
 */
export function orphanDrops(
  ids: string[],
  st: EvalResult,
  cx: Ctx,
  ghosts: string[] = [],
  bare?: Set<string>
): Set<string> {
  const out = new Set<string>()
  const gone = new Set<string>() // dropped here without a header
  if (!st.X.size) return out
  const fp = (E: string[], G: string[]) => forkPoints(E, cx, G)
  const full = fp(ids, ghosts)
  // [H19]: FI of an epoch whose rotation is contested (in RF) has no effect: every identity op of that epoch is
  // contested, so a candidate whatever FI says, and RF only grows; such entries need not be preserved (mutant fi-all)
  const liveKey = (k: string) => {
    const ep = k.slice(k.indexOf('|') + 1)
    return MUT === 'fi-all' || ep === '' || !full.RF.has(ep)
  }
  const keyFI = (m: Map<string, number>) =>
    [...m]
      .filter(([k]) => liveKey(k))
      .sort()
      .join(';')
  const keyF = (m: Map<string, number>) => [...m].sort().join(';')
  const fiFull = keyFI(full.FI),
    fFull = keyF(full.F)
  let kept = [...ids]
  const cands = [...st.X]
    .filter(x => ids.includes(x))
    .sort()
    .reverse()
  const hdrs = () => [...ghosts, ...[...out].filter(x => !gone.has(x))]
  for (let changed = true; changed;) {
    changed = false
    for (const id of cands) {
      if (out.has(id)) continue
      const e = cx.ev(id)
      // revision 6 (controller, from the production port): a `proof` is never dropped either: its content can be the
      // only evidence of a fork point, so dropping it would change F. The model has no proof events (§7.7), so this is inert here
      if (e.t === 'upgrade' || e.t === 'genesis' || (e.t as string) === 'proof') continue
      if (MUT === 'orphan-5a' && (cx.rec(id).depth >= 0 || e.seq < (st.F.get(e.dev) ?? Infinity)))
        continue
      // revision 7: a candidate only by pool evidence stays stored
      if (MUT !== 'pool-drop' && !candidate(id, cx, st.F, st.FI, st.X, st.RF)) continue
      if (kept.some(x => x !== id && cx.anc(x).has(id))) continue
      const rest = kept.filter(x => x !== id)
      const h = hdrs()
      const f2 = fp(rest, [...h, id])
      if (keyFI(f2.FI) !== fiFull) continue
      if (
        [...full.RF].some(x => x !== id && rest.includes(x) && !f2.RF.has(x)) ||
        [...f2.RF].some(x => !full.RF.has(x))
      )
        continue
      kept = rest
      out.add(id)
      changed = true
      // revision 7: without its header, if it is past its device's fork point, not an identity op (unless bare-idops),
      // and F, FI and the contested ops of the held events stay as they are
      if (
        MUT === 'keep-headers' ||
        e.seq < (full.F.get(e.dev) ?? Infinity) ||
        (cx.rec(id).depth >= 0 && MUT !== 'bare-idops')
      )
        continue
      // a kept header's parents are held events or kept headers (a replica knows a header's place in the causal order
      // only through its ap): an event that a kept header has in its past keeps its header (mutant `fast-bare-anc`)
      if (MUT !== 'fast-bare-anc' && h.some(x => cx.anc(x).has(id))) continue
      const f3 = fp(rest, h)
      if (keyF(f3.F) !== fFull || keyFI(f3.FI) !== fiFull) continue
      if (
        [...full.RF].some(x => rest.includes(x) && !f3.RF.has(x)) ||
        [...f3.RF].some(x => !full.RF.has(x))
      )
        continue
      gone.add(id)
    }
  }
  if (bare) for (const x of gone) bare.add(x)
  return out
}
/** Devices an in-force primary_rotate drops (§3.9), written independently of model.ts. */
function droppedP(r: Ev, order: string[], cx: Ctx): Set<string> {
  const keep = new Set<string>([r.dev, ...((r.c?.keep ?? []) as string[])])
  const out = new Set<string>()
  for (const id of order) {
    const x = cx.ev(id)
    if (id === r.id || x.a !== r.a || cx.anc(id).has(r.id)) continue
    const intro =
      x.t === 'genesis' || x.t === 'join' || x.t === 'device_add'
        ? [x.dev]
        : (x.t as string) === 'primary_rotate'
          ? [x.dev, ...((x.c?.keep ?? []) as string[])]
          : []
    for (const v of intro) if (!keep.has(v)) out.add(v)
  }
  return out
}

export function checkCase(
  cs: Case,
  o: { prefix?: boolean; replicas?: number; admissionSamples?: number } = {}
): Fail[] {
  const { w } = cs
  const fails: Fail[] = []
  const fail = (prop: string, detail: string) => fails.push({ prop, detail })
  const rng = new Rng(cs.seed * 7919 + 13)
  const ref = w.ref
  const order = ref.order
  const final = ref.state()
  const sum = evalSummary(final)
  // O5-worlds (revision 7c, §3.1.1): in the exact branch of a stratum whose flat closure holds no X op, no op is tested
  // in more than 2^classes + 1 worlds projected onto G(q). Counted over every evaluation this check makes (one fresh here)
  const wo0 = stats.worldsOverClean
  evaluate(order, ref)
  const k = (id: string) => ref.rec(id).k
  const isD = (id: string) => ref.rec(id).cls === 'D'
  const fixed = (id: string) =>
    ref.ev(id).t === 'genesis' ||
    ref.ev(id).t === 'device_revoke' ||
    (ref.ev(id).t as string) === 'primary_rotate'

  // O1-iteration: Eval is a function of the set (shuffled iteration order), checked in every case.
  for (let i = 0; i < 2; i++) {
    const s2 = evalSummary(evaluate(rng.shuffle(order), ref))
    if (s2 !== sum) fail('O1-iteration', `shuffle ${i}`)
  }

  // O9-prune: the step-3 pre-filter of model.ts (touches) never changes the result
  if (evalSummary(evaluate(order, ref, { prune: false })) !== sum)
    fail('O9-prune', 'evaluate() differs without the step-3 pre-filter')

  // O1 convergence: replicas with different delivery orders, partitions and duplicates
  const nrep = o.replicas ?? 2
  for (let i = 0; i < nrep; i++) {
    const r = new Replica()
    let evs = rng.shuffle(w.all)
    if (i === 1) {
      const cutAt = rng.int(evs.length + 1)
      evs = [
        ...evs.slice(0, cutAt),
        ...rng.shuffle(evs.slice(0, cutAt)).slice(0, 3),
        ...rng.shuffle(evs.slice(cutAt)),
      ]
    }
    for (const e of evs) r.receive(e)
    for (const e of w.all) {
      const a = JSON.stringify(ref.status.get(e.id)),
        b = JSON.stringify(r.status.get(e.id))
      if (a !== b) fail('O1-verdict', `${e.id}: ${a} vs ${b}`)
    }
    if (evalSummary(r.state()) !== sum) fail('O1-state', `replica ${i}`)
  }

  // O2 admission determinism: holding exactly C(ap) gives the same verdict; a missing ancestor gives Pending
  const samples = o.admissionSamples ?? 3
  const cands = w.all.filter(e => e.t !== 'genesis')
  const byId = new Map(w.all.map(e => [e.id, e]))
  for (let i = 0; i < samples && cands.length; i++) {
    const e = rng.pick(cands)
    // C(ap) through ap links, also through rejected events (whose causal past the reference doesn't record)
    const C = new Set<string>()
    const stack = [...e.ap]
    while (stack.length) {
      const p = stack.pop()!
      if (C.has(p)) continue
      C.add(p)
      const pe = byId.get(p)
      if (pe) stack.push(...pe.ap)
    }
    const evsC = w.all.filter(x => C.has(x.id))
    const r = new Replica()
    for (const x of rng.shuffle(evsC)) r.receive(x)
    r.receive(e)
    const a = JSON.stringify(ref.status.get(e.id)),
      b = JSON.stringify(r.status.get(e.id))
    if (a !== b) fail('O2-pure', `${e.id}: ${a} vs ${b}`)
    const ancs = [...C].filter(x => ref.status.get(x)?.s === 'A' && ref.ev(x).t !== 'genesis')
    if (ancs.length && !e.ap.some(p => ref.status.get(p)?.s === 'R')) {
      const drop = rng.pick(ancs)
      const r2 = new Replica()
      for (const x of evsC) if (x.id !== drop && !ref.anc(x.id)?.has(drop)) r2.receive(x)
      r2.receive(e)
      if (r2.status.get(e.id)?.s !== 'P')
        fail('O2-pending', `${e.id} without ${drop}: ${JSON.stringify(r2.status.get(e.id))}`)
    }
  }

  // O4 no escalation, written against the final state (not the evaluator's loop): every event that is not deny-cut,
  // including X events (O7-shield: equivocation never shields from a deny), satisfies the frontier rule of every
  // effective deny it did not see as effective.
  const effAbove = (kk: Rank) =>
    new Set([...final.eff].filter(d => cmp(k(d), kk) > 0 || isRev(ref.ev(d))))
  const cutAbove = (kk: Rank) =>
    new Set([...final.cut.entries()].filter(([, s]) => cmp(s, kk) > 0).map(([id]) => id))
  const KfMemo = new Map<string, Set<string>>()
  const Kf = (kk: Rank) => {
    const key = `${kk[0]}/${kk[1]}`
    let v = KfMemo.get(key)
    if (!v) KfMemo.set(key, (v = cutAbove(kk)))
    return v
  }
  // in-force revocations and their watermarks, recomputed here: (revocation, device, seen)
  // revision 5, dispatch 5b ([H17]): a primary_rotate is in force only outside X (rotation evidence can put it there),
  // and it drops only devices that an event outside X introduced
  const revs = order.filter(
    r =>
      (ref.ev(r).t === 'device_revoke' || (ref.ev(r).t as string) === 'primary_rotate') &&
      !final.X.has(r)
  )
  const nonX = order.filter(x => !final.X.has(x))
  const marks: { r: string; dev: string; seen: number }[] = []
  for (const r of revs) {
    const re = ref.ev(r)
    if (re.t === 'device_revoke') marks.push({ r, dev: re.c.dev, seen: re.c.seen })
    else
      for (const v of droppedP(re, nonX, ref)) marks.push({ r, dev: v, seen: re.c.seen?.[v] ?? -1 })
  }
  const tailOfP = (id: string) =>
    marks.filter(m => m.dev === ref.ev(id).dev && ref.ev(id).seq > m.seen).map(m => m.r)
  // the monotone authority of revision 5 (model.ts authorizedIn): resources with the cuts and d, obstacles without d
  const authed = (oid: string, K: Set<string>, d?: string) => authorizedIn(oid, ref, K, [], d)
  for (const oid of order) {
    if (final.cut.has(oid) || fixed(oid)) continue
    const oe = ref.ev(oid)
    const tag = final.X.has(oid) ? 'O7-shield' : 'O4'
    if (!admissible(oe, ref.rec(oid).local.facts)) fail('O4-admission', oid)
    if (tailOfP(oid).length) fail('O4-tail', `${oid} of a revoked or dropped device survives`)
    for (const d of final.eff) {
      if (fixed(d) || !frontier(oid, d, ref)) continue
      const de = ref.ev(d),
        rd = ref.rec(d),
        kd = k(d)
      const K = Kf(kd)
      const ks = isD(oid) ? k(oid) : kstar(oid, ref, K, effAbove(kd))
      if (rd.self) {
        if (de.a !== oe.a || cmp(ks, kd) > 0 || (isD(oid) && ref.rec(oid).self)) continue
        if (!authed(oid, K, d) && authed(oid, K)) fail(`${tag}-self`, `${oid} survives ${d}`)
        continue
      }
      const tg = target(de, rd.local.facts)
      const below = cmp(ks, kd) < 0
      const same = cmp(ks, kd) <= 0 && !isD(oid) && tg.kind === 'member' && tg.who === oe.a
      if (!below && !same) continue
      const Sd = order.filter(x => !ref.anc(x).has(d))
      // the author's standing at oid: higher decisions made after oid are left out (§3.1 V_γ^p), except for the deny's
      // own target, judged in V_d like the deny's effectiveness
      const hi = new Set([...effAbove(kd)].filter(x => same || !ref.anc(x).has(oid)))
      const V = facts(Sd, new Set([...final.X, ...K, ...final.tail]), hi, ref, final.X)
      if (!exposedP(oe, de, ref, V, kd)) continue
      if (!authed(oid, K, d) && authed(oid, K)) fail(`${tag}-senior`, `${oid} survives ${d}`)
    }
  }
  // the winning position write was placed strictly below its writer's rank at the time
  for (const [R, p] of final.facts.pos) {
    if (!final.facts.roles.has(R)) continue
    const writers = order
      .filter(id => {
        const e = ref.ev(id)
        return (e.t === 'role_create' && id === R) || (e.t === 'role_move' && e.c.role === R)
      })
      .filter(id => live(final, id) || final.eff.has(id))
    if (!writers.some(id => gt(k(id), [p, R]))) fail('O4-pos', `${R}@${p}`)
  }
  for (const [T, rs] of final.facts.holds)
    for (const R of rs) {
      const ok = order.some(id => {
        const e = ref.ev(id)
        return e.t === 'assign' && e.c.to === T && e.c.role === R && e.a !== T && live(final, id)
      })
      if (!ok) fail('O4-holds', `${T}:${R}`)
    }

  // consistency: an effective deny is never void; every tail op is cut
  for (const d of final.eff) if (final.void.has(d)) fail('C-effvoid', d)
  for (const t of final.tail) if (!final.cut.has(t)) fail('C-tail', t)
  for (const id of order)
    if (!fixed(id) && tailOfP(id).length && !final.tail.has(id))
      fail('C-tail', `${id} missing from Tail`)

  // O5-exact, O5-safe, O5-complete (G5 inside a stratum; [R3V C1], [R3V M1]): the exact exponential oracle of
  // oracle.ts, written independently of model.ts's step 4, on every stratum with at most ORACLE_BOUND causes.
  {
    hullCheck.on = true
    hullLog.length = 0
    const r = g5Oracle(ref, order, final, ORACLE_BOUND)
    hullCheck.on = false
    // O5-hull: the polynomial position hull (model.ts posHull) equals its definition, the min or max over all subsets
    for (const h of hullLog) {
      oracleStats.hulls++
      const want = posHullBrute(h.L, h.V, h.dir, h.cx)
      if (want !== h.got)
        fail(
          'O5-hull',
          `${h.dir} over [${h.L.map(w => w.id)}] removable [${[...h.V]}]: ${h.got} vs ${want}`
        )
    }
    hullLog.length = 0
    for (const f of r.fails) fail(f.prop, f.detail)
    oracleStats.cases++
    oracleStats.strata += r.strata
    oracleStats.checked += r.checked
    oracleStats.skipped += r.skipped
    oracleStats.maxCauses = Math.max(oracleStats.maxCauses, r.maxCauses)
    oracleStats.subsets += r.subsets
    oracleStats.fallback += r.fallback
    oracleStats.lazy += r.lazy
    oracleStats.monoTests += r.monoTests
    oracleStats.workFallback += r.workFallback
  }

  // O11 (§4.1, revision 4), rechecked independently for every admitted event: W3(a) per window, W3(b) per day for events
  // no other identity acknowledged within a window, W3(c) identity churn, W6 for rotations, W5. Exempt from W3(a)/(b): D
  // and S classes and upgrade, except a ban of a principal its causal past never saw join or be invited, and role_move.
  {
    const freeT = (t: string) =>
      t === 'genesis' ||
      t === 'upgrade' ||
      t === 'leave' ||
      t === 'device_revoke' ||
      t === 'primary_rotate'
    const knownIn = (B: Set<string>, T: string) =>
      [...B].some(x => {
        const xe = ref.ev(x)
        return (xe.t === 'join' && xe.a === T) || (xe.t === 'add' && xe.c?.to === T)
      })
    const exM = new Map<string, boolean>()
    const ex = (x: string) => {
      let v = exM.get(x)
      if (v === undefined) {
        const xe = ref.ev(x)
        v =
          xe.t === 'genesis' ||
          xe.t === 'upgrade' ||
          (ref.rec(x).cls === 'D' &&
            xe.t !== 'role_move' &&
            !(xe.t === 'ban' && !knownIn(ref.anc(x), xe.c.to)))
        exM.set(x, v)
      }
      return v
    }
    for (const id of order) {
      const e = ref.ev(id)
      if (e.t === 'genesis') continue
      const r = ref.rec(id),
        St = r.local.facts
      const B = [...ref.anc(id)]
      if (!ex(id)) {
        const cap = perms(St, e.a) & MODBITS ? LIM.w3mod : LIM.w3
        const mine = B.filter(x => ref.ev(x).dev === e.dev && !ex(x))
        if (mine.filter(x => ref.ev(x).ts > e.ts - LIM.win).length + 1 > cap) fail('O11-W3', id)
      }
      // W3(b) (revision 5, dispatch 5b): the device's events in B(e) other than leave, device_revoke, primary_rotate and
      // upgrade (so moderation too, [H18]) that no event of another identity in B(e) has in its past, plus e, ≤ totU,
      // whatever their ts
      if (!freeT(e.t)) {
        const unacked = B.filter(
          x =>
            ref.ev(x).dev === e.dev &&
            !freeT(ref.ev(x).t) &&
            !B.some(f => ref.ev(f).a !== e.a && ref.anc(f).has(x))
        )
        if (unacked.length + 1 > LIM.totU) fail('O11-total', id)
      }
      // W3(g) (revision 5, dispatch 5b-ii, [H20]): a non-owner's identity holds at most poolU events in B(e) ∪ {e} that
      // no event of another identity in B(e) has in its past, every kind except genesis, over all its devices
      if (!St.owners.has(e.a) && MUT !== 'pool-off' && MUT !== 'pool-cap-off') {
        const un = B.filter(
          x =>
            ref.ev(x).a === e.a &&
            ref.ev(x).t !== 'genesis' &&
            !B.some(f => ref.ev(f).a !== e.a && ref.anc(f).has(x))
        )
        if (un.length + 1 > LIM.poolU) fail('O11-pool', id)
        // the recorded pool is U(e) as defined
        if ([...un, id].sort().join() !== (r.pool ?? []).join())
          fail('O11-pool', `${id}: recorded pool differs from U(e)`)
      }
      // W3(e) (revision 5, dispatch 5b, [H18]): a non-owner's join has a live add by an owner, or one that an event of a
      // third identity in B(e) has in its past while the add's device was not forked at it in that event's state
      if (e.t === 'join' && !St.owners.has(e.a)) {
        const inv = St.invited.get(e.a) ?? []
        const ok = inv.some(
          g =>
            St.owners.has(g.a) ||
            B.some(f => {
              const fe = ref.ev(f)
              if (fe.a === g.a || fe.a === e.a || !ref.anc(f).has(g.id)) return false
              // good faith: the add is not a structural candidate in St(f) (past its device's fork point, or on a device whose
              // every introduction is one), written here from St(f)'s F, FI and RF. r7b (reading confirmed): a pool candidacy
              // in St(f) is no fork evidence and can end (poolmono), so it does not block the vouch (vector "r7b: W3(e)")
              const ge = ref.ev(g.id),
                L = ref.rec(f).local
              const RFl = L.RF ?? new Set<string>()
              const candId = (x: string) => {
                const xe = ref.ev(x),
                  xr = ref.rec(x)
                if (xe.t === 'genesis') return false
                if ((xe.t as string) === 'primary_rotate') return RFl.has(x)
                return (
                  xe.seq >= (L.F.get(xe.dev) ?? Infinity) ||
                  xr.depth >= (L.FI.get(`${xe.a}|${xr.epoch}`) ?? Infinity) ||
                  RFl.has(x)
                )
              }
              if (ge.seq >= (L.F.get(ge.dev) ?? Infinity)) return false
              const intros = [...ref.anc(g.id)].filter(x => {
                const xe = ref.ev(x)
                if (ref.rec(x).depth < 0) return false
                const iv =
                  xe.t === 'genesis' || xe.t === 'join' || xe.t === 'device_add'
                    ? [xe.dev]
                    : (xe.t as string) === 'primary_rotate'
                      ? [xe.dev, ...((xe.c?.keep ?? []) as string[])]
                      : []
                return iv.includes(ge.dev)
              })
              return !(intros.length && intros.every(candId))
            })
        )
        if (!ok) fail('O11-vouch', id)
      }
      if (e.t === 'device_add' || (e.t as string) === 'primary_rotate') {
        // W3(c): device_adds per identity per day across epochs (revision 5), rotations per identity per day
        const same = B.filter(
          x => ref.ev(x).a === e.a && ref.ev(x).t === e.t && ref.ev(x).ts > e.ts - LIM.day
        )
        if (same.length + 1 > (e.t === 'device_add' ? LIM.idCap : LIM.rotCap)) fail('O11-churn', id)
        // W3(c) rotation total (revision 5, dispatch 5b): a non-owner's rotations in B(e) that no event of another
        // identity in B(e) has in its past, plus e, ≤ rotTot
        if (
          !St.owners.has(e.a) &&
          (e.t as string) === 'primary_rotate' &&
          B.filter(
            x =>
              ref.ev(x).a === e.a &&
              (ref.ev(x).t as string) === 'primary_rotate' &&
              !B.some(f => ref.ev(f).a !== e.a && ref.anc(f).has(x))
          ).length +
            1 >
            LIM.rotTot
        )
          fail('O11-total', `${id} (rotations)`)
        if (
          e.t === 'device_add' &&
          !St.owners.has(e.a) &&
          B.filter(
            x =>
              ref.ev(x).a === e.a &&
              ref.ev(x).t === 'device_add' &&
              !B.some(f => ref.ev(f).a !== e.a && ref.anc(f).has(x))
          ).length +
            1 >
            LIM.freshCap
        )
          fail('O11-fresh', `${id} (device_adds)`)
      }
      if ((e.t as string) === 'primary_rotate') {
        // W6: drops a live device, introduces its posting device, installs a new pcert, or recovers a forked/split epoch
        const liveD = St.devs.get(e.a) ?? new Set<string>()
        const keep = new Set<string>([e.dev, ...((e.c?.keep ?? []) as string[])])
        const rots = B.filter(
          x => ref.ev(x).a === e.a && (ref.ev(x).t as string) === 'primary_rotate'
        )
        const maxR = rots.filter(x => !rots.some(y => y !== x && ref.anc(y).has(x)))
        const pc = maxR.length === 1 ? String(ref.ev(maxR[0]).c?.pcert ?? '') : ''
        const forked =
          (r.local.FI.get(`${e.a}|${maxR.length === 1 ? maxR[0] : ''}`) ?? Infinity) < Infinity
        const changes =
          [...liveD].some(v => !keep.has(v)) ||
          !liveD.has(e.dev) ||
          String(e.c?.pcert ?? '') !== pc ||
          maxR.length > 1 ||
          forked
        if (!changes) fail('O11-W6', id)
      }
      if (e.t === 'role_create' && St.roles.size + 1 > LIM.roles) fail('O11-W5', id)
      if (
        e.t === 'add' &&
        [...St.pending.values()].flat().filter(p => p.dev === e.dev).length + 1 > LIM.pendingPerDev
      )
        fail('O11-W5', id)
      if (
        e.t === 'code' &&
        [...St.codes.values()].filter(c => c.dev === e.dev).length + 1 >
          (perms(St, e.a) & SERVER ? LIM.codesPerDevServer : LIM.codesPerDev)
      )
        fail('O11-W5', id)
      // O12: after an upgrade only leave; every upgrade countersigned by every other genesis owner
      if (St.upgraded.length && e.t !== 'leave') fail('O12-frozen', id)
      if (
        e.t === 'upgrade' &&
        ![...St.owners].every(o => o === e.a || (e.c.sigs ?? []).includes(o))
      )
        fail('O12-sigs', id)
    }
    // moderation of members and leaving are never refused by the hourly window or W5; leaving and revocations are never
    // refused by W3(b) either, moderation only when the device has totU unacknowledged counted events in B(e)
    // (revision 5, dispatch 5b, [H18]): a refused exempt deny is a failure otherwise
    for (const e of w.all) {
      const st = ref.status.get(e.id)
      if (st?.s !== 'R' || !['W3', 'W3b', 'W5'].includes(st.why)) continue
      const ok =
        [
          'kick',
          'uninvite',
          'leave',
          'revoke',
          'device_revoke',
          'code_revoke',
          'role_del',
        ].includes(e.t) ||
        (e.t === 'ban' && knownIn(w.closure(e.ap), e.c.to))
      if (ok && st.why === 'W3b' && !freeT(e.t)) {
        const Bc = [...w.closure(e.ap)]
        const unacked = Bc.filter(
          x =>
            ref.ev(x).dev === e.dev &&
            !freeT(ref.ev(x).t) &&
            !Bc.some(f => ref.ev(f).a !== e.a && ref.anc(f).has(x))
        )
        if (unacked.length + 1 > LIM.totU) continue
      }
      if (ok) fail('O11-exempt', `${e.id} refused (${st.why})`)
    }
  }
  // O11-cap (I4): each device chain stays within a global cap on its own, so live roles ≤ cap × (chain heads creating roles)
  {
    const creates = order.filter(id => ref.ev(id).t === 'role_create' && final.facts.roles.has(id))
    const heads = creates.filter(
      c => !creates.some(d => d !== c && ref.ev(d).dev === ref.ev(c).dev && ref.anc(d).has(c))
    )
    // a deletion that made room in some creator's view and is later cut or ineffective revives its role (seed 59711)
    const undone = order.filter(id => ref.ev(id).t === 'role_del' && !final.eff.has(id)).length
    if (final.facts.roles.size > LIM.roles * Math.max(1, heads.length) + undone)
      fail('O11-cap', `${final.facts.roles.size} roles`)
  }
  // O17-recover (C3): an identity fork never blocks a device revocation or a rotation
  for (const e of w.all) {
    if (!isRev(e)) continue
    const st = ref.status.get(e.id)
    if (st?.s === 'R' && st.why === 'identity-forked') fail('O17-recover', e.id)
  }
  // O18-code (I1): a live code dies by revocation only through a code_revoke naming it, by its issuer or by someone with
  // ManageServer ranked above the issuer in the revoke's admission state; holding its hash gives nothing.
  {
    const liveIds = new Set([...final.facts.codes.values()].map(c => c.id))
    for (const c of order) {
      const ce = ref.ev(c)
      if (ce.t !== 'code' || final.void.has(c) || liveIds.has(c)) continue
      if (!final.facts.mem.has(ce.a) || !(perms(final.facts, ce.a) & INVITE)) continue
      const sticky = order.some(
        x =>
          !final.void.has(x) &&
          ref.anc(x).has(c) &&
          (!ref.rec(x).local.facts.mem.has(ce.a) || !(perms(ref.rec(x).local.facts, ce.a) & INVITE))
      )
      if (sticky) continue
      const ok = [...final.eff].some(r => {
        const re = ref.ev(r)
        if (re.t !== 'code_revoke' || re.c.code !== c) return false
        const St = ref.rec(r).local.facts
        return (
          re.a === ce.a || ((perms(St, re.a) & SERVER) !== 0 && gt(rank(St, re.a), rank(St, ce.a)))
        )
      })
      if (!ok) fail('O18-code', `${c} died without a valid revocation`)
    }
  }

  // O6 ban permanence (final): an unlifted effective ban keeps T out, and no join of T that did not see it is live
  for (const b of final.eff) {
    const be = ref.ev(b)
    if (be.t !== 'ban') continue
    const T = be.c.to
    const lifted = order.some(u => {
      const ue = ref.ev(u)
      return (
        ue.t === 'unban' &&
        ue.c.to === T &&
        live(final, u) &&
        ref.anc(u).has(b) &&
        cmp(k(u), k(b)) >= 0
      )
    })
    if (lifted) continue
    if (!final.facts.ban.has(T) || final.facts.mem.has(T)) fail('O6-ban', `${T} by ${b}`)
    // r7b (seed 8868407): a ban of a member takes effect unless V_b ranks the target strictly above k(b), and the target's
    // racing join is exposed only strictly below it (§3.1 exposed, [R2V C2]); a target ranked exactly k(b) there (a duel)
    // keeps its racing join, which can never give membership either (Mem needs every effective ban in the join's past)
    let duel: boolean | undefined
    const isDuel = () => {
      if (duel === undefined) {
        const kb = k(b),
          Sb = order.filter(x => !ref.anc(x).has(b))
        const Vb = facts(
          Sb,
          new Set([...final.X, ...Kf(kb), ...final.tail]),
          effAbove(kb),
          ref,
          final.X
        )
        duel = ref.rec(b).local.facts.mem.has(T) && !Vb.owners.has(T) && cmp(rank(Vb, T), kb) === 0
      }
      return duel
    }
    for (const j of order) {
      const je = ref.ev(j)
      // a join already broken by a cut above the ban's stratum (kept by protection there) is not cut again ("newly
      // broken"); it can never give membership, since Mem needs every effective ban in the join's past (seed 70137)
      if (
        je.t === 'join' &&
        je.a === T &&
        live(final, j) &&
        frontier(j, b, ref) &&
        authorizedIn(j, ref, Kf(k(b))) &&
        !isDuel()
      )
        fail('O6-join', `${j} vs ${b}`)
    }
  }

  // O7 equivocation containment
  if (!cs.equivocation && final.X.size) fail('O7-honest', `X=${[...final.X]}`)
  {
    // evidence pairs (device and identity): they define F and FI, so they are never dropped
    const pairs = evidencePairs(order, final, ref)
    // O7-absent: X events outside the evidence pairs that no non-X event depends on have no effect at all.
    const xt = new Set(
      [...final.X].filter(
        x =>
          ref.ev(x).t !== 'upgrade' &&
          !pairs.has(x) &&
          !order.some(y => !final.X.has(y) && ref.anc(y).has(x))
      )
    )
    if (xt.size) {
      const rest = order.filter(id => !xt.has(id))
      // [H20]: an X event still counts in its identity's pool (§2.3 pool evidence), as a header does; it is removed with
      // its header kept, and must have no other effect
      const r2 = evaluate(rest, ref, { ghosts: [...xt] })
      fastHeaders(rest, [...xt], r2, ref, 'O7-absent', fail)
      const strip = (r: EvalResult) =>
        evalSummary({
          ...r,
          X: new Set([...r.X].filter(x => !xt.has(x))),
          tail: new Set([...r.tail].filter(x => !final.X.has(x))),
          // the cut status of an X event is observable only through non-X descendants, so it is compared for non-X events
          cut: new Map([...r.cut].filter(([id]) => !final.X.has(id))),
          eff: new Set([...r.eff].filter(id => !xt.has(id))),
        } as EvalResult)
      if (strip(final) !== strip(r2))
        fail('O7-absent', `Eval(S) != Eval(S \\ Xtail) (${xt.size} dropped)`)
    }
    // O7-orphan: X events without descendants whose drop leaves FI and the contested identity ops unchanged may be
    // dropped, their headers kept as device evidence (revision 5, dispatch 5b, [H17])
    // revision 7: events past their device's fork point that are not identity ops go without their headers (`bareFinal`)
    const bareFinal = new Set<string>()
    const dropsFinal = orphanDrops(order, final, ref, [], bareFinal)
    const hdrFinal = [...dropsFinal].filter(x => !bareFinal.has(x))
    const kept = order.filter(id => !dropsFinal.has(id))
    if (kept.length < order.length) {
      oracleStats.finalDrops += dropsFinal.size
      oracleStats.bareDrops += bareFinal.size
      for (const x of dropsFinal) if (ref.rec(x).depth >= 0) oracleStats.idDrops++
      const r3 = evaluate(kept, ref, { ghosts: hdrFinal })
      fastHeaders(kept, hdrFinal, r3, ref, 'O7-orphan', fail)
      const keptSet = new Set(kept)
      const restrict = (r: EvalResult) =>
        evalSummary({
          ...r,
          X: new Set([...r.X].filter(x => keptSet.has(x))),
          tail: new Set([...r.tail].filter(x => keptSet.has(x) && !final.X.has(x))),
          cut: new Map([...r.cut].filter(([id]) => keptSet.has(id) && !final.X.has(id))),
          eff: new Set([...r.eff].filter(id => keptSet.has(id))),
        } as EvalResult)
      if (restrict(final) !== restrict(r3))
        fail('O7-orphan', `dropped ${order.length - kept.length}`)
    }
    // O11-growth (revision 7, spec §4.1 growth bound, restated for the controller's ruling on r6.1): pool candidates stay
    // stored, so a removed identity is bounded per device chain, and the kept headers are counted. For every non-owner
    // identity, over its events that the final orphan drop keeps (stored) or keeps as headers, "unacknowledged" meaning
    // that no event of another identity has them in its past:
    // (a) every maximal stored unacknowledged event is no structural candidate (a candidate only by pool evidence or
    //     none): the orphan rule dropped the others; at most one per device chain, plus one rotation;
    // (b) every stored unacknowledged event lies in the recorded pool U(m) of a maximal one, so the stored ones are at
    //     most the sum of those pools (each at most poolU by W3(g));
    // (c) per device chain, its counted unacknowledged events before its fork point, stored or as headers, are at most
    //     totU (one chain; W3(b) at its last event);
    // (d) per device chain, at most 2 kept headers at or past its fork point that are not identity ops and that no kept
    //     header or stored event of another device chain has in its past (the pair defining F; the others go without
    //     their headers, §2.3, except a branch another chain holds, which W3(f) and W3(b) bound by one per holding chain).
    //     r7b (seed 10016903): nor a kept identity-op header of the same chain: identity ops keep their headers and so do
    //     the events below a kept header (r7.2, ruled), so the branch under it keeps its headers; W3(b) bounds its counted
    //     events (totU per branch); measured (maxBelowId).
    // Identity ops keep their headers (r7: needed as later identity, race or rotation evidence); measured, not bounded.
    {
      const hdrSet = new Set(hdrFinal)
      const ackd = (id: string) =>
        order.some(f => ref.ev(f).a !== ref.ev(id).a && ref.anc(f).has(id))
      const structural = (id: string) => candidate(id, ref, final.F, final.FI, final.X, final.RF)
      // held up by another device chain: a kept header or a stored event on another device has it in its past
      const keptOther = (id: string) =>
        [...hdrFinal, ...kept].some(x => ref.ev(x).dev !== ref.ev(id).dev && ref.anc(x).has(id))
      const keptIdSame = (id: string) =>
        hdrFinal.some(
          x =>
            x !== id &&
            ref.ev(x).dev === ref.ev(id).dev &&
            ref.rec(x).depth >= 0 &&
            ref.anc(x).has(id)
        )
      const byA = new Map<string, string[]>(),
        hdrA = new Map<string, string[]>()
      for (const id of order) {
        const e = ref.ev(id)
        if (e.t === 'genesis' || final.facts.owners.has(e.a) || bareFinal.has(id)) continue
        if (ackd(id)) continue
        const m = hdrSet.has(id) ? hdrA : dropsFinal.has(id) ? undefined : byA
        if (!m) continue
        if (!m.has(e.a)) m.set(e.a, [])
        m.get(e.a)!.push(id)
      }
      for (const a of new Set([...byA.keys(), ...hdrA.keys()])) {
        const st = byA.get(a) ?? [],
          hd = hdrA.get(a) ?? []
        const stSet = new Set(st)
        const max = st.filter(x => !st.some(y => y !== x && ref.anc(y).has(x)))
        for (const m of max)
          if (structural(m))
            fail('O11-growth', `${a}: maximal stored unacknowledged ${m} is a structural candidate`)
        const perDev = new Map<string, number>()
        for (const m of max)
          if (ref.ev(m).t !== 'primary_rotate')
            perDev.set(ref.ev(m).dev, (perDev.get(ref.ev(m).dev) ?? 0) + 1)
        for (const [v, n] of perDev)
          if (n > 1) fail('O11-growth', `${a}: ${n} maximal stored events on ${v}`)
        if (max.filter(m => ref.ev(m).t === 'primary_rotate').length > 1)
          fail('O11-growth', `${a}: two maximal stored rotations`)
        const cover = new Set<string>()
        for (const m of max) for (const z of ref.rec(m).pool ?? [m]) if (stSet.has(z)) cover.add(z)
        if (cover.size < st.length)
          fail(
            'O11-growth',
            `${a}: ${st.length - cover.size} stored events outside the pools of the maximal ones`
          )
        const pre = new Map<string, number>(),
          past = new Map<string, number>(),
          belowId = new Map<string, number>(),
          devs = new Set<string>()
        for (const id of [...st, ...hd]) {
          const e = ref.ev(id),
            Fv = final.F.get(e.dev) ?? Infinity
          devs.add(e.dev)
          if (e.seq < Fv) {
            if (totCounted(e)) pre.set(e.dev, (pre.get(e.dev) ?? 0) + 1)
          } else if (hdrSet.has(id) && ref.rec(id).depth < 0 && !keptOther(id)) {
            if (keptIdSame(id)) belowId.set(e.dev, (belowId.get(e.dev) ?? 0) + 1)
            else past.set(e.dev, (past.get(e.dev) ?? 0) + 1)
          }
        }
        for (const [v, n] of pre)
          if (n > LIM.totU)
            fail(
              'O11-growth',
              `${a}: ${n} unacknowledged counted events before F(${v}), stored or as headers`
            )
        for (const [v, n] of past)
          if (n > 2) fail('O11-growth', `${a}: ${n} kept headers past F(${v})`)
        for (const n of belowId.values())
          oracleStats.maxBelowId = Math.max(oracleStats.maxBelowId, n)
        const idH = hd.filter(x => ref.rec(x).depth >= 0).length
        oracleStats.maxStoredHeaders = Math.max(oracleStats.maxStoredHeaders, st.length + hd.length)
        oracleStats.maxIdHeaders = Math.max(oracleStats.maxIdHeaders, idH)
        oracleStats.maxPerDevice = Math.max(
          oracleStats.maxPerDevice,
          Math.ceil((st.length + hd.length - idH) / Math.max(1, devs.size))
        )
        if (st.length + hd.length > LIM.poolU) oracleStats.headerOver++
      }
      if (final.PC?.size) oracleStats.pcCases++
      if (final.RF?.size) oracleStats.rfCases++
    }
    // O7-taildrop ([R4V C2]): a Tail event with no descendant, outside the evidence pairs, that is not an identity op or
    // an upgrade, and is past the watermark of a clean revocation record of its device, is inert in S: it never witnesses
    // (§2.3 clean witness), so Eval of the rest is unchanged without it. (Revision 4's §4.2 dropped such events; revision 5
    // keeps them stored, because a later sibling or a revocation that falls into X can change their role.) Clean records,
    // written here independently: a primary_rotate without rotation evidence, or a device_revoke before its own device's
    // fork point whose device an identity op introduced cleanly (an uncontested rotation, or an uncontested op at depth
    // below its epoch's FI). Revision 5, dispatch 5b ([H17]): a contested rotation (RF) is not clean, and a rotation's
    // drops count only for devices that a non-candidate identity op introduced.
    const fiP = (a: string, ep: string) => final.FI.get(`${a}|${ep}`) ?? Infinity
    const RFp = final.RF ?? new Set<string>(),
      PCp = final.PC ?? new Set<string>()
    const nonCandP = order.filter(x => {
      const xr = ref.rec(x)
      return !(
        xr.depth >= 0 &&
        (RFp.has(x) ||
          PCp.has(x) ||
          ((ref.ev(x).t as string) !== 'primary_rotate' && xr.depth >= fiP(ref.ev(x).a, xr.epoch)))
      )
    })
    const recCleanP = (r: Ev) =>
      ((r.t as string) === 'primary_rotate' && !RFp.has(r.id)) ||
      (r.t === 'device_revoke' &&
        r.seq < (final.F.get(r.dev) ?? Infinity) &&
        !PCp.has(r.id) &&
        [r.id, ...ref.anc(r.id)].some(x => {
          const xe = ref.ev(x),
            xr = ref.rec(x)
          if (xr.depth < 0 || xe.a !== r.a) return false
          const intro =
            xe.t === 'genesis' || xe.t === 'join' || xe.t === 'device_add'
              ? [xe.dev]
              : (xe.t as string) === 'primary_rotate'
                ? [xe.dev, ...((xe.c?.keep ?? []) as string[])]
                : []
          return (
            intro.includes(r.dev) &&
            !RFp.has(x) &&
            !PCp.has(x) &&
            ((xe.t as string) === 'primary_rotate' || xr.depth < fiP(xe.a, xr.epoch))
          )
        }))
    const pastClean = (id: string) => {
      const t = ref.ev(id)
      return order.some(rid => {
        const r = ref.ev(rid)
        if (r.t === 'device_revoke')
          return (
            r.c?.dev === t.dev &&
            t.seq > (typeof r.c.seen === 'number' ? r.c.seen : -1) &&
            recCleanP(r)
          )
        if ((r.t as string) === 'primary_rotate')
          return (
            !RFp.has(rid) &&
            droppedP(r, nonCandP, ref).has(t.dev) &&
            t.seq > ((r.c?.seen?.[t.dev] ?? -1) as number)
          )
        return false
      })
    }
    // O7-cleanrec: a clean revocation record is never void, so the witness watermark never reads an X event
    for (const id of order)
      if (ref.ev(id).t === 'device_revoke' && recCleanP(ref.ev(id)) && final.X.has(id))
        fail('O7-cleanrec', id)
    const td = new Set(
      [...final.tail].filter(
        id =>
          !pairs.has(id) &&
          ref.ev(id).t !== 'upgrade' &&
          ref.rec(id).depth < 0 &&
          !order.some(x => ref.anc(x).has(id)) &&
          pastClean(id)
      )
    )
    if (td.size) {
      oracleStats.tailDrops += td.size
      const rest = order.filter(id => !td.has(id))
      // [H20]: a tail event still counts in its identity's pool, so it is removed with its header kept (as the orphan
      // rule keeps one); what this checks is that it has no other effect
      const r4 = evaluate(rest, ref, { ghosts: [...td] })
      fastHeaders(rest, [...td], r4, ref, 'O7-taildrop', fail)
      const keep = (r: EvalResult) =>
        evalSummary({
          ...r,
          X: new Set([...r.X].filter(x => !td.has(x))),
          tail: new Set([...r.tail].filter(x => !td.has(x))),
          cut: new Map([...r.cut].filter(([id]) => !td.has(id))),
          eff: new Set([...r.eff].filter(id => !td.has(id))),
        } as EvalResult)
      if (keep(final) !== keep(r4))
        fail(
          'O7-taildrop',
          `Eval(S) != Eval(S \\ tail) (${td.size} tail events without descendants)`
        )
    }
  }

  // Prefix properties: O3 monotone revocation, O5 seniority, O6 incremental ban permanence, O7 X growth
  if (o.prefix !== false) {
    let prev: EvalResult | undefined
    // O7-orphan-stable ([R4V C2]): every event the orphan rule lets a replica drop at some point of its history (here the
    // prefixes of the admission order) and that nothing cites later is still droppable in the final set, and dropping all
    // of them leaves Eval of the rest unchanged (a cited one is re-fetched, §2.3, so it is held again)
    const everDropped = new Set<string>(),
      everBare = new Set<string>()
    for (let i = 1; i <= order.length; i++) {
      const cur = ref.evalSet(order.slice(0, i))
      if (cur.X.size) {
        // a replica holding this prefix has already dropped the earlier drops that nothing cited since
        const pre = order.slice(0, i),
          cited = (x: string) => pre.some(y => ref.anc(y).has(x))
        const prev0 = [...everDropped].filter(x => !cited(x))
        const prevH = prev0.filter(x => !everBare.has(x)) // the headers it keeps (revision 7)
        const heldNow = pre.filter(x => !prev0.includes(x))
        if (prev0.length) {
          const curD = evaluate(heldNow, ref, { ghosts: prevH })
          fastHeaders(heldNow, prevH, curD, ref, 'O7-orphan-stable (prefix)', fail)
          for (const x of orphanDrops(heldNow, curD, ref, prevH, everBare)) everDropped.add(x)
        } else for (const x of orphanDrops(pre, cur, ref, [], everBare)) everDropped.add(x)
      }
      if (prev) {
        const eid = order[i - 1]
        const e = ref.ev(eid)
        const old = order.slice(0, i - 1)
        // A device revocation acts on its identity's own device at the revoked ops' strata (§3.1 step 0): for these
        // properties it counts at the highest stratum among the ops it newly puts in the tail.
        let ke = k(eid)
        for (const t of cur.tail) if (!prev.tail.has(t) && cmp(k(t), ke) > 0) ke = k(t)
        // a join is judged at the rank it confers (⊥): it can beat an equal-rank deny made against its author as a
        // non-member (§3.1 protectedTarget, [R2V C2]; seed 12087 in §7.7)
        if (e.t === 'join' && cmp(ke, BOT) < 0) ke = BOT
        const xchanged = old.some(id => prev!.X.has(id) !== cur.X.has(id))
        if (xchanged) {
          // O7-growth: only events of the new event's identity, or of devices/identities already forked, enter X
          for (const id of old) {
            const x = ref.ev(id)
            // revision 5, dispatch 5b-ii: an identity is also already forked when it has contested identity ops ([H17],
            // [H19]) or pool candidates ([H20]) in the prefix (candidacy by RF or the pool was never generated before)
            const already =
              (prev.F.get(x.dev) ?? Infinity) < Infinity ||
              [...prev.FI.entries()].some(
                ([key, d]) => d < Infinity && (key === x.a || key.startsWith(`${x.a}|`))
              ) ||
              [...(prev.RF ?? [])].some(r => ref.ev(r).a === x.a) ||
              [...(prev.PC ?? [])].some(r => ref.ev(r).a === x.a)
            if (!prev.X.has(id) && cur.X.has(id) && x.a !== e.a && !already)
              fail('O7-growth', `${eid} put ${id} in X`)
          }
        } else {
          const prevAbove = new Set(
            [...prev.cut.entries()].filter(([, s]) => cmp(s, ke) > 0).map(([id]) => id)
          )
          const prevHigh = new Set([...prev.eff].filter(d => cmp(k(d), ke) > 0 || isRev(ref.ev(d))))
          // denies that this step made live and effective again (a revival O3-revive governs: a senior grant that protects
          // a deny's author against the cause that had cut it, G5). Their cascade may cut at their own stratum or below
          // even when the new event is a grant (seed 2074807, §7.7: the owner's promotion of A, concurrent with B's
          // demotion of A's role, revives A's kick of U, which then cuts U's concurrent invite chain).
          const revived = old.filter(
            d => isD(d) && !(live(prev, d) && prev.eff.has(d)) && live(cur, d) && cur.eff.has(d)
          )
          for (const id of old) {
            const wasLive = live(prev, id),
              isLive = live(cur, id)
            if (wasLive && !isLive) {
              const s = cur.cut.get(id)
              const okCause =
                ref.rec(eid).cls === 'D' ||
                e.t === 'role_move' ||
                (!!s && revived.some(d => d !== id && !ref.anc(d).has(id) && cmp(k(d), s) >= 0))
              if (!s || !okCause || cmp(s, ke) > 0)
                fail('O3-cut', `${eid}(${ke}) cut ${id} at ${s}`)
            }
            if (!wasLive && isLive) {
              const s = prev.cut.get(id)
              if (s && cmp(ke, s) < 0) fail('O3-revive', `${eid}(${ke}) revived ${id} cut at ${s}`)
            }
            // O5-senior: nothing at stratum ke changes an op whose (effective) stratum is above ke
            const ks = isD(id) || fixed(id) ? k(id) : kstar(id, ref, prevAbove, prevHigh)
            if (cmp(ks, ke) > 0 && (wasLive !== isLive || prev.eff.has(id) !== cur.eff.has(id))) {
              // r7b (seed 9043909; the O3-cut analogue): this step's own decisions at ke or below (a tail, a cut) can remove
              // the grant the op's stratum rested on, and a junior deny that grant had defeated then takes effect. A new
              // cut at s is allowed when the op's k* with the cuts at s and above, and the effective denies above s, of the
              // state after the step is at most s (§3.1: a grant cut at kk counts as live only for the decisions above kk)
              const s = cur.cut.get(id)
              const rested =
                wasLive &&
                !isLive &&
                prev.eff.has(id) === cur.eff.has(id) &&
                !!s &&
                cmp(s, ke) <= 0 &&
                cmp(
                  kstar(
                    id,
                    ref,
                    new Set(
                      [...cur.cut.entries()].filter(([, x]) => cmp(x, s) >= 0).map(([x]) => x)
                    ),
                    new Set([...cur.eff].filter(d => cmp(k(d), s) > 0 || isRev(ref.ev(d))))
                  ),
                  s
                ) <= 0
              if (!rested) fail('O5-senior', `${eid}(${ke}) changed ${id}(${ks})`)
            }
          }
          // O16 (C2): another identity's membership ends only through an event ranked strictly above it, a duel (a kick or
          // ban of it as a member at equal rank), or a revocation at or above it; a withdrawal also needs Kick.
          // A step in which another deny's effectiveness changed is a retroactive flip through a senior decision; it is
          // governed by O3-future (seed 975 in §7.7), so O16 judges only removals that the new event makes by itself.
          const flipped = [...new Set([...prev.eff, ...cur.eff])].some(
            d => d !== eid && prev.eff.has(d) !== cur.eff.has(d)
          )
          for (const P of flipped ? [] : prev.facts.mem) {
            if (cur.facts.mem.has(P) || P === e.a) continue
            const rp = rank(prev.facts, P)
            const duel =
              (e.t === 'kick' || e.t === 'ban') &&
              e.c.to === P &&
              ref.rec(eid).local.facts.mem.has(P)
            let ok = gt(ke, rp) || (cmp(ke, rp) === 0 && (duel || isRev(e)))
            if (ok && isWithdrawal(e) && !(perms(ref.rec(eid).local.facts, e.a) & KICK)) ok = false
            if (!ok) fail('O16-membership', `${eid}(${ke}) removed ${P}(${rp})`)
          }
          // O3-future (no landmines): a new event changes whether an uncut deny d in its causal past is effective only by
          // changing a more senior decision (a cut above k(d)) about an event that is not after d. Facts set by events
          // after d never count for d's protection (seed 1217 in §7.7 shows the legitimate case).
          for (const d of ref.anc(eid)) {
            if (!(live(prev, d) && live(cur, d) && prev.eff.has(d) !== cur.eff.has(d))) continue
            const explained = old.some(x => {
              if (x === d || ref.anc(x).has(d) || live(prev, x) === live(cur, x)) return false
              const s = cur.cut.get(x) ?? prev.cut.get(x)
              return !!s && cmp(s, k(d)) > 0
            })
            if (!explained) fail('O3-future', `${eid} flipped ${d}`)
          }
          // O3-heads: an event causally after everything never changes the status of what came before;
          // O10 liveness: such an event is itself live (unless it is equivocation)
          if (old.every(x => ref.anc(eid).has(x))) {
            for (const id of old)
              if (live(prev, id) !== live(cur, id) || prev.eff.has(id) !== cur.eff.has(id))
                fail('O3-heads', `${eid} changed ${id}`)
            if (!cur.X.has(eid) && !live(cur, eid))
              fail('O10-live', `${eid} on the full heads is not live`)
          }
          // O5-pos: a junior's write never displaces a position set by a more senior concurrent write. Revision 7: the
          // senior concurrent write must be the one that set the position before (its value); a junior's write may
          // supersede a senior write it saw, which can let another, concurrent senior write win (seed 8644705, fixture
          // r7-o5pos-seed8644705.json: two concurrent owner moves to 5 and 6, 5 wins by the lowest pos; a junior that saw
          // the move to 5 moves the role; the move to 6 now wins, as §1.5's register says, and the junior's value doesn't)
          if (e.t === 'role_move' && prev.facts.pos.get(e.c.role) !== cur.facts.pos.get(e.c.role)) {
            const R = e.c.role
            const conc = (x: string, y: string) =>
              x !== y && !ref.anc(x).has(y) && !ref.anc(y).has(x)
            const senior = old.some(x => {
              const xe = ref.ev(x)
              const isW =
                (xe.t === 'role_move' && xe.c.role === R) || (xe.t === 'role_create' && x === R)
              return (
                isW &&
                (live(cur, x) || cur.eff.has(x)) &&
                conc(x, eid) &&
                cmp(k(x), ke) > 0 &&
                xe.c.pos === prev.facts.pos.get(R) &&
                !old.some(
                  y =>
                    ref.anc(y).has(x) &&
                    ref.ev(y).t === 'role_move' &&
                    ref.ev(y).c.role === R &&
                    (live(cur, y) || cur.eff.has(y))
                )
              )
            })
            if (senior) fail('O5-pos', `${eid} moved ${R} past a senior write`)
          }
          // O6-lift: a ban stops holding only through an unban, or a deny at least as senior as every unlifted ban
          for (const T of prev.facts.ban) {
            if (cur.facts.ban.has(T)) continue
            const unlifted = (b: string) =>
              !old.some(u => {
                const ue = ref.ev(u)
                return (
                  ue.t === 'unban' &&
                  ue.c.to === T &&
                  live(prev!, u) &&
                  ref.anc(u).has(b) &&
                  cmp(k(u), k(b)) >= 0
                )
              })
            const bans = old.filter(
              b => prev!.eff.has(b) && ref.ev(b).t === 'ban' && ref.ev(b).c.to === T && unlifted(b)
            )
            if (!bans.every(b => cmp(ke, k(b)) >= 0))
              fail('O6-lift', `${eid}(${ke}) lifted ban of ${T}`)
          }
        }
      }
      prev = cur
    }
    const D = [...everDropped].filter(id => !order.some(x => ref.anc(x).has(id)))
    if (D.length) {
      oracleStats.earlyDrops += D.length
      oracleStats.earlyDropCases++
      const Ds = new Set(D)
      const rest = order.filter(id => !Ds.has(id))
      // still inert: each is an X candidate without a held descendant, and the structural evidence of what is held is
      // that of the whole set (FI and the contested identity ops; F counts the dropped headers)
      const DH = D.filter(x => !everBare.has(x))
      const fAll = forkPoints(order, ref),
        fRest = forkPoints(rest, ref, DH)
      const notNow = D.filter(id => !final.X.has(id))
      if (notNow.length)
        fail(
          'O7-orphan-stable',
          `${notNow[0]} was droppable earlier, not in X in the final set (${notNow.length})`
        )
      if (
        [...fAll.FI].sort().join(';') !== [...fRest.FI].sort().join(';') ||
        [...fAll.F].sort().join(';') !== [...fRest.F].sort().join(';') ||
        [...fAll.RF]
          .filter(x => !Ds.has(x))
          .sort()
          .join() !==
          [...fRest.RF]
            .filter(x => !Ds.has(x))
            .sort()
            .join() ||
        [...fAll.PC]
          .filter(x => !Ds.has(x))
          .sort()
          .join() !==
          [...fRest.PC]
            .filter(x => !Ds.has(x))
            .sort()
            .join()
      )
        fail('O7-orphan-stable', 'dropping the earlier drops changes the fork evidence')
      const rS = evaluate(rest, ref, { ghosts: DH })
      fastHeaders(rest, DH, rS, ref, 'O7-orphan-stable', fail)
      const strip = (r: EvalResult) =>
        evalSummary({
          ...r,
          X: new Set([...r.X].filter(x => !Ds.has(x))),
          tail: new Set([...r.tail].filter(x => !Ds.has(x) && !final.X.has(x))),
          cut: new Map([...r.cut].filter(([id]) => !Ds.has(id) && !final.X.has(id))),
          eff: new Set([...r.eff].filter(id => !Ds.has(id))),
        } as EvalResult)
      if (strip(final) !== strip(rS))
        fail('O7-orphan-stable', `Eval(S) != Eval(S \\ dropped earlier) (${D.length} dropped)`)
    }
  }
  fastDiff(ref, fail)
  if (stats.worldsOverClean > wo0)
    fail(
      'O5-worlds',
      `${stats.worldsOverClean - wo0} exact-branch strata without X ops in Fl tested an op in more than 2^classes + 1 projected worlds (max ${stats.maxOpWorlds})`
    )
  return fails
}
