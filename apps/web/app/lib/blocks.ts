// Blocked users: the account's own list. Their messages collapse into "N blocked messages" rows,
// their typing is hidden, and the server drops their DMs, calls and pings.

import type { BlockedUser, Message } from './types'
import type { TypingMap } from './typing'

export type Blocked = Record<string, true>

export const blockedSet = (names: string[]): Blocked =>
  Object.fromEntries(names.map(n => [n, true] as const))

// A run of consecutive messages by blocked users. Only user messages (and forwards) collapse;
// call logs, pins and join notices stay as they are.
export interface BlockedRun {
  start: number
  ids: number[]
}

export const collapsible = (m: Message, blocked: Blocked) =>
  m.kind === 'user' && blocked[m.author.username] === true

// Index of each collapsible message -> its run.
export const blockedRuns = (messages: Message[], blocked: Blocked): Map<number, BlockedRun> => {
  const out = new Map<number, BlockedRun>()
  let run: BlockedRun | null = null
  messages.forEach((m, i) => {
    if (!collapsible(m, blocked)) {
      run = null
      return
    }
    if (!run) run = { start: i, ids: [] }
    run.ids.push(m.id)
    out.set(i, run)
  })
  return out
}

export const blockedLabel = (n: number) => `${n} blocked ${n === 1 ? 'message' : 'messages'}`

export const withoutTypers = (map: TypingMap, blocked: Blocked): TypingMap => {
  let changed = false
  const out: TypingMap = {}
  for (const [scope, here] of Object.entries(map)) {
    const kept = Object.entries(here).filter(([u]) => !blocked[u])
    if (kept.length !== Object.keys(here).length) changed = true
    if (kept.length) out[scope] = Object.fromEntries(kept)
  }
  return changed ? out : map
}

// The blocked list as the settings page shows it: newest first, filtered by the search prefix.
export const matchesBlockQuery = (b: BlockedUser, q: string) => {
  const t = q.trim().toLowerCase()
  return (
    !t ||
    b.user.username.toLowerCase().startsWith(t) ||
    b.user.display_name.toLowerCase().startsWith(t)
  )
}
