import { describe, expect, test } from 'bun:test'
import { ApiError } from '../api'
import { canRetry, refusalOf } from '../api_errors'

describe('a refusal from an API error', () => {
  test('carries the reason the server gave', () => {
    const r = refusalOf(
      new ApiError('Calls are full', 503, {
        error: 'Calls are full',
        reason: { kind: 'capacity', control: 'calls', retry_after: 120 },
      })
    )
    expect(r).toEqual({
      kind: 'capacity',
      message: 'Calls are full',
      control: 'calls',
      fields: [],
      retryAfter: 120,
      status: 503,
    })
  })

  test('names the fields of an invalid request', () => {
    const one = refusalOf(
      new ApiError('Too long', 400, { reason: { kind: 'invalid', field: 'name' } })
    )
    expect(one.fields).toEqual(['name'])
    const many = refusalOf(
      new ApiError('Bad', 400, {
        reason: { kind: 'invalid', field: 'name', fields: ['name', 'bio'] },
      })
    )
    expect(many.fields).toEqual(['name', 'bio'])
  })

  test('falls back to the status where the server gave no reason', () => {
    expect(refusalOf(new ApiError('Not found', 404)).kind).toBe('denied')
    expect(refusalOf(new ApiError('Log in', 401)).kind).toBe('sign_in')
    expect(refusalOf(new ApiError('Taken', 409)).kind).toBe('conflict')
    expect(refusalOf(new ApiError('Bad', 400)).kind).toBe('invalid')
    expect(refusalOf(new ApiError('Down', 500)).kind).toBe('unavailable')
    expect(refusalOf(new ApiError('Odd', 418)).kind).toBe('unknown')
  })

  test('takes the wait from the header where the reason has none', () => {
    const r = refusalOf(new ApiError('Slow down', 429, { error: 'Slow down' }, 7))
    expect(r.kind).toBe('rate')
    expect(r.retryAfter).toBe(7)
  })

  test('a reason kind it does not know reads by status', () => {
    const r = refusalOf(new ApiError('New', 403, { reason: { kind: 'brand_new', control: 'x' } }))
    expect(r.kind).toBe('denied')
    expect(r.control).toBe('x')
  })
})

describe('a failure that is not an API error', () => {
  test('a request that got no answer is offline', () => {
    expect(refusalOf(new TypeError('Failed to fetch')).kind).toBe('offline')
  })

  test('a timeout is the server being unavailable', () => {
    const late = new Error('late')
    late.name = 'TimeoutError'
    expect(refusalOf(late).kind).toBe('unavailable')
  })

  test('anything else keeps its message', () => {
    expect(refusalOf(new Error('Boom')).message).toBe('Boom')
    expect(refusalOf('plain text').message).toBe('plain text')
    expect(refusalOf(null).message).toBe('Something went wrong')
  })
})

describe('asking again', () => {
  test('helps for waits and outages, not for what the person must change', () => {
    expect(canRetry(refusalOf(new ApiError('Down', 500)))).toBe(true)
    expect(canRetry(refusalOf(new ApiError('Slow', 429)))).toBe(true)
    expect(canRetry(refusalOf(new TypeError('x')))).toBe(true)
    expect(canRetry(refusalOf(new ApiError('Not found', 404)))).toBe(false)
    expect(canRetry(refusalOf(new ApiError('Bad', 400)))).toBe(false)
  })
})
