import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { allPings, dmPingCount, knownMentions, serverPingCount, useStore } from '../store'
import { mentionCandidates } from '../mentions'
import { scopePings } from '../pings'
import { headline, type Piece } from '../notices'
import type { Ping, WsEvent } from '../types'
import { me, member, msg, serverDetail, user } from './fixtures'

const st = () => useStore.getState()
const line = (pieces: Piece[]) => pieces.map(p => p.text).join('')
const dispatch = (ev: WsEvent) => st().applyWsEvent(ev)
const realFetch = globalThis.fetch
const realWindow = (globalThis as { window?: unknown }).window
let requests: { url: string; body: string | null }[] = []
let route: (url: string) => unknown = () => []
const tick = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

const ping = (over: Partial<Ping> = {}): Ping => ({
  id: 1,
  kind: 'mention',
  scope: 'c1',
  server: 's',
  message_id: 10,
  thread_root_id: null,
  actor: user('alice', { display_name: 'Alice' }),
  emoji: null,
  excerpt: 'hi @bob',
  created_at: 1,
  ...over,
})
const pinged = (p: Ping, username = 'bob'): WsEvent => ({ type: 'ping', username, ping: p })
const counted = (scope: string, server: string | null, bulk: number, bulkUntil: number) => ({
  scope,
  server,
  bulk,
  bulkUntil,
  ids: [] as number[],
})
const reads = () =>
  requests.filter(r => r.url.endsWith('/read')).map(r => JSON.parse(r.body ?? '{}'))

beforeEach(() => {
  ;(globalThis as { window?: unknown }).window = {
    location: { pathname: '/', href: 'http://x/', origin: 'http://x', protocol: 'http:' },
    history: { state: null, pushState: () => {}, replaceState: () => {} },
  }
  requests = []
  route = () => []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    requests.push({ url, body: (init?.body as string | undefined) ?? null })
    return new Response(JSON.stringify(route(url)), { status: 200 })
  }) as typeof fetch
  useStore.setState({
    me: me('bob'),
    token: 't',
    guest: false,
    view: { kind: 'channel', server: 's', channelId: 2 },
    servers: {
      s: serverDetail('s', {
        channels: [
          { id: 1, name: 'general', kind: 'text', slowmode_seconds: 0, perms: [] },
          { id: 2, name: 'random', kind: 'text', slowmode_seconds: 0, perms: [] },
        ] as never,
      }),
    },
    dms: [{ id: 4, other: user('alice'), is_self: false }],
    messages: {},
    newer: {},
    reads: {},
    pings: {},
    atBottom: { c2: true },
    panel: null,
    notices: [],
  })
})

afterEach(() => {
  globalThis.fetch = realFetch
  ;(globalThis as { window?: unknown }).window = realWindow
})

describe('incoming pings', () => {
  test('elsewhere: a badge and a toast that names the channel', () => {
    dispatch(pinged(ping()))
    dispatch(pinged(ping({ id: 2 })))
    expect(st().pings).toEqual({
      c1: { scope: 'c1', server: 's', bulk: 0, bulkUntil: 0, ids: [1, 2] },
    })
    expect(serverPingCount(st(), 's')).toBe(2)
    expect(allPings(st())).toBe(2)
    expect(st().notices.map(n => `${line(headline(n))}|${n.body}`)).toEqual([
      '2 new messages from Alice|hi @bob',
    ])
  })

  test('pings for someone else are ignored', () => {
    dispatch(pinged(ping(), 'carol'))
    expect(st().pings).toEqual({})
    expect(st().notices).toEqual([])
  })

  test('watching the scope at the bottom: no toast, no badge, marked seen on the server', async () => {
    useStore.setState({ reads: { c2: { lastRead: 9, latest: 9, server: 's' } } })
    dispatch(pinged(ping({ scope: 'c2' })))
    await tick()
    expect(st().pings).toEqual({})
    expect(st().notices).toEqual([])
    expect(reads()).toEqual([{ scope: 'c2', last_read: 9, pings_until: 1 }])
  })

  test('watching the thread at the bottom marks only that thread seen', async () => {
    useStore.setState({
      panel: { kind: 'thread', root: msg(5, { channel_id: 1 }) } as never,
      atBottom: { c2: true, t5: true },
    })
    dispatch(pinged(ping({ id: 3, thread_root_id: 5 })))
    await tick()
    expect(st().pings).toEqual({})
    expect(st().notices).toEqual([])
    expect(reads()).toEqual([{ scope: 't5', last_read: 0, pings_until: 3 }])
  })

  test('scrolled up in the scope still badges', () => {
    useStore.setState({ atBottom: { c2: false } })
    dispatch(pinged(ping({ scope: 'c2' })))
    expect(scopePings(st().pings, 'c2')).toBe(1)
  })

  test('a DM mention toasts once, as a ping', () => {
    useStore.setState({ view: { kind: 'channel', server: 's', channelId: 2 } })
    dispatch({
      type: 'message',
      server: null,
      channel_id: null,
      dm_id: 4,
      dm_users: ['alice', 'bob'],
      message: msg(11, { channel_id: null, dm_id: 4, content: 'yo @bob' }),
    })
    expect(st().notices).toEqual([])
    dispatch(pinged(ping({ scope: 'd4', server: null, message_id: 11 })))
    expect(dmPingCount(st())).toBe(1)
    expect(st().notices.map(n => n.action)).toEqual(['mentioned you'])
  })
})

describe('clearing pings', () => {
  test('read_updated from another tab clears pings up to its bound', () => {
    useStore.setState({
      pings: {
        c1: { scope: 'c1', server: 's', bulk: 2, bulkUntil: 3, ids: [7] },
        t5: counted('c1', 's', 1, 4),
      },
    })
    dispatch({ type: 'read_updated', username: 'bob', scope: 'c1', last_read: 4, pings_until: 3 })
    expect(st().pings).toEqual({
      c1: { scope: 'c1', server: 's', bulk: 0, bulkUntil: 0, ids: [7] },
      t5: counted('c1', 's', 1, 4),
    })
    expect(scopePings(st().pings, 'c1')).toBe(2)
    dispatch({ type: 'read_updated', username: 'bob', scope: 't5', last_read: 0, pings_until: 4 })
    expect(Object.keys(st().pings)).toEqual(['c1'])
    expect(st().reads.t5).toBeUndefined()
    dispatch({ type: 'read_updated', username: 'bob', scope: 'c1', last_read: 4, pings_until: 0 })
    expect(Object.keys(st().pings)).toEqual(['c1'])
    dispatch({ type: 'read_updated', username: 'bob', scope: 'c1', last_read: 4, pings_until: 7 })
    expect(st().pings).toEqual({})
  })

  test('ping_count replaces the scope after a deleted mention', () => {
    useStore.setState({
      pings: { c1: counted('c1', 's', 3, 9), t5: counted('c1', 's', 1, 8) },
    })
    dispatch({
      type: 'ping_count',
      username: 'bob',
      scope: 'c1',
      pings: 1,
      pings_until: 0,
      thread_pings: [{ root_id: 5, pings: 1, pings_until: 8 }],
    })
    expect(st().pings).toEqual({ t5: counted('c1', 's', 1, 8) })
    dispatch({
      type: 'ping_count',
      username: 'bob',
      scope: 'c1',
      pings: 0,
      pings_until: 0,
      thread_pings: [],
    })
    expect(st().pings).toEqual({})
  })

  test('reaching the bottom of a read scope with pings still tells the server', async () => {
    useStore.setState({
      reads: { c1: { lastRead: 20, latest: 20, server: 's' } },
      pings: { c1: counted('c1', 's', 1, 6), t5: counted('c1', 's', 1, 7) },
    })
    st().markRead('c1', 20)
    await tick()
    expect(st().pings).toEqual({ t5: counted('c1', 's', 1, 7) })
    expect(reads()).toEqual([{ scope: 'c1', last_read: 20, pings_until: 6 }])
    st().markRead('c1', 20)
    await tick()
    expect(reads()).toHaveLength(1)
    st().seeThread(5)
    await tick()
    expect(st().pings).toEqual({})
    expect(reads().at(-1)).toEqual({ scope: 't5', last_read: 0, pings_until: 7 })
  })

  test('reading new messages clears the badge at once, threads stay', () => {
    useStore.setState({
      reads: { c1: { lastRead: 20, latest: 25, server: 's' } },
      pings: { c1: counted('c1', 's', 2, 9), t5: counted('c1', 's', 1, 7) },
    })
    st().markRead('c1', 25)
    expect(st().pings).toEqual({ t5: counted('c1', 's', 1, 7) })
  })

  test('leaving a server forgets its pings', () => {
    useStore.setState({
      pings: {
        c1: counted('c1', 's', 1, 1),
        t5: counted('c1', 's', 1, 2),
        d4: counted('d4', null, 1, 3),
      },
      me: me('bob', {
        servers: [{ name: 's', display_name: 's', creator: null, is_admin: false }],
      }),
    })
    dispatch({ type: 'member_left', server: 's', username: 'bob' })
    expect(st().pings).toEqual({ d4: counted('d4', null, 1, 3) })
  })
})

describe('unreads load', () => {
  test('ping counts come from /api/unreads and survive the merge', async () => {
    useStore.setState({ pings: { c9: counted('c9', 's', 1, 1) } })
    route = url =>
      url.endsWith('/unreads')
        ? {
            items: [
              {
                scope: 'c1',
                server: 's',
                last_read: 5,
                latest: 5,
                pings: 2,
                pings_until: 4,
                thread_pings: [{ root_id: 3, pings: 1, pings_until: 2 }],
              },
              { scope: 'd4', server: null, last_read: 1, latest: 3, pings: 0 },
            ],
            more: false,
          }
        : []
    dispatch({ type: 'banned', username: 'dave' })
    await tick()
    await tick()
    expect(st().pings).toEqual({
      c1: counted('c1', 's', 1, 4),
      t3: counted('c1', 's', 1, 2),
    })
    expect(serverPingCount(st(), 's')).toBe(2)
  })
})

describe('mention pills', () => {
  test('every known @ in a long sentence is a pill', () => {
    useStore.setState({
      memberInfo: { s: { bob: member('bob'), dave: member('dave'), carol: member('carol') } },
    })
    const m = msg(11, {
      channel_id: 1,
      content:
        '@bob, @dave, can you and the team look at it? I think it is related to the thing @carol did',
    })
    expect(knownMentions(st(), m, mentionCandidates(m.content)).split('\n')).toEqual([
      'bob',
      'dave',
      'carol',
    ])
  })
})
