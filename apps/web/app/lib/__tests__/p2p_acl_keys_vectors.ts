import { afterAll, afterEach, expect } from 'bun:test'
import { World } from './acl_model_r8f/world'
import { worldDiff } from './p2p_acl_r3'
import './acl_model_r8f/vectors-r8.test'
import './acl_model_r8f/vectors-r8d.test'
import './acl_model_r8f/vectors-r8e.test'
import './acl_model_r8f/vectors-r8f.test'

// Run by p2p_acl_keys.test.ts in a process of its own (`bun test ./p2p_acl_keys_vectors.ts`): a
// test file that another one imports runs once, in whichever loads it first, and test files share
// their modules. Here the r8 vectors of the model (B3 among them: the recovery key from creation,
// the void rule and the freeze, sibling carriers, upgrades as records, an upgrade that dies only
// through carriers signed by a recovery key) run under their own names, and after each one the
// protection state production reads from every world it built, at its end and after each of its
// events, is compared with the model's and the oracle's.

const live: World[] = []
const genesis = World.prototype.genesis
World.prototype.genesis = function (this: World, ...args: Parameters<World['genesis']>) {
  live.push(this)
  return genesis.apply(this, args)
}

const checked = { worlds: 0, rules3: 0 }

afterEach(() => {
  for (const w of live.splice(0)) {
    checked.worlds += 1
    if (w.ref.order.length && w.ref.ev(w.ref.order[0]).c?.rules === 3) checked.rules3 += 1
    expect(worldDiff(w, true)).toEqual([])
  }
})

afterAll(() => {
  World.prototype.genesis = genesis
  console.log(`worlds compared: ${checked.worlds} (${checked.rules3} on rules 3)`)
})
