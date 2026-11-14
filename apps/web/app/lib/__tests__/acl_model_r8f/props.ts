/* eslint-disable */
// @ts-nocheck
// Copy of notes/acl-model-r8f/props.ts (the executable reference model of the P2P ACL spec r8f), used only by tests.
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
  withLim,
  recoveryKeyOf,
  LIM_BASE,
  LIM_RANGE,
  resolveProtection,
  creationOf,
  carriedOf,
  crDigest,
  recDigest,
  chainTree,
  droppedBy,
} from './model'
import { type Case, Rng } from './gen'
import { g5Oracle } from './oracle'
import { fastEvaluate, FastState } from './fast'
import { Adopted, checkTransfer, makeTransfer, verify } from './checkpoint'

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
  fastConc: 0,
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
  cpCases: 0,
  b3Handed: 0,
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
  oracleStats.fastConc += fs.stats.conc
  oracleStats.b3Handed += fs.stats.b3
  if (evalSummary(fs.state()) !== evalSummary(ref.state()))
    fail('O13-fast', 'incremental final state differs')
}

/**
 * The protection rules of §2.5 (revision 8, fix round 2) recomputed from their definition by separate code: pasts walked
 * from `ap`, chains attached and killed here, signers read from the events' `c.by` with the honest defaults worked out
 * here (no use of model.ts's protection functions or recorded signers; the digest functions are the record format).
 * Per identity with a creation record: void (two creation records, an `ik`-signed record, rival resets) or protected
 * with the keys of its chain heads, and its inert records. O15-oracle compares it with resolveProtection both ways.
 */
export function protectionOracle(cx: Ctx, ids: string[]) {
  const memo = new Map<string, Set<string>>()
  const past = (x: string): Set<string> => {
    let s = memo.get(x)
    if (s) return s
    s = new Set<string>()
    for (const p of cx.ev(x).ap) {
      s.add(p)
      for (const q of past(p)) s.add(q)
    }
    memo.set(x, s)
    return s
  }
  type Out = {
    st: string
    rec: string[]
    prim: string[]
    inert: Set<string>
    won?: string
    why?: string
    rivals?: Set<string>
  }
  const out = new Map<string, Out>()
  const evs = ids.map(id => cx.ev(id))
  const gen = evs.find(e => e.t === 'genesis')
  if ((gen?.c?.rules ?? 2) !== 3) return out
  const owners = new Set<string>((gen?.c?.owners ?? []) as string[])
  const isRkO = (k: unknown) => typeof k === 'string' && k.startsWith('rk')
  // an introduction's creation record for identity a: [rk, pk, chain]
  const crOf = (e: Ev, a: string): [string, string, any[]] | undefined => {
    if (e.t === 'join' && e.a === a && isRkO(e.c?.rk))
      return [
        e.c.rk,
        e.c?.pk === undefined ? 'p0' : e.c.pk,
        Array.isArray(e.c?.chain) ? e.c.chain : [],
      ]
    if (e.t === 'genesis') {
      const r = e.c?.rks?.[a]
      if (isRkO(r)) return [r, 'p0', []]
      if (r && typeof r === 'object' && isRkO(r.rk))
        return [r.rk, r.pk === undefined ? 'p0' : r.pk, Array.isArray(r.chain) ? r.chain : []]
    }
    return undefined
  }
  const FIELDS = ['n', 'prev', 'by', 'pk', 'keep', 'rk']
  const okRec = (r: any) =>
    !!r &&
    typeof r === 'object' &&
    !Array.isArray(r) &&
    Number.isInteger(r.n) &&
    r.n >= 1 &&
    r.n <= 8 &&
    typeof r.prev === 'string' &&
    typeof r.by === 'string' &&
    r.by !== '' &&
    typeof r.pk === 'string' &&
    r.pk !== '' &&
    r.pk !== 'ik' &&
    !isRkO(r.pk) &&
    Array.isArray(r.keep) &&
    r.keep.every((k: unknown) => typeof k === 'string') &&
    (r.rk === undefined || r.rk === '' || isRkO(r.rk)) &&
    Object.keys(r).every(k => FIELDS.includes(k))
  // fix round 4 (ruling 1): an upgrade signature's chain is carried by the upgrade, like a rotation's
  const carried = (e: Ev, a: string): any[] =>
    (e.t === 'primary_rotate'
      ? e.a === a && Array.isArray(e.c?.chain)
        ? e.c.chain
        : []
      : e.t === 'upgrade'
        ? (sigEntry(e, a)?.[1] ?? [])
        : (crOf(e, a)?.[2] ?? [])
    ).filter(okRec)
  // a chain from a creation record and records: per digest the node {n, parent, rec, keyAfter, primAfter}
  type N = { d: string; n: number; par?: N; r?: any; key: string; prim: string }
  const chainOf = (a: string, rk: string, pk: string, recs: any[]) => {
    const root: N = { d: crDigest(a, rk, pk), n: 0, key: rk, prim: pk }
    const at = new Map<string, N>([[root.d, root]])
    const byD = new Map<string, any>()
    for (const r of recs) byD.set(recDigest(r), r)
    const attach = (d: string, seen: Set<string>): N | undefined => {
      if (at.has(d)) return at.get(d)
      const r = byD.get(d)
      if (!r || seen.has(d)) return undefined
      seen.add(d)
      const p = attach(r.prev, seen)
      if (!p || r.n !== p.n + 1 || r.by !== p.key) return undefined
      const x: N = {
        d,
        n: r.n,
        par: p,
        r,
        key: r.rk === undefined ? p.key : r.rk === '' ? r.pk : r.rk,
        prim: r.pk,
      }
      at.set(d, x)
      return x
    }
    for (const d of byD.keys()) attach(d, new Set())
    const up = (x: N | undefined, y: N) => {
      for (let z: N | undefined = y; z; z = z.par) if (z.d === x?.d) return true
      return false
    }
    const changes = [...at.values()].filter(x => x.r && x.r.rk !== undefined)
    let rival = false
    const dead = new Set<N>(),
      rivalNodes = new Set<N>()
    for (const m of changes)
      for (const x of at.values()) {
        if (x === m || !x.r || x.r.by !== m.r.by || up(x, m) || up(m, x)) continue
        dead.add(x)
        if (x.r.rk !== undefined) {
          rival = true
          rivalNodes.add(x)
          rivalNodes.add(m)
        }
      }
    const alive = (x: N) => {
      for (let z: N | undefined = x; z; z = z.par) if (dead.has(z)) return false
      return true
    }
    const underRival = (x: N) => {
      for (let z: N | undefined = x; z; z = z.par) if (rivalNodes.has(z)) return true
      return false
    }
    const live = [...at.values()].filter(alive)
    const top = Math.max(...live.map(x => x.n))
    const heads = live.filter(x => x.n === top).sort((x, y) => (x.d < y.d ? -1 : 1))
    return { at, alive, heads, rival, up, changes, underRival, rivalNodes, byD }
  }
  // the tree after `extra` at a position holding `before`, read on extra's own branch when it brings rival resets
  const ownBranchOf = (a: string, rk: string, pk: string, before: any[], extra: any[]) => {
    const C0 = chainOf(a, rk, pk, before),
      C1 = chainOf(a, rk, pk, [...before, ...extra])
    if (!C1.rival || !extra.some(r => !C0.at.has(recDigest(r)))) return C1
    const keepD = new Set<string>()
    for (const r of extra)
      for (let d: string | undefined = recDigest(r); d && C1.byD.has(d); d = C1.byD.get(d).prev)
        keepD.add(d)
    return chainOf(
      a,
      rk,
      pk,
      [...before, ...extra].filter(r => keepD.has(recDigest(r)))
    )
  }
  const isRecordE = (e: Ev) =>
    e.t === 'primary_rotate' ||
    e.t === 'device_add' ||
    e.t === 'device_revoke' ||
    (e.t === 'join' && cx.rec(e.id).depth >= 0)
  const concurrent = (x: string, y: string) => x !== y && !past(y).has(x) && !past(x).has(y)
  const crsIn = (a: string, E: Ev[]) => {
    const m = new Map<string, [string, string]>()
    const g = E.find(e => e.t === 'genesis')
    if (g && owners.has(a)) {
      const c = crOf(g, a)
      if (c) m.set(`${c[0]}|${c[1]}`, [c[0], c[1]])
    }
    for (const e of E)
      if (e.t === 'join' && e.a === a) {
        const c = crOf(e, a)
        if (c) m.set(`${c[0]}|${c[1]}`, [c[0], c[1]])
      }
    return m
  }
  const carriersIn = (a: string, E: Ev[]) =>
    E.filter(
      e =>
        (e.t === 'genesis' ? owners.has(a) : e.a === a || e.t === 'upgrade') && carried(e, a).length
    )
  // an upgrade's signature entry of owner a (rules 3, fix round 3): [the key it names or undefined, its chain]
  const sigEntry = (u: Ev, a: string): [string | undefined, any[]] | undefined => {
    const sigs = u.c?.sigs
    if (!sigs || typeof sigs !== 'object' || Array.isArray(sigs) || !Object.hasOwn(sigs, a))
      return undefined
    const s = sigs[a]
    if (typeof s === 'string') return ['ik', []]
    return [
      typeof s?.by === 'string' ? s.by : undefined,
      Array.isArray(s?.chain) ? s.chain.filter(okRec) : [],
    ]
  }
  // the honest default signer of a record: what its own position allows first (heads sorted by digest), worked out here
  const sigMemo = new Map<string, string>()
  const protAt = (a: string, P: Ev[]): { rk: string; pk: string; recs: any[] } | undefined => {
    const vals = crsIn(a, P)
    if (vals.size !== 1) return undefined
    if (P.some(x => x.a === a && isRecordE(x) && sig(x) === 'ik')) return undefined
    if (P.some(x => x.t === 'upgrade' && sigOf(x, a) === 'ik')) return undefined
    const [rk, pk] = [...vals.values()][0]
    const recs = carriersIn(a, P).flatMap(x => carried(x, a))
    if (chainOf(a, rk, pk, recs).rival) return undefined
    return { rk, pk, recs }
  }
  const sig = (e: Ev): string => {
    if (typeof e.c?.by === 'string') return e.c.by
    let v = sigMemo.get(e.id)
    if (v !== undefined) return v
    const P = evs.filter(x => past(e.id).has(x.id))
    const vals = crsIn(e.a, P)
    const own = e.t === 'join' ? crOf(e, e.a) : undefined
    const base = vals.size
      ? [...vals.values()][0]
      : own && !P.some(x => x.t === 'join' && x.a === e.a)
        ? [own[0], own[1]]
        : undefined
    const voidHere =
      !base ||
      vals.size > 1 ||
      P.some(x => x.a === e.a && isRecordE(x) && sig(x) === 'ik') ||
      P.some(x => x.t === 'upgrade' && sigOf(x, e.a) === 'ik')
    if (voidHere) v = 'ik'
    else {
      // fix round 5 (the r8e C2 verifier's side seed 93,100,183, fixture `r8e-o15oracle-seed93100183.json`): a carrier that
      // brings rival resets is read on its own branch, as admission checks it (`decide`) and as `sigOf` reads an upgrade
      // signature's chain; only a past that already holds both resets leaves no key but `ik`. Before, the default signer
      // of the rotation that brought the second reset was read as `ik` here and as the branch's recovery key by the model
      const recs0 = carriersIn(e.a, P).flatMap(x => carried(x, e.a))
      const extra = e.t === 'primary_rotate' || e.t === 'join' ? carried(e, e.a) : []
      const C0 = chainOf(e.a, base![0], base![1], recs0)
      const C = C0.rival || !extra.length ? C0 : ownBranchOf(e.a, base![0], base![1], recs0, extra)
      if (C.rival) v = 'ik'
      else if (e.t === 'primary_rotate') {
        const ks = [...new Set(C.heads.map(h => h.key))]
        v = ks.length === 1 ? ks[0] : '?'
      } else if (e.t === 'device_revoke') {
        const C0 = chainOf(
          e.a,
          base![0],
          base![1],
          carriersIn(e.a, P).flatMap(x => carried(x, e.a))
        )
        v = C0.heads[0].prim
      } else v = C.heads[0].prim
    }
    sigMemo.set(e.id, v)
    return v
  }
  // the key an upgrade's signature of owner a names (an absent `by`: the head's primary at the upgrade's position)
  const sigOf = (u: Ev, a: string): string | undefined => {
    const s = sigEntry(u, a)
    if (!s) return undefined
    if (s[0] !== undefined) return s[0]
    const P = evs.filter(x => past(u.id).has(x.id))
    const pr = protAt(a, P)
    if (!pr) return 'ik'
    return ownBranchOf(a, pr.rk, pr.pk, pr.recs, s[1]).heads[0]?.prim ?? 'ik'
  }
  const upgrades = evs.filter(
    e => e.t === 'upgrade' && !Array.isArray(e.c?.sigs) && e.c?.sigs && typeof e.c.sigs === 'object'
  )
  const idents = new Set<string>()
  for (const e of evs) {
    if (e.t === 'join' && crOf(e, e.a)) idents.add(e.a)
    if (e.t === 'genesis') for (const o of owners) if (crOf(e, o)) idents.add(o)
  }
  for (const a of idents) {
    const mine = evs.filter(e => e.a === a)
    const recsA = mine.filter(isRecordE)
    const sigsA = upgrades.filter(u => sigEntry(u, a))
    const vals = crsIn(a, evs)
    const [rk0, pk0] = [...vals.values()][0]
    const carriers = carriersIn(a, evs)
    const allRecs = carriers.flatMap(x => carried(x, a))
    const C = chainOf(a, rk0, pk0, allRecs)
    const inert = new Set<string>()
    const why =
      vals.size > 1
        ? 'cr'
        : recsA.some(x => sig(x) === 'ik') || sigsA.some(u => sigOf(u, a) === 'ik')
          ? 'ik'
          : C.rival
            ? 'chain'
            : undefined
    if (why && why !== 'chain') {
      for (const x of recsA) if (sig(x) !== 'ik') inert.add(x.id)
      for (const u of sigsA) if (sigOf(u, a) !== 'ik') inert.add(u.id)
      out.set(a, { st: 'unprotected', rec: ['ik'], prim: ['ik'], inert, why })
      continue
    }
    const frozen = why === 'chain'
    const carriedBy = (d: string) =>
      carriers.filter(x => carried(x, a).some(r => recDigest(r) === d)).map(x => x.id)
    // a record dies in the set: its node dead (rival branches included), or key or epoch death against the carriers of a
    // valid record (on a frozen identity also of either rival branch)
    const countsForDeath = (m: N) => C.alive(m) || (frozen && C.underRival(m))
    // fix round 5 (ruling 2; r8e attack review C1): an upgrade's signatures and its author device's introductions die
    // only through carriers that are rotations signed by a recovery key (a key some node of the chain installs)
    const keysOfC = new Set([...C.at.values()].map(n => n.key))
    const rkRot = (c: string) => {
      const ce = cx.ev(c)
      return ce.t === 'primary_rotate' && keysOfC.has(sig(ce))
    }
    const deadAt = (
      Cn: typeof C,
      nodeS: N,
      byKey: boolean,
      by: string,
      pos: string,
      upg = false
    ) => {
      if (!Cn.alive(nodeS)) return true
      const kill = (c: string) => concurrent(c, pos) && (!upg || rkRot(c))
      if (byKey)
        for (const m of C.changes)
          if (m.r.by === by && countsForDeath(m) && C.up(nodeS, m) && carriedBy(m.d).some(kill))
            return true
      if (!byKey)
        for (const m of C.at.values())
          if (m.r && m.n > nodeS.n && countsForDeath(m) && carriedBy(m.d).some(kill)) return true
      return false
    }
    const inertRk = new Set<string>()
    for (const x of recsA) {
      if (frozen && x.t === 'device_revoke') continue // a removal valid at its own position keeps its cut
      const by = sig(x)
      const before = carriers.filter(c => past(x.id).has(c.id)).flatMap(c => carried(c, a))
      const own = x.t === 'primary_rotate' || x.t === 'join' ? carried(x, a) : []
      const C0 = chainOf(a, rk0, pk0, before),
        C1 = ownBranchOf(a, rk0, pk0, before, own)
      const brought = own.some(r => !C0.at.has(recDigest(r)))
      let node: N | undefined,
        byKey = false
      if (x.t === 'primary_rotate') {
        node = C1.heads.find(h => h.key === by)
        byKey = !!node
        if (!node && brought) node = C1.heads.find(h => h.prim === by)
      } else if (x.t === 'device_revoke') {
        node = C0.heads.find(h => h.key === by)
        byKey = !!node
        if (!node) node = C0.heads.find(h => h.prim === by)
      } else node = C1.heads.find(h => h.prim === by)
      const nodeS = node && C.at.get(node.d)
      if (!node || !nodeS || deadAt(C, nodeS, byKey, by, x.id, true)) inertRk.add(x.id)
      if (!node || !nodeS || deadAt(C, nodeS, byKey, by, x.id)) inert.add(x.id)
    }
    for (const u of sigsA) {
      const by = sigOf(u, a)!,
        sc = sigEntry(u, a)![1]
      const before = carriers.filter(c => past(u.id).has(c.id)).flatMap(c => carried(c, a))
      const C1 = ownBranchOf(a, rk0, pk0, before, sc)
      let node = C1.heads.find(h => h.prim === by),
        byKey = false
      if (!node) {
        node = C1.heads.find(h => h.key === by)
        byKey = !!node
      }
      const Cn = sc.length ? chainOf(a, rk0, pk0, [...allRecs, ...sc]) : C
      const nodeS = node && Cn.at.get(node.d)
      if (!node || !nodeS || deadAt(Cn, nodeS, byKey, by, u.id, true)) inert.add(u.id)
    }
    const upgIds = new Set(sigsA.map(u => u.id))
    for (const x of mine) {
      const intro = (y: Ev) =>
        y.a === a &&
        cx.rec(y.id).depth >= 0 &&
        (y.t === 'genesis' || y.t === 'join' || y.t === 'device_add'
          ? [y.dev]
          : y.t === 'primary_rotate'
            ? [y.dev, ...((y.c?.keep ?? []) as string[])]
            : []
        ).includes(x.dev)
      const its = [x, ...evs.filter(y => past(x.id).has(y.id))].filter(intro)
      if (
        !inertRk.has(x.id) &&
        ((upgIds.has(x.id) && inert.has(x.id)) || (its.length && its.every(y => inertRk.has(y.id))))
      )
        inertRk.add(x.id)
      if (inert.has(x.id)) continue
      if (upgIds.has(x.id)) {
        if (inertRk.has(x.id)) inert.add(x.id)
        continue
      }
      if (its.length && its.every(y => inert.has(y.id))) inert.add(x.id)
    }
    if (frozen) {
      const rivals = new Set<string>()
      for (const m of C.rivalNodes) for (const c of carriedBy(m.d)) rivals.add(c)
      out.set(a, { st: 'unprotected', rec: [], prim: [], inert, why: 'chain', rivals })
      continue
    }
    out.set(a, {
      st: 'protected',
      rec: [...new Set(C.heads.map(h => h.key))].sort(),
      prim: [...new Set(C.heads.map(h => h.prim))].sort(),
      inert,
      won: `${rk0}|${pk0}`,
    })
  }
  return out
}

/** fix round 4 (ruling 1): the chain records an event carries for `a`, a rules-3 upgrade's signature chain included (it
 * joins the set's chain, with the upgrade as its carrier) */
export const carriedAll = (e: Ev, a: string): any[] => {
  if (e.t !== 'upgrade') return carriedOf(e, a)
  const s = e.c?.sigs
  const x =
    s && typeof s === 'object' && !Array.isArray(s) && Object.hasOwn(s, a) ? s[a] : undefined
  return x && typeof x === 'object' && Array.isArray(x.chain) ? x.chain : []
}
/** the keys a carrier is checked against when it brings rival resets: its own records and their ancestors at its position */
function ownBranch(
  ref: Replica,
  B: string[],
  id: string,
  a: string
): { st: string; rec: string[]; prim: string[] } | undefined {
  const e = ref.ev(id)
  const cr =
    B.map(x => ref.ev(x))
      .map(x => creationOf(x, a))
      .find(c => c) ?? (e.t === 'join' ? creationOf(e, a) : undefined)
  if (!cr) return undefined
  const all = new Map<string, any>()
  for (const x of [...B, id]) for (const r of carriedAll(ref.ev(x), a)) all.set(recDigest(r), r)
  const keepD = new Set<string>()
  for (const r of carriedOf(e, a))
    for (let d: string | undefined = recDigest(r); d && all.has(d); d = all.get(d).prev)
      keepD.add(d)
  const T = chainTree(
    a,
    cr,
    [...all.entries()].filter(([d]) => keepD.has(d)).map(([, r]) => r)
  )
  return {
    st: 'protected',
    rec: [...new Set(T.heads.map(h => h.key))].sort(),
    prim: [...new Set(T.heads.map(h => h.prim))].sort(),
  }
}

/**
 * O15 (revision 8, fix rounds 2 and 3, §2.5), on every case with a creation record. Every property runs (fix round 3,
 * ruling 11: no early return after O15-oracle), and the fuzz output counts each:
 * - O15-oracle: the model's protection state equals protectionOracle's, the two inert sets are equal, and every inert
 *   record is in X;
 * - O15-signer: every admitted identity record and every rules-3 upgrade signature is signed by a key its own position
 *   allows;
 * - O15-value: no value other than the identity's creation record ever holds, and an `ik`-signed record voids it: in
 *   every admission state and the final state, every identity with a creation record in the set is protected exactly
 *   when the set holds one creation record for it, no record of it signed by `ik` and no rival resets;
 * - O15-void (fix round 3): rival resets freeze the identity: it is no member and has no live device, no event of it
 *   whose past holds both rivals is admitted (an ik-signed identity record aside), and every removal of it keeps its
 *   cut (the device's events past the watermark have no effect);
 * - O15-join (fix round 3): a join admitted through adds that name the invitee's chain head carries (or its position
 *   holds) a chain that reaches every head they name;
 * - on the b3 templates: O15-recovery, a device a valid recovery drops never returns (the recovery stays valid and its
 *   dropped devices stay revoked at every prefix that holds it, with every event past its watermark without effect),
 *   and for every valid chain record of the user's carried in the set, every device of the identity in its carrier's
 *   past that the record neither keeps nor certified is not live, and has no effect outside that past; O15-thief, no key
 *   the thief holds is the identity's once a user record is in the set, no record or upgrade the thief signed has an
 *   effect after it is known, and the thief's devices are not live; the disowning flow's revocation signed by the
 *   recovery key stands unless a key change of that key is in the set. The template's metadata names the cases where the
 *   thief holds the recovery key or a later record's primary (N26 (b), (f)), which those properties skip.
 */
export function protectionChecks(cs: Case, fail: (prop: string, detail: string) => void) {
  const ref = cs.w.ref,
    S = ref.state()
  const g = ref.order.length ? ref.ev(ref.order[0]) : undefined
  if ((g?.c?.rules ?? 2) !== 3) return
  const O = protectionOracle(ref, ref.order)
  const M = resolveProtection(ref.order, ref)
  const mInert = M.inert,
    oInert = new Set<string>()
  for (const o of O.values()) for (const x of o.inert) oInert.add(x)
  // O15-oracle
  for (const [a, o] of O) {
    const m = S.BD?.get(a)
    if (
      !m ||
      m.st !== o.st ||
      m.won !== o.won ||
      JSON.stringify(m.rec) !== JSON.stringify(o.rec) ||
      JSON.stringify(m.prim) !== JSON.stringify(o.prim) ||
      (m.void === 'chain') !== (o.why === 'chain')
    ) {
      fail(
        'O15-oracle',
        `${a}: model ${JSON.stringify(m && { st: m.st, won: m.won, rec: m.rec, prim: m.prim, void: m.void })} vs ${JSON.stringify({ st: o.st, won: o.won, rec: o.rec, prim: o.prim, why: o.why })}`
      )
      break
    }
  }
  if ([...(S.BD?.keys() ?? [])].some(a => !O.has(a)))
    fail('O15-oracle', "the model protects an identity the oracle doesn't")
  const onlyM = [...mInert].find(x => !oInert.has(x)),
    onlyO = [...oInert].find(x => !mInert.has(x))
  if (onlyM || onlyO)
    fail('O15-oracle', `inert sets differ: model only ${onlyM}, oracle only ${onlyO}`)
  const notX = [...oInert].find(id => !S.X.has(id))
  if (notX) fail('O15-oracle', `${notX} inert but not in X`)
  // O15-signer
  for (const id of ref.order) {
    const e = ref.ev(id)
    if (
      e.t !== 'primary_rotate' &&
      e.t !== 'device_add' &&
      e.t !== 'device_revoke' &&
      !(e.t === 'join' && ref.rec(id).depth >= 0)
    )
      continue
    const B = ref.order.filter(x => ref.anc(id).has(x))
    const by = ref.rec(id).by ?? 'ik'
    if (by === 'ik') continue // ik is always admitted (it voids a creation record)
    let o = protectionOracle(ref, [...B, id]).get(e.a)
    const o0 = protectionOracle(ref, B).get(e.a)
    // a carrier that brings rival resets (a leaked phrase) is checked on its own branch: the records it carries and those
    // its position holds below them
    if (o?.why === 'chain' && o0?.st === 'protected') o = ownBranch(ref, B, id, e.a) ?? o
    // the record's own position (for a carrier, with its own records): the oracle on B(e) ∪ {e} sees them
    const ok = o0?.st === 'protected' || (e.t === 'join' && o?.st === 'protected' && !o0)
    if (!ok || (o0 && o0.st !== 'protected')) {
      fail('O15-signer', `${id} signed by ${by} where its identity is not protected`)
      break
    }
    // a rotation by the recovery key in force, or by the new head's primary when it brings a record its position lacks
    const knownD = new Set(B.flatMap(x => carriedAll(ref.ev(x), e.a)).map(recDigest))
    const brings = carriedOf(e, e.a).some(r => !knownD.has(recDigest(r)))
    const allowed =
      e.t === 'device_revoke'
        ? [...(o0?.prim ?? []), ...(o0?.rec ?? [])]
        : e.t === 'primary_rotate'
          ? [...(o?.rec ?? []), ...(brings ? (o?.prim ?? []) : [])]
          : [...(o?.prim ?? [])]
    if (!allowed.includes(by)) {
      fail('O15-signer', `${id} signed by ${by}, its position allows ${allowed.join(',')}`)
      break
    }
  }
  // O15-signer, upgrade signatures (fix round 3, ruling 5): each owner's by the primary or recovery key of its head at
  // the upgrade's position after the chain it carries
  for (const id of ref.order) {
    const e = ref.ev(id),
      sb = ref.rec(id).sigBy
    if (e.t !== 'upgrade' || !sb) continue
    const B = ref.order.filter(x => ref.anc(id).has(x))
    for (const [o, by] of Object.entries(sb)) {
      if (by === 'ik') continue
      const o0 = protectionOracle(ref, B).get(o)
      if (o0?.st !== 'protected') {
        fail('O15-signer', `${id}: ${o}'s signature by ${by} where ${o} is not protected`)
        continue
      }
      const cr = B.map(x => creationOf(ref.ev(x), o)).find(c => c)
      const sc = Array.isArray(e.c?.sigs?.[o]?.chain) ? e.c.sigs[o].chain : []
      const T = chainTree(o, cr!, [...B.flatMap(x => carriedAll(ref.ev(x), o)), ...sc])
      const allowed = [...T.heads.map(h => h.prim), ...T.heads.map(h => h.key)]
      if (!T.equiv && !allowed.includes(by))
        fail(
          'O15-signer',
          `${id}: ${o}'s signature by ${by}, its position allows ${allowed.join(',')}`
        )
    }
  }
  // O15-signer: a carried chain record is a closed format (fix round 3, attack review M4; mutant `b3-rec-fields`)
  for (const id of ref.order)
    for (const r of carriedOf(ref.ev(id), ref.ev(id).a))
      if (Object.keys(r).some(k => !['n', 'prev', 'by', 'pk', 'keep', 'rk'].includes(k))) {
        fail('O15-signer', `${id} carries a chain record with an unknown field`)
        break
      }
  // O15-value, on every admission state and the final state, over every identity with a creation record in the set
  const crVals = (E: string[], a: string) => {
    const s = new Set<string>()
    for (const x of E) {
      const e = ref.ev(x)
      const c = e.t === 'genesis' || (e.t === 'join' && e.a === a) ? creationOf(e, a) : undefined
      if (c) s.add(`${c.rk}|${c.pk}`)
    }
    return s
  }
  const withCr = (E: string[]) => {
    const s = new Set<string>()
    for (const x of E) {
      const e = ref.ev(x)
      if (e.t === 'join' && creationOf(e)) s.add(e.a)
      if (e.t === 'genesis') for (const o of e.c?.owners ?? []) if (creationOf(e, o)) s.add(o)
    }
    return s
  }
  const valueOk = (E: string[], st: EvalResult, at: string) => {
    for (const a of withCr(E)) {
      const p = st.BD?.get(a)
      const vs = crVals(E, a)
      const ikRec = E.some(x => {
        const e = ref.ev(x)
        return (
          (e.a === a && (ref.rec(x)?.by ?? '') === 'ik') ||
          (e.t === 'upgrade' && ref.rec(x)?.sigBy?.[a] === 'ik')
        )
      })
      if (p?.st === 'protected' && (vs.size !== 1 || p.won !== [...vs][0] || ikRec)) {
        fail(
          'O15-value',
          `${at}: ${a} protected with ${p.won} (creation records ${[...vs]}, ik-signed ${ikRec})`
        )
        return false
      }
      if (p?.st !== 'protected' && vs.size === 1 && !ikRec && p?.void !== 'chain') {
        fail('O15-value', `${at}: ${a} unprotected without a cause`)
        return false
      }
    }
    return true
  }
  if (valueOk(ref.order, S, 'final'))
    for (const id of ref.order)
      if (
        ref.rec(id).local?.facts &&
        !valueOk(
          ref.order.filter(x => ref.anc(id).has(x)),
          ref.rec(id).local,
          `St(${id})`
        )
      )
        break
  // O15-void (fix round 3, ruling 3)
  const nonX = ref.order.filter(x => !S.X.has(x))
  const fixedT = (t: string) => t === 'genesis' || t === 'device_revoke' || t === 'primary_rotate'
  for (const [a, o] of O) {
    if (o.why !== 'chain') continue
    if (S.facts.mem.has(a) || (S.facts.devs.get(a)?.size ?? 0) > 0)
      fail('O15-void', `${a} is frozen but a member or with a live device`)
    // no grant under either rival branch counts: a rival carrier, and a grant whose past holds one, are in X
    for (const id of ref.order) {
      const e = ref.ev(id)
      if (
        e.a !== a ||
        !(
          e.t === 'primary_rotate' ||
          e.t === 'device_add' ||
          (e.t === 'join' && ref.rec(id).depth >= 0)
        )
      )
        continue
      if (
        (o.rivals?.has(id) || [...(o.rivals ?? [])].some(c => ref.anc(id).has(c))) &&
        !S.X.has(id)
      ) {
        fail('O15-void', `${id}, a grant under a rival branch of the frozen ${a}, has an effect`)
        break
      }
    }
    // fix round 4 (r8d completeness review I1, the verifier's F1): the identity's own client posts nothing once its replica
    // holds the rival (the client rule; honest members don't cite the rival, it is in X), so an event it posted anyway
    // (mutant `frozen-acts`) shows here as admitted (cs.b3.afterVoid)
    for (const id of cs.b3?.x === a ? (cs.b3.afterVoid ?? []) : [])
      if (ref.admitted(id)) {
        fail(
          'O15-void',
          `${id}, posted by ${a}'s honest client after its replica held the rival, is admitted`
        )
        break
      }
    for (const id of ref.order) {
      const e = ref.ev(id)
      if (e.a !== a || e.t === 'genesis') continue
      if (
        (e.t === 'primary_rotate' ||
          e.t === 'device_add' ||
          e.t === 'device_revoke' ||
          e.t === 'join') &&
        (ref.rec(id).by ?? 'ik') === 'ik'
      )
        continue
      const B = ref.order.filter(x => ref.anc(id).has(x))
      if (protectionOracle(ref, B).get(a)?.why === 'chain') {
        fail('O15-void', `${id} of the frozen ${a} admitted with both rivals in its past`)
        break
      }
    }
    for (const id of ref.order) {
      const r = ref.ev(id)
      if (
        r.a !== a ||
        (r.t !== 'device_revoke' && r.t !== 'primary_rotate') ||
        r.seq >= (S.F.get(r.dev) ?? Infinity)
      )
        continue
      const marks =
        r.t === 'device_revoke'
          ? [{ v: r.c.dev as string, s: r.c.seen as number }]
          : [...droppedP(r, nonX, ref)].map(v => ({ v, s: (r.c.seen?.[v] ?? -1) as number }))
      for (const { v, s } of marks)
        for (const x of ref.order) {
          const xe = ref.ev(x)
          if (xe.dev === v && xe.seq > s && !fixedT(xe.t) && !S.tail.has(x) && !S.X.has(x)) {
            fail(
              'O15-void',
              `${x} past the watermark of ${id} (a removal of the frozen ${a}) has an effect`
            )
            break
          }
        }
    }
  }
  // O15-void (fix round 4; r8d completeness review I1): a rival carrier placed on one sibling of a third identity's
  // unacknowledged fork launders nothing: honest members never cite it, so both siblings stay in X (mutant `cite-rival`)
  if (cs.b3?.launder && cs.b3.launderAt) {
    const pre = ref.order.slice(0, cs.b3.launderAt)
    if (protectionOracle(ref, pre).get(cs.b3.x)?.why === 'chain') {
      const St = withLim(ref.lim, () => evaluate(pre, ref))
      for (const id of cs.b3.launder)
        if (ref.admitted(id) && !St.X.has(id)) {
          fail(
            'O15-void',
            `${id}, a sibling of an unacknowledged fork below a rival carrier, left X`
          )
          break
        }
    }
  }
  // O15-join (fix round 3; the r8c completeness review I7 and M2, mutants `b3-add-head`, `b3-two-cr`): a join's creation
  // record is the one its position knows (an owner's genesis bundle's, else its earlier joins', or none once a plain join
  // of it is there), and it reaches every head its usable adds name
  for (const id of ref.order) {
    const e = ref.ev(id)
    if (e.t !== 'join') continue
    const cJ = creationOf(e)
    if (cJ) {
      const B0 = ref.order.filter(x => ref.anc(id).has(x)).map(x => ref.ev(x))
      const g0 = B0.find(x => x.t === 'genesis')
      const isOwner = (g0?.c?.owners ?? []).includes(e.a)
      const prior = isOwner
        ? [g0 ? creationOf(g0, e.a) : undefined]
        : B0.filter(x => x.t === 'join' && x.a === e.a).map(x => creationOf(x))
      const vals = new Set(prior.map(c => (c ? `${c.rk}|${c.pk}` : '')))
      if ((isOwner || prior.length) && !vals.has(`${cJ.rk}|${cJ.pk}`))
        fail('O15-join', `${id} carries a creation record its position doesn't know (${[...vals]})`)
    }
    const L = ref.rec(id).local
    const named = [
      ...new Set(
        (L.facts?.invited.get(e.a) ?? [])
          .map(p => ref.ev(p.id).c?.head)
          .filter((h): h is string => typeof h === 'string')
      ),
    ]
    if (!named.length) continue
    const B = ref.order.filter(x => ref.anc(id).has(x))
    const cr = [...B, id].map(x => creationOf(ref.ev(x), e.a)).find(c => c)
    if (!cr) {
      fail('O15-join', `${id} joined through adds naming ${named} without a creation record`)
      continue
    }
    if (L.BD?.get(e.a) && L.BD.get(e.a)!.st !== 'protected') continue // unprotected at its position: ik plays every key
    const recs = [...B, id].flatMap(x => carriedAll(ref.ev(x), e.a))
    const byD = new Map<string, any>(recs.map(r => [recDigest(r), r]))
    const root = crDigest(e.a, cr.rk, cr.pk)
    // a chain walked up from a record to the creation record: fix round 4 (r8d attack review M5), a named record is
    // reached when it is one of the join's chain (it attaches to the creation record), also the other one of two same-n
    // records the user reconciled
    const pathTo = (d: string) => {
      const out: string[] = []
      for (let x: string | undefined = d; x; x = x === root ? undefined : byD.get(x)?.prev) {
        out.push(x)
        if (x !== root && !byD.has(x)) return []
      }
      return out
    }
    for (const h of named)
      if (!pathTo(h).length) {
        fail('O15-join', `${id} carries no chain holding the named record ${h}`)
        break
      }
  }
  // fix round 4 (rulings 1 and 6; r8d attack review C1, completeness review M5): no lockout. The user's honest posts that
  // the template's client makes must be admitted: in a successor server its join through the carry-over's add, carrying
  // a chain that reaches the head it names (mutant `b3-migrate-mem`: migrate makes it a member first, so its own join is
  // refused and it holds no device there); in an upgraded S its reset (mutants `b3-upg-rot-off`, `b3-upg-rot-mem`)
  for (const id of cs.b3?.mustAdmit ?? [])
    if (!ref.admitted(id)) {
      fail(
        'O15-join',
        `${id}, the user's ${cs.w.all.find(e => e.id === id)?.t ?? 'event'} its client posts, is refused (${JSON.stringify(ref.status.get(id))})`
      )
      break
    }
  const b3 = cs.b3
  if (!b3) return
  const thiefKey = (k: string) => (b3.thiefKeys ?? []).includes(k)
  const mb = S.BD?.get(b3.x)
  // once one of the user's own chain records is in the set, no key the thief holds is the identity's
  const userCarriers = ref.order.filter(id =>
    carriedAll(ref.ev(id), b3.x).some(r => (b3.userRecs ?? []).includes(recDigest(r)))
  )
  const userIn = userCarriers.length > 0
  if (
    !b3.legacy &&
    !b3.n26f &&
    userIn &&
    mb?.st === 'protected' &&
    (mb.rec.some(thiefKey) || mb.prim.some(thiefKey))
  )
    fail('O15-thief', `the thief's key holds: rec ${mb.rec} prim ${mb.prim}`)
  const skip = b3.legacy || b3.n26f
  if (b3.r && ref.admitted(b3.r) && !b3.leaked && !skip) {
    const r = ref.ev(b3.r)
    if (S.X.has(b3.r)) fail('O15-recovery', `the valid recovery ${b3.r} is in X`)
    const drops = b3.rDrops ?? []
    // at every prefix that holds the recovery and ends with an event the thief posted, and at the final state
    const at = ref.order.indexOf(b3.r)
    const cuts = [
      ref.order.length,
      ...ref.order.map((x, i) => (i > at && b3.thief.includes(x) ? i + 1 : -1)).filter(i => i > 0),
    ]
    for (const n of cuts) {
      const pre = ref.order.slice(0, n)
      const st = n === ref.order.length ? S : withLim(ref.lim, () => evaluate(pre, ref))
      // fix round 5: "never returns" is never live again: revoked, or (an N26 (f) repair's drops) introduced only by
      // records that died meanwhile
      const bad = drops.find(
        v => !st.facts.revoked.has(v) && (st.facts.devs.get(b3.x)?.has(v) ?? false)
      )
      if (bad) {
        fail('O15-recovery', `${bad} dropped by ${b3.r} is live at a prefix of ${n} events`)
        break
      }
      const live = pre.find(id => {
        const e = ref.ev(id)
        return (
          drops.includes(e.dev) &&
          !st.tail.has(id) &&
          !st.X.has(id) &&
          e.t !== 'device_revoke' &&
          e.t !== 'primary_rotate' &&
          e.seq > ((r.c?.seen?.[e.dev] ?? -1) as number)
        )
      })
      if (live) {
        fail('O15-recovery', `${live} of the dropped device ${ref.ev(live).dev} has an effect`)
        break
      }
    }
  }
  // fix round 3 (attack review C2, I1; completeness C1): every valid chain record of the user's carried in the set, by
  // a rotation or a join: the devices of the identity in its carrier's past that the record neither keeps nor certified
  // are not live, and their events outside that past have no effect
  if (!skip && !b3.leaked && userIn && mb?.st === 'protected') {
    const T = chainTree(b3.x, mb.cr!, mb.chain ?? [])
    const onPath = new Set<string>()
    for (const h of T.heads) for (let x: any = h; x; x = x.parent) onPath.add(x.d)
    const introsOf = (v: string) =>
      ref.order.filter(y => {
        const ye = ref.ev(y)
        return (
          ye.a === b3.x &&
          ref.rec(y).depth >= 0 &&
          (ye.t === 'primary_rotate'
            ? [ye.dev, ...((ye.c?.keep ?? []) as string[])]
            : [ye.dev]
          ).includes(v)
        )
      })
    // fix round 5: carriers that count (a carrier in X, such as a stolen later-epoch device's extension of the user's own
    // record that the user's next recovery killed, drops nothing and its watermark is the thief's)
    outer: for (const c of userCarriers.filter(x => !S.X.has(x))) {
      for (const rec of carriedOf(ref.ev(c), b3.x)) {
        const d = recDigest(rec)
        if (!(b3.userRecs ?? []).includes(d) || !onPath.has(d)) continue
        const past = new Set(ref.anc(c))
        const devs = new Set<string>()
        for (const y of past) {
          const ye = ref.ev(y)
          if (ye.a === b3.x && ref.rec(y).depth >= 0)
            for (const v of ye.t === 'primary_rotate'
              ? [ye.dev, ...((ye.c?.keep ?? []) as string[])]
              : [ye.dev])
              devs.add(v)
        }
        for (const v of devs) {
          if ((rec.keep ?? []).includes(v) || v === ref.ev(c).dev) continue
          if (introsOf(v).some(y => ref.rec(y).by === rec.pk)) continue
          if (S.facts.devs.get(b3.x)?.has(v)) {
            fail(
              'O15-recovery',
              `${v} in the past of ${c} (carrying the user's record ${d}) is live`
            )
            break outer
          }
          // fix round 4 (ruling 2): a rotation's watermark may cover more than its past holds (the client's posting at
          // the parents of a leave covers the leave), and what it covers stands
          const ce = ref.ev(c),
            wm = ce.t === 'primary_rotate' ? ((ce.c?.seen?.[v] ?? -1) as number) : -1
          const live = ref.order.find(x => {
            const xe = ref.ev(x)
            return (
              xe.dev === v &&
              !past.has(x) &&
              x !== c &&
              xe.seq > wm &&
              !fixedT(xe.t) &&
              !S.tail.has(x) &&
              !S.X.has(x)
            )
          })
          if (live) {
            fail(
              'O15-recovery',
              `${live} of ${v}, outside the past of ${c} (carrying the user's record ${d}), has an effect`
            )
            break outer
          }
        }
      }
    }
  }
  // fix round 3 (ruling 2; the r8c reviews: attack I1, completeness C1): once a user record is in the set, every live
  // device of the identity is one the latest user record on the head path keeps, or one a primary of that record or of
  // a later one introduced (a certificate, an extension), or the recovering device of an rk-signed carrier it keeps
  if (!skip && !b3.leaked && userIn && mb?.st === 'protected') {
    const recs = new Map<string, any>()
    for (const id of ref.order)
      for (const r of carriedOf(ref.ev(id), b3.x)) recs.set(recDigest(r), r)
    const T = chainTree(b3.x, mb.cr!, mb.chain ?? [])
    const path: any[] = []
    for (let x: any = T.heads[0]; x?.r; x = x.parent) path.unshift(x.r)
    const iu = path.map(r => recDigest(r)).findLastIndex(d => (b3.userRecs ?? []).includes(d))
    if (iu >= 0 && T.heads.length === 1) {
      const allowed = new Set<string>(path[iu].keep ?? [])
      const prims = new Set(path.slice(iu).map(r => r.pk))
      for (const id of ref.order) {
        const e = ref.ev(id)
        if (e.a !== b3.x || ref.rec(id).depth < 0 || S.X.has(id)) continue
        if (prims.has(ref.rec(id).by ?? ''))
          for (const v of e.t === 'primary_rotate'
            ? [e.dev, ...((e.c?.keep ?? []) as string[])]
            : [e.dev])
            allowed.add(v)
      }
      for (const v of S.facts.devs.get(b3.x) ?? [])
        if (!allowed.has(v)) {
          fail(
            'O15-recovery',
            `${v} is live, though the user's latest record ${recDigest(path[iu])} neither keeps nor certified it`
          )
          break
        }
    }
  }
  // O15-thief: the thief's records, upgrades and devices once a user record is in the set (fix round 3, the r8c
  // completeness review I7: whenever the identity is protected, not only after an admitted recovery)
  if (!skip && userIn && mb?.st === 'protected') {
    const afterUser = (t: string) =>
      userCarriers.some(c => ref.anc(t).has(c) || (!ref.anc(c).has(t) && c !== t))
    for (const t of b3.thief) {
      const te = ref.ev(t)
      if (te.t === 'upgrade' && ref.admitted(t) && afterUser(t) && S.facts.upgraded.includes(t))
        fail('O15-thief', `the thief's upgrade ${t} freezes the server after the recovery`)
      if (!ref.admitted(t) || S.X.has(t) || S.tail.has(t)) continue
      if (!afterUser(t)) continue
      if (
        (te.t === 'primary_rotate' ||
          te.t === 'device_revoke' ||
          te.t === 'device_add' ||
          (te.t === 'join' && ref.rec(t).depth >= 0)) &&
        (te.c?.by === undefined || thiefKey(te.c.by))
      )
        fail('O15-thief', `thief record ${t} has an effect after the recovery`)
    }
    for (const d of b3.thiefDevs ?? [])
      if (S.facts.devs.get(b3.x)?.has(d) ?? false)
        fail('O15-thief', `the thief's device ${d} is live after the recovery`)
  }
  // fix round 4 (rulings 1 and 2; r8d attack review C1, C2): the templates that model the client's posting obligation in
  // an upgraded S and in a server the identity left (b3-upgrade's old-phrase shapes, b3-left) check the end-to-end claim:
  // once the user recovered or reset, nothing the thief posted counts in the final state (in X or in Tail), its upgrades
  // included, and the thief's devices are not live, whether or not the user's record reached the set. The client step is
  // what makes it reach: ACL_GEN_NOUPGROT and ACL_GEN_NOLEFT turn it off, and then this fails. Upgraded is not required to
  // hold: a leaked old phrase of a genesis owner can undo an earlier transfer (the stated cost, G7)
  if (b3.e2e) {
    for (const t of b3.thief) {
      // fix round 5: an introduction of the identity the user's posting adopts (the older-epoch bullet positions its
      // rotation at it, so the identity's membership rests on it with the user's devices) is the identity's from then on
      if (!ref.admitted(t) || (b3.adopted ?? []).includes(t)) continue
      const te = ref.ev(t)
      if (te.t === 'upgrade') {
        if (S.facts.upgraded.includes(t)) {
          fail('O15-thief', `the thief's upgrade ${t} counts`)
          break
        }
        continue
      }
      if (!S.X.has(t) && !S.tail.has(t)) {
        fail('O15-thief', `the thief's ${te.t} ${t} counts`)
        break
      }
    }
    for (const d of b3.thiefDevs ?? [])
      if (S.facts.devs.get(b3.x)?.has(d) ?? false) {
        fail('O15-thief', `the thief's device ${d} is live`)
        break
      }
  }
  // fix round 4 (ruling 2; r8d attack review C2): in a server the identity left or was removed from, its leave or removal
  // stays in force: the identity is no member at the end (frozen or not), whatever the thief posted before or after
  if (b3.leftOut && S.facts.mem.has(b3.x))
    fail('O15-recovery', `${b3.x} left (or was removed), but is a member again`)
  // fix round 5 (restart): after the client's N26 (f) repair, what its dead record had cut is cut again (mutant
  // `cl-n26f-heads`: a repair on the trusted heads covers those events with its own watermark, so they count)
  for (const id of b3.stillCut ?? [])
    if (ref.admitted(id) && !S.tail.has(id) && !S.X.has(id)) {
      fail(
        'O15-recovery',
        `${id}, cut by the user's record before a stolen primary's carrier killed it, counts after the client's repair`
      )
      break
    }
  // fix round 5 (restart): the user's own clients never freeze the identity: without a leaked phrase there are no rival
  // resets (a reset is refused on a device that didn't fetch the identity's head; mutant `cl-reset-unfetched`)
  if (
    !b3.leaked &&
    !b3.legacy &&
    !(b3.thiefKeys ?? []).some(k => k.startsWith('rk')) &&
    mb?.void === 'chain'
  )
    fail(
      'O15-void',
      `${b3.x} is frozen, though no phrase leaked: the user's own records are rivals`
    )
  // fix round 5 (restart): where the user's client joined or rejoined, the identity is a member once the template's
  // events are in, unless it is frozen there (§1.7: after an older-epoch rotation that killed the thief's introduction
  // "the identity stays a member"; the user's own rejoin of a server on its list)
  if (b3.memberAt !== undefined) {
    const pre = ref.order.slice(0, b3.memberAt)
    const st = b3.memberAt >= ref.order.length ? S : withLim(ref.lim, () => evaluate(pre, ref))
    if (!st.facts.mem.has(b3.x) && st.BD?.get(b3.x)?.void !== 'chain')
      fail(
        'O15-join',
        `${b3.x}'s client joined here, but the identity is no member after the template's ${b3.memberAt} events`
      )
  }
  // fix round 5 (the controller's ruling 1): properties over the client model (client.ts), on every template that drives
  // its postings through it.
  // O15-link: a posting always has a link: every posting the client made or tried was carried by a link an up-to-date
  // member gave the poster's session (§3.7; a refused delivery is never a posting)
  for (const p of b3.postings ?? [])
    if (!p.delivered) {
      fail('O15-link', `the client's ${p.t} (${p.bullet}) from ${p.dev || 'no device'} had no link`)
      break
    }
  // and the links give nothing §3.7 forbids: no push link for a device the user lost that presents the user's records,
  // and nothing over a push link but the identity's rotations and joins carrying them (client.ts `deliver`)
  for (const p of b3.postings ?? [])
    if (p.flaw) {
      fail('O15-link', `at the client's ${p.t} (${p.bullet}): ${p.flaw}`)
      break
    }
  // O15-keepup: the client's own posting never makes an upgrade the user signed inert, outside the leaked-phrase cost
  // (r8e attack review I1: at the parents of a leave made before the transfer it would kill the user's own signature)
  // Read at the end of the template (`keepUpAt` events), as `launder` and `memberAt` are: the random phase after it may
  // void or freeze another owner whose signature the upgrade carries (an `ik`-signed record of a protected co-owner, a
  // world that can't exist; rival resets of its key), which is no doing of the user's posting (the first official forced
  // range of this round, seed 82,005,714)
  if (!b3.leaked && (b3.keepUp ?? []).length) {
    const st =
      b3.keepUpAt === undefined || b3.keepUpAt >= ref.order.length
        ? S
        : withLim(ref.lim, () => evaluate(ref.order.slice(0, b3.keepUpAt), ref))
    for (const u of b3.keepUp ?? [])
      if (!st.facts.upgraded.includes(u)) {
        fail('O15-keepup', `the user's own posting made the upgrade ${u} it signed inert`)
        break
      }
  }
  // O15-left: no act of a device the posting dropped, after the leave or removal the client recorded, counts (r8e attack
  // review C2: a posting at the identity's latest leave, or on the heads, leaves the thief's rejoin, acts and transfer
  // counting). The dropped devices: those the client's rotations drop in the final state (concurrent introductions
  // included, at -1), and those its rotation dropped at its position
  if (b3.leftAt && ref.admitted(b3.leftAt)) {
    const E = b3.leftAt,
      pastE = ref.anc(E)
    const drops = new Set(b3.leftDrops ?? [])
    for (const p of b3.postings ?? [])
      if (p.id && p.t === 'primary_rotate' && ref.admitted(p.id) && !S.X.has(p.id))
        for (const v of droppedBy(ref.ev(p.id), ref.order, ref)) drops.add(v)
    for (const id of ref.order) {
      const e = ref.ev(id)
      if (e.a !== b3.x || !drops.has(e.dev) || id === E || pastE.has(id)) continue
      const counts =
        e.t === 'upgrade' ? S.facts.upgraded.includes(id) : !S.X.has(id) && !S.tail.has(id)
      if (counts) {
        fail(
          'O15-left',
          `${id} of ${e.dev}, a device the posting dropped, after the recorded ${ref.ev(E).t} ${E}, counts`
        )
        break
      }
    }
  }
  // the disowning flow (fix round 3, the r8c completeness review I7 point 5; mutant `b3-epoch-rk`): a revocation signed
  // by the recovery key at an old position stands unless the set holds a key change of that key
  if (b3.disown && ref.admitted(b3.disown) && mb?.st === 'protected') {
    const r = ref.ev(b3.disown)
    const kc = ref.order.some(id =>
      carriedOf(ref.ev(id), b3.x).some(x => x.rk !== undefined && x.by === r.c.by)
    )
    if (!kc) {
      if (S.X.has(b3.disown))
        fail(
          'O15-recovery',
          `the disowning revocation ${b3.disown} signed by the recovery key is in X`
        )
      const live = ref.order.find(x => {
        const xe = ref.ev(x)
        return (
          xe.dev === r.c.dev && xe.seq > r.c.seen && !fixedT(xe.t) && !S.tail.has(x) && !S.X.has(x)
        )
      })
      if (live)
        fail('O15-recovery', `${live} past the disowning revocation's watermark has an effect`)
    }
  }
}

/**
 * O16-checkpoint (fix round 2, r8b review M5 (c)): on every fourth rules-3 case with a creation record, a transfer signed
 * by a live device of the genesis author is accepted, adopted with the shown state and the evaluation over the restored
 * admission states equal to the replica's, and background verification agrees.
 */
export function checkpointCheck(cs: Case, fail: (prop: string, detail: string) => void) {
  const ref = cs.w.ref
  if (!ref.order.length || cs.seed % 4 !== 0) return
  const g = ref.ev(ref.order[0])
  if (
    (g.c?.rules ?? 2) !== 3 ||
    !ref.order.some(
      id => recoveryKeyOf(ref.ev(id)) !== undefined || Object.keys(g.c?.rks ?? {}).length
    )
  )
    return
  const S = ref.state()
  const dev = [...(S.facts.devs.get(g.a) ?? [])].filter(d => !S.facts.revoked.has(d)).sort()[0]
  if (!dev) return
  oracleStats.cpCases++
  const T = makeTransfer(ref, dev, g.a, undefined, ids => ref.evalSet(ids))
  const ck = checkTransfer(T)
  if (!ck.ok) {
    fail('O16-checkpoint', `transfer refused: ${ck.why}`)
    return
  }
  let ad: Adopted
  try {
    ad = new Adopted(T, ref.lim)
  } catch (e) {
    fail('O16-checkpoint', `adoption: ${(e as Error).message}`)
    return
  }
  const want = evalSummary(S)
  if (ad.shownSummary() !== want) {
    fail('O16-checkpoint', 'the shown state differs')
    return
  }
  if (evalSummary(ad.state()) !== want) {
    fail('O16-checkpoint', 'the evaluation over the restored states differs')
    return
  }
  if (!verify(ad, T.events, T).ok)
    fail('O16-checkpoint', `verification refuted an honest transfer (${ad.report?.id})`)
}

/**
 * O14-version (revision 8, §1.2): a client that knows only rules version 2 evaluates a rules-2 server exactly as this
 * one does, and a rules-3 server not at all: every event is stored unchecked (`U`), nothing is admitted or refused, so
 * it shows the read-only "update needed" state and never a wrong one.
 */
export function versionCheck(cs: Case, rng: Rng, fail: (prop: string, detail: string) => void) {
  const { w } = cs,
    ref = w.ref
  const g = w.all.find(e => e.t === 'genesis')
  const rules = g?.c?.rules ?? 2
  const old = new Replica({ rules: [2] })
  for (const e of rng.shuffle(w.all)) old.receive(e)
  if (rules === 2) {
    for (const e of w.all)
      if (JSON.stringify(old.status.get(e.id)) !== JSON.stringify(ref.status.get(e.id))) {
        fail('O14-version', `rules 2: ${e.id} differs on an older client`)
        return
      }
    if (evalSummary(old.state()) !== evalSummary(ref.state()))
      fail('O14-version', 'rules 2: state differs on an older client')
  } else {
    if (old.order.length)
      fail('O14-version', `rules ${rules}: an older client admitted ${old.order.length} events`)
    for (const e of w.all)
      if (old.status.get(e.id)?.s !== 'U') {
        fail(
          'O14-version',
          `rules ${rules}: ${e.id} is ${JSON.stringify(old.status.get(e.id))} on an older client`
        )
        return
      }
  }
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
  const bound = new Set<string>()
  for (const x of [...ids, ...ghosts]) {
    const e = cx.ev(x)
    if (recoveryKeyOf(e) !== undefined) bound.add(e.a)
    if (e.t === 'genesis') for (const o of Object.keys(e.c?.rks ?? {})) bound.add(o)
  }
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
      // revision 7: a candidate only by pool evidence stays stored. Revision 8 (§2.5): the protection rules are not
      // monotone everywhere (key death can kill a valid rotation, and then the epoch primaries after it change), so an
      // event of a protected identity is dropped only when it is past its own device's fork point (F only falls)
      // (mutant `b3-drop`: dropped by any candidacy)
      if (MUT !== 'pool-drop' && !candidate(id, cx, st.F, st.FI, st.X, st.RF)) continue
      if (MUT !== 'b3-drop' && bound.has(e.a) && e.seq < (full.F.get(e.dev) ?? Infinity)) continue
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
/** Devices an in-force primary_rotate drops (§3.9), written independently of model.ts. Fix round 3 (ruling 2): a
 * rotation in keep for its single chain head doesn't drop what a concurrent sibling in `order` (in keep for the same
 * head) introduces or keeps. */
function droppedP(r: Ev, order: string[], cx: Ctx): Set<string> {
  const keep = new Set<string>([r.dev, ...((r.c?.keep ?? []) as string[])])
  const kept = (e: Ev) => {
    const h = cx.rec(e.id)?.head1
    return (
      !!h &&
      h.keep.length <= LIM.devCap &&
      h.keep.includes(e.dev) &&
      ((e.c?.keep ?? []) as string[]).every(v => h.keep.includes(v))
    )
  }
  const h1 = cx.rec(r.id)?.head1
  if (h1 && (r.t as string) === 'primary_rotate' && kept(r))
    for (const id of order) {
      const y = cx.ev(id)
      if (
        id === r.id ||
        y.a !== r.a ||
        (y.t as string) !== 'primary_rotate' ||
        cx.anc(id).has(r.id) ||
        cx.anc(r.id).has(id)
      )
        continue
      if (cx.rec(id)?.head1?.d !== h1.d || !kept(y)) continue
      keep.add(y.dev)
      for (const v of (y.c?.keep ?? []) as string[]) keep.add(v)
    }
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
  // revision 8 (C3): every check runs under the case's per-server limits (its genesis)
  return withLim(cs.w.ref.lim, () => checkCase0(cs, o))
}
function checkCase0(
  cs: Case,
  o: { prefix?: boolean; replicas?: number; admissionSamples?: number } = {}
): Fail[] {
  const { w } = cs
  // O14-limits (revision 8, fix round 1; r8 review M2, M7): a rules-3 genesis with an unknown `limits` key or a value
  // outside its range is refused and nothing of the server is admitted; a rules-2 genesis's `limits` field is unread
  {
    const g0 = w.all.find(e => e.t === 'genesis')!
    const L = g0.c?.limits,
      rules = g0.c?.rules ?? 2
    // fix round 2 (r8b review I5): own keys only, and a present `limits` must be a JSON object
    const bad =
      rules === 3 &&
      L !== undefined &&
      (L === null ||
        typeof L !== 'object' ||
        Array.isArray(L) ||
        Object.entries(L).some(([k, v]) => {
          const r = Object.hasOwn(LIM_RANGE, k) ? LIM_RANGE[k] : undefined
          return !r || typeof v !== 'number' || v < r[0] || v > r[1]
        }))
    const fails0: Fail[] = []
    if (bad && w.ref.admitted(g0.id))
      fails0.push({
        prop: 'O14-limits',
        detail: 'a genesis with an unknown key or a value outside its range was admitted',
      })
    if (rules === 2 && w.ref.lim !== undefined)
      fails0.push({ prop: 'O14-limits', detail: "a rules-2 genesis's limits were read" })
    if (!w.ref.admitted(g0.id)) {
      if (w.ref.order.length)
        fails0.push({ prop: 'O14-limits', detail: 'events admitted without a genesis' })
      return fails0
    }
    if (fails0.length) return fails0
  }
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
  // fix round 3 (ruling 3): a frozen identity's removals (rival resets, read from the independent oracle) keep their cuts
  // whatever their own effect, unless past their own device's fork point
  const frozenP = new Set<string>()
  for (const [a, o] of protectionOracle(ref, order)) if (o.why === 'chain') frozenP.add(a)
  const revs = order.filter(
    r =>
      (ref.ev(r).t === 'device_revoke' || (ref.ev(r).t as string) === 'primary_rotate') &&
      (!final.X.has(r) ||
        (frozenP.has(ref.ev(r).a) && ref.ev(r).seq < (final.F.get(ref.ev(r).dev) ?? Infinity)))
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
  // fix round 5 (the controller's ruling 6; r8e attack review I5): Holds recomputed from §3.2's sentence, both ways: a
  // role is held exactly through a live assign with every effective revoke of it and every effective kick, ban or leave
  // of its target in its past, whose target is a member and one of whose target's latest joins in the assign's past
  // (those no other join of the target there follows; the genesis for its author) is live
  {
    const want = new Set<string>()
    const effOf = order.filter(id => final.eff.has(id)).map(id => ref.ev(id))
    const joins = order.map(id => ref.ev(id)).filter(e => e.t === 'join' || e.t === 'genesis')
    for (const id of order) {
      const g = ref.ev(id)
      if (g.t !== 'assign' || !live(final, id)) continue
      const T = g.c.to,
        R = g.c.role,
        past = ref.anc(id)
      if (!final.facts.mem.has(T) || !final.facts.roles.has(R)) continue
      const ended = effOf.some(
        r =>
          !past.has(r.id) &&
          ((r.t === 'revoke' && r.c.to === T && r.c.role === R) ||
            ((r.t === 'kick' || r.t === 'ban') && r.c.to === T) ||
            (r.t === 'leave' && r.a === T))
      )
      if (ended) continue
      const js = joins.filter(j => j.a === T && past.has(j.id))
      if (js.some(j => live(final, j.id) && !js.some(j2 => j2 !== j && ref.anc(j2.id).has(j.id))))
        want.add(`${T}:${R}`)
    }
    const got = new Set<string>()
    for (const [T, rs] of final.facts.holds) for (const R of rs) got.add(`${T}:${R}`)
    for (const x of want)
      if (!got.has(x)) {
        fail('O4-holds', `${x} should be held (a live assign in the membership it was given in)`)
        break
      }
    for (const x of got)
      if (!want.has(x)) {
        fail(
          'O4-holds',
          `${x} is held, but no live assign gave it in a membership that still counts`
        )
        break
      }
  }

  // consistency: an effective deny is never void; every tail op is cut
  // fix round 3 (ruling 3): a frozen identity's removal is in force for its cut while its grant part is inert (in X)
  for (const d of final.eff)
    if (final.void.has(d) && !(frozenP.has(ref.ev(d).a) && revs.includes(d))) fail('C-effvoid', d)
  for (const t of final.tail) if (!final.cut.has(t)) fail('C-tail', t)
  for (const id of order)
    if (!fixed(id) && tailOfP(id).length && !final.tail.has(id))
      fail('C-tail', `${id} missing from Tail`)
  // fix round 3: the revoked and dropped devices are those of the revocations in force (recomputed here)
  {
    const exp = new Set<string>()
    for (const r of revs) {
      const re = ref.ev(r)
      if (re.t === 'device_revoke') exp.add(re.c.dev)
      else for (const v of droppedP(re, nonX, ref)) exp.add(v)
    }
    const got = final.facts.revoked
    const diff = [...exp].find(v => !got.has(v)) ?? [...got].find(v => !exp.has(v))
    if (diff !== undefined)
      fail(
        'C-revoked',
        `${diff}: revoked ${got.has(diff)}, by the revocations in force ${exp.has(diff)}`
      )
  }
  // fix round 3: and every Tail event is past the watermark of a revocation in force (recomputed here)
  for (const id of final.tail)
    if (!tailOfP(id).length) {
      fail('C-tail', `${id} in Tail without a revocation that reaches it`)
      break
    }

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
        // revision 8 fix round 2: a protected identity's primary and recovery key are its chain head's, so for it the
        // rotation installs a primary or changes the key exactly when it brings a chain record its position lacks
        const protP =
          (ref.ev(order[0])?.c?.rules ?? 2) === 3 && r.local.BD?.get(e.a)?.st === 'protected'
        const knownD = new Set(B.flatMap(x => carriedOf(ref.ev(x), e.a)).map(recDigest))
        const brings = carriedOf(e, e.a).some(x => !knownD.has(recDigest(x)))
        const changes =
          [...liveD].some(v => !keep.has(v)) ||
          !liveD.has(e.dev) ||
          (protP ? brings : String(e.c?.pcert ?? '') !== pc) ||
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
      // O12: after an upgrade only leave, and (rules 3, fix round 4, ruling 1) a rotation of an identity protected there
      // that carries a chain record its position lacks; every upgrade countersigned by every other genesis owner
      if (St.upgraded.length && e.t !== 'leave') {
        const known = new Set(B.flatMap(x => carriedAll(ref.ev(x), e.a)).map(recDigest))
        const okRot =
          (e.t as string) === 'primary_rotate' &&
          (ref.ev(order[0])?.c?.rules ?? 2) === 3 &&
          r.local.BD?.get(e.a)?.st === 'protected' &&
          carriedOf(e, e.a).some(x => !known.has(recDigest(x)))
        if (!okRot) fail('O12-frozen', id)
      }
      if (
        e.t === 'upgrade' &&
        ![...St.owners].every(
          o =>
            o === e.a ||
            (Array.isArray(e.c.sigs ?? [])
              ? (e.c.sigs ?? []).includes(o)
              : Object.hasOwn(e.c.sigs, o))
        )
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
    // revision 8 (fuzz range N, seed 13817876; present in revision 7c): so does any deny that cut a create in a chain
    // head's admission state and later falls into X (an owner's leave from a device that forks afterwards): count the
    // roles live finally but not live in the St of a later create of their chain
    const revived = new Set<string>()
    for (const h of heads)
      for (const r of final.facts.roles)
        if (ref.anc(h).has(r) && !ref.rec(h).local.facts.roles.has(r)) revived.add(r)
    const undone =
      order.filter(id => ref.ev(id).t === 'role_del' && !final.eff.has(id)).length + revived.size
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
  // revision 8: honest concurrency makes no pool candidate only while the pool holds about twice every live device's
  // unacknowledged budget (the defaults: model 30 ≥ 1.25 × 2 × 12, production 384 = 2 × 8 × 24, the production range's
  // joint constraint); with drawn limits below that margin, honest pool candidates are expected (§4.1, §7.7 revision 8)
  const tightPool = LIM.poolU < 2 * LIM.devCap * LIM.totU && LIM.poolU < LIM_BASE.poolU
  // revision 8 fix round 1 (§2.5): epoch and key death make an honest identity record inert when it is concurrent with
  // a later record of its own protected identity (two of its devices acted without seeing each other; the client
  // signs it again under the new primary), and what an inert rotation's epoch built is contested. Fix round 2 (r8b
  // review M2): only a record the independent oracle finds inert is excused, and its epoch's identity ops
  const PO = (ref.ev(order[0])?.c?.rules ?? 2) === 3 ? protectionOracle(ref, order) : new Map()
  const deathX = (x: string, depth = 0): boolean => {
    const e = ref.ev(x)
    if (PO.get(e.a)?.st !== 'protected' || depth > 8) return false
    if (PO.get(e.a)!.inert.has(x)) return true
    const ep = ref.rec(x)?.epoch
    return !!ep && ep !== x && final.X.has(ep) && deathX(ep, depth + 1)
  }
  const honestX = [...final.X].filter(x => !(tightPool && final.PC?.has(x)) && !deathX(x))
  if (!cs.equivocation && honestX.length) fail('O7-honest', `X=${honestX}`)
  {
    // evidence pairs (device and identity): they define F and FI, so they are never dropped
    const pairs = evidencePairs(order, final, ref)
    // O7-absent: X events outside the evidence pairs that no non-X event depends on have no effect at all.
    // revision 8 (§2.5, N25): an identity with a creation record keeps its events unless they are past their device's
    // fork point (protection is not monotone: a creation record can become void, a record can die by key or epoch
    // death). Fix round 2: owners no longer (no settlement views)
    const boundO = new Set<string>()
    for (const id of order) {
      const e = ref.ev(id)
      if (recoveryKeyOf(e) !== undefined) boundO.add(e.a)
      if (e.t === 'genesis' && (e.c?.rules ?? 2) === 3)
        for (const o of Object.keys(e.c?.rks ?? {})) boundO.add(o)
    }
    const keptB = (x: string) =>
      (ref.ev(ref.order[0])?.c?.rules ?? 2) === 3 &&
      boundO.has(ref.ev(x).a) &&
      ref.ev(x).seq < (final.F.get(ref.ev(x).dev) ?? Infinity)
    const xt = new Set(
      [...final.X].filter(
        x =>
          ref.ev(x).t !== 'upgrade' &&
          !pairs.has(x) &&
          !keptB(x) &&
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
      // revision 8 (§2.5, N25): an identity with a creation record keeps its candidates by identity or rotation evidence
      // stored (only device-forked events are dropped), so the shape checks below apply to identities without one
      const boundA = new Set<string>()
      for (const id of order) {
        const e = ref.ev(id)
        if (recoveryKeyOf(e) !== undefined) boundA.add(e.a)
        if (e.t === 'genesis') for (const o of Object.keys(e.c?.rks ?? {})) boundA.add(o)
      }
      for (const a of new Set([...byA.keys(), ...hdrA.keys()])) {
        if (boundA.has(a)) continue
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
    // revision 8 (§2.5): inert records (rotations and certificates signed by a key their position no longer allows,
    // revocations of an earlier epoch) are never clean
    const inertP = new Set<string>()
    for (const o of protectionOracle(ref, order).values()) for (const x of o.inert) inertP.add(x)
    const recCleanP = (r: Ev) =>
      !inertP.has(r.id) &&
      (((r.t as string) === 'primary_rotate' && !RFp.has(r.id)) ||
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
          })))
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
            !inertP.has(rid) &&
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
          // O7-growth: only events of the new event's identity, or of devices/identities already forked, enter X. Fix
          // round 3: a rules-3 upgrade is also an event of every owner whose signature it carries (each is a record of
          // that owner, §3.8), both ways: an owner's `ik` signature in another owner's upgrade voids that owner's
          // creation record as its own record would (fuzz ranges A and B, seeds 93012829 and 94000317), and an owner's
          // recovery kills its own signature in an upgrade by epoch death (range C, seed 96026777)
          const idsOf = (id: string) =>
            ref.ev(id).t === 'upgrade'
              ? [ref.ev(id).a, ...Object.keys(ref.rec(id)?.sigBy ?? {})]
              : [ref.ev(id).a]
          const own = new Set(idsOf(eid))
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
            if (!prev.X.has(id) && cur.X.has(id) && !idsOf(id).some(a => own.has(a)) && !already)
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
            // O5-senior: nothing at stratum ke changes an op whose (effective) stratum is above ke. Fix round 2 (b3-legacy seed
            // 50500097, present in r7c): a revocation or rotation is its identity's own self-deny, and its tail cuts that
            // identity's own events at their own strata (§3.1 step 0, [H2]); when it removes the identity's membership, a
            // deny that targets the identity can take effect (a ban of a non-member is authorized), as after a leave. That
            // change is the identity's own act, not a junior's decision about another member
            const ks = isD(id) || fixed(id) ? k(id) : kstar(id, ref, prevAbove, prevHigh)
            const selfReach =
              isRev(e) &&
              (e.t === 'primary_rotate' || e.t === 'device_revoke') &&
              ref.ev(id).c?.to === e.a &&
              isD(id)
            if (
              cmp(ks, ke) > 0 &&
              !selfReach &&
              (wasLive !== isLive || prev.eff.has(id) !== cur.eff.has(id))
            ) {
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
  versionCheck(cs, rng, fail)
  protectionChecks(cs, fail)
  checkpointCheck(cs, fail)
  if (stats.worldsOverClean > wo0)
    fail(
      'O5-worlds',
      `${stats.worldsOverClean - wo0} exact-branch strata without X ops in Fl tested an op in more than 2^classes + 1 projected worlds (max ${stats.maxOpWorlds})`
    )
  return fails
}
