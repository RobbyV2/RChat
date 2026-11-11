// Hemisphere detection on the names browsers really report: a pure test over
// the vector `gen_zones.ts` recorded from Chromium, so the unit gate never launches a browser.
import { describe, expect, test } from 'bun:test'
import recorded from './fixtures/fx_v8_zones.json'
import { hemisphereOf } from '../fx/seasons'
import { NORTH_IANA, SOUTH_IANA } from './fx_zones_list'

const reported = recorded.reported as Record<string, string>

describe('hemisphere on the names Chromium reports', () => {
  test('the vector covers every listed zone', () => {
    for (const z of [...SOUTH_IANA, ...NORTH_IANA])
      expect([z, typeof reported[z]]).toEqual([z, 'string'])
  })
  test('it is a V8 recording: some names come back as CLDR legacy names', () => {
    expect(reported['America/Argentina/Buenos_Aires']).toBe('America/Buenos_Aires')
    expect(reported['Pacific/Kanton']).toBe('Pacific/Enderbury')
  })
  test('every southern zone reads south, whatever name Chromium reports', () => {
    const wrong = SOUTH_IANA.filter(z => hemisphereOf(reported[z]) !== 'south').map(
      z => `${z} -> ${reported[z]}`
    )
    expect(wrong).toEqual([])
  })
  test('northern zones read north', () => {
    for (const z of NORTH_IANA) expect([z, hemisphereOf(reported[z])]).toEqual([z, 'north'])
  })
  test('bun reports IANA names, which read the same', () => {
    for (const z of SOUTH_IANA) expect([z, hemisphereOf(z)]).toEqual([z, 'south'])
    for (const z of NORTH_IANA) expect([z, hemisphereOf(z)]).toEqual([z, 'north'])
  })
})
