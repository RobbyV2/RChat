import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import { home } from '../instances'
import { resetSessionCaches, useStore } from '../store'
import { advance, me, memoryStorage } from './fixtures'

afterAll(resetSessionCaches)

const st = () => useStore.getState()
const g = globalThis as { window?: unknown; document?: unknown; WebSocket?: unknown }
const real = {
  window: g.window,
  document: g.document,
  WebSocket: g.WebSocket,
  fetch: globalThis.fetch,
}

const homeInfo = home.info
let versions: string[] | undefined
let hung = false
let calls: string[] = []
let sockets: string[] = []

class Socket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3
  readyState = 0
  onopen = null
  onclose = null
  onerror = null
  onmessage = null
  constructor(url: string) {
    sockets.push(url)
  }
  send() {}
  close() {
    this.readyState = 3
  }
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

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
      host: 'x',
      protocol: 'http:',
      search: '',
      hash: '',
    },
    history: { state: null, pushState: () => {}, replaceState: () => {} },
  }
  g.document = { cookie: '', visibilityState: 'visible', addEventListener: () => {} }
  g.WebSocket = Socket
  calls = []
  sockets = []
  hung = false
  // The home instance in full mode: an instance from before versions sends unknown paths
  // (all of /api/v1) to the web app, which answers with its HTML page.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input), 'http://x').pathname
    calls.push(`${init?.method ?? 'GET'} ${path}`)
    if (path.startsWith('/api/v1/') && !versions?.includes('v1'))
      return new Response('<!DOCTYPE html>', { headers: { 'content-type': 'text/html' } })
    const rest = path.replace(/^\/api(\/v1)?/, '')
    if (rest === '/instance' && hung)
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      )
    if (rest === '/instance')
      return json({
        software: 'rchat',
        id: 'home',
        name: 'Home',
        host: 'x',
        api_version: '1.1',
        public_url: 'http://x',
        api_url: 'http://x/api',
        ws_url: 'ws://x/api/ws',
        features: {},
        ...(versions ? { api_versions: versions } : {}),
      })
    if (rest === '/me') return json(me('bob'))
    return json([])
  }) as typeof fetch
  useStore.setState({ me: null, token: null, guest: false, authExpired: false, bootError: null })
})

afterEach(() => {
  st().logout()
  home.info = homeInfo
  jest.useRealTimers()
  globalThis.fetch = real.fetch
  g.window = real.window
  g.document = real.document
  g.WebSocket = real.WebSocket
})

describe('the API prefix at boot', () => {
  test('a home instance that serves v1 is called on /api/v1 after its document', async () => {
    versions = ['v1']
    await st().bootstrap()
    expect(st().me?.username).toBe('bob')
    expect(calls[0]).toBe('GET /api/instance')
    expect(calls).toContain('GET /api/v1/me')
    expect(calls.slice(1).every(c => c.includes(' /api/v1/'))).toBe(true)
    expect(sockets.at(-1)).toEndWith('/api/v1/ws')
  })

  test('a home instance from before versions is called on /api, never on /api/v1', async () => {
    versions = undefined
    await st().bootstrap()
    expect(st().me?.username).toBe('bob')
    expect(calls[0]).toBe('GET /api/instance')
    expect(calls).toContain('GET /api/me')
    expect(calls.filter(c => c.includes('/api/v1'))).toEqual([])
    expect(sockets.at(-1)).toEndWith('/api/ws')
  })

  test('a discovery request that never answers holds the boot for 3 s at most', async () => {
    home.info = null
    hung = true
    const boot = st().bootstrap()
    await advance(2_900, () => calls.length > 1)
    expect(calls).toEqual(['GET /api/instance'])
    await advance(200, () => calls.includes('GET /api/me'))
    expect(calls).toContain('GET /api/me')
    await boot
    expect(st().me?.username).toBe('bob')
  })
})
