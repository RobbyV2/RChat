import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { useStore, resetSessionCaches } from '../store'
import { me, memoryStorage, msg, serverDetail, user } from './fixtures'

afterAll(resetSessionCaches)

const st = () => useStore.getState()
const realFetch = globalThis.fetch
const realWindow = (globalThis as { window?: unknown }).window
let reply: { status: number; body: unknown } = { status: 200, body: null }
const tick = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
  await new Promise(r => setTimeout(r, 0))
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

const setup = (slowmode: number, admin = false) =>
  useStore.setState({
    me: me('bob', { servers: [{ name: 's', display_name: 's', creator: null, is_admin: admin }] }),
    token: 't',
    guest: false,
    error: null,
    view: { kind: 'channel', server: 's', channelId: 77 },
    servers: {
      s: serverDetail('s', {
        channels: [{ id: 77, name: 'general', kind: 'text', slowmode_seconds: slowmode }],
      }),
    },
    messages: { c77: [msg(9, { channel_id: 77 })] },
    outbox: {},
    slowUntil: {},
    panel: null,
  })

beforeEach(() => {
  memoryStorage.clear()
  Object.assign(globalThis, { localStorage: memoryStorage })
  ;(globalThis as { window?: unknown }).window = {
    location: { pathname: '/', href: 'http://x/', origin: 'http://x', protocol: 'http:' },
    history: { state: null, pushState: () => {}, replaceState: () => {} },
  }
  reply = { status: 200, body: msg(50, { channel_id: 77, author: user('bob'), content: 'hi' }) }
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, '')
    if (init?.method === 'POST' && url === '/api/channels/77/messages')
      return new Response(JSON.stringify(reply.body), { status: reply.status })
    return new Response(JSON.stringify([]), { status: 200 })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  ;(globalThis as { window?: unknown }).window = realWindow
})

describe('slow mode countdown', () => {
  test('starts after a send in a slow channel', async () => {
    setup(30)
    const before = Date.now()
    st().sendMessage('hi')
    await tick()
    const until = st().slowUntil[77] ?? 0
    expect(until >= before + 30_000).toBe(true)
    expect(until <= Date.now() + 30_000).toBe(true)
  })

  test('not in channels without slow mode or for exempt members', async () => {
    setup(0)
    st().sendMessage('hi')
    await tick()
    expect(st().slowUntil[77]).toBeUndefined()
    setup(30, true)
    st().sendMessage('hi')
    await tick()
    expect(st().slowUntil[77]).toBeUndefined()
  })

  test('follows the server wait when a send is refused', async () => {
    setup(30)
    reply = { status: 429, body: { error: 'Slow mode: wait 12s' } }
    const before = Date.now()
    st().sendMessage('hi')
    await tick()
    const until = st().slowUntil[77] ?? 0
    expect(until >= before + 12_000).toBe(true)
    expect(until < before + 13_000).toBe(true)
  })
})
