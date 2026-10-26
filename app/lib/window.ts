export interface WithId {
  id: number
}

export const indexOfId = <T extends WithId>(list: T[], id: number): number => {
  let lo = 0
  let hi = list.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const at = list[mid].id
    if (at === id) return mid
    if (at < id) lo = mid + 1
    else hi = mid - 1
  }
  return -1
}

export const findById = <T extends WithId>(list: T[] | undefined, id: number): T | undefined => {
  if (!list) return undefined
  const i = indexOfId(list, id)
  return i === -1 ? undefined : list[i]
}

const byId = (a: WithId, b: WithId) => a.id - b.id

export const mergeSorted = <T extends WithId>(list: T[], incoming: T[]): T[] => {
  if (!incoming.length) return list
  const fresh = [...incoming].sort(byId)
  if (!list.length) return dedupe(fresh)
  const first = list[0].id
  const last = list[list.length - 1].id
  if (fresh[0].id > last) return [...list, ...dedupe(fresh)]
  if (fresh[fresh.length - 1].id < first) return [...dedupe(fresh), ...list]
  if (fresh.length === 1) {
    const m = fresh[0]
    let lo = 0
    let hi = list.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (list[mid].id < m.id) lo = mid + 1
      else hi = mid
    }
    const next = [...list]
    if (list[lo]?.id === m.id) next[lo] = m
    else next.splice(lo, 0, m)
    return next
  }
  const map = new Map(list.map(m => [m.id, m]))
  for (const m of fresh) map.set(m.id, m)
  return [...map.values()].sort(byId)
}

const dedupe = <T extends WithId>(sorted: T[]): T[] =>
  sorted.filter((m, i) => i === 0 || sorted[i - 1].id !== m.id)

export const patchById = <T extends WithId>(list: T[], id: number, fn: (m: T) => T): T[] => {
  const i = indexOfId(list, id)
  if (i === -1) return list
  const next = fn(list[i])
  if (next === list[i]) return list
  const out = [...list]
  out[i] = next
  return out
}

export const mapWhere = <T>(list: T[], hit: (m: T) => boolean, fn: (m: T) => T): T[] =>
  list.some(hit) ? list.map(m => (hit(m) ? fn(m) : m)) : list

export const dropWhere = <T>(list: T[], hit: (m: T) => boolean): T[] =>
  list.some(hit) ? list.filter(m => !hit(m)) : list

export const WINDOW_MAX = 200
export const WINDOW_SLACK = 50

export type Keep = 'newest' | 'oldest'

export const trimWindow = <T>(
  list: T[],
  keep: Keep,
  max = WINDOW_MAX,
  slack = WINDOW_SLACK
): { list: T[]; trimmed: boolean } => {
  if (list.length <= max + slack) return { list, trimmed: false }
  return { list: keep === 'newest' ? list.slice(-max) : list.slice(0, max), trimmed: true }
}

export interface Lru<K> {
  touch: (key: K) => K[]
  delete: (key: K) => void
  has: (key: K) => boolean
  keys: () => K[]
  clear: () => void
}

export const createLru = <K>(max: number, pinned: (key: K) => boolean = () => false): Lru<K> => {
  const order = new Map<K, true>()
  return {
    touch: key => {
      order.delete(key)
      order.set(key, true)
      const evicted: K[] = []
      if (order.size <= max) return evicted
      for (const k of order.keys()) {
        if (order.size - evicted.length <= max) break
        if (k === key || pinned(k)) continue
        evicted.push(k)
      }
      for (const k of evicted) order.delete(k)
      return evicted
    },
    delete: key => void order.delete(key),
    has: key => order.has(key),
    keys: () => [...order.keys()],
    clear: () => order.clear(),
  }
}

export interface Range {
  start: number
  end: number
  before: number
  after: number
}

export const prefixHeights = (heights: number[]): number[] => {
  const out = new Array<number>(heights.length + 1)
  out[0] = 0
  for (let i = 0; i < heights.length; i += 1) out[i + 1] = out[i] + heights[i]
  return out
}

const firstAbove = (prefix: number[], y: number) => {
  let lo = 0
  let hi = prefix.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (prefix[mid + 1] <= y) lo = mid + 1
    else hi = mid
  }
  return lo
}

export const visibleRange = (
  prefix: number[],
  scrollTop: number,
  viewport: number,
  overscan: number
): Range => {
  const count = prefix.length - 1
  const total = prefix[count] ?? 0
  if (count <= 0) return { start: 0, end: 0, before: 0, after: 0 }
  const top = Math.max(0, scrollTop - overscan)
  const bottom = Math.min(total, scrollTop + viewport + overscan)
  const start = Math.min(count - 1, firstAbove(prefix, top))
  const end = Math.max(start + 1, Math.min(count, firstAbove(prefix, bottom) + 1))
  return { start, end, before: prefix[start], after: total - prefix[end] }
}
