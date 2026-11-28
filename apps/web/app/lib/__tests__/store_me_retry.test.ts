import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import { getHomeSession, useStore } from '../store'
import { advance, me, memoryStorage } from './fixtures'
import { plain } from './helpers/secret'
import { writeJson } from '../api/masks'

const st = () => useStore.getState()
const g = globalThis as { window?: unknown; document?: unknown; WebSocket?: unknown }
const real = {
  window: g.window,
  document: g.document,
  WebSocket: g.WebSocket,
  fetch: globalThis.fetch,
}
let answers: (number | 'down')[] = []
let meCalls = 0

class QuietSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3
  readyState = 0
  onopen = null
  onclose = null
  onerror = null
  onmessage = null
  send() {}
  close() {
    this.readyState = 3
  }
}

beforeEach(() => {
  jest.useFakeTimers()
  memoryStorage.clear()
  memoryStorage.setItem('rchat_token', 'tok')
  Object.assign(globalThis, { localStorage: memoryStorage })
  g.window = {
    addEventListener: () => {},
    location: {
      pathname: '/',
      href: 'http://x/',
      origin: 'http://x',
      protocol: 'http:',
      search: '',
      hash: '',
    },
    history: { state: null, pushState: () => {}, replaceState: () => {} },
  }
  g.document = { cookie: '', visibilityState: 'visible', addEventListener: () => {} }
  g.WebSocket = QuietSocket
  meCalls = 0
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, '')
    if (url === '/api/me') {
      meCalls += 1
      const answer = answers.shift() ?? 200
      if (answer === 'down') throw new TypeError('fetch failed')
      if (answer !== 200)
        return new Response(writeJson({ error: 'Try again soon' }), { status: answer })
      return new Response(writeJson(me('bob')), { status: 200 })
    }
    return new Response(writeJson([]), { status: 200 })
  }) as typeof fetch
  useStore.setState({ me: null, token: null, guest: false, authExpired: false, bootError: null })
})

afterEach(() => {
  st().logout()
  getHomeSession().credentialTarget = undefined
  jest.useRealTimers()
  globalThis.fetch = real.fetch
  g.window = real.window
  g.document = real.document
  g.WebSocket = real.WebSocket
})

describe('account load at boot', () => {
  test('server errors and network failures keep the session and retry until it loads', async () => {
    answers = [503, 500, 'down', 502]
    await st().bootstrap()
    expect(plain(st().token)).toBe('tok')
    expect(st().authExpired).toBe(false)
    expect(st().me).toBeNull()
    expect(st().bootError).not.toBeNull()
    expect(meCalls).toBe(1)
    expect(memoryStorage.getItem('rchat_token:bob')).toBeNull()
    await advance(1000, () => meCalls > 1)
    expect(meCalls).toBe(2)
    await advance(120_000, () => !!st().me)
    expect(st().me?.username).toBe('bob')
    expect(st().authExpired).toBe(false)
    expect(st().bootError).toBeNull()
    expect(meCalls).toBe(5)
    expect(memoryStorage.getItem('rchat_token')).toBe('tok')
    expect(memoryStorage.getItem('rchat_token:bob')).toBe('tok')
  })

  test('an explicit account never falls back to the legacy alias', async () => {
    getHomeSession().credentialTarget = 'alice'
    await st().bootstrap()
    expect(meCalls).toBe(0)
    expect(st().me).toBeNull()
    memoryStorage.setItem('rchat_token:alice', 'alice-token')
    answers = [200]
    await st().bootstrap()
    expect(meCalls).toBe(1)
    expect(st().me).toBeNull()
    expect(memoryStorage.getItem('rchat_token')).toBe('tok')
    expect(memoryStorage.getItem('rchat_token:bob')).toBeNull()
  })

  test('a 401 signs out', async () => {
    answers = [401]
    await st().bootstrap()
    expect(st().authExpired).toBe(true)
    expect(st().me).toBeNull()
    expect(meCalls).toBe(1)
  })
})
