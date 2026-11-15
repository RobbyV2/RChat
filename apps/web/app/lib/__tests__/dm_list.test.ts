import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_DM_QUERY,
  DM_SORTS,
  arrangeDms,
  clearDmFilters,
  dmListPrefs,
  dmQuery,
  dmRows,
  filtersOn,
  holdOrder,
  noteDmMessage,
  parseDmList,
  queryKey,
  queryParams,
  setDmFriend,
  unreadDmIds,
  unreadListed,
  waitsForPage,
  type DmEdge,
  type DmListPrefs,
} from '../dm_list'
import { emptyLayout, parseLayout, placeDm, type Layout } from '../nav_layout'

interface Dm {
  id: number
  is_self?: boolean
  friend?: boolean
  last_message_id?: number | null
  last_message_at?: number | null
  other: { username: string; display_name: string }
}

const dm = (
  id: number,
  username: string,
  display: string,
  last: number | null,
  more: Partial<Dm> = {}
): Dm => ({
  id,
  other: { username, display_name: display },
  last_message_id: last,
  friend: false,
  ...more,
})

const P = (over: Partial<DmListPrefs> = {}): DmListPrefs => ({
  sort: 'recent',
  friends: false,
  unread: false,
  unreadTop: false,
  ...over,
})

const ids = (list: { id: number }[]) => list.map(d => d.id)

const me = dm(1, 'alice', 'Alice', null, { is_self: true })
const zoe = dm(2, 'zoe', 'Zoe', 50, { friend: true })
const amy = dm(3, 'amy', 'amy', 70)
const bea = dm(4, 'bea', 'Bea', null, { friend: true })
const abe = dm(5, 'abe', 'bea', 20)
const quiet = dm(6, 'kim', 'Kim', null)
const order = [zoe, amy, me, bea, abe, quiet]
const none = () => false

describe('dm list prefs', () => {
  test('defaults to recent activity, or custom for a layout with a dragged order', () => {
    expect(dmListPrefs(emptyLayout)).toEqual(P())
    const dragged: Layout = { ...emptyLayout, dmOrder: [3, 1], dmSeen: 3 }
    expect(dmListPrefs(dragged).sort).toBe('custom')
    const chosen = P({ sort: 'name', unreadTop: true })
    expect(dmListPrefs({ ...emptyLayout, dmOrder: [3], dmList: chosen })).toBe(chosen)
  })

  test('parses defensively', () => {
    expect(parseDmList({ sort: 'oldest', friends: true, unread: 1, unreadTop: 'yes' })).toEqual(
      P({ sort: 'oldest', friends: true })
    )
    expect(parseDmList({ sort: 'size' })).toBeNull()
    expect(parseDmList(null)).toBeNull()
    expect(parseDmList(['name'])).toBeNull()
    expect(parseDmList('name')).toBeNull()
  })

  test('is saved and read back with the rest of the layout', () => {
    const layout: Layout = { ...emptyLayout, dmList: P({ sort: 'custom', unread: true }) }
    expect(parseLayout(JSON.stringify(layout))).toEqual(layout)
    const old = { v: 2, servers: [], dmOrder: [2], dmPinned: [], dmSeen: 2 }
    expect(parseLayout(JSON.stringify(old)).dmList).toBeUndefined()
    expect(parseLayout(JSON.stringify({ ...old, dmList: { sort: 'x' } })).dmList).toBeUndefined()
  })

  test('counts and clears filters, sort and unread on top stay', () => {
    expect(filtersOn(P())).toBe(0)
    expect(filtersOn(P({ friends: true, unread: true, unreadTop: true }))).toBe(2)
    expect(
      clearDmFilters(P({ sort: 'name', friends: true, unread: true, unreadTop: true }))
    ).toEqual(P({ sort: 'name', unreadTop: true }))
  })

  test('the menu lists every sort with a label', () => {
    expect(DM_SORTS.map(s => s.sort)).toEqual(['recent', 'oldest', 'name', 'custom'])
    expect(DM_SORTS.map(s => s.label)).toEqual([
      'Recent activity',
      'Oldest activity',
      'Name',
      'Custom',
    ])
  })
})

describe('dm list server query', () => {
  test('custom pages like recent, the friends filter goes to the server, unread stays here', () => {
    expect(dmQuery(P())).toEqual(DEFAULT_DM_QUERY)
    expect(dmQuery(P({ sort: 'custom', unread: true, unreadTop: true }))).toEqual(DEFAULT_DM_QUERY)
    expect(dmQuery(P({ sort: 'name', friends: true }))).toEqual({ sort: 'name', friends: true })
  })

  test('keys and params tell the queries apart', () => {
    const all = (['recent', 'oldest', 'name'] as const).flatMap(sort =>
      [false, true].map(friends => ({ sort, friends }))
    )
    expect(new Set(all.map(queryKey)).size).toBe(6)
    expect(queryParams(DEFAULT_DM_QUERY)).toBe('')
    expect(queryParams({ sort: 'oldest', friends: false })).toBe('&sort=oldest')
    expect(queryParams({ sort: 'recent', friends: true })).toBe('&friends=true')
    expect(queryParams({ sort: 'name', friends: true })).toBe('&sort=name&friends=true')
  })
})

describe('arranging the dms below the pins', () => {
  test('recent: the self dm first, then newest message, dms without messages last', () => {
    expect(ids(arrangeDms(order, P(), none))).toEqual([1, 3, 2, 5, 6, 4])
  })

  test('oldest: the self dm first, dms without messages first, then oldest message', () => {
    expect(ids(arrangeDms(order, P({ sort: 'oldest' }), none))).toEqual([1, 4, 6, 5, 2, 3])
  })

  test('name: display name ignoring case, then username', () => {
    expect(ids(arrangeDms(order, P({ sort: 'name' }), none))).toEqual([1, 3, 5, 4, 6, 2])
  })

  test('custom keeps the order it is given', () => {
    expect(ids(arrangeDms(order, P({ sort: 'custom' }), none))).toEqual([2, 3, 1, 4, 5, 6])
  })

  test('friends only keeps friends and the self dm', () => {
    expect(ids(arrangeDms(order, P({ friends: true }), none))).toEqual([1, 2, 4])
  })

  test('unread only, and the open dm is never filtered out', () => {
    const unread = (d: Dm) => d.id === 5 || d.id === 4
    expect(ids(arrangeDms(order, P({ unread: true }), unread))).toEqual([5, 4])
    expect(ids(arrangeDms(order, P({ unread: true }), unread, 2))).toEqual([2, 5, 4])
    expect(ids(arrangeDms(order, P({ unread: true, friends: true }), unread, 3))).toEqual([3, 4])
  })

  test('unread on top works with every sort and keeps each part in order', () => {
    const unread = (d: Dm) => d.id === 6 || d.id === 2
    expect(ids(arrangeDms(order, P({ unreadTop: true }), unread))).toEqual([1, 2, 6, 3, 5, 4])
    expect(ids(arrangeDms(order, P({ sort: 'name', unreadTop: true }), unread))).toEqual([
      1, 6, 2, 3, 5, 4,
    ])
    expect(ids(arrangeDms(order, P({ sort: 'custom', unreadTop: true }), unread))).toEqual([
      2, 6, 3, 1, 4, 5,
    ])
  })

  test('name: only ascii letters ignore case, then code point order, as on the server', () => {
    const names = ['Борис', 'анна', 'Ézra', 'éa', 'bob', 'Zed', '\u{1F600}', '\uFF71']
    const list = names.map((name, i) => dm(10 + i, `u${i}`, name, null))
    expect(arrangeDms(list, P({ sort: 'name' }), none).map(d => d.other.display_name)).toEqual([
      'bob',
      'Zed',
      'Ézra',
      'éa',
      'Борис',
      'анна',
      '\uFF71',
      '\u{1F600}',
    ])
  })

  test('dms from an older server keep its order and pass friends only', () => {
    const old = [7, 3, 9].map(id => ({ id, other: { username: `u${id}`, display_name: 'X' } }))
    expect(ids(arrangeDms(old, P(), none))).toEqual([7, 3, 9])
    expect(ids(arrangeDms(old, P({ sort: 'oldest' }), none))).toEqual([7, 3, 9])
    expect(ids(arrangeDms(old, P({ friends: true }), none))).toEqual([7, 3, 9])
  })
})

describe('the paged edge', () => {
  const edge = (sort: 'recent' | 'oldest' | 'name', last: Dm | null, friends = false): DmEdge => ({
    query: { sort, friends },
    last,
  })

  test('rows past the last paged row wait for their page, the self and the open dm stay', () => {
    expect(ids(arrangeDms(order, P(), none, null, edge('recent', zoe)))).toEqual([1, 3, 2])
    expect(ids(arrangeDms(order, P(), none, 4, edge('recent', zoe)))).toEqual([1, 3, 2, 4])
    expect(
      ids(arrangeDms(order, P({ sort: 'oldest' }), none, null, edge('oldest', quiet)))
    ).toEqual([1, 4, 6])
    expect(ids(arrangeDms(order, P({ sort: 'name' }), none, null, edge('name', abe)))).toEqual([
      1, 3, 5,
    ])
  })

  test('before the first page of this order only the self dm shows', () => {
    expect(ids(arrangeDms(order, P({ sort: 'name' }), none, null, edge('name', null)))).toEqual([1])
    expect(ids(arrangeDms(order, P({ sort: 'name' }), none, null, edge('recent', zoe)))).toEqual([
      1,
    ])
    expect(
      ids(arrangeDms(order, P({ sort: 'name', friends: true }), none, null, edge('name', zoe)))
    ).toEqual([1])
  })

  test('without more pages, in custom and with an older server nothing waits', () => {
    expect(ids(arrangeDms(order, P(), none, null, null))).toEqual([1, 3, 2, 5, 6, 4])
    expect(ids(arrangeDms(order, P({ sort: 'custom' }), none, null, edge('recent', null)))).toEqual(
      ids(order)
    )
    const old = { id: 5, other: abe.other }
    expect(ids(arrangeDms(order, P(), none, null, { query: DEFAULT_DM_QUERY, last: old }))).toEqual(
      [1, 3, 2, 5, 6, 4]
    )
    const byName = { query: { sort: 'name' as const, friends: false }, last: old }
    expect(ids(arrangeDms(order, P({ sort: 'name' }), none, null, byName))).toEqual([
      1, 3, 5, 4, 6, 2,
    ])
  })

  test('only rows past the edge, and not known as unread, wait for their page', () => {
    const unread = (d: Dm) => d.id === 6
    const edgeAt = edge('recent', zoe)
    const waits = (prefs: DmListPrefs) =>
      order.filter(waitsForPage(prefs, unread, edgeAt)).map(d => d.id)
    expect(waits(P())).toEqual([4, 5, 6])
    expect(waits(P({ unreadTop: true }))).toEqual([4, 5])
    expect(order.filter(waitsForPage(P(), unread, null))).toEqual([])
  })

  test('unread dms known from the unread list show on top or alone before their page', () => {
    const unread = (d: Dm) => d.id === 6
    expect(
      ids(arrangeDms(order, P({ unreadTop: true }), unread, null, edge('recent', zoe)))
    ).toEqual([1, 6, 3, 2])
    expect(ids(arrangeDms(order, P({ unread: true }), unread, null, edge('recent', zoe)))).toEqual([
      6,
    ])
    expect(ids(arrangeDms(order, P(), unread, null, edge('recent', zoe)))).toEqual([1, 3, 2])
  })

  test('the rows come with the open dm as their tail while it waits for its page', () => {
    const at = edge('recent', zoe)
    const tail = (
      prefs: DmListPrefs,
      unread: (d: Dm) => boolean,
      open: number,
      to: DmEdge | null
    ) => dmRows(order, prefs, unread, open, to).tail
    expect(dmRows(order, P(), none, 5, at)).toEqual({ ids: [1, 3, 2, 5], tail: [5] })
    expect(dmRows(order, P(), none, 3, at)).toEqual({ ids: [1, 3, 2], tail: [] })
    expect(tail(P(), none, 5, edge('recent', null))).toEqual([5])
    expect(tail(P(), none, 1, at)).toEqual([])
    expect(tail(P(), none, 99, at)).toEqual([])
    expect(tail(P(), none, 5, null)).toEqual([])
    expect(tail(P({ sort: 'custom' }), none, 5, at)).toEqual([])
    expect(tail(P({ unreadTop: true }), d => d.id === 5, 5, at)).toEqual([])
  })

  test('a held list that shows only the open dm takes its first page above it', () => {
    const below = order.filter(d => !d.is_self)
    const rows = (at: DmEdge) => dmRows(below, P({ sort: 'name' }), none, 2, at)
    const alive = new Set(ids(below))
    const start = rows(edge('name', null))
    expect(start).toEqual({ ids: [2], tail: [2] })
    const first = holdOrder(start, rows(edge('name', abe)), alive)
    expect(first).toEqual({ ids: [3, 5, 2], tail: [2] })
    expect(holdOrder(first, rows(edge('name', quiet)), alive)).toEqual({
      ids: [3, 5, 4, 6, 2],
      tail: [2],
    })
  })
})

describe('live changes', () => {
  const rows = (ids: number[], tail: number[] = []) => ({ ids, tail })

  test('a new message moves the dm up in recent activity', () => {
    const next = noteDmMessage(order, 6, 90, 1234)
    expect(next.find(d => d.id === 6)).toMatchObject({ last_message_id: 90, last_message_at: 1234 })
    expect(ids(arrangeDms(next, P(), none))).toEqual([1, 6, 3, 2, 5, 4])
  })

  test('an older or unknown message changes nothing', () => {
    expect(noteDmMessage(order, 3, 60, 1)).toBe(order)
    expect(noteDmMessage(order, 99, 100, 1)).toBe(order)
  })

  test('friendship changes mark the dm with that person', () => {
    const next = setDmFriend(order, 'amy', true)
    expect(next.find(d => d.id === 3)?.friend).toBe(true)
    expect(setDmFriend(next, 'amy', true)).toBe(next)
    expect(setDmFriend(order, 'alice', true)).toBe(order)
    expect(setDmFriend(order, 'zoe', false).find(d => d.id === 2)?.friend).toBe(false)
  })

  test('a held list keeps its rows in place, adds new ones at the end and drops gone ones', () => {
    const held = (was: number[], next: number[], alive: number[]) =>
      holdOrder(rows(was), rows(next), new Set(alive))
    expect(held([3, 2, 5], [2, 9, 3, 5], [2, 3, 5, 9])).toEqual(rows([3, 2, 5, 9]))
    expect(held([3, 2, 5], [5, 2], [2, 5])).toEqual(rows([2, 5]))
    expect(held([3, 2, 5], [5], [2, 3, 5])).toEqual(rows([3, 2, 5]))
    expect(held([], [4, 1], [1, 4])).toEqual(rows([4, 1]))
  })

  test('the open dm waiting for its page is not held: pages land above it', () => {
    const alive = new Set([1, 2, 3, 4, 9])
    expect(holdOrder(rows([9], [9]), rows([1, 3, 2, 9], [9]), alive)).toEqual(
      rows([1, 3, 2, 9], [9])
    )
    expect(holdOrder(rows([3, 1, 9], [9]), rows([1, 2, 3, 4, 9], [9]), alive)).toEqual(
      rows([3, 1, 2, 4, 9], [9])
    )
  })

  test('an open dm that starts to wait for its page while held moves last', () => {
    const alive = new Set([1, 3, 9])
    expect(holdOrder(rows([3, 9, 1]), rows([3, 1, 9], [9]), alive)).toEqual(rows([3, 1, 9], [9]))
  })

  test('once its page came, the open dm takes its place among the new rows', () => {
    const alive = new Set([1, 2, 3, 4, 9])
    expect(holdOrder(rows([1, 3, 9], [9]), rows([1, 2, 3, 9, 4]), alive)).toEqual(
      rows([1, 3, 2, 9, 4])
    )
  })

  test('unread dms to load are the unread dm scopes, latest first', () => {
    const reads = {
      d4: { lastRead: 1, latest: 9 },
      d7: { lastRead: 5, latest: 5 },
      c3: { lastRead: 1, latest: 30 },
      d2: { lastRead: 1, latest: 20 },
      dx: { lastRead: 1, latest: 40 },
    }
    expect(unreadDmIds(reads)).toEqual([2, 4])
    expect(unreadDmIds(reads, 1)).toEqual([2])
  })

  test('unread only needs no pages while the unread list holds every unread dm', () => {
    const many = (n: number) =>
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => [`d${i + 1}`, { lastRead: 0, latest: 5 }])
      )
    expect(unreadListed({}, false)).toBe(true)
    expect(unreadListed(many(100), false)).toBe(true)
    expect(unreadListed(many(101), false)).toBe(false)
    expect(unreadListed(many(3), true)).toBe(false)
  })
})

describe('dropping in a filtered or sorted custom list', () => {
  test('moves only the dragged dm, before the row it was dropped on', () => {
    const layout: Layout = { ...emptyLayout, dmOrder: [1, 2, 3, 4, 5], dmSeen: 5 }
    const shown = { pinned: [], recent: [4, 2, 5] }
    const next = placeDm(layout, shown, 5, 'recent', 0, 5, [1, 2, 3, 4, 5])
    expect(next.dmOrder).toEqual([1, 2, 3, 5, 4])
  })

  test('without the full order it places the dm in the shown one', () => {
    const next = placeDm(emptyLayout, { pinned: [], recent: [1, 4, 3] }, 3, 'recent', 0, 4)
    expect(next.dmOrder).toEqual([3, 1, 4])
  })
})
