import { describe, expect, test } from 'bun:test'
import { EVERYONE, P } from '../p2p/acl/rules'
import {
  reapplyLine,
  ALLOW_BOTH,
  fromHex,
  mayTakeRole,
  mayWriteRow,
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
import { serverPings, serverUnread } from '../p2p/alerts'
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
  held: false,
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

  test('a respace posted one move at a time never swaps two other roles on the way', () => {
    // Owners: every role from the top range down to small positions, the dragged one in a gap.
    const roles = [
      role('a', 1_000_005),
      role('b', 1_000_004),
      role('c', 1_000_003),
      role('d', 1_000_002),
      role('e', 1_000_001),
    ]
    const moves = placeRole(roles, 'e', 1, OWNER)
    expect(moves.length).toBeGreaterThan(1)
    expect(apply(roles, moves).join('')).toBe('aebcd')
    const others = (list: RoleView[]) =>
      apply(list, [])
        .filter(id => id !== 'e')
        .join('')
    for (let n = 1; n <= moves.length; n += 1) {
      const now = roles.map(r => ({
        ...r,
        pos: moves.slice(0, n).find(m => m.role === r.id)?.pos ?? r.pos,
      }))
      expect(others(now)).toBe('abcd')
    }
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

  test('pings and unread of channels that no longer show (deleted, or not viewable), or of a server we are out of, do not count', () => {
    const v = {
      id: 'srv',
      me: 'join',
      chans: { a: { pings: 2, unread: 0 }, gone: { pings: 5, unread: 3 } },
      channels: [{ id: 'a' }],
    }
    expect(serverPings(v, EMPTY_NOTIFY)).toBe(2)
    expect(serverUnread(v, EMPTY_NOTIFY)).toBe(false)
    expect(serverUnread({ ...v, chans: { a: { pings: 0, unread: 1 } } }, EMPTY_NOTIFY)).toBe(true)
    for (const me of ['leave', 'ban', null]) {
      expect(serverPings({ ...v, me }, EMPTY_NOTIFY)).toBe(0)
      expect(serverUnread({ ...v, me, chans: { a: { pings: 1, unread: 1 } } }, EMPTY_NOTIFY)).toBe(
        false
      )
    }
  })
})

describe('taking roles in the UI (spec 1.4)', () => {
  test('a role a channel holds its holders back with comes off only with Manage channels', () => {
    const v = { me: 'join' as const, perms: 0 }
    const mine = { ik: 'me', roles: ['muted', 'fun'], below: false }
    const muted = { ...role('muted', 1), held: true }
    const fun = role('fun', 2)
    expect(mayTakeRole(v, mine, fun, 'me')).toBe(true)
    expect(mayTakeRole(v, mine, muted, 'me')).toBe(false)
    expect(mayTakeRole({ ...v, perms: P.ManageChannels }, mine, muted, 'me')).toBe(true)
    // Someone else's: Manage roles above both, and Manage channels for a held one.
    const theirs = { ik: 'x', roles: ['muted'], below: true }
    expect(mayTakeRole({ ...v, perms: P.ManageRoles }, theirs, muted, 'me')).toBe(false)
    expect(
      mayTakeRole({ ...v, perms: P.ManageRoles | P.ManageChannels }, theirs, muted, 'me')
    ).toBe(true)
  })
})

describe('allow-list rows (spec 1.4 chperm)', () => {
  test('rows of a member who left or a deleted role can be cleared; others need rank above them', () => {
    const v = {
      rank: [5, 'r'] as Rank,
      roles: [{ ...role('high', 9), below: false }, role('low', 1)],
      members: [member('peer', { below: false }), member('junior')],
    }
    expect(mayWriteRow(v, 'r:high')).toBe(false)
    expect(mayWriteRow(v, 'r:low')).toBe(true)
    expect(mayWriteRow(v, 'r:gone')).toBe(true)
    expect(mayWriteRow(v, 'u:peer')).toBe(false)
    expect(mayWriteRow(v, 'u:junior')).toBe(true)
    expect(mayWriteRow(v, 'u:departed')).toBe(true)
  })
})

describe('the Re-apply list', () => {
  const roles = [{ id: 'r1', name: 'Helper' }]
  test('each line names the role it acts on', () => {
    expect(reapplyLine('revoke', { to: 'bob', role: 'r1' }, roles)).toEqual({
      act: 'Take a role from',
      who: 'bob',
      role: 'Helper',
    })
    expect(
      reapplyLine('role_bits', { role: EVERYONE, bit: P.SendMessages, on: false }, roles)
    ).toEqual({
      act: 'Turn off Send messages',
      role: '@everyone',
    })
    expect(reapplyLine('role_del', { role: 'r1' }, roles)).toEqual({
      act: 'Delete a role',
      role: 'Helper',
    })
    expect(reapplyLine('role_bits', { role: 'gone', bit: 1, on: false }, roles).role).toBe(
      'Deleted role'
    )
    expect(reapplyLine('kick', { to: 'bob' }, roles)).toEqual({ act: 'Kick', who: 'bob' })
  })
})
