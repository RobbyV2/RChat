import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { typeExportsOf } from './api_surface'
import api from './fixtures/p2p_app_api.json'

// The P2P page store keeps the surface app.ts had: its barrel (app/index.ts) exports exactly those
// names, recorded before the split.

describe('the P2P app barrel', () => {
  test('exports what app.ts did', async () => {
    const index = fileURLToPath(new URL('../p2p/app/index.ts', import.meta.url))
    expect(Object.keys(await import('../p2p/app')).sort()).toEqual(api.values)
    expect(typeExportsOf(index)).toEqual(api.types)
  })
})
