import { describe, expect, test } from 'bun:test'
import { parseTheme } from '../theme/device'

describe('parseTheme', () => {
  test('reads light, dark for any other value, and null when nothing is kept', () => {
    expect(parseTheme('light')).toBe('light')
    expect(parseTheme('dark')).toBe('dark')
    expect(parseTheme('sepia')).toBe('dark')
    expect(parseTheme(null)).toBeNull()
  })
})
