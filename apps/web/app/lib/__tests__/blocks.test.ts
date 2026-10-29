import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { useStore, resetSessionCaches } from '../store'
import { home } from '../instances'
import { blockedLabel, blockedRuns, blockedSet, matchesBlockQuery, withoutTypers } from '../blocks'
import { typerNames } from '../typing'
import type { BlockedUser, WsEvent } from '../types'
import { me, memoryStorage, msg, user } from './fixtures'

afterAll(resetSessionCaches)

const st = () => useStore.getState()
const dispatch = (ev: WsEvent) => st().applyWsEvent(ev)
const tick = () => new Promise(r => setTimeout(r, 0))
const blockedUser = (name: string, at = 1, display = name): BlockedUser => ({
  user: user(name, { display_name: display }),
  blocked_at: at,
})

type Call = { method: string; url: string; body?: string }
let calls: Call[] = []
let routes: [RegExp, unknown, number?][] = []
const realFetch = globalThis.fetch
const g = globalThis as { window?: unknown; document?: unknown }
const real = { window: g.window, document: g.document }

beforeEach(() => {
  calls = []
  routes = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({
      method: init?.method ?? 'GET',
      url: url.replace(/^https?:\/\/[^/]+/, ''),
      body: init?.body as string | undefined,
    })
    const hit = routes.find(([re]) => re.test(url))
    return new Response(JSON.stringify(hit ? hit[1] : []), { status: hit?.[2] ?? 200 })
  }) as typeof fetch
  Object.assign(globalThis, { localStorage: memoryStorage })
  g.window = {
    location: { pathname: '/', href: 'http://x/', origin: 'http://x', protocol: 'http:' },
    history: { state: null, pushState: () => {}, replaceState: () => {} },
  }
  g.document = { cookie: '' }
  useStore.setState({
    token: 'tok',
    me: me('alice'),
    guest: false,
    blocked: {},
    blockList: { list: [], hasMore: true, loading: false, q: '' },
    typing: {},
    typingOn: true,
    toast: null,
  })
})

afterEach(() => {
  home.ws.stop()
  globalThis.fetch = realFetch
  g.window = real.window
  g.document = real.document
  useStore.setState({ token: null, blocked: {}, typing: {} })
})

describe('blocked runs', () => {
  const by = (id: number, author: string, kind: 'user' | 'call' = 'user') =>
    msg(id, { author: user(author), kind })

  test('groups consecutive user messages of blocked authors', () => {
    const list = [
      by(1, 'bob'),
      by(2, 'bob'),
      by(3, 'carol'),
      by(4, 'bob'),
      by(5, 'dave'),
      by(6, 'bob', 'call'),
      by(7, 'dave'),
    ]
    const runs = blockedRuns(list, blockedSet(['bob', 'dave']))
    expect([...runs.keys()]).toEqual([0, 1, 3, 4, 6])
    expect(runs.get(0)).toBe(runs.get(1)!)
    expect(runs.get(0)?.ids).toEqual([1, 2])
    expect(runs.get(3)).toEqual({ start: 3, ids: [4, 5] })
    expect(runs.get(6)).toEqual({ start: 6, ids: [7] })
    expect(blockedRuns(list, {}).size).toBe(0)
  })

  test('labels and search', () => {
    expect(blockedLabel(1)).toBe('1 blocked message')
    expect(blockedLabel(3)).toBe('3 blocked messages')
    const b = blockedUser('bob', 1, 'Zed')
    expect(matchesBlockQuery(b, '')).toBe(true)
    expect(matchesBlockQuery(b, ' BO')).toBe(true)
    expect(matchesBlockQuery(b, 'ze')).toBe(true)
    expect(matchesBlockQuery(b, 'ob')).toBe(false)
  })

  test('typers of blocked users are dropped', () => {
    const map = { c1: { bob: { name: 'Bob', until: 9 }, carol: { name: 'Carol', until: 9 } } }
    expect(withoutTypers(map, {})).toBe(map)
    expect(withoutTypers(map, blockedSet(['bob']))).toEqual({
      c1: { carol: { name: 'Carol', until: 9 } },
    })
    expect(withoutTypers(map, blockedSet(['bob', 'carol']))).toEqual({})
  })
})

describe('blocking in the store', () => {
  test('blocking asks the server and hides typing', async () => {
    routes = [[/\/api\/blocks$/, blockedUser('bob', 5, 'Bob')]]
    dispatch({
      type: 'typing',
      username: 'bob',
      display_name: 'Bob',
      scope: 'c1',
      until: Date.now() / 1000 + 8,
    } as WsEvent)
    expect(Object.keys(st().typing.c1 ?? {})).toEqual(['bob'])
    expect(await st().blockUser(' bob ')).toBeNull()
    expect(calls).toEqual([{ method: 'POST', url: '/api/blocks', body: '{"username":"bob"}' }])
    expect(st().blocked).toEqual({ bob: true })
    expect(st().typing).toEqual({})
    expect(typerNames({ bob: { name: 'Bob', until: 1 } })).toEqual([])
    dispatch({
      type: 'typing',
      username: 'bob',
      display_name: 'Bob',
      scope: 'c1',
      until: Date.now() / 1000 + 8,
    } as WsEvent)
    expect(st().typing).toEqual({})
  })

  test('a failed block returns the error text', async () => {
    routes = [[/\/api\/blocks$/, { error: 'User not found' }, 404]]
    expect(await st().blockUser('nobody')).toBe('User not found')
    expect(st().blocked).toEqual({})
  })

  test('events from other tabs keep the set and the list in sync', () => {
    useStore.setState({
      blockList: { list: [blockedUser('carol')], hasMore: false, loading: false, q: '' },
    })
    dispatch({ type: 'user_blocked', username: 'zoe', blocked: blockedUser('bob') })
    expect(st().blocked).toEqual({})
    dispatch({ type: 'user_blocked', username: 'alice', blocked: blockedUser('bob', 2) })
    expect(st().blocked).toEqual({ bob: true })
    expect(st().blockList.list.map(b => b.user.username)).toEqual(['bob', 'carol'])
    dispatch({ type: 'user_blocked', username: 'alice', blocked: blockedUser('bob', 2) })
    expect(st().blockList.list.length).toBe(2)
    useStore.setState({ blockList: { ...st().blockList, q: 'ca' } })
    dispatch({ type: 'user_blocked', username: 'alice', blocked: blockedUser('dave') })
    expect(st().blockList.list.map(b => b.user.username)).toEqual(['bob', 'carol'])
    dispatch({ type: 'user_unblocked', username: 'alice', blocked: 'carol' })
    expect(st().blocked).toEqual({ bob: true, dave: true })
    expect(st().blockList.list.map(b => b.user.username)).toEqual(['bob'])
  })

  test('unblock calls the server and shows a toast', async () => {
    useStore.setState({ blocked: { bob: true } })
    await st().unblockUser('bob', 'Bob')
    expect(calls).toEqual([{ method: 'DELETE', url: '/api/blocks/bob', body: undefined }])
    expect(st().blocked).toEqual({})
    expect(st().toast?.text).toBe('Unblocked')
    expect(st().toast?.name).toBe('Bob')
  })

  test('the list pages with the search text', async () => {
    routes = [[/\/api\/blocks\?/, [blockedUser('bob')]]]
    await st().loadBlockList('b o', true)
    await tick()
    expect(calls[0].url).toBe('/api/blocks?limit=50&q=b%20o')
    expect(st().blockList.list.map(b => b.user.username)).toEqual(['bob'])
    expect(st().blockList.hasMore).toBe(false)
  })

  test('askBlock confirms first', async () => {
    routes = [[/\/api\/blocks$/, blockedUser('bob', 1, 'Bob')]]
    st().askBlock(user('alice'))
    expect(st().confirm).toBeNull()
    st().askBlock(user('bob', { display_name: 'Bob' }))
    expect(st().confirm?.confirm).toBe('Block')
    expect(calls).toEqual([])
    st().confirm?.action('')
    await tick()
    await tick()
    expect(st().blocked).toEqual({ bob: true })
    expect(st().toast?.text).toBe('Blocked')
    st().closeConfirm()
  })
})
