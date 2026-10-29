export interface MentionPart {
  text: string
  mention: boolean
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const WORD = '[\\p{L}\\p{N}\\p{M}_]'
const WORD_RE = new RegExp(`^${WORD}$`, 'u')
const isWord = (c: string | undefined) => c !== undefined && WORD_RE.test(c)

export const NAME_MAX = 100
const MENTION_MAX = 20
const CANDIDATES_MAX = 400

const FENCE = /^\s*(```|~~~)/

export const maskCode = (text: string): string => {
  let fenced = false
  return text
    .split('\n')
    .map(line => {
      if (FENCE.test(line)) {
        fenced = !fenced
        return ' '.repeat([...line].length)
      }
      if (fenced) return ' '.repeat([...line].length)
      const chars = [...line]
      let open: { at: number; len: number } | null = null
      let i = 0
      while (i < chars.length) {
        if (chars[i] !== '`') {
          i += 1
          continue
        }
        const start = i
        while (i < chars.length && chars[i] === '`') i += 1
        const len = i - start
        if (open === null) open = { at: start, len }
        else if (open.len === len) {
          chars.fill(' ', open.at, i)
          open = null
        }
      }
      return chars.join('')
    })
    .join('\n')
}

const mentionRe = (username: string) =>
  new RegExp(`(^|(?!${WORD})[\\s\\S])(@${escapeRe(username)})(?!${WORD})`, 'giu')

export const mentionsUser = (content: string, username: string): boolean =>
  username !== '' && mentionRe(username).test(maskCode(content))

export const splitMentions = (text: string, username: string): MentionPart[] => {
  if (!username) return [{ text, mention: false }]
  const parts: MentionPart[] = []
  let last = 0
  for (const m of text.matchAll(mentionRe(username))) {
    const at = (m.index ?? 0) + m[1].length
    if (at > last) parts.push({ text: text.slice(last, at), mention: false })
    parts.push({ text: m[2], mention: true })
    last = at + m[2].length
  }
  if (last < text.length || parts.length === 0)
    parts.push({ text: text.slice(last), mention: false })
  return parts
}

interface Candidate {
  at: number
  end: number
  name: string
}

function* scanCandidates(chars: string[]): Generator<Candidate> {
  for (let at = 0; at < chars.length; at += 1) {
    if (chars[at] !== '@' || (at > 0 && isWord(chars[at - 1]))) continue
    for (let end = at + 1; end < chars.length && end - at <= NAME_MAX; end += 1) {
      const c = chars[end]
      if (c === '@' || c === '\n') break
      if (/\s/u.test(c) || isWord(chars[end + 1])) continue
      yield {
        at,
        end,
        name: chars
          .slice(at + 1, end + 1)
          .join('')
          .toLowerCase(),
      }
    }
  }
}

// Usernames `content` may mention, in order (the server's rule in src/api/pings.rs): after an
// `@` that does not follow a word character, every run up to a character that is not followed
// by a word character. Code is skipped.
export const mentionCandidates = (content: string, max = CANDIDATES_MAX): string[] => {
  const seen = new Set<string>()
  for (const { name } of scanCandidates([...maskCode(content)])) {
    seen.add(name)
    if (seen.size >= max) break
  }
  return [...seen]
}

// Names worth fetching member info for so pills can render: the first `perAt` candidates of
// each of the first `ats` mentions. Rendering itself checks every candidate.
export const mentionLookups = (content: string, perAt = 3, ats = MENTION_MAX): string[] => {
  const out = new Set<string>()
  const taken = new Map<number, number>()
  for (const { at, name } of scanCandidates([...maskCode(content)])) {
    const n = taken.get(at)
    if (n === undefined && taken.size >= ats) break
    if ((n ?? 0) >= perAt) continue
    taken.set(at, (n ?? 0) + 1)
    out.add(name)
  }
  return [...out]
}

export type KnownPart<T> = { text: string; user: T | null }

// Splits text into plain runs and `@username` runs of users `lookup` knows; at each `@` the
// longest known username wins.
export const splitKnownMentions = <T>(
  text: string,
  lookup: (username: string) => T | undefined
): KnownPart<T>[] => {
  const chars = [...text]
  const hits = new Map<number, { end: number; user: T }>()
  for (const { at, end, name } of scanCandidates(chars)) {
    const user = lookup(name)
    if (user !== undefined) hits.set(at, { end, user })
  }
  const parts: KnownPart<T>[] = []
  let last = 0
  for (const [at, { end, user }] of hits) {
    if (at < last) continue
    if (at > last) parts.push({ text: chars.slice(last, at).join(''), user: null })
    parts.push({ text: chars.slice(at, end + 1).join(''), user })
    last = end + 1
  }
  if (last < chars.length || parts.length === 0)
    parts.push({ text: chars.slice(last).join(''), user: null })
  return parts
}
