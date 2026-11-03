import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { genCase } from './acl_model/gen'
import type { Ev } from './acl_model/model'
import { World } from './acl_model/world'
import { FastEval, type StratumInfo } from '../p2p/acl/eval'
import { diffModelWorld, prodReplica, useModelLimits, useProductionLimits } from './p2p_acl_world'

// The production ACL modules against the executable reference model (spec §7.2, §8.1): random
// adversarial universes from the model's generator (a copy of notes/acl-model/gen.ts, model
// constants), replayed through both; every verdict, admission record, admission state, the
// incremental final state and a batch evaluation must be equal.

beforeAll(useModelLimits)
afterAll(useProductionLimits)

const SEEDS = 2000
const CHUNK = 100

const run = (seeds: number[], gen: (s: number) => World) => {
  const fails: string[] = []
  for (const s of seeds) {
    for (const d of diffModelWorld(gen(s))) fails.push(`seed ${s}: ${d.slice(0, 600)}`)
    if (fails.length > 5) break
  }
  return fails
}
const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i)

for (let from = 1; from <= SEEDS; from += CHUNK)
  test(`seeds ${from} to ${from + CHUNK - 1}: production equals the model`, () => {
    expect(run(range(from, CHUNK), s => genCase(s).w)).toEqual([])
  }, 600_000)

test('equivocation-heavy and long runs: production equals the model', () => {
  const gen = (s: number) => genCase(1_000_000 + s, { equivocation: true, maxAdv: 14 }).w
  expect(run(range(1, 100), gen)).toEqual([])
}, 600_000)

test('seed 5019136: a range term that cuts nothing is no direct cut', () => {
  expect(run([5_019_136], s => genCase(s).w)).toEqual([])
})

test('seed 8414: a stray content field of a profile write is not part of the model register', () => {
  expect(run([8414], s => genCase(s).w)).toEqual([])
})

// Revision 7b's final-fuzz findings (O5-senior, O6-join, O11-growth (d)), regenerated.
for (const s of [9_043_909, 8_868_407, 10_016_903])
  test(`seed ${s} (revision 7b): production equals the model`, () => {
    expect(run([s], x => genCase(x).w)).toEqual([])
  })

// The saved universes behind the failures of §7.7 (revision-2 format converted as the model's
// fixtures test does).
const toR3 = (events: Ev[]): Ev[] => {
  const codeByH = new Map<string, string>()
  for (const e of events)
    if (e.t === 'code' && (!codeByH.has(e.c.h) || e.id < codeByH.get(e.c.h)!))
      codeByH.set(e.c.h, e.id)
  return events.map(e => {
    const x: Ev = { ...e, c: { ...e.c } }
    if (x.t === 'device_revoke') delete x.iprev
    if (x.t === 'code_revoke' && x.c.code === undefined)
      x.c.code = codeByH.get(x.c.h) ?? `missing-${x.c.h}`
    if (x.t === 'add' && typeof x.c.code === 'string' && !x.c.code.startsWith('code.'))
      x.c.code = codeByH.get(x.c.code) ?? `missing-${x.c.code}`
    return x
  })
}
const dir = fileURLToPath(new URL('./acl_model/fixtures', import.meta.url))
for (const f of readdirSync(dir)
  .filter(x => x.endsWith('.json'))
  .sort())
  test(`fixture ${f}: production equals the model`, () => {
    const fx = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'))
    const w = new World()
    for (const e of fx.events[0]?.t === 'genesis' && fx.format === 3
      ? fx.events
      : toR3(fx.events)) {
      w.all.push(e)
      w.ref.receive(e)
    }
    expect(diffModelWorld(w)).toEqual([])
  })

// §3.5 cascadeCut asks a stratum's in(x, W) for content authors' worlds after the stratum loop:
// those answers must equal the ones the loop itself would give (higher strata only in k*).
test('content worlds asked after the stratum loop equal those asked inside it', () => {
  const fails: string[] = []
  const worldsOf = (n: number) => {
    const all = (BigInt(1) << BigInt(n)) - BigInt(1)
    if (n <= 4) return Array.from({ length: Number(all) }, (_, i) => BigInt(i + 1))
    return [all, ...Array.from({ length: n }, (_, i) => all ^ (BigInt(1) << BigInt(i)))]
  }
  const ask = (fe: FastEval, info: StratumInfo, out: Map<string, boolean>) => {
    for (let x = 0; x < fe.cutOrd.length; x++)
      if (fe.cutOrd[x] === info.s)
        for (const W of worldsOf(info.causes.length)) out.set(`${info.s}|${x}|${W}`, info.inW(x, W))
  }
  for (const s of range(1, 600)) {
    const ix = prodReplica(genCase(s).w).acl.ix
    const inside = new Map<string, boolean>()
    const a = new FastEval(ix)
    a.onStratum = info => ask(a, info, inside)
    a.run()
    const b = new FastEval(ix)
    b.run()
    const after = new Map<string, boolean>()
    for (const info of b.strataInfo) ask(b, info, after)
    for (const [k, v] of inside)
      if (after.get(k) !== v) fails.push(`seed ${s}: in(${k}) inside ${v}, after ${after.get(k)}`)
    if (fails.length > 5) break
  }
  expect(fails).toEqual([])
}, 600_000)
