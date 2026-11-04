import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AclReplica, type Verdict } from '../p2p/acl/admit'
import type { AclEv } from '../p2p/acl/rules'
import { AclWorld, MODEL_LIMITS, testBinds } from './p2p_acl_world'

// Agreed limits are per replica (spec 4.1): every room is built with its server's limits, and
// nothing in the P2P code reads a module-wide limit.

const P2P = fileURLToPath(new URL('../p2p/', import.meta.url))

const aclSources = () =>
  (readdirSync(P2P, { recursive: true }) as string[])
    .filter(p => p.endsWith('.ts'))
    .map(p => ({ path: p, text: readFileSync(join(P2P, p), 'utf8') }))

const feed = (r: AclReplica, evs: AclEv[]): Verdict[] => evs.map(e => r.receive(e))

describe('agreed limits', () => {
  test('two replicas with different agreed limits decide one event differently', () => {
    const w = new AclWorld({ model: false })
    w.genesis('O1', ['O'])
    for (const id of ['c1', 'c2', 'c3']) w.ok('O1', 'channel', { id, name: id })
    const evs = w.all
    const a = new AclReplica({ binds: testBinds, agreed: { ...MODEL_LIMITS, channels: 2 } })
    const b = new AclReplica({ binds: testBinds, agreed: MODEL_LIMITS })
    expect(feed(a, evs).map(v => v.s)).toEqual(['A', 'A', 'A', 'R'])
    expect(feed(b, evs).map(v => v.s)).toEqual(['A', 'A', 'A', 'A'])
  })

  test('no module reads a global limit', () =>
    expect(
      aclSources()
        .filter(s => /\bLIM\b|setLimits/.test(s.text))
        .map(s => s.path)
    ).toEqual([]))
})
