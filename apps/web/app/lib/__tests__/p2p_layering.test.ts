import { describe, expect, test } from 'bun:test'
import { importsOf } from './import_graph'

// Which P2P modules may load which (static imports, type-only ones aside).

const P2P = 'apps/web/app/lib/p2p'
const reaches = (g: Set<string>, m: string) => [...g].some(p => p.endsWith(m))

describe('P2P layering', () => {
  test('the walker follows value imports and skips type-only ones', () => {
    const g = importsOf(`${P2P}/acl/rules.ts`)
    expect(g.has(`${P2P}/limits.ts`)).toBe(true)
    expect(g.has(`${P2P}/canonical.ts`)).toBe(true)
    expect(g.has(`${P2P}/acl/facts.ts`)).toBe(false)
  })

  test('the summary codec loads without the evaluator', () => {
    const g = importsOf(`${P2P}/acl/summary.ts`)
    for (const m of ['acl/eval.ts', 'acl/cache.ts', 'acl/admit.ts', 'acl_room.ts'])
      expect([m, reaches(g, m)]).toEqual([m, false])
  })
})
