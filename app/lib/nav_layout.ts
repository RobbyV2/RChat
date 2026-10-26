export interface Layout {
  v: 1
  servers: string[]
  dmOrder: number[]
  dmPinned: number[]
  dmSeen: number
}

export type DmZone = 'pinned' | 'recent'

export interface DmSections<T> {
  pinned: T[]
  recent: T[]
}

export const emptyLayout: Layout = { v: 1, servers: [], dmOrder: [], dmPinned: [], dmSeen: 0 }

export const layoutKey = (username: string | null) => `rchat_layout:${username ?? 'guest'}`

const unique = <K>(list: K[]): K[] => [...new Set(list)]

const listOf = <K>(value: unknown, ok: (x: unknown) => x is K): K[] =>
  Array.isArray(value) ? unique(value.filter(ok)) : []

const isName = (x: unknown): x is string => typeof x === 'string' && x.length > 0

const isId = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) > 0

const parseJson = (raw: string | null): unknown => {
  try {
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export const parseLayout = (raw: string | null): Layout => {
  const data = parseJson(raw)
  if (typeof data !== 'object' || data === null) return emptyLayout
  const { v, servers, dmOrder, dmPinned, dmSeen } = data as Record<string, unknown>
  if (v !== 1) return emptyLayout
  return {
    v: 1,
    servers: listOf(servers, isName),
    dmOrder: listOf(dmOrder, isId),
    dmPinned: listOf(dmPinned, isId),
    dmSeen: isId(dmSeen) ? dmSeen : 0,
  }
}

const rank = <K>(saved: K[]) => new Map(saved.map((k, i) => [k, i]))

export const orderServers = <T>(items: T[], keyOf: (item: T) => string, saved: string[]): T[] => {
  const at = rank(saved)
  const known = items.filter(x => at.has(keyOf(x)))
  known.sort((a, b) => (at.get(keyOf(a)) ?? 0) - (at.get(keyOf(b)) ?? 0))
  return [...known, ...items.filter(x => !at.has(keyOf(x)))]
}

export const dmSections = <T extends { id: number; is_self?: boolean }>(
  dms: T[],
  layout: Layout
): DmSections<T> => {
  const byId = new Map(dms.map(d => [d.id, d]))
  const pinned = layout.dmPinned.flatMap(id => byId.get(id) ?? [])
  const pinnedIds = new Set(layout.dmPinned)
  const rest = dms.filter(d => !pinnedIds.has(d.id))
  if (layout.dmSeen === 0)
    return { pinned, recent: [...rest.filter(d => d.is_self), ...rest.filter(d => !d.is_self)] }
  const at = rank(layout.dmOrder)
  const fresh = rest.filter(d => !at.has(d.id) && d.id > layout.dmSeen).sort((a, b) => b.id - a.id)
  const known = rest.filter(d => at.has(d.id))
  known.sort((a, b) => (at.get(a.id) ?? 0) - (at.get(b.id) ?? 0))
  const older = rest.filter(d => !at.has(d.id) && d.id <= layout.dmSeen)
  return { pinned, recent: [...fresh, ...known, ...older] }
}

export const mergeOrder = <K>(saved: K[], shown: K[]): K[] => {
  const visible = new Set(shown)
  const at = rank(saved)
  const out: K[] = []
  let next = 0
  const flush = (to: number) => {
    for (; next < to; next++) if (!visible.has(saved[next])) out.push(saved[next])
  }
  for (const k of shown) {
    const i = at.get(k)
    if (i !== undefined && i >= next) {
      flush(i)
      next = i + 1
    }
    out.push(k)
  }
  flush(saved.length)
  return out
}

export const moveAmong = <K>(full: K[], shown: K[], key: K, index: number): K[] => {
  const rest = shown.filter(k => k !== key)
  const base = full.filter(k => k !== key)
  const anchor = rest[Math.max(0, index)]
  const last = rest[rest.length - 1]
  const at =
    anchor !== undefined
      ? base.indexOf(anchor)
      : last === undefined
        ? base.length
        : base.indexOf(last) + 1
  const pos = at < 0 ? base.length : at
  return [...base.slice(0, pos), key, ...base.slice(pos)]
}

export const reorderServers = (
  layout: Layout,
  shown: string[],
  name: string,
  index: number
): Layout => ({
  ...layout,
  servers: moveAmong(mergeOrder(layout.servers, shown), shown, name, index),
})

export const placeDm = (
  layout: Layout,
  shown: DmSections<number>,
  id: number,
  zone: DmZone,
  index: number,
  maxId: number
): Layout =>
  zone === 'pinned'
    ? {
        ...layout,
        dmPinned: moveAmong(mergeOrder(layout.dmPinned, shown.pinned), shown.pinned, id, index),
      }
    : {
        ...layout,
        dmPinned: layout.dmPinned.filter(x => x !== id),
        dmOrder: moveAmong(mergeOrder(layout.dmOrder, shown.recent), shown.recent, id, index),
        dmSeen: Math.max(layout.dmSeen, maxId, id),
      }

export const pinDm = (layout: Layout, id: number): Layout => ({
  ...layout,
  dmPinned: [...layout.dmPinned.filter(x => x !== id), id],
})

export const unpinDm = (layout: Layout, id: number): Layout => ({
  ...layout,
  dmPinned: layout.dmPinned.filter(x => x !== id),
  dmOrder: layout.dmSeen === 0 ? layout.dmOrder : [id, ...layout.dmOrder.filter(x => x !== id)],
})

export const renameServer = (layout: Layout, from: string, to: string): Layout =>
  layout.servers.includes(from)
    ? { ...layout, servers: unique(layout.servers.map(n => (n === from ? to : n))) }
    : layout

export const forgetServer = (layout: Layout, name: string): Layout =>
  layout.servers.includes(name)
    ? { ...layout, servers: layout.servers.filter(n => n !== name) }
    : layout

export const pruneLayout = (
  layout: Layout,
  servers: string[] | null,
  dms: number[] | null
): Layout => {
  const keepServers = servers ? new Set(servers) : null
  const keepDms = dms ? new Set(dms) : null
  const next: Layout = {
    ...layout,
    servers: keepServers ? layout.servers.filter(n => keepServers.has(n)) : layout.servers,
    dmOrder: keepDms ? layout.dmOrder.filter(id => keepDms.has(id)) : layout.dmOrder,
    dmPinned: keepDms ? layout.dmPinned.filter(id => keepDms.has(id)) : layout.dmPinned,
  }
  const same =
    next.servers.length === layout.servers.length &&
    next.dmOrder.length === layout.dmOrder.length &&
    next.dmPinned.length === layout.dmPinned.length
  return same ? layout : next
}
