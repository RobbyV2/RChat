// The Threads list of a channel or DM: instance channels and DMs fill it from the server a page at
// a time, P2P channels and DMs from what is stored here, through the same rules.

import type { Page } from './lists'
import { plainLine } from './replies'
import type { Message, ThreadItem } from './types'

export const THREADS_TITLE = 'Threads'
export const THREADS_SEARCH = 'Search threads'
export const THREADS_PAGE = 50
export const THREADS_QUERY_MAX = 200

export const repliesText = (n: number) => `${n} ${n === 1 ? 'reply' : 'replies'}`

// A thread as the list shows it: its root (`files`: it carries files), its replies, when the
// newest one came (Unix seconds) and whether it has unread pings.
export interface ThreadRow {
  key: string
  root: Message
  files: boolean
  replies: number
  lastAt: number
  pinged: boolean
}

// A thread of the instance's lists as a row.
export const threadRowOf = (t: ThreadItem): ThreadRow => ({
  key: String(t.root.id),
  root: t.root,
  files: t.root.media !== null,
  replies: t.root.reply_count,
  lastAt: t.last_reply_at,
  pinged: false,
})

export interface ThreadLists {
  channelThreads(id: number, q: string, cursor: string | null): Promise<Page<ThreadItem>>
  dmThreads(id: number, q: string, cursor: string | null): Promise<Page<ThreadItem>>
}

// A page of the instance's Threads list of a channel (`c<id>`) or DM (`d<id>`).
export const hostedThreadPage = async (
  api: ThreadLists,
  key: string,
  query: string,
  cursor: string | null
) => {
  const id = Number(key.slice(1))
  const page =
    key[0] === 'd'
      ? await api.dmThreads(id, query, cursor)
      : await api.channelThreads(id, query, cursor)
  return { items: page.items.map(threadRowOf), next: page.next }
}

// Rows marked with the thread pings the account has (`t<root id>` keys).
export const pingedRows = (rows: readonly ThreadRow[], pings: Readonly<Record<string, unknown>>) =>
  rows.map(r => ({ ...r, pinged: pings[`t${r.root.id}`] !== undefined }))

export const threadsEmpty = (searching: boolean, selfDm: boolean) =>
  searching
    ? { title: 'No matching threads', body: 'Try a different search.' }
    : {
        title: 'There are no threads',
        body: selfDm
          ? 'Organize notes and forwarded messages into focused threads.'
          : 'Stay focused on a conversation with a thread.',
      }

// What the search compares: trimmed, lowercase and at most `THREADS_QUERY_MAX` characters.
export const threadQuery = (raw: string) =>
  [...raw.trim().toLowerCase()].slice(0, THREADS_QUERY_MAX).join('')

// The line a root shows: its first line of text, or what it holds when it has none.
export const rootLine = (m: Pick<Message, 'content' | 'kind' | 'forward'>, files: boolean) => {
  const text = m.content ? plainLine(m.content) : ''
  if (text.trim()) return { text, label: null }
  const label = m.kind === 'poll' ? 'Poll' : files ? 'Attachment' : 'Message'
  return { text: '', label: m.forward ? 'Forwarded message' : label }
}

// A thread held on this device (P2P): `last` orders it (the newest reply's sort key), `text`
// and `names` are what a search looks in.
export interface LocalThread {
  id: string
  last: string
  text: string
  names: string[]
}

// Orders like (last, id), newest first: a newline sorts before every character a key holds.
const orderKey = (t: LocalThread) => `${t.last}\n${t.id}`

export const matchesThread = (t: Pick<LocalThread, 'text' | 'names'>, query: string) => {
  const q = threadQuery(query)
  return !q || t.text.toLowerCase().includes(q) || t.names.some(n => n.toLowerCase().includes(q))
}

// One page of local threads, the newest reply first, like the instance's lists: `cursor` is the
// `next` of the page before.
export function pageThreads<T extends LocalThread>(
  all: readonly T[],
  query: string,
  cursor: string | null,
  size = THREADS_PAGE
): { items: T[]; next: string | null } {
  const shown = all
    .filter(t => matchesThread(t, query) && (cursor === null || orderKey(t) < cursor))
    .sort((a, b) => (orderKey(a) < orderKey(b) ? 1 : orderKey(a) > orderKey(b) ? -1 : 0))
  const items = shown.slice(0, size)
  const last = items.at(-1)
  return { items, next: shown.length > size && last ? orderKey(last) : null }
}

// Adds a page to the rows loaded so far: a thread that moved keeps its first place.
export function mergeRows(rows: readonly ThreadRow[], page: readonly ThreadRow[]): ThreadRow[] {
  const seen = new Set(rows.map(r => r.key))
  return [...rows, ...page.filter(r => !seen.has(r.key))]
}
