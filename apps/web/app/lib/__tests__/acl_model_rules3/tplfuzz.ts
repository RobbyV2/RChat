/* eslint-disable */
// @ts-nocheck
// Part of the P2P ACL reference model, used only by tests.
// A forced-template pass over the recovery-key templates on rules
// 3, since the random fuzz draws a recovery-key template in a few percent of its cases. Usage: bun tplfuzz.ts [perTemplate=300]
// [startSeed=1] [workers=1]; prints the failing cases and the properties, per template and in total.
import { genCase } from './gen'
import { checkCase } from './props'

export const RK_TEMPLATES = [
  'rk-thief',
  'rk-newsrv',
  'rk-leak',
  'rk-legacy',
  'rk-rejoin',
  'rk-upgrade',
  'rk-left',
]
const N = Number(process.argv[2] ?? 300)
const start = Number(process.argv[3] ?? 1)
const workers = Number(process.argv[4] ?? 1)

function runRange(from: number, n: number) {
  const out: {
    failedCases: number
    cases: number
    byProp: Record<string, number>
    byTpl: Record<string, number>
    firstSeed: Record<string, string>
    postings: Record<string, number>
  } = { failedCases: 0, cases: 0, byProp: {}, byTpl: {}, firstSeed: {}, postings: {} }
  for (const tpl of RK_TEMPLATES)
    for (let s = from; s < from + n; s++) {
      const cs = genCase(s, { template: tpl, rules: 3 })
      if (!cs.rkCase) continue
      out.cases++
      // the client model's postings, by bullet and link (and how many had none)
      for (const p of cs.rkCase.postings ?? []) {
        const k = `${p.t === 'primary_rotate' ? 'rotation' : p.t} ${p.bullet.replace(/-(try|retry)$/, '')} ${p.link}`
        out.postings[k] = (out.postings[k] ?? 0) + 1
      }
      const f = checkCase(cs)
      if (!f.length) continue
      out.failedCases++
      out.byTpl[tpl] = (out.byTpl[tpl] ?? 0) + 1
      for (const x of f) {
        out.byProp[x.prop] = (out.byProp[x.prop] ?? 0) + 1
        out.firstSeed[x.prop] ??= `${tpl} seed ${s}: ${x.detail}`
      }
    }
  return out
}
if (import.meta.main === false) {
  /* imported for RK_TEMPLATES */
} else if (process.env.ACL_CHILD) console.log(JSON.stringify(runRange(start, N)))
else {
  const t0 = performance.now()
  const per = Math.ceil(N / workers)
  const procs = Array.from({ length: workers }, (_, i) =>
    Bun.spawn(
      [
        'bun',
        import.meta.path,
        String(Math.max(0, Math.min(per, N - i * per))),
        String(start + i * per),
      ],
      { env: { ...process.env, ACL_CHILD: '1' }, stdout: 'pipe' }
    )
  )
  const outs = await Promise.all(
    procs.map(async p => JSON.parse(await new Response(p.stdout).text()))
  )
  const tot: any = {
    n: N,
    failedCases: 0,
    cases: 0,
    byProp: {},
    byTpl: {},
    firstSeed: {},
    postings: {},
  }
  for (const o of outs) {
    tot.failedCases += o.failedCases
    tot.cases += o.cases
    for (const [k, v] of Object.entries(o.postings ?? {}))
      tot.postings[k] = (tot.postings[k] ?? 0) + (v as number)
    for (const [k, v] of Object.entries(o.byProp))
      tot.byProp[k] = (tot.byProp[k] ?? 0) + (v as number)
    for (const [k, v] of Object.entries(o.byTpl)) tot.byTpl[k] = (tot.byTpl[k] ?? 0) + (v as number)
    for (const [k, v] of Object.entries(o.firstSeed)) tot.firstSeed[k] ??= v
  }
  console.log(JSON.stringify(tot, null, 1), `\n${((performance.now() - t0) / 1000).toFixed(1)} s`)
}
