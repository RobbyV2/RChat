import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { dmsUnread, serverUnread, useStore } from '../store'
import type { DmSummary, Message, ServerSummary, WsEvent } from '../types'
import { me, msg, serverDetail, user } from './fixtures'

const dispatch = (ev: WsEvent) => useStore.getState().applyWsEvent(ev)
const st = () => useStore.getState()
const dm = (id: number, other: string, is_self = false): DmSummary => ({
  id,
  other: user(other),
  is_self,
})
const dmIds = () => st().dms.map(d => d.id)

const realFetch = globalThis.fetch
let requests: string[] = []
const serve = (body: unknown) => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    requests.push(String(input))
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
}

let held: ((body: unknown) => void)[] = []
const hold = () => {
  globalThis.fetch = ((input: string | URL | Request) =>
    new Promise<Response>(resolve => {
      requests.push(String(input))
      held.push(body => resolve(new Response(JSON.stringify(body), { status: 200 })))
    })) as typeof fetch
}
const tick = () => new Promise(r => setTimeout(r, 0))
const offsetOf = (url: string) => Number(new URL(url).searchParams.get('offset'))
const srv = (name: string): ServerSummary => ({
  name,
  display_name: name,
  creator: null,
  is_admin: false,
})
const serverNames = () => st().me?.servers.map(x => x.name) ?? []
const firstFifty = () => Array.from({ length: 50 }, (_, i) => srv(`s${i}`))
const range = (from: number, to: number, over: Partial<Message> = {}) =>
  Array.from({ length: to - from + 1 }, (_, i) => msg(from + i, over))
const ids = (list: Message[] | undefined) => (list ?? []).map(m => m.id)

beforeEach(() => {
  requests = []
  held = []
  useStore.setState({
    me: me('alice'),
    view: null,
    servers: {},
    messages: {},
    reads: {},
    dms: [dm(1, 'alice', true), dm(2, 'bob'), dm(3, 'carol')],
    dmsMore: true,
  })
})

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('dm ordering', () => {
  test('a dm message moves that dm to the top, below the self dm', () => {
    dispatch({
      type: 'message',
      server: null,
      channel_id: null,
      dm_id: 3,
      dm_users: ['alice', 'carol'],
      message: msg(50, { channel_id: null, dm_id: 3, author: user('carol') }),
    })
    expect(dmIds()).toEqual([1, 3, 2])
  })

  test('a call log also counts as activity', () => {
    dispatch({
      type: 'message',
      server: null,
      channel_id: null,
      dm_id: 3,
      dm_users: ['alice', 'carol'],
      message: msg(51, { channel_id: null, dm_id: 3, kind: 'call', author: user('alice') }),
    })
    expect(dmIds()).toEqual([1, 3, 2])
  })

  test('dm_created fetches only the new dm and puts it on top', async () => {
    serve([dm(9, 'dave')])
    dispatch({ type: 'dm_created', dm_id: 9, dm_users: ['alice', 'dave'] })
    await new Promise(r => setTimeout(r, 0))
    expect(requests).toHaveLength(1)
    expect(requests[0]).toEndWith('/dms?ids=9')
    expect(dmIds()).toEqual([1, 9, 2, 3])
  })

  test('ensureDms skips loaded ids and appends the rest', async () => {
    serve([dm(7, 'erin')])
    await st().ensureDms([2, 7, 7])
    expect(requests).toHaveLength(1)
    expect(requests[0]).toEndWith('/dms?ids=7')
    expect(dmIds()).toEqual([1, 2, 3, 7])
    await st().ensureDms([1, 2])
    expect(requests).toHaveLength(1)
  })

  test('loadMoreDms appends the next page and clears dmsMore on a short page', async () => {
    serve([dm(3, 'carol'), dm(4, 'dave')])
    useStore.setState({ dmsMore: true })
    await st().loadMoreDms()
    expect(dmIds()).toEqual([1, 2, 3, 4])
    expect(st().dmsMore).toBe(false)
    await st().loadMoreDms()
    expect(requests).toHaveLength(1)
  })
})

describe('unread dots for lists that are not loaded', () => {
  test('channel messages tag the read mark with their server', () => {
    dispatch({
      type: 'message',
      server: 'far',
      channel_id: 40,
      dm_id: null,
      dm_users: null,
      message: msg(60, { channel_id: 40, author: user('bob') }),
    })
    expect(st().reads.c40).toEqual({ lastRead: 0, latest: 60, server: 'far' })
    expect(serverUnread(st(), 'far')).toBe(true)
    expect(serverUnread(st(), 'near')).toBe(false)
    dispatch({ type: 'read_updated', username: 'alice', scope: 'c40', last_read: 60 })
    expect(st().reads.c40.server).toBe('far')
    expect(serverUnread(st(), 'far')).toBe(false)
  })

  test('a loaded server detail still decides from its own channels', () => {
    useStore.setState({
      servers: { far: serverDetail('far', { channels: [] }) },
      reads: { c40: { lastRead: 0, latest: 60, server: 'far' } },
    })
    expect(serverUnread(st(), 'far')).toBe(false)
  })

  test('dmsUnread covers dms outside the loaded page', () => {
    useStore.setState({ reads: { d77: { lastRead: 1, latest: 5 } } })
    expect(dmsUnread(st())).toBe(true)
  })

  test('server rename and channel deletion keep read marks consistent', () => {
    useStore.setState({
      reads: {
        c40: { lastRead: 0, latest: 60, server: 'far' },
        c41: { lastRead: 0, latest: 61, server: 'far' },
      },
    })
    dispatch({
      type: 'server_renamed',
      old_name: 'far',
      server: { name: 'away', display_name: 'Away', creator: null, has_password: false },
    })
    expect(serverUnread(st(), 'away')).toBe(true)
    dispatch({ type: 'channel_deleted', server: 'away', channel_id: 40 })
    expect(st().reads.c40).toBeUndefined()
    dispatch({ type: 'member_left', server: 'away', username: 'alice' })
    expect(serverUnread(st(), 'away')).toBe(false)
  })
})

describe('removed or renamed list items stay gone', () => {
  test('a server deleted while a page is in flight is not appended back', async () => {
    useStore.setState({ me: me('alice', { servers: firstFifty() }), serversMore: true })
    hold()
    const load = st().loadMoreServers()
    await tick()
    dispatch({ type: 'server_deleted', name: 's50' })
    await tick()
    expect(requests).toHaveLength(2)
    expect(offsetOf(requests[1])).toBe(offsetOf(requests[0]))
    held[0]([srv('s50'), srv('s51')])
    await load
    held[1]([srv('s51')])
    await tick()
    expect(serverNames()).toHaveLength(51)
    expect(serverNames().includes('s50')).toBe(false)
    expect(serverNames()[50]).toBe('s51')
    expect(st().serversMore).toBe(false)
  })

  test('leaving a loaded server mid-page refetches one step back so nothing is skipped', async () => {
    useStore.setState({ me: me('alice', { servers: firstFifty() }), serversMore: true })
    hold()
    const load = st().loadMoreServers()
    await tick()
    dispatch({ type: 'member_left', server: 's10', username: 'alice' })
    await tick()
    expect(requests).toHaveLength(2)
    expect(offsetOf(requests[1])).toBe(offsetOf(requests[0]) - 1)
    held[0]([srv('s51')])
    await load
    expect(serverNames()).toHaveLength(49)
    held[1]([srv('s50'), srv('s51')])
    await tick()
    expect(serverNames().slice(-2)).toEqual(['s50', 's51'])
    expect(serverNames().includes('s10')).toBe(false)
  })

  test('a rename while a page is in flight does not bring back the old name', async () => {
    useStore.setState({ me: me('alice', { servers: firstFifty() }), serversMore: true })
    hold()
    const load = st().loadMoreServers()
    await tick()
    dispatch({
      type: 'server_renamed',
      old_name: 's50',
      server: { name: 'n50', display_name: 'n50', creator: null, has_password: false },
    })
    await tick()
    expect(requests).toHaveLength(2)
    held[0]([srv('s50')])
    await load
    held[1]([srv('n50')])
    await tick()
    expect(serverNames().slice(-1)).toEqual(['n50'])
    expect(serverNames().includes('s50')).toBe(false)
  })

  test('ensureServers asks again when a server is removed before its answer lands', async () => {
    useStore.setState({ me: me('alice'), serversMore: true })
    hold()
    const ensure = st().ensureServers(['far'])
    await tick()
    dispatch({ type: 'server_deleted', name: 'far' })
    held[0]([srv('far')])
    await tick()
    expect(requests).toHaveLength(2)
    held[1]([])
    await ensure
    expect(serverNames()).toEqual([])
  })

  test('ensureServers sends each name as its own parameter', async () => {
    useStore.setState({ me: me('alice'), serversMore: true })
    serve([srv('foo, bar'), srv('a&b')])
    await st().ensureServers(['Foo, Bar', 'a&b'])
    expect(requests).toHaveLength(1)
    expect(requests[0]).toEndWith('/me/servers?names=foo%2C%20bar&names=a%26b')
    expect(serverNames()).toEqual(['foo, bar', 'a&b'])
  })

  test('a ban during a dm page drops that dm and refreshes unread dots', async () => {
    useStore.setState({ reads: { d77: { lastRead: 0, latest: 5 } } })
    expect(dmsUnread(st())).toBe(true)
    hold()
    const load = st().loadMoreDms()
    await tick()
    dispatch({ type: 'banned', username: 'dave' })
    await tick()
    expect(requests).toHaveLength(3)
    expect(requests[1]).toEndWith('/unreads')
    held[0]([dm(4, 'dave'), dm(5, 'erin')])
    await load
    held[1]({ items: [{ scope: 'd5', server: null, last_read: 9, latest: 9 }] })
    held[2]([dm(5, 'erin')])
    await tick()
    expect(dmIds()).toEqual([1, 2, 3, 5])
    expect(st().reads.d77).toBeUndefined()
    expect(dmsUnread(st())).toBe(false)
  })
})

describe('older history', () => {
  beforeEach(() => {
    useStore.setState({
      view: { kind: 'channel', server: 's', channelId: 5 },
      messages: { c5: range(101, 150, { channel_id: 5 }) },
      older: {},
    })
  })

  test('a short page stops further requests', async () => {
    serve(range(91, 100, { channel_id: 5 }))
    await st().loadOlder()
    expect(requests).toHaveLength(1)
    expect(requests[0]).toContain('before=101')
    expect(ids(st().messages.c5)).toEqual(ids(range(91, 150)))
    expect(st().older.c5).toEqual({ more: false, loading: false })
    await st().loadOlder()
    expect(requests).toHaveLength(1)
  })

  test('a second load while one is in flight is ignored', async () => {
    hold()
    const first = st().loadOlder()
    const second = st().loadOlder()
    await tick()
    expect(requests).toHaveLength(1)
    expect(st().older.c5).toEqual({ more: true, loading: true })
    held[0](range(51, 100, { channel_id: 5 }))
    await Promise.all([first, second])
    expect(requests).toHaveLength(1)
    expect(ids(st().messages.c5)).toEqual(ids(range(51, 150)))
    expect(st().older.c5).toEqual({ more: true, loading: false })
  })

  test('a page that lands after the thread was reopened is dropped', async () => {
    const root = msg(500)
    const reply = { thread_root_id: 500 }
    useStore.setState({
      panel: { kind: 'thread', root },
      messages: { t500: range(1001, 1050, reply) },
    })
    hold()
    const older = st().loadOlderThread()
    await tick()
    const reopen = st().openThread(root)
    await tick()
    expect(requests).toHaveLength(2)
    held[1](range(1051, 1100, reply))
    await reopen
    held[0](range(951, 1000, reply))
    await older
    expect(ids(st().messages.t500)).toEqual(ids(range(1051, 1100)))
    expect(st().older.t500).toEqual({ more: true, loading: false })
    const next = st().loadOlderThread()
    await tick()
    expect(requests[2]).toContain('before=1051')
    held[2]([])
    await next
    expect(st().older.t500).toEqual({ more: false, loading: false })
  })
})
