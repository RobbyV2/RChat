import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { ListFilter, X } from 'lucide-react'
import { ctxFor, paletteCtx } from '../actions/ctx'
import { registerAppActions } from '../actions/index'
import { menuItems } from '../actions/menu'
import { paletteCommands } from '../actions/palette'
import { dmView, useStore, resetSessionCaches } from '../store'
import { emptyLayout, type Layout } from '../nav_layout'
import { arrangeDms, dmListPrefs } from '../dm_list'
import { home } from './home_instance'
import type { DmSummary, WsEvent } from '../types'
import { me, memoryStorage, msg, until, user } from './fixtures'
import { Secret } from '../secret'

beforeAll(registerAppActions)

const st = () => useStore.getState()
const dispatch = (ev: WsEvent) => st().applyWsEvent(ev)
const dm = (id: number, other: string, over: Partial<DmSummary> = {}): DmSummary => ({
  id,
  other: user(other),
  is_self: false,
  last_message_id: null,
  last_message_at: null,
  friend: false,
  ...over,
})
const find = (id: number) => st().dms.find(d => d.id === id)
const shown = () =>
  arrangeDms(
    dmView(st()).recent,
    dmListPrefs(st().layout),
    () => false,
    null,
    st().dmsMore ? st().dmsEdge : null
  ).map(d => d.id)
const pages = (byCursor: Record<string, [DmSummary[], string | null]>) => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    if (/\/me$/.test(url)) return new Response(JSON.stringify(meNow), { status: 200 })
    const key = /[?&]cursor=([^&]*)/.exec(url)?.[1] ?? ''
    const [items, next] = byCursor[key] ?? [[], null]
    return new Response(JSON.stringify(/\/dms\?limit=/.test(url) ? items : []), {
      status: 200,
      headers: next ? { 'X-Next-Cursor': next } : {},
    })
  }) as typeof fetch
}
let meNow = me('alice')
const listed = () => calls.filter(c => /\/dms\?limit=/.test(c))

const storage = new Map<string, string>()
const saved = (): Layout | null => {
  const raw = storage.get('rchat_layout:alice')
  return raw ? (JSON.parse(raw) as Layout) : null
}

let calls: string[] = []
let routes: [RegExp, unknown][] = []
const realFetch = globalThis.fetch
const g = globalThis as { window?: unknown; document?: unknown }
const real = { window: g.window, document: g.document }

beforeEach(() => {
  resetSessionCaches()
  calls = []
  routes = []
  storage.clear()
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    const hit = routes.find(([re]) => re.test(url))
    return new Response(JSON.stringify(hit ? hit[1] : []), { status: 200 })
  }) as typeof fetch
  Object.assign(globalThis, {
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    },
  })
  g.window = {
    location: { pathname: '/', href: 'http://x/', origin: 'http://x', protocol: 'http:' },
    history: { state: null, pushState: () => {}, replaceState: () => {} },
  }
  g.document = { cookie: '', querySelectorAll: () => [] }
  useStore.setState({
    token: Secret.of('tok'),
    me: me('alice'),
    guest: false,
    view: null,
    servers: {},
    reads: {},
    dms: [
      dm(1, 'alice', { is_self: true }),
      dm(2, 'bob', { last_message_id: 40, friend: true }),
      dm(3, 'carol', { last_message_id: 30 }),
    ],
    dmsMore: false,
    layout: { ...emptyLayout, dmPinned: [1] },
  })
})

afterEach(() => {
  home.ws.stop()
  globalThis.fetch = realFetch
  Object.assign(globalThis, { localStorage: memoryStorage })
  g.window = real.window
  g.document = real.document
  useStore.setState({ token: null, view: null })
})

describe('dm list sort and filters', () => {
  test('a new sort is saved with the layout and pages from the server in that order', async () => {
    st().setDmList({ sort: 'name' })
    expect(saved()?.dmList).toEqual({
      sort: 'name',
      friends: false,
      unread: false,
      unreadTop: false,
    })
    await until(() => listed().length === 1)
    expect(listed()[0]).toEndWith('/dms?limit=50&sort=name')
    st().setDmList({ friends: true })
    await until(() => listed().length === 2)
    expect(listed()[1]).toEndWith('/dms?limit=50&sort=name&friends=true')
  })

  test('only the client side choices ask the server for nothing', async () => {
    st().setDmList({ unreadTop: true })
    st().setDmList({ unread: true })
    st().setDmList({ sort: 'custom' })
    await new Promise(r => setTimeout(r, 20))
    expect(listed()).toEqual([])
    expect(saved()?.dmList?.sort).toBe('custom')
  })

  test('the next page keeps asking for the same order with its cursor', async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      calls.push(url)
      const first = !url.includes('cursor=')
      return new Response(JSON.stringify(first ? [dm(9, 'dave')] : [dm(10, 'erin')]), {
        status: 200,
        headers: first ? { 'X-Next-Cursor': 'abc' } : {},
      })
    }) as typeof fetch
    st().setDmList({ sort: 'oldest' })
    await until(() => find(9) !== undefined)
    expect(st().dmsMore).toBe(true)
    await st().loadMoreDms()
    expect(listed()).toHaveLength(2)
    expect(listed()[1]).toContain('sort=oldest')
    expect(listed()[1]).toContain('cursor=abc')
    expect(find(10)?.id).toBe(10)
    expect(st().dmsMore).toBe(false)
  })

  test('in another order, rows known before their page wait for it', async () => {
    useStore.setState({
      dms: [
        dm(1, 'alice', { is_self: true }),
        dm(2, 'zed', { last_message_id: 40 }),
        dm(3, 'carol', { last_message_id: 30 }),
        dm(4, 'bob', { last_message_id: 20 }),
      ],
      dmsMore: true,
    })
    pages({
      '': [[dm(1, 'alice', { is_self: true }), dm(5, 'adam'), dm(4, 'bob')], 'n1'],
      n1: [[dm(3, 'carol'), dm(6, 'dave')], null],
    })
    st().setDmList({ sort: 'name' })
    expect(shown()).toEqual([])
    await until(() => find(5) !== undefined)
    expect(shown()).toEqual([5, 4])
    await st().loadMoreDms()
    expect(shown()).toEqual([5, 4, 3, 6, 2])
  })

  test('going back to an order pages it again from its first page', async () => {
    useStore.setState({ dms: [dm(1, 'alice', { is_self: true })], dmsMore: true })
    pages({
      '': [[dm(1, 'alice', { is_self: true }), dm(5, 'adam'), dm(4, 'bob')], 'n1'],
      n1: [[dm(6, 'dave')], null],
    })
    st().setDmList({ sort: 'name' })
    await until(() => find(5) !== undefined)
    expect(shown()).toEqual([5, 4])
    st().setDmList({ sort: 'oldest' })
    st().setDmList({ sort: 'name' })
    expect(shown()).toEqual([])
    await until(() => !st().dmsMore)
    expect(shown()).toEqual([5, 4, 6])
    expect(listed().filter(url => url.endsWith('/dms?limit=50&sort=name'))).toHaveLength(2)
  })

  test('a refetched account keeps paging the chosen order where it was', async () => {
    useStore.setState({ dmsMore: true })
    pages({
      '': [[dm(1, 'alice', { is_self: true }), dm(5, 'adam'), dm(4, 'bob')], 'n1'],
      n1: [[dm(6, 'dave')], null],
    })
    st().setDmList({ sort: 'name' })
    await until(() => find(5) !== undefined)
    meNow = me('alice', {
      dms: [dm(1, 'alice', { is_self: true }), dm(2, 'bob', { last_message_id: 40 })],
      dms_more: true,
      dms_cursor: 'r1',
    })
    dispatch({
      type: 'member_joined',
      server: 'x',
      member: { ...user('alice'), roles: [], joined_at: 1 },
    } as unknown as WsEvent)
    await until(() => calls.some(c => c.endsWith('/me')))
    expect(calls.at(-1)).toEndWith('/me')
    await new Promise(r => setTimeout(r, 20))
    expect(st().dmsEdge.last?.id).toBe(4)
    expect(st().dmsMore).toBe(true)
    expect(listed()).toHaveLength(1)
    await st().loadMoreDms()
    expect(listed().at(-1)).toContain('sort=name')
    expect(listed().at(-1)).toContain('cursor=n1')
    meNow = me('alice')
  })

  test('in the default order, a refetched account keeps the rows paged past its first page', async () => {
    const head = [
      dm(1, 'alice', { is_self: true }),
      dm(2, 'bob', { last_message_id: 40 }),
      dm(3, 'carol', { last_message_id: 30 }),
    ]
    const refetch = async (bio: string) => {
      meNow = me('alice', { dms: head, dms_more: true, dms_cursor: 'r1', bio })
      dispatch({
        type: 'member_joined',
        server: 'x',
        member: { ...user('alice'), roles: [], joined_at: 1 },
      } as unknown as WsEvent)
      await until(() => st().me?.bio === bio)
    }
    pages({
      r1: [[dm(4, 'dave', { last_message_id: 20 }), dm(5, 'erin', { last_message_id: 10 })], 'r2'],
    })
    await refetch('first')
    expect(shown()).toEqual([2, 3])
    await st().loadMoreDms()
    expect(listed()).toHaveLength(1)
    expect(shown()).toEqual([2, 3, 4, 5])
    await refetch('second')
    expect(st().dmsMore).toBe(true)
    expect(st().dmsEdge.last?.id).toBe(5)
    expect(shown()).toEqual([2, 3, 4, 5])
    expect(listed()).toHaveLength(1)
    meNow = me('alice')
  })

  test('the unread list says when its cap cut it', async () => {
    routes = [[/\/unreads/, { items: [], more: true }]]
    dispatch({ type: 'banned', username: 'mallory' })
    await until(() => st().unreadsCut)
    expect(st().unreadsCut).toBe(true)
    routes = [[/\/unreads/, { items: [], more: false }]]
    dispatch({ type: 'banned', username: 'mallory' })
    await until(() => !st().unreadsCut)
    expect(st().unreadsCut).toBe(false)
  })

  test('a new message moves the dm in recent activity', () => {
    dispatch({
      type: 'message',
      server: null,
      channel_id: null,
      dm_id: 3,
      dm_users: ['alice', 'carol'],
      message: msg(50, { channel_id: null, dm_id: 3, author: user('carol'), created_at: 777 }),
    })
    expect(find(3)).toMatchObject({ last_message_id: 50, last_message_at: 777 })
  })

  test('friendship changes mark the dm', () => {
    dispatch({
      type: 'friend_added',
      username: 'alice',
      friend: { user: user('carol'), since: 1, online: false },
    })
    expect(find(3)?.friend).toBe(true)
    dispatch({ type: 'friend_removed', username: 'alice', friend: 'bob' })
    expect(find(2)?.friend).toBe(false)
    dispatch({ type: 'friend_removed', username: 'zed', friend: 'carol' })
    expect(find(3)?.friend).toBe(true)
  })

  test('outside custom, a drop below the pins only unpins', () => {
    st().placeDm(3, 'recent', 0)
    expect(saved()).toBeNull()
    st().placeDm(1, 'recent', 1)
    expect(dmView(st()).pinned).toEqual([])
    expect(saved()?.dmOrder).toEqual([])
    expect(saved()?.selfPin).toBe('unpinned')
  })

  test('in custom, a drop places the dm among the shown rows', () => {
    st().setDmList({ sort: 'custom' })
    st().placeDm(3, 'recent', 0, { pinned: [1], recent: [2, 3] })
    expect(saved()?.dmOrder).toEqual([3, 2])
    expect(dmView(st()).recent.map(d => d.id)).toEqual([3, 2])
  })

  test('an account with a dragged order starts on custom', () => {
    useStore.setState({ layout: { ...emptyLayout, dmOrder: [3, 2], dmSeen: 3 } })
    st().placeDm(2, 'recent', 0, { pinned: [], recent: [3, 2] })
    expect(saved()?.dmOrder).toEqual([2, 3, 1])
  })
})

describe('dm list commands', () => {
  const rows = () => paletteCommands(paletteCtx(st())).filter(r => r.id.startsWith('dms_'))
  const titles = () => rows().map(r => r.title)
  const menu = () => menuItems(ctxFor(st(), { kind: 'dm_list' }, 'menu'))

  test('the palette lists the other sorts and the filters', () => {
    expect(titles()).toEqual([
      'Sort DMs by oldest activity',
      'Sort DMs by name',
      'Sort DMs in custom order',
      'Show unread DMs on top',
      'Show only DMs with friends',
      'Show only unread DMs',
    ])
  })

  test('running them changes the list and its labels', async () => {
    const before = new Map(rows().map(r => [r.id, r]))
    for (const id of ['dms_sort_name', 'dms_friends_only', 'dms_unread_top'])
      await before.get(id)?.run()
    expect(saved()?.dmList).toEqual({ sort: 'name', friends: true, unread: false, unreadTop: true })
    const after = rows()
    expect(after.map(r => r.title)).toEqual([
      'Sort DMs by recent activity',
      'Sort DMs by oldest activity',
      'Sort DMs in custom order',
      'Stop showing unread DMs on top',
      'Show DMs with everyone',
      'Show only unread DMs',
      'Clear DM filters',
    ])
    await after.find(r => r.id === 'dms_clear_filters')?.run()
    expect(saved()?.dmList).toEqual({
      sort: 'name',
      friends: false,
      unread: false,
      unreadTop: true,
    })
  }, 30_000)

  test('the palette rows carry no subtitle, the custom order included', () => {
    expect(rows().map(r => r.id)).toContain('dms_sort_custom')
    expect(rows().filter(r => r.subtitle !== undefined)).toEqual([])
  })

  test('Clear filters has the close icon on the list and the filter icon in the palette', () => {
    st().setDmList({ friends: true })
    expect(menu().find(i => i.label === 'Clear filters')?.icon).toBe(X)
    expect(rows().find(r => r.id === 'dms_clear_filters')?.icon).toBe(ListFilter)
  })

  test('the menu of a dm row holds none of the list rows', () => {
    st().setDmList({ friends: true })
    const list = new Set([...titles(), ...menu().map(i => i.label)])
    expect(list.size).toBe(15)
    for (const where of ['sidebar', 'home'] as const) {
      const own = menuItems(ctxFor(st(), { kind: 'dm', dm: st().dms[1], where }, 'menu'))
      expect(own.length).toBeGreaterThan(0)
      expect(own.map(i => i.label).filter(label => list.has(label))).toEqual([])
    }
  })

  test('guests get none of them', () => {
    useStore.setState({ me: null, guest: true })
    expect(titles()).toEqual([])
    expect(menu()).toEqual([])
  })

  test('the sort and filter button lists every sort and filter, with the current ones marked', () => {
    expect(menu().map(i => i.label)).toEqual([
      'Recent activity',
      'Oldest activity',
      'Name',
      'Custom',
      'Unread on top',
      'Friends only',
      'Unread only',
    ])
    expect(menu().map(i => i.radio === true)).toEqual([true, true, true, true, false, false, false])
    expect(menu().map(i => i.checked)).toEqual([true, false, false, false, false, false, false])
    expect(menu().map(i => i.subtitle)).toEqual([
      undefined,
      undefined,
      undefined,
      'Drag to reorder',
      undefined,
      undefined,
      undefined,
    ])
  })

  test('its rows change the list, and Clear filters shows while a filter is on', async () => {
    const pick = (label: string) =>
      menu()
        .find(i => i.label === label)
        ?.action?.()
    pick('Name')
    await until(() => saved()?.dmList?.sort === 'name')
    pick('Friends only')
    await until(() => saved()?.dmList?.friends === true)
    pick('Unread on top')
    await until(() => saved()?.dmList?.unreadTop === true)
    expect(menu().map(i => [i.label, i.checked])).toEqual([
      ['Recent activity', false],
      ['Oldest activity', false],
      ['Name', true],
      ['Custom', false],
      ['Unread on top', true],
      ['Friends only', true],
      ['Unread only', false],
      ['Clear filters', undefined],
    ])
    pick('Clear filters')
    await until(() => saved()?.dmList?.friends === false)
    expect(saved()?.dmList).toEqual({
      sort: 'name',
      friends: false,
      unread: false,
      unreadTop: true,
    })
    expect(menu().map(i => i.label)).not.toContain('Clear filters')
  })
})
