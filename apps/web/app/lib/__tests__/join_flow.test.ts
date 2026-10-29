import { describe, expect, test } from 'bun:test'
import { ApiError } from '../api'
import {
  ACCESS_DENIED,
  JOIN_NOTE,
  PASSWORD_REQUIRED,
  deniedAccess,
  needsPassword,
  runJoinStep,
} from '../join_flow'

const required = () => new ApiError(PASSWORD_REQUIRED, 401, { error: PASSWORD_REQUIRED })
const denied = () => new ApiError(ACCESS_DENIED, 404, { error: ACCESS_DENIED })
const describeError = (e: unknown) => (e instanceof Error ? e.message : String(e))

const server = (password: string | null) => {
  const calls: (string | undefined)[] = []
  const join = (pw?: string) => {
    calls.push(pw)
    if (password === null) return Promise.resolve()
    if (pw === undefined) return Promise.reject(required())
    return pw === password ? Promise.resolve() : Promise.reject(denied())
  }
  return { calls, join }
}

describe('join steps', () => {
  test('a public server joins on the first call without a password', async () => {
    const s = server(null)
    expect(await runJoinStep('name', 'typed early', s.join, describeError)).toEqual({ done: true })
    expect(s.calls).toEqual([undefined])
  })

  test('password_required moves to the password step without an error', async () => {
    const s = server('pw')
    expect(await runJoinStep('name', '', s.join, describeError)).toEqual({
      done: false,
      step: 'password',
      error: null,
    })
    expect(s.calls).toEqual([undefined])
  })

  test('the password step sends the trimmed password and joins when it is right', async () => {
    const s = server('pw')
    expect(await runJoinStep('password', '  pw ', s.join, describeError)).toEqual({ done: true })
    expect(s.calls).toEqual(['pw'])
  })

  test('a wrong password and a missing server show the API message on the password step', async () => {
    const missing = {
      calls: [] as (string | undefined)[],
      join(pw?: string) {
        this.calls.push(pw)
        return Promise.reject(pw === undefined ? required() : denied())
      },
    }
    const first = await runJoinStep('name', '', pw => missing.join(pw), describeError)
    const protectedFirst = await runJoinStep('name', '', server('pw').join, describeError)
    expect(first).toEqual(protectedFirst)
    const wrong = await runJoinStep('password', 'nope', server('pw').join, describeError)
    const ghost = await runJoinStep('password', 'nope', pw => missing.join(pw), describeError)
    expect(wrong).toEqual({ done: false, step: 'password', error: ACCESS_DENIED })
    expect(ghost).toEqual(wrong)
  })

  test('a blank password is not sent', async () => {
    const s = server('pw')
    expect(await runJoinStep('password', '   ', s.join, describeError)).toEqual({
      done: false,
      step: 'password',
      error: 'Enter the server password',
    })
    expect(s.calls).toEqual([])
  })

  test('other errors stay on the current step', async () => {
    const banned = new ApiError('You are banned from this server', 403, {})
    const out = await runJoinStep('name', '', () => Promise.reject(banned), describeError)
    expect(out).toEqual({ done: false, step: 'name', error: 'You are banned from this server' })
  })
})

describe('uniform API errors', () => {
  test('only the exact uniform responses count', () => {
    expect(needsPassword(required())).toBe(true)
    expect(needsPassword(new ApiError('Unauthorized', 401, {}))).toBe(false)
    expect(deniedAccess(denied())).toBe(true)
    expect(deniedAccess(new ApiError('Not found', 404, {}))).toBe(false)
  })

  test('the join note copy has no em dashes and no app name', () => {
    expect(JOIN_NOTE.includes('\u2014')).toBe(false)
    expect(JOIN_NOTE.toLowerCase().includes('rchat')).toBe(false)
  })
})
