import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  allMarkTargets,
  dmsMarkTargets,
  scopeMarkTargets,
  serverUnread,
  serversMarkTargets,
  useStore,
  resetSessionCaches,
} from '../store'
import { READ_BATCH_MAX, chunked, markTargets, markedRead, withThreads } from '../reads'
import type { Pings } from '../pings'
import { EMPTY_NOTIFY } from '../notify'
import type { ReadMark } from '../lists'
import { me, serverDetail, user } from './fixtures'

afterAll(resetSessionCaches)

const st = () => useStore.getState()
const realFetch = globalThis.fetch
const realWindow = (globalThis as { window?: unknown }).window
let requests: { url: string; body: string | null }[] = []
let route: (url: string) => unknown = () => ({ ok: true })

const counted = (scope: string, server: string | null, bulk: number, bulkUntil: number) => ({
  scope,
  server,
  bulk,
  bulkUntil,
  ids: [] as number[],
})

const READS: Record<string, ReadMark> = {
  c1: { lastRead: 5, latest: 9, server: 's' },
  c2: { lastRead: 9, latest: 9, server: 's' },
  c7: { lastRead: 1, latest: 3, server: 'other' },
  c8: { lastRead: 1, latest: 3, server: 'preview' },
  d4: { lastRead: 2, latest: 6 },
  d5: { lastRead: 6, latest: 6 },
}

const PINGS: Pings = {
  c2: counted('c2', 's', 1, 40),
  t90: counted('c2', 's', 2, 41),
  d5: counted('d5', null, 1, 42),
}

const batches = () =>
  requests
    .filter(r => r.url.endsWith('/read/batch'))
    .map(r => (JSON.parse(r.body ?? '{}') as { scopes: string[] }).scopes)

beforeEach(() => {
  ;(globalThis as { window?: unknown }).window = {
    location: { pathname: '/', href: 'http://x/', origin: 'http://x', protocol: 'http:' },
    history: { state: null, pushState: () => {}, replaceState: () => {} },
  }
  requests = []
  route = () => ({ ok: true })
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    requests.push({ url, body: (init?.body as string | undefined) ?? null })
    return new Response(JSON.stringify(route(url)), { status: 200 })
  }) as typeof fetch
  useStore.setState({
    me: me('bob', {
      servers: [
        { name: 's', display_name: 's', creator: null, is_admin: false },
        { name: 'other', display_name: 'other', creator: null, is_admin: false },
      ] as never,
    }),
    token: 't',
    guest: false,
    view: null,
    servers: {
      s: serverDetail('s', {
        channels: [
          { id: 1, name: 'general', kind: 'text', slowmode_seconds: 0, perms: [] },
          { id: 2, name: 'random', kind: 'text', slowmode_seconds: 0, perms: [] },
          { id: 3, name: 'talk', kind: 'voice', slowmode_seconds: 0, perms: [] },
        ] as never,
      }),
    },
    dms: [{ id: 4, other: user('alice'), is_self: false }],
    messages: {},
    reads: READS,
    pings: PINGS,
    unreadAnchor: { c1: 5 },
    notifyPrefs: EMPTY_NOTIFY,
    confirm: null,
    panel: null,
  })
})

afterEach(() => {
  globalThis.fetch = realFetch
  ;(globalThis as { window?: unknown }).window = realWindow
})

describe('mark targets', () => {
  test('unread scopes, scopes with pings and their threads', () => {
    expect(markTargets(READS, PINGS, () => true).sort()).toEqual(
      ['c1', 'c2', 'c7', 'c8', 'd4', 'd5', 't90'].sort()
    )
    expect(markTargets(READS, PINGS, scope => scope === 'c2').sort()).toEqual(['c2', 't90'])
    expect(markTargets(READS, PINGS, scope => scope === 'd5')).toEqual(['d5'])
    expect(markTargets(READS, {}, scope => scope === 'c2')).toEqual([])
  })

  test('selectors pick a scope, servers, DMs or everything joined', () => {
    expect(scopeMarkTargets(st(), 'c1')).toEqual(['c1'])
    expect(scopeMarkTargets(st(), 'd5')).toEqual(['d5'])
    expect(scopeMarkTargets(st(), 'c9')).toEqual([])
    expect(serversMarkTargets(st(), ['s']).sort()).toEqual(['c1', 'c2', 't90'])
    expect(serversMarkTargets(st(), ['s', 'other']).sort()).toEqual(['c1', 'c2', 'c7', 't90'])
    expect(dmsMarkTargets(st()).sort()).toEqual(['d4', 'd5'])
    expect(allMarkTargets(st()).sort()).toEqual(['c1', 'c2', 'c7', 'd4', 'd5', 't90'])
  })

  test('a channel of a loaded server counts even without a server on its read mark', () => {
    useStore.setState({ reads: { c1: { lastRead: 1, latest: 2 } }, pings: {} })
    expect(serversMarkTargets(st(), ['s'])).toEqual(['c1'])
    expect(serversMarkTargets(st(), ['other'])).toEqual([])
  })

  test('mark all skips channels of servers that are not joined', () => {
    useStore.setState({
      reads: {
        c1: { lastRead: 1, latest: 2 },
        c9: { lastRead: 1, latest: 2 },
        c8: { lastRead: 1, latest: 3, server: 'preview' },
      },
      pings: { c9: counted('c9', null, 1, 50) },
    })
    expect(allMarkTargets(st())).toEqual(['c1'])
  })

  test('muted scopes are marked too', () => {
    useStore.setState({
      notifyPrefs: {
        ...EMPTY_NOTIFY,
        servers: { s: { level: 'nothing', muteUntil: 'forever' } },
        dms: { 4: { muteUntil: 'forever' } },
      },
    })
    expect(serverUnread(st(), 's')).toBe(false)
    expect(serversMarkTargets(st(), ['s']).sort()).toEqual(['c1', 'c2', 't90'])
    expect(dmsMarkTargets(st()).sort()).toEqual(['d4', 'd5'])
  })

  test('withThreads adds the threads with pings under a channel', () => {
    expect(withThreads(['c2'], PINGS).sort()).toEqual(['c2', 't90'])
    expect(withThreads(['d4'], PINGS)).toEqual(['d4'])
  })

  test('markedRead moves positions to the newest message and drops pings', () => {
    const out = markedRead(READS, PINGS, ['c1', 'c2', 't90'])
    expect(out.reads.c1).toEqual({ lastRead: 9, latest: 9, server: 's' })
    expect(out.reads.c2).toBe(READS.c2)
    expect(out.reads.d4).toBe(READS.d4)
    expect(out.pings).toEqual({ d5: PINGS.d5 })
    const none = markedRead(READS, PINGS, [])
    expect(none.reads).toBe(READS)
    expect(none.pings).toBe(PINGS)
  })

  test('chunks hold at most one batch each', () => {
    const list = Array.from({ length: 450 }, (_, i) => `c${i}`)
    const parts = chunked(list)
    expect(parts.map(p => p.length)).toEqual([READ_BATCH_MAX, READ_BATCH_MAX, 50])
    expect(parts.flat()).toEqual(list)
    expect(chunked([])).toEqual([])
  })
})

describe('mark as read actions', () => {
  test('a channel clears its dot, its pings and its threads, and posts one batch', async () => {
    await st().markScopesRead(['c2'])
    expect(st().pings).toEqual({ d5: PINGS.d5 })
    expect(batches()).toEqual([['c2', 't90']])
    await st().markScopesRead(['c1'])
    expect(st().reads.c1.lastRead).toBe(9)
    expect(st().unreadAnchor.c1).toBe(0)
    expect(batches()[1]).toEqual(['c1'])
  })

  test('a server and a folder mark only their channels', async () => {
    await st().markServerRead('s')
    expect(batches()).toEqual([['c1', 'c2', 't90']])
    expect(st().reads.c7.lastRead).toBe(1)
    expect(st().pings.d5).toEqual(PINGS.d5)
    await st().markServersRead(['other'])
    expect(batches()[1]).toEqual(['c7'])
    expect(st().reads.c7.lastRead).toBe(3)
  })

  test('DMs, then everything, skipping a previewed server', async () => {
    await st().markDmsRead()
    expect(batches()).toEqual([['d4', 'd5']])
    await st().markAllRead()
    expect(batches()[1].sort()).toEqual(['c1', 'c2', 'c7', 't90'])
    expect(st().reads.c8.lastRead).toBe(1)
    expect(Object.keys(st().pings)).toEqual([])
  })

  test('large sets go out in chunks of 200', async () => {
    const reads: Record<string, ReadMark> = {}
    for (let i = 1; i <= 450; i += 1) reads[`d${i}`] = { lastRead: 0, latest: 1 }
    useStore.setState({ reads, pings: {} })
    await st().markAllRead()
    expect(batches().map(b => b.length)).toEqual([200, 200, 50])
  })

  test('nothing to mark sends nothing; mark all asks first', async () => {
    useStore.setState({ reads: {}, pings: {} })
    await st().markAllRead()
    st().askMarkAllRead()
    expect(st().confirm).toBeNull()
    expect(batches()).toEqual([])
    useStore.setState({ reads: READS, pings: PINGS })
    st().askMarkAllRead()
    expect(st().confirm?.title).toBe('Mark all as read')
    expect(batches()).toEqual([])
    st().confirm?.action('')
    await new Promise(r => setTimeout(r, 0))
    expect(batches()).toHaveLength(1)
  })

  test('the echo on another tab clears the same badges', () => {
    useStore.setState({ token: null })
    st().applyWsEvent({
      type: 'read_updated',
      username: 'bob',
      scope: 't90',
      last_read: 0,
      pings_until: 41,
    })
    st().applyWsEvent({
      type: 'read_updated',
      username: 'bob',
      scope: 'c1',
      last_read: 12,
      pings_until: 0,
    })
    expect(st().pings.t90).toBeUndefined()
    expect(st().reads.c1).toEqual({ lastRead: 12, latest: 12, server: 's' })
  })

  test('a failed batch queues the reads again', async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, body: (init?.body as string | undefined) ?? null })
      if (url.endsWith('/read/batch'))
        return new Response(JSON.stringify({ error: 'Down' }), { status: 503 })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof fetch
    useStore.setState({ reads: { c11: { lastRead: 1, latest: 4, server: 's' } }, pings: {} })
    await st().markScopesRead(['c11'])
    expect(st().reads.c11.lastRead).toBe(4)
    expect(requests.filter(r => r.url.endsWith('/read'))).toEqual([])
    await new Promise(r => setTimeout(r, 2200))
    const single = requests.filter(r => r.url.endsWith('/read'))
    expect(single.map(r => JSON.parse(r.body ?? '{}'))).toEqual([
      { scope: 'c11', last_read: 4, pings_until: 0 },
    ])
  })

  test('signed out or as a guest, nothing happens', async () => {
    useStore.setState({ me: null, guest: true })
    await st().markAllRead()
    expect(st().reads).toBe(READS)
    expect(batches()).toEqual([])
  })
})
