import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import { memberOf, serverAdminPerms, useStore, resetSessionCaches } from '../store'
import { Perm, type Member, type WsEvent } from '../types'
import { PRESENCE_LOG_MAX, byCodePoint, onlineRows, onlineSection, onlineTotals } from '../presence'
import { advance, me, member, paged, role, serverDetail, until } from './fixtures'
import { home } from '../instances'

afterAll(resetSessionCaches)

const st = () => useStore.getState()
const dispatch = (ev: WsEvent) => st().applyWsEvent(ev)
const tick = () => new Promise(r => setTimeout(r, 0))

const realFetch = globalThis.fetch
let requests: string[] = []
let directory: Record<string, Member> = {}
const asked = (url: string) => new URL(url).searchParams.getAll('usernames')

beforeEach(() => {
  resetSessionCaches()
  requests = []
  directory = {
    bob: member('bob', { role_ids: [1] }),
    carol: member('carol', { role_ids: [2], is_admin: true }),
    alice: member('alice', { role_ids: [2] }),
  }
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    requests.push(url)
    const found = asked(url).flatMap(n => (directory[n] ? [directory[n]] : []))
    return new Response(JSON.stringify(found), { status: 200 })
  }) as typeof fetch
  useStore.setState({
    guest: false,
    view: null,
    me: me('alice', {
      servers: [{ name: 's', display_name: 's', creator: null, is_admin: false }],
    }),
    servers: {
      s: serverDetail('s', { roles: [role(1, '#ff0000', 0), role(2, '#00ff00', Perm.Kick)] }),
    },
    members: { s: paged([member('dave', { role_ids: [1] })]) },
    memberInfo: {},
  })
})

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('member lookups for authors', () => {
  test('fetches only unknown names, records non-members, and dedupes in flight', async () => {
    const first = st().ensureMembers('s', ['bob', 'dave', 'zed', 'bob', ''])
    const second = st().ensureMembers('s', ['bob', 'zed'])
    await Promise.all([first, second])
    expect(requests).toHaveLength(1)
    expect(requests[0]).toContain('/servers/s/members?')
    expect(asked(requests[0])).toEqual(['bob', 'zed'])
    expect(memberOf(st(), 's', 'bob')?.role_ids).toEqual([1])
    expect(st().memberInfo.s?.zed).toBeNull()
    expect(memberOf(st(), 's', 'zed')).toBeUndefined()
    expect(memberOf(st(), 's', 'dave')?.role_ids).toEqual([1])
    await st().ensureMembers('s', ['bob', 'zed', 'dave'])
    expect(requests).toHaveLength(1)
  })

  test('batches large author lists by 100', async () => {
    const names = Array.from({ length: 150 }, (_, i) => `u${i}`)
    await st().ensureMembers('s', names)
    expect(requests.map(r => asked(r).length)).toEqual([100, 50])
  })

  test('own row from the lookup drives server perms', async () => {
    expect(serverAdminPerms(st(), 's')).toBe(0)
    await st().ensureMembers('s', ['alice'])
    expect(serverAdminPerms(st(), 's')).toBe(Perm.Kick)
  })

  test('ws events keep cached rows current', async () => {
    await st().ensureMembers('s', ['bob', 'carol', 'zed'])
    dispatch({ type: 'admin_changed', server: 's', username: 'bob', is_admin: true, perms: 4 })
    dispatch({ type: 'presence_changed', server: 's', username: 'bob', online: true })
    await new Promise(r => setTimeout(r, 20))
    expect(memberOf(st(), 's', 'bob')).toEqual({
      ...member('bob', { role_ids: [1] }),
      is_admin: true,
      perms: 4,
      online: true,
    })
    dispatch({
      type: 'user_updated',
      user: { username: 'bob', display_name: 'Bob', avatar_kind: 'color', avatar_color: '#123456' },
    })
    expect(memberOf(st(), 's', 'bob')?.display_name).toBe('Bob')
    dispatch({ type: 'member_left', server: 's', username: 'carol' })
    expect(st().memberInfo.s?.carol).toBeNull()
    dispatch({ type: 'member_joined', server: 's', member: member('zed', { role_ids: [2] }) })
    expect(memberOf(st(), 's', 'zed')?.role_ids).toEqual([2])
  })

  test('roles_changed refetches the cached members', async () => {
    await st().ensureMembers('s', ['bob', 'zed'])
    requests = []
    directory.bob = member('bob', { role_ids: [2] })
    dispatch({ type: 'roles_changed', server: 's' })
    await until(() => memberOf(st(), 's', 'bob')?.role_ids[0] === 2)
    const lookups = requests.filter(r => r.includes('usernames='))
    expect(lookups).toHaveLength(1)
    expect(asked(lookups[0])).toEqual(['bob'])
    expect(memberOf(st(), 's', 'bob')?.role_ids).toEqual([2])
  })

  test('a lookup racing roles_changed is retried instead of applied', async () => {
    const pending = st().ensureMembers('s', ['bob'])
    dispatch({ type: 'roles_changed', server: 's' })
    directory.bob = member('bob', { role_ids: [2] })
    await pending
    await until(() => memberOf(st(), 's', 'bob')?.role_ids[0] === 2)
    expect(memberOf(st(), 's', 'bob')?.role_ids).toEqual([2])
  })

  test('leaving a server drops its cache', async () => {
    await st().ensureMembers('s', ['bob'])
    dispatch({ type: 'member_left', server: 's', username: 'alice' })
    expect(st().memberInfo.s).toBeUndefined()
  })
})

describe('the online section', () => {
  const online = (username: string, on = true): WsEvent => ({
    type: 'presence_changed',
    server: 's',
    username,
    online: on,
  })
  const frame = () => new Promise(r => setTimeout(r, 20))
  const shown = () => onlineRows(st().members.s.list, st().memberInfo.s).map(m => m.username)
  const json = (body: unknown, next?: string) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: next ? { 'X-Next-Cursor': next } : {},
    })
  const serveDirectory = () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input))
      requests.push(url.href)
      const names = asked(url.href)
      if (names.length) return json(names.flatMap(n => (directory[n] ? [directory[n]] : [])))
      if (url.pathname.endsWith('/servers/s/members')) {
        const [phase, after] = (url.searchParams.get('cursor') ?? 'o:').split(':')
        const past = (m: Member) => byCodePoint(m.username, after) > 0
        const all = Object.values(directory).sort((a, b) => byCodePoint(a.username, b.username))
        const rows = [
          ...all.filter(m => phase === 'o' && m.online && past(m)),
          ...all.filter(m => !m.online && (phase === 'o' || past(m))),
        ]
        const last = rows[49]
        return json(
          rows.slice(0, 50),
          rows.length > 50 ? `${last.online ? 'o' : 'f'}:${last.username}` : undefined
        )
      }
      if (url.pathname.endsWith('/me/servers')) return json(st().me?.servers ?? [])
      if (url.pathname.endsWith('/me')) return json(st().me)
      if (url.pathname.endsWith('/servers/s')) return json(st().servers.s)
      return json([])
    }) as typeof fetch
  }
  const lists = () => requests.filter(r => r.includes('/servers/s/members?limit='))
  const restarts = () => lists().filter(r => new URL(r).searchParams.get('cursor') === null)
  const sidebar = () => {
    const { online_count, member_count } = st().servers.s
    const section = onlineSection(online_count, member_count, st().members.s, st().memberInfo.s)
    return { ...section.totals, rows: section.online.length, more: section.more }
  }
  const named = (prefix: string, n: number, width: number) =>
    Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(width, '0')}`)
  const turn = async (usernames: string[], on: boolean) => {
    for (const n of usernames) {
      directory[n] = { ...directory[n], online: on }
      dispatch(online(n, on))
    }
    await frame()
  }

  beforeEach(() => {
    for (const n of ['bob', 'carol']) directory[n] = { ...directory[n], online: true }
    useStore.setState({
      members: { s: { ...paged([member('alice', { online: true })]), hasMore: true } },
    })
  })

  test('people who come online after the list loaded join the online section', async () => {
    dispatch(online('bob'))
    dispatch(online('carol'))
    await frame()
    expect(requests).toHaveLength(0)
    await st().loadMissingOnline('s')
    expect(asked(requests[0])).toEqual(['bob', 'carol'])
    expect(shown()).toEqual(['alice', 'bob', 'carol'])
    await st().loadMissingOnline('s')
    expect(requests).toHaveLength(1)
  })

  test('a storm of 100 arrivals asks for at most 50 names per load', async () => {
    const names = Array.from({ length: 100 }, (_, i) => `u${String(i).padStart(3, '0')}`)
    for (const n of names) directory[n] = member(n, { online: true })
    for (const n of names) dispatch(online(n))
    await frame()
    expect(requests).toHaveLength(0)
    await st().loadMissingOnline('s')
    expect(requests.map(asked)).toEqual([names.slice(0, 50)])
    await st().loadMissingOnline('s')
    expect(requests.map(asked)).toEqual([names.slice(0, 50), names.slice(50)])
    expect(shown()).toEqual(['alice', ...names])
  })

  test('someone who went offline again is not asked for', async () => {
    dispatch(online('bob'))
    dispatch(online('bob', false))
    dispatch(online('carol'))
    await frame()
    await st().loadMissingOnline('s')
    expect(requests.map(asked)).toEqual([['carol']])
    dispatch(online('carol', false))
    await frame()
    expect(shown()).toEqual(['alice'])
  })

  test('a list read to its end still finds the people its cursor skipped', async () => {
    directory = { alice: member('alice', { online: true }), dave: member('dave') }
    for (const n of named('u', 60, 2)) directory[n] = member(n)
    serveDirectory()
    useStore.setState(s => ({
      servers: { s: { ...s.servers.s, member_count: 62, online_count: 1 } },
    }))
    await st().loadMembers('s', true)
    await turn(['u10', 'u55'], true)
    while (st().members.s.hasMore) await st().loadMembers('s')
    expect(st().members.s.list.map(m => m.username)).not.toContain('u55')
    expect(sidebar()).toEqual({ online: 3, offline: 59, rows: 2, more: 'omore2:0' })
    requests = []
    await st().loadMissingOnline('s')
    expect(requests.map(asked)).toEqual([['u55']])
    expect(sidebar()).toEqual({ online: 3, offline: 59, rows: 3, more: null })
    await turn(['u55'], false)
    expect(sidebar()).toEqual({ online: 2, offline: 60, rows: 2, more: null })
  })

  describe('when the presence log dropped arrivals', () => {
    const names = named('u', PRESENCE_LOG_MAX + 50, 4)
    const lookUp = async () => {
      for (let i = 0; i < PRESENCE_LOG_MAX / 50; i++) await st().loadMissingOnline('s')
    }

    test('a list past its online section restarts to find them', async () => {
      directory = { alice: member('alice', { online: true }), dave: member('dave') }
      for (const n of [...named('f', 60, 2), ...names]) directory[n] = member(n)
      serveDirectory()
      await st().loadMembers('s', true)
      expect(st().members.s.list.at(-1)?.username).toBe('f47')
      requests = []
      await turn(['f47'], true)
      await turn(names, true)
      await lookUp()
      expect(shown()).toEqual(['alice', 'f47', ...names.slice(50)])
      expect(lists()).toHaveLength(0)
      await st().loadMissingOnline('s')
      expect(restarts()).toHaveLength(1)
      while (st().members.s.list.every(m => m.online) && st().members.s.hasMore)
        await st().loadMembers('s')
      expect(shown()).toEqual(['alice', 'f47', ...names])
      const before = requests.length
      await st().loadMissingOnline('s')
      expect(requests).toHaveLength(before)
    })

    test('a list read to its end restarts to find them', async () => {
      const early = named('b', PRESENCE_LOG_MAX + 50, 4)
      directory = { alice: member('alice', { online: true }) }
      for (const n of named('o', 59, 2)) directory[n] = member(n, { online: true })
      for (const n of early) directory[n] = member(n)
      serveDirectory()
      await st().loadMembers('s', true)
      requests = []
      await turn(early, true)
      await st().loadMembers('s')
      expect(st().members.s.hasMore).toBe(false)
      expect(st().members.s.list.at(-1)).toMatchObject({ username: 'o58', online: true })
      await lookUp()
      expect(restarts()).toHaveLength(0)
      await st().loadMissingOnline('s')
      expect(restarts()).toHaveLength(1)
      while (st().members.s.hasMore) await st().loadMembers('s')
      expect(shown()).toEqual(['alice', ...early, ...named('o', 59, 2)])
    })

    test('a list still paging its online section is left to its own pages', async () => {
      const o = named('o', 59, 2)
      directory = { alice: member('alice', { online: true }) }
      for (const n of [...o, ...names]) directory[n] = member(n)
      serveDirectory()
      await st().loadMembers('s', true)
      expect(st().members.s.list.at(-1)).toMatchObject({ username: 'o48', online: false })
      await turn(o, true)
      await st().loadMembers('s', true)
      expect(st().members.s.list.at(-1)).toMatchObject({ username: 'o48', online: true })
      requests = []
      await turn(['o48'], false)
      await turn(names, true)
      await lookUp()
      await st().loadMissingOnline('s')
      expect(lists()).toHaveLength(0)
      expect(st().members.s.list).toHaveLength(50)
      while (st().members.s.hasMore) await st().loadMembers('s')
      expect(restarts()).toHaveLength(0)
      expect(shown()).toEqual(['alice', ...o.filter(n => n !== 'o48'), ...names])
    })
  })

  describe('after an outage', () => {
    const realRandom = Math.random
    beforeEach(() => {
      jest.useFakeTimers()
      Math.random = () => 0
    })
    afterEach(() => {
      Math.random = realRandom
      jest.useRealTimers()
    })

    test('the catch-up refreshes looked-up rows the snapshot does not decide', async () => {
      const names = Array.from({ length: 120 }, (_, i) => `u${String(i).padStart(3, '0')}`)
      for (const n of ['alice', ...names]) directory[n] = member(n, { online: true })
      serveDirectory()
      useStore.setState(s => ({
        view: { kind: 'channel', server: 's', channelId: 1 },
        servers: {
          s: { ...s.servers.s, member_count: Object.keys(directory).length, online_count: 1 },
        },
      }))
      for (const n of ['bob', 'carol', ...names]) dispatch(online(n))
      await advance(20)
      for (let i = 0; i < 3; i++) await st().loadMissingOnline('s')
      expect(shown()).toHaveLength(123)
      for (const n of names.slice(60)) directory[n] = member(n)
      const on = Object.values(directory)
        .filter(m => m.online)
        .map(m => m.username)
        .sort(byCodePoint)
      dispatch({
        type: 'presence_snapshot',
        server: 's',
        online: on.slice(0, 50),
        online_count: on.length,
      })
      dispatch({ type: 'resync' })
      await advance(300)
      expect(lists()).toHaveLength(1)
      expect(shown().filter(n => !directory[n].online)).toEqual([])
      expect(shown()).toEqual(on)
      const { list } = st().members.s
      const rows = [...onlineRows(list, st().memberInfo.s), ...list.filter(m => !m.online)]
      const { online_count, member_count } = st().servers.s
      expect(onlineTotals(online_count, member_count, rows, false).online).toBe(on.length)
    })

    test('looked-up authors are refreshed too while the member list is closed', async () => {
      const names = Array.from({ length: 60 }, (_, i) => `u${String(i).padStart(3, '0')}`)
      for (const n of names) directory[n] = member(n, { online: true })
      serveDirectory()
      useStore.setState(s => ({
        view: { kind: 'channel', server: 's', channelId: 1 },
        members: {},
        servers: { s: { ...s.servers.s, member_count: 63, online_count: 62 } },
      }))
      await st().ensureMembers('s', names)
      for (const n of names.slice(55)) directory[n] = member(n)
      dispatch({
        type: 'presence_snapshot',
        server: 's',
        online: ['bob', 'carol', ...names.slice(0, 48)],
        online_count: 57,
      })
      dispatch({ type: 'resync' })
      await advance(300)
      expect(lists()).toHaveLength(0)
      const info = st().memberInfo.s
      expect(names.filter(n => info[n]?.online)).toEqual(names.slice(0, 55))
    })
  })
})

describe('same-name server updates', () => {
  const lite = (name: string) => ({
    name,
    display_name: name,
    creator: null,
    has_password: false,
    banner_color: '#ff0066',
    name_color: null,
  })
  const recolor = (name: string): WsEvent =>
    name === 's'
      ? { type: 'server_updated', server: lite(name) }
      : { type: 'server_renamed', old_name: 's', server: lite(name) }
  const lookups = () => requests.filter(r => r.includes('usernames='))

  test('a color change keeps an in-flight member lookup', async () => {
    const pending = st().ensureMembers('s', ['bob'])
    dispatch(recolor('s'))
    await pending
    await tick()
    await tick()
    expect(lookups()).toHaveLength(1)
    expect(memberOf(st(), 's', 'bob')?.role_ids).toEqual([1])
    expect(st().servers.s.banner_color).toBe('#ff0066')
  })

  test('server_updated and channel_updated patch the cached detail', () => {
    dispatch({ type: 'server_updated', server: { ...lite('s'), has_password: true } })
    expect(st().servers.s.has_password).toBe(true)
    expect(st().servers.s.banner_color).toBe('#ff0066')
    const channel = { id: 7, name: 'general', kind: 'text' as const, slowmode_seconds: 0 }
    useStore.setState(x => ({ servers: { s: { ...x.servers.s, channels: [channel] } } }))
    dispatch({
      type: 'channel_updated',
      server: 's',
      channel: { ...channel, slowmode_seconds: 30 },
    })
    expect(st().servers.s.channels[0].slowmode_seconds).toBe(30)
    expect(st().servers.s.channels[0].name).toBe(channel.name)
  })

  test('a guest is resubscribed only on a real rename', () => {
    const calls: string[] = []
    const { subscribe, unsubscribe } = home.ws
    home.ws.subscribe = servers => void calls.push(`sub ${servers.join(',')}`)
    home.ws.unsubscribe = server => void calls.push(`unsub ${server}`)
    try {
      useStore.setState({ me: null, guest: true, guestServers: ['s'] })
      dispatch(recolor('s'))
      expect(calls).toEqual([])
      dispatch(recolor('t'))
      expect(calls).toEqual(['unsub s', 'sub t'])
    } finally {
      home.ws.subscribe = subscribe
      home.ws.unsubscribe = unsubscribe
    }
  })
})
