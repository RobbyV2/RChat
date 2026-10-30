import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { BOOT_RETRY_MS, useStore, resetSessionCaches } from '../store'
import { me, memoryStorage, msg, serverDetail } from './fixtures'

afterAll(resetSessionCaches)

const st = () => useStore.getState()
const realFetch = globalThis.fetch
const realWindow = (globalThis as { window?: unknown }).window
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
const chan = { id: 77, name: 'general', kind: 'text' as const, slowmode_seconds: 0 }
let limited = 0
let limitedS = false
let path = '/'

beforeEach(() => {
  memoryStorage.clear()
  Object.assign(globalThis, { localStorage: memoryStorage })
  limited = 0
  limitedS = false
  path = '/s/s/77/'
  ;(globalThis as { window?: unknown }).window = {
    addEventListener: () => {},
    location: {
      get pathname() {
        return path
      },
      href: 'http://x/',
      origin: 'http://x',
      protocol: 'http:',
      search: '',
      hash: '',
    },
    history: {
      state: null,
      pushState: (_: unknown, __: string, p: string) => {
        path = p
      },
      replaceState: (_: unknown, __: string, p: string) => {
        path = p
      },
    },
  }
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, '')
    if (limitedS && url.startsWith('/api/servers/s'))
      return new Response('Too Many Requests', { status: 429 })
    if (url.startsWith('/api/servers/') && limited > 0) {
      limited -= 1
      return new Response('Too Many Requests', { status: 429 })
    }
    if (url === '/api/servers/s')
      return new Response(JSON.stringify(serverDetail('s', { channels: [chan] })), { status: 200 })
    if (url === '/api/servers/rchat')
      return new Response(
        JSON.stringify(serverDetail('rchat', { channels: [{ ...chan, id: 78 }] })),
        { status: 200 }
      )
    if (url.startsWith('/api/channels/77/messages'))
      return new Response(JSON.stringify([msg(40, { channel_id: 77 })]), { status: 200 })
    return new Response(JSON.stringify([]), { status: 200 })
  }) as typeof fetch
  useStore.setState({
    me: me('bob', { servers: [{ name: 's', display_name: 's', creator: null, is_admin: false }] }),
    token: 't',
    guest: false,
    error: null,
    view: null,
    home: false,
    servers: {},
    messages: {},
  })
})

afterEach(() => {
  globalThis.fetch = realFetch
  ;(globalThis as { window?: unknown }).window = realWindow
})

describe('boot under rate limits', () => {
  test('a boot whose requests got 429 opens the address once they pass', async () => {
    limited = 1
    await st().bootstrap()
    expect(st().view).toBeNull()
    for (let i = 0; i < 40 && !st().view; i += 1) await wait(50)
    expect(st().view).toEqual({ kind: 'channel', server: 's', channelId: 77 })
    expect(path).toBe('/s/s/77/')
  })

  test('when the last retry still gets 429 it falls back', async () => {
    const waits = [...BOOT_RETRY_MS]
    BOOT_RETRY_MS.splice(0, waits.length, 20, 20, 20)
    try {
      limitedS = true
      await st().bootstrap()
      for (let i = 0; i < 40 && !st().view; i += 1) await wait(25)
      expect(st().view).toEqual({ kind: 'channel', server: 'rchat', channelId: 78 })
    } finally {
      BOOT_RETRY_MS.splice(0, BOOT_RETRY_MS.length, ...waits)
    }
  })

  test('without a 429 nothing is retried', async () => {
    path = '/dm/999/'
    await st().bootstrap()
    const view = st().view
    await wait(1200)
    expect(st().view).toEqual(view)
  })
})
