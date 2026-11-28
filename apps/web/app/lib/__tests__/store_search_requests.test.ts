import { flush, testClock, type ManualTime } from './helpers/test_clock'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { SearchArgs } from '../search'
import { useStore } from '../store'
import { memoryStorage, result } from './fixtures'

let clock: ManualTime
beforeEach(() => {
  clock = testClock()
})

const st = () => useStore.getState()
const g = globalThis as { window?: unknown; document?: unknown }
const real = { window: g.window, document: g.document, fetch: globalThis.fetch }

interface Asked {
  q: string
  cursor: string | null
  signal: AbortSignal | null
  answer: (response: Response) => void
}

// Every search request in order; each one waits until the test answers it.
let asked: Asked[] = []
// Whether a pending request ends when its signal aborts, as `fetch` does.
let endsOnAbort = true

const args = (q: string): SearchArgs => ({
  q,
  from: '',
  channelId: null,
  hasFile: false,
  beforeTs: null,
  afterTs: null,
})

const found = (ids: number[], next: string | null = null) =>
  new Response(JSON.stringify(ids.map(id => result(id, 1))), {
    status: 200,
    headers: next === null ? {} : { 'X-Next-Cursor': next },
  })

const refused = (status: number, error: string, kind: string) =>
  new Response(JSON.stringify({ error, reason: { kind, retry_after: 1 } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await flush()
}

const waitFor = async (holds: () => boolean) => {
  for (let i = 0; i < 300 && !holds(); i += 1) await clock.pass(10)
  expect(holds()).toBe(true)
}

const shown = () => ({
  ids: st().search.results.map(r => r.message.id),
  loading: st().search.loading,
  error: st().error,
})

const ask = (q: string, fresh = true) => void st().searchRun(args(q), fresh)

beforeEach(() => {
  asked = []
  endsOnAbort = true
  memoryStorage.clear()
  Object.assign(globalThis, { localStorage: memoryStorage })
  g.window = {
    addEventListener: () => {},
    location: {
      pathname: '/',
      href: 'http://x/',
      origin: 'http://x',
      protocol: 'http:',
      search: '',
      hash: '',
    },
    history: { state: null, pushState: () => {}, replaceState: () => {} },
  }
  g.document = { cookie: '', visibilityState: 'visible', addEventListener: () => {} }
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'http://x/')
    if (!url.pathname.endsWith('/search')) return Promise.resolve(found([]))
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal ?? null
      asked.push({
        q: url.searchParams.get('q') ?? '',
        cursor: url.searchParams.get('cursor'),
        signal,
        answer: resolve,
      })
      if (endsOnAbort)
        signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        )
    })
  }) as typeof fetch
  useStore.setState({
    error: null,
    guest: false,
    search: { results: [], hasMore: false, loading: false, cursor: null },
  })
})

afterEach(() => {
  globalThis.fetch = real.fetch
  g.window = real.window
  g.document = real.document
})

describe('search requests', () => {
  test('a new search aborts the request in flight', async () => {
    ask('ch')
    await settle()
    ask('chatter')
    await settle()
    expect(asked.map(a => [a.q, a.signal?.aborted])).toEqual([
      ['ch', true],
      ['chatter', false],
    ])
    expect(shown()).toEqual({ ids: [], loading: true, error: null })
    asked[1].answer(found([7, 6]))
    await settle()
    expect(shown()).toEqual({ ids: [7, 6], loading: false, error: null })
  })

  test('answers for an older text are dropped, refusals and errors included', async () => {
    endsOnAbort = false
    ask('ch')
    ask('cha')
    ask('chat')
    ask('chatter')
    await settle()
    expect(asked.map(a => a.q)).toEqual(['ch', 'cha', 'chat', 'chatter'])
    asked[0].answer(found([1]))
    asked[1].answer(refused(429, 'A newer search of yours took the place of this one.', 'rate'))
    asked[2].answer(new Response('down', { status: 502 }))
    await settle()
    expect(shown()).toEqual({ ids: [], loading: true, error: null })
    asked[3].answer(found([7]))
    await settle()
    expect(shown()).toEqual({ ids: [7], loading: false, error: null })
  })

  test('an answer for an older text that comes after the latest one changes nothing', async () => {
    endsOnAbort = false
    ask('ch')
    ask('chatter')
    await settle()
    asked[1].answer(found([7]))
    await settle()
    asked[0].answer(found([1, 2, 3]))
    await settle()
    expect(shown()).toEqual({ ids: [7], loading: false, error: null })
  })

  test('a new search aborts loading more of the one before', async () => {
    ask('chatter')
    await settle()
    const page = Array.from({ length: 25 }, (_, i) => 100 - i)
    asked[0].answer(found(page, 'c1'))
    await settle()
    expect(shown()).toEqual({ ids: page, loading: false, error: null })
    ask('chatter', false)
    await settle()
    expect(asked.map(a => [a.q, a.cursor])).toEqual([
      ['chatter', null],
      ['chatter', 'c1'],
    ])
    ask('notes')
    await settle()
    expect(asked.slice(1).map(a => a.signal?.aborted)).toEqual([true, false])
    asked[2].answer(found([5]))
    await settle()
    expect(shown()).toEqual({ ids: [5], loading: false, error: null })
  })

  test('typing short texts asks for one page of each, longer texts read on to a page', async () => {
    for (const q of ['w', 'we']) {
      ask(q)
      await settle()
      asked[asked.length - 1].answer(found([], 'c1'))
      await settle()
    }
    expect(asked.map(a => [a.q, a.cursor])).toEqual([
      ['w', null],
      ['we', null],
    ])
    expect(shown()).toEqual({ ids: [], loading: false, error: null })
    expect(st().search.hasMore).toBe(true)
    ask('wee')
    await settle()
    asked[2].answer(found([], 'c1'))
    await settle()
    expect(asked.slice(2).map(a => [a.q, a.cursor])).toEqual([
      ['wee', null],
      ['wee', 'c1'],
    ])
  })

  test("a refusal of the latest search for the caller's own limits is asked again once", async () => {
    ask('chatter')
    await settle()
    asked[0].answer(refused(429, 'Too many searches. Try again in a moment.', 'rate'))
    await settle()
    expect(asked).toHaveLength(1)
    expect(shown()).toEqual({ ids: [], loading: true, error: null })
    await waitFor(() => asked.length === 2)
    expect(asked[1].q).toBe('chatter')
    asked[1].answer(found([7]))
    await settle()
    expect(shown()).toEqual({ ids: [7], loading: false, error: null })
    ask('notes')
    await settle()
    asked[2].answer(refused(429, 'Too many searches. Try again in a moment.', 'rate'))
    await waitFor(() => asked.length === 4)
    asked[3].answer(refused(429, 'Too many searches. Try again in a moment.', 'rate'))
    await settle()
    expect(shown()).toEqual({
      ids: [],
      loading: false,
      error: 'Too many searches. Try again in a moment.',
    })
    expect(asked).toHaveLength(4)
  })

  test('a search that a newer one replaces while it waits to ask again is not asked again', async () => {
    ask('chat')
    await settle()
    asked[0].answer(refused(429, 'Too many searches. Try again in a moment.', 'rate'))
    await settle()
    ask('chatter')
    await settle()
    asked[1].answer(found([7]))
    await clock.pass(1300)
    expect(asked.map(a => a.q)).toEqual(['chat', 'chatter'])
    expect(shown()).toEqual({ ids: [7], loading: false, error: null })
  })

  test('the site at capacity shows at once', async () => {
    ask('chatter')
    await settle()
    asked[0].answer(refused(503, 'This site is at capacity for searches right now.', 'capacity'))
    await settle()
    expect(shown()).toEqual({
      ids: [],
      loading: false,
      error: 'This site is at capacity for searches right now.',
    })
    expect(asked).toHaveLength(1)
  })

  test('a failure of the latest search shows', async () => {
    ask('chatter')
    await settle()
    asked[0].answer(refused(500, 'Search failed', 'internal'))
    await settle()
    expect(shown()).toEqual({ ids: [], loading: false, error: 'Search failed' })
  })
})
