import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import { useStore, resetSessionCaches } from '../store'
import type { MessageLocation, WsEvent } from '../types'
import { home } from '../instances'
import { advance, me, memoryStorage, msg, serverDetail, user } from './fixtures'

afterAll(resetSessionCaches)

const st = () => useStore.getState()
const realFetch = globalThis.fetch
const realWindow = (globalThis as { window?: unknown }).window
let readable: Record<number, MessageLocation> = {}
let lookups: number[] = []
let batches: number[][] = []
let flying = 0
let maxFlying = 0
let hold: Promise<void> | null = null
let pages: string[] = []
let replaced: string[] = []
let path = '/'

const card = (over: Partial<MessageLocation> = {}): MessageLocation => ({
  id: 40,
  server: 's',
  channel_id: 77,
  dm_id: null,
  thread_root_id: null,
  author: user('carol'),
  created_at: 7,
  content: 'old news',
  has_media: false,
  kind: 'user',
  forwarded: false,
  ...over,
})

beforeEach(() => {
  memoryStorage.clear()
  Object.assign(globalThis, { localStorage: memoryStorage })
  readable = {}
  lookups = []
  batches = []
  flying = 0
  maxFlying = 0
  hold = null
  pages = []
  replaced = []
  path = '/'
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
        replaced.push(p)
      },
    },
  }
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, '')
    if (url === '/api/messages/locations') {
      const { ids } = JSON.parse(String(init?.body)) as { ids: number[] }
      batches.push(ids)
      flying += 1
      maxFlying = Math.max(maxFlying, flying)
      await hold
      flying -= 1
      const found = ids.flatMap(id => (readable[id] ? [{ ...readable[id], id }] : []))
      return new Response(JSON.stringify(found), { status: 200 })
    }
    if (url === '/api/auth/login')
      return new Response(JSON.stringify({ token: 't2', user: me('bob') }), { status: 200 })
    const loc = url.match(/^\/api\/messages\/(\d+)\/location$/)
    if (loc) {
      const id = Number(loc[1])
      lookups.push(id)
      const found = readable[id]
      return found
        ? new Response(JSON.stringify(found), { status: 200 })
        : new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })
    }
    if (url.startsWith('/api/channels/77/messages')) {
      pages.push(url)
      return new Response(
        JSON.stringify([msg(40, { channel_id: 77 }), msg(41, { channel_id: 77 })]),
        {
          status: 200,
        }
      )
    }
    if (url === '/api/servers/s')
      return new Response(JSON.stringify(serverDetail('s', { channels: [chan] })), { status: 200 })
    return new Response(JSON.stringify([]), { status: 200 })
  }) as typeof fetch
  useStore.setState({
    me: me('bob', { servers: [{ name: 's', display_name: 's', creator: null, is_admin: false }] }),
    token: 't',
    guest: false,
    error: null,
    toast: null,
    linkCards: {},
    view: { kind: 'channel', server: 's', channelId: 77 },
    servers: { s: serverDetail('s', { channels: [chan] }) },
    messages: { c77: [msg(90, { channel_id: 77 })] },
    focus: {},
    outbox: {},
    panel: null,
  })
})

const chan = { id: 77, name: 'general', kind: 'text' as const, slowmode_seconds: 0 }

afterEach(() => {
  globalThis.fetch = realFetch
  ;(globalThis as { window?: unknown }).window = realWindow
})

describe('opening a message link', () => {
  test('an unloaded message loads around it and flashes', async () => {
    readable[40] = card()
    await st().openMessage(40)
    expect(pages.some(p => p.includes('around=40'))).toBe(true)
    expect(st().focus.c77).toEqual({ id: 40, flash: true })
    expect(st().toast).toBeNull()
  })

  test('an unreadable message toasts and stays put', async () => {
    await st().openMessage(41)
    expect(st().toast?.text).toBe("You can't open this message")
    expect(st().error).toBeNull()
    expect(st().view).toEqual({ kind: 'channel', server: 's', channelId: 77 })
    expect(st().focus.c77 ?? null).toBeNull()
    expect(st().linkCards[41]).toBeNull()
  })

  test('the address bar opens the message, then shows the channel path', async () => {
    readable[40] = card()
    path = '/s/s/77/40/'
    await st().syncFromUrl('replace')
    expect(st().focus.c77).toEqual({ id: 40, flash: true })
    expect(path).toBe('/s/s/77/')
  })

  test('an unreadable address keeps the current view and says so', async () => {
    path = '/s/s/77/41/'
    await st().syncFromUrl('none')
    expect(st().toast?.text).toBe("You can't open this message")
    expect(st().view).toEqual({ kind: 'channel', server: 's', channelId: 77 })
    expect(path).toBe('/s/s/77/')
  })
})

describe('link cards', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  test('visible cards resolve in one batch and refusals are cached', async () => {
    readable[40] = card()
    st().resolveLinkCard(40)
    st().resolveLinkCard(40)
    st().resolveLinkCard(41)
    st().resolveLinkCard(42)
    expect(batches).toEqual([])
    await advance(80)
    st().resolveLinkCard(40)
    st().resolveLinkCard(41)
    await advance(80)
    expect(batches).toEqual([[40, 41, 42]])
    expect(lookups).toEqual([])
    expect(st().linkCards[40]?.content).toBe('old news')
    expect(st().linkCards[41]).toBeNull()
    expect(st().linkCards[42]).toBeNull()
  })

  test('many links go out 50 at a time, two batches at most in flight', async () => {
    let open = () => {}
    hold = new Promise<void>(r => {
      open = r
    })
    const ids = Array.from({ length: 160 }, (_, i) => 1000 + i)
    for (const id of ids) readable[id] = card({ id })
    for (const id of ids) st().resolveLinkCard(id)
    await advance(80)
    expect(batches.map(b => b.length)).toEqual([50, 50])
    open()
    hold = null
    await advance(300)
    expect(batches.map(b => b.length)).toEqual([50, 50, 50, 10])
    expect(batches.flat()).toEqual(ids)
    expect(maxFlying).toBe(2)
    expect(ids.every(id => st().linkCards[id]?.id === id)).toBe(true)
  })

  test('a full cache evicts its oldest cards only', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => 2000 + i)
    for (const id of ids) readable[id] = card({ id })
    for (const id of ids.slice(0, 500)) st().resolveLinkCard(id)
    await advance(400)
    expect(Object.keys(st().linkCards).length).toBe(500)
    st().resolveLinkCard(2500)
    await advance(100)
    expect(Object.keys(st().linkCards).length).toBe(500)
    expect(2000 in st().linkCards).toBe(false)
    expect(st().linkCards[2001]?.id).toBe(2001)
    expect(st().linkCards[2500]?.id).toBe(2500)
  })

  test('jumping still uses the single lookup', async () => {
    readable[40] = card()
    await st().openMessage(40)
    expect(lookups).toEqual([40])
    expect(batches).toEqual([])
    expect(st().linkCards[40]?.content).toBe('old news')
  })

  test('renames and avatar changes patch cached cards', async () => {
    readable[40] = card()
    readable[43] = card({ id: 43, author: user('dave') })
    st().resolveLinkCard(40)
    st().resolveLinkCard(43)
    await advance(80)
    const renamed = { ...user('carol'), display_name: 'Caroline', avatar_color: '#123456' }
    st().applyWsEvent({ type: 'user_updated', user: renamed } as WsEvent)
    expect(st().linkCards[40]?.author).toEqual(renamed)
    expect(st().linkCards[43]?.author).toEqual(user('dave'))
  })

  test('signing in drops cards cached for the previous session', async () => {
    readable[40] = card()
    st().resolveLinkCard(40)
    st().resolveLinkCard(41)
    await advance(80)
    expect(41 in st().linkCards).toBe(true)
    const g = globalThis as { document?: unknown }
    const realDocument = g.document
    g.document = { cookie: '', visibilityState: 'visible', addEventListener: () => {} }
    try {
      await st().login({ username: 'bob', password: 'x' } as never)
      expect(st().error).toBeNull()
      expect(st().token).toBe('t2')
      expect(st().linkCards).toEqual({})
    } finally {
      home.ws.stop()
      g.document = realDocument
    }
  })

  test('links still queued when the session ends are never looked up', async () => {
    readable[40] = card()
    st().resolveLinkCard(40)
    resetSessionCaches()
    await advance(80)
    expect(batches).toEqual([])
  })

  test('edits and deletes drop the cached card', async () => {
    readable[40] = card()
    st().resolveLinkCard(40)
    await advance(80)
    st().applyWsEvent({ type: 'message_updated', stub: true, id: 40 } as unknown as WsEvent)
    expect(40 in st().linkCards).toBe(false)
    readable[40] = card({ content: 'new news' })
    st().resolveLinkCard(40)
    await advance(80)
    expect(st().linkCards[40]?.content).toBe('new news')
    st().applyWsEvent({
      type: 'message_deleted',
      id: 40,
      server: 's',
      channel_id: 77,
      dm_id: null,
      thread_root_id: null,
    } as unknown as WsEvent)
    expect(40 in st().linkCards).toBe(false)
  })

  test('an edit while a lookup is in flight refetches', async () => {
    let open = () => {}
    hold = new Promise<void>(r => {
      open = r
    })
    readable[40] = card()
    st().resolveLinkCard(40)
    await advance(80)
    st().applyWsEvent({ type: 'message_updated', stub: true, id: 40 } as unknown as WsEvent)
    readable[40] = card({ content: 'new news' })
    open()
    hold = null
    await advance(150)
    expect(st().linkCards[40]?.content).toBe('new news')
    expect(batches).toEqual([[40], [40]])
  })
})
