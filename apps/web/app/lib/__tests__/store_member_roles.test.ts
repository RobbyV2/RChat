import { testClock, type ManualTime } from './helpers/test_clock'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resetSessionCaches, useStore } from '../store'
import { Perm, type Member, type Role, type ServerDetail, type WsEvent } from '../types'
import { me, member, role, serverDetail, until } from './fixtures'
import { writeJson } from '../api/masks'

let clock: ManualTime
beforeEach(() => {
  clock = testClock()
})

const st = () => useStore.getState()
const dispatch = (ev: WsEvent) => st().applyWsEvent(ev)
const changed = (username: string, role_ids: number[]): WsEvent => ({
  type: 'member_roles_changed',
  server: 's',
  username,
  role_ids,
})

const realFetch = globalThis.fetch
let requests: string[] = []
let groups: Record<string, Member[]> = {}
let directory: Record<string, Member> = {}
let hold: Promise<void> | null = null
let stale: Member[] = []

const ranked = (id: number, position: number, over: Partial<Role> = {}): Role => ({
  ...role(id, `#00000${id}`, 0n),
  name: `r${id}`,
  position,
  ...over,
})

const server = (over: Partial<ServerDetail> = {}) =>
  serverDetail('s', {
    roles: [ranked(1, 2, { hoist: true }), ranked(2, 1)],
    roles_version: 1,
    roles_order_confirmed: true,
    ...over,
  })

const manager = (confirmed: boolean) =>
  useStore.setState({
    servers: { s: server({ my_perms: Perm.ManageRoles, roles_order_confirmed: confirmed }) },
    me: me('alice', {
      servers: [{ name: 's', display_name: 's', creator: null, is_admin: true }],
    }),
  })

beforeEach(() => {
  resetSessionCaches()
  requests = []
  groups = { '1': [member('amy', { role_ids: [1] })], rest: [member('bob'), member('cat')] }
  directory = { zed: member('zed', { role_ids: [1] }) }
  hold = null
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    requests.push(url.pathname + url.search)
    const p = url.searchParams
    const key = p.get('unhoisted') ? 'rest' : (p.get('role') ?? '')
    const list = groups[key] ?? []
    if (hold) await hold
    if (url.pathname.endsWith('/members') && (p.get('top_hoisted') || p.get('unhoisted')))
      return new Response(writeJson(list), { status: 200 })
    if (url.pathname.endsWith('/members') && p.getAll('usernames').length) {
      const rows = p.getAll('usernames').flatMap(n => (directory[n] ? [directory[n]] : []))
      return new Response(writeJson(rows), { status: 200 })
    }
    if (url.pathname.endsWith('/members')) return new Response(writeJson(stale), { status: 200 })
    return new Response(writeJson(server()), { status: 200 })
  }) as typeof fetch
  useStore.setState({
    guest: false,
    view: null,
    me: me('alice', {
      servers: [{ name: 's', display_name: 's', creator: null, is_admin: false }],
    }),
    servers: { s: server() },
    members: {
      s: {
        list: [member('amy', { role_ids: [1] }), member('bob')],
        hasMore: false,
        loading: false,
        q: '',
        cursor: null,
      },
    },
    memberInfo: { s: { cat: member('cat') } },
    hoisted: {},
  })
})

afterEach(() => {
  globalThis.fetch = realFetch
})

const names = (key: string) => st().hoisted.s[key].list.map(m => m.username)
const settle = () => clock.pass(20)

describe("one member's roles", () => {
  test('change that member only: their rows and the group they show in, with nothing reloaded', async () => {
    await st().loadGroup('s', 1, true)
    await st().loadGroup('s', 'rest', true)
    requests = []
    dispatch(changed('bob', [1, 2]))
    expect(st().members.s.list.find(m => m.username === 'bob')?.role_ids).toEqual([1, 2])
    expect(names('1')).toEqual(['amy', 'bob'])
    expect(names('rest')).toEqual(['cat'])
    dispatch(changed('amy', []))
    expect(names('1')).toEqual(['bob'])
    expect(names('rest')).toEqual(['cat', 'amy'])
    dispatch(changed('cat', [2]))
    expect(st().memberInfo.s.cat?.role_ids).toEqual([2])
    expect(st().hoisted.s.rest.list.find(m => m.username === 'cat')?.role_ids).toEqual([2])
    await settle()
    expect(requests).toEqual([])
  })

  test('a member not loaded anywhere is looked up for the loaded page of their group', async () => {
    await st().loadGroup('s', 1, true)
    requests = []
    dispatch(changed('zed', [1]))
    await until(() => st().hoisted.s['1'].list.some(m => m.username === 'zed'))
    expect(names('1')).toEqual(['amy', 'zed'])
    expect(requests).toEqual(['/api/servers/s/members?usernames=zed'])
    requests = []
    dispatch(changed('yan', [2]))
    await settle()
    expect(requests).toEqual([])
  })

  test('a page that loads while roles change keeps the change and leaves the old group', async () => {
    let release = () => {}
    hold = new Promise<void>(r => (release = r))
    groups['1'] = [member('amy', { role_ids: [1] }), member('bob', { role_ids: [1] })]
    stale = [member('amy'), member('bob'), member('dan')]
    useStore.setState(s => ({ members: { s: { ...s.members.s, hasMore: true, cursor: 'c' } } }))
    const group = st().loadGroup('s', 1, true)
    const list = st().loadMembers('s')
    await until(() => requests.length === 2)
    expect(requests).toHaveLength(2)
    dispatch(changed('bob', [2]))
    dispatch(changed('amy', [1, 2]))
    dispatch(changed('dan', [1]))
    release()
    await group
    await list
    expect(names('1')).toEqual(['amy'])
    expect(st().hoisted.s['1'].list[0].role_ids).toEqual([1, 2])
    expect(st().members.s.list.map(m => [m.username, m.role_ids])).toEqual([
      ['amy', [1, 2]],
      ['bob', [2]],
      ['dan', [1]],
    ])
  })

  test('a change of your own roles reloads the server, for what you hold now', async () => {
    dispatch(changed('alice', [2]))
    await until(() => requests.includes('/api/servers/s'))
    expect(requests).toContain('/api/servers/s')
  })

  test('managers reload the server only while the role order is unconfirmed', async () => {
    manager(true)
    dispatch(changed('bob', [2]))
    await settle()
    expect(requests).toEqual([])
    manager(false)
    dispatch(changed('bob', [1]))
    await until(() => requests.includes('/api/servers/s'))
    expect(requests).toContain('/api/servers/s')
  })
})
