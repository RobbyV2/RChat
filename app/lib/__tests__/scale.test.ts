import { describe, expect, test } from 'bun:test'
import {
  BACKOFF_CAP,
  BACKOFF_FLOOR,
  backoffDelay,
  catchUpDelay,
  due,
  nextAttempt,
} from '../backoff'
import { createReadQueue } from '../reads'
import {
  createLru,
  findById,
  indexOfId,
  mergeSorted,
  patchById,
  prefixHeights,
  trimWindow,
  visibleRange,
} from '../window'
import { createPager, insertSorted, samePrefix } from '../lists'
import { SEARCH_MAX, SEARCH_PAGE, addSearchPage } from '../search'
import { msg, result } from './fixtures'

const ids = (list: { id: number }[]) => list.map(m => m.id)

describe('backoff', () => {
  test('full jitter grows exponentially up to the cap', () => {
    const top = () => 0.999999
    expect(backoffDelay(0, top)).toBe(999)
    expect(backoffDelay(1, top)).toBe(1999)
    expect(backoffDelay(3, top)).toBe(7999)
    expect(backoffDelay(10, top)).toBe(BACKOFF_CAP - 1)
    expect(backoffDelay(1000, top)).toBe(BACKOFF_CAP - 1)
  })

  test('never retries faster than the floor', () => {
    expect(backoffDelay(0, () => 0)).toBe(BACKOFF_FLOOR)
    expect(backoffDelay(5, () => 0)).toBe(BACKOFF_FLOOR)
  })

  test('spreads clients across the whole window', () => {
    const delays = [0.1, 0.5, 0.9].map(r => backoffDelay(4, () => r))
    expect(delays).toEqual([1600, 8000, 14400])
  })

  test('the attempt counter resets only after a stable connection', () => {
    expect(nextAttempt(0, null)).toBe(1)
    expect(nextAttempt(3, 2_000)).toBe(4)
    expect(nextAttempt(6, 30_000)).toBe(1)
  })

  test('catch-up jitter scales with the outage and is capped', () => {
    expect(catchUpDelay(0, () => 0.5)).toBe(0)
    expect(catchUpDelay(4_000, () => 0.5)).toBe(2_000)
    expect(catchUpDelay(600_000, () => 0.5)).toBe(BACKOFF_CAP / 2)
    expect(catchUpDelay(600_000, () => 0.5, 5_000)).toBe(2_500)
  })

  test('due throttles by interval', () => {
    expect(due(null, 5, 60)).toBe(true)
    expect(due(0, 59, 60)).toBe(false)
    expect(due(0, 60, 60)).toBe(true)
  })
})

const fakeClock = () => {
  let now = 0
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      seq += 1
      timers.set(seq, { at: now + ms, fn })
      return seq as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: (t: ReturnType<typeof setTimeout>) => void timers.delete(t as unknown as number),
    advance: (ms: number) => {
      now += ms
      for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at > now) continue
        timers.delete(id)
        t.fn()
      }
    },
  }
}

describe('read coalescing', () => {
  const setup = (fail = false) => {
    const clock = fakeClock()
    const posts: [string, number][] = []
    const q = createReadQueue({
      send: (scope, id) => {
        posts.push([scope, id])
        return fail ? Promise.reject(new Error('down')) : Promise.resolve()
      },
      delay: 2_000,
      maxWait: 5_000,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    })
    return { clock, posts, q }
  }

  test('a burst of reads posts once with the newest id', () => {
    const { clock, posts, q } = setup()
    for (let id = 1; id <= 20; id += 1) {
      q.mark('c1', id)
      clock.advance(100)
    }
    expect(posts).toEqual([])
    clock.advance(2_000)
    expect(posts).toEqual([['c1', 20]])
  })

  test('steady traffic still flushes within the max wait', () => {
    const { clock, posts, q } = setup()
    for (let id = 1; id <= 60; id += 1) {
      q.mark('c1', id)
      clock.advance(1_000)
    }
    expect(posts.length).toBe(12)
    expect(posts.every(([, id], i) => i === 0 || id > posts[i - 1][1])).toBe(true)
  })

  test('only an advancing id is sent', () => {
    const { clock, posts, q } = setup()
    q.mark('c1', 10)
    q.flush()
    q.mark('c1', 10)
    q.mark('c1', 9)
    clock.advance(10_000)
    expect(posts).toEqual([['c1', 10]])
    expect(q.queued()).toBe(0)
  })

  test('flush sends every scope now and reads seen elsewhere are skipped', () => {
    const { posts, q } = setup()
    q.mark('c1', 5)
    q.mark('d2', 7)
    q.seen('d2', 9)
    q.flush()
    expect(posts).toEqual([['c1', 5]])
  })

  test('a failed post can be retried with the same id', async () => {
    const { posts, q } = setup(true)
    q.mark('c1', 5)
    q.flush()
    await Promise.resolve()
    await Promise.resolve()
    q.mark('c1', 5)
    q.flush()
    expect(posts).toEqual([
      ['c1', 5],
      ['c1', 5],
    ])
  })

  test('a failed post is retried with backoff until it lands', async () => {
    const clock = fakeClock()
    const posts: [string, number][] = []
    let failures = 2
    const q = createReadQueue({
      send: (scope, id) => {
        posts.push([scope, id])
        if (failures > 0) {
          failures -= 1
          return Promise.reject(new Error('down'))
        }
        return Promise.resolve()
      },
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      retryDelay: attempt => 1_000 * 2 ** attempt,
    })
    const settle = async () => {
      for (let i = 0; i < 4; i += 1) await Promise.resolve()
    }
    q.mark('c1', 500)
    q.flush()
    await settle()
    expect(q.queued()).toBe(1)
    expect(q.pending('c1')).toBe(500)
    clock.advance(1_999)
    expect(posts).toHaveLength(1)
    clock.advance(1)
    await settle()
    expect(posts).toHaveLength(2)
    clock.advance(3_999)
    expect(posts).toHaveLength(2)
    clock.advance(1)
    await settle()
    expect(posts).toEqual([
      ['c1', 500],
      ['c1', 500],
      ['c1', 500],
    ])
    expect(q.queued()).toBe(0)
    clock.advance(60_000)
    expect(posts).toHaveLength(3)
  })

  test('a retry never replaces a newer read', async () => {
    const clock = fakeClock()
    const posts: [string, number][] = []
    let fail = true
    const q = createReadQueue({
      send: (scope, id) => {
        posts.push([scope, id])
        return fail ? Promise.reject(new Error('down')) : Promise.resolve()
      },
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      retryDelay: () => 1_000,
    })
    q.mark('c1', 5)
    q.flush()
    q.mark('c1', 9)
    await Promise.resolve()
    await Promise.resolve()
    fail = false
    q.flush()
    clock.advance(10_000)
    expect(posts).toEqual([
      ['c1', 5],
      ['c1', 9],
    ])
    expect(q.pending('c1')).toBe(9)
  })

  test('client errors are dropped, 429 and server errors retry', async () => {
    const clock = fakeClock()
    const posts: [string, number][] = []
    const status: Record<string, number> = { c403: 403, c404: 404, c429: 429, c503: 503 }
    const q = createReadQueue({
      send: (scope, id) => {
        posts.push([scope, id])
        return Promise.reject(Object.assign(new Error('nope'), { status: status[scope] }))
      },
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      retryDelay: () => 1_000,
    })
    for (const scope of Object.keys(status)) q.mark(scope, 7)
    q.flush()
    for (let i = 0; i < 4; i += 1) await Promise.resolve()
    expect(q.queued()).toBe(2)
    clock.advance(1_000)
    expect(posts.map(([scope]) => scope).sort()).toEqual([
      'c403',
      'c404',
      'c429',
      'c429',
      'c503',
      'c503',
    ])
    expect(q.pending('c403')).toBe(0)
    q.mark('c403', 8)
    q.flush('c403')
    expect(posts.at(-1)).toEqual(['c403', 8])
  })

  test('clear stops retries', async () => {
    const { clock, posts, q } = setup(true)
    q.mark('c1', 5)
    q.flush()
    await Promise.resolve()
    await Promise.resolve()
    q.clear()
    clock.advance(120_000)
    expect(posts).toEqual([['c1', 5]])
  })

  test('clear drops queued reads', () => {
    const { clock, posts, q } = setup()
    q.mark('c1', 5)
    q.clear()
    clock.advance(10_000)
    expect(posts).toEqual([])
  })
})

describe('message window', () => {
  const list = [msg(10), msg(20), msg(30), msg(40)]

  test('binary search by id', () => {
    expect(indexOfId(list, 30)).toBe(2)
    expect(indexOfId(list, 31)).toBe(-1)
    expect(findById(list, 10)?.id).toBe(10)
    expect(findById(undefined, 10)).toBeUndefined()
  })

  test('merge appends, prepends, inserts and replaces in order', () => {
    expect(ids(mergeSorted(list, [msg(60), msg(50)]))).toEqual([10, 20, 30, 40, 50, 60])
    expect(ids(mergeSorted(list, [msg(5), msg(1)]))).toEqual([1, 5, 10, 20, 30, 40])
    expect(ids(mergeSorted(list, [msg(25)]))).toEqual([10, 20, 25, 30, 40])
    const replaced = mergeSorted(list, [msg(20, { content: 'x' })])
    expect(ids(replaced)).toEqual([10, 20, 30, 40])
    expect(replaced[1].content).toBe('x')
    expect(ids(mergeSorted(list, [msg(15), msg(45), msg(30)]))).toEqual([10, 15, 20, 30, 40, 45])
    expect(mergeSorted(list, [])).toBe(list)
    expect(ids(mergeSorted([], [msg(2), msg(1), msg(2)]))).toEqual([1, 2])
  })

  test('patching keeps the list reference when the id is absent or unchanged', () => {
    expect(patchById(list, 99, m => ({ ...m, content: 'x' }))).toBe(list)
    expect(patchById(list, 20, m => m)).toBe(list)
    const next = patchById(list, 20, m => ({ ...m, content: 'x' }))
    expect(next === list).toBe(false)
    expect(next[0]).toBe(list[0])
    expect(next[1].content).toBe('x')
  })

  test('trim keeps the requested end once past the slack', () => {
    const many = Array.from({ length: 260 }, (_, i) => i)
    expect(trimWindow(many.slice(0, 250), 'newest', 200, 50).trimmed).toBe(false)
    const newest = trimWindow(many, 'newest', 200, 50)
    expect(newest.trimmed).toBe(true)
    expect(newest.list.length).toBe(200)
    expect(newest.list[0]).toBe(60)
    const oldest = trimWindow(many, 'oldest', 200, 50)
    expect(oldest.list[oldest.list.length - 1]).toBe(199)
  })
})

describe('lru', () => {
  test('evicts the least recently used keys beyond the limit', () => {
    const lru = createLru<string>(3)
    expect(lru.touch('a')).toEqual([])
    lru.touch('b')
    lru.touch('c')
    lru.touch('a')
    expect(lru.touch('d')).toEqual(['b'])
    expect(lru.keys()).toEqual(['c', 'a', 'd'])
  })

  test('never evicts pinned keys or the key being touched', () => {
    const pinned = new Set(['a'])
    const lru = createLru<string>(2, k => pinned.has(k))
    lru.touch('a')
    lru.touch('b')
    expect(lru.touch('c')).toEqual(['b'])
    pinned.add('c')
    expect(lru.touch('d')).toEqual([])
    expect(lru.keys()).toEqual(['a', 'c', 'd'])
    lru.delete('a')
    expect(lru.has('a')).toBe(false)
  })
})

describe('virtual window math', () => {
  const prefix = prefixHeights([32, 40, 40, 40, 40, 40, 32, 40, 40, 1])

  test('prefix sums', () => {
    expect(prefix.slice(0, 4)).toEqual([0, 32, 72, 112])
    expect(prefix[prefix.length - 1]).toBe(345)
  })

  test('picks the rows that cover the viewport plus overscan', () => {
    expect(visibleRange(prefix, 0, 80, 0)).toEqual({ start: 0, end: 3, before: 0, after: 233 })
    expect(visibleRange(prefix, 100, 50, 0)).toEqual({
      start: 2,
      end: 4,
      before: 72,
      after: 193,
    })
    const wide = visibleRange(prefix, 100, 50, 40)
    expect([wide.start, wide.end]).toEqual([1, 5])
  })

  test('clamps at the edges and handles empty lists', () => {
    const end = visibleRange(prefix, 10_000, 100, 0)
    expect(end.start).toBe(9)
    expect(end.end).toBe(10)
    expect(end.after).toBe(0)
    expect(visibleRange([0], 0, 100, 10)).toEqual({ start: 0, end: 0, before: 0, after: 0 })
  })

  test('rendered rows never exceed what fits plus overscan', () => {
    const rows = prefixHeights(Array.from({ length: 5000 }, () => 40))
    const r = visibleRange(rows, 100_000, 800, 400)
    expect(r.end - r.start <= Math.ceil((800 + 800) / 40) + 1).toBe(true)
    expect(r.before + (r.end - r.start) * 40 + r.after).toBe(200_000)
  })
})

describe('paged lists', () => {
  const name = (s: string) => s
  test('insertSorted keeps order, replaces duplicates and skips rows past a partial page', () => {
    const cmp = (a: string, b: string) => a.localeCompare(b)
    expect(insertSorted(['a', 'c'], 'b', cmp, name, false)).toEqual(['a', 'b', 'c'])
    expect(insertSorted(['a', 'c'], 'c', cmp, name, false)).toEqual(['a', 'c'])
    expect(insertSorted(['a', 'c'], 'z', cmp, name, true)).toEqual(['a', 'c'])
    expect(insertSorted(['a', 'c'], 'z', cmp, name, false)).toEqual(['a', 'c', 'z'])
  })

  test('samePrefix compares keys in order', () => {
    expect(samePrefix(['a', 'b', 'c'], ['a', 'b'], name)).toBe(true)
    expect(samePrefix(['a', 'b', 'c'], ['b', 'a'], name)).toBe(false)
    expect(samePrefix(['a'], ['a', 'b'], name)).toBe(false)
  })

  test('a reset with an unchanged head keeps the pager cursor', async () => {
    let list = Array.from({ length: 150 }, (_, i) => i)
    const cursors: (string | null)[] = []
    const pager = createPager<number>({
      read: () => list,
      write: next => (list = next),
      fetchPage: async (cursor, limit) => {
        cursors.push(cursor)
        const from = cursor === null ? 0 : Number(cursor) + 1
        const items = Array.from({ length: limit }, (_, i) => from + i)
        return { items, next: String(items[items.length - 1]) }
      },
      keyOf: n => n,
      page: 50,
    })
    pager.reset('149')
    pager.reset('49', true)
    await pager.load()
    expect(cursors).toEqual(['149'])
    pager.reset('49')
    cursors.length = 0
    await pager.load()
    expect(cursors).toEqual(['49', '99', '149', '199'])
  })

  test('search results stop growing at the cap', () => {
    const page = (from: number) =>
      Array.from({ length: SEARCH_PAGE }, (_, i) => result(from - i, from - i))
    let state = { results: [] as ReturnType<typeof page>, hasMore: true }
    let at = 100_000
    while (state.hasMore) {
      state = addSearchPage(state.results, page(at), 'more')
      at -= SEARCH_PAGE
    }
    expect(state.results.length).toBe(SEARCH_MAX)
  })
})
