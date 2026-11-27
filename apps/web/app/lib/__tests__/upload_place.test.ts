import { describe, expect, test } from 'bun:test'
import { uploadPlace } from '../attachments'

describe('the place an upload names', () => {
  test('a channel or a DM by its id, a thread by its channel', () => {
    expect(uploadPlace('c12')).toBe('c:12')
    expect(uploadPlace('d3')).toBe('d:3')
    expect(uploadPlace('t9', root => (root === 9 ? 4 : null))).toBe('c:4')
    expect(uploadPlace('t9')).toBeNull()
  })

  test('anything else names no place', () => {
    for (const key of [
      null,
      '',
      'c',
      'cx',
      'c0',
      'c-1',
      'c1.5',
      'x1',
      'p2p',
      'c99999999999999999999',
    ])
      expect(uploadPlace(key)).toBeNull()
  })
})
