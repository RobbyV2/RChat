/* eslint-disable */
// @ts-nocheck
// Part of the P2P ACL reference model, used only by tests.
// Runs the exact G5 oracle (oracle.ts) on every World a vector builds ("on every vector"). Each World calls
// genesis() once, so wrapping it registers the world without changing world.ts.
import { afterEach, expect } from 'bun:test'
import { World } from './world'
import { g5Oracle } from './oracle'
import { fastDiff } from './props'
import { withLim } from './model'

const live: World[] = []
const orig = World.prototype.genesis
World.prototype.genesis = function (this: World, ...args: Parameters<World['genesis']>) {
  live.push(this)
  return orig.apply(this, args)
}
export const oracleRuns = { worlds: 0, strata: 0, checked: 0, skipped: 0, maxCauses: 0, fast: 0 }

/** Install in a test file: after each test, every world it built must satisfy O5-exact, O5-safe and O5-complete. */
export function oracleAfterEach(bound = 10) {
  live.splice(0)
  afterEach(() => {
    const ws = live.splice(0)
    for (const w of ws) {
      // under the world's own per-server limits (its genesis)
      const r = withLim(w.ref.lim, () => g5Oracle(w.ref, w.ref.order, w.state(), bound))
      oracleRuns.worlds++
      oracleRuns.strata += r.strata
      oracleRuns.checked += r.checked
      oracleRuns.skipped += r.skipped
      oracleRuns.maxCauses = Math.max(oracleRuns.maxCauses, r.maxCauses)
      expect(r.fails.map(f => `${f.prop}: ${f.detail}`)).toEqual([])
      // O13-fast on every vector: fast.ts equals the reference on every set this world evaluated, and incrementally
      const ff: string[] = []
      withLim(w.ref.lim, () => fastDiff(w.ref, (p, d) => ff.push(`${p}: ${d}`)))
      oracleRuns.fast++
      expect(ff).toEqual([])
    }
  })
}
