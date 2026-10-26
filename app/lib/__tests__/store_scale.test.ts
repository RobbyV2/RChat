import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { useStore } from '../store'
import type { DmSummary, Message, WsEvent } from '../types'
import { me, msg, user } from './fixtures'

const st = () => useStore.getState()
const dispatch = (ev: WsEvent) => st().applyWsEvent(ev)
const realFetch = globalThis.fetch
const realWindow = (globalThis as { window?: unknown }).window
let requests: { url: string; body: string | null }[] = []
let replies: unknown[] = []

const range = (from: number, to: number, over: Partial<Message> = {}) =>
  Array.from({ length: to - from + 1 }, (_, i) => msg(from + i, over))
const ids = (key: string) => (st().messages[key] ?? []).map(m => m.id)
const live = (id: number): WsEvent => ({
  type: 'message',
  server: 's',
  channel_id: 1,
  dm_id: null,
  dm_users: null,
  message: msg(id, { author: user('bob') }),
})
const dm = (id: number): DmSummary => ({
  id,
  other: user(`u${id}`),
  is_self: false,
})
const reads = () => requests.filter(r => r.url.endsWith('/read'))

beforeEach(() => {
  ;(globalThis as { window?: unknown }).window = {
    location: { pathname: '/', href: 'http://x/', origin: 'http://x', protocol: 'http:' },
    history: { state: null, pushState: () => {}, replaceState: () => {} },
  }
  requests = []
  replies = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), body: (init?.body as string | undefined) ?? null })
    return new Response(JSON.stringify(replies.shift() ?? []), { status: 200 })
  }) as typeof fetch
  useStore.setState({
    me: me('alice'),
    token: null,
    guest: false,
    view: { kind: 'channel', server: 's', channelId: 1 },
    servers: {},
    dms: [],
    messages: {},
    older: {},
    newer: {},
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

describe('bounded message window', () => {
  test('scrolling far back drops the newest pages and detaches', async () => {
    useStore.setState({
      messages: { c1: range(1001, 1200) },
      older: { c1: { more: true, loading: false } },
    })
    replies = [range(951, 1000)]
    await st().loadOlder()
    expect(ids('c1').length).toBe(250)
    expect(st().newer.c1).toBeUndefined()
    replies = [range(901, 950)]
    await st().loadOlder()
    expect(ids('c1')[0]).toBe(901)
    expect(ids('c1').length).toBe(200)
    expect(ids('c1')[199]).toBe(1100)
    expect(st().newer.c1).toEqual({ more: true, loading: false })
    dispatch(live(1300))
    expect(ids('c1')[199]).toBe(1100)
  })

  test('scrolling back down drops the oldest pages and reloads newer ones', async () => {
    useStore.setState({
      messages: { c1: range(901, 1100) },
      older: { c1: { more: true, loading: false } },
      newer: { c1: { more: true, loading: false } },
    })
    replies = [range(1101, 1150)]
    await st().loadNewer()
    replies = [range(1151, 1200)]
    await st().loadNewer()
    expect(requests.map(r => r.url.split('?')[1])).toEqual(['after=1100', 'after=1150'])
    expect(ids('c1').length).toBe(200)
    expect(ids('c1')[0]).toBe(1001)
    expect(st().older.c1).toEqual({ more: true, loading: false })
  })

  test('live messages at the bottom keep the window bounded', () => {
    useStore.setState({ messages: { c1: range(1, 250) } })
    dispatch(live(251))
    expect(ids('c1').length).toBe(200)
    expect(ids('c1')[199]).toBe(251)
    expect(st().older.c1).toEqual({ more: true, loading: false })
  })

  test('live messages while scrolled up grow the list, then detach', () => {
    useStore.setState({ messages: { c1: range(1, 399) }, atBottom: false })
    dispatch(live(400))
    expect(ids('c1').length).toBe(400)
    dispatch(live(401))
    expect(ids('c1').length).toBe(400)
    expect(st().newer.c1).toEqual({ more: true, loading: false })
  })
})

describe('view cache', () => {
  test('only the most recent views stay cached', async () => {
    const all = Array.from({ length: 12 }, (_, i) => dm(i + 1))
    useStore.setState({ dms: all })
    for (const d of all) {
      replies = [[msg(d.id * 10, { channel_id: null, dm_id: d.id })]]
      await st().openDm(d.id)
    }
    const keys = Object.keys(st().messages).sort()
    expect(keys.length).toBe(8)
    expect(keys).toContain('d12')
    expect(keys.includes('d1')).toBe(false)
    expect(st().older.d1).toBeUndefined()
  })
})

describe('read coalescing', () => {
  test('a burst of messages while watching sends one /read on leaving', async () => {
    useStore.setState({ token: 't', messages: { c1: range(1, 10) } })
    for (let id = 11; id <= 30; id += 1) dispatch(live(id))
    await Promise.resolve()
    expect(reads()).toHaveLength(0)
    expect(st().reads.c1.lastRead).toBe(30)
    useStore.setState({ dms: [dm(5)] })
    replies = [[]]
    await st().openDm(5)
    expect(reads()).toHaveLength(1)
    expect(JSON.parse(reads()[0].body ?? '{}')).toEqual({ scope: 'c1', last_read: 30 })
  })

  test('a channel that is not on screen is not marked read', async () => {
    useStore.setState({ token: 't', view: { kind: 'channel', server: 's', channelId: 2 } })
    for (let id = 11; id <= 15; id += 1) dispatch(live(id))
    expect(st().reads.c1.lastRead).toBe(10)
    expect(st().reads.c1.latest).toBe(15)
  })
})
