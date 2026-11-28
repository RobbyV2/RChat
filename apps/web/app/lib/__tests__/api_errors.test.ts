import { describe, expect, test } from 'bun:test'
import { ApiError } from '../api'
import {
  background,
  canRetry,
  controlLabel,
  fieldLine,
  refusalOf,
  refusalView,
  waitText,
  type RefusalKind,
} from '../api_errors'

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

describe('what a refusal shows, and where', () => {
  const of = (kind: RefusalKind, over: Record<string, unknown> = {}, status = 400) =>
    refusalView(refusalOf(new ApiError('The server line', status, { reason: { kind, ...over } })))

  test('an invalid field goes under the field, in the server words', () => {
    const view = of('invalid', { field: 'name' })
    expect(view.where).toBe('field')
    expect(view.line).toBe('The server line')
    expect(view.fields).toEqual(['name'])
    expect(of('invalid').where).toBe('notice')
  })

  test('a switch that is off goes on its control and says whose switch it is', () => {
    expect(of('off_site', { control: 'calls' })).toMatchObject({
      where: 'control',
      line: 'Calls is turned off on this site.',
      retry: false,
    })
    expect(of('off_account', { control: 'uploads' }).line).toBe(
      'Uploads is turned off for your account.'
    )
    expect(of('off_server', { control: 'guest_chat' }).line).toBe(
      'Guest chat is turned off in this server.'
    )
    expect(of('off_app', { control: 'dialogs' }).line).toBe('Dialogs is turned off for this app.')
    expect(of('off_site').line).toBe('This is turned off on this site.')
    expect(of('perm').where).toBe('control')
  })

  test('capacity and rate say to wait, with the time when the server gave one', () => {
    expect(of('capacity', { control: 'calls', retry_after: 120 }, 503)).toMatchObject({
      where: 'notice',
      line: 'This site is at capacity for calls right now. Try again in about 2 minutes.',
      retry: true,
      wait: 120,
    })
    expect(of('rate', { retry_after: 5 }, 429).line).toBe(
      'You are doing that too fast. Try again in 5 seconds.'
    )
    expect(of('unavailable', {}, 503).line).toBe(
      'The server cannot do that right now. Try again in a moment.'
    )
  })

  test('a limit, a lock and a conflict keep the server words', () => {
    for (const kind of ['limit', 'locked', 'conflict'] as const)
      expect(of(kind)).toMatchObject({ where: 'notice', line: 'The server line', retry: false })
  })

  test('an ended session asks to log in, and an app speaks for itself', () => {
    expect(of('sign_in', {}, 401).where).toBe('sign_in')
    expect(of('app')).toMatchObject({ where: 'app', line: 'The server line' })
  })

  test('no answer is a connection state, and a plain denial names nothing', () => {
    expect(refusalView(refusalOf(new TypeError('x'))).where).toBe('connection')
    const denied = refusalView(refusalOf(new ApiError('Not found', 404)))
    expect(denied).toMatchObject({ where: 'notice', retry: false })
    expect(denied.line).toBe('This is not here, or you cannot open it.')
  })

  test('no line has an em dash, a code or the name of the app', () => {
    const kinds: RefusalKind[] = [
      'invalid',
      'rate',
      'conflict',
      'sign_in',
      'unavailable',
      'off_site',
      'off_account',
      'off_server',
      'off_app',
      'app',
      'limit',
      'capacity',
      'perm',
      'locked',
    ]
    const lines = [
      ...kinds.map(kind => of(kind, { control: 'calls', retry_after: 90 }, 503).line),
      refusalView(refusalOf(new TypeError('x'))).line,
      refusalView(refusalOf(new ApiError('Not found', 404))).line,
    ]
    for (const line of lines) {
      expect(line.includes('\u2014')).toBe(false)
      expect(/rchat/i.test(line)).toBe(false)
      expect(/\b(4|5)\d\d\b/.test(line)).toBe(false)
      expect(/[.!?]$/.test(line) || line === 'The server line').toBe(true)
    }
  })
})

describe('the words in a line', () => {
  test('a wait reads in seconds, then minutes', () => {
    expect(waitText(1)).toBe('1 second')
    expect(waitText(45)).toBe('45 seconds')
    expect(waitText(60)).toBe('about a minute')
    expect(waitText(150)).toBe('about 3 minutes')
  })

  test('a control key reads as words', () => {
    expect(controlLabel('guest_chat')).toBe('Guest chat')
    expect(controlLabel('registration')).toBe('New accounts')
    expect(controlLabel('instance_name')).toBe('Instance name')
    expect(controlLabel('p2p.attachments')).toBe('P2p attachments')
    expect(controlLabel(null)).toBeNull()
    expect(controlLabel('')).toBeNull()
  })

  test('a field line is the message only for a field the refusal names', () => {
    const r = refusalOf(
      new ApiError('Too long', 400, { reason: { kind: 'invalid', field: 'name' } })
    )
    expect(fieldLine(r, 'name')).toBe('Too long')
    expect(fieldLine(r, 'bio')).toBeNull()
    expect(fieldLine(null, 'name')).toBeNull()
  })
})

describe('a failure nobody is waiting on', () => {
  const recorded = (run: () => void) => {
    const calls: unknown[][] = []
    const warn = console.warn
    console.warn = (...args: unknown[]) => void calls.push(args)
    try {
      run()
    } finally {
      console.warn = warn
    }
    return calls
  }

  test('is recorded with what it was and why, and the caller goes on', () => {
    const failed = new ApiError('Down', 500)
    const calls = recorded(() => {
      expect(background('marking read failed')(failed)).toBeUndefined()
      expect(background('refreshing failed', null)(failed)).toBeNull()
    })
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual(['marking read failed', 'unavailable', failed])
  })

  test('a request that got no answer is left to the connection state', () => {
    const calls = recorded(() =>
      background('marking read failed')(new TypeError('Failed to fetch'))
    )
    expect(calls).toEqual([])
  })
})
