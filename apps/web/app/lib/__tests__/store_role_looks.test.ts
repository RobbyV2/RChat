import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import { resetSessionCaches, roleLook, useStore } from '../store'
import { Perm, type Member, type Role, type WsEvent } from '../types'
import { advance, me, member, role, serverDetail, until } from './fixtures'

afterAll(resetSessionCaches)

const st = () => useStore.getState()
const dispatch = (ev: WsEvent) => st().applyWsEvent(ev)

const realFetch = globalThis.fetch
let requests: string[] = []
let groups: Record<string, Member[]> = {}

const ranked = (id: number, position: number, over: Partial<Role> = {}): Role => ({
  ...role(id, `#00000${id}`, 0),
  name: `r${id}`,
  position,
  ...over,
})

beforeEach(() => {
  resetSessionCaches()
  requests = []
  groups = {
    '1': [member('zed', { role_ids: [1], online: false }), member('amy', { role_ids: [1] })],
    rest: [member('bob'), member('cat', { online: false })],
  }
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    requests.push(url.pathname + url.search)
    const p = url.searchParams
    const key = p.get('unhoisted') ? 'rest' : (p.get('role') ?? '')
    if (url.pathname.endsWith('/members') && (p.get('top_hoisted') || p.get('unhoisted')))
      return new Response(JSON.stringify(groups[key] ?? []), { status: 200 })
    return new Response(JSON.stringify(serverDetail('s')), { status: 200 })
  }) as typeof fetch
  useStore.setState({
    guest: false,
    view: null,
    me: me('alice', {
      servers: [{ name: 's', display_name: 's', creator: null, is_admin: false }],
    }),
    servers: {
      s: serverDetail('s', {
        roles: [ranked(1, 3, { hoist: true }), ranked(2, 2), ranked(3, 1)],
        roles_version: 4,
      }),
    },
    members: {},
    hoisted: {},
  })
})

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('role events', () => {
  test('a role that changed how it shows is replaced in place', () => {
    const changed = ranked(2, 2, { icon: 'x', name: 'Crew', hoist: true })
    dispatch({ type: 'role_updated', server: 's', role: changed })
    expect(st().servers.s.roles.map(r => r.name)).toEqual(['r1', 'Crew', 'r3'])
    expect(st().servers.s.roles[1]).toEqual(changed)
    expect(requests).toEqual([])
    dispatch({ type: 'role_updated', server: 'gone', role: changed })
    expect(st().servers.gone).toBeUndefined()
  })

  test('a new order places the roles; a stale one is ignored, an unknown role reloads', async () => {
    dispatch({
      type: 'roles_reordered',
      server: 's',
      order: [3, 1, 2],
      display: [null, 5, null],
      version: 5,
    })
    const roles = st().servers.s.roles
    expect(roles.map(r => [r.id, r.position, r.display_position])).toEqual([
      [3, 3, null],
      [1, 2, 5],
      [2, 1, null],
    ])
    expect(st().servers.s.roles_version).toBe(5)
    expect(requests).toEqual([])
    dispatch({
      type: 'roles_reordered',
      server: 's',
      order: [1, 2, 3],
      display: [null, null, null],
      version: 5,
    })
    expect(st().servers.s.roles.map(r => r.id)).toEqual([3, 1, 2])
    dispatch({
      type: 'roles_reordered',
      server: 's',
      order: [9, 3, 1, 2],
      display: [null, null, null, null],
      version: 6,
    })
    await until(() => requests.includes('/api/servers/s'))
    expect(requests).toContain('/api/servers/s')
  })

  test('managers reload the server for what they may change', async () => {
    useStore.setState({
      servers: {
        s: serverDetail('s', {
          roles: [ranked(1, 2), ranked(2, 1)],
          roles_version: 1,
          my_perms: Perm.ManageRoles,
        }),
      },
    })
    useStore.setState({
      me: me('alice', {
        servers: [{ name: 's', display_name: 's', creator: null, is_admin: true }],
      }),
    })
    dispatch({
      type: 'roles_reordered',
      server: 's',
      order: [2, 1],
      display: [null, null],
      version: 2,
    })
    await until(() => requests.includes('/api/servers/s'))
    expect(requests).toContain('/api/servers/s')
  })

  test('role events that arrive while the server loads are kept', async () => {
    let release = () => {}
    const held = new Promise<void>(r => (release = r))
    const serve = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input))
      if (url.pathname !== '/api/servers/s') return serve(input)
      requests.push(url.pathname)
      await held
      const roles = [ranked(1, 3, { hoist: true }), ranked(2, 2), ranked(3, 1)]
      const detail = serverDetail('s', { display_name: 'loaded', roles, roles_version: 4 })
      return new Response(JSON.stringify(detail), { status: 200 })
    }) as typeof fetch
    dispatch({ type: 'roles_changed', server: 's' })
    await until(() => requests.includes('/api/servers/s'))
    dispatch({ type: 'role_updated', server: 's', role: ranked(2, 9, { hoist: true, icon: 'x' }) })
    dispatch({
      type: 'roles_reordered',
      server: 's',
      order: [2, 1, 3],
      display: [null, 7, null],
      version: 5,
    })
    release()
    await until(() => st().servers.s.display_name === 'loaded')
    const { roles, roles_version } = st().servers.s
    expect(roles.map(r => [r.id, r.position, r.display_position ?? null, !!r.hoist])).toEqual([
      [2, 3, null, true],
      [1, 2, 7, true],
      [3, 1, null, false],
    ])
    expect(roles[0].icon).toBe('x')
    expect(roles_version).toBe(5)
  })

  test('names take the color and icon of the roles in display order', () => {
    const roles = [
      ranked(1, 2, { color_names: false, icon: String.fromCodePoint(0x1f6e1, 0xfe0f) }),
      ranked(2, 1, { display_position: 9, color: '#abcdef' }),
    ]
    expect(roleLook(roles, [1, 2])).toEqual({
      color: '#abcdef',
      icon: { emoji: String.fromCodePoint(0x1f6e1, 0xfe0f), role: 'r1' },
    })
    expect(roleLook(undefined, [1])).toEqual({})
  })
})

describe('the groups of the member list', () => {
  test('a group loads a page of its members and the rest loads its own', async () => {
    await st().loadGroup('s', 1, true, 20)
    await st().loadGroup('s', 'rest', true)
    expect(requests).toEqual([
      '/api/servers/s/members?limit=20&role=1&top_hoisted=1',
      '/api/servers/s/members?limit=50&unhoisted=1',
    ])
    expect(st().hoisted.s['1'].list.map(m => m.username)).toEqual(['zed', 'amy'])
    expect(st().hoisted.s.rest.list.map(m => m.username)).toEqual(['bob', 'cat'])
  })

  test('members joining, leaving and coming online change the loaded groups', async () => {
    await st().loadGroup('s', 1, true)
    await st().loadGroup('s', 'rest', true)
    dispatch({ type: 'member_joined', server: 's', member: member('dan') })
    expect(st().hoisted.s.rest.list.map(m => m.username)).toEqual(['bob', 'cat', 'dan'])
    expect(st().hoisted.s['1'].list.map(m => m.username)).toEqual(['zed', 'amy'])
    dispatch({ type: 'member_left', server: 's', username: 'zed' })
    expect(st().hoisted.s['1'].list.map(m => m.username)).toEqual(['amy'])
    st().notePresence('s', 'cat', true)
    expect(st().hoisted.s.rest.list.find(m => m.username === 'cat')?.online).toBe(true)
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

    test('the catch-up forgets the groups of the open server, so the list loads them again', async () => {
      useStore.setState({ view: { kind: 'channel', server: 's', channelId: 1 } })
      await st().loadGroup('s', 'rest', true)
      expect(st().hoisted.s.rest.list.map(m => m.username)).toEqual(['bob', 'cat'])
      dispatch({ type: 'resync' })
      await advance(300, () => !st().hoisted.s)
      expect(st().hoisted.s).toBeUndefined()
    })
  })

  test('a change of roles forgets the groups, so the list loads them again', async () => {
    await st().loadGroup('s', 1, true)
    dispatch({ type: 'roles_changed', server: 's' })
    expect(st().hoisted.s).toBeUndefined()
    await st().loadGroup('s', 1, true)
    st().clearGroups('s')
    expect(st().hoisted.s).toBeUndefined()
  })
})
