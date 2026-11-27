import { looksLikeEmoji } from './emoji'
import type { Role, ServerDetail } from './types'

// How roles show on hosted servers and P2P rooms alike: the order roles show in, the groups of
// the member list (the members of a role shown separately), and the role that colors a member's
// name or gives it an icon. The order and the groups are the shared rules' (`crates/perms`
// looks); this copy needs no loaded rules, so chat pages can ask it.

// Most roles the member list shows as groups of their own.
export const HOIST_GROUPS = 10

// A role as the member list shows it, from a list of roles highest rank first.
export interface Shown<Id> {
  id: Id
  name: string
  // Its display position, else its rank position.
  place: number
  // Its members show as a group of their own.
  hoist: boolean
  // The color it gives its members' names, or null.
  tint: string | null
  // The emoji shown after its members' names, or null.
  icon: string | null
}

// What a member's name looks like: its color and the icon after it, with the role it comes from.
export interface Look {
  color?: string
  icon?: { emoji: string; role: string }
}

// The display order of `ranked` (highest rank first): a higher place shows higher, and roles at
// one place keep their rank order.
export const displayOrder = <R extends { place: number }>(ranked: readonly R[]): R[] =>
  ranked
    .map((r, i) => ({ r, i }))
    .sort((a, b) => b.r.place - a.r.place || a.i - b.i)
    .map(({ r }) => r)

// The roles shown as groups, in display order: the first HOIST_GROUPS hoisted roles.
export const hoistGroups = <R extends { place: number; hoist: boolean }>(ranked: readonly R[]) =>
  displayOrder(ranked)
    .filter(r => r.hoist)
    .slice(0, HOIST_GROUPS)

// The first role of `shown` (in display order) among `held`, and that `has` says yes to.
const firstHeld = <Id, R extends { id: Id }>(
  shown: readonly R[],
  held: readonly Id[],
  has: (r: R) => boolean
) => (held.length ? shown.find(r => has(r) && held.includes(r.id)) : undefined)

// The look of a member holding `held`, from the roles in display order.
export const lookOf = <Id>(shown: readonly Shown<Id>[], held: readonly Id[]): Look => {
  const tint = firstHeld(shown, held, r => r.tint !== null)
  const icon = firstHeld(shown, held, r => r.icon !== null)
  return {
    ...(tint ? { color: tint.tint! } : {}),
    ...(icon ? { icon: { emoji: icon.icon!, role: icon.name } } : {}),
  }
}

// The group a member holding `held` shows in: the first group role they hold, else null.
export const groupOf = <Id>(groups: readonly { id: Id }[], held: readonly Id[]): Id | null =>
  firstHeld(groups, held, () => true)?.id ?? null

// Members of one part of the member list: online ones first, each by name.
export const onlineFirst = <M>(
  list: readonly M[],
  online: (m: M) => boolean,
  name: (m: M) => string
): M[] =>
  [...list].sort((a, b) => Number(online(b)) - Number(online(a)) || name(a).localeCompare(name(b)))

// A role's icon as it shows: one emoji, else none.
export const roleIcon = (text: string | null | undefined) =>
  typeof text === 'string' && looksLikeEmoji(text) ? text : null

const byRank = (a: Role, b: Role) => (b.position ?? 0) - (a.position ?? 0) || a.id - b.id

const hostedMemo = new WeakMap<readonly Role[], Shown<number>[]>()

// A hosted server's roles in display order.
export const hostedShown = (roles: readonly Role[] | undefined): Shown<number>[] => {
  if (!roles) return []
  const known = hostedMemo.get(roles)
  if (known) return known
  const shown = displayOrder(
    [...roles].sort(byRank).map(r => ({
      id: r.id,
      name: r.name,
      place: r.display_position ?? r.position ?? 0,
      hoist: r.hoist === true,
      tint: r.color_names === false ? null : r.color,
      icon: roleIcon(r.icon),
    }))
  )
  hostedMemo.set(roles, shown)
  return shown
}

// A P2P role as the room's view has it, highest rank first.
export interface P2pShownRole {
  id: string
  name: string
  pos: number
  dpos: number | null
  hoist: boolean
  tint: boolean
  color: number | null
  icon: string | null
}

const hex = (c: number | null) => (c === null ? null : `#${c.toString(16).padStart(6, '0')}`)

const p2pMemo = new WeakMap<readonly P2pShownRole[], Shown<string>[]>()

// A P2P room's roles (highest rank first) in display order.
export const p2pShown = (roles: readonly P2pShownRole[]): Shown<string>[] => {
  const known = p2pMemo.get(roles)
  if (known) return known
  const shown = displayOrder(
    roles.map(r => ({
      id: r.id,
      name: r.name,
      place: r.dpos ?? r.pos,
      hoist: r.hoist,
      tint: r.tint ? hex(r.color) : null,
      icon: roleIcon(r.icon),
    }))
  )
  p2pMemo.set(roles, shown)
  return shown
}

// A server's roles placed as a new order announces them: `order` lists every role id, the
// highest first, and `display` the display position of each. Null when the roles differ.
export const placeRoles = (
  roles: readonly Role[],
  order: readonly number[],
  display: readonly (number | null)[]
): Role[] | null => {
  const byId = new Map(roles.map(r => [r.id, r]))
  if (
    order.length !== roles.length ||
    display.length !== order.length ||
    new Set(order).size !== order.length ||
    order.some(id => !byId.has(id))
  )
    return null
  return order.map((id, i) => ({
    ...byId.get(id)!,
    position: order.length - i,
    display_position: display[i],
  }))
}

// `roles` with `role` in place of the role with its id. It keeps the places it has in the role
// order and the display order: only a reorder moves a role, and reorders carry a version.
export const withRole = (roles: readonly Role[], role: Role): Role[] =>
  roles.map(r =>
    r.id === role.id ? { ...role, position: r.position, display_position: r.display_position } : r
  )

// A role order a server announced: every role id, the highest first, the display position of
// each, and the `roles_version` it is.
export interface RolePlaces {
  order: readonly number[]
  display: readonly (number | null)[]
  version: number
}

// A server detail with the role updates and the newest role order that arrived while it loaded.
export const withRoleEvents = (
  detail: ServerDetail,
  updates: ReadonlyMap<number, Role>,
  places: RolePlaces | null
): ServerDetail => {
  let roles: Role[] = detail.roles
  for (const role of updates.values()) roles = withRole(roles, role)
  if (places && places.version > (detail.roles_version ?? -1)) {
    const placed = placeRoles(roles, places.order, places.display)
    if (placed) return { ...detail, roles: placed, roles_version: places.version }
  }
  return roles === detail.roles ? detail : { ...detail, roles }
}
