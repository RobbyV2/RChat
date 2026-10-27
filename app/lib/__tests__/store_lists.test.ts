import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { dmsUnread, serverUnread, useStore } from '../store'
import type { DmSummary, Message, ServerSummary, WsEvent } from '../types'
import { me, member, msg, paged, serverDetail, user } from './fixtures'
import { emptyLayout, layoutServers } from '../nav_layout'

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

let held: ((body: unknown, next?: string) => void)[] = []
const hold = () => {
  globalThis.fetch = ((input: string | URL | Request) =>
    new Promise<Response>(resolve => {
      requests.push(String(input))
      held.push((body, next) =>
        resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: next ? { 'X-Next-Cursor': next } : {},
          })
        )
      )
    })) as typeof fetch
}
const tick = () => new Promise(r => setTimeout(r, 0))
const cursorOf = (url: string) => new URL(url, 'http://localhost').searchParams.get('cursor')
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
    expect(st().reads.c40).toEqual({ lastRead: 59, latest: 60, server: 'far' })
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

describe('server colors', () => {
  test('a color change updates the server live without replacing the view', () => {
    serve([])
    const view = { kind: 'channel' as const, server: 'club', channelId: 3 }
    useStore.setState({
      view,
      servers: { club: serverDetail('club') },
      me: me('alice', {
        servers: [{ name: 'club', display_name: 'club', creator: null, is_admin: true }],
      }),
    })
    dispatch({
      type: 'server_renamed',
      old_name: 'club',
      server: {
        name: 'club',
        display_name: 'club',
        creator: null,
        has_password: false,
        banner_color: '#ff0066',
        name_color: '#ffffff',
      },
    })
    expect(st().view === view).toBe(true)
    expect(st().servers.club.banner_color).toBe('#ff0066')
    expect(st().servers.club.name_color).toBe('#ffffff')
    expect(st().me?.servers[0].banner_color).toBe('#ff0066')
    dispatch({
      type: 'server_renamed',
      old_name: 'club',
      server: { name: 'club', display_name: 'club', creator: null, has_password: false },
    })
    expect(st().servers.club.banner_color).toBeNull()
    expect(st().servers.club.name_color).toBeNull()
    expect(st().view === view).toBe(true)
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
    expect(cursorOf(requests[1])).toBe(cursorOf(requests[0]))
    held[0]([srv('s50'), srv('s51')])
    await load
    held[1]([srv('s51')])
    await tick()
    expect(serverNames()).toHaveLength(51)
    expect(serverNames().includes('s50')).toBe(false)
    expect(serverNames()[50]).toBe('s51')
    expect(st().serversMore).toBe(false)
  })

  test('leaving a loaded server mid-page asks again from the same cursor', async () => {
    useStore.setState({ me: me('alice', { servers: firstFifty() }), serversMore: true })
    hold()
    const load = st().loadMoreServers()
    await tick()
    dispatch({ type: 'member_left', server: 's10', username: 'alice' })
    await tick()
    expect(requests).toHaveLength(2)
    expect(cursorOf(requests[1])).toBe(cursorOf(requests[0]))
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

describe('server bans list', () => {
  const ban = (i: number) => ({ ...user(`b${i}`), banned_at: 100 - i })
  const names = () => st().bans.club.list.map(b => b.username)

  test('an unban while a page is in flight does not bring the ban back', async () => {
    useStore.setState({
      bans: {
        club: {
          list: Array.from({ length: 50 }, (_, i) => ban(i)),
          hasMore: true,
          loading: false,
          q: '',
          cursor: 'k49',
        },
      },
    })
    hold()
    const load = st().loadBans('club')
    await tick()
    const unban = st().unbanMember('club', 'b10')
    await tick()
    expect(requests).toHaveLength(2)
    expect(cursorOf(requests[0])).toBe('k49')
    expect(requests[1]).toEndWith('/servers/club/bans/b10')
    held[1]({ ok: true })
    await unban
    held[0]([ban(50)])
    await load
    expect(names()).toHaveLength(49)
    expect(names().includes('b10')).toBe(false)
    expect(st().bans.club.loading).toBe(false)
    const next = st().loadBans('club')
    await tick()
    expect(cursorOf(requests[2])).toBe('k49')
    held[2]([ban(50)])
    await next
    expect(names()).toHaveLength(50)
    expect(names().includes('b10')).toBe(false)
    expect(names()[49]).toBe('b50')
  })

  test('a ban seen over the socket refreshes a loaded list', async () => {
    useStore.setState({
      bans: { club: { list: [ban(1)], hasMore: false, loading: false, q: '' } },
    })
    serve([ban(0), ban(1)])
    dispatch({ type: 'member_kicked', server: 'club', username: 'b0', banned: true })
    await tick()
    expect(cursorOf(requests[0])).toBeNull()
    expect(names()).toEqual(['b0', 'b1'])
    dispatch({ type: 'member_kicked', server: 'club', username: 'b2', banned: false })
    await tick()
    expect(requests).toHaveLength(1)
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

describe('resync after the socket lagged', () => {
  const realRandom = Math.random
  beforeEach(() => {
    Math.random = () => 0
  })
  afterEach(() => {
    Math.random = realRandom
  })

  test('waits a random jitter of up to ten seconds before catching up', async () => {
    Math.random = () => 0.15
    serve({ items: [] })
    dispatch({ type: 'resync' })
    await new Promise(r => setTimeout(r, 1500))
    expect(requests).toHaveLength(0)
    await new Promise(r => setTimeout(r, 300))
    expect(requests.length > 0).toBe(true)
  })

  test('fully drops the open server even when the refetched me already lost it', async () => {
    const channels = [{ id: 7, name: 'general', kind: 'text' as const, slowmode_seconds: 0 }]
    const rchat = serverDetail('rchat', {
      channels: [{ id: 1, name: 'general', kind: 'text', slowmode_seconds: 0 }],
    })
    useStore.setState({
      me: me('alice', { servers: [srv('rchat'), { ...srv('club'), display_name: 'Club' }] }),
      serversMore: false,
      view: { kind: 'channel', server: 'club', channelId: 7 },
      servers: { club: serverDetail('club', { display_name: 'Club', channels }) },
      members: { club: paged([member('alice'), member('bob')]) },
      layout: { ...emptyLayout, servers: ['club', 'rchat'] },
      notices: [],
      error: null,
    })
    let releaseNames: () => void = () => {}
    const namesHeld = new Promise<void>(r => (releaseNames = r))
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input))
      requests.push(url.pathname + url.search)
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
      if (url.pathname.endsWith('/me/servers')) {
        await namesHeld
        return json(
          url.searchParams
            .getAll('names')
            .filter(n => n !== 'club')
            .map(srv)
        )
      }
      if (url.pathname.endsWith('/me'))
        return json(me('alice', { servers: [srv('rchat')], servers_more: false }))
      if (url.pathname.includes('/servers/club')) return json({ error: 'Not a member' }, 403)
      if (url.pathname.endsWith('/servers/rchat')) return json(rchat)
      return json(url.pathname.includes('/messages') ? [] : { items: [] })
    }) as typeof fetch
    dispatch({ type: 'resync' })
    await new Promise(r => setTimeout(r, 300))
    await tick()
    expect(serverNames()).toEqual(['rchat'])
    releaseNames()
    await new Promise(r => setTimeout(r, 20))
    expect(st().view).toEqual({ kind: 'channel', server: 'rchat', channelId: 1 })
    expect(st().servers.club).toBeUndefined()
    expect(st().members.club).toBeUndefined()
    expect(layoutServers(st().layout.servers)).toEqual(['rchat'])
    expect(st().notices.map(n => `${n.lead} ${n.name}`)).toEqual(['You were removed from Club'])
    expect(requests.some(r => r.includes('/servers/club/members'))).toBe(false)
    expect(st().error === 'Not a member').toBe(false)
  })

  test('a server that no longer exists drops without a removal notice', async () => {
    useStore.setState({
      me: me('alice', { servers: [srv('rchat'), srv('gone')] }),
      serversMore: false,
      servers: { gone: serverDetail('gone') },
      notices: [],
    })
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input))
      requests.push(url.pathname + url.search)
      if (url.pathname.endsWith('/servers/gone/exists'))
        return new Response(JSON.stringify({ error: 'Server not found' }), { status: 404 })
      const body = url.pathname.endsWith('/me/servers')
        ? url.searchParams
            .getAll('names')
            .filter(n => n !== 'gone')
            .map(srv)
        : url.pathname.endsWith('/me')
          ? me('alice', { servers: [srv('rchat')] })
          : { items: [] }
      return new Response(JSON.stringify(body), { status: 200 })
    }) as typeof fetch
    dispatch({ type: 'resync' })
    await new Promise(r => setTimeout(r, 320))
    expect(serverNames()).toEqual(['rchat'])
    expect(st().servers.gone).toBeUndefined()
    expect(st().notices).toHaveLength(0)
  })

  test('a kick that arrives during the check is not announced twice', async () => {
    useStore.setState({
      me: me('alice', { servers: [srv('rchat'), srv('club')] }),
      serversMore: false,
      servers: { club: serverDetail('club') },
      notices: [],
    })
    let releaseNames: () => void = () => {}
    const namesHeld = new Promise<void>(r => (releaseNames = r))
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input))
      requests.push(url.pathname + url.search)
      if (url.pathname.endsWith('/me/servers')) await namesHeld
      const body = url.pathname.endsWith('/me/servers')
        ? url.searchParams
            .getAll('names')
            .filter(n => n !== 'club')
            .map(srv)
        : url.pathname.endsWith('/me')
          ? me('alice', { servers: [srv('rchat'), srv('club')] })
          : { items: [] }
      return new Response(JSON.stringify(body), { status: 200 })
    }) as typeof fetch
    dispatch({ type: 'resync' })
    await new Promise(r => setTimeout(r, 300))
    dispatch({ type: 'member_kicked', server: 'club', username: 'alice', banned: false })
    releaseNames()
    await new Promise(r => setTimeout(r, 20))
    expect(serverNames()).toEqual(['rchat'])
    expect(st().notices).toHaveLength(1)
  })

  test('drops servers the user was removed from, past the first page too', async () => {
    const all = Array.from({ length: 52 }, (_, i) => srv(`s${i}`))
    const gone = new Set(['s1', 's51'])
    useStore.setState({
      me: me('alice', { servers: all, servers_more: true }),
      serversMore: true,
      servers: { s1: serverDetail('s1'), s2: serverDetail('s2'), s51: serverDetail('s51') },
    })
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input))
      requests.push(url.pathname + url.search)
      const names = url.searchParams.getAll('names')
      const body = url.pathname.endsWith('/me/servers')
        ? names.filter(n => !gone.has(n)).map(srv)
        : url.pathname.endsWith('/me')
          ? me('alice', {
              servers: all.slice(0, 50).filter(x => !gone.has(x.name)),
              servers_more: true,
            })
          : { items: [] }
      return new Response(JSON.stringify(body), { status: 200 })
    }) as typeof fetch
    dispatch({ type: 'resync' })
    dispatch({ type: 'resync' })
    expect(requests).toHaveLength(0)
    await new Promise(r => setTimeout(r, 300))
    await tick()
    expect(requests.filter(r => r.includes('names='))).toHaveLength(1)
    expect(serverNames()).toHaveLength(50)
    expect(serverNames().some(n => gone.has(n))).toBe(false)
    expect(Object.keys(st().servers)).toEqual(['s2'])
  })
})
