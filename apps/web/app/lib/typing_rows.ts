// Who a channel or DM row shows as typing. Pure.
import { shownTypers, type LookSource } from './server_profile'
import type { TypingMap } from './typing'

const NONE: string[] = []

export interface RowTypingSource extends LookSource {
  typingOn: boolean
  typing: TypingMap
  blocked: Record<string, unknown>
}

// The people typing in any of `scopes` of a hosted `server` (null for a DM), once each, under the
// names the server shows (`names`), and those whose server look isn't loaded yet (`ask`); nobody
// while typing indicators are off.
export const rowTypers = (
  s: RowTypingSource,
  scopes: readonly string[],
  server: string | null
): { names: string[]; ask: string[] } => {
  if (!s.typingOn) return { names: NONE, ask: NONE }
  const names = new Set<string>()
  const ask = new Set<string>()
  for (const scope of scopes) {
    const found = shownTypers(s, server, s.typing[scope], s.blocked)
    for (const n of found.names) names.add(n)
    for (const a of found.ask) ask.add(a)
  }
  return {
    names: names.size ? [...names] : NONE,
    ask: ask.size ? [...ask] : NONE,
  }
}

// The members typing in a P2P channel, under their names, leaving out blocked contacts.
export const p2pRowTypers = (
  iks: readonly string[],
  blocked: ReadonlySet<string>,
  nameOf: (ik: string) => string
): string[] => {
  const shown = iks.filter(ik => !blocked.has(ik))
  return shown.length ? shown.map(nameOf) : NONE
}
