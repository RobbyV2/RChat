import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { dmView, useStore, resetSessionCaches } from '../store'
import { emptyLayout, type Layout } from '../nav_layout'
import { home } from '../instances'
import type { DmSummary, WsEvent } from '../types'
import { me, memoryStorage, user } from './fixtures'

afterAll(resetSessionCaches)

const st = () => useStore.getState()
const dispatch = (ev: WsEvent) => st().applyWsEvent(ev)
const dm = (id: number, other: string, is_self = false, closed = false): DmSummary => ({
  id,
  other: user(other),
  is_self,
  closed,
})
const dmIds = () => st().dms.map(d => d.id)
const pinned = () => dmView(st()).pinned.map(d => d.id)
const tick = () => new Promise(r => setTimeout(r, 0))

const storage = new Map<string, string>()
const saved = (): Layout | null => {
  const raw = storage.get('rchat_layout:alice')
  return raw ? (JSON.parse(raw) as Layout) : null
}

type Call = { method: string; url: string }
let calls: Call[] = []
let routes: [RegExp, unknown][] = []
const realFetch = globalThis.fetch
const g = globalThis as { window?: unknown; document?: unknown }
const real = { window: g.window, document: g.document }

beforeEach(() => {
  calls = []
  routes = []
  storage.clear()
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ method: init?.method ?? 'GET', url })
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
  g.document = { cookie: '' }
  useStore.setState({
    token: 'tok',
    me: me('alice'),
    guest: false,
    view: null,
    servers: {},
    reads: {},
    dms: [dm(1, 'alice', true), dm(2, 'bob'), dm(3, 'carol')],
    dmsMore: false,
    layout: { ...emptyLayout, dmPinned: [1, 3] },
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

describe('closing dms', () => {
  test('close hides the dm, unpins it and asks the server', async () => {
    await st().closeDm(3)
    expect(dmIds()).toEqual([1, 2])
    expect(pinned()).toEqual([1])
    expect(saved()?.dmPinned).toEqual([1])
    const posts = calls.filter(c => c.method === 'POST').map(c => c.url)
    expect(posts).toHaveLength(1)
    expect(posts[0]).toEndWith('/dms/3/close')
  })

  test('closing the open dm moves to the self dm', async () => {
    useStore.setState({ view: { kind: 'dm', dmId: 2 } })
    await st().closeDm(2)
    expect(st().view).toEqual({ kind: 'dm', dmId: 1 })
  })

  test('closing the self dm unpins it for good', async () => {
    useStore.setState({ layout: { ...emptyLayout, dmPinned: [1] } })
    await st().closeDm(1)
    expect(dmIds()).toEqual([2, 3])
    expect(saved()?.selfPin).toBe('unpinned')
  })

  test('another device closing it hides it here too', () => {
    dispatch({ type: 'dm_closed', username: 'bob', dm_id: 2 })
    expect(dmIds()).toEqual([1, 2, 3])
    dispatch({ type: 'dm_closed', username: 'alice', dm_id: 3 })
    expect(dmIds()).toEqual([1, 2])
    expect(pinned()).toEqual([1])
  })

  test('a reopen fetches the dm and puts it on top', async () => {
    dispatch({ type: 'dm_closed', username: 'alice', dm_id: 3 })
    routes.push([/\/dms\?ids=3$/, [dm(3, 'carol')]])
    dispatch({ type: 'dm_reopened', username: 'alice', dm_id: 3 })
    await tick()
    expect(dmIds()).toEqual([1, 3, 2])
  })

  test('lookups keep closed dms out of the list', async () => {
    routes.push([/\/dms\?ids=/, [dm(7, 'erin', false, true), dm(8, 'finn')]])
    await st().ensureDms([7, 8])
    expect(dmIds()).toEqual([1, 2, 3, 8])
  })

  test('opening a closed dm reopens it', async () => {
    routes.push([/\/dms\?ids=7$/, [dm(7, 'erin', false, true)]])
    routes.push([/\/dms$/, dm(7, 'erin')])
    await st().openDm(7)
    await tick()
    await tick()
    expect(calls.some(c => c.method === 'POST' && c.url.endsWith('/dms'))).toBe(true)
    expect(dmIds()).toEqual([1, 7, 2, 3])
  })
})
