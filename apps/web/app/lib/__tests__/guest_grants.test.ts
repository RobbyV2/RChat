import { afterEach, describe, expect, test } from 'bun:test'
import { readGrants, writeGrants } from '../client/credentials'
import { Secret } from '../secret'
import { memoryStorage } from './fixtures'
import { plain } from './helpers/secret'

const KEY = 'rchat_guest_grants_test'
afterEach(() => memoryStorage.removeItem(KEY))

const shown = (grants: Record<string, Secret>) =>
  Object.fromEntries(Object.entries(grants).map(([server, grant]) => [server, plain(grant)]))

describe('saved guest grants', () => {
  test('grants come back sealed with the values that were saved', () => {
    writeGrants(KEY, { club: Secret.of('g1'), den: Secret.of('g2') })
    expect(JSON.parse(memoryStorage.getItem(KEY) ?? '')).toEqual({ club: 'g1', den: 'g2' })
    const read = readGrants(KEY)
    expect(read.club instanceof Secret).toBe(true)
    expect(shown(read)).toEqual({ club: 'g1', den: 'g2' })
  })

  test('nothing saved, or a value of another shape, holds no grants', () => {
    expect(readGrants(KEY)).toEqual({})
    for (const raw of ['{', '[]', '"g1"', '{"club":7}']) {
      memoryStorage.setItem(KEY, raw)
      expect(readGrants(KEY)).toEqual({})
    }
  })

  test('an empty grant is left out', () => {
    memoryStorage.setItem(KEY, '{"club":"","den":"g2"}')
    expect(shown(readGrants(KEY))).toEqual({ den: 'g2' })
  })
})
