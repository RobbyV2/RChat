import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { useStore } from '../store'
import type { Message, Unread, WsEvent } from '../types'
import { me, msg, user } from './fixtures'

const st = () => useStore.getState()
const dispatch = (ev: WsEvent) => st().applyWsEvent(ev)
const realFetch = globalThis.fetch
const realWindow = (globalThis as { window?: unknown }).window
let unreads: ((body: { items: Unread[]; more: boolean }) => void)[] = []
let pages: Message[][] = []

const range = (from: number, to: number, over: Partial<Message> = {}) =>
  Array.from({ length: to - from + 1 }, (_, i) => msg(from + i, over))
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const live = (channel: number, id: number, author = 'bob'): WsEvent => ({
  type: 'message',
  server: 's',
  channel_id: channel,
  dm_id: null,
  dm_users: null,
  message: msg(id, { channel_id: channel, author: user(author) }),
})

beforeEach(() => {
  ;(globalThis as { window?: unknown }).window = {
    location: { pathname: '/', href: 'http://x/', origin: 'http://x', protocol: 'http:' },
    history: { state: null, pushState: () => {}, replaceState: () => {} },
  }
  unreads = []
  pages = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('/unreads'))
      return new Promise<Response>(resolve => unreads.push(body => resolve(reply(body))))
    return reply(url.includes('/messages') ? (pages.shift() ?? []) : [])
  }) as typeof fetch
  useStore.setState({
    me: me('alice'),
    token: null,
    guest: false,
    view: { kind: 'channel', server: 's', channelId: 9 },
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
    atBottom: {},
    panel: null,
    error: null,
  })
})

afterEach(() => {
  globalThis.fetch = realFetch
  ;(globalThis as { window?: unknown }).window = realWindow
})

const loadUnreadsLate = async () => {
  dispatch({ type: 'banned', username: 'mallory' })
  await tick()
  expect(unreads.length).toBe(1)
}

describe('unread divider when reads arrive late', () => {
  test('a view opened before /unreads answers gets its divider once it does', async () => {
    await loadUnreadsLate()
    pages = [range(1, 20)]
    await st().openChannel('s', 1, 'none')
    expect(st().unreadAnchor.c1).toBe(0)
    st().markRead('c1', 20)
    unreads[0]({ items: [{ scope: 'c1', server: 's', last_read: 12, latest: 20 }], more: false })
    await tick()
    expect(st().unreadAnchor.c1).toBe(12)
    expect(st().reads.c1.lastRead >= 20).toBe(true)
  })

  test('a view left before /unreads answers gets no divider', async () => {
    await loadUnreadsLate()
    pages = [range(1, 20), range(1, 5)]
    await st().openChannel('s', 1, 'none')
    await st().openChannel('s', 2, 'none')
    unreads[0]({ items: [{ scope: 'c1', server: 's', last_read: 12, latest: 20 }], more: false })
    await tick()
    expect(st().unreadAnchor.c1).toBeUndefined()
    expect(st().unreadAnchor.c2).toBe(0)
  })

  test('a fully read scope stays without a divider', async () => {
    await loadUnreadsLate()
    pages = [range(1, 20)]
    await st().openChannel('s', 1, 'none')
    unreads[0]({ items: [], more: false })
    await tick()
    expect(st().unreadAnchor.c1).toBe(0)
  })

  test('sending before /unreads answers keeps the divider away', async () => {
    await loadUnreadsLate()
    pages = [range(1, 20)]
    await st().openChannel('s', 1, 'none')
    globalThis.fetch = (() => new Promise<Response>(() => {})) as typeof fetch
    st().sendMessage('hi')
    unreads[0]({ items: [{ scope: 'c1', server: 's', last_read: 12, latest: 20 }], more: false })
    await tick()
    expect(st().unreadAnchor.c1).toBe(0)
  })
})

describe('own messages', () => {
  test('an own message in a scope with no read state is read, not unread', () => {
    dispatch(live(3, 50, 'alice'))
    expect(st().reads.c3).toEqual({ lastRead: 50, latest: 50, server: 's' })
  })

  test("someone else's message in a scope with no read state is unread", () => {
    dispatch(live(3, 50))
    expect(st().reads.c3).toEqual({ lastRead: 49, latest: 50, server: 's' })
  })
})

describe('following the bottom per view', () => {
  test('a stale flag from another view does not decide trimming', () => {
    useStore.setState({
      view: { kind: 'channel', server: 's', channelId: 1 },
      messages: { c1: range(1, 250) },
      atBottom: { c2: true, c1: false },
    })
    dispatch(live(1, 251))
    expect(st().messages.c1.length).toBe(251)
  })

  test('live messages are marked read only while the view follows the bottom', () => {
    useStore.setState({
      view: { kind: 'channel', server: 's', channelId: 1 },
      messages: { c1: range(1, 10) },
      reads: { c1: { lastRead: 10, latest: 10 } },
      atBottom: { c1: false },
    })
    dispatch(live(1, 11))
    expect(st().reads.c1.lastRead).toBe(10)
    st().setAtBottom('c1', true)
    dispatch(live(1, 12))
    expect(st().reads.c1.lastRead).toBe(12)
  })

  test('opening a view starts it following the bottom', async () => {
    useStore.setState({ atBottom: { c1: false } })
    pages = [range(1, 5)]
    await st().openChannel('s', 1, 'none')
    expect(st().atBottom.c1).toBe(true)
  })
})
