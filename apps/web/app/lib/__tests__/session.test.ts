import { describe, expect, test } from 'bun:test'
import { ApiError } from '../api'
import { BACKOFF_CAP, BACKOFF_FLOOR } from '../backoff'
import { endsSession, meRetryIn } from '../session'

const top = () => 0.999999

describe('sign-out decision', () => {
  test('a 401 signs out', () => {
    const e = new ApiError('Unauthorized', 401)
    expect(endsSession(e)).toBe(true)
    expect(meRetryIn(e, 0)).toBeNull()
    expect(meRetryIn(e, 7)).toBeNull()
  })

  test('server errors keep the session and retry', () => {
    for (const status of [500, 502, 503, 504]) {
      const e = new ApiError('Service unavailable', status)
      expect(endsSession(e)).toBe(false)
      expect(meRetryIn(e, 0, top)).not.toBeNull()
    }
  })

  test('network failures and other answers keep the session', () => {
    for (const e of [
      new ApiError("Can't reach the server", 0),
      new TypeError('fetch failed'),
      new DOMException('The operation timed out.', 'TimeoutError'),
      new ApiError('Too many attempts', 429),
      new ApiError('Not found', 404),
      new ApiError('Forbidden', 403),
      null,
    ]) {
      expect(endsSession(e)).toBe(false)
      expect(meRetryIn(e, 0, top)).not.toBeNull()
    }
  })

  test('retries back off up to the cap', () => {
    const e = new ApiError('Service unavailable', 503)
    const waits = [0, 1, 2, 3, 4, 5, 10].map(n => meRetryIn(e, n, top) ?? -1)
    expect(waits).toEqual([999, 1999, 3999, 7999, 15_999, 29_999, 29_999])
    expect(meRetryIn(e, 0, () => 0)).toBe(BACKOFF_FLOOR)
    expect(Math.max(...waits)).toBeLessThan(BACKOFF_CAP)
  })
})
