import { cmp, EVERYONE, P, type Rank } from './acl/rules'
import type { OverSum } from './acl/summary'
import { actParts, roleMoveWarns } from './flows'
import { ROLE_STEP, type MemberView, type RoleView, type ServerView } from './server'

// Roles and channel permissions of P2P servers as the settings and the member list show them
// (spec 1.4, 1.6): the permission toggles, where a dragged role lands, the member list grouped by
// top role, and the allow-list rows of a channel.

// Whether we may take role `r` from member `m`: ours we may always drop, others' with Manage roles
// above both; a role a channel's overwrites hold its holders back with only with Manage channels
// too (spec 1.4: the instance rule).
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

// Whether we may write an overwrite for `subj` (spec 1.4 chperm: ranked above its subject). A
// member who left or a deleted role ranks below everyone: its rows can always be cleared.
export const mayWriteRow = (v: Pick<ServerView, 'rank' | 'roles' | 'members'>, subj: string) => {
  if (subj === `r:${EVERYONE}`) return v.rank[0] > -1
  if (subj.startsWith('r:')) return v.roles.find(r => `r:${r.id}` === subj)?.below ?? true
  return v.members.find(m => `u:${m.ik}` === subj)?.below ?? true
}

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

export const ROLE_LOCKED = 'Only someone with a higher role can change this role.'

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

// A role's rank (spec 1.6).
const rankOf = (r: Pick<RoleView, 'id' | 'pos'>): Rank => [r.pos, r.id]

export interface Move {
  role: string
  pos: number
}

// Where `id` lands when dropped at `index` of the list without it (highest first): a position
// strictly between its new neighbours, else the movable roles spaced out again, in the new order.
// `top`: our rank; every role we move stays strictly below it.
export function placeRole(roles: RoleView[], id: string, index: number, top: Rank): Move[] {
  const self = roles.find(r => r.id === id)
  if (!self) return []
  const rest = roles.filter(r => r.id !== id)
  const above = rest[index - 1]
  const below = rest[index]
  const cap = Number.isFinite(top[0]) ? top[0] : Infinity
  const hi = above ? Math.min(above.pos, cap) : cap === Infinity ? null : cap
  const lo = below ? below.pos : -1
  const pick =
    hi === null
      ? below
        ? below.pos + ROLE_STEP
        : ROLE_STEP * ROLE_STEP
      : !below && hi > ROLE_STEP
        ? hi - ROLE_STEP
        : Math.floor((hi + lo) / 2)
  if (pick > lo && (hi === null || pick < hi) && pick >= 0)
    return pick === self.pos ? [] : [{ role: id, pos: pick }]
  // No room: the roles below us, in the new order, spaced out under our rank.
  const order = [...rest.slice(0, index), self, ...rest.slice(index)]
  const movable = order.filter(r => cmp(top, rankOf(r)) > 0)
  const room = cap === Infinity ? ROLE_STEP * (movable.length + 1) : cap
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

// Whether moves lower a role someone holds (spec 8.2 role order): ask first.
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

// The member list: online members by their top role (highest first), then the rest online,
// offline and invited; each by name.
export function memberGroups(members: MemberView[], roles: RoleView[], me: string | null) {
  const byName = (a: MemberView, b: MemberView) => a.name.localeCompare(b.name)
  const on = (m: MemberView) => m.online || m.ik === me
  const joined = members.filter(m => m.m === 'join')
  const groups: MemberGroup[] = []
  for (const r of roles) {
    const list = joined.filter(m => on(m) && m.top === r.id).sort(byName)
    if (list.length) groups.push({ key: `r:${r.id}`, label: r.name, color: r.color, list })
  }
  const rest = joined.filter(m => on(m) && (m.top === null || !roles.some(r => r.id === m.top)))
  const tail: [string, string, MemberView[]][] = [
    ['online', 'Online', rest],
    ['offline', 'Offline', joined.filter(m => !on(m))],
    ['invited', 'Invited', members.filter(m => m.m === 'invite')],
  ]
  for (const [key, label, list] of tail)
    if (list.length) groups.push({ key, label, color: null, list: list.sort(byName) })
  return groups
}

// A member's name color: their top role's.
export const nameColor = (m: MemberView, roles: RoleView[]) =>
  m.top === null ? null : (roles.find(r => r.id === m.top)?.color ?? null)

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

// A channel overwrite as an allow-list row: may they view and send there.
export const overFlags = (o: OverSum) => ({
  view: (o.allow & P.ViewChannel) !== 0,
  send: (o.allow & P.SendMessages) !== 0,
})

// A row's flags as an overwrite: what's ticked is allowed, what isn't is denied.
export const overBits = (view: boolean, send: boolean): OverSum => ({
  allow: (view ? P.ViewChannel : 0) | (send ? P.SendMessages : 0),
  deny: (view ? 0 : P.ViewChannel) | (send ? 0 : P.SendMessages),
})

// A new row allows both.
export const ALLOW_BOTH = overBits(true, true)
