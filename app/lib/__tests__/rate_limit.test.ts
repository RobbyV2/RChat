import { describe, expect, test } from 'bun:test'
import { retrySeconds, tooManyText } from '../rate_limit'

describe('retry hints', () => {
  test('reads delta seconds and http dates from Retry-After', () => {
    expect(retrySeconds('7')).toBe(7)
    expect(retrySeconds('0')).toBe(1)
    const now = Date.parse('2026-01-01T00:00:00Z')
    expect(retrySeconds('Thu, 01 Jan 2026 00:00:12 GMT', '', now)).toBe(12)
  })

  test('falls back to the wait in the body', () => {
    expect(retrySeconds(null, 'Too Many Requests! Wait for 4s')).toBe(4)
    expect(retrySeconds(null, '{"error":"Wait 3 seconds between attempts"}')).toBe(3)
    expect(retrySeconds('soon', 'nothing here')).toBeNull()
  })

  test('message names the wait when known', () => {
    expect(tooManyText(5)).toBe('Too many attempts — try again in 5 s')
    expect(tooManyText(null)).toBe('Too many attempts — try again in a few seconds')
  })
})
