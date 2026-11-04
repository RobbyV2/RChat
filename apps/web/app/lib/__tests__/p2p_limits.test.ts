import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { MAX_PARENTS } from '../p2p/acl_room'
import { LIMITS2 } from '../p2p/event_v2'
import { AGREED, flatLocal, LOCAL, localDefaults, RANGES, registryJson } from '../p2p/limits'
import { LIMITS as STATE_LIMITS } from '../p2p/state'
import before from './fixtures/p2p_local_before.json'

// The P2P limits registry: AGREED is spec 4.1, the copies outside it follow it, LOCAL holds
// every device-local value at what it was before the registry, and the instance's copy of the
// registry is current.

const ASSET = fileURLToPath(new URL('../../../../../assets/p2p_limits.json', import.meta.url))
const flat = flatLocal

describe('P2P limits registry', () => {
  test('AGREED is spec 4.1', () =>
    expect(AGREED).toEqual({
      devCap: 8,
      w3: 60,
      w3mod: 600,
      win: 3_600_000,
      day: 86_400_000,
      freshCap: 2,
      idCap: 8,
      rotCap: 4,
      classes: 3,
      pendingPerDev: 20,
      codesPerDev: 20,
      codesPerDevServer: 100,
      roles: 250,
      totU: 24,
      rotTot: 4,
      poolU: 384,
      ap: 10,
      channels: 500,
      overwrites: 100,
      w4: 500,
    }))

  test('copies derive from AGREED', () => {
    expect(LIMITS2.ap).toBe(AGREED.ap)
    expect(MAX_PARENTS).toBe(AGREED.ap)
    expect(STATE_LIMITS.codesPerMember).toBe(AGREED.codesPerDev)
  })

  test('LOCAL keeps every value it had', () => expect(flat(LOCAL)).toEqual(before))

  test('every default is inside its range', () => {
    expect(Object.keys(RANGES).sort()).toEqual(Object.keys(flat(LOCAL)).sort())
    for (const [k, v] of Object.entries(flat(LOCAL))) {
      const [lo, hi] = RANGES[k]
      expect(lo <= v && v <= hi).toBe(true)
    }
  })

  test('localDefaults overrides, clamps and ignores', () => {
    const l = localDefaults({
      'sync.statePerMin': 5000,
      'gossip.perRoom': 1e12,
      'no.such': 3,
      'dag.roomCap': Number.NaN,
      'node.sessions': -4,
    })
    expect(l.sync.statePerMin).toBe(5000)
    expect(l.gossip.perRoom).toBe(RANGES['gossip.perRoom'][1])
    expect(l.dag.roomCap).toBe(LOCAL.dag.roomCap)
    expect(l.node.sessions).toBe(RANGES['node.sessions'][0])
    expect(LOCAL.sync.statePerMin).toBe(2000)
  })

  test('localDefaults takes array items and refuses strings and inherited names', () => {
    const l = localDefaults(
      JSON.parse(
        '{"node.backoff.1": 90000, "sync.horizon": "9", "__proto__": 1, "constructor": 2, "toString": 3}'
      )
    )
    expect(l.node.backoff).toEqual([30_000, 90_000, 120_000, 300_000, 600_000])
    expect(l.sync.horizon).toBe(LOCAL.sync.horizon)
    expect(({} as Record<string, unknown>).undefined).toBeUndefined()
    expect(flat(localDefaults())).toEqual(flat(LOCAL))
    expect(Object.isFrozen(localDefaults().sync)).toBe(false)
    expect(Object.isFrozen(LOCAL.sync)).toBe(true)
  })

  test('assets/p2p_limits.json is the registry', () =>
    expect(JSON.parse(readFileSync(ASSET, 'utf8'))).toEqual(registryJson()))
})
