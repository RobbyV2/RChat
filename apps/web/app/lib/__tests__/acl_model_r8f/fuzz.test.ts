/* eslint-disable */
// @ts-nocheck
// Copy of notes/acl-model-r8f/fuzz.test.ts (the executable reference model of the P2P ACL spec r8f), used only by tests.
import { setDefaultTimeout } from 'bun:test'
setDefaultTimeout(120_000)
// Random adversarial DAGs under `bun test`. ACL_CASES scales the run (default 300); `bun fuzz.ts N 1 W` runs N in parallel.
import { expect, test } from 'bun:test'
import { genCase } from './gen'
import { checkCase } from './props'

const N = Number(process.env.ACL_CASES ?? 300)
const START = Number(process.env.ACL_SEED ?? 1)

test(`oracles O1-O7 hold on ${N} random adversarial cases`, () => {
  const fails: string[] = []
  for (let s = START; s < START + N; s++) {
    for (const f of checkCase(genCase(s))) fails.push(`seed ${s} ${f.prop}: ${f.detail}`)
    if (fails.length > 20) break
  }
  expect(fails).toEqual([])
}, 600_000)

test('equivocation-heavy and long runs', () => {
  const fails: string[] = []
  for (let s = 1; s <= Math.ceil(N / 5); s++) {
    for (const f of checkCase(genCase(1_000_000 + s, { equivocation: true, maxAdv: 14 })))
      fails.push(`seed ${s} ${f.prop}: ${f.detail}`)
    if (fails.length > 20) break
  }
  expect(fails).toEqual([])
}, 600_000)
