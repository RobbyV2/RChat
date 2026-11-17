import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { ApiError } from '../api'
import {
  SEARCH_PAGE,
  SEARCH_RETRY_MAX,
  addSearchPage,
  dayEndTs,
  dayStartTs,
  searchParams,
  searchRetryAfter,
  shortSearch,
  type SearchArgs,
} from '../search'
import { useStore, resetSessionCaches } from '../store'
import { result } from './fixtures'

afterAll(resetSessionCaches)

const page = (top: number, count: number) =>
  Array.from({ length: count }, (_, i) => result(top - i, top - i))

const args = (over: Partial<SearchArgs> = {}): SearchArgs => ({
  q: '',
  from: '',
  channelId: null,
  hasFile: false,
  beforeTs: null,
  afterTs: null,
  ...over,
})

describe('search date bounds', () => {
  test('before is the start of that local day', () => {
    expect(dayStartTs('2026-03-08')).toBe(new Date(2026, 2, 8).getTime() / 1000)
  })

  test('after is the last second of that local day', () => {
    expect(dayEndTs('2026-03-08')).toBe(new Date(2026, 2, 9).getTime() / 1000 - 1)
    expect(dayEndTs('2026-12-31')).toBe(new Date(2027, 0, 1).getTime() / 1000 - 1)
  })

  test('empty or malformed dates give no bound', () => {
    expect(dayStartTs('')).toBeNull()
    expect(dayEndTs('2026-3-8')).toBeNull()
  })
})

describe('search params', () => {
  test('empty filters are omitted', () => {
    expect(searchParams(args(), null, null)).toEqual({
      q: undefined,
      from: undefined,
      channel_id: undefined,
      has: undefined,
      cursor: undefined,
      before_ts: undefined,
      after_ts: undefined,
      servers: undefined,
    })
  })

  test('filters, cursor and guest servers go to the server', () => {
    const full = args({
      q: 'hi',
      from: 'bob',
      channelId: 7,
      hasFile: true,
      beforeTs: 200,
      afterTs: 100,
    })
    expect(searchParams(full, 'c42', ['a', 'b'])).toEqual({
      q: 'hi',
      from: 'bob',
      channel_id: 7,
      has: 'file',
      cursor: 'c42',
      before_ts: 200,
      after_ts: 100,
      servers: ['a', 'b'],
    })
  })
})

describe('search pages', () => {
  test('the next cursor decides whether there is more, not the page length', () => {
    expect(addSearchPage([], page(100, SEARCH_PAGE), 'n').hasMore).toBe(true)
    expect(addSearchPage([], page(3, 3), 'n').hasMore).toBe(true)
    expect(addSearchPage([], page(100, SEARCH_PAGE), null).hasMore).toBe(false)
  })

  test('pages append in order without duplicates', () => {
    const first = page(100, 3)
    const { results } = addSearchPage(first, [result(98, 98), result(97, 97)], null)
    expect(results.map(r => r.message.id)).toEqual([100, 99, 98, 97])
  })
})

describe('short search text', () => {
  test('is under 3 characters, counted as the server counts them', () => {
    expect(['', 'w', 'we', ' we ', 'éé', '😀😀'].map(shortSearch)).toEqual(Array(6).fill(true))
    expect(['wee', 'weekly notes', '日本語', '😀😀😀'].map(shortSearch)).toEqual(
      Array(4).fill(false)
    )
  })
})

describe('search refusals asked again', () => {
  const refused = (status: number, reason?: unknown) =>
    new ApiError('refused', status, { error: 'refused', reason })

  test("the caller's own limits with a short wait are asked again after that wait", () => {
    expect(searchRetryAfter(refused(429, { kind: 'rate', retry_after: 1 }))).toBe(1)
    expect(searchRetryAfter(refused(429, { kind: 'rate', retry_after: SEARCH_RETRY_MAX }))).toBe(
      SEARCH_RETRY_MAX
    )
  })

  test('a long wait, the site at capacity and other failures are not', () => {
    for (const e of [
      refused(429, { kind: 'rate', retry_after: SEARCH_RETRY_MAX + 1 }),
      refused(429, { kind: 'rate', retry_after: 0 }),
      refused(429, { kind: 'rate' }),
      refused(429, { kind: 'rate', retry_after: '1' }),
      refused(429),
      refused(503, { kind: 'capacity', retry_after: 2 }),
      refused(500, { kind: 'rate', retry_after: 1 }),
      new Error('offline'),
      null,
    ])
      expect(searchRetryAfter(e)).toBeNull()
  })
})

const realFetch = globalThis.fetch
let requests: URL[] = []
let replies: unknown[][] = []
let nexts: (string | null)[] = []

beforeEach(() => {
  requests = []
  replies = []
  nexts = []
  useStore.setState({ guest: false, guestServers: [] })
  globalThis.fetch = (async (input: string | URL | Request) => {
    requests.push(new URL(String(input), 'http://localhost'))
    const next = nexts.shift() ?? null
    return new Response(JSON.stringify(replies.shift() ?? []), {
      status: 200,
      headers: next ? { 'X-Next-Cursor': next } : {},
    })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('searchRun', () => {
  const run = (a: SearchArgs, reset: boolean) => useStore.getState().searchRun(a, reset)
  const ids = () => useStore.getState().search.results.map(r => r.message.id)

  test('pages by the server cursor and filters dates on the server', async () => {
    const a = args({ q: 'needle', beforeTs: 5000, afterTs: 1000 })
    replies = [page(900, 25), page(875, 4)]
    nexts = ['k876', null]
    await run(a, true)
    const first = requests[0].searchParams
    expect(first.get('q')).toBe('needle')
    expect(first.get('before_ts')).toBe('5000')
    expect(first.get('after_ts')).toBe('1000')
    expect(first.get('cursor')).toBeNull()
    expect(first.get('offset')).toBeNull()
    expect(useStore.getState().search.hasMore).toBe(true)
    await run(a, false)
    expect(requests[1].searchParams.get('cursor')).toBe('k876')
    expect(ids()).toHaveLength(29)
    expect(useStore.getState().search.hasMore).toBe(false)
    await run(a, false)
    expect(requests).toHaveLength(2)
  })

  test('short pages with a next cursor keep going until a page worth of results', async () => {
    replies = [page(900, 3), [], page(500, 30)]
    nexts = ['a', 'b', 'c']
    await run(args({ q: 'rare' }), true)
    expect(requests.map(r => r.searchParams.get('cursor'))).toEqual([null, 'a', 'b'])
    expect(ids()).toHaveLength(33)
    expect(useStore.getState().search.hasMore).toBe(true)
    expect(useStore.getState().search.loading).toBe(false)
  })

  test('text under 3 characters reads one page a run, and the next one as asked', async () => {
    replies = [page(900, 3), [], page(500, 30)]
    nexts = ['a', 'b', 'c']
    await run(args({ q: 'no' }), true)
    const cursors = () => requests.map(r => r.searchParams.get('cursor'))
    expect(cursors()).toEqual([null])
    expect(ids()).toHaveLength(3)
    expect(useStore.getState().search).toMatchObject({ hasMore: true, loading: false, cursor: 'a' })
    await run(args({ q: 'no' }), false)
    expect(cursors()).toEqual([null, 'a'])
    expect(ids()).toHaveLength(3)
    expect(useStore.getState().search).toMatchObject({ hasMore: true, loading: false, cursor: 'b' })
    await run(args({ q: 'no' }), false)
    expect(cursors()).toEqual([null, 'a', 'b'])
    expect(ids()).toHaveLength(33)
  })

  test('a next page continues only the text its cursor came from', async () => {
    replies = [page(900, 25), page(875, 25)]
    nexts = ['we1', 'we2']
    await run(args({ q: 'we' }), true)
    await run(args({ q: 'wee' }), false)
    await run(args({ q: 'we', from: 'bob' }), false)
    await run(args({ q: 'we', hasFile: true }), false)
    expect(requests).toHaveLength(1)
    expect(useStore.getState().search).toMatchObject({ cursor: 'we1', loading: false })
    await run(args({ q: 'we' }), false)
    expect(requests.map(r => [r.searchParams.get('q'), r.searchParams.get('cursor')])).toEqual([
      ['we', null],
      ['we', 'we1'],
    ])
    await run(args({ q: 'wee' }), true)
    expect(requests[2].searchParams.get('cursor')).toBeNull()
  })

  test('the automatic follow-up is bounded', async () => {
    replies = [[], [], [], [], []]
    nexts = ['a', 'b', 'c', 'd', 'e']
    await run(args({ q: 'none' }), true)
    expect(requests).toHaveLength(4)
    expect(useStore.getState().search.hasMore).toBe(true)
    expect(useStore.getState().search.loading).toBe(false)
  })

  test('a reset starts over without a cursor', async () => {
    replies = [page(900, 25), page(50, 1)]
    nexts = ['x', null]
    await run(args({ q: 'a' }), true)
    await run(args({ q: 'b' }), true)
    expect(requests[1].searchParams.get('cursor')).toBeNull()
    expect(ids()).toEqual([50])
  })

  test('guests send their server list as repeated params', async () => {
    useStore.setState({ guest: true, guestServers: ['rchat', 'other', 'a, b'] })
    await run(args({ q: 'x' }), true)
    expect(requests[0].searchParams.getAll('servers')).toEqual(['rchat', 'other', 'a, b'])
  })
})
