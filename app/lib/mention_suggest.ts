import type { UserRef } from './types'

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
