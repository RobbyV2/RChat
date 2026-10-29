import type { Role, UserRef } from './types'

const SUGGEST_MAX = 10
export const SUGGEST_DEBOUNCE = 150

// Characters an `@` query may contain: anything up to whitespace or another `@`.
export const MENTION_QUERY = /[^\s@]/u

export const matchesPerson = (u: UserRef, q: string) => {
  const needle = q.toLowerCase()
  return u.username.startsWith(needle) || u.display_name.toLowerCase().startsWith(needle)
}

// Mention suggestions: groups in order, no duplicate usernames, prefix match on username or
// display name, at most `max`. `skip` removes people (you, known non-members).
export const suggestPeople = (
  query: string,
  groups: readonly (readonly UserRef[])[],
  skip: (username: string) => boolean,
  max = SUGGEST_MAX
): UserRef[] => {
  const out: UserRef[] = []
  const seen = new Set<string>()
  for (const group of groups)
    for (const u of group) {
      if (seen.has(u.username) || skip(u.username) || !matchesPerson(u, query)) continue
      seen.add(u.username)
      out.push(u)
      if (out.length === max) return out
    }
  return out
}

// Newest distinct authors first.
export const recentAuthors = <T extends { author: UserRef }>(messages: readonly T[], max = 50) => {
  const out: UserRef[] = []
  const seen = new Set<string>()
  for (let i = messages.length - 1; i >= 0 && out.length < max; i -= 1) {
    const a = messages[i].author
    if (seen.has(a.username)) continue
    seen.add(a.username)
    out.push(a)
  }
  return out
}

export const suggestKey = (server: string, query: string) => `${server}\u0000${query.toLowerCase()}`

export const mentionText = (username: string) => `@${username}`

export interface GroupSuggestion {
  key: string
  // inserted as is
  label: string
  color: string | null
  hint: string
}

const GROUPS_MAX = 5

// `@everyone`, `@here` (with Mention everyone and roles) and the roles you may mention whose
// name starts with the query, at most 5.
export const groupSuggestions = (
  query: string,
  allowed: boolean,
  roles: readonly Role[]
): GroupSuggestion[] => {
  const q = query.toLowerCase()
  const out: GroupSuggestion[] = []
  if (allowed) {
    if ('everyone'.startsWith(q))
      out.push({
        key: 'everyone',
        label: '@everyone',
        color: null,
        hint: 'Everyone in this channel',
      })
    if ('here'.startsWith(q))
      out.push({ key: 'here', label: '@here', color: null, hint: 'Everyone online' })
  }
  for (const r of roles) {
    if (out.length >= GROUPS_MAX) break
    const name = r.name.trim()
    if ((allowed || r.mentionable) && name && name.toLowerCase().startsWith(q))
      out.push({ key: `r${r.id}`, label: `@${name}`, color: r.color, hint: 'Role' })
  }
  return out.slice(0, GROUPS_MAX)
}
