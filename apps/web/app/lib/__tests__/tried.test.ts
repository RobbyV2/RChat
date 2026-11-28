import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { ApiError } from '../api'
import { Ended } from '../slices/ctx'
import { came, recorded, refused } from '../tried'

describe('what a store action answers', () => {
  const warned: unknown[][] = []
  const before = console.warn
  console.warn = (...said: unknown[]) => void warned.push(said)
  afterEach(() => void warned.splice(0))
  afterAll(() => {
    console.warn = before
  })

  test('a value is read after a look at ok', () => {
    const tried = came(3)
    expect(tried.ok && tried.value).toBe(3)
  })

  test('a failure keeps what the instance refused with', () => {
    const tried = refused(new ApiError('No such server', 404))
    expect(tried.ok).toBe(false)
    expect(!tried.ok && tried.refusal.status).toBe(404)
    expect(!tried.ok && tried.refusal.message).toBe('No such server')
  })

  test('a caller nobody waits on records the refusal', () => {
    recorded('own server profile')(refused(new ApiError('Try again later', 503)))
    expect(warned.map(said => said[0])).toEqual(['own server profile'])
  })

  test('an answer, a late answer and a request with no answer record nothing', () => {
    recorded('own server profile')(came(1))
    recorded('own server profile')(refused(new Ended()))
    recorded('own server profile')(refused(new TypeError('Failed to fetch')))
    expect(warned).toEqual([])
  })
})
