import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { useStore } from '../store'
import type { Message, WsEvent } from '../types'
import { me, msg, user } from './fixtures'

const st = () => useStore.getState()
const dispatch = (ev: WsEvent) => st().applyWsEvent(ev)
const realFetch = globalThis.fetch
const realWindow = (globalThis as { window?: unknown }).window
let requests: { url: string; body: string | null }[] = []
let route: (url: string) => unknown = () => []
let held: ((body: unknown) => void)[] = []
let holdMessages = false

const range = (from: number, to: number, over: Partial<Message> = {}) =>
  Array.from({ length: to - from + 1 }, (_, i) => msg(from + i, over))
const ids = (key: string) => (st().messages[key] ?? []).map(m => m.id)
const live = (channel: number, id: number): WsEvent => ({
  type: 'message',
  server: 's',
  channel_id: channel,
  dm_id: null,
  dm_users: null,
  message: msg(id, { channel_id: channel, author: user('bob') }),
})
const tick = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

beforeEach(() => {
  ;(globalThis as { window?: unknown }).window = {
    location: { pathname: '/', href: 'http://x/', origin: 'http://x', protocol: 'http:' },
    history: { state: null, pushState: () => {}, replaceState: () => {} },
  }
  requests = []
  held = []
  holdMessages = false
  route = () => []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    requests.push({ url, body: (init?.body as string | undefined) ?? null })
    if (holdMessages && url.includes('/messages'))
      return new Promise<Response>(resolve => held.push(body => resolve(reply(body))))
    return reply(route(url))
  }) as typeof fetch
  useStore.setState({
    me: me('alice'),
    token: null,
    guest: false,
    view: { kind: 'channel', server: 's', channelId: 2 },
    servers: {},
    dms: [],
    messages: {},
    older: {},
    newer: {},
    stale: {},
    focus: {},
    outbox: {},
    reads: {},
    unreadAnchor: {},
    atBottom: true,
    panel: null,
    error: null,
  })
})

afterEach(() => {
  globalThis.fetch = realFetch
  ;(globalThis as { window?: unknown }).window = realWindow
})

describe('returning to a cached view', () => {
  test('a live message that arrives while the first page loads is kept', async () => {
    useStore.setState({ messages: { c41: range(1, 100), c2: range(1, 5) } })
    for (let id = 101; id <= 130; id += 1) dispatch(live(41, id))
    expect(ids('c41').at(-1)).toBe(100)
    holdMessages = true
    const open = st().openChannel('s', 41, 'none')
    await tick()
    dispatch(live(41, 131))
    expect(held).toHaveLength(1)
    held[0](range(81, 130))
    await open
    expect(ids('c41').slice(-3)).toEqual([129, 130, 131])
    expect(ids('c41')).toEqual(range(81, 131).map(m => m.id))
  })

  test('the cached list is marked stale until the fresh page lands', async () => {
    useStore.setState({
      messages: { c41: range(1, 100), c2: range(1, 5) },
      reads: { c41: { lastRead: 100, latest: 100 } },
    })
    for (let id = 101; id <= 130; id += 1) dispatch(live(41, id))
    expect(st().reads.c41).toEqual({ lastRead: 100, latest: 130, server: 's' })
    holdMessages = true
    const open = st().openChannel('s', 41, 'none')
    await tick()
    expect(st().stale.c41).toBe(true)
    expect(st().unreadAnchor.c41).toBe(100)
    held[0](range(81, 130))
    await open
    expect(st().stale.c41).toBeUndefined()
    expect(ids('c41').at(-1)).toBe(130)
    expect(st().unreadAnchor.c41).toBe(100)
  })

  test('a failed first page falls back to the cache plus the held messages', async () => {
    useStore.setState({ messages: { c41: range(1, 100), c2: range(1, 5) } })
    globalThis.fetch = (async () =>
      new Response('{"error":"down"}', { status: 500 })) as unknown as typeof fetch
    const open = st().openChannel('s', 41, 'none')
    dispatch(live(41, 101))
    await open
    expect(st().stale.c41).toBeUndefined()
    expect(ids('c41').at(-1)).toBe(101)
  })
})

describe('unread state from the server', () => {
  const unreads = (items: unknown[], more = false) => {
    route = url => (url.endsWith('/unreads') ? { items, more } : [])
  }

  test('a read made locally is not undone by an older /unreads response', async () => {
    useStore.setState({ token: 't', reads: { c41: { lastRead: 10, latest: 30, server: 's' } } })
    st().markRead('c41', 30)
    unreads([{ scope: 'c41', server: 's', last_read: 10, latest: 30 }])
    dispatch({ type: 'banned', username: 'dave' })
    await tick()
    expect(requests.some(r => r.url.endsWith('/unreads'))).toBe(true)
    expect(st().reads.c41.lastRead).toBe(30)
    expect(st().reads.c41.latest).toBe(30)
    useStore.setState({ dms: [{ id: 5, other: user('u5'), is_self: false }] })
    await st().openDm(5)
    const posted = requests.filter(r => r.url.endsWith('/read'))
    expect(posted.map(r => JSON.parse(r.body ?? '{}'))).toEqual([{ scope: 'c41', last_read: 30 }])
  })

  test('a scope created while /unreads is in flight is kept', async () => {
    let answer: (r: Response) => void = () => {}
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/unreads')) return new Promise<Response>(r => (answer = r))
      return Promise.resolve(reply([]))
    }) as typeof fetch
    useStore.setState({ reads: { d77: { lastRead: 0, latest: 5 } } })
    dispatch({ type: 'banned', username: 'dave' })
    await tick()
    dispatch(live(49, 500))
    answer(reply({ items: [], more: false }))
    await tick()
    expect(st().reads.d77).toBeUndefined()
    expect(st().reads.c49).toEqual({ lastRead: 499, latest: 500, server: 's' })
  })

  test('a scope cut by the cap starts with no read position', async () => {
    unreads([{ scope: 'c41', server: 's', last_read: 1, latest: 2 }], true)
    dispatch({ type: 'banned', username: 'dave' })
    await tick()
    dispatch(live(49, 700))
    expect(st().reads.c49).toEqual({ lastRead: 0, latest: 700, server: 's' })
    unreads([], false)
    dispatch({ type: 'banned', username: 'dave' })
    await tick()
    dispatch(live(48, 800))
    expect(st().reads.c48).toEqual({ lastRead: 799, latest: 800, server: 's' })
  })
})
