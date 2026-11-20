import { describe, expect, test } from 'bun:test'
import { ApiError } from '../api'
import {
  ACCESS_DENIED,
  CODE_GONE,
  JOIN_NOTE,
  PASSWORD_REQUIRED,
  deniedAccess,
  joinByCode,
  joinInput,
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

describe('join input', () => {
  const ORIGIN = 'https://chat.example.com'

  test('a pasted invite link joins what it names; anything else is a server name', () => {
    expect(joinInput(` ${ORIGIN}/i/k7m2p9xq4tzr/ `, ORIGIN)).toEqual({
      server: '',
      password: null,
      code: 'k7m2p9xq4tzr',
    })
    expect(joinInput(`${ORIGIN}/invite/Club/#password=pw`, ORIGIN)).toEqual({
      server: 'club',
      password: 'pw',
    })
    expect(joinInput('/i/k7m2p9xq4tzr', ORIGIN)?.code).toBe('k7m2p9xq4tzr')
    for (const name of ['club', 'k7m2p9xq4tzr', 'a/b', 'https://other.example/i/k7m2p9xq4tzr/'])
      expect(joinInput(name, ORIGIN)).toBeNull()
  })

  test('joins with a code through the server it names', async () => {
    const calls: string[] = []
    const lookup = async (code: string) => {
      calls.push(`look ${code}`)
      if (code !== 'k7m2p9xq4tzr') throw new ApiError('Not found', 404, { error: 'Not found' })
      return 'x2y3z4w5v6'
    }
    const join = async (server: string, password?: string) => {
      calls.push(`join ${server} ${password}`)
    }
    expect(await joinByCode('k7m2p9xq4tzr', lookup, join, describeError)).toBeNull()
    expect(calls).toEqual(['look k7m2p9xq4tzr', 'join x2y3z4w5v6 k7m2p9xq4tzr'])
    expect(await joinByCode('hhhhhhhhhhhh', lookup, join, describeError)).toBe(CODE_GONE)
    const banned = async () => {
      throw new ApiError('You are banned from this server', 403, {
        error: 'You are banned from this server',
      })
    }
    expect(await joinByCode('k7m2p9xq4tzr', lookup, banned, describeError)).toBe(
      'You are banned from this server'
    )
    expect(CODE_GONE.includes('\u2014')).toBe(false)
  })
})
