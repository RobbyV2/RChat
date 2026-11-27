// The reason a moderator gives for a change, as hosted servers and P2P rooms keep it.

// The longest reason a change may carry, in characters.
export const REASON_MAX = 300

// Control characters, and halves of characters that lost their other half, read as spaces.
const plain = (v: string) =>
  ((v as string & { toWellFormed?: () => string }).toWellFormed?.() ?? v).replace(/\p{Cc}/gu, ' ')

// A reason as an entry or an event carries it: its text with control characters as spaces, cut
// to `max` characters; null for anything that isn't text.
export const reasonOf = (v: unknown, max = REASON_MAX): string | null => {
  if (typeof v !== 'string') return null
  const text = plain(v).trim()
  return text ? Array.from(text).slice(0, max).join('') : null
}
