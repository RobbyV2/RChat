import type { GroupKind, GroupMention, GroupPing, Message, Role, Unread } from './types'
import type { PingCount, Pings } from './pings'

// Unread messages that ping you through `@everyone`, `@here` or one of your roles, per channel
// scope, newest first. The server stores one row per message, not one per member: a message
// counts here while it is newer than the channel's read position, so reading the channel (or
// "Mark as read") clears it without any extra request.
export interface GroupEntry {
  server: string | null
  items: GroupPing[]
}

export type GroupPings = Record<string, GroupEntry>

export const NO_GROUP_PINGS: GroupPings = {}

// Most remembered per scope (badges show 99+ well before this).
const SCOPE_MAX = 200

const ORDER: GroupKind[] = ['everyone', 'here', 'role']

export const sortKinds = (kinds: readonly GroupKind[]): GroupKind[] =>
  ORDER.filter(k => kinds.includes(k))

export const addGroupPing = (
  groups: GroupPings,
  scope: string,
  server: string | null,
  ping: GroupPing
): GroupPings => {
  const cur = groups[scope]
  if (!ping.kinds.length || cur?.items.some(i => i.message_id === ping.message_id)) return groups
  const items = [...(cur?.items ?? []), ping]
    .sort((a, b) => b.message_id - a.message_id)
    .slice(0, SCOPE_MAX)
  return { ...groups, [scope]: { server: cur?.server ?? server, items } }
}

// Server lists from GET /api/unreads win, except for scopes that changed locally while the
// request was in flight.
export const mergeGroupPings = (
  before: GroupPings,
  current: GroupPings,
  items: Unread[]
): GroupPings => {
  const out: GroupPings = {}
  for (const i of items)
    if (i.group_pings?.length && current[i.scope] === before[i.scope])
      out[i.scope] = { server: i.server, items: i.group_pings.slice(0, SCOPE_MAX) }
  for (const [scope, e] of Object.entries(current)) if (e !== before[scope]) out[scope] = e
  return out
}

export const forgetGroupPings = (
  groups: GroupPings,
  drop: (scope: string, server: string | null) => boolean
): GroupPings => {
  const kept = Object.entries(groups).filter(([scope, e]) => !drop(scope, e.server))
  return kept.length === Object.keys(groups).length ? groups : Object.fromEntries(kept)
}

export const dropGroupMessage = (groups: GroupPings, messageId: number): GroupPings => {
  for (const [scope, e] of Object.entries(groups))
    if (e.items.some(i => i.message_id === messageId)) {
      const items = e.items.filter(i => i.message_id !== messageId)
      const out = { ...groups }
      if (items.length) out[scope] = { ...e, items }
      else delete out[scope]
      return out
    }
  return groups
}

// Group mentions marked seen in the inbox (`group_pings_seen`): they stop counting.
export const seenGroupMessages = (
  groups: GroupPings,
  scope: string,
  ids: readonly number[]
): GroupPings => {
  const e = groups[scope]
  if (!e) return groups
  const gone = new Set(ids)
  const items = e.items.filter(i => !gone.has(i.message_id))
  if (items.length === e.items.length) return groups
  const out = { ...groups }
  if (items.length) out[scope] = { ...e, items }
  else delete out[scope]
  return out
}

// The badge entries (keyed `g<scope>`, never sent anywhere) for messages past the read position
// whose kinds still notify.
export const groupBadges = (
  groups: GroupPings,
  lastRead: (scope: string) => number,
  shown: (server: string | null, kinds: GroupKind[]) => boolean
): Pings => {
  const out: Pings = {}
  for (const [scope, e] of Object.entries(groups)) {
    const read = lastRead(scope)
    const n = e.items.filter(i => i.message_id > read && shown(e.server, i.kinds)).length
    if (n > 0) {
      const p: PingCount = { scope, server: e.server, bulk: n, bulkUntil: 0, ids: [] }
      out[`g${scope}`] = p
    }
  }
  return out
}

// Online for `@here`: signed in (so connected) and not appearing offline. Which server or page
// is open does not matter, the same rule as the server's presence.
export const onlineForHere = (me: { appear_offline: boolean } | null | undefined): boolean =>
  !!me && !me.appear_offline

export interface GroupSelf {
  username: string
  // a member of the message's server (guests and previewers are never pinged)
  member: boolean
  // shown as online anywhere on the site (not "appear offline")
  online: boolean
  // your roles there, when known
  roleIds: readonly number[] | null
}

// Which of a message's group mentions address you. Roles you hold count; with unknown roles
// (member info not loaded) role mentions are left out. Only top-level channel messages from
// someone else count, and forwarded copies never do.
export const groupKindsFor = (m: Message, self: GroupSelf): GroupKind[] => {
  const mentions = m.group_mentions ?? []
  if (
    !mentions.length ||
    !self.member ||
    m.author.username === self.username ||
    m.channel_id === null ||
    m.thread_root_id !== null ||
    m.forward
  )
    return []
  const kinds = new Set<GroupKind>()
  for (const g of mentions) {
    if (g.kind === 'everyone') kinds.add('everyone')
    else if (g.kind === 'here' && self.online) kinds.add('here')
    else if (g.kind === 'role' && g.role_id !== null && self.roleIds?.includes(g.role_id))
      kinds.add('role')
  }
  return sortKinds([...kinds])
}

// Whether a message highlights for you: `@everyone` and `@here` for every member, role mentions
// for holders of the role.
export const groupHighlights = (m: Message, self: GroupSelf): boolean =>
  groupKindsFor(m, { ...self, online: true }).length > 0

// Lowercase names a message's group mentions render as pills, mapped to their pill key
// (`everyone`, `here` or `r<role id>`). Roles that were deleted or are not loaded stay text.
export const groupNames = (
  mentions: readonly GroupMention[] | undefined,
  roles: readonly Role[] | undefined
): [string, string][] => {
  const out: [string, string][] = []
  for (const g of mentions ?? []) {
    if (g.kind !== 'role') out.push([g.kind, g.kind])
    else {
      const role = roles?.find(r => r.id === g.role_id)
      if (role) out.push([role.name.trim().toLowerCase(), `r${role.id}`])
    }
  }
  return out
}

export const groupAction = (kinds: readonly GroupKind[], role: string | null) => {
  if (kinds.includes('everyone')) return 'mentioned @everyone'
  if (kinds.includes('here')) return 'mentioned @here'
  return role ? `mentioned @${role}` : 'mentioned your role'
}
