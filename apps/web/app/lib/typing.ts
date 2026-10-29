// Typing indicators. Scopes are message keys: `c{channel}`, `t{thread root}`, `d{dm}`.
// The setting is per account in this browser (`rchat_typing:{username|guest}`); off means
// yours are never sent and others' are never shown.

export const TYPING_EVERY_MS = 3000
export const TYPING_TTL_MS = 8000

export const typingKey = (username: string | null) => `rchat_typing:${username ?? 'guest'}`

export const parseTyping = (raw: string | null): boolean => {
  try {
    const data = raw ? (JSON.parse(raw) as unknown) : null
    if (typeof data !== 'object' || data === null) return true
    const { v, on } = data as { v?: unknown; on?: unknown }
    return v === 1 && typeof on === 'boolean' ? on : true
  } catch {
    return true
  }
}

export const typingValue = (on: boolean) => JSON.stringify({ v: 1, on })

export type TypingMsg = { type: 'typing' | 'typing_stop'; scope: string }

// What this tab has told the server: the scope it shows as typing in, and when.
export interface TypingOut {
  scope: string | null
  at: number
}

export const IDLE: TypingOut = { scope: null, at: 0 }

// The composer of `scope` is typing (`active`) or not. Inactive composers only stop their own
// scope, so a second composer on screen can't cancel the one in use.
export const nextTyping = (
  cur: TypingOut,
  scope: string,
  active: boolean,
  now: number
): { next: TypingOut; send: TypingMsg[] } => {
  if (!active) {
    return cur.scope === scope
      ? { next: IDLE, send: [{ type: 'typing_stop', scope }] }
      : { next: cur, send: [] }
  }
  if (cur.scope === scope && now - cur.at < TYPING_EVERY_MS) return { next: cur, send: [] }
  const send: TypingMsg[] =
    cur.scope !== null && cur.scope !== scope ? [{ type: 'typing_stop', scope: cur.scope }] : []
  send.push({ type: 'typing', scope })
  return { next: { scope, at: now }, send }
}

export const stopTyping = (cur: TypingOut): TypingMsg[] =>
  cur.scope === null ? [] : [{ type: 'typing_stop', scope: cur.scope }]

export interface Typer {
  name: string
  until: number
}

// Who is typing where: scope -> username -> display name and local expiry.
export type TypingMap = Record<string, Record<string, Typer>>

export const withTyper = (
  map: TypingMap,
  scope: string,
  username: string,
  typer: Typer | null
): TypingMap => {
  const here = { ...(map[scope] ?? {}) }
  if (typer) here[username] = typer
  else if (here[username]) delete here[username]
  else return map
  const out = { ...map }
  if (Object.keys(here).length) out[scope] = here
  else delete out[scope]
  return out
}

export const pruneTypers = (map: TypingMap, now: number): TypingMap => {
  let changed = false
  const out: TypingMap = {}
  for (const [scope, here] of Object.entries(map)) {
    const kept = Object.entries(here).filter(([, t]) => t.until > now)
    if (kept.length !== Object.keys(here).length) changed = true
    if (kept.length) out[scope] = Object.fromEntries(kept)
  }
  return changed ? out : map
}

export const nextExpiry = (map: TypingMap): number | null => {
  let next: number | null = null
  for (const here of Object.values(map))
    for (const t of Object.values(here)) if (next === null || t.until < next) next = t.until
  return next
}

// Single place to hide typers: blocked users.
const hidden = new Set<string>()
export const typerShown = (username: string) => !hidden.has(username)
export const hideTypers = (names: Iterable<string>) => {
  hidden.clear()
  for (const n of names) hidden.add(n)
}

// Display names of who is typing, in the order they started. Expired entries are pruned by
// the store.
export const typerNames = (here: Record<string, Typer> | undefined): string[] =>
  Object.entries(here ?? {})
    .filter(([username]) => typerShown(username))
    .map(([, t]) => t.name)

export type TypingPart = { text: string; name: boolean }

// "Alice is typing…", "Alice and Bob are typing…", "Alice, Bob and Carol are typing…",
// "Several people are typing…" (4 or more). Names are marked for streamer mode.
export const typingParts = (names: string[]): TypingPart[] => {
  if (!names.length) return []
  if (names.length > 3) return [{ text: 'Several people are typing…', name: false }]
  const parts: TypingPart[] = []
  names.forEach((n, i) => {
    if (i > 0) parts.push({ text: i === names.length - 1 ? ' and ' : ', ', name: false })
    parts.push({ text: n, name: true })
  })
  parts.push({ text: names.length === 1 ? ' is typing…' : ' are typing…', name: false })
  return parts
}

export const typingText = (names: string[]) =>
  typingParts(names)
    .map(p => p.text)
    .join('')
