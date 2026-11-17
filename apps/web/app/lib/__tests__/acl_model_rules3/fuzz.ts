/* eslint-disable */
// @ts-nocheck
// Part of the P2P ACL reference model, used only by tests.
// Brute-force harness. Usage: bun fuzz.ts [cases=1000] [startSeed=1] [workers=1]
// With workers > 1, seeds are split across child processes.
import { genCase } from './gen'
import { checkCase, oracleStats } from './props'
import { stats } from './model'
import { fastStats } from './fast'

const N = Number(process.argv[2] ?? 1000)
const start = Number(process.argv[3] ?? 1)
const workers = Number(process.argv[4] ?? 1)

async function runRange(from: number, n: number) {
  const byProp = new Map<string, number>()
  const firstSeed = new Map<string, string>()
  let failedCases = 0,
    events = 0,
    adv = 0,
    eqv = 0,
    cuts = 0,
    xs = 0,
    effs = 0,
    rejected = 0,
    pcs = 0,
    pcCases = 0,
    rkCases = 0
  const tplCount = new Map<string, number>()
  for (let s = from; s < from + n; s++) {
    const cs = genCase(s)
    const f = checkCase(cs)
    // a genesis the rules refuse leaves an empty server (no state to count)
    const st = cs.w.ref.order.length ? cs.w.state() : undefined
    events += cs.w.ref.order.length
    adv += cs.adversarial.length
    if (cs.equivocation) eqv++
    if (cs.rkCase) {
      rkCases++
      tplCount.set(cs.rkCase.kind, (tplCount.get(cs.rkCase.kind) ?? 0) + 1)
    }
    if (st) {
      cuts += st.cut.size
      xs += st.X.size
      effs += st.eff.size
      pcs += st.PC?.size ?? 0
      if (st.PC?.size) pcCases++
    }
    rejected += cs.w.all.length - cs.w.ref.order.length
    if (f.length) {
      failedCases++
      for (const x of f) {
        byProp.set(x.prop, (byProp.get(x.prop) ?? 0) + 1)
        if (!firstSeed.has(x.prop)) firstSeed.set(x.prop, `seed ${s}: ${x.detail}`)
      }
    }
  }
  const o = oracleStats
  return {
    n,
    failedCases,
    byProp: Object.fromEntries(byProp),
    firstSeed: Object.fromEntries(firstSeed),
    events,
    adv,
    eqv,
    cuts,
    xs,
    effs,
    rejected,
    pcs,
    pcCases,
    oStrata: o.strata,
    oChecked: o.checked,
    oSkipped: o.skipped,
    oMaxCauses: o.maxCauses,
    oSubsets: o.subsets,
    oFallback: o.fallback,
    oWorkFallback: o.workFallback,
    fastHeaderSets: o.fastHeaderSets,
    maxStoredHeaders: o.maxStoredHeaders,
    headerOver: o.headerOver,
    bareDrops: o.bareDrops,
    maxIdHeaders: o.maxIdHeaders,
    maxPerDevice: o.maxPerDevice,
    maxBelowId: o.maxBelowId,
    oLazy: o.lazy,
    oMono: o.monoTests,
    oHulls: o.hulls,
    oEarlyDrops: o.earlyDrops,
    oEarlyDropCases: o.earlyDropCases,
    oTailDrops: o.tailDrops,
    fastSets: o.fastSets,
    fastSteps: o.fastSteps,
    fastHead: o.fastHead,
    fastConc: o.fastConc,
    finalDrops: o.finalDrops,
    idDrops: o.idDrops,
    pcCasesO: o.pcCases,
    rfCases: o.rfCases,
    maxClasses: stats.maxClasses,
    mFallbacks: stats.fallbacks,
    maxOpWorlds: stats.maxOpWorlds,
    worldsOver: stats.worldsOver,
    worldsOverClean: stats.worldsOverClean,
    fastHanded: fastStats.handed,
    fastEvaluated: fastStats.evaluated,
    rkArrivals: o.rkHanded,
    cpCases: o.cpCases,
    rkCases,
    tplCount: Object.fromEntries(tplCount),
  }
}

if (process.env.ACL_CHILD) {
  const r = await runRange(start, N)
  console.log(JSON.stringify(r))
} else if (workers <= 1) {
  const t0 = performance.now()
  const r = await runRange(start, N)
  console.log(JSON.stringify(r, null, 1), `\n${((performance.now() - t0) / 1000).toFixed(1)} s`)
} else {
  const t0 = performance.now()
  const per = Math.ceil(N / workers)
  const procs = Array.from({ length: workers }, (_, i) =>
    Bun.spawn(
      ['bun', import.meta.path, String(Math.min(per, N - i * per)), String(start + i * per)],
      {
        env: { ...process.env, ACL_CHILD: '1' },
        stdout: 'pipe',
      }
    )
  )
  const outs = await Promise.all(
    procs.map(async p => JSON.parse(await new Response(p.stdout).text()))
  )
  const tot: any = {
    n: 0,
    failedCases: 0,
    byProp: {},
    firstSeed: {},
    events: 0,
    adv: 0,
    eqv: 0,
    cuts: 0,
    xs: 0,
    effs: 0,
    rejected: 0,
    pcs: 0,
    pcCases: 0,
    oStrata: 0,
    oChecked: 0,
    oSkipped: 0,
    oMaxCauses: 0,
    oSubsets: 0,
    oFallback: 0,
    oWorkFallback: 0,
    oLazy: 0,
    oMono: 0,
    oHulls: 0,
    oEarlyDrops: 0,
    oEarlyDropCases: 0,
    oTailDrops: 0,
    fastSets: 0,
    fastSteps: 0,
    fastHead: 0,
    fastConc: 0,
    fastHeaderSets: 0,
    maxStoredHeaders: 0,
    headerOver: 0,
    bareDrops: 0,
    maxIdHeaders: 0,
    maxPerDevice: 0,
    maxBelowId: 0,
    finalDrops: 0,
    idDrops: 0,
    pcCasesO: 0,
    rfCases: 0,
    maxClasses: 0,
    mFallbacks: 0,
    maxOpWorlds: 0,
    worldsOver: 0,
    worldsOverClean: 0,
    fastHanded: 0,
    fastEvaluated: 0,
    rkArrivals: 0,
    cpCases: 0,
    rkCases: 0,
    tplCount: {} as Record<string, number>,
  }
  for (const o of outs) {
    for (const k of [
      'n',
      'failedCases',
      'events',
      'adv',
      'eqv',
      'cuts',
      'xs',
      'effs',
      'rejected',
      'pcs',
      'pcCases',
      'oStrata',
      'oChecked',
      'oSkipped',
      'oSubsets',
      'oFallback',
      'oWorkFallback',
      'oLazy',
      'oMono',
      'oHulls',
      'oEarlyDrops',
      'oEarlyDropCases',
      'oTailDrops',
      'fastSets',
      'fastSteps',
      'fastHead',
      'fastConc',
      'fastHeaderSets',
      'headerOver',
      'bareDrops',
      'finalDrops',
      'idDrops',
      'pcCasesO',
      'rfCases',
      'mFallbacks',
      'worldsOver',
      'worldsOverClean',
      'fastHanded',
      'fastEvaluated',
      'rkArrivals',
      'cpCases',
      'rkCases',
    ])
      tot[k] += o[k]
    for (const [k, v] of Object.entries(o.tplCount ?? {}))
      tot.tplCount[k] = (tot.tplCount[k] ?? 0) + (v as number)
    tot.maxClasses = Math.max(tot.maxClasses, o.maxClasses)
    tot.maxOpWorlds = Math.max(tot.maxOpWorlds, o.maxOpWorlds)
    tot.oMaxCauses = Math.max(tot.oMaxCauses, o.oMaxCauses)
    tot.maxStoredHeaders = Math.max(tot.maxStoredHeaders, o.maxStoredHeaders)
    tot.maxIdHeaders = Math.max(tot.maxIdHeaders, o.maxIdHeaders)
    tot.maxPerDevice = Math.max(tot.maxPerDevice, o.maxPerDevice)
    tot.maxBelowId = Math.max(tot.maxBelowId, o.maxBelowId)
    for (const [k, v] of Object.entries(o.byProp))
      tot.byProp[k] = (tot.byProp[k] ?? 0) + (v as number)
    for (const [k, v] of Object.entries(o.firstSeed)) tot.firstSeed[k] ??= v
  }
  console.log(JSON.stringify(tot, null, 1), `\n${((performance.now() - t0) / 1000).toFixed(1)} s`)
}
