import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  SEARCH_PAGE,
  addSearchPage,
  dayEndTs,
  dayStartTs,
  searchCursor,
  searchParams,
  type SearchArgs,
} from '../search'
import { useStore } from '../store'
import { result } from './fixtures'

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
      before: undefined,
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
    expect(searchParams(full, 42, ['a', 'b'])).toEqual({
      q: 'hi',
      from: 'bob',
      channel_id: 7,
      has: 'file',
      before: 42,
      before_ts: 200,
      after_ts: 100,
      servers: 'a,b',
    })
  })
})

describe('search pages', () => {
  test('cursor is the oldest result id', () => {
    expect(searchCursor([])).toBeNull()
    expect(searchCursor(page(100, 25))).toBe(76)
  })

  test('a full page means more, a short page means done', () => {
    expect(addSearchPage([], page(100, SEARCH_PAGE)).hasMore).toBe(true)
    expect(addSearchPage([], page(3, 3)).hasMore).toBe(false)
  })

  test('pages append in order without duplicates', () => {
    const first = page(100, 3)
    const { results } = addSearchPage(first, [result(98, 98), result(97, 97)])
    expect(results.map(r => r.message.id)).toEqual([100, 99, 98, 97])
  })
})

const realFetch = globalThis.fetch
let requests: URL[] = []
let replies: unknown[][] = []

beforeEach(() => {
  requests = []
  replies = []
  useStore.setState({ guest: false, guestServers: [] })
  globalThis.fetch = (async (input: string | URL | Request) => {
    requests.push(new URL(String(input), 'http://localhost'))
    return new Response(JSON.stringify(replies.shift() ?? []), { status: 200 })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('searchRun', () => {
  const run = (a: SearchArgs, reset: boolean) => useStore.getState().searchRun(a, reset)
  const ids = () => useStore.getState().search.results.map(r => r.message.id)

  test('pages with the oldest id as cursor and filters dates on the server', async () => {
    const a = args({ q: 'needle', beforeTs: 5000, afterTs: 1000 })
    replies = [page(900, 25), page(875, 4)]
    await run(a, true)
    const first = requests[0].searchParams
    expect(first.get('q')).toBe('needle')
    expect(first.get('before_ts')).toBe('5000')
    expect(first.get('after_ts')).toBe('1000')
    expect(first.get('before')).toBeNull()
    expect(first.get('offset')).toBeNull()
    expect(useStore.getState().search.hasMore).toBe(true)
    await run(a, false)
    expect(requests[1].searchParams.get('before')).toBe('876')
    expect(ids()).toHaveLength(29)
    expect(useStore.getState().search.hasMore).toBe(false)
    await run(a, false)
    expect(requests).toHaveLength(2)
  })

  test('a reset starts over without a cursor', async () => {
    replies = [page(900, 25), page(50, 1)]
    await run(args({ q: 'a' }), true)
    await run(args({ q: 'b' }), true)
    expect(requests[1].searchParams.get('before')).toBeNull()
    expect(ids()).toEqual([50])
  })

  test('guests send their server list', async () => {
    useStore.setState({ guest: true, guestServers: ['rchat', 'other'] })
    await run(args({ q: 'x' }), true)
    expect(requests[0].searchParams.get('servers')).toBe('rchat,other')
  })
})
