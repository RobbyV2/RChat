// Friends: the paged lists, pending requests, privacy settings and the command text the
// palette and the add box share. The server owns everything; these helpers only keep the
// loaded pages in order as events arrive.

import type { Friend, FriendRequest, UserRef } from './types'

export const FRIENDS_SCOPE = 'friends'

// Most names one "add friends" command sends at once.
export const ADD_MAX = 10

export type FriendsTab = 'online' | 'all' | 'pending' | 'add'

export const FRIEND_TABS: { tab: FriendsTab; label: string }[] = [
  { tab: 'online', label: 'Online' },
  { tab: 'all', label: 'All' },
  { tab: 'pending', label: 'Pending' },
  { tab: 'add', label: 'Add friend' },
]

export type Relation = 'none' | 'friend' | 'incoming' | 'outgoing'

export type RequestStatus = 'sent' | 'accepted' | 'friends'

export type SendResult =
  { ok: true; status: RequestStatus; user: UserRef } | { ok: false; error: string }

export const DM_POLICIES = [
  { value: 'everyone', label: 'Everyone' },
  { value: 'friends', label: 'Friends only' },
] as const

export const REQUEST_POLICIES = [
  { value: 'everyone', label: 'Everyone' },
  { value: 'servers', label: 'People in shared servers' },
  { value: 'nobody', label: 'Nobody' },
] as const

export type DmPolicy = (typeof DM_POLICIES)[number]['value']
export type RequestPolicy = (typeof REQUEST_POLICIES)[number]['value']

export interface Privacy {
  dms: DmPolicy
  friend_requests: RequestPolicy
}

export const DEFAULT_PRIVACY: Privacy = { dms: 'everyone', friend_requests: 'everyone' }

export const parsePrivacy = (raw: unknown): Privacy => {
  const r = (raw ?? {}) as Partial<Record<keyof Privacy, unknown>>
  const dms = DM_POLICIES.find(p => p.value === r.dms)?.value ?? DEFAULT_PRIVACY.dms
  const friend_requests =
    REQUEST_POLICIES.find(p => p.value === r.friend_requests)?.value ??
    DEFAULT_PRIVACY.friend_requests
  return { dms, friend_requests }
}

const NAME = /^[^\s@,]{1,64}$/

// "alice, @Bob carol" -> ["alice", "bob", "carol"]: lowercase, deduplicated, in order, at most
// `ADD_MAX`. Tokens that can't be usernames are dropped.
export const parseNames = (text: string, max = ADD_MAX): string[] => {
  const out: string[] = []
  for (const raw of text.split(/[\s,]+/)) {
    const name = raw.replace(/^@+/, '').toLowerCase()
    if (!NAME.test(name) || out.includes(name)) continue
    out.push(name)
    if (out.length === max) break
  }
  return out
}

// The palette command: "add friend alice" or "add friends alice bob carol" (also "friend
// alice"). Returns the names, or null when the text is not this command.
export const parseAddCommand = (text: string): string[] | null => {
  const m = /^\s*(?:add\s+)?friends?\s+(.+)$/i.exec(text)
  if (!m) return null
  const names = parseNames(m[1])
  return names.length ? names : null
}

export const matchesFriendQuery = (u: UserRef, q: string) => {
  const t = q.trim().toLowerCase()
  return !t || u.username.toLowerCase().startsWith(t) || u.display_name.toLowerCase().startsWith(t)
}

// Server order: display name (case-insensitive), then username.
export const friendOrder = (a: UserRef, b: UserRef) => {
  const x = a.display_name.toLowerCase()
  const y = b.display_name.toLowerCase()
  if (x !== y) return x < y ? -1 : 1
  return a.username < b.username ? -1 : a.username > b.username ? 1 : 0
}

// Puts `f` into a loaded, sorted page. When more pages follow, an item past the last loaded one
// is left for the page that will bring it.
export const placeFriend = (list: Friend[], f: Friend, hasMore: boolean): Friend[] => {
  const rest = list.filter(x => x.user.username !== f.user.username)
  const at = rest.findIndex(x => friendOrder(f.user, x.user) < 0)
  if (at === -1) return hasMore ? rest : [...rest, f]
  return [...rest.slice(0, at), f, ...rest.slice(at)]
}

export const withoutUser = <T extends { user: UserRef }>(list: T[], username: string): T[] =>
  list.some(x => x.user.username === username)
    ? list.filter(x => x.user.username !== username)
    : list

export const setOnline = (list: Friend[], username: string, online: boolean): Friend[] =>
  list.some(x => x.user.username === username && x.online !== online)
    ? list.map(x => (x.user.username === username ? { ...x, online } : x))
    : list

// A new request goes first (newest first), once.
export const addRequest = (list: FriendRequest[], r: FriendRequest): FriendRequest[] => [
  r,
  ...withoutUser(list, r.user.username),
]

export const sendLabel = (status: RequestStatus) =>
  status === 'accepted'
    ? 'Now friends with'
    : status === 'friends'
      ? 'Already friends with'
      : 'Friend request sent to'

export const relationLabel = (r: Relation) =>
  r === 'friend'
    ? 'Already friends'
    : r === 'incoming'
      ? 'Sent you a request'
      : r === 'outgoing'
        ? 'Request pending'
        : null
