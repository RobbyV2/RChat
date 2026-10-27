import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { memberOf, serverAdminPerms, useStore } from '../store'
import { Perm, type Member, type WsEvent } from '../types'
import { me, member, paged, role, serverDetail } from './fixtures'
import { home } from '../instances'

const st = () => useStore.getState()
const dispatch = (ev: WsEvent) => st().applyWsEvent(ev)
const tick = () => new Promise(r => setTimeout(r, 0))

const realFetch = globalThis.fetch
let requests: string[] = []
let directory: Record<string, Member> = {}
const asked = (url: string) => new URL(url).searchParams.getAll('usernames')

beforeEach(() => {
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
    await tick()
    await tick()
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
    await tick()
    await tick()
    expect(memberOf(st(), 's', 'bob')?.role_ids).toEqual([2])
  })

  test('leaving a server drops its cache', async () => {
    await st().ensureMembers('s', ['bob'])
    dispatch({ type: 'member_left', server: 's', username: 'alice' })
    expect(st().memberInfo.s).toBeUndefined()
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
