import { shortcodeOf, type Emoji, type EmojiPrefs } from './emoji'
import type { Message, Reaction, ServerDetail } from './types'

export const REACTIONS_MAX = 20
export const NAMES_SHOWN = 3

const EMPTY: Reaction[] = []

const put = (list: Reaction[], i: number, r: Reaction) => list.map((x, j) => (j === i ? r : x))

// Emojis that differ only in presentation selectors (`❤` / `❤️`) are one reaction; the server
// stores the fully-qualified form.
export const emojiKey = (e: string) => e.replace(/\uFE0F/g, '')

export const sameEmoji = (a: string, b: string) => a === b || emojiKey(a) === emojiKey(b)

// One reaction change from a WS event or an optimistic toggle. `mine` means the viewer reacted.
// Events carry `count` (reactors of the emoji after the change), so a repeated event changes
// nothing. Optimistic changes (no count) step by one. An own change that already shows is
// ignored. New emojis go last. An emoji at 0 goes away.
export function applyReaction(
  list: Reaction[] | undefined,
  emoji: string,
  added: boolean,
  mine: boolean,
  at: number,
  count?: number
): Reaction[] {
  const cur = list ?? EMPTY
  const i = cur.findIndex(r => sameEmoji(r.emoji, emoji))
  if (count !== undefined) {
    if (count <= 0) return i === -1 ? cur : [...cur.slice(0, i), ...cur.slice(i + 1)]
    if (i === -1) return [...cur, { emoji, count, me: mine && added, first_at: at }]
    const r = cur[i]
    const me = mine ? added : r.me
    if (r.count === count && r.me === me && r.emoji === emoji) return cur
    return put(cur, i, { ...r, emoji, count: Math.max(count, me ? 1 : 0), me })
  }
  if (added) {
    if (i === -1) return [...cur, { emoji, count: 1, me: mine, first_at: at }]
    const r = cur[i]
    if (mine && r.me) return cur
    return put(cur, i, { ...r, count: r.count + 1, me: r.me || mine })
  }
  if (i === -1) return cur
  const r = cur[i]
  if (mine && !r.me) return cur
  if (r.count <= 1) return [...cur.slice(0, i), ...cur.slice(i + 1)]
  return put(cur, i, { ...r, count: r.count - 1, me: mine ? false : r.me })
}

export function withReaction(
  m: Message,
  emoji: string,
  added: boolean,
  mine: boolean,
  at: number,
  count?: number
): Message {
  const next = applyReaction(m.reactions, emoji, added, mine, at, count)
  return next === (m.reactions ?? EMPTY) ? m : { ...m, reactions: next }
}

export const reacted = (m: Message, emoji: string) =>
  m.reactions?.some(r => r.me && sameEmoji(r.emoji, emoji)) === true

// Adding a new emoji past the per-message cap would be refused by the server.
export const canAddEmoji = (m: Message, emoji: string) => {
  const list = m.reactions ?? EMPTY
  return list.some(r => sameEmoji(r.emoji, emoji)) || list.length < REACTIONS_MAX
}

// A channel where the viewer may read but not send: no new reactions, own ones can go.
export const readOnly = (detail: ServerDetail | undefined, channelId: number | null) =>
  channelId !== null && (detail?.read_only?.includes(channelId) ?? false)

export const reactionsFull = (m: Message) => (m.reactions?.length ?? 0) >= REACTIONS_MAX

export const FULL_TITLE = `This message has ${REACTIONS_MAX} reactions already`

export const reactorKey = (messageId: number, emoji: string) => `${messageId}:${emojiKey(emoji)}`

export const othersText = (n: number) => `${n} ${n === 1 ? 'other' : 'others'}`

export const peopleText = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`

// "alice", "alice and bob", "alice, bob and carol", "alice, bob, carol and 2 others".
// `names` are the first reactors known (may be fewer than `total`).
export function reactorsText(names: string[], total: number, shown = NAMES_SHOWN): string {
  const count = Math.max(total, names.length)
  const head = names.slice(0, Math.min(shown, count))
  const rest = count - head.length
  if (!head.length) return peopleText(count)
  if (rest > 0) return `${head.join(', ')} and ${othersText(rest)}`
  if (head.length === 1) return head[0]
  return `${head.slice(0, -1).join(', ')} and ${head[head.length - 1]}`
}

// Tooltip: "😭 :sob: reacted by alice, bob and 3 others". Streamer mode hides the names.
export function reactionLabel(
  emoji: string,
  code: string | null,
  names: string[] | null,
  total: number,
  streamer: boolean
): string {
  const who = streamer || names === null ? peopleText(total) : reactorsText(names, total)
  return `${emoji}${code ? ` :${code}:` : ''} reacted by ${who}`
}

// The frecency key of a picked emoji: the base it was last picked as, else the emoji
// without skin tones.
export function emojiBase(prefs: EmojiPrefs, picked: string): string {
  if (prefs.used[picked]) return picked
  for (const [base, use] of Object.entries(prefs.used)) if (use.last === picked) return base
  return picked.replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '')
}

const bare = emojiKey

const codeMaps = new WeakMap<Emoji[], Map<string, string>>()

// Shortcode of an emoji or one of its skin tone variants, from the lazily loaded dataset.
export function emojiCode(list: Emoji[], emoji: string): string | null {
  let map = codeMaps.get(list)
  if (!map) {
    map = new Map()
    for (const e of list) {
      const code = shortcodeOf(e)
      if (!code) continue
      for (const v of [e.emoji, ...(e.skins ?? [])]) {
        map.set(v, code)
        if (!map.has(bare(v))) map.set(bare(v), code)
      }
    }
    codeMaps.set(list, map)
  }
  return map.get(emoji) ?? map.get(bare(emoji)) ?? null
}
