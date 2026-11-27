import { test, expect } from 'bun:test'
import { clientLogin, CLIENT_SSO } from '../client_sso'
import { testAccount } from './test_account'
import { challengeOf } from '../sso'
test('only the originating popup and instance complete this account’s challenge', async () => {
  const origin = 'https://beta.example',
    app = 'https://client.example'
  const account = testAccount('alice', origin)
  const before = Object.getOwnPropertyDescriptor(globalThis, 'window'),
    place = Object.getOwnPropertyDescriptor(globalThis, 'location')
  const target = Promise.withResolvers<URL>()
  let closed = false
  const replies: { payload: unknown; origin: string }[] = []
  const popup = {
    get closed() {
      return closed
    },
    close() {
      closed = true
    },
    location: { replace: (value: string) => target.resolve(new URL(value)) },
    postMessage: (payload: unknown, origin: string) => replies.push({ payload, origin }),
  }
  const w = Object.assign(new EventTarget(), { open: () => popup, location: new URL(app) })
  const emit = (source: unknown, origin: string, data: unknown) =>
    w.dispatchEvent(Object.assign(new Event('message'), { source, origin, data }))
  Object.defineProperty(globalThis, 'window', { configurable: true, value: w })
  Object.defineProperty(globalThis, 'location', { configurable: true, value: w.location })
  try {
    const result = clientLogin(account, 'local', new AbortController().signal)
    const start = await target.promise
    expect(start.origin).toBe(origin)
    expect(start.searchParams.get('origin')).toBe(app)
    expect(start.searchParams.get('return')).toBe('client')
    const challenge = start.searchParams.get('challenge')
    const ready = { type: CLIENT_SSO, challenge, ready: true },
      code = '1'.repeat(64)
    emit({}, origin, ready)
    emit(popup, app, ready)
    emit(popup, origin, { ...ready, challenge: 'old' })
    expect(replies).toHaveLength(0)
    emit(popup, origin, ready)
    expect(replies).toEqual([{ payload: { type: CLIENT_SSO, challenge, ack: true }, origin }])
    emit({}, origin, { type: CLIENT_SSO, challenge, code })
    emit(popup, app, { type: CLIENT_SSO, challenge, code })
    expect(closed).toBe(false)
    emit(popup, origin, { type: CLIENT_SSO, challenge, code })
    expect(await challengeOf((await result).verifier)).toBe(challenge!)
    expect(closed).toBe(true)
  } finally {
    if (before) Object.defineProperty(globalThis, 'window', before)
    else Reflect.deleteProperty(globalThis, 'window')
    if (place) Object.defineProperty(globalThis, 'location', place)
    else Reflect.deleteProperty(globalThis, 'location')
  }
})
