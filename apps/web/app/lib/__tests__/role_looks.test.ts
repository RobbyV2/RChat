import { describe, expect, test } from 'bun:test'
import {
  HOIST_GROUPS,
  displayOrder,
  groupOf,
  hoistGroups,
  hostedShown,
  lookOf,
  onlineFirst,
  p2pShown,
  placeRoles,
  roleIcon,
  withRole,
  withRoleEvents,
} from '../role_looks'
import { FIRST_GROUPS, groupParts, mapGroups, regroup, serverGroups } from '../member_groups'
import { displayOrderOf, hoistGroupsOf } from '../perms'
import type { Member, Role } from '../types'
import { loadPerms } from './helpers/perms'
import { serverDetail } from './fixtures'

const role = (id: number, position: number, over: Partial<Role> = {}): Role => ({
  id,
  name: `r${id}`,
  color: `#00000${id}`,
  perms: 0n,
  position,
  ...over,
})

const shield = String.fromCodePoint(0x1f6e1, 0xfe0f)

describe('the order roles show in', () => {
  test('a higher place shows higher; roles at one place keep their rank order', () => {
    const ranked = [{ place: 4 }, { place: 3 }, { place: 9 }, { place: 3 }, { place: 1 }]
    expect(displayOrder(ranked).map(r => ranked.indexOf(r))).toEqual([2, 0, 1, 3, 4])
  })

  test('the display order and the groups are the ones the shared rules decide', async () => {
    await loadPerms()
    let seed = 7
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    for (let k = 0; k < 400; k++) {
      const n = next(16)
      const places = Array.from({ length: n }, () => next(6) - 1)
      const hoist = Array.from({ length: n }, () => next(3) > 0)
      const ranked = places.map((place, i) => ({ place, hoist: hoist[i], i }))
      expect(displayOrder(ranked).map(r => r.i)).toEqual(displayOrderOf(places))
      expect(hoistGroups(ranked).map(r => r.i)).toEqual(hoistGroupsOf(places, hoist))
    }
  })

  test('hosted roles show by display position, else by position; P2P ones by dpos, else pos', () => {
    const roles = [role(1, 1, { display_position: 9 }), role(2, 3), role(3, 2)]
    expect(hostedShown(roles).map(r => r.id)).toEqual([1, 2, 3])
    expect(hostedShown([role(2, 3), role(3, 3)]).map(r => r.id)).toEqual([2, 3])
    expect(hostedShown(undefined)).toEqual([])
    const p2p = (id: string, pos: number, dpos: number | null) => ({
      id,
      name: id,
      pos,
      dpos,
      hoist: true,
      tint: true,
      color: null,
      icon: null,
    })
    expect(
      p2pShown([p2p('a', 30, null), p2p('b', 20, 40), p2p('c', 10, null)]).map(r => r.id)
    ).toEqual(['b', 'a', 'c'])
  })

  test('a new order places every role, or none when the roles differ', () => {
    const roles = [role(1, 2), role(2, 1, { display_position: 4 })]
    expect(placeRoles(roles, [2, 1], [null, 7])).toEqual([
      { ...roles[1], position: 2, display_position: null },
      { ...roles[0], position: 1, display_position: 7 },
    ])
    expect(placeRoles(roles, [2], [null])).toBeNull()
    expect(placeRoles(roles, [2, 2], [null, null])).toBeNull()
    expect(placeRoles(roles, [2, 3], [null, null])).toBeNull()
    expect(placeRoles(roles, [2, 1], [null])).toBeNull()
  })

  test('an updated role keeps its places; a loaded server takes the newer order it missed', () => {
    const roles = [role(1, 2), role(2, 1, { display_position: 4 })]
    const renamed = role(2, 8, { name: 'Crew', display_position: 9 })
    expect(withRole(roles, renamed)).toEqual([
      roles[0],
      { ...renamed, position: 1, display_position: 4 },
    ])
    const detail = { ...serverDetail('s'), roles, roles_version: 3 }
    const places = { order: [2, 1], display: [null, null], version: 4 }
    expect(withRoleEvents(detail, new Map(), null)).toBe(detail)
    expect(withRoleEvents(detail, new Map(), { ...places, version: 3 })).toBe(detail)
    const merged = withRoleEvents(detail, new Map([[2, renamed]]), places)
    expect(merged.roles.map(r => [r.id, r.name, r.position, r.display_position])).toEqual([
      [2, 'Crew', 2, null],
      [1, 'r1', 1, null],
    ])
    expect(merged.roles_version).toBe(4)
  })
})

describe('what a name looks like', () => {
  test('the color and icon of the first roles in display order that give them', () => {
    const roles = [
      role(1, 3, { color_names: false, icon: shield }),
      role(2, 2, { icon: 'text' }),
      role(3, 1, { display_position: 9, color: '#123456' }),
    ]
    const shown = hostedShown(roles)
    expect(lookOf(shown, [1, 2, 3])).toEqual({
      color: '#123456',
      icon: { emoji: shield, role: 'r1' },
    })
    expect(lookOf(shown, [1])).toEqual({ icon: { emoji: shield, role: 'r1' } })
    expect(lookOf(shown, [2])).toEqual({ color: '#000002' })
    expect(lookOf(shown, [])).toEqual({})
    expect(lookOf(shown, [7])).toEqual({})
  })

  test('an icon shows only when it is one emoji', () => {
    expect(roleIcon(shield)).toBe(shield)
    expect(roleIcon('text')).toBeNull()
    expect(roleIcon('')).toBeNull()
    expect(roleIcon(null)).toBeNull()
  })
})

describe('the groups of the member list', () => {
  const member = (username: string, online = true): Member =>
    ({ username, display_name: username.toUpperCase(), online, role_ids: [] }) as unknown as Member
  const page = (list: Member[], hasMore = false) => ({ list, hasMore, loading: false, q: '' })

  test('at most ten hoisted roles in display order form groups; a member shows in the first', () => {
    const roles = Array.from({ length: 14 }, (_, i) => role(i + 1, 20 - i, { hoist: i !== 2 }))
    const groups = serverGroups(roles)
    expect(groups.length).toBe(HOIST_GROUPS)
    expect(groups.map(g => g.id)).toEqual([1, 2, 4, 5, 6, 7, 8, 9, 10, 11])
    expect(groupOf(groups, [3, 11, 5])).toBe(5)
    expect(groupOf(groups, [3, 12])).toBeNull()
  })

  test('each group online first, then everyone else online and offline; unloaded groups load', () => {
    const groups = serverGroups([
      role(1, 3, { hoist: true, name: 'Admins' }),
      role(2, 2, { hoist: true, name: 'Mods' }),
      role(3, 1, { hoist: true, name: 'Empty' }),
      role(4, 0, { hoist: true, name: 'Later' }),
    ])
    const parts = groupParts(
      groups,
      {
        '1': page([member('zed', false), member('amy')]),
        '2': page([member('bob')], true),
        '3': page([]),
        rest: page([member('cat', false), member('dan'), member('amy')]),
      },
      m => m.display_name
    )
    expect(parts.map(p => (p.kind === 'member' ? p.m.username : `${p.kind}:${p.key}`))).toEqual([
      'head:g1',
      'amy',
      'zed',
      'head:g2',
      'bob',
      'more:more2:1',
      'head:g4',
      'more:more4:0',
      'head:hon',
      'dan',
      'head:hoff',
      'cat',
    ])
    expect(FIRST_GROUPS).toBe(3)
    expect(
      groupParts(groups, undefined, m => m.display_name).filter(p => p.kind === 'more')
    ).toHaveLength(5)
  })

  test('loaded group pages change with their members, and only where something changed', () => {
    const pages = {
      a: { '1': page([member('amy')]), rest: page([member('bob')]) },
      b: { rest: page([member('amy')]) },
    }
    const drop = (list: Member[]) =>
      list.some(m => m.username === 'amy') ? list.filter(m => m.username !== 'amy') : list
    const one = mapGroups(pages, 'a', drop)
    expect(one.a['1'].list).toEqual([])
    expect(one.a.rest).toBe(pages.a.rest)
    expect(one.b).toBe(pages.b)
    const all = mapGroups(pages, null, drop)
    expect(all.b.rest.list).toEqual([])
    expect(mapGroups(pages, null, list => list)).toBe(pages)
  })

  test('a member whose roles changed moves to the loaded page of the group they show in', () => {
    const m = (username: string, role_ids: number[] = []) => ({ ...member(username), role_ids })
    const groups = serverGroups([
      role(1, 3, { hoist: true }),
      role(2, 2, { hoist: true }),
      role(3, 1),
    ])
    const pages = {
      '1': page([m('amy', [1])]),
      '2': page([m('bob', [2])]),
      rest: page([m('cat')]),
    }
    const lists = (out: Record<string, { list: Member[] }>) =>
      Object.fromEntries(Object.entries(out).map(([k, p]) => [k, p.list.map(x => x.username)]))
    expect(lists(regroup(pages, groups, 'bob', m('bob', [1, 2])))).toEqual({
      '1': ['amy', 'bob'],
      '2': [],
      rest: ['cat'],
    })
    expect(lists(regroup(pages, groups, 'amy', m('amy', [3])))).toEqual({
      '1': [],
      '2': ['bob'],
      rest: ['cat', 'amy'],
    })
    const same = regroup(pages, groups, 'bob', m('bob', [2, 3]))
    expect(same['2'].list[0].role_ids).toEqual([2, 3])
    expect(same['1']).toBe(pages['1'])
    expect(regroup({ rest: pages.rest }, groups, 'cat', m('cat', [1]))).toEqual({ rest: page([]) })
    expect(regroup(pages, groups, 'zed', undefined)).toBe(pages)
  })

  test('online members first, each by name', () => {
    const list = [member('b', false), member('c'), member('a'), member('d', false)]
    expect(
      onlineFirst(
        list,
        m => m.online,
        m => m.username
      ).map(m => m.username)
    ).toEqual(['a', 'c', 'b', 'd'])
  })
})
