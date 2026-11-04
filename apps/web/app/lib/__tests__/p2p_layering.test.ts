import { describe, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { importsOf, packagesOf } from './import_graph'

// Which P2P modules may load which (static imports, type-only ones aside).

const P2P = 'apps/web/app/lib/p2p'
const SERVER = fileURLToPath(new URL('../p2p/server/', import.meta.url))

// What plan H's reports may import without the page: every server module and the transport.
const PAGE_FREE = () => [
  ...readdirSync(SERVER)
    .filter(f => f.endsWith('.ts'))
    .map(f => `${P2P}/server/${f}`),
  ...['node.ts', 'session.ts', 'gossip.ts', 'sync.ts'].map(f => `${P2P}/${f}`),
]
const PAGE_FILE = (p: string) => p.startsWith(`${P2P}/app/`) || p === 'apps/web/app/lib/store.ts'
const PAGE_PACKAGE = (p: string) => /^(react|zustand)(\/|$)/.test(p)

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

  test('the server code and the transport load without the page store, zustand or React', () => {
    for (const entry of PAGE_FREE()) {
      const files = [...importsOf(entry)].filter(PAGE_FILE)
      const packages = [...packagesOf(entry)].filter(PAGE_PACKAGE)
      expect([entry, files, packages]).toEqual([entry, [], []])
    }
  })
})
