import { describe, expect, test } from 'bun:test'
import {
  STAFF,
  droppedOrder,
  memberRank,
  outranks,
  outranksKnown,
  roleRank,
  stepRole,
} from '../hierarchy'
import {
  canChangeRole,
  canModerate,
  canSetRoleBits,
  movableRoles,
  roleEditBlock,
  ROLE_NOT_BELOW,
} from '../rules'
import { mayModerate, reorder, outranks as shared, type Rank } from '../perms'
import { ALL_PERMS, Perm } from '../types'
import { loadPerms } from './helpers/perms'

const roles = [
  { id: 1, position: 3 },
  { id: 2, position: 2 },
  { id: 3, position: 2 },
  { id: 4, position: 1 },
]
const member = (role_ids: number[]) => ({ is_admin: false, perms: 0n, role_ids })
const admin = (perms: bigint) => ({ is_admin: true, perms, role_ids: [4] })

describe('ranks on hosted servers', () => {
  test('a member ranks by the highest role held, an admin by its permissions', () => {
    expect(memberRank(null, roles)).toEqual({ tier: 'outside' })
    expect(memberRank(member([]), roles)).toEqual({ tier: 'plain' })
    expect(memberRank(member([4, 2]), roles)).toEqual({ tier: 'role', pos: 2, tie: -2 })
    expect(memberRank(member([3, 2]), roles)).toEqual({ tier: 'role', pos: 2, tie: -2 })
    expect(memberRank(member([9]), roles)).toEqual({ tier: 'plain' })
    expect(memberRank(admin(0n), roles)).toEqual({ tier: 'owner' })
    expect(memberRank(admin(Perm.Kick), roles)).toEqual({ tier: 'admin', adminMask: Perm.Kick })
    expect(roleRank({ id: 7 })).toEqual({ tier: 'role', pos: 0, tie: -7 })
  })

  test('the order is the one the shared rules decide', async () => {
    await loadPerms()
    const masks = [Perm.Kick, Perm.Kick + Perm.DeleteMessages, Perm.ManageChannels, ALL_PERMS]
    const ranks: Rank[] = [
      { tier: 'outside' },
      { tier: 'plain' },
      { tier: 'owner' },
      STAFF,
      ...masks.map((adminMask): Rank => ({ tier: 'admin', adminMask })),
      ...[0, 1, 2].flatMap(pos => [-1, -2, -9].map((tie): Rank => ({ tier: 'role', pos, tie }))),
    ]
    for (const a of ranks)
      for (const b of ranks) expect([a, b, outranks(a, b)]).toEqual([a, b, shared(a, b)])
    for (const a of ranks)
      for (const b of ranks)
        expect(canModerate(Perm.Kick, false, 0n, { mine: a, theirs: b })).toBe(
          mayModerate({ rank: a, bits: Perm.Kick }, { rank: b, bits: 0n }, Perm.Kick, false)
        )
  })

  test('someone whose roles are not loaded is left to the server', () => {
    const mine = memberRank(member([2]), roles)
    expect(outranksKnown(undefined, member([1]), roles)).toBe(true)
    expect(outranksKnown(mine, undefined, roles)).toBe(true)
    expect(outranksKnown(mine, member([4]), roles)).toBe(true)
    expect(outranksKnown(mine, member([3]), roles)).toBe(true)
    expect(outranksKnown(mine, member([2]), roles)).toBe(false)
    expect(outranksKnown(mine, member([1]), roles)).toBe(false)
    expect(outranksKnown(mine, admin(Perm.Kick), roles)).toBe(false)
    expect(outranksKnown(STAFF, admin(0n), roles)).toBe(true)
  })
})

describe('moderation and roles by rank', () => {
  const mine = memberRank(member([2]), roles)
  const below = { mine, theirs: memberRank(member([4]), roles) }
  const above = { mine, theirs: memberRank(member([1]), roles) }

  test('rank decides once the order is confirmed, permissions before', () => {
    expect(canModerate(Perm.Kick, false, Perm.Kick + Perm.DeleteMessages, below)).toBe(true)
    expect(canModerate(ALL_PERMS, false, 0n, above)).toBe(false)
    expect(canModerate(Perm.Kick, false, Perm.Kick + Perm.DeleteMessages)).toBe(false)
    expect(canModerate(Perm.Kick + Perm.DeleteMessages, false, Perm.Kick)).toBe(true)
    expect(canModerate(0n, true, ALL_PERMS, above)).toBe(true)
  })

  test('a role is given or taken only when it ranks below you', () => {
    const give = (roleBelow: boolean) =>
      canChangeRole(Perm.AssignRoles, false, 0n, false, false, 0n, false, { below: roleBelow })
    expect(give(true)).toBe(true)
    expect(give(false)).toBe(false)
    const take = (roleBelow: boolean, self: boolean, order = below) =>
      canChangeRole(Perm.AssignRoles, false, 0n, true, self, 0n, false, { below: roleBelow, order })
    expect(take(true, false)).toBe(true)
    expect(take(false, false)).toBe(false)
    expect(take(false, true)).toBe(true)
    expect(take(true, false, above)).toBe(false)
    expect(canChangeRole(0n, true, ALL_PERMS, false, false, 0n, true, { below: false })).toBe(true)
  })

  test('a confirmed order asks only for the permissions a role gains', () => {
    const wide = Perm.DeleteServer + Perm.Kick
    expect(canSetRoleBits(Perm.Kick, wide, wide - Perm.Kick, true)).toBe(true)
    expect(canSetRoleBits(Perm.Kick, Perm.DeleteServer, wide, true)).toBe(true)
    expect(canSetRoleBits(Perm.Kick, Perm.Kick, Perm.Kick + Perm.ManageChannels, true)).toBe(false)
    expect(canSetRoleBits(Perm.Kick, wide, wide - Perm.Kick, false)).toBe(false)
    expect(canSetRoleBits(Perm.Kick, 0n, Perm.Kick, false)).toBe(true)
  })

  test('a role at or above your own is locked, with or without a confirmed order', () => {
    const role = (id: number) => ({
      id,
      perms: Perm.DeleteServer,
      position: roles[id - 1].position,
    })
    const limits = { held_above: [4], channel_grants: [], channel_denies: [] }
    expect(roleEditBlock(Perm.ManageRoles, false, role(1), undefined, mine, true)).toBe(
      ROLE_NOT_BELOW
    )
    expect(roleEditBlock(Perm.ManageRoles, false, role(2), undefined, mine, true)).toBe(
      ROLE_NOT_BELOW
    )
    expect(roleEditBlock(Perm.ManageRoles, false, role(3), undefined, mine, true)).toBeNull()
    expect(roleEditBlock(Perm.ManageRoles, false, role(3), undefined, mine, false)).toBe(
      "This role has permissions you don't have, so you can't change it."
    )
    expect(roleEditBlock(ALL_PERMS, false, role(4), limits, mine, false)).toBe(
      "Someone you can't moderate has this role, so you can't change it."
    )
    expect(roleEditBlock(ALL_PERMS, false, role(4), limits, undefined, true)).toBe(ROLE_NOT_BELOW)
    expect(roleEditBlock(0n, true, role(1), limits, mine, false)).toBeNull()
  })
})

describe('moving a role one step', () => {
  test('a role trades places with the next one you may move; the others stay', () => {
    const order = [1, 2, 3, 4, 5]
    expect(stepRole(order, [2, 3, 4, 5], 4, -1)).toEqual([1, 2, 4, 3, 5])
    expect(stepRole(order, [2, 3, 4, 5], 4, 1)).toEqual([1, 2, 3, 5, 4])
    expect(stepRole(order, [2, 4, 5], 4, -1)).toEqual([1, 4, 3, 2, 5])
    expect(stepRole(order, [2, 3, 4, 5], 2, -1)).toBeNull()
    expect(stepRole(order, [2, 3, 4, 5], 5, 1)).toBeNull()
    expect(stepRole(order, [2, 3, 5], 4, 1)).toBeNull()
    expect(stepRole(order, [4], 4, -1)).toBeNull()
  })

  test('every step keeps the roles you may not move where the server keeps them', async () => {
    await loadPerms()
    const order = [5, 4, 3, 2, 1]
    for (let set = 0; set < 32; set++) {
      const movable = order.filter((_, i) => (set & (1 << i)) !== 0)
      for (const id of order)
        for (const step of [-1, 1] as const) {
          const next = stepRole(order, movable, id, step)
          if (next)
            expect([movable, id, step, reorder(order, next, movable)]).toEqual([
              movable,
              id,
              step,
              next,
            ])
        }
    }
  })

  test('a dragged role lands among the roles you may move; the others stay', () => {
    const order = [1, 2, 3, 4, 5]
    expect(droppedOrder(order, [2, 3, 4, 5], 5, 0)).toEqual([1, 5, 2, 3, 4])
    expect(droppedOrder(order, [2, 4, 5], 2, 2)).toEqual([1, 4, 3, 5, 2])
    expect(droppedOrder(order, [2, 4, 5], 2, 0)).toBeNull()
    expect(droppedOrder(order, [2, 4], 1, 0)).toBeNull()
  })

  test('every drop keeps the roles you may not move where the server keeps them', async () => {
    await loadPerms()
    const order = [5, 4, 3, 2, 1]
    for (let set = 0; set < 32; set++) {
      const movable = order.filter((_, i) => (set & (1 << i)) !== 0)
      for (const id of movable)
        for (let index = 0; index < movable.length; index++) {
          const next = droppedOrder(order, movable, id, index)
          if (next) expect(reorder(order, next, movable)).toEqual(next)
        }
    }
  })

  test('you may move the roles you may change, and staff every role', () => {
    const list = roles.map(r => ({ ...r, perms: r.id === 3 ? Perm.DeleteServer : 0n }))
    const mine = memberRank(member([2]), roles)
    const limits = { held_above: [1, 2], channel_grants: [], channel_denies: [] }
    expect(movableRoles(list, Perm.ManageRoles, limits, mine, true)).toEqual([3, 4])
    expect(movableRoles(list, Perm.ManageRoles, limits, mine, false)).toEqual([4])
    expect(movableRoles(list, Perm.Kick, limits, mine, true)).toEqual([])
    expect(movableRoles(list, undefined)).toEqual([1, 2, 3, 4])
  })
})
