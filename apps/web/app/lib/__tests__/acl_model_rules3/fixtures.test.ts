/* eslint-disable */
// @ts-nocheck
// Part of the P2P ACL reference model, used only by tests.
import { setDefaultTimeout } from 'bun:test'
setDefaultTimeout(120_000)
// Replays saved event universes (a seed alone doesn't reproduce them: the generator's output depends on its version)
// and checks every property on them. Some are in event format 2;
// `toFormat3` converts them (a device_revoke carries no iprev; code references name the code event).
import { expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { World } from './world'
import { checkCase } from './props'
import type { Ev } from './model'

export function toFormat3(events: Ev[]): Ev[] {
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

for (const f of readdirSync(`${import.meta.dir}/fixtures`)
  .filter(x => x.endsWith('.json'))
  .sort()) {
  test(`fixture ${f}: every property holds`, async () => {
    const fx = await Bun.file(`${import.meta.dir}/fixtures/${f}`).json()
    const w = new World()
    for (const e of fx.events[0]?.t === 'genesis' && fx.format === 3
      ? fx.events
      : toFormat3(fx.events)) {
      w.all.push(e)
      w.ref.receive(e)
    }
    expect(
      checkCase({ w, equivocation: fx.equivocation, seed: fx.seed, adversarial: [] }).map(
        x => `${x.prop}: ${x.detail}`
      )
    ).toEqual([])
  })
}
