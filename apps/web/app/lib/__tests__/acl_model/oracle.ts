/* eslint-disable */
// @ts-nocheck
// Copy of notes/acl-model/oracle.ts (the executable reference model of the P2P ACL spec), used only by the differential tests.
// Exact G5 oracle inside a stratum (spec §3.1 "G5 inside a stratum", §7.1 O5-exact / O5-safe / O5-complete).
//
// Written independently of model.ts's step 4: it shares only the primitives facts(), view(), authorizeFull(), rank()
// and target() (as props.ts does), and recomputes direct cuts, exposure and the cascade from the definitions.
//
// Definition (G5 inside a stratum kk with causes Γ). For a set of causes T ⊆ Γ, `T alone` cuts op x iff
//   x is a direct cut of some cause in T (steps 0–3), or
//   x is alive at kk, not already broken under the cuts K of the strata above, T ∩ U(x) ≠ ∅, and x is broken, with
//   k*(x) < kk, under K plus the ops y ∈ B(x) that T ∩ U(x) alone cuts,
// where U(x) is the set of causes x's author is exposed to. An op may be cut at kk only if some T alone cuts it
// (O5-safe), and everything Γ alone cuts must be cut (O5-complete). The production rule (model.ts cascadeExact) also
// requires the ops it counts to be cut in the result; that variant is F1' below and must equal the model's cut set
// exactly (O5-exact). Every T is enumerated: the cost is 2^|Γ| per stratum, so strata with more than `bound` causes are
// skipped and counted.
//
// Revision 5 ([R4V C1]): authority is monotone (model.ts `authorizedIn`, `monoCtx`): the oracle shares that primitive and
// the resource rank `monoCtx(...).me` for k*. It checks the monotonicity itself (O5-mono): for sampled N ⊆ N' of ops in
// an op's past, broken under N implies broken under N' and k* under N' is at most k* under N; and, on enumerated strata,
// x ∈ C_T implies x ∈ C_{T ∪ {γ}} (adding causes never un-cuts). Strata above the enumeration bound are checked lazily
// (M1): C_Γ by memoized recursion over the worlds that arise, plus sampled pairs T ⊂ T ∪ {γ}.
import {
  type Ctx,
  type Ev,
  type EvalResult,
  type Facts,
  type Rank,
  authorizedIn,
  cmp,
  facts,
  gt,
  minR,
  monoCtx,
  perms,
  rank,
  target,
  view,
  KICK,
  LIM,
} from './model'

export type OFail = { prop: string; detail: string }
export interface OracleOut {
  fails: OFail[]
  strata: number
  checked: number
  skipped: number
  maxCauses: number
  subsets: number
  fallback: number
  workFallback: number
  lazy: number
  monoTests: number
}

/** Deterministic sampler (the oracle must not depend on Math.random). */
function lcg(seed: number) {
  let s = seed >>> 0 || 1
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0
    return s / 4294967296
  }
}

const isRev = (e: Ev) => e.t === 'device_revoke' || (e.t as string) === 'primary_rotate'
const isFixed = (e: Ev) => e.t === 'genesis' || isRev(e)
const isWithdrawal = (e: Ev) => e.t === 'uninvite' || e.t === 'code_revoke'
const frontier = (o: string, d: string, cx: Ctx) =>
  o !== d && !cx.anc(d).has(o) && !(cx.anc(o).has(d) && cx.rec(o).local.eff.has(d))
const kstar = (o: string, cx: Ctx, K: Set<string>, high: Set<string>, N?: string[]): Rank =>
  cx.rec(o).cls === 'D'
    ? cx.rec(o).k
    : N === undefined
      ? minR(
          cx.rec(o).k,
          rank(view(o, cx, K, [...high].filter(d => frontier(o, d, cx)).sort()), cx.ev(o).a)
        )
      : minR(cx.rec(o).k, monoCtx(o, cx, K, N, [...high].filter(d => frontier(o, d, cx)).sort()).me)
function exposed(p: Ev, g: Ev, cx: Ctx, V: Facts, kk: Rank) {
  if (V.owners.has(p.a)) return false
  const r = rank(V, p.a)
  if (isRev(g)) return !gt(r, kk)
  if (p.t === 'join') {
    if (isWithdrawal(g) && !(perms(cx.rec(g.id).local.facts, g.a) & KICK)) return false
    return cmp(r, kk) < 0
  }
  return !gt(r, kk)
}
function dropped(r: Ev, order: string[], cx: Ctx): Set<string> {
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

export function g5Oracle(
  cx: Ctx,
  order: string[],
  final: EvalResult,
  bound = 8,
  o: { monoSamples?: number; lazyBudget?: number } = {}
): OracleOut {
  const out: OracleOut = {
    fails: [],
    strata: 0,
    checked: 0,
    skipped: 0,
    maxCauses: 0,
    subsets: 0,
    fallback: 0,
    workFallback: 0,
    lazy: 0,
    monoTests: 0,
  }
  const rnd = lcg(order.length * 7919 + 17)
  const monoSamples = o.monoSamples ?? 2
  const lazyBudget = o.lazyBudget ?? 20000
  const k = (id: string) => cx.rec(id).k
  const isD = (id: string) => cx.rec(id).cls === 'D'
  const topo = [...order].sort((x, y) => cx.anc(x).size - cx.anc(y).size || (x < y ? -1 : 1))
  // revocations in force and their tails (recomputed)
  // revision 5 ([H17]): a rotation can be in X (rotation evidence); in force only outside X, and it drops only devices
  // that a non-X event introduces
  const revs = order.filter(
    r =>
      (cx.ev(r).t === 'device_revoke' || (cx.ev(r).t as string) === 'primary_rotate') &&
      !final.X.has(r)
  )
  const orderNX = order.filter(x => !final.X.has(x))
  const tailOf = new Map<string, string[]>()
  for (const r of revs) {
    const re = cx.ev(r)
    const marks =
      re.t === 'device_revoke'
        ? [{ dev: re.c.dev as string, seen: re.c.seen as number }]
        : [...dropped(re, orderNX, cx)].map(v => ({
            dev: v,
            seen: (re.c.seen?.[v] ?? -1) as number,
          }))
    for (const { dev, seen } of marks)
      for (const o of order) {
        const oe = cx.ev(o)
        if (oe.dev !== dev || oe.seq <= seen || isFixed(oe)) continue
        if (!tailOf.has(o)) tailOf.set(o, [])
        if (!tailOf.get(o)!.includes(r)) tailOf.get(o)!.push(r)
      }
  }
  const strataM = new Map<string, Rank>()
  for (const [, s] of final.cut) strataM.set(`${s[0]}/${s[1]}`, s)
  for (const d of final.eff) if (!isFixed(cx.ev(d))) strataM.set(`${k(d)[0]}/${k(d)[1]}`, k(d))
  for (const o of tailOf.keys()) strataM.set(`${k(o)[0]}/${k(o)[1]}`, k(o))
  const strata = [...strataM.values()].sort((a, b) => cmp(b, a))

  for (const kk of strata) {
    out.strata++
    const K = new Set([...final.cut.entries()].filter(([, s]) => cmp(s, kk) > 0).map(([x]) => x))
    const high = new Set([...final.eff].filter(d => cmp(k(d), kk) > 0 || isRev(cx.ev(d))))
    const voidK = new Set([...final.X, ...K, ...final.tail])
    const alive = (o: string) => !K.has(o) && !isFixed(cx.ev(o))
    const ksM = new Map<string, Rank>()
    const ks = (o: string) => {
      let v = ksM.get(o)
      if (!v) ksM.set(o, (v = kstar(o, cx, K, high)))
      return v
    }
    const below = (o: string) => cmp(k(o), kk) < 0 || (!isD(o) && cmp(ks(o), kk) < 0)
    const atOrBelow = (o: string) => cmp(k(o), kk) <= 0 || (!isD(o) && cmp(ks(o), kk) <= 0)
    const auth = (o: string, KK: Set<string>, d?: string) => authorizedIn(o, cx, KK, [], d)
    const VM = new Map<string, Facts>()
    const Vg = (g: string, p?: string) => {
      const hi = [...high].filter(x => !p || !cx.anc(x).has(p)).sort()
      const key = `${g}|${hi.join(',')}`
      let V = VM.get(key)
      if (!V)
        VM.set(
          key,
          (V = facts(
            order.filter(x => !cx.anc(x).has(g)),
            voidK,
            new Set(hi),
            cx,
            final.X
          ))
        )
      return V
    }
    // causes of kk and their direct cuts (steps 0–3, recomputed)
    const causes: string[] = []
    const D = new Map<string, Set<string>>()
    for (const d of [...final.eff].sort()) {
      const de = cx.ev(d),
        rd = cx.rec(d)
      if (isFixed(de) || cmp(k(d), kk) !== 0) continue
      causes.push(d)
      const set = new Set<string>()
      for (const o of order) {
        if (!alive(o) || o === d || !frontier(o, d, cx)) continue
        const oe = cx.ev(o)
        if (rd.self) {
          if (oe.a !== de.a || (isD(o) && cx.rec(o).self) || !atOrBelow(o)) continue
        } else {
          const tg = target(de, rd.local.facts)
          const same = !isD(o) && tg.kind === 'member' && tg.who === oe.a
          if (!(same ? atOrBelow(o) : below(o))) continue
          if (!exposed(oe, de, cx, same ? Vg(d) : Vg(d, o), kk)) continue
        }
        if (auth(o, K) && !auth(o, K, d)) set.add(o)
      }
      D.set(d, set)
    }
    for (const [o, rs] of tailOf) {
      if (!alive(o) || cmp(k(o), kk) !== 0) continue
      for (const r of rs) {
        if (!D.has(r)) {
          D.set(r, new Set())
          causes.push(r)
        }
        D.get(r)!.add(o)
      }
    }
    // causes without direct cuts contribute to no world (and the model leaves them out of Γ, [H16])
    for (let i = causes.length - 1; i >= 0; i--) if (!D.get(causes[i])?.size) causes.splice(i, 1)
    causes.sort()
    const n = causes.length
    out.maxCauses = Math.max(out.maxCauses, n)
    const modelCut = new Set(
      [...final.cut.entries()].filter(([, s]) => cmp(s, kk) === 0).map(([x]) => x)
    )
    if (!n) {
      if (modelCut.size)
        out.fails.push({
          prop: 'O5-exact',
          detail: `cuts at ${kk} without causes: ${[...modelCut]}`,
        })
      continue
    }
    const ALLb = (1n << BigInt(n)) - 1n
    const Dc = new Map<string, bigint>()
    causes.forEach((g, i) => {
      for (const o of D.get(g) ?? []) Dc.set(o, (Dc.get(o) ?? 0n) | (1n << BigInt(i)))
    })
    // the region: ops that are direct cuts or have one in their causal past (nothing else can be cut)
    const region = topo.filter(
      x => alive(x) && (Dc.has(x) || [...Dc.keys()].some(y => cx.anc(x).has(y)))
    )
    const UM = new Map<string, bigint>()
    const U = (p: string) => {
      let m = UM.get(p)
      if (m === undefined) {
        m = 0n
        const pe = cx.ev(p)
        causes.forEach((g, i) => {
          if (exposed(pe, cx.ev(g), cx, Vg(g, p), kk)) m! |= 1n << BigInt(i)
        })
        UM.set(p, m)
      }
      return m
    }
    const bM = new Map<string, boolean>()
    const brokenUnder = (x: string, N: string[]) => {
      const key = `${x}|${N.join(',')}`
      let b = bM.get(key)
      if (b === undefined) {
        b =
          (cmp(k(x), kk) < 0 || (!isD(x) && cmp(kstar(x, cx, K, high, N), kk) < 0)) &&
          !authorizedIn(x, cx, K, N)
        bM.set(key, b)
      }
      return b
    }
    const newlyM = new Map<string, boolean>()
    const newly = (x: string) => {
      let v = newlyM.get(x)
      if (v === undefined) newlyM.set(x, (v = auth(x, K)))
      return v
    }
    const pastOf = (x: string) => region.filter(y => cx.anc(x).has(y))
    // O5-mono, authority (revision 5): more cuts never restore an authority and never raise k*. Sampled N ⊆ N' from the
    // region ops in x's past (cut or not), on every stratum, also those above the enumeration bound.
    for (const x of region) {
      if (!newly(x)) continue
      const past = pastOf(x)
      if (!past.length) continue
      for (let i = 0; i < monoSamples; i++) {
        const big = past.filter(() => rnd() < 0.6)
        const small = big.filter(() => rnd() < 0.5)
        out.monoTests++
        const bS = !authorizedIn(x, cx, K, small),
          bB = !authorizedIn(x, cx, K, big)
        if (bS && !bB)
          out.fails.push({
            prop: 'O5-mono',
            detail: `stratum ${kk}: ${x} broken under [${small}] but not under [${big}]`,
          })
        if (!isD(x) && cmp(kstar(x, cx, K, high, big), kstar(x, cx, K, high, small)) > 0)
          out.fails.push({
            prop: 'O5-mono',
            detail: `stratum ${kk}: k*(${x}) rises from [${small}] to [${big}]`,
          })
      }
    }
    // protection classes are counted among the ops the causes could cut if no author were protected (the flat closure,
    // [H16]); computed here from brokenUnder, independently of model.ts
    const flat = new Set<string>()
    for (const x of region) {
      if (Dc.has(x)) {
        flat.add(x)
        continue
      }
      if (!newly(x)) continue
      const N = pastOf(x).filter(y => flat.has(y))
      if (N.length && brokenUnder(x, N)) flat.add(x)
    }
    // revision 7c (r7 re-review C1): the distinct exposure sets U(x) ∩ Γ⁺ of the flat ops outside X, other than ∅ and
    // Γ⁺, Γ⁺ = the causes with a direct cut on an event outside X (as model.ts; before, every flat op's U unprojected)
    let GP = 0n
    causes.forEach((g, i) => {
      if ([...(D.get(g) ?? [])].some(o => !final.X.has(o))) GP |= 1n << BigInt(i)
    })
    const classes = new Set(
      region
        .filter(x => flat.has(x) && !final.X.has(x))
        .map(x => U(x) & GP)
        .filter(m => m !== 0n && m !== GP)
    ).size
    if (classes > LIM.classes) out.fallback++
    // revision 6: how often the ruled work bound of r5 review I3 (b) (not adopted, §10.16) would send a stratum below the
    // class cap to the fallback: (2^cp + 1) × |Fl \ (X ∪ Tail)|, cp the classes projected onto G(q) over Fl \ X
    {
      const Gm = new Map<string, bigint>()
      for (const q of topo) {
        let g = Dc.get(q) ?? 0n
        for (const p of cx.ev(q).ap) g |= Gm.get(p) ?? 0n
        if (g) Gm.set(q, g)
      }
      const flatNX = region.filter(x => flat.has(x) && !final.X.has(x))
      const cp = new Set(
        flatNX
          .map(x => U(x) & (Gm.get(x) ?? 0n))
          .filter((m, i) => m !== 0n && m !== (Gm.get(flatNX[i]) ?? 0n))
      ).size
      const workO = (2 ** cp + 1) * flatNX.filter(x => !final.tail.has(x)).length
      if (classes <= LIM.classes && cp <= LIM.classes && workO > LIM.work) out.workFallback++
    }
    if (n > bound) {
      // Lazy check (M1): "W alone cuts x" by memoized recursion over the worlds that arise from Γ, independent of the
      // enumeration. With monotone authority, O5-safe and O5-complete reduce to the model's cut set versus C_Γ.
      const memo = new Map<string, boolean>()
      let work = 0
      const inC = (x: string, W: bigint): boolean => {
        if (((Dc.get(x) ?? 0n) & W) !== 0n) return true
        if (!newly(x)) return false
        const Wx = W & U(x)
        if (Wx === 0n) return false
        const key = `${x}|${Wx}`
        let v = memo.get(key)
        if (v !== undefined) return v
        if (++work > lazyBudget) throw new Error('lazy budget')
        const N = pastOf(x).filter(y => inC(y, Wx))
        v = N.length > 0 && brokenUnder(x, N)
        memo.set(key, v)
        return v
      }
      try {
        const exact = new Set(region.filter(x => inC(x, ALLb)))
        out.lazy++
        if (classes > LIM.classes) {
          for (const x of modelCut)
            if (!exact.has(x))
              out.fails.push({
                prop: 'O5-sound',
                detail: `stratum ${kk} (${classes} classes, lazy): ${x} cut by the fallback, kept by the exact rule`,
              })
        } else {
          const sym = [...new Set([...exact, ...modelCut])].filter(
            x => exact.has(x) !== modelCut.has(x)
          )
          if (sym.length)
            out.fails.push({
              prop: 'O5-exact',
              detail: `stratum ${kk} (lazy, ${n} causes): model ${[...modelCut].sort()} vs exact ${[...exact].sort()}`,
            })
        }
        for (const x of modelCut)
          if (!exact.has(x))
            out.fails.push({
              prop: 'O5-safe',
              detail: `${x} cut at ${kk} (lazy, ${n} causes), but the causes its author is exposed to don't cut it`,
            })
        // sampled monotonicity in the cause set: T ⊂ T ∪ {γ}
        for (let i = 0; i < 4; i++) {
          let T = 0n
          for (let j = 0; j < n; j++) if (rnd() < 0.5) T |= 1n << BigInt(j)
          const g = 1n << BigInt(Math.floor(rnd() * n))
          for (const x of region)
            if (inC(x, T) && !inC(x, T | g))
              out.fails.push({
                prop: 'O5-mono',
                detail: `stratum ${kk}: ${x} cut by ${T} but not by ${T | g}`,
              })
        }
      } catch {
        out.skipped++
      }
      continue
    }
    out.checked++
    const ALL = (1 << n) - 1
    const Ui = (p: string) => Number(U(p))
    const Dci = (p: string) => Number(Dc.get(p) ?? 0n)
    // F1: literal "T alone"; F1p: counted ops must also be cut under Γ (the production variant)
    const F1 = new Map<string, Uint8Array>()
    const F1p = new Map<string, Uint8Array>()
    for (const x of region) {
      const a = new Uint8Array(ALL + 1),
        b = new Uint8Array(ALL + 1)
      const dc = Dci(x)
      const nw = newly(x) // a cascade cut needs an op not already broken under the cuts above (newly broken)
      const Bx = pastOf(x)
      for (let T = 1; T <= ALL; T++) {
        if (dc & T) {
          a[T] = 1
          b[T] = 1
          continue
        }
        if (!nw) continue
        const W = T & Ui(x)
        if (!W) continue
        const N = Bx.filter(y => F1.get(y)![W])
        if (N.length && brokenUnder(x, N)) a[T] = 1
        const Np = Bx.filter(y => F1p.get(y)![W] && F1p.get(y)![ALL])
        if (Np.length && brokenUnder(x, Np)) b[T] = 1
      }
      out.subsets += ALL
      F1.set(x, a)
      F1p.set(x, b)
      // O5-mono, cause sets: adding a cause never un-cuts an operation
      for (let T = 1; T <= ALL; T++)
        if (a[T])
          for (let i = 0; i < n; i++)
            if (!a[T | (1 << i)]) {
              out.fails.push({
                prop: 'O5-mono',
                detail: `stratum ${kk}: ${x} cut by causes ${T} but not by ${T | (1 << i)}`,
              })
              T = ALL + 1
              break
            }
    }
    const exact = new Set(region.filter(x => F1p.get(x)![ALL]))
    // protection classes (above): above the cap, the model uses
    // its sound fallback, which must cut a subset of what the exact rule cuts (O5-sound); below, exactly the same
    if (classes > LIM.classes) {
      for (const x of modelCut)
        if (!exact.has(x))
          out.fails.push({
            prop: 'O5-sound',
            detail: `stratum ${kk} (${classes} classes): ${x} cut by the fallback, kept by the exact rule`,
          })
    } else {
      const sym = [...new Set([...exact, ...modelCut])].filter(
        x => exact.has(x) !== modelCut.has(x)
      )
      if (sym.length)
        out.fails.push({
          prop: 'O5-exact',
          detail: `stratum ${kk}: model ${[...modelCut].sort()} vs exact ${[...exact].sort()}`,
        })
    }
    for (const x of modelCut) {
      const a = F1.get(x)
      let some = false
      if (a) for (let T = 1; T <= ALL && !some; T++) some = a[T] === 1
      if (!some)
        out.fails.push({
          prop: 'O5-safe',
          detail: `${x} cut at ${kk}, but no set of causes its author is exposed to cuts it alone`,
        })
    }
    if (classes <= LIM.classes)
      for (const x of region)
        if (F1.get(x)![ALL] && !modelCut.has(x))
          out.fails.push({
            prop: 'O5-complete',
            detail: `${x}: the causes at ${kk} alone cut it, the model keeps it`,
          })
  }
  return out
}
