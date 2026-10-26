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

export const samePrefix = <T>(list: T[], head: T[], keyOf: (item: T) => Key): boolean =>
  head.length <= list.length && head.every((item, i) => keyOf(item) === keyOf(list[i]))

export const insertSorted = <T>(
  list: T[],
  item: T,
  cmp: (a: T, b: T) => number,
  keyOf: (item: T) => Key,
  more: boolean
): T[] => {
  const key = keyOf(item)
  const rest = list.some(x => keyOf(x) === key) ? list.filter(x => keyOf(x) !== key) : list
  let lo = 0
  let hi = rest.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (cmp(rest[mid], item) < 0) lo = mid + 1
    else hi = mid
  }
  if (more && lo === rest.length) return rest
  return [...rest.slice(0, lo), item, ...rest.slice(lo)]
}

export const lostServers = (
  known: string[],
  joined: ReadonlySet<string>,
  droppedSince: (name: string) => boolean
): string[] => [...new Set(known)].filter(name => !joined.has(name) && !droppedSince(name))

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

export const keyed = <T>(
  map: Record<string, T>,
  key: string,
  value: T | null | undefined
): Record<string, T> => {
  if (value === null || value === undefined) {
    if (!(key in map)) return map
    const next = { ...map }
    delete next[key]
    return next
  }
  return map[key] === value ? map : { ...map, [key]: value }
}

export const windowEdges = (
  ids: number[],
  at: number,
  page: number
): { older: boolean; newer: boolean } => {
  const below = ids.filter(id => id < at).length
  const half = Math.floor(page / 2)
  return { older: below >= half, newer: ids.length - below >= page - half }
}

export const unreadMark = (
  ids: number[],
  anchor: number | undefined,
  olderMore: boolean
): { divider: number; above: boolean } => {
  if (anchor === undefined || anchor <= 0) return { divider: -1, above: false }
  const first = ids.findIndex(id => id > anchor)
  if (first === -1) return { divider: -1, above: false }
  if (first === 0 && olderMore && ids[0] !== anchor + 1) return { divider: -1, above: true }
  return { divider: first, above: false }
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

export interface Page<T> {
  items: T[]
  next: string | null
}

export interface Pager {
  load: () => Promise<void>
  reset: (cursor: string | null, keep?: boolean) => boolean
  removed: () => boolean
}

export const createPager = <T>(opts: {
  read: () => T[]
  write: (list: T[], more: boolean) => void
  fetchPage: (cursor: string | null, limit: number) => Promise<Page<T>>
  keyOf: (item: T) => Key
  page: number
}): Pager => {
  let cursor: string | null = null
  let last: string | null = null
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
          const from = cursor ?? last
          const page = await opts.fetchPage(from, opts.page)
          if (epoch !== mine) return
          last = from
          cursor = page.next
          const list = appendUnique(opts.read(), page.items, opts.keyOf)
          opts.write(list, page.next !== null)
          if (page.next === null || list.length > had) return
        }
      } finally {
        if (epoch === mine) loading = false
      }
    },
    reset: (next, keep = false) => {
      const wasLoading = loading
      epoch += 1
      loading = false
      if (!keep || (cursor === null && last === null)) {
        cursor = next
        last = null
      }
      return wasLoading
    },
    removed: () => {
      if (!loading) return false
      epoch += 1
      loading = false
      return true
    },
  }
}
