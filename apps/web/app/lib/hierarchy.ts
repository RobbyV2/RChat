import { ALL_PERMS, type Member, type Role } from './types'
import { type Rank } from './perms'

// Ranks on hosted servers, as the shared permission rules order them: an admin with every
// permission is an owner, another admin ranks by its permission set, anyone else by the highest
// role held. This copy needs no loaded rules, so chat pages can ask it.

export type RankedMember = Pick<Member, 'is_admin' | 'perms' | 'role_ids'>
export type RankedRole = Pick<Role, 'id' | 'position'>

const TIERS = ['outside', 'plain', 'role', 'admin', 'owner', 'staff'] as const

export const STAFF: Rank = { tier: 'staff' }

// A role ranks by its position, and among roles at one position the older one first.
export const roleRank = (role: RankedRole): Rank => ({
  tier: 'role',
  pos: role.position ?? 0,
  tie: -role.id,
})

const above = (a: Rank, b: Rank) =>
  (a.pos ?? 0) !== (b.pos ?? 0)
    ? (a.pos ?? 0) > (b.pos ?? 0)
    : Number(a.tie ?? 0) > Number(b.tie ?? 0)

// A member's rank; `undefined` or `null` is someone who is not in the server.
export const memberRank = (member: RankedMember | null | undefined, roles: RankedRole[]): Rank => {
  if (!member) return { tier: 'outside' }
  if (member.is_admin)
    return member.perms === 0n
      ? { tier: 'owner' }
      : { tier: 'admin', adminMask: member.perms & ALL_PERMS }
  const held = roles.filter(r => member.role_ids.includes(r.id)).map(roleRank)
  return held.reduce<Rank>((top, r) => (top.tier === 'role' && !above(r, top) ? top : r), {
    tier: 'plain',
  })
}

// Whether a viewer at `rank` ranks above `them`, as far as is known: a viewer whose rank is not
// known, or someone whose roles are not loaded, leaves it to the server.
export const outranksKnown = (
  rank: Rank | undefined,
  them: RankedMember | null | undefined,
  roles: RankedRole[] | undefined
) => !rank || !them || outranks(rank, memberRank(them, roles ?? []))

// Whether `a` ranks strictly above `b`. Equal ranks never do; staff outrank everyone. Of two
// admins, the one whose permissions include all of the other's and more.
export const outranks = (a: Rank, b: Rank): boolean => {
  if (a.tier === 'staff') return true
  if (a.tier !== b.tier) return TIERS.indexOf(a.tier) > TIERS.indexOf(b.tier)
  if (a.tier === 'role') return above(a, b)
  if (a.tier !== 'admin') return false
  const [mine, theirs] = [a.adminMask ?? 0n, b.adminMask ?? 0n]
  return mine !== theirs && (theirs & ~mine) === 0n
}

// The role order (highest first) with `id` moved one step up (`step` -1) or down (1): it trades
// places with the next role of `movable` that way, and every other role keeps its place, as the
// server requires. null when it can't move that way.
export const stepRole = <Id>(
  order: readonly Id[],
  movable: readonly Id[],
  id: Id,
  step: -1 | 1
): Id[] | null => {
  const slots = order.flatMap((r, i) => (movable.includes(r) ? [i] : []))
  const at = slots.findIndex(i => order[i] === id)
  const to = slots[at + step]
  if (at < 0 || to === undefined) return null
  const next = [...order]
  next[slots[at]] = order[to]
  next[to] = id
  return next
}

// The role order with `id` dropped at `index` of the roles you may move (without it): the others
// keep their places.
export const droppedOrder = <Id>(
  order: readonly Id[],
  movable: readonly Id[],
  id: Id,
  index: number
): Id[] | null => {
  if (!movable.includes(id)) return null
  const rest = order.filter(r => r !== id && movable.includes(r))
  const moved = [...rest.slice(0, index), id, ...rest.slice(index)]
  const next = order.map(r => (movable.includes(r) ? moved.shift()! : r))
  return next.every((r, i) => r === order[i]) ? null : next
}
