import { describe, expect, test } from 'bun:test'
import {
  anyDmUnread,
  appendUnique,
  bumpFront,
  keyed,
  unreadMark,
  windowEdges,
  createPager,
  mergeHead,
  refreshTail,
  unreadServers,
} from '../lists'
import { msg } from './fixtures'

const id = (n: number) => n
const ids = (list: { id: number }[]) => list.map(m => m.id)

describe('appendUnique', () => {
  test('appends only unseen items, also de-duplicating within the page', () => {
    expect(appendUnique([1, 2], [2, 3, 3, 4], id)).toEqual([1, 2, 3, 4])
  })

  test('returns the same array when nothing is new', () => {
    const list = [1, 2]
    expect(appendUnique(list, [2, 1], id)).toBe(list)
  })
})

describe('mergeHead', () => {
  test('a complete head replaces the list', () => {
    expect(mergeHead([1, 2, 3, 4], [2, 5], false, id)).toEqual([2, 5])
  })

  test('a partial head keeps loaded items that are not in it', () => {
    expect(mergeHead([1, 2, 3, 4], [5, 1], true, id)).toEqual([5, 1, 2, 3, 4])
  })
})

describe('bumpFront', () => {
  const self = (n: number) => n === 0
  test('moves an item to just after the pinned ones', () => {
    expect(bumpFront([0, 1, 2, 3], 3, id, self)).toEqual([0, 3, 1, 2])
  })

  test('inserts a new item after the pinned ones', () => {
    expect(bumpFront([0, 1], 9, id, self)).toEqual([0, 9, 1])
  })

  test('a pinned item goes first and an empty list works', () => {
    expect(bumpFront([1, 2, 0], 0, id, self)).toEqual([0, 1, 2])
    expect(bumpFront([], 4, id, self)).toEqual([4])
  })

  test('returns the same array when already in place', () => {
    const list = [0, 1, 2]
    expect(bumpFront(list, 1, id, self)).toBe(list)
  })
})

describe('refreshTail', () => {
  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => msg(from + i))

  test('a short page is the whole history', () => {
    const out = refreshTail(range(1, 80), range(5, 7), 50, true)
    expect(ids(out.list)).toEqual([5, 6, 7])
    expect(out.more).toBe(false)
  })

  test('an overlapping full page keeps older loaded messages and their more flag', () => {
    const fresh = [...range(31, 80)].reverse()
    const out = refreshTail([...range(1, 70)], fresh, 50, false)
    expect(ids(out.list)).toEqual(ids(range(1, 80)))
    expect(out.more).toBe(false)
  })

  test('drops loaded messages deleted inside the fresh range', () => {
    const fresh = range(31, 80).filter(m => m.id !== 40)
    const out = refreshTail(range(1, 80), [...fresh, msg(81)], 50, true)
    expect(out.list.some(m => m.id === 40)).toBe(false)
    expect(out.list[0].id).toBe(1)
  })

  test('a gap after the loaded messages discards them', () => {
    const out = refreshTail(range(1, 20), range(200, 249), 50, false)
    expect(ids(out.list)).toEqual(ids(range(200, 249)))
    expect(out.more).toBe(true)
  })
})

describe('unread helpers', () => {
  const reads = {
    c1: { lastRead: 5, latest: 9, server: 'a' },
    c2: { lastRead: 9, latest: 9, server: 'b' },
    c3: { lastRead: 0, latest: 2 },
    d4: { lastRead: 3, latest: 3 },
  }

  test('unreadServers collects servers with an unread channel', () => {
    expect([...unreadServers(reads)]).toEqual(['a'])
  })

  test('anyDmUnread only looks at dm scopes', () => {
    expect(anyDmUnread(reads)).toBe(false)
    expect(anyDmUnread({ ...reads, d5: { lastRead: 1, latest: 2 } })).toBe(true)
  })
})

const fakeServer = (total: number) => {
  const all = Array.from({ length: total }, (_, i) => i + 1)
  const calls: [number, number][] = []
  return {
    all,
    calls,
    fetchPage: async (offset: number, limit: number) => {
      calls.push([offset, limit])
      return all.slice(offset, offset + Math.min(limit, 100))
    },
  }
}

const pagerOver = (server: ReturnType<typeof fakeServer>, initial: number[]) => {
  const state = { list: initial, more: true }
  const pager = createPager({
    read: () => state.list,
    write: (list, more) => {
      state.list = list
      state.more = more
    },
    fetchPage: server.fetchPage,
    keyOf: id,
    page: 50,
    max: 100,
  })
  pager.reset(initial.length)
  return { state, pager }
}

describe('createPager', () => {
  test('loads page by page and stops on a short page', async () => {
    const server = fakeServer(120)
    const { state, pager } = pagerOver(server, server.all.slice(0, 50))
    await pager.load()
    expect(state.list).toEqual(server.all.slice(0, 100))
    expect(state.more).toBe(true)
    await pager.load()
    expect(state.list).toEqual(server.all)
    expect(state.more).toBe(false)
    expect(server.calls).toEqual([
      [50, 50],
      [100, 50],
    ])
  })

  test('concurrent loads share one request', async () => {
    const server = fakeServer(120)
    const { pager } = pagerOver(server, server.all.slice(0, 50))
    await Promise.all([pager.load(), pager.load()])
    expect(server.calls).toHaveLength(1)
  })

  test('catches up past already-loaded items without stopping on a duplicate page', async () => {
    const server = fakeServer(260)
    const { state, pager } = pagerOver(server, server.all.slice(0, 200))
    pager.reset(50)
    await pager.load()
    expect(server.calls).toEqual([
      [50, 100],
      [150, 100],
    ])
    expect(state.list).toEqual(server.all.slice(0, 250))
    expect(state.more).toBe(true)
  })

  test('reset during a load discards the stale page', async () => {
    const server = fakeServer(120)
    const { state, pager } = pagerOver(server, server.all.slice(0, 50))
    const pending = pager.load()
    expect(pager.reset(50)).toBe(true)
    state.list = [7]
    await pending
    expect(state.list).toEqual([7])
    expect(pager.reset(1)).toBe(false)
  })

  test('removals step the cursor back so nothing is skipped', async () => {
    const server = fakeServer(120)
    const { state, pager } = pagerOver(server, server.all.slice(0, 50))
    server.all.splice(9, 1)
    state.list = state.list.filter(n => n !== 10)
    expect(pager.removed(1)).toBe(false)
    await pager.load()
    expect(server.calls[0]).toEqual([49, 50])
    expect(state.list).toContain(51)
  })

  test('a removal during a load drops the in-flight page and asks for a reload', async () => {
    const server = fakeServer(120)
    const { state, pager } = pagerOver(server, server.all.slice(0, 50))
    const pending = pager.load()
    server.all.splice(9, 1)
    state.list = state.list.filter(n => n !== 10)
    expect(pager.removed(1)).toBe(true)
    await pending
    expect(state.list).toHaveLength(49)
    await pager.load()
    expect(server.calls).toEqual([
      [50, 50],
      [49, 50],
    ])
    expect(state.list).toEqual(server.all.slice(0, 99))
  })

  test('an item removed from the in-flight page is not brought back', async () => {
    const server = fakeServer(120)
    const { state, pager } = pagerOver(server, server.all.slice(0, 50))
    const pending = pager.load()
    server.all.splice(59, 1)
    expect(pager.removed(0)).toBe(true)
    await pending
    await pager.load()
    expect(state.list.includes(60)).toBe(false)
    expect(state.list).toEqual(server.all.slice(0, 100))
  })
})

describe('keyed', () => {
  test('sets and deletes a key without touching the others', () => {
    const map = { a: 1, b: 2 }
    expect(keyed(map, 'c', 3)).toEqual({ a: 1, b: 2, c: 3 })
    expect(keyed(map, 'a', null)).toEqual({ b: 2 })
    expect(keyed(map, 'z', undefined)).toBe(map)
    expect(keyed(map, 'a', 1)).toBe(map)
    expect(map).toEqual({ a: 1, b: 2 })
  })
})

describe('windowEdges', () => {
  const ids = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => from + i)
  test('a full window has more on both sides', () => {
    expect(windowEdges(ids(75, 124), 100, 50)).toEqual({ older: true, newer: true })
  })
  test('short sides mean the start or the present was reached', () => {
    expect(windowEdges(ids(1, 30), 5, 50)).toEqual({ older: false, newer: true })
    expect(windowEdges(ids(75, 110), 100, 50)).toEqual({ older: true, newer: false })
    expect(windowEdges([], 100, 50)).toEqual({ older: false, newer: false })
  })
})

describe('unreadMark', () => {
  const ids = [10, 11, 12, 13]
  test('never read or nothing unread shows no divider', () => {
    expect(unreadMark(ids, 0, true)).toEqual({ divider: -1, above: false })
    expect(unreadMark(ids, undefined, true)).toEqual({ divider: -1, above: false })
    expect(unreadMark(ids, 13, true)).toEqual({ divider: -1, above: false })
  })
  test('the divider sits before the first unread loaded message', () => {
    expect(unreadMark(ids, 11, true)).toEqual({ divider: 2, above: false })
  })
  test('unread starting above the loaded page asks to jump instead of a divider', () => {
    expect(unreadMark(ids, 5, true)).toEqual({ divider: -1, above: true })
    expect(unreadMark(ids, 5, false)).toEqual({ divider: 0, above: false })
    expect(unreadMark(ids, 9, true)).toEqual({ divider: 0, above: false })
  })
})
