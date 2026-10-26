export interface Folder {
  id: string
  name: string | null
  servers: string[]
  open: boolean
}

export type RailEntry = string | Folder

export interface Layout {
  v: 2
  servers: RailEntry[]
  dmOrder: number[]
  dmPinned: number[]
  dmSeen: number
}

export type RailItem<T> =
  | { kind: 'server'; key: string; server: T }
  | { kind: 'folder'; key: string; folder: Folder; servers: T[] }

export type DmZone = 'pinned' | 'recent'

export interface DmSections<T> {
  pinned: T[]
  recent: T[]
}

export const FOLDER_NAME_MAX = 50

export const emptyLayout: Layout = { v: 2, servers: [], dmOrder: [], dmPinned: [], dmSeen: 0 }

export const layoutKey = (username: string | null) => `rchat_layout:${username ?? 'guest'}`

export const serverKey = (name: string) => `server:${name}`

export const folderKey = (id: string) => `folder:${id}`

const entryKey = (e: RailEntry) => (typeof e === 'string' ? serverKey(e) : folderKey(e.id))

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

export const cleanFolderName = (name: string) => name.trim().slice(0, FOLDER_NAME_MAX) || null

const tidy = (entries: RailEntry[]): RailEntry[] => {
  const seen = new Set<string>()
  const ids = new Set<string>()
  const fresh = (n: string) => {
    if (seen.has(n)) return false
    seen.add(n)
    return true
  }
  const out: RailEntry[] = []
  for (const e of entries) {
    if (typeof e === 'string') {
      if (fresh(e)) out.push(e)
      continue
    }
    const servers = e.servers.filter(fresh)
    if (servers.length < 2 || ids.has(e.id)) out.push(...servers)
    else {
      ids.add(e.id)
      out.push(servers.length === e.servers.length ? e : { ...e, servers })
    }
  }
  return out
}

const folderOf = (x: unknown): RailEntry[] => {
  if (isName(x)) return [x]
  if (typeof x !== 'object' || x === null) return []
  const { id, name, servers, open } = x as Record<string, unknown>
  if (!isName(id)) return []
  return [
    {
      id,
      name: typeof name === 'string' ? cleanFolderName(name) : null,
      servers: listOf(servers, isName),
      open: open === true,
    },
  ]
}

export const parseLayout = (raw: string | null): Layout => {
  const data = parseJson(raw)
  if (typeof data !== 'object' || data === null) return emptyLayout
  const { v, servers, dmOrder, dmPinned, dmSeen } = data as Record<string, unknown>
  if (v !== 1 && v !== 2) return emptyLayout
  return {
    v: 2,
    servers:
      v === 1
        ? listOf(servers, isName)
        : tidy(Array.isArray(servers) ? servers.flatMap(folderOf) : []),
    dmOrder: listOf(dmOrder, isId),
    dmPinned: listOf(dmPinned, isId),
    dmSeen: isId(dmSeen) ? dmSeen : 0,
  }
}

const rank = <K>(saved: K[]) => new Map(saved.map((k, i) => [k, i]))

export const layoutServers = (entries: RailEntry[]): string[] =>
  entries.flatMap(e => (typeof e === 'string' ? [e] : e.servers))

export const folderChildren = <T>(folder: Folder, byName: Map<string, T>): T[] =>
  folder.servers.flatMap(n => {
    const server = byName.get(n)
    return server === undefined ? [] : [server]
  })

export const railItems = <T>(
  items: T[],
  keyOf: (item: T) => string,
  entries: RailEntry[]
): RailItem<T>[] => {
  const byName = new Map(items.map(x => [keyOf(x), x]))
  const placed = new Set(layoutServers(entries))
  const saved = entries.flatMap((e): RailItem<T>[] => {
    if (typeof e === 'string') {
      const server = byName.get(e)
      return server === undefined ? [] : [{ kind: 'server', key: serverKey(e), server }]
    }
    const servers = folderChildren(e, byName)
    return servers.length === 0
      ? []
      : [{ kind: 'folder', key: folderKey(e.id), folder: e, servers }]
  })
  const fresh = items
    .filter(x => !placed.has(keyOf(x)))
    .map((server): RailItem<T> => ({ kind: 'server', key: serverKey(keyOf(server)), server }))
  return [...saved, ...fresh]
}

export const railNames = (loaded: string[], entries: RailEntry[]): string[] =>
  railItems(loaded, n => n, entries).flatMap(i => (i.kind === 'server' ? [i.server] : i.servers))

export const folderTitle = (name: string | null, servers: string[]) => {
  if (name) return name
  const shown: string[] = []
  let length = 0
  for (const full of servers) {
    const n = full.length > 32 ? `${full.slice(0, 31)}…` : full
    if (shown.length > 0 && length + n.length > 48) break
    shown.push(n)
    length += n.length + 2
  }
  const more = servers.length - shown.length
  return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ')
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

const materialize = (entries: RailEntry[], loaded: string[]): RailEntry[] => {
  const placed = new Set(layoutServers(entries))
  return [...entries, ...loaded.filter(n => !placed.has(n))]
}

const without = (entries: RailEntry[], key: string): RailEntry[] =>
  entries.flatMap(e => {
    if (entryKey(e) === key) return []
    if (typeof e === 'string' || !e.servers.some(n => serverKey(n) === key)) return [e]
    return [{ ...e, servers: e.servers.filter(n => serverKey(n) !== key) }]
  })

const findFolder = (entries: RailEntry[], id: string) =>
  entries.find((e): e is Folder => typeof e !== 'string' && e.id === id)

const withFolder = (entries: RailEntry[], id: string, edit: (f: Folder) => RailEntry[]) =>
  tidy(entries.flatMap(e => (typeof e !== 'string' && e.id === id ? edit(e) : [e])))

const placeTop = (layout: Layout, loaded: string[], entry: RailEntry, index: number): Layout => {
  const key = entryKey(entry)
  const base = without(materialize(layout.servers, loaded), key)
  const byKey = new Map(base.map(e => [entryKey(e), e]))
  byKey.set(key, entry)
  const shown = railItems(loaded, n => n, layout.servers).map(i => i.key)
  const order = moveAmong(base.map(entryKey), shown, key, index)
  return { ...layout, servers: tidy(order.flatMap(k => byKey.get(k) ?? [])) }
}

export const moveServer = (layout: Layout, loaded: string[], name: string, index: number) =>
  placeTop(layout, loaded, name, index)

export const moveFolder = (layout: Layout, loaded: string[], id: string, index: number) => {
  const folder = findFolder(layout.servers, id)
  return folder ? placeTop(layout, loaded, folder, index) : layout
}

export const moveIntoFolder = (
  layout: Layout,
  loaded: string[],
  name: string,
  id: string,
  index: number
): Layout => {
  const folder = findFolder(layout.servers, id)
  if (!folder) return layout
  const have = new Set(loaded)
  const shown = folder.servers.filter(n => have.has(n))
  const servers = moveAmong(folder.servers, shown, name, index)
  const base = without(materialize(layout.servers, loaded), serverKey(name))
  return { ...layout, servers: withFolder(base, id, f => [{ ...f, servers }]) }
}

export const addToFolder = (layout: Layout, loaded: string[], name: string, id: string) => {
  const folder = findFolder(layout.servers, id)
  if (!folder || folder.servers.includes(name)) return layout
  const base = without(materialize(layout.servers, loaded), serverKey(name))
  return {
    ...layout,
    servers: withFolder(base, id, f => [{ ...f, servers: [...f.servers, name] }]),
  }
}

export const mergeServers = (
  layout: Layout,
  loaded: string[],
  name: string,
  target: string,
  id: string
): Layout => {
  const base = without(materialize(layout.servers, loaded), serverKey(name))
  if (name === target || !base.includes(target)) return layout
  const folder: Folder = { id, name: null, servers: [target, name], open: false }
  return { ...layout, servers: tidy(base.map(e => (e === target ? folder : e))) }
}

export const newFolderId = (entries: RailEntry[], random = Math.random) => {
  const taken = new Set(entries.flatMap(e => (typeof e === 'string' ? [] : [e.id])))
  for (;;) {
    const id = random().toString(36).slice(2, 10)
    if (id && !taken.has(id)) return id
  }
}

const editFolder = (layout: Layout, id: string, edit: (f: Folder) => RailEntry[]): Layout =>
  findFolder(layout.servers, id)
    ? { ...layout, servers: withFolder(layout.servers, id, edit) }
    : layout

export const toggleFolder = (layout: Layout, id: string) =>
  editFolder(layout, id, f => [{ ...f, open: !f.open }])

export const renameFolder = (layout: Layout, id: string, name: string) =>
  editFolder(layout, id, f => [{ ...f, name: cleanFolderName(name) }])

export const ungroupFolder = (layout: Layout, id: string) => editFolder(layout, id, f => f.servers)

export const renameServer = (layout: Layout, from: string, to: string): Layout => {
  if (!layoutServers(layout.servers).includes(from)) return layout
  const swap = (n: string) => (n === from ? to : n)
  return {
    ...layout,
    servers: tidy(
      layout.servers.map(e =>
        typeof e === 'string' ? swap(e) : { ...e, servers: e.servers.map(swap) }
      )
    ),
  }
}

export const forgetServer = (layout: Layout, name: string): Layout =>
  layoutServers(layout.servers).includes(name)
    ? { ...layout, servers: tidy(without(layout.servers, serverKey(name))) }
    : layout

const keepOnly = (entries: RailEntry[], keep: Set<string>) =>
  tidy(
    entries.flatMap((e): RailEntry[] =>
      typeof e === 'string'
        ? keep.has(e)
          ? [e]
          : []
        : [{ ...e, servers: e.servers.filter(n => keep.has(n)) }]
    )
  )

export const pruneLayout = (
  layout: Layout,
  servers: string[] | null,
  dms: number[] | null
): Layout => {
  const keepServers = servers ? new Set(servers) : null
  const keepDms = dms ? new Set(dms) : null
  const gone = keepServers !== null && layoutServers(layout.servers).some(n => !keepServers.has(n))
  const next: Layout = {
    ...layout,
    servers: gone ? keepOnly(layout.servers, keepServers) : layout.servers,
    dmOrder: keepDms ? layout.dmOrder.filter(id => keepDms.has(id)) : layout.dmOrder,
    dmPinned: keepDms ? layout.dmPinned.filter(id => keepDms.has(id)) : layout.dmPinned,
  }
  const same =
    !gone &&
    next.dmOrder.length === layout.dmOrder.length &&
    next.dmPinned.length === layout.dmPinned.length
  return same ? layout : next
}
