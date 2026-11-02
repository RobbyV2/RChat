import type { InboxFilter, InboxItem, InboxKind, UserRef } from './types'
import { alertBody } from './notices'
import { maskOutsideCode } from './profanity'

// What the inbox shows: the tab and the filters.
export interface InboxView {
  unread: boolean
  kind: InboxFilter | null
  // a server name, 'dms' for direct messages, or null for everywhere
  place: string | null
}

export const DM_PLACE = 'dms'

export const DEFAULT_VIEW: InboxView = { unread: true, kind: null, place: null }

// One row, whatever source it came from. `adapter` names the source that loaded it and handles
// opening and marking it read; `raw` is that source's own record.
export interface InboxEntry {
  key: string
  adapter: string
  id: number
  created_at: number
  unread: boolean
  kind: InboxKind
  actor: UserRef
  emoji: string | null
  role: string | null
  where: InboxPlace
  content: string | null
  media: string | null
  mediaSpoiler: boolean
  // Order within the same second, higher first, as the source pages them (0 when it has none).
  order?: number
  raw: unknown
}

export type InboxPlace =
  | { kind: 'channel'; server: string; serverName: string; channel: string; thread: boolean }
  | { kind: 'dm' }
  | { kind: 'friends' }
  | { kind: 'other'; label: string }

export interface SourcePage {
  entries: InboxEntry[]
  next: string | null
}

// An inbox source: the instance's notifications, and later others (P2P) that list their own.
// `load` returns entries newest first; the panel merges the sources by time.
export interface InboxAdapter {
  id: string
  load: (view: InboxView, cursor: string | null) => Promise<SourcePage>
  markRead: (entry: InboxEntry) => Promise<void>
  // Marks what `view` lists, up to the newest entries this source has shown (`shown`, newest
  // first), so notifications that arrive meanwhile stay unread.
  markAll: (view: InboxView, shown: InboxEntry[]) => Promise<void>
  open: (entry: InboxEntry) => void | Promise<void>
  // Its notifications that badge, when the store doesn't count them, and how to hear that the
  // count may have changed: the bell counts them and the list reloads when the count moves.
  count?: () => number
  subscribe?: (onChange: () => void) => () => void
}

// Paging state of one source.
export interface SourceState {
  entries: InboxEntry[]
  next: string | null
  done: boolean
  loading: boolean
  failed: boolean
}

export const freshSource = (): SourceState => ({
  entries: [],
  next: null,
  done: false,
  loading: false,
  failed: false,
})

// Newest first; ties by adapter, then the source's own order, then key, so the order is stable
// and matches how each source pages.
export const compareEntries = (a: InboxEntry, b: InboxEntry) =>
  b.created_at - a.created_at ||
  (a.adapter < b.adapter ? -1 : a.adapter > b.adapter ? 1 : 0) ||
  (b.order ?? 0) - (a.order ?? 0) ||
  (a.key < b.key ? 1 : a.key > b.key ? -1 : 0)

// The oldest entry a source has loaded while it has more: entries older than it may still be
// preceded by entries this source has not loaded yet. `null` for a finished source, and for an
// unfinished one with nothing loaded (it blocks everything).
const edge = (s: SourceState): InboxEntry | null | 'none' =>
  s.done ? null : s.entries.length ? s.entries[s.entries.length - 1] : 'none'

// The merged list: every source's entries in order, cut where an unfinished source might still
// have entries to fill in, so paging never shows an entry out of order.
export const mergeEntries = (sources: Record<string, SourceState>): InboxEntry[] => {
  const all = Object.values(sources)
    .flatMap(s => s.entries)
    .sort(compareEntries)
  let cut: InboxEntry | null = null
  for (const s of Object.values(sources)) {
    const e = edge(s)
    if (e === 'none') return []
    if (e && (!cut || compareEntries(e, cut) < 0)) cut = e
  }
  if (!cut) return all
  const at = cut
  return all.filter(e => compareEntries(e, at) <= 0)
}

// The sources to load next: the ones whose edge is where the merged list stops.
export const sourcesToLoad = (sources: Record<string, SourceState>): string[] => {
  let cut: InboxEntry | null = null
  const out: string[] = []
  for (const [id, s] of Object.entries(sources)) {
    if (s.loading || s.failed) continue
    const e = edge(s)
    if (e === null) continue
    if (e === 'none') return [id]
    if (!cut || compareEntries(e, cut) < 0) {
      cut = e
      out.length = 0
      out.push(id)
    } else if (compareEntries(e, cut) === 0) out.push(id)
  }
  return out
}

export const hasMore = (sources: Record<string, SourceState>) =>
  Object.values(sources).some(s => !s.done)

// Marks one entry read in place; on the Unread tab it leaves the list.
export const markedRead = (
  sources: Record<string, SourceState>,
  key: string,
  unreadTab: boolean
): Record<string, SourceState> => {
  const out: Record<string, SourceState> = {}
  for (const [id, s] of Object.entries(sources)) {
    const entries = unreadTab
      ? s.entries.filter(e => e.key !== key)
      : s.entries.map(e => (e.key === key && e.unread ? { ...e, unread: false } : e))
    out[id] =
      entries.length === s.entries.length && entries.every((e, i) => e === s.entries[i])
        ? s
        : { ...s, entries }
  }
  return out
}

// Marks everything read in place. The Unread tab empties and stops paging (an old cursor would
// bring back rows that are being marked); the reload after the request fills it again.
export const allRead = (
  sources: Record<string, SourceState>,
  unreadTab: boolean
): Record<string, SourceState> => {
  const out: Record<string, SourceState> = {}
  for (const [id, s] of Object.entries(sources))
    out[id] = unreadTab
      ? { ...s, entries: [], next: null, done: true }
      : { ...s, entries: s.entries.map(e => (e.unread ? { ...e, unread: false } : e)) }
  return out
}

// A source's first page fetched again, merged into what is loaded: the page replaces the rows
// in its range (new ones appear, changed ones update, missing ones go), and the older rows of
// deeper pages stay with their cursor.
export const refreshHead = (prev: SourceState, page: SourcePage): SourceState => {
  const fresh: SourceState = {
    entries: page.entries,
    next: page.next,
    done: page.next === null,
    loading: false,
    failed: false,
  }
  const last = page.entries[page.entries.length - 1]
  if (page.next === null || !last) return fresh
  const keys = new Set(page.entries.map(e => e.key))
  const older = prev.entries.filter(e => !keys.has(e.key) && compareEntries(e, last) > 0)
  if (!older.length) return fresh
  return { ...fresh, entries: [...page.entries, ...older], next: prev.next, done: prev.done }
}

// How long after this panel marks something read a lower badge count is taken as that mark
// (already shown) rather than a change elsewhere.
export const OWN_MARK_MS = 3000

// Whether a change of the badge count reloads the list: always when it went up, and when it
// went down unless this panel just marked something read.
export const refreshOnCount = (before: number, after: number, ownUntil: number, now: number) =>
  after !== before && (after > before || now >= ownUntil)

const KIND_TEXT: Record<InboxKind, string> = {
  mention: 'mentioned you',
  reply: 'replied to you',
  reaction: 'reacted to your message',
  everyone: 'mentioned @everyone',
  here: 'mentioned @here',
  role: 'mentioned your role',
  friend_request: 'sent you a friend request',
  friend_accept: 'accepted your friend request',
}

// The words after the actor's name.
export const inboxAction = (e: Pick<InboxEntry, 'kind' | 'emoji' | 'role'>) => {
  if (e.kind === 'reaction' && e.emoji) return `reacted ${e.emoji} to your message`
  if (e.kind === 'role' && e.role) return `mentioned @${e.role}`
  return KIND_TEXT[e.kind]
}

// The text line: markdown and spoilers masked like toasts, the profanity mask applied, nothing
// in streamer mode. A file stands in for empty text.
export const inboxSnippet = (
  e: Pick<InboxEntry, 'content' | 'media' | 'mediaSpoiler'>,
  streamer: boolean,
  mask: (text: string) => string
): string => {
  if (streamer) return ''
  const text = e.content ? alertBody(e.content, false) : ''
  if (text) return maskOutsideCode(text, mask)
  if (e.media) return e.mediaSpoiler ? 'Spoiler' : mask(e.media)
  return ''
}

export const KIND_FILTERS: { value: InboxFilter | null; label: string }[] = [
  { value: null, label: 'All' },
  { value: 'mentions', label: 'Mentions' },
  { value: 'replies', label: 'Replies' },
  { value: 'reactions', label: 'Reactions' },
  { value: 'friends', label: 'Friends' },
]

// The server pages one second's items by source (friend, group, ping), then id, newest first.
const SOURCE_RANK: Record<InboxItem['source'], number> = { ping: 0, group: 1, friend: 2 }
const RANK_STEP = 2 ** 50

// The instance's own notifications (`GET /api/inbox`) as an entry.
export const entryOf = (adapter: string, item: InboxItem): InboxEntry => ({
  key: `${adapter}:${item.source}:${item.id}`,
  adapter,
  id: item.id,
  created_at: item.created_at,
  unread: item.unread,
  kind: item.kind,
  actor: item.actor,
  emoji: item.emoji,
  role: item.role,
  where:
    item.scope?.[0] === 'd'
      ? { kind: 'dm' }
      : item.source === 'friend'
        ? { kind: 'friends' }
        : {
            kind: 'channel',
            server: item.server ?? '',
            serverName: item.server_name ?? item.server ?? '',
            channel: item.channel_name ?? '',
            thread: item.thread_root_id !== null,
          },
  content: item.content,
  media: item.media_filename,
  mediaSpoiler: item.media_spoiler ?? false,
  order: SOURCE_RANK[item.source] * RANK_STEP + item.id,
  raw: item,
})
