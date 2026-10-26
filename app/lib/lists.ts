import type { Message } from './types'

export type Key = string | number

export interface ReadMark {
  lastRead: number
  latest: number
  server?: string
}

export interface OlderState {
  more: boolean
  loading: boolean
}

export const appendUnique = <T>(list: T[], items: T[], keyOf: (item: T) => Key): T[] => {
  const seen = new Set(list.map(keyOf))
  const fresh = items.filter(item => {
    const key = keyOf(item)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return fresh.length ? [...list, ...fresh] : list
}

export const mergeHead = <T>(list: T[], head: T[], more: boolean, keyOf: (item: T) => Key): T[] => {
  if (!more) return head
  const seen = new Set(head.map(keyOf))
  return [...head, ...list.filter(item => !seen.has(keyOf(item)))]
}

export const bumpFront = <T>(
  list: T[],
  item: T,
  keyOf: (item: T) => Key,
  pinned: (item: T) => boolean
): T[] => {
  const key = keyOf(item)
  const rest = list.filter(x => keyOf(x) !== key)
  const after = pinned(item) ? 0 : rest.findIndex(x => !pinned(x))
  const at = after === -1 ? rest.length : after
  if (list[at] !== undefined && keyOf(list[at]) === key && list.length === rest.length + 1)
    return list
  return [...rest.slice(0, at), item, ...rest.slice(at)]
}

const byId = (a: Message, b: Message) => a.id - b.id

export const refreshTail = (
  list: Message[],
  fresh: Message[],
  limit: number,
  more: boolean
): { list: Message[]; more: boolean } => {
  const sorted = [...fresh].sort(byId)
  const lo = sorted[0]?.id
  if (sorted.length < limit || lo === undefined) return { list: sorted, more: false }
  if (!list.some(m => m.id >= lo)) return { list: sorted, more: true }
  return { list: [...list.filter(m => m.id < lo), ...sorted], more }
}

export const unreadServers = (reads: Record<string, ReadMark>): Set<string> => {
  const servers = new Set<string>()
  for (const r of Object.values(reads)) {
    if (r.server !== undefined && r.latest > r.lastRead) servers.add(r.server)
  }
  return servers
}

export const anyDmUnread = (reads: Record<string, ReadMark>): boolean =>
  Object.entries(reads).some(([scope, r]) => scope[0] === 'd' && r.latest > r.lastRead)

export interface Pager {
  load: () => Promise<void>
  reset: (cursor: number) => boolean
  removed: (count: number) => boolean
}

export const createPager = <T>(opts: {
  read: () => T[]
  write: (list: T[], more: boolean) => void
  fetchPage: (offset: number, limit: number) => Promise<T[]>
  keyOf: (item: T) => Key
  page: number
  max: number
}): Pager => {
  let cursor = 0
  let epoch = 0
  let loading = false
  return {
    load: async () => {
      if (loading) return
      const mine = epoch
      loading = true
      try {
        for (;;) {
          const had = opts.read().length
          const limit = cursor < had ? opts.max : opts.page
          const page = await opts.fetchPage(cursor, limit)
          if (epoch !== mine) return
          cursor += page.length
          const more = page.length === limit
          const list = appendUnique(opts.read(), page, opts.keyOf)
          opts.write(list, more)
          if (!more || list.length > had) return
        }
      } finally {
        if (epoch === mine) loading = false
      }
    },
    reset: next => {
      const wasLoading = loading
      epoch += 1
      loading = false
      cursor = next
      return wasLoading
    },
    removed: count => {
      cursor = Math.max(0, cursor - count)
      if (!loading) return false
      epoch += 1
      loading = false
      return true
    },
  }
}
