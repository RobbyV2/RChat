import { describe, expect, test } from 'bun:test'
import { P } from '../p2p/acl/rules'
import {
  ALLOW_BOTH,
  fromHex,
  hex,
  memberGroups,
  movesWarn,
  nameColor,
  overBits,
  overFlags,
  placeRole,
  slowChanged,
  type Move,
} from '../p2p/roles'
import { serverPings } from '../p2p/alerts'
import { EMPTY_NOTIFY } from '../notify'
import { newRolePos, ROLE_STEP, type MemberView, type RoleView } from '../p2p/server'
import type { Rank } from '../p2p/acl/rules'

const role = (id: string, pos: number, holders = 0, color: number | null = null): RoleView => ({
  id,
  name: id.toUpperCase(),
  color,
  pos,
  bits: 0,
  holders,
  below: true,
})
const member = (ik: string, over: Partial<MemberView> = {}): MemberView => ({
  ik,
  m: 'join',
  name: ik,
  owner: false,
  online: true,
  contact: false,
  below: true,
  waits: false,
  myInvite: false,
  unban: false,
  roles: [],
  top: null,
  ...over,
})
const OWNER: Rank = [Infinity, '']
// Applies moves and reads the order back, highest first (position, then id).
const apply = (roles: RoleView[], moves: Move[]) =>
  roles
    .map(r => ({ ...r, pos: moves.find(m => m.role === r.id)?.pos ?? r.pos }))
    .sort((a, b) => b.pos - a.pos || (a.id < b.id ? 1 : -1))
    .map(r => r.id)

describe('role positions (spec 1.6)', () => {
  test('a new role goes below the lowest, leaving room, and never onto a taken position', () => {
    expect(newRolePos([])).toBe(ROLE_STEP * ROLE_STEP)
    expect(newRolePos([5000, 3000])).toBe(3000 - ROLE_STEP)
    expect(newRolePos([600])).toBe(300)
    expect(newRolePos([1])).toBe(0)
    // The lowest role at 0: a gap, else (owners) above everything.
    expect(newRolePos([0, 1, 9])).toBe(5)
    expect(newRolePos([0, 1, 2])).toBe(2 + ROLE_STEP)
    // A moderator whose top role sits at 2: only below it; none left.
    expect(newRolePos([0, 2], 2)).toBe(1)
    expect(newRolePos([0, 1, 2], 2)).toBeNull()
    // Someone ranked ⊥ (Manage roles through @everyone): nothing is below them.
    expect(newRolePos([5000], -1)).toBeNull()
    expect(newRolePos([0, 9], -1)).toBeNull()
    expect(newRolePos([0, 1, 3, 50], 50)).toBe(2)
    expect(newRolePos([0, 1, 2, 50], 50)).toBe(26)
    for (const ps of [[0], [0, 1], [0, 0, 1], [0, 2, 3], [7, 0]]) {
      const p = newRolePos(ps)!
      expect(ps.includes(p)).toBe(false)
    }
  })

  test('a dropped role lands strictly between its new neighbours, one move', () => {
    const roles = [role('a', 3000), role('b', 2000), role('c', 1000)]
    for (const [id, index, want] of [
      ['c', 0, 'cab'],
      ['c', 1, 'acb'],
      ['a', 2, 'bca'],
      ['a', 1, 'bac'],
      ['b', 0, 'bac'],
    ] as const) {
      const moves = placeRole(roles, id, index, OWNER)
      expect(moves.length).toBe(1)
      expect(apply(roles, moves).join('')).toBe(want)
    }
    expect(placeRole(roles, 'b', 1, OWNER)).toEqual([])
  })

  test('without room the roles below us are spaced out again, in the new order, under our rank', () => {
    const roles = [role('top', 50), role('a', 3), role('b', 2), role('c', 1)]
    // Moving c between a and b: no integer between 3 and 2.
    const moves = placeRole(roles.slice(1), 'c', 1, OWNER)
    expect(apply(roles.slice(1), moves).join('')).toBe('acb')
    // A moderator whose top role is `top` (rank 50): every move stays below 50.
    const mod = placeRole(roles, 'c', 2, [50, 'top'])
    expect(apply(roles, mod).join(' ')).toBe('top a c b')
    expect(mod.every(m => m.pos < 50 && m.pos >= 0)).toBe(true)
    expect(mod.some(m => m.role === 'top')).toBe(false)
  })

  test('equal positions (ordered by id) have no room between them either', () => {
    const roles = [role('y', 10), role('x', 10), role('w', 5)]
    const moves = placeRole(roles, 'w', 1, OWNER)
    expect(apply(roles, moves).join('')).toBe('ywx')
  })

  test('moving a held role down asks first (spec 8.2 role order)', () => {
    const roles = [role('a', 3000, 2), role('b', 2000, 0)]
    expect(movesWarn(roles, placeRole(roles, 'a', 1, OWNER))).toBe(true)
    expect(movesWarn(roles, placeRole(roles, 'b', 0, OWNER))).toBe(false)
    expect(movesWarn([role('a', 3000), role('b', 2000)], [{ role: 'a', pos: 1 }])).toBe(false)
  })
})

describe('the member list (grouped by top role)', () => {
  test('online members by top role, highest first; then online, offline and invited', () => {
    const roles = [role('mod', 20, 2, 0xff0000), role('vip', 10, 1, null)]
    const ms = [
      member('zed', { top: 'mod', roles: ['mod'] }),
      member('amy', { top: 'mod', roles: ['mod', 'vip'] }),
      member('bob', { top: 'vip', roles: ['vip'] }),
      member('cat'),
      member('dan', { online: false, top: 'mod', roles: ['mod'] }),
      member('eve', { m: 'invite' }),
      member('me', { online: false }),
      member('old', { top: 'gone', roles: ['gone'] }),
    ]
    const g = memberGroups(ms, roles, 'me')
    expect(g.map(x => [x.label, x.list.map(m => m.ik)])).toEqual([
      ['MOD', ['amy', 'zed']],
      ['VIP', ['bob']],
      ['Online', ['cat', 'me', 'old']],
      ['Offline', ['dan']],
      ['Invited', ['eve']],
    ])
    expect(g[0].color).toBe(0xff0000)
    expect(nameColor(ms[0], roles)).toBe(0xff0000)
    expect(nameColor(ms[2], roles)).toBeNull()
    expect(nameColor(ms[3], roles)).toBeNull()
  })

  test('colors read and written as #rrggbb', () => {
    expect(hex(0x7c4dff)).toBe('#7c4dff')
    expect(hex(0x0000ff)).toBe('#0000ff')
    expect(hex(null)).toBeUndefined()
    expect(fromHex('#7C4DFF')).toBe(0x7c4dff)
    expect(fromHex('red')).toBeNull()
  })
})

describe('channel allow lists', () => {
  test('a row allows what is ticked and denies the rest', () => {
    expect(ALLOW_BOTH).toEqual({ allow: P.ViewChannel | P.SendMessages, deny: 0 })
    expect(overBits(true, false)).toEqual({ allow: P.ViewChannel, deny: P.SendMessages })
    expect(overBits(false, false)).toEqual({ allow: 0, deny: P.ViewChannel | P.SendMessages })
    for (const [v, s] of [
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ])
      expect(overFlags(overBits(v, s))).toEqual({ view: v, send: s })
  })
})

describe('slow mode and pings of the open server', () => {
  test('the countdown follows a change of slow mode or of our exemption', () => {
    expect(slowChanged({ slow: 30, exempt: false }, { slow: 30, exempt: false })).toBe(false)
    expect(slowChanged({ slow: 30, exempt: false }, { slow: 10, exempt: false })).toBe(true)
    expect(slowChanged({ slow: 30, exempt: false }, { exempt: false })).toBe(true)
    expect(slowChanged({ slow: 30, exempt: false }, { slow: 30, exempt: true })).toBe(true)
    expect(slowChanged(undefined, { exempt: false })).toBe(false)
  })

  test('pings of channels that no longer show (deleted, or not viewable) do not badge', () => {
    const v = {
      id: 'srv',
      chans: { a: { pings: 2 }, gone: { pings: 5 } },
      channels: [{ id: 'a' }],
    }
    expect(serverPings(v, EMPTY_NOTIFY)).toBe(2)
  })
})
