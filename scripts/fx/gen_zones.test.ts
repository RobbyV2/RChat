import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { NORTH_IANA, SOUTH_IANA } from '../../apps/web/app/lib/__tests__/fx_zones_list'
import { VECTOR, vectorText, zoneDiff } from './gen_zones'

describe('time zone vector', () => {
  test('equal recordings have no difference', () => {
    expect(
      zoneDiff({ 'Pacific/Kanton': 'Pacific/Enderbury' }, { 'Pacific/Kanton': 'Pacific/Enderbury' })
    ).toEqual([])
  })

  test('changed, missing and new zones are listed', () => {
    expect(
      zoneDiff(
        { 'Pacific/Kanton': 'Pacific/Enderbury', 'Asia/Kolkata': 'Asia/Calcutta', UTC: 'UTC' },
        { 'Pacific/Kanton': 'Pacific/Kanton', UTC: 'UTC', 'Europe/Kyiv': 'Europe/Kiev' }
      )
    ).toEqual([
      'Asia/Kolkata: Asia/Calcutta -> (not recorded)',
      'Europe/Kyiv: (not recorded) -> Europe/Kiev',
      'Pacific/Kanton: Pacific/Enderbury -> Pacific/Kanton',
    ])
  })

  test('the committed vector is in the form the generator writes', () => {
    const text = readFileSync(VECTOR, 'utf8')
    const { engine, recorded, reported } = JSON.parse(text)
    expect(vectorText(engine, recorded, reported)).toBe(text)
    expect(Object.keys(reported)).toEqual([...SOUTH_IANA, ...NORTH_IANA])
  })
})
