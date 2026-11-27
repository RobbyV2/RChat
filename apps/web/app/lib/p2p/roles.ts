import { cmp, EVERYONE, P, type Rank } from './acl/rules'
import { actParts, roleMoveWarns } from './flows'
import { type MemberView, type RoleView, type ServerView } from './server'
import { LOCAL, type Local } from './limits'
import { reorder } from '../perms'
import { groupOf, hoistGroups, lookOf, onlineFirst, p2pShown, type Look } from '../role_looks'

// Roles and channel permissions of P2P servers as the settings and the member list show them:
// the permission toggles, where a dragged role lands, the member list grouped by
// top role, and the allow-list rows of a channel.

// Whether we may take role `r` from member `m`: ours we may always drop, others' with Manage roles
// above both; a role a channel's overwrites hold its holders back with only with Manage channels
// too (the instance rule).
export const mayTakeRole = (
  v: Pick<ServerView, 'me' | 'perms'>,
  m: Pick<MemberView, 'ik' | 'roles' | 'below'>,
  r: Pick<RoleView, 'id' | 'below' | 'held'>,
  me: string | null
) => {
  const can = (bit: number) => v.me === 'join' && (v.perms & bit) !== 0
  if (!m.roles.includes(r.id) || (r.held && !can(P.ManageChannels))) return false
  return m.ik === me || (can(P.ManageRoles) && r.below && m.below)
}

// Whether we may write an overwrite for `subj` (chperm: ranked above its subject). A
// member who left or a deleted role ranks below everyone: its rows can always be cleared.
export const mayWriteRow = (v: Pick<ServerView, 'rank' | 'roles' | 'members'>, subj: string) => {
  if (subj === `r:${EVERYONE}`) return v.rank[0] > -1
  if (subj.startsWith('r:')) return v.roles.find(r => `r:${r.id}` === subj)?.below ?? true
  return v.members.find(m => `u:${m.ik}` === subj)?.below ?? true
}

// The name of an overwrite's subject: @everyone, a role (through `mask`) or a member ("a member"
// in streamer mode).
export const subjectName = (
  v: Pick<ServerView, 'roles' | 'members'>,
  subj: string,
  mask: (text: string) => string = text => text,
  streamer = false
) =>
  subj === `r:${EVERYONE}`
    ? '@everyone'
    : subj.startsWith('r:')
      ? mask(v.roles.find(r => r.id === subj.slice(2))?.name ?? 'a role')
      : streamer
        ? 'a member'
        : (v.members.find(m => m.ik === subj.slice(2))?.name ?? 'someone')

export const PERM_ITEMS: { label: string; bit: number; hint?: string }[] = [
  { label: 'Manage channels', bit: P.ManageChannels },
  { label: 'Manage messages', bit: P.ManageMessages, hint: "Delete and pin others' messages" },
  { label: 'Kick', bit: P.Kick },
  { label: 'Ban', bit: P.Ban },
  {
    label: 'Manage server',
    bit: P.ManageServer,
    hint: 'Rename the server and change its settings',
  },
  {
    label: 'Manage roles',
    bit: P.ManageRoles,
    hint: 'Make, change and give roles below their own',
  },
  { label: 'Invite', bit: P.Invite, hint: 'Invite people and make invite codes' },
  { label: 'Mention everyone', bit: P.MentionEveryone, hint: 'Use @everyone' },
]

// @everyone also carries what every member may do in channels.
export const EVERYONE_ITEMS = [
  ...PERM_ITEMS,
  { label: 'View channels', bit: P.ViewChannel },
  { label: 'Send messages', bit: P.SendMessages },
]

export { ROLE_NOT_BELOW as ROLE_LOCKED } from '../rules'

// A line of the Re-apply list: the act, whom it is about and the role it names.
export const reapplyLine = (
  t: string,
  c: Record<string, unknown>,
  roles: readonly Pick<RoleView, 'id' | 'name'>[]
): { act: string; who?: string; role?: string } => {
  const { act, who } = actParts(t, typeof c.to === 'string' ? c.to : undefined)
  const ref = typeof c.role === 'string' ? c.role : null
  const off = t === 'role_bits' && c.on === false && EVERYONE_ITEMS.find(x => x.bit === c.bit)
  const role =
    ref === null ? null : ref === EVERYONE ? '@everyone' : roles.find(r => r.id === ref)?.name
  return {
    act: off ? `Turn off ${off.label}` : act,
    ...(who ? { who } : {}),
    ...(role ? { role } : ref !== null ? { role: 'Deleted role' } : {}),
  }
}

// A role's rank.
const rankOf = (r: Pick<RoleView, 'id' | 'pos'>): Rank => [r.pos, r.id]

export interface Move {
  role: string
  pos: number
}

// Where `id` lands when dropped at `index` of the list without it (highest first). The roles
// at or above our rank (`top`) keep their places and the ones below it fill the others in the
// order asked for, as the shared rules place them. The moves: a position strictly between its
// new neighbours, else the movable roles spaced out again, in the new order. Every role we move
// stays strictly below `top`. New gaps are `server.roleStep`.
export function placeRole(
  roles: RoleView[],
  id: string,
  index: number,
  top: Rank,
  lim: Pick<Local['server'], 'roleStep'> = LOCAL.server
): Move[] {
  const gap = lim.roleStep
  const self = roles.find(r => r.id === id)
  if (!self || cmp(top, rankOf(self)) <= 0) return []
  const rest = roles.filter(r => r.id !== id)
  const at = new Map(roles.map((r, i) => [r.id, i]))
  const slots = (list: RoleView[]) => list.map(r => at.get(r.id)!)
  const order = reorder(
    slots(roles),
    slots([...rest.slice(0, index), self, ...rest.slice(index)]),
    slots(roles.filter(r => cmp(top, rankOf(r)) > 0))
  ).map(i => roles[i])
  if (order.every((r, i) => r === roles[i])) return []
  const place = order.indexOf(self)
  const above = order[place - 1]
  const below = order[place + 1]
  const cap = Number.isFinite(top[0]) ? top[0] : Infinity
  const hi = above ? Math.min(above.pos, cap) : cap === Infinity ? null : cap
  const lo = below ? below.pos : -1
  const pick =
    hi === null
      ? below
        ? below.pos + gap
        : gap * gap
      : !below && hi > gap
        ? hi - gap
        : Math.floor((hi + lo) / 2)
  if (pick > lo && (hi === null || pick < hi) && pick >= 0)
    return pick === self.pos ? [] : [{ role: id, pos: pick }]
  // No room: the roles below us, in the new order, spaced out under our rank.
  const movable = order.filter(r => cmp(top, rankOf(r)) > 0)
  const room = cap === Infinity ? gap * (movable.length + 1) : cap
  const step = Math.floor(room / (movable.length + 1))
  if (step < 1) return []
  const moves = movable.flatMap((r, i) => {
    const pos = step * (movable.length - i)
    return pos === r.pos ? [] : [{ role: r.id, pos, from: r.pos }]
  })
  // Posted one at a time, each a change in force at once (a move down cuts at once): moves down
  // lowest first, then moves up highest first, so no two other roles swap on the way.
  const down = moves.filter(m => m.pos < m.from).sort((x, y) => x.pos - y.pos)
  const up = moves.filter(m => m.pos > m.from).sort((x, y) => y.pos - x.pos)
  return [...down, ...up].map(({ role, pos }) => ({ role, pos }))
}

// Whether moves lower a role someone holds: ask first.
export const movesWarn = (roles: RoleView[], moves: Move[]) =>
  moves.some(m => {
    const r = roles.find(x => x.id === m.role)
    return !!r && r.holders > 0 && roleMoveWarns(r.pos, m.pos)
  })

export interface MemberGroup {
  key: string
  label: string
  color: number | null
  list: MemberView[]
}

// The member list: the members of each role shown separately (display order, online first),
// then the rest online and offline, then the invited; each by name.
export function memberGroups(members: MemberView[], roles: RoleView[], me: string | null) {
  const byName = (a: MemberView, b: MemberView) => a.name.localeCompare(b.name)
  const on = (m: MemberView) => m.online || m.ik === me
  const joined = members.filter(m => m.m === 'join')
  const shown = hoistGroups(p2pShown(roles))
  const groups: MemberGroup[] = []
  for (const g of shown) {
    const list = joined.filter(m => groupOf(shown, m.roles) === g.id)
    const color = roles.find(r => r.id === g.id)?.color ?? null
    if (list.length)
      groups.push({
        key: `r:${g.id}`,
        label: g.name,
        color,
        list: onlineFirst(list, on, m => m.name),
      })
  }
  const rest = joined.filter(m => groupOf(shown, m.roles) === null)
  const tail: [string, string, MemberView[]][] = [
    ['online', 'Online', rest.filter(on)],
    ['offline', 'Offline', rest.filter(m => !on(m))],
    ['invited', 'Invited', members.filter(m => m.m === 'invite')],
  ]
  for (const [key, label, list] of tail)
    if (list.length) groups.push({ key, label, color: null, list: list.sort(byName) })
  return groups
}

// What a member's name looks like: the color and icon of their first roles in display order
// that give them.
export const lookOfMember = (m: Pick<MemberView, 'roles'>, roles: RoleView[]): Look =>
  lookOf(p2pShown(roles), m.roles)

export const nameColor = (m: Pick<MemberView, 'roles'>, roles: RoleView[]) =>
  lookOfMember(m, roles).color

// What each member's name looks like in a server, by identity key; role names through `mask`.
export const memberLooks = (
  v: Pick<ServerView, 'members' | 'roles'>,
  mask: (text: string) => string
) => {
  const held = new Map(v.members.map(m => [m.ik, m.roles]))
  return (ik: string): Look => {
    const look = lookOf(p2pShown(v.roles), held.get(ik) ?? [])
    return look.icon ? { ...look, icon: { ...look.icon, role: mask(look.icon.role) } } : look
  }
}

export interface DisplayMove {
  role: string
  dpos: number | null
}

// The roles in display order, the one shown highest first.
export const shownOrder = (roles: RoleView[]) => p2pShown(roles).map(r => r.id)

// The display positions that show `roles` (highest rank first) in `order` (ids, the one shown
// highest first), for the roles `movable` allows; the others keep theirs. Each run of movable
// roles between two others keeps its positions when they already fit, else is spaced out evenly
// between them (`gap` apart above the highest). null when there is no room.
export function displayMoves(
  roles: RoleView[],
  order: readonly string[],
  movable: (r: RoleView) => boolean,
  gap: number
): DisplayMove[] | null {
  const byId = new Map(roles.map(r => [r.id, r]))
  const place = (r: RoleView) => r.dpos ?? r.pos
  const moves: DisplayMove[] = []
  let run: RoleView[] = []
  let hi = Infinity
  const fits = (lo: number) =>
    run.every((r, i) => place(r) < (i ? place(run[i - 1]) : hi) && place(r) > lo)
  const flush = (lo: number) => {
    if (run.length && !fits(lo)) {
      const n = run.length
      const base = lo === -Infinity ? Math.min(0, hi === Infinity ? 0 : hi - gap * (n + 1)) : lo
      const step = hi === Infinity ? gap : Math.floor((hi - base) / (n + 1))
      if (step < 1) return false
      run.forEach((r, i) => {
        const at = hi === Infinity ? base + step * (n - i) : hi - step * (i + 1)
        if (at !== place(r) || r.dpos === null) moves.push({ role: r.id, dpos: at })
      })
    }
    run = []
    return true
  }
  for (const id of order) {
    const r = byId.get(id)
    if (!r) return null
    if (movable(r)) {
      run.push(r)
      continue
    }
    if (!flush(place(r))) return null
    hi = place(r)
  }
  return flush(-Infinity) ? moves : null
}

// Whether the open channel's slow mode, or our exemption from it, changed (the countdown follows).
export const slowChanged = (
  was: { slow?: number; exempt: boolean } | undefined,
  is: { slow?: number; exempt: boolean } | undefined
) => (was?.slow ?? 0) !== (is?.slow ?? 0) || (was?.exempt ?? false) !== (is?.exempt ?? false)

export const hex = (c: number | null) =>
  c === null ? undefined : `#${c.toString(16).padStart(6, '0')}`

export const fromHex = (h: string): number | null => {
  const m = /^#([0-9a-f]{6})$/i.exec(h)
  return m ? parseInt(m[1], 16) : null
}
