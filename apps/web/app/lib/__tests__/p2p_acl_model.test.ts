import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { genCase } from './acl_model/gen'
import type { Ev } from './acl_model/model'
import { World } from './acl_model/world'
import { diffModelWorld, useModelLimits, useProductionLimits } from './p2p_acl_world'

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
