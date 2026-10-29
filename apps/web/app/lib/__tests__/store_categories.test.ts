import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resetSessionCaches, useStore } from '../store'
import { channelGroups } from '../categories'
import { emptyLayout } from '../nav_layout'
import type { Channel, ChannelLayout, WsEvent } from '../types'
import { me, serverDetail } from './fixtures'

afterAll(resetSessionCaches)

const dispatch = (ev: WsEvent) => useStore.getState().applyWsEvent(ev)
const st = () => useStore.getState()
const tick = () => new Promise(r => setTimeout(r, 0))

const ch = (id: number, position: number, category_id: number | null = null): Channel => ({
  id,
  name: `c${id}`,
  kind: id % 2 ? 'text' : 'voice',
  slowmode_seconds: 0,
  position,
  category_id,
})

const groups = () => {
  const g = channelGroups(st().servers.club, true)
  return [
    g.uncategorized.map(c => c.id),
    ...g.categories.map(x => [x.category.name, ...x.channels.map(c => c.id)]),
  ]
}

const realFetch = globalThis.fetch
let requests: { method: string; url: string; body: unknown }[] = []
let replies: (() => Response)[] = []
const pending: ((r: Response) => void)[] = []

beforeEach(() => {
  requests = []
  replies = []
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      method: init?.method ?? 'GET',
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    const reply = replies.shift()
    if (reply) return Promise.resolve(reply())
    return new Promise<Response>(resolve => pending.push(resolve))
  }) as typeof fetch
  useStore.setState({
    me: me('alice', {
      servers: [{ name: 'club', display_name: 'club', creator: 'alice', is_admin: true }],
    }),
    view: null,
    error: null,
    layout: emptyLayout,
    servers: {
      club: serverDetail('club', {
        channels: [ch(1, 0), ch(2, 1), ch(3, 2, 10)],
        categories: [{ id: 10, name: 'Games', position: 0 }],
        layout_version: 3,
      }),
    },
  })
})

afterEach(() => {
  globalThis.fetch = realFetch
  pending.length = 0
})

const json =
  (body: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(body), { status })

describe('categories in the store', () => {
  test('a live layout reorders the cached server', () => {
    const layout: ChannelLayout = {
      version: 4,
      uncategorized: [3],
      categories: [{ id: 10, name: 'Fun', channels: [2, 1] }],
    }
    dispatch({ type: 'layout_changed', server: 'club', layout })
    expect(groups()).toEqual([[3], ['Fun', 2, 1]])
    expect(st().servers.club.layout_version).toBe(4)
    expect(requests).toEqual([])
  })

  test('a move shows at once, is sent with the version and settles on the answer', async () => {
    st().moveChannel('club', 1, 10, 1)
    expect(groups()).toEqual([[2], ['Games', 3, 1]])
    await tick()
    expect(requests[0].method).toBe('PUT')
    expect(requests[0].url).toEndWith('/servers/club/layout')
    expect(requests[0].body).toEqual({
      version: 3,
      uncategorized: [2],
      categories: [{ id: 10, channels: [3, 1] }],
    })
    dispatch({
      type: 'layout_changed',
      server: 'club',
      layout: { version: 9, uncategorized: [1, 2, 3], categories: [] },
    })
    expect(groups()).toEqual([[2], ['Games', 3, 1]])
    pending.shift()?.(
      json({
        version: 4,
        uncategorized: [2],
        categories: [{ id: 10, name: 'Games', channels: [3, 1] }],
      })()
    )
    await tick()
    await tick()
    expect(st().servers.club.layout_version).toBe(4)
    st().moveCategory('club', 10, 0)
    await tick()
    expect((requests[1].body as { version: number }).version).toBe(4)
    pending.shift()?.(
      json({
        version: 5,
        uncategorized: [2],
        categories: [{ id: 10, name: 'Games', channels: [3, 1] }],
      })()
    )
    await tick()
    await tick()
    expect(st().servers.club.layout_version).toBe(5)
  })

  test('a stale move reloads the server and says so', async () => {
    replies.push(json({ error: 'The channel list changed. Reload it and try again' }, 409))
    replies.push(
      json(
        serverDetail('club', {
          channels: [ch(1, 0), ch(2, 1), ch(3, 2)],
          categories: [],
          layout_version: 7,
        })
      )
    )
    st().moveChannel('club', 2, null, 0)
    for (let i = 0; i < 5; i++) await tick()
    expect(st().error).toBe('The channel list changed. Try again')
    expect(requests.map(r => r.method)).toEqual(['PUT', 'GET'])
    expect(st().servers.club.layout_version).toBe(7)
    expect(groups()).toEqual([[1, 2, 3]])
  })

  test('collapsed categories are kept in the account layout', () => {
    st().setCategoriesCollapsed('club', [10, 11], true)
    expect(st().layout.collapsed).toEqual({ club: [10, 11] })
    st().setCategoriesCollapsed('club', [10], false)
    expect(st().layout.collapsed).toEqual({ club: [11] })
  })

  test('loading a server drops collapsed ids of categories it no longer has', async () => {
    st().setCategoriesCollapsed('club', [10, 11], true)
    st().setCategoriesCollapsed('arena', [20], true)
    replies.push(
      json(
        serverDetail('club', {
          channels: [ch(1, 0), ch(3, 1, 10)],
          categories: [{ id: 10, name: 'Games', position: 0 }],
          layout_version: 4,
        })
      )
    )
    dispatch({ type: 'channel_perms_changed', server: 'club', channel_id: 1 })
    for (let i = 0; i < 5; i++) await tick()
    expect(requests.map(r => r.method)).toEqual(['GET'])
    expect(st().layout.collapsed).toEqual({ club: [10], arena: [20] })
  })

  test('a failed move drops the moves queued behind it and refuses new ones until reloaded', async () => {
    st().moveChannel('club', 2, null, 0)
    st().moveChannel('club', 1, 10, 0)
    await tick()
    expect(requests.map(r => r.method)).toEqual(['PUT'])
    pending.shift()?.(json({ error: 'The channel list changed. Reload it and try again' }, 409)())
    for (let i = 0; i < 5; i++) await tick()
    expect(requests.map(r => r.method)).toEqual(['PUT', 'GET'])
    st().moveCategory('club', 10, 0)
    for (let i = 0; i < 5; i++) await tick()
    expect(requests.map(r => r.method)).toEqual(['PUT', 'GET'])
    pending.shift()?.(
      json(
        serverDetail('club', {
          channels: [ch(1, 0), ch(2, 1), ch(3, 2)],
          categories: [{ id: 10, name: 'Games', position: 0 }],
          layout_version: 8,
        })
      )()
    )
    for (let i = 0; i < 5; i++) await tick()
    expect(requests.map(r => r.method)).toEqual(['PUT', 'GET'])
    expect(groups()).toEqual([[1, 2, 3], ['Games']])
    st().moveChannel('club', 3, 10, 0)
    for (let i = 0; i < 5; i++) await tick()
    expect(requests.map(r => r.method)).toEqual(['PUT', 'GET', 'PUT'])
    expect((requests[2].body as { version: number }).version).toBe(8)
  })
})
